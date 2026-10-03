// Crushing and dodging (Red Alert 2 style).
//
// Heavy ground vehicles (UnitDef.crusher, see defs.ts) run over enemy infantry
// (UnitDef.crushable) whose footprint lies under the front / centre of the hull
// while the vehicle is driving at them. The soldier dies at once (death cause
// 'crushed'); the kill and its experience go to the vehicle.
//
// Never crushable: soldiers inside a transport or a garrisoned building
// (Entity.inside >= 0, not even on the spatial grid), paratroopers still under
// canopy (Entity.para), anything airborne. Friendly infantry are never crushed:
// they step out of the vehicle's way (a "yield" dodge) and are shoved aside
// sideways if they are still in contact; the vehicle is never held up by them.
//
// Dodging: infantry watch the projected path of nearby enemy crushers. A soldier
// in the vehicle's lane whose time to contact is under DODGE_LOOK seconds rolls
// once (seeded world RNG) to notice it in time; the chance depends on his rank,
// his posture (on the move, standing, firing / kneeling, dug in or with a mortar
// set up) and the vehicle's closing speed. A soldier who notices reacts after a
// short delay (faster for veterans, slower when firing or dug in), sprints
// sideways to the side away from the vehicle's line (the other side or straight
// back if that is blocked terrain), dives and rolls when it is a close call,
// stands clear until the vehicle has passed, then picks up his order again (a
// move re-plans to its formation slot, an idle soldier walks back to his post).
// Dodges have a cooldown, and the reaction delay is real: a soldier who reacts
// too late still gets run over.
//
// Everything here is deterministic: positions, ticks and World.rng only.

import { unitDef } from './defs';
import { TPS, type Entity, type UnitDef } from './types';
import type { World } from './world';

/** Minimum closing speed (tiles / s) of a vehicle on a soldier for a crush or a dodge. */
export const CRUSH_MIN_SPEED = 0.3;
/** Crush zone in the vehicle's frame (fractions of its radius; plus half the soldier's radius at the front / sides). */
export const CRUSH_FRONT = 0.95;
export const CRUSH_BACK = 0.55;
export const CRUSH_SIDE = 0.7;
/** Attack order on infantry: a crusher drives over the target when it is this close (tiles). */
export const CRUSH_CHASE = 2;
/** Seconds of the vehicle's projected path a soldier watches (enemy / friendly vehicle). */
export const DODGE_LOOK = 1.25;
export const YIELD_LOOK = 1;
/** Extra half-width of the watched lane beyond hull + soldier (tiles). */
export const DODGE_LANE = 0.3;
/** Chance to notice in time, per rank (rookie, veteran, elite), before posture and speed. */
export const DODGE_BASE = [0.5, 0.68, 0.82];
/** Reaction delay per rank (ticks), before the posture factor. */
export const DODGE_REACT = [5, 3, 2];
/** Sprint speed multipliers (of the soldier's walking speed): sidestep / dive. */
export const DODGE_SPRINT = 1.9;
export const DIVE_SPRINT = 2.4;
/** Time to contact (s) under which the dodge is a dive and roll. */
export const DIVE_TC = 0.6;
/** Ticks a diving soldier stays down before he is back on his feet. */
export const DIVE_DOWN = 14;
/** Cooldown before another dodge (ticks): after a roll at an enemy vehicle / after making way for a friendly one. */
export const DODGE_COOLDOWN = TPS * 2;
export const YIELD_COOLDOWN = TPS;
/** Closing speed (tiles / s) the dodge chance is balanced for (a main battle tank at full speed). */
const REF_SPEED = 2.2;

export type Posture = 'moving' | 'standing' | 'firing' | 'dug';
/** Posture factors: chance to notice the vehicle in time, and reaction delay. */
export const POSTURE_CHANCE: Record<Posture, number> = { moving: 1.1, standing: 1, firing: 0.8, dug: 0.55 };
export const POSTURE_REACT: Record<Posture, number> = { moving: 0.8, standing: 1, firing: 1.4, dug: 2 };

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Infantry on the ground that a vehicle can run over (not inside anything, not under canopy). */
export function isCrushable(e: Entity): boolean {
  return e.kind === 'unit' && !e.dead && e.inside < 0 && !e.para && e.z < 0.05 && !!unitDef(e.def).crushable;
}

/** A ground vehicle that runs infantry over. */
export function isCrusher(e: Entity): boolean {
  return e.kind === 'unit' && !e.dead && e.inside < 0 && !e.para && !!unitDef(e.def).crusher;
}

