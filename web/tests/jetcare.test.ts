import { describe, expect, it } from 'vitest';
import { REARM_TICKS, REPAIR_RATE, jetReady, parkJet, repairProgress } from '../src/sim/airbase';
import { entityZ, launch } from '../src/sim/ballistics';
import { WEAPONS, unitDef } from '../src/sim/defs';
import { evades, evasionChance, lowObsFactor, rangeVs } from '../src/sim/stealth';
import { TPS, type Entity, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/** USA (player 0) vs Russia, starting forces cleared; an airbase for player 0 at (10, 60). */
function airWorld(seed = 3, factions: ['usa' | 'israel' | 'china', 'russia'] = ['usa', 'russia'], base = true, night = false) {
  const w = new World({
    seed,
    // by night (sim/night.ts) explored ground outside sight hides units; by day it stays revealed (classic)
    clock: night ? { start: 23, live: false } : undefined,
    players: [
      { name: 'A', faction: factions[0], color: 0, isAI: false },
      { name: 'B', faction: factions[1], color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding(`${factions[0]}_conyard`, 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  const af = base ? w.spawnBuilding(`${factions[0]}_airfield`, 0, 10, 60, true) : (null as unknown as Entity);
  return { w, af };
}

function jetAt(w: World, af: Entity, def = 'usa_fighter') {
  const j = w.spawnUnit(def, 0, af.x, af.y);
  expect(parkJet(w, j, af)).toBe(true);
  return j;
}

const what = (evs: SimEvent[], k: string) => evs.filter((e) => e.t === 'sortie' && e.what === k).length;

/** Step until cond() or the tick budget runs out; returns the events seen. */
function runUntil(w: World, cond: () => boolean, ticks: number): SimEvent[] {
  const evs: SimEvent[] = [];
  for (let i = 0; i < ticks && !cond(); i++) {
    w.step();
    evs.push(...w.drainEvents());
  }
  return evs;
}

describe('jet repair on the pad', () => {
  it('repairs ~4% max HP per second alongside the rearm, and does not re-strike before it is fully repaired', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    // first sortie: out, bomb, home, parked and rearming
    runUntil(w, () => j.sortie!.phase === 'parked' && j.sortie!.rearm > 0, TPS * 120);
    expect(j.sortie!.rearm).toBe(REARM_TICKS);
    expect(tgt.dead).toBe(false);
    // it came home hit: 40% HP
    j.hp = j.maxHp * 0.4;
    expect(repairProgress(j)).toBeCloseTo(0.4);
    w.step();
    expect(j.hp).toBeCloseTo(j.maxHp * (0.4 + REPAIR_RATE / TPS), 5);
    // after the 10 s rearm: armed, repaired to 80%, still on the pad (the re-strike waits for the repair)
    for (let i = 1; i < REARM_TICKS; i++) w.step();
    expect(j.sortie!.ammo).toBe(1);
    expect(j.sortie!.rearm).toBe(0);
    expect(j.hp / j.maxHp).toBeCloseTo(0.8, 2);
    expect(j.sortie!.phase).toBe('parked');
    expect(j.order).toMatchObject({ type: 'attack', target: tgt.id });
    expect(jetReady(j)).toBe(false);
    // 5 s more to 100%, then off again on its own
    let left = -1;
    for (let i = 0; i < TPS * 8; i++) {
      w.step();
      if (j.sortie!.phase !== 'parked') {
        left = i;
        break;
      }
      expect(j.hp).toBeLessThan(j.maxHp);
    }
    expect(left).toBeGreaterThanOrEqual(TPS * 5 - 3);
    expect(left).toBeLessThanOrEqual(TPS * 5 + 2);
    expect(j.hp).toBe(j.maxHp);
    expect(j.sortie!.phase).toBe('taxiOut');
  });

  it('a fresh order from its owner launches a damaged jet as soon as it is armed', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    j.hp = j.maxHp * 0.3;
    // idle, armed, damaged: it sits and gets repaired...
    for (let i = 0; i < TPS * 2; i++) w.step();
    expect(j.sortie!.phase).toBe('parked');
    expect(j.hp).toBeGreaterThan(j.maxHp * 0.3);
    // ...until the player sends it: off at once, repaired or not
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    w.step();
    w.step();
    expect(j.sortie!.phase).toBe('taxiOut');
    expect(j.hp).toBeLessThan(j.maxHp * 0.5);
  });

  it('a fresh order while rearming launches the damaged jet the moment the rearm ends', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const other = w.spawnBuilding('russia_power', 1, 50, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    runUntil(w, () => j.sortie!.phase === 'parked' && j.sortie!.rearm > 0, TPS * 120);
    j.hp = j.maxHp * 0.2;
    w.issue(0, { type: 'attack', ids: [j.id], target: other.id });
    for (let i = 0; i < REARM_TICKS + 2; i++) w.step();
    expect(j.sortie!.phase).toBe('taxiOut');
    expect(j.hp).toBeLessThan(j.maxHp * 0.7);
    expect(j.order).toMatchObject({ type: 'attack', target: other.id });
  });
});

describe('automatic re-strike', () => {
  it('keeps bombing the same target, sortie after sortie, until it is destroyed, then stays parked and idle', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_power', 1, 40, 20, true); // 750 HP: takes two bombs
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    const evs = runUntil(w, () => tgt.dead && j.sortie!.phase === 'parked', TPS * 240);
    expect(tgt.dead).toBe(true);
    expect(what(evs, 'release')).toBe(2);
    expect(what(evs, 'takeoff')).toBe(2);
    // home, idle, armed again after the rearm, and it stays there
    const more = runUntil(w, () => false, TPS * 40);
    expect(what(more, 'takeoff')).toBe(0);
    expect(j.sortie!.phase).toBe('parked');
    expect(j.order.type).toBe('idle');
    expect(j.sortie!.ammo).toBe(1);
    expect(j.sortie!.auto).toBe(-1);
  });

  it('works for AI jets too', () => {
    const { w, af } = airWorld();
    w.players[0].isAI = true; // the order goes through the same command path the AI uses
    const tgt = w.spawnBuilding('russia_power', 1, 40, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    const evs = runUntil(w, () => tgt.dead, TPS * 240);
    expect(tgt.dead).toBe(true);
    expect(what(evs, 'release')).toBe(2);
  });

  it('a new order (stop) cancels the re-strike', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    runUntil(w, () => j.sortie!.phase === 'return', TPS * 120);
    expect(j.order).toMatchObject({ type: 'attack', target: tgt.id });
    w.issue(0, { type: 'stop', ids: [j.id] });
    const evs = runUntil(w, () => false, TPS * 90);
    expect(what(evs, 'takeoff')).toBe(0);
    expect(j.sortie!.phase).toBe('parked');
    expect(j.order.type).toBe('idle');
    expect(tgt.dead).toBe(false);
  });

  it('a new attack order switches the jet to the new target', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const other = w.spawnBuilding('russia_power', 1, 30, 40, true);
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    runUntil(w, () => j.sortie!.phase === 'return', TPS * 120);
    w.issue(0, { type: 'attack', ids: [j.id], target: other.id });
    runUntil(w, () => w.projectiles.length === 0, TPS * 10); // the first bomb lands
    const hp0 = tgt.hp;
    runUntil(w, () => other.dead, TPS * 240);
    expect(other.dead).toBe(true);
    expect(tgt.hp).toBeGreaterThanOrEqual(hp0 - 1);
  });

  it('drops the re-strike when the target is no longer valid (a unit out of sight)', () => {
    const { w, af } = airWorld(3, ['usa', 'russia'], true, true);
    const tank = w.spawnUnit('russia_mbt', 1, 40, 30);
    tank.maxHp = tank.hp = 5000; // survives the bomb
    const j = jetAt(w, af);
    w.issue(0, { type: 'attack', ids: [j.id], target: tank.id });
    runUntil(w, () => j.sortie!.phase === 'return', TPS * 120);
    expect(j.order).toMatchObject({ type: 'attack', target: tank.id });
    // the tank slips away into the fog
    tank.x = tank.px = 85;
    tank.y = tank.py = 10;
    const evs = runUntil(w, () => false, TPS * 90);
    expect(what(evs, 'takeoff')).toBe(0);
    expect(j.order.type).toBe('idle');
  });

  it('jets never pile onto a target that is already dead', () => {
    const { w, af } = airWorld();
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    const near = w.spawnBuilding('russia_power', 1, 44, 20, true); // a juicy neighbour: an auto re-strike never re-aims at it
    const jets = [0, 1, 2].map(() => jetAt(w, af));
    w.issue(0, { type: 'attack', ids: jets.map((j) => j.id), target: tgt.id });
    // once all three bombs are away, the target dies (e.g. to someone else)
    runUntil(w, () => jets.every((j) => j.sortie!.ammo === 0), TPS * 150);
    w.kill(tgt, -1);
    const nearHp = near.hp;
    const evs = runUntil(w, () => false, TPS * 120);
    expect(what(evs, 'takeoff')).toBe(0);
    expect(what(evs, 'release')).toBe(0);
    for (const j of jets) {
      expect(j.sortie!.phase).toBe('parked');
      expect(j.order.type).toBe('idle');
    }
    expect(near.hp).toBe(nearHp);
  });
});

describe('F-35: faster, low observable, evasive', () => {
  it('F-35A / F-35I cruise 20% faster than the J-20; only they are stealthy', () => {
    const j20 = unitDef('china_fighter');
    for (const id of ['usa_fighter', 'israel_fighter']) {
      const d = unitDef(id);
      expect(d.speed).toBeCloseTo(j20.speed * 1.2);
      expect(d.lowObservable).toBeCloseTo(0.6);
      expect(d.evasion).toBeCloseTo(0.3);
      expect(d.desc).toMatch(/stealth/i);
      expect(d.desc).toMatch(/evasion/i);
    }
    for (const id of ['china_fighter', 'russia_fighter', 'germany_fighter', 'korea_fighter']) {
      expect(unitDef(id).lowObservable).toBeUndefined();
      expect(unitDef(id).evasion).toBeUndefined();
    }
  });

  it('flies its sortie faster, with the same take-off roll', () => {
    const run = (faction: 'usa' | 'china') => {
      const { w, af } = airWorld(3, [faction, 'russia']);
      const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
      const j = jetAt(w, af, `${faction}_fighter`);
      w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
      let vmax = 0;
      let rollStart = -1;
      let roll = 0;
      let release = -1;
      for (let i = 0; i < TPS * 120 && release < 0; i++) {
        w.step();
        const ph = j.sortie!.phase;
        if (ph === 'takeoff' && rollStart < 0) rollStart = j.x;
        if (ph === 'takeoff' && j.z === 0) roll = Math.abs(j.x - rollStart);
        if (ph === 'sortie') vmax = Math.max(vmax, j.sortie!.v * TPS);
        for (const e of w.drainEvents()) if (e.t === 'sortie' && e.what === 'release') release = w.tick;
      }
      return { vmax, roll, release };
    };
    const f35 = run('usa');
    const j20 = run('china');
    expect(f35.vmax).toBeCloseTo(6.0, 1);
    expect(j20.vmax).toBeCloseTo(5.0, 1);
    expect(Math.abs(f35.roll - j20.roll)).toBeLessThan(0.15);
    expect(f35.roll).toBeLessThan(5);
    expect(f35.release).toBeLessThan(j20.release);
  });

  it('enemy air defences acquire an airborne F-35 only within 60% of their range (not the J-20, not on the ground)', () => {
    const { w } = airWorld();
    const aa = w.spawnUnit('russia_aa', 1, 50, 50);
    const sam = w.spawnBuilding('russia_def_aa', 1, 60, 50, true);
    const f35 = w.spawnUnit('usa_fighter', 0, 0, 0);
    const j20 = w.spawnUnit('china_fighter', 0, 0, 0);
    const flak = WEAPONS[unitDef('russia_aa').weapon!];
    const s400 = WEAPONS.s400;
    for (const j of [f35, j20]) j.z = j.pz = 2.6;
    expect(lowObsFactor(w, flak, f35)).toBeCloseTo(0.6);
    expect(lowObsFactor(w, flak, j20)).toBe(1);
    expect(rangeVs(w, aa, flak, f35)).toBeCloseTo(w.weaponRange(aa, flak) * 0.6);
    expect(rangeVs(w, sam, s400, f35)).toBeCloseTo(w.weaponRange(sam, s400) * 0.6);
    expect(rangeVs(w, aa, flak, j20)).toBeCloseTo(w.weaponRange(aa, flak));
    // ground weapons and grounded jets are unaffected
    expect(lowObsFactor(w, WEAPONS.cannon, f35)).toBe(1);
    const ww = w as unknown as { findTarget(e: Entity, r: number): Entity | null; rebuildGrid(): void };
    const find = (e: Entity, r: number) => {
      w.updateVisibility();
      ww.rebuildGrid();
      return ww.findTarget(e, r);
    };
    const place = (j: Entity, x: number, y: number) => {
      j.x = j.px = x;
      j.y = j.py = y;
    };
    const R = w.weaponRange(aa, flak);
    // one aircraft at a time, at 80% of the flak range: the J-20 is engaged, the F-35 is not
    place(f35, 50 + R * 0.8, 50);
    place(j20, 5, 5);
    expect(find(aa, 12)).toBeNull();
    place(f35, 5, 5);
    place(j20, 50 + R * 0.8, 50);
    expect(find(aa, 12)?.id).toBe(j20.id);
    // inside 60%: the F-35 is fair game
    place(j20, 5, 5);
    place(f35, 50 + R * 0.5, 50);
    expect(find(aa, 12)?.id).toBe(f35.id);
    // the S-400 (13 tiles) picks it up at 7.8, not at 10
    const S = w.weaponRange(sam, s400);
    place(f35, 60.5 + S * 0.77, 50.5);
    expect(find(sam, S)).toBeNull();
    place(f35, 60.5 + S * 0.5, 50.5);
    expect(find(sam, S)?.id).toBe(f35.id);
  });

  it('a flak gun at an F-35 inside its reduced range keeps firing and still shoots it down eventually', () => {
    const { w } = airWorld(3, ['usa', 'russia'], false);
    const aa = w.spawnUnit('russia_aa', 1, 50, 50);
    aa.stance = 'hold';
    const f35 = w.spawnUnit('usa_fighter', 0, 51.5, 50); // homeless: circles at cruise altitude near (51.5, 50)
    let fired = 0;
    for (let i = 0; i < TPS * 60 && !f35.dead; i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'fire' && e.id === aa.id) fired++;
    }
    expect(fired).toBeGreaterThan(0);
    expect(f35.dead).toBe(true);
  });

  it('~30% of shots at an airborne F-35 miss (seeded), identically on every client; none at the J-20', () => {
    const roll = (seed: number) => {
      const { w } = airWorld(seed);
      const f35 = w.spawnUnit('usa_fighter', 0, 30, 30);
      f35.z = 2.6;
      const out: boolean[] = [];
      for (let i = 0; i < 4000; i++) out.push(evades(w, WEAPONS.flak, f35));
      return out;
    };
    const a = roll(11);
    const b = roll(11);
    expect(a).toEqual(b);
    const rate = a.filter(Boolean).length / a.length;
    expect(rate).toBeGreaterThan(0.27);
    expect(rate).toBeLessThan(0.33);
    const { w } = airWorld(11);
    const j20 = w.spawnUnit('china_fighter', 0, 30, 30);
    j20.z = 2.6;
    expect(evasionChance(w, WEAPONS.flak, j20)).toBe(0);
    const f35 = w.spawnUnit('usa_fighter', 0, 30, 30);
    f35.z = 2.6;
    expect(evasionChance(w, WEAPONS.cannon, f35)).toBe(0); // ground weapon
    f35.sortie = { phase: 'parked' } as Entity['sortie'];
    f35.z = 0;
    expect(evasionChance(w, WEAPONS.flak, f35)).toBe(0); // on its wheels
  });

  it('a fooled missile turns onto the decoy flare and bursts on it; the rest hit the jet - deterministic', () => {
    const fly = (seed: number) => {
      const { w } = airWorld(seed, ['usa', 'russia'], false);
      const site = w.spawnBuilding('russia_def_aa', 1, 60, 50, true);
      site.cooldown = 1e9; // the site itself stays quiet: only our test missiles
      const res: string[] = [];
      let decoys = 0;
      let bursts = 0;
      let hits = 0;
      const away: number[] = [];
      for (let k = 0; k < 60; k++) {
        const jet = w.spawnUnit('usa_fighter', 0, 64, 50 + (k % 3));
        jet.z = jet.pz = 2.6;
        jet.maxHp = jet.hp = 1e6;
        const p = launch(w, site, jet, WEAPONS.s400, jet.x, jet.y);
        const fooled = p.decoy === 1;
        let decoyAt: { x: number; y: number; z: number; jx: number; jy: number } | null = null;
        let burstAt: { x: number; y: number; z: number } | null = null;
        for (let i = 0; i < TPS * 8 && !p.dead; i++) {
          w.step(); // the homeless jet circles at cruise altitude
          for (const e of w.drainEvents()) {
            if (e.t === 'decoy' && e.proj === p.id) decoyAt = { x: e.x, y: e.y, z: e.z, jx: jet.x, jy: jet.y };
            if (e.t === 'airburst' && e.decoy) burstAt = { x: e.x, y: e.y, z: e.z };
          }
        }
        expect(p.dead).toBe(true);
        if (fooled) {
          decoys++;
          expect(decoyAt).not.toBeNull();
          expect(burstAt).not.toBeNull();
          expect(jet.hp).toBe(1e6);
          bursts++;
          // the flare leaves the jet itself; the missile bursts on the flare, away from the jet
          expect(Math.hypot(decoyAt!.x - decoyAt!.jx, decoyAt!.y - decoyAt!.jy)).toBeLessThan(0.6);
          away.push(Math.hypot(burstAt!.x - jet.x, burstAt!.y - jet.y, burstAt!.z - entityZ(w, jet)));
        } else if (jet.hp < 1e6) hits++;
        res.push(`${fooled ? 'D' : 'H'}${Math.round(jet.hp)}`);
        w.kill(jet, -1);
      }
      return { res, decoys, bursts, hits, away };
    };
    const a = fly(5);
    const b = fly(5);
    expect(a.res).toEqual(b.res);
    expect(a.decoys).toBeGreaterThan(8);
    expect(a.decoys).toBeLessThan(30);
    expect(a.bursts).toBe(a.decoys);
    expect(a.hits).toBeGreaterThan(30);
    // the bursts happen out on the flares, mostly well clear of the jet
    const sorted = [...a.away].sort((x, y) => x - y);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(0.6);
  });
});
