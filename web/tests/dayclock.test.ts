import { describe, expect, it } from 'vitest';
import { CYCLE_TICKS, GAME_HOUR_TICKS, HOUR_U, START_HOUR, atmosConfig, clockHours, clockIcon, formatClock, hourToU, uToHour } from '../src/render/atmos';
import { WeatherCycle, type WxClimate } from '../src/render/weathercycle';
import { TPS } from '../src/sim/types';
import { forecastLine, timeLine } from '../src/ui/briefing';

describe('live day clock', () => {
  it('runs 1 real minute = 1 game hour at 1x (24 minute day)', () => {
    expect(GAME_HOUR_TICKS).toBe(TPS * 60);
    expect(CYCLE_TICKS).toBe(TPS * 60 * 24);
    const t0 = clockHours(0);
    expect(clockHours(TPS * 60) - t0).toBeCloseTo(1, 9);
    expect(clockHours(TPS) - t0).toBeCloseTo(1 / 60, 9); // a real second = a game minute
    expect(clockHours(CYCLE_TICKS) - t0).toBeCloseTo(24, 9);
  });

  it('starts at 05:30, before sunrise', () => {
    expect(START_HOUR).toBe(5.5);
    expect(formatClock(clockHours(0))).toBe('05:30');
    expect(clockIcon(clockHours(0))).toBe('sunrise');
    // 30 real seconds later it is 06:00 (dawn), after 24 minutes the next day's 05:30
    expect(formatClock(clockHours(TPS * 30))).toBe('06:00');
    expect(formatClock(clockHours(CYCLE_TICKS))).toBe('05:30');
    expect(Math.floor(clockHours(CYCLE_TICKS) / 24) + 1).toBe(2);
  });

  it('formats the clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(6.7)).toBe('06:42');
    expect(formatClock(23.999)).toBe('23:59');
    expect(formatClock(24)).toBe('00:00');
    expect(formatClock(37.25)).toBe('13:15');
    expect(formatClock(-0.5)).toBe('23:30');
    expect(clockIcon(12)).toBe('sun');
    expect(clockIcon(18.75)).toBe('sunset');
    expect(clockIcon(23)).toBe('moon');
    expect(clockIcon(3)).toBe('moon');
  });

  it('hour -> u hits the lighting anchors', () => {
    const anchors: [number, number][] = [
      [12, 0],
      [15, 0.2],
      [17.5, 0.31],
      [18.5, 0.375],
      [19.25, 0.425],
      [19.75, 0.46],
      [21, 0.51],
      [4.5, 0.72],
      [5.25, 0.77],
      [6, 0.81],
      [8, 0.88],
    ];
    for (const [h, u] of anchors) {
      expect(hourToU(h)).toBeCloseTo(u, 9);
      expect(uToHour(u)).toBeCloseTo(h, 9);
    }
    expect(HOUR_U[HOUR_U.length - 1]).toEqual([36, 1]);
  });

  it('hour -> u is monotonic over a day, wraps at noon and inverts', () => {
    let prev = -1;
    for (let k = 0; k < 24 * 60; k++) {
      const h = 12 + k / 60;
      const u = hourToU(h);
      expect(u).toBeGreaterThan(prev);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      prev = u;
      const d = (((uToHour(u) - (h % 24)) % 24) + 24) % 24;
      expect(Math.min(d, 24 - d)).toBeCloseTo(0, 6);
    }
    // wraps: the same hour on any day, negative hours too
    expect(hourToU(12)).toBe(0);
    expect(hourToU(11.999)).toBeGreaterThan(0.99);
    expect(hourToU(6 + 48)).toBeCloseTo(hourToU(6), 9);
    expect(hourToU(-18)).toBeCloseTo(hourToU(6), 9);
    expect(uToHour(1.2)).toBeCloseTo(uToHour(0.2), 9);
    // the night (21:00 .. 04:30) lasts 7.5 game hours = 7.5 real minutes at 1x
    expect(uToHour(0.72) + 24 - uToHour(0.51)).toBeCloseTo(7.5, 9);
  });
});

