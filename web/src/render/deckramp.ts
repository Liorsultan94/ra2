import { BRIDGE_HEIGHT, Tile, standHeight, type GameMap } from '../sim/map';
import { surfaceHeight } from './ground';

/**
 * Where a bridge deck meets a bank that sits higher than the deck (Frontline's plateau banks, the
 * raised city quays), the deck's last stretch rises to sit on the bank instead of running into it,
 * and the approach roads come down to meet the deck's end exactly. One height profile per bridge,
 * shared by the deck (bridgefx.ts), the road ribbons (scenery.ts, ambient/roadfurniture.ts) and
 * the cars (ambient/traffic.ts), so they all agree.
 *
 * Bridge-local frame (as bridgefx.ts builds it): x along the deck from ends[0] (x = -L/2) to
 * ends[1] (x = +L/2), z across; world = (br.x + (x + z)·√½, br.y + (z − x)·√½).
 */

export const DECK_W = 2.1;
/** Approach roads ramp onto the deck over this many tiles. */
export const RAMP_RUN = 2.2;
const STEP = 0.05;
const D = Math.SQRT1_2;

export interface DeckRamp {
  x: number;
  y: number;
  L: number;
  /** extra deck height (above BRIDGE_HEIGHT) every STEP from x = -L/2 */
  lift: Float32Array;
}

const cache = new WeakMap<GameMap, DeckRamp[]>();

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The bridges' deck profiles (cached per map). */
export function deckRamps(m: GameMap): DeckRamp[] {
  let r = cache.get(m);
  if (r) return r;
  r = m.bridges.map((br) => {
    const L = br.length;
    const n = Math.round(L / STEP) + 1;
    // how far the ground (plus a road's thickness) reaches above the deck top across its width
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = -L / 2 + i * STEP;
      let h = 0;
      for (let z = -DECK_W / 2 - 0.05; z <= DECK_W / 2 + 0.051; z += 0.1) {
        const g = surfaceHeight(m, Math.max(0, Math.min(m.w - 0.01, br.x + (x + z) * D)), Math.max(0, Math.min(m.h - 0.01, br.y + (z - x) * D)));
        h = Math.max(h, g + 0.035 - BRIDGE_HEIGHT);
      }
      need[i] = h > 0.01 ? h : 0;
    }
    // a smooth hump over every point that needs it, eased out at no more than ~1 in 2
    const lift = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const h = need[j];
      if (!h) continue;
      const R = 0.35 + h / 0.42;
      const k0 = Math.max(0, Math.floor(j - R / STEP));
      const k1 = Math.min(n - 1, Math.ceil(j + R / STEP));
      for (let k = k0; k <= k1; k++) lift[k] = Math.max(lift[k], h * smooth(1 - (Math.abs(k - j) * STEP) / R));
    }
    return { x: br.x, y: br.y, L, lift };
  });
  cache.set(m, r);
  return r;
}

/** Deck lift (above BRIDGE_HEIGHT) at bridge-local x. */
export function deckLift(d: DeckRamp, x: number): number {
  const f = Math.max(0, Math.min(d.lift.length - 1.001, (x + d.L / 2) / STEP));
  const i = Math.floor(f);
  const t = f - i;
  return d.lift[i] * (1 - t) + d.lift[i + 1] * t;
}

/**
 * Height of a road ribbon point at tile (x, y) over ground `g`, `base` above the ground away from
 * bridges: within RAMP_RUN of a deck end the road rises (or keeps level) to meet the deck's top
 * at its end, across the deck's whole width.
 */
export function rampHeight(m: GameMap, x: number, y: number, g: number, base: number): number {
  let h = g + base;
  for (const d of deckRamps(m)) {
    const dx = x - d.x;
    const dz = y - d.y;
    if (Math.abs(dx) > d.L / 2 + RAMP_RUN + 2 || Math.abs(dz) > d.L / 2 + RAMP_RUN + 2) continue;
    const lx = (dx - dz) * D;
    const lz = (dx + dz) * D;
    const out = Math.max(0, Math.abs(lx) - d.L / 2);
    const side = Math.max(0, Math.abs(lz) - DECK_W / 2 + 0.15);
    const dist = Math.hypot(out, side);
    if (dist >= RAMP_RUN) continue;
    const top = BRIDGE_HEIGHT + 0.014 + deckLift(d, Math.sign(lx) * d.L / 2);
    const k = Math.min(1, (1 - dist / RAMP_RUN) * 1.15);
    h = Math.max(h, g + (top - g) * k);
  }
  return h;
}

/**
 * The drivable surface under a car near a bridge: the deck (with its end ramps) or the ramped
 * approach road; null away from bridges (or on a deck that is down, `down(i)`).
 */
export function deckSurface(m: GameMap, x: number, y: number, down?: (i: number) => boolean): number | null {
  const ds = deckRamps(m);
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    const dx = x - d.x;
    const dz = y - d.y;
    if (Math.abs(dx) > d.L / 2 + RAMP_RUN + 1 || Math.abs(dz) > d.L / 2 + RAMP_RUN + 1) continue;
    const lx = (dx - dz) * D;
    const lz = (dx + dz) * D;
    if (Math.abs(lz) > DECK_W / 2 + 0.4) continue;
    if (Math.abs(lx) <= d.L / 2) return down?.(i) ? null : BRIDGE_HEIGHT + deckLift(d, lx);
    if (Math.abs(lx) < d.L / 2 + RAMP_RUN) {
      const g = surfaceHeight(m, Math.max(0, Math.min(m.w - 0.01, x)), Math.max(0, Math.min(m.h - 0.01, y)));
      return rampHeight(m, x, y, g, 0) - 0.01;
    }
  }
  return null;
}

/**
 * Height a ground unit is drawn at (render only): the sim's standHeight, except on a standing
 * bridge's tiles, where it follows the deck with its end ramps (deckSurface), so units ride up
 * onto a raised bank instead of sinking into the ramp. The sim keeps BRIDGE_HEIGHT; never lower
 * than it. (x, y) must lie on the map.
 */
export function unitStandHeight(m: GameMap, x: number, y: number): number {
  const h = standHeight(m, x, y);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || m.tiles[ty * m.w + tx] !== Tile.Bridge || !m.bridges.length) return h;
  const d = deckSurface(m, x, y);
  return d === null ? h : Math.max(h, d);
}
