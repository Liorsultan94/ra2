import { DEFS, WEAPONS, buildingDef, unitDef } from './defs';
import { jetGrounded } from './airbase';
import { TPS, type Entity, type Flare, type UnitDef } from './types';
import type { World } from './world';

/*
 * Night combat (the same rules for every player, the AI included).
 *
 * The day clock is sim side (clock.ts): World.nightLevel goes 0 (day) .. 1 (night) over the dusk and dawn
 * hours and World.night (the night fog rule, types.ts FogMode 'modern') is on past the middle of the ramp.
 *
 *  - Sight: ordinary units and structures see half as far by night (World.sightOf); night vision / thermal
 *    equipment (UnitDef.nvg: snipers, main battle tanks, attack helicopters, drones / UAVs, airborne fighter
 *    jets) keeps its full sight.
 *  - Night fog: enemy units outside current sight are hidden, even on explored ground; discovered structures
 *    stay shown (last known) and explored terrain stays explored.
 *  - Muzzle flash: anything that fires by night is revealed to every enemy for FLASH_TICKS after its last
 *    shot (World.sees), base defences and garrisoned buildings included. Units on "No fire" (holdFire) don't
 *    fire, so they stay hidden: the ambush play.
 *  - Illumination rounds: artillery and mortars (UnitDef.illum) fire a parachute flare over a spot within
 *    their normal range (ILLUM_COOLDOWN between rounds). It burns FLARE_TICKS after the shell's flight and
 *    reveals FLARE_RADIUS around it to the firing player, as by day.
 *  - Base floodlights: by night every built structure of a player shines floodlights over FLOOD_RADIUS
 *    around it, revealing that ring to its owner; low power puts them out.
 * All of it is folded into the per-player visible grid at the fog cadence (World.updateVisibility), so the
 * targeting, the AI and the renderer read one truth.
 */

/** A shot gives its shooter away by night for this long (5 s). */
export const FLASH_TICKS = 5 * TPS;
/** Between two illumination rounds of one gun (45 s). */
export const ILLUM_COOLDOWN = 45 * TPS;
/** A flare burns this long under its parachute (30 s). */
export const FLARE_TICKS = 30 * TPS;
/** A burning flare lights and reveals this radius (tiles). */
export const FLARE_RADIUS = 7;
/** Base floodlights light and reveal this radius around the structure's centre (tiles). */
export const FLOOD_RADIUS = 6;

/** Does it see its full sight by night (night vision; fighter jets only while airborne)? */
export function hasNightVision(e: Entity): boolean {
  if (e.kind !== 'unit') return false;
  const d = unitDef(e.def);
  if (!d.nvg) return false;
  return !d.fixedWing || !jetGrounded(e);
}

/** Is this entity given away by its muzzle flash right now (night only)? */
export function flashLit(w: World, e: Entity): boolean {
  return w.night && w.tick - e.flashAt < FLASH_TICKS;
}

/** A shot was fired by e (from inside a container: the container shows the flash too). */
export function muzzleFlash(w: World, e: Entity) {
  e.flashAt = w.tick;
  if (e.inside >= 0) {
    const c = w.get(e.inside);
    if (c) c.flashAt = w.tick;
  }
}

/** Is this one of a player's own structures that shines floodlights now (night, built, powered)? */
export function floodlit(w: World, b: Entity): boolean {
  if (!w.night || b.dead || b.kind !== 'building' || b.owner < 0 || b.buildAnim < 1) return false;
  const d = DEFS[b.def];
  if (d.faction === 'neutral') return false; // oil derricks, captured tech sites, garrisoned houses: not base structures
  return !w.isLowPower(w.players[b.owner]);
}

/** Centre of a structure's floodlight ring. */
export function floodCentre(b: Entity): [number, number] {
  const d = buildingDef(b.def);
  return [b.tx + d.w / 2, b.ty + d.h / 2];
}

/** Is the flare burning (lighting / revealing) at this tick? */
export function flareLit(f: Flare, tick: number): boolean {
  return tick >= f.at && tick < f.end;
}

/** Ticks the shell flies before the flare pops (longer for a farther spot). */
export function illumFlight(dist: number): number {
  return Math.round(TPS * (1.2 + Math.max(0, dist) * 0.12));
}

