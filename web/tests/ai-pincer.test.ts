import { describe, expect, it } from 'vitest';
import { AI2, AIController, type Arrival } from '../src/sim/ai';
import { DEFS } from '../src/sim/defs';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

/**
 * AI2 pincers: a Hard AI with a mixed army at its rally point attacks a passive enemy base on the river map. Made to
 * split (its doctrine's flank appetite turned right up), it now sends two halves by two bridges, each to a staging
 * point on its own approach, and lets them go so they reach the enemy base together; with pincers off the same
 * doctrine sends its old untimed flank wing (the fastest units, by the flank bridge, straight in). The arrival spread
 * (seconds between the two groups having half their number within 16 tiles of the objective, as the AI logs it:
 * AIController.arrivals) is measured both ways, from either start.
 */
function attack(slot: number, me: Faction, pincers: boolean): Arrival | null {
  const players = [{ name: me, faction: me, color: 0, isAI: true }, { name: 'russia', faction: 'russia' as Faction, color: 0, isAI: true }];
  const w = new World({ seed: 1, map: 'frontline', players: slot ? players.reverse() : players });
  // the enemy: a construction yard at its start, no controller (it just stands)
  const st = w.map.starts[1 - slot];
  w.spawnBuilding('russia_conyard', 1 - slot, Math.round(st.x) - 1, Math.round(st.y) - 1, true);
  const ai = new AIController(w, slot, 'hard') as AnyAI;
  ai.doctrine = { ...ai.doctrine, flank: 5 };
  ai.war = { ...ai.war, flank: 1, front: 1, prep: 0 };
  w.controllers.push(ai);
  for (let t = 0; t < TPS * 5; t++) w.step();
  const [rx, ry] = ai.rally();
  const army = [`${me}_mbt`, `${me}_mbt`, `${me}_mbt`, `${me}_mbt`, `${me}_apc`, `${me}_apc`, `${me}_apc`, `${me}_rifle`, `${me}_rifle`, `${me}_rifle`, `${me}_at`, `${me}_at`].filter((d) => DEFS[d]);
  army.forEach((d, k) => w.spawnUnit(d, slot, rx + (k % 4) - 1.5, ry + Math.floor(k / 4) - 1));
  const was = AI2.pincer;
  AI2.pincer = pincers;
  try {
    for (let t = 0; t < TPS * 60 * 5 && !ai.arrivals.length; t++) w.step();
  } finally {
    AI2.pincer = was;
  }
  return ai.arrivals[0] ?? null;
}

const spread = (a: Arrival | null) => (a && a.at.every((t) => t >= 0) ? Math.abs(a.at[0] - a.at[1]) / TPS : Infinity);

describe('AI pincers', () => {
  it('two halves by two lanes reach the objective together (old flank wing: not)', () => {
    const rows: string[] = [];
    const pin: number[] = [];
    const old: number[] = [];
    for (const slot of [0, 1]) for (const me of ['usa', 'israel', 'china'] as Faction[]) {
      const p = attack(slot, me, true);
      const o = attack(slot, me, false);
      rows.push(`slot ${slot} ${me}: pincer ${p?.kind} ${spread(p).toFixed(1)}s ${p?.at.map((t) => (t - p.born) / TPS)}, old ${o?.kind} ${spread(o).toFixed(1)}s ${o?.at.map((t) => (t - o.born) / TPS)}`);
      expect(p?.kind, rows.join('\n')).toBe('pincer');
      pin.push(spread(p));
      old.push(spread(o));
    }
    console.log(rows.join('\n'));
    const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    // every pincer arrives within a few seconds; the old wing's median spread is several times that
    expect(Math.max(...pin), rows.join('\n')).toBeLessThanOrEqual(8);
    expect(med(old), rows.join('\n')).toBeGreaterThan(med(pin) * 2);
  }, 600_000);
});
