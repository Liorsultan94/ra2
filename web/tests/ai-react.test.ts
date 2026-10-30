import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { REACT } from '../src/sim/aireact';
import { DEFS, defsForFaction, factionDefByRole, unitDef } from '../src/sim/defs';
import { isFast } from '../src/sim/plans';
import type { SimClock } from '../src/sim/clock';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

// The computer player's reactions (sim/aireact.ts): snipers, AA escorts and home guard, the anti-tank ambush,
// the base raid and the artillery hunt - each one only on what the AI has SEEN (the player's own fog of war and
// night rules), never on what is out of its sight.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

const NIGHT: SimClock = { start: 23, live: false };

/** Player 0 a human who does nothing (its start units removed), player 1 a Hard Russian AI that launches no waves. */
function setup(clock?: SimClock) {
  const w = new World({
    seed: 1,
    map: 'frontline',
    clock,
    players: [
      { name: 'human', faction: 'usa', color: 0, isAI: false },
      { name: 'ai', faction: 'russia', color: 0, isAI: true },
    ],
  });
  const ai = new AIController(w, 1, 'hard', { peaceTicks: 0 }) as AnyAI;
  w.controllers.push(ai);
  // (no scouting and no waves: only the reactions under test move units out)
  ai.scoutAt = Infinity;
  ai.waveNotBefore = Infinity;
  ai.raidAt = Infinity;
  for (const e of w.list) if (e.owner === 0 && e.kind === 'unit' && !unitDef(e.def).mcv) w.kill(e, -1);
  const home: [number, number] = [w.players[1].startX + 0.5, w.players[1].startY + 0.5];
  const base: [number, number] = [w.players[0].startX + 0.5, w.players[0].startY + 0.5];
  const along = (k: number): [number, number] => {
    const p = w.nearestPassable(home[0] + (base[0] - home[0]) * k, home[1] + (base[1] - home[1]) * k, 6, w.mainland)!;
    return [p[0] + 0.5, p[1] + 0.5];
  };
  return { w, ai, home, base, along, rally: ai.rally() as [number, number] };
}

/** n units of def for a player around (x, y); the human's hold their fire (no muzzle flash gives them away). */
function spawn(w: World, def: string, owner: number, at: [number, number], n: number, spread = 0.9): Entity[] {
  expect(DEFS[def], def).toBeTruthy();
  const out: Entity[] = [];
  for (let i = 0; i < n; i++) {
    const p = w.nearestPassable(at[0] + (i % 3) * spread, at[1] + Math.floor(i / 3) * spread, 4, w.mainland)!;
    out.push(w.spawnUnit(def, owner, p[0] + 0.5, p[1] + 0.5));
  }
  if (owner === 0) w.issue(0, { type: 'stance', ids: out.map((u) => u.id), stance: 'holdFire' });
  return out;
}

function run(w: World, s: number) {
  for (let t = 0; t < TPS * s; t++) w.step();
}

/** A spot `d` tiles from (x, y) towards (tx, ty). */
function toward(x: number, y: number, tx: number, ty: number, d: number): [number, number] {
  const len = Math.hypot(tx - x, ty - y) || 1;
  return [x + ((tx - x) / len) * d, y + ((ty - y) / len) * d];
}

const roleOf = (ai: AnyAI, u: Entity) => ai.roleOf(u);
/** An AI lookout: kept where it stands (out of the army's hands), holding its fire. */
function lookout(w: World, ai: AnyAI, def: string, at: [number, number]) {
  const u = spawn(w, def, 1, at, 1)[0];
  ai.setRole([u.id], 'post');
  w.issue(1, { type: 'stance', ids: [u.id], stance: 'holdFire' });
  return u;
}
const fastDef = defsForFaction('russia').find((d) => d.kind === 'unit' && d.category === 'vehicle' && !!d.aiWeight && isFast(d.id) && d.aiTag === 'main')!.id;

