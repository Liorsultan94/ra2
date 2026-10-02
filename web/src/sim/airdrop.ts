// Airborne-drop support power ("reinforcements"): balance numbers and helpers
// shared by the simulation, the AI and the HUD. Deterministic - no wall clock.

import { TPS } from './types';
import type { World } from './world';

/** First drop is available this long after the airfield completes. */
export const AIRDROP_FIRST = TPS * 90;
/** Recharge between drops. */
export const AIRDROP_COOLDOWN = TPS * 170;
/** Stick composition, in exit order (faction prefix added); the AT gunner jumps in the middle. */
export const AIRDROP_STICK = ['rifle', 'rifle', 'at', 'rifle', 'rifle', 'rifle'];
/** Ticks between two jumpers leaving the ramp. */
export const AIRDROP_GAP = 3;
/** Canopy descent time for jumpers / the supply pallet. */
export const CHUTE_TICKS = 70;
export const CRATE_CHUTE_TICKS = 80;
/** Supply pallet: lifetime on the ground, heal radius and heal per second (fraction of max hp). */
export const CRATE_LIFE = TPS * 40;
export const CRATE_RADIUS = 3;
export const CRATE_HEAL = 0.04;

export interface AirdropStatus {
  unlocked: boolean; // owns a completed airfield
  ready: boolean;
  progress: number; // 0..1 recharge
  secondsLeft: number;
}

export function airdropStatus(w: World, player: number): AirdropStatus {
  const p = w.players[player];
  if (!p || p.airdropAt < 0) return { unlocked: false, ready: false, progress: 0, secondsLeft: 0 };
  const total = Math.max(1, p.airdropAt - p.airdropFrom);
  const left = Math.max(0, p.airdropAt - w.tick);
  return { unlocked: true, ready: left === 0, progress: 1 - left / total, secondsLeft: Math.ceil(left / TPS) };
}

/** Parachute descent profile: 0 at exit .. 1 on the ground. A short freefall before the canopy bites, then a steady descent. */
export function descentHeight(u: number): number {
  const free = Math.min(1, u / 0.12);
  const steady = Math.max(0, (u - 0.12) / 0.88);
  return Math.max(0, 1 - (0.22 * free * free + 0.78 * steady));
}
