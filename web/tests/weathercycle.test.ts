import { describe, expect, it } from 'vitest';
import { WeatherCycle } from '../src/render/weathercycle';

describe('dynamic weather timeline', () => {
  it('is a deterministic function of seed and game time (frame-rate independent)', () => {
    const a = new WeatherCycle(42, { dust: true });
    const b = new WeatherCycle(42, { dust: true });
    // a samples every frame-ish, b jumps straight to the times
    let t = 0;
    while (t < 1800) {
      a.at(t);
      t += 0.37;
    }
    for (const q of [1800, 950.5, 2400]) {
      const sa = a.at(q);
      const sb = b.at(q);
      expect(sa.cover).toBeCloseTo(sb.cover, 6);
      expect(sa.precip).toBeCloseTo(sb.precip, 6);
      expect(sa.wet).toBeCloseTo(sb.wet, 6);
      expect(sa.windDir).toBeCloseTo(sb.windDir, 6);
      expect(sa.fall).toBe(sb.fall);
    }
    const c = new WeatherCycle(43, { dust: true });
    c.at(3600);
    a.at(3600);
    expect(c.events[0].start).not.toBe(a.events[0].start);
  });

  it('opens clear, then fronts come and go and the ground wets and dries', () => {
    const w = new WeatherCycle(7);
    expect(w.at(0).precip).toBe(0);
    expect(w.at(30).cover).toBe(0);
    w.at(7200);
    const wet = w.events.filter((e) => e.precip > 0 && e.fall === 'rain');
    expect(wet.length).toBeGreaterThan(3);
    const e = wet[0];
    const peak = e.start + e.build + e.ramp + e.hold * 0.5;
    const s = w.at(peak);
    expect(s.cover).toBeGreaterThan(0.5);
    expect(s.precip).toBeGreaterThan(0.2);
    expect(s.wet).toBeGreaterThan(0.4);
    const end = w.end(e);
    // ends clear, wet ground then drying
    expect(w.at(end + 1).cover).toBe(0);
    expect(w.at(end + 1).precip).toBe(0);
    expect(w.at(end + 400).wet).toBeLessThan(w.at(end - e.clear + 5).wet);
    // values stay in range everywhere
    for (let t = 0; t < 7200; t += 13) {
      const q = w.at(t);
      for (const v of [q.cover, q.precip, q.storm, q.wind, q.wet, q.mist, q.dust, q.snow]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('desert sandstorm', () => {
  const HOUR = 60; // game seconds per game hour (1 real minute at 1x)
  const firstDust = (seed: number) => {
    const w = new WeatherCycle(seed, { climate: 'desert' });
    w.at(24 * HOUR);
    return { w, e: w.events.find((e) => e.kind === 'dust')! };
  };

  it('comes at a random (seeded, deterministic) hour, not always in the morning', () => {
    const starts: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const { e } = firstDust(seed * 7919);
      expect(e).toBeTruthy();
      starts.push(e.start / HOUR + 5.5);
      // deterministic: the same seed lays out the same storm
      expect(firstDust(seed * 7919).e.start).toBe(e.start);
    }
    const lo = Math.min(...starts);
    const hi = Math.max(...starts);
    // spread over most of the day (old timeline: always 07:00 .. 09:30)
    expect(hi - lo).toBeGreaterThan(6);
    expect(starts.filter((h) => h > 11).length).toBeGreaterThan(15);
  });

  it('blows for about 30 s (half a game hour), fading in and out gradually, as a thin haze', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { w, e } = firstDust(seed * 104729);
      let on = 0;
      let prev = 0;
      let maxStep = 0;
      let peak = 0;
      let cover = 0;
      for (let t = e.start - 5; t < w.end(e) + 5; t += 0.25) {
        const s = w.at(t);
        if (s.fall === 'sandstorm' && s.precip > 0.05) on += 0.25;
        maxStep = Math.max(maxStep, Math.abs(s.precip - prev));
        prev = s.precip;
        peak = Math.max(peak, s.precip);
        cover = Math.max(cover, s.cover);
      }
      expect(on).toBeGreaterThan(18);
      expect(on).toBeLessThan(42);
      expect(peak).toBeGreaterThan(0.6);
      // gradual: no jumps (a quarter second never moves the intensity by more than 8%)
      expect(maxStep).toBeLessThan(0.08);
      // a sandy haze, not a dark overcast front
      expect(cover).toBeLessThanOrEqual(0.35);
    }
  });
});
