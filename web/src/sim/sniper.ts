// Sniper lock-on (part of the weapon cycle; deterministic, state on the entity).
//
// A weapon with `aim` (the sniper rifle) must hold its aim on a NEW target for `aim` ticks
// (3 s) before it fires; each new target needs a fresh aim. The aim is cancelled when the
// target leaves range, drops out of the shooter's sight (fog), climbs into a building or a
// vehicle, or dies, and when the shooter moves or is given another order. Once locked, follow
// -up shots on the same target only wait for the bolt (weapon rof).
//
// State: Entity.aimTarget (-1 = not aiming) and Entity.aimTicks (ticks aimed so far). The
// renderer draws the laser designator from it (render/fx/sniperfx.ts) and the HUD shows
// "Aiming 2.1s". Events: 'aim' phase 'start' (new target) and 'lock' (the final steady
// SNIPER_STEADY ticks begin).

import { DEFS, WEAPONS } from './defs';
import { TPS, type Command, type Entity, type WeaponDef } from './types';
import type { World } from './world';

/** Lock-on time of the sniper rifle (ticks). */
export const SNIPER_AIM = 3 * TPS;
/** The last ticks of the aim the hand is steady (render: the laser dot stops swaying; 'lock' event). */
export const SNIPER_STEADY = 8;
/** Auto-targeting: score bonus (tiles) for infantry, so a sniper picks soldiers first. */
const INFANTRY_FIRST = 8;

/** The lock-on weapon of a unit, or null. */
export function aimWeapon(e: Entity): WeaponDef | null {
  const id = DEFS[e.def]?.weapon;
  const w = id ? WEAPONS[id] : undefined;
  return w && w.aim ? w : null;
}

export function cancelAim(e: Entity) {
  e.aimTarget = -1;
  e.aimTicks = 0;
}

/** Aim progress 0..1 (1 = locked) and the seconds left, for the HUD; null when not aiming. */
export function aimStatus(e: Entity): { k: number; left: number } | null {
  const w = e.aimTarget >= 0 ? aimWeapon(e) : null;
  if (!w || !w.aim) return null;
  const k = Math.min(1, e.aimTicks / w.aim);
  return { k, left: Math.max(0, (w.aim - e.aimTicks) / TPS) };
}

/** Can the shooter hold a lock on t: alive, out in the open, and in its owner's sight. */
export function aimSees(w: World, e: Entity, t: Entity): boolean {
  if (t.dead || t.inside >= 0 || t.wound) return false;
  return e.owner < 0 || w.sees(e.owner, t);
}

/**
 * One tick of aiming at t (in range, can hit it). Returns true when the shot may be released
 * this tick. The tick a new target is taken is aim tick 0, so the shot comes exactly `aim`
 * ticks later.
 */
export function aimStep(w: World, e: Entity, t: Entity, wpn: WeaponDef): boolean {
  const need = wpn.aim ?? 0;
  if (e.aimTarget !== t.id) {
    e.aimTarget = t.id;
    e.aimTicks = 0;
    w.events.push({ t: 'aim', id: e.id, owner: e.owner, target: t.id, phase: 'start', x: e.x, y: e.y });
    return need <= 0;
  }
  if (e.aimTicks < need) {
    e.aimTicks++;
    if (e.aimTicks === need - SNIPER_STEADY) w.events.push({ t: 'aim', id: e.id, owner: e.owner, target: t.id, phase: 'lock', x: e.x, y: e.y });
  }
  return e.aimTicks >= need;
}

/**
 * Start-of-tick upkeep: drop the lock when the target died or hid inside a building / vehicle,
 * when the unit switched targets, or when it moved last tick.
 */
export function aimUpkeep(w: World, e: Entity) {
  if (e.aimTarget < 0) return;
  const t = w.get(e.aimTarget);
  // (a target lying wounded is out of the fight too: medic.ts)
  const gone = !!t && (t.inside >= 0 || !!t.wound);
  if (!t || gone || e.targetId !== e.aimTarget || (e.moving && e.inside < 0)) {
    if (t && gone && e.order.type === 'attack' && e.order.target === t.id) e.order = { type: 'idle' };
    if (t && gone) e.targetId = -1;
    cancelAim(e);
  }
}

/** A new order cancels the aim (queued orders and re-ordering the same target keep it). */
export function aimOrder(e: Entity, cmd: Command) {
  if (e.aimTarget < 0) return;
  if ('queue' in cmd && cmd.queue) return;
  if (cmd.type === 'attack' && cmd.target === e.aimTarget) return;
  if (cmd.type === 'stance' && cmd.stance !== 'holdFire') return;
  cancelAim(e);
}

/**
 * Auto-targeting preference of a lock-on weapon (lower = better, added to the distance score):
 * infantry first, never buildings (a 3 s aim for a scratch on the wall). null = skip.
 */
export function aimTargetScore(t: Entity): number | null {
  if (t.kind === 'building') return null;
  return DEFS[t.def].armor === 'infantry' ? -INFANTRY_FIRST : 0;
}
