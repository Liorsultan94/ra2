// Stealth aircraft (the F-35A / F-35I): low observability and evasion against anti-air fire.
//
// Low observability is the aircraft counterpart of the cruise missiles' `lowObservable` (ballistics.ts
// detectionRange): while the jet is airborne, every enemy weapon that can hit aircraft (AA vehicles, SAM
// sites, base defences, interceptors, infantry rockets, helicopter missiles...) acquires and fires at it
// only within `lowObservable` x its normal weapon range.
//
// Evasion: each anti-air shot or missile aimed at it misses with chance `evasion`, decided by the seeded
// world RNG (never Math.random), so every lockstep client agrees. Guided missiles roll once at launch; a
// fooled missile chases the jet until it closes to DECOY_RANGE, then the jet's decoy flare leaves it and
// the missile turns onto the flare and bursts on it (stepDecoy / releaseDecoy, called from ballistics.ts).
// Gun, flak and beam shots that miss just miss (World.fire).
//
// Neither applies to a jet on its wheels at its airbase: that is a ground target (airbase.ts).

import { unitDef } from './defs';
import { TPS, type Entity, type Projectile, type WeaponDef } from './types';
import type { World } from './world';

/** A fooled missile turns onto the flare once it is this close to the jet (tiles, 3D). */
export const DECOY_RANGE = 4;
/** A missile that has not reached its flare after this long self-destructs. */
const DECOY_LIFE = TPS * 2;
// decoy flare flight: light and draggy, it arcs out behind the jet and sinks (matches render/fx/flyers.ts)
const FLARE_DRAG = 1.6; // 1/s
const FLARE_G = 2.2; // tiles/s^2
const DT = 1 / TPS;

/** Does this weapon engage aircraft at all? */
function antiAir(wpn: WeaponDef) {
  return wpn.air !== 'no';
}

/** Low-observable factor of a target against this weapon (1 = normal). */
export function lowObsFactor(w: World, wpn: WeaponDef, t: Entity): number {
  if (t.kind !== 'unit' || !antiAir(wpn)) return 1;
  const lo = unitDef(t.def).lowObservable;
  if (!lo || lo >= 1 || !w.isAir(t)) return 1;
  return lo;
}

/** Range at which shooter e acquires and fires at target t with weapon wpn (stealth aircraft: a fraction of it). */
export function rangeVs(w: World, e: Entity, wpn: WeaponDef, t: Entity): number {
  return w.weaponRange(e, wpn) * lowObsFactor(w, wpn, t);
}

/** Chance that one anti-air shot / missile from wpn at t misses (0 for everything but airborne evasive aircraft). */
export function evasionChance(w: World, wpn: WeaponDef, t: Entity): number {
  if (t.kind !== 'unit' || !antiAir(wpn)) return 0;
  const ev = unitDef(t.def).evasion;
  if (!ev || !w.isAir(t)) return 0;
  return ev;
}

/** Seeded evasion roll for one shot at t. Consumes the world RNG only when t can evade at all. */
export function evades(w: World, wpn: WeaponDef, t: Entity): boolean {
  const ev = evasionChance(w, wpn, t);
  return ev > 0 && w.rng.next() < ev;
}

/**
 * The jet pops its decoy flare: it leaves just behind the jet, kicked out to one side and slowed by the
 * airflow, and the missile turns onto it.
 */
export function releaseDecoy(w: World, p: Projectile, jet: Entity, jz: number) {
  const vx = (jet.x - jet.px) * TPS;
  const vy = (jet.y - jet.py) * TPS;
  const sp = Math.hypot(vx, vy);
  const fx = sp > 1e-6 ? vx / sp : Math.cos(jet.facing);
  const fy = sp > 1e-6 ? vy / sp : Math.sin(jet.facing);
  const side = p.id % 2 ? 1 : -1;
  p.decoy = 2;
  p.dcx = jet.x - fx * 0.25;
  p.dcy = jet.y - fy * 0.25;
  p.dcz = jz - 0.08;
  p.dcvx = vx * 0.45 - fy * side * 1.3;
  p.dcvy = vy * 0.45 + fx * side * 1.3;
  p.dcvz = 0.7;
  p.dcAt = p.age;
  p.targetId = -1;
  w.events.push({ t: 'decoy', id: jet.id, owner: jet.owner, proj: p.id, x: p.dcx, y: p.dcy, z: p.dcz, vx: p.dcvx, vy: p.dcvy, vz: p.dcvz });
}

/** One tick of the decoy flare's flight. Returns false when the missile should give up (flare spent / too long). */
export function stepDecoy(p: Projectile, ground: number): boolean {
  const k = Math.max(0, 1 - FLARE_DRAG * DT);
  p.dcvx *= k;
  p.dcvy *= k;
  p.dcvz = p.dcvz * k - FLARE_G * DT;
  p.dcx += p.dcvx * DT;
  p.dcy += p.dcvy * DT;
  p.dcz += p.dcvz * DT;
  if (p.dcz < ground + 0.05) return false;
  return p.age - p.dcAt < DECOY_LIFE;
}
