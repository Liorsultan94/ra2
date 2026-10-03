/**
 * Combat "heat" for the adaptive battle score.
 *
 * The music has no access to the simulation: it infers how intense the fight
 * is from the sound effects and announcer lines that reach the AudioSystem.
 * Every combat sound adds weighted energy to two leaky integrators (a fast one,
 * ~6 s, that reacts to bursts and a slow one, ~25 s, that remembers a long
 * siege). Their sum is mapped through a saturating curve into 0..1, combined
 * with an optional "floor" (raised by alarms such as "base under attack") and
 * finally smoothed asymmetrically: quick to rise, slow to calm down.
 *
 * Pure TypeScript: no Web Audio, so it can be unit-tested.
 */
import type { Sfx } from './audio';

/** energy per event at volume 1 (UI sounds contribute nothing) */
export const HEAT_WEIGHT: Partial<Record<Sfx, number>> = {
  rifle: 0.16,
  mg: 0.14,
  flak: 0.25,
  laser: 0.4,
  cannon: 0.5,
  cannonHeavy: 0.8,
  rocket: 0.5,
  missileLaunch: 0.8,
  artillery: 0.8,
  thermo: 1.2,
  explosionSmall: 0.4,
  explosionMedium: 0.8,
  explosionLarge: 1.6,
  buildingCollapse: 3,
  intercept: 0.5,
  droneLaunch: 0.4,
  droneBuzz: 0.1,
  autocannon: 0.35,
  interceptorLaunch: 0.6,
  mortar: 0.6,
  bridgeCollapse: 3,
  jetFlyby: 0.3,
  crush: 0.3,
  jam: 0.3,
  alarm: 2.5,
};

const FAST_TAU = 6;
const SLOW_TAU = 25;
const FAST_K = 8;
const SLOW_K = 60;
const RISE_TAU = 1.2;
const FALL_TAU = 9;
/** the same sound name counts at most this often (rapid fire is gated) */
const NAME_GAP = 0.1;
const FLOOR_FADE = 15;

export class CombatHeat {
  private fast = 0;
  private slow = 0;
  private v = 0;
  private t = Number.NaN;
  private floor = 0;
  private floorAt = 0;
  private floorHold = 0;
  private last = new Map<string, number>();

  /** current smoothed intensity 0..1 (as of the last update) */
  get value(): number {
    return this.v;
  }

  reset(now?: number): void {
    this.fast = 0;
    this.slow = 0;
    this.v = 0;
    this.floor = 0;
    this.last.clear();
    this.t = now ?? Number.NaN;
  }

  /** Register a sound effect that was requested at time `now` (seconds). */
  hit(name: Sfx, volume: number, now: number): void {
    const w = HEAT_WEIGHT[name];
    if (!w || !(volume > 0) || !Number.isFinite(now)) return;
    const prev = this.last.get(name);
    if (prev !== undefined && now - prev < NAME_GAP && now >= prev) return;
    this.last.set(name, now);
    this.update(now);
    const e = w * Math.min(1, volume);
    this.fast += e;
    this.slow += e;
  }

  /**
   * Keep the intensity at or above `level` for `hold` seconds, then let the
   * floor fade out over ~15 s (used for "base under attack" style alerts).
   */
  raiseFloor(level: number, hold: number, now: number): void {
    if (!Number.isFinite(now)) return;
    this.update(now);
    const cur = this.floorAt + this.floorHold > now ? this.floor : this.floorValue(now);
    if (level >= cur) {
      this.floor = Math.min(1, level);
      this.floorAt = now;
      this.floorHold = hold;
    }
  }

  /** raw (unsmoothed) target intensity at the last update */
  target(now: number): number {
    const x = this.fast / FAST_K + this.slow / SLOW_K;
    return Math.max(1 - Math.exp(-x), this.floorValue(now));
  }

  /** Advance decay and smoothing to `now`; returns the smoothed intensity. */
  update(now: number): number {
    if (!Number.isFinite(now)) return this.v;
    if (Number.isNaN(this.t)) this.t = now;
    const dt = now - this.t;
    if (dt <= 0) return this.v;
    this.t = now;
    this.fast *= Math.exp(-dt / FAST_TAU);
    this.slow *= Math.exp(-dt / SLOW_TAU);
    const target = this.target(now);
    const tau = target > this.v ? RISE_TAU : FALL_TAU;
    this.v += (target - this.v) * (1 - Math.exp(-dt / tau));
    if (this.v < 1e-4) this.v = 0;
    return this.v;
  }

  private floorValue(now: number): number {
    if (this.floor <= 0) return 0;
    const since = now - this.floorAt - this.floorHold;
    if (since <= 0) return this.floor;
    const k = 1 - since / FLOOR_FADE;
    if (k <= 0) {
      this.floor = 0;
      return 0;
    }
    return this.floor * k;
  }
}
