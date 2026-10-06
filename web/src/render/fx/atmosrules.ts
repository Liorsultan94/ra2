/*
 * Pure rules of the atmosphere extras (render only, never the sim; no three.js here so the
 * tests can import them cheaply):
 *  - the dawn valley mist over the live clock and its strength per climate (atmos.ts, groundfog.ts);
 *  - when and how many dust devils cross the desert (fx/nature.ts);
 *  - how much the village chimneys smoke over the day (fx/chimneys.ts);
 *  - steam rising off wet ground when the sun comes back after rain (fx/nature.ts);
 *  - which quality tier draws the god rays and how (fx/godrays.ts, cloudshadow.ts).
 */

export type Tier = 'low' | 'medium' | 'high';
export type Climate = 'temperate' | 'desert' | 'winter' | 'urban';

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Clock hour 0..24 of any hour value (NaN -> noon). */
function hour24(hours: number): number {
  if (!Number.isFinite(hours)) return 12;
  return ((hours % 24) + 24) % 24;
}

// ------------------------------------------------------------ dawn mist

/** Dawn mist: rises 04:45 .. 05:45, full until ~06:45, burns off gradually as the sun climbs, gone by 08:30. */
export const MIST_RISE: readonly [number, number] = [4.75, 5.75];
export const MIST_BURN: readonly [number, number] = [6.6, 8.5];

/**
 * Valley mist strength 0..1 at a clock hour: a faint layer in the small hours (from ~22:30), the
 * thick dawn banks from about 05:00, burning off over the morning (thin by 08:00, gone at 08:30).
 */
export function dawnMistAt(hours: number): number {
  const x = hour24(hours);
  // the small hours: a faint layer gathering after midnight (22:30 .. 04:00), merging into the dawn banks
  const night = x >= 12 ? 0.22 * sstep(22.5, 26, x) : 0.22 * sstep(-1.5, 2, x) * (1 - sstep(5.75, 6.6, x));
  return Math.min(1, night + dawnBanksAt(x));
}

/** The dawn part alone 0..1 (05:00 .. 08:30): the extra valley / riverbed banks of the ground fog cards. */
export function dawnBanksAt(hours: number): number {
  const x = hour24(hours);
  return x >= 12 ? 0 : sstep(MIST_RISE[0], MIST_RISE[1], x) * (1 - sstep(MIST_BURN[0], MIST_BURN[1], x));
}

/** How strongly the low sun gilds the mist banks 0..1 (sunrise .. mid-morning). */
export function dawnGlowAt(hours: number): number {
  const x = hour24(hours);
  return sstep(5.4, 6.1, x) * (1 - sstep(7.4, 8.6, x));
}

/** Valley mist per climate: full in the cold / temperate valleys, lighter in the city, a trace in the desert. */
export function mistClimateK(biome: string): number {
  return biome === 'winter' ? 1 : biome === 'desert' ? 0.22 : biome === 'urban' ? 0.75 : 1;
}

// ------------------------------------------------------------ dust devils

export interface DevilWeather {
  biome: string;
  /** Daylight 0..1 (atmos.daylight). */
  day: number;
  /** Anything falling 0..1 and the ground wetness 0..1. */
  precip: number;
  wet: number;
  /** ?devil=1 debug. */
  forced?: boolean;
}

/** At most this many dust devils in the view per tier (low: none: no particles at all). */
export const DEVIL_CAP: Record<Tier, number> = { low: 0, medium: 1, high: 2 };
/** Lifetime of one whirl (seconds): [min, random extra] = 10 .. 25 s. */
export const DEVIL_LIFE: readonly [number, number] = [10, 15];

/** How many dust devils may wander the view now: desert, by day, dry and calm skies only (0 = none). */
export function devilCap(w: DevilWeather, tier: Tier): number {
  const cap = DEVIL_CAP[tier];
  if (w.forced) return Math.max(1, cap);
  if (w.biome !== 'desert') return 0;
  if (!(w.day > 0.55) || w.precip >= 0.05 || w.wet >= 0.25) return 0;
  return cap;
}

/** May another whirl start (count = live whirls, timer = seconds until the next one may start)? */
export function devilMaySpawn(w: DevilWeather, tier: Tier, count: number, timer: number): boolean {
  return timer <= 0 && count < devilCap(w, tier);
}

