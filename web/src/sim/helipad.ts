// Attack helicopter repair at the airbase (deterministic lockstep).
//
// A helicopter (UnitDef.rotary) below HELI_RETURN_HP of its health that its owner has not given an order
// in the last HELI_ORDER_GRACE ticks breaks off and flies to the nearest airbase of its owner with a free
// landing spot; the owner can also send it there on purpose (Command 'land': right-click / tap an own
// airbase), damaged or not. It lands on a spot on the open ground right beside the airbase (behind the
// parking stands, else off the ends of the stand / taxiway rows: never on the runway, the taxiway or the
// jets' stands), sits there with its rotors idling while the ground crew repairs it for free at the jets'
// REPAIR_RATE, lifts off once fully repaired and goes back to what it was doing: its attack or attack-move
// order if it had one, else back to where it was. A newer order from its owner cancels the trip at once.
// With no airbase it fights on. While it is down (z < GROUND_Z) it is a ground target, like a jet on its
// wheels (World.isAir). The AI's helicopters follow the same rule (the AI leaves them alone meanwhile).
//
// Plain arithmetic on entity state in tick order, no randomness.

import { buildingDef, unitDef } from './defs';
import { GROUND_Z, REPAIR_RATE } from './airbase';
import { TPS, type Entity, type HeliPad, type Order, type UnitDef } from './types';
import type { World } from './world';

/** Health fraction under which a helicopter flies home for repair on its own. */
export const HELI_RETURN_HP = 0.4;
/** An order from a human owner this recent keeps it in the fight (ticks). */
export const HELI_ORDER_GRACE = TPS * 5;
/** Damage check period (ticks). */
const HELI_SCAN = 10;
/** Descent / climb rates on the spot (tiles of altitude per tick). */
const LAND_RATE = 0.03;
const CLIMB_RATE = 0.045;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function turnToward(a: number, b: number, rate: number) {
  const d = angleDiff(a, b);
  if (Math.abs(d) <= rate) return b;
  return a + Math.sign(d) * rate;
}

export function isHeli(d: UnitDef | undefined): boolean {
  return !!d && !!d.rotary && !!d.air && !d.fixedWing && !d.temp;
}

/** Helicopter set down at an airbase (landing, on the ground, lifting off below GROUND_Z): a ground target. */
export function heliGrounded(e: Entity): boolean {
  return !!e.heli && e.z < GROUND_Z;
}

/** On the ground being repaired (for the UI and the repair sparks). */
export function heliRepairing(e: Entity): boolean {
  return !!e.heli && e.heli.phase === 'landed' && e.hp < e.maxHp;
}

/** Status line for the UI, or '' when not on a repair trip. */
export function heliStatus(e: Entity): string {
  const h = e.heli;
  if (!h) return '';
  switch (h.phase) {
    case 'return':
    case 'land':
      return 'Returning for repair';
    case 'landed':
      return `Repairing ${Math.floor(Math.min(1, e.hp / e.maxHp) * 100)}%`;
    case 'takeoff':
      return 'Repaired - taking off';
  }
}

function isBase(b: Entity | undefined, owner: number): b is Entity {
  return !!b && !b.dead && b.kind === 'building' && b.owner === owner && buildingDef(b.def).role === 'airfield' && b.buildAnim >= 1;
}

/**
 * Landing spots of an airbase (world tiles), in order of preference: the open ground behind the four
 * parking stands, then off both ends of the stand row, then off both ends of the taxiway row. The runway
 * row (and its approach / climb-out lines) and the slab itself are left to the jets. Spots on blocked or
 * built-up ground, or off the map, are left out (their index stays, so a spot keeps its number).
 */
export function helipadSpots(w: World, b: Entity): ([number, number] | null)[] {
  const d = buildingDef(b.def);
  const raw: [number, number][] = [];
  for (let i = 0; i < 4; i++) raw.push([b.tx + 0.75 + i * 1.5, b.ty - 0.8]);
  raw.push([b.tx - 0.8, b.ty + 0.9], [b.tx + d.w + 0.8, b.ty + 0.9], [b.tx - 0.8, b.ty + 2.1], [b.tx + d.w + 0.8, b.ty + 2.1]);
  const { w: mw, h: mh } = w.map;
  return raw.map(([x, y]) => {
    if (x < 0.6 || y < 0.6 || x > mw - 0.6 || y > mh - 0.6) return null;
    const t = w.tileOf(x, y);
    return w.pass[t] === 1 && w.occ[t] === 0 ? [x, y] : null;
  });
}

