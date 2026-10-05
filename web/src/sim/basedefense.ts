// Automatic base defence for human players (the AI runs its own, ai.ts defendBase).
//
// When an enemy damages one of the player's structures, or enemy units come within
// BASE_ALERT tiles of one, the player's idle combat units within DEFEND_PULL tiles of
// that structure engage the attackers on their own, and walk back to their posts once
// the base is quiet again.
//
//  - who answers: combat units on 'guard' / 'aggressive' stance that are idle (no queue,
//    patrol or escort) and got no explicit order from the player in the last ORDER_GRACE;
//  - who is left alone: 'hold' / 'holdFire' stances, recently ordered units, harvesters,
//    engineers, MCVs, transports, strike-missile launchers, sortie jets, drones;
//  - artillery (minimum range / 'arty' units) only fires from where it stands, if in range;
//  - targets: what the unit's weapon can hit, preferring the structure's attacker, then the
//    nearest armed threat its warhead is good against; never further than DEFEND_LEASH
//    from the unit's post;
//  - any new order from the player overrides it at once (World.applyCommand -> releaseDefender).
//
// Runs inside the deterministic simulation every THINK ticks per player (staggered). Threats
// are what the player can see near the base, plus whoever is shooting at a structure (its
// muzzle flash gives it away, as in RA2).

import { DEFS, VERSUS, WEAPONS, buildingDef, unitDef } from './defs';
import { isSortieJet } from './airbase';
import { isBridge } from './bridges';
import { lowObsFactor } from './stealth';
import { TPS, type Entity, type UnitDef } from './types';
import type { World } from './world';

/** Units this close (tiles) to an alerted structure are pulled in. */
export const DEFEND_PULL = 14;
/** Enemy units this close (tiles) to a structure count as being inside the base. */
export const BASE_ALERT = 6;
/** A structure hit within this many ticks is under attack. */
export const HURT_WINDOW = TPS * 3;
/** Units given an explicit order this recently are left alone. */
export const ORDER_GRACE = TPS * 10;
/** A defender never chases a target further than this from its post. */
export const DEFEND_LEASH = DEFEND_PULL + 8;
/** Re-think period (ticks). */
const THINK = 10;

/** Can this kind of unit join a base defence at all? */
export function defenderKind(d: UnitDef): boolean {
  if (!d.weapon || d.harvester || d.engineer || d.mcv || d.temp || d.supply || d.kamikaze || d.airlift || isSortieJet(d)) return false;
  const f = WEAPONS[d.weapon].flight;
  return f !== 'ballistic' && f !== 'hypersonic' && f !== 'cruise'; // strike missiles are not for skirmishes at the gate
}

/** Artillery holds its ground and fires only at what it already reaches. */
function isArtillery(d: UnitDef) {
  return d.aiTag === 'arty' || (WEAPONS[d.weapon!].minRange ?? 0) > 0;
}

/** May the unit be pulled into a defence right now (stance, recent orders, current activity)? */
function available(w: World, e: Entity): boolean {
  // (nor a soldier lying wounded, or a helicopter on its repair trip: medic.ts, helipad.ts)
  if (e.inside >= 0 || e.para || e.drop || e.wound || e.heli) return false;
  if (e.stance !== 'guard' && e.stance !== 'aggressive') return false;
  if (w.tick - e.orderAt < ORDER_GRACE) return false;
  if (e.defend) return e.order.type === 'idle' || (e.order.type === 'attack' && !e.order.forced);
  return e.order.type === 'idle' && e.queue.length === 0 && !e.patrol && e.guardId < 0;
}

/** Player toggled auto-defend (a command, so it stays in lockstep). Off: every defender goes home. */
export function setAutoDefend(w: World, pid: number, on: boolean) {
  const p = w.players[pid];
  if (!p) return;
  p.autoDefend = on;
  if (on) return;
  for (const e of w.list) if (!e.dead && e.owner === pid && e.defend) sendHome(w, e);
}

/**
 * The player gave this defender an order: it is no longer on a defence run.
 * recall: also stop the fight (a stance change, which leaves the current order alone).
 */
export function releaseDefender(_w: World, e: Entity, recall: boolean) {
  const post = e.defend;
  e.defend = null;
  if (!recall || !post) return;
  if (e.order.type === 'attack' && !e.order.forced) e.order = { type: 'idle' };
  e.targetId = -1;
  e.path = null;
  e.guardX = post.x;
  e.guardY = post.y;
}

/** Back to the post it left (it still fights back on the way, as any idle unit). */
function sendHome(w: World, e: Entity) {
  const post = e.defend!;
  e.defend = null;
  if (e.order.type === 'attack' && !e.order.forced) e.order = { type: 'idle' };
  e.targetId = -1;
  e.autoTarget = false;
  e.guardX = post.x;
  e.guardY = post.y;
  if (Math.hypot(e.x - post.x, e.y - post.y) > 1.5) w.pathTo(e, post.x, post.y);
  else e.path = null;
}

