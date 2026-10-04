import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { FUEL_TICKS, PADS_PER_BASE, REARM_TICKS, baseGeo, jetCount, padCap, parkJet } from '../src/sim/airbase';
import { WEAPONS, unitDef } from '../src/sim/defs';
import { TPS, type Entity, type SimEvent, type SortiePhase } from '../src/sim/types';
import { World } from '../src/sim/world';

/** USA (player 0) vs Russia, starting forces cleared; an airbase for player 0 at (ax, ay). */
function airWorld(seed = 3, ax = 10, ay = 60) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: false },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  const af = w.spawnBuilding('usa_airfield', 0, ax, ay, true);
  return { w, af };
}

function jetAt(w: World, af: Entity) {
  const j = w.spawnUnit('usa_fighter', 0, af.x, af.y);
  expect(parkJet(w, j, af)).toBe(true);
  return j;
}

const sorties = (evs: SimEvent[], what: string) => evs.filter((e) => e.t === 'sortie' && e.what === what);

describe('airbase sortie cycle', () => {
  it('runs pad -> taxi -> take-off -> strike -> return -> land -> taxi -> rearm 10 s', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    const g = baseGeo(w, af);
    // parked on pad 0, nose out, armed
    expect(j.sortie!.phase).toBe('parked');
    expect(j.x).toBeCloseTo(g.pads[0]);
    expect(j.y).toBeCloseTo(g.padY);
    expect(j.z).toBe(0);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    const seq: SortiePhase[] = ['parked'];
    const at: Partial<Record<SortiePhase, number>> = {};
    const evs: SimEvent[] = [];
    let maxZtaxi = 0;
    let rollY = 0;
    let impacts = 0;
    for (let i = 0; i < TPS * 120; i++) {
      w.step();
      for (const e of w.drainEvents()) {
        evs.push(e);
        if (e.t === 'impact' && e.weapon === 'jetBomb') impacts++;
      }
      const ph = j.sortie!.phase;
      if (ph !== seq[seq.length - 1]) {
        seq.push(ph);
        at[ph] = w.tick;
      }
      if (ph === 'taxiOut' || ph === 'taxiIn' || ph === 'lineup' || ph === 'rollout') maxZtaxi = Math.max(maxZtaxi, j.z);
      if (ph === 'takeoff' && j.z === 0) rollY = Math.max(rollY, Math.abs(j.y - g.rwyY));
      if (seq.length > 10 && ph === 'parked' && j.sortie!.ammo > 0) break;
    }
    expect(seq).toEqual(['parked', 'taxiOut', 'hold', 'lineup', 'takeoff', 'sortie', 'return', 'final', 'rollout', 'taxiIn', 'parked']);
    // wheels on the ground until the take-off roll, which runs down the runway centreline
    expect(maxZtaxi).toBe(0);
    expect(rollY).toBeLessThan(0.05);
    // exactly one bomb, and it hurt the target
    expect(sorties(evs, 'release').length).toBe(1);
    expect(impacts).toBe(1);
    expect(tgt.hp).toBeLessThan(tgt.maxHp - WEAPONS.jetBomb.damage * 0.9);
    expect(sorties(evs, 'takeoff').length).toBe(1);
    expect(sorties(evs, 'touchdown').length).toBe(1);
    // back on its own pad, rearmed after exactly 10 s
    expect(j.x).toBeCloseTo(g.pads[0], 1);
    expect(j.y).toBeCloseTo(g.padY, 1);
    expect(w.tick - at.parked!).toBe(REARM_TICKS);
    expect(j.sortie!.ammo).toBe(1);
    expect(j.sortie!.rearm).toBe(0);
    // the runway lock is free again
    expect(af.dockedBy).toBe(-1);
  });

  it('waits on the pad while rearming, then sorties on its own', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    j.sortie!.ammo = 0;
    j.sortie!.rearm = REARM_TICKS;
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    for (let i = 0; i < REARM_TICKS - 5; i++) w.step();
    expect(j.sortie!.phase).toBe('parked');
    expect(j.order.type).toBe('attack');
    for (let i = 0; i < 10; i++) w.step();
    expect(j.sortie!.phase).toBe('taxiOut');
  });

  it('only bombs ground targets; parked jets are ground targets, airborne jets are aircraft', () => {
    const { w, af } = airWorld();
    const j = jetAt(w, af);
    const cannon = WEAPONS.cannon;
    const sam = WEAPONS.sam;
    expect(w.isAir(j)).toBe(false);
    expect(w.canHit(cannon, j)).toBe(true);
    expect(w.canHit(sam, j)).toBe(false);
    j.z = 2.6;
    expect(w.isAir(j)).toBe(true);
    expect(w.canHit(cannon, j)).toBe(false);
    expect(w.canHit(sam, j)).toBe(true);
    expect(w.canHit(WEAPONS[unitDef(j.def).weapon!], j)).toBe(false);
  });

  it('shares the runway: 4 jets queue for it, all strike and all come home', () => {
    for (const ax of [10, 70]) {
      const { w, af } = airWorld(5, ax, 60);
      const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
      const jets = [0, 1, 2, 3].map(() => jetAt(w, af));
      expect(new Set(jets.map((j) => j.sortie!.pad))).toEqual(new Set([0, 1, 2, 3]));
      w.issue(0, { type: 'attack', ids: jets.map((j) => j.id), target: tgt.id });
      let releases = 0;
      let maxOnRunway = 0;
      const g = baseGeo(w, af);
      for (let i = 0; i < TPS * 150; i++) {
        w.step();
        releases += sorties(w.drainEvents(), 'release').length;
        // one at a time in the landing / take-off roll on the runway
        const rolling = jets.filter((j) => (j.sortie!.phase === 'rollout' || j.sortie!.phase === 'lineup' || (j.sortie!.phase === 'takeoff' && Math.abs(j.x - g.startX) < 2.6)) && !j.dead).length;
        maxOnRunway = Math.max(maxOnRunway, rolling);
      }
      expect(maxOnRunway).toBe(1);
      expect(releases).toBe(4);
      expect(tgt.dead).toBe(true);
      for (const j of jets) {
        expect(j.dead).toBe(false);
        expect(j.sortie!.phase).toBe('parked');
      }
    }
  });
});