/** Spot indices of airbase b taken by other helicopters (on their way in, down or lifting off). */
function spotsTaken(w: World, b: Entity, self: Entity): Set<number> {
  const taken = new Set<number>();
  for (const o of w.list) if (!o.dead && o !== self && o.heli && o.heli.base === b.id) taken.add(o.heli.spot);
  return taken;
}

/** The free spot of airbase b nearest to helicopter e, or -1. */
function freeSpot(w: World, b: Entity, e: Entity): number {
  const spots = helipadSpots(w, b);
  const taken = spotsTaken(w, b, e);
  let best = -1;
  let bd = Infinity;
  spots.forEach((s, i) => {
    if (!s || taken.has(i)) return;
    const dd = Math.hypot(s[0] - e.x, s[1] - e.y);
    if (dd < bd - 1e-9) {
      bd = dd;
      best = i;
    }
  });
  return best;
}

/** Nearest completed airbase of e's owner with a free landing spot (or `only`, if given and usable). */
function findPad(w: World, e: Entity, only?: Entity): { base: Entity; spot: number } | null {
  let best: { base: Entity; spot: number } | null = null;
  let bd = Infinity;
  for (const b of only ? [only] : w.list) {
    if (!isBase(b, e.owner)) continue;
    const spot = freeSpot(w, b, e);
    if (spot < 0) continue;
    const dd = Math.hypot(b.x - e.x, b.y - e.y);
    if (dd < bd) {
      bd = dd;
      best = { base: b, spot };
    }
  }
  return best;
}

/** Keep the order to resume after the repair: an attack or attack-move; anything else is replaced by "back to here". */
function keepOrder(o: Order): Order {
  return o.type === 'attack' || o.type === 'attackMove' ? o : { type: 'idle' };
}

/**
 * Send helicopter e to an airbase for repair: `base` (the owner's order) or the nearest one with a free
 * spot (the automatic return). Returns false when there is nowhere to land.
 */
export function startHeliRepair(w: World, e: Entity, manual: boolean, base?: Entity): boolean {
  const pad = findPad(w, e, base);
  if (!pad) return false;
  const spot = helipadSpots(w, pad.base)[pad.spot]!;
  // a trip already under way: keep what it was doing before it
  const prev = e.heli;
  const h: HeliPad = {
    phase: prev && prev.phase !== 'takeoff' && e.z < GROUND_Z ? prev.phase : 'return',
    base: pad.base.id,
    spot: pad.spot,
    x: spot[0],
    y: spot[1],
    at: w.tick,
    manual,
    order: prev ? prev.order : keepOrder(e.order),
    ox: prev ? prev.ox : e.x,
    oy: prev ? prev.oy : e.y,
  };
  if (h.phase !== 'return' && (Math.abs(e.x - h.x) > 0.05 || Math.abs(e.y - h.y) > 0.05)) h.phase = 'return';
  e.heli = h;
  e.order = { type: 'idle' };
  e.targetId = -1;
  e.autoTarget = false;
  e.burstLeft = 0;
  e.path = null;
  e.queue.length = 0;
  e.patrol = null;
  e.guardId = -1;
  w.events.push({ t: 'heliPad', id: e.id, owner: e.owner, what: 'return', x: e.x, y: e.y });
  return true;
}

/** Player order: fly these helicopters to own airbase b and land them there for repair. */
export function orderLand(w: World, units: Entity[], b: Entity) {
  for (const e of units) {
    if (e.kind !== 'unit' || !isHeli(unitDef(e.def)) || !isBase(b, e.owner)) continue;
    // a trip already heading for this very airbase just carries on
    if (e.heli && e.heli.base === b.id && e.heli.phase !== 'takeoff') {
      e.heli.at = w.tick;
      e.heli.manual = true;
      continue;
    }
    startHeliRepair(w, e, true, b);
  }
}

