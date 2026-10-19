// SN1 design aid: where the hard AI's units die (screen E/S in the slot-0 frame) and what was near them.
// BENCH=1 SEED=1 HARD=0 MIN=14 npx vitest run bench/sinai-deaths.test.ts --silent=false
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

it('sinai deaths', () => {
  const seed = Number(process.env.SEED ?? 1);
  const hard = Number(process.env.HARD ?? 0);
  const [fa, fb] = (process.env.FACS ?? 'usa,usa').split(',') as any[];
  const w = new World({ seed, map: 'desert', players: [{ name: 'a', faction: fa, color: 0, isAI: true }, { name: 'b', faction: fb, color: 0, isAI: true }] });
  const diff = (k: number) => (hard === k || process.env.BOTH ? 'hard' : 'easy');
  const ais = [new AIController(w, 0, diff(0)), new AIController(w, 1, diff(1))];
  // SWAP=1: each AI keeps the personality (plan, build order, rng) it has in the game with the slots swapped
  if (process.env.SWAP) {
    const wa = new World({ seed, map: 'desert', players: [{ name: 'b', faction: 'usa', color: 0, isAI: true }, { name: 'a', faction: 'usa', color: 0, isAI: true }] });
    for (let k = 0; k < 2; k++) {
      const donor: any = new AIController(wa, 1 - k, diff(k));
      const c: any = ais[k];
      for (const f of ['rng', 'plan', 'planCfg', 'buildOrder', 'waveSize', 'raidPace', 'raidAt', 'scoutAt', 'waveStale', 'waveJitter']) c[f] = donor[f];
      c.planLog.length = 0;
      c.planLog.push(...donor.planLog);
    }
  }
  w.controllers.push(...ais);
  const MIN = Number(process.env.MIN ?? 14);
  // slot-0 frame: slot 1 positions transposed, so both runs compare directly
  const fr = (x: number, y: number) => (hard === 0 ? [x, y] : [y, x]);
  const E = (x: number, y: number) => { const [a, b] = fr(x, y); return (a - b) / Math.SQRT2; };
  const S = (x: number, y: number) => { const [a, b] = fr(x, y); return (a + b) / Math.SQRT2; };
  const last = new Map<number, { x: number; y: number; def: string }>();
  const bins = new Map<string, number>();
  const killers = new Map<string, number>();
  for (let t = 0; t < TPS * 60 * MIN && !w.over; t++) {
    w.step();
    w.drainEvents();
    if (t % (TPS * 150) === 0) {
      const a: any = ais[hard];
      const st = a.stats;
      const units = w.list.filter((e) => !e.dead && e.owner === hard && e.kind === 'unit');
      const foe = w.list.filter((e) => !e.dead && e.owner === 1 - hard && e.kind === 'unit').length;
      const me = units.reduce((s, u) => s + E(u.x, u.y), 0) / Math.max(1, units.length);
      console.log(`${(t / TPS / 60).toFixed(1)}m hard ${units.length}u (E${me.toFixed(0)}) h${w.players[hard].stats.harvested} $${Math.round(w.players[hard].credits)} waves ${st.waves} feints ${st.feints} opp ${st.opportunist} retreats ${st.retreats} regroups ${st.regroups} ambush ${st.ambushes} | easy ${foe}u h${w.players[1 - hard].stats.harvested}`);
    }
    if (t % (TPS * 2)) continue;
    const alive = new Set<number>();
    for (const e of w.list) {
      if (e.dead || e.owner !== hard || e.kind !== 'unit' || e.def.includes('harvester')) continue;
      alive.add(e.id);
      last.set(e.id, { x: e.x, y: e.y, def: e.def });
    }
    for (const [id, p] of last) {
      if (alive.has(id)) continue;
      last.delete(id);
      const k = `E${Math.round(E(p.x, p.y) / 10) * 10},S${Math.round(S(p.x, p.y) / 10) * 10}`;
      bins.set(k, (bins.get(k) ?? 0) + 1);
      for (const e of w.list) {
        if (e.dead || e.owner !== 1 - hard || Math.hypot(e.x - p.x, e.y - p.y) > 9) continue;
        const inside = e.kind === 'building' && e.passengers.length ? '(garrisoned)' : '';
        const d = e.def.replace(/^[a-z]+_/, '') + inside;
        killers.set(d, (killers.get(d) ?? 0) + 1);
      }
    }
  }
  console.log(`hard in slot ${hard}: over ${w.over} at ${(w.tick / TPS / 60).toFixed(1)} min`);
  console.log('deaths by place (slot-0 frame): ' + [...bins].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '));
  console.log('enemies near deaths: ' + [...killers].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k}:${n}`).join(' '));
});
