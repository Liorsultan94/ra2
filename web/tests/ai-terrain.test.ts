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
      expect(canyon.length).toBe(2);
      const o = w.players[1 - pid];
      for (const c of [plateau, ...canyon]) expect(Math.hypot(c.x - p.startX, c.y - p.startY)).toBeLessThan(Math.hypot(c.x - o.startX, c.y - o.startY));
    }
  });

  it('a Hard desert game: houses on the routes garrisoned, a canyon ambush set, the plateau visited', () => {
    const w = new World({ seed: 3, map: 'desert', players: [
      { name: 'israel', faction: 'israel', color: 0, isAI: true },
      { name: 'iran', faction: 'iran', color: 0, isAI: true },
    ] });
    const pt = peaceTicks('hard', 'auto');
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })] as AnyAI[];
    w.controllers.push(...ais);
    let held = 0;
    for (let t = 0; t < TPS * 60 * 16 && !w.over; t++) {
      w.step();
      if (t % (TPS * 10) === 0) for (const e of w.list) if (!e.dead && e.kind === 'building' && e.owner >= 0 && buildingDef(e.def).garrison && e.passengers.length) held++;
    }
    const st = ais.map((a) => a.terrainStats);
    const msg = JSON.stringify(st);
    expect(held, msg).toBeGreaterThan(0);
    expect(st[0].garrisons + st[1].garrisons, msg).toBeGreaterThan(0);
    expect(st[0].canyon + st[1].canyon, msg).toBeGreaterThan(0);
    expect(st[0].plateauVisits + st[1].plateauVisits, msg).toBeGreaterThan(0);
  }, 300000);
});
