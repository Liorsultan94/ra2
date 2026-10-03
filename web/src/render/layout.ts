import { Tile, groundHeight, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import { buildBiomeLayout } from './biomelayout';
import { finishRoadLayout, prepareRoadNet, setLayoutBuilder } from './ambient/clearance';

/*
 * Scenery layout derived deterministically from the map: paved roads, dirt
 * tracks, farm fields, hedgerows, fences, power lines and wrecks. All of it
 * is visual only (the simulation never sees it) and kept off tiles that
 * matter for play (bases, ore, bridges, blocking structures).
 *
 * Coordinates are continuous tile space: tile (x, y) covers [x, x+1) x [y, y+1).
 */

export interface V2 {
  x: number;
  y: number;
}

export interface Road {
  pts: V2[]; // dense, smoothed centreline
  width: number;
  variant: 0 | 1; // 0 highway with markings, 1 country road
  /** Drawn by the ground shader (city streets as Avenue / Street / Crossing fields), no ribbon mesh. */
  painted?: boolean;
  /** A piece fitted to the traffic network (link, turning loop): drawn, but no lane of its own. */
  ring?: boolean;
}

export interface Track {
  pts: V2[];
  width: number;
  /** Turning loop / link of a dirt track (see Road.ring). */
  ring?: boolean;
}

export const enum FieldType {
  Plowed = 0,
  Green = 1,
  Wheat = 2,
  Fallow = 3,
  /** City squares: stone flags (urban maps only). */
  Plaza = 4,
  /** City streets painted by the ground shader (urban maps only): avenue, street, crossing. */
  Avenue = 5,
  Street = 6,
  Crossing = 7,
}

export interface Field {
  cx: number;
  cy: number;
  /** half length along the rows, half width across */
  hl: number;
  hw: number;
  angle: number; // row direction
  type: FieldType;
}

export interface Edge {
  a: V2;
  b: V2;
  kind: 'hedge' | 'fence';
}

export interface Layout {
  roads: Road[];
  tracks: Track[];
  fields: Field[];
  edges: Edge[];
  pylons: { lines: V2[][] };
  poles: V2[][];
  wrecks: { x: number; y: number; rot: number; kind: number }[];
  /** 4 cells per tile: bit 1 paved road, 2 track, 4 field, 8 structure / yard */
  occ: Uint8Array;
  occRes: number;
}

export const OCC_ROAD = 1;
export const OCC_TRACK = 2;
export const OCC_FIELD = 4;
export const OCC_BUILT = 8;

const v = (x: number, y: number): V2 => ({ x, y });

/** Chaikin-smoothed, then resampled polyline (spacing ~step). */
export function smoothLine(pts: V2[], iterations = 3, step = 0.25): V2[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const out: V2[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push(v(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25), v(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  // resample to an even spacing
  const res: V2[] = [p[0]];
  let carry = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let t = step - carry;
    while (t <= L) {
      res.push(v(a.x + ((b.x - a.x) * t) / L, a.y + ((b.y - a.y) * t) / L));
      t += step;
    }
    carry = L - (t - step);
  }
  const last = p[p.length - 1];
  if (Math.hypot(res[res.length - 1].x - last.x, res[res.length - 1].y - last.y) > step * 0.3) res.push(last);
  return res;
}

export function segDist(px: number, py: number, a: V2, b: V2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - a.x - dx * t, py - a.y - dy * t);
}

const layouts = new WeakMap<GameMap, Layout>();

/** The map's scenery layout (built once per map: deterministic). */
export function buildLayout(m: GameMap): Layout {
  let l = layouts.get(m);
  if (!l) layouts.set(m, (l = buildLayoutOnce(m)));
  return l;
}
setLayoutBuilder(buildLayout);

function buildLayoutOnce(m: GameMap): Layout {
  // the other maps hand their layout to the renderer as deco hints (sim/maps.ts)
  if (m.id !== 'frontline') return buildBiomeLayout(m);
  const W = m.w;
  const H = m.h;
  const mir = (p: V2) => v(W - p.x, H - p.y);
  const mirAll = (a: V2[]) => a.map(mir);
  const rev = <T>(a: T[]) => [...a].reverse();

  // bridge ends: deck runs along (1, -1); end 0 lies on player 0's side (y > x)
  const D = Math.SQRT1_2;
  const ends = m.bridges.map((b) => {
    const h = b.length / 2;
    return {
      e0: v(b.x - h * D, b.y + h * D),
      a0: v(b.x - (h + 1.6) * D, b.y + (h + 1.6) * D),
      e1: v(b.x + h * D, b.y - h * D),
      a1: v(b.x + (h + 1.6) * D, b.y - (h + 1.6) * D),
    };
  });
  // bridges are listed [centre, west/north, east/south]
  const [bc, , bs] = ends;
  const s0 = v(m.starts[0].x + 0.5, m.starts[0].y + 0.5);
  const s1 = v(m.starts[1].x + 0.5, m.starts[1].y + 0.5);

  // ---- paved roads and dirt tracks: hand-placed via points, routed around
  // rocks, trees, structures and water so nothing paved disappears under them
  const route = makeRouter(m);
  const hwy0 = [v(0, 71.5), v(8, 79.6), s0, v(24, 76.5), v(30, 58.5), v(37.5, 56.5), bc.a0, bc.e0];
  const ctryA0 = [s0, v(30.5, 84.5), v(52.5, 82.5), v(64.5, 76.5), v(70, 77.8), bs.a0, bs.e0];
  const ctryA1 = [bs.e1, bs.a1, v(80.6, 66), v(80.2, 60), v(81, 52), v(83.5, 33.5), s1];
  // (the rock ridges are not exactly point symmetric, so mirrored roads are routed on their own)
  const roadSrc: { pts: V2[]; width: number; variant: 0 | 1 }[] = [
    { pts: hwy0, width: 1.05, variant: 0 },
    { pts: ctryA0, width: 0.8, variant: 1 },
    { pts: ctryA1, width: 0.8, variant: 1 },
  ];
  // roads lead up to the bases but stop short of the construction area
  const baseR = 8.5;
  const inBase = (p: V2) => m.starts.some((st) => Math.hypot(p.x - st.x - 0.5, p.y - st.y - 0.5) < baseR);
  const roads: Road[] = [];
  for (const r of [...roadSrc, ...roadSrc.map((r) => ({ ...r, pts: rev(mirAll(r.pts)) }))]) {
    let run: V2[] = [];
    const flush = () => {
      if (run.length * 0.25 > 2) roads.push({ ...r, pts: run });
      run = [];
    };
    for (const p of route(r.pts, r.width)) {
      if (inBase(p)) flush();
      else run.push(p);
    }
    flush();
  }

  const tr0: V2[][] = [
    // village lane, from the western road through the village to the highway
    [v(14.5, 52.6), v(20, 53.1), v(27, 52.7), v(33, 53.2), v(37.5, 53.4), v(39.8, 56.6)],
    // farm track
    [v(55.6, 82), v(56.6, 85.8), v(60.6, 87.4), v(65.6, 88.6), v(70.5, 90.2), v(75, 91.5)],
    // hamlet track
    [v(50.6, 82.8), v(51.2, 79.4), v(50.8, 75.6), v(50.2, 71.6), v(45, 67.6), v(37.8, 66.4)],
    // field access west
    [v(12.6, 45.5), v(9, 45.8), v(4, 46.6)],
    [v(31, 76), v(37, 75.6), v(43.5, 75.8)],
  ];
  const tracks: Track[] = [...tr0, ...tr0.map(mirAll)].map((pts) => ({ pts: route(pts, 0.5, 0.3), width: 0.5 }));

  // ---- occupancy grid
  const R = 4;
  const occ = new Uint8Array(W * R * H * R);
  const stampLine = (pts: V2[], radius: number, bit: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius) * R));
      const x1 = Math.min(W * R - 1, Math.ceil((Math.max(a.x, b.x) + radius) * R));
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius) * R));
      const y1 = Math.min(H * R - 1, Math.ceil((Math.max(a.y, b.y) + radius) * R));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) if (segDist((x + 0.5) / R, (y + 0.5) / R, a, b) < radius) occ[y * W * R + x] |= bit;
    }
  };
  for (const r of roads) stampLine(r.pts, r.width / 2 + 0.25, OCC_ROAD);
  for (const t of tracks) stampLine(t.pts, t.width / 2 + 0.2, OCC_TRACK);
  // the civilian lane graph: turning circles / junctions kept clear, roads fitted to them (ambient/clearance.ts)
  prepareRoadNet(m, roads, tracks, occ, R);
  for (const st of m.structures) {
    for (let y = (st.y - 0.6) * R; y < (st.y + st.h + 0.6) * R; y++)
      for (let x = (st.x - 0.6) * R; x < (st.x + st.w + 0.6) * R; x++) if (x >= 0 && y >= 0 && x < W * R && y < H * R) occ[Math.floor(y) * W * R + Math.floor(x)] |= OCC_BUILT;
  }
  const occAt = (x: number, y: number) => {
    const ix = Math.floor(x * R);
    const iy = Math.floor(y * R);
    if (ix < 0 || iy < 0 || ix >= W * R || iy >= H * R) return 255;
    return occ[iy * W * R + ix];
  };

  // ---- farm fields
  const nearStart = (x: number, y: number, r: number) => m.starts.some((s) => Math.hypot(x - s.x - 0.5, y - s.y - 0.5) < r);
  const tileOk = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
    const i = ty * W + tx;
    const t = m.tiles[i];
    if (t !== Tile.Grass && t !== Tile.Dirt) return false;
    if (m.trees[i] || m.blocked[i]) return false;
    if (occAt(x, y) & (OCC_ROAD | OCC_TRACK | OCC_BUILT | OCC_FIELD)) return false;
    if (nearStart(x, y, 12)) return false;
    // ore (and where ore regrows) stays clear
    for (const mm of m.oreMines) if (Math.abs(x - mm.x - 0.5) < 5.5 && Math.abs(y - mm.y - 0.5) < 5.5) return false;
    if (m.ore[i]) return false;
    // steep ground is no farmland
    const h0 = groundHeight(m, x, y);
    if (Math.abs(groundHeight(m, x + 0.5, y) - h0) + Math.abs(groundHeight(m, x, y + 0.5) - h0) > 0.32) return false;
    return true;
  };
  const fieldOk = (f: Field) => {
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (let a = -f.hl; a <= f.hl + 1e-6; a += 0.5)
      for (let b = -f.hw; b <= f.hw + 1e-6; b += 0.5) if (!tileOk(f.cx + ca * a - sa * b, f.cy + sa * a + ca * b)) return false;
    return true;
  };
  /** Try the field, shrinking it from either end until it fits. */
  const fit = (f: Field): Field | null => {
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (let cut = 0; cut <= f.hl * 0.9; cut += 0.5) {
      for (const side of [1, -1, 0]) {
        const hl = side === 0 ? f.hl - cut : f.hl - cut / 2;
        const shift = side === 0 ? 0 : (side * cut) / 2;
        if (hl < 1.4) continue;
        const g = { ...f, hl, cx: f.cx + ca * shift, cy: f.cy + sa * shift };
        if (fieldOk(g)) return g;
      }
      // also try thinning the field
      const thin = { ...f, hl: f.hl - cut, hw: f.hw * 0.65 };
      if (thin.hl >= 1.4 && thin.hw >= 1 && fieldOk(thin)) return thin;
    }
    return null;
  };
  const zones0 = [
    { x0: 2.5, y0: 27, x1: 11.5, y1: 45, rows: 'x' },
    { x0: 18.5, y0: 59, x1: 29, y1: 67.5, rows: 'y' },
    { x0: 55, y0: 64.5, x1: 68, y1: 78, rows: 'x' },
    { x0: 31, y0: 68, x1: 44, y1: 74.6, rows: 'x' },
    { x0: 31, y0: 76.6, x1: 44, y1: 82.4, rows: 'x' },
    { x0: 51.5, y0: 84, x1: 57.5, y1: 92.5, rows: 'y' },
    { x0: 66.4, y0: 85, x1: 75.5, y1: 92.5, rows: 'x' },
    { x0: 2.5, y0: 84, x1: 9, y1: 92, rows: 'y' },
  ];
  const zones = [...zones0, ...zones0.map((z) => ({ x0: W - z.x1, y0: H - z.y1, x1: W - z.x0, y1: H - z.y0, rows: z.rows }))];
  const fields: Field[] = [];
  const edges: Edge[] = [];
  let seed = 0;
  for (const z of zones) {
    // split the zone into strips across its long side, 0.6 tile gaps between
    const along = z.rows === 'x';
    const len = along ? z.x1 - z.x0 : z.y1 - z.y0;
    const span = along ? z.y1 - z.y0 : z.x1 - z.x0;
    let s = 0;
    while (s < span - 1.5) {
      seed++;
      const wdt = Math.min(span - s, 2.6 + hash2(seed, 1, 515) * 2.4);
      if (wdt < 1.6) break;
      const mid = s + wdt / 2;
      const r = hash2(seed, 2, 515);
      const type = r < 0.32 ? FieldType.Plowed : r < 0.56 ? FieldType.Green : r < 0.86 ? FieldType.Wheat : FieldType.Fallow;
      const tilt = (hash2(seed, 3, 515) - 0.5) * 0.08;
      const f: Field = along
        ? { cx: (z.x0 + z.x1) / 2, cy: z.y0 + mid, hl: len / 2 - 0.3, hw: wdt / 2 - 0.3, angle: tilt, type }
        : { cx: z.x0 + mid, cy: (z.y0 + z.y1) / 2, hl: len / 2 - 0.3, hw: wdt / 2 - 0.3, angle: Math.PI / 2 + tilt, type };
      const g = fit(f);
      if (g) {
        fields.push(g);
        // mark it so neighbouring strips and other zones don't overlap
        const ca = Math.cos(g.angle);
        const sa = Math.sin(g.angle);
        for (let a = -g.hl - 0.3; a <= g.hl + 0.3; a += 0.2)
          for (let b = -g.hw - 0.3; b <= g.hw + 0.3; b += 0.2) {
            const x = g.cx + ca * a - sa * b;
            const y = g.cy + sa * a + ca * b;
            const ix = Math.floor(x * R);
            const iy = Math.floor(y * R);
            if (ix >= 0 && iy >= 0 && ix < W * R && iy < H * R) occ[iy * W * R + ix] |= OCC_FIELD;
          }
        // a hedge or fence along one long side
        const kindSel = hash2(seed, 4, 515);
        if (kindSel < 0.75) {
          const side = hash2(seed, 5, 515) < 0.5 ? -1 : 1;
          const off = g.hw + 0.32;
          const nx = -sa * off * side;
          const ny = ca * off * side;
          edges.push({
            a: v(g.cx - ca * g.hl + nx, g.cy - sa * g.hl + ny),
            b: v(g.cx + ca * g.hl + nx, g.cy + sa * g.hl + ny),
            kind: kindSel < 0.45 ? 'hedge' : 'fence',
          });
        }
      }
      s += wdt + 0.6;
    }
  }

  // yard fences around village houses (front side open)
  for (const st of m.structures) {
    if (hash2(st.x, st.y, 77) < 0.35) continue;
    const x0 = st.x - 0.35;
    const y0 = st.y - 0.35;
    const x1 = st.x + st.w + 0.35;
    const y1 = st.y + st.h + 0.35;
    const sides: [V2, V2][] = [
      [v(x0, y0), v(x1, y0)],
      [v(x1, y0), v(x1, y1)],
      [v(x1, y1), v(x0, y1)],
      [v(x0, y1), v(x0, y0)],
    ];
    // rot 0 faces +y (south), 1 +x, 2 -y, 3 -x; leave the facing side open
    const open = [2, 1, 0, 3][st.rot];
    sides.forEach((sd, i) => {
      if (i === open) return;
      const mx = (sd[0].x + sd[1].x) / 2;
      const my = (sd[0].y + sd[1].y) / 2;
      if (occAt(mx, my) & (OCC_ROAD | OCC_TRACK)) return;
      edges.push({ a: sd[0], b: sd[1], kind: hash2(st.x, st.y, 78 + i) < 0.5 ? 'fence' : 'hedge' });
    });
  }

  // ---- power lines: two lines crossing the river at right angles, mirrored
  const valid = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const i = ty * W + tx;
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Bridge || t === Tile.Rock || m.trees[i] || m.blocked[i]) return false;
    if (occAt(x, y) & (OCC_ROAD | OCC_TRACK | OCC_BUILT)) return false;
    if (nearStart(x, y, 9)) return false;
    for (const mm of m.oreMines) if (Math.hypot(x - mm.x - 0.5, y - mm.y - 0.5) < 6) return false;
    return true;
  };
  const line = (a: V2, b: V2, spacing: number) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.round(L / spacing);
    const dx = (b.x - a.x) / L;
    const dy = (b.y - a.y) / L;
    const out: V2[] = [];
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * L;
      // slide along the line to the nearest valid spot
      for (const o of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4]) {
        const x = a.x + dx * (t + o);
        const y = a.y + dy * (t + o);
        if (valid(x, y)) {
          out.push(v(x, y));
          break;
        }
      }
    }
    return out;
  };
  const pl0 = line(v(0.6, 62.4), v(62.4, 0.6), 7.6);
  const pylons = { lines: [pl0, rev(mirAll(pl0))] };

  // ---- wooden utility poles along the country roads
  const poles: V2[][] = [];
  for (const r of roads) {
    if (r.variant !== 1) continue;
    const run: V2[] = [];
    for (let i = 4; i < r.pts.length - 4; i += 12) {
      const a = r.pts[i - 1];
      const b = r.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / L;
      const ny = (b.x - a.x) / L;
      const p = v(r.pts[i].x + nx * (r.width / 2 + 0.45), r.pts[i].y + ny * (r.width / 2 + 0.45));
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      const ok = tx >= 0 && ty >= 0 && tx < W && ty < H && m.tiles[ty * W + tx] !== Tile.Water && m.tiles[ty * W + tx] !== Tile.Bridge && !m.trees[ty * W + tx] && !m.blocked[ty * W + tx] && !nearStart(p.x, p.y, 7);
      if (ok) run.push(p);
      else if (run.length > 1) {
        poles.push(run.splice(0));
      } else run.length = 0;
    }
    if (run.length > 1) poles.push(run);
  }

  // ---- wrecked cars on road shoulders
  const wrecks: Layout['wrecks'] = [];
  let wseed = 0;
  for (const r of roads) {
    for (let i = 20; i < r.pts.length - 20; i += 28 + Math.floor(hash2(i, r.pts.length, 61) * 50)) {
      wseed++;
      if (hash2(wseed, 0, 62) < 0.45) continue;
      const a = r.pts[i - 1];
      const b = r.pts[i + 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const side = hash2(wseed, 1, 62) < 0.5 ? -1 : 1;
      const off = r.width / 2 + 0.15 + hash2(wseed, 2, 62) * 0.35;
      const x = r.pts[i].x - Math.sin(ang) * off * side;
      const y = r.pts[i].y + Math.cos(ang) * off * side;
      if (nearStart(x, y, 10)) continue;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const wt = m.tiles[ty * W + tx];
      if (wt === Tile.Water || wt === Tile.Bridge || wt === Tile.Rock || m.trees[ty * W + tx] || m.blocked[ty * W + tx]) continue;
      wrecks.push({ x, y, rot: ang + (hash2(wseed, 3, 62) - 0.5) * 1.2 + (hash2(wseed, 4, 62) < 0.2 ? Math.PI / 2 : 0), kind: Math.floor(hash2(wseed, 5, 62) * 3) });
    }
  }

  return finishRoadLayout(m, { roads, tracks, fields, edges, pylons, poles, wrecks, occ, occRes: R });
}

