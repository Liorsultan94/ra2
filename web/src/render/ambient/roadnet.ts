import { Tile, type GameMap } from '../../sim/map';
import type { Layout, V2 } from '../layout';
import type { Board, Lot } from './sites';

/*
 * The civilian road network as a lane graph (pure logic, no three.js): the
 * render layout's roads, tracks and bridge decks become lines; every place
 * where lines meet (end to line, line across line) or a line just stops
 * becomes a node with arms, and every node gets a traffic rule:
 *
 *  - Free:   two lines joined end to end (a plain continuation);
 *  - Yield:  unsignalled junction, the side road / track gives way to the main road;
 *  - Signal: traffic lights (city 4-way crossings, big village junctions);
 *  - Loop:   a roundabout (paved roads meeting in the open countryside) or a
 *            turning place at a dead end (paved: a turning circle with a central
 *            island; dirt track: a small gravel loop). Traffic circulates
 *            counter-clockwise on screen (right-hand traffic), i.e. with the
 *            tile-space angle decreasing, and gives way to circulating cars.
 *
 * It also lists the road furniture (traffic lights, signs, islands) and the
 * markings (turning circles, stop lines, give-way lines, zebras) that
 * roadfurniture.ts draws, a speed limit per line point (slower in villages and
 * the city) and a raster of the drivable surface (used by the tests to prove
 * no car path leaves the road).
 */

export interface NetLine {
  pts: V2[];
  cum: Float32Array;
  len: number;
  /** Lane offset to the right of the centreline. */
  lane: number;
  /** Half width of the drivable surface. */
  half: number;
  paved: boolean;
  /** City street painted by the ground shader. */
  painted: boolean;
  /** Road look: 0 highway, 1 country road (tracks: 1). */
  variant: number;
  /** Access lane of parking lot #lot, -1 otherwise. */
  lot: number;
  /** World bridge index for a deck crossing, -1 otherwise. */
  bridge: number;
  /** Endpoint at the map edge (cars leave / enter there). */
  portal: [boolean, boolean];
  /** Junction approaches on this line, sorted by arc. */
  stops: Stop[];
  /** Speed limit factor per point (villages / city slower, open road faster). */
  limit: Float32Array;
  /** Drivable arc range (spawning): dead-end turning places excluded. */
  a0: number;
  a1: number;
  /** Bounding box (+ half width). */
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
}

/** Where a car travelling `dir` along a line reaches node `node` (through arm `arm`). */
export interface Stop {
  node: number;
  arm: number;
  /** Arc where the car leaves the line (junction centre, or the roundabout edge). */
  arc: number;
  /** Travel direction of the inbound cars. */
  dir: number;
  /** Arc where a car waits (stop line, give-way line). */
  hold: number;
}

export interface Arm {
  line: number;
  /** Node arc on the line. */
  arc: number;
  /** Direction along the line leaving the node. */
  dir: number;
  /** Heading leaving the node (tile-space angle). */
  ang: number;
  /** Signal phase group (0 / 1). */
  axis: number;
  /** Has priority at an unsignalled junction. */
  major: boolean;
  /** Arc where the inbound car waits. */
  hold: number;
  /** Roundabouts: arc where the line meets the circle, entry / exit angles of the lanes. */
  edge: number;
  inAng: number;
  outAng: number;
}

export const enum Ctl {
  Free = 0,
  Yield = 1,
  Signal = 2,
  Loop = 3,
  /** Dead end without room for a turning place: 3-point turn on the road. */
  Turn = 4,
  /** End of a parking lot's access lane: the cars park. */
  Lot = 5,
}

export interface NetNode {
  x: number;
  y: number;
  arms: Arm[];
  ctl: Ctl;
  loop: number;
  signal: number;
  /** In a village / the city. */
  village: boolean;
  /** Lines with priority (Yield nodes, and failed signals). */
  majorLines: number[];
  /** Parking lot served (Ctl.Lot), -1 otherwise. */
  lot: number;
}

export interface Loop {
  x: number;
  y: number;
  /** Outer radius of the paved circle. */
  R: number;
  /** Central island radius (0: gravel loop without island). */
  ri: number;
  /** Radius of the circulating lane. */
  rl: number;
  paved: boolean;
  node: number;
  /** Turning place at a dead end (vs a roundabout joining roads). */
  dead: boolean;
}

export const enum SigMode {
  Normal = 0,
  /** Blinking amber (power cut / damage): treated as an unsignalled junction. */
  Flash = 1,
  Dark = 2,
}

export interface Signal {
  node: number;
  x: number;
  y: number;
  /** Cycle offset (s). */
  offset: number;
  mode: SigMode;
}

export const enum MarkKind {
  /** Paved turning circle / roundabout disc (asphalt, island). */
  Disc = 0,
  /** Gravel turning loop of a dirt track. */
  Gravel = 1,
  /** Solid stop line. */
  Bar = 2,
  /** Give-way line (shark teeth). */
  Teeth = 3,
  /** Zebra crossing. */
  Zebra = 4,
  /** Short paved / gravel link from a road or track end that stops short of the road it joins. */
  Asphalt = 5,
  Gravel2 = 6,
}

/** Ground marking: a decal of `len` (along `ang`) by `wid`, centred on (x, y); discs use `len` as the radius. */
export interface Mark {
  kind: MarkKind;
  x: number;
  y: number;
  ang: number;
  len: number;
  wid: number;
}

export const enum PropKind {
  /** Traffic light: pole + head facing `yaw`, on signal `ref`, phase group `axis`. */
  Light = 0,
  GiveWay = 1,
  StopSign = 2,
  /** Roundabout island (radius `size`): kerb ring + greenery. */
  Island = 3,
}

export interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  /** Facing (tile-space angle the sign / head looks along). */
  yaw: number;
  ref: number;
  axis: number;
  size: number;
}

export interface RoadNet {
  w: number;
  h: number;
  lines: NetLine[];
  nodes: NetNode[];
  loops: Loop[];
  signals: Signal[];
  marks: Mark[];
  /** Parking lots (sites.ts) and billboard spots, filled in by clearance.ts. */
  lots: Lot[];
  boards: Board[];
  /** Short links from a road / track end that stops short of the road it joins (drawn as road / track pieces). */
  links: { x0: number; y0: number; x1: number; y1: number; half: number; paved: boolean; variant: number; joinHalf: number }[];
  props: Prop[];
  /** Drivable surface raster, `res` cells per tile: 1 road / track / turning place / junction. */
  surface: Uint8Array;
  res: number;
}

export interface NetInput {
  w: number;
  h: number;
  roads: readonly { pts: V2[]; width: number; variant: 0 | 1; painted?: boolean; ring?: boolean; lot?: number }[];
  tracks: readonly { pts: V2[]; width: number; ring?: boolean }[];
  bridges: readonly { ends: readonly V2[] }[];
  /** Tile (tx, ty) can't take a turning place (water, rock, trees, structures, ore, base areas, off map). */
  hard: (tx: number, ty: number) => boolean;
  structures: readonly { x: number; y: number; w: number; h: number }[];
  urban: boolean;
  /** Tracks are cut where this is true (base areas: the roads already stop short of them). */
  clip?: (x: number, y: number) => boolean;
  /** Collects why dead ends got no turning place (tests / debugging). */
  debug?: string[];
}

// ------------------------------------------------------------------ geometry

export function cumulative(pts: V2[]): Float32Array {
  const c = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return c;
}

