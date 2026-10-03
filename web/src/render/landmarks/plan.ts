import { Tile, WATER_LEVEL, type GameMap } from '../../sim/map';
import { roadClear } from '../ambient/clearance';
import { surfaceHeight } from '../ground';

/*
 * Where every map's set pieces go: unique landmarks, the railway lines, the
 * outskirts lanes they cross, and spots handed to other systems (camels).
 * A pure, deterministic function of the map (memoised): nothing here touches
 * the simulation, and nothing is placed on tiles the sim cares about.
 *
 * Placement rules:
 *  - most set pieces stand in the outskirts (beyond the map edge), on the
 *    far sides of the default view (west / north) when they are tall, so
 *    they read as a skyline and never hide units;
 *  - inside the playable area only on impassable ground: a castle ruin on a
 *    rock ridge, a fort on a mesa top, a radio mast on a ridge, pylons in the
 *    canal next to a bridge deck. Units never drive through them;
 *  - the railways run in the outskirts, 1.7 tiles past the edge, so trains
 *    never meet a unit; on Frontline Crossing the highway leaves the map
 *    through a level crossing right at the edge (cars wait at its barriers).
 *
 * Coordinates are continuous tile space (x right, y down); "yaw" is the
 * tile-space heading of a model's local +X.
 */

export interface P2 {
  x: number;
  y: number;
}

export type SpotKind =
  | 'turbine'
  | 'castle'
  | 'church'
  | 'watertower'
  | 'cottage'
  | 'station'
  | 'mosque'
  | 'souk'
  | 'mudhouse'
  | 'palm'
  | 'pond'
  | 'fort'
  | 'refinery'
  | 'mast'
  | 'factory'
  | 'lake'
  | 'icehut'
  | 'skimountain'
  | 'liftstation'
  | 'stadium'
  | 'tower'
  | 'fuel'
  | 'hospital'
  | 'crane'
  | 'containers'
  | 'suspension';

export interface Spot {
  kind: SpotKind;
  x: number;
  y: number;
  yaw: number;
  /** Scale (most models 1). */
  s: number;
  /** Clearance radius (outskirts trees / city blocks keep off). */
  r: number;
  /** Variant 0..1. */
  v: number;
  /** Stands inside the playable area (destructible by blasts). */
  inMap?: boolean;
  /** Extra numbers (tower size, lake radii, lift end, bridge index...). */
  a?: number;
  b?: number;
  c?: number;
}

export interface RailCrossing {
  x: number;
  y: number;
  /** Arc along the rail line. */
  arc: number;
  /** Heading of the road through it (tile space). */
  roadAng: number;
  /** The crossing sits on a road the civilian traffic drives (Frontline's highway). */
  traffic: boolean;
}

export interface RailPlan {
  /** Dense centreline (0.5 spacing). */
  pts: P2[];
  /** Cumulative arc length per point. */
  cum: number[];
  len: number;
  /** Deck height above the ground (0 = on ballast; urban: a viaduct). */
  elevated: number;
  crossings: RailCrossing[];
  /** Station platform: arc range and the side of the track it lies on (+1 = left of travel). */
  station: { a0: number; a1: number; side: number } | null;
  /** Trains on this line: 'country' (passenger + freight, diesel / electric), 'metro' (short EMUs). */
  service: 'country' | 'metro';
  /** Catenary masts along the line (electrified). */
  wired: boolean;
}

export interface LandmarkPlan {
  spots: Spot[];
  rails: RailPlan[];
  /** Outskirts lanes (render only: a road running on past the edge, a works lane). Width per lane. */
  lanes: { pts: P2[]; width: number }[];
  /** Extra clearings (outskirts trees / city blocks keep off): the canal running on past the edge. */
  clears?: { x: number; y: number; r: number }[];
  /** Camel resting / grazing spots (desert; for the animals system). */
  camels: P2[];
}

