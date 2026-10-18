// Slopes (SL1): how steep a step between two neighbouring tiles may be for each way of moving.
//
// Heights are vertex heights (map.ts GameMap.heights, (w + 1) x (h + 1)) in tile units: the renderer draws
// one height unit as tall as a tile is wide, so rise / run is the real grade (0.5 = 26.6 degrees).
//
// A step goes from a tile's centre over the shared edge (orthogonal) or the shared corner (diagonal) to the
// neighbour's centre. Its grade is the steeper of its two halves: the tile centre (the mean of its four
// corners) to the edge midpoint (the mean of the edge's two vertices) or the corner vertex, and on to the
// other centre. Half steps catch a cliff band that a centre-to-centre average would smooth over.
//
// The rule is per edge, not per tile: a unit can stand on a ramp tile and still not step off its side down
// the cliff. Every edge is classified once per map (slopeField) into a bit mask per locomotion class, so
// the per-tick checks are plain bit tests and nothing depends on floating point after the map is built.
//
// Limits (rise / run of either half step), tuned so the maps' tracks and footpaths pass and the cliffs and
// mountain flanks do not:
// - vehicles (tracked and wheeled alike: the sim has no wheeled class) 0.53, about 28 degrees: about what a
//   tank or a truck crawls up on loose ground;
// - infantry 0.83, about 40 degrees: soldiers scramble up scree and rock steps a vehicle cannot take;
// - aircraft (and boats, should there ever be any) ignore slopes.
// Bridge decks and their head ramps are exempt: the deck's own ramps grade the approach (render/deckramp.ts).

import { Tile, onBridgeHead, type GameMap } from './map';

/** Ways of moving on the ground that slopes limit. */
export const enum Loco {
  Foot = 0,
  Vehicle = 1,
}
export const LOCO_COUNT = 2;

/** Steepest grade (rise / run of a half step) each locomotion class takes. */
export const MAX_GRADE: readonly number[] = [0.83, 0.53];

/**
 * Extra path cost per height unit climbed (tile units): a climb of h costs as much as h * CLIMB_COST tiles more
 * of level ground. Downhill is free. Units take the gentler of two routes when it is not much longer.
 */
export const CLIMB_COST = 1.25;

/** Neighbour order shared with the path finder (path.ts): 4 orthogonal, then 4 diagonal. */
export const DX = [1, -1, 0, 0, 1, 1, -1, -1];
export const DY = [0, 0, 1, -1, 1, -1, 1, -1];
/** The opposite direction of each neighbour. */
export const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
/** Each neighbour's direction mirrored across the x == y diagonal ((dx, dy) -> (dy, dx)). */
export const TRANS_DIR = [2, 3, 0, 1, 4, 6, 5, 7];

/** Index of the neighbour (dx, dy) in DX / DY (-1: not a neighbour). */
export function dirOf(dx: number, dy: number): number {
  for (let k = 0; k < 8; k++) if (DX[k] === dx && DY[k] === dy) return k;
  return -1;
}

export interface SlopeField {
  /** Per locomotion class, per tile: bit k set = the step towards neighbour k is too steep (or off the map). */
  block: Uint8Array[];
  /** Per tile and neighbour (index * 8 + k): extra path cost of the step (CLIMB_COST x the rise, 0 downhill). */
  climb: Float32Array;
  /** Per tile and neighbour: the step's grade (rise / run of the steeper half), for tests and the debug overlay. */
  grade: Float32Array;
}

/** Grade of the step from tile (x, y) to neighbour k (both on the map). */
export function stepGrade(m: GameMap, x: number, y: number, k: number): number {
  const W1 = m.w + 1;
  const H = m.heights;
  const v = (vx: number, vy: number) => H[vy * W1 + vx];
  const dx = DX[k];
  const dy = DY[k];
  const nx = x + dx;
  const ny = y + dy;
  const a = (v(x, y) + v(x + 1, y) + v(x, y + 1) + v(x + 1, y + 1)) * 0.25;
  const b = (v(nx, ny) + v(nx + 1, ny) + v(nx, ny + 1) + v(nx + 1, ny + 1)) * 0.25;
  let mid: number;
  let half: number;
  if (dx !== 0 && dy !== 0) {
    mid = v(x + (dx > 0 ? 1 : 0), y + (dy > 0 ? 1 : 0));
    half = Math.SQRT1_2;
  } else if (dx !== 0) {
    const vx = x + (dx > 0 ? 1 : 0);
    mid = (v(vx, y) + v(vx, y + 1)) * 0.5;
    half = 0.5;
  } else {
    const vy = y + (dy > 0 ? 1 : 0);
    mid = (v(x, vy) + v(x + 1, vy)) * 0.5;
    half = 0.5;
  }
  return Math.max(Math.abs(mid - a), Math.abs(b - mid)) / half;
}

