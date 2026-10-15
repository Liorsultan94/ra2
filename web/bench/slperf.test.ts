// Sim tick cost (SL1): AI vs AI Hard on the 128 x 128 maps, mean and p99 ms per tick over the first minutes.
// BENCH=1 npx vitest run bench/slperf.test.ts   (env: MAPS, MIN (minutes, default 12), SEEDS)
import { it } from 'vitest';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';
import { AIController } from '../src/sim/ai';

const MAPS = (process.env.MAPS ?? 'frontline,desert').split(',');
const MIN = Number(process.env.MIN ?? 12);
const SEEDS = (process.env.SEEDS ?? '1,2').split(',').map(Number);

it('sim tick time', () => {
  for (const map of MAPS) {
    const all: number[] = [];
    let ms = 0;
    let ticks = 0;
    for (const seed of SEEDS) {
      const w = new World({ seed, map: map as never, players: [
        { name: 'a', faction: 'usa', color: 0, isAI: true },
        { name: 'b', faction: 'russia', color: 0, isAI: true },
      ] });
      w.controllers.push(new AIController(w, 0, 'hard', { peaceTicks: 0 }) as never, new AIController(w, 1, 'hard', { peaceTicks: 0 }) as never);
      while (!w.over && w.tick < MIN * 60 * TPS) {
        const t0 = performance.now();
        w.step();
        const dt = performance.now() - t0;
        all.push(dt);
        ms += dt;
        ticks++;
      }
    }
    all.sort((a, b) => a - b);
    console.log(`${map}: ${ticks} ticks, mean ${(ms / ticks).toFixed(3)} ms, p50 ${all[Math.floor(all.length * 0.5)].toFixed(3)}, p99 ${all[Math.floor(all.length * 0.99)].toFixed(3)}, max ${all[all.length - 1].toFixed(1)}`);
  }
});
