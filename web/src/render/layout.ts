import { neutralSites } from '../sim/capture';
import { Tile, type GameMap } from '../sim/map';
import { spanClear } from './pylonsite';
export { pylonFooting, spanClear } from './pylonsite';
import { buildBiomeLayout } from './biomelayout';
import { setLayoutBuilder } from './ambient/clearance';

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
  /** Access lane of parking lot #lot (ambient/sites.ts). */
  lot?: number;
  /** Two roads joined into one (ambient/clearance.ts): width and look per point (drawn by roadfurniture.ts). */
  taper?: { w: number[]; v: (0 | 1)[]; from?: number; to?: number; lift?: number };
  /** A closed loop (first point follows the last). */
  closed?: boolean;
  /** A paved lane off the traffic's network (the Litani's real minor, service and slip roads: MapDeco.trackPave). */
  lane?: boolean;
}

export interface Track {
  pts: V2[];
  width: number;
  /** Extra half width of the worn band (tiles; a graded mountain track: MapDeco.trackBeds). */
  bed?: number;
  /** No civilian vehicles on it: a footpath, a dead-end mountain track (MapDeco.trackNoCars). */
  noCars?: boolean;
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
  /** A small plot by a village house (render/farm.ts favours gardens, greenhouses and orchards there). */
  plot?: boolean;
  /** What grows there when the map says (MapDeco.fields crop: the Litani's real orchards and greenhouses). */
  crop?: 'orchard' | 'greenhouse';
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
  /** Desert centre-pivot circles (render/farm.ts), tile space; their discs count as fields in `occ`. */
  pivots?: { x: number; y: number; r: number }[];
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

/**
 * Is (x, y) within `margin` of a neutral site's footprint (oil derricks, tech structures: sim/capture.ts
 * neutralSites, the same plan the world spawns)? Roads, tracks, fields, hedges, power lines and wrecks
 * keep off them, so no car drives through a compound and no hedge runs through a derrick.
 */
export function nearSite(m: GameMap, x: number, y: number, margin: number): boolean {
  for (const s of neutralSites(m)) if (x > s.x - margin && x < s.x + s.w + margin && y > s.y - margin && y < s.y + s.h + margin) return true;
  return false;
}
/** Drop the hedges / fences that would run through a neutral site (park hedges, yard fences: not routed). */
export function edgesOffSites(m: GameMap, edges: Edge[]) {
  const keep = edges.filter((e) => {
    const L = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    const n = Math.max(1, Math.ceil(L / 0.2));
    for (let k = 0; k <= n; k++) if (nearSite(m, e.a.x + ((e.b.x - e.a.x) * k) / n, e.a.y + ((e.b.y - e.a.y) * k) / n, 0.3)) return false;
    return true;
  });
  edges.length = 0;
  edges.push(...keep);
}
/** Roads and tracks are routed this far (tiles) clear of a neutral site; fields keep SITE_CLEAR + their hedge's offset. */
export const SITE_CLEAR = 1;

/**
 * Power-line spans that would cut through a mesa / ridge (or skim a hill) get an extra tower beside
 * the obstacle: the line bends round it. Deterministic; a span with no detour is dropped (the line splits).
 */
export function detourSpans(m: GameMap, line: V2[], valid: (x: number, y: number) => boolean): V2[][] {
  const out: V2[][] = [];
  if (line.length < 2) return out;
  let cur: V2[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = cur[cur.length - 1];
    const b = line[i];
    if (spanClear(m, a, b)) {
      cur.push(b);
      continue;
    }
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / L;
    const ny = (b.x - a.x) / L;
    let via: V2 | null = null;
    // a tower off to one side (nearest first, along the span), both new spans clear
    for (let off = 2; off <= 7 && !via; off += 0.5)
      for (const side of [1, -1]) {
        for (const t of [0.5, 0.35, 0.65, 0.2, 0.8, 0.05, 0.95]) {
          const p = { x: a.x + (b.x - a.x) * t + nx * off * side, y: a.y + (b.y - a.y) * t + ny * off * side };
          if (valid(p.x, p.y) && spanClear(m, a, p) && spanClear(m, p, b)) {
            via = p;
            break;
          }
        }
        if (via) break;
      }
    // a longer obstacle: two towers out to the same side
    let via2: V2[] | null = null;
    for (let off = 2; off <= 7 && !via && !via2; off += 0.5)
      for (const side of [1, -1]) {
        const p = { x: a.x + (b.x - a.x) * 0.15 + nx * off * side, y: a.y + (b.y - a.y) * 0.15 + ny * off * side };
        const q = { x: a.x + (b.x - a.x) * 0.85 + nx * off * side, y: a.y + (b.y - a.y) * 0.85 + ny * off * side };
        if (valid(p.x, p.y) && valid(q.x, q.y) && spanClear(m, a, p) && spanClear(m, p, q) && spanClear(m, q, b)) {
          via2 = [p, q];
          break;
        }
      }
    if (via) cur.push(via, b);
    else if (via2) cur.push(...via2, b);
    else {
      if (cur.length > 1) out.push(cur);
      cur = [b];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
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
  // every map hands its layout to the renderer as deco hints (sim/maps.ts)
  return buildBiomeLayout(m);
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
  // neutral sites (oil derricks, tech structures) and a ring around them: no road or track runs through
  for (const s of neutralSites(m))
    for (let y = s.y - SITE_CLEAR; y < s.y + s.h + SITE_CLEAR; y++) for (let x = s.x - SITE_CLEAR; x < s.x + s.w + SITE_CLEAR; x++) if (x >= 0 && y >= 0 && x < W && y < H) hard[y * W + x] = 1;
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
