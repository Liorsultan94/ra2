import { groundHeight, type GameMap, WATER_LEVEL } from '../sim/map';
import { fbm, hash2 } from '../sim/rng';
import { biomeLook, type BiomeLook } from './biome';
import { landmarkPlan, type P2 } from './landmarks/plan';

/*
 * The world past the map edge, as numbers (render only, deterministic, no sim).
 *
 * One height function covers everything outside the playable area:
 *  - the near belt (0 .. HZ_MARGIN = 84 units past the edge, drawn by outskirts.ts on a 2 unit
 *    grid): the map's edge height eases into a plain within 10 units, gentle hills from 6 units
 *    out, and every river / canal that touches the edge runs straight on at the edge's depth;
 *  - the far ring (horizon.ts, out to HZ_RADIUS from the map centre): the biome's relief rises
 *    with distance (rolling hills and ridgelines, dunes and mesas, snow-capped mountains), the
 *    rivers meander on in widening valleys, and the water bodies (Canal City's bay, Frontline's
 *    lake) cut in.
 *
 * Meeting this terrain (relief agents: cliffs / ridges at the map edge, rocks.ts / waterside.ts / relief*):
 *  - `edgeHeightAt(map, x, y)` is the outskirts / horizon ground height at any (x, y) outside the map
 *    (inside the map it returns the sim's `groundHeight`). Stand anything outside the map on it.
 *  - The belt starts from `groundHeight` clamped to the map edge, so raising the map's own edge
 *    vertices carries straight out (then eases to the plain over ~10 units).
 *  - To raise the belt itself (a ridge continuing past the edge), set `HORIZON_EDGE.lift` BEFORE the
 *    renderer is built: `(x, y, d) => extra height`, d = distance past the edge. It is added to the near
 *    belt (fades out by d = 84, where the far relief takes over) and both meshes pick it up, so the seams
 *    stay closed. Keep it ~0 within ~45 units on the near (camera) sides if it is tall.
 */

/** How far the outskirts' fine grid reaches past each map edge (outskirts.ts MARGIN). */
export const HZ_MARGIN = 84;
/** Outskirts grid spacing. */
export const HZ_CELL = 2;
/** Outer radius of the far ring (from the map centre). */
export const HZ_RADIUS = 560;

/** Hook for the relief agent (see the header). */
export const HORIZON_EDGE: { lift: ((x: number, y: number, d: number) => number) | null } = { lift: null };

const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const ridged = (x: number, y: number, seed: number) => 1 - Math.abs(fbm(x, y, seed, 4) * 2 - 1);

interface RiverExit {
  /** 0 west, 1 east, 2 north, 3 south. */
  side: number;
  /** Lateral centre along the edge. */
  c: number;
  hw: number;
  amp: number;
  phase: number;
}

export interface Sea {
  /** Seaward unit normal and the along-coast unit vector. */
  nx: number;
  ny: number;
  ux: number;
  uy: number;
  /** Coast distance from the map centre along n. */
  off: number;
  /** Harbour stretch (along-coast u range) and the beach stretch. */
  harbour: [number, number];
  beach: [number, number];
  /** Breakwater: from (u0, v0) to (u1, v1). */
  mole: [number, number, number, number];
}

export interface Lake {
  x: number;
  y: number;
  rx: number;
  ry: number;
  c: number;
  s: number;
}

export interface FarPath {
  pts: P2[];
  width: number;
  kind: 'road' | 'rail';
}

export class HorizonWorld {
  readonly look: BiomeLook;
  readonly code: 0 | 1 | 2 | 3;
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
  readonly rivers: RiverExit[] = [];
  readonly sea: Sea | null = null;
  readonly lakes: Lake[] = [];
  private _paths: FarPath[] | null = null;
  private pathGrid: Map<number, number> | null = null;

  constructor(readonly map: GameMap) {
    this.look = biomeLook(map);
    this.code = this.look.code;
    this.w = map.w;
    this.h = map.h;
    this.cx = map.w / 2;
    this.cy = map.h / 2;
    this.findRivers();
    if (this.code === 3) {
      // Canal City: the canal's two arms (north and west of the NW corner) run out into a bay
      const n = Math.SQRT1_2;
      this.sea = { nx: -n, ny: -n, ux: n, uy: -n, off: 68 + 34, harbour: [44, 150], beach: [-190, -46], mole: [158, -1, 118, 58] };
    }
    if (this.code === 0 && this.rivers.length) {
      // Frontline: the river widens into a lake in the valley downstream
      const r = this.rivers[this.rivers.length - 1];
      const d = 250;
      const p = this.riverPoint(r, d);
      const [ox, oy] = this.sideNormal(r.side);
      const ang = Math.atan2(oy, ox);
      this.lakes.push({ x: p.x + ox * 60, y: p.y + oy * 60, rx: 120, ry: 62, c: Math.cos(ang), s: Math.sin(ang) });
    }
  }