/** Lifetime of a new whirl from a 0..1 random number. */
export function devilLife(r: number): number {
  return DEVIL_LIFE[0] + Math.max(0, Math.min(1, r)) * DEVIL_LIFE[1];
}

// ------------------------------------------------------------ chimney smoke

/**
 * How much the village chimneys smoke 0..1 at a clock hour: a few stoves all day, most of them
 * at breakfast (06:00 .. 09:30) and in the evening (17:00 .. 22:30), a little through the night;
 * more in the cold (winter maps, snow lying), none in the desert (no chimneys there).
 */
export function chimneyAmount(hours: number, biome: string, snow = 0): number {
  if (biome === 'desert') return 0;
  const x = hour24(hours);
  const morning = sstep(5.2, 6.4, x) * (1 - sstep(8.6, 10, x));
  const evening = sstep(16.5, 18, x) * (1 - sstep(22, 23.5, x));
  const night = x < 6 ? 0.35 : x > 22 ? 0.35 : 0;
  let a = 0.22 + 0.7 * morning + 0.6 * evening + night * (1 - morning) * (1 - evening);
  const cold = biome === 'winter' ? 1 : Math.max(0, Math.min(1, snow));
  a *= 1 + 0.6 * cold;
  return Math.min(1, a);
}

/**
 * Chimney smoke shading against the ground under it: `alpha` scales the puff opacity, `tint`
 * multiplies its (scene-lit) grey. The smoke's lit grey is about as bright as sunlit snow, so on a
 * snow map a plain grey plume vanishes (it only shows over dark grass); over snow the plume turns a
 * darker blue-grey and denser so it reads by day and by night. snow = snow lying 0..1.
 */
export function smokeShade(snow: number): { alpha: number; tint: [number, number, number] } {
  const s = Math.max(0, Math.min(1, Number.isFinite(snow) ? snow : 0));
  return { alpha: 0.5 + 0.4 * s, tint: [1 - 0.66 * s, 1 - 0.64 * s, 1 - 0.58 * s] };
}

/** Puffs per chimney and the most chimneys smoking at once (the nearest to the view) per tier. */
export const CHIMNEY_TIER: Record<Tier, { puffs: number; max: number }> = { low: { puffs: 0, max: 0 }, medium: { puffs: 7, max: 18 }, high: { puffs: 10, max: 40 } };

// ------------------------------------------------------------ after rain

/**
 * Steam off the wet ground 0..1: the ground must still be wet, nothing falling, and the sun out
 * (daylight, the sky clearing). `sun` = daylight 0..1, `cover` = cloud cover 0..1.
 */
export function steamAmount(wet: number, precip: number, sun: number, cover: number): number {
  if (!(wet > 0.06) || precip > 0.08) return 0;
  return sstep(0.06, 0.4, wet) * sstep(0.5, 0.85, sun) * (1 - sstep(0.45, 0.85, cover)) * (1 - sstep(0.02, 0.08, precip));
}

// ------------------------------------------------------------ god rays

export interface GodRayTier {
  /** Draw the shafts at all. */
  on: boolean;
  /** Also march the smoke (an extra draw of the smoke particles into a density buffer). */
  smoke: boolean;
  /** Buffer resolution divisor (4 = quarter, 8 = eighth). */
  div: number;
  /** Samples along the view ray through the cloud-shadow slab. */
  steps: number;
  /** Strength of the cloud shafts (1 = full). */
  strength: number;
}

/**
 * God rays per quality tier: high marches the smoke and the cloud gaps at quarter resolution;
 * medium (phones) only the cloud gaps (analytic, from the cloud-shadow field) at an eighth of
 * the resolution with fewer samples, and only while the shafts are on; low has none.
 */
export function godRayTier(q: Tier): GodRayTier {
  if (q === 'high') return { on: true, smoke: true, div: 4, steps: 10, strength: 1 };
  if (q === 'medium') return { on: true, smoke: false, div: 8, steps: 8, strength: 1 };
  return { on: false, smoke: false, div: 8, steps: 0, strength: 0 };
}

/** Moist air after rain scatters more: the shafts strengthen while the ground is wet and the rain has stopped. */
export function postRainShaftBoost(wet: number, precip: number): number {
  return 1 + 0.5 * sstep(0.08, 0.45, wet) * (1 - sstep(0.03, 0.12, precip));
}
