import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { NAVY_AI } from '../src/sim/navalai';
import { peaceTicks } from '../src/sim/peace';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * The carrier-vs-no-carrier matchup (NV2), re-run for NV4: on the desert map a carrier nation (USA / Russia / China)
 * whose AI buys the carrier plays a nation whose AI does not, both seats, seeds 1-2, 40 minutes, every AI Hard.
 * SUBS=0 / 1 switches the submarines (NV4) off / on for both sides. BENCH=1 to run (it is slow).
 *   BENCH=1 SUBS=1 npx vitest run bench/cvbench.test.ts --silent=false
 */
const PAIRS: [Faction, Faction][] = [['usa', 'israel'], ['russia', 'ukraine'], ['china', 'iran']];

it.skipIf(!process.env.BENCH)('carrier vs none', () => {
  NAVY_AI.subs = process.env.SUBS !== '0';
  let cvWins = 0;
  let otWins = 0;
  let games = 0;
  let subsBuilt = 0;
  for (const seed of [1, 2]) {
    for (const [cvn, other] of PAIRS) {
      for (const cvSlot of [0, 1]) {
        const fs = cvSlot === 0 ? [cvn, other] : [other, cvn];
        const w = new World({ seed, map: 'desert', players: fs.map((f, i) => ({ name: `P${i}`, faction: f, color: 0, isAI: true })) });
        const pt = peaceTicks('hard', 'auto');
        const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
        w.controllers.push(...ais);
        // the carrier nation's AI buys its carrier, the other's does not
        ais.forEach((a, i) => {
          const n = a.navy as unknown as { carrierPlan: boolean } | null;
          if (n) n.carrierPlan = i === cvSlot;
        });
        while (!w.over && w.tick < TPS * 60 * 40) {
          w.step();
          w.drainEvents();
        }
        games++;
        const winner = w.over ? (w.players.findIndex((p) => !p.defeated) === cvSlot ? 'cv' : 'other') : 'none';
        if (winner === 'cv') cvWins++;
        if (winner === 'other') otWins++;
        subsBuilt += ais.reduce((n, a) => n + (a.navy?.stats.subs ?? 0), 0);
        console.log('CVB', JSON.stringify({ seed, cvn, other, cvSlot, winner, min: +(w.tick / TPS / 60).toFixed(1), subs: ais.map((a) => a.navy?.stats.subs ?? 0) }));
      }
    }
  }
  console.log('CVB SUM', JSON.stringify({ subs: NAVY_AI.subs, games, cvWins, otWins, subsBuilt }));
}, 9_000_000);