describe('atmosphere defaults', () => {
  it('menu battles default to the live day with dynamic weather; test URLs keep the plain day', () => {
    expect(atmosConfig(0, 'snow', true)).toMatchObject({ tod: 'cycle', weather: 'dynamic' });
    expect(atmosConfig(0, 'snow', false)).toMatchObject({ tod: 'day', weather: 'snow' });
    // the attract demo never gets it
    expect(atmosConfig(-1, 'clear', true)).toMatchObject({ tod: 'day', weather: 'clear' });
  });

  it("a menu battle's day / dusk / night / mist pick is a start time on the running clock, never a frozen sky", () => {
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    const store: Record<string, string> = {};
    g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) };
    try {
      for (const [tod, h] of [['day', 10], ['dusk', 17.5], ['night', 21], ['mist', 6]] as const) {
        store['ironfront.settings.v1'] = JSON.stringify({ tod });
        expect(atmosConfig(0, 'clear', true)).toMatchObject({ tod: 'cycle', startHour: h });
      }
      store['ironfront.settings.v1'] = JSON.stringify({ tod: 'cycle' });
      expect(atmosConfig(0, 'clear', true).startHour).toBeUndefined();
      // test URLs (not live) keep the fixed sky
      store['ironfront.settings.v1'] = JSON.stringify({ tod: 'night' });
      expect(atmosConfig(0, 'clear', false)).toMatchObject({ tod: 'night' });
    } finally {
      g.localStorage = prev;
    }
  });
});

describe('briefing lines', () => {
  it('shows the start time and the forecast', () => {
    expect(timeLine('cycle', 5.5)).toBe('0530 HRS · DAWN · LIVE DAY');
    expect(timeLine('night')).toMatch(/2300 HRS · NIGHT/);
    expect(forecastLine('dynamic', [{ kind: 'showers', hour: 8.25, storm: false }, { kind: 'storm', hour: 15, storm: true }])).toBe('FORECAST · SHOWERS ~0815 · STORMS LATER');
    expect(forecastLine('dynamic', [])).toMatch(/CLEAR/);
    expect(forecastLine('rain', null)).toMatch(/RAIN/);
  });
});

describe('weather over a live day (24 game hours = 1440 game seconds)', () => {
  const DAY = 24 * 60;
  const climates: WxClimate[] = ['temperate', 'desert', 'winter', 'urban'];
  const fallOf: Record<WxClimate, string> = { temperate: 'rain', urban: 'rain', desert: 'sandstorm', winter: 'snow' };

  for (const climate of climates) {
    it(`${climate}: fronts with precipitation and clear spells, deterministic per seed`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const w = new WeatherCycle(seed * 7919, { climate, cold: climate === 'winter' });
        let precipSec = 0;
        let clearSec = 0;
        let fall = 0;
        for (let t = 0; t < DAY; t += 10) {
          const s = w.at(t);
          if (s.precip > 0.05) {
            precipSec += 10;
            if (s.fall === fallOf[climate]) fall += 10;
          }
          if (s.cover < 0.05 && s.precip === 0) clearSec += 10;
        }
        // at least one episode, the climate's own kind first, and plenty of clear sky in between
        // (a desert sandstorm blows for only ~30 s: weathercycle.ts DUST_SHAPE)
        const minSec = climate === 'desert' ? 20 : 61;
        expect(precipSec).toBeGreaterThanOrEqual(minSec);
        expect(fall).toBeGreaterThanOrEqual(minSec);
        expect(clearSec).toBeGreaterThan(DAY * 0.25);
        // noticeable but not constant: 1 .. 5 fronts a day
        w.at(DAY);
        const fronts = w.events.filter((e) => e.start < DAY);
        expect(fronts.length).toBeGreaterThanOrEqual(1);
        expect(fronts.length).toBeLessThanOrEqual(5);
        // climate: no rain in winter, rain rare in the desert, never dust outside the desert
        if (climate === 'winter') expect(fronts.every((e) => e.fall === 'snow')).toBe(true);
        if (climate !== 'desert') expect(fronts.every((e) => e.kind !== 'dust')).toBe(true);
        // deterministic: a fresh timeline with the same seed agrees
        const b = new WeatherCycle(seed * 7919, { climate, cold: climate === 'winter' });
        for (const t of [333.3, 900, 1400]) {
          expect(b.at(t).precip).toBeCloseTo(w.at(t).precip, 9);
          expect(b.at(t).cover).toBeCloseTo(w.at(t).cover, 9);
        }
      }
    });
  }

  it('desert: mostly dust, rain is rare', () => {
    let dust = 0;
    let wet = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const w = new WeatherCycle(seed, { climate: 'desert' });
      w.at(DAY * 4);
      for (const e of w.events) {
        if (e.kind === 'dust') dust++;
        else if (e.fall === 'rain' && e.precip > 0) wet++;
      }
    }
    expect(dust).toBeGreaterThan(wet * 2);
    expect(wet).toBeGreaterThan(0);
  });
});
