import * as THREE from 'three';
import { WATER_LEVEL, type GameMap } from '../../sim/map';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import { groundY } from '../landmarks/ground';
import { landmarkMaterial } from '../landmarks/material';
import { landmarkPlan, type RailPlan } from '../landmarks/plan';
import { civSound } from '../landmarks/sound';
import { Kit, platform } from '../models/landmarks';
import { COACH_LEN, GAUGE, LOCO_LEN, METRO_LEN, TANK_LEN, WAGON_LEN, boxWagon, coach, locomotive, metroCar, tankWagon } from '../models/landmarks-vehicles';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from './shared';

/*
 * The railways (render only; landmarks/plan.ts lays the lines out in the
 * outskirts, just past the map edge, so a train never meets a unit):
 *
 *  - track: ballast bed, sleepers and rails on the ground (or a concrete
 *    viaduct for Canal City's metro), catenary masts and the contact wire on
 *    the electrified lines, block signals, a station platform;
 *  - level crossings where a road crosses: crossing panels, crossbucks,
 *    half-barrier arms that swing down, alternating red lights and a bell
 *    while a train is near. levelCrossingClosed(x, y) tells the civilian
 *    traffic (traffic.ts wires it) to wait at a closed crossing;
 *  - a train every few minutes per line: an electric locomotive with coaches
 *    (it stops at the station) or freight wagons; four-car metro sets on the
 *    viaduct. Headlight / tail light and lit windows at night, a horn before
 *    the crossings, the rumble as it passes the view;
 *  - a shell landing next to the line derails the train (render-only): the
 *    cars jack-knife off the track and burn for a while, then the line is
 *    cleared and service resumes.
 *
 * Draw calls: the whole track network is one static mesh; each car type that
 * is on screen is one instanced mesh (2 - 3 for a train); barrier arms one.
 * Low quality: track only (no trains, no barriers).
 */

/** Height of the rail tops above the line's bed height. */
const RAIL_TOP = 0.115;
const T_LOCO = 0;
const T_COACH = 1;
const T_BOX = 2;
const T_TANK = 3;
const T_METRO = 4;
const LENS = [LOCO_LEN, COACH_LEN, WAGON_LEN, TANK_LEN, METRO_LEN];
const GAP = 0.07;

interface Car {
  type: number;
  len: number;
  /** Offset of the car centre behind the head (arc). */
  off: number;
  /** Derailment: yaw / roll targets, lateral slide. */
  dy: number;
  dr: number;
  ds: number;
  burn: boolean;
}

interface Crossing {
  x: number;
  y: number;
  arc: number;
  h: number;
  roadAng: number;
  traffic: boolean;
  /** 0 open .. 1 barriers down. */
  k: number;
  closed: boolean;
  bellT: number;
  /** Barrier pivots: position, arm heading. */
  arms: { x: number; y: number; z: number; yaw: number }[];
  lamps: { x: number; y: number; z: number; ph: number }[];
}

interface Line {
  plan: RailPlan;
  /** Bed height per point (ground smoothed, or the viaduct deck). */
  h: Float32Array;
  crossings: Crossing[];
  signals: { x: number; y: number; z: number; arc: number }[];
  train: Train;
}

