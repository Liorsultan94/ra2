import { Tile, type GameMap } from './map';
import { tileDepth } from './naval';
import { DX, DY } from './slope';
import { unitDef } from './defs';
import type { SubmergeRule } from './submerge';
import type { Entity } from './types';
import type { World } from './world';

/*
 * NV3, the Combat Diver: a soldier that swims. Unlocked by the Shipyard, built in the Barracks like any soldier.
 *
 * Moving (slope.ts Loco.Swim): the diver walks land by the infantry's slope rule and swims every water tile (the
 * shallows, the reef flats, the deep sea) with no slope rule at all; it never stands inside a structure. A move
 * order over water is simply a path through it: from a beach across the sea to another shore, to an island no
 * walker can reach (the Tiran lighthouse's).
 *
 * Diving (one simple rule, a function of where the diver is): in water at least DIVE_DEPTH deep it is
 * SUBMERGED. Submerged it is out of sight of enemies (a bubble trail is all the picture shows), nothing but a
 * naval weapon can hurt it, enemy boats and ships within SONAR_RANGE tiles pick it up, and it cannot shoot, so it
 * does not pick fights: it swims on. In the shallows (the reef flats, the first tiles off a beach) and on land it is
 * on the surface and fights like a rifleman (the same rifle); an attack order on something it cannot yet shoot at
 * from the deep water brings it closer, to the shallows. It is a function of the tile only, so it is the same on
 * every client.
 */

/** Water at least this deep (height units below the waterline, naval.ts tileDepth) hides a diver. The reef flats are 0.07-0.25. */
export const DIVE_DEPTH = 0.3;
/** Enemy ships and boats this close pick up a submerged diver (their sonar). */
export const SONAR_RANGE = 5;
/** Speed factors: fins under water, wading in the shallows. */
export const DIVER_SWIM = 1.25;
export const DIVER_WADE = 0.9;

/** The diver's slope blocks: the infantry's over land, none for a step in or out of water. */
export function swimBlock(m: GameMap, foot: Uint8Array): Uint8Array {
  const { w: W, h: H } = m;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (m.tiles[i] === Tile.Water) continue;
    const x = i % W;
    const y = (i / W) | 0;
    let bits = 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      // (off the map: blocked, as for the soldier; a water neighbour: open)
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) bits |= foot[i] & (1 << k);
      else if (m.tiles[ny * W + nx] !== Tile.Water) bits |= foot[i] & (1 << k);
    }
    out[i] = bits;
  }
  return out;
}

export function isDiver(e: Entity): boolean {
  return e.kind === 'unit' && !!unitDef(e.def).swim;
}

/** Is the diver submerged (a function of its tile only: in water at least DIVE_DEPTH deep, not inside a transport)? */
function submerged(w: World, e: Entity): boolean {
  if (e.inside >= 0) return false;
  const tx = Math.floor(e.x);
  const ty = Math.floor(e.y);
  return tx >= 0 && ty >= 0 && tx < w.map.w && ty < w.map.h && w.map.tiles[ty * w.map.w + tx] === Tile.Water && tileDepth(w.map, tx, ty) >= DIVE_DEPTH;
}

/** Is the diver in water at all (submerged or wading)? */
export function inWater(w: World, e: Entity): boolean {
  const tx = Math.floor(e.x);
  const ty = Math.floor(e.y);
  return tx >= 0 && ty >= 0 && tx < w.map.w && ty < w.map.h && w.map.tiles[ty * w.map.w + tx] === Tile.Water;
}

/** A diver's speed relative to the soldier's: fins under water, wading slower, the soldier's pace on land. */
export function diverSpeed(w: World, e: Entity): number {
  if (e.dive) return DIVER_SWIM;
  return inWater(w, e) ? DIVER_WADE : 1;
}

/** Is a submerged diver picked up by the sonar of `viewer`'s ships and boats (allies' too)? */
function sonarSees(w: World, viewer: number, e: Entity): boolean {
  let seen = false;
  w.queryRadius(e.x, e.y, SONAR_RANGE, (o) => {
    if (seen || o.dead || o.kind !== 'unit' || o.owner < 0 || w.isEnemy(viewer, o.owner)) return;
    if (unitDef(o.def).category === 'naval' && Math.hypot(o.x - e.x, o.y - e.y) <= SONAR_RANGE) seen = true;
  });
  return seen;
}

/** The diver's rule for the submerged-unit layer (submerge.ts): the depth rule, ships' sonar, ships' guns, no fire. */
export const DIVER_RULE: SubmergeRule = {
  update: submerged,
  spotted: sonarSees,
  // (only ships and boats: their guns and missiles; nothing on land or in the air)
  hurtBy: (src) => src.kind === 'unit' && unitDef(src.def).category === 'naval',
  fires: false,
};
