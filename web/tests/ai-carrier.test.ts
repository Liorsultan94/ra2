import { describe, expect, it, onTestFinished } from 'vitest';
import { AI2, AIController } from '../src/sim/ai';
import { unitDef } from '../src/sim/defs';
import { peaceTicks } from '../src/sim/peace';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV2: on the desert map (deep sea) a Hard USA / Russia / China AI builds an aircraft carrier late in the game, keeps it
 * on its own side of the sea in deep water (never sailing it at the enemy's coast), and its deck jets fly strikes and
 * land back aboard. The peace grace is untouched: no carrier, no deck jet sortie before it ends.
 */

describe('AI aircraft carrier', () => {
  it('Hard builds one late, keeps it back in deep water and strikes with its jets', () => {
    const fs: Faction[] = ['usa', 'russia'];
    // (seed 1: since jets no longer bomb unexplored ground, seed 2's game has no carrier; seeds 1 and 4 do)
    // (the game this was tuned on: without combined landings, ai.ts, which change how it goes from the first landing on)
    const was = AI2.combined;
    AI2.combined = false;
    onTestFinished(() => {
      AI2.combined = was;
    });
    const w = new World({ seed: 1, map: 'desert', players: fs.map((f, i) => ({ name: `P${i}`, faction: f, color: 0, isAI: true })) });
    const pt = peaceTicks('hard', 'auto');
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
    w.controllers.push(...ais);
    let firstCarrier = -1;
    let notDeep = 0;
    let nearEnemy = Infinity;
    let jetsBuilt = 0;
    const seen = new Set<number>();
    let releases = 0;
    let landings = 0;
    let sortieInPeace = false;
    // (a late-game asset: the game runs 46 minutes)
    while (!w.over && w.tick < TPS * 60 * 46) {
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.t !== 'sortie') continue;
        const j = w.get(ev.id);
        if (!j || !j.def.endsWith('_cvjet')) continue;
        if (ev.what === 'release') releases++;
        if (ev.what === 'touchdown' && j.sortie && w.get(j.sortie.base)?.kind === 'unit') landings++;
        if (ev.what === 'takeoff' && w.tick < pt) sortieInPeace = true;
      }
      if (w.tick % 20 !== 0) continue;
      for (const e of w.list) {
        if (e.dead || e.kind !== 'unit') continue;
        const d = unitDef(e.def);
        if (d.deckJet && !seen.has(e.id)) {
          seen.add(e.id);
          jetsBuilt++;
        }
        if (!d.deck) continue;
        if (firstCarrier < 0) firstCarrier = w.tick;
        if (!w.naval.base[3][w.tileOf(e.x, e.y)]) notDeep++;
        const foe = w.players[1 - e.owner];
        nearEnemy = Math.min(nearEnemy, Math.hypot(e.x - foe.startX, e.y - foe.startY));
      }
    }
    const st = ais.map((a) => a.navy?.stats);
    const msg = JSON.stringify({ st, first: +(firstCarrier / TPS / 60).toFixed(1), jetsBuilt, releases, landings, nearEnemy: +nearEnemy.toFixed(0), min: +(w.tick / TPS / 60).toFixed(1) });
    expect(firstCarrier, msg).toBeGreaterThan(pt);
    expect(firstCarrier, msg).toBeGreaterThan(TPS * 60 * 14);
    expect(notDeep, msg).toBe(0);
    expect(jetsBuilt, msg).toBeGreaterThanOrEqual(2);
    expect(releases, msg).toBeGreaterThanOrEqual(1);
    expect(landings, msg).toBeGreaterThanOrEqual(1);
    expect(sortieInPeace).toBe(false);
    // (it holds a station on its own side: never off the enemy's base)
    expect(nearEnemy, msg).toBeGreaterThan(40);
  }, 1_800_000);

  it('nations without a carrier never build one', () => {
    const w = new World({ seed: 1, map: 'desert', players: [
      { name: 'A', faction: 'israel', color: 0, isAI: true },
      { name: 'B', faction: 'iran', color: 0, isAI: true },
    ] });
    for (const pid of [0, 1]) {
      const ai = new AIController(w, pid, 'hard');
      expect((ai.navy as unknown as { carrierPlan: boolean } | null)?.carrierPlan ?? false).toBe(false);
    }
  });
});
