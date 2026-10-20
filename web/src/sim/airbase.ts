// Airbases and the fixed-wing jet sortie cycle (RA2 style, deterministic lockstep).
//
// A combat jet lives on one of its airbase's 4 parking pads. Ordered to strike, it
// taxis out along the taxiway, holds short of the runway until the runway is free,
// lines up, rolls and takes off, flies to the target and drops ONE heavy bomb in
// level flight, flies home, joins the final approach, lands, rolls out, taxis back
// to its pad and rearms there for 10 s, while the ground crew repairs any battle damage (free, REPAIR_RATE).
// It takes off again only when armed AND fully repaired, except that a fresh order the owner gives that jet
// launches it as soon as it is armed. Automatic re-strike: if the target survives the bomb, the jet keeps the
// attack order, and after rearm and repair it sorties against the same target again, until the target is
// destroyed, is no longer a valid / visible target, or the owner gives a new order. Only one jet uses a runway at a time (the
// airbase's `dockedBy` holds the runway lock), taxiing jets keep their distance, and
// the jet cap is the number of pads (4 per completed airbase).
//
// Losing the airbase: jets on the ground die with it; airborne jets divert to another
// airbase with a free pad, or circle (with no time limit) until one is built or frees up.
//
// Aircraft carriers (NV2) are airbases at sea: their deck jets park on the deck pads, launch off the bow (a
// catapult, or a ski-jump run), land back on the moving deck from the stern and are arrested on the angled deck.
// On deck a jet's position is kept in the ship's frame (Sortie.lx / ly / lf) and follows the ship as it sails;
// the final approach is flown in that frame too, so the touchdown keeps up with the deck smoothly. A sunk
// carrier takes the jets on its deck down with it; the airborne divert to another carrier or an airbase.
//
// Everything here is plain arithmetic on entity state in tick order, no randomness,
// so every client computes the same thing.

import { DEFS, WEAPONS, buildingDef, unitDef } from './defs';
import { launch } from './ballistics';
import { TPS, type Entity, type Sortie, type SortiePhase, type UnitDef } from './types';
import type { World } from './world';

/** Parking pads (and so jets) per airbase. */
export const PADS_PER_BASE = 4;
/** Rearm time on the pad after a strike. */
export const REARM_TICKS = TPS * 10;
/** Free repair on the pad: fraction of max HP per second (runs alongside the rearm). */
export const REPAIR_RATE = 0.04;
/** Endurance of a jet that has lost its airbase. */
export const FUEL_TICKS = TPS * 30;

const TAXI_V = 1.5 / TPS; // tiles per tick
const TAXI_ACC = 1.6 / TPS / TPS;
const TAXI_TURN = 0.12; // rad per tick
const TO_ACC = 2.4 / TPS / TPS; // take-off roll acceleration
const ROTATE_K = 0.66; // rotate at this fraction of the reference cruise speed
const REF_V = 5.0 / TPS; // reference cruise speed for the take-off roll: faster jets (F-35) rotate at the same speed, then accelerate in the air
const CLIMB = 0.028; // tiles per tick on climb-out
const APPROACH_V = 3.2 / TPS;
const TOUCH_V = 2.6 / TPS;
const ROLL_DEC = 1.4 / TPS / TPS;
const GLIDE_ALT = 1.3; // altitude at the final approach fix
const FINAL_LEN = 6; // final approach fix: tiles before touchdown
const RELEASE_DIST = 3.0; // bomb release: tiles short of the target
const PARK_FACING = Math.PI / 2; // nose out of the stand, towards the taxiway
/** Below this altitude a jet counts as on the ground (ground weapons can hit it, AA cannot). */
export const GROUND_Z = 0.3;

const GROUND_PHASES: ReadonlySet<SortiePhase> = new Set(['parked', 'taxiOut', 'hold', 'lineup', 'rollout', 'taxiIn']);

export function isSortieJet(d: UnitDef | undefined): boolean {
  return !!d && !!d.fixedWing && !!d.weapon && !d.airlift;
}

/** Jet on its wheels (parked, taxiing, rolling): a ground target, not an aircraft. */
export function jetGrounded(e: Entity): boolean {
  return !!e.sortie && e.z < GROUND_Z;
}

function clamp(x: number, a: number, b: number) {
  return x < a ? a : x > b ? b : x;
}
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

// ------------------------------------------------------------------ geometry

/**
 * Airbase layout in world tiles. The footprint is 7 x 4: four parking stands along the back row
 * (1.5 tiles apart), the control tower in the back-right corner, the taxiway across the middle and
 * the runway along the front row. Runway ops are one-way: take-off and landing both head along
 * `dir` (+1 east / -1 west), chosen so the final approach comes in over the roomier side of the map.
 */
export interface BaseGeo {
  dir: 1 | -1;
  pads: number[]; // pad centre x
  padY: number;
  taxiY: number;
  rwyY: number;
  startX: number; // threshold end: take-off rolls start, landings touch down just past it
  endX: number;
  tdX: number; // touchdown point
  fx: number; // final approach fix (x on the extended centreline)
}

export function baseGeo(w: World, b: Entity): BaseGeo {
  const d = buildingDef(b.def);
  const roomW = b.tx;
  const roomE = w.map.w - (b.tx + d.w);
  const dir: 1 | -1 = roomW >= roomE ? 1 : -1;
  const x0 = b.tx + 0.55;
  const x1 = b.tx + d.w - 0.55;
  const startX = dir > 0 ? x0 : x1;
  const tdX = startX + dir * 1.1;
  const pads: number[] = [];
  for (let i = 0; i < PADS_PER_BASE; i++) pads.push(b.tx + 0.75 + i * 1.5);
  return {
    dir,
    pads,
    padY: b.ty + 0.85,
    taxiY: b.ty + 2.05,
    rwyY: b.ty + d.h - 0.8,
    startX,
    endX: dir > 0 ? x1 : x0,
    tdX,
    fx: clamp(tdX - dir * FINAL_LEN, 1, w.map.w - 1),
  };
}

