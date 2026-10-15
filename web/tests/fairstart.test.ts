import { describe, expect, it } from 'vitest';
import { factionUnit } from '../src/sim/defs';
import { dockXY } from '../src/sim/harvest';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

// BAL1: the north base's exit / dock buildings are turned half a circle (sim/turn.ts), so the two bases of a
// point-symmetric map are exact mirrors: units leave, and harvesters dock, on mirrored sides.

function world(map: 'frontline' | 'desert' | 'winter' | 'urban' = 'frontline') {
  const w = new World({ seed: 1, map, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'usa', color: 0, isAI: false }] });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  return w;
}

describe('fair starts: the north base mirrors the south one', () => {
  it('turns the north player\'s refinery / factory / barracks (only those), with drive-through tiles, dock and exits mirrored', () => {
    const w = world();
    const { w: W, h: H } = w.map;
    const pairs: [string, number, number, number, number][] = [
      ['usa_refinery', 24, 112, 3, 3],
      ['usa_factory', 30, 112, 3, 3],
      ['usa_barracks', 36, 112, 2, 2],
      ['usa_power', 40, 112, 2, 2],
    ];
    for (const [def, x, y, bw, bh] of pairs) {
      const s = w.spawnBuilding(def, 0, x, y, true);
      const n = w.spawnBuilding(def, 1, W - x - bw, H - y - bh, true);
      expect(!!s.flip, def).toBe(false);
      expect(!!n.flip, def).toBe(def !== 'usa_power');
      // occupancy / passability of the two footprints are point mirrors (drive-through tiles included)
      for (let dy = 0; dy < bh; dy++)
        for (let dx = 0; dx < bw; dx++) {
          const i = (y + dy) * W + x + dx;
          expect(w.pass[i], `${def} ${dx},${dy}`).toBe(w.pass[W * H - 1 - i]);
        }
      if (def === 'usa_refinery') {
        const [ax, ay] = dockXY(s);
        const [bx, by] = dockXY(n);
        expect([bx, by]).toEqual([W - ax, H - ay]);
      }
    }
  });

  it('units leave a turned factory on its north side, towards the mirrored rally point', () => {
    const w = world();
    const { w: W, h: H } = w.map;
    w.players[0].credits = w.players[1].credits = 99999;
    const f0 = w.spawnBuilding('usa_factory', 0, 30, 112, true);
    const f1 = w.spawnBuilding('usa_factory', 1, W - 33, H - 115, true);
    w.spawnBuilding('usa_power', 0, 20, 112, true);
    w.spawnBuilding('usa_power', 1, W - 22, H - 114, true);
    const tank = factionUnit('usa', (u) => u.id === 'usa_mbt').id;
    w.issue(0, { type: 'produce', def: tank });
    w.issue(1, { type: 'produce', def: tank });
    let u0, u1;
    for (let t = 0; t < TPS * 90 && !(u0 && u1); t++) {
      w.step();
      u0 = w.list.find((e) => e.owner === 0 && e.def === tank);
      u1 = w.list.find((e) => e.owner === 1 && e.def === tank);
    }
    expect(u0 && u1).toBeTruthy();
    for (let t = 0; t < TPS * 6; t++) w.step();
    // the south base's tank rolls out south of its factory, the north one's north of its own
    expect(u0!.y).toBeGreaterThan(f0.ty + 2);
    expect(u1!.y).toBeLessThan(f1.ty + 1);
  });
});
