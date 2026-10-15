// Hard vs easy on the desert, both slot orders: 4 seeds x usa / russia mirrors x 2 slot orders = 16 games.
import { it } from 'vitest';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
import { AIController } from '../src/sim/ai';

it('hard vs easy x16', () => {
  const tally: Record<string, number> = {};
  for (const seed of [1, 2, 3, 4]) for (const f of ['usa', 'russia'] as Faction[]) for (const hardSlot of [0, 1]) {
    const w = new World({ seed, map: 'desert', players: [{ name: 'a', faction: f, color: 0, isAI: true }, { name: 'b', faction: f, color: 0, isAI: true }] });
    const ais = [new AIController(w, 0, hardSlot === 0 ? 'hard' : 'easy'), new AIController(w, 1, hardSlot === 1 ? 'hard' : 'easy')];
    w.controllers.push(...(ais as never[]));
    let t = 0;
    for (; t < TPS * 60 * 25 && !w.over; t++) w.step();
    const l0 = w.players[0].defeated, l1 = w.players[1].defeated;
    const ws = l0 === l1 ? -1 : l0 ? 1 : 0;
    const winner = ws < 0 ? 'none' : ws === hardSlot ? 'hard' : 'easy';
    const k = `hardSlot${hardSlot}:${winner}`;
    tally[k] = (tally[k] ?? 0) + 1;
    console.log(`seed ${seed} ${f} hardSlot ${hardSlot}: ${winner} ${(t / TPS / 60).toFixed(1)}min`);
  }
  console.log('TALLY ' + JSON.stringify(tally));
}, 3_600_000);