/** Attack order on infantry: drive over the target instead of standing off (target in contact range). */
export function wantsCrush(w: World, e: Entity, d: UnitDef, t: Entity): boolean {
  if (!d.crusher || e.stance === 'hold' || !w.isEnemy(e.owner, t.owner) || !isCrushable(t)) return false;
  return Math.hypot(t.x - e.x, t.y - e.y) <= CRUSH_CHASE;
}

/** How settled a soldier is (slower to react when firing or dug in). */
export function posture(w: World, o: Entity, od: UnitDef): Posture {
  const tick = w.tick;
  if (o.moving || o.x !== o.px || o.y !== o.py) return 'moving';
  if (od.model === 'mortar') return 'dug'; // the tube is set up
  if (o.targetId >= 0 || tick - o.firedAt < TPS * 1.5) return 'firing';
  // dug in: standing calm on the same spot for 8 s (the renderer shows the foxhole; render/unitlife.ts)
  const calm = o.order.type === 'idle' && (o.stance === 'guard' || o.stance === 'hold') && tick - o.lastHurt > 4 * TPS && tick - o.firedAt > 4 * TPS && !o.queue.length && !o.patrol && o.guardId < 0;
  if (calm && tick - o.stillAt > TPS * 8) return 'dug';
  return 'standing';
}

/** Chance (0..1) that soldier `o` notices a vehicle closing at `closing` tiles / s in time to dodge. */
export function dodgeChance(w: World, o: Entity, od: UnitDef, closing: number): number {
  const p = (DODGE_BASE[o.rank] ?? DODGE_BASE[0]) * POSTURE_CHANCE[posture(w, o, od)] * clamp(REF_SPEED / Math.max(0.1, closing), 0.7, 1.25);
  return clamp(p, 0.05, 0.95);
}

/** Reaction delay in ticks. */
export function reactTicks(w: World, o: Entity, od: UnitDef): number {
  return Math.max(1, Math.round((DODGE_REACT[o.rank] ?? DODGE_REACT[0]) * POSTURE_REACT[posture(w, o, od)]));
}

function passable(w: World, x: number, y: number) {
  return x > 0 && y > 0 && x < w.map.w && y < w.map.h && w.pass[w.tileOf(x, y)] === 1;
}

/** Move a soldier by (dx, dy) if the ground there is passable. */
function shove(w: World, e: Entity, dx: number, dy: number) {
  const nx = e.x + dx;
  const ny = e.y + dy;
  if (passable(w, nx, ny)) {
    e.x = nx;
    e.y = ny;
  }
}

// ------------------------------------------------------------------ contact

/**
 * Contact between a crusher and infantry (World.separate). Returns true when it handled the pair.
 * Enemy soldiers in the moving vehicle's lane are not pushed: they go under the tracks (updateCrush).
 * Anyone else in contact is shoved out sideways; the vehicle never yields to infantry.
 */
export function crushContact(w: World, a: Entity, ad: UnitDef, b: Entity, bd: UnitDef): boolean {
  let v: Entity;
  let vd: UnitDef;
  let s: Entity;
  let sd: UnitDef;
  if (ad.crusher && bd.crushable) {
    v = a;
    vd = ad;
    s = b;
    sd = bd;
  } else if (bd.crusher && ad.crushable) {
    v = b;
    vd = bd;
    s = a;
    sd = ad;
  } else return false;
  const R = vd.radius;
  const r = sd.radius;
  const min = R + r;
  const dx = s.x - v.x;
  const dy = s.y - v.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return true;
  const mx = v.x - v.px;
  const my = v.y - v.py;
  const m = Math.hypot(mx, my);
  if (m * TPS >= CRUSH_MIN_SPEED) {
    const hx = mx / m;
    const hy = my / m;
    const along = dx * hx + dy * hy;
    const lat = dy * hx - dx * hy;
    if (w.isEnemy(v.owner, s.owner) && along >= -CRUSH_BACK * R && Math.abs(lat) <= CRUSH_SIDE * R + 0.5 * r) return true;
    // out of the way, sideways (at most a quick step per tick)
    const side = Math.abs(lat) < 0.02 ? (s.id & 1 ? 1 : -1) : Math.sign(lat);
    const want = Math.sqrt(Math.max(0, min * min - along * along));
    const push = clamp(want - Math.abs(lat), 0, 0.15);
    if (push > 0) shove(w, s, -hy * side * push, hx * side * push);
    return true;
  }
  // a stationary vehicle doesn't budge for infantry: the soldier steps round it
  const dist = Math.sqrt(d2);
  const nx = dist > 1e-4 ? dx / dist : s.id & 1 ? 1 : -1;
  const ny = dist > 1e-4 ? dy / dist : 0;
  const push = Math.min(0.15, min - dist);
  shove(w, s, nx * push, ny * push);
  return true;
}

