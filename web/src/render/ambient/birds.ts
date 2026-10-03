import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { FieldType, type Layout } from '../layout';
import { birdModel } from './models';
import { AnimInstances, ambientMaterial, clampX, clampY, groundAt, walkable, type AmbientFrame, type FogProbe, type Quality } from './shared';

/*
 * Birds: flocks that peck about on fields and at the edge of woods, then take
 * off and circle lazily over the countryside before settling somewhere else.
 * Explosions, gunfire and low aircraft make them scatter (fast, frantic
 * flapping, climbing away); they regroup, circle and land again later. Fewer
 * fly in foul weather and they stay down at night unless frightened.
 *
 * Each bird springs towards its slot in the flock pattern; wings flap / glide
 * / fold in the vertex shader. One instanced draw call for every bird.
 */

const enum F {
  Ground = 0,
  Circle = 1,
  Scatter = 2,
  Land = 3,
}

interface Bird {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
  amp: number;
  fold: number;
  /** Slot: angle offset / radius on the circle, ground offset. */
  a: number;
  r: number;
  alt: number;
  gx: number;
  gy: number;
  hop: number;
  yaw: number;
  bank: number;
  size: number;
}

interface Flock {
  s: F;
  t: number;
  dur: number;
  cx: number;
  cy: number;
  /** Circling: centre drifts towards (wx, wy). */
  wx: number;
  wy: number;
  spin: number;
  sx: number;
  sy: number;
  birds: Bird[];
  paint: THREE.Color;
}

