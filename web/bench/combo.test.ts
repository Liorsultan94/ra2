// Pincer / combined-landing bench (AI2 pincers, combined landings): win rates before / after.
// CMODE=hn: Hard vs Normal, CMODE=ne: Normal vs Easy (OFF=1: both play without pincers and combined landings, i.e. as
// before them; the code with them off plays exactly as before). CMODE=hh: Hard with them against Hard without, in the
// same game (the switches are flipped round each controller's turn). Each pairing is played with the sides in either
// slot and either nation. env: MAPS, N (games per map), CAP (min), OUT, PAIRS
import { it } from 'vitest';
import { appendFileSync } from 'fs';
import { TPS, type Faction } from '../src/sim/types';
import { World, type Controller } from '../src/sim/world';
import { AI2, AIController, type Difficulty } from '../src/sim/ai';
import { peaceTicks } from '../src/sim/peace';
import { DEFS } from '../src/sim/defs';

const MODE = process.env.CMODE ?? 'hn';
const MAPS = (process.env.MAPS ?? 'frontline,desert').split(',');
const N = Number(process.env.N ?? 12);
const CAP = Number(process.env.CAP ?? 35) * 60 * TPS;
const OUT = process.env.OUT ?? '/tmp/combo.txt';
const PAIRS = (process.env.PAIRS ?? 'israel-iran,usa-russia,china-ukraine').split(',').map((p) => p.split('-') as [Faction, Faction]);
const OFF = !!process.env.OFF;

/** Run a controller with pincers / combined landings on or off for its turn only. */
const flip = (c: AIController, on: boolean): Controller => ({
  update() {
    const was = [AI2.pincer, AI2.combined];
    AI2.pincer = AI2.combined = on;
    try {
      c.update();
    } finally {
      [AI2.pincer, AI2.combined] = was;
    }
  },
});

it('combo bench', () => {
  const [strong, weak]: Difficulty[] = MODE === 'ne' ? ['normal', 'easy'] : MODE === 'hn' ? ['hard', 'normal'] : ['hard', 'hard'];
  for (const map of MAPS) {
    for (let i = 0; i < N; i++) {
      const pair = PAIRS[Math.floor(i / 4) % PAIRS.length];
      const seed = 1 + Math.floor(i / 4);
      const swap = i % 2 === 1;
      const sSlot = (i >> 1) % 2;
      const [a, b] = swap ? [pair[1], pair[0]] : pair;
      const w = new World({ seed, map: map as never, players: [
        { name: a, faction: a, color: 0, isAI: true },
        { name: b, faction: b, color: 0, isAI: true },
      ] });
      const pt = peaceTicks(weak, 'auto');
      const ais: AIController[] = [];
      for (let pid = 0; pid < 2; pid++) {
        const ai = new AIController(w, pid, pid === sSlot ? strong : weak, { peaceTicks: pt });
        ais.push(ai);
        // (hh: the "strong" side has them, the other not; hn / ne: both as OFF says)
        w.controllers.push(flip(ai, MODE === 'hh' ? pid === sSlot : !OFF));
      }
      const t0 = performance.now();
      while (!w.over && w.tick < CAP) w.step();
      const winSlot = w.over ? w.players.findIndex((p) => !p.defeated) : -1;
      const res = winSlot < 0 ? 'none' : winSlot === sSlot ? 'S' : 'W';
      const val = [0, 0];
      for (const e of w.list) if (!e.dead && (e.owner === 0 || e.owner === 1)) val[e.owner] += DEFS[e.def]?.cost ?? 0;
      const lead = winSlot >= 0 ? res : val[sSlot] > val[1 - sSlot] * 1.15 ? 'S' : val[1 - sSlot] > val[sSlot] * 1.15 ? 'W' : 'even';
      const st = ais.map((x) => `p${x.stats.pincers}c${x.stats.combined}l${x.navy?.stats.landings ?? 0}`).join('/');
      const row = [MODE + (OFF ? '-off' : '-on'), map, `seed=${seed}`, `${a}-${b}`, `strong=slot${sSlot}`, w.over ? 'END' : 'CAP', (w.tick / TPS / 60).toFixed(1) + 'min', `win=${res}`, `lead=${lead}`, `val=${val[sSlot]}/${val[1 - sSlot]}`, st, `wall=${((performance.now() - t0) / 1000).toFixed(0)}s`].join(' ');
      appendFileSync(OUT, row + '\n');
      console.log(row);
    }
  }
}, 40_000_000);