describe('jet cap', () => {
  function capWorld() {
    const { w, af } = airWorld();
    w.spawnBuilding('usa_power', 0, 8, 88, true);
    w.spawnBuilding('usa_power', 0, 8, 84, true);
    w.spawnBuilding('usa_radar', 0, 12, 88, true);
    w.spawnBuilding('usa_tech', 0, 20, 86, true);
    w.players[0].credits = 50000;
    return { w, af };
  }

  it('is 4 jets per airbase, counting jets in production', () => {
    const { w, af } = capWorld();
    expect(padCap(w, 0)).toBe(PADS_PER_BASE);
    expect(w.canBuild(0, 'usa_fighter')).toBe(true);
    jetAt(w, af);
    jetAt(w, af);
    w.issue(0, { type: 'produce', def: 'usa_fighter', count: 5 });
    w.step();
    expect(w.players[0].queues.air.length).toBe(2);
    expect(w.canBuild(0, 'usa_fighter')).toBe(false);
    // helicopters and drones are not capped
    expect(w.canBuild(0, 'usa_heli')).toBe(true);
    for (let i = 0; i < TPS * 60; i++) w.step();
    expect(w.players[0].queues.air.length).toBe(0);
    expect(jetCount(w, 0)).toBe(4);
    const jets = w.list.filter((e) => !e.dead && e.sortie);
    expect(new Set(jets.map((j) => j.sortie!.pad)).size).toBe(4);
    for (const j of jets) expect(j.sortie!.phase).toBe('parked');
    expect(w.canBuild(0, 'usa_fighter')).toBe(false);
    // a second airbase doubles the cap
    w.spawnBuilding('usa_airfield', 0, 30, 70, true);
    w.step();
    expect(padCap(w, 0)).toBe(8);
    expect(w.canBuild(0, 'usa_fighter')).toBe(true);
  });

  it('Iran still has no fighter jets', () => {
    const { w } = airWorld();
    expect(w.list.length).toBeGreaterThan(0);
    for (const id of ['iran_fighter']) expect(unitDef(id)).toBeUndefined();
  });
});

