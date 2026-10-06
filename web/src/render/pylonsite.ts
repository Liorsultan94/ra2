import { Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';

/*
 * Where a power-line tower may stand and whether a span between two towers clears the ground
 * (render/layout.ts, biomelayout.ts and ambient/clearance.ts all place / move towers). Pure.
 */

interface P {
  x: number;
  y: number;
}

/**
 * Can a power-line tower stand at (x, y)? Its four legs splay 0.37 from the centre: every leg on dry,
 * walkable ground above the water line (not just the centre tile: the river bank slopes into the water).
 */
export function pylonFooting(m: GameMap, x: number, y: number): boolean {
  for (let k = 0; k < 9; k++) {
    const r = k === 8 ? 0 : 0.5;
    const px = x + Math.cos((k / 8) * Math.PI * 2) * r;
    const py = y + Math.sin((k / 8) * Math.PI * 2) * r;
    const tx = Math.floor(px);
    const ty = Math.floor(py);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    const i = ty * m.w + tx;
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Bridge || t === Tile.Rock || m.trees[i] || m.blocked[i]) return false;
    if (groundHeight(m, px, py) < WATER_LEVEL + 0.15) return false;
  }
  // and not on a cliff foot or bank: the legs stand on near level ground
  const h = [groundHeight(m, x - 0.4, y - 0.4), groundHeight(m, x + 0.4, y - 0.4), groundHeight(m, x - 0.4, y + 0.4), groundHeight(m, x + 0.4, y + 0.4)];
  return Math.max(...h) - Math.min(...h) < 0.35;
}

/** Does the span a -> b of a power line clear the ground (no rock under it, the lowest wire well above the ground)? */
export function spanClear(m: GameMap, a: P, b: P): boolean {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 0.01) return true;
  const nx = -(b.y - a.y) / L;
  const ny = (b.x - a.x) / L;
  const ha = groundHeight(m, a.x, a.y);
  const hb = groundHeight(m, b.x, b.y);
  const n = Math.ceil(L / 0.25);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    // the lowest wire: arm attach 1.48 above the foot, sagging 0.03 per tile of span
    const wire = ha + (hb - ha) * t + 1.48 - 0.03 * L * 4 * t * (1 - t);
    for (const o of [-0.7, 0, 0.7]) {
      const x = a.x + (b.x - a.x) * t + nx * o;
      const y = a.y + (b.y - a.y) * t + ny * o;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) continue;
      // rock relief rises well above the sim's ground (render/relief.ts): never string a wire over it
      if (m.tiles[ty * m.w + tx] === Tile.Rock) return false;
      if (groundHeight(m, x, y) > wire - 0.6) return false;
    }
  }
  return true;
}

