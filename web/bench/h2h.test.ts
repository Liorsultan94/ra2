// AI2 head-to-head bench: the new AI (src/sim/ai.ts + superweapons.ts) against the AI before AI2 (bench/old/, a
// frozen copy of master 14341b4), Hard vs Hard, grace on (as in real games). Each nation pairing is played twice per
// seed with the new AI in either slot and either nation, so slot and nation effects cancel out.
// env: MAPS, N (games per map), CAP (min), OUT, PAIRS
import { it } from 'vitest';
import { appendFileSync } from 'fs';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
import { AI2, AIController } from '../src/sim/ai';
import { SuperweaponAI } from '../src/sim/superweapons';
import { peaceTicks } from '../src/sim/peace';
import { DEFS } from '../src/sim/defs';
import { DOCTRINES } from '../src/sim/doctrine';
import { AIController as OldAI } from './old/ai';
import { SuperweaponAI as OldSW } from './old/superweapons';

const MAPS = (process.env.MAPS ?? 'frontline,desert,winter,urban').split(',');
const N = Number(process.env.N ?? 20);
const CAP = Number(process.env.CAP ?? 30) * 60 * TPS;
const OUT = process.env.OUT ?? '/tmp/h2h.txt';
const PAIRS = (process.env.PAIRS ?? 'israel-iran,usa-russia,china-ukraine').split(',').map((p) => p.split('-') as [Faction, Faction]);

// OFF=retreat,terrain,war: play the new AI without those AI2 parts (ablation)
for (const k of (process.env.OFF ?? '').split(',').filter(Boolean)) (AI2 as Record<string, boolean>)[k] = false;

// EXPAND=1: every nation's war doctrine expands (experiment)
if (process.env.EXPAND) for (const d of Object.values(DOCTRINES)) d.war = { ...d.war, expand: 1 };

it('h2h bench', () => {
  for (const map of MAPS) {
    for (let i = 0; i < N; i++) {
      // games 4k..4k+3: one pairing and seed, the new AI as either nation in either slot
      const pair = PAIRS[Math.floor(i / 4) % PAIRS.length];
      const seed = 1 + Math.floor(i / 4);
      const swap = i % 2 === 1;
      const newSlot = (i >> 1) % 2;
      const [a, b] = swap ? [pair[1], pair[0]] : pair;
      const w = new World({ seed, map: map as never, players: [
        { name: a, faction: a, color: 0, isAI: true },
        { name: b, faction: b, color: 0, isAI: true },
      ] });
      const pt = peaceTicks('hard', 'auto');
      for (let pid = 0; pid < 2; pid++) {
        if (pid === newSlot) {
          const ai = new AIController(w, pid, 'hard', { peaceTicks: pt });
          w.controllers.push(ai, process.env.OLDSW ? (new OldSW(w, pid, { peaceTicks: pt }) as never) : new SuperweaponAI(w, pid, { peaceTicks: pt, ai }));
        } else w.controllers.push(new OldAI(w, pid, 'hard', { peaceTicks: pt }) as never, new OldSW(w, pid, { peaceTicks: pt }) as never);
      }
      const t0 = performance.now();
      while (!w.over && w.tick < CAP) w.step();
      const winSlot = w.over ? w.players.findIndex((p) => !p.defeated) : -1;
      const res = winSlot < 0 ? 'none' : winSlot === newSlot ? 'NEW' : 'OLD';
      // value on the field at the end (who is ahead in a capped game)
      const val = [0, 0];
      for (const e of w.list) if (!e.dead && (e.owner === 0 || e.owner === 1)) val[e.owner] += DEFS[e.def]?.cost ?? 0;
      const lead = winSlot >= 0 ? res : val[newSlot] > val[1 - newSlot] * 1.15 ? 'NEW' : val[1 - newSlot] > val[newSlot] * 1.15 ? 'OLD' : 'even';
      const row = [map, `seed=${seed}`, `${a}-${b}`, `new=slot${newSlot}:${w.players[newSlot].faction}`, w.over ? 'END' : 'CAP', (w.tick / TPS / 60).toFixed(1) + 'min', `win=${res}`, `lead=${lead}`, `val=${val[newSlot]}/${val[1 - newSlot]}`, `wall=${((performance.now() - t0) / 1000).toFixed(0)}s`].join(' ');
      appendFileSync(OUT, row + '\n');
      console.log(row);
    }
  }
}, 40_000_000);
