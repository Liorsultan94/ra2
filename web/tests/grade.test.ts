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
    // (warm, but only a little: the warmth of a golden hour lives in the key light)
    expect(g.temperature).toBeGreaterThan(0.02);
    // fixed dusk keeps the day's key light direction: the warm colour alone makes it golden
    g.blend(base({ sunY: 0.62, warmth: 0.93, daylight: 0.6 }));
    expect(g.weights().golden).toBeGreaterThan(0.5);
  });

  it('night is cool and keeps saturated colours (team colours) readable', () => {
    const g = new GradeLut();
    g.blend(base({ daylight: 0.12, sunY: 0.5, warmth: -0.5 }));
    expect(g.weights().night).toBeGreaterThan(0.95);
    expect(g.temperature).toBeLessThan(-0.1);
    // the landscape goes grey-blue; lights and team colours are spared by the protection band (shader)
    expect(g.saturation).toBeLessThan(0.7);
    expect(g.saturation).toBeGreaterThan(0.4);
  });

  it('rain greys the look, storms more; sandstorm is warm; weights sum sensibly', () => {
    const g = new GradeLut();
    g.blend(base({ rain: 1 }));
    const rainSat = g.saturation;
    expect(rainSat).toBeLessThan(0.85);
    g.blend(base({ rain: 1, storm: 1 }));
    expect(g.saturation).toBeLessThan(rainSat);
    g.blend(base({ sand: 1 }));
    expect(g.temperature).toBeGreaterThan(0.05);
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


describe('grade LUT survives a lost GPU context (the black screen)', () => {
  const r = { getRenderTarget: () => null, setRenderTarget: () => {} } as never;
  const blit = { draw: () => {} } as never;
  const day = { daylight: 1, sunY: 0.62, warmth: 0.73, rain: 0, storm: 0, sand: 0, snow: 0 };

  it('re-bakes after invalidate() even when the look holds still', () => {
    const g = new GradeLut();
    g.update(r, blit, { ...day });
    const n = g.bakes;
    g.update(r, blit, { ...day });
    expect(g.bakes).toBe(n);
    // WebGL context restored: the LUT render target came back empty (every pixel graded to black)
    g.invalidate();
    g.update(r, blit, { ...day });
    expect(g.bakes).toBe(n + 1);
  });

  it('refreshes the LUT every ~2 s regardless, so a lost LUT can never stick', () => {
    const g = new GradeLut();
    g.update(r, blit, { ...day });
    const n = g.bakes;
    for (let i = 0; i < 400; i++) g.update(r, blit, { ...day });
    expect(g.bakes).toBeGreaterThanOrEqual(n + 3);
    expect(g.bakes).toBeLessThanOrEqual(n + 4);
  });

  it('never bakes a NaN look', () => {
    const g = new GradeLut();
    g.update(r, blit, { ...day });
    const n = g.bakes;
    g.invalidate();
    g.update(r, blit, { ...day, daylight: NaN, warmth: NaN, sunY: Infinity });
    // (sanitised to the clear day: a finite look is baked)
    expect(g.bakes).toBe(n + 1);
  });
});

describe('post grade: the desert looks (GD5)', () => {
  const sum = (w: Readonly<Record<string, number>>) => Object.values(w).reduce((a, b) => a + b, 0);
  it('crisp noon and afternoon, warm golden hour, cool blue hour, the shared night', () => {
    const g = new GradeLut();
    g.blend(base({ sunY: 0.85, warmth: 0.28, desert: 1 }));
    expect(g.weights().dNoon).toBeGreaterThan(0.95);
    expect(g.weights().noon).toBe(0);
    g.blend(base({ desert: 1 }));
    expect(g.weights().dDay).toBeGreaterThan(0.95);
    // (higher contrast than the shared day look)
    const crisp = g.blend(base({ desert: 1 }))[13];
    expect(crisp).toBeGreaterThan(g.blend(base())[13]);
    g.blend(base({ sunY: 0.37, warmth: 0.9, daylight: 0.85, desert: 1 }));
    expect(g.weights().dGolden).toBeGreaterThan(0.7);
    expect(g.temperature).toBeGreaterThan(0.04);
    // dusk .. twilight (19:30): the blue hour
    g.blend(base({ sunY: 0.15, warmth: 0.8, daylight: 0.46, desert: 1 }));
    expect(g.weights().dBlue).toBeGreaterThan(0.5);
    expect(g.temperature).toBeLessThan(-0.04);
    // the night look is untouched (gameplay darkness)
    g.blend(base({ daylight: 0.12, sunY: 0.5, warmth: -0.5, desert: 1 }));
    expect(g.weights().night).toBeGreaterThan(0.95);
    // (daylight, key light elevation) along the live day: the weights stay a partition
    for (const [d, y] of [[1, 0.85], [1, 0.62], [0.85, 0.37], [0.65, 0.22], [0.6, 0.16], [0.46, 0.14], [0.28, 0.12], [0.12, 0.5], [0.6, 0.21], [0.95, 0.5]]) {
      g.blend(base({ daylight: d, sunY: y, desert: 1 }));
      expect(sum(g.weights())).toBeCloseTo(1, 5);
    }
  });

  it('other maps keep the shared looks', () => {
    const g = new GradeLut();
    for (const o of [{}, { sunY: 0.85, warmth: 0.28 }, { sunY: 0.15, warmth: 0.8, daylight: 0.46 }]) {
      g.blend(base(o));
      const w = g.weights();
      expect(w.dNoon + w.dDay + w.dGolden + w.dBlue).toBe(0);
    }
  });
});