/** An aircraft carrier (a unit with deck pads), alive. */
export function isAircraftCarrier(b: Entity | undefined): b is Entity {
  return !!b && !b.dead && b.kind === 'unit' && !!unitDef(b.def).deck;
}

function isBase(b: Entity | undefined, owner: number): b is Entity {
  if (!b || b.dead || b.owner !== owner) return false;
  if (b.kind === 'unit') return !!unitDef(b.def).deck;
  return buildingDef(b.def).role === 'airfield' && b.buildAnim >= 1;
}

/** Parking pads of an airbase or a carrier's deck. */
function padCount(b: Entity): number {
  return b.kind === 'unit' ? (unitDef(b.def).deck ?? 0) : PADS_PER_BASE;
}

/** Pads of an airbase (or a deck) taken by jets assigned to it (the pad is theirs while they are out on a sortie, too). */
function padsTaken(w: World, b: Entity): boolean[] {
  const n = padCount(b);
  const taken: boolean[] = new Array(n).fill(false);
  for (const e of w.list) {
    if (e.dead || !e.sortie || e.sortie.base !== b.id) continue;
    if (e.sortie.pad >= 0 && e.sortie.pad < n) taken[e.sortie.pad] = true;
  }
  return taken;
}

export function freePad(w: World, b: Entity): number {
  return padsTaken(w, b).indexOf(false);
}

/**
 * Nearest base of the jet's owner with a free pad: a deck jet makes for a carrier first, then an airbase; the
 * airbase jets use airbases only (a carrier's deck is for its own air wing).
 */
function findBase(w: World, e: Entity): Entity | null {
  const deckJet = !!unitDef(e.def).deckJet;
  let best: Entity | null = null;
  let bd = Infinity;
  for (const b of w.list) {
    if (!isBase(b, e.owner) || (b.kind === 'unit' && !deckJet) || freePad(w, b) < 0) continue;
    // (a carrier's deck before any airbase, for its own jets)
    const dd = Math.hypot(b.x - e.x, b.y - e.y) + (deckJet && b.kind !== 'unit' ? 1e4 : 0);
    if (dd < bd) {
      bd = dd;
      best = b;
    }
  }
  return best;
}

/** Jet cap: 4 jets per completed airbase (the airbase jets; a carrier's air wing has its own cap: deckCap). */
export function padCap(w: World, pid: number): number {
  let n = 0;
  for (const b of w.list) if (b.kind === 'building' && isBase(b, pid)) n++;
  return n * PADS_PER_BASE;
}

/** Deck jet cap: the deck pads of the player's carriers. */
export function deckCap(w: World, pid: number): number {
  let n = 0;
  for (const b of w.list) if (b.kind === 'unit' && isBase(b, pid)) n += padCount(b);
  return n;
}

/** Combat jets a player owns (on the ground and in the air): the airbase jets, or (deck) the carrier air wing. */
export function jetCount(w: World, pid: number, deck = false): number {
  let n = 0;
  for (const e of w.list) {
    if (e.dead || e.owner !== pid || e.kind !== 'unit') continue;
    const d = unitDef(e.def);
    if (isSortieJet(d) && !!d.deckJet === deck) n++;
  }
  return n;
}

/** Jets waiting in a player's air production queue (the airbase jets, or the deck jets). */
export function jetsQueued(w: World, pid: number, deck = false): number {
  let n = 0;
  for (const q of w.players[pid].queues.air) {
    const d = DEFS[q.def];
    if (d && d.kind === 'unit' && isSortieJet(d) && !!d.deckJet === deck) n++;
  }
  return n;
}

/** The player's carrier with a free deck pad (where a new deck jet is put), or null. */
export function carrierWithPad(w: World, pid: number): Entity | null {
  for (const b of w.list) if (b.kind === 'unit' && isBase(b, pid) && freePad(w, b) >= 0) return b;
  return null;
}

function newSortie(e: Entity, d: UnitDef): Sortie {
  return { phase: 'return', base: -1, pad: -1, ammo: 1, rearm: 0, v: d.speed / TPS, path: [], wp: 0, tx: -1, ty: -1, fuel: FUEL_TICKS, ox: e.x, oy: e.y, auto: -1, autoAt: 0 };
}

/** Put a jet on a free pad of base b, parked, armed and ready (new jets from production). */
export function parkJet(w: World, e: Entity, b: Entity): boolean {
  const pad = freePad(w, b);
  if (pad < 0) return false;
  const d = unitDef(e.def);
  const s = e.sortie ?? newSortie(e, d);
  e.sortie = s;
  s.base = b.id;
  s.pad = pad;
  s.phase = 'parked';
  s.v = 0;
  s.ammo = 1;
  s.rearm = 0;
  s.path = [];
  s.wp = 0;
  s.auto = -1;
  e.z = e.pz = 0;
  e.moving = false;
  e.order = { type: 'idle' };
  if (b.kind === 'unit') {
    // on a carrier's deck pad, nose in from the deck edge
    const [px, py] = DECK.pads[pad];
    s.lx = px;
    s.ly = py;
    s.lf = DECK.park;
    deckPose(e, b, s);
    e.px = e.x;
    e.py = e.y;
    e.pfacing = e.pturret = e.facing;
    return true;
  }
  const g = baseGeo(w, b);
  e.x = e.px = g.pads[pad];
  e.y = e.py = g.padY;
  e.facing = e.pfacing = e.turret = e.pturret = PARK_FACING;
  return true;
}

/** Ready for a strike: parked on its pad, armed, rearm finished and fully repaired. */
export function jetReady(e: Entity): boolean {
  const s = e.sortie;
  return !!s && s.phase === 'parked' && s.ammo > 0 && s.rearm <= 0 && e.hp >= e.maxHp;
}

/** Being repaired: a damaged jet parked on its pad. */
export function jetRepairing(e: Entity): boolean {
  return !!e.sortie && e.sortie.phase === 'parked' && e.hp < e.maxHp;
}

/** Repair state 0..1 for the UI (the jet's health; 1 = fully repaired), or -1 for non-jets. */
export function repairProgress(e: Entity): number {
  if (!e.sortie) return -1;
  return Math.min(1, Math.max(0, e.hp / e.maxHp));
}

