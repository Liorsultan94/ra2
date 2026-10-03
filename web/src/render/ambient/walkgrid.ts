import { Tile, type GameMap } from '../../sim/map';
import { FieldType, OCC_FIELD, OCC_ROAD, OCC_TRACK, type Layout } from '../layout';
import { MarkKind, onSurface, type RoadNet } from './roadnet';

/*
 * Where pedestrians may walk (pure logic, no three.js): a fine cost raster
 * over the map (RES cells per tile) and a bounded A* with line-of-sight
 * smoothing on it.
 *
 * Pavements, plazas, park paths, village lanes and dirt tracks are cheap;
 * grass, sand and snow a little dearer; crop fields and woods dearer still;
 * paved road surface is expensive (city streets very much so) EXCEPT on the
 * zebra crossings, so walkers keep to the pavement and cross at the zebras.
 * Bases are avoided. Water, rock and structures are closed. A panicking
 * walker (evacuation) ignores the road rules: roads cost little then.
 */

export const RES = 4;

export const enum WF {
  Road = 1,
  Zebra = 2,
  Plaza = 4,
  Park = 8,
  Field = 16,
  Base = 32,
  Track = 64,
  Edge = 128,
}

export interface WalkGrid {
  w: number;
  h: number;
  gw: number;
  gh: number;
  /** Step cost per cell (0 = closed). */
  cost: Uint8Array;
  flag: Uint8Array;
  urban: boolean;
}

export interface ZebraBand {
  x: number;
  y: number;
  /** Unit direction a walker crosses along. */
  dx: number;
  dy: number;
  /** Half length (across the road) and half width (of the band). */
  hl: number;
  hw: number;
}

/** Zebra crossings: roadnet marks (country / village junctions) and the city's painted crossings. */
export function zebraBands(m: GameMap, layout: Layout, net: RoadNet | null): ZebraBand[] {
  const out: ZebraBand[] = [];
  if (net)
    for (const mk of net.marks) {
      if (mk.kind !== MarkKind.Zebra) continue;
      // the band runs along the road (len) and spans it (wid): walkers cross perpendicular to `ang`
      out.push({ x: mk.x, y: mk.y, dx: -Math.sin(mk.ang), dy: Math.cos(mk.ang), hl: mk.wid / 2 + 0.15, hw: Math.max(0.16, mk.len / 2) });
    }
  if (m.biome === 'urban')
    for (const f of layout.fields) {
      if (f.type !== FieldType.Crossing) continue;
      // ground.ts paints the bands at 0.95..1.42 from the centre, 1.1 long, on each of the four sides
      for (const s of [-1, 1]) {
        out.push({ x: f.cx + s * 1.19, y: f.cy, dx: 0, dy: 1, hl: 1.45, hw: 0.2 });
        out.push({ x: f.cx, y: f.cy + s * 1.19, dx: 1, dy: 0, hl: 1.45, hw: 0.2 });
      }
    }
  return out;
}

