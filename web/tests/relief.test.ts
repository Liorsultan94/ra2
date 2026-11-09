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
          // (the Litani: its walls' foot follows the rock's smoothed outline, cutting the tile staircase's inner corners -
          // off the rock only there, within a quarter tile of a rock tile and never near a tile's centre, where units
          // stand; render/relief.ts)
          if (t !== Tile.Rock && lift > 1e-5 && id === 'frontline') {
            let dr = 9;
            for (let ty = Math.floor(y) - 1; ty <= Math.floor(y) + 1; ty++)
              for (let tx = Math.floor(x) - 1; tx <= Math.floor(x) + 1; tx++)
                if (m.tiles[ty * m.w + tx] === Tile.Rock) dr = Math.min(dr, Math.hypot(Math.max(tx - x, 0, x - tx - 1), Math.max(ty - y, 0, y - ty - 1)));
            const dc = Math.hypot(x - Math.floor(x) - 0.5, y - Math.floor(y) - 0.5);
            if (dr <= 0.25 && dc >= 0.25) continue;
          }
          if (t !== Tile.Rock) above += lift > 1e-5 ? 1 : 0;
          else if (lift > 0.3) lifted++;
        }
      expect(above).toBe(0);
      // every map with rock gets real cliffs (the city has none; the Litani mouth's coastal plain only a few, on the
      // steepest slopes of its hills)
      if (id === 'urban') expect(rf.count).toBe(0);
      else expect(lifted).toBeGreaterThan(id === 'frontline' ? 20 : 150);
    });
});
