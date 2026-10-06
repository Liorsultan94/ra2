import { TPS } from './types';

/*
 * The battle's day clock, sim side (deterministic: derived from the tick and the match's start hour only).
 *
 * The live day runs 1 real minute = 1 game hour at 1x game speed (a full day is 24 real minutes); it follows
 * the game speed and pause because it is driven by the sim tick. The renderer's sky (render/atmos.ts) reads the
 * same clock, so the night the player sees is the night the sim plays.
 *
 * Night combat (world.ts updateVisibility):
 *  - nightLevel: 0 by day .. 1 by night, a smooth ramp over the dusk hour (centred on 19:45, when the moon rises
 *    and the HUD clock turns to the moon: atmos.ts MOON_RISE) and the dawn hour (centred on 05:15, when the moon
 *    sets and the sun takes the sky over again: atmos.ts MOON_SET);
 *  - ordinary units see 1 - 0.5 * nightLevel of their daytime sight (half by night); night-vision equipment
 *    (UnitDef.nvg) keeps its full sight;
 *  - past the middle of the ramp (nightLevel > 0.5) the night fog rule applies (types.ts FogMode 'modern').
 */

/** One game hour of the live day in sim ticks. */
export const GAME_HOUR_TICKS = TPS * 60;
/** One full day of the cycle. */
export const CYCLE_TICKS = GAME_HOUR_TICKS * 24;
/** The live day starts just before sunrise (?clock=HH:MM overrides it for debugging / screenshots). */
export const START_HOUR = 5.5;

/** Night falls (the middle of the dusk ramp): moon rise, 19:45. */
export const NIGHT_FROM = 19.75;
/** Night ends (the middle of the dawn ramp): moon set, 05:15. */
export const NIGHT_TO = 5.25;
/** Each ramp lasts one game hour, centred on its switch-over hour. */
export const NIGHT_RAMP = 1;
/** Sight of ordinary units at full night, as a fraction of their daytime sight. */
export const NIGHT_SIGHT = 0.5;

/** The match's clock: the hour it starts at, and whether it runs (the live day) or stays put (a fixed sky). */
export interface SimClock {
  start: number;
  live: boolean;
}

/** Without a clock (tests, the demo battle): a fixed afternoon. */
export const DAY_CLOCK: SimClock = { start: 15, live: false };

/** Hours since midnight of day 1 at a sim tick (the live day starts at `start`). */
export function clockHours(tick: number, start = START_HOUR): number {
  return start + tick / GAME_HOUR_TICKS;
}

/** Clock hour (any number of hours; may pass 24) of a match clock at a tick. */
export function simHours(tick: number, c: SimClock): number {
  return c.live ? clockHours(tick, c.start) : c.start;
}

function sstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0 = day .. 1 = night at a clock hour (wraps every 24 hours). */
export function nightLevel(hours: number): number {
  if (!Number.isFinite(hours)) return 0;
  const x = ((hours % 24) + 24) % 24;
  const h = NIGHT_RAMP / 2;
  // dusk ramp up around NIGHT_FROM, dawn ramp down around NIGHT_TO (the night spans midnight)
  const dusk = sstep(NIGHT_FROM - h, NIGHT_FROM + h, x);
  const dawn = 1 - sstep(NIGHT_TO - h, NIGHT_TO + h, x);
  return x >= 12 ? dusk : dawn;
}

/** Sight multiplier of ordinary units (no night vision) at a night level. */
export function nightSight(level: number): number {
  return 1 - (1 - NIGHT_SIGHT) * Math.max(0, Math.min(1, level));
}

/** Does the night fog rule apply at this night level? */
export function isNight(level: number): boolean {
  return level > 0.5;
}
