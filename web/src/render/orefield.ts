import { ORE_MAX, Tile, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';

/*
 * Ore / gem field layout for the renderer (pure, no three.js: unit-tested).
 *
 * The field of a deposit is every tile that holds ore when the battle starts
 * plus the square around its rig where the sim regrows ore (world.ts growOre:
 * rig +-3 tiles). Ore can never appear anywhere else, so this is where the
 * crystals may stand and what render-only props (bushes, scree) keep out of.
 * (The ground stain stays the organic patch of the starting field: growing it
 * to the regrowth square made square stains.)
 */

/** Regrowth reach around a rig (tiles, Chebyshev): world.ts growOre picks rig + int(7) - 3. */
export const REGROW_R = 3;

/** Pieces per tile: gems = one cluster + two sprouts, ore = two rock piles + two nugget groups. */
export const PER_GEM = 3;
export const PER_ORE = 4;

/**
 * Field kind per tile: 0 = none, 1 = ore, 2 = gems. Regrowth tiles take the kind of
 * their rig's tile (as the sim does when it seeds them).
 */
export function oreFieldKinds(m: GameMap): Uint8Array {
  const out = new Uint8Array(m.w * m.h);
  for (let i = 0; i < out.length; i++) if (m.oreKind[i] || m.ore[i]) out[i] = m.oreKind[i] || 1;
  for (const mm of m.oreMines) {
    const kind = m.oreKind[mm.y * m.w + mm.x] || 1;
    for (let y = mm.y - REGROW_R; y <= mm.y + REGROW_R; y++)
      for (let x = mm.x - REGROW_R; x <= mm.x + REGROW_R; x++) {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
        const i = y * m.w + x;
        const t = m.tiles[i];
        if (out[i] || t === Tile.Water || t === Tile.Rock || t === Tile.Bridge) continue;
        out[i] = kind;
      }
  }
  return out;
}

/** 1 where a tile is in a field or within `margin` tiles of one (render-only props keep out). */
export function oreKeepOut(m: GameMap, margin = 1, kinds = oreFieldKinds(m)): Uint8Array {
  const out = new Uint8Array(m.w * m.h);
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      if (!kinds[y * m.w + x]) continue;
      for (let dy = -margin; dy <= margin; dy++)
        for (let dx = -margin; dx <= margin; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < m.w && yy < m.h) out[yy * m.w + xx] = 1;
        }
    }
  return out;
}

/** Is world point (x, z) (tile units) on a keep-out tile? */
export function inKeepOut(m: GameMap, mask: Uint8Array, x: number, z: number): boolean {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  return tx >= 0 && tz >= 0 && tx < m.w && tz < m.h && mask[tz * m.w + tx] === 1;
}

/**
 * Depletion: scale of piece `rank` (0 = the last to go) of a tile holding `amount` ore,
 * 0 = gone. The higher ranks vanish first as the tile is mined; every piece shrinks
 * with the amount and the last one disappears with the last unit.
 */
export function pieceScale(amount: number, rank: number, per: number): number {
  if (!(amount > 0)) return 0;
  const thr = (rank / per) * ORE_MAX * 0.75;
  if (amount <= thr) return 0;
  const s = Math.min(1, (amount - thr) / (ORE_MAX - thr));
  return 0.3 + 0.7 * s;
}

/** One resource piece: tile, rank (depletion order), kind (1 ore, 2 gems), big piece or small one, placement. */
export interface OreSlot {
  tile: number;
  rank: number;
  kind: 1 | 2;
  /** gems: cluster (true) / sprout; ore: rock pile (true) / nuggets. */
  big: boolean;
  x: number;
  z: number;
  rotY: number;
  tiltX: number;
  tiltZ: number;
  scale: number;
}

/** Every piece of every field tile (deterministic). Pieces stay inside their tile. */
export function planOreSlots(m: GameMap, kinds = oreFieldKinds(m)): OreSlot[] {
  const out: OreSlot[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i] as 0 | 1 | 2;
    if (!kind || m.blocked[i]) continue;
    const x = i % m.w;
    const y = (i / m.w) | 0;
    const per = kind === 2 ? PER_GEM : PER_ORE;
    const a0 = hash2(x, y, 700) * Math.PI * 2;
    for (let k = 0; k < per; k++) {
      const big = kind === 2 ? k === 0 : k % 2 === 0;
      // the main piece near the middle, the others around it
      const r = k === 0 ? hash2(x, y, 701) * 0.12 : 0.2 + hash2(x, y, 702 + k) * 0.14;
      const a = a0 + (k * Math.PI * 2) / per + (hash2(x, y, 710 + k) - 0.5) * 0.8;
      const px = Math.min(0.86, Math.max(0.14, 0.5 + Math.cos(a) * r));
      const pz = Math.min(0.86, Math.max(0.14, 0.5 + Math.sin(a) * r));
      const h = hash2(x, y, 720 + k);
      const scale = kind === 2 ? (big ? 0.42 + h * 0.1 : 0.34 + h * 0.12) : big ? 0.36 + h * 0.08 : 0.4 + h * 0.08;
      out.push({
        tile: i,
        rank: k,
        kind: kind as 1 | 2,
        big,
        x: x + px,
        z: y + pz,
        rotY: hash2(x, y, 730 + k) * Math.PI * 2,
        tiltX: (hash2(x, y, 740 + k) - 0.5) * 0.3,
        tiltZ: (hash2(x, y, 750 + k) - 0.5) * 0.3,
        scale,
      });
    }
  }
  return out;
}