/** Index of the segment containing arc `a`. */
export function segAt(L: { cum: Float32Array; len: number }, a: number): number {
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

/** Shared output of pointAt (no allocation). */
export const PT = { x: 0, y: 0, tx: 0, ty: 0 };

/** Point + unit tangent at arc `a` (clamped), into PT. */
export function pointAt(L: { pts: V2[]; cum: Float32Array; len: number }, a: number) {
  const aa = a < 0 ? 0 : a > L.len ? L.len : a;
  const i = segAt(L, aa);
  const p = L.pts[i];
  const q = L.pts[i + 1];
  const sl = L.cum[i + 1] - L.cum[i] || 1;
  const t = (aa - L.cum[i]) / sl;
  PT.x = p.x + (q.x - p.x) * t;
  PT.y = p.y + (q.y - p.y) * t;
  PT.tx = (q.x - p.x) / sl;
  PT.ty = (q.y - p.y) / sl;
  return PT;
}

/** Nearest arc on the whole line to (x, y). */
export function nearestArc(L: { pts: V2[]; cum: Float32Array }, x: number, y: number): { arc: number; d: number } {
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

/** Local projection around the current arc (cheap, per frame). */
export function projectNear(L: { pts: V2[]; cum: Float32Array; len: number }, arc: number, x: number, y: number): number {
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

export function wrapPi(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** a mod 2pi in [0, 2pi). */
export function mod2pi(a: number) {
  const T = Math.PI * 2;
  a %= T;
  return a < 0 ? a + T : a;
}

// ------------------------------------------------------------------ rules (pure)

export const enum Light {
  Green = 0,
  Amber = 1,
  Red = 2,
  Off = 3,
}

export interface SignalTiming {
  green: number;
  amber: number;
  /** All-red clearance after each amber. */
  clear: number;
}

export const SIGNAL_TIMING: SignalTiming = { green: 9, amber: 2.4, clear: 1.6 };

/** Cycle length of the two-phase signal. */
export function signalCycle(tm: SignalTiming = SIGNAL_TIMING) {
  return (tm.green + tm.amber + tm.clear) * 2;
}

/**
 * Light shown to phase group `axis` (0 / 1) at time `t` of a two-phase cycle:
 * axis 0 green -> amber -> all red, then axis 1 green -> amber -> all red.
 */
export function signalLight(t: number, axis: number, tm: SignalTiming = SIGNAL_TIMING): Light {
  const half = tm.green + tm.amber + tm.clear;
  const T = half * 2;
  let u = t % T;
  if (u < 0) u += T;
  if (axis) u = (u + half) % T;
  if (u < tm.green) return Light.Green;
  if (u < tm.green + tm.amber) return Light.Amber;
  return Light.Red;
}

/** What a signal head shows, including the failure modes. */
export function headLight(mode: SigMode, t: number, axis: number, tm: SignalTiming = SIGNAL_TIMING): Light {
  if (mode === SigMode.Dark) return Light.Off;
  if (mode === SigMode.Flash) return (t * 1.1) % 1 < 0.5 ? Light.Amber : Light.Off;
  return signalLight(t, axis, tm);
}

/**
 * Should a car `dist` tiles before the stop line, at speed `v`, stop for this light?
 * Red: always; amber: unless it is too close to stop comfortably (decel `brake`).
 */
export function mustStop(light: Light, dist: number, v: number, brake = 1.5): boolean {
  if (light === Light.Green || light === Light.Off) return false;
  if (light === Light.Red) return true;
  return dist > (v * v) / (2 * brake) + 0.05;
}

/**
 * Time-gap acceptance for a merging car: a conflicting car `dist` tiles from
 * the conflict point at speed `v` leaves an acceptable gap when it is further
 * than `clear` and either (nearly) stopped or more than `crit` seconds away.
 */
export function gapOk(dist: number, v: number, crit = 2.2, clear = 0.8): boolean {
  if (dist < clear) return false;
  if (v < 0.05) return true;
  return (dist - clear) / v >= crit;
}

/** A car circulating on a roundabout (`loop`), at angle `ang`, `left` radians before it exits. */
export interface LoopCar {
  loop: number;
  ang: number;
  v: number;
  left: number;
}

/**
 * Roundabout entry gap: circulating traffic has priority. Travel is angle
 * decreasing, so a car at a larger angle is upstream of the entry. Free when
 * no circulating car sits on the merge point and every one that will pass the
 * entry is more than `crit` seconds away.
 */
export function loopGapFree(loop: number, entry: number, rl: number, cars: readonly LoopCar[], self: unknown, crit = 1.6, clear = 0.55): boolean {
  for (const o of cars) {
    if (o === self || o.loop !== loop) continue;
    const down = mod2pi(entry - o.ang) * rl; // just past the entry
    if (down < clear) return false;
    const up = mod2pi(o.ang - entry) * rl;
    // leaves the circle before it reaches the entry
    if (o.left * rl < up - 0.1) continue;
    if (up < clear + 0.2) return false;
    if (up / Math.max(o.v, 0.15) < crit) return false;
  }
  return true;
}

// ------------------------------------------------------------------ building

const SIGNAL_CYCLE = signalCycle();

export function netInput(m: GameMap, layout: Layout, bridges: readonly { ends: readonly V2[] }[]): NetInput {
  return netInputFrom(m, layout.roads, layout.tracks, bridges);
}

/** Deck ends of the map's bridges (as the sim computes them). */
export function bridgeEnds(m: GameMap): { ends: V2[] }[] {
  const D = Math.SQRT1_2;
  return m.bridges.map((b) => ({
    ends: [
      { x: b.x - (b.length / 2) * D, y: b.y + (b.length / 2) * D },
      { x: b.x + (b.length / 2) * D, y: b.y - (b.length / 2) * D },
    ],
  }));
}

export function netInputFrom(m: GameMap, roads: NetInput['roads'], tracks: NetInput['tracks'], bridges: readonly { ends: readonly V2[] }[]): NetInput {
  const W = m.w;
  const H = m.h;
  const urban = m.biome === 'urban';
  const baseR = urban ? 6.5 : 8.6;
  return {
    w: W,
    h: H,
    roads,
    tracks,
    bridges,
    structures: m.structures,
    urban,
    clip: urban ? undefined : (x, y) => m.starts.some((s) => Math.hypot(x - s.x - 0.5, y - s.y - 0.5) < 8.5),
    hard: (tx, ty) => {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
      const i = ty * W + tx;
      const t = m.tiles[i];
      if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[i] || m.blocked[i] || m.ore[i]) return true;
      for (const s of m.starts) if (Math.hypot(tx + 0.5 - s.x - 0.5, ty + 0.5 - s.y - 0.5) < baseR) return true;
      return false;
    },
  };
}

interface Cand {
  x: number;
  y: number;
  prio: number;
  /** Line endpoint it comes from (ai * 2 + end), -1 for crossings: one endpoint, one node. */
  ep: number;
  cs: { line: number; arc: number }[];
}

/**
 * Drop hairpin spikes the road router sometimes leaves at sharp corners (the
 * polyline overshoots and doubles back): no car could follow them.
 */
function unspike(src: V2[]): V2[] {
  const p = src.slice();
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    for (let i = 1; i < p.length - 1; i++) {
      const ax = p[i].x - p[i - 1].x;
      const ay = p[i].y - p[i - 1].y;
      const bx = p[i + 1].x - p[i].x;
      const by = p[i + 1].y - p[i].y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6 || (ax * bx + ay * by) / (la * lb) < 0.35) {
        p.splice(i, 1);
        i--;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // even spacing again (~0.25)
  const out: V2[] = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

export function buildRoadNet(inp: NetInput): RoadNet {
  const { w: W, h: H } = inp;
  const lines: NetLine[] = [];
  const edgeP = (p: V2) => p.x < 1.6 || p.y < 1.6 || p.x > W - 1.6 || p.y > H - 1.6;
  const add = (raw: V2[], lane: number, half: number, paved: boolean, painted: boolean, bridge: number, variant = 1, lot = -1) => {
    if (raw.length < 2) return;
    const pts = unspike(raw);
    const cum = cumulative(pts);
    const len = cum[cum.length - 1];
    if (len < 1.5) return;
    let bx0 = 1e9;
    let by0 = 1e9;
    let bx1 = -1e9;
    let by1 = -1e9;
    for (const p of pts) {
      bx0 = Math.min(bx0, p.x);
      by0 = Math.min(by0, p.y);
      bx1 = Math.max(bx1, p.x);
      by1 = Math.max(by1, p.y);
    }
    lines.push({
      pts,
      cum,
      len,
      lane,
      half,
      paved,
      painted,
      variant,
      lot,
      bridge,
      portal: [edgeP(pts[0]), edgeP(pts[pts.length - 1])],
      stops: [],
      limit: new Float32Array(pts.length).fill(1),
      a0: 0,
      a1: len,
      bx0: bx0 - half,
      by0: by0 - half,
      bx1: bx1 + half,
      by1: by1 + half,
    });
  };
  for (const r of inp.roads) {
    if (r.ring) continue; // turning-circle rings drawn as road pieces: not lanes
    const painted = !!r.painted;
    // city avenues: two lanes a side, cars keep to the right one; streets: one lane a side
    const lane = r.lot !== undefined ? 0.13 : painted ? (r.variant === 0 ? 0.9 : 0.6) : r.width * (r.variant === 0 ? 0.24 : 0.22);
    add(r.pts, lane, painted ? 1.22 : r.width / 2, true, painted, -1, r.variant, r.lot ?? -1);
  }
  // the city's "tracks" are park footpaths: no cars there
  if (!inp.urban)
    for (const t of inp.tracks) {
      if (t.ring) continue;
      let run: V2[] = [];
      for (const p of t.pts) {
        if (inp.clip?.(p.x, p.y)) {
          add(run, 0.06, t.width / 2, false, false, -1);
          run = [];
        } else run.push(p);
      }
      add(run, 0.06, t.width / 2, false, false, -1);
    }
  // bridge decks join the road ends on either bank
  inp.bridges.forEach((b, bi) => {
    const a = b.ends[0];
    const c = b.ends[1];
    const near = (p: V2) =>
      lines.find((L) => L.bridge < 0 && L.paved && (Math.hypot(L.pts[0].x - p.x, L.pts[0].y - p.y) < 2.4 || Math.hypot(L.pts[L.pts.length - 1].x - p.x, L.pts[L.pts.length - 1].y - p.y) < 2.4));
    const la = near(a);
    const lc = near(c);
    if (!la || !lc) return;
    const pts: V2[] = [];
    const n = Math.max(2, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.25));
    for (let i = 0; i <= n; i++) pts.push({ x: a.x + ((c.x - a.x) * i) / n, y: a.y + ((c.y - a.y) * i) / n });
    add(pts, la.lane, Math.max(la.half, 0.5), true, la.painted, bi, la.variant);
  });
  const nL = lines.length;

  // ---- junction candidates: endpoint onto a line, line across line, dead ends
  const cands: Cand[] = [];
  for (let ai = 0; ai < nL; ai++) {
    const A = lines[ai];
    for (let e = 0; e < 2; e++) {
      if (A.portal[e]) continue;
      const P = e ? A.pts[A.pts.length - 1] : A.pts[0];
      const endArc = e ? A.len : 0;
      let linked = false;
      // a parking lot's aisle ends in the lot (nothing joins it there)
      if (A.lot >= 0 && e === 1) {
        cands.push({ x: P.x, y: P.y, prio: 0, ep: ai * 2 + e, cs: [{ line: ai, arc: endArc }] });
        continue;
      }
      for (let bi = 0; bi < nL; bi++) {
        if (bi === ai) continue;
        const B = lines[bi];
        if (B.lot >= 0 && A.lot < 0) continue; // (other ends don't join an access lane)
        const thr = A.bridge >= 0 || B.bridge >= 0 ? 2.4 : 1.3;
        if (P.x < B.bx0 - thr || P.x > B.bx1 + thr || P.y < B.by0 - thr || P.y > B.by1 + thr) continue;
        const { arc, d } = nearestArc(B, P.x, P.y);
        if (d > thr) continue;
        linked = true;
        const mid = arc > 0.7 && arc < B.len - 0.7;
        const q = pointAt(B, arc);
        cands.push({ x: mid ? q.x : P.x, y: mid ? q.y : P.y, prio: mid ? 1 : 0, ep: ai * 2 + e, cs: [{ line: ai, arc: endArc }, { line: bi, arc: mid ? arc : arc < 0.7 ? 0 : B.len }] });
      }
      if (!linked) cands.push({ x: P.x, y: P.y, prio: 0, ep: ai * 2 + e, cs: [{ line: ai, arc: endArc }] });
    }
  }
  // line across line: segment intersections via a coarse spatial hash
  {
    const CS = 2;
    const GW = Math.ceil(W / CS) + 2;
    const grid = new Map<number, number[]>();
    const key = (x: number, y: number) => (Math.floor(y / CS) + 1) * GW + Math.floor(x / CS) + 1;
    lines.forEach((L, li) => {
      if (L.bridge >= 0) return;
      for (let i = 0; i < L.pts.length - 1; i++) {
        const a = L.pts[i];
        const b = L.pts[i + 1];
        const keys = new Set([key(a.x, a.y), key(b.x, b.y)]);
        for (const k of keys) {
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push(li, i);
        }
      }
    });
    const seen = new Set<string>();
    for (const arr of grid.values()) {
      for (let p = 0; p < arr.length; p += 2)
        for (let q = p + 2; q < arr.length; q += 2) {
          const la = arr[p];
          const lb = arr[q];
          if (la === lb || lines[la].lot >= 0 || lines[lb].lot >= 0) continue;
          const A = lines[la];
          const B = lines[lb];
          const i = arr[p + 1];
          const j = arr[q + 1];
          const a0 = A.pts[i];
          const a1 = A.pts[i + 1];
          const b0 = B.pts[j];
          const b1 = B.pts[j + 1];
          const rx = a1.x - a0.x;
          const ry = a1.y - a0.y;
          const sx = b1.x - b0.x;
          const sy = b1.y - b0.y;
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((b0.x - a0.x) * sy - (b0.y - a0.y) * sx) / den;
          const u = ((b0.x - a0.x) * ry - (b0.y - a0.y) * rx) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          // shallow crossings of two roads sharing a corridor are no junction
          if (Math.abs(den) / (Math.hypot(rx, ry) * Math.hypot(sx, sy)) < 0.42) continue;
          const arcA = A.cum[i] + t * (A.cum[i + 1] - A.cum[i]);
          const arcB = B.cum[j] + u * (B.cum[j + 1] - B.cum[j]);
          // near an end: the endpoint links cover it
          if (arcA < 0.7 || arcA > A.len - 0.7 || arcB < 0.7 || arcB > B.len - 0.7) continue;
          const id = `${Math.min(la, lb)}:${Math.max(la, lb)}:${Math.round(arcA * 2)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          cands.push({ x: a0.x + rx * t, y: a0.y + ry * t, prio: 2, ep: -1, cs: [{ line: la, arc: arcA }, { line: lb, arc: arcB }] });
        }
    }
  }
  // cluster candidates closer than 1.6 tiles (union-find)
  const par = cands.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++) if (Math.hypot(cands[i].x - cands[j].x, cands[i].y - cands[j].y) < 1.6 || (cands[i].ep >= 0 && cands[i].ep === cands[j].ep)) par[find(i)] = find(j);
  // roads tangled in a corridor (crossing each other again a few tiles on): one junction
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < cands.length; i++)
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i];
        const b = cands[j];
        if (inp.urban || find(i) === find(j) || a.prio !== 2 || b.prio !== 2 || Math.hypot(a.x - b.x, a.y - b.y) > 3.4) continue;
        let shared = 0;
        for (const p of a.cs) if (b.cs.some((q) => q.line === p.line)) shared++;
        if (shared >= 1) par[find(i)] = find(j);
      }
  const groups = new Map<number, Cand[]>();
  cands.forEach((c, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(c);
  });

  // ---- nodes and arms
  const nodes: NetNode[] = [];
  const armAng = (L: NetLine, arc: number, dir: number) => {
    const p = pointAt(L, arc);
    const px = p.x;
    const py = p.y;
    const q = pointAt(L, arc + dir * 1.2);
    return Math.atan2(q.y - py, q.x - px);
  };
  for (const g of groups.values()) {
    const top = Math.max(...g.map((c) => c.prio));
    const at = g.filter((c) => c.prio === top);
    const x = at.reduce((s, c) => s + c.x, 0) / at.length;
    const y = at.reduce((s, c) => s + c.y, 0) / at.length;
    const perLine = new Map<number, number[]>();
    for (const c of g)
      for (const k of c.cs) {
        let a = perLine.get(k.line);
        if (!a) perLine.set(k.line, (a = []));
        a.push(k.arc);
      }
    const arms: Arm[] = [];
    for (const [li, arcs] of perLine) {
      const L = lines[li];
      // the arc nearest the node centre
      let arc = arcs[0];
      let bd = 1e9;
      for (const a of arcs) {
        const p = pointAt(L, a);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) {
          bd = d;
          arc = a;
        }
      }
      const mk = (arcv: number, dir: number): Arm => ({ line: li, arc: arcv, dir, ang: armAng(L, arcv, dir), axis: 0, major: false, hold: arcv, edge: arcv, inAng: 0, outAng: 0 });
      // a line overshooting the junction a little (crosses, then ends just past it): the stub is no road
      const mid = arc > 0.7 && arc < L.len - 0.7;
      const nearEnd = arcs.find((a) => a < 0.7 || a > L.len - 0.7);
      if (mid && nearEnd !== undefined && Math.abs(nearEnd - arc) < 2.6) {
        if (nearEnd < 0.7) {
          arms.push(mk(arc, 1));
          L.a0 = Math.max(L.a0, arc + 0.3);
        } else {
          arms.push(mk(arc, -1));
          L.a1 = Math.min(L.a1, arc - 0.3);
        }
        continue;
      }
      if (arc < 0.7) arms.push(mk(0, 1));
      else if (arc > L.len - 0.7) arms.push(mk(L.len, -1));
      else arms.push(mk(arc, 1), mk(arc, -1));
    }
    if (arms.length === 2 && arms[0].line === arms[1].line) continue; // a line passing a node that lost its partner
    nodes.push({ x, y, arms, ctl: Ctl.Free, loop: -1, signal: -1, village: false, majorLines: [], lot: -1 });
  }

  // ---- villages (structures close by)
  const village = (x: number, y: number, r: number) => {
    let n = 0;
    for (const s of inp.structures) if (Math.hypot(s.x + s.w / 2 - x, s.y + s.h / 2 - y) < r) n++;
    return n;
  };

  // ---- classification
  const loops: Loop[] = [];
  const signals: Signal[] = [];
  const marks: Mark[] = [];
  const props: Prop[] = [];
  const nearOtherLine = (cx: number, cy: number, R: number, skip: (li: number) => boolean) => {
    for (let li = 0; li < nL; li++) {
      if (skip(li)) continue;
      const L = lines[li];
      const m = R + L.half + 0.15;
      if (cx < L.bx0 - m || cx > L.bx1 + m || cy < L.by0 - m || cy > L.by1 + m) continue;
      if (nearestArc(L, cx, cy).d < m) return true;
    }
    return false;
  };
  const discFree = (cx: number, cy: number, R: number) => {
    if (cx - R < 0.7 || cy - R < 0.7 || cx + R > W - 0.7 || cy + R > H - 0.7) return false;
    if (inp.hard(Math.floor(cx), Math.floor(cy))) return false;
    for (const [f, n] of [
      [1, 22],
      [0.7, 16],
      [0.4, 10],
    ] as const) {
      const r = (R + 0.12) * f;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        if (inp.hard(Math.floor(cx + Math.cos(a) * r), Math.floor(cy + Math.sin(a) * r))) return false;
      }
    }
    return true;
  };
  const clearOfNodes = (cx: number, cy: number, R: number, self: number) => {
    for (let j = 0; j < nodes.length; j++) {
      if (j === self) continue;
      const n = nodes[j];
      const lp = n.loop >= 0 ? loops[n.loop] : null;
      if (n.arms.length && Math.hypot(n.x - cx, n.y - cy) < R + (lp ? lp.R + 2 : 1.2)) return false;
    }
    // two turning circles never come closer than ~2 tiles ring to ring (close dead ends share one instead)
    for (const lp of loops) if (Math.hypot(lp.x - cx, lp.y - cy) < R + lp.R + 2) return false;
    return true;
  };
  /** Arc where line `L` (from `arc`, moving `dir`) leaves the circle; -1 if it ends inside. */
  const edgeArc = (L: NetLine, arc: number, dir: number, cx: number, cy: number, R: number) => {
    for (let s = 0; s <= R * 3 + 1; s += 0.05) {
      const a = arc + dir * s;
      if (a < 0 || a > L.len) return -1;
      const p = pointAt(L, a);
      if (Math.hypot(p.x - cx, p.y - cy) >= R) return a;
    }
    return -1;
  };
  const laneAng = (L: NetLine, arc: number, travel: number, cx: number, cy: number) => {
    const p = pointAt(L, arc);
    const x = p.x - p.ty * travel * L.lane;
    const y = p.y + p.tx * travel * L.lane;
    return Math.atan2(y - cy, x - cx);
  };
  /** Try to set node `ni` up as a roundabout / turning place centred at (cx, cy). */
  const makeLoop = (ni: number, cx: number, cy: number, R: number, paved: boolean, dead: boolean, from = -1): boolean => {
    const n = nodes[ni];
    const own = new Set(n.arms.map((a) => a.line));
    const why = (r: string) => {
      inp.debug?.push(`node ${ni} R ${R.toFixed(2)} at ${cx.toFixed(1)},${cy.toFixed(1)}: ${r}`);
      return false;
    };
    if (!discFree(cx, cy, R)) return why('hard');
    if (!clearOfNodes(cx, cy, R, ni)) return why('nodes');
    if (nearOtherLine(cx, cy, R, (li) => own.has(li))) return why('line');
    const edges: number[] = [];
    for (const a of n.arms) {
      const L = lines[a.line];
      const a0 = from >= 0 ? from : a.arc;
      // the arm must start inside the circle
      const p0 = pointAt(L, a0);
      if (Math.hypot(p0.x - cx, p0.y - cy) > R - 0.25) return why('outside');
      const e = edgeArc(L, a0, a.dir, cx, cy, R);
      if (e < 0) return why('edge');
      // keep a usable approach beyond the edge (unless it runs off the map edge)
      const rest = a.dir > 0 ? L.len - e : e;
      if (rest < 0.8 && !L.portal[a.dir > 0 ? 1 : 0]) return why('short');
      edges.push(e);
    }
    // arms must reach the circle at distinct places
    for (let i = 0; i < n.arms.length; i++)
      for (let j = i + 1; j < n.arms.length; j++) {
        const pi = pointAt(lines[n.arms[i].line], edges[i]);
        const ax = pi.x;
        const ay = pi.y;
        const pj = pointAt(lines[n.arms[j].line], edges[j]);
        const sep = Math.abs(wrapPi(Math.atan2(ay - cy, ax - cx) - Math.atan2(pj.y - cy, pj.x - cx)));
        // roads sharing a corridor reach the circle together: fine, they merge there
        const same = Math.hypot(ax - pj.x, ay - pj.y) < 0.6 && Math.abs(wrapPi(n.arms[i].ang - n.arms[j].ang)) < 0.5;
        if (sep < 0.7 && !same) return why('arms');
      }
    const ri = paved ? R * 0.42 : 0;
    const rl = paved ? (ri + R) / 2 + 0.02 : R * 0.55;
    const li = loops.length;
    loops.push({ x: cx, y: cy, R, ri, rl, paved, node: ni, dead });
    n.ctl = Ctl.Loop;
    n.loop = li;
    n.arms.forEach((a, k) => {
      const L = lines[a.line];
      a.edge = edges[k];
      a.hold = edges[k] + a.dir * 0.32;
      a.inAng = laneAng(L, a.edge, -a.dir, cx, cy);
      a.outAng = laneAng(L, a.edge, a.dir, cx, cy);
      if (paved) {
        // give-way line across the inbound half, where the arm meets the circle
        const p = pointAt(L, a.edge + a.dir * 0.06);
        const tx = p.tx * -a.dir;
        const ty = p.ty * -a.dir;
        const hw = L.painted ? 1.1 : L.half * 0.92;
        marks.push({ kind: MarkKind.Teeth, x: p.x - ty * hw * 0.5, y: p.y + tx * hw * 0.5, ang: Math.atan2(ty, tx), len: 0.13, wid: hw });
        // a give-way sign on the right of the approach
        const s = pointAt(L, a.edge + a.dir * 0.25);
        props.push({ kind: PropKind.GiveWay, x: s.x - ty * (L.half + 0.22), y: s.y + tx * (L.half + 0.22), yaw: Math.atan2(-ty, -tx), ref: ni, axis: 0, size: 1 });
      }
    });
    marks.push({ kind: paved ? MarkKind.Disc : MarkKind.Gravel, x: cx, y: cy, ang: 0, len: R, wid: R });
    if (paved) props.push({ kind: PropKind.Island, x: cx, y: cy, yaw: 0, ref: li, axis: 0, size: ri });
    return true;
  };

  nodes.forEach((n, ni) => {
    n.village = inp.urban || village(n.x, n.y, 6.5) >= 3;
    const arms = n.arms;
    if (arms.length === 1) {
      // dead end: a turning place (slid back along the road until it fits)
      const a = arms[0];
      const L = lines[a.line];
      if (L.lot >= 0) {
        // a parking lot's aisle
        n.ctl = Ctl.Lot;
        n.lot = L.lot;
        return;
      }
      const paved = L.paved;
      const R0 = paved ? (L.painted ? 1.42 : 1.55) : 0.95;
      // don't slide past another junction on this line
      let room = L.len;
      nodes.forEach((o, oi) => {
        if (oi === ni) return;
        for (const b of o.arms) if (b.line === a.line) room = Math.min(room, Math.abs(b.arc - a.arc));
      });
      const tried: number[] = [];
      for (let t = 0; t <= 7; t += 0.25) tried.push(t);
      tried.push(-0.25, -0.5, -0.75);
      for (const sc of paved ? [1, 0.9, 0.8] : [1, 0.85]) {
        const R = R0 * sc;
        for (const t of tried) {
          const s = R - 0.3 + t;
          if (s < 0 || s + R > L.len - 0.8 || s + R > room - 1.2) continue;
          const p = pointAt(L, a.arc + a.dir * s);
          if (makeLoop(ni, p.x, p.y, R, paved, true, a.arc + a.dir * s)) {
            if (a.dir > 0) L.a0 = Math.max(L.a0, a.edge + 0.3);
            else L.a1 = Math.min(L.a1, a.edge - 0.3);
            return;
          }
        }
      }
      n.ctl = Ctl.Turn;
      return;
    }
    if (arms.length === 2) return; // continuation
    const paved = arms.filter((a) => lines[a.line].paved).length;
    const painted = arms.some((a) => lines[a.line].painted);
    // countryside: a roundabout where paved roads meet
    if (!painted && !n.village && paved >= 3 && paved === arms.length) {
      for (const R of arms.length > 4 ? [2.4, 2.1, 1.9] : [1.9, 1.7]) if (makeLoop(ni, n.x, n.y, R, true, false)) return;
    }
    // priority: the straightest pair of the best ranked arms
    const rank = (a: Arm) => {
      const L = lines[a.line];
      const through = arms.filter((b) => b.line === a.line).length > 1;
      return (L.paved ? 2 : 0) + (through ? 1 : 0) + (L.painted ? 0 : L.half * 0.4);
    };
    let bi = 0;
    let bj = 1;
    let bs = -1e9;
    for (let i = 0; i < arms.length; i++)
      for (let j = i + 1; j < arms.length; j++) {
        const s = rank(arms[i]) + rank(arms[j]) - Math.cos(arms[i].ang - arms[j].ang) * 1.5;
        if (s > bs) {
          bs = s;
          bi = i;
          bj = j;
        }
      }
    arms[bi].major = arms[bj].major = true;
    n.majorLines = [...new Set([arms[bi].line, arms[bj].line])];
    // widest crossing road (sets how far back the cars wait)
    const crossHalf = (a: Arm) => {
      let m = 0.3;
      for (const b of arms) if (b.line !== a.line) m = Math.max(m, lines[b.line].half);
      return m;
    };
    const signalled = (painted && arms.length >= 4) || (!painted && n.village && paved >= 3);
    if (signalled) {
      const si = signals.length;
      // green waves don't matter here: hashed cycle offsets
      const hsh = Math.sin(n.x * 12.9898 + n.y * 78.233) * 43758.5453;
      signals.push({ node: ni, x: n.x, y: n.y, offset: (hsh - Math.floor(hsh)) * SIGNAL_CYCLE, mode: SigMode.Normal });
      n.ctl = Ctl.Signal;
      n.signal = si;
      const ref = arms[bi].ang;
      for (const a of arms) {
        const L = lines[a.line];
        a.axis = Math.abs(Math.cos(a.ang - ref)) > 0.69 ? 0 : 1;
        const ch = crossHalf(a);
        // city crossings already have zebras painted (0.95 .. 1.42 from the centre)
        const zebra0 = painted ? 0.95 : ch + 0.1;
        const zebra1 = painted ? 1.42 : ch + 0.42;
        const stopD = zebra1 + 0.12;
        const room = a.dir > 0 ? L.len - a.arc : a.arc;
        if (room < stopD + 0.6) continue;
        a.hold = a.arc + a.dir * (stopD + 0.3);
        const p = pointAt(L, a.arc + a.dir * stopD);
        const tx = p.tx * -a.dir;
        const ty = p.ty * -a.dir;
        const hw = L.painted ? 1.15 : L.half * 0.95;
        // stop line across the inbound half
        marks.push({ kind: MarkKind.Bar, x: p.x - ty * hw * 0.5, y: p.y + tx * hw * 0.5, ang: Math.atan2(ty, tx), len: L.painted ? 0.09 : 0.07, wid: hw });
        if (!painted) {
          const z = pointAt(L, a.arc + (a.dir * (zebra0 + zebra1)) / 2);
          marks.push({ kind: MarkKind.Zebra, x: z.x, y: z.y, ang: Math.atan2(z.ty, z.tx), len: zebra1 - zebra0, wid: L.half * 1.9 });
        }
        // the signal pole on the right of the approach, at the stop line
        const sx = p.x - ty * (L.half + 0.22);
        const sy = p.y + tx * (L.half + 0.22);
        props.push({ kind: PropKind.Light, x: sx, y: sy, yaw: Math.atan2(-ty, -tx), ref: si, axis: a.axis, size: 1 });
      }
      return;
    }
    // unsignalled: the minor arms give way (paved: give-way sign + line; tracks: stop sign)
    n.ctl = Ctl.Yield;
    for (const a of arms) {
      if (a.major) continue;
      const L = lines[a.line];
      const ch = crossHalf(a);
      const room = a.dir > 0 ? L.len - a.arc : a.arc;
      const d = Math.min(ch + 0.18, Math.max(0, room - 0.6));
      a.hold = a.arc + a.dir * (d + 0.3);
      const p = pointAt(L, a.arc + a.dir * d);
      const tx = p.tx * -a.dir;
      const ty = p.ty * -a.dir;
      if (L.paved) {
        const hw = L.painted ? 1.1 : L.half * 0.92;
        marks.push({ kind: MarkKind.Teeth, x: p.x - ty * hw * 0.5, y: p.y + tx * hw * 0.5, ang: Math.atan2(ty, tx), len: 0.13, wid: hw });
      }
      props.push({ kind: L.paved ? PropKind.GiveWay : PropKind.StopSign, x: p.x - ty * (L.half + 0.22), y: p.y + tx * (L.half + 0.22), yaw: Math.atan2(-ty, -tx), ref: ni, axis: 0, size: 1 });
    }
  });

  // ---- stops per line
  nodes.forEach((n, ni) =>
    n.arms.forEach((a, k) => {
      const at = n.ctl === Ctl.Loop ? a.edge : a.arc;
      lines[a.line].stops.push({ node: ni, arm: k, arc: at, dir: -a.dir, hold: a.hold });
    }),
  );
  for (const L of lines) L.stops.sort((p, q) => p.arc - q.arc);

  // ---- speed limits: villages and the city slower, open roads faster
  {
    for (const L of lines) {
      const raw = new Float32Array(L.pts.length);
      for (let i = 0; i < L.pts.length; i++) {
        const p = L.pts[i];
        if (L.lot >= 0) raw[i] = 0.35;
        else if (L.painted) raw[i] = 0.8;
        else if (village(p.x, p.y, 4.5) >= 2) raw[i] = 0.72;
        else raw[i] = L.paved ? 1.12 : 1;
      }
      // smooth over ~2 tiles so cars ease into the zones
      for (let i = 0; i < L.pts.length; i++) {
        let s = 0;
        let c = 0;
        for (let k = Math.max(0, i - 8); k <= Math.min(L.pts.length - 1, i + 8); k++) {
          s += raw[k];
          c++;
        }
        L.limit[i] = s / c;
      }
    }
  }

  // ---- drivable surface raster
  const res = 4;
  const SW = W * res;
  const SH = H * res;
  const surface = new Uint8Array(SW * SH);
  const disc = (cx: number, cy: number, r: number, val: number) => {
    const x0 = Math.max(0, Math.floor((cx - r) * res));
    const x1 = Math.min(SW - 1, Math.ceil((cx + r) * res));
    const y0 = Math.max(0, Math.floor((cy - r) * res));
    const y1 = Math.min(SH - 1, Math.ceil((cy + r) * res));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (Math.hypot((x + 0.5) / res - cx, (y + 0.5) / res - cy) <= r) surface[y * SW + x] = val;
  };
  for (const L of lines) {
    const r = L.half;
    for (let i = 0; i < L.pts.length - 1; i++) {
      const a = L.pts[i];
      const b = L.pts[i + 1];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r) * res));
      const x1 = Math.min(SW - 1, Math.ceil((Math.max(a.x, b.x) + r) * res));
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r) * res));
      const y1 = Math.min(SH - 1, Math.ceil((Math.max(a.y, b.y) + r) * res));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = (x + 0.5) / res;
          const py = (y + 0.5) / res;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l2 = dx * dx + dy * dy || 1e-9;
          let t = ((px - a.x) * dx + (py - a.y) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(px - a.x - dx * t, py - a.y - dy * t) <= r) surface[y * SW + x] = 1;
        }
    }
  }
  const links: RoadNet['links'] = [];
  const capsule = (ax: number, ay: number, bx: number, by: number, r: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1));
    for (let k = 0; k <= n; k++) disc(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, r, 1);
  };
  for (const n of nodes) {
    if (n.ctl === Ctl.Loop || n.arms.length < 2) continue;
    let m = 0;
    for (const a of n.arms) m = Math.max(m, lines[a.line].half);
    disc(n.x, n.y, m + 0.22, 1);
    // a road / track that stops short of the road it joins: pave / gravel the gap
    for (const a of n.arms) {
      const L = lines[a.line];
      if (a.arc > 0.01 && a.arc < L.len - 0.01) continue;
      const p = L.pts[a.arc < 0.01 ? 0 : L.pts.length - 1];
      // to where the cars hop onto the other line
      let qx = n.x;
      let qy = n.y;
      let d = 1e9;
      for (const b of n.arms) {
        if (b.line === a.line) continue;
        const q = pointAt(lines[b.line], b.arc);
        const e = Math.hypot(q.x - p.x, q.y - p.y);
        if (e < d) {
          d = e;
          qx = q.x;
          qy = q.y;
        }
      }
      if (d < 0.2 || d > 3) continue;
      capsule(p.x, p.y, qx, qy, L.half);
      let jh = 0.3;
      for (const b of n.arms) if (b.line !== a.line) jh = Math.max(jh, lines[b.line].half);
      links.push({ x0: p.x, y0: p.y, x1: qx, y1: qy, half: L.half, paved: L.paved, variant: L.variant, joinHalf: jh });
    }
  }
  for (const lp of loops) disc(lp.x, lp.y, lp.R, 1);
  for (const lp of loops) if (lp.ri > 0) disc(lp.x, lp.y, lp.ri, 0);

  return { w: W, h: H, lines, nodes, loops, signals, marks, links, props, surface, res, lots: [], boards: [] };
}

/** Is (x, y) on the drivable surface (road, track, turning place, junction)? */
export function onSurface(net: RoadNet, x: number, y: number): boolean {
  const ix = Math.floor(x * net.res);
  const iy = Math.floor(y * net.res);
  if (ix < 0 || iy < 0 || ix >= net.w * net.res || iy >= net.h * net.res) return false;
  return net.surface[iy * net.w * net.res + ix] === 1;
}

/** Speed limit factor at arc `a` of line `L`. */
export function limitAt(L: NetLine, a: number): number {
  return L.limit[Math.min(L.limit.length - 1, segAt(L, a))];
}