/** City pigeons: blue-grey, the odd white or brown one. */
const PIGEONS = [0x6a6e78, 0x7a7e88, 0x5e626c, 0x8a8c92, 0xd8d6d0, 0x6a5a4a].map((c) => new THREE.Color(c));
const PAINTS = [0x1c1c1f, 0x1c1c1f, 0x2a2826, 0x6a6c72, 0xd8d8d4].map((c) => new THREE.Color(c));

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Birds {
  readonly group = new THREE.Group();
  private flocks: Flock[] = [];
  private spots: { x: number; y: number }[] = [];
  private inst: AnimInstances;

  constructor(
    private map: GameMap,
    layout: Layout,
    fog: FogOfWar,
    private probe: FogProbe,
    quality: Quality,
    phone: boolean,
    foul: boolean,
  ) {
    const m = map;
    // the city: pigeons on the squares and in the parks
    const urban = m.biome === 'urban';
    if (urban) {
      for (const f of layout.fields) if (f.type === FieldType.Plaza) for (const [ox, oy] of [[-1.6, -1.6], [1.6, 1.6], [-1.6, 1.6], [1.6, -1.6]]) if (walkable(m, f.cx + ox, f.cy + oy)) this.spots.push({ x: f.cx + ox, y: f.cy + oy });
      for (const p of m.deco?.parks ?? []) this.spots.push({ x: (p.x0 + p.x1) / 2 + 1.2, y: (p.y0 + p.y1) / 2 + 1.2 });
    }
    // landing spots: fields and the grass along wood edges, away from the bases
    if (!urban) for (const f of layout.fields) if (walkable(m, f.cx, f.cy)) this.spots.push({ x: f.cx, y: f.cy });
    for (let k = 0; k < 400 && this.spots.length < 80 && !urban; k++) {
      const x = 2 + Math.random() * (m.w - 4);
      const y = 2 + Math.random() * (m.h - 4);
      const i = (y | 0) * m.w + (x | 0);
      if (m.trees[i] || !walkable(m, x, y)) continue;
      let wood = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (m.trees[Math.max(0, Math.min(m.h - 1, (y | 0) + dy)) * m.w + Math.max(0, Math.min(m.w - 1, (x | 0) + dx))]) wood++;
      if (wood >= 3) this.spots.push({ x, y });
    }
    const starts = m.starts;
    this.spots = this.spots.filter((s) => starts.every((b) => Math.hypot(b.x - s.x, b.y - s.y) > 10));
    if (!this.spots.length) this.spots.push({ x: m.w / 2, y: m.h / 2 });
    let nFlocks = Math.round((quality === 'high' ? 5 : quality === 'medium' ? 4 : 2) * (phone ? 0.75 : 1));
    if (foul) nFlocks = Math.max(1, Math.round(nFlocks * 0.5));
    let total = 0;
    for (let i = 0; i < nFlocks; i++) {
      const sp = this.spots[(Math.random() * this.spots.length) | 0];
      const n = (phone ? 6 : 7) + Math.floor(Math.random() * (phone ? 4 : 6));
      const paint = (urban ? PIGEONS : PAINTS)[(Math.random() * (urban ? PIGEONS : PAINTS).length) | 0];
      const fl: Flock = { s: F.Ground, t: Math.random() * 20, dur: 25 + Math.random() * 40, cx: sp.x, cy: sp.y, wx: sp.x, wy: sp.y, spin: Math.random() < 0.5 ? 0.35 : -0.35, sx: 0, sy: 0, birds: [], paint };
      for (let j = 0; j < n; j++) {
        const gx = (Math.random() - 0.5) * 1.4;
        const gy = (Math.random() - 0.5) * 1.0;
        const x = sp.x + gx;
        const y = sp.y + gy;
        fl.birds.push({ x, y, z: groundAt(m, x, y), vx: 0, vy: 0, vz: 0, phase: Math.random() * 6.28, amp: 0, fold: 1, a: Math.random() * 6.28, r: urban ? 0.8 + Math.random() * 1.1 : 1.2 + Math.random() * 1.6, alt: urban ? 1.5 + Math.random() * 0.9 : 2.2 + Math.random() * 1.4, gx, gy, hop: Math.random() * 3, yaw: Math.random() * 6.28, bank: 0, size: 1.05 + Math.random() * 0.25 });
      }
      // half of them start in the air
      if (!foul && Math.random() < 0.5) this.takeOff(fl);
      total += n;
      this.flocks.push(fl);
    }
    const mat = ambientMaterial(fog, 'bird', new THREE.Vector4(), 0.9, 0);
    this.inst = new AnimInstances(birdModel(), mat, Math.max(1, total), 'ambient-birds', { heat: true });
    this.group.add(this.inst.mesh);
  }

  get count() {
    let n = 0;
    for (const f of this.flocks) n += f.birds.length;
    return n;
  }

  private takeOff(fl: Flock) {
    fl.s = F.Circle;
    fl.t = 0;
    fl.dur = 20 + Math.random() * 35;
    const sp = this.spots[(Math.random() * this.spots.length) | 0];
    fl.wx = sp.x;
    fl.wy = sp.y;
  }

  private scatter(fl: Flock, x: number, y: number) {
    let dx = fl.cx - x;
    let dy = fl.cy - y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    fl.s = F.Scatter;
    fl.t = 0;
    fl.dur = 3 + Math.random() * 2;
    fl.sx = dx;
    fl.sy = dy;
    for (const b of fl.birds) {
      const sp = 2.4 + Math.random() * 1.4;
      const jx = dx + (Math.random() - 0.5) * 1.2;
      const jy = dy + (Math.random() - 0.5) * 1.2;
      b.vx = jx * sp;
      b.vy = jy * sp;
      b.vz = 1.2 + Math.random() * 1.5;
    }
    // regroup further away
    const m = this.map;
    fl.cx = clampX(m, fl.cx + dx * 9);
    fl.cy = clampY(m, fl.cy + dy * 9);
    fl.wx = fl.cx;
    fl.wy = fl.cy;
  }

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    const m = this.map;
    const night = f.dark > 0.6;
    for (const fl of this.flocks) {
      fl.t += dt;
      // frights: blasts, gunfire, aircraft passing low
      if (fl.s !== F.Scatter) {
        let sx = 0;
        let sy = 0;
        let scared = false;
        for (const d of f.dangers) {
          if (Math.hypot(fl.cx - d.x, fl.cy - d.y) < d.r * 1.35 + 1.5) {
            scared = true;
            sx = d.x;
            sy = d.y;
          }
        }
        for (let i = 0; i < f.nAir && !scared; i++) {
          if (Math.hypot(fl.cx - f.air[i * 2], fl.cy - f.air[i * 2 + 1]) < 3) {
            scared = true;
            sx = f.air[i * 2];
            sy = f.air[i * 2 + 1];
          }
        }
        for (let i = 0; i < f.nUnits && !scared && fl.s === F.Ground; i++) {
          if (Math.hypot(fl.cx - f.units[i * 2], fl.cy - f.units[i * 2 + 1]) < 2.5) {
            scared = true;
            sx = f.units[i * 2];
            sy = f.units[i * 2 + 1];
          }
        }
        if (scared) this.scatter(fl, sx, sy);
      }
      switch (fl.s) {
        case F.Ground:
          if (fl.t > fl.dur && !night && !(f.foul && Math.random() < 0.6)) this.takeOff(fl);
          else if (fl.t > fl.dur) fl.t = 0;
          break;
        case F.Circle: {
          const dx = fl.wx - fl.cx;
          const dy = fl.wy - fl.cy;
          const d = Math.hypot(dx, dy);
          if (d > 0.5) {
            fl.cx += (dx / d) * Math.min(d, 0.9 * dt);
            fl.cy += (dy / d) * Math.min(d, 0.9 * dt);
          } else if (fl.t < fl.dur * 0.7) {
            // drift on to another spot while there's time
            const sp = this.spots[(Math.random() * this.spots.length) | 0];
            fl.wx = sp.x;
            fl.wy = sp.y;
          }
          if (fl.t > fl.dur * (night || f.foul ? 0.4 : 1) && d < 3) {
            fl.s = F.Land;
            fl.t = 0;
            fl.wx = fl.cx;
            fl.wy = fl.cy;
            // settle on the nearest spot to the current position
            let best = 1e9;
            for (const s of this.spots) {
              const dd = Math.hypot(s.x - fl.cx, s.y - fl.cy);
              if (dd < best) {
                best = dd;
                fl.wx = s.x;
                fl.wy = s.y;
              }
            }
          }
          break;
        }
        case F.Scatter:
          if (fl.t > fl.dur) {
            fl.s = F.Circle;
            fl.t = 0;
            fl.dur = 12 + Math.random() * 20;
          }
          break;
        case F.Land: {
          const dx = fl.wx - fl.cx;
          const dy = fl.wy - fl.cy;
          const d = Math.hypot(dx, dy);
          if (d > 0.05) {
            fl.cx += (dx / d) * Math.min(d, 1.0 * dt);
            fl.cy += (dy / d) * Math.min(d, 1.0 * dt);
          }
          let down = 0;
          for (const b of fl.birds) if (b.fold > 0.9) down++;
          if (down === fl.birds.length || fl.t > 25) {
            fl.s = F.Ground;
            fl.t = 0;
            fl.dur = 25 + Math.random() * 45;
          }
          break;
        }
      }
      const ang = f.time * fl.spin;
      for (const b of fl.birds) {
        const g = groundAt(m, clampX(m, b.x), clampY(m, b.y));
        let tx: number;
        let ty: number;
        let tz: number;
        let maxV = 1.6;
        if (fl.s === F.Ground || (fl.s === F.Land && Math.hypot(b.x - fl.cx - b.gx, b.y - fl.cy - b.gy) < 0.6)) {
          // on the ground / landing: hop about, peck, wings folded
          b.hop -= dt;
          if (fl.s === F.Ground && b.hop < 0) {
            b.hop = 1 + Math.random() * 4;
            b.gx = Math.max(-1, Math.min(1, b.gx + (Math.random() - 0.5) * 0.4));
            b.gy = Math.max(-0.8, Math.min(0.8, b.gy + (Math.random() - 0.5) * 0.4));
          }
          tx = fl.cx + b.gx;
          ty = fl.cy + b.gy;
          tz = groundAt(m, clampX(m, tx), clampY(m, ty)) + 0.012;
          maxV = 0.5;
          const dd = Math.hypot(tx - b.x, ty - b.y) + Math.abs(tz - b.z);
          const sitting = dd < 0.08;
          b.fold += ((sitting ? 1 : 0.1) - b.fold) * Math.min(1, dt * 4);
          b.amp += ((sitting ? 0 : 0.9) - b.amp) * Math.min(1, dt * 6);
          if (sitting) {
            b.vx *= 0.8;
            b.vy *= 0.8;
            b.vz = 0;
            b.x += (tx - b.x) * Math.min(1, dt * 3);
            b.y += (ty - b.y) * Math.min(1, dt * 3);
            b.z = tz;
            if (fl.s === F.Ground) {
              const dir = Math.atan2(ty - b.y, tx - b.x);
              if (Math.hypot(tx - b.x, ty - b.y) > 0.01) b.yaw = dir;
            }
            b.bank = 0;
            continue;
          }
        } else if (fl.s === F.Scatter) {
          tx = b.x + b.vx;
          ty = b.y + b.vy;
          tz = Math.max(b.z, g) + 1.2;
          maxV = 3.6;
          b.fold += (0 - b.fold) * Math.min(1, dt * 10);
          b.amp += (1.2 - b.amp) * Math.min(1, dt * 10);
        } else {
          // circling (and descending towards the landing spot)
          const a = b.a + ang;
          const rr = fl.s === F.Land ? b.r * 0.4 : b.r;
          tx = fl.cx + Math.cos(a) * rr;
          ty = fl.cy + Math.sin(a) * rr;
          tz = fl.s === F.Land ? groundAt(m, clampX(m, fl.cx + b.gx), clampY(m, fl.cy + b.gy)) + 0.3 : Math.max(g, 0) + b.alt + Math.sin(f.time * 0.4 + b.a) * 0.3;
          if (fl.s === F.Land && Math.hypot(b.x - fl.cx, b.y - fl.cy) < 1.2) {
            tx = fl.cx + b.gx;
            ty = fl.cy + b.gy;
          }
          maxV = 1.6;
          b.fold += (0 - b.fold) * Math.min(1, dt * 5);
          // flap in bursts, glide in between (climbing birds flap)
          const burst = Math.sin(f.time * 0.7 + b.a * 3) > 0.2 || b.vz > 0.25;
          b.amp += ((burst ? 0.85 : 0.12) - b.amp) * Math.min(1, dt * 3);
        }
        // spring towards the slot
        const dx = tx - b.x;
        const dy = ty - b.y;
        const dz = tz - b.z;
        let wx = dx * 1.6;
        let wy = dy * 1.6;
        let wz = dz * 1.6;
        const wl = Math.hypot(wx, wy, wz);
        if (wl > maxV) {
          wx *= maxV / wl;
          wy *= maxV / wl;
          wz *= maxV / wl;
        }
        const k = Math.min(1, dt * (fl.s === F.Scatter ? 2.5 : 1.6));
        const pyaw = Math.atan2(b.vy, b.vx);
        b.vx += (wx - b.vx) * k;
        b.vy += (wy - b.vy) * k;
        b.vz += (wz - b.vz) * k;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z = Math.max(g + 0.012, b.z + b.vz * dt);
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0.05) {
          const ny = Math.atan2(b.vy, b.vx);
          let dyaw = ny - pyaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          b.yaw = ny;
          b.bank += (Math.max(-0.7, Math.min(0.7, (dyaw / Math.max(1e-3, dt)) * 0.25)) - b.bank) * Math.min(1, dt * 4);
        }
        b.phase += dt * (fl.s === F.Scatter ? 26 : 15) * (0.5 + b.amp * 0.6);
      }
    }
  }

  draw() {
    const im = this.inst;
    im.begin();
    for (const fl of this.flocks) {
      const c = fl.paint;
      for (const b of fl.birds) {
        if (!this.probe.visible(b.x, b.y)) continue;
        // pecking: a little nod while on the ground
        const sit = b.fold > 0.9;
        const pitch = sit ? -0.15 - Math.max(0, Math.sin(b.phase * 0.25 + b.a * 5)) * 0.45 : Math.max(-0.5, Math.min(0.5, b.vz * 0.3));
        if (sit) b.phase += 0.016 * 6;
        _e.set(-b.bank, -b.yaw, pitch, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(b.x, b.z + (sit ? 0.012 * b.size : 0), b.y), _q, _s.set(b.size, b.size, b.size));
        im.push(_m, b.phase, b.amp, b.fold, 0, c.r, c.g, c.b);
      }
    }
    im.commit();
  }
}
