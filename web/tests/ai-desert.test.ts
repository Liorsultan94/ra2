import { expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

// Desert (no river between the bases): hard AI vs hard AI used to trade wave for wave in the open middle and
// never reach a base - every game ran out the clock. Waves now go for the base, so games end. Game length swings a
// lot from seed to seed (and with any map layout change), so check several seeds rather than one tight deadline.
// The Sinai (SN1, traced from the owner's picture, every attack over the land at one of the two gulfs' heads): of
// seeds 1-20, 16 end in 19-58 minutes, 4 hold out past 60; seeds 1-5 end in 35-46. With the bases far west and far
// east (SN2: 250 tiles apart by road, 76 from their crossings) waves sent straight in strung out over the march:
// of seeds 1-10 only 4 ended inside 75 minutes. Marching to a staging point and going in together (SN3, ai.ts
// marchPoint) 8 of them end in 23-59 minutes; seeds 2-5 in 50, 23, 50 and 37, seed 1 holds out. So: 3 of seeds 1-5
// end inside an hour.
// With the navy (NV1, navalai.ts; on here, as in the game: its Shipyard after 14 minutes, within a share of the
// army) seeds 2, 3 and 5 end in 32, 27 and 24 minutes; 1 and 4 hold out.
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
    // (an hour of game time: the bases 250 tiles apart by road, two gulfs and the crossings at their heads between)
    for (let t = 0; t < TPS * 60 * 60 && !w.over; t++) {
      w.step();
      w.drainEvents();
    }
    if (w.over) ended++;
  }
  expect(ended).toBeGreaterThanOrEqual(3);
}, 1_800_000);