/** Mean height of a tile's four corners. */
export function tileCentreHeight(m: GameMap, x: number, y: number): number {
  const W1 = m.w + 1;
  const H = m.heights;
  const i = y * W1 + x;
  return (H[i] + H[i + 1] + H[i + W1] + H[i + W1 + 1]) * 0.25;
}

/**
 * Classify every step on the map once. A diagonal step also needs both orthogonal steps round each of its
 * corner tiles to be within the limit (no slipping past a cliff's corner), as the path finder never cuts a
 * corner past an impassable tile either. Point symmetric on a point symmetric map (the grade of a step and
 * of its mirror are computed from the same vertex heights).
 */
export function slopeField(m: GameMap): SlopeField {
  const { w: W, h: H } = m;
  const n = W * H;
  const grade = new Float32Array(n * 8);
  const climb = new Float32Array(n * 8);
  const block = Array.from({ length: LOCO_COUNT }, () => new Uint8Array(n));
  const head = new Uint8Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (m.tiles[i] === Tile.Bridge || (m.bridges.length && onBridgeHead(m, x, y))) head[i] = 1;
    }
  const ch = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ch[y * W + x] = tileCentreHeight(m, x, y);
  // orthogonal steps first (diagonals look at them); after each pass the steps of the half with the lower tile
  // indices are made the exact mirror of the other half's (the maps are point symmetric, their heights to within
  // float noise: a step right at a limit must not open on one side and close on the other)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        for (let k = pass * 4; k < pass * 4 + 4; k++) {
          const nx = x + DX[k];
          const ny = y + DY[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
            for (let c = 0; c < LOCO_COUNT; c++) block[c][i] |= 1 << k;
            continue;
          }
          const j = ny * W + nx;
          // bridge decks and their head ramps: the deck's ramps grade the approach
          const g = head[i] && head[j] ? 0 : stepGrade(m, x, y, k);
          grade[i * 8 + k] = g;
          climb[i * 8 + k] = Math.max(0, ch[j] - ch[i]) * CLIMB_COST;
          for (let c = 0; c < LOCO_COUNT; c++) {
            let bad = g > MAX_GRADE[c];
            if (k >= 4 && !bad) {
              // the corner tiles: (x + dx, y) and (x, y + dy), each reached from here and left towards j
              const kx = DX[k] > 0 ? 0 : 1;
              const ky = DY[k] > 0 ? 2 : 3;
              const bx = block[c][i] >> kx;
              const by = block[c][i] >> ky;
              const cxI = y * W + nx;
              const cyI = ny * W + x;
              bad = !!((bx | by | (block[c][cxI] >> ky) | (block[c][cyI] >> kx)) & 1);
            }
            if (bad) block[c][i] |= 1 << k;
          }
        }
      }
    const trans = m.mirror === 'transpose';
    for (let i = 0; i < n; i++) {
      // (transposed halves: tile (x, y) mirrors (y, x) and a step's direction swaps its axes, TRANS_DIR)
      const im = trans ? (i % W) * W + ((i / W) | 0) : n - 1 - i;
      if (im <= i) continue;
      for (let k = pass * 4; k < pass * 4 + 4; k++) {
        const km = trans ? TRANS_DIR[k] : OPP[k];
        if (Math.abs(grade[i * 8 + k] - grade[im * 8 + km]) > 1e-3) continue;
        grade[i * 8 + k] = grade[im * 8 + km];
        climb[i * 8 + k] = climb[im * 8 + km];
        for (let c = 0; c < LOCO_COUNT; c++) block[c][i] = (block[c][i] & ~(1 << k)) | (((block[c][im] >> km) & 1) << k);
      }
    }
  }
  return { block, climb, grade };
}

/** Locomotion class of a ground unit (aircraft: -1, no slope rule). */
export function locoOf(d: { category: string; air?: boolean }): number {
  if (d.air) return -1;
  return d.category === 'infantry' ? Loco.Foot : Loco.Vehicle;
}

/**
 * Connected regions of passable tiles for one locomotion class (4-neighbour flood fills over steps within its
 * grade limit, numbered from 1; 0 = impassable). The path finder moves diagonally only past two open corner
 * steps, so 4-connectivity is its connectivity.
 */
export function groundRegions(w: number, h: number, pass: Uint8Array, block?: Uint8Array): Uint16Array {
  const reg = new Uint16Array(w * h);
  let n = 0;
  const q: number[] = [];
  const off = [1, -1, w, -w];
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!pass[i0] || reg[i0]) continue;
    reg[i0] = ++n;
    q.push(i0);
    while (q.length) {
      const t = q.pop()!;
      const x = t % w;
      const bl = block ? block[t] : 0;
      for (let k = 0; k < 4; k++) {
        if (bl & (1 << k)) continue;
        if ((k === 0 && x === w - 1) || (k === 1 && x === 0)) continue;
        const j = t + off[k];
        if (j < 0 || j >= w * h || !pass[j] || reg[j]) continue;
        reg[j] = n;
        q.push(j);
      }
    }
  }
  return reg;
}
