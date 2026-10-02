import { describe, expect, it } from 'vitest';
import { GradeLut, type GradeInput } from '../src/render/post/grade';

const base = (o: Partial<GradeInput> = {}): GradeInput => ({ daylight: 1, sunY: 0.62, warmth: 0.73, rain: 0, storm: 0, sand: 0, snow: 0, ...o });

describe('post grade: look weights from time of day and weather', () => {
  it('the classic afternoon is the day look; a high sun is noon', () => {
    const g = new GradeLut();
    g.blend(base());
    expect(g.weights().day).toBeGreaterThan(0.95);
    g.blend(base({ sunY: 0.88, warmth: 0.28 }));
    expect(g.weights().noon).toBeGreaterThan(0.95);
    expect(g.temperature).toBeLessThan(0);
  });

  it('a low or very warm sun is golden hour, warmer than noon', () => {
    const g = new GradeLut();
    g.blend(base({ sunY: 0.37, warmth: 0.9, daylight: 0.85 }));
    expect(g.weights().golden).toBeGreaterThan(0.7);
    expect(g.temperature).toBeGreaterThan(0.05);
    // fixed dusk keeps the day's key light direction: the warm colour alone makes it golden
    g.blend(base({ sunY: 0.62, warmth: 0.93, daylight: 0.6 }));
    expect(g.weights().golden).toBeGreaterThan(0.5);
  });

  it('night is cool and keeps saturated colours (team colours) readable', () => {
    const g = new GradeLut();
    g.blend(base({ daylight: 0.12, sunY: 0.5, warmth: -0.5 }));
    expect(g.weights().night).toBeGreaterThan(0.95);
    expect(g.temperature).toBeLessThan(-0.1);
    expect(g.saturation).toBeGreaterThan(0.85);
  });

  it('rain greys the look, storms more; sandstorm is warm; weights sum sensibly', () => {
    const g = new GradeLut();
    g.blend(base({ rain: 1 }));
    const rainSat = g.saturation;
    expect(rainSat).toBeLessThan(0.85);
    g.blend(base({ rain: 1, storm: 1 }));
    expect(g.saturation).toBeLessThan(rainSat);
    g.blend(base({ sand: 1 }));
    expect(g.temperature).toBeGreaterThan(0.1);
    // at night the time of day survives part of the weather
    g.blend(base({ daylight: 0.12, rain: 1 }));
    expect(g.weights().rain).toBeLessThan(0.7);
    expect(g.temperature).toBeLessThan(-0.06);
  });

  it('blending is continuous (no pops while the cycle runs)', () => {
    const g = new GradeLut();
    let prev = g.blend(base({ daylight: 1, sunY: 0.85, warmth: 0.3 })).slice();
    for (let i = 1; i <= 100; i++) {
      const t = i / 100;
      const v = g.blend(base({ daylight: 1 - 0.88 * t, sunY: 0.85 - 0.8 * t, warmth: 0.3 + 0.6 * Math.sin(t * Math.PI) - 0.6 * t * t, rain: t * 0.5 }));
      let d = 0;
      for (let k = 0; k < v.length; k++) d = Math.max(d, Math.abs(v[k] - prev[k]));
      expect(d).toBeLessThan(0.03);
      prev = v.slice();
    }
  });
});
