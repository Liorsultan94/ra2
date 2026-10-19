import { describe, expect, it } from 'vitest';
import { AIController, type Difficulty } from '../src/sim/ai';
import { NAVY_AI } from '../src/sim/navalai';
import { DOCTRINES } from '../src/sim/doctrine';
import { DEFS, FACTIONS, VERSUS, WEAPONS, defsForFaction, hitsAir, unitDef } from '../src/sim/defs';
import { groundHeight } from '../src/sim/map';
import { PLANS, PLAN_CFG, arsenal, pickPlan, planWeights, type Plan } from '../src/sim/plans';
import { Rng } from '../src/sim/rng';
import { TPS, type Command, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

function game(a: Faction, b: Faction, seed: number, diff: [Difficulty, Difficulty] = ['hard', 'hard'], map: 'frontline' | 'desert' | 'winter' | 'urban' = 'frontline', peace = 0) {
  const w = new World({
    seed,
    map,
    players: [
      { name: a, faction: a, color: 0, isAI: true },
      { name: b, faction: b, color: 0, isAI: true },
    ],
  });
  const ais = [new AIController(w, 0, diff[0], { peaceTicks: peace }), new AIController(w, 1, diff[1], { peaceTicks: peace })];
  w.controllers.push(...ais);
  return { w, ais: ais as AnyAI[] };
}

/** What a fresh AI decides at match start: plan, build order, scout / raid / stale timings, wave jitter. */
function opening(seed: number, f: Faction = 'usa', pid = 1) {
  const { ais } = game('russia', f, seed);
  const a = ais[pid];
  return JSON.stringify([a.plan, a.buildOrder, a.scoutAt, a.raidAt, a.waveStale, a.waveJitter, a.waveSize]);
}

describe('per-match randomness', () => {
  it('different match seeds give different AI openings; the same seed the same one', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 12; s++) seen.add(opening(s));
    expect(seen.size).toBeGreaterThanOrEqual(10);
    expect(opening(5)).toBe(opening(5));
    // the two sides of one match differ too
    const { ais } = game('usa', 'usa', 9);
    expect(JSON.stringify([ais[0].buildOrder, ais[0].scoutAt])).not.toBe(JSON.stringify([ais[1].buildOrder, ais[1].scoutAt]));
  });

  it('same seed: identical AI decisions over a game; different seeds: different lanes / timings', () => {
    const run = (seed: number) => {
      const { w, ais } = game('usa', 'russia', seed);
      const cmds: string[] = [];
      const issue = w.issue.bind(w);
      w.issue = (pid: number, c: Command) => {
        if (c.type === 'produce' || c.type === 'move') cmds.push(`${w.tick}:${pid}:${c.type}:${'def' in c ? c.def : ''}`);
        issue(pid, c);
      };
      for (let t = 0; t < TPS * 60 * 7; t++) w.step();
      return { cmds: cmds.join('|'), stats: JSON.stringify(ais.map((a) => [a.plan, a.stats.firstWave, a.stats.lanes])) };
    };
    const a = run(11);
    const b = run(11);
    expect(a.cmds).toBe(b.cmds);
    expect(a.stats).toBe(b.stats);
    const c = run(12);
    expect(c.stats).not.toBe(a.stats);
  }, 120000);
});

describe('opening strategies (plans)', () => {
  it('a plan the arsenal cannot support is never picked; seeds pick different plans', () => {
    for (const f of FACTIONS) {
      const doc = DOCTRINES[f.id];
      const ars = arsenal(f.id);
      for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
        const wts = planWeights(f.id, doc, d);
        if (!ars.air) expect(wts.air).toBe(0);
        if (!ars.arty) expect(wts.siege).toBe(0);
        if (!ars.fast) expect(wts.harass).toBe(0);
        const picked = new Set<Plan>();
        for (let s = 0; s < 200; s++) picked.add(pickPlan(new Rng(s * 7919 + 1), wts));
        for (const p of picked) expect(wts[p]).toBeGreaterThan(0);
        expect(picked.size).toBeGreaterThanOrEqual(3);
      }
    }
    // AIs of different matches pick different plans
    const plans = new Set<string>();
    for (let s = 1; s <= 16; s++) plans.add(game('usa', 'china', s).ais[1].plan);
    expect(plans.size).toBeGreaterThanOrEqual(3);
  });

  it('every plan builds only from the nation’s own arsenal', () => {
    for (const f of ['usa', 'iran', 'turkey', 'korea'] as Faction[]) {
      const own = new Set(defsForFaction(f).map((d) => d.id));
      for (const p of PLANS) {
        if (planWeights(f, DOCTRINES[f], 'hard')[p] <= 0) continue;
        const { w, ais } = game('russia', f, 3);
        ais[1].setPlan(p);
        const bad: string[] = [];
        const issue = w.issue.bind(w);
        w.issue = (pid: number, c: Command) => {
          if (pid === 1 && (c.type === 'produce' || c.type === 'place') && !own.has(c.def)) bad.push(c.def);
          issue(pid, c);
        };
        for (let t = 0; t < TPS * 60 * 4; t++) w.step();
        expect(bad, `${f} ${p}`).toEqual([]);
        expect(PLAN_CFG[p]).toBeTruthy();
      }
    }
  }, 240000);
});