  // ---------------------------------------------------------------- basics

  outside(x: number, y: number) {
    const dx = Math.max(0, -x, x - this.w);
    const dy = Math.max(0, -y, y - this.h);
    return Math.hypot(dx, dy);
  }

  edgeHeight(x: number, y: number) {
    return groundHeight(this.map, Math.max(0, Math.min(this.w - 0.001, x)), Math.max(0, Math.min(this.h - 0.001, y)));
  }

  private sideNormal(side: number): [number, number] {
    return side === 0 ? [-1, 0] : side === 1 ? [1, 0] : side === 2 ? [0, -1] : [0, 1];
  }

  private findRivers() {
    const { w, h } = this;
    for (let side = 0; side < 4; side++) {
      const len = side < 2 ? h : w;
      let run = -1;
      for (let L = 0.25; L <= len; L += 0.5) {
        const x = side === 0 ? 0 : side === 1 ? w : L;
        const y = side === 2 ? 0 : side === 3 ? h : L;
        const wet = L < len - 0.3 && this.edgeHeight(x, y) < WATER_LEVEL + 0.02;
        if (wet && run < 0) run = L;
        if (!wet && run >= 0) {
          if (L - run >= 1.5) {
            const i = this.rivers.length;
            this.rivers.push({ side, c: (run + L - 0.5) / 2, hw: (L - run) / 2, amp: 16 + hash2(i, side, 71) * 22, phase: hash2(i, side, 72) * 6.28 });
          }
          run = -1;
        }
      }
    }
  }

  /** River centre line offset (lateral) at d units past the edge (0 within the near belt). */
  private meander(r: RiverExit, d: number) {
    if (d <= HZ_MARGIN) return 0;
    return r.amp * (Math.sin((d - HZ_MARGIN) * 0.014 + r.phase) - Math.sin(r.phase)) * ss(HZ_MARGIN, HZ_MARGIN + 70, d);
  }

  private riverHalfWidth(r: RiverExit, d: number) {
    return r.hw * (1 + Math.max(0, d - HZ_MARGIN) / 120) + Math.max(0, d - HZ_MARGIN) * 0.012;
  }

  riverPoint(r: RiverExit, d: number): P2 {
    const L = r.c + this.meander(r, d);
    switch (r.side) {
      case 0:
        return { x: -d, y: L };
      case 1:
        return { x: this.w + d, y: L };
      case 2:
        return { x: L, y: -d };
      default:
        return { x: L, y: this.h + d };
    }
  }

  /** Far rivers at (x, y): water 0..1 (in the channel) and valley 0..1 (the flat floor around it). */
  private riverAt(x: number, y: number, out: { water: number; valley: number }) {
    out.water = 0;
    out.valley = 0;
    for (const r of this.rivers) {
      const d = r.side === 0 ? -x : r.side === 1 ? x - this.w : r.side === 2 ? -y : y - this.h;
      if (d < HZ_MARGIN - 14) continue;
      const L = r.side < 2 ? y : x;
      const t = Math.abs(L - r.c - this.meander(r, d));
      const hw = this.riverHalfWidth(r, d);
      const wf = 1 + Math.max(0, d - HZ_MARGIN) / 90;
      out.water = Math.max(out.water, (1 - ss(hw - 0.5, hw + 1.5, t)) * ss(HZ_MARGIN - 12, HZ_MARGIN + 2, d));
      out.valley = Math.max(out.valley, (1 - ss(hw + 2, hw + 2 + 22 * wf, t)) * ss(HZ_MARGIN - 40, HZ_MARGIN, d));
    }
  }

  /** Signed seaward distance (> 0 = sea) and the along-coast coordinate. */
  seaV(x: number, y: number): { v: number; u: number } {
    const s = this.sea!;
    const px = x - this.cx;
    const py = y - this.cy;
    const u = px * s.ux + py * s.uy;
    return { v: px * s.nx + py * s.ny - s.off + coastWiggle(u), u };
  }

