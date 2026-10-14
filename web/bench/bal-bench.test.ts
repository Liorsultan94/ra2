// Start-position balance bench (BAL1): AI vs AI Hard, swapped slots, grace on / off.
// env: MAPS, GRACE (on|off|both), SEEDS (for swapped pairs), MSEEDS (for mirror matches), CAP (min), OUT
import { it } from 'vitest';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
import { AIController } from '../src/sim/ai';
import { peaceTicks } from '../src/sim/peace';
import { appendFileSync } from 'fs';
import { DEFS } from '../src/sim/defs';

const MAPS = (process.env.MAPS ?? 'frontline,desert,winter,urban').split(',');
const SEEDS = (process.env.SEEDS ?? '1,2').split(',').map(Number);
const MSEEDS = (process.env.MSEEDS ?? '1,2,3,4').split(',').map(Number);
const GRACE = process.env.GRACE ?? 'both';
const PAIRS = (process.env.PAIRS ?? 'israel-iran,usa-russia,china-ukraine').split(',').map((p) => p.split('-') as [Faction, Faction]);
const MIRRORS = (process.env.MIRRORS ?? 'usa,russia').split(',').filter(Boolean) as Faction[];
const CAP = Number(process.env.CAP ?? 30) * 60 * TPS;
const OUT = process.env.OUT ?? '/tmp/bal-bench.txt';

it('bal bench', () => {
  const games: { map: string; seed: number; a: Faction; b: Faction; grace: boolean; swapped: boolean }[] = [];
  const graces = GRACE === 'both' ? [true, false] : [GRACE === 'on'];
  for (const map of MAPS) for (const grace of graces) {
    for (const [x, y] of PAIRS) for (const seed of SEEDS) {
      games.push({ map, seed, a: x, b: y, grace, swapped: false });
      games.push({ map, seed, a: y, b: x, grace, swapped: true });
    }
    for (const f of MIRRORS) for (const seed of MSEEDS) {
      games.push({ map, seed, a: f, b: f, grace, swapped: false });
      if (process.env.FULL) games.push({ map, seed, a: f, b: f, grace, swapped: true });
    }
  }
  for (const g of games) {
    const w = new World({ seed: g.seed, map: g.map as never, players: [
      { name: g.a, faction: g.a, color: 0, isAI: true },
      { name: g.b, faction: g.b, color: 0, isAI: true },
    ] });
    const pt = process.env.ECON ? CAP + 1 : g.grace ? peaceTicks('hard', 'auto') : 0;
    const ais = [new AIController(w, 0, 'hard', { peaceTicks: pt }), new AIController(w, 1, 'hard', { peaceTicks: pt })];
    // FULL=1: each nation keeps the AI personality (seeded plan, build order, rng stream) it has in the
    // un-swapped game, so only the start position changes between the two orientations
    if (process.env.FULL && g.swapped) {
      const wa = new World({ seed: g.seed, map: g.map as never, players: [
        { name: g.b, faction: g.b, color: 0, isAI: true },
        { name: g.a, faction: g.a, color: 0, isAI: true },
      ] });
      for (let k = 0; k < 2; k++) {
        const donor: any = new AIController(wa, 1 - k, 'hard', { peaceTicks: pt });
        const c: any = ais[k];
        for (const f of ['rng', 'plan', 'planCfg', 'buildOrder', 'waveSize', 'raidPace', 'raidAt', 'scoutAt', 'waveStale', 'waveJitter']) c[f] = donor[f];
        c.planLog.length = 0;
        c.planLog.push(...donor.planLog);
      }
    }
    w.controllers.push(...(ais as never[]));
    const t0 = performance.now();
    const firstHit = [-1, -1];
    const lost: number[] = [0, 0];
    const snap: string[] = [];
    while (!w.over && w.tick < CAP) {
      w.step();
      if (w.tick % (TPS * 240) === 0) snap.push(`${w.tick / TPS / 60}m:h${w.players[0].stats.harvested}/${w.players[1].stats.harvested}`);
    }
    // value on the field at the end (tie-break for capped games)
    const val = [0, 0];
    for (const e of w.list as any[]) if (!e.dead && (e.owner === 0 || e.owner === 1)) val[e.owner] += DEFS[e.def]?.cost ?? 0;
    const winSlot = w.over ? w.players.findIndex((p) => !p.defeated) : -1;
    const lead = winSlot >= 0 ? winSlot : val[0] > val[1] * 1.15 ? 0 : val[1] > val[0] * 1.15 ? 1 : -1;
    const plans = ais.map((c: any) => `${c.planLog.join('>')}/w${c.stats.waves}/fw${c.stats.firstWave > 0 ? Math.round(c.stats.firstWave / TPS) : '-'}/l[${c.stats.lanes.slice(0, 6).join(' ')}]`);
    const row = [g.map, g.swapped && process.env.FULL ? 'B' : 'A', g.grace ? 'graceON' : 'graceOFF', `seed=${g.seed}`, `${g.a}-${g.b}`, w.over ? 'END' : 'CAP', (w.tick / TPS / 60).toFixed(1) + 'min',
      `win=${winSlot >= 0 ? 'slot' + winSlot + ':' + w.players[winSlot].faction : 'none'}`, `lead=${lead}`, `val=${val[0]}/${val[1]}`, `${snap.join(',')}`, `wall=${((performance.now() - t0) / 1000).toFixed(0)}s`, plans.join(' | ')].join(' ');
    void firstHit; void lost;
    appendFileSync(OUT, row + '\n');
    console.log(row);
  }
}, 20_000_000);
