import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { FieldType, type Field, type Layout } from '../layout';
import { cowModel, sheepModel } from './models';
import { AnimInstances, ambientMaterial, groundAt, walkable, wrapAngle, type AmbientFrame, type FogProbe, type Quality } from './shared';

/*
 * Livestock: small herds of cows and sheep in the pastures (fallow / green
 * fields of the scenery layout). They graze with their heads down, wander a
 * few steps at a time and keep loosely together. Explosions, gunfire and
 * military units send the whole herd running away; after a while they calm
 * down and amble back to their field. Animals caught in a blast are killed.
 *
 * Legs, head and body bob are animated in the vertex shader: one instanced
 * draw call per species.
 */

const enum A {
  Graze = 0,
  Walk = 1,
  Panic = 2,
  Alert = 3,
  Return = 4,
  Dead = 5,
}

interface Animal {
  x: number;
  y: number;
  yaw: number;
  v: number;
  s: A;
  t: number;
  tx: number;
  ty: number;
  head: number;
  phase: number;
  gait: number;
  roll: number;
  hgt: number;
  paint: THREE.Color;
  fx: number;
  fy: number;
  size: number;
}

interface Herd {
  sp: number; // 0 cow, 1 sheep
  f: Field;
  animals: Animal[];
}

const COW_COATS = [0x2a2522, 0x6b4a32, 0x8a5a36, 0xe8e2d8, 0x3a2e28, 0xb08860, 0x5a3a28].map((c) => new THREE.Color(c));
const SHEEP_COATS = [0xe8e2d2, 0xdcd4c0, 0xf0ebe0, 0xcfc6b2, 0x8a8278].map((c) => new THREE.Color(c));
const WALK = [0.13, 0.16];
const RUN = [0.95, 1.15];
const BODY_Y = [0.165, 0.13];
const HALF_W = [0.065, 0.07];

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Animals {
  readonly group = new THREE.Group();
  private herds: Herd[] = [];
  private inst: AnimInstances[] = [];

  constructor(
    private map: GameMap,
    layout: Layout,
    fog: FogOfWar,
    private probe: FogProbe,
    quality: Quality,
    phone: boolean,
  ) {
    const m = map;
    const nHerds = Math.round((quality === 'high' ? 7 : quality === 'medium' ? 5 : 3) * (phone ? 0.75 : 1));
    const pastures = layout.fields
      .filter((f) => (f.type === FieldType.Fallow || f.type === FieldType.Green) && f.hl > 1 && f.hw > 0.8)
      .filter((f) => m.starts.every((s) => Math.hypot(s.x - f.cx, s.y - f.cy) > 11) && walkable(m, f.cx, f.cy));
    // spread over the map: shuffle, then take every other where possible
    for (let i = pastures.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pastures[i], pastures[j]] = [pastures[j], pastures[i]];
    }
    for (const f of pastures.slice(0, nHerds)) {
      const sp = Math.random() < 0.55 ? 0 : 1;
      const n = sp === 0 ? 3 + Math.floor(Math.random() * 4) : 5 + Math.floor(Math.random() * 5);
      const herd: Herd = { sp, f, animals: [] };
      const coats = sp === 0 ? COW_COATS : SHEEP_COATS;
      const base = coats[(Math.random() * coats.length) | 0];
      for (let i = 0; i < n; i++) {
        const p = this.fieldPoint(f, 0.6);
        // mostly one breed per herd, the odd different coat
        const coat = (Math.random() < 0.7 ? base : coats[(Math.random() * coats.length) | 0]).clone().multiplyScalar(0.9 + Math.random() * 0.2);
        herd.animals.push({ x: p.x, y: p.y, yaw: Math.random() * 6.28, v: 0, s: A.Graze, t: Math.random() * 10, tx: p.x, ty: p.y, head: 1, phase: Math.random() * 6, gait: 0, roll: 0, hgt: groundAt(m, p.x, p.y), paint: coat, fx: 0, fy: 0, size: 0.9 + Math.random() * 0.2 });
      }
      this.herds.push(herd);
    }
    const cow = cowModel();
    const sheep = sheepModel();
    let nc = 0;
    let ns = 0;
    for (const h of this.herds) (h.sp ? (ns += h.animals.length) : (nc += h.animals.length));
    for (const [i, mdl, n] of [
      [0, cow, nc],
      [1, sheep, ns],
    ] as const) {
      const mat = ambientMaterial(fog, 'animal', mdl.rig, 0.95, 0);
      const inst = new AnimInstances(mdl.geo, mat, Math.max(1, n), i ? 'ambient-sheep' : 'ambient-cows', { shadow: quality === 'high', heat: true });
      this.inst.push(inst);
      this.group.add(inst.mesh);
    }
  }

  private fieldPoint(f: Field, spread: number) {
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (let k = 0; k < 8; k++) {
      const a = (Math.random() - 0.5) * 2 * Math.max(0.2, f.hl - 0.4) * spread;
      const b = (Math.random() - 0.5) * 2 * Math.max(0.2, f.hw - 0.3) * spread;
      const x = f.cx + ca * a - sa * b;
      const y = f.cy + sa * a + ca * b;
      if (walkable(this.map, x, y)) return { x, y };
    }
    return { x: f.cx, y: f.cy };
  }

  private inField(f: Field, x: number, y: number) {
    const dx = x - f.cx;
    const dy = y - f.cy;
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    return Math.abs(dx * ca + dy * sa) < f.hl && Math.abs(-dx * sa + dy * ca) < f.hw;
  }

  get count() {
    let n = 0;
    for (const h of this.herds) n += h.animals.length;
    return n;
  }

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    for (const h of this.herds) {
      // herd centre (cohesion)
      let hx = 0;
      let hy = 0;
      let live = 0;
      for (const a of h.animals)
        if (a.s !== A.Dead) {
          hx += a.x;
          hy += a.y;
          live++;
        }
      if (!live) continue;
      hx /= live;
      hy /= live;
      // scares: the whole herd bolts when any of them is close to the danger
      for (const d of f.dangers) {
        let hit = false;
        for (const a of h.animals) {
          if (a.s === A.Dead) continue;
          const dist = Math.hypot(a.x - d.x, a.y - d.y);
          if (d.kill > 0 && dist < d.kill * 0.9) {
            a.s = A.Dead;
            a.v = 0;
            continue;
          }
          if (dist < d.r) hit = true;
        }
        if (hit) this.bolt(h, d.x, d.y, d.power);
      }
      // military units walking or driving into the pasture
      for (let i = 0; i < f.nUnits; i++) {
        const ux = f.units[i * 2];
        const uy = f.units[i * 2 + 1];
        if (Math.hypot(ux - hx, uy - hy) < 3.6) {
          this.bolt(h, ux, uy, 0.3);
          break;
        }
      }
      for (const a of h.animals) this.step(h, a, dt, hx, hy);
    }
  }

  private bolt(h: Herd, sx: number, sy: number, power: number) {
    for (const a of h.animals) {
      if (a.s === A.Dead) continue;
      let dx = a.x - sx;
      let dy = a.y - sy;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      a.fx = dx;
      a.fy = dy;
      if (a.s !== A.Panic) a.t = 0;
      a.s = A.Panic;
      // louder = longer run (keeps running while it keeps happening)
      a.t = Math.min(a.t, -(2.5 + power * 3 + Math.random() * 1.5));
    }
  }

  private step(h: Herd, a: Animal, dt: number, hx: number, hy: number) {
    const m = this.map;
    const sp = h.sp;
    a.t += dt;
    let vt = 0;
    let want = a.yaw;
    let headT = 0;
    switch (a.s) {
      case A.Dead:
        a.roll = Math.min(Math.PI / 2, a.roll + dt * 4);
        a.v = 0;
        a.gait = 0;
        a.head = Math.max(0.3, a.head - dt);
        return;
      case A.Graze: {
        headT = (a.t % 9) < 7.5 ? 1 : 0.15; // look up now and then
        // the odd shuffle forward
        vt = Math.sin(a.t * 0.9 + a.phase) > 0.85 ? 0.035 : 0;
        want = a.yaw + Math.sin(a.t * 0.3 + a.phase) * 0.4;
        if (a.t > 8 + (a.phase % 1) * 12) {
          // wander a few steps, keeping near the herd and in the field
          const p = this.fieldPoint(h.f, 1);
          a.tx = hx + (p.x - hx) * 0.35 + (Math.random() - 0.5) * 0.8;
          a.ty = hy + (p.y - hy) * 0.35 + (Math.random() - 0.5) * 0.8;
          if (!this.inField(h.f, a.tx, a.ty) || !walkable(m, a.tx, a.ty)) {
            a.tx = p.x;
            a.ty = p.y;
          }
          a.s = A.Walk;
          a.t = 0;
        }
        break;
      }
      case A.Walk:
      case A.Return: {
        const dx = a.tx - a.x;
        const dy = a.ty - a.y;
        const d = Math.hypot(dx, dy);
        want = Math.atan2(dy, dx);
        vt = WALK[sp] * (a.s === A.Return ? 1.4 : 1) * Math.min(1, d * 3 + 0.2);
        headT = 0.1;
        if (d < 0.08 || a.t > 30) {
          a.s = A.Graze;
          a.t = 0;
        }
        break;
      }
      case A.Panic: {
        // run away (with a bit of herd pull and weaving), heads up
        const cx = hx - a.x;
        const cy = hy - a.y;
        const wx = a.fx * 1.0 + cx * 0.15 + Math.sin(a.t * 2.3 + a.phase) * 0.25;
        const wy = a.fy * 1.0 + cy * 0.15 + Math.cos(a.t * 2.1 + a.phase) * 0.25;
        want = Math.atan2(wy, wx);
        vt = RUN[sp] * Math.min(1, -a.t * 0.6 + 0.4);
        headT = 0;
        if (a.t >= 0) {
          a.s = A.Alert;
          a.t = -(2 + Math.random() * 4);
        }
        break;
      }
      case A.Alert:
        headT = 0;
        vt = 0;
        if (a.t >= 0) {
          a.s = A.Return;
          a.t = 0;
          const p = this.fieldPoint(h.f, 0.7);
          a.tx = p.x;
          a.ty = p.y;
        }
        break;
    }
    // turn, then move (blocked by water / buildings: slide round)
    const turn = (a.s === A.Panic ? 4 : 1.6) * dt;
    a.yaw = wrapAngle(a.yaw + Math.max(-turn, Math.min(turn, wrapAngle(want - a.yaw))));
    a.v += (vt - a.v) * Math.min(1, dt * (a.s === A.Panic ? 4 : 2));
    if (a.v > 0.005) {
      const nx = a.x + Math.cos(a.yaw) * a.v * dt;
      const ny = a.y + Math.sin(a.yaw) * a.v * dt;
      if (walkable(m, nx, ny)) {
        a.x = nx;
        a.y = ny;
      } else {
        a.yaw += (a.phase > 3 ? 1 : -1) * 1.2 * dt * 4;
        a.fx = Math.cos(a.yaw);
        a.fy = Math.sin(a.yaw);
      }
    }
    a.head += (headT - a.head) * Math.min(1, dt * 2.5);
    a.gait += (Math.min(1, a.v / (WALK[sp] * 1.2)) * (a.v > RUN[sp] * 0.5 ? 1.3 : 0.8) - a.gait) * Math.min(1, dt * 5);
    a.phase += dt * (a.v / (sp ? 0.09 : 0.12)) * Math.PI;
    a.hgt += (groundAt(m, a.x, a.y) - a.hgt) * Math.min(1, dt * 12);
  }

  draw() {
    for (const im of this.inst) im.begin();
    for (const h of this.herds) {
      const im = this.inst[h.sp];
      for (const a of h.animals) {
        if (!this.probe.visible(a.x, a.y)) continue;
        const k = a.roll / (Math.PI / 2);
        _e.set(0, -a.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(a.x, a.hgt + k * HALF_W[h.sp], a.y), _q, _s.set(a.size, a.size, a.size));
        if (a.roll) {
          _r.makeRotationX(a.roll);
          _m.multiply(_r);
          _r.makeTranslation(0, -k * BODY_Y[h.sp], 0);
          _m.multiply(_r);
        }
        im.push(_m, a.phase, a.head, a.gait, a.s === A.Dead ? 1 : 0, a.paint.r, a.paint.g, a.paint.b);
      }
    }
    for (const im of this.inst) im.commit();
  }
}
