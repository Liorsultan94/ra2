import { it } from 'vitest';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';
import { AIController } from '../src/sim/ai';
import { DEFS } from '../src/sim/defs';

it('dbg', () => {
  const map = (process.env.MAP ?? 'frontline') as never;
  const seed = Number(process.env.SEED ?? 3);
  const f = (process.env.F ?? 'usa') as never;
  const w = new World({ seed, map, players: [{ name: 'a', faction: f, color: 0, isAI: true }, { name: 'b', faction: f, color: 0, isAI: true }] });
  const ais = [new AIController(w, 0, 'hard', { peaceTicks: 1e9 }), new AIController(w, 1, 'hard', { peaceTicks: 1e9 })];
  w.controllers.push(...(ais as never[]));
  const until = Number(process.env.MIN ?? 6) * 60 * TPS;
  while (w.tick < until) {
    w.step();
    if (w.tick % (TPS * 60) === 0) {
      for (const pid of [0, 1]) {
        const hv = w.list.filter((e: any) => !e.dead && e.owner === pid && (DEFS[e.def] as any).harvester);
        console.log(`t=${w.tick / TPS / 60} p${pid} cred=${Math.round(w.players[pid].credits)} harv=${w.players[pid].stats.harvested} hv=${hv.map((h: any) => `${h.def}@${h.x.toFixed(0)},${h.y.toFixed(0)}:${h.hstate}:${h.order.type}:c${h.cargo ?? '?'}`).join(' ')}`);
      }
    }
  }
  for (const pid of [0, 1]) {
    const bs = w.list.filter((e: any) => !e.dead && e.owner === pid && e.kind === 'building').map((e: any) => `${e.def}@${e.tx},${e.ty}`);
    console.log(`p${pid} plan=${(ais[pid] as any).planLog.join('>')} bld: ${bs.join(' ')}`);
  }
});
