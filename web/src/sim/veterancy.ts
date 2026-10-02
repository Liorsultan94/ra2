// RA2-style veterancy. Units earn experience by destroying enemies: each kill is worth the
// value (cost) of what was destroyed, so killing expensive targets ranks a unit up faster.
// Rookie -> Veteran after destroying about its own cost, Elite at three times its cost.
// All bonuses are plain multipliers on deterministic quantities (no randomness, no clocks).

import { DEFS } from './defs';
import type { Def } from './types';

export const ROOKIE = 0;
export const VETERAN = 1;
export const ELITE = 2;
export type Rank = 0 | 1 | 2;
export const RANK_NAMES = ['Rookie', 'Veteran', 'Elite'] as const;

/** Experience (in credits destroyed) needed per rank, as a multiple of the unit's own cost. */
export const VETERAN_RATIO = 1;
export const ELITE_RATIO = 3;
/** Floor for the unit cost used in thresholds, so very cheap units still need a real kill or two. */
export const MIN_RANK_COST = 150;

/** Damage dealt multiplier per rank. */
export const RANK_FIREPOWER = [1, 1.1, 1.25];
/** Damage taken multiplier per rank (armour). */
export const RANK_ARMOR = [1, 0.9, 0.8];
/** Weapon reload (ticks between bursts) multiplier per rank. */
export const RANK_ROF = [1, 0.9, 0.8];
/** Elite units slowly repair themselves: fraction of max hp per second. */
export const ELITE_HEAL = 0.01;

/** Can units of this def gain rank? Spawned munitions, pallets and support transports can't. */
export function canRank(d: Def): boolean {
  if (d.kind !== 'unit') return false;
  return !d.temp && !d.supply && !d.airlift && !d.harvester && !d.mcv && d.cost > 0;
}

/** Experience earned for destroying something of this def. Cost-less things are worth a bit by their toughness. */
export function xpValue(defId: string): number {
  const d = DEFS[defId];
  if (!d) return 0;
  if (d.cost > 0) return d.cost;
  if (d.kind === 'unit' && (d.temp || d.supply)) return Math.round(d.hp * 0.5); // drones, pallets
  return Math.round(d.hp * 0.4); // support transports, neutral structures
}

/** Experience needed to reach a rank for a unit of this def. */
export function rankThreshold(defId: string, rank: Rank): number {
  if (rank === ROOKIE) return 0;
  const base = Math.max(MIN_RANK_COST, DEFS[defId].cost);
  return base * (rank === ELITE ? ELITE_RATIO : VETERAN_RATIO);
}

export function rankFor(defId: string, xp: number): Rank {
  if (xp >= rankThreshold(defId, ELITE)) return ELITE;
  if (xp >= rankThreshold(defId, VETERAN)) return VETERAN;
  return ROOKIE;
}