export function buildWalkGrid(m: GameMap, layout: Layout, net: RoadNet | null, zebras = zebraBands(m, layout, net)): WalkGrid {
  const W = m.w;
  const H = m.h;
  const gw = W * RES;
  const gh = H * RES;
  const cost = new Uint8Array(gw * gh);
  const flag = new Uint8Array(gw * gh);
  const urban = m.biome === 'urban';
  const R = layout.occRes;
  const plazas = layout.fields.filter((f) => f.type === FieldType.Plaza);
  const parks = m.deco?.parks ?? [];
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x = (gx + 0.5) / RES;
      const y = (gy + 0.5) / RES;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      const ti = ty * W + tx;
      const k = gy * gw + gx;
      const t = m.tiles[ti];
      if (t === Tile.Water || t === Tile.Rock || m.blocked[ti]) continue;
      const occ = layout.occ[Math.floor(y * R) * W * R + Math.floor(x * R)];
      let c = t === Tile.Dirt ? (urban ? 1 : 2) : 2;
      let fl = 0;
      if (t === Tile.Bridge) c = 2;
      if (occ & OCC_TRACK) {
        c = 1;
        fl |= WF.Track;
      }
      if (occ & OCC_FIELD) {
        c = urban ? 1 : 5;
        fl |= WF.Field;
      }
      if (m.trees[ti]) c = Math.max(c, urban ? 3 : 4);
      if (m.ore[ti] || m.oreKind[ti]) c = Math.max(c, 4);
      if (net && (occ & OCC_ROAD) && onSurface(net, x, y)) {
        c = urban ? 16 : 6;
        fl |= WF.Road;
      }
      for (const st of m.starts)
        if (Math.hypot(x - st.x - 0.5, y - st.y - 0.5) < 12.5) {
          fl |= WF.Base;
          c = Math.max(c, 24);
        }
      if (tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1) fl |= WF.Edge;
      cost[k] = c;
      flag[k] = fl;
    }
  // plazas (flags) and park lawns
  const rect = (x0: number, y0: number, x1: number, y1: number, f: number, c: number) => {
    for (let gy = Math.max(0, Math.floor(y0 * RES)); gy < Math.min(gh, Math.ceil(y1 * RES)); gy++)
      for (let gx = Math.max(0, Math.floor(x0 * RES)); gx < Math.min(gw, Math.ceil(x1 * RES)); gx++) {
        const k = gy * gw + gx;
        if (!cost[k] || flag[k] & WF.Road) continue;
        flag[k] |= f;
        if (!(flag[k] & WF.Base)) cost[k] = Math.min(cost[k], c);
      }
  };
  for (const p of plazas) rect(p.cx - p.hl, p.cy - p.hw, p.cx + p.hl, p.cy + p.hw, WF.Plaza, 1);
  for (const p of parks) rect(p.x0 + 0.4, p.y0 + 0.4, p.x1 - 0.4, p.y1 - 0.4, WF.Park, 2);
  // zebra crossings: cheap again
  for (const z of zebras) {
    const r = z.hl + 0.3;
    for (let gy = Math.max(0, Math.floor((z.y - r) * RES)); gy < Math.min(gh, Math.ceil((z.y + r) * RES)); gy++)
      for (let gx = Math.max(0, Math.floor((z.x - r) * RES)); gx < Math.min(gw, Math.ceil((z.x + r) * RES)); gx++) {
        const px = (gx + 0.5) / RES - z.x;
        const py = (gy + 0.5) / RES - z.y;
        const along = px * z.dx + py * z.dy;
        const across = -px * z.dy + py * z.dx;
        if (Math.abs(along) > z.hl || Math.abs(across) > z.hw + 0.06) continue;
        const k = gy * gw + gx;
        if (!cost[k]) continue;
        flag[k] |= WF.Zebra;
        cost[k] = 1;
      }
  }
  return { w: W, h: H, gw, gh, cost, flag, urban };
}

export function cellOf(g: WalkGrid, x: number, y: number): number {
  const gx = Math.floor(x * RES);
  const gy = Math.floor(y * RES);
  if (gx < 0 || gy < 0 || gx >= g.gw || gy >= g.gh) return -1;
  return gy * g.gw + gx;
}

/** Cost of the cell under (x, y): 0 when closed or off the map. */
export function costAt(g: WalkGrid, x: number, y: number): number {
  const k = cellOf(g, x, y);
  return k < 0 ? 0 : g.cost[k];
}

export function flagAt(g: WalkGrid, x: number, y: number): number {
  const k = cellOf(g, x, y);
  return k < 0 ? 0 : g.flag[k];
}

/**
 * Bounded A* over the walk grid. Reuses its buffers (no allocation per
 * search); `blockedTile(tx, ty)` closes tiles dynamically (sim buildings).
 */
export class PathFinder {
  private g: Float32Array;
  private from: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private hk: Int32Array;
  private hf: Float32Array;
  private hn = 0;
  private cells: Int32Array;
  /** Cells expanded by the last search (tests / perf). */
  expanded = 0;

  constructor(
    readonly grid: WalkGrid,
    readonly maxExpand = 9000,
  ) {
    const n = grid.gw * grid.gh;
    this.g = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.hk = new Int32Array(maxExpand * 8 + 16);
    this.hf = new Float32Array(maxExpand * 8 + 16);
    this.cells = new Int32Array(4096);
  }

  private cost(k: number, panic: boolean, blocked: ((tx: number, ty: number) => boolean) | null): number {
    const g = this.grid;
    const c = g.cost[k];
    if (!c) return 0;
    if (blocked) {
      const gx = k % g.gw;
      const gy = (k / g.gw) | 0;
      if (blocked((gx / RES) | 0, (gy / RES) | 0)) return 0;
    }
    if (!panic) return c;
    const f = g.flag[k];
    // running for it: roads, fields and the base edges all fine
    return f & (WF.Road | WF.Base | WF.Field) ? 2 : Math.min(c, 3);
  }