  /** World position of along-coast u, seaward v. */
  seaPoint(u: number, v: number): P2 {
    const s = this.sea!;
    const n = v + s.off - coastWiggle(u);
    return { x: this.cx + s.ux * u + s.nx * n, y: this.cy + s.uy * u + s.ny * n };
  }

  /** Lake inside measure: > 0 inside (roughly units from the shore). */
  lakeV(x: number, y: number) {
    let best = -1e9;
    for (const l of this.lakes) {
      const dx = x - l.x;
      const dy = y - l.y;
      const a = (dx * l.c + dy * l.s) / l.rx;
      const b = (-dx * l.s + dy * l.c) / l.ry;
      const e = 1 - Math.sqrt(a * a + b * b);
      best = Math.max(best, e * Math.min(l.rx, l.ry));
    }
    return best;
  }

  /** The biome's far relief above the plain at (x, y), d units past the edge. */
  relief(x: number, y: number, d: number) {
    switch (this.code) {
      case 1: {
        const u = x * 0.82 + y * 0.57;
        const dunes = Math.pow(0.5 + 0.5 * Math.cos(u * 0.2 + fbm(x * 0.011, y * 0.011, 401, 2) * 9), 1.6) * 3.2 * ss(8, 80, d);
        const m = fbm(x * 0.0065, y * 0.0065, 411, 4);
        const mesa = (ss(0.555, 0.585, m) * (12 + fbm(x * 0.02, y * 0.02, 412, 2) * 8) + ss(0.62, 0.64, m) * 9) * ss(70, 150, d);
        const far = Math.pow(ridged(x * 0.004, y * 0.004, 421), 2.2) * 50 * ss(260, 470, d);
        return dunes * (1 - ss(0.5, 0.56, m)) + mesa + far;
      }
      case 2: {
        const hills = Math.max(0, fbm(x * 0.013, y * 0.013, 501, 4) - 0.28) * 34 * ss(18, 170, d);
        const mts = Math.pow(ridged(x * 0.0042, y * 0.0042, 511), 1.7) * 155 * ss(130, 360, d);
        return hills + mts;
      }
      case 3: {
        const hills = Math.max(0, fbm(x * 0.01, y * 0.01, 601, 3) - 0.35) * 22 * ss(90, 250, d);
        const ridge = Math.pow(ridged(x * 0.0042, y * 0.0042, 611), 2) * 60 * ss(240, 450, d);
        return hills + ridge;
      }
      default: {
        const hills = Math.max(0, fbm(x * 0.012, y * 0.012, 301, 4) - 0.3) * 30 * ss(18, 180, d);
        const ridge = Math.pow(ridged(x * 0.0048, y * 0.0048, 311), 2.2) * 80 * ss(170, 400, d);
        return hills + ridge;
      }
    }
  }

  // ---------------------------------------------------------------- height

  /** 1 where the map edge next to this point is under water (rivers flow on past the edge). */
  wetNear(x: number, y: number) {
    const { w, h } = this;
    const ox = x < 0 || x > w;
    const oy = y < 0 || y > h;
    if (ox === oy) return 0;
    let m = 0;
    for (let k = -4; k <= 4; k++) {
      const hh = ox && !oy ? this.edgeHeight(x, y + k) : this.edgeHeight(x + k, y);
      m = Math.max(m, ss(0.05, -0.3, hh) * (1 - Math.abs(k) / 5));
    }
    return m;
  }

  private rv = { water: 0, valley: 0 };

