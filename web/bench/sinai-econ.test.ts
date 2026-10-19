// SN1 design aid: early economy by slot for one difficulty (both sides the same AI level), building spots in the
// slot-0 frame (slot 1 transposed) so the two bases compare directly.
// BENCH=1 SEED=1 DIFF=easy MIN=5 npx vitest run bench/sinai-econ.test.ts --silent=false
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

it('sinai econ', () => {
  const seed = Number(process.env.SEED ?? 1);
  const diff = (process.env.DIFF ?? 'easy') as any;
  const MIN = Number(process.env.MIN ?? 5);
  const w = new World({ seed, map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'usa', color: 0, isAI: true }] });
  const ais = [new AIController(w, 0, diff, { peaceTicks: TPS * 60 * 60 }), new AIController(w, 1, diff, { peaceTicks: TPS * 60 * 60 })];
  // SWAP=1: each AI keeps the personality (plan, build order, rng) it has in the game with the slots swapped
  if (process.env.SWAP) {
    const wa = new World({ seed, map: 'desert', players: [{ name: 'b', faction: 'usa', color: 0, isAI: true }, { name: 'a', faction: 'usa', color: 0, isAI: true }] });
    for (let k = 0; k < 2; k++) {
      const donor: any = new AIController(wa, 1 - k, diff, { peaceTicks: TPS * 60 * 60 });
      const c: any = ais[k];
      for (const f of ['rng', 'plan', 'planCfg', 'buildOrder', 'waveSize', 'raidPace', 'raidAt', 'scoutAt', 'waveStale', 'waveJitter']) c[f] = donor[f];
      c.planLog.length = 0;
      c.planLog.push(...donor.planLog);
    }
  }
  w.controllers.push(...ais);
  for (let t = 0; t <= TPS * 60 * MIN; t++) {
    if (t % (TPS * 30) === 0) {
      const row = [`${(t / TPS / 60).toFixed(1)}m`];
      for (const p of [0, 1]) {
        const harv = w.list.filter((e) => !e.dead && e.owner === p && e.def.includes('harvester'));
        row.push(`P${p} h${w.players[p].stats.harvested} $${Math.round(w.players[p].credits)} harv ${harv.length} [${harv.map((e) => `${(e as any).hstate ?? (e as any).order?.type ?? ''}`).join(',')}]`);
      }
      console.log(row.join(' | '));
    }
    w.step();
    w.drainEvents();
  }
  for (const p of [0, 1]) {
    const blds = w.list.filter((e) => !e.dead && e.owner === p && e.kind === 'building').map((e: any) => {
      const [x, y] = p === 0 ? [e.tx, e.ty] : [e.ty, e.tx];
      return `${e.def.replace(/^[a-z]+_/, '')}@${x},${y}${e.flip ? 'f' : ''}`;
    });
    console.log(`P${p} buildings (slot-0 frame, top-left tile): ${blds.join(' ')}`);
  }
});
