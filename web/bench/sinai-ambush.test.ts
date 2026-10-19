// SN1 design aid: what the infantry is doing when the AI looks to man a canyon ambush.
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { canGarrisonUnit } from '../src/sim/garrison';
import { DEFS } from '../src/sim/defs';
import { peaceTicks } from '../src/sim/peace';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

it('sinai ambush', () => {
  const seed = Number(process.env.SEED ?? 3);
  const w = new World({ seed, map: 'desert', players: [{ name: 'israel', faction: 'israel', color: 0, isAI: true }, { name: 'iran', faction: 'iran', color: 0, isAI: true }] });
  const pt = peaceTicks('hard', 'auto');
  const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })] as any[];
  w.controllers.push(...ais);
  const hist = new Map<string, number>();
  ais.forEach((ai) => {
    const orig = ai.holdPost.bind(ai);
    ai.holdPost = (force: any[], p: any, want: number, aa: boolean) => {
      if (p.ambush && ai.postBudget >= 2) {
        const [rx, ry] = ai.rally();
        for (const u of force) {
          if (DEFS[u.def].category !== 'infantry' || !canGarrisonUnit(u.def)) continue;
          const k = `${ai.roleOf(u)}/${u.order.type}/${Math.hypot(u.x - rx, u.y - ry) < 14 ? 'rally' : 'far'}`;
          hist.set(k, (hist.get(k) ?? 0) + 1);
        }
      }
      return orig(force, p, want, aa);
    };
  });
  for (let t = 0; t < TPS * 60 * 16 && !w.over; t++) w.step();
  console.log(JSON.stringify([...hist.entries()].sort((a, b) => b[1] - a[1])));
});
