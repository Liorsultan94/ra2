import type { GameMap } from '../../sim/map';
import { surfaceHeight } from '../ground';
import { OUTSKIRTS_GRID, outskirtsHeight } from '../outskirts';
import { reliefEnabled, reliefHeight } from '../relief';

const RELIEF = reliefEnabled();

/*
 * Ground height for set pieces inside and beyond the map: the drawn terrain
 * inside, the outskirts mesh outside (interpolated between its control
 * points the way the mesh is, so things sit on it). Cached per map.
 */

const cache = new WeakMap<GameMap, Map<number, number>>();

function grid(m: GameMap, i: number, j: number): number {
  let c = cache.get(m);
  if (!c) cache.set(m, (c = new Map()));
  const k = i * 4096 + j;
  let v = c.get(k);
  if (v === undefined) {
    v = outskirtsHeight(m, OUTSKIRTS_GRID.origin + i * OUTSKIRTS_GRID.cell, OUTSKIRTS_GRID.origin + j * OUTSKIRTS_GRID.cell);
    c.set(k, v);
  }
  return v;
}

/** Height of the drawn ground at (x, y) in tile space (inside: the terrain; outside: the outskirts mesh). */
export function groundY(m: GameMap, x: number, y: number): number {
  // (inside: on the relief's cliffs where they rise over the rock: the castle ruin, the fort, the mast stand on top)
  if (x >= 0.3 && y >= 0.3 && x <= m.w - 0.3 && y <= m.h - 0.3) return RELIEF ? Math.max(surfaceHeight(m, x, y), reliefHeight(m, x, y)) : surfaceHeight(m, x, y);
  const g = OUTSKIRTS_GRID;
  const fx = (x - g.origin) / g.cell;
  const fy = (y - g.origin) / g.cell;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  // the mesh's triangles: (a, c, b) and (b, c, d) with a = (i, j), b = (i + 1, j), c = (i, j + 1), d = (i + 1, j + 1)
  const a = grid(m, i, j);
  const b = grid(m, i + 1, j);
  const c = grid(m, i, j + 1);
  const d = grid(m, i + 1, j + 1);
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

/** Lowest / highest ground over a disc (footprint foundations). */
export function groundRange(m: GameMap, x: number, y: number, r: number): { lo: number; hi: number } {
  let lo = 1e9;
  let hi = -1e9;
  const n = Math.max(1, Math.ceil(r / 0.7));
  for (let a = -n; a <= n; a++)
    for (let b = -n; b <= n; b++) {
      const dx = (a / n) * r;
      const dy = (b / n) * r;
      if (dx * dx + dy * dy > r * r * 1.05) continue;
      const h = groundY(m, x + dx, y + dy);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  return { lo, hi };
}
