import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { groundHeight } from '../src/sim/map';
import { PadSet, SITE_RES, SiteMap, bindPads, padDelta, padSurface } from '../src/render/basesoil';

describe('base pads (render only)', () => {
  const m = createMap('frontline', 1);
  it('level the footprint exactly, blend back to the natural ground, and leave far ground alone', () => {
    const p = new PadSet(m);
    bindPads(p);
    const x0 = 20;
    const y0 = 20;
    const base = groundHeight(m, x0 + 1.5, y0 + 1.5);
    p.add(x0, y0, x0 + 3, y0 + 3, base + 0.04, 1);
    for (const [x, y] of [
      [x0 + 0.2, y0 + 0.3],
      [x0 + 2.9, y0 + 2.7],
      [x0 + 1.5, y0 + 1.5],
    ])
      expect(padSurface(m, x, y, groundHeight(m, x, y))).toBeCloseTo(base + 0.04, 6);
    // a smooth, monotone blend out to the natural height
    let prev = Math.abs(padDelta(m, x0 + 3.1, y0 + 1.5));
    for (let d = 3.3; d < 4.3; d += 0.2) {
      const dl = Math.abs(padDelta(m, x0 + d, y0 + 1.5));
      expect(dl).toBeLessThanOrEqual(prev + 0.02);
      prev = dl;
    }
    expect(padDelta(m, x0 + 5, y0 + 1.5)).toBe(0);
    expect(padDelta(m, 60, 60)).toBe(0);
    // a new structure on the same spot replaces the pad
    p.add(x0, y0, x0 + 2, y0 + 2, base + 0.1);
    expect(p.pads.length).toBe(1);
    bindPads(null);
  });

  it('paints the site map: disturbed soil under and round the footprint, a lane out of the front', () => {
    const p = new PadSet(m);
    const s = new SiteMap(p);
    p.add(30, 30, 33, 33, 0.5, 1);
    s.update();
    const at = (x: number, y: number) => ((Math.floor(y * SITE_RES) * m.w * SITE_RES + Math.floor(x * SITE_RES)) * 4);
    expect(s.data[at(31.5, 31.5)]).toBe(255);
    expect(s.data[at(31.5, 33.5)]).toBeGreaterThan(100);
    expect(s.data[at(31.5, 35.2)]).toBeLessThan(s.data[at(31.5, 33.5)]);
    expect(s.data[at(40, 40)]).toBe(0);
    expect(s.data[at(31.5, 34.2) + 2]).toBeGreaterThan(80); // lane strength
    expect(s.data[at(36.5, 31.5) + 2]).toBe(0);
  });
});