describe('airbase loss', () => {
  it('jets on the ground die with their airbase', () => {
    const { w, af } = airWorld();
    const jets = [jetAt(w, af), jetAt(w, af)];
    w.kill(af, 1);
    w.step();
    for (const j of jets) expect(j.dead).toBe(true);
  });

  it('airborne jets divert to another airbase with a free pad and land there', () => {
    const { w, af } = airWorld(3, 10, 60);
    const af2 = w.spawnBuilding('usa_airfield', 0, 30, 76, true);
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    for (let i = 0; i < TPS * 60 && j.sortie!.phase !== 'return'; i++) w.step();
    expect(j.sortie!.phase).toBe('return');
    w.kill(af, 1);
    const evs: SimEvent[] = [];
    for (let i = 0; i < TPS * 60; i++) {
      w.step();
      evs.push(...w.drainEvents());
      if (j.sortie!.phase === 'parked') break;
    }
    expect(sorties(evs, 'divert').length).toBe(1);
    expect(j.dead).toBe(false);
    expect(j.sortie!.base).toBe(af2.id);
    expect(j.sortie!.phase).toBe('parked');
    const g2 = baseGeo(w, af2);
    expect(j.x).toBeCloseTo(g2.pads[j.sortie!.pad], 1);
  });

  it('with no airbase left they circle and crash when the fuel runs out', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    for (let i = 0; i < TPS * 60 && j.sortie!.phase !== 'return'; i++) w.step();
    w.kill(af, 1);
    const evs: SimEvent[] = [];
    let orbitAt = -1;
    for (let i = 0; i < FUEL_TICKS + TPS * 5 && !j.dead; i++) {
      w.step();
      evs.push(...w.drainEvents());
      if (orbitAt < 0 && j.sortie!.phase === 'orbit') orbitAt = w.tick;
    }
    expect(orbitAt).toBeGreaterThan(0);
    expect(sorties(evs, 'crash').length).toBe(1);
    expect(j.dead).toBe(true);
  });

  it('a new airbase built while they circle takes them in', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    for (let i = 0; i < TPS * 60 && j.sortie!.phase !== 'return'; i++) w.step();
    w.kill(af, 1);
    for (let i = 0; i < TPS * 5; i++) w.step();
    expect(j.sortie!.phase).toBe('orbit');
    const af2 = w.spawnBuilding('usa_airfield', 0, 30, 76, true);
    for (let i = 0; i < TPS * 60 && j.sortie!.phase !== 'parked'; i++) w.step();
    expect(j.dead).toBe(false);
    expect(j.sortie!.base).toBe(af2.id);
    expect(j.sortie!.phase).toBe('parked');
  });
});

describe('airbase determinism', () => {
  function run(seed: number) {
    const w = new World({
      seed,
      players: [
        { name: 'A', faction: 'usa', color: 0, isAI: true },
        { name: 'B', faction: 'israel', color: 0, isAI: true },
      ],
    });
    w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
    // both sides start with a full airbase so the AI flies sorties from the first minute
    const a0 = w.spawnBuilding('usa_airfield', 0, 12, 70, true);
    const a1 = w.spawnBuilding('israel_airfield', 1, 77, 22, true);
    // a spare airbase each: the AI goes for the enemy airbase first, its jets divert to the spare
    w.spawnBuilding('usa_airfield', 0, 22, 62, true);
    w.spawnBuilding('israel_airfield', 1, 67, 30, true);
    for (const [af, def] of [
      [a0, 'usa_fighter'],
      [a1, 'israel_fighter'],
    ] as const)
      for (let k = 0; k < PADS_PER_BASE; k++) parkJet(w, w.spawnUnit(def, af.owner, af.x, af.y), af);
    let releases = 0;
    let landings = 0;
    let diverts = 0;
    for (let t = 0; t < TPS * 180; t++) {
      w.step();
      for (const e of w.drainEvents()) {
        if (e.t === 'sortie' && e.what === 'release') releases++;
        if (e.t === 'sortie' && e.what === 'touchdown') landings++;
        if (e.t === 'sortie' && e.what === 'divert') diverts++;
      }
    }
    const snap = w.list
      .filter((e) => !e.dead)
      .map((e) => `${e.id}:${e.def}:${e.x.toFixed(5)}:${e.y.toFixed(5)}:${e.z.toFixed(5)}:${e.hp.toFixed(3)}:${e.sortie ? `${e.sortie.phase}/${e.sortie.pad}/${e.sortie.rearm}/${e.sortie.ammo}` : ''}`)
      .join('|');
    return { snap, releases, landings, diverts, credits: w.players.map((p) => p.credits) };
  }

  it('AI sorties play out identically', () => {
    const a = run(21);
    const b = run(21);
    expect(a.releases).toBeGreaterThan(2);
    expect(a.landings).toBeGreaterThan(0);
    console.log('AI sortie run: releases', a.releases, 'landings', a.landings, 'diverts', a.diverts);
    expect(a.snap).toBe(b.snap);
    expect(a.releases).toBe(b.releases);
    expect(a.credits).toEqual(b.credits);
  }, 120000);
});
