import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { unitDef } from '../src/sim/defs';
import { peaceTicks } from '../src/sim/peace';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV3: on the desert map a Hard AI trains a small squad of Combat Divers once the war is on (never in the peace grace),
 * swims it from its coast to a beach by the enemy's base and fights on ashore; the land AI never takes them for a wave.
 */

describe('AI divers', () => {
  it('Hard trains a squad after the grace and raids by sea', () => {
    const fs: Faction[] = ['usa', 'russia'];
    // (seed 3: with the AI's reactions, aireact.ts, seed 2's game is over before the divers sail)
    const w = new World({ seed: 3, map: 'desert', players: fs.map((f, i) => ({ name: `P${i}`, faction: f, color: 0, isAI: true })) });
    const pt = peaceTicks('hard', 'auto');
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
    w.controllers.push(...ais);
    const seen = new Set<number>();
    let built = 0;
    let first = -1;
    let dived = 0;
    let nearFoe = Infinity;
    let inWave = false;
    const armyTicks = new Map<number, number>();
    while (!w.over && w.tick < TPS * 60 * 36) {
      w.step();
      w.drainEvents();
      if (w.tick % 20 !== 0) continue;
      for (const e of w.list) {
        if (e.dead || e.kind !== 'unit' || !unitDef(e.def).swim) continue;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          built++;
          if (first < 0) first = w.tick;
        }
        if (e.dive) dived++;
        const foe = w.players[1 - e.owner];
        nearFoe = Math.min(nearFoe, Math.hypot(e.x - foe.startX, e.y - foe.startY));
        // (the land AI's waves never take a diver: once trained it is the navy's within a moment, never the army's)
        const a = ais[e.owner] as unknown as { roleOf(u: unknown): string };
        armyTicks.set(e.id, a.roleOf(e) === 'army' ? (armyTicks.get(e.id) ?? 0) + 1 : 0);
        if ((armyTicks.get(e.id) ?? 0) > 6) inWave = true;
      }
    }
    const st = ais.map((a) => a.navy?.stats);
    const msg = JSON.stringify({ st, built, first: +(first / TPS / 60).toFixed(1), dived, nearFoe: +nearFoe.toFixed(0), min: +(w.tick / TPS / 60).toFixed(1) });
    expect(built, msg).toBeGreaterThanOrEqual(2);
    expect(first, msg).toBeGreaterThan(pt); // never in the grace
    expect(st.reduce((n, s) => n + (s?.dives ?? 0), 0), msg).toBeGreaterThanOrEqual(1);
    expect(dived, msg).toBeGreaterThan(0); // they swam submerged
    expect(nearFoe, msg).toBeLessThan(45); // and got to the enemy's shore
    expect(inWave).toBe(false);
  }, 1_800_000);

  it('no divers where there is no sea or no Shipyard', () => {
    const w = new World({ seed: 1, map: 'frontline', players: [
      { name: 'A', faction: 'usa', color: 0, isAI: true },
      { name: 'B', faction: 'russia', color: 0, isAI: true },
    ] });
    for (let t = 0; t < TPS * 60 * 3; t++) w.step();
    expect(w.list.some((e) => e.kind === 'unit' && unitDef(e.def).swim)).toBe(false);
  });
});