  private push(k: number, f: number) {
    if (this.hn >= this.hk.length) return;
    let i = this.hn++;
    const hk = this.hk;
    const hf = this.hf;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hk[i] = hk[p];
      hf[i] = hf[p];
      i = p;
    }
    hk[i] = k;
    hf[i] = f;
  }

  private pop(): number {
    const hk = this.hk;
    const hf = this.hf;
    const top = hk[0];
    const n = --this.hn;
    if (n > 0) {
      const lk = hk[n];
      const lf = hf[n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && hf[r] < hf[l] ? r : l;
        if (hf[c] >= lf) break;
        hk[i] = hk[c];
        hf[i] = hf[c];
        i = c;
      }
      hk[i] = lk;
      hf[i] = lf;
    }
    return top;
  }

  /**
   * Path from (x0, y0) to (x1, y1) into `out` (x, y pairs, the start excluded,
   * the goal last); returns the number of points (0: no path within budget).
   */
  find(x0: number, y0: number, x1: number, y1: number, out: Float32Array, panic = false, blocked: ((tx: number, ty: number) => boolean) | null = null): number {
    const G = this.grid;
    const gw = G.gw;
    const s = cellOf(G, x0, y0);
    const t = cellOf(G, x1, y1);
    if (s < 0 || t < 0 || !this.cost(t, panic, blocked)) return 0;
    this.gen++;
    const gen = this.gen;
    const tx = t % gw;
    const ty = (t / gw) | 0;
    const heur = (k: number) => {
      const dx = Math.abs((k % gw) - tx);
      const dy = Math.abs(((k / gw) | 0) - ty);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    };
    this.hn = 0;
    this.g[s] = 0;
    this.from[s] = -1;
    this.stamp[s] = gen;
    this.push(s, heur(s));
    let found = false;
    let n = 0;
    while (this.hn > 0 && n < this.maxExpand) {
      const k = this.pop();
      if (this.closed[k] === gen) continue;
      this.closed[k] = gen;
      n++;
      if (k === t) {
        found = true;
        break;
      }
      const kx = k % gw;
      const ky = (k / gw) | 0;
      const ck = Math.max(1, this.cost(k, panic, blocked));
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = kx + dx;
          const ny = ky + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= G.gh) continue;
          const j = ny * gw + nx;
          if (this.closed[j] === gen) continue;
          const cj = this.cost(j, panic, blocked);
          if (!cj) continue;
          // no corner cutting past closed cells
          if (dx && dy && (!G.cost[ky * gw + nx] || !G.cost[ny * gw + kx])) continue;
          const ng = this.g[k] + (dx && dy ? 1.414 : 1) * (ck + cj) * 0.5;
          if (this.stamp[j] !== gen || ng < this.g[j]) {
            this.stamp[j] = gen;
            this.g[j] = ng;
            this.from[j] = k;
            this.push(j, ng + heur(j));
          }
        }
    }
    this.expanded = n;
    if (!found) return 0;
    // walk back
    let m = 0;
    const cells = this.cells;
    for (let k = t; k >= 0 && m < cells.length; k = this.from[k]) cells[m++] = k;
    // cells[m-1] is the start: simplify with line of sight (never through dearer ground than the path used)
    const maxPts = out.length >> 1;
    let np = 0;
    let a = m - 1;
    while (a > 0 && np < maxPts) {
      let best = a - 1;
      let worst = this.cost(cells[a], panic, blocked);
      for (let j = a - 1; j >= 0; j--) {
        worst = Math.max(worst, this.cost(cells[j], panic, blocked));
        if (a - j > 40) break;
        if (this.los(cells[a], cells[j], worst, panic, blocked)) best = j;
      }
      const c = cells[best];
      out[np * 2] = ((c % gw) + 0.5) / RES;
      out[np * 2 + 1] = (((c / gw) | 0) + 0.5) / RES;
      np++;
      a = best;
    }
    if (np) {
      out[(np - 1) * 2] = x1;
      out[(np - 1) * 2 + 1] = y1;
    }
    return np;
  }

  private los(a: number, b: number, worst: number, panic: boolean, blocked: ((tx: number, ty: number) => boolean) | null): boolean {
    const G = this.grid;
    const gw = G.gw;
    const ax = (a % gw) + 0.5;
    const ay = ((a / gw) | 0) + 0.5;
    const bx = (b % gw) + 0.5;
    const by = ((b / gw) | 0) + 0.5;
    const L = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(L * 2);
    for (let i = 1; i < steps; i++) {
      const x = ax + ((bx - ax) * i) / steps;
      const y = ay + ((by - ay) * i) / steps;
      const k = Math.floor(y) * gw + Math.floor(x);
      const c = this.cost(k, panic, blocked);
      if (!c || c > worst) return false;
    }
    return true;
  }
}