const plans = new WeakMap<GameMap, LandmarkPlan>();

/** The map's landmark plan (memoised; deterministic). */
export function landmarkPlan(m: GameMap): LandmarkPlan {
  let p = plans.get(m);
  if (!p) plans.set(m, (p = buildPlan(m)));
  return p;
}

/** Spots for camels (desert): near the oases inside the map and by the palm grove outside it. */
export function camelSpots(m: GameMap): P2[] {
  return landmarkPlan(m).camels;
}

// ------------------------------------------------------------------ clearance mask

interface Mask {
  data: Uint8Array;
  x0: number;
  y0: number;
  w: number;
  h: number;
}
const masks = new WeakMap<GameMap, Mask>();
const MASK_MARGIN = 90;

function maskFor(m: GameMap): Mask {
  let mk = masks.get(m);
  if (mk) return mk;
  const plan = landmarkPlan(m);
  const x0 = -MASK_MARGIN;
  const y0 = -MASK_MARGIN;
  const w = m.w + MASK_MARGIN * 2;
  const h = m.h + MASK_MARGIN * 2;
  const data = new Uint8Array(w * h);
  const disc = (cx: number, cy: number, r: number) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const ix = x - x0;
        const iy = y - y0;
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 0.71) data[iy * w + ix] = 1;
      }
  };
  for (const s of plan.spots) if (!s.inMap) disc(s.x, s.y, s.r);
  for (const c of plan.clears ?? []) disc(c.x, c.y, c.r);
  for (const r of plan.rails) for (let i = 0; i < r.pts.length; i += 2) disc(r.pts[i].x, r.pts[i].y, r.elevated ? 1.4 : 1.6);
  for (const l of plan.lanes) for (const p of l.pts) disc(p.x, p.y, l.width / 2 + 0.6);
  mk = { data, x0, y0, w, h };
  masks.set(m, mk);
  return mk;
}

/** Is (x, y) within `pad` of a landmark site, railway or outskirts lane (outskirts trees / city blocks keep off)? */
export function landmarkClear(m: GameMap, x: number, y: number, pad = 0): boolean {
  const mk = maskFor(m);
  const at = (px: number, py: number) => {
    const ix = Math.floor(px) - mk.x0;
    const iy = Math.floor(py) - mk.y0;
    return ix >= 0 && iy >= 0 && ix < mk.w && iy < mk.h && mk.data[iy * mk.w + ix] === 1;
  };
  if (at(x, y)) return true;
  if (pad > 0) for (const [dx, dy] of [[pad, 0], [-pad, 0], [0, pad], [0, -pad]]) if (at(x + dx, y + dy)) return true;
  return false;
}

// ------------------------------------------------------------------ helpers