describe('AI reactions only on what it sees (fog of war, night)', () => {
  it('enemy tanks massing in unexplored ground: no anti-tank ambush; seen: the ambush is set up', () => {
    const { w, ai, home, base, along, rally } = setup();
    const at = spawn(w, 'russia_at', 1, rally, 4);
    const P = along(0.38);
    spawn(w, 'usa_mbt', 0, P, 6);
    run(w, 8);
    expect(w.players[1].explored[Math.floor(P[1]) * w.map.w + Math.floor(P[0])]).toBe(0);
    expect(ai.react.stats.atAmbush).toBe(0);
    expect(at.every((u) => roleOf(ai, u) === 'army')).toBe(true);
    // an AI rifleman walks up to them: now it has seen them
    lookout(w, ai, 'russia_rifle', toward(P[0], P[1], home[0], home[1], 3));
    run(w, 4);
    expect(ai.react.stats.atAmbush).toBeGreaterThan(0);
    const squad = at.filter((u) => roleOf(ai, u) === 'react');
    expect(squad.length).toBeGreaterThanOrEqual(2);
    // they go out on the way in (a house next to it, or the ground behind the crossing), not at the tanks
    run(w, 6);
    for (const u of squad) {
      const x = u.inside >= 0 ? w.get(u.inside)!.x : u.x;
      const y = u.inside >= 0 ? w.get(u.inside)!.y : u.y;
      expect(Math.hypot(x - home[0], y - home[1])).toBeLessThan(Math.hypot(P[0] - home[0], P[1] - home[1]));
    }
    expect(base).toBeTruthy();
  });

  it('by night the same tanks, outside the shortened sight, stay unknown; by day the same watcher sees them', () => {
    const watch = (clock?: SimClock) => {
      const { w, ai, home, along, rally } = setup(clock);
      spawn(w, 'russia_at', 1, rally, 4);
      const P = along(0.38);
      spawn(w, 'usa_mbt', 0, P, 6, 0);
      // an EW vehicle (sight 9, no night vision: 4.5 by night) 7.5 tiles short of them
      const [ox, oy] = toward(P[0], P[1], home[0], home[1], 7.5);
      lookout(w, ai, 'russia_ew', [ox, oy]);
      run(w, 8);
      return { w, ai };
    };
    const night = watch(NIGHT);
    expect(night.w.night).toBe(true);
    expect(night.ai.react.stats.atAmbush).toBe(0);
    expect([...night.ai.intel.values()].some((it: { def: string }) => it.def === 'usa_mbt')).toBe(false);
    const day = watch();
    expect(day.w.night).toBe(false);
    expect(day.ai.react.stats.atAmbush).toBeGreaterThan(0);
  });

  it('enemy aircraft out of sight do not count; seen, AA soldiers stay home and escort the waves', () => {
    const { w, ai, home, along, rally } = setup();
    spawn(w, 'russia_at', 1, rally, 4);
    const heli = spawn(w, 'usa_heli', 0, along(0.8), 1)[0];
    run(w, 4);
    // (the old count saw every enemy aircraft on the map)
    expect(ai.enemyAirCount()).toBe(0);
    expect(ai.react.stats.aaHome).toBe(0);
    // the helicopter comes over our base
    heli.x = home[0] + 3;
    heli.y = home[1] + 3;
    run(w, 4);
    expect(ai.enemyAirCount()).toBeGreaterThan(0);
    expect(ai.react.stats.aaHome).toBe(REACT.hard.aaHome);
    // a wave of tanks leaves without any AA: Rocket Teams are attached as escorts (guarding its leader)
    const tanks = spawn(w, 'russia_mbt', 1, along(0.3), 4);
    ai.waves.push({ ids: tanks.map((u) => u.id), tx: 0, ty: 0, focus: -1, born: w.tick, lane: '', value: 3200, killed: 0 });
    run(w, 2);
    expect(ai.react.stats.aaEscorts).toBeGreaterThan(0);
    const leader = [...tanks].sort((a, b) => b.maxHp - a.maxHp || a.id - b.id)[0];
    expect(w.list.some((u) => u.owner === 1 && u.def === 'russia_at' && u.guardId === leader.id)).toBe(true);
  });

  it('the enemy base: unscouted it is not known to be empty; seen empty with its army away, a fast raid goes in', () => {
    const go = (look: boolean) => {
      const { w, ai, base, along, rally } = setup();
      ai.stats.firstWave = 1;
      const mcv = w.list.find((e) => e.owner === 0 && unitDef(e.def).mcv)!;
      w.kill(mcv, -1);
      const pw = factionDefByRole('usa', 'power').id;
      const ref = factionDefByRole('usa', 'refinery').id;
      w.spawnBuilding(pw, 0, Math.floor(base[0]) - 1, Math.floor(base[1]) - 1, true);
      w.spawnBuilding(ref, 0, Math.floor(base[0]) + 3, Math.floor(base[1]) - 1, true);
      // its army: out in the middle, where an AI picket sees it
      const M = along(0.5);
      spawn(w, 'usa_mbt', 0, M, 5);
      lookout(w, ai, 'russia_rifle', toward(M[0], M[1], rally[0], rally[1], 3.5));
      const raiders = spawn(w, fastDef, 1, rally, 4);
      if (look) lookout(w, ai, 'russia_rifle', toward(base[0], base[1], rally[0], rally[1], 2.5));
      run(w, 6);
      return { ai, raiders };
    };
    const blind = go(false);
    expect(blind.ai.react.stats.baseRaid).toBe(0);
    const seen = go(true);
    expect(seen.ai.react.stats.baseRaid).toBe(1);
    expect(seen.raiders.filter((u) => seen.ai.roleOf(u) === 'react').length).toBeGreaterThanOrEqual(3);
  });

  it('enemy artillery: unseen it is left alone; seen, fast units hunt it', () => {
    const go = (look: boolean) => {
      const { w, ai, along, rally } = setup();
      // (shelling our half of the map)
      const M = along(0.4);
      const gun = spawn(w, 'usa_arty', 0, M, 1)[0];
      const hunters = spawn(w, fastDef, 1, rally, 4);
      if (look) lookout(w, ai, 'russia_rifle', toward(M[0], M[1], rally[0], rally[1], 3.5));
      run(w, 4);
      return { ai, hunters, gun };
    };
    const blind = go(false);
    expect(blind.ai.react.stats.artyHunt).toBe(0);
    const seen = go(true);
    expect(seen.ai.react.stats.artyHunt).toBe(1);
    const sent = seen.hunters.filter((u) => seen.ai.roleOf(u) === 'react');
    expect(sent.length).toBe(REACT.hard.hunt);
    for (const u of sent) expect(u.order.type === 'attack' && u.order.target === seen.gun.id).toBe(true);
  });
});