// ------------------------------------------------------------------ per tick

/** After movement and separation: crush infantry under moving crushers, and let the others see them coming. */
export function updateCrush(w: World) {
  const tick = w.tick;
  let victims: [Entity, Entity][] | null = null;
  for (const e of w.list) {
    if (e.dead || e.kind !== 'unit' || e.inside >= 0) continue;
    if (Math.abs(e.x - e.px) + Math.abs(e.y - e.py) > 0.02) e.stillAt = tick;
    const d = unitDef(e.def);
    if (!d.crusher || e.para) continue;
    const mx = e.x - e.px;
    const my = e.y - e.py;
    const m = Math.hypot(mx, my);
    const sp = m * TPS;
    if (sp < CRUSH_MIN_SPEED) continue;
    const hx = mx / m;
    const hy = my / m;
    const R = d.radius;
    const look = R + sp * DODGE_LOOK + 0.6;
    w.queryRadius(e.x, e.y, look, (o) => {
      if (o === e || !isCrushable(o)) return;
      const dx = o.x - e.x;
      const dy = o.y - e.y;
      if (dx * dx + dy * dy > look * look) return;
      const enemy = w.isEnemy(e.owner, o.owner);
      if (!enemy && o.owner !== e.owner) return;
      const od = unitDef(o.def);
      const r = od.radius;
      const along = dx * hx + dy * hy;
      const lat = dy * hx - dx * hy;
      const closing = sp - ((o.x - o.px) * hx + (o.y - o.py) * hy) * TPS;
      if (closing < CRUSH_MIN_SPEED) return;
      if (enemy && along >= -CRUSH_BACK * R && along <= CRUSH_FRONT * R + 0.5 * r && Math.abs(lat) <= CRUSH_SIDE * R + 0.5 * r) {
        (victims ??= []).push([o, e]);
        return;
      }
      // in the lane ahead, contact within the look-ahead time?
      if (o.dodge || tick < o.dodgeAt || along < 0 || Math.abs(lat) > R + r + DODGE_LANE) return;
      const tc = Math.max(0, along - R - 0.5 * r) / closing;
      if (tc > (enemy ? DODGE_LOOK : YIELD_LOOK)) return;
      if (!enemy && o.order.type === 'enter' && o.order.target === e.id) return; // boarding this very vehicle
      startDodge(w, o, od, e, d, hx, hy, lat, tc, closing, enemy);
    });
  }
  if (victims) for (const [o, e] of victims as [Entity, Entity][]) crush(w, o, e);
}

/** Vehicle `v` runs soldier `o` over. */
function crush(w: World, o: Entity, v: Entity) {
  if (o.dead || v.dead) return;
  w.events.push({ t: 'crushed', id: o.id, def: o.def, owner: o.owner, by: v.id, byDef: v.def, byOwner: v.owner, x: o.x, y: o.y });
  w.kill(o, v.owner, v, 'crushed');
}

