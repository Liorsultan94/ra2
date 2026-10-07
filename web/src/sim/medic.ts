// Wounded soldiers and combat medics (deterministic lockstep).
//
// The wounded state is OFF in the game (World.wounds, the owner's call): a soldier brought to 0 HP dies, and
// medics treat hurt soldiers on their feet. The mechanic below stays for tests (WorldOptions.wounds).
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
// back up at REVIVE_HP of his health and picks up the order he had.
// With nobody down, the same scan (World.queryRadius) looks for HURT friendly soldiers on their feet, below
// HURT_HP of their health: the most hurt first, a little less the farther away, never one another medic
// has taken, and not one a visible enemy has in weapon range (no running into fire for a scratch; the
// wounded are still rescued). He runs over and treats him, TREAT_RATE of max HP per second while within
// TREAT_REACH, to full health: kneeling at a soldier standing still, working on his feet beside one who
// walks on (he follows; the patient's own orders are never touched).
// Failing that, he slowly patches up the most hurt friendly soldier within HEAL_RANGE, HEAL_RATE of max HP
// per second, one at a time.
// The player can also send a medic to a particular wounded or hurt soldier (Command 'treat'), fire or not.

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
/** A soldier on his feet below this share of his health is worth a medic's trip on his own. */
export const HURT_HP = 0.9;
/** Treating a hurt soldier: fraction of his max HP per second while the medic works on him. */
export const TREAT_RATE = 0.08;
/** A medic works on a hurt soldier from this close (tiles), also walking beside him. */
export const TREAT_REACH = 1;
/** A medic picks up a hurt soldier only if no visible enemy within this far (tiles) has him in weapon range. */
export const FIRE_REACH = 9;
/** Choosing among hurt soldiers: the most hurt (missing share of HP), less this much per tile away. */
const NEAR_BIAS = 0.015;
/** Hurt soldiers checked for enemy fire per scan, best first. */
const FIRE_CHECKS = 4;
/** Gap the medic keeps to a hurt soldier standing still (kneeling at his side) / walking on (tiles). */
const TEND_GAP = 0.38;
const TEND_FOLLOW = 0.6;
/** Within this far of a hurt soldier the medic goes straight for him (no path), hurrying at CHASE_SPEED x his speed after one who walks on. */
const CHASE_NEAR = 3;
const CHASE_SPEED = 1.3;
/** Slow healing of hurt friendly infantry around an idle medic: fraction of max HP per second, within HEAL_RANGE. */
export const HEAL_RATE = 0.02;
export const HEAL_RANGE = 2.5;
/** Explosions from weapons of this much damage or more (artillery, missiles, bombs) kill outright. */
export const BIG_BLAST = 90;
/**
 * Where the medic kneels: beside the patient's chest. A soldier down wounded lies on his back with his
 * torso TORSO_BACK tiles behind his position (along his facing); the medic kneels TREAT_SIDE to the side.
 */
const TORSO_BACK = 0.17;
const TREAT_SIDE = 0.16;
/** Close enough to the kneeling spot to start (tiles); or this close to the patient once the path has ended. */
const TREAT_ARRIVE = 0.12;
const TREAT_NEAR = 0.5;

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
  if (!w.wounds || t.kind !== 'unit' || t.dead || t.wound || t.owner < 0) return false;
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
  // (a medic on his way to him / at work on him stays his medic)
  t.wound = { at: w.tick, until: w.tick + BLEED_TICKS, by: by >= 0 && by !== t.owner ? by : -1, healer: t.tendedBy, order: t.order };
  t.tendedBy = -1;
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
  if (!p) return;
  if (p.wound && p.wound.healer === m.id) p.wound.healer = -1;
  if (p.tendedBy === m.id) p.tendedBy = -1;
}

