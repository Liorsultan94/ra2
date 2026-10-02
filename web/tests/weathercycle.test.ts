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
