// SN1 design aid: one hard AI-vs-AI desert game with a progress log (where the armies are, buildings, waves).
// BENCH=1 SEED=1 MIN=45 npx vitest run bench/sinai-game.test.ts
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';

it('sinai game', () => {
  const seed = Number(process.env.SEED ?? 1);
  const [fa, fb] = (process.env.FACS ?? 'usa,russia').split(',') as any[];
  const [da, db] = (process.env.DIFFS ?? 'hard,hard').split(',') as any[];
  const w = new World({ seed, map: (process.env.MAP ?? 'desert') as any, players: [{ name: fa, faction: fa, color: 0, isAI: true }, { name: fb, faction: fb, color: 0, isAI: true }] });
  const ais = [new AIController(w, 0, da), new AIController(w, 1, db)];
  w.controllers.push(...ais);
  const MIN = Number(process.env.MIN ?? 45);
  const E = (x: number, y: number) => (x - y) / Math.SQRT2;
  const S = (x: number, y: number) => (x + y) / Math.SQRT2;
  for (let t = 0; t < TPS * 60 * MIN && !w.over; t++) {
    w.step();
    w.drainEvents();
    if (process.env.WATCH && t % (TPS * 30) === 0 && t > TPS * 240 && t < TPS * 780) {
      const pid = Number(process.env.WATCH);
      const s = w.players[pid];
      const bl = w.list.filter((e) => !e.dead && e.owner === pid && e.kind === 'building').map((e) => e.def.replace(/^[a-z]+_/, ''));
      const foes = w.list.filter((e) => !e.dead && e.owner === 1 - pid && e.kind === 'unit' && Math.hypot(e.x - s.startX, e.y - s.startY) < 22).map((e) => e.def.replace(/^[a-z]+_/, ''));
      const own = w.list.filter((e) => !e.dead && e.owner === pid && e.kind === 'unit').map((e) => `${e.def.replace(/^[a-z]+_/, '')}:${(ais[pid] as any).roleOf?.(e) ?? ''}`);
      console.log(`  ${(t / TPS / 60).toFixed(1)}m P${pid} blds[${bl.join(' ')}] foesNear[${foes.join(' ')}] own[${own.join(' ')}]`);
    }
    if (t % (TPS * 150) === 0) {
      const row: string[] = [`${(t / TPS / 60).toFixed(1)}m`];
      for (const p of w.players) {
        const units = w.list.filter((e) => !e.dead && e.owner === p.id && e.kind === 'unit');
        const blds = w.list.filter((e) => !e.dead && e.owner === p.id && e.kind === 'building');
        const ground = units.filter((u) => u.z < 0.5);
        const me = ground.reduce((a, u) => a + E(u.x, u.y), 0) / Math.max(1, ground.length);
        const ms = ground.reduce((a, u) => a + S(u.x, u.y), 0) / Math.max(1, ground.length);
        const ai = ais[p.id] as any;
        row.push(`P${p.id}: ${blds.length}b ${units.length}u mean(E${me.toFixed(0)},S${ms.toFixed(0)}) waves ${ai.stats.waves} lanes[${ai.stats.lanes.slice(-4).join(' ')}] h${p.stats.harvested} $${Math.round(p.credits)}`);
      }
      console.log(row.join(' | '));
    }
  }
  console.log(`end tick ${w.tick} (${(w.tick / TPS / 60).toFixed(1)} min) over ${w.over} winner ${w.players.findIndex((p) => !p.defeated)}`);
});
