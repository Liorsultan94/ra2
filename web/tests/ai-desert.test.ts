import { expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

// Desert (no river between the bases): hard AI vs hard AI used to trade wave for wave in the open middle and
// never reach a base - every game ran out the clock. Waves now go for the base, so games end. Game length swings a
// lot from seed to seed (and with any map layout change), so check several seeds rather than one tight deadline.
// The Sinai (SN1, 160 x 160, every attack through one of two land corridors): of seeds 1-6, 2 / 4 / 5 / 6 end in
// 19-29 minutes, 1 and 3 hold out past 60 (both sides' waves die at the corridors). So: 3 of seeds 1-5 end.
it('hard AI games on the desert map end', () => {
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
    // (45 game minutes: the bases 140 tiles apart, two gulfs and the corridors at their heads in between)
    for (let t = 0; t < TPS * 60 * 45 && !w.over; t++) {
      w.step();
      w.drainEvents();
    }
    if (w.over) ended++;
  }
  expect(ended).toBeGreaterThanOrEqual(3);
}, 1_800_000);
