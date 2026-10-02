import * as THREE from 'three';
import { Tile, WATER_LEVEL, type GameMap } from '../../sim/map';
import type { BridgeState } from '../../sim/bridges';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import type { Layout, V2 } from '../layout';
import { carModel, type CarModel } from './models';
import { AnimInstances, ambientMaterial, groundAt, walkable, wrapAngle, type AmbientFrame, type FogProbe, type LightSprites, type Quality } from './shared';

/*
 * Civilian traffic: cars, vans, pickups and tractors driving the paved roads
 * and dirt tracks of the scenery layout (keeping right, slowing for bends,
 * turning off at junctions, U-turning at dead ends and leaving / entering at
 * the map edges). Collapsed bridges are not crossed. Combat nearby makes them
 * flee: speed up and turn away, some swerve off the road and are abandoned
 * with doors open and hazard lights blinking; blasts wreck them (burnt,
 * sometimes flipped, burning for a while).
 *
 * Steering is pure pursuit of a carrot point running ahead along the lane,
 * which smooths junction hops and turns U-turns into proper turning circles.
 * One instanced draw call per vehicle type (4), lights share LightSprites.
 */

interface Link {
  /** Arc position on this line (tiles). */
  at: number;
  /** 0 start endpoint, 1 end endpoint, -1 mid-line junction. */
  end: number;
  to: number;
  toArc: number;
  /** Direction on the target line (0 = either). */
  toDir: number;
}

interface Line {
  pts: V2[];
  cum: Float32Array;
  len: number;
  lane: number;
  paved: boolean;
  /** World bridge index for a deck crossing, -1 otherwise. */
  bridge: number;
  links: Link[];
  /** Endpoint at the map edge (cars leave / enter there). */
  portal: [boolean, boolean];
}

const enum S {
  Drive = 0,
  Offroad = 1,
  Abandoned = 2,
  Rejoin = 3,
  Wreck = 4,
  Sinking = 5,
}

interface Car {
  kind: number;
  model: CarModel;
  s: S;
  line: number;
  arc: number;
  dir: number;
  x: number;
  y: number;
  yaw: number;
  v: number;
  cruise: number;
  paint: THREE.Color;
  panic: number;
  calm: number;
  door: number;
  burnt: number;
  roll: number;
  rollTarget: number;
  lift: number;
  liftV: number;
  fire: number;
  blocked: number;
  tx: number;
  ty: number;
  hgt: number;
  pitch: number;
  bank: number;
  brake: number;
  /** Time spent near a unit (U-turn when stuck behind a convoy). */
  wait: number;
  seen: boolean;
  sink: number;
  id: number;
  /** U-turn cooldown (s): a car mid-turn must not flip back. */
  cd: number;
}

const PAINTS = [0xe8e8e6, 0xb8bcc0, 0x24272b, 0x9e1c1c, 0x1f3f7a, 0x2c4a32, 0xc9b48a, 0xd7a92a, 0x5a6b7a, 0x6e2a3a, 0x3d8fb0, 0xece5d0].map((c) => new THREE.Color(c));
const VAN_PAINTS = [0xf0f0ee, 0xf0f0ee, 0xd8d8d4, 0x2a4f8a, 0xb02020, 0xe0c040].map((c) => new THREE.Color(c));
const TRACTOR_PAINTS = [0x2f7a2e, 0x2f7a2e, 0xb0201a, 0x1f4fa0, 0xd8b020].map((c) => new THREE.Color(c));
const CRUISE = [1.25, 1.05, 1.1, 0.5];

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _o = { x: 0, y: 0, tx: 0, ty: 0 };

function cumulative(pts: V2[]): Float32Array {
  const c = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return c;
}

/** Index of the segment containing arc `a`. */
function segAt(L: Line, a: number): number {
  const c = L.cum;
  let lo = 0;
  let hi = c.length - 2;
  if (a <= 0) return 0;
  if (a >= L.len) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= a) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Point + unit tangent at arc `a` (clamped), into _o. */
