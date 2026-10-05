// Wounded soldiers and combat medics (deterministic lockstep).
//
// Wounded instead of dead: a soldier (UnitDef category 'infantry') brought to 0 HP goes down WOUNDED
// with a seeded chance of WOUND_CHANCE instead of dying, except when the blow could not leave anyone
// alive to save: a sniper's shot, a big explosion (artillery, missiles and bombs of BIG_BLAST damage or
// more), being run over (crush.ts kills outright) and dying inside a destroyed building or vehicle
// (World.kill on the passengers / garrison). A wounded soldier lies where he fell: he can't move or
// shoot, takes no further damage, is off the spatial grid (so nothing targets, splashes, crushes or
// shoves him) and doesn't count as a fighting unit for victory or the AI. He bleeds out after
// BLEED_TICKS; the shooter's player gets the kill then. The shooter's veterancy XP is granted when he
// goes down.
//
// Medics (UnitDef.medic): an idle (or attack-moving) medic looks for wounded friendly soldiers within
// MEDIC_RANGE every MEDIC_SCAN ticks (a walk over the short World.wounded list, no full scans), runs to
// the nearest one nobody else is treating, kneels and works on him for TREAT_TICKS; the soldier gets
// back up at REVIVE_HP of his health and picks up the order he had. With nobody to save, a medic patches
// up the most hurt friendly soldier within HEAL_RANGE, HEAL_RATE of max HP per second, one at a time.
// The player can also send a medic to a particular wounded soldier (Command 'treat').

import { DEFS, unitDef } from './defs';
import { hash2 } from './rng';
import { cancelAim } from './sniper';
import { releaseDefender } from './basedefense';
import { TPS, type Entity, type Flight, type Order, type UnitDef, type Warhead, type WeaponDef } from './types';
import type { World } from './world';

/** Chance that a soldier brought to 0 HP goes down wounded instead of dying. */
export const WOUND_CHANCE = 0.6;
/** A wounded soldier bleeds out after this long without a medic. */
export const BLEED_TICKS = TPS * 45;
/** Kneeling treatment time before the soldier is back on his feet. */
export const TREAT_TICKS = TPS * 4;
/** Health a treated soldier gets up with (fraction of max HP). */
export const REVIVE_HP = 0.4;
/** How far (tiles) a medic goes on his own for a wounded soldier. */
export const MEDIC_RANGE = 7;
/** A medic on 'hold' only treats soldiers this close. */
export const MEDIC_HOLD_RANGE = 1.5;
/** Wounded / hurt soldier search period (ticks). */
export const MEDIC_SCAN = 10;
/** Slow healing of hurt friendly infantry around an idle medic: fraction of max HP per second, within HEAL_RANGE. */
export const HEAL_RATE = 0.02;
export const HEAL_RANGE = 2.5;
/** Explosions from weapons of this much damage or more (artillery, missiles, bombs) kill outright. */
export const BIG_BLAST = 90;
/** The medic works this close to the patient (tiles). */
export const TREAT_DIST = 0.5;
const TREAT_STAND = 0.3;

const BLAST_FLIGHTS: ReadonlySet<Flight> = new Set<Flight>(['artillery', 'mortar', 'rocketSalvo', 'ballistic', 'hypersonic', 'cruise', 'bomb']);
const BLAST_WARHEADS: ReadonlySet<Warhead> = new Set<Warhead>(['artillery', 'missile', 'thermo']);

/** A big explosion: an artillery shell, missile or bomb heavy enough that nobody it brings down survives. */
export function bigBlast(wpn: WeaponDef | undefined): boolean {
  if (!wpn || wpn.damage < BIG_BLAST || wpn.air === 'only') return false;
  return BLAST_WARHEADS.has(wpn.warhead) || (!!wpn.flight && BLAST_FLIGHTS.has(wpn.flight));
}

export function isWounded(e: Entity | undefined): boolean {
  return !!e && !!e.wound;
}

export function isMedic(e: Entity): boolean {
  return e.kind === 'unit' && !!unitDef(e.def).medic;
}

/** The seeded wound roll for soldier t going down this tick (the same on every client). */
export function woundRoll(w: World, t: Entity): boolean {
  return hash2(t.id, w.tick, w.seed) < WOUND_CHANCE;
}

/** Can this blow leave soldier t wounded rather than dead (and does the roll say so)? */
export function canWound(w: World, t: Entity, warhead: Warhead, big: boolean): boolean {
  if (t.kind !== 'unit' || t.dead || t.wound || t.owner < 0) return false;
  if (warhead === 'sniper' || big) return false;
  if (t.inside >= 0 || t.para || t.z > 0.05) return false;
  const d = DEFS[t.def];
  if (d.kind !== 'unit' || d.category !== 'infantry' || d.temp) return false;
  if (w.players[t.owner]?.defeated) return false;
  return woundRoll(w, t);
}

