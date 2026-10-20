import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { unitDef } from '../src/sim/defs';
import { Tile } from '../src/sim/map';
import { peaceTicks } from '../src/sim/peace';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV1: the computer player goes to sea on the desert map (Hard): it builds a Shipyard on the coast that leads to the
 * enemy, fields boats, raids with them once the war is on (never in the peace grace) and makes flanking landings.
 * Maps without sea are untouched (no navy at all). The navy comes late (the land war first: navalai.ts NavCfg.yardAt,
 * share), so the game runs 34 minutes.
 */

describe('AI navy', () => {
  it('builds and uses a Shipyard on the desert map', () => {
    const w = new World({ seed: 2, map: 'desert', players: [
      { name: 'A', faction: 'usa', color: 0, isAI: true },
      { name: 'B', faction: 'russia', color: 0, isAI: true },
    ] });
    const pt = peaceTicks('hard', 'auto');
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
    w.controllers.push(...ais);
    let raidInPeace = false;
    let boatOnLand = false;
    while (!w.over && w.tick < TPS * 60 * 34) {
      w.step();
      if (w.tick % 20 !== 0) continue;
      if (w.tick < pt && ais.some((a) => (a.navy?.stats.raids ?? 0) + (a.navy?.stats.landings ?? 0) > 0)) raidInPeace = true;
      for (const e of w.list) if (!e.dead && e.kind === 'unit' && unitDef(e.def).naval === 'boat' && w.map.tiles[w.tileOf(e.x, e.y)] !== Tile.Water) boatOnLand = true;
    }
    const st = ais.map((a) => a.navy!.stats);
    const msg = JSON.stringify({ st, min: +(w.tick / TPS / 60).toFixed(1), over: w.over });
    // (built: by the end of a long game a yard may well have been sunk by the other side's boats or a landing)
    expect(st.some((s) => s.yards > 0), msg).toBe(true);
    expect(st.reduce((n, s) => n + s.boats, 0), msg).toBeGreaterThanOrEqual(2);
    expect(st.reduce((n, s) => n + s.raids, 0), msg).toBeGreaterThanOrEqual(1);
    expect(st.reduce((n, s) => n + s.landings, 0), msg).toBeGreaterThanOrEqual(1);
    expect(raidInPeace).toBe(false);
    expect(boatOnLand).toBe(false);
  });

  it('no navy where there is no sea', () => {
    const w = new World({ seed: 1, map: 'frontline', players: [
      { name: 'A', faction: 'usa', color: 0, isAI: true },
      { name: 'B', faction: 'russia', color: 0, isAI: true },
    ] });
    const ai = new AIController(w, 0, 'hard');
    expect(ai.navy).toBeNull();
  });
});