/** A soldier on his feet a medic can work on (not down wounded, not inside anything, not dropping in). */
function soldierUp(t: Entity): boolean {
  if (t.dead || t.kind !== 'unit' || t.wound || t.inside >= 0 || t.para || t.drop || t.owner < 0) return false;
  const d = unitDef(t.def);
  return d.category === 'infantry' && !d.temp && !d.air;
}

/** Can a medic be sent to t (Command 'treat'): down wounded, or a soldier on his feet short of full health. */
export function treatable(t: Entity): boolean {
  if (t.dead || t.kind !== 'unit') return false;
  return !!t.wound || (soldierUp(t) && t.hp < t.maxHp);
}

/** Hurt enough for a medic to go to him on his own (below HURT_HP). */
function hurt(t: Entity): boolean {
  return soldierUp(t) && t.hp > 0 && t.hp < t.maxHp * HURT_HP;
}

/**
 * Is hurt soldier p under enemy fire: a living enemy within FIRE_REACH that `side` can see, able to shoot
 * at him and with him inside its weapon range? (one World.queryRadius)
 */
export function underFire(w: World, p: Entity, side: number): boolean {
  let hit = false;
  w.queryRadius(p.x, p.y, FIRE_REACH, (o) => {
    if (hit || o.wound || !w.isEnemy(side, o.owner) || !DEFS[o.def].weapon) return;
    if (o.kind === 'building' && o.buildAnim < 1) return;
    const dd = Math.hypot(o.x - p.x, o.y - p.y);
    if (dd > FIRE_REACH || dd > w.maxWeaponRange(o) + (o.kind === 'building' ? 1 : 0.3)) return;
    if (!w.sees(side, o) || !w.canAttack(o.def, p)) return;
    hit = true;
  });
  return hit;
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

/** Player order: medics among `units` go and treat wounded or hurt friendly soldier t. */
export function orderTreat(w: World, units: Entity[], t: Entity) {
  if (!treatable(t)) return;
  for (const m of units) {
    if (!unitDef(m.def).medic || m.owner !== t.owner || m === t) continue;
    releasePatient(w, m);
    m.order = { type: 'treat', target: t.id };
    m.treat = 0;
    m.targetId = -1;
    m.path = null;
    m.repathAt = w.tick;
    claim(t, m);
  }
}

/** Medic m takes patient p (the others leave him be). */
function claim(p: Entity, m: Entity) {
  if (p.wound) p.wound.healer = m.id;
  else p.tendedBy = m.id;
}

/** Is wounded / hurt soldier p free to be picked up by medic m (nobody else on him)? */
function freePatient(w: World, p: Entity, m: Entity): boolean {
  const h = p.wound ? p.wound.healer : p.tendedBy;
  if (h < 0 || h === m.id) return true;
  const o = w.get(h);
  return !o || o.dead || o.order.type !== 'treat' || o.order.target !== p.id;
}

/**
 * The hurt friendly soldier medic m goes to on his own, or null: the most hurt within range (a little less the
 * farther off), nobody else's patient, and not under enemy fire. One World.queryRadius, a few fire checks.
 */
function findHurt(w: World, m: Entity, range: number): Entity | null {
  const cands: { p: Entity; s: number }[] = [];
  w.queryRadius(m.x, m.y, range, (p) => {
    if (p === m || p.owner !== m.owner || !hurt(p)) return;
    const dd = Math.hypot(p.x - m.x, p.y - m.y);
    if (dd > range || !freePatient(w, p, m)) return;
    cands.push({ p, s: 1 - p.hp / p.maxHp - dd * NEAR_BIAS });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.s - a.s || a.p.id - b.p.id);
  for (let i = 0; i < cands.length && i < FIRE_CHECKS; i++) if (!underFire(w, cands[i].p, m.owner)) return cands[i].p;
  return null;
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
    // pick up a wounded soldier on his own (or else a hurt one): idle (also on hold, close by only) or on an
    // attack-move with the army
    if ((o.type === 'idle' || o.type === 'attackMove') && e.stance !== 'holdFire' && (w.tick + e.id) % MEDIC_SCAN === 0) {
      const range = e.stance === 'hold' ? MEDIC_HOLD_RANGE : MEDIC_RANGE;
      const p = (w.wounded.length ? findPatient(w, e, range) : null) ?? findHurt(w, e, range);
      if (p) {
        e.order = o = o.type === 'attackMove' ? { type: 'treat', target: p.id, auto: true, x: o.x, y: o.y } : { type: 'treat', target: p.id, auto: true };
        claim(p, e);
        e.path = null;
        e.repathAt = w.tick;
      }
    }
    if (o.type !== 'treat') {
      healNearby(w, e);
      return false;
    }
  }
  const p = w.entities.get(o.target);
  if (!p || p.dead || p === e || p.owner !== e.owner || (o.auto && !freePatient(w, p, e))) {
    finishTreat(w, e);
    return true;
  }
  if (!p.wound) return tendHurt(w, e, d, p, o);
  p.wound.healer = e.id;
  const [sx, sy, cx, cy] = treatSpot(p, e);
  const dist = Math.hypot(sx - e.x, sy - e.y);
  const near = Math.hypot(cx - e.x, cy - e.y);
  if (dist > TREAT_ARRIVE && (near > TREAT_NEAR || (e.path && e.treat === 0))) {
    e.treat = 0;
    // the patient is out of reach of an automatic pick-up (pushed off, blocked): give up on him
    if (o.auto && near > MEDIC_RANGE + 3) {
      finishTreat(w, e);
      return true;
    }
    if (!e.path || w.tick >= e.repathAt) {
      w.pathTo(e, sx, sy);
      e.repathAt = w.tick + 30;
    }
    if (w.walk(e, d) && near <= TREAT_NEAR) e.path = null;
    return true;
  }
  // at his side: kneel and work on his chest
  e.path = null;
  e.moving = false;
  e.facing = e.turret = Math.atan2(cy - e.y, cx - e.x);
  e.treat++;
  if (e.treat >= TREAT_TICKS) {
    revive(w, p, e);
    finishTreat(w, e);
  }
  return true;
}

/**
 * One tick of medic e on hurt soldier p (on his feet): get within reach (beside him if he stands still, on his
 * heels if he walks on) and treat him, TREAT_RATE of max HP per second while within TREAT_REACH, to full health.
 */
function tendHurt(w: World, e: Entity, d: UnitDef, p: Entity, o: Extract<Order, { type: 'treat' }>): boolean {
  // healed up, or out of reach (in a vehicle or building)
  if (!soldierUp(p) || p.hp >= p.maxHp) {
    finishTreat(w, e);
    return true;
  }
  p.tendedBy = e.id;
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const dist = Math.hypot(dx, dy);
  if (o.auto) {
    // a pick-up of his own: not off his post (hold), not far after a soldier who walks away, not into enemy fire
    if (dist > (e.stance === 'hold' ? MEDIC_HOLD_RANGE + 0.5 : MEDIC_RANGE + 3) || ((w.tick + e.id) % MEDIC_SCAN === 0 && underFire(w, p, e.owner))) {
      finishTreat(w, e);
      return true;
    }
  }
  const still = !p.moving;
  const gap = still ? TEND_GAP : TEND_FOLLOW;
  if (dist > gap + 0.06) {
    // the spot `gap` short of him on our side: close by, straight there (hurrying after one who walks on);
    // farther, a path kept up to date as he moves (a new one at most every few ticks)
    const gx = p.x - (dx / dist) * gap;
    const gy = p.y - (dy / dist) * gap;
    if (dist <= CHASE_NEAR && stepTo(w, e, d, gx, gy, still ? 1 : CHASE_SPEED)) return treatHurt(w, e, p);
    const stale = !e.path || Math.hypot(gx - e.slotX, gy - e.slotY) > 0.25;
    const tile = Math.floor(gy) * w.map.w + Math.floor(gx);
    if (stale && e.path && tile === e.moveGoal) {
      e.slotX = gx;
      e.slotY = gy;
    } else if (stale && w.tick >= e.repathAt) {
      w.pathTo(e, gx, gy);
      e.repathAt = w.tick + 8;
    }
    if (e.path) w.walk(e, d);
    else e.moving = false;
  } else {
    e.path = null;
    e.moving = false;
    e.facing = e.turret = Math.atan2(dy, dx);
  }
  return treatHurt(w, e, p);
}

/** Medic e works on hurt soldier p this tick if within TREAT_REACH; done at full health. Always true (the tick is used). */
function treatHurt(w: World, e: Entity, p: Entity): boolean {
  if (Math.hypot(p.x - e.x, p.y - e.y) > TREAT_REACH) {
    e.treat = 0;
    return true;
  }
  e.treat++;
  p.hp = Math.min(p.maxHp, p.hp + (p.maxHp * TREAT_RATE) / TPS);
  if (p.hp >= p.maxHp) finishTreat(w, e);
  return true;
}

/** One straight step towards (gx, gy) at k x his speed, unless it leads off passable ground (false: use a path). */
function stepTo(w: World, e: Entity, d: UnitDef, gx: number, gy: number, k: number): boolean {
  const dx = gx - e.x;
  const dy = gy - e.y;
  const dd = Math.hypot(dx, dy);
  if (dd < 1e-6) return false;
  const step = Math.min(dd, (d.speed / TPS) * k);
  const nx = e.x + (dx / dd) * step;
  const ny = e.y + (dy / dd) * step;
  const tx = Math.floor(nx);
  const ty = Math.floor(ny);
  if (tx < 0 || ty < 0 || tx >= w.map.w || ty >= w.map.h || !w.pass[ty * w.map.w + tx]) return false;
  e.x = nx;
  e.y = ny;
  e.facing = e.turret = Math.atan2(dy, dx);
  e.moving = true;
  e.path = null;
  return true;
}

/**
 * Medic m at work (m.treat > 0), for the renderer: [hurt, stand]. hurt = the patient is on his feet (dressing,
 * no chest compressions); stand = working standing up beside a patient who walks on (no kneeling).
 */
export function treatPoseOf(w: World, m: Entity): [boolean, boolean] {
  if (m.treat <= 0 || m.order.type !== 'treat') return [false, false];
  const p = w.entities.get(m.order.target);
  if (!p || p.wound) return [false, false];
  return [true, p.moving || m.moving];
}

/**
 * Treatment progress of medic m at work, 0..1 (-1 = not at work): his time at a wounded soldier's side
 * (TREAT_TICKS), or a hurt soldier's health.
 */
export function treatProgress(w: World, m: Entity): number {
  if (m.treat <= 0 || m.order.type !== 'treat') return -1;
  const p = w.entities.get(m.order.target);
  if (!p || p.dead) return -1;
  return p.wound ? Math.min(1, m.treat / TREAT_TICKS) : Math.min(1, p.hp / p.maxHp);
}

/** The kneeling spot beside wounded soldier p for medic m (on m's side of him), and the patient's chest: [sx, sy, cx, cy]. */
export function treatSpot(p: Entity, m: Entity): [number, number, number, number] {
  const fx = Math.cos(p.facing);
  const fy = Math.sin(p.facing);
  const cx = p.x - fx * TORSO_BACK;
  const cy = p.y - fy * TORSO_BACK;
  const side = (m.x - cx) * -fy + (m.y - cy) * fx >= 0 ? 1 : -1;
  return [cx - fy * side * TREAT_SIDE, cy + fx * side * TREAT_SIDE, cx, cy];
}

/** Treatment over (done, or the patient is gone): back to the attack-move he was on, or stand here. */
function finishTreat(w: World, e: Entity) {
  const o = e.order;
  releasePatient(w, e);
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