/** Chaikin smoothing then an even resample (spacing `step`). */
export function smoothPath(via: P2[], iterations = 4, step = 0.5): P2[] {
  let p = via;
  for (let it = 0; it < iterations; it++) {
    const out: P2[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  const res: P2[] = [p[0]];
  let carry = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let t = step - carry;
    while (t <= L) {
      res.push({ x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L });
      t += step;
    }
    carry = L - (t - step);
  }
  const last = p[p.length - 1];
  if (Math.hypot(res[res.length - 1].x - last.x, res[res.length - 1].y - last.y) > step * 0.3) res.push(last);
  return res;
}

function cumulative(pts: P2[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return c;
}

/** Arc of the point of `pts` nearest (x, y). */
export function arcNear(pts: P2[], cum: number[], x: number, y: number): number {
  let best = 1e9;
  let arc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
    if (d < best) {
      best = d;
      arc = cum[i] + t * Math.sqrt(l2);
    }
  }
  return arc;
}

function rail(via: P2[], o: Partial<RailPlan> & { crossAt?: { x: number; y: number; roadAng: number; traffic: boolean }[]; stationAt?: { x: number; y0: number; y1: number; side: number }; stationX?: { y: number; x0: number; x1: number; side: number } }): RailPlan {
  const pts = smoothPath(via, 4, 0.5);
  const cum = cumulative(pts);
  const len = cum[cum.length - 1];
  const crossings = (o.crossAt ?? []).map((c) => {
    const arc = arcNear(pts, cum, c.x, c.y);
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(arc / 0.5)));
    return { x: pts[i].x, y: pts[i].y, arc, roadAng: c.roadAng, traffic: c.traffic };
  });
  let station: RailPlan['station'] = null;
  const st = o.stationAt;
  if (st) {
    const a0 = arcNear(pts, cum, st.x, st.y0);
    const a1 = arcNear(pts, cum, st.x, st.y1);
    station = { a0: Math.min(a0, a1), a1: Math.max(a0, a1), side: st.side };
  }
  const sx = o.stationX;
  if (sx) {
    const a0 = arcNear(pts, cum, sx.x0, sx.y);
    const a1 = arcNear(pts, cum, sx.x1, sx.y);
    station = { a0: Math.min(a0, a1), a1: Math.max(a0, a1), side: sx.side };
  }
  return { pts, cum, len, elevated: o.elevated ?? 0, crossings, station, service: o.service ?? 'country', wired: o.wired ?? true };
}

const spot = (kind: SpotKind, x: number, y: number, yaw = 0, r = 1.5, v = 0.5, extra: Partial<Spot> = {}): Spot => ({ kind, x, y, yaw, s: 1, r, v, ...extra });

