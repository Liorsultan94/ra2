import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WATER_LEVEL, type GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { HEAT_LAYER } from '../thermal';
import { waterRings, type RiverInfo } from '../water';
import { boatGeometry } from '../waterside';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from './shared';

/*
 * Life in the river (purely visual): ducks paddling in the quiet shallows
 * that hurry off from blasts and passing units and take flight when it gets
 * close; fish jumping now and then; dragonflies darting over the reeds on
 * warm days; and a couple of fishing boats working slowly up and down the
 * river, who run for the jetty (or away from the shooting) once combat
 * starts nearby, and come out again when it has been quiet for a while.
 * Four instanced draw calls (ducks, fish, dragonflies, boats), each skipped
 * while nothing of its kind is visible.
 */

const enum D {
  Paddle = 0,
  Flee = 1,
  Fly = 2,
}

interface Duck {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  ox: number;
  oy: number;
  phase: number;
  male: boolean;
  wakeT: number;
}

interface Flock {
  s: D;
  t: number;
  hx: number;
  hy: number;
  fx: number;
  fy: number;
  ducks: Duck[];
  /** Flight: destination. */
  lx: number;
  ly: number;
}

interface Fish {
  x: number;
  y: number;
  dx: number;
  dy: number;
  t: number;
  on: boolean;
}

interface Fly {
  ax: number;
  ay: number;
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  t: number;
  yaw: number;
}

const enum B {
  Cruise = 0,
  Flee = 1,
  Moor = 2,
}

interface Boat {
  s: number;
  off: number;
  dir: number;
  speed: number;
  st: B;
  /** Seconds since the last fright. */
  calm: number;
  x: number;
  y: number;
  yaw: number;
  wakeT: number;
  lo: number;
  hi: number;
  paint: THREE.Color;
  mx: number;
  my: number;
  myaw: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = { x: 0, y: 0 };

function colored(g: THREE.BufferGeometry, hex: number, wing = 0): THREE.BufferGeometry {
  const o = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(o.attributes)) if (k !== 'position' && k !== 'normal') o.deleteAttribute(k);
  const n = o.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const a = new Float32Array(n * 3);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
    w[i] = wing;
  }
  o.setAttribute('color', new THREE.BufferAttribute(a, 3));
  o.setAttribute('wing', new THREE.BufferAttribute(w, 1));
  return o;
}

/** Mallard, bill along +x, waterline at y = 0. `wing` marks the wing vertices (flap in the shader). */
function duckGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(1, 10, 6);
  body.scale(0.085, 0.045, 0.05).translate(0, 0.018, 0);
  const breast = new THREE.SphereGeometry(1, 8, 6);
  breast.scale(0.04, 0.035, 0.04).translate(0.045, 0.03, 0);
  const tail = new THREE.ConeGeometry(0.025, 0.05, 5);
  tail.rotateZ(Math.PI / 2).translate(-0.095, 0.035, 0);
  const neck = new THREE.CylinderGeometry(0.015, 0.02, 0.05, 6);
  neck.translate(0.06, 0.07, 0);
  const head = new THREE.SphereGeometry(0.027, 8, 6);
  head.scale(1.15, 1, 0.9).translate(0.07, 0.1, 0);
  const bill = new THREE.BoxGeometry(0.04, 0.008, 0.018);
  bill.translate(0.1, 0.093, 0);
  const ring = new THREE.CylinderGeometry(0.0185, 0.0185, 0.006, 8);
  ring.translate(0.062, 0.078, 0);
  const wingL = new THREE.BoxGeometry(0.08, 0.006, 0.11);
  wingL.translate(-0.005, 0.045, 0.058);
  const wingR = new THREE.BoxGeometry(0.08, 0.006, 0.11);
  wingR.translate(-0.005, 0.045, -0.058);
  return mergeGeometries([
    colored(body, 0xa8a49c),
    colored(breast, 0x6a3a26),
    colored(tail, 0x2a2a2a),
    colored(neck, 0x1e4a2a),
    colored(head, 0x1e5a32),
    colored(bill, 0xd8b030),
    colored(ring, 0xe8e8e0),
    colored(wingL, 0x8a8278, 1),
    colored(wingR, 0x8a8278, 1),
  ])!;
}

