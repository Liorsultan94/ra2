import * as THREE from 'three';
import { standHeight, type GameMap } from '../sim/map';
import type { Entity } from '../sim/types';
import type { AnimState, Model, Region } from './models/types';

/*
 * Parachute canopies for the airborne-drop support power.
 *
 * Round military canopies (T-11 / D-10 / Type-specific shades: olive drab,
 * khaki, sand) for the jumpers and a larger cargo canopy for the supply
 * pallet. A canopy pops open out of a short streamer just after exit,
 * breathes and sways as a pendulum (the jumper's body swings under it),
 * then collapses downwind and fades once the load is on the ground.
 *
 * The renderer positions the body at the simulated (interpolated) position;
 * track() then moves it onto the pendulum and places the canopy above it.
 * Purely visual: Math.random / wall-clock time are fine here.
 */

const CANOPY: Record<Region, number> = {
  west: 0x5b5f3c, // olive drab
  east: 0x6a6942, // khaki-olive
  asia: 0x56643f, // green
  mideast: 0xb4a074, // sand
};
const CARGO_CANOPY = 0x6b6f44;

const GORES = 16;
const THETA0 = 0.16; // apex vent
const THETA1 = 1.2; // skirt
const FLAT = 0.62; // dome height ratio

interface Chute {
  id: number;
  cargo: boolean;
  root: THREE.Group; // origin at the skirt centre
  canopy: THREE.Mesh;
  lines: THREE.LineSegments;
  mat: THREE.MeshStandardMaterial;
  lineMat: THREE.LineBasicMaterial;
  R: number; // canopy radius
  drop: number; // skirt -> load attachment
  attach: number; // attachment height above the load's origin
  open: number; // 0..1 deploy animation clock (seconds since the pop / 0.45)
  seen: boolean;
  seed: number;
  state: 'air' | 'collapse';
  t: number;
  sway: THREE.Vector2;
  swayV: THREE.Vector2;
  yaw: number;
  ground: number;
  /** Dead jumper whose body we took over from the renderer. */
  body: { model: Model; anim: AnimState; landed: number } | null;
}

const geoCache = new Map<string, { dome: THREE.BufferGeometry; lines: THREE.BufferGeometry }>();

/** Unit canopy (radius 1, skirt at y = 0), gores shaded alternately, plus suspension lines converging at (0, -drop, 0). */
function canopyGeo(color: number, drop: number, cargo: boolean) {
  const key = `${color}|${drop}|${cargo}`;
  let g = geoCache.get(key);
  if (g) return g;
  const sg = new THREE.SphereGeometry(1, GORES * 2, 7, 0, Math.PI * 2, THETA0, THETA1 - THETA0);
  const dome = sg.toNonIndexed();
  sg.dispose();
  const pos = dome.attributes.position;
  const y0 = Math.cos(THETA1) * FLAT;
  // scallop the gores a little: each panel bulges between its seams
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const bulge = 1 + 0.035 * Math.abs(Math.sin((a * GORES) / 2));
    pos.setXYZ(i, x * bulge, pos.getY(i) * FLAT - y0, z * bulge);
  }
  const col = new Float32Array(pos.count * 3);
  const base = new THREE.Color(color);
  const c = new THREE.Color();
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const gore = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * GORES) % GORES;
    c.copy(base).multiplyScalar(gore % 2 ? 0.86 : 1.04);
    // darker skirt hem and a lighter crown
    if (cy < 0.05) c.multiplyScalar(0.72);
    else if (cy > FLAT - y0 - 0.12) c.multiplyScalar(1.1);
    if (cargo && gore % 4 === 0) c.lerp(new THREE.Color(0xc9c2a0), 0.35);
    for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], (t + v) * 3);
  }
  dome.setAttribute('color', new THREE.BufferAttribute(col, 3));
  dome.computeVertexNormals();
  // suspension lines: skirt -> risers (two risers per shoulder for a jumper, one point for cargo)
  const lp: number[] = [];
  for (let i = 0; i < GORES; i++) {
    const a = (i / GORES) * Math.PI * 2;
    const sx = Math.cos(a) * Math.sin(THETA1);
    const sz = Math.sin(a) * Math.sin(THETA1);
    const side = cargo ? 0 : Math.sin(a) >= 0 ? 1 : -1;
    lp.push(sx, 0, sz, 0, -drop, side * 0.18);
  }
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  g = { dome, lines };
  geoCache.set(key, g);
  return g;
}