function pointAt(L: Line, a: number) {
  const aa = a < 0 ? 0 : a > L.len ? L.len : a;
  const i = segAt(L, aa);
  const p = L.pts[i];
  const q = L.pts[i + 1];
  const sl = L.cum[i + 1] - L.cum[i] || 1;
  const t = (aa - L.cum[i]) / sl;
  _o.x = p.x + (q.x - p.x) * t;
  _o.y = p.y + (q.y - p.y) * t;
  _o.tx = (q.x - p.x) / sl;
  _o.ty = (q.y - p.y) / sl;
  return _o;
}

/** Nearest arc on the whole line to (x, y). */
function nearestArc(L: Line, x: number, y: number): { arc: number; d: number } {
  let best = 1e9;
  let arc = 0;
  for (let i = 0; i < L.pts.length - 1; i++) {
    const a = L.pts[i];
    const b = L.pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
    if (d < best) {
      best = d;
      arc = L.cum[i] + t * Math.sqrt(l2);
    }
  }
  return { arc, d: best };
}

/** Local projection around the car's current arc (cheap, per frame). */
function projectNear(L: Line, arc: number, x: number, y: number): number {
  const i0 = Math.max(0, segAt(L, arc) - 3);
  const i1 = Math.min(L.pts.length - 2, i0 + 7);
  let best = 1e9;
  let out = arc;
  for (let i = i0; i <= i1; i++) {
    const a = L.pts[i];
    const b = L.pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
    if (d < best) {
      best = d;
      out = L.cum[i] + t * Math.sqrt(l2);
    }
  }
  return out;
}

export class Traffic {
  readonly group = new THREE.Group();
  private lines: Line[] = [];
  private cars: Car[] = [];
  private inst: AnimInstances[] = [];
  private models: CarModel[] = [];
  private target: number;
  private spawnT = 3;
  private nextId = 1;
  private portals: { line: number; end: number }[] = [];

  constructor(
    private map: GameMap,
    layout: Layout,
    private bridges: readonly BridgeState[],
    fog: FogOfWar,
    private effects: Effects,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
    phone: boolean,
  ) {
    this.buildNetwork(layout);
    const base = quality === 'high' ? 13 : quality === 'medium' ? 10 : 7;
    this.target = this.lines.length ? Math.max(4, Math.round(base * (phone ? 0.75 : 1))) : 0;
    for (let k = 0; k < 4; k++) {
      const m = carModel(k);
      this.models.push(m);
      const mat = ambientMaterial(fog, 'car', m.rig, k === 3 ? 0.7 : 0.45, k === 3 ? 0.1 : 0.35);
      const inst = new AnimInstances(m.geo, mat, 24, `ambient-cars-${k}`, { shadow: quality === 'high', heat: true });
      this.inst.push(inst);
      this.group.add(inst.mesh);
    }
    for (let i = 0; i < this.target; i++) this.spawn(true);
  }

  // ------------------------------------------------------------------ network