/** Is the jet's attack order an automatic re-strike (kept after a release, not a fresh order from its owner)? */
export function autoStrike(e: Entity): boolean {
  const s = e.sortie;
  if (!s || s.auto < 0) return false;
  if (e.order.type === 'attack' && e.order.target === s.auto && e.orderAt === s.autoAt) return true;
  s.auto = -1; // a new order (or stop) replaced it
  return false;
}

/** Rearm progress 0..1 for the UI (1 = ready / not rearming), or -1 for non-jets. */
export function rearmProgress(e: Entity): number {
  const s = e.sortie;
  if (!s) return -1;
  if (s.rearm > 0) return 1 - s.rearm / REARM_TICKS;
  return s.ammo > 0 ? 1 : 0;
}

// ------------------------------------------------------------------ runway lock

function takeRunway(b: Entity, e: Entity): boolean {
  if (b.dockedBy >= 0 && b.dockedBy !== e.id) return false;
  b.dockedBy = e.id;
  return true;
}
function freeRunway(b: Entity | undefined, e: Entity) {
  if (b && b.dockedBy === e.id) b.dockedBy = -1;
}

// ------------------------------------------------------------------ movement

function frontBlocked(w: World, e: Entity): boolean {
  const s = e.sortie!;
  const fx = Math.cos(e.facing);
  const fy = Math.sin(e.facing);
  for (const o of w.list) {
    if (o === e || o.dead || !o.sortie || o.sortie.base !== s.base || o.z > 0.05) continue;
    const op = o.sortie.phase;
    if (op === 'parked' || op === 'takeoff') continue;
    const dx = o.x - e.x;
    const dy = o.y - e.y;
    const dd = Math.hypot(dx, dy);
    if (dd > 1.25 || dd < 1e-6) continue;
    if ((dx * fx + dy * fy) / dd < 0.55) continue;
    // head-on: the lower id goes first
    const bx = Math.cos(o.facing);
    const by = Math.sin(o.facing);
    if ((-dx * bx - dy * by) / dd > 0.55 && e.id < o.id) continue;
    return true;
  }
  return false;
}

/** Follow the taxi waypoints. Returns true once the last one is reached. */
function taxi(w: World, e: Entity, s: Sortie): boolean {
  e.z = 0;
  if (s.wp * 2 >= s.path.length) {
    s.v = 0;
    e.moving = false;
    return true;
  }
  const wx = s.path[s.wp * 2];
  const wy = s.path[s.wp * 2 + 1];
  const dx = wx - e.x;
  const dy = wy - e.y;
  const dist = Math.hypot(dx, dy);
  const last = (s.wp + 1) * 2 >= s.path.length;
  if (dist < (last ? 0.03 : 0.16)) {
    s.wp++;
    if (last) {
      e.x = wx;
      e.y = wy;
      s.v = 0;
      e.moving = false;
      return true;
    }
    return false;
  }
  const want = Math.atan2(dy, dx);
  e.facing = turnToward(e.facing, want, TAXI_TURN);
  const off = Math.abs(angleDiff(e.facing, want));
  let target = TAXI_V * clamp(1 - off / 1.1, 0, 1);
  if (last) target = Math.min(target, Math.max(0.006, dist * 0.15));
  if (frontBlocked(w, e)) target = 0;
  s.v += clamp(target - s.v, -TAXI_ACC * 3, TAXI_ACC);
  if (s.v < 0) s.v = 0;
  const step = Math.min(s.v, dist);
  e.x += Math.cos(e.facing) * step;
  e.y += Math.sin(e.facing) * step;
  e.moving = s.v > 0.002;
  e.turret = e.facing;
  return false;
}

/** Airborne: steer for (gx, gy) at a speed and altitude. */
function fly(w: World, e: Entity, d: UnitDef, s: Sortie, gx: number, gy: number, speed: number, alt: number, turnMul = 1, steer = true) {
  if (steer) e.facing = turnToward(e.facing, Math.atan2(gy - e.y, gx - e.x), d.turnRate * turnMul);
  const jam = e.jammedUntil > w.tick ? 0.5 : 1;
  s.v += clamp(speed * jam - s.v, -0.006, 0.004);
  e.x += Math.cos(e.facing) * s.v;
  e.y += Math.sin(e.facing) * s.v;
  const { w: mw, h: mh } = w.map;
  if (e.x < 0.5 || e.y < 0.5 || e.x > mw - 0.5 || e.y > mh - 0.5) {
    e.x = clamp(e.x, 0.5, mw - 0.5);
    e.y = clamp(e.y, 0.5, mh - 0.5);
  }
  e.z += clamp(alt - e.z, -0.045, 0.05);
  e.turret = e.facing;
  e.moving = true;
  e.path = null;
}

// ------------------------------------------------------------------ missions

/** A ground target the bomb can hit (enemy, visible to the owner), nearest to (x, y) within r. */
function targetNear(w: World, e: Entity, x: number, y: number, r: number): Entity | null {
  const wpn = WEAPONS[unitDef(e.def).weapon!];
  let best: Entity | null = null;
  let bs = Infinity;
  w.queryRadius(x, y, r, (o) => {
    if (!w.isEnemy(e.owner, o.owner) || o.inside >= 0 || !w.canHit(wpn, o)) return;
    if (o.kind === 'unit' && unitDef(o.def).temp) return;
    if (!w.sees(e.owner, o)) return;
    const dd = Math.hypot(o.x - x, o.y - y);
    if (dd > r) return;
    // structures and armour first: a heavy bomb is wasted on one rifleman
    const score = dd + (o.kind === 'building' ? -1 : unitDef(o.def).category === 'infantry' ? 1.5 : 0);
    if (score < bs) {
      bs = score;
      best = o;
    }
  });
  return best;
}

/**
 * The current strike target of an attack order, re-acquired near the last aim point if it is gone.
 * An automatic re-strike never re-acquires: once its target is destroyed, or is no longer a valid target
 * (a unit out of sight, captured, airborne), the order is dropped and the jet stays home / heads home.
 */