interface Train {
  state: 0 | 1 | 2 | 3; // waiting, running, dwelling, derailed
  wait: number;
  cars: Car[];
  total: number;
  head: number;
  dir: number;
  v: number;
  vmax: number;
  passenger: boolean;
  stopAt: number;
  stopped: boolean;
  dwell: number;
  derailT: number;
  horned: Set<number>;
  rumbleT: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const PT = { x: 0, y: 0, tx: 1, ty: 0, h: 0 };

let current: Railway | null = null;

/**
 * Is the level crossing at / near (x, y) closed (barriers lowering or down, a train near)?
 * For the civilian traffic: cars should stop short of a closed crossing. Within 1.6 tiles of a crossing centre.
 */
export function levelCrossingClosed(x: number, y: number): boolean {
  return current ? current.closedAt(x, y) : false;
}

/** The level crossings of a map (centre, road heading); for tests and the traffic wiring. */
export function levelCrossings(m: GameMap): { x: number; y: number; roadAng: number; traffic: boolean }[] {
  return landmarkPlan(m).rails.flatMap((r) => r.crossings.map((c) => ({ x: c.x, y: c.y, roadAng: c.roadAng, traffic: c.traffic })));
}

export class Railway {
  readonly group = new THREE.Group();
  private lines: Line[] = [];
  private banks: THREE.InstancedMesh[] = [];
  private arms: THREE.InstancedMesh | null = null;
  private animate: boolean;
  private time = 0;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    private effects: Effects,
    quality: Quality,
  ) {
    this.group.name = 'railway';
    this.animate = quality !== 'low';
    const plan = landmarkPlan(map);
    if (!plan.rails.length) return;
    current = this;
    const k = new Kit();
    for (const rp of plan.rails) {
      const line = this.layLine(rp);
      this.lines.push(line);
      this.buildTrack(k, line);
    }
    const mat = landmarkMaterial(fog);
    const mesh = new THREE.Mesh(k.build(), mat);
    mesh.name = 'railway-track';
    mesh.receiveShadow = quality !== 'low';
    mesh.castShadow = quality === 'high';
    mesh.frustumCulled = true;
    this.group.add(mesh);
    if (!this.animate) return;
    // rolling stock: one instanced mesh per car type
    const geos = [locomotive(), coach(), boxWagon(), tankWagon(), metroCar()];
    const metro = plan.rails.some((r) => r.service === 'metro');
    const country = plan.rails.some((r) => r.service === 'country');
    geos.forEach((g, i) => {
      const need = i === T_METRO ? metro : country;
      const n = need ? (i === T_METRO ? 5 : 10) * plan.rails.length : 1;
      const im = new THREE.InstancedMesh(g, mat, n);
      im.name = 'train-' + ['loco', 'coach', 'box', 'tank', 'metro'][i];
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = quality === 'high';
      im.frustumCulled = false;
      im.count = 0;
      im.visible = false;
      this.banks.push(im);
      this.group.add(im);
    });
    const nArms = this.lines.reduce((s, l) => s + l.crossings.length * 2, 0);
    if (nArms) {
      const im = new THREE.InstancedMesh(barrierArm(), mat, nArms);
      im.name = 'crossing-arms';
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      this.arms = im;
      this.group.add(im);
    }
    // first trains soon after the start, then every few minutes
    this.lines.forEach((l, i) => (l.train.wait = 10 + i * 22 + Math.random() * 15));
  }

  // ---------------------------------------------------------------- layout