describe('adaptation', () => {
  /** Russia's AI after it has seen (fog-fair: right in front of its base) an enemy force of the given kind. */
  function seen(kind: 'armour' | 'air' | 'infantry') {
    const { w, ais } = game('usa', 'russia', 4, ['easy', 'hard']);
    const ai = ais[1];
    const p = w.players[1];
    const def = kind === 'armour' ? 'usa_mbt' : kind === 'air' ? 'usa_heli' : 'usa_rifle';
    for (let k = 0; k < 10; k++) w.spawnUnit(def, 0, p.startX + 0.5 + 2 + (k % 5), p.startY + 0.5 + 3 + Math.floor(k / 5));
    for (let t = 0; t < TPS * 3; t++) w.step();
    return ai;
  }
  const own = defsForFaction('russia')
    .filter((d) => d.kind === 'unit' && d.aiWeight && d.weapon && d.aiTag !== 'aa')
    .map((d) => unitDef(d.id));
  const vs = (d: ReturnType<typeof unitDef>, a: 'heavy' | 'infantry') => Math.max(VERSUS[WEAPONS[d.weapon!].warhead][a], d.weapon2 ? VERSUS[WEAPONS[d.weapon2].warhead][a] : 0);

  it('shifts production toward anti-armour against tanks, anti-infantry against infantry, AA against aircraft', () => {
    const armour = seen('armour');
    expect(armour.mix.armour).toBeGreaterThanOrEqual(5);
    const at = own.filter((d) => vs(d, 'heavy') >= 0.9);
    const mg = own.filter((d) => vs(d, 'heavy') <= 0.35 && vs(d, 'infantry') >= 1);
    expect(at.length && mg.length).toBeTruthy();
    for (const a of at) for (const m of mg) expect(armour.counterWeight(a)).toBeGreaterThan(armour.counterWeight(m));
    const inf = seen('infantry');
    expect(inf.mix.infantry).toBeGreaterThanOrEqual(5);
    for (const a of at) for (const m of mg) if (vs(a, 'infantry') < 0.6) expect(inf.counterWeight(m)).toBeGreaterThan(inf.counterWeight(a));
    const air = seen('air');
    expect(air.mix.air).toBeGreaterThanOrEqual(5);
    const aaCapable = own.filter((d) => hitsAir(d));
    const groundOnly = own.filter((d) => !hitsAir(d));
    for (const a of aaCapable) for (const g of groundOnly) expect(air.counterWeight(a)).toBeGreaterThan(air.counterWeight(g));
  });

  it('a wave lost for little marks its lane, grows the next wave and boosts the counters', () => {
    const { w, ais } = game('usa', 'russia', 6);
    for (let t = 0; t < TPS * 30; t++) w.step();
    const ai = ais[1];
    const u = w.list.find((e) => e.owner === 1 && e.kind === 'unit' && !unitDef(e.def).harvester && !unitDef(e.def).mcv)!;
    const size = ai.waveSize;
    ai.waves.push({ ids: [u.id], tx: 0, ty: 0, focus: -1, born: w.tick - TPS * 200, lane: '1,1', value: 5000, killed: 0 });
    ai.retireWaves();
    expect(ai.stats.badTrades).toBe(1);
    expect(ai.lanePenalty.get('1,1')).toBe(1);
    expect(ai.waveSize).toBeGreaterThanOrEqual(Math.min(size + 2, 24));
    expect(ai.adaptBoostUntil).toBeGreaterThan(w.tick);
  });
});