/**
 * A* road router over the tile grid. Roads keep a margin from rocks, trees,
 * structures and water, prefer flat ground, and the result is string-pulled
 * (with a clearance check) and smoothed. Pure function of the map, so the
 * scenery stays deterministic.
 */
export function makeRouter(m: GameMap) {
  const W = m.w;
  const H = m.h;
  const hard = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[i] || m.blocked[i]) hard[i] = 1;
  }
  const isHard = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || hard[y * W + x] === 1;
  // distance (in tiles, chamfer) to the nearest hard tile
  const near = new Float32Array(W * H).fill(99);
  for (let i = 0; i < W * H; i++) if (hard[i]) near[i] = 0;
  for (let pass = 0; pass < 2; pass++) {
    const dirs = pass === 0 ? 1 : -1;
    for (let k = 0; k < W * H; k++) {
      const i = dirs > 0 ? k : W * H - 1 - k;
      const x = i % W;
      const y = (i / W) | 0;
      for (const [dx, dy, c] of [
        [-1, 0, 1],
        [0, -1, 1],
        [-1, -1, 1.414],
        [1, -1, 1.414],
      ] as const) {
        const xx = x + dx * dirs;
        const yy = y + dy * dirs;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        near[i] = Math.min(near[i], near[yy * W + xx] + c);
      }
    }
  }
  // ore fields (and the ground around the rigs where ore regrows) are expensive
  const oreArea = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!m.oreKind[i] && !m.ore[i]) continue;
    const x = i % W;
    const y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) oreArea[(y + dy) * W + x + dx] = 1;
  }
  for (const mm of m.oreMines)
    for (let y = mm.y - 4; y <= mm.y + 4; y++) for (let x = mm.x - 4; x <= mm.x + 4; x++) if (x >= 0 && y >= 0 && x < W && y < H) oreArea[y * W + x] = 1;
  const vh = (x: number, y: number) => m.heights[y * (W + 1) + x];
  const cost = (i: number) => {
    const x = i % W;
    const y = (i / W) | 0;
    const d = near[i];
    const slope = Math.max(vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1)) - Math.min(vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1));
    return 1 + (d < 1.5 ? 6 : d < 2.5 ? 1.5 : 0) + slope * 6 + (oreArea[i] ? 25 : 0) + (m.tiles[i] === Tile.Sand ? 1 : 0);
  };
  /** Is a disc of radius r around (x, y) clear of hard tiles? */
  const free = (x: number, y: number, r: number) => {
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++)
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H || !hard[ty * W + tx]) continue;
        const dx = Math.max(tx - x, 0, x - tx - 1);
        const dy = Math.max(ty - y, 0, y - ty - 1);
        if (dx * dx + dy * dy < r * r) return false;
      }
    return true;
  };
  const snap = (p: V2): number => {
    let best = -1;
    let bd = 1e9;
    const cx = Math.floor(Math.max(0, Math.min(W - 1, p.x)));
    const cy = Math.floor(Math.max(0, Math.min(H - 1, p.y)));
    for (let y = cy - 4; y <= cy + 4; y++)
      for (let x = cx - 4; x <= cx + 4; x++) {
        if (isHard(x, y)) continue;
        const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) - Math.min(near[y * W + x], 3) * 0.3 + oreArea[y * W + x] * 6;
        if (d < bd) {
          bd = d;
          best = y * W + x;
        }
      }
    return best >= 0 ? best : cy * W + cx;
  };
  const astar = (a: number, b: number): number[] => {
    const g = new Float32Array(W * H).fill(Infinity);
    const from = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const bx = b % W;
    const by = (b / W) | 0;
    const heur = (i: number) => {
      const dx = Math.abs((i % W) - bx);
      const dy = Math.abs(((i / W) | 0) - by);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    };
    // binary heap of [f, i]
    const hf: number[] = [];
    const hi: number[] = [];
    const push = (f: number, i: number) => {
      let k = hf.length;
      hf.push(f);
      hi.push(i);
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (hf[p] < hf[k] || (hf[p] === hf[k] && hi[p] <= hi[k])) break;
        [hf[p], hf[k]] = [hf[k], hf[p]];
        [hi[p], hi[k]] = [hi[k], hi[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = hi[0];
      const lf = hf.pop()!;
      const li = hi.pop()!;
      if (hf.length) {
        hf[0] = lf;
        hi[0] = li;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let s = k;
          const less = (x: number, y: number) => hf[x] < hf[y] || (hf[x] === hf[y] && hi[x] < hi[y]);
          if (l < hf.length && less(l, s)) s = l;
          if (r < hf.length && less(r, s)) s = r;
          if (s === k) break;
          [hf[s], hf[k]] = [hf[k], hf[s]];
          [hi[s], hi[k]] = [hi[k], hi[s]];
          k = s;
        }
      }
      return top;
    };
    g[a] = 0;
    push(heur(a), a);
    while (hf.length) {
      const i = pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === b) break;
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (isHard(xx, yy)) continue;
          if (dx && dy && (isHard(x + dx, y) || isHard(x, y + dy))) continue;
          const j = yy * W + xx;
          const ng = g[i] + (dx && dy ? 1.414 : 1) * (cost(i) + cost(j)) * 0.5;
          if (ng < g[j]) {
            g[j] = ng;
            from[j] = i;
            push(ng + heur(j), j);
          }
        }
    }
    const path: number[] = [];
    for (let i = b; i >= 0; i = from[i]) {
      path.push(i);
      if (i === a) break;
    }
    return path.reverse();
  };
  const clearSeg = (p: V2, q: V2, r: number) => {
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.ceil(L / 0.2));
    for (let k = 0; k <= n; k++) {
      const x = p.x + ((q.x - p.x) * k) / n;
      const y = p.y + ((q.y - p.y) * k) / n;
      if (!free(x, y, r)) return false;
      // short cuts must not clip ore fields either
      for (const [ox, oy] of [
        [0, 0],
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        const tx = Math.floor(x + ox);
        const ty = Math.floor(y + oy);
        if (tx >= 0 && ty >= 0 && tx < W && ty < H && (m.oreKind[ty * W + tx] || m.ore[ty * W + tx])) return false;
      }
    }
    return true;
  };
  /**
   * Route through the via points. The first / last via may lie off the
   * grid or on a bridge approach; they are joined straight to the route.
   */
  return (allVias: V2[], width: number, step = 0.25): V2[] => {
    const r = width / 2 + 0.3;
    // leading / trailing points on bridge decks or water join straight on
    const vias = [...allVias];
    const onHard = (p: V2) => {
      const t = m.tiles[Math.floor(Math.max(0, Math.min(H - 1, p.y))) * W + Math.floor(Math.max(0, Math.min(W - 1, p.x)))];
      return t === Tile.Water || t === Tile.Bridge;
    };
    const lead: V2[] = [];
    const trail: V2[] = [];
    while (vias.length > 2 && onHard(vias[0])) lead.push(vias.shift()!);
    while (vias.length > 2 && onHard(vias[vias.length - 1])) trail.unshift(vias.pop()!);
    const ids = vias.map(snap);
    const centre = (i: number) => v((i % W) + 0.5, ((i / W) | 0) + 0.5);
    // A* per leg, then string pulling with clearance (per leg, so it never skips a via)
    const pulled: V2[] = [centre(ids[0])];
    for (let leg = 0; leg < ids.length - 1; leg++) {
      const cells = astar(ids[leg], ids[leg + 1]);
      let i = 0;
      while (i < cells.length - 1) {
        let j = i + 1;
        for (let k = cells.length - 1; k > i + 1; k--)
          if (clearSeg(centre(cells[i]), centre(cells[k]), r)) {
            j = k;
            break;
          }
        pulled.push(centre(cells[j]));
        i = j;
      }
    }
    const first = vias[0];
    const last = vias[vias.length - 1];
    // keep the original end points when they differ from the snapped cells
    const head = Math.hypot(first.x - pulled[0].x, first.y - pulled[0].y) > 0.05 && clearSeg(first, pulled[0], r * 0.7) ? [first] : [];
    const tail = Math.hypot(last.x - pulled[pulled.length - 1].x, last.y - pulled[pulled.length - 1].y) > 0.05 && clearSeg(pulled[pulled.length - 1], last, r * 0.7) ? [last] : [];
    // bridge approaches: keep the straight run onto the deck
    const raw = [...lead, ...head, ...pulled, ...tail, ...trail];
    // subdivide long legs so the corner cutting of the smoothing stays small
    const dense: V2[] = [raw[0]];
    for (let k = 1; k < raw.length; k++) {
      const a = raw[k - 1];
      const b = raw[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.6));
      for (let s = 1; s <= n; s++) dense.push(v(a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n));
    }
    return smoothLine(dense, 3, step);
  };
}

/** Occupancy bits at a continuous position. */
export function occAt(l: Layout, m: GameMap, x: number, y: number): number {
  const R = l.occRes;
  const ix = Math.floor(x * R);
  const iy = Math.floor(y * R);
  if (ix < 0 || iy < 0 || ix >= m.w * R || iy >= m.h * R) return 255;
  return l.occ[iy * m.w * R + ix];
}