function fishGeometry(): THREE.BufferGeometry {
  const b = new THREE.SphereGeometry(1, 8, 5);
  b.scale(0.06, 0.018, 0.013);
  const t = new THREE.ConeGeometry(0.018, 0.03, 4);
  t.rotateZ(-Math.PI / 2).scale(1, 1, 0.3).translate(-0.07, 0, 0);
  return mergeGeometries([colored(b, 0xb8c0c4), colored(t, 0x8a949a)])!;
}

function dragonflyGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.07, 0.006, 0.006);
  const head = new THREE.SphereGeometry(0.006, 5, 4).translate(0.037, 0, 0);
  const parts = [colored(body, 0x1a6a8a), colored(head, 0x2a8a6a)];
  for (const [x, w] of [
    [0.012, 1],
    [-0.004, 0.85],
  ])
    for (const sd of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.014, 0.001, 0.04 * w);
      g.translate(x, 0.003, sd * 0.022 * w);
      parts.push(colored(g, 0xd8e4ea, 1));
    }
  return mergeGeometries(parts)!;
}

function flapMaterial(fog: FogOfWar, key: string): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wing;\nattribute vec3 aFlap;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        if (wing > 0.5) {
          // aFlap: x phase, y flap amplitude, z spread (0 folded .. 1 open)
          float side = transformed.z > 0.0 ? 1.0 : -1.0;
          float span = abs(transformed.z);
          float sp = span * mix(0.32, 1.0, aFlap.z);
          transformed.z = side * sp;
          transformed.y += sp * sin(aFlap.x) * aFlap.y;
        }`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => `fog2-flap-${key}`;
  return mat;
}

class Inst {
  readonly mesh: THREE.InstancedMesh;
  private flap: THREE.InstancedBufferAttribute | null = null;
  n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly max: number, name: string, flap: boolean, color: boolean) {
    const g = geo;
    if (flap) {
      this.flap = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      this.flap.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aFlap', this.flap);
    }
    const m = new THREE.InstancedMesh(g, mat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (color) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    m.name = name;
    m.layers.enable(HEAT_LAYER);
    this.mesh = m;
  }
  push(mat: THREE.Matrix4, f0 = 0, f1 = 0, f2 = 0, c?: THREE.Color) {
    if (this.n >= this.max) return;
    const i = this.n++;
    mat.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    if (this.flap) {
      const a = this.flap.array as Float32Array;
      a[i * 3] = f0;
      a[i * 3 + 1] = f1;
      a[i * 3 + 2] = f2;
    }
    if (c && this.mesh.instanceColor) this.mesh.setColorAt(i, c);
  }
  commit() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (!this.n) return;
    m.instanceMatrix.needsUpdate = true;
    if (this.flap) this.flap.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

const BOAT_PAINT = [0x2a5a7a, 0x8a2a22, 0x2a6a3a, 0xc8b890].map((c) => new THREE.Color(c));
const MALE = new THREE.Color(1, 1, 1);
const FEMALE = new THREE.Color(0.78, 0.62, 0.48);

export class RiverLife {
  readonly group = new THREE.Group();
  private flocks: Flock[] = [];
  private fish: Fish[] = [];
  private flies: Fly[] = [];
  private boats: Boat[] = [];
  private duckI: Inst;
  private fishI: Inst;
  private flyI: Inst;
  private boatI: Inst;
  private spots: { x: number; y: number }[] = [];
  private reedSpots: { x: number; y: number }[] = [];
  private fishT = 3;
  private time = 0;
  private sLo = 0;
  private sHi = 0;

  constructor(
    map: GameMap,
    private river: RiverInfo,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
    phone: boolean,
  ) {
    this.group.name = 'river-life';
    const r = river;
    const f = r.features;
    // quiet water by the banks: duck spots; the shallows' edge: reed spots for the dragonflies
    const inside = r.samples.filter((c) => c.x > 3 && c.y > 3 && c.x < map.w - 3 && c.y < map.h - 3);
    this.sLo = inside.length ? inside[0].s + 2 : 0;
    this.sHi = inside.length ? inside[inside.length - 1].s - 2 : 0;
    const busy = (x: number, y: number) => {
      for (const b of map.bridges) if (Math.hypot(x - b.x, y - b.y) < b.length / 2 + 1.5) return true;
      if (f.weir && Math.hypot(x - f.weir.x, y - f.weir.y) < f.weir.half + 1.5) return true;
      if (f.rapids) {
        const s = r.sAt(x, y);
        if (s > f.rapids.s0 - 2 && s < f.rapids.s1 + 3) return true;
      }
      return false;
    };
    for (let k = 0; k < 2000 && inside.length && (this.spots.length < 40 || this.reedSpots.length < 40); k++) {
      // a random point across the river at a random spot along it
      const c = inside[Math.floor(Math.random() * inside.length)];
      const p = r.at(c.s, (Math.random() - 0.5) * (c.width + 1.2));
      const x = p.x;
      const y = p.y;
      if (x < 1 || y < 1 || x > map.w - 1 || y > map.h - 1 || busy(x, y)) continue;
      const sh = r.shoreAt(x, y);
      if (sh > 0.35 && sh < 1.1 && this.spots.length < 40) this.spots.push({ x, y });
      const d = r.depthAt(x, y);
      if (d > -0.06 && d < 0.06 && this.reedSpots.length < 40) this.reedSpots.push({ x, y });
    }
    const nFlocks = this.spots.length ? (quality === 'low' ? 2 : phone ? 3 : 4) : 0;
    let nd = 0;
    for (let i = 0; i < nFlocks; i++) {
      const sp = this.spots[Math.floor(Math.random() * this.spots.length)];
      const fl: Flock = { s: D.Paddle, t: 0, hx: sp.x, hy: sp.y, fx: 0, fy: 0, ducks: [], lx: sp.x, ly: sp.y };
      const n = 3 + Math.floor(Math.random() * 4);
      for (let j = 0; j < n; j++) {
        const ox = (Math.random() - 0.5) * 0.9;
        const oy = (Math.random() - 0.5) * 0.9;
        fl.ducks.push({ x: sp.x + ox, y: sp.y + oy, z: 0, yaw: Math.random() * 6.28, vx: 0, vy: 0, ox, oy, phase: Math.random() * 6.28, male: Math.random() < 0.5, wakeT: Math.random() });
      }
      nd += n;
      this.flocks.push(fl);
    }
    for (let i = 0; i < 3; i++) this.fish.push({ x: 0, y: 0, dx: 1, dy: 0, t: 0, on: false });
    const nFly = this.reedSpots.length ? (quality === 'low' ? 4 : phone ? 7 : 10) : 0;
    for (let i = 0; i < nFly; i++) {
      const sp = this.reedSpots[Math.floor(Math.random() * this.reedSpots.length)];
      this.flies.push({ ax: sp.x, ay: sp.y, x: sp.x, y: sp.y, z: WATER_LEVEL + 0.3, tx: sp.x, ty: sp.y, tz: WATER_LEVEL + 0.3, t: Math.random(), yaw: 0 });
    }
    // fishing boats: between the map edges, never over the weir
    const nBoats = r.samples.length > 20 ? (quality === 'low' || phone ? 1 : 2) : 0;
    for (let i = 0; i < nBoats; i++) {
      let lo = this.sLo;
      let hi = this.sHi;
      const s = lo + 6 + Math.random() * Math.max(1, hi - lo - 12);
      if (f.weir) {
        if (s < f.weir.s) hi = Math.min(hi, f.weir.s - 1.5);
        else lo = Math.max(lo, f.weir.s + 1.5);
      }
      const p = r.at(s);
      this.boats.push({ s, off: (Math.random() - 0.5) * 0.8, dir: Math.random() < 0.5 ? 1 : -1, speed: 0.22, st: B.Cruise, calm: 100, x: p.x, y: p.y, yaw: 0, wakeT: 0, lo: lo + 1.5, hi: hi - 1.5, paint: BOAT_PAINT[i % BOAT_PAINT.length], mx: 0, my: 0, myaw: 0 });
    }
    // mooring spots off the jetty
    const j = f.jetty;
    this.boats.forEach((b, i) => {
      if (!j) return;
      const along = j.len - 0.25 - i * 0.55;
      const side = i % 2 ? -0.42 : 0.42;
      b.mx = j.x + j.dx * along - j.dy * side;
      b.my = j.y + j.dy * along + j.dx * side;
      b.myaw = Math.atan2(-j.dy, j.dx) + Math.PI;
    });
    this.duckI = new Inst(duckGeometry(), flapMaterial(fog, 'duck'), Math.max(1, nd), 'ambient-ducks', true, true);
    this.fishI = new Inst(fishGeometry(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.4 })), 3, 'ambient-fish', false, false);
    this.flyI = new Inst(dragonflyGeometry(), flapMaterial(fog, 'fly'), Math.max(1, nFly), 'ambient-dragonflies', true, false);
    this.boatI = new Inst(boatGeometry('fish'), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })), Math.max(1, nBoats), 'ambient-boats', false, true);
    this.boatI.mesh.castShadow = quality !== 'low';
    this.group.add(this.duckI.mesh, this.fishI.mesh, this.flyI.mesh, this.boatI.mesh);
  }

  get count() {
    let n = 0;
    for (const f of this.flocks) n += f.ducks.length;
    return { ducks: n, flying: this.flocks.filter((f) => f.s === D.Fly).length, fleeing: this.flocks.filter((f) => f.s === D.Flee).length, boats: this.boats.map((b) => b.st), flies: this.flies.length };
  }

  private wet(x: number, y: number) {
    return this.river.shoreAt(x, y) > 0.15;
  }

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    this.time += dt;
    this.updateDucks(f, dt);
    this.updateFish(f, dt);
    this.updateFlies(f, dt);
    this.updateBoats(f, dt);
  }

  // --------------------------------------------------------------- ducks

  private updateDucks(f: AmbientFrame, dt: number) {
    const r = this.river;
    for (const fl of this.flocks) {
      fl.t += dt;
      // frights: blasts / gunfire, a unit or a low aircraft close by
      if (fl.s !== D.Fly) {
        let sx = 0;
        let sy = 0;
        let k = 0;
        for (const d of f.dangers) {
          const dist = Math.hypot(fl.hx - d.x, fl.hy - d.y);
          if (dist < d.r * 1.2 + 2) {
            const kk = d.power * (dist < d.r * 0.6 + 1.5 ? 2 : 1);
            if (kk > k) {
              k = kk;
              sx = d.x;
              sy = d.y;
            }
          }
        }
        for (let i = 0; i < f.nUnits; i++) {
          const dist = Math.hypot(fl.hx - f.units[i * 2], fl.hy - f.units[i * 2 + 1]);
          if (dist < 2.6 && 0.5 > k) {
            k = 0.5;
            sx = f.units[i * 2];
            sy = f.units[i * 2 + 1];
          }
        }
        for (let i = 0; i < f.nAir; i++) {
          if (Math.hypot(fl.hx - f.air[i * 2], fl.hy - f.air[i * 2 + 1]) < 3 && 1.2 > k) {
            k = 1.2;
            sx = f.air[i * 2];
            sy = f.air[i * 2 + 1];
          }
        }
        if (k >= 1) this.takeOff(fl, sx, sy);
        else if (k > 0) {
          // paddle off along the river, away from it
          fl.s = D.Flee;
          fl.t = 0;
          const c = r.sample(r.sAt(fl.hx, fl.hy));
          const tx = c ? c.tx : 1;
          const ty = c ? c.ty : 0;
          const sgn = (fl.hx - sx) * tx + (fl.hy - sy) * ty >= 0 ? 1 : -1;
          fl.fx = tx * sgn;
          fl.fy = ty * sgn;
        }
      }
      if (fl.s === D.Flee) {
        // the home point hurries away; ducks follow at full paddle
        const nx = fl.hx + fl.fx * dt * 0.75;
        const ny = fl.hy + fl.fy * dt * 0.75;
        if (this.wet(nx, ny)) {
          fl.hx = nx;
          fl.hy = ny;
        }
        if (fl.t > 4.5) fl.s = D.Paddle;
      }
      if (fl.s === D.Fly) {
        this.flyDucks(fl, dt);
        continue;
      }
      // slow drift with the current, the home point wanders along the bank
      r.velAt(fl.hx, fl.hy, _v);
      const wx = fl.hx + Math.sin(this.time * 0.05 + fl.lx) * 0.004;
      const wy = fl.hy + Math.cos(this.time * 0.05 + fl.ly) * 0.004;
      if (this.wet(wx, wy) && r.shoreAt(wx, wy) < 1.3) {
        fl.hx = wx;
        fl.hy = wy;
      }
      const fast = fl.s === D.Flee;
      for (const d of fl.ducks) {
        d.phase += dt * (fast ? 9 : 3);
        // each duck wanders round its slot
        if (Math.random() < dt * 0.25) {
          d.ox = (Math.random() - 0.5) * 1.1;
          d.oy = (Math.random() - 0.5) * 1.1;
        }
        const tx = fl.hx + d.ox;
        const ty = fl.hy + d.oy;
        const dx = tx - d.x;
        const dy = ty - d.y;
        const l = Math.hypot(dx, dy);
        const sp = fast ? 0.9 : 0.12;
        const ax = l > 0.05 ? (dx / l) * sp : 0;
        const ay = l > 0.05 ? (dy / l) * sp : 0;
        d.vx += (ax - d.vx) * Math.min(1, dt * 2) + _v.x * dt * 0.3;
        d.vy += (ay - d.vy) * Math.min(1, dt * 2) + _v.y * dt * 0.3;
        const nx = d.x + d.vx * dt;
        const ny = d.y + d.vy * dt;
        if (this.wet(nx, ny)) {
          d.x = nx;
          d.y = ny;
        } else {
          d.vx *= -0.5;
          d.vy *= -0.5;
        }
        const spd = Math.hypot(d.vx, d.vy);
        if (spd > 0.03) {
          const want = Math.atan2(-d.vy, d.vx);
          let da = want - d.yaw;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          d.yaw += da * Math.min(1, dt * 4);
        }
        d.z = WATER_LEVEL + Math.sin(this.time * 2 + d.phase) * 0.004;
        d.wakeT -= dt * (fast ? 4 : spd > 0.08 ? 1 : 0.25);
        if (d.wakeT <= 0) {
          d.wakeT = 1;
          if (d.x > f.vx0 && d.x < f.vx1 && d.y > f.vy0 && d.y < f.vy1 && this.probe.visible(d.x, d.y)) waterRings.add(d.x, d.y, fast ? 0.12 : 0.05);
        }
      }
    }
  }

  private takeOff(fl: Flock, sx: number, sy: number) {
    fl.s = D.Fly;
    fl.t = 0;
    // land again somewhere quiet, far from the fright
    let best = this.spots[0];
    let bd = -1;
    for (let i = 0; i < 8; i++) {
      const sp = this.spots[Math.floor(Math.random() * this.spots.length)];
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d > bd && d < 40) {
        bd = d;
        best = sp;
      }
    }
    fl.lx = best.x;
    fl.ly = best.y;
    let dx = fl.hx - sx;
    let dy = fl.hy - sy;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    for (const d of fl.ducks) {
      d.vx = dx * (1.5 + Math.random()) + (Math.random() - 0.5);
      d.vy = dy * (1.5 + Math.random()) + (Math.random() - 0.5);
      if (this.probe.visible(d.x, d.y)) waterRings.add(d.x, d.y, 0.22);
    }
  }

  private flyDucks(fl: Flock, dt: number) {
    let landed = 0;
    for (const d of fl.ducks) {
      d.phase += dt * 16;
      const tx = fl.lx + d.ox;
      const ty = fl.ly + d.oy;
      const dx = tx - d.x;
      const dy = ty - d.y;
      const l = Math.hypot(dx, dy);
      const cruise = fl.t > 1.2;
      if (cruise) {
        const sp = Math.min(3.2, 0.4 + l * 0.8);
        d.vx += ((dx / (l || 1)) * sp - d.vx) * Math.min(1, dt * 1.2);
        d.vy += ((dy / (l || 1)) * sp - d.vy) * Math.min(1, dt * 1.2);
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const alt = cruise ? Math.min(2.2, l * 0.35) : fl.t * 1.6;
      d.z += (WATER_LEVEL + alt - d.z) * Math.min(1, dt * 2.5);
      d.yaw = Math.atan2(-d.vy, d.vx);
      if (cruise && l < 0.15 && d.z < WATER_LEVEL + 0.06) landed++;
    }
    if (landed === fl.ducks.length || fl.t > 30) {
      fl.s = D.Paddle;
      fl.hx = fl.lx;
      fl.hy = fl.ly;
      for (const d of fl.ducks) {
        if (!this.wet(d.x, d.y)) {
          d.x = fl.lx + d.ox * 0.5;
          d.y = fl.ly + d.oy * 0.5;
        }
        d.z = WATER_LEVEL;
        d.vx = d.vy = 0;
        if (this.probe.visible(d.x, d.y)) waterRings.add(d.x, d.y, 0.15);
      }
    }
  }

  // --------------------------------------------------------------- fish

  private updateFish(f: AmbientFrame, dt: number) {
    this.fishT -= dt;
    if (this.fishT <= 0 && f.dark < 0.85) {
      this.fishT = 2.5 + Math.random() * 5;
      const fish = this.fish.find((x) => !x.on);
      if (fish) {
        // somewhere in view, in open water
        for (let k = 0; k < 12; k++) {
          const x = f.vx0 + 3 + Math.random() * Math.max(0, f.vx1 - f.vx0 - 6);
          const y = f.vy0 + 3 + Math.random() * Math.max(0, f.vy1 - f.vy0 - 6);
          if (this.river.shoreAt(x, y) < 0.6 || !this.probe.visible(x, y)) continue;
          const a = Math.random() * Math.PI * 2;
          fish.x = x;
          fish.y = y;
          fish.dx = Math.cos(a);
          fish.dy = Math.sin(a);
          fish.t = 0;
          fish.on = true;
          waterRings.add(x, y, 0.16);
          break;
        }
      }
    }
    for (const fish of this.fish) {
      if (!fish.on) continue;
      fish.t += dt / 0.65;
      if (fish.t >= 1) {
        fish.on = false;
        waterRings.add(fish.x + fish.dx * 0.32, fish.y + fish.dy * 0.32, 0.2);
      }
    }
  }

  // --------------------------------------------------------------- dragonflies

  private updateFlies(f: AmbientFrame, dt: number) {
    const on = f.dark < 0.35 && !f.foul;
    if (!on) return;
    for (const d of this.flies) {
      d.t -= dt;
      if (d.t <= 0) {
        // dart to a new hover point near the reeds
        d.t = 0.6 + Math.random() * 1.8;
        d.tx = d.ax + (Math.random() - 0.5) * 1.6;
        d.ty = d.ay + (Math.random() - 0.5) * 1.6;
        d.tz = WATER_LEVEL + 0.15 + Math.random() * 0.3;
      }
      const k = Math.min(1, dt * 5);
      const px = d.x;
      const py = d.y;
      d.x += (d.tx - d.x) * k;
      d.y += (d.ty - d.y) * k;
      d.z += (d.tz - d.z) * k;
      if (Math.abs(d.x - px) + Math.abs(d.y - py) > 0.002) d.yaw = Math.atan2(-(d.y - py), d.x - px);
    }
  }

  // --------------------------------------------------------------- boats

  private updateBoats(f: AmbientFrame, dt: number) {
    const r = this.river;
    const j = r.features.jetty;
    for (const b of this.boats) {
      b.calm += dt;
      // combat nearby: run for the jetty if it is on this stretch, else away from it
      let near = false;
      let sx = 0;
      let sy = 0;
      for (const d of f.dangers) {
        if (d.power >= 0.3 && Math.hypot(b.x - d.x, b.y - d.y) < 14) {
          near = true;
          sx = d.x;
          sy = d.y;
        }
      }
      for (let i = 0; i < f.nUnits && !near; i++) if (Math.hypot(b.x - f.units[i * 2], b.y - f.units[i * 2 + 1]) < 3.5) near = true;
      if (near) {
        b.calm = 0;
        if (b.st === B.Cruise) {
          b.st = B.Flee;
          if (!(j && j.s > b.lo && j.s < b.hi)) b.dir = (b.x - sx) * (r.sample(b.s)?.tx ?? 1) + (b.y - sy) * (r.sample(b.s)?.ty ?? 0) >= 0 ? 1 : -1;
        }
      }
      if (b.st === B.Moor) {
        if (b.calm > 35) {
          b.st = B.Cruise;
          b.dir = Math.random() < 0.5 ? 1 : -1;
          b.s = r.sAt(b.x, b.y);
        } else {
          // tied up: bob alongside
          b.x += (b.mx - b.x) * Math.min(1, dt * 0.8);
          b.y += (b.my - b.y) * Math.min(1, dt * 0.8);
          b.yaw += (b.myaw - b.yaw) * Math.min(1, dt * 0.8);
          continue;
        }
      }
      if (b.st === B.Flee && b.calm > 25) b.st = B.Cruise;
      let speed = b.st === B.Flee ? 0.75 : 0.22;
      let off = b.off;
      if (b.st === B.Flee && j && j.s > b.lo && j.s < b.hi) {
        // to the jetty
        b.dir = j.s > b.s ? 1 : -1;
        const js = r.sAt(b.mx, b.my);
        if (Math.abs(js - b.s) < 0.6) {
          b.st = B.Moor;
          continue;
        }
        const c = r.sample(js);
        if (c) off = -(b.mx - c.x) * c.ty + (b.my - c.y) * c.tx;
        speed = Math.min(speed, 0.2 + Math.abs(js - b.s) * 0.3);
      }
      b.s += b.dir * speed * dt;
      if (b.s > b.hi) {
        b.s = b.hi;
        b.dir = -1;
      } else if (b.s < b.lo) {
        b.s = b.lo;
        b.dir = 1;
      }
      const c = r.sample(b.s);
      if (!c) continue;
      // keep clear of the banks
      const lim = Math.max(0, c.width / 2 - 0.55);
      const o = Math.max(-lim, Math.min(lim, off));
      const p = r.at(b.s, o, _v);
      b.x += (p.x - b.x) * Math.min(1, dt * 1.5);
      b.y += (p.y - b.y) * Math.min(1, dt * 1.5);
      const want = Math.atan2(-c.ty * b.dir, c.tx * b.dir);
      let da = want - b.yaw;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      b.yaw += da * Math.min(1, dt * 1.2);
      b.wakeT -= dt * (speed > 0.5 ? 2.2 : 1);
      if (b.wakeT <= 0) {
        b.wakeT = 0.9;
        if (b.x > f.vx0 && b.x < f.vx1 && b.y > f.vy0 && b.y < f.vy1 && this.probe.visible(b.x, b.y)) waterRings.add(b.x - Math.cos(b.yaw) * 0.25, b.y + Math.sin(b.yaw) * 0.25, speed > 0.5 ? 0.3 : 0.12);
      }
      if (Math.random() < dt * 0.02) b.off = (Math.random() - 0.5) * c.width * 0.35;
    }
  }

  // --------------------------------------------------------------- draw

  draw(f: AmbientFrame) {
    const inView = (x: number, y: number) => x > f.vx0 && x < f.vx1 && y > f.vy0 && y < f.vy1 && this.probe.visible(x, y);
    const t = this.time;
    // ducks
    const di = this.duckI;
    di.n = 0;
    for (const fl of this.flocks) {
      const flying = fl.s === D.Fly;
      for (const d of fl.ducks) {
        if (!inView(d.x, d.y)) continue;
        const pitch = flying ? -0.15 : Math.sin(t * 1.3 + d.phase) * 0.04;
        _e.set(Math.sin(t * 1.7 + d.phase) * 0.05, d.yaw, pitch, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(d.x, d.z, d.y), _q, _s.set(1.15, 1.15, 1.15));
        di.push(_m, d.phase, flying ? 0.9 : 0, flying ? 1 : 0, d.male ? MALE : FEMALE);
      }
    }
    di.commit();
    // jumping fish
    const fi = this.fishI;
    fi.n = 0;
    for (const fish of this.fish) {
      if (!fish.on || !inView(fish.x, fish.y)) continue;
      const u = fish.t;
      const x = fish.x + fish.dx * 0.32 * u;
      const y = fish.y + fish.dy * 0.32 * u;
      const h = WATER_LEVEL - 0.02 + Math.sin(u * Math.PI) * 0.2;
      _e.set(0, Math.atan2(-fish.dy, fish.dx), Math.cos(u * Math.PI) * 0.9, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, h, y), _q, _s.set(1.3, 1.3, 1.3));
      fi.push(_m);
    }
    fi.commit();
    // dragonflies
    const ri = this.flyI;
    ri.n = 0;
    if (f.dark < 0.35 && !f.foul)
      for (const d of this.flies) {
        if (!inView(d.x, d.y)) continue;
        _e.set(0, d.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(d.x, d.z + Math.sin(t * 9 + d.ax) * 0.01, d.y), _q, _s.set(1.4, 1.4, 1.4));
        ri.push(_m, t * 60 + d.ax * 10, 0.5, 1);
      }
    ri.commit();
    // boats (a lantern on the wheelhouse at night)
    const bi = this.boatI;
    bi.n = 0;
    for (const b of this.boats) {
      if (!inView(b.x, b.y)) continue;
      const fast = b.st === B.Flee;
      _e.set(Math.sin(t * 1.2 + b.lo) * 0.04, b.yaw, (fast ? 0.06 : 0.015) + Math.sin(t * 0.9 + b.hi) * 0.02, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(b.x, WATER_LEVEL - 0.01 + Math.sin(t * 1.4 + b.lo) * 0.006, b.y), _q, _s.set(1, 1, 1));
      bi.push(_m, 0, 0, 0, b.paint);
      if (f.dark > 0.45) {
        const c = Math.cos(b.yaw);
        const s = Math.sin(b.yaw);
        this.lights.flare(b.x - c * 0.16, WATER_LEVEL + 0.24, b.y + s * 0.16, 0.22, 1.4, 1.0, 0.55);
      }
    }
    bi.commit();
  }
}
