import { describe, expect, it } from 'vitest';
import { Tile, groundHeight, type MapId } from '../src/sim/map';
import { createMap } from '../src/sim/maps';
import { reliefField, reliefHeight } from '../src/render/relief';

/*
 * The relief (render/relief.ts) is render only: it may lift the ground into
 * cliffs on impassable rock, never above the sim's ground anywhere a unit,
 * building, road or bridge can be.
 */
describe('relief', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as MapId[])
    it(`${id}: cliffs only on rock tiles`, () => {
      const m = createMap(id, 1);
      const rf = reliefField(m);
      let lifted = 0;
      let above = 0;
      for (let y = 0.05; y < m.h; y += 0.17)
        for (let x = 0.05; x < m.w; x += 0.17) {
          const t = m.tiles[Math.floor(y) * m.w + Math.floor(x)];
          const lift = reliefHeight(m, x, y) - groundHeight(m, x, y);
          if (t !== Tile.Rock) above += lift > 1e-5 ? 1 : 0;
          else if (lift > 0.3) lifted++;
        }
      expect(above).toBe(0);
      // every map with rock gets real cliffs (the city has none)
      if (id === 'urban') expect(rf.count).toBe(0);
      else expect(lifted).toBeGreaterThan(150);
    });
});