function strikeTarget(w: World, e: Entity, s: Sortie): Entity | null {
  const o = e.order;
  if (o.type !== 'attack') return null;
  const wpn = WEAPONS[unitDef(e.def).weapon!];
  const t = w.foe(o.target); // (a soldier lying wounded is no target: medic.ts)
  const auto = autoStrike(e);
  if (t && w.isEnemy(e.owner, t.owner) && w.canHit(wpn, t) && (!auto || t.kind === 'building' || w.sees(e.owner, t))) {
    s.tx = t.x;
    s.ty = t.y;
    return t;
  }
  if (auto) {
    s.auto = -1;
    e.order = { type: 'idle' };
    return null;
  }
  if (s.tx >= 0) {
    const n = targetNear(w, e, s.tx, s.ty, 4.0);
    if (n) {
      e.order = { type: 'attack', target: n.id, forced: true };
      return n;
    }
  }
  e.order = { type: 'idle' };
  return null;
}

/** Does the jet have somewhere to go (an attack / attack-move needs a bomb aboard)? Drops dead attack orders. */
function hasMission(w: World, e: Entity, s: Sortie): boolean {
  const o = e.order;
  if (o.type === 'move') return true;
  if (o.type === 'attackMove') return s.ammo > 0;
  if (o.type === 'attack') {
    const t = strikeTarget(w, e, s);
    return !!t && s.ammo > 0;
  }
  if (o.type !== 'idle') e.order = { type: 'idle' };
  return false;
}

function release(w: World, e: Entity, d: UnitDef, s: Sortie, t: Entity) {
  const wpn = WEAPONS[d.weapon!];
  launch(w, e, t, wpn, t.x, t.y);
  e.firedAt = w.tick;
  e.flashAt = w.tick; // the release gives the jet away by night (night.ts)
  s.ammo = 0;
  // keep the attack order: if the target survives the bomb, the jet comes back for it after rearm and repair
  e.order = { type: 'attack', target: t.id, forced: true };
  s.auto = t.id;
  s.autoAt = e.orderAt;
  e.targetId = -1;
  s.phase = 'return';
  w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'release', x: e.x, y: e.y });
}

// ------------------------------------------------------------------ the cycle

function setPath(s: Sortie, pts: number[]) {
  s.path = pts;
  s.wp = 0;
}

function taxiHome(s: Sortie, g: BaseGeo, x: number) {
  setPath(s, [x, g.taxiY, g.pads[s.pad], g.taxiY, g.pads[s.pad], g.padY]);
  s.phase = 'taxiIn';
}

function goHomeless(w: World, e: Entity, s: Sortie, x: number, y: number) {
  s.base = -1;
  s.pad = -1;
  s.ox = x;
  s.oy = y;
  if (s.phase !== 'sortie') {
    s.phase = 'orbit';
    w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'orbit', x: e.x, y: e.y });
  }
}

function crash(w: World, e: Entity) {
  w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'crash', x: e.x, y: e.y });
  w.kill(e, -1);
}

// ------------------------------------------------------------------ the carrier's deck

/**
 * Flight deck layout of a carrier, in the ship's frame (tiles; x towards the bow, y to starboard). The models
 * (render/naval, tools/blender/naval) are built to it: the island aft of amidships to starboard, two deck pads
 * forward of it and two aft, the launch run along the port side of the bow (catapult track, or the run-up to the
 * ski-jump), the landing area on the deck angled off to port aft (touchdown, arresting wires).
 */
export const DECK = {
  bow: 2.6,
  stern: -2.6,
  /** Deck pads (x, y) and the parking heading on them (nose towards the port side, a little forward). */
  pads: [
    [1.75, 0.42],
    [1.05, 0.44],
    [-1.45, 0.44],
    [-2.12, 0.42],
  ] as [number, number][],
  park: -1.25,
  /** Launch: the run starts here and leaves the deck at the bow (heading straight ahead). */
  launchX: -0.15,
  launchY: -0.22,
  /** Ski-jump: the ramp over the last stretch of the bow lifts the jet this high. */
  rampLen: 0.75,
  rampZ: 0.12,
  /** Landing: touchdown point and the angled deck's heading (to port of the ship's axis), arrested within stopLen. */
  tdX: -2.05,
  tdY: -0.12,
  angle: -0.16,
  stopLen: 1.15,
  /** Taxi lane down the middle of the deck. */
  laneY: 0.08,
};

const DECK_FINAL = 5.5; // final approach fix: tiles astern of the touchdown along the angled deck
const CAT_ACC = 9.0 / TPS / TPS; // catapult stroke
const JUMP_ACC = 3.4 / TPS / TPS; // full-power run to the ski-jump
const ARREST_DEC = 5.0 / TPS / TPS; // arresting wire

/** Ship frame -> world for a carrier. */
export function deckToWorld(c: Entity, lx: number, ly: number): [number, number] {
  const co = Math.cos(c.facing);
  const si = Math.sin(c.facing);
  return [c.x + lx * co - ly * si, c.y + lx * si + ly * co];
}

/** World -> ship frame for a carrier. */
function worldToDeck(c: Entity, x: number, y: number): [number, number] {
  const co = Math.cos(c.facing);
  const si = Math.sin(c.facing);
  const dx = x - c.x;
  const dy = y - c.y;
  return [dx * co + dy * si, -dx * si + dy * co];
}

/** Put the jet where its deck position says (it rides along with the ship). */
function deckPose(e: Entity, c: Entity, s: Sortie) {
  const [x, y] = deckToWorld(c, s.lx ?? 0, s.ly ?? 0);
  e.x = x;
  e.y = y;
  e.facing = e.turret = c.facing + (s.lf ?? 0);
}