  private layLine(plan: RailPlan): Line {
    const m = this.map;
    const n = plan.pts.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = plan.pts[i];
      const a = plan.pts[Math.max(0, i - 1)];
      const b = plan.pts[Math.min(n - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / L;
      const ny = (b.x - a.x) / L;
      raw[i] = Math.max(groundY(m, p.x, p.y), groundY(m, p.x + nx * 0.35, p.y + ny * 0.35), groundY(m, p.x - nx * 0.35, p.y - ny * 0.35), WATER_LEVEL + 0.12);
    }
    // a smooth grade: moving average, then lifted over any bump, then smoothed again
    const smooth = (src: Float32Array, R: number) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        let c = 0;
        for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) {
          s += src[j];
          c++;
        }
        out[i] = s / c;
      }
      return out;
    };
    let h = smooth(raw, 8);
    for (let i = 0; i < n; i++) h[i] = Math.max(h[i], raw[i] - 0.03);
    h = smooth(h, 3);
    if (plan.elevated) for (let i = 0; i < n; i++) h[i] += plan.elevated;
    const line: Line = { plan, h, crossings: [], signals: [], train: newTrain() };
    for (const c of plan.crossings) {
      const ph = this.at(line, c.arc).h;
      line.crossings.push({ x: c.x, y: c.y, arc: c.arc, h: ph, roadAng: c.roadAng, traffic: c.traffic, k: 0, closed: false, bellT: 0, arms: [], lamps: [] });
    }
    return line;
  }

  /** Point on a line at arc a (clamped): PT.x / y, tangent, bed height. */
  private at(l: Line, a: number) {
    const { pts, cum, len } = l.plan;
    const n = pts.length;
    const aa = Math.max(0, Math.min(len, a));
    let i = Math.min(n - 2, Math.max(0, Math.floor(aa * 2)));
    while (i > 0 && cum[i] > aa) i--;
    while (i < n - 2 && cum[i + 1] < aa) i++;
    const seg = cum[i + 1] - cum[i] || 1;
    const t = (aa - cum[i]) / seg;
    const p = pts[i];
    const q = pts[i + 1];
    PT.x = p.x + (q.x - p.x) * t;
    PT.y = p.y + (q.y - p.y) * t;
    PT.tx = (q.x - p.x) / seg;
    PT.ty = (q.y - p.y) / seg;
    PT.h = l.h[i] + (l.h[i + 1] - l.h[i]) * t;
    return PT;
  }

  /** Distance outside the map (for the level of detail of the track). */
  private outside(x: number, y: number) {
    const m = this.map;
    return Math.hypot(Math.max(0, -x, x - m.w), Math.max(0, -y, y - m.h));
  }

  private buildTrack(k: Kit, l: Line) {
    const { pts } = l.plan;
    const n = pts.length;
    const elev = l.plan.elevated > 0;
    const ballast = elev ? 0x7a7670 : 0x8a8276;
    const sleeperC = elev ? 0x9a968e : 0x5a4636;
    const railC = 0x9aa0a6;
    k.at(0, 0, 0, 0);
    const P = (i: number) => pts[i];
    const nrm = (i: number) => {
      const a = P(Math.max(0, i - 1));
      const b = P(Math.min(n - 1, i + 1));
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return [-(b.y - a.y) / L, (b.x - a.x) / L];
    };
    const ground = (i: number) => groundY(this.map, P(i).x, P(i).y);
    for (let i = 0; i < n - 1; i++) {
      const o = this.outside(P(i).x, P(i).y);
      const [nx0, ny0] = nrm(i);
      const [nx1, ny1] = nrm(i + 1);
      const h0 = l.h[i];
      const h1 = l.h[i + 1];
      // ballast bed: a trapezoid with a skirt down into the ground (or the viaduct deck)
      const prof = elev ? [[-0.42, 0.0], [-0.38, 0.06], [0.38, 0.06], [0.42, 0.0]] : [[-0.62, -0.25], [-0.32, 0.07], [0.32, 0.07], [0.62, -0.25]];
      for (let s = 0; s < prof.length - 1; s++) {
        const [a0, y0] = prof[s];
        const [a1, y1] = prof[s + 1];
        quad(k, P(i).x + nx0 * a0, h0 + y0, P(i).y + ny0 * a0, P(i + 1).x + nx1 * a0, h1 + y0, P(i + 1).y + ny1 * a0, P(i + 1).x + nx1 * a1, h1 + y1, P(i + 1).y + ny1 * a1, P(i).x + nx0 * a1, h0 + y1, P(i).y + ny0 * a1, s === 1 ? ballast : 0x7a7266, false);
      }
      if (elev) {
        // the viaduct: deck slab, parapets and pillars
        for (const sg of [-1, 1]) {
          const a = sg * 0.44;
          quad(k, P(i).x + nx0 * a, h0 + 0.12, P(i).y + ny0 * a, P(i + 1).x + nx1 * a, h1 + 0.12, P(i + 1).y + ny1 * a, P(i + 1).x + nx1 * a, h1 - 0.16, P(i + 1).y + ny1 * a, P(i).x + nx0 * a, h0 - 0.16, P(i).y + ny0 * a, 0xb8b4ac);
        }
        quad(k, P(i).x - nx0 * 0.44, h0 - 0.16, P(i).y - ny0 * 0.44, P(i).x + nx0 * 0.44, h0 - 0.16, P(i).y + ny0 * 0.44, P(i + 1).x + nx1 * 0.44, h1 - 0.16, P(i + 1).y + ny1 * 0.44, P(i + 1).x - nx1 * 0.44, h1 - 0.16, P(i + 1).y - ny1 * 0.44, 0x8a8680);
        if (i % 7 === 0 && o < 70) {
          const g = ground(i);
          const ph = h0 - 0.16 - g + 0.1;
          if (ph > 0.05) k.at(P(i).x, g - 0.1, P(i).y, Math.atan2(P(i + 1).y - P(i).y, P(i + 1).x - P(i).x)).box(0.22, ph, 0.5, 0, ph / 2, 0, 0xa8a49c).box(0.3, 0.1, 0.8, 0, ph - 0.02, 0, 0xa8a49c);
          k.at(0, 0, 0, 0);
        }
      }
      // sleepers (top faces) and rails, near the map only
      const near = o < 34;
      if (near || i % 2 === 0) {
        const step = near ? 2 : 1;
        for (let sl = 0; sl < step; sl++) {
          const t = sl / step;
          const x = P(i).x + (P(i + 1).x - P(i).x) * t;
          const y = P(i).y + (P(i + 1).y - P(i).y) * t;
          const hh = h0 + (h1 - h0) * t + 0.075;
          const tx = P(i + 1).x - P(i).x;
          const ty = P(i + 1).y - P(i).y;
          const L = Math.hypot(tx, ty) || 1;
          const ux = (tx / L) * 0.04;
          const uy = (ty / L) * 0.04;
          const w = 0.19;
          quad(k, x - ux - nx0 * w, hh, y - uy - ny0 * w, x - ux + nx0 * w, hh, y - uy + ny0 * w, x + ux + nx0 * w, hh, y + uy + ny0 * w, x + ux - nx0 * w, hh, y + uy - ny0 * w, sleeperC, false);
        }
      }
      for (const sg of [-1, 1]) {
        const a = (sg * GAUGE) / 2;
        const top = RAIL_TOP;
        // rail: top and the outer face
        quad(k, P(i).x + nx0 * (a - 0.012), h0 + top, P(i).y + ny0 * (a - 0.012), P(i).x + nx0 * (a + 0.012), h0 + top, P(i).y + ny0 * (a + 0.012), P(i + 1).x + nx1 * (a + 0.012), h1 + top, P(i + 1).y + ny1 * (a + 0.012), P(i + 1).x + nx1 * (a - 0.012), h1 + top, P(i + 1).y + ny1 * (a - 0.012), railC, false);
        if (near) {
          const e = a + sg * 0.012;
          quad(k, P(i).x + nx0 * e, h0 + top, P(i).y + ny0 * e, P(i + 1).x + nx1 * e, h1 + top, P(i + 1).y + ny1 * e, P(i + 1).x + nx1 * e, h1 + 0.075, P(i + 1).y + ny1 * e, P(i).x + nx0 * e, h0 + 0.075, P(i).y + ny0 * e, 0x5a4e44);
        }
      }
      // catenary: a mast every 4 tiles on the left, a cantilever over the track, the contact wire
      if (l.plan.wired && o < 40) {
        const M = 8;
        if (i % M === 0) {
          const mx = P(i).x + nx0 * 0.42;
          const my = P(i).y + ny0 * 0.42;
          k.at(0, 0, 0, 0)
            .beam(mx, h0 - 0.1, my, mx, h0 + 0.98, my, 0.035, 0x6a6e66)
            .beam(mx, h0 + 0.92, my, P(i).x - nx0 * 0.05, h0 + 0.92, P(i).y - ny0 * 0.05, 0.02, 0x6a6e66)
            .beam(mx, h0 + 0.76, my, P(i).x, h0 + 0.88, P(i).y, 0.012, 0x6a6e66);
        }
        if (i % 2 === 0) {
          const j = Math.min(n - 1, i + 2);
          k.at(0, 0, 0, 0).beam(P(i).x, h0 + 0.8, P(i).y, P(j).x, l.h[j] + 0.8, P(j).y, 0.01, 0x2a2a2a);
          k.beam(P(i).x, h0 + 0.9, P(i).y, P(j).x, l.h[j] + 0.9, P(j).y, 0.008, 0x2a2a2a);
        }
      }
    }
    // the station platform
    const st = l.plan.station;
    if (st) {
      for (let a = st.a0; a < st.a1 - 0.5; a += 1.0) {
        const p = this.at(l, a + 0.5);
        const yaw = Math.atan2(p.ty, p.tx);
        const off = st.side * 0.62;
        // local x of the platform model faces the track: rotate so +X points from the platform to the rail
        const nx = -p.ty;
        const ny = p.tx;
        const px = p.x + nx * off;
        const py = p.y + ny * off;
        k.at(px, p.h - 0.02, py, Math.atan2(-ny * st.side, -nx * st.side));
        platform(k, 1.02);
        void yaw;
      }
    }
    // crossings: panels, crossbucks with lamp housings, barrier pivots
    for (const c of l.crossings) {
      const p = this.at(l, c.arc);
      const tx = p.tx;
      const ty = p.ty;
      const rx = Math.cos(c.roadAng);
      const ry = Math.sin(c.roadAng);
      const nx = -ry;
      const ny = rx;
      const H = p.h + RAIL_TOP;
      // rubber panels across the road
      k.at(c.x, H - 0.01, c.y, Math.atan2(ry, rx)).box(0.9, 0.02, 1.25, 0, 0, 0, 0x2e2e30);
      for (const sg of [-1, 1]) k.at(c.x, H, c.y, Math.atan2(ty, tx)).box(1.25, 0.005, 0.02, 0, 0.003, (sg * GAUGE) / 2, 0x9aa0a6);
      for (const sg of [-1, 1]) {
        // each side of the track: a post on the right of the approaching traffic, the arm across the road
        const bx = c.x + rx * sg * 0.75 - nx * sg * 0.66;
        const by = c.y + ry * sg * 0.75 - ny * sg * 0.66;
        const g = Math.max(groundY(this.map, bx, by), p.h - 0.05);
        k.at(bx, g, by, Math.atan2(ry, rx) + (sg > 0 ? 0 : Math.PI));
        k.box(0.05, 0.62, 0.05, 0, 0.31, 0, 0xe8e8e8);
        k.box(0.03, 0.04, 0.32, 0.03, 0.58, 0, 0xe8e8e8, 0, 0, 0.8).box(0.03, 0.04, 0.32, 0.03, 0.58, 0, 0xe8e8e8, 0, 0, -0.8);
        k.box(0.03, 0.03, 0.33, 0.032, 0.58, 0, 0xc02020, 0, 0, 0.8).box(0.03, 0.03, 0.33, 0.032, 0.58, 0, 0xc02020, 0, 0, -0.8);
        k.box(0.06, 0.08, 0.26, 0.0, 0.43, 0, 0x1a1a1a);
        k.box(0.14, 0.18, 0.12, -0.02, 0.09, 0.08, 0x8a8e94);
        // lamps face the oncoming traffic (towards -road * sg)
        for (const lz of [-0.09, 0.09]) c.lamps.push({ x: bx - rx * sg * 0.05 + nx * lz, y: g + 0.43, z: by - ry * sg * 0.05 + ny * lz, ph: lz > 0 ? 0 : Math.PI });
        c.arms.push({ x: bx + nx * sg * 0.02, y: g + 0.24, z: by + ny * sg * 0.02, yaw: Math.atan2(ny * sg, nx * sg) });
      }
      // signals each side of the crossing on the line
      for (const da of [-9, 9]) l.signals.push({ ...this.sigAt(l, c.arc + da), arc: c.arc + da });
    }
    if (st) for (const a of [st.a0 - 3, st.a1 + 3]) l.signals.push({ ...this.sigAt(l, a), arc: a });
    for (const s of l.signals) {
      k.at(s.x, s.y - 0.62, s.z, 0).box(0.03, 0.62, 0.03, 0, 0.31, 0, 0x4a4e54).box(0.07, 0.16, 0.06, 0, 0.6, 0, 0x1a1a1a);
    }
  }

  private sigAt(l: Line, a: number) {
    const p = this.at(l, a);
    const nx = -p.ty;
    const ny = p.tx;
    return { x: p.x - nx * 0.42, y: p.h + 0.62 + (l.plan.elevated ? 0 : 0), z: p.y - ny * 0.42 };
  }

  // ---------------------------------------------------------------- trains

  private dispatch(l: Line) {
    const t = l.train;
    const metro = l.plan.service === 'metro';
    t.passenger = metro || Math.random() < 0.6;
    t.cars = [];
    const types: number[] = metro ? [T_METRO, T_METRO, T_METRO, T_METRO] : t.passenger ? [T_LOCO, ...Array(3 + Math.floor(Math.random() * 3)).fill(T_COACH)] : [T_LOCO, ...Array.from({ length: 6 + Math.floor(Math.random() * 4) }, () => (Math.random() < 0.55 ? T_BOX : T_TANK))];
    let off = 0;
    for (const ty of types) {
      const len = LENS[ty];
      t.cars.push({ type: ty, len, off: off + len / 2, dy: 0, dr: 0, ds: 0, burn: false });
      off += len + GAP;
    }
    t.total = off;
    t.dir = Math.random() < 0.5 ? 1 : -1;
    t.head = t.dir > 0 ? 0 : l.plan.len;
    t.vmax = metro ? 3.4 : t.passenger ? 4.2 : 3.0;
    t.v = t.vmax;
    t.state = 1;
    t.horned.clear();
    t.rumbleT = 0;
    const st = l.plan.station;
    t.stopAt = st && t.passenger ? (st.a0 + st.a1) / 2 + (t.dir * t.total) / 2 - t.dir * 0.4 : -1;
    t.stopped = false;
  }

  private stepTrain(l: Line, f: AmbientFrame) {
    const t = l.train;
    const dt = f.dt;
    if (t.state === 0) {
      t.wait -= dt;
      if (t.wait <= 0) this.dispatch(l);
      return;
    }
    if (t.state === 3) {
      t.derailT += dt;
      t.v = Math.max(0, t.v - dt * 6);
      t.head += t.dir * t.v * dt;
      if (t.derailT > 55) {
        t.state = 0;
        t.wait = 50 + Math.random() * 40;
      }
      return;
    }
    if (t.state === 2) {
      t.dwell -= dt;
      if (t.dwell <= 0) {
        t.state = 1;
        t.stopped = true;
      }
      return;
    }
    // running: brake for the station stop, otherwise cruise
    let target = t.vmax;
    if (t.stopAt >= 0 && !t.stopped) {
      const d = (t.stopAt - t.head) * t.dir;
      if (d <= 0.05) {
        t.v = 0;
        t.state = 2;
        t.dwell = 9 + Math.random() * 5;
        return;
      }
      target = Math.min(target, Math.sqrt(2 * 0.7 * d) + 0.15);
    }
    t.v += Math.max(-1.4 * dt, Math.min(0.6 * dt, target - t.v));
    t.head += t.dir * t.v * dt;
    // horn before each crossing; past the end of the line: gone
    l.crossings.forEach((c, i) => {
      const d = (c.arc - t.head) * t.dir;
      if (d > 0 && d < 16 && !t.horned.has(i)) {
        t.horned.add(i);
        const p = this.at(l, t.head);
        if (this.inView(f, p.x, p.y, 14)) civSound('trainHorn', 0.85, p.x, p.y, 0.4);
      }
    });
    const tail = t.head - t.dir * t.total;
    if ((t.dir > 0 && tail > l.plan.len + 1) || (t.dir < 0 && tail < -1)) {
      t.state = 0;
      t.wait = 75 + Math.random() * 90;
    }
    // the rumble while it passes the view
    t.rumbleT -= dt;
    if (t.rumbleT <= 0) {
      const mid = this.at(l, t.head - (t.dir * t.total) / 2);
      if (this.inView(f, mid.x, mid.y, 6) && this.probe.visible(mid.x, mid.y)) {
        civSound('trainPass', Math.min(1, 0.45 + t.cars.length * 0.08) * (t.state === 1 ? Math.min(1, t.v / 2 + 0.2) : 0.3), mid.x, mid.y, 0.3);
        t.rumbleT = 6.5;
      } else t.rumbleT = 0.5;
    }
  }

  private inView(f: AmbientFrame, x: number, y: number, m: number) {
    return x > f.vx0 - m && x < f.vx1 + m && y > f.vy0 - m && y < f.vy1 + m;
  }

  /** Derail any train with a car close to a blast at (x, y) (lethal radius `kill`). */
  blast(x: number, y: number, kill: number) {
    for (const l of this.lines) {
      const t = l.train;
      if (t.state !== 1 && t.state !== 2) continue;
      let hit = -1;
      for (let i = 0; i < t.cars.length; i++) {
        const p = this.at(l, t.head - t.dir * t.cars[i].off);
        if (Math.hypot(p.x - x, p.y - y) < kill + 0.75) {
          hit = i;
          break;
        }
      }
      if (hit < 0) continue;
      t.state = 3;
      t.derailT = 0;
      t.v = Math.max(t.v, 1.5);
      t.cars.forEach((c, i) => {
        const near = Math.abs(i - hit);
        const k = Math.max(0.15, 1 - near * 0.22);
        const sg = (i % 2 ? 1 : -1) * (Math.random() < 0.8 ? 1 : -1);
        c.dy = sg * (0.25 + Math.random() * 0.6) * k;
        c.dr = sg * (0.15 + Math.random() * 0.9) * k * (near < 2 ? 1.6 : 1);
        c.ds = sg * (0.2 + Math.random() * 0.5) * k;
        c.burn = near < 2 || c.type === T_TANK && near < 4;
      });
      const p = this.at(l, t.head - t.dir * t.cars[hit].off);
      this.effects.explosion(p.x, p.h + 0.4, p.y, t.cars[hit].type === T_TANK ? 'medium' : 'small', 'fire');
    }
  }

  /** Is a crossing within 1.6 tiles of (x, y) closed? */
  closedAt(x: number, y: number): boolean {
    for (const l of this.lines) for (const c of l.crossings) if (c.closed && Math.hypot(c.x - x, c.y - y) < 1.6) return true;
    return false;
  }

  // ---------------------------------------------------------------- frame

  update(f: AmbientFrame) {
    if (!this.animate || !this.lines.length) return;
    this.time += f.dt;
    for (const l of this.lines) {
      this.stepTrain(l, f);
      this.stepCrossings(l, f);
    }
    this.draw(f);
  }

  private stepCrossings(l: Line, f: AmbientFrame) {
    const t = l.train;
    for (const c of l.crossings) {
      let closed = false;
      if (t.state !== 0) {
        const tail = t.head - t.dir * t.total;
        const lo = Math.min(t.head + t.dir * 15, tail - t.dir * 2.5);
        const hi = Math.max(t.head + t.dir * 15, tail - t.dir * 2.5);
        closed = c.arc > lo && c.arc < hi;
      }
      c.closed = closed || c.k > 0.05;
      c.k = Math.max(0, Math.min(1, c.k + (closed ? 1 : -1) * f.dt / 2.6));
      if (closed && this.inView(f, c.x, c.y, 8) && this.probe.visible(c.x, c.y)) {
        c.bellT -= f.dt;
        if (c.bellT <= 0) {
          c.bellT = 2.4;
          civSound('crossingBell', 0.7, c.x, c.y, 0.4);
        }
      } else c.bellT = 0;
    }
  }

  private draw(f: AmbientFrame) {
    const dk = f.dark;
    const L = this.lights;
    const counts = [0, 0, 0, 0, 0];
    for (const l of this.lines) {
      const t = l.train;
      if (t.state === 0) continue;
      const elevated = l.plan.elevated > 0;
      for (let i = 0; i < t.cars.length; i++) {
        const c = t.cars[i];
        const a = t.head - t.dir * c.off;
        if (a < -2 || a > l.plan.len + 2) continue;
        const half = c.len * 0.34;
        const f1 = this.at(l, a + half);
        const x1 = f1.x;
        const y1 = f1.y;
        const h1 = f1.h;
        const f2 = this.at(l, a - half);
        const cx = (x1 + f2.x) / 2;
        const cy = (y1 + f2.y) / 2;
        if (!this.inView(f, cx, cy, 3) || !this.probe.visible(cx, cy)) continue;
        let yaw = Math.atan2(y1 - f2.y, x1 - f2.x);
        if (t.dir < 0) yaw += Math.PI;
        const pitch = Math.atan2(h1 - f2.h, c.len * 0.68) * t.dir;
        let ch = (h1 + f2.h) / 2 + RAIL_TOP;
        let px = cx;
        let py = cy;
        let roll = 0;
        if (t.state === 3) {
          // jack-knifed off the track (the viaduct keeps them on the deck, tilted)
          const k = Math.min(1, t.derailT / 1.3);
          const e = 1 - (1 - k) * (1 - k);
          yaw += c.dy * e * (elevated ? 0.3 : 1);
          roll = c.dr * e * (elevated ? 0.4 : 1);
          const nx = -Math.sin(yaw);
          const ny = Math.cos(yaw);
          px += nx * c.ds * e * (elevated ? 0.2 : 1);
          py += ny * c.ds * e * (elevated ? 0.2 : 1);
          ch -= Math.abs(roll) * 0.08;
          if (c.burn && t.derailT < 45 && Math.random() < f.dt * 4) {
            this.effects.column(px, ch + 0.3, py, 0.8, true);
            if (t.derailT < 25) this.effects.flame(px, ch + 0.25, py, 0.7);
          }
          if (c.burn && t.derailT < 25) this.effects.burnGlow(px, ch + 0.3, py, 1.4);
        }
        _e.set(roll, -yaw, pitch, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(px, ch, py), _q, _s);
        const im = this.banks[c.type];
        if (counts[c.type] < im.instanceMatrix.count) im.setMatrixAt(counts[c.type]++, _m);
        // headlight (lead car), tail light (last car)
        if (t.state !== 3 && (i === 0 || i === t.cars.length - 1)) {
          const front = i === 0;
          const fx = Math.cos(yaw);
          const fy = Math.sin(yaw);
          const sx = px + fx * (front ? 1 : -1) * (c.len / 2 + 0.01);
          const sy = py + fy * (front ? 1 : -1) * (c.len / 2 + 0.01);
          if (front) {
            const k = 0.5 + dk * 1.5;
            L.flare(sx, ch + 0.19, sy, 0.16 + dk * 0.12, 1.8 * k, 1.7 * k, 1.3 * k);
            if (dk > 0.15) L.pool(sx + fx * 0.9, ch - RAIL_TOP, sy + fy * 0.9, -yaw, 1.8, 0.6, 0.45 * dk, 0.42 * dk, 0.32 * dk);
          } else if (dk > 0.1) L.flare(sx, ch + 0.18, sy, 0.1, 1.6 * dk, 0.1 * dk, 0.08 * dk);
        }
      }
    }
    this.banks.forEach((im, i) => {
      im.count = counts[i];
      im.visible = counts[i] > 0;
      if (counts[i]) {
        im.instanceMatrix.clearUpdateRanges();
        im.instanceMatrix.addUpdateRange(0, counts[i] * 16);
        im.instanceMatrix.needsUpdate = true;
      }
    });
    // crossings: arms swing down, lamps flash alternately; block signals
    const arms = this.arms;
    let na = 0;
    const blink = Math.sin(this.time * Math.PI * 2 * 0.9) > 0;
    for (const l of this.lines) {
      for (const c of l.crossings) {
        const vis = this.inView(f, c.x, c.y, 4) && this.probe.visible(c.x, c.y);
        // arms are vertical (raised) when open; they swing down after a short warning
        const k = Math.max(0, Math.min(1, (c.k - 0.25) / 0.75));
        const ang = (Math.PI / 2) * (1 - k * k * (3 - 2 * k));
        if (arms)
          for (const a of c.arms) {
            _q.setFromEuler(_e.set(0, -a.yaw, ang, 'YXZ'));
            _m.compose(_p.set(a.x, a.y, a.z), _q, _s);
            arms.setMatrixAt(na++, _m);
          }
        if (vis && c.k > 0.01)
          for (const lp of c.lamps) {
            const on = (lp.ph === 0) === blink;
            if (on) L.flare(lp.x, lp.y, lp.z, 0.16, 2.2, 0.15, 0.05);
          }
      }
      for (const s of l.signals) {
        if (!this.inView(f, s.x, s.z, 3) || !this.probe.visible(s.x, s.z)) continue;
        const t = l.train;
        const occ = t.state !== 0 && Math.abs(s.arc - (t.head - (t.dir * t.total) / 2)) < t.total / 2 + 14;
        const k = 0.6 + dk * 0.8;
        if (occ) L.flare(s.x, s.y, s.z, 0.08, 2 * k, 0.15 * k, 0.1 * k);
        else L.flare(s.x, s.y, s.z, 0.08, 0.15 * k, 1.8 * k, 0.6 * k);
      }
    }
    if (arms) {
      arms.count = na;
      arms.instanceMatrix.needsUpdate = true;
    }
  }

  /** Debug / tests. */
  stats() {
    return this.lines.map((l) => ({ state: l.train.state, head: +l.train.head.toFixed(1), dir: l.train.dir, cars: l.train.cars.length, wait: +l.train.wait.toFixed(1), crossings: l.crossings.map((c) => ({ x: +c.x.toFixed(2), y: +c.y.toFixed(2), closed: c.closed, k: +c.k.toFixed(2) })) }));
  }

  /** Debug: send the next train now (and park it upstream of the first crossing when `atCrossing`). */
  debugDispatch(line = 0, atCrossing = false, dir = 1) {
    const l = this.lines[line];
    if (!l) return;
    this.dispatch(l);
    const t = l.train;
    t.dir = dir;
    if (atCrossing && l.crossings.length) t.head = l.crossings[0].arc - dir * 3;
    t.stopAt = -1;
  }
}