export function updateBaseDefense(w: World) {
  for (const p of w.players) {
    if (!p.autoDefend || p.defeated || (w.tick + p.id * 3) % THINK !== 0) continue;
    think(w, p.id);
  }
}

function think(w: World, pid: number) {
  // 1. alerted structures and the threats around them (only what this player can see)
  const alerts: Entity[] = [];
  const threats = new Map<number, Entity>();
  const attackers = new Set<number>();
  const seen = (o: Entity) => w.isEnemy(pid, o.owner) && o.inside < 0 && !o.para && w.sees(pid, o);
  for (const b of w.list) {
    if (b.dead || b.owner !== pid || b.kind !== 'building') continue;
    let alerted = false;
    if (w.tick - b.lastHurt < HURT_WINDOW) {
      const a = w.get(b.hurtBy);
      if (a && w.isEnemy(pid, a.owner)) {
        alerted = true;
        // whoever fires at the base gives itself away: it is a target even outside our sight
        if (a.inside < 0 && !a.para && !isBridge(a)) {
          threats.set(a.id, a);
          attackers.add(a.id);
        }
      }
    }
    const bd = buildingDef(b.def);
    w.queryRadius(b.x, b.y, BASE_ALERT + Math.max(bd.w, bd.h) / 2, (o) => {
      if (o.kind !== 'unit' || !seen(o) || unitDef(o.def).temp || w.distTo(o, b) > BASE_ALERT) return;
      threats.set(o.id, o);
      alerted = true;
    });
    if (alerted) alerts.push(b);
  }
  const quiet = threats.size === 0;

  // 2. defenders: keep fighting, retarget, go home, or join in
  for (const e of w.list) {
    if (e.dead || e.owner !== pid || e.kind !== 'unit') continue;
    if (!e.defend && quiet) continue;
    const d = unitDef(e.def);
    if (!defenderKind(d) || !available(w, e)) {
      if (e.defend && (e.order.type === 'attack' || e.order.type === 'idle')) sendHome(w, e);
      else e.defend = null;
      continue;
    }
    if (e.defend) {
      const cur = e.order.type === 'attack' ? threats.get(e.order.target) : undefined;
      if (cur && Math.hypot(cur.x - e.defend.x, cur.y - e.defend.y) <= DEFEND_LEASH) continue; // still on it
      const t = quiet ? null : pick(w, e, d, threats, attackers, e.defend.x, e.defend.y);
      if (t) engage(e, t);
      else sendHome(w, e);
      continue;
    }
    // close enough to an alerted structure to help?
    let near = false;
    for (const b of alerts) {
      if (w.distTo(e, b) <= DEFEND_PULL) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    if (isArtillery(d)) {
      // fire from where it stands (idle behaviour keeps shooting while it is in range)
      const cur = w.get(e.targetId);
      if (cur && w.isEnemy(pid, cur.owner)) continue;
      const t = pick(w, e, d, threats, attackers, e.guardX, e.guardY, true);
      if (t) {
        e.targetId = t.id;
        e.autoTarget = true;
      }
      continue;
    }
    const t = pick(w, e, d, threats, attackers, e.guardX, e.guardY);
    if (t) {
      e.defend = { x: e.guardX, y: e.guardY };
      engage(e, t);
    }
  }
}

/** The best threat for this unit: one its weapon hits well, the structure's attacker first, then the nearest. */
function pick(w: World, e: Entity, _d: UnitDef, threats: Map<number, Entity>, attackers: Set<number>, px: number, py: number, inRangeOnly = false): Entity | null {
  let best: Entity | null = null;
  let bs = Infinity;
  for (const t of threats.values()) {
    // the weapon for this threat (main, or a secondary AA missile); units that can't hit aircraft are never sent at one
    const wpn = t.dead ? null : w.weaponVs(e.def, t);
    if (!wpn) continue;
    const dist = w.distTo(e, t);
    if (inRangeOnly ? dist > w.weaponRange(e, wpn) * lowObsFactor(w, wpn, t) || dist < (wpn.minRange ?? 0) : Math.hypot(t.x - px, t.y - py) > DEFEND_LEASH) continue;
    const eff = VERSUS[wpn.warhead][DEFS[t.def].armor];
    if (eff <= 0) continue;
    let s = dist - eff * 4;
    if (attackers.has(t.id)) s -= 4;
    if (t.kind === 'unit' && unitDef(t.def).weapon) s -= 1;
    if (s < bs) {
      bs = s;
      best = t;
    }
  }
  return best;
}

function engage(e: Entity, t: Entity) {
  e.order = { type: 'attack', target: t.id };
  e.targetId = t.id;
  e.autoTarget = true;
  e.path = null;
}