/** Deck taxi along the waypoints in the ship's frame. Returns true once the last one is reached. */
function deckTaxi(e: Entity, c: Entity, s: Sortie): boolean {
  e.z = 0;
  let lx = s.lx ?? 0;
  let ly = s.ly ?? 0;
  let lf = s.lf ?? 0;
  let done = false;
  if (s.wp * 2 >= s.path.length) done = true;
  else {
    const wx = s.path[s.wp * 2];
    const wy = s.path[s.wp * 2 + 1];
    const dx = wx - lx;
    const dy = wy - ly;
    const dist = Math.hypot(dx, dy);
    const last = (s.wp + 1) * 2 >= s.path.length;
    if (dist < (last ? 0.03 : 0.12)) {
      s.wp++;
      if (last) {
        lx = wx;
        ly = wy;
        done = true;
      }
    } else {
      const want = Math.atan2(dy, dx);
      lf = turnToward(lf, want, TAXI_TURN);
      const off = Math.abs(angleDiff(lf, want));
      let target = TAXI_V * 0.8 * clamp(1 - off / 1.1, 0, 1);
      if (last) target = Math.min(target, Math.max(0.006, dist * 0.15));
      s.v += clamp(target - s.v, -TAXI_ACC * 3, TAXI_ACC);
      if (s.v < 0) s.v = 0;
      const step = Math.min(s.v, dist);
      lx += Math.cos(lf) * step;
      ly += Math.sin(lf) * step;
    }
  }
  if (done) s.v = 0;
  s.lx = lx;
  s.ly = ly;
  s.lf = lf;
  e.moving = s.v > 0.002;
  deckPose(e, c, s);
  return done;
}

/** Taxi from where the jet stands on deck back to its pad. */
function deckTaxiHome(s: Sortie) {
  const [px, py] = DECK.pads[s.pad] ?? DECK.pads[0];
  setPath(s, [s.lx ?? 0, DECK.laneY, px, DECK.laneY, px, py]);
  s.phase = 'taxiIn';
}

/**
 * One tick of a deck jet in the phases its carrier's deck handles (on deck, the return and the final approach).
 * Returns false when the phase is not a deck phase (the shared airborne cycle runs it).
 */
