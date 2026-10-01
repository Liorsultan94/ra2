import { Tile, groundHeight, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';

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
}

export interface Track {
  pts: V2[];
  width: number;
}

export const enum FieldType {
  Plowed = 0,
  Green = 1,
  Wheat = 2,
  Fallow = 3,
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

export function buildLayout(m: GameMap): Layout {
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

  // ---- paved roads
  const hwy0 = [v(0, 77), v(8, 79.6), s0, v(30.5, 72.5), v(41.6, 61.5), v(43.2, 55), bc.a0, bc.e0];
  const ctryA0 = [s0, v(30.5, 84.5), v(52.5, 82.5), v(64.5, 76.5), v(70, 77.8), bs.a0, bs.e0];
  const ctryA1 = [bs.e1, bs.a1, v(80.6, 66), v(80.2, 60), v(77.5, 51.5), v(83.5, 33.5), s1];
  const raw: { pts: V2[]; width: number; variant: 0 | 1 }[] = [
    { pts: hwy0, width: 1.05, variant: 0 },
    { pts: rev(mirAll(hwy0)), width: 1.05, variant: 0 },
    { pts: ctryA0, width: 0.8, variant: 1 },
    { pts: ctryA1, width: 0.8, variant: 1 },
    { pts: mirAll(ctryA0), width: 0.8, variant: 1 },
    { pts: mirAll(ctryA1), width: 0.8, variant: 1 },
  ];
  const roads: Road[] = raw.map((r) => ({ pts: smoothLine(r.pts, 4, 0.25), width: r.width, variant: r.variant }));

  // ---- dirt tracks
  const tr0: V2[][] = [
    // village lane, from the western road through the village to the highway
    [v(14.5, 52.6), v(20, 53.1), v(27, 52.7), v(33, 53.2), v(37.5, 53.4), v(40.6, 56.5), v(42.4, 58)],
    // farm track
    [v(55.6, 82), v(56.6, 85.8), v(60.6, 87.4), v(65.6, 87.4), v(70.5, 90.2), v(75, 91.5)],
    // hamlet track
    [v(50.6, 82.8), v(51.2, 79.4), v(50.8, 75.6), v(50.2, 71.6), v(45, 67.6), v(37.8, 66.4)],
    // field access west
    [v(12.6, 45.5), v(9, 45.8), v(4, 46.6)],
    [v(31, 76), v(37, 75.6), v(43.5, 75.8)],
  ];
  const tracks: Track[] = [...tr0, ...tr0.map(mirAll)].map((pts) => ({ pts: smoothLine(pts, 3, 0.3), width: 0.5 }));

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
      if (m.tiles[ty * W + tx] === Tile.Water || m.tiles[ty * W + tx] === Tile.Bridge || m.trees[ty * W + tx]) continue;
      wrecks.push({ x, y, rot: ang + (hash2(wseed, 3, 62) - 0.5) * 1.2 + (hash2(wseed, 4, 62) < 0.2 ? Math.PI / 2 : 0), kind: Math.floor(hash2(wseed, 5, 62) * 3) });
    }
  }

  return { roads, tracks, fields, edges, pylons, poles, wrecks, occ, occRes: R };
}

/** Occupancy bits at a continuous position. */
export function occAt(l: Layout, m: GameMap, x: number, y: number): number {
  const R = l.occRes;
  const ix = Math.floor(x * R);
  const iy = Math.floor(y * R);
  if (ix < 0 || iy < 0 || ix >= m.w * R || iy >= m.h * R) return 255;
  return l.occ[iy * m.w * R + ix];
}
