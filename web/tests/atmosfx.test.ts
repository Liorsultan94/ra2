import { describe, expect, it } from 'vitest';
import {
  CHIMNEY_TIER,
  DEVIL_CAP,
  chimneyAmount,
  dawnBanksAt,
  dawnGlowAt,
  dawnMistAt,
  devilCap,
  devilLife,
  devilMaySpawn,
  godRayTier,
  mistClimateK,
  postRainShaftBoost,
  steamAmount,
} from '../src/render/fx/atmosrules';
import { WeatherCycle, dryRate, wetStep } from '../src/render/weathercycle';

describe('dawn valley mist over the live clock', () => {
  it('rises from about 05:00, is full at dawn and burns off by 08:30', () => {
    expect(dawnMistAt(4.5)).toBeLessThan(0.3);
    expect(dawnMistAt(5)).toBeGreaterThan(dawnMistAt(4.5));
    expect(dawnMistAt(6)).toBeGreaterThan(0.95);
    expect(dawnMistAt(6.5)).toBeGreaterThan(0.95);
    // burning off gradually as the sun climbs: monotonic over the morning
    let prev = dawnMistAt(6.7);
    for (let h = 6.8; h <= 8.5; h += 0.1) {
      const v = dawnMistAt(h);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    expect(dawnMistAt(7.5)).toBeGreaterThan(0.2);
    expect(dawnMistAt(7.5)).toBeLessThan(0.8);
    expect(dawnMistAt(8.5)).toBeLessThan(0.01);
    // none through the day and the evening
    for (const h of [9, 11, 12, 14, 17, 19, 21]) expect(dawnMistAt(h)).toBeLessThan(0.01);
  });

  it('a faint layer in the small hours, continuous over midnight', () => {
    expect(dawnMistAt(23.99)).toBeCloseTo(dawnMistAt(0), 2);
    expect(dawnMistAt(2.5)).toBeGreaterThan(0.15);
    expect(dawnMistAt(2.5)).toBeLessThan(0.3);
    // wraps every 24 hours, survives bad input
    expect(dawnMistAt(6.5 + 48)).toBeCloseTo(dawnMistAt(6.5), 6);
    expect(dawnMistAt(NaN)).toBe(0);
  });

  it('the dawn banks and the sun glow follow the morning; the glow waits for the sun', () => {
    expect(dawnBanksAt(3)).toBe(0);
    expect(dawnBanksAt(6.2)).toBeGreaterThan(0.95);
    expect(dawnBanksAt(9)).toBe(0);
    expect(dawnGlowAt(5.2)).toBe(0);
    expect(dawnGlowAt(6.5)).toBeGreaterThan(0.9);
    expect(dawnGlowAt(9)).toBe(0);
  });

  it('strong in the temperate and winter valleys, a trace in the desert', () => {
    expect(mistClimateK('winter')).toBe(1);
    expect(mistClimateK('temperate')).toBe(1);
    expect(mistClimateK('urban')).toBeLessThan(1);
    expect(mistClimateK('desert')).toBeLessThan(0.3);
    expect(mistClimateK('desert')).toBeGreaterThan(0);
  });
});

describe('dust devil spawn rules', () => {
  const desertNoon = { biome: 'desert', day: 1, precip: 0, wet: 0 };
  it('desert by day only', () => {
    expect(devilCap(desertNoon, 'high')).toBe(2);
    expect(devilCap(desertNoon, 'medium')).toBe(1);
    expect(devilCap({ ...desertNoon, day: 0.3 }, 'high')).toBe(0);
    for (const biome of ['temperate', 'winter', 'urban']) expect(devilCap({ ...desertNoon, biome }, 'high')).toBe(0);
  });

  it('not in rain, a sandstorm or on wet sand', () => {
    expect(devilCap({ ...desertNoon, precip: 0.4 }, 'high')).toBe(0);
    expect(devilCap({ ...desertNoon, wet: 0.5 }, 'high')).toBe(0);
  });

  it('capped per view and tier, none on low', () => {
    expect(DEVIL_CAP.low).toBe(0);
    expect(devilCap(desertNoon, 'low')).toBe(0);
    expect(devilMaySpawn(desertNoon, 'high', 0, 0)).toBe(true);
    expect(devilMaySpawn(desertNoon, 'high', 1, 0)).toBe(true);
    expect(devilMaySpawn(desertNoon, 'high', 2, 0)).toBe(false);
    expect(devilMaySpawn(desertNoon, 'medium', 1, 0)).toBe(false);
    // the spawn timer must have run out
    expect(devilMaySpawn(desertNoon, 'high', 0, 3)).toBe(false);
    // the debug switch forces one anywhere
    expect(devilCap({ ...desertNoon, biome: 'temperate', forced: true }, 'medium')).toBe(1);
  });

  it('each whirl lives 10 to 25 seconds', () => {
    expect(devilLife(0)).toBe(10);
    expect(devilLife(1)).toBe(25);
    expect(devilLife(0.5)).toBeCloseTo(17.5);
    expect(devilLife(-3)).toBe(10);
    expect(devilLife(7)).toBe(25);
  });
});

describe('ground drying after rain', () => {
  it('soaks in the rain and dries gradually over a few minutes of sun', () => {
    let w = 0;
    for (let s = 0; s < 60; s++) w = wetStep(w, 1, 1, 0.5);
    expect(w).toBeGreaterThan(0.9);
    // stops raining, the sky clears: never jumps, dries over ~4-6 minutes
    const curve: number[] = [w];
    for (let s = 0; s < 600; s++) curve.push((w = wetStep(w, 0, 0.1, 0.2)));
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeLessThanOrEqual(curve[i - 1]);
      expect(curve[i - 1] - curve[i]).toBeLessThan(0.01);
    }
    const dryAt = curve.findIndex((v) => v <= 0);
    expect(dryAt).toBeGreaterThan(180);
    expect(dryAt).toBeLessThan(420);
    // half dry after a couple of minutes
    expect(curve[120]).toBeGreaterThan(0.3);
    expect(curve[120]).toBeLessThan(0.8);
  });

  it('dries slower under cloud, faster in wind', () => {
    expect(dryRate(0.9, 0.2)).toBeLessThan(dryRate(0.1, 0.2));
    expect(dryRate(0.3, 0.8)).toBeGreaterThan(dryRate(0.3, 0.1));
  });

  it('the timeline integrates the same curve (deterministic)', () => {
    const a = new WeatherCycle(11, { climate: 'temperate' });
    const b = new WeatherCycle(11, { climate: 'temperate' });
    for (const t of [30, 400, 1200, 2600]) expect(a.at(t).wet).toBe(b.at(t).wet);
  });

  it('steam rises only off wet ground in the sun, after the rain has stopped', () => {
    expect(steamAmount(0.6, 0, 1, 0.2)).toBeGreaterThan(0.5);
    expect(steamAmount(0, 0, 1, 0.2)).toBe(0);
    expect(steamAmount(0.6, 0.5, 1, 0.2)).toBe(0);
    expect(steamAmount(0.6, 0, 0.2, 0.2)).toBe(0);
    expect(steamAmount(0.6, 0, 1, 0.95)).toBe(0);
    // fades as the ground dries
    expect(steamAmount(0.15, 0, 1, 0.2)).toBeLessThan(steamAmount(0.5, 0, 1, 0.2));
  });
});