  /** Ground height outside the map (inside: the sim height). See the header. */
  height(x: number, y: number): number {
    const d = this.outside(x, y);
    const base = this.edgeHeight(x, y);
    if (d <= 0) return base - 0.14;
    // near belt: flatten towards a gentle plain, then rolling hills
    const plain = Math.max(base, 0) * (1 - ss(0, 10, d));
    const hills = (fbm(x * 0.035, y * 0.035, 909, 3) - 0.38) * 5.5;
    const near = this.wetNear(x, y);
    let dry = plain + Math.max(-0.2, hills) * ss(6, 46, d) * (1 - near) - 0.14 * (1 - ss(0, 3, d));
    const lift = HORIZON_EDGE.lift;
    if (lift) dry += lift(x, y, d) * (1 - ss(HZ_MARGIN - 20, HZ_MARGIN, d));
    // river beds continue straight out at the edge's depth (then meander on in the far ring)
    const corner = (x < 0 || x > this.w) && (y < 0 || y > this.h);
    const wet = (corner ? 0 : ss(0.0, -0.3, base)) * (1 - ss(HZ_MARGIN - 6, HZ_MARGIN + 10, d));
    const rv = this.rv;
    this.riverAt(x, y, rv);
    // far relief, kept off the river valleys
    const relief = d > 16 ? this.relief(x, y, d) * ss(16, 110, d) * (1 - Math.max(rv.valley, near * (1 - ss(40, 80, d)))) : 0;
    let hgt = (dry + relief) * (1 - wet) + base * wet;
    if (d > HZ_MARGIN - 14) {
      if (rv.water > 0) hgt = hgt + (WATER_LEVEL - 0.55 - hgt) * rv.water;
      // dry land stays well clear of the far water sheet (depth precision far from the camera)
      else if (d > HZ_MARGIN) hgt = Math.max(hgt, WATER_LEVEL + 0.12 + ss(HZ_MARGIN, HZ_MARGIN + 40, d) * 0.4);
    }
    // the bay
    if (this.sea) {
      const { v, u } = this.seaV(x, y);
      if (v > 0) return WATER_LEVEL - 0.3 - Math.min(v * 0.07, 3.5);
      const s = this.sea;
      const inHarbour = u > s.harbour[0] && u < s.harbour[1];
      if (inHarbour) {
        // the container yard: flat, quay wall at the water
        const k = 1 - ss(-48, -38, v);
        hgt += (0.35 - hgt) * k;
      } else if (v > -26) {
        // beach / promenade sloping down to the water
        const bh = WATER_LEVEL + 0.18 + -v * 0.06;
        hgt += (bh - hgt) * (1 - ss(-24, -2, v));
      }
    }
    if (this.lakes.length) {
      const lv = this.lakeV(x, y);
      if (lv > 0) return WATER_LEVEL - 0.3 - Math.min(lv * 0.05, 3);
      if (lv > -18) {
        const bh = WATER_LEVEL + 0.15 + -lv * 0.05;
        hgt += (bh - hgt) * (1 - ss(-18, -1, lv));
      }
    }
    return hgt;
  }

  /** Is (x, y) under open water (far river, bay or lake)? */
  isWater(x: number, y: number) {
    return this.height(x, y) < WATER_LEVEL + 0.02;
  }

  /** Slope magnitude (rise per unit) of the height field around (x, y). */
  slope(x: number, y: number, e = 2) {
    const hx = this.height(x + e, y) - this.height(x - e, y);
    const hy = this.height(x, y + e) - this.height(x, y - e);
    return Math.hypot(hx, hy) / (2 * e);
  }

  // ---------------------------------------------------------------- roads / railways leaving the map

  /** Roads and railways continued from where they leave the map (or the outskirts lanes end) out towards the horizon. */
  get paths(): FarPath[] {
    if (!this._paths) this._paths = this.buildPaths();
    return this._paths;
  }