/** Back to work: its attack / attack-move, else hover back to where it was. */
function resume(w: World, e: Entity, h: HeliPad) {
  e.heli = null;
  e.targetId = -1;
  const o = h.order;
  if (o.type === 'attack') {
    const t = w.foe(o.target);
    if (t && w.isEnemy(e.owner, t.owner) && w.canAttack(e.def, t)) {
      e.order = o;
      e.targetId = t.id;
      return;
    }
  }
  if (o.type === 'attackMove') {
    e.order = o;
    w.pathTo(e, o.x, o.y);
    return;
  }
  e.order = { type: 'idle' };
  if (Math.hypot(h.ox - e.x, h.oy - e.y) > 1.5) {
    e.order = { type: 'move', x: h.ox, y: h.oy };
    w.pathTo(e, h.ox, h.oy);
  }
  e.guardX = h.ox;
  e.guardY = h.oy;
}

/**
 * One tick of an attack helicopter (World.updateUnit). Starts the automatic repair trip when it is badly
 * damaged, and flies / lands / repairs / lifts off while one runs. Returns true while it controls the
 * helicopter this tick; false hands it to the normal flight and combat code.
 */
export function updateHeli(w: World, e: Entity, d: UnitDef): boolean {
  if (!e.heli) {
    if ((w.tick + e.id) % HELI_SCAN !== 0 || e.hp >= e.maxHp * HELI_RETURN_HP) return false;
    const p = w.players[e.owner];
    if (!p || (!p.isAI && w.tick - e.orderAt < HELI_ORDER_GRACE)) return false;
    if (!startHeliRepair(w, e, false)) return false; // no airbase: it fights on
  }
  const h = e.heli!;
  // a newer order from its owner takes over (it climbs back to its altitude on the way)
  if (e.orderAt > h.at) {
    e.heli = null;
    return false;
  }
  // airbase lost (destroyed, sold, captured), or a structure has gone up on the landing spot
  if (!isBase(w.get(h.base), e.owner) || (h.phase !== 'takeoff' && w.occ[w.tileOf(h.x, h.y)] !== 0)) {
    // another spot / airbase, or back to the fight
    const keepManual = h.manual;
    if (!startHeliRepair(w, e, keepManual)) {
      resume(w, e, h); // nowhere to land: back to what it was doing, in the air
      return false;
    }
    e.heli!.at = h.at;
  }
  const hp = e.heli!;
  const cruise = d.cruiseAlt ?? 1.15;
  e.targetId = -1;
  e.burstLeft = 0;
  e.path = null;
  switch (hp.phase) {
    case 'return': {
      const dx = hp.x - e.x;
      const dy = hp.y - e.y;
      const dist = Math.hypot(dx, dy);
      const jam = e.jammedUntil > w.tick ? 0.35 : 1;
      const step = (d.speed / TPS) * jam * clamp(dist / 1.2, 0.25, 1);
      e.z += clamp(cruise - e.z, -0.05, 0.05);
      if (dist <= Math.max(0.04, step)) {
        e.x = hp.x;
        e.y = hp.y;
        e.moving = false;
        hp.phase = 'land';
        break;
      }
      const want = Math.atan2(dy, dx);
      e.facing = turnToward(e.facing, want, d.turnRate * 1.5);
      e.turret = e.facing;
      const k = Math.max(0.35, Math.cos(angleDiff(e.facing, want)));
      e.x += Math.cos(e.facing) * step * k;
      e.y += Math.sin(e.facing) * step * k;
      e.moving = true;
      break;
    }
    case 'land': {
      e.moving = false;
      e.x += (hp.x - e.x) * 0.3;
      e.y += (hp.y - e.y) * 0.3;
      e.z = Math.max(0, e.z - LAND_RATE);
      if (e.z <= 0) {
        e.z = 0;
        hp.phase = 'landed';
        w.events.push({ t: 'heliPad', id: e.id, owner: e.owner, what: 'landed', x: e.x, y: e.y });
      }
      break;
    }
    case 'landed': {
      e.z = 0;
      e.moving = false;
      e.x = hp.x;
      e.y = hp.y;
      // the ground crew patches it up (free, the jets' rate)
      if (e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * REPAIR_RATE) / TPS);
      if (e.hp >= e.maxHp) {
        hp.phase = 'takeoff';
        w.events.push({ t: 'heliPad', id: e.id, owner: e.owner, what: 'takeoff', x: e.x, y: e.y });
      }
      break;
    }
    case 'takeoff': {
      e.moving = false;
      e.z = Math.min(cruise, e.z + CLIMB_RATE);
      if (e.z >= cruise - 0.02) resume(w, e, hp);
      break;
    }
  }
  return true;
}
