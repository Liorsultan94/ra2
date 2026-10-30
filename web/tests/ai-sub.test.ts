import { describe, expect, it } from 'vitest';
import { AI2, AIController } from '../src/sim/ai';
import { unitDef } from '../src/sim/defs';
import { peaceTicks } from '../src/sim/peace';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV4: on the desert map a Hard AI buys a few submarines once the war is on (never in the peace grace), keeps them
 * submerged at its anchorage and sends them out with its raids; they come up to fight. Iran and Ukraine have none.
 */

// (the game these were tuned on: without combined landings, ai.ts, which change how it goes from the first landing on)
function play(fs: [Faction, Faction], minutes: number, seed = 2) {
  const was = AI2.combined;
  AI2.combined = false;
  try {
    return game(fs, minutes, seed);
  } finally {
    AI2.combined = was;
  }
}

function game(fs: [Faction, Faction], minutes: number, seed: number) {
  const w = new World({ seed, map: 'desert', players: fs.map((f, i) => ({ name: `P${i}`, faction: f, color: 0, isAI: true })) });
  const pt = peaceTicks('hard', 'auto');
  const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
  w.controllers.push(...ais);
  const seen = new Set<number>();
  let first = -1;
  let surfaced = 0;
  let hiddenSamples = 0;
  let fired = 0;
  while (!w.over && w.tick < TPS * 60 * minutes) {
    w.step();
    for (const ev of w.drainEvents()) if (ev.t === 'fire') {
        const u = w.get(ev.id);
        if (u && u.kind === 'unit' && unitDef(u.def).submerge === 'sub') fired++;
      }
    if (w.tick % 20 !== 0) continue;
    for (const e of w.list) {
      if (e.dead || e.kind !== 'unit' || unitDef(e.def).submerge !== 'sub') continue;
      if (!seen.has(e.id)) {
        seen.add(e.id);
        if (first < 0) first = w.tick;
      }
      if ((e.subPhase ?? 0) > 0) surfaced++;
      else hiddenSamples++;
    }
  }
  return { w, ais, pt, built: seen.size, first, surfaced, hiddenSamples, fired };
}

describe('AI submarines', () => {
  it('Hard buys submarines after the grace, keeps them down when idle and uses them', () => {
    // (seed 4: with the AI's reactions, aireact.ts, seed 2's game is over before the submarines sail)
    const r = play(['korea', 'turkey'], 36, 4);
    const st = r.ais.map((a) => a.navy?.stats);
    const msg = JSON.stringify({ st, built: r.built, first: +(r.first / TPS / 60).toFixed(1), surfaced: r.surfaced, hidden: r.hiddenSamples, fired: r.fired });
    expect(r.built, msg).toBeGreaterThanOrEqual(1);
    expect(r.first, msg).toBeGreaterThan(r.pt);
    expect(r.hiddenSamples, msg).toBeGreaterThan(0); // submerged at its anchorage
    expect(r.surfaced + r.fired, msg).toBeGreaterThan(0); // and used
  }, 1_800_000);

  it('Iran and Ukraine have none, and nothing breaks', () => {
    const r = play(['iran', 'ukraine'], 22);
    expect(r.built).toBe(0);
    expect(r.ais.every((a) => (a.navy?.stats.subs ?? 0) === 0)).toBe(true);
  }, 1_800_000);
});