describe('deception and timing', () => {
  it('hard AIs feint before some main pushes, and wave timing is irregular', () => {
    let feints = 0;
    const gaps: number[] = [];
    for (const seed of [1, 2, 3]) {
      const { w, ais } = game('usa', 'russia', seed);
      const last = [0, 0];
      const n = [0, 0];
      for (let t = 0; t < TPS * 60 * 12 && !w.over; t++) {
        w.step();
        ais.forEach((a, i) => {
          if (a.stats.waves !== n[i]) {
            n[i] = a.stats.waves;
            if (last[i]) gaps.push(w.tick - last[i]);
            last[i] = w.tick;
          }
        });
      }
      feints += ais[0].stats.feints + ais[1].stats.feints;
    }
    expect(feints).toBeGreaterThan(0);
    expect(new Set(gaps.map((g) => Math.round(g / (TPS * 10)))).size).toBeGreaterThan(2);
  }, 240000);

  it('no attack (wave, feint, raid) before the peace grace, whatever the plan', () => {
    const peace = TPS * 60 * 3;
    for (const [seed, plan] of [
      [1, 'rush'],
      [2, 'harass'],
      [3, 'boom'],
    ] as [number, Plan][]) {
      const { w, ais } = game('usa', 'germany', seed, ['hard', 'hard'], 'frontline', peace);
      ais[1].setPlan(plan);
      const enemy = w.players[0];
      let early = 0;
      for (let t = 0; t < peace; t++) {
        w.step();
        if (t % TPS) continue;
        for (const e of w.list) {
          if (e.dead || e.owner !== 1 || e.kind !== 'unit' || ais[1].roleOf(e) === 'scout') continue;
          if (Math.hypot(e.x - enemy.startX, e.y - enemy.startY) < 30) early++;
        }
      }
      expect(early).toBe(0);
      expect(ais[1].stats.waves + ais[1].stats.feints).toBe(0);
    }
  }, 120000);
});

describe('terrain', () => {
  it('finds high ground and chokepoints from the heightmap and passability (desert mountains)', () => {
    const { w, ais } = game('usa', 'russia', 2, ['hard', 'hard'], 'desert');
    const ai = ais[1];
    const m = w.map;
    // high ground: from points around the map, the spot picked is never lower and often higher
    let higher = 0;
    for (let k = 0; k < 40; k++) {
      const x = 8 + ((k * 37) % (m.w - 16));
      const y = 8 + ((k * 53) % (m.h - 16));
      const p = w.nearestPassable(x, y, 4);
      if (!p) continue;
      const [sx, sy] = ai.highSpot(p[0] + 0.5, p[1] + 0.5, 3);
      expect(w.pf.passable(Math.floor(sx), Math.floor(sy))).toBe(true);
      const h0 = groundHeight(m, p[0] + 0.5, p[1] + 0.5);
      const h1 = groundHeight(m, sx, sy);
      expect(h1).toBeGreaterThanOrEqual(h0 - 0.05);
      if (h1 > h0 + 0.2) higher++;
    }
    expect(higher).toBeGreaterThanOrEqual(3);
    // a map that lists no lanes: chokepoints come from passability alone, a few hundred samples per think
    m.lanes = [];
    for (let i = 0; i < 40 && !ai.chokes; i++) ai.scanChokes();
    expect(ai.chokes.length).toBeGreaterThan(0);
    for (const c of ai.chokes) expect(w.pf.passable(Math.floor(c.x), Math.floor(c.y))).toBe(true);
    expect(ai.lanes().length).toBe(ai.chokes.length);
  });

  it('an enemy column closing on a crossing near home meets an ambush on the best ground', () => {
    const { w, ais } = game('usa', 'russia', 2, ['hard', 'hard'], 'desert');
    const ai = ais[1];
    for (let t = 0; t < TPS * 60 * 6; t++) w.step();
    // (not while a wave gathers at the rally point: the tanks there would join it, not an ambush; and the eight
    // tanks put there below must not start one either)
    for (let t = 0; t < TPS * 60 * 3 && ai.staged; t++) w.step();
    ai.waveSize = 999;
    const p = w.players[1];
    // ambush: an enemy column closing on the crossing nearest us, our army idle at the rally point
    const [hx, hy] = ai.home();
    const lane = ai.lanes().reduce((b: { x: number; y: number }, l: { x: number; y: number }) => (Math.hypot(l.x - hx, l.y - hy) < Math.hypot(b.x - hx, b.y - hy) ? l : b));
    const far = ai.bank(lane, -8);
    for (let k = 0; k < 6; k++) w.spawnUnit('usa_mbt', 0, far[0] + (k % 3) - 1, far[1] + Math.floor(k / 3));
    // (a lookout of ours on the near bank sees it coming)
    const look = ai.bank(lane, 1);
    w.spawnUnit('russia_sniper', 1, look[0], look[1]);
    const [rx, ry] = ai.rally();
    for (let k = 0; k < 8; k++) w.spawnUnit('russia_mbt', 1, rx + (k % 4) - 1.5, ry + Math.floor(k / 4));
    for (let t = 0; t < TPS * 4 && !ai.stats.ambushes; t++) w.step();
    expect(ai.stats.ambushes).toBe(1);
    const amb = w.list.filter((e) => !e.dead && e.owner === 1 && ai.roleOf(e) === 'ambush');
    expect(amb.length).toBeGreaterThanOrEqual(4);
    const post = ai.bank(lane, 5);
    expect(groundHeight(w.map, ai.ambushAt[0], ai.ambushAt[1])).toBeGreaterThanOrEqual(groundHeight(w.map, post[0], post[1]) - 0.05);
    expect(amb.every((e) => e.stance === 'holdFire' || e.stance === 'guard')).toBe(true);
    expect(p.defeated).toBe(false);
  });
});

