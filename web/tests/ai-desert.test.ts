import { expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { NAVY_AI } from '../src/sim/navalai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

// Desert (no river between the bases): hard AI vs hard AI used to trade wave for wave in the open middle and
// never reach a base - every game ran out the clock. Waves now go for the base, so games end. Game length swings a
// lot from seed to seed (and with any map layout change), so check several seeds rather than one tight deadline.
// The Sinai (SN1, traced from the owner's picture, every attack over the land at one of the two gulfs' heads): of
// seeds 1-20, 16 end in 19-58 minutes, 4 hold out past 60; seeds 1-5 end in 35-46. So: 3 of seeds 1-5 end.
// The land war only: the navy (NV1, navalai.ts) is switched off here. With it, Hard spends on a Shipyard, boats and
// landings: of seeds 1-13, 6 end within 45 minutes against 10 without (no grace; with the grace on, the slot bench
// decides more games with the navy than without). tests/ai-navy.test.ts covers the navy.
it('hard AI games on the desert map end', () => {
  NAVY_AI.on = false;
  let ended = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = new World({
      seed,
      map: 'desert',
      players: [
        { name: 'usa', faction: 'usa', color: 0, isAI: true },
        { name: 'russia', faction: 'russia', color: 0, isAI: true },
      ],
    });
    w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
    // (45 game minutes: the bases 160 tiles apart by road, two gulfs and the crossings at their heads in between)
    for (let t = 0; t < TPS * 60 * 45 && !w.over; t++) {
      w.step();
      w.drainEvents();
    }
    if (w.over) ended++;
  }
  NAVY_AI.on = true;
  expect(ended).toBeGreaterThanOrEqual(3);
}, 1_800_000);
