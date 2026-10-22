import { unitDef } from './defs';
import { DIVER_RULE } from './diver';
import { SUB_RULE } from './sub';
import type { Entity } from './types';
import type { World } from './world';

/*
 * Submerged units (NV3 divers; NV4 submarines plug into the same seam): ONE place for what hiding under the water
 * means, so the visibility, targeting and firing code never asks "is this a diver?" but "is it submerged, and what
 * does its rule say?".
 *
 * A unit def with `submerge: '<kind>'` has a rule here. Each tick World.updateUnit asks the rule whether the unit is
 * submerged (Entity.dive). While it is:
 *   - World.sees(viewer, e): an enemy sees it only if the rule's `spotted` says so (never by plain line of sight);
 *     its owner and allies always see it. The renderer, the targeting scan (findTarget) and the HUD all go through
 *     sees(), so there is nothing else to change.
 *   - World.damage(): a weapon of `src` hurts it only if the rule's `hurtBy` says so (the central damage gate: shells,
 *     splash, crushing, everything).
 *   - It fires only if the rule's `fires` says so (an idle scan, attack-move and retaliation skip it; an attack order
 *     on a target it cannot fire at brings it closer: World.engage).
 * The rule is a pure function of the world state (no randomness, no wall clock): the same on every client. A rule
 * that needs a timer (a submarine's seconds to surface and dive) keeps it in a field of its own on the entity.
 */

export interface SubmergeRule {
  /** Is the unit submerged this tick? (may keep a timer on the entity, deterministically from w.tick) */
  update(w: World, e: Entity): boolean;
  /** Does `viewer` (an enemy of the owner) pick the submerged unit up? */
  spotted(w: World, viewer: number, e: Entity): boolean;
  /** May the attacker `src` hurt the submerged unit? */
  hurtBy(src: Entity, e: Entity): boolean;
  /** Can the unit fire right now? (a diver: not while submerged; a submarine: only fully surfaced) */
  canFire(e: Entity): boolean;
  /** While it cannot fire yet but the target is in range, does it wait for it (a submarine coming up) rather than move closer (a diver)? */
  holds: boolean;
  /** May it pick targets on its own while submerged (idle scan, attack-move)? A diver no (it swims on), a submarine yes (that is how it surfaces). */
  scans: boolean;
}

/** The rules by def.submerge. NV4 adds 'sub' (and its nuclear / conventional variants) here. */
const RULES: Record<string, SubmergeRule> = {
  diver: DIVER_RULE,
  sub: SUB_RULE,
};

export function submergeRule(e: Entity): SubmergeRule | undefined {
  if (e.kind !== 'unit') return undefined;
  const k = unitDef(e.def).submerge;
  return k ? RULES[k] : undefined;
}

/** Update the submerged flag of a unit with a rule (every tick). */
export function updateSubmerged(w: World, e: Entity) {
  const r = submergeRule(e);
  if (r) e.dive = r.update(w, e);
}

/** Does `viewer` see this submerged unit (given that it is an enemy and submerged)? */
export function spottedWhenSubmerged(w: World, viewer: number, e: Entity): boolean {
  const r = submergeRule(e);
  return r ? r.spotted(w, viewer, e) : true;
}

/** May `src` damage this unit? (always, unless it is submerged and the rule says no) */
export function canHurtSubmerged(src: Entity, e: Entity): boolean {
  if (!e.dive) return true;
  const r = submergeRule(e);
  return r ? r.hurtBy(src, e) : true;
}

/** Can this unit fire right now (false only while its rule forbids it: submerged, or still coming up)? */
export function canFireNow(e: Entity): boolean {
  const r = submergeRule(e);
  return r ? r.canFire(e) : true;
}

/** May it pick its own targets (the scan that starts an auto engagement)? */
export function mayScan(e: Entity): boolean {
  const r = submergeRule(e);
  return r ? r.scans || canFireNow(e) : true;
}

/** Blocked from firing but with the target in range: wait (true) or move closer (false)? */
export function holdsWhenBlocked(e: Entity): boolean {
  const r = submergeRule(e);
  return !!r?.holds;
}