/** Is this unit's illumination round ready? */
export function illumReady(w: World, e: Entity): boolean {
  return !e.dead && e.kind === 'unit' && !!unitDef(e.def).illum && w.tick >= e.illumAt;
}

/** Seconds until the round is ready again (0 = ready). */
export function illumWait(w: World, e: Entity): number {
  return Math.max(0, (e.illumAt - w.tick) / TPS);
}

/** Map spot of an illumination order, clamped onto the map. */
export function illumSpot(w: World, x: number, y: number): [number, number] {
  return [Math.max(0.5, Math.min(w.map.w - 0.5, x)), Math.max(0.5, Math.min(w.map.h - 0.5, y))];
}

/** Command 'illum': the gun of a selection that takes the fire mission (ready, in range first, then the nearest). */
export function pickIllum(w: World, units: Entity[], x: number, y: number): Entity | null {
  const [tx, ty] = illumSpot(w, x, y);
  let best: Entity | null = null;
  let bd = Infinity;
  for (const e of units) {
    if (!illumReady(w, e)) continue;
    const d = unitDef(e.def);
    const dist = Math.hypot(tx - e.x, ty - e.y);
    const score = dist - (dist <= w.weaponRange(e, WEAPONS[d.weapon!]) ? 1000 : 0);
    if (score < bd || (score === bd && best && e.id < best.id)) {
      bd = score;
      best = e;
    }
  }
  return best;
}

/** Give a gun the illumination fire mission over (x, y). */
export function orderIllum(w: World, e: Entity, x: number, y: number) {
  const [tx, ty] = illumSpot(w, x, y);
  e.order = { type: 'illum', x: tx, y: ty };
  e.targetId = -1;
  e.path = null;
  e.queue.length = 0;
  e.patrol = null;
  e.guardId = -1;
}

function turnToward(a: number, b: number, rate: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= rate) return b;
  return a + Math.sign(d) * rate;
}

/** One tick of an 'illum' order: close in to range, lay the gun, fire the round. */
export function stepIllum(w: World, e: Entity, d: UnitDef) {
  const o = e.order;
  if (o.type !== 'illum') return;
  const done = () => {
    e.order = { type: 'idle' };
    e.path = null;
    e.moving = false;
    e.guardX = e.x;
    e.guardY = e.y;
  };
  if (!d.illum || !d.weapon || w.tick < e.illumAt) return done();
  const dist = Math.hypot(o.x - e.x, o.y - e.y);
  const range = w.weaponRange(e, WEAPONS[d.weapon]);
  if (dist > range) {
    if (!e.path || w.tick >= e.repathAt) {
      w.pathTo(e, o.x, o.y);
      e.repathAt = w.tick + 30;
    }
    // (arrived at the spot itself without getting in range: can't happen with a range > 0, but never stall)
    if (w.walk(e, d) && Math.hypot(o.x - e.x, o.y - e.y) > range) return done();
    return;
  }
  e.path = null;
  e.moving = false;
  const want = Math.atan2(o.y - e.y, o.x - e.x);
  let err: number;
  if (d.turret) {
    e.turret = turnToward(e.turret, want, 0.16);
    err = e.turret - want;
  } else {
    e.facing = turnToward(e.facing, want, d.category === 'infantry' ? 1 : d.turnRate);
    e.turret = e.facing;
    err = e.facing - want;
  }
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  if (Math.abs(err) > 0.15) return;
  fireIllum(w, e, o.x, o.y);
  done();
}

/** Fire an illumination round over (x, y) now. */
export function fireIllum(w: World, e: Entity, x: number, y: number): Flare {
  const dist = Math.hypot(x - e.x, y - e.y);
  const flight = illumFlight(dist);
  const f: Flare = { id: w.allocId(), owner: e.owner, from: e.id, x, y, fired: w.tick, at: w.tick + flight, end: w.tick + flight + FLARE_TICKS };
  w.flares.push(f);
  e.illumAt = w.tick + ILLUM_COOLDOWN;
  e.firedAt = w.tick;
  muzzleFlash(w, e);
  w.events.push({ t: 'illum', id: e.id, owner: e.owner, x: e.x, y: e.y, tx: x, ty: y, flare: f.id });
  return f;
}

/** Burnt-out flares go (and those of defeated players). */
export function updateFlares(w: World) {
  if (!w.flares.length) return;
  w.flares = w.flares.filter((f) => f.end > w.tick && !w.players[f.owner]?.defeated);
}
