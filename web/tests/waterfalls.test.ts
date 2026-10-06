import { describe, expect, it } from 'vitest';
import { Tile, type MapId } from '../src/sim/map';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { findFalls, runningWater } from '../src/render/relieffx';

/*
 * Waterfalls (render/relieffx.ts) only where running water meets a cliff: the
 * desert's oases are still water in a basin, and a cascade off a dry mesa into
 * one would be water from nowhere.
 */
describe('waterfalls', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as MapId[])
    for (const seed of [1, 437163864, 777])
      it(`${id} #${seed}: falls only on running water`, () => {
        const m = createMap(id, seed);
        const run = runningWater(m);
        let water = 0;
        let running = 0;
        for (let i = 0; i < m.w * m.h; i++)
          if (m.tiles[i] === Tile.Water) {
            water++;
            if (run[i] === 1) running++;
          }
        if (id === 'desert') expect(running).toBe(0);
        // (the frozen pass's river is an icy lake chain inside the map: still water too)
        else if (id !== 'winter') expect(running / water).toBeGreaterThan(0.9);
        for (const f of findFalls(m, buildLayout(m))) {
          const e = f.entry;
          // the cascade ends in the river
          let near = false;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const x = Math.floor(e.x) + dx;
              const y = Math.floor(e.z) + dy;
              if (x >= 0 && y >= 0 && x < m.w && y < m.h && run[y * m.w + x] === 1) near = true;
            }
          expect(near).toBe(true);
        }
        if (id === 'desert') expect(findFalls(m, buildLayout(m)).length).toBe(0);
      });
});