  private buildNetwork(layout: Layout) {
    const m = this.map;
    const add = (pts: V2[], lane: number, paved: boolean, bridge: number) => {
      if (pts.length < 2) return;
      const cum = cumulative(pts);
      const len = cum[cum.length - 1];
      if (len < 1.5) return;
      const edge = (p: V2) => p.x < 1.6 || p.y < 1.6 || p.x > m.w - 1.6 || p.y > m.h - 1.6;
      this.lines.push({ pts, cum, len, lane, paved, bridge, links: [], portal: [edge(pts[0]), edge(pts[pts.length - 1])] });
    };
    for (const r of layout.roads) add(r.pts, r.width * (r.variant === 0 ? 0.24 : 0.22), true, -1);
    for (const t of layout.tracks) add(t.pts, 0.06, false, -1);
    // bridge decks join the road ends on either bank
    this.bridges.forEach((b, bi) => {
      const a = b.ends[0];
      const c = b.ends[1];
      const near = (p: { x: number; y: number }) => this.lines.some((L) => L.bridge < 0 && L.paved && (Math.hypot(L.pts[0].x - p.x, L.pts[0].y - p.y) < 2.4 || Math.hypot(L.pts[L.pts.length - 1].x - p.x, L.pts[L.pts.length - 1].y - p.y) < 2.4));
      if (!near(a) || !near(c)) return;
      const pts: V2[] = [];
      const n = Math.max(2, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.25));
      for (let i = 0; i <= n; i++) pts.push({ x: a.x + ((c.x - a.x) * i) / n, y: a.y + ((c.y - a.y) * i) / n });
      add(pts, 0.2, true, bi);
    });
    // links: every endpoint to the nearest point of every other line close by
    const L = this.lines;
    for (let ai = 0; ai < L.length; ai++) {
      const A = L[ai];
      for (let e = 0; e < 2; e++) {
        const P = e ? A.pts[A.pts.length - 1] : A.pts[0];
        for (let bi = 0; bi < L.length; bi++) {
          if (bi === ai) continue;
          const B = L[bi];
          const thr = A.bridge >= 0 || B.bridge >= 0 ? 2.4 : 1.3;
          const { arc, d } = nearestArc(B, P.x, P.y);
          if (d > thr) continue;
          const atStart = arc < 0.7;
          const atEnd = arc > B.len - 0.7;
          A.links.push({ at: e ? A.len : 0, end: e, to: bi, toArc: atStart ? 0 : atEnd ? B.len : arc, toDir: atStart ? 1 : atEnd ? -1 : 0 });
          if (!atStart && !atEnd) B.links.push({ at: arc, end: -1, to: ai, toArc: e ? A.len : 0, toDir: e ? -1 : 1 });
        }
        if (A.portal[e] && A.bridge < 0) this.portals.push({ line: ai, end: e });
      }
    }
  }

  private bridgeUp(bi: number): boolean {
    const b = this.bridges[bi];
    if (!b) return false;
    for (const t of b.tiles) if (this.map.tiles[t] !== Tile.Bridge) return false;
    return true;
  }

  private usable(link: Link): boolean {
    const B = this.lines[link.to];
    return B.bridge < 0 || this.bridgeUp(B.bridge);
  }

  // ------------------------------------------------------------------ spawning

  private pickKind(paved: boolean): number {
    const r = Math.random();
    if (paved) return r < 0.5 ? 0 : r < 0.72 ? 1 : r < 0.92 ? 2 : 3;
    return r < 0.2 ? 0 : r < 0.55 ? 2 : 3;
  }

  private spawn(initial: boolean, units?: Float32Array, nUnits = 0, view?: AmbientFrame) {
    const L = this.lines;
    let line = -1;
    let arc = 0;
    let dir = 1;
    for (let tries = 0; tries < 12 && line < 0; tries++) {
      if (initial || !this.portals.length) {
        // anywhere on the network, weighted by length (bridges excluded)
        let tot = 0;
        for (const l of L) if (l.bridge < 0) tot += l.len;
        let r = Math.random() * tot;
        let li = 0;
        for (; li < L.length; li++) {
          if (L[li].bridge >= 0) continue;
          r -= L[li].len;
          if (r <= 0) break;
        }
        li = Math.min(li, L.length - 1);
        if (L[li].bridge >= 0) continue;
        line = li;
        arc = 0.5 + Math.random() * (L[li].len - 1);
        dir = Math.random() < 0.5 ? 1 : -1;
      } else {
        const p = this.portals[(Math.random() * this.portals.length) | 0];
        line = p.line;
        arc = p.end ? L[line].len - 0.3 : 0.3;
        dir = p.end ? -1 : 1;
      }
      const pt = pointAt(L[line], arc);
      const px = pt.x;
      const py = pt.y;
      let bad = false;
      if (units) for (let i = 0; i < nUnits && !bad; i++) if (Math.hypot(units[i * 2] - px, units[i * 2 + 1] - py) < 7) bad = true;
      for (const c of this.cars) if (Math.hypot(c.x - px, c.y - py) < 1.2) bad = true;
      // don't pop into view mid-road (map-edge entries are fine: they drive in)
      if (!initial && view && !this.portals.length && px > view.vx0 && px < view.vx1 && py > view.vy0 && py < view.vy1) bad = true;
      if (bad) line = -1;
    }
    if (line < 0) return;
    const Ln = L[line];
    const kind = this.pickKind(Ln.paved);
    const pal = kind === 1 ? VAN_PAINTS : kind === 3 ? TRACTOR_PAINTS : PAINTS;
    const pt = pointAt(Ln, arc);
    const yaw = Math.atan2(pt.ty * dir, pt.tx * dir);
    const lane = Ln.lane;
    const rx = -pt.ty * dir;
    const ry = pt.tx * dir;
    const cruise = CRUISE[kind] * (Ln.paved ? 1 : 0.62) * (0.85 + Math.random() * 0.3);
    this.cars.push({
      kind,
      model: this.models[kind],
      s: S.Drive,
      line,
      arc,
      dir,
      x: pt.x + rx * lane,
      y: pt.y + ry * lane,
      yaw,
      v: initial ? cruise * 0.8 : cruise * 0.6,
      cruise,
      paint: pal[(Math.random() * pal.length) | 0].clone().multiplyScalar(0.9 + Math.random() * 0.15),
      panic: 0,
      calm: 0,
      door: 0,
      burnt: 0,
      roll: 0,
      rollTarget: 0,
      lift: 0,
      liftV: 0,
      fire: 0,
      blocked: 0,
      tx: 0,
      ty: 0,
      hgt: groundAt(this.map, pt.x, pt.y),
      pitch: 0,
      bank: 0,
      brake: 0,
      wait: 0,
      seen: false,
      sink: 0,
      id: this.nextId++,
      cd: 0,
    });
  }

  // ------------------------------------------------------------------ reactions

  private react(c: Car, f: AmbientFrame) {
    for (const d of f.dangers) {
      const dx = c.x - d.x;
      const dy = c.y - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist > d.r) continue;
      if (c.s === S.Wreck || c.s === S.Sinking) continue;
      if (d.kill > 0 && dist < d.kill + 0.2) {
        this.wreck(c, dx, dy, dist, d);
        continue;
      }
      c.calm = 0;
      if (c.s === S.Abandoned) continue;
      c.panic = Math.max(c.panic, 7 + Math.random() * 5);
      if (c.s !== S.Drive) continue;
      const hx = Math.cos(c.yaw);
      const hy = Math.sin(c.yaw);
      const ahead = (-dx * hx - dy * hy) / (dist || 1);
      // some bail out off the road (more likely when it's loud and close)
      const bail = (d.power > 0.5 ? 0.35 : 0.15) * (dist < d.r * 0.6 ? 1.4 : 1);
      if (c.kind !== 3 && Math.random() < bail && this.trySwerve(c, d.x, d.y)) continue;
      if (ahead > 0.25) this.turnRound(c); // danger in front: turn round
    }
  }

  private turnRound(c: Car) {
    if (c.cd > 0) return;
    c.dir = -c.dir;
    c.cd = 3;
  }

  /** Swerve off the road away from (sx, sy): picks a free spot to the side. */
  private trySwerve(c: Car, sx: number, sy: number): boolean {
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    const rx = -hy;
    const ry = hx;
    const side = (c.x - sx) * rx + (c.y - sy) * ry >= 0 ? 1 : -1;
    for (const sgn of [side, -side]) {
      const off = 0.9 + Math.random() * 0.9;
      const tx = c.x + rx * sgn * off + hx * (0.6 + c.v * 0.5);
      const ty = c.y + ry * sgn * off + hy * (0.6 + c.v * 0.5);
      let ok = true;
      for (let k = 1; k <= 4 && ok; k++) ok = walkable(this.map, c.x + ((tx - c.x) * k) / 4, c.y + ((ty - c.y) * k) / 4) && !this.map.trees[((c.y + ((ty - c.y) * k) / 4) | 0) * this.map.w + ((c.x + ((tx - c.x) * k) / 4) | 0)];
      if (!ok) continue;
      c.s = S.Offroad;
      c.tx = tx;
      c.ty = ty;
      return true;
    }
    return false;
  }

  private wreck(c: Car, dx: number, dy: number, dist: number, d: { kill: number; power: number }) {
    c.s = S.Wreck;
    c.fire = 10 + Math.random() * 16;
    c.panic = 0;
    const k = 1 - dist / (d.kill + 0.2);
    // blown over when close to a heavy blast
    if (d.power > 0.55 && k > 0.35 && Math.random() < 0.75) {
      c.rollTarget = (Math.random() < 0.5 ? 1 : -1) * (Math.random() < 0.6 ? Math.PI : Math.PI / 2);
      c.liftV = 1.2 + k * 1.6;
    } else c.liftV = 0.4 + k * 0.6;
    const l = dist || 1;
    c.tx = (dx / l) * (0.2 + k * 0.5);
    c.ty = (dy / l) * (0.2 + k * 0.5);
    c.v = 0;
    if (this.probe.visible(c.x, c.y)) {
      const g = groundAt(this.map, c.x, c.y);
      this.effects.explosion(c.x, g + 0.15, c.y, 'small', 'fire');
    }
  }

  // ------------------------------------------------------------------ update

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    const L = this.lines;
    if (!L.length) return;
    // keep the density up: new cars come in from the map edges
    let alive = 0;
    for (const c of this.cars) if (c.s === S.Drive || c.s === S.Rejoin || c.s === S.Offroad) alive++;
    this.spawnT -= dt;
    if (alive < this.target && this.spawnT <= 0) {
      this.spawnT = 4 + Math.random() * 6;
      this.spawn(false, f.units, f.nUnits, f);
    }
    // too many wrecks / abandoned cars: clear the oldest one out of sight
    let parked = this.cars.length - alive;
    for (let i = 0; i < this.cars.length && parked > 7; i++) {
      const c = this.cars[i];
      if ((c.s === S.Wreck && c.fire <= 0) || c.s === S.Abandoned) {
        if (c.x > f.vx0 && c.x < f.vx1 && c.y > f.vy0 && c.y < f.vy1) continue;
        this.cars.splice(i--, 1);
        parked--;
      }
    }

    for (let ci = this.cars.length - 1; ci >= 0; ci--) {
      const c = this.cars[ci];
      this.react(c, f);
      const inView = c.x > f.vx0 && c.x < f.vx1 && c.y > f.vy0 && c.y < f.vy1;
      if (c.s === S.Wreck || c.s === S.Sinking) {
        this.updateWreck(c, dt, inView);
        if (c.s === S.Sinking && c.sink > 3) this.cars.splice(ci, 1);
        continue;
      }
      // military units close by: unease (they speed away / turn round when units block the road)
      let near = 1e9;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < f.nUnits; i++) {
        const d = Math.hypot(f.units[i * 2] - c.x, f.units[i * 2 + 1] - c.y);
        if (d < near) {
          near = d;
          nx = f.units[i * 2];
          ny = f.units[i * 2 + 1];
        }
      }
      if (near < 5 && c.s === S.Drive) {
        if (c.panic <= 0) {
          const ahead = ((nx - c.x) * Math.cos(c.yaw) + (ny - c.y) * Math.sin(c.yaw)) / (near || 1);
          if (ahead > 0.3) this.turnRound(c);
        }
        c.panic = Math.max(c.panic, 3);
      }
      c.panic = Math.max(0, c.panic - dt);
      c.cd = Math.max(0, c.cd - dt);
      c.calm += dt;
      if (c.s === S.Abandoned) {
        c.door = Math.min(1, c.door + dt * 1.6);
        c.v = 0;
        if (c.calm > 35 && near > 8) {
          // the driver comes back: doors shut, back onto the road
          c.s = S.Rejoin;
          const r = nearestArc(L[c.line], c.x, c.y);
          c.arc = r.arc;
        }
      } else c.door = Math.max(0, c.door - dt * 1.4);
      if (c.s === S.Abandoned) {
        this.place(c, dt);
        continue;
      }
      if (!inView && (ci + Math.floor(f.time * 10)) % 3 !== 0) {
        // off-screen: coarse steps are fine
        this.drive(c, dt * 3, near, false);
      } else this.drive(c, dt, near, inView);
      if (c.s === S.Drive && this.atPortalExit(c)) {
        this.cars.splice(ci, 1);
        continue;
      }
      this.place(c, dt);
    }
  }

  private atPortalExit(c: Car): boolean {
    const Ln = this.lines[c.line];
    if (c.dir > 0 && Ln.portal[1] && c.arc > Ln.len - 0.3) return true;
    if (c.dir < 0 && Ln.portal[0] && c.arc < 0.3) return true;
    return false;
  }

  private drive(c: Car, dt: number, nearUnit: number, inView: boolean): void {
    const L = this.lines;
    const Ln = L[c.line];
    let cx: number;
    let cy: number;
    let curve = 0;
    let stopAt = -1;
    if (c.s === S.Drive) {
      const prev = c.arc;
      c.arc = projectNear(Ln, c.arc, c.x, c.y);
      // mid-line junctions: sometimes turn off
      for (const k of Ln.links) {
        if (k.end >= 0) continue;
        if ((c.dir > 0 && prev < k.at && c.arc >= k.at) || (c.dir < 0 && prev > k.at && c.arc <= k.at)) {
          const B = L[k.to];
          const p = c.kind === 3 ? (B.paved ? 0.25 : 0.6) : B.paved ? 0.45 : 0.18;
          if (c.panic <= 0 && Math.random() < p && this.usable(k)) {
            this.enter(c, k);
            return this.drive(c, 0, nearUnit, inView);
          }
        }
      }
      // end of the line: follow a link, leave the map, or turn round
      const endNear = c.dir > 0 ? Ln.len - c.arc < 0.3 : c.arc < 0.3;
      if (endNear && !Ln.portal[c.dir > 0 ? 1 : 0]) {
        const end = c.dir > 0 ? 1 : 0;
        const opts = Ln.links.filter((k) => k.end === end && this.usable(k));
        if (opts.length) this.enter(c, opts[(Math.random() * opts.length) | 0]);
        else c.dir = -c.dir;
      }
      if (Ln.bridge >= 0 && !this.bridgeUp(Ln.bridge)) {
        // the deck went down under the car
        c.s = S.Sinking;
        c.burnt = 0.3;
        c.liftV = 0;
        return;
      }
      const L2 = L[c.line];
      const look = 0.32 + c.v * 0.3;
      const p0 = pointAt(L2, c.arc);
      const t0x = p0.tx * c.dir;
      const t0y = p0.ty * c.dir;
      const pa = pointAt(L2, c.arc + c.dir * look);
      cx = pa.x - pa.ty * c.dir * L2.lane;
      cy = pa.y + pa.tx * c.dir * L2.lane;
      // bend ahead: compare the tangent a little further on
      const pb = pointAt(L2, c.arc + c.dir * 1.3);
      curve = Math.abs(wrapAngle(Math.atan2(pb.ty * c.dir, pb.tx * c.dir) - Math.atan2(t0y, t0x)));
    } else {
      // off-road (swerving out / getting back on)
      if (c.s === S.Rejoin) {
        const Lr = L[c.line];
        const p = pointAt(Lr, c.arc + c.dir * 0.6);
        cx = p.x - p.ty * c.dir * Lr.lane;
        cy = p.y + p.tx * c.dir * Lr.lane;
        if (Math.hypot(cx - c.x, cy - c.y) < 0.35) c.s = S.Drive;
      } else {
        cx = c.tx;
        cy = c.ty;
        const d = Math.hypot(cx - c.x, cy - c.y);
        stopAt = d;
        // arrived (or the spot ended up inside the turning circle / it's taking too long): stop here
        const behind = Math.abs(wrapAngle(Math.atan2(cy - c.y, cx - c.x) - c.yaw)) > 1.3;
        if (d < 0.12 || (c.v < 0.05 && d < 0.4) || (behind && d < 0.9) || c.calm > 6) {
          c.s = S.Abandoned;
          c.calm = 0;
          c.v = 0;
          return;
        }
      }
    }
    // steering
    const want = Math.atan2(cy - c.y, cx - c.x);
    const dyaw = wrapAngle(want - c.yaw);
    const maxTurn = (c.v / (c.kind === 3 ? 0.3 : 0.36) + 0.25) * dt;
    c.yaw = wrapAngle(c.yaw + Math.max(-maxTurn, Math.min(maxTurn, dyaw)));
    // speed: cruise, slower in bends / while turning, faster when fleeing
    const fleeing = c.panic > 0;
    let vt = c.cruise * (fleeing ? (c.kind === 3 ? 1.5 : 1.9) : 1);
    vt *= 1 - Math.min(0.65, curve * 0.55);
    vt *= 1 - Math.min(0.7, Math.abs(dyaw) * 0.6);
    if (stopAt >= 0) vt = Math.min(vt, stopAt * 1.6 + 0.05);
    // traffic ahead (cars, wrecks) and units in the road
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    let blocked = false;
    for (const o of this.cars) {
      if (o === c) continue;
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      const along = dx * hx + dy * hy;
      if (along <= 0 || along > 1.0) continue;
      const lat = Math.abs(dx * -hy + dy * hx);
      if (lat > 0.17) continue;
      // oncoming car on our side mid-U-turn: just slow
      const gap = along - 0.55;
      vt = Math.min(vt, Math.max(0, gap * 2.2 + (o.s === S.Drive ? o.v * 0.6 : 0)));
      if (gap < 0.2 && o.s !== S.Drive) blocked = true;
    }
    if (nearUnit < 1.6 && c.s === S.Drive) {
      vt = Math.min(vt, Math.max(0, (nearUnit - 0.9) * 0.8));
      if (nearUnit < 1.2) blocked = true;
    }
    c.blocked = blocked ? c.blocked + dt : 0;
    if (c.blocked > 3.5 && c.s === S.Drive) {
      c.cd = 0;
      this.turnRound(c);
      c.blocked = 0;
    }
    const acc = fleeing ? 1.6 : 0.7;
    const prevV = c.v;
    c.v = vt > c.v ? Math.min(vt, c.v + acc * dt) : Math.max(vt, c.v - 2.4 * dt);
    c.brake = c.v < prevV - 0.5 * dt ? 1 : Math.max(0, c.brake - dt * 3);
    c.x += hx * c.v * dt;
    c.y += hy * c.v * dt;
    // tractors on dirt kick up a little dust
    if (inView && c.kind === 3 && !this.lines[c.line].paved && c.v > 0.2 && Math.random() < dt * 1.2 && this.probe.visible(c.x, c.y)) {
      this.effects.dust(c.x - hx * 0.2, c.hgt, c.y - hy * 0.2, 0.35);
    }
  }

  private enter(c: Car, k: Link) {
    c.line = k.to;
    c.arc = k.toArc;
    c.dir = k.toDir || (Math.random() < 0.5 ? 1 : -1);
  }

  private updateWreck(c: Car, dt: number, inView: boolean) {
    const m = this.map;
    c.burnt = Math.min(1, c.burnt + dt * (c.s === S.Sinking ? 0.2 : 0.8));
    c.door = Math.max(0, c.door - dt);
    if (c.s === S.Sinking) {
      c.sink += dt;
      c.liftV -= 4 * dt;
      c.lift += c.liftV * dt;
      c.roll += dt * 0.6;
      this.place(c, dt, true);
      if (c.sink < 0.1 && this.probe.visible(c.x, c.y)) this.effects.splash(c.x, WATER_LEVEL, c.y, 0.6);
      return;
    }
    // thrown by the blast
    if (c.tx || c.ty) {
      const k = Math.min(1, dt * 6);
      const nx = c.x + c.tx * k;
      const ny = c.y + c.ty * k;
      if (walkable(m, nx, ny) || this.lines[c.line].paved) {
        c.x = nx;
        c.y = ny;
      }
      c.tx *= 1 - k;
      c.ty *= 1 - k;
      if (Math.abs(c.tx) + Math.abs(c.ty) < 0.01) c.tx = c.ty = 0;
    }
    c.liftV -= 6 * dt;
    c.lift = Math.max(0, c.lift + c.liftV * dt);
    if (c.lift <= 0) c.liftV = 0;
    c.roll += (c.rollTarget - c.roll) * Math.min(1, dt * 5);
    if (c.fire > 0) {
      c.fire -= dt;
      if (inView && this.probe.visible(c.x, c.y)) {
        const g = c.hgt + 0.15;
        if (Math.random() < dt * 9) this.effects.flame(c.x + (Math.random() - 0.5) * 0.2, g, c.y + (Math.random() - 0.5) * 0.15, 0.45);
        if (Math.random() < dt * 2.2) this.effects.column(c.x, g + 0.1, c.y, 0.5, true);
        this.effects.burnGlow(c.x, g + 0.1, c.y, 0.6);
      }
    }
    this.place(c, dt);
  }

  /** Ground following: height, pitch and bank from the terrain under the car. */
  private place(c: Car, dt: number, free = false) {
    const m = this.map;
    const half = c.model.len * 0.4;
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    const g = groundAt(m, c.x, c.y);
    if (!free) {
      const gf = groundAt(m, c.x + hx * half, c.y + hy * half);
      const gb = groundAt(m, c.x - hx * half, c.y - hy * half);
      const gl = groundAt(m, c.x - hy * 0.1, c.y + hx * 0.1);
      const gr = groundAt(m, c.x + hy * 0.1, c.y - hx * 0.1);
      const k = Math.min(1, dt * 10);
      c.hgt += (Math.max(g, (gf + gb) / 2) - c.hgt) * Math.min(1, dt * 14);
      c.pitch += (Math.atan2(gf - gb, half * 2) - c.pitch) * k;
      c.bank += (Math.atan2(gr - gl, 0.2) - c.bank) * k;
    }
  }

  /** Write the instances (fog-culled) and the lights. */
  draw(f: AmbientFrame, time: number) {
    for (const im of this.inst) im.begin();
    const dk = f.dark;
    const Lt = this.lights;
    for (const c of this.cars) {
      const vis = this.probe.visible(c.x, c.y);
      c.seen = vis;
      if (!vis) continue;
      const mdl = c.model;
      const h = 0.19;
      // root: position, yaw (tile y = world z, so yaw is negated about +Y), terrain pitch / bank, roll for flipped wrecks
      const y = c.hgt + c.lift;
      _e.set(c.bank, -c.yaw, c.pitch, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(c.x, y + (c.roll ? h / 2 : 0), c.y), _q, _s);
      if (c.roll) {
        _r.makeRotationX(c.roll);
        _m.multiply(_r);
        _r.makeTranslation(0, -h / 2, 0);
        _m.multiply(_r);
      }
      this.inst[c.kind].push(_m, c.burnt, c.door, 0, 0, c.paint.r, c.paint.g, c.paint.b);
      // lights
      if (c.s === S.Wreck || c.s === S.Sinking) continue;
      const hx = Math.cos(c.yaw);
      const hy = Math.sin(c.yaw);
      const rx = -hy;
      const ry = hx;
      const fl = mdl.len / 2 + 0.01;
      const ly = y + mdl.lightY;
      const sw = mdl.wid * 0.33;
      if (c.s === S.Abandoned || (c.panic > 0 && c.s !== S.Drive)) {
        // hazard blinkers (day and night)
        const on = Math.sin(time * 9 + c.id) > 0;
        if (on) {
          const k = 0.8 + dk * 1.2;
          for (const sx of [fl, -fl])
            for (const sd of [-1, 1]) Lt.flare(c.x + hx * sx + rx * sd * sw * 1.2, ly, c.y + hy * sx + ry * sd * sw * 1.2, 0.09 + dk * 0.05, 1.9 * k, 0.9 * k, 0.15 * k);
        }
      }
      if (dk > 0.08 && c.s !== S.Abandoned) {
        const k = dk;
        for (const sd of [-1, 1]) {
          Lt.flare(c.x + hx * fl + rx * sd * sw, ly, c.y + hy * fl + ry * sd * sw, 0.14, 2.0 * k, 1.85 * k, 1.5 * k);
          const b = c.brake ? 2.2 : 1;
          Lt.flare(c.x - hx * fl + rx * sd * sw, ly, c.y - hy * fl + ry * sd * sw, 0.06 * (c.brake ? 1.4 : 1), 1.3 * k * b, 0.06 * k * b, 0.03 * k * b);
        }
        const px = c.x + hx * (fl + 0.55);
        const pz = c.y + hy * (fl + 0.55);
        Lt.pool(px, groundAt(this.map, px, pz), pz, -c.yaw, 1.1, 0.55, 0.3 * k, 0.27 * k, 0.2 * k);
      }
    }
    for (const im of this.inst) im.commit();
  }

  get count() {
    return this.cars.length;
  }

  /** Debug / screenshots: car positions and states. */
  debug() {
    return this.cars.map((c) => ({ x: +c.x.toFixed(2), y: +c.y.toFixed(2), s: c.s, kind: c.kind, v: +c.v.toFixed(2), panic: +c.panic.toFixed(1), seen: c.seen }));
  }
}