function newTrain(): Train {
  return { state: 0, wait: 30, cars: [], total: 0, head: 0, dir: 1, v: 0, vmax: 4, passenger: true, stopAt: -1, stopped: false, dwell: 0, derailT: 0, horned: new Set(), rumbleT: 0 };
}

/** A flat-shaded quad (a, b, c, d around its edge) into the kit; `two` adds the back face (seen from both sides). */
function quad(k: Kit, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, col: number, two = true) {
  // geometric normal of (a, b, c): the side its counter-clockwise winding faces
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz) || 1;
  nx /= L;
  ny /= L;
  nz /= L;
  _c.setHex(col);
  const front = [ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz];
  const back = [ax, ay, az, cx, cy, cz, bx, by, bz, ax, ay, az, dx, dy, dz, cx, cy, cz];
  const emit = (v: number[], sg: number) => {
    for (let i = 0; i < 6; i++) {
      k.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      k.nor.push(nx * sg, ny * sg, nz * sg);
      k.col.push(_c.r, _c.g, _c.b);
      k.glow.push(0);
    }
  };
  // one-sided quads keep the face that looks up
  if (two || ny >= 0) emit(front, 1);
  if (two || ny < 0) emit(back, -1);
}
const _c = new THREE.Color();

/** Barrier arm: red / white boom along +X from a pivot at the origin, a counterweight behind it. */
function barrierArm(): THREE.BufferGeometry {
  const k = new Kit();
  const L = 1.05;
  const n = 6;
  for (let i = 0; i < n; i++) k.box(L / n, 0.035, 0.03, (i + 0.5) * (L / n) + 0.04, 0, 0, i % 2 ? 0xf0f0f0 : 0xd02020);
  k.box(0.14, 0.08, 0.06, -0.08, 0, 0, 0x3a3a3a);
  k.box(0.05, 0.05, 0.05, 0, 0, 0, 0x8a8e94);
  return k.build();
}
