import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
import { writeFileSync } from 'fs';

const MAPS = (process.env.MAPS ?? 'frontline,desert,winter,urban').split(',');
const SEEDS = (process.env.SEEDS ?? '1,2,3').split(',').map(Number);
const PAIRS: [Faction, Faction][] = [['usa', 'russia'], ['israel', 'iran'], ['china', 'ukraine']];
const CAP = Number(process.env.CAP ?? 30) * 60 * TPS;

it('bench', () => {
  const rows: string[] = [];
  for (const map of MAPS) {
    for (let si = 0; si < SEEDS.length; si++) {
      const seed = SEEDS[si];
      const [a, b] = PAIRS[si % PAIRS.length];
      const w = new World({ seed, map: map as never, players: [
        { name: a, faction: a, color: 0, isAI: true },
        { name: b, faction: b, color: 0, isAI: true },
      ] });
      const ais = [new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard')];
      let aiT = 0;
      let maxT = 0;
      const wrap = ais.map((c) => ({ update: () => { const t0 = performance.now(); c.update(); const dt = performance.now() - t0; aiT += dt; if (dt > maxT) maxT = dt; } }));
      w.controllers.push(...(wrap as never[]));
      const t0 = performance.now();
      let firstWave = -1;
      while (!w.over && w.tick < CAP) {
        w.step();
        if (firstWave < 0 && ais.some((c) => (c as any).lastWave > 0)) firstWave = w.tick;
      }
      const wall = performance.now() - t0;
      const alive = w.players.filter((p) => !p.defeated).map((p) => p.faction);
      const winner = w.over ? alive.join('+') : 'none';
      rows.push(`${map} seed=${seed} ${a}-${b}: ${w.over ? 'END' : 'CAP'} ${(w.tick / TPS / 60).toFixed(1)}min winner=${winner} firstWave=${(firstWave / TPS).toFixed(0)}s aiAvg=${((aiT / w.tick) * 1000).toFixed(1)}us/tick aiMaxThink=${maxT.toFixed(2)}ms simWall=${((wall / w.tick) * 1000).toFixed(0)}us/tick`);
      console.log(rows[rows.length - 1]);
    }
  }
  writeFileSync(process.env.OUT ?? '/tmp/claude-0/-home-user-ra2/44ece053-d4d3-5128-ba4e-051cd1175fe3/scratchpad/bench.txt', rows.join('\n') + '\n');
}, 3_600_000);
