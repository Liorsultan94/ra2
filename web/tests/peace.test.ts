import { describe, expect, it } from 'vitest';
import { AIController, type Difficulty } from '../src/sim/ai';
import { PEACE_DEFAULT_MIN, formatPeace, peaceSecondsLeft, peaceTicks, type PeaceOption } from '../src/sim/peace';
import { SuperweaponAI } from '../src/sim/superweapons';
import { TPS, type Command, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
import { unitDef } from '../src/sim/defs';
import { GAME_SPEEDS, TickPacer, speedFactor } from '../src/game/pace';

/** Player 0 stands in for a human who builds up and defends but never attacks; player 1 is the enemy AI. */
function skirmish(diff: Difficulty, peace: number, seed = 21, a: Faction = 'usa', b: Faction = 'russia') {
  const w = new World({
    seed,
    players: [
      { name: 'You', faction: a, color: 0, isAI: false },
      { name: 'AI', faction: b, color: 0, isAI: true },
    ],
  });
  w.controllers.push(new AIController(w, 0, 'normal', { peaceTicks: Infinity }), new AIController(w, 1, diff, { peaceTicks: peace }), new SuperweaponAI(w, 1, { peaceTicks: peace }));
  return w;
}

const BASE_R = 25;

interface Log {
  /** First tick an enemy fighter (not a hold-fire scout) is inside the player's base region. */
  arrival: number;
  /** First tick a player structure is hurt by the enemy. */
  firstHit: number;
  /** Offensive orders issued before the grace ended (should be none). */
  violations: string[];
  /** Tick of the first offensive order (attack, attack-move away from its own base, airdrop, superweapon). */
  firstWave: number;
}

function play(w: World, peace: number, ticks: number, stopAtArrival = false): Log {
  const me = w.players[0];
  const ai = w.players[1];
  const log: Log = { arrival: -1, firstHit: -1, violations: [], firstWave: -1 };
  const near = (x: number, y: number) => Math.hypot(x - ai.startX, y - ai.startY) <= 32 || w.list.some((e) => !e.dead && e.owner === 1 && e.kind === 'building' && Math.hypot(e.x - x, e.y - y) <= 13);
  /** An offensive order (anything but local defence), described; null for the rest. */
  const offensive = (c: Command): string | null => {
    if (c.type === 'airdrop' || c.type === 'superweapon') return c.type;
    if (c.type === 'attack') {
      const e = w.get(c.target);
      return e && e.owner === 0 && !near(e.x, e.y) ? `attack ${e.def} @${e.x.toFixed(0)},${e.y.toFixed(0)}` : null;
    }
    return c.type === 'move' && c.attackMove && !near(c.x, c.y) ? `attackMove @${c.x.toFixed(0)},${c.y.toFixed(0)}` : null;
  };
  const orig = w.issue.bind(w);
  w.issue = (pid: number, c: Command) => {
    const o = pid === 1 ? offensive(c) : null;
    if (o && w.tick < peace) log.violations.push(`${w.tick}:${o}`);
    else if (o && log.firstWave < 0) log.firstWave = w.tick;
    orig(pid, c);
  };
  for (let i = 0; i < ticks && !w.over; i++) {
    w.step();
    w.drainEvents();
    if (log.firstHit < 0 && w.tick % 10 === 0) {
      for (const e of w.list) if (!e.dead && e.owner === 0 && e.kind === 'building' && w.tick - e.lastHurt < 10) log.firstHit = w.tick;
    }
    if (log.arrival < 0 && w.tick % 10 === 0) {
      for (const e of w.list) {
        if (e.dead || e.owner !== 1 || e.kind !== 'unit' || e.stance === 'holdFire' || e.inside >= 0 || unitDef(e.def).temp || unitDef(e.def).airlift) continue;
        if (Math.hypot(e.x - me.startX, e.y - me.startY) <= BASE_R) {
          log.arrival = w.tick;
          break;
        }
      }
      if (log.arrival >= 0 && stopAtArrival) break;
    }
  }
  return log;
}

const mmss = (t: number) => (t < 0 ? 'never' : formatPeace(t / TPS));

describe('peace time (early-game grace)', () => {
  it('lengths by difficulty and option', () => {
    expect(PEACE_DEFAULT_MIN).toEqual({ easy: 10, normal: 6, hard: 3 });
    expect(peaceTicks('easy')).toBe(10 * 60 * TPS);
    expect(peaceTicks('normal', 'auto')).toBe(6 * 60 * TPS);
    expect(peaceTicks('hard', 'auto')).toBe(3 * 60 * TPS);
    expect(peaceTicks('hard', 'off')).toBe(0);
    for (const [o, m] of [['3', 3], ['6', 6], ['10', 10], ['15', 15]] as [PeaceOption, number][]) {
      for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) expect(peaceTicks(d, o)).toBe(m * 60 * TPS);
    }
    expect(peaceTicks('normal', 'bogus' as PeaceOption)).toBe(6 * 60 * TPS);
    expect(peaceSecondsLeft(0, 6 * 60 * TPS)).toBe(360);
    expect(peaceSecondsLeft(6 * 60 * TPS - 1, 6 * 60 * TPS)).toBe(1);
    expect(peaceSecondsLeft(6 * 60 * TPS, 6 * 60 * TPS)).toBe(0);
    expect(formatPeace(312)).toBe('5:12');
    expect(formatPeace(59.2)).toBe('1:00');
  });

  const rows: string[] = [];
  for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
    it(`${d}: no attack before the grace, waves after it`, () => {
      const peace = peaceTicks(d, 'auto');
      const w = skirmish(d, peace);
      const log = play(w, peace, peace + TPS * 60 * 5, true);
      // the same game without a grace (the old pacing)
      const before = play(skirmish(d, 0), 0, TPS * 60 * 12, true);
      rows.push(
        `${d}: before (off): first attack order ${mmss(before.firstWave)}, first enemy in base ${mmss(before.arrival)}, first hit ${mmss(before.firstHit)}` +
          ` | after (grace ${mmss(peace)}): first attack order ${mmss(log.firstWave)}, first enemy in base ${mmss(log.arrival)}, first hit ${mmss(log.firstHit)}`,
      );
      console.log(rows[rows.length - 1]);
      expect(log.violations).toEqual([]);
      // nothing reaches the player's base during the grace (plus at least the travel time across the map)
      expect(log.arrival < 0 || log.arrival >= peace + TPS * 15).toBe(true);
      expect(log.firstHit < 0 || log.firstHit >= peace).toBe(true);
      // ... but the AI does attack once the grace is over: its waves get into the base, or at least hit it (a
      // defender with a working economy - sim/harvest.ts - may stop them short of the base region)
      expect(log.firstWave).toBeGreaterThanOrEqual(peace);
      expect(log.arrival > 0 || log.firstHit >= peace).toBe(true);
    }, 240000);
  }

  it('the option overrides the difficulty default (hard with 6 min, easy with 3 min)', () => {
    for (const [d, o] of [
      ['hard', '6'],
      ['easy', '3'],
    ] as [Difficulty, PeaceOption][]) {
      const peace = peaceTicks(d, o);
      const w = skirmish(d, peace, 33, 'israel', 'iran');
      const log = play(w, peace, peace + TPS * 60 * 4, true);
      console.log(`${d} with ${o} min: first offensive order ${mmss(log.firstWave)}, first arrival ${mmss(log.arrival)}`);
      expect(log.violations).toEqual([]);
      expect(log.firstWave).toBeGreaterThanOrEqual(peace);
      expect(log.arrival < 0 || log.arrival >= peace).toBe(true);
    }
  }, 240000);

  it('off: the AI attacks as early as before', () => {
    const w = skirmish('hard', 0);
    const log = play(w, 0, TPS * 60 * 6, true);
    expect(log.firstWave).toBeGreaterThan(0);
    expect(log.firstWave).toBeLessThan(TPS * 60 * 4);
  }, 240000);

  it('the AI still defends its base during the grace', () => {
    const peace = peaceTicks('easy', 'auto');
    const w = skirmish('easy', peace, 5);
    for (let i = 0; i < TPS * 150; i++) w.step();
    w.drainEvents();
    // the player raids the AI base early
    const ai = w.players[1];
    const raid = [0, 1, 2].map((k) => w.spawnUnit(`usa_mbt`, 0, ai.startX + 0.5 + 9 + k, ai.startY + 0.5 + 9));
    const target = w.list.find((e) => !e.dead && e.owner === 1 && e.kind === 'building')!;
    w.issue(0, { type: 'attack', ids: raid.map((u) => u.id), target: target.id });
    let fought = false;
    const orig = w.issue.bind(w);
    w.issue = (pid: number, c: Command) => {
      if (pid === 1 && c.type === 'move' && c.attackMove && Math.hypot(c.x - ai.startX, c.y - ai.startY) < 32) fought = true;
      orig(pid, c);
    };
    for (let i = 0; i < TPS * 40; i++) w.step();
    expect(fought).toBe(true);
    expect(w.tick).toBeLessThan(peace);
  }, 120000);

  it('is deterministic with a grace (same seed, same game)', () => {
    const peace = peaceTicks('hard', 'auto');
    const snap = (w: World) => w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}:${e.stance}`).join('|') + '#' + w.players.map((p) => p.credits).join(',');
    const a = skirmish('hard', peace, 9);
    const b = skirmish('hard', peace, 9);
    for (let i = 0; i < peace + TPS * 90; i++) {
      a.step();
      b.step();
      a.drainEvents();
      b.drainEvents();
      if (i % (TPS * 60) === 0) expect(snap(a)).toBe(snap(b));
    }
    expect(snap(a)).toBe(snap(b));
  }, 240000);
});

describe('game speed', () => {
  it('slow / normal / fast tick rates', () => {
    expect(GAME_SPEEDS).toEqual({ slow: 0.75, normal: 1, fast: 1.25 });
    expect(speedFactor(undefined)).toBe(1);
    expect(speedFactor('turbo')).toBe(1);
    for (const [s, n] of [
      ['slow', 15],
      ['normal', 20],
      ['fast', 25],
    ] as const) {
      const p = new TickPacer();
      let ticks = 0;
      // one real second of 60 fps frames
      for (let f = 0; f < 60; f++) ticks += p.advance(1 / 60, speedFactor(s));
      expect(Math.abs(ticks - n)).toBeLessThanOrEqual(1);
    }
  });

  it('does not change what happens per tick', () => {
    const snap = (w: World) => w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}`).join('|') + '#' + w.players.map((p) => p.credits).join(',');
    const N = TPS * 100;
    const ref = skirmish('hard', 0, 4);
    const at = new Map<number, string>();
    for (let i = 1; i <= N; i++) {
      ref.step();
      ref.drainEvents();
      if (i % 200 === 0) at.set(i, snap(ref));
    }
    for (const s of ['slow', 'normal', 'fast'] as const) {
      const w = skirmish('hard', 0, 4);
      const p = new TickPacer();
      let f = 0;
      while (w.tick < N) {
        // jittery frame times (16-40 ms) like a phone
        const dt = (16 + ((f++ * 7919) % 25)) / 1000;
        const n = p.advance(dt, speedFactor(s));
        for (let i = 0; i < n && w.tick < N; i++) {
          w.step();
          w.drainEvents();
          if (at.has(w.tick)) expect(snap(w)).toBe(at.get(w.tick));
        }
      }
      expect(snap(w)).toBe(at.get(N));
    }
  }, 240000);
});