function deckSortie(w: World, e: Entity, d: UnitDef, s: Sortie, c: Entity): boolean {
  const cruise = d.cruiseAlt ?? 2.6;
  const vCruise = d.speed / TPS;
  const vRef = Math.min(vCruise, REF_V);
  const shipV = Math.hypot(c.x - c.px, c.y - c.py);
  const axis = c.facing + DECK.angle; // the angled deck's heading in the world
  switch (s.phase) {
    case 'parked': {
      e.z = 0;
      s.v = 0;
      e.moving = false;
      const [px, py] = DECK.pads[s.pad] ?? DECK.pads[0];
      s.lx = (s.lx ?? px) + (px - (s.lx ?? px)) * 0.2;
      s.ly = (s.ly ?? py) + (py - (s.ly ?? py)) * 0.2;
      s.lf = turnToward(s.lf ?? DECK.park, DECK.park, 0.05);
      deckPose(e, c, s);
      if (s.rearm > 0 && --s.rearm === 0) s.ammo = 1;
      if (s.rearm <= 0 && s.ammo <= 0) s.ammo = 1;
      if (e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * REPAIR_RATE) / TPS);
      if (s.rearm <= 0 && hasMission(w, e, s) && (e.hp >= e.maxHp || !autoStrike(e))) {
        setPath(s, [px, DECK.laneY, DECK.launchX, DECK.laneY, DECK.launchX, DECK.launchY]);
        s.phase = 'taxiOut';
      }
      return true;
    }
    case 'taxiOut': {
      if (!hasMission(w, e, s)) {
        deckTaxiHome(s);
        return true;
      }
      if (deckTaxi(e, c, s)) s.phase = 'hold';
      return true;
    }
    case 'hold':
    case 'lineup': {
      e.z = 0;
      s.v = 0;
      e.moving = false;
      if (!hasMission(w, e, s)) {
        freeRunway(c, e);
        deckTaxiHome(s);
        return true;
      }
      // on the catapult (or at the start of the run), nose to the bow, once the deck is clear
      s.lf = turnToward(s.lf ?? 0, 0, TAXI_TURN);
      deckPose(e, c, s);
      if (s.phase === 'hold') {
        if (takeRunway(c, e)) s.phase = 'lineup';
      } else if (Math.abs(angleDiff(s.lf ?? 0, 0)) < 1e-3) {
        s.phase = 'takeoff';
        s.v = 0;
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'takeoff', x: e.x, y: e.y });
      }
      return true;
    }
    case 'takeoff': {
      if ((s.lx ?? 0) >= DECK.bow) return false; // off the deck: the shared climb-out
      // the catapult throws it off the bow; a ski-jump launch is a full-power run up the ramp
      s.v = Math.min(vRef * ROTATE_K * 1.05, s.v + (d.deckJet === 'catapult' ? CAT_ACC : JUMP_ACC));
      s.lf = 0;
      const lx = (s.lx ?? 0) + s.v;
      s.lx = lx;
      s.ly = (s.ly ?? 0) + (DECK.launchY - (s.ly ?? 0)) * 0.3;
      const ramp = (lx - (DECK.bow - DECK.rampLen)) / DECK.rampLen;
      e.z = d.deckJet === 'skijump' && ramp > 0 ? DECK.rampZ * Math.min(1, ramp) ** 2 : 0;
      deckPose(e, c, s);
      e.moving = true;
      if (lx >= DECK.bow) {
        // airborne off the bow: from here on it flies in the world, with the ship's way on it
        s.v += shipV;
        e.z = Math.max(e.z, GROUND_Z + 0.06);
        freeRunway(c, e);
        s.phase = 'sortie';
      }
      return true;
    }
    case 'return': {
      // a fresh strike order for an armed jet on its way home
      if (s.ammo > 0 && e.order.type !== 'idle' && hasMission(w, e, s)) {
        s.phase = 'sortie';
        return true;
      }
      // the final approach fix astern of the angled deck, sailing with the ship
      const [tdx, tdy] = deckToWorld(c, DECK.tdX, DECK.tdY);
      const ax = Math.cos(axis);
      const ay = Math.sin(axis);
      const fx = tdx - ax * DECK_FINAL;
      const fy = tdy - ay * DECK_FINAL;
      const along = (e.x - fx) * ax + (e.y - fy) * ay; // > 0: past the fix, towards the deck
      const lat = -(e.x - fx) * ay + (e.y - fy) * ax;
      const near = Math.hypot(e.x - fx, e.y - fy) < 9;
      let gx: number;
      let gy: number;
      if (along < -0.6 && Math.abs(lat) < 1 + -along * 0.9) {
        gx = fx + ax * 1.2;
        gy = fy + ay * 1.2;
      } else {
        // join astern: a point behind the fix, off to the side it is on
        const side = lat >= 0 ? 1 : -1;
        gx = clamp(fx - ax * 3.6 - ay * side * 2.8, 1, w.map.w - 1);
        gy = clamp(fy - ay * 3.6 + ax * side * 2.8, 1, w.map.h - 1);
      }
      fly(w, e, d, s, gx, gy, near ? APPROACH_V + shipV : vCruise, near ? GLIDE_ALT : cruise);
      if (along > -0.8 && along < 1.2 && Math.abs(lat) < 1 && Math.abs(angleDiff(e.facing, axis)) < 0.8 && e.z < GLIDE_ALT + 0.6 && takeRunway(c, e)) {
        const [lx, ly] = worldToDeck(c, e.x, e.y);
        s.lx = lx;
        s.ly = ly;
        s.lf = angleDiff(c.facing, e.facing);
        s.v = Math.max(TOUCH_V, s.v - shipV); // closing speed on the deck
        s.phase = 'final';
      }
      return true;
    }
    case 'final': {
      // flown in the ship's frame: down the angled deck's centreline onto the touchdown point, which keeps pace
      const ax = Math.cos(DECK.angle);
      const ay = Math.sin(DECK.angle);
      let lx = s.lx ?? 0;
      let ly = s.ly ?? 0;
      const dTd = (DECK.tdX - lx) * ax + (DECK.tdY - ly) * ay;
      const lat = -(lx - DECK.tdX) * ay + (ly - DECK.tdY) * ax;
      let lf = turnToward(s.lf ?? DECK.angle, DECK.angle - clamp(lat * 0.5, -0.4, 0.4), d.turnRate);
      if (dTd < 2) lf = turnToward(lf, DECK.angle, 0.08);
      s.lf = lf;
      s.v += clamp(TOUCH_V - s.v, -0.005, 0.002);
      lx += Math.cos(lf) * s.v;
      ly += Math.sin(lf) * s.v;
      // (onto the centreline)
      const k = dTd < 2.5 ? 0.2 : 0.07;
      lx += ay * lat * k;
      ly -= ax * lat * k;
      s.lx = lx;
      s.ly = ly;
      const zt = dTd > 0.7 ? GLIDE_ALT * clamp((dTd - 0.7) / (DECK_FINAL - 0.7), 0, 1) + 0.07 : 0.1 * Math.max(0, dTd / 0.7);
      e.z += clamp(zt - e.z, -0.06, 0.03);
      deckPose(e, c, s);
      e.moving = true;
      if (dTd <= 0 || (e.z <= 0.02 && dTd < 0.7)) {
        e.z = 0;
        s.lf = DECK.angle;
        s.phase = 'rollout';
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'touchdown', x: e.x, y: e.y });
      } else if (Math.abs(lat) > 1.3 || dTd < -1) {
        // wave-off: go round again
        freeRunway(c, e);
        s.v += shipV;
        s.phase = 'return';
      }
      return true;
    }
    case 'rollout': {
      // caught by the wire: pulled up within the landing area
      e.z = 0;
      s.v = Math.max(0, s.v - ARREST_DEC);
      s.lf = DECK.angle;
      const lx = (s.lx ?? 0) + Math.cos(DECK.angle) * s.v;
      const ly = (s.ly ?? 0) + Math.sin(DECK.angle) * s.v;
      s.lx = lx;
      s.ly = ly;
      deckPose(e, c, s);
      e.moving = s.v > 0.002;
      const run = (lx - DECK.tdX) * Math.cos(DECK.angle) + (ly - DECK.tdY) * Math.sin(DECK.angle);
      if (s.v <= 1e-4 || run >= DECK.stopLen) {
        s.v = 0;
        freeRunway(c, e);
        deckTaxiHome(s);
      }
      return true;
    }
    case 'taxiIn': {
      if (deckTaxi(e, c, s)) {
        s.phase = 'parked';
        if (s.ammo <= 0) s.rearm = REARM_TICKS;
      }
      return true;
    }
  }
  return false;
}

