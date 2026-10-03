import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFS } from '../sim/defs';
import { TPS, type Entity } from '../sim/types';
import type { World } from '../sim/world';
import type { Effects } from './effects';
import type { AnimState, Model } from './models';

/*
 * Small "life" animations of units, visual only (the simulation is read, never changed):
 *
 *  - Crew hatches: every frame a ground vehicle gets AnimState.hatch = 0 while it is
 *    in combat (has a target, fired or was hit in the last few seconds), else 1.
 *    The vehicle model (models/vehicles.ts) shows / ducks its commander.
 *  - Troop transports: passenger list changes are diffed per transport. Boarding
 *    infantry are not deleted when they vanish into the hull: their model walks to
 *    the rear ramp and up into the vehicle (~1 s) first. Unloaded infantry walk out
 *    of the hull down the ramp to their real position, staggered. The ramp / doors
 *    are held open (AnimState.ramp) while that happens, and open ahead of time for
 *    infantry about to board.
 *  - Digging in: infantry standing still out of combat for 8 s (guard / hold stance,
 *    idle, no orders) dig a foxhole: a short dig motion (AnimState.dig), a growing
 *    horseshoe of sandbags and a ring of dug earth (two InstancedMeshes, capped),
 *    then they kneel in it. Leaving the spot leaves the empty hole, which fades.
 *
 * Per-frame work is a map lookup per infantry / transport and a few dozen
 * instance matrices; no allocation in steady state.
 */

const WALK = 0.95; // tiles / s
const DIG_START = 8; // s standing still
const DIG_T = 2.6; // dig motion length (models/infantry.ts)
const HOLES = 40; // foxhole cap
const DOOR = 0.72; // walk-in / walk-out point: just inside the rear door (fraction of the half length)

type Getter = (id: number) => Model | undefined;

interface Walker {
  model: Model;
  anim: AnimState;
  apc: number;
  /** Path: up to 4 points (x, y, z); `n` points; distance walked. */
  pts: Float32Array;
  n: number;
  d: number;
  len: number;
}

interface Exit {
  apc: number;
  delay: number;
  t: number;
}

interface Carrier {
  ids: number[];
  until: number;
  /** Infantry sent out in the current unload (staggers the walk-out). */
  out: number;
}

interface Dig {
  x: number;
  z: number;
  still: number;
  t: number;
  slot: number;
  frame: number;
  chop: number;
}

const _a = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function newAnim(): AnimState {
  return { dt: 0, time: 0, moving: true, speed: WALK, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true };
}

// ------------------------------------------------------------- foxholes

function sandbagGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const col = new THREE.Color();
  const tones = [0x9c8a62, 0x8a7a56, 0xa89670, 0x7e7050];
  const layer = (n: number, r: number, y: number, a0: number, a1: number) => {
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * (i + 0.5)) / n + (rnd() - 0.5) * 0.06;
      const g = new THREE.BoxGeometry(0.078, 0.03, 0.045, 1, 1, 1);
      // puffy bag: round the top
      const pos = g.attributes.position;
      for (let k = 0; k < pos.count; k++) if (pos.getY(k) > 0) pos.setY(k, pos.getY(k) * (1 - 0.3 * Math.abs(pos.getZ(k)) / 0.0225));
      g.rotateY(-a + Math.PI / 2 + (rnd() - 0.5) * 0.15);
      g.translate(Math.cos(a) * r, y, Math.sin(a) * r);
      col.setHex(tones[Math.floor(rnd() * tones.length)]).multiplyScalar(0.9 + rnd() * 0.2);
      const c = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) col.toArray(c, k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      parts.push(g);
    }
  };
  // horseshoe open at the back (local -X), facing the soldier's front (+X)
  layer(9, 0.165, 0.015, -2.25, 2.25);
  layer(7, 0.162, 0.043, -1.95, 1.95);
  layer(3, 0.16, 0.07, -0.55, 0.55);
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

