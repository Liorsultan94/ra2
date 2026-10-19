// SN1 design aid: the AI's rally point per slot (slot 1 transposed into the slot-0 frame) and how many of its army
// units stand idle near it over time in a hard-vs-easy game.
// BENCH=1 SEED=3 HARD=0 npx vitest run bench/sinai-rally.test.ts --silent=false
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

it('sinai rally', () => {
  const seed = Number(process.env.SEED ?? 3);
  const hard = Number(process.env.HARD ?? 0);
  const w = new World({ seed, map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'usa', color: 0, isAI: true }] });
  const diff = (k: number) => (hard === k ? 'hard' : 'easy');
  const ais: any[] = [new AIController(w, 0, diff(0)), new AIController(w, 1, diff(1))];
  if (process.env.SWAP) {
    const wa = new World({ seed, map: 'desert', players: [{ name: 'b', faction: 'usa', color: 0, isAI: true }, { name: 'a', faction: 'usa', color: 0, isAI: true }] });
    for (let k = 0; k < 2; k++) {
      const donor: any = new AIController(wa, 1 - k, diff(k));
      for (const f of ['rng', 'plan', 'planCfg', 'buildOrder', 'waveSize', 'raidPace', 'raidAt', 'scoutAt', 'waveStale', 'waveJitter']) ais[k][f] = donor[f];
      ais[k].planLog.length = 0;
      ais[k].planLog.push(...donor.planLog);
    }
  }
  w.controllers.push(...ais);
  const fr = (x: number, y: number, p: number) => (p === 0 ? [x, y] : [y, x]);
  for (let t = 0; t <= TPS * 60 * Number(process.env.MIN ?? 8); t++) {
    if (t % (TPS * 30) === 0 && t > 0) {
      const a = ais[hard];
      const [rx, ry] = a.rally();
      const units = w.list.filter((e) => !e.dead && e.owner === hard && e.kind === 'unit' && a.roleOf(e) === 'army');
      const near = units.filter((u) => Math.hypot(u.x - rx, u.y - ry) < 7);
      const idle = units.filter((u) => u.order.type === 'idle');
      const far = units.filter((u) => Math.hypot(u.x - rx, u.y - ry) >= 7).map((u) => {
        const [x, y] = fr(u.x, u.y, hard);
        return `${u.def.replace(/^[a-z]+_/, '')}:${u.order.type}@${x.toFixed(0)},${y.toFixed(0)}`;
      });
      const [cx, cy] = fr(rx, ry, hard);
      console.log(`${(t / TPS / 60).toFixed(1)}m rally ${cx.toFixed(1)},${cy.toFixed(1)} army ${units.length} near ${near.length} idle ${idle.length} waves ${a.stats.waves} notBefore ${(a.waveNotBefore / TPS / 60).toFixed(1)}m want ${a.waveSize}+${a.waveJitter} far [${far.join(' ')}]`);
    }
    w.step();
    w.drainEvents();
  }
});