describe('difficulty still matters', () => {
  /*
   * Mirror matches (same nation both sides) on the desert, hard vs easy, each played with hard in either slot
   * (the original two match-ups: usa on seed 1, russia on seed 2; 25 game minutes at most each).
   *
   * Thresholds from a 16 game sample (seeds 1-4 x usa / russia x both slot orders, Wadi Al-Rimal): before BAL1
   * the north start was favoured (hard won 7 of 8 from slot 1 but only 4 of 8 from slot 0, with 3 easy wins).
   * BAL1 made the two bases exact mirrors (sim/turn.ts): hard 12, easy 0, 4 ran out the clock (5 + 3 draws with
   * hard in slot 0, 7 + 1 draw in slot 1). So: of these 4 games at least 3 are decisive, hard wins at least 3 of
   * them, and easy wins none, whichever slot hard starts in.
   *
   * The Sinai (SN1: the bases 140 tiles apart, every attack through one of two land corridors) runs longer: of the
   * 19 hard-vs-easy usa mirror games of its sample (seeds 1-8, both slots) 11 ended inside 25 minutes (hard won 4 of
   * 10 from slot 0, 7 of 9 from slot 1), easy won none. Here hard in slot 1 wins both, hard in slot 0 runs out the
   * clock 6.4 and 1.8 times as strong (value of everything on the field). The Sinai traced from the owner's picture
   * (bases 160 tiles apart by road): hard wins 3 of these 4 in 14-23 minutes, the fourth runs out the clock with hard
   * 1.4 times as strong. So: at least 2 decisive, hard wins them, easy wins none, and a game that runs out the clock
   * ends with hard at least 1.25 times as strong.
   */
  it('hard beats easy in AI-vs-AI games (both slot orders)', () => {
    // (the land war: the navy - NV1, navalai.ts - is switched off here; tests/ai-navy.test.ts covers it)
    NAVY_AI.on = false;
    const results: { seed: number; f: Faction; hardSlot: number; winner: 'hard' | 'easy' | 'none'; min: number; lead: number }[] = [];
    for (const [seed, f] of [
      [1, 'usa'],
      [2, 'russia'],
    ] as [number, Faction][]) {
      for (const hardSlot of [0, 1]) {
        const { w } = game(f, f, seed, hardSlot === 0 ? ['hard', 'easy'] : ['easy', 'hard'], 'desert');
        let t = 0;
        for (; t < TPS * 60 * 25 && !w.over; t++) w.step();
        const lost = (pid: number) => w.players[pid].defeated;
        const winnerSlot = lost(0) === lost(1) ? -1 : lost(0) ? 1 : 0;
        const winner = winnerSlot < 0 ? 'none' : winnerSlot === hardSlot ? 'hard' : 'easy';
        // value on the field (hard / easy) at the end
        const val = [0, 0];
        for (const e of w.list) if (!e.dead && (e.owner === 0 || e.owner === 1)) val[e.owner] += DEFS[e.def]?.cost ?? 0;
        const lead = +(val[hardSlot] / Math.max(1, val[1 - hardSlot])).toFixed(2);
        results.push({ seed, f, hardSlot, winner, min: +(t / TPS / 60).toFixed(1), lead });
      }
    }
    const msg = JSON.stringify(results);
    const decisive = results.filter((r) => r.winner !== 'none');
    expect(decisive.length, msg).toBeGreaterThanOrEqual(2);
    expect(decisive.filter((r) => r.winner === 'hard').length, msg).toBe(decisive.length);
    for (const r of results) if (r.winner === 'none') expect(r.lead, msg).toBeGreaterThanOrEqual(1.25);
    // easy never wins, whichever slot hard starts in (fair starts: the north base is the south one's mirror, sim/turn.ts)
    expect(results.filter((r) => r.winner === 'easy').length, msg).toBe(0);
    NAVY_AI.on = true;
  }, 600000);
});
