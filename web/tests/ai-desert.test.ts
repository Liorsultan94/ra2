import { expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

// Desert (no river between the bases): hard AI vs hard AI used to trade wave for wave in the open middle and
// never reach a base - every game ran out the clock. Waves now go for the base, so the game ends.
it('a hard AI game on the desert map ends', () => {
  const w = new World({
    seed: 1,
    map: 'desert',
    players: [
      { name: 'usa', faction: 'usa', color: 0, isAI: true },
      { name: 'russia', faction: 'russia', color: 0, isAI: true },
    ],
  });
  w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
  for (let t = 0; t < TPS * 60 * 25 && !w.over; t++) {
    w.step();
    w.drainEvents();
  }
  expect(w.over).toBe(true);
  expect(w.tick / TPS / 60).toBeLessThan(22);
}, 600_000);