const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Paradrop {
  private chutes = new Map<number, Chute>();

  constructor(private scene: THREE.Scene) {}

  has(id: number) {
    return this.chutes.has(id);
  }

  begin() {
    for (const c of this.chutes.values()) c.seen = false;
  }

  /**
   * An entity under canopy this frame. `p` is where the renderer placed the load (interpolated sim position, altitude included);
   * the load's root is moved onto the pendulum below the canopy.
   */
  track(e: Entity, model: Model, p: THREE.Vector3, yaw: number, region: Region, cargo: boolean, alpha: number, vis: boolean, time: number, dt: number, map: GameMap) {
    let c = this.chutes.get(e.id);
    if (!c) {
      c = this.make(e.id, cargo, region);
      c.yaw = yaw;
    }
    if (c.state !== 'air') return;
    c.seen = true;
    const pa = e.para;
    const u = pa ? Math.min(1, 1 - (pa.t - alpha) / pa.T) : 1;
    // the static line pops the canopy a moment after exit
    if (u > 0.06) c.open = Math.min(1, c.open + dt / 0.45);
    const o = c.open;
    const k = o < 1 ? 1 - Math.pow(1 - o, 3) : 1;
    const over = Math.sin(Math.min(1, o) * Math.PI) * 0.18;
    const breathe = 1 + 0.025 * Math.sin(time * 3.1 + c.seed * 9) * k;
    const sxz = (0.12 + 0.88 * k + over) * breathe;
    const sy = o <= 0 ? 1.8 : 1.8 - 0.8 * k - over * 0.6;
    c.canopy.scale.set(c.R * sxz, c.R * sy * (1 / breathe), c.R * sxz);
    c.lines.scale.set(c.R * sxz, c.R, c.R * sxz);
    // pendulum sway (stronger right after the opening shock)
    if (dt > 0) {
      const amp = 0.05 + 0.12 * Math.max(0, 1 - o * 1.4) * (o > 0 ? 1 : 0);
      const tx = Math.sin(time * 1.7 + c.seed * 11) * amp + Math.sin(time * 0.63 + c.seed * 3) * 0.04;
      const tz = Math.cos(time * 1.3 + c.seed * 7) * amp * 0.8;
      c.swayV.x += ((tx - c.sway.x) * 18 - c.swayV.x * 4) * dt;
      c.swayV.y += ((tz - c.sway.y) * 18 - c.swayV.y * 4) * dt;
      c.sway.x += c.swayV.x * dt;
      c.sway.y += c.swayV.y * dt;
    }
    c.yaw += Math.atan2(Math.sin(yaw - c.yaw), Math.cos(yaw - c.yaw)) * Math.min(1, dt * 2);
    // canopy centre above the load; before the pop the pack trails close above the jumper
    const lift = o <= 0 ? c.attach + 0.08 : c.attach + c.drop * (0.35 + 0.65 * k);
    c.root.position.set(p.x, p.y + lift, p.z);
    _qy.setFromAxisAngle(UP, c.yaw);
    _q.setFromEuler(_e.set(c.sway.y, 0, c.sway.x));
    c.root.quaternion.copy(_q).multiply(_qy);
    c.lines.visible = o > 0.15;
    c.canopy.visible = true;
    c.root.visible = vis;
    // the load hangs on the pendulum
    if (o > 0) {
      _v.set(0, -lift, 0).applyQuaternion(_q);
      model.root.position.set(p.x + _v.x, p.y + lift + _v.y, p.z + _v.z);
      model.root.quaternion.copy(_q).multiply(_qy.setFromAxisAngle(UP, yaw));
    }
    c.ground = standHeight(map, Math.max(0, Math.min(map.w - 0.01, p.x)), Math.max(0, Math.min(map.h - 0.01, p.z)));
  }

  /** A jumper killed under the canopy: the body keeps hanging and the canopy carries it down. Returns false if not airborne. */
  takeBody(id: number, model: Model, anim: AnimState): boolean {
    const c = this.chutes.get(id);
    if (!c || c.state !== 'air' || !model.infantry) return false;
    if (c.root.position.y - c.ground < c.attach + 0.25) return false;
    c.body = { model, anim: { ...anim, dead: 0, para: 1, moving: false }, landed: -1 };
    return true;
  }

  /** Canopies whose load landed (or died) collapse and fade; dead jumpers drift down first. */
  end(dt: number, time: number) {
    for (const c of [...this.chutes.values()]) {
      if (c.state === 'air' && !c.seen) {
        if (c.body) {
          // dead weight: steady descent, limp swing
          const y = c.root.position.y - dt * 0.42;
          const footY = y - c.drop - c.attach;
          const body = c.body;
          body.anim.dt = dt;
          body.anim.time = time;
          if (footY <= c.ground) {
            c.state = 'collapse';
            c.t = 0;
            body.landed = 0;
          } else {
            c.root.position.y = y;
            c.sway.x *= 1 - Math.min(1, dt * 0.8);
            _v.set(0, -(c.drop + c.attach), 0).applyQuaternion(c.root.quaternion);
            body.model.root.position.set(c.root.position.x + _v.x, c.root.position.y + _v.y, c.root.position.z + _v.z);
            body.model.root.quaternion.copy(c.root.quaternion);
            body.model.anim?.(body.anim);
          }
          continue;
        }
        c.state = 'collapse';
        c.t = 0;
      }
      if (c.state !== 'collapse') continue;
      c.t += dt;
      const k = Math.min(1, c.t / 1.4);
      const e = k * k * (3 - 2 * k);
      // the canopy spills its air and settles over downwind
      c.canopy.scale.y = c.R * Math.max(0.12, 1 - 0.88 * e);
      c.canopy.scale.x = c.canopy.scale.z = c.R * (1 + 0.18 * e);
      c.lines.visible = e < 0.4;
      const tilt = e * 1.25;
      _q.setFromEuler(_e.set(0, 0, -tilt));
      _qy.setFromAxisAngle(UP, c.yaw + c.seed);
      c.root.quaternion.copy(_qy).multiply(_q);
      const target = c.ground + 0.03;
      c.root.position.y += (target - c.root.position.y) * Math.min(1, dt * 3.2);
      const fwd = dt * 0.35 * (1 - e);
      c.root.position.x += Math.cos(c.yaw + c.seed) * fwd;
      c.root.position.z -= Math.sin(c.yaw + c.seed) * fwd;
      c.mat.opacity = c.t < 2.2 ? 1 : Math.max(0, 1 - (c.t - 2.2) / 1.2);
      c.mat.transparent = c.mat.opacity < 1;
      if (c.body) {
        const b = c.body;
        b.landed += dt;
        b.anim.dt = dt;
        b.anim.time = time;
        b.anim.dead = Math.max(0.001, b.landed);
        b.anim.para = 0;
        b.model.root.position.y = c.ground - Math.max(0, c.t - 2.6) * 0.25;
        b.model.anim?.(b.anim);
      }
      if (c.t > 3.4) this.dispose(c);
    }
  }

  clear() {
    for (const c of [...this.chutes.values()]) this.dispose(c);
  }

  private make(id: number, cargo: boolean, region: Region): Chute {
    const color = cargo ? CARGO_CANOPY : CANOPY[region];
    const R = cargo ? 0.4 : 0.24;
    const drop = cargo ? 0.42 : 0.42;
    const geo = canopyGeo(color, drop / R, cargo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2b2b26, transparent: true, opacity: 0.75 });
    const canopy = new THREE.Mesh(geo.dome, mat);
    canopy.castShadow = true;
    const lines = new THREE.LineSegments(geo.lines, lineMat);
    lines.scale.setScalar(R); // built in canopy-radius units
    const root = new THREE.Group();
    root.add(canopy, lines);
    this.scene.add(root);
    const c: Chute = {
      id,
      cargo,
      root,
      canopy,
      lines,
      mat,
      lineMat,
      R,
      drop,
      attach: cargo ? 0.22 : 0.27,
      open: 0,
      seen: true,
      seed: Math.random() * 10,
      state: 'air',
      t: 0,
      sway: new THREE.Vector2(),
      swayV: new THREE.Vector2(),
      yaw: 0,
      ground: 0,
      body: null,
    };
    this.chutes.set(id, c);
    return c;
  }

  private dispose(c: Chute) {
    this.scene.remove(c.root);
    c.mat.dispose();
    c.lineMat.dispose();
    if (c.body) {
      c.body.model.root.parent?.remove(c.body.model.root);
    }
    this.chutes.delete(c.id);
  }
}
