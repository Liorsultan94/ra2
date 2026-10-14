import { it } from 'vitest';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
import { AIController } from '../src/sim/ai';

it('hard vs easy probe', () => {
  for (const [seed, f] of [[1, 'usa'], [2, 'russia']] as [number, Faction][]) {
    const w = new World({ seed, map: (process.env.MAP ?? 'desert') as never, players: [{ name: 'a', faction: f, color: 0, isAI: true }, { name: 'b', faction: f, color: 0, isAI: true }] });
    const ais = [new AIController(w, 0, 'hard'), new AIController(w, 1, 'easy')];
    w.controllers.push(...(ais as never[]));
    const log: string[] = [];
    for (let t = 0; t < TPS * 60 * 25 && !w.over; t++) {
      w.step();
      if (process.env.DUMP && w.tick === TPS * 60 * 6) log.push('bld0: ' + w.list.filter((e: any) => !e.dead && e.owner === 0 && e.kind === 'building').map((e: any) => `${e.def}@${e.tx},${e.ty}`).join(' '));
      if (w.tick % (TPS * 120) === 0) log.push(`${w.tick / TPS / 60}m h${w.players[0].stats.harvested}/${w.players[1].stats.harvested} b${w.list.filter((e: any) => !e.dead && e.owner === 0 && e.kind === 'building').length}/${w.list.filter((e: any) => !e.dead && e.owner === 1 && e.kind === 'building').length}`);
    }
    console.log(`${f} seed ${seed}: over=${w.over} p0def=${w.players[0].defeated} p1def=${w.players[1].defeated} t=${(w.tick / TPS / 60).toFixed(1)} plans ${(ais[0] as any).planLog.join('>')} | ${(ais[1] as any).planLog.join('>')}\n  ${log.join('\n  ')}`);
  }
}, 600000);
