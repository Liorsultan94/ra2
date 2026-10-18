import type { GameMap, Structure } from '../sim/map';

/*
 * The Sinai's towns (SN1) look different while they play the same (their houses mirror each other): the
 * Egyptian canal town at the west crossing whitewashed, with blue, green and turquoise shutters; the Arabian
 * town at the east crossing in warm sandstone and ochre with terracotta, brass and dark wood; Sharm el-Sheikh on
 * the southern tip with the whole coastal palette. Other maps keep their one palette (style 2).
 */

/** Wall colours per town style: the Egyptian canal town, the Arabian town, Sharm. */
export const TOWN_WALLS: number[][] = [
  [0xf3efe6, 0xeee2c8, 0xf2e0c8, 0xf7f3ea, 0xeadfd0, 0xe8e2d8, 0xf0e8da],
  [0xe9d4ac, 0xe4d2ae, 0xdcc8a0, 0xdfb57e, 0xe6c28e, 0xd8b890, 0xd2b48a],
  [0xf3efe6, 0xeee2c8, 0xe9d4ac, 0xf2e0c8, 0xe4d2ae, 0xf7f3ea, 0xdcc8a0, 0xeadfd0, 0xdfb57e, 0xe6c28e],
];
/** Shutter, door and awning colours per town style (linear RGB). */
export const TOWN_ACCENTS: [number, number, number][][] = [
  [
    [0.18, 0.4, 0.66],
    [0.16, 0.56, 0.56],
    [0.24, 0.46, 0.3],
    [0.14, 0.3, 0.52],
  ],
  [
    [0.7, 0.36, 0.22],
    [0.85, 0.66, 0.28],
    [0.16, 0.56, 0.56],
    [0.42, 0.3, 0.2],
  ],
  [
    [0.18, 0.4, 0.66],
    [0.16, 0.56, 0.56],
    [0.24, 0.46, 0.3],
    [0.7, 0.36, 0.22],
    [0.85, 0.66, 0.28],
  ],
];

/** Style of a structure's town: 0 the Egyptian (west) one, 1 the Arabian (east) one, 2 Sharm and every other map's. */
export function townStyle(m: GameMap, st: Structure): 0 | 1 | 2 {
  if (m.mirror !== 'transpose') return 2;
  const cx = st.x + st.w / 2;
  const cy = st.y + st.h / 2;
  // (the southern tip: Sharm)
  if ((cx + cy) / Math.SQRT2 > m.w * 0.95) return 2;
  return cx < cy ? 0 : 1;
}