/** Soldier t goes down wounded (World.damage): out of the fight until a medic gets to him or he bleeds out. */
export function woundUnit(w: World, t: Entity, by: number, killer?: Entity) {
  t.hp = 0;
  t.wound = { at: w.tick, until: w.tick + BLEED_TICKS, by: by >= 0 && by !== t.owner ? by : -1, healer: -1, order: t.order };
  t.order = { type: 'idle' };
  t.path = null;
  t.moving = false;
  t.targetId = -1;
  t.autoTarget = false;
  t.burstLeft = 0;
  t.dodge = null;
  if (t.defend) releaseDefender(w, t, false);
  cancelAim(t);
  releasePatient(w, t);
  t.treat = 0;
  w.wounded.push(t);
  w.events.push({ t: 'wounded', id: t.id, def: t.def, owner: t.owner, by: t.wound.by, x: t.x, y: t.y, phase: 'down' });
  // the shooter earns the kill's experience as he goes down (no second award if he bleeds out)
  if (killer && by >= 0 && by !== t.owner) w.creditKill(killer, t);
}

/** A medic stops working on his patient (he was ordered away, went down himself or died). */
export function releasePatient(w: World, m: Entity) {
  if (m.order.type !== 'treat') return;
  const p = w.entities.get(m.order.target);
  if (p && p.wound && p.wound.healer === m.id) p.wound.healer = -1;
}

/** Drop a soldier from the wounded list (back on his feet, or dead). */
export function forgetWounded(w: World, e: Entity) {
  const i = w.wounded.indexOf(e);
  if (i >= 0) w.wounded.splice(i, 1);
}

/** One tick of a wounded soldier (World.updateUnit): lying still, bleeding out. */
export function updateWounded(w: World, e: Entity) {
  const ws = e.wound!;
  e.moving = false;
  e.path = null;
  e.targetId = -1;
  if (w.tick < ws.until) return;
  w.events.push({ t: 'wounded', id: e.id, def: e.def, owner: e.owner, by: ws.by, x: e.x, y: e.y, phase: 'bledOut' });
  w.kill(e, ws.by);
}

/** Back on his feet at REVIVE_HP, picking up the order he had when he went down. */
export function revive(w: World, e: Entity, medic: Entity | null) {
  const ws = e.wound;
  if (!ws) return;
  e.wound = null;
  forgetWounded(w, e);
  e.hp = Math.max(e.hp, e.maxHp * REVIVE_HP);
  e.lastHurt = -9999;
  e.scanAt = w.tick + 2;
  e.guardX = e.x;
  e.guardY = e.y;
  resumeOrder(w, e, ws.order);
  w.events.push({ t: 'wounded', id: e.id, def: e.def, owner: e.owner, by: ws.by, x: e.x, y: e.y, phase: 'revived', medic: medic?.id });
}

function resumeOrder(w: World, e: Entity, o: Order) {
  e.order = { type: 'idle' };
  switch (o.type) {
    case 'move':
    case 'attackMove':
      if (Math.hypot(o.x - e.x, o.y - e.y) < 0.3) return;
      e.order = o;
      w.pathTo(e, o.x, o.y);
      return;
    case 'attack': {
      const t = w.foe(o.target);
      if (t && w.isEnemy(e.owner, t.owner) && w.canAttack(e.def, t)) {
        e.order = o;
        e.targetId = t.id;
      }
      return;
    }
    case 'enter':
    case 'capture':
      if (w.get(o.target)) e.order = o;
      return;
    default:
      return;
  }
}

/** Player order: medics among `units` go and treat wounded friendly soldier t. */
export function orderTreat(w: World, units: Entity[], t: Entity) {
  if (!t.wound) return;
  for (const m of units) {
    if (!unitDef(m.def).medic || m.owner !== t.owner || m === t) continue;
    releasePatient(w, m);
    m.order = { type: 'treat', target: t.id };
    m.treat = 0;
    m.targetId = -1;
    m.path = null;
    t.wound.healer = m.id;
  }
}

/** Is wounded soldier p free to be picked up by medic m (nobody else on him)? */
function freePatient(w: World, p: Entity, m: Entity): boolean {
  const h = p.wound!.healer;
  if (h < 0 || h === m.id) return true;
  const o = w.get(h);
  return !o || o.order.type !== 'treat' || o.order.target !== p.id;
}

/** Nearest wounded friendly soldier medic m may go for on his own, or null. */
function findPatient(w: World, m: Entity, range: number): Entity | null {
  let best: Entity | null = null;
  let bd = range;
  for (const p of w.wounded) {
    if (p.dead || !p.wound || p.owner !== m.owner) continue;
    const dd = Math.hypot(p.x - m.x, p.y - m.y);
    if (dd > bd || (dd === bd && best && p.id > best.id)) continue;
    if (!freePatient(w, p, m)) continue;
    bd = dd;
    best = p;
  }
  return best;
}

