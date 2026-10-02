import { describe, expect, it } from 'vitest';
import { AIController, type Difficulty } from '../src/sim/ai';
import { FACTIONS } from '../src/sim/defs';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * AI-vs-AI balance sweep (slow): BALANCE=1 npx vitest run tests/balance.test.ts
 * BALANCE_GAMES=n limits the number of pairings; BALANCE_MIN = game length cap in minutes.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const ON = !!env.BALANCE;

export function playAI(a: Faction, b: Faction, seed: number, minutes = 20, diff: Difficulty = 'hard') {
  const w = new World({
    seed,
    players: [
      { name: a, faction: a, color: 0, isAI: true },
      { name: b, faction: b, color: 0, isAI: true },
    ],
  });
  w.controllers.push(new AIController(w, 0, diff), new AIController(w, 1, diff));
  for (let t = 0; t < TPS * 60 * minutes && !w.over; t++) {
    w.step();
    w.drainEvents();
  }
  // timeout: judge by surviving value (buildings + units) as a tiebreak
  let winner = w.over ? w.winner : -1;
  const score = [0, 0];
  for (const e of w.list) if (!e.dead && e.owner >= 0) score[e.owner] += e.kind === 'building' ? 2 : 1;
  if (winner < 0) winner = score[0] > score[1] * 1.25 ? 0 : score[1] > score[0] * 1.25 ? 1 : -1;
  return { winner, over: w.over, minutes: w.tick / TPS / 60, score, kills: w.players.map((p) => p.stats.killed) };
}

describe.skipIf(!ON)('balance', () => {
  it('round robin', () => {
    const ids = FACTIONS.map((f) => f.id);
    const minutes = Number(env.BALANCE_MIN ?? 20);
    const limit = Number(env.BALANCE_GAMES ?? 999);
    const wins: Record<string, number> = {};
    const games: Record<string, number> = {};
    let n = 0;
    const t0 = Date.now();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        if (n >= limit) continue;
        for (const [a, b] of [[ids[i], ids[j]], [ids[j], ids[i]]] as [Faction, Faction][]) {
          const r = playAI(a, b, 100 + n, minutes);
          n++;
          games[a] = (games[a] ?? 0) + 1;
          games[b] = (games[b] ?? 0) + 1;
          const wn = r.winner === 0 ? a : r.winner === 1 ? b : 'draw';
          if (wn !== 'draw') wins[wn] = (wins[wn] ?? 0) + 1;
          console.log(`${a} vs ${b}: ${wn}${r.over ? '' : ' (timeout)'} @${r.minutes.toFixed(1)}min score ${r.score.join('/')} kills ${r.kills.join('/')}`);
        }
      }
    console.log('wins/games', ids.map((f) => `${f} ${wins[f] ?? 0}/${games[f] ?? 0}`).join('  '), `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    expect(n).toBeGreaterThan(0);
  }, 3_600_000);
});