/** A deterministic 0..1 hash. */
function hh(a: number, b: number, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ per map

function buildPlan(m: GameMap): LandmarkPlan {
  switch (m.id) {
    case 'frontline':
      return frontline(m);
    case 'desert':
      return desert(m);
    case 'winter':
      return winter(m);
    case 'urban':
      return urban(m);
    default:
      return { spots: [], rails: [], lanes: [], camels: [] };
  }
}

/** Rail x just past the west edge (and its mirror past the east edge). */
const RAIL_X = -1.7;

function frontline(m: GameMap): LandmarkPlan {
  const W = m.w;
  const H = m.h;
  const spots: Spot[] = [];
  // the highway leaves the map at (0, 71.5) / (96, 24.5): it runs on through a level crossing
  const hwyY = 71.5;
  const west = rail(
    [
      { x: -40, y: 140 },
      { x: -16, y: 114 },
      { x: -3.6, y: 97 },
      { x: RAIL_X, y: 84 },
      { x: RAIL_X, y: 14 },
      { x: -3.8, y: 1 },
      { x: -14, y: -14 },
      { x: -34, y: -42 },
    ],
    { crossAt: [{ x: RAIL_X, y: hwyY, roadAng: 0, traffic: true }], stationAt: { x: RAIL_X, y0: 52.5, y1: 60.5, side: -1 } },
  );
  const east = rail(
    [
      { x: W + 40, y: H - 140 },
      { x: W + 16, y: H - 114 },
      { x: W + 3.6, y: H - 97 },
      { x: W - RAIL_X, y: H - 84 },
      { x: W - RAIL_X, y: H - 14 },
      { x: W + 3.8, y: H - 1 },
      { x: W + 14, y: H + 14 },
      { x: W + 34, y: H + 42 },
    ],
    { crossAt: [{ x: W - RAIL_X, y: H - hwyY, roadAng: 0, traffic: true }] },
  );
  const lanes = [
    { pts: smoothPath([{ x: -0.05, y: hwyY }, { x: -9, y: hwyY }, { x: -18, y: hwyY + 2.5 }, { x: -30, y: hwyY + 8 }, { x: -46, y: hwyY + 10 }], 3, 0.5), width: 1.05 },
    { pts: smoothPath([{ x: W + 0.05, y: H - hwyY }, { x: W + 9, y: H - hwyY }, { x: W + 18, y: H - hwyY - 2.5 }, { x: W + 30, y: H - hwyY - 8 }, { x: W + 46, y: H - hwyY - 10 }], 3, 0.5), width: 1.05 },
    // the village street behind the station
    { pts: smoothPath([{ x: -9, y: hwyY }, { x: -6.4, y: 64 }, { x: -6.0, y: 54 }, { x: -6.8, y: 44 }], 3, 0.5), width: 0.7 },
  ];
  // the station village west of the line
  spots.push(spot('station', -3.75, 56.5, 0, 1.6));
  spots.push(spot('church', -9.6, 50.2, 0, 2.4));
  spots.push(spot('watertower', -9.0, 61.5, 0, 1.2));
  const houses: [number, number, number][] = [
    [-4.2, 46.5, Math.PI / 2],
    [-4.4, 63.6, Math.PI / 2],
    [-8.6, 66.8, 0],
    [-4.6, 67.8, Math.PI / 2],
    [-9.4, 45.0, Math.PI],
    [-12.6, 56.4, Math.PI / 2],
    [-12.0, 62.4, -Math.PI / 2],
    [-13.2, 47.6, 0],
    [-4.4, 41.6, Math.PI / 2],
  ];
  houses.forEach(([x, y, yaw], i) => spots.push(spot('cottage', x, y, yaw, 1.0, hh(i, 3, 11))));
  // the wind farm on the hills north of the map
  [[14, -10], [26, -13.5], [38, -9.5], [50, -14], [62, -10], [74, -13.5], [86, -9.5]].forEach(([x, y], i) => spots.push(spot('turbine', x, y, Math.PI / 2, 1.2, hh(i, 5, 12))));
  // the castle ruin on the rock ridge south-west of the centre bridge (impassable rock)
  spots.push(spot('castle', 42, 61, Math.atan2(58 - 64, 44 - 40), 0, 0.37, { inMap: true }));
  return { spots, rails: [west, east], lanes, camels: [] };
}

function desert(m: GameMap): LandmarkPlan {
  const spots: Spot[] = [];
  // the old town west of the map: a mosque, the souk street, houses and palms
  spots.push(spot('mosque', -9.4, 49.5, 0, 3.2));
  for (let i = 0; i < 6; i++) {
    spots.push(spot('souk', -7.0, 55.2 + i * 0.62, 0, 0.6, hh(i, 1, 21)));
    spots.push(spot('souk', -4.6, 55.4 + i * 0.62, Math.PI, 0.6, hh(i, 2, 21)));
  }
  const houses: [number, number][] = [[-12.8, 44.2], [-13.4, 55.4], [-12.4, 61.2], [-6.4, 43.2], [-9.6, 66.2], [-14.8, 50.2], [-5.2, 64.6], [-16.2, 58.8], [-8.4, 40.2]];
  houses.forEach(([x, y], i) => spots.push(spot('mudhouse', x, y, (Math.round(hh(i, 4, 21) * 4) * Math.PI) / 2, 0.9, hh(i, 5, 21))));
  for (let i = 0; i < 9; i++) spots.push(spot('palm', -3.6 - hh(i, 6, 21) * 13, 38 + i * 3.6 + hh(i, 7, 21), hh(i, 8, 21) * 6, 0.4, hh(i, 9, 21)));
  // the palm grove by a spring, south of the town (camels rest here)
  const gx = -11;
  const gy = 79;
  spots.push(spot('pond', gx, gy, 0, 4.2, 0.5, { a: 3.0, b: 2.2 }));
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + hh(i, 1, 22);
    const r = 3.4 + hh(i, 2, 22) * 1.6;
    spots.push(spot('palm', gx + Math.cos(a) * r * 1.2, gy + Math.sin(a) * r, a * 3, 0.4, hh(i, 3, 22)));
  }
  const camels: P2[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    camels.push({ x: gx + Math.cos(a) * 6.8, y: gy + Math.sin(a) * 5.4 });
  }
  camels.push(...oasisRing(m));
  // the ruined fort on the mesa west of the oasis town (impassable rock)
  spots.push(spot('fort', 30.5, 63, Math.atan2(5, 6), 0, 0.61, { inMap: true }));
  // the refinery skyline north of the map, with its gas flare
  spots.push(spot('refinery', 68, -11, 0, 6.5));
  const lane = smoothPath([{ x: -5.8, y: 38 }, { x: -5.8, y: 54 }, { x: -5.8, y: 60 }, { x: -5.0, y: 70 }, { x: -3.6, y: 92 }], 3, 0.5);
  const offLane = spots.filter((sp) => sp.kind !== 'palm' || lane.every((p) => Math.hypot(p.x - sp.x, p.y - sp.y) > 1.1));
  return { spots: offLane, rails: [], lanes: [{ pts: lane, width: 0.75 }], camels };
}

