import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { WATER_LEVEL } from '../src/sim/map';
import { HZ_MARGIN, edgeHeightAt, horizonWorld } from '../src/render/horizonworld';

describe('horizon world', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as const) {
    it(`${id}: continuous heights, paths and water`, () => {
      const m = createMap(id);
      const t0 = performance.now();
      const w = horizonWorld(m);
      let n = 0;
      for (let y = -200; y < m.h + 200; y += 3)
        for (let x = -200; x < m.w + 200; x += 3) {
          const h = edgeHeightAt(m, x, y);
          expect(Number.isFinite(h)).toBe(true);
          n++;
        }
      const t1 = performance.now();
      const paths = w.paths;
      // the outskirts belt starts from the map edge height
      for (let y = 0.5; y < m.h; y += 7) expect(Math.abs(edgeHeightAt(m, -0.01, y) - (edgeHeightAt(m, 0.01, y) - 0.14))).toBeLessThan(0.2);
      console.log(id, 'rivers', w.rivers.length, 'paths', paths.length, paths.map((p) => p.pts.length).join(','), 'sea', !!w.sea, 'lakes', w.lakes.length, 'us/height', (((t1 - t0) * 1000) / n).toFixed(2), 'paths ms', (performance.now() - t1).toFixed(0));
      if (id === 'urban') expect(w.isWater(-40, -40)).toBe(true);
      expect(edgeHeightAt(m, m.w / 2, -HZ_MARGIN - 300)).toBeGreaterThan(WATER_LEVEL - 10);
    });
  }
});