describe('god ray tiers', () => {
  it('high: smoke and cloud shafts at quarter resolution', () => {
    const t = godRayTier('high');
    expect(t).toMatchObject({ on: true, smoke: true, div: 4, steps: 10, strength: 1 });
  });

  it('medium (phones): cloud gaps only, an eighth of the resolution, fewer samples, still visible', () => {
    const t = godRayTier('medium');
    expect(t.on).toBe(true);
    expect(t.smoke).toBe(false);
    expect(t.div).toBeGreaterThanOrEqual(8);
    expect(t.steps).toBeLessThan(godRayTier('high').steps);
    expect(t.strength).toBeGreaterThan(0.5);
    expect(t.strength).toBeLessThanOrEqual(1);
  });

  it('low: none', () => {
    expect(godRayTier('low').on).toBe(false);
  });

  it('after rain the shafts glow more, only once it has stopped', () => {
    expect(postRainShaftBoost(0, 0)).toBe(1);
    expect(postRainShaftBoost(0.6, 0)).toBeGreaterThan(1.3);
    expect(postRainShaftBoost(0.6, 0.5)).toBe(1);
  });
});

describe('chimney smoke', () => {
  it('more at breakfast and in the evening than at midday', () => {
    const noon = chimneyAmount(13, 'temperate');
    expect(chimneyAmount(7.5, 'temperate')).toBeGreaterThan(noon + 0.3);
    expect(chimneyAmount(19.5, 'temperate')).toBeGreaterThan(noon + 0.3);
    expect(noon).toBeGreaterThan(0);
    expect(chimneyAmount(3, 'temperate')).toBeGreaterThan(noon);
  });

  it('more in the cold, none in the desert', () => {
    expect(chimneyAmount(13, 'winter')).toBeGreaterThan(chimneyAmount(13, 'temperate'));
    expect(chimneyAmount(13, 'temperate', 0.8)).toBeGreaterThan(chimneyAmount(13, 'temperate', 0));
    expect(chimneyAmount(7.5, 'desert')).toBe(0);
    for (let h = 0; h < 24; h += 0.5) expect(chimneyAmount(h, 'winter')).toBeLessThanOrEqual(1);
  });

  it('distance-capped per tier, none on low', () => {
    expect(CHIMNEY_TIER.low.max).toBe(0);
    expect(CHIMNEY_TIER.medium.max * CHIMNEY_TIER.medium.puffs).toBeLessThan(CHIMNEY_TIER.high.max * CHIMNEY_TIER.high.puffs);
    expect(CHIMNEY_TIER.high.max * CHIMNEY_TIER.high.puffs).toBeLessThanOrEqual(400);
  });
});