describe('snipers', () => {
  it('a few, never a swarm: posted on the enemy routes, and they pull back from vehicles they see', () => {
    const { w, ai, home, rally } = setup();
    const snipers = spawn(w, 'russia_sniper', 1, rally, 3);
    // the production cap: three alive already, so no more are ordered
    expect(ai.react.prodWeight(unitDef('russia_sniper'))).toBe(0);
    run(w, 3);
    expect(ai.react.stats.snipersPosted).toBeGreaterThanOrEqual(1);
    expect(snipers.every((u) => roleOf(ai, u) === 'react')).toBe(true);
    run(w, 25);
    // one posted out on the ground (or in a house): enemy tanks seen coming at it send it back
    const out = snipers.find((u) => u.inside < 0 && Math.hypot(u.x - rally[0], u.y - rally[1]) > 4 && u.order.type === 'idle') ?? snipers.find((u) => u.inside < 0)!;
    const d0 = Math.hypot(out.x - home[0], out.y - home[1]);
    const away = toward(out.x, out.y, home[0], home[1], -6);
    spawn(w, 'usa_mbt', 0, away, 2);
    run(w, 4);
    expect(out.order.type === 'move' || Math.hypot(out.x - home[0], out.y - home[1]) < d0 - 1).toBe(true);
  });

  it('Easy plays without any of this', () => {
    const w = new World({ seed: 1, map: 'frontline', players: [
      { name: 'human', faction: 'usa', color: 0, isAI: false },
      { name: 'ai', faction: 'russia', color: 0, isAI: true },
    ] });
    expect((new AIController(w, 1, 'easy') as AnyAI).react).toBeNull();
    expect((new AIController(w, 1, 'normal') as AnyAI).react).not.toBeNull();
  });
});
