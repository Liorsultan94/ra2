import { unitDef } from './defs';
import { TPS, type Entity } from './types';
import type { SubmergeRule } from './submerge';
import type { World } from './world';

/*
 * NV4 submarines (nuclear: USA, Russia, China; conventional: Israel, Germany, Korea, Turkey). The owner's rules, exactly:
 *
 *   - Submerged = invisible to the enemy. Only its owner (and allies) see it. The enemy cannot see it, target it or
 *     hit it, not even with an area attack (World.sees / World.damage through submerge.ts).
 *   - Ordered to attack (or auto-engaging), it takes 5 s to come up. Surfaced it is visible and any weapon that can reach
 *     a surface ship can hit it, for as long as it keeps attacking.
 *   - When it stops attacking (target dead or lost, order cancelled) it takes 5 s to dive, then it vanishes again.
 *   - Only submarines see submerged submarines, always: so a submarine can always attack an enemy submarine.
 *   - While coming up and diving it is exposed (visible, hittable) but cannot fire. The surfacing is announced to the
 *     enemy: a 'subUp' event (a ping on the map and a sound, game.ts / renderer.ts).
 *   - Hold fire stays submerged (no auto engagement; autoFire in orders.ts).
 *
 * The phase (Entity.subPhase) is a pure function of the ticks (no randomness): 0 submerged, 1 coming up, 2 surfaced,
 * 3 diving. It lives in the submerged-unit layer (submerge.ts): Entity.dive is true only in phase 0.
 */

/** Seconds to come up / to dive. */
export const SUB_SURFACE_TICKS = 5 * TPS;
export const SUB_DIVE_TICKS = 5 * TPS;
/** A surfaced submarine with nothing to shoot at for this long starts to dive (a target blinking in and out of sight). */
export const SUB_LINGER_TICKS = Math.round(1.5 * TPS);
/** How far a submarine hears an enemy submarine (tiles). */
export const SUB_SONAR = 12;

export const UP = 2;

function engaged(w: World, e: Entity): boolean {
  if (e.targetId < 0) return false;
  const t = w.foe(e.targetId);
  return !!t && !t.dead && w.isEnemy(e.owner, t.owner);
}

/** Advance the submarine's phase one tick; true while it is fully submerged (hidden). */
function update(w: World, e: Entity): boolean {
  const ph = e.subPhase ?? 0;
  const eng = engaged(w, e);
  if (eng) e.subSeen = w.tick;
  switch (ph) {
    case 0:
      if (eng) {
        e.subPhase = 1;
        e.subAt = w.tick;
        w.events.push({ t: 'subUp', id: e.id, owner: e.owner, x: e.x, y: e.y, up: true });
      }
      break;
    case 1:
      if (w.tick - (e.subAt ?? 0) >= SUB_SURFACE_TICKS) {
        e.subPhase = UP;
        e.subAt = w.tick;
      }
      break;
    case 2:
      if (!eng && w.tick - (e.subSeen ?? 0) >= SUB_LINGER_TICKS) {
        e.subPhase = 3;
        e.subAt = w.tick;
      }
      break;
    default:
      // diving: seen again by a target, it turns round (the time already spent counts)
      if (eng) {
        e.subPhase = 1;
        e.subAt = w.tick - Math.max(0, SUB_SURFACE_TICKS - (w.tick - (e.subAt ?? 0)));
      } else if (w.tick - (e.subAt ?? 0) >= SUB_DIVE_TICKS) {
        e.subPhase = 0;
        w.events.push({ t: 'subUp', id: e.id, owner: e.owner, x: e.x, y: e.y, up: false });
      }
  }
  return (e.subPhase ?? 0) === 0;
}

/** Does `viewer` hear this submerged submarine? Only submarines hear submarines (any of the viewer's side's, within SUB_SONAR). */
function spotted(w: World, viewer: number, e: Entity): boolean {
  let seen = false;
  w.queryRadius(e.x, e.y, SUB_SONAR, (o) => {
    if (seen || o.dead || o.kind !== 'unit' || o.owner < 0 || w.isEnemy(viewer, o.owner)) return;
    if (unitDef(o.def).submerge === 'sub' && Math.hypot(o.x - e.x, o.y - e.y) <= SUB_SONAR) seen = true;
  });
  return seen;
}

export const SUB_RULE: SubmergeRule = {
  update,
  spotted,
  // only another submarine's torpedoes reach it while it is down
  hurtBy: (src) => src.kind === 'unit' && unitDef(src.def).submerge === 'sub',
  canFire: (e) => (e.subPhase ?? 0) === UP,
  holds: true,
  scans: true,
};
