import { describe, expect, it } from 'vitest';
import { AIController, type Difficulty } from '../src/sim/ai';
import { DOCTRINES } from '../src/sim/doctrine';
import { FACTIONS, unitDef } from '../src/sim/defs';
import { TPS, type Command, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

function game(a: Faction, b: Faction, seed: number, diff: Difficulty = 'hard') {
  const w = new World({
    seed,
    players: [
      { name: a, faction: a, color: 0, isAI: true },
      { name: b, faction: b, color: 0, isAI: true },
    ],
  });
  w.controllers.push(new AIController(w, 0, diff), new AIController(w, 1, diff));
  return w;
}

function snap(w: World) {
  return (
    w.tick +
    '#' +
    w.list
      .filter((e) => !e.dead)
      .map((e) => `${e.id}:${e.def}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.hp.toFixed(1)}:${e.stance}:${e.queue.length}`)
      .join('|') +
    '#' +
    w.players.map((p) => Math.round(p.credits)).join(',')
  );
}

describe('doctrine AI', () => {
  it('every nation has a doctrine', () => {
    for (const f of FACTIONS) expect(DOCTRINES[f.id]).toBeTruthy();
  });

  it('all 9 nations play each other without errors', () => {
    const ids = FACTIONS.map((f) => f.id);
    for (let i = 0; i < ids.length; i++) {
      const w = game(ids[i], ids[(i + 3) % ids.length], 40 + i);
      let fired = 0;
      for (let t = 0; t < TPS * 60 * 9 && !w.over; t++) {
        w.step();
        for (const e of w.drainEvents()) if (e.t === 'fire') fired++;
      }
      expect(fired).toBeGreaterThan(20);
      for (const p of w.players) expect(Number.isFinite(p.credits)).toBe(true);
    }
  }, 240000);

  it('AI games stay deterministic (orders, stances, queues and all)', () => {
    for (const [a, b, d] of [
      ['ukraine', 'turkey', 'hard'],
      ['korea', 'iran', 'normal'],
    ] as [Faction, Faction, Difficulty][]) {
      const x = game(a, b, 77, d);
      const y = game(a, b, 77, d);
      for (let t = 0; t < TPS * 60 * 6; t++) {
        x.step();
        y.step();
        x.drainEvents();
        y.drainEvents();
        if (t % (TPS * 60) === 0) expect(snap(x)).toBe(snap(y));
      }
      expect(snap(x)).toBe(snap(y));
    }
  }, 240000);

  it('uses the new orders: scouts on hold fire, queued lane waypoints, raids / pickets', () => {
    const w = game('germany', 'ukraine', 5);
    const seen = new Set<string>();
    const orig = w.issue.bind(w);
    w.issue = (pid: number, c: Command) => {
      seen.add(c.type === 'stance' ? `stance:${c.stance}` : c.type + ('queue' in c && c.queue ? '+queue' : ''));
      orig(pid, c);
    };
    for (let t = 0; t < TPS * 60 * 10 && !w.over; t++) {
      w.step();
      w.drainEvents();
    }
    expect(seen.has('stance:holdFire')).toBe(true); // scouts
    expect(seen.has('move+queue')).toBe(true); // scout routes / lanes
  }, 120000);

  it('doctrine shapes the army: Turkey flies, Russia brings thermobaric artillery', () => {
    // what each AI orders from its factories over the first 10 minutes
    const orders = (a: Faction, b: Faction, seed: number, pred: (id: string) => boolean) => {
      const w = game(a, b, seed);
      let n = 0;
      const orig = w.issue.bind(w);
      w.issue = (pid: number, c: Command) => {
        if (pid === 0 && c.type === 'produce' && pred(c.def)) n++;
        orig(pid, c);
      };
      for (let t = 0; t < TPS * 60 * 10 && !w.over; t++) {
        w.step();
        w.drainEvents();
      }
      return n;
    };
    const air = (id: string) => unitDef(id)?.kind === 'unit' && !!unitDef(id).air;
    const tk = orders('turkey', 'korea', 21, air);
    const de = orders('germany', 'korea', 21, air);
    expect(tk).toBeGreaterThan(de);
    const ru = orders('russia', 'korea', 22, (id) => id === 'russia_tos');
    expect(ru).toBeGreaterThan(0);
  }, 180000);
});
