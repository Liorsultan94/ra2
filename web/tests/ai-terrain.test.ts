import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { buildingDef } from '../src/sim/defs';
import { groundHeight } from '../src/sim/map';
import { peaceTicks } from '../src/sim/peace';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

describe('terrain use on Wadi Al-Rimal (AI2)', () => {
  it('finds the summit plateau and the canyon mouths on its own side', () => {
    const w = new World({ seed: 2, map: 'desert', players: [
      { name: 'usa', faction: 'usa', color: 0, isAI: true },
      { name: 'russia', faction: 'russia', color: 0, isAI: true },
    ] });
    // (the one coloured canyon lies inland of Nuweiba, nearer red's base: SN1 traced the real Sinai)
    const cy = w.map.deco!.canyons![0].pts;
    const mid = cy[cy.length >> 1];
    const near = w.players.map((p) => Math.hypot(mid.x - p.startX, mid.y - p.startY));
    const owner = near[0] < near[1] ? 0 : 1;
    for (const pid of [0, 1]) {
      const ai = new AIController(w, pid, 'hard') as AnyAI;
      const posts = ai.findPosts();
      const p = w.players[pid];
      const plateau = posts.find((q: { key: string }) => q.key === 'plateau');
      expect(plateau).toBeTruthy();
      // high above the base, on our half, reachable by vehicle (the summit track)
      expect(groundHeight(w.map, plateau.x, plateau.y) - groundHeight(w.map, p.startX + 0.5, p.startY + 0.5)).toBeGreaterThan(2);
      expect(w.regionOf(plateau.x, plateau.y)).toBe(w.mainland);
      const canyon = posts.filter((q: { ambush: boolean }) => q.ambush);
      expect(canyon.length).toBe(pid === owner ? 2 : 0);
      const o = w.players[1 - pid];
      // (the canyon lies by the line halfway between the two bases since they moved apart, SN2: a wall spot over a
      // mouth may sit on that line)
      for (const c of [plateau, ...canyon]) expect(Math.hypot(c.x - p.startX, c.y - p.startY)).toBeLessThanOrEqual(Math.hypot(c.x - o.startX, c.y - o.startY));
    }
  });

  it('Hard desert games: houses on the routes garrisoned, a canyon ambush set, the plateau visited', () => {
    // (terrain use is chaotic from seed to seed - every feature moved with the Sinai layout, SN1: two games,
    // 16 minutes each, between them the AIs use all three)
    let held = 0;
    const tot = { garrisons: 0, canyon: 0, plateauVisits: 0 };
    const all: unknown[] = [];
    for (const seed of [2, 3]) {
      const w = new World({ seed, map: 'desert', players: [
        { name: 'israel', faction: 'israel', color: 0, isAI: true },
        { name: 'iran', faction: 'iran', color: 0, isAI: true },
      ] });
      const pt = peaceTicks('hard', 'auto');
      const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })] as AnyAI[];
      w.controllers.push(...ais);
      for (let t = 0; t < TPS * 60 * 16 && !w.over; t++) {
        w.step();
        if (t % (TPS * 10) === 0) for (const e of w.list) if (!e.dead && e.kind === 'building' && e.owner >= 0 && buildingDef(e.def).garrison && e.passengers.length) held++;
      }
      for (const a of ais) {
        tot.garrisons += a.terrainStats.garrisons;
        tot.canyon += a.terrainStats.canyon;
        tot.plateauVisits += a.terrainStats.plateauVisits;
        all.push(a.terrainStats);
      }
    }
    const msg = JSON.stringify(all);
    expect(held, msg).toBeGreaterThan(0);
    expect(tot.garrisons, msg).toBeGreaterThan(0);
    expect(tot.canyon, msg).toBeGreaterThan(0);
    expect(tot.plateauVisits, msg).toBeGreaterThan(0);
  }, 600000);
});