/** Soldier `o` sees vehicle `v` coming (heading hx, hy; o is `lat` to its left): roll to notice, pick a side, start the dodge. */
function startDodge(w: World, o: Entity, od: UnitDef, v: Entity, vd: UnitDef, hx: number, hy: number, lat: number, tc: number, closing: number, enemy: boolean) {
  const tick = w.tick;
  let go = tick + 2;
  let dive = false;
  if (enemy) {
    o.dodgeAt = tick + DODGE_COOLDOWN; // one roll per close pass
    const p = dodgeChance(w, o, od, closing);
    const u = w.rng.next();
    if (u >= p) return; // didn't see it in time / froze
    // a soldier who only just made the roll spotted the vehicle late: close call, he dives (and may still be caught)
    const late = (u / p) * (u / p);
    const spot = Math.round(late * Math.max(0, tc - 0.3) * TPS * 0.85);
    const react = reactTicks(w, o, od) + spot;
    go = tick + react;
    dive = tc - react / TPS < DIVE_TC;
  }
  // sideways, away from the vehicle's line; the other side or straight back off if that is blocked
  const clear = vd.radius + od.radius + (dive ? 0.27 : 0.15); // a dive and roll ends a step further out
  const al = Math.abs(lat);
  const pref = al < 0.04 ? ((o.id + v.id) & 1 ? 1 : -1) : Math.sign(lat);
  const nx = -hy;
  const ny = hx;
  const tries: [number, number][] = [
    [nx * pref * (clear - al), ny * pref * (clear - al)],
    [-nx * pref * (clear + al), -ny * pref * (clear + al)],
    [nx * pref * 0.6 * clear - hx * 0.9 * clear, ny * pref * 0.6 * clear - hy * 0.9 * clear],
    [-nx * pref * 0.6 * clear - hx * 0.9 * clear, -ny * pref * 0.6 * clear - hy * 0.9 * clear],
  ];
  let goal: [number, number] | null = null;
  for (const [dx, dy] of tries) {
    const x = o.x + dx;
    const y = o.y + dy;
    if (passable(w, x, y) && passable(w, o.x + dx * 0.5, o.y + dy * 0.5)) {
      goal = [x, y];
      break;
    }
  }
  if (!goal) return; // nowhere to go
  o.dodge = { by: v.id, x: goal[0], y: goal[1], go, until: go + Math.round(TPS * 2.5), phase: 'wait', downUntil: 0, dive, yield: !enemy };
  w.events.push({ t: 'dodge', id: o.id, owner: o.owner, by: v.id, x: o.x, y: o.y, dive, yield: !enemy });
}

/**
 * Soldier with a dodge in progress (World.updateUnit). Returns true while the dodge moves / holds him this tick
 * (his order waits), false while he hasn't reacted yet or once it is over.
 */
export function stepDodge(w: World, e: Entity, d: UnitDef): boolean {
  const g = e.dodge!;
  const tick = w.tick;
  if (g.phase === 'wait') {
    if (tick < g.go) return false; // not reacted yet: carries on with what he was doing
    g.phase = 'run';
  }
  if (g.phase === 'run') {
    const dx = g.x - e.x;
    const dy = g.y - e.y;
    const dist = Math.hypot(dx, dy);
    const step = (d.speed * (g.dive ? DIVE_SPRINT : DODGE_SPRINT)) / TPS;
    let done = tick >= g.until;
    if (dist > 1e-4) {
      e.facing = Math.atan2(dy, dx);
      e.turret = e.facing;
    }
    if (dist <= step) {
      if (passable(w, g.x, g.y)) {
        e.x = g.x;
        e.y = g.y;
      }
      done = true;
    } else {
      const nx = e.x + (dx / dist) * step;
      const ny = e.y + (dy / dist) * step;
      if (passable(w, nx, ny)) {
        e.x = nx;
        e.y = ny;
      } else done = true;
    }
    e.moving = true;
    if (done) {
      g.phase = g.dive ? 'down' : 'clear';
      g.downUntil = tick + DIVE_DOWN;
    }
    return true;
  }
  e.moving = false;
  if (g.phase === 'down') {
    if (tick >= g.downUntil) g.phase = 'clear';
    return true;
  }
  // clear: stand aside until the vehicle has gone past (or stopped, or turned away)
  const v = w.get(g.by);
  let gone = !v || tick >= g.until;
  if (v && !gone) {
    const mx = v.x - v.px;
    const my = v.y - v.py;
    const m = Math.hypot(mx, my);
    if (m * TPS < CRUSH_MIN_SPEED) gone = true;
    else {
      const along = ((e.x - v.x) * mx + (e.y - v.y) * my) / m;
      const lat = Math.abs(((e.y - v.y) * mx - (e.x - v.x) * my) / m);
      gone = along < -unitDef(v.def).radius * 0.5 || lat > unitDef(v.def).radius + unitDef(e.def).radius + 1;
    }
  }
  if (!gone) return true;
  endDodge(w, e);
  return false;
}

/** Dodge over: cooldown, then back to the order (moves re-plan to their slot, idle soldiers return to their post). */
export function endDodge(w: World, e: Entity) {
  const g = e.dodge;
  if (!g) return;
  e.dodge = null;
  e.dodgeAt = Math.max(e.dodgeAt, w.tick + (g.yield ? YIELD_COOLDOWN : DODGE_COOLDOWN));
  const o = e.order;
  if ((o.type === 'move' || o.type === 'attackMove') && e.path) w.pathTo(e, e.slotX, e.slotY);
  else if (o.type === 'idle' && e.guardId < 0 && !e.patrol && Math.hypot(e.x - e.guardX, e.y - e.guardY) > 0.25) w.pathTo(e, e.guardX, e.guardY);
}
