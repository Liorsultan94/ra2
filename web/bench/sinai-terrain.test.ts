// SN1 design aid: the AI's terrain use (AI2) on the Sinai over several seeds: garrisons, canyon ambushes, plateau.
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { peaceTicks } from '../src/sim/peace';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

it('sinai terrain', () => {
  for (const seed of (process.env.SEEDS ?? '3,1,2').split(',').map(Number)) {
    const w = new World({ seed, map: 'desert', players: [{ name: 'israel', faction: 'israel', color: 0, isAI: true }, { name: 'iran', faction: 'iran', color: 0, isAI: true }] });
    const pt = peaceTicks('hard', 'auto');
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })] as any[];
    w.controllers.push(...ais);
    const out: string[] = [];
    for (let t = 0; t < TPS * 60 * Number(process.env.MIN ?? 24) && !w.over; t++) {
      w.step();
      if (t % (TPS * 60 * 4) === 0) out.push(`${t / TPS / 60}m ${JSON.stringify(ais.map((a) => a.terrainStats))} budget ${ais.map((a) => a.postBudget)}`);
    }
    console.log(`seed ${seed}\n${out.join('\n')}`);
  }
});