/** Slow healing: the most hurt friendly soldier near the medic gets HEAL_RATE * max HP per second. */
function healNearby(w: World, m: Entity) {
  if ((w.tick + m.id) % TPS !== 0) return;
  let best: Entity | null = null;
  let bk = 1;
  w.queryRadius(m.x, m.y, HEAL_RANGE, (o) => {
    if (o === m || o.owner !== m.owner || o.kind !== 'unit' || o.wound || o.para || o.hp >= o.maxHp) return;
    if (unitDef(o.def).category !== 'infantry' || Math.hypot(o.x - m.x, o.y - m.y) > HEAL_RANGE) return;
    const k = o.hp / o.maxHp;
    if (k < bk || (k === bk && best && o.id < best.id)) {
      bk = k;
      best = o;
    }
  });
  if (best) {
    const b = best as Entity;
    b.hp = Math.min(b.maxHp, b.hp + b.maxHp * HEAL_RATE);
  }
}

/**
 * One tick of a medic (World.updateUnit, after his dodge step). Returns true while a treatment
 * (running to the patient or working on him) runs this tick; false hands the tick to the normal
 * order handling (moves, idle).
 */
export function updateMedic(w: World, e: Entity, d: UnitDef): boolean {
  let o = e.order;
  if (o.type !== 'treat') {
    e.treat = 0;
    // pick up a wounded soldier on his own: idle (also on hold, close by only) or on an attack-move with the army
    if ((o.type === 'idle' || o.type === 'attackMove') && e.stance !== 'holdFire' && (w.tick + e.id) % MEDIC_SCAN === 0 && w.wounded.length) {
      const p = findPatient(w, e, e.stance === 'hold' ? MEDIC_HOLD_RANGE : MEDIC_RANGE);
      if (p) {
        e.order = o = o.type === 'attackMove' ? { type: 'treat', target: p.id, auto: true, x: o.x, y: o.y } : { type: 'treat', target: p.id, auto: true };
        p.wound!.healer = e.id;
        e.path = null;
      }
    }
    if (o.type !== 'treat') {
      healNearby(w, e);
      return false;
    }
  }
  const p = w.entities.get(o.target);
  if (!p || p.dead || !p.wound || p.owner !== e.owner || (o.auto && !freePatient(w, p, e))) {
    finishTreat(w, e);
    return true;
  }
  p.wound.healer = e.id;
  const dx = e.x - p.x;
  const dy = e.y - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist > TREAT_DIST) {
    e.treat = 0;
    // the patient is out of reach of an automatic pick-up (pushed off, blocked): give up on him
    if (o.auto && dist > MEDIC_RANGE + 3) {
      finishTreat(w, e);
      return true;
    }
    if (!e.path || w.tick >= e.repathAt) {
      const k = dist > 1e-3 ? TREAT_STAND / dist : 0;
      w.pathTo(e, p.x + (dist > 1e-3 ? dx * k : TREAT_STAND), p.y + dy * k);
      e.repathAt = w.tick + 30;
    }
    w.walk(e, d);
    return true;
  }
  // at his side: kneel and work on him
  e.path = null;
  e.moving = false;
  e.facing = e.turret = Math.atan2(p.y - e.y, p.x - e.x);
  e.treat++;
  if (e.treat >= TREAT_TICKS) {
    revive(w, p, e);
    finishTreat(w, e);
  }
  return true;
}

/** Treatment over (done, or the patient is gone): back to the attack-move he was on, or stand here. */
function finishTreat(w: World, e: Entity) {
  const o = e.order;
  e.treat = 0;
  e.path = null;
  e.moving = false;
  e.guardX = e.x;
  e.guardY = e.y;
  if (o.type === 'treat' && o.auto && o.x !== undefined && o.y !== undefined) {
    e.order = { type: 'attackMove', x: o.x, y: o.y };
    w.pathTo(e, o.x, o.y);
  } else e.order = { type: 'idle' };
}

/** Bleed-out time left (seconds) for the UI, or -1 if not wounded. */
export function bleedLeft(w: World, e: Entity): number {
  if (!e.wound) return -1;
  return Math.max(0, (e.wound.until - w.tick) / TPS);
}

/** Bleed-out progress 0 (just went down) .. 1 (dead) for the UI countdown ring. */
export function bleedFrac(w: World, e: Entity): number {
  if (!e.wound) return 0;
  const T = e.wound.until - e.wound.at;
  return T > 0 ? Math.min(1, Math.max(0, (w.tick - e.wound.at) / T)) : 1;
}
