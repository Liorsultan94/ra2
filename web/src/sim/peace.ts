// Early-game grace period ("peace time"): for the first minutes of a skirmish
// the computer player builds, expands, scouts and defends itself, but sends no
// attack waves, raids, air strikes, missile salvos, paratroopers or superweapon
// strikes at the player. Measured in simulation ticks (deterministic: no wall
// clock), so it runs faster or slower with the game speed like everything else.

import type { Difficulty } from './ai';
import { TPS } from './types';

/** Skirmish option: 'auto' = by difficulty, 'off', or a fixed number of minutes. */
export type PeaceOption = 'auto' | 'off' | '3' | '6' | '10' | '15';

export const PEACE_OPTIONS: PeaceOption[] = ['auto', 'off', '3', '6', '10', '15'];

/** Default grace by difficulty, in minutes of game time. */
export const PEACE_DEFAULT_MIN: Record<Difficulty, number> = { easy: 10, normal: 6, hard: 3 };

export function isPeaceOption(v: unknown): v is PeaceOption {
  return typeof v === 'string' && (PEACE_OPTIONS as string[]).includes(v);
}

/** Grace length in ticks for a difficulty and the skirmish option (0 = no grace). */
export function peaceTicks(difficulty: Difficulty, option: PeaceOption | undefined = 'auto'): number {
  if (option === 'off') return 0;
  const min = option === 'auto' || !isPeaceOption(option) ? PEACE_DEFAULT_MIN[difficulty] : Number(option);
  return Math.round(min * 60 * TPS);
}

/** Whole seconds of grace left at `tick` (0 once it is over). */
export function peaceSecondsLeft(tick: number, until: number): number {
  return until > tick ? Math.ceil((until - tick) / TPS) : 0;
}

/** "5:12" */
export function formatPeace(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * After the grace the AI ramps up instead of releasing the army it massed in one go: each wave
 * is capped at the current wave size (starting at the normal first-wave size, then growing) and
 * waves leave at least this many ticks apart.
 */
export const RAMP_GAP: Record<Difficulty, number> = { easy: TPS * 120, normal: TPS * 90, hard: TPS * 60 };

/** The AI may still fight anything this close to home (tiles) or to one of its structures during the grace. */
export const PEACE_HOME_R = 30;
export const PEACE_BUILDING_R = 12;
