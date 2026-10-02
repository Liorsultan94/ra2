import { describe, expect, it } from 'vitest';
import type { Sfx } from '../src/audio/audio';
import { CombatHeat } from '../src/audio/intensity';

/** Feed `events` (name, volume, per second) for `secs` seconds starting at t0; returns end time. */
function simulate(h: CombatHeat, t0: number, secs: number, events: [Sfx, number, number][]): number {
  const dt = 0.025;
  const acc = events.map(() => 0);
  let t = t0;
  for (let i = 0; i < secs / dt; i++) {
    t = t0 + i * dt;
    events.forEach(([name, vol, rate], k) => {
      acc[k] += rate * dt;
      while (acc[k] >= 1) {
        acc[k] -= 1;
        h.hit(name, vol, t);
      }
    });
    h.update(t);
  }
  return t;
}

describe('CombatHeat (music intensity)', () => {
  it('stays calm with no combat and ignores UI sounds', () => {
    const h = new CombatHeat();
    const t = simulate(h, 0, 30, [['click', 1, 3], ['select', 1, 1], ['build', 1, 0.5]]);
    expect(h.update(t)).toBe(0);
  });

  it('a sparse skirmish lands in the calm/alert range', () => {
    const h = new CombatHeat();
    const t = simulate(h, 0, 30, [['rifle', 0.5, 0.6], ['explosionSmall', 0.8, 0.1]]);
    const v = h.update(t);
    expect(v).toBeGreaterThan(0.05);
    expect(v).toBeLessThan(0.4);
  });

  it('a sustained firefight reaches combat level and rapid fire saturates instead of exploding', () => {
    const h = new CombatHeat();
    const t = simulate(h, 0, 15, [
      ['mg', 0.5, 40],
      ['rifle', 0.5, 40],
      ['cannon', 0.8, 1.5],
      ['explosionMedium', 0.8, 1],
      ['explosionSmall', 0.8, 1.5],
    ]);
    const v = h.update(t);
    expect(v).toBeGreaterThan(0.7);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('rises quickly but decays slowly after the fight', () => {
    const h = new CombatHeat();
    let t = simulate(h, 0, 6, [['explosionLarge', 1, 1], ['cannonHeavy', 0.8, 2], ['rifle', 0.5, 8]]);
    const peak = h.update(t);
    expect(peak).toBeGreaterThan(0.6);
    t = simulate(h, t, 5, []);
    expect(h.update(t)).toBeGreaterThan(peak * 0.5);
    t = simulate(h, t, 60, []);
    expect(h.update(t)).toBeLessThan(0.2);
  });

  it('an alarm floor holds the music at alert level, then fades', () => {
    const h = new CombatHeat();
    h.update(0);
    h.raiseFloor(0.55, 12, 0);
    let t = simulate(h, 0, 10, []);
    expect(h.update(t)).toBeGreaterThan(0.45);
    t = simulate(h, t, 60, []);
    expect(h.update(t)).toBeLessThan(0.1);
  });

  it('reset clears everything', () => {
    const h = new CombatHeat();
    const t = simulate(h, 0, 5, [['thermo', 1, 2]]);
    expect(h.update(t)).toBeGreaterThan(0.3);
    h.reset(t);
    expect(h.update(t + 1)).toBe(0);
  });
});