/** One tick of a combat jet (World.updateUnit hands fixed-wing combat jets here). */
export function updateSortie(w: World, e: Entity, d: UnitDef) {
  if (!e.sortie) {
    // spawned outside production (scripts, tests): find it a pad, or send it round in circles
    const s = newSortie(e, d);
    e.sortie = s;
    const b = findBase(w, e);
    if (b && e.z < GROUND_Z) parkJet(w, e, b);
    else if (b) {
      s.base = b.id;
      s.pad = freePad(w, b);
    } else {
      if (e.z < GROUND_Z) e.z = e.pz = d.cruiseAlt ?? 2.6;
      goHomeless(w, e, s, e.x, e.y);
    }
  }
  const s = e.sortie!;
  // jets ignore waypoint queues, patrols and escort duty: one strike at a time
  if (e.queue.length) e.queue.length = 0;
  e.patrol = null;
  e.guardId = -1;

  let base: Entity | undefined;
  if (s.base >= 0) {
    base = w.get(s.base);
    if (!isBase(base, e.owner)) {
      // airbase destroyed, sold or captured
      if (GROUND_PHASES.has(s.phase) || (s.phase === 'takeoff' && e.z < 0.05)) {
        crash(w, e);
        return;
      }
      const old = base ?? { x: e.x, y: e.y };
      freeRunway(base, e);
      base = undefined;
      const nb = findBase(w, e);
      if (nb) {
        s.base = nb.id;
        s.pad = freePad(w, nb);
        if (s.phase !== 'sortie') s.phase = 'return';
        s.fuel = FUEL_TICKS;
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'divert', x: e.x, y: e.y });
        base = nb;
      } else goHomeless(w, e, s, old.x, old.y);
    }
  }
  if (!base) {
    // homeless: circle with no time limit until an airbase is built or frees up (the owner's call: no fuel-out crash)
    if ((w.tick + e.id) % 20 === 0) {
      const nb = findBase(w, e);
      if (nb) {
        s.base = nb.id;
        s.pad = freePad(w, nb);
        s.fuel = FUEL_TICKS;
        if (s.phase === 'orbit') s.phase = 'return';
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'divert', x: e.x, y: e.y });
        base = nb;
      }
    }
  }
  // a carrier's deck (and its approach) runs in the ship's frame
  if (base && base.kind === 'unit' && deckSortie(w, e, d, s, base)) return;
  const g = base && base.kind === 'building' ? baseGeo(w, base) : null;
  const cruise = d.cruiseAlt ?? 2.6;
  const vCruise = d.speed / TPS;
  const vRef = Math.min(vCruise, REF_V);
  const dirA = g ? (g.dir > 0 ? 0 : Math.PI) : 0;

  switch (s.phase) {
    case 'parked': {
      if (!g) break;
      e.z = 0;
      s.v = 0;
      e.moving = false;
      const px = g.pads[s.pad];
      e.x += (px - e.x) * 0.2;
      e.y += (g.padY - e.y) * 0.2;
      // a tug turns it round on the stand, nose out
      e.facing = turnToward(e.facing, PARK_FACING, 0.05);
      e.turret = e.facing;
      if (s.rearm > 0 && --s.rearm === 0) s.ammo = 1;
      if (s.rearm <= 0 && s.ammo <= 0) s.ammo = 1;
      // the ground crew patches up battle damage while it rearms (free)
      if (e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * REPAIR_RATE) / TPS);
      // off again once armed and fully repaired; a fresh order from its owner launches it as soon as it is armed
      if (s.rearm <= 0 && hasMission(w, e, s) && (e.hp >= e.maxHp || !autoStrike(e))) {
        setPath(s, [px, g.taxiY, g.startX, g.taxiY]);
        s.phase = 'taxiOut';
      }
      break;
    }
    case 'taxiOut': {
      if (!g) break;
      if (!hasMission(w, e, s)) {
        taxiHome(s, g, e.x);
        break;
      }
      if (taxi(w, e, s)) s.phase = 'hold';
      break;
    }
    case 'hold': {
      // short of the runway, waiting for it to be free
      if (!g || !base) break;
      e.z = 0;
      s.v = 0;
      e.moving = false;
      e.facing = turnToward(e.facing, Math.PI / 2, TAXI_TURN);
      if (!hasMission(w, e, s)) {
        taxiHome(s, g, e.x);
        break;
      }
      if (takeRunway(base, e)) {
        setPath(s, [g.startX, g.rwyY]);
        s.phase = 'lineup';
      }
      break;
    }
    case 'lineup': {
      if (!g || !base) break;
      if (!hasMission(w, e, s)) {
        freeRunway(base, e);
        setPath(s, [g.startX, g.taxiY, g.pads[s.pad], g.taxiY, g.pads[s.pad], g.padY]);
        s.phase = 'taxiIn';
        break;
      }
      if (!taxi(w, e, s)) break;
      e.facing = turnToward(e.facing, dirA, TAXI_TURN);
      e.turret = e.facing;
      if (Math.abs(angleDiff(e.facing, dirA)) < 1e-3) {
        s.phase = 'takeoff';
        s.v = 0;
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'takeoff', x: e.x, y: e.y });
      }
      break;
    }
    case 'takeoff': {
      s.v = Math.min(vCruise, s.v + TO_ACC);
      if (e.z < 0.6) e.facing = dirA;
      e.x += Math.cos(e.facing) * s.v;
      e.y += Math.sin(e.facing) * s.v;
      if (g && e.z < 0.05) e.y += (g.rwyY - e.y) * 0.3;
      if (s.v >= vRef * ROTATE_K) e.z = Math.min(cruise, e.z + CLIMB * clamp((s.v - vRef * ROTATE_K) / (vRef * 0.12), 0.25, 1));
      e.moving = true;
      e.turret = e.facing;
      // stream take-off: the next jet may line up once this one is well down the runway
      if (g && (e.x - g.startX) * g.dir > 2.6) freeRunway(base, e);
      if (e.z > GROUND_Z + 0.05) {
        freeRunway(base, e);
        s.phase = 'sortie';
      }
      break;
    }
    case 'sortie': {
      const o = e.order;
      // climb out straight before turning
      const turnMul = e.z < 0.9 ? 0.35 : 1;
      if (s.ammo <= 0 && o.type !== 'move') {
        s.phase = base ? 'return' : 'orbit';
        break;
      }
      if (o.type === 'attack') {
        const t = strikeTarget(w, e, s);
        if (!t) {
          s.phase = base ? 'return' : 'orbit';
          break;
        }
        e.targetId = t.id;
        const dx = t.x - e.x;
        const dy = t.y - e.y;
        const dc = Math.hypot(dx, dy);
        const offBefore = Math.abs(angleDiff(e.facing, Math.atan2(dy, dx)));
        const turnR = vCruise / d.turnRate;
        // Break turning-circle orbit trap: if too close and off-axis to roll out onto the target,
        // extend straight (or toward map center near a border) until far enough for a clean attack run.
        const canLineUp =
          dc > 1.6 &&
          (offBefore < 0.35 ||
            (offBefore <= Math.PI * 0.5
              ? dc * dc - 2 * dc * turnR * Math.sin(offBefore) >= 1.5 * 1.5
              : dc >= turnR * 2.2 + 1.2));
        let gx = t.x;
        let gy = t.y;
        let steer = canLineUp;
        if (!steer) {
          const nx = e.x + Math.cos(e.facing) * 3;
          const ny = e.y + Math.sin(e.facing) * 3;
          if (nx < 2.5 || ny < 2.5 || nx > w.map.w - 2.5 || ny > w.map.h - 2.5) {
            gx = w.map.w * 0.5;
            gy = w.map.h * 0.5;
            steer = true;
          }
        }
        fly(w, e, d, s, gx, gy, vCruise, cruise, turnMul, steer);
        const off = Math.abs(angleDiff(e.facing, Math.atan2(dy, dx)));
        if (dc <= RELEASE_DIST && dc >= 0.8 && off < 0.35 && e.z > 0.7 && e.jammedUntil <= w.tick) release(w, e, d, s, t);
        break;
      }
      if (o.type === 'attackMove' || o.type === 'move') {
        const dx = o.x - e.x;
        const dy = o.y - e.y;
        const dc = Math.hypot(dx, dy);
        if (s.ammo > 0 && dc < 5.0) {
          const t = targetNear(w, e, o.x, o.y, 4.5);
          if (t) {
            e.order = { type: 'attack', target: t.id, forced: true };
            s.tx = t.x;
            s.ty = t.y;
            break;
          }
        }
        const offBefore = Math.abs(angleDiff(e.facing, Math.atan2(dy, dx)));
        const turnR = vCruise / d.turnRate;
        const canLineUp = dc > 1.2 && (offBefore < 0.4 || dc >= turnR * 2.1);
        fly(w, e, d, s, o.x, o.y, vCruise, cruise, turnMul, canLineUp);
        if (dc < 1.8) {
          e.order = { type: 'idle' };
          s.phase = base ? 'return' : 'orbit';
        }
        break;
      }
      s.phase = base ? 'return' : 'orbit';
      break;
    }
    case 'return': {
      if (!g || !base) {
        s.phase = 'orbit';
        break;
      }
      // a fresh strike order for an armed jet on its way home
      if (s.ammo > 0 && e.order.type !== 'idle' && hasMission(w, e, s)) {
        s.phase = 'sortie';
        break;
      }
      const along = (e.x - g.fx) * g.dir; // > 0: past the fix, towards (or beyond) the runway
      const lat = e.y - g.rwyY;
      const distF = Math.hypot(e.x - g.fx, lat);
      const near = distF < 9;
      let gx: number;
      let gy: number;
      if (along < -0.6 && Math.abs(lat) < 1 + -along * 0.9) {
        // on the approach cone: head for the fix along the extended centreline
        gx = g.fx + g.dir * 1.2;
        gy = g.rwyY;
      } else {
        // join downwind: a point behind the fix, off to the side we are on
        const side = lat >= 0 ? 1 : -1;
        gx = clamp(g.fx - g.dir * 3.6, 1, w.map.w - 1);
        gy = clamp(g.rwyY + side * 2.8, 1, w.map.h - 1);
      }
      fly(w, e, d, s, gx, gy, near ? APPROACH_V : vCruise, near ? GLIDE_ALT : cruise);
      if (along > -0.8 && along < 1.2 && Math.abs(lat) < 1 && Math.abs(angleDiff(e.facing, dirA)) < 0.8 && e.z < GLIDE_ALT + 0.6 && takeRunway(base, e)) s.phase = 'final';
      break;
    }
    case 'final': {
      if (!g || !base) {
        s.phase = 'orbit';
        break;
      }
      const dTd = (g.tdX - e.x) * g.dir;
      const len = Math.max(1.5, Math.abs(g.tdX - g.fx));
      e.facing = turnToward(e.facing, Math.atan2(g.rwyY - e.y, g.dir * 1.5), d.turnRate);
      if (dTd < 2) e.facing = turnToward(e.facing, dirA, 0.08);
      e.y += (g.rwyY - e.y) * (dTd < 2.5 ? 0.2 : 0.07);
      s.v += clamp(TOUCH_V - s.v, -0.005, 0.002);
      e.x += Math.cos(e.facing) * s.v;
      e.y += Math.sin(e.facing) * s.v;
      // glide slope, then the flare over the threshold
      const zt = dTd > 0.7 ? GLIDE_ALT * clamp((dTd - 0.7) / (len - 0.7), 0, 1) + 0.07 : 0.1 * Math.max(0, dTd / 0.7);
      e.z += clamp(zt - e.z, -0.06, 0.03);
      e.turret = e.facing;
      e.moving = true;
      if (dTd <= 0 || (e.z <= 0.02 && dTd < 0.7)) {
        e.z = 0;
        e.y = g.rwyY;
        e.facing = dirA;
        s.phase = 'rollout';
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'touchdown', x: e.x, y: e.y });
      } else if (Math.abs(e.y - g.rwyY) > 1.3 || dTd < -1) {
        // go around
        freeRunway(base, e);
        s.phase = 'return';
      }
      break;
    }
    case 'rollout': {
      if (!g || !base) break;
      e.z = 0;
      s.v = Math.max(TAXI_V, s.v - ROLL_DEC);
      e.facing = dirA;
      e.x += Math.cos(e.facing) * s.v;
      e.y += (g.rwyY - e.y) * 0.3;
      e.moving = true;
      const left = (g.endX - e.x) * g.dir;
      if (s.v <= TAXI_V + 1e-9 || left < 0.8) {
        freeRunway(base, e);
        taxiHome(s, g, e.x + g.dir * 0.5);
      }
      break;
    }
    case 'taxiIn': {
      if (!g) break;
      if (taxi(w, e, s)) {
        s.phase = 'parked';
        if (s.ammo <= 0) s.rearm = REARM_TICKS;
      }
      break;
    }
    case 'orbit': {
      if (s.ammo > 0 && e.order.type !== 'idle' && hasMission(w, e, s)) {
        s.phase = 'sortie';
        break;
      }
      if (base) {
        s.phase = 'return';
        break;
      }
      const a = Math.atan2(e.y - s.oy, e.x - s.ox) + 0.6;
      fly(w, e, d, s, s.ox + Math.cos(a) * 3, s.oy + Math.sin(a) * 3, vCruise * 0.8, cruise);
      break;
    }
  }
}