function dirtGeo(): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(0.27, 22, 0, Math.PI * 2);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const c = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i)) / 0.27;
    // dark pit in the middle, spoil ring, soft edge
    const pit = 1 - sstep(0.15, 0.45, r);
    c[i * 4] = 0.3 - 0.14 * pit;
    c[i * 4 + 1] = 0.24 - 0.12 * pit;
    c[i * 4 + 2] = 0.17 - 0.09 * pit;
    c[i * 4 + 3] = 0.9 * (1 - sstep(0.7, 1, r));
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 4));
  return g;
}

interface Hole {
  used: boolean;
  owned: boolean;
  vis: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  grow: number;
  /** Seconds since its soldier left (fades after a while). */
  left: number;
}

class Foxholes {
  readonly bags: THREE.InstancedMesh;
  readonly dirt: THREE.InstancedMesh;
  private holes: Hole[] = [];
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  constructor(scene: THREE.Scene) {
    this.bags = new THREE.InstancedMesh(sandbagGeo(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }), HOLES);
    this.dirt = new THREE.InstancedMesh(
      dirtGeo(),
      new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      HOLES,
    );
    for (const m of [this.bags, this.dirt]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.userData.perfCat = 'foxholes';
      scene.add(m);
    }
    this.bags.castShadow = true;
    this.bags.receiveShadow = true;
    this.dirt.receiveShadow = true;
    this.dirt.renderOrder = 1;
    for (let i = 0; i < HOLES; i++) this.holes.push({ used: false, owned: false, vis: false, x: 0, y: 0, z: 0, yaw: 0, grow: 0, left: 0 });
  }
  claim(x: number, y: number, z: number, yaw: number): number {
    let best = -1;
    for (let i = 0; i < HOLES; i++) {
      const h = this.holes[i];
      if (!h.used) {
        best = i;
        break;
      }
      // all taken: recycle the empty hole abandoned longest ago
      if (!h.owned && (best < 0 || h.left > this.holes[best].left)) best = i;
    }
    if (best < 0) return -1;
    const h = this.holes[best];
    h.used = h.owned = h.vis = true;
    h.x = x;
    h.y = y;
    h.z = z;
    h.yaw = yaw;
    h.grow = 0;
    h.left = 0;
    return best;
  }
  set(i: number, grow: number, vis: boolean) {
    const h = this.holes[i];
    h.grow = grow;
    h.vis = vis;
  }
  release(i: number) {
    if (i >= 0) this.holes[i].owned = false;
  }
  update(dt: number) {
    let n = 0;
    for (let i = 0; i < HOLES; i++) {
      const h = this.holes[i];
      if (!h.used) continue;
      if (!h.owned) {
        h.left += dt;
        if (h.left > 9) {
          h.used = false;
          continue;
        }
      }
      n = i + 1;
    }
    this.bags.count = n;
    this.dirt.count = n;
    if (!n) {
      this.bags.visible = this.dirt.visible = false;
      return;
    }
    this.bags.visible = this.dirt.visible = true;
    for (let i = 0; i < n; i++) {
      const h = this.holes[i];
      if (!h.used || !h.vis) {
        this.bags.setMatrixAt(i, this.zero);
        this.dirt.setMatrixAt(i, this.zero);
        continue;
      }
      // abandoned: the bags slump and sink after ~6 s, the earth ring shrinks away
      const sink = sstep(6, 9, h.left);
      _q.setFromAxisAngle(_up, h.yaw);
      const by = Math.max(0.02, sstep(0, 0.85, h.grow)) * (1 - sink);
      _m.compose(_p.set(h.x, h.y - 0.045 * sink, h.z), _q, _s.set(1, by, 1));
      this.bags.setMatrixAt(i, _m);
      const dk = (0.35 + 0.65 * sstep(0, 0.6, h.grow)) * (1 - sink * 0.9);
      _m.compose(_p.set(h.x, h.y + 0.012, h.z), _q, _s.set(dk, 1, dk));
      this.dirt.setMatrixAt(i, _m);
    }
    this.bags.instanceMatrix.needsUpdate = true;
    this.dirt.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    for (const m of [this.bags, this.dirt]) {
      m.removeFromParent();
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}

// ------------------------------------------------------------- main

export class UnitLife {
  private walkers: Walker[] = [];
  private pool: Walker[] = [];
  private exits = new Map<number, Exit>();
  private carriers = new Map<number, Carrier>();
  private boarding = new Set<number>();
  private digs = new Map<number, Dig>();
  private holes: Foxholes;
  private frame = 0;
  private time = 0;

  constructor(
    private scene: THREE.Scene,
    private fx: Effects,
    private world: World,
    private ground: (x: number, z: number) => number,
    /** Model of a live unit visual (transport position / size). */
    private modelOf: Getter,
  ) {
    this.holes = new Foxholes(scene);
  }

  /** Ground vehicle, before its model animates: crew hatch target, troop ramp, passenger changes. */
  vehicle(e: Entity, a: AnimState, transport: boolean) {
    const tick = this.world.tick;
    a.hatch = e.targetId >= 0 || tick - e.lastHurt < 5 * TPS || tick - e.firedAt < 3 * TPS ? 0 : 1;
    if (!transport) return;
    let c = this.carriers.get(e.id);
    if (!c) this.carriers.set(e.id, (c = { ids: e.passengers.slice(), until: 0, out: 0 }));
    const p = e.passengers;
    let same = p.length === c.ids.length;
    for (let i = 0; same && i < p.length; i++) if (p[i] !== c.ids[i]) same = false;
    if (!same) {
      for (const id of c.ids) if (!p.includes(id)) this.unloaded(id, e.id, c);
      c.out = 0;
      for (const id of p) {
        if (c.ids.includes(id)) continue;
        this.boarding.add(id);
        c.until = Math.max(c.until, this.time + 1.5);
      }
      c.ids = p.slice();
    }
    a.ramp = this.time < c.until ? 1 : 0;
  }

  /** Passenger `id` left transport `cid`: walks out down the ramp, one after the other. */
  private unloaded(id: number, cid: number, c: Carrier) {
    if (this.exits.has(id)) return;
    const u = this.world.get(id);
    if (!u || u.inside >= 0) return;
    this.exits.set(id, { apc: cid, delay: 0.45 + c.out * 0.32, t: 0 });
    c.out++;
    c.until = Math.max(c.until, this.time + 0.45 + c.out * 0.32 + 1.1);
  }

  /** Infantry, after its ground pose: digging in, walking out of a transport. */
  infantry(e: Entity, model: Model, a: AnimState, vis: boolean, dt: number) {
    const root = model.root;
    // about to board: open the ramp ahead of time
    if (e.order.type === 'enter') {
      const t = this.world.get(e.order.target);
      const c = t && this.carriers.get(t.id);
      if (c && Math.hypot(t.x - e.x, t.y - e.y) < 1.6) c.until = Math.max(c.until, this.time + 0.8);
    }
    let st = this.digs.get(e.id);
    if (!st) {
      // first seen: just out of a transport whose passenger diff hasn't run yet this frame?
      for (const [cid, c] of this.carriers) if (c.ids.includes(e.id)) this.unloaded(e.id, cid, c);
      this.digs.set(e.id, (st = { x: root.position.x, z: root.position.z, still: 0, t: 0, slot: -1, frame: 0, chop: 0 }));
    }
    st.frame = this.frame;
    const ex = this.exits.size ? this.exits.get(e.id) : undefined;
    if (ex) this.walkOut(e.id, ex, model, a, vis, dt);
    a.dig = 0;
    if (e.para || DEFS[e.def].model === 'mortar') return;
    const moved = Math.abs(root.position.x - st.x) + Math.abs(root.position.z - st.z) > 0.06 || e.moving || !!ex;
    if (moved) {
      st.x = root.position.x;
      st.z = root.position.z;
      st.still = 0;
      if (st.t > 0) this.leave(st);
      return;
    }
    const tick = this.world.tick;
    const calm = e.order.type === 'idle' && (e.stance === 'guard' || e.stance === 'hold') && e.targetId < 0 && tick - e.lastHurt > 4 * TPS && tick - e.firedAt > 4 * TPS && !e.queue.length && !e.patrol && e.guardId < 0;
    if (st.t > 0) {
      // under fire mid-dig: stop digging, get down in what there is
      if (!calm && st.t < DIG_T) st.t = DIG_T;
      st.t += dt;
    } else if (!calm) st.still = 0;
    else {
      st.still += dt;
      if (st.still > DIG_START && vis) {
        st.slot = this.holes.claim(root.position.x, this.ground(root.position.x, root.position.z), root.position.z, root.rotation.y);
        if (st.slot >= 0) st.t = 1e-3;
      }
    }
    if (st.t <= 0) return;
    a.dig = st.t;
    const g = Math.min(1, st.t / DIG_T);
    this.holes.set(st.slot, g, vis);
    root.position.y -= 0.03 * sstep(0.4, 1, g);
    // a spadeful of earth per stroke
    if (vis && st.t < DIG_T - 0.3 && dt > 0) {
      st.chop += dt * 1.7;
      if (st.chop >= 1) {
        st.chop -= 1;
        const yaw = root.rotation.y;
        this.fx.dust(root.position.x + Math.cos(yaw) * 0.12, root.position.y + 0.02, root.position.z - Math.sin(yaw) * 0.12, 0.3);
      }
    }
  }

  private leave(st: Dig) {
    this.holes.release(st.slot);
    st.slot = -1;
    st.t = 0;
  }

  /** A visual whose unit just went inside a transport: true when it was taken over for the walk in. */
  adopt(id: number, model: Model): boolean {
    if (!this.boarding.delete(id)) return false;
    const u = this.world.entities.get(id);
    const tm = u && u.inside >= 0 ? this.modelOf(u.inside) : undefined;
    if (!tm || !tm.root.visible || !model.root.visible || !model.anim) return false;
    const w = this.pool.pop() ?? { model, anim: newAnim(), apc: 0, pts: new Float32Array(12), n: 0, d: 0, len: 0 };
    w.model = model;
    w.apc = u!.inside;
    w.d = 0;
    const a = w.anim;
    a.moving = true;
    a.speed = WALK;
    a.dead = 0;
    a.fired = Infinity;
    a.dig = 0;
    a.para = 0;
    // path: around the side if it's in front, to the ramp foot, up into the hull
    const r = model.root.position;
    const tr = tm.root;
    const fx = Math.cos(tr.rotation.y);
    const fz = -Math.sin(tr.rotation.y);
    const half = (tm.size?.x ?? 1) * 0.5;
    const P = w.pts;
    let n = 0;
    const push = (x: number, z: number, y: number) => {
      P[n * 3] = x;
      P[n * 3 + 1] = y;
      P[n * 3 + 2] = z;
      n++;
    };
    push(r.x, r.z, r.y);
    const rx = r.x - tr.position.x;
    const rz = r.z - tr.position.z;
    const along = rx * fx + rz * fz;
    if (along > -half * 0.6) {
      const side = rx * -fz + rz * fx >= 0 ? 1 : -1;
      const sx = tr.position.x - fx * half * 0.7 - fz * side * 0.62;
      const sz = tr.position.z - fz * half * 0.7 + fx * side * 0.62;
      push(sx, sz, this.ground(sx, sz));
    }
    const ax = tr.position.x - fx * (half + 0.22);
    const az = tr.position.z - fz * (half + 0.22);
    push(ax, az, this.ground(ax, az));
    push(tr.position.x - fx * half * DOOR, tr.position.z - fz * half * DOOR, tr.position.y + 0.1);
    w.n = n;
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 2] - P[i * 3 - 1]);
    w.len = len;
    this.walkers.push(w);
    const c = this.carriers.get(w.apc);
    if (c) c.until = Math.max(c.until, this.time + len / WALK + 0.5);
    return true;
  }

  private walkOut(id: number, ex: Exit, model: Model, a: AnimState, vis: boolean, dt: number) {
    const tm = this.modelOf(ex.apc);
    ex.t += dt;
    if (!tm || !vis) {
      this.exits.delete(id);
      return;
    }
    const root = model.root;
    const te = ex.t - ex.delay;
    if (te < 0) {
      root.visible = false;
      return;
    }
    const tr = tm.root;
    const fx = Math.cos(tr.rotation.y);
    const fz = -Math.sin(tr.rotation.y);
    const half = (tm.size?.x ?? 1) * 0.5;
    // inside the hull -> ramp foot -> the real (sim) position
    const x0 = tr.position.x - fx * half * DOOR;
    const z0 = tr.position.z - fz * half * DOOR;
    const y0 = tr.position.y + 0.1;
    const x1 = tr.position.x - fx * (half + 0.22);
    const z1 = tr.position.z - fz * (half + 0.22);
    const x2 = root.position.x;
    const z2 = root.position.z;
    const l1 = Math.hypot(x1 - x0, z1 - z0);
    const l2 = Math.hypot(x2 - x1, z2 - z1);
    const d = te * WALK;
    if (d >= l1 + l2) {
      this.exits.delete(id);
      return;
    }
    let x: number;
    let z: number;
    let y: number;
    let dx: number;
    let dz: number;
    if (d < l1) {
      const k = d / Math.max(1e-3, l1);
      x = x0 + (x1 - x0) * k;
      z = z0 + (z1 - z0) * k;
      y = y0 + (this.ground(x1, z1) - y0) * k;
      dx = x1 - x0;
      dz = z1 - z0;
    } else {
      const k = (d - l1) / Math.max(1e-3, l2);
      x = x1 + (x2 - x1) * k;
      z = z1 + (z2 - z1) * k;
      y = this.ground(x, z);
      dx = x2 - x1;
      dz = z2 - z1;
    }
    root.position.set(x, y, z);
    if (dx * dx + dz * dz > 1e-6) root.rotation.set(0, -Math.atan2(dz, dx), 0);
    a.moving = true;
    a.speed = WALK;
    a.dist += WALK * dt;
  }

  update(dt: number, time: number) {
    this.time = time;
    this.frame++;
    // boarding walkers
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i];
      const root = w.model.root;
      const tm = this.modelOf(w.apc);
      w.d += WALK * dt;
      if (!tm || w.d >= w.len) {
        this.scene.remove(root);
        this.walkers.splice(i, 1);
        this.pool.push(w);
        continue;
      }
      const P = w.pts;
      let d = w.d;
      let k = 1;
      while (k < w.n - 1) {
        const l = Math.hypot(P[k * 3] - P[k * 3 - 3], P[k * 3 + 2] - P[k * 3 - 1]);
        if (d <= l) break;
        d -= l;
        k++;
      }
      const l = Math.max(1e-3, Math.hypot(P[k * 3] - P[k * 3 - 3], P[k * 3 + 2] - P[k * 3 - 1]));
      const f = Math.min(1, d / l);
      _a.set(P[k * 3 - 3], P[k * 3 - 2], P[k * 3 - 1]).lerp(_p.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]), f);
      root.position.copy(_a);
      if (k < w.n - 1) root.position.y = this.ground(_a.x, _a.z);
      root.rotation.set(0, -Math.atan2(P[k * 3 + 2] - P[k * 3 - 1], P[k * 3] - P[k * 3 - 3]), 0);
      root.visible = tm.root.visible;
      const a = w.anim;
      a.dt = dt;
      a.time = time;
      a.dist += WALK * dt;
      w.model.anim!(a);
    }
    // forget units not seen for a while (dead, garrisoned, inside)
    if (this.frame % 30 === 0) {
      for (const [id, st] of this.digs)
        if (this.frame - st.frame > 20) {
          this.leave(st);
          this.digs.delete(id);
        }
      for (const id of this.carriers.keys()) if (!this.world.get(id)) this.carriers.delete(id);
      for (const id of this.exits.keys()) if (!this.world.get(id)) this.exits.delete(id);
      if (this.boarding.size > 32) this.boarding.clear();
    }
    this.holes.update(dt);
  }

  dispose() {
    for (const w of this.walkers) this.scene.remove(w.model.root);
    this.walkers.length = 0;
    this.holes.dispose();
  }
}