  private buildPaths(): FarPath[] {
    const out: FarPath[] = [];
    const plan = landmarkPlan(this.map);
    const starts: { p: P2; dx: number; dy: number; width: number; kind: 'road' | 'rail'; seed: number }[] = [];
    const push = (p: P2, q: P2, width: number, kind: 'road' | 'rail') => {
      const l = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      starts.push({ p, dx: (p.x - q.x) / l, dy: (p.y - q.y) / l, width, kind, seed: starts.length });
    };
    // outskirts lanes (render-only roads that already run on past the edge): continue from their far end
    for (const l of plan.lanes) {
      const a = l.pts[l.pts.length - 1];
      const b = l.pts[Math.max(0, l.pts.length - 4)];
      if (this.outside(a.x, a.y) < 6) continue; // a short works lane
      push(a, b, l.width, 'road');
    }
    for (const r of plan.rails) {
      if (r.elevated) continue;
      const n = r.pts.length;
      push(r.pts[0], r.pts[Math.min(n - 1, 4)], 1.1, 'rail');
      push(r.pts[n - 1], r.pts[Math.max(0, n - 5)], 1.1, 'rail');
    }
    // the map's own roads that end at the edge (not already continued by a lane)
    if (this.code !== 3) {
      const st = this.map.deco?.roadStyles;
      this.map.roads.forEach((rd, i) => {
        for (const end of [0, 1]) {
          const a = end ? rd[rd.length - 1] : rd[0];
          const b = end ? rd[Math.max(0, rd.length - 3)] : rd[Math.min(rd.length - 1, 2)];
          if (!a || !b) continue;
          const ex = Math.min(a.x, this.w - a.x, a.y, this.h - a.y);
          if (ex > 1.2) continue;
          if (plan.lanes.some((l) => Math.hypot(l.pts[0].x - a.x, l.pts[0].y - a.y) < 6)) continue;
          // step out to the edge itself
          const p = { x: a.x < 1.2 ? 0 : a.x > this.w - 1.2 ? this.w : a.x, y: a.y < 1.2 ? 0 : a.y > this.h - 1.2 ? this.h : a.y };
          const w0 = st?.[i]?.width ?? 0.9;
          push(p, { x: p.x - (a.x - b.x), y: p.y - (a.y - b.y) }, w0, 'road');
        }
      });
    }
    for (const s of starts) {
      const pts: P2[] = [s.p];
      let x = s.p.x;
      let y = s.p.y;
      let ang = Math.atan2(s.dy, s.dx);
      // the first stretch runs straight out of the edge, then the road wanders, preferring the low ground
      for (let k = 0; k < 400; k++) {
        const d = this.outside(x, y);
        const step = d < 30 ? 2 : d < 120 ? 3 : 5;
        if (d > 22) {
          ang += (fbm(k * 0.05, s.seed * 3.1, 931 + s.seed, 2) - 0.5) * 0.09;
          const la = 16;
          const hl = this.height(x + Math.cos(ang - 0.35) * la, y + Math.sin(ang - 0.35) * la);
          const hr = this.height(x + Math.cos(ang + 0.35) * la, y + Math.sin(ang + 0.35) * la);
          if (Math.abs(hl - hr) > 1.5) ang += hl < hr ? -0.06 : 0.06;
          // never turn back towards the map
          const ox = x - this.cx;
          const oy = y - this.cy;
          const out = (Math.cos(ang) * ox + Math.sin(ang) * oy) / (Math.hypot(ox, oy) || 1);
          if (out < 0.35) ang += Math.sign(Math.cos(ang) * -oy + Math.sin(ang) * ox) * -0.08;
        }
        x += Math.cos(ang) * step;
        y += Math.sin(ang) * step;
        if (Math.hypot(x - this.cx, y - this.cy) > HZ_RADIUS * 0.9) break;
        if (this.sea && this.seaV(x, y).v > -3) break;
        if (this.lakes.length && this.lakeV(x, y) > -3) break;
        pts.push({ x, y });
      }
      if (pts.length > 3) out.push({ pts, width: s.width, kind: s.kind });
    }
    return out;
  }

  /** Is (x, y) within `pad` of a far road / railway (outskirts trees, towns and forests keep off)? */
  nearPath(x: number, y: number, pad = 1.5): boolean {
    if (!this.pathGrid) {
      const g = new Map<number, number>();
      for (const p of this.paths)
        for (let i = 1; i < p.pts.length; i++) {
          const a = p.pts[i - 1];
          const b = p.pts[i];
          const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1);
          for (let k = 0; k <= n; k++) {
            const px = a.x + ((b.x - a.x) * k) / n;
            const py = a.y + ((b.y - a.y) * k) / n;
            const key = (Math.floor(px / 2) + 1000) * 4000 + Math.floor(py / 2) + 1000;
            g.set(key, Math.max(g.get(key) ?? 0, p.width));
          }
        }
      this.pathGrid = g;
    }
    const r = Math.ceil(pad / 2) + 1;
    const gx = Math.floor(x / 2);
    const gy = Math.floor(y / 2);
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        const v = this.pathGrid.get((gx + i + 1000) * 4000 + gy + j + 1000);
        if (v !== undefined && Math.hypot((gx + i + 0.5) * 2 - x, (gy + j + 0.5) * 2 - y) < pad + v / 2 + 1.4) return true;
      }
    return false;
  }
}

/** Gentle bends of the bay's coast (same formula in the water shader). */
export function coastWiggle(u: number) {
  return 4 * Math.sin(u * 0.045) + 2.5 * Math.sin(u * 0.13 + 1.0);
}

const worlds = new WeakMap<GameMap, HorizonWorld>();

/** The map's horizon world (memoised). */
export function horizonWorld(m: GameMap): HorizonWorld {
  let w = worlds.get(m);
  if (!w) worlds.set(m, (w = new HorizonWorld(m)));
  return w;
}

/** Ground height of the outskirts / horizon terrain at (x, y) (see the header). */
export function edgeHeightAt(m: GameMap, x: number, y: number): number {
  const w = horizonWorld(m);
  if (x >= 0 && y >= 0 && x <= m.w && y <= m.h) return groundHeight(m, Math.min(m.w - 0.001, x), Math.min(m.h - 0.001, y));
  return w.height(x, y);
}