/** Walkable spots ringing the map's oases (open sand or scrub, no trees, buildings or rock). */
function oasisRing(m: GameMap): P2[] {
  const W = m.w;
  const H = m.h;
  const seen = new Uint8Array(W * H);
  const out: P2[] = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || m.tiles[i] !== Tile.Water) continue;
    // flood the pond
    const q = [i];
    seen[i] = 1;
    let sx = 0;
    let sy = 0;
    let n = 0;
    while (q.length) {
      const t = q.pop()!;
      const x = t % W;
      const y = (t / W) | 0;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
      for (const u of [t - 1, t + 1, t - W, t + W]) if (u >= 0 && u < W * H && !seen[u] && m.tiles[u] === Tile.Water && Math.abs((u % W) - x) <= 1) (seen[u] = 1), q.push(u);
    }
    if (n < 6) continue;
    const cx = sx / n;
    const cy = sy / n;
    const r = Math.sqrt(n / Math.PI) + 3.2;
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) continue;
      const j = ty * W + tx;
      const t = m.tiles[j];
      if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[j] || m.blocked[j] || m.ore[j]) continue;
      if (surfaceHeight(m, x, y) <= WATER_LEVEL + 0.08 || !roadClear(m, x, y, 0.6)) continue;
      if (m.starts.some((s) => Math.hypot(s.x - x, s.y - y) < 12)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

function winter(_m: GameMap): LandmarkPlan {
  const spots: Spot[] = [];
  const laneY = 33.5;
  const west = rail(
    [
      { x: -36, y: 136 },
      { x: -14, y: 112 },
      { x: -3.4, y: 96 },
      { x: RAIL_X, y: 84 },
      { x: RAIL_X, y: 20 },
      { x: -4.2, y: 6 },
      { x: -15, y: -8 },
      { x: -38, y: -30 },
    ],
    { crossAt: [{ x: RAIL_X, y: laneY, roadAng: 0, traffic: false }], stationAt: { x: RAIL_X, y0: 37, y1: 44, side: -1 } },
  );
  const lanes = [{ pts: smoothPath([{ x: 0.2, y: laneY }, { x: -8, y: laneY }, { x: -15, y: laneY - 1.5 }, { x: -26, y: laneY - 6 }], 3, 0.5), width: 0.85 }];
  spots.push(spot('station', -3.75, 40.5, 0, 1.6));
  spots.push(spot('factory', -11.6, 41.2, -Math.PI / 2, 3.4));
  // the frozen lake and its ice-fishing hut
  spots.push(spot('lake', -10.5, 72, 0, 5.2, 0.5, { a: 4.6, b: 3.3 }));
  spots.push(spot('icehut', -9.6, 72.6, 0.4, 0.5));
  spots.push(spot('icehut', -12.4, 70.8, 2.2, 0.5, 0.8));
  const cot: [number, number, number][] = [[-6.2, 63, Math.PI / 2], [-8.8, 66.6, 0], [-5.4, 69.4, Math.PI / 2], [-9.8, 60.2, Math.PI], [-4.4, 47.2, Math.PI / 2]];
  cot.forEach(([x, y, yaw], i) => spots.push(spot('cottage', x, y, yaw, 1.0, 0.2 + hh(i, 1, 31) * 0.3)));
  // the ski mountain north of the map with a gondola lift up its face
  const mx = 34;
  const my = -27;
  spots.push(spot('skimountain', mx, my, 0, 19, 0.5, { a: 19, b: 9.5 }));
  spots.push(spot('liftstation', mx, -6.5, Math.PI / 2, 1.2, 0, { a: 0 }));
  spots.push(spot('liftstation', mx, -20.5, -Math.PI / 2, 1.0, 1, { a: 1 }));
  // the radio / TV mast on the rock ridge south of the centre (impassable rock)
  spots.push(spot('mast', 49, 68.5, 0, 0, 0.5, { inMap: true }));
  return { spots, rails: [west], lanes, camels: [] };
}

function urban(m: GameMap): LandmarkPlan {
  const W = m.w;
  const spots: Spot[] = [];
  // the elevated metro along the north edge
  const metro = rail(
    [
      { x: -70, y: -2.6 },
      { x: W + 70, y: -2.6 },
    ],
    { elevated: 1.15, service: 'metro', stationX: { y: -2.6, x0: 22, x1: 30, side: 1 } },
  );
  spots.push(spot('stadium', -13.5, 46, 0, 7.6));
  spots.push(spot('hospital', -7.2, 24.5, Math.PI, 3.2));
  spots.push(spot('fuel', -4.6, 68.2, 0, 2.3));
  // the skyline: glass towers on the far sides (warning lights on the tall ones)
  const towers: [number, number, number][] = [
    [-12, 8, 9],
    [-19, 16, 12],
    [-11, 28, 7.5],
    [-21, 31, 10],
    [-12, 62, 8.5],
    [-20, 71, 13.5],
    [-11, 83, 7],
    [-25, 52, 11],
    [17, -10, 8],
    [21, -19, 14],
    [33, -10, 9.5],
    [46, -17, 12.5],
    [58, -10, 8],
    [70, -16, 15],
    [84, -11, 9],
    [95, -18, 11],
  ];
  towers.forEach(([x, y, h], i) => spots.push(spot('tower', x, y, (hh(i, 2, 41) - 0.5) * 0.3, 2.6, hh(i, 1, 41), { a: h, b: 1.9 + hh(i, 3, 41) * 1.1, c: 1.7 + hh(i, 4, 41) * 1.0 })));
  // the marina where the canal runs out of town (north-west), cranes and containers on the quay
  spots.push(spot('crane', 8.2, -8.5, Math.PI, 1.6, 0.2));
  spots.push(spot('crane', 8.2, -14.2, Math.PI, 1.6, 0.8));
  spots.push(spot('containers', 10.4, -11.4, Math.PI / 2, 2.4, 0.3));
  // suspension cables on the bridge nearest the centre on player 0's side
  if (m.bridges.length > 1) spots.push(spot('suspension', m.bridges[1].x, m.bridges[1].y, 0, 0, 0.5, { inMap: true, a: 1 }));
  // the canal runs on past the map's corners (outskirts water): keep the city blocks out of it
  const clears: { x: number; y: number; r: number }[] = [];
  for (let d = 0; d < 34; d += 2.5) {
    clears.push({ x: 2.2, y: -1.5 - d, r: 3.2 }, { x: -1.5 - d, y: 1.6, r: 2.6 });
    clears.push({ x: W - 2.2, y: m.h + 1.5 + d, r: 3.2 }, { x: W + 1.5 + d, y: m.h - 1.6, r: 2.6 });
  }
  return { spots, rails: [metro], lanes: [], camels: [], clears };
}
