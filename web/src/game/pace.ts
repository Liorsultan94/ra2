// Game speed: how many fixed simulation ticks run per real second. The
// simulation itself never sees the speed (every tick is the same 1/20 s step),
// so a battle plays out identically, tick for tick, at any speed; only the real
// time between ticks changes. The live day clock and the early-game grace are
// tick-based, so they follow the speed too.

import { TICK_MS } from '../sim/types';

export type GameSpeed = 'slow' | 'normal' | 'fast';

export const GAME_SPEEDS: Record<GameSpeed, number> = { slow: 0.75, normal: 1, fast: 1.25 };

export function isGameSpeed(v: unknown): v is GameSpeed {
  return v === 'slow' || v === 'normal' || v === 'fast';
}

/** Tick-rate multiplier of a speed setting (unknown / unset = normal). */
export function speedFactor(s: GameSpeed | string | undefined): number {
  return isGameSpeed(s) ? GAME_SPEEDS[s] : 1;
}

/** Most ticks run in one frame; a longer stall drops the backlog instead of spiralling. */
export const MAX_STEPS = 6;

/** Fixed-step accumulator of the game loop. */
export class TickPacer {
  acc = 0;

  /** Add a frame of `dtSec` real seconds at `rate` (speed x slow-motion) and return how many ticks to run now. */
  advance(dtSec: number, rate: number): number {
    this.acc += dtSec * 1000 * rate;
    let n = 0;
    while (this.acc >= TICK_MS && n < MAX_STEPS) {
      this.acc -= TICK_MS;
      n++;
    }
    if (n >= MAX_STEPS) this.acc = 0;
    return n;
  }

  /** Interpolation between the last two ticks (0..1). */
  get alpha(): number {
    return Math.min(1, this.acc / TICK_MS);
  }

  reset() {
    this.acc = 0;
  }
}
