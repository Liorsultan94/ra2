import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { peaceTicks } from '../src/sim/peace';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * AI2 combined landings (Wadi Al-Rimal, Hard): a landing timed with a land wave. The loaded landing craft waits at
 * its beach while a wave marches to its staging point short of the enemy; then the craft or the wave is held back so
 * the party comes ashore on the enemy's side as the wave reaches its objective from the front. A long game (as in
 * ai-navy: the Shipyard comes late), grace on.
 */
describe('AI combined sea and land assault', () => {
  it('a Hard AI on the desert map lands a party as a land wave goes in', () => {
    const SEED = 4;
    const PAIR: [Faction, Faction] = ['israel', 'iran'];
    const w = new World({ seed: SEED, map: 'desert', players: PAIR.map((f) => ({ name: f, faction: f, color: 0, isAI: true })) });
    const pt = peaceTicks('hard', 'auto');
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
    w.controllers.push(...ais);
    while (!w.over && w.tick < TPS * 60 * 45 && !ais.some((a) => a.arrivals.some((e) => e.kind === 'combined' && e.at.every((t) => t >= 0)))) w.step();
    const combos = ais.flatMap((a) => a.arrivals.filter((e) => e.kind === 'combined'));
    const done = combos.filter((e) => e.at.every((t) => t >= 0));
    const msg = JSON.stringify({ min: +(w.tick / TPS / 60).toFixed(1), stats: ais.map((a) => [a.stats.combined, a.navy?.stats.landings]), combos });
    expect(ais.reduce((n, a) => n + a.stats.combined, 0), msg).toBeGreaterThanOrEqual(1);
    expect(done.length, msg).toBeGreaterThanOrEqual(1);
    // the party ashore within 15 s of the land wave reaching its objective (half of it within 16 tiles)
    const gap = Math.min(...done.map((e) => Math.abs(e.at[1] - e.at[0]) / TPS));
    console.log('combined landing: party ashore', gap.toFixed(1), 's from the land wave', msg);
    expect(gap, msg).toBeLessThanOrEqual(15);
  }, 1_800_000);
});
