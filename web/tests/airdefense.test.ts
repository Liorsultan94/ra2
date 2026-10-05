import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { parkJet } from '../src/sim/airbase';
import { launch } from '../src/sim/ballistics';
import { WEAPONS, airReach, unitDef } from '../src/sim/defs';
import { enterGarrison, isGarrison } from '../src/sim/garrison';
import { evasionChance, lowObsFactor, rangeVs } from '../src/sim/stealth';
import { TPS, type Command, type Entity, type Faction, type SimEvent } from '../src/sim/types';
import { WEAPON_SWAP, World } from '../src/sim/world';

/** Two human players, starting forces cleared. */
function arena(seed = 5, a: Faction = 'usa', b: Faction = 'russia', autoDefend = false) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: a, color: 0, isAI: false, autoDefend },
      { name: 'B', faction: b, color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding(`${a}_conyard`, 0, 4, 88, true);
  w.spawnBuilding(`${b}_conyard`, 1, 88, 4, true);
  return w;
}

function at(w: World, def: string, owner: number, x: number, y: number) {
  const p = w.nearestPassable(x, y)!;
  return w.spawnUnit(def, owner, p[0] + 0.5, p[1] + 0.5);
}

/** An aircraft hovering / circling at its cruise altitude that never shoots back. */
function aircraft(w: World, def: string, owner: number, x: number, y: number) {
  const a = w.spawnUnit(def, owner, x, y);
  a.z = a.pz = unitDef(def).cruiseAlt ?? 1.7;
  a.stance = 'holdFire';
  return a;
}

function run(w: World, ticks: number, onEv?: (e: SimEvent) => void) {
  for (let i = 0; i < ticks; i++) {
    w.step();
    for (const e of w.drainEvents()) onEv?.(e);
  }
}

describe('only air defence can engage aircraft', () => {
  it('rifle, MG, autocannon and RPG weapons are ground-only; dedicated AA and air-to-air keep their reach', () => {
    for (const id of ['rifle', 'mgHeavy', 'atRocket', 'autocannon', 'sniper', 'cannon']) expect(WEAPONS[id].air).toBe('no');
    for (const id of ['flak', 'sam', 'patriot', 's400', 'ironDome', 'irisT', 'manpads']) expect(WEAPONS[id].air).toBe('only');
    expect(WEAPONS.laser.air).toBe('yes'); // DE M-SHORAD: an air-defence vehicle
    expect(WEAPONS.airMissile.air).toBe('yes');
    // per-unit reach (main + secondary weapon)
    for (const f of ['usa', 'russia', 'israel', 'iran', 'ukraine', 'korea']) {
      for (const k of ['rifle', 'apc', 'mbt']) expect(airReach(unitDef(`${f}_${k}`))).toBe('no');
      expect(airReach(unitDef(`${f}_at`))).toBe('yes');
    }
    expect(airReach(unitDef('ukraine_ewinf'))).toBe('no');
    expect(airReach(unitDef('russia_robot'))).toBe('no'); // Uran-9 autocannon
    expect(airReach(unitDef('israel_ugv'))).toBe('no'); // Jaguar MG
  });

  it('riflemen, MGs, IFVs, IFV passengers and garrisons never fire at an airborne helicopter, jet or UAV, but still fight ground targets', () => {
    const w = arena(7);
    const house = w.list.find((e) => isGarrison(e))!;
    expect(house).toBeTruthy();
    const cx = house.x;
    const cy = house.y;
    const ours: Entity[] = [];
    for (let i = 0; i < 3; i++) ours.push(at(w, 'usa_rifle', 0, cx - 2 + i, cy + 2));
    ours.push(at(w, 'usa_robot', 0, cx + 2, cy + 2)); // MG
    const apc = at(w, 'usa_apc', 0, cx - 2, cy + 4.5);
    const rider = at(w, 'usa_rifle', 0, cx - 2, cy + 4.5);
    w.board(rider, apc);
    ours.push(apc, rider);
    const g = at(w, 'usa_rifle', 0, cx, cy + 3);
    expect(enterGarrison(w, g, house)).toBe(true);
    ours.push(g);
    const bunker = w.spawnBuilding('usa_def_gun', 0, Math.floor(cx) + 3, Math.floor(cy) + 5, true);
    ours.push(bunker);
    const air = [aircraft(w, 'russia_heli', 1, cx + 1, cy), aircraft(w, 'russia_uav', 1, cx - 1, cy + 1), aircraft(w, 'russia_fighter', 1, cx, cy - 1)];
    const hp0 = air.map((a) => a.hp);
    const ids = new Set(ours.map((e) => e.id));
    let fired = 0;
    run(w, TPS * 12, (e) => {
      if (e.t === 'fire' && ids.has(e.id)) fired++;
    });
    expect(fired).toBe(0);
    air.forEach((a, i) => expect(a.hp).toBe(hp0[i]));
    for (const e of ours) if (e.kind === 'unit') expect(e.targetId < 0 || !w.isAir(w.get(e.targetId)!)).toBe(true);
    // an explicit attack order on an aircraft is refused
    w.issue(0, { type: 'attack', ids: ours.filter((e) => e.kind === 'unit').map((e) => e.id), target: air[0].id });
    run(w, 2);
    for (const e of ours) if (e.kind === 'unit') expect(e.order.type).not.toBe('attack');
    // a soldier on the ground is a fair target for all of them
    const foe = at(w, 'russia_rifle', 1, cx + 0.5, cy + 3.5);
    foe.hp = foe.maxHp = 1e5;
    foe.stance = 'holdFire';
    const shooters = new Set<number>();
    run(w, TPS * 6, (e) => {
      if (e.t === 'fire' && ids.has(e.id) && e.targetId === foe.id) shooters.add(e.id);
    });
    expect(foe.hp).toBeLessThan(1e5);
    for (const e of [ours[0], rider, g, bunker]) expect(shooters.has(e.id)).toBe(true);
    air.forEach((a, i) => expect(a.hp).toBe(hp0[i]));
  });

  it('a jet on its wheels is still a ground target (rifles, RPGs), but not for the AA missile', () => {
    const w = arena(3);
    const af = w.spawnBuilding('russia_airfield', 1, 30, 40, true);
    const j = w.spawnUnit('russia_fighter', 1, af.x, af.y);
    expect(parkJet(w, j, af)).toBe(true);
    expect(w.isAir(j)).toBe(false);
    for (const id of ['rifle', 'mgHeavy', 'atRocket', 'autocannon', 'cannon']) expect(w.canHit(WEAPONS[id], j)).toBe(true);
    expect(w.canHit(WEAPONS.manpads, j)).toBe(false);
    expect(w.weaponVs('usa_at', j)?.id).toBe('atRocket'); // the Rocket Team uses its RPG on it
    const r = at(w, 'usa_rifle', 0, j.x - 3, j.y);
    w.issue(0, { type: 'attack', ids: [r.id], target: j.id });
    const hp = j.hp;
    run(w, TPS * 4);
    expect(j.hp).toBeLessThan(hp);
  });
});

describe('Rocket Team (AT/AA): RPG for the ground, shoulder-fired missile for the air', () => {
  it('is one unit with both weapons, named and described for both roles', () => {
    for (const f of ['usa', 'israel', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran']) {
      const d = unitDef(`${f}_at`);
      expect(d.weapon).toMatch(/atRocket/);
      expect(d.weapon2).toMatch(/manpads/);
      expect(d.name).toBe('Rocket Team (AT/AA)');
      expect(d.desc).toMatch(/helicopters, jets and drones/);
      expect(unitDef(`${f}_manpads`)).toBeUndefined(); // no separate MANPADS unit
    }
    expect(WEAPONS.manpads.range).toBe(7);
    expect(WEAPONS.manpads.rof).toBeGreaterThanOrEqual(3 * TPS);
    expect(unitDef('iran_fighter')).toBeUndefined(); // Iran still has no jets
  });

  it('fires the guided missile (never the RPG) at a helicopter and downs it in 2-3 hits', () => {
    for (const [heli, maxHits] of [
      ['russia_heli', 3], // Ka-52, 420 hp
      ['iran_heli', 2], // AH-1J, 360 hp
      ['ukraine_heli', 3], // Mi-24, 520 hp
    ] as const) {
      const w = arena(11, 'usa', heli.split('_')[0] as Faction);
      const team = at(w, 'usa_at', 0, 40, 40);
      const h = aircraft(w, heli, 1, team.x + 4, team.y);
      const weapons: string[] = [];
      let hits = 0;
      let last = h.hp;
      run(w, TPS * 25, (e) => {
        if (e.t === 'fire' && e.id === team.id) weapons.push(e.weapon);
        if (h.hp < last) {
          hits++;
          last = h.hp;
        }
      });
      expect(h.dead).toBe(true);
      expect(new Set(weapons)).toEqual(new Set(['manpads']));
      expect(hits).toBeGreaterThanOrEqual(2);
      expect(hits).toBeLessThanOrEqual(maxHits);
    }
  });

  it('uses the RPG on tanks, the missile on aircraft (air first), one launcher at a time, each with its own reload', () => {
    const w = arena(13);
    const team = at(w, 'usa_at', 0, 40, 40);
    team.hp = team.maxHp = 1e5;
    const tank = at(w, 'russia_mbt', 1, team.x + 4, team.y + 1);
    tank.hp = tank.maxHp = 1e5;
    tank.stance = 'holdFire';
    const heli = aircraft(w, 'russia_heli', 1, team.x + 3, team.y - 2);
    heli.hp = heli.maxHp = 1e5;
    const shots: { tick: number; weapon: string; target: number }[] = [];
    const rec = (e: SimEvent) => {
      if (e.t === 'fire' && e.id === team.id) shots.push({ tick: w.tick, weapon: e.weapon, target: e.targetId });
    };
    // both in range: the air threat first, and it stays on the target it is engaged with
    run(w, TPS * 12, rec);
    expect(shots.length).toBeGreaterThanOrEqual(3);
    for (const s of shots) expect(s.weapon === 'manpads' && s.target === heli.id).toBe(true);
    for (let i = 1; i < shots.length; i++) expect(shots[i].tick - shots[i - 1].tick).toBeGreaterThanOrEqual(WEAPONS.manpads.rof);
    // the helicopter goes down just after a missile left the tube
    const n0 = shots.length;
    for (let i = 0; i < TPS * 5 && shots.length === n0; i++) run(w, 1, rec);
    const lastAA = shots[shots.length - 1];
    expect(lastAA.weapon).toBe('manpads');
    w.kill(heli, 0);
    const n = shots.length;
    run(w, TPS * 10, rec);
    const rpg = shots.slice(n);
    expect(rpg.length).toBeGreaterThanOrEqual(3);
    expect(rpg.every((s) => s.weapon === 'atRocket' && s.target === tank.id)).toBe(true);
    // one launcher at a time (swap delay), but the RPG does not wait for the missile's 3.5 s reload
    expect(rpg[0].tick - lastAA.tick).toBeGreaterThanOrEqual(WEAPON_SWAP);
    expect(rpg[0].tick - lastAA.tick).toBeLessThan(WEAPONS.manpads.rof);
    for (let i = 1; i < rpg.length; i++) expect(rpg[i].tick - rpg[i - 1].tick).toBeGreaterThanOrEqual(WEAPONS.atRocket.rof);
    expect(tank.hp).toBeLessThan(1e5);
  });

  it('against a fast jet the small warhead needs about 4 hits', () => {
    const w = arena(17, 'usa', 'china');
    const team = at(w, 'usa_at', 0, 40, 40);
    team.cooldown2 = 1e9; // only the test's missiles
    const jet = aircraft(w, 'china_fighter', 1, 43, 40); // J-20: not stealthy, no flares
    let hits = 0;
    for (let k = 0; k < 10 && !jet.dead; k++) {
      const hp = jet.hp;
      const p = launch(w, team, jet, WEAPONS.manpads, jet.x, jet.y);
      for (let i = 0; i < TPS * 6 && !p.dead; i++) w.step();
      w.drainEvents();
      if (jet.hp < hp) hits++;
    }
    expect(jet.dead).toBe(true);
    expect(hits).toBe(4);
  });

  it('F-35 stealth and decoy flares apply to it: 60% lock-on range, 30% of missiles fooled (seeded)', () => {
    const w = arena(19);
    const team = at(w, 'russia_at', 1, 40, 40);
    const f35 = aircraft(w, 'usa_fighter', 0, 45, 40);
    const j20 = w.spawnUnit('china_fighter', 0, 45, 41);
    j20.z = 2.6;
    const mp = WEAPONS[unitDef('russia_at').weapon2!];
    expect(lowObsFactor(w, mp, f35)).toBeCloseTo(0.6);
    expect(rangeVs(w, team, mp, f35)).toBeCloseTo(w.weaponRange(team, mp) * 0.6);
    expect(rangeVs(w, team, mp, j20)).toBeCloseTo(w.weaponRange(team, mp));
    expect(evasionChance(w, mp, f35)).toBeCloseTo(0.3);
    expect(evasionChance(w, mp, j20)).toBe(0);
    const fooled = (seed: number) => {
      const ww = arena(seed);
      const t = at(ww, 'russia_at', 1, 40, 40);
      t.cooldown2 = 1e9;
      const out: number[] = [];
      for (let k = 0; k < 60; k++) out.push(launch(ww, t, f35, mp, f35.x, f35.y).decoy);
      return out;
    };
    const a = fooled(23);
    expect(a).toEqual(fooled(23));
    const n = a.filter((d) => d === 1).length;
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(30);
    // in play: a stealth jet 5 tiles out (inside 7, outside 7 x 0.6) is not engaged; at 3.5 it is
    const w2 = arena(29);
    const g = at(w2, 'russia_at', 1, 40, 40);
    const jet = aircraft(w2, 'usa_fighter', 0, g.x + 5, g.y);
    const ww = w2 as unknown as { findTarget(e: Entity, r: number): Entity | null; rebuildGrid(): void };
    const find = () => {
      w2.updateVisibility();
      ww.rebuildGrid();
      return ww.findTarget(g, 8);
    };
    expect(find()).toBeNull();
    jet.x = jet.px = g.x + 3.5;
    expect(find()?.id).toBe(jet.id);
  });
});

describe('base defence and AI against aircraft', () => {
  it('auto base defence never sends ground-only units at a helicopter; Rocket Teams answer it', () => {
    const w = arena(31, 'usa', 'russia', true);
    const plant = w.spawnBuilding('usa_power', 0, 20, 80, true);
    plant.hp = plant.maxHp = 1e6;
    const rifles = [at(w, 'usa_rifle', 0, 15, 75), at(w, 'usa_rifle', 0, 16, 75), at(w, 'usa_mbt', 0, 14, 77)];
    const team = at(w, 'usa_at', 0, 15, 82);
    const heli = w.spawnUnit('russia_heli', 1, 26, 81);
    heli.hp = heli.maxHp = 1e5;
    w.issue(1, { type: 'attack', ids: [heli.id], target: plant.id });
    let aaShots = 0;
    for (let i = 0; i < TPS * 25 && plant.lastHurt < 0; i++) run(w, 1);
    expect(plant.lastHurt).toBeGreaterThan(0);
    run(w, TPS * 8, (e) => {
      if (e.t === 'fire' && e.id === team.id && e.weapon === 'manpads') aaShots++;
    });
    for (const r of rifles) {
      expect(r.defend).toBeNull();
      expect(r.order.type).not.toBe('attack');
    }
    expect(aaShots).toBeGreaterThan(0);
  });

  it('the AI builds more Rocket Teams (and AA) when the enemy flies, and counts them as anti-air', () => {
    const picks = (enemyAir: number) => {
      const w = arena(37, 'germany', 'turkey');
      const ai = new AIController(w, 0, 'hard');
      w.spawnBuilding('germany_power', 0, 10, 80, true);
      w.spawnBuilding('germany_barracks', 0, 14, 80, true);
      w.spawnBuilding('germany_factory', 0, 10, 74, true);
      for (let i = 0; i < enemyAir; i++) aircraft(w, 'turkey_uav', 1, 80, 10 + i);
      const counts = new Map<string, number>();
      const orig = w.issue.bind(w);
      w.issue = (pid: number, c: Command) => {
        if (pid === 0 && c.type === 'produce') counts.set(c.def, (counts.get(c.def) ?? 0) + 1);
        orig(pid, c);
      };
      const mp = ai as unknown as { manageProduction(b: Entity[], u: Entity[]): void };
      for (let k = 0; k < 400; k++) {
        w.players[0].credits = 1e5;
        for (const q of Object.values(w.players[0].queues)) q.length = 0;
        const own = w.list.filter((e) => !e.dead && e.owner === 0);
        mp.manageProduction(
          own.filter((e) => e.kind === 'building'),
          own.filter((e) => e.kind === 'unit'),
        );
      }
      const inf = [...counts].filter(([id]) => unitDef(id)?.category === 'infantry').reduce((s, [, n]) => s + n, 0);
      return { at: (counts.get('germany_at') ?? 0) / inf, aa: counts.get('germany_aa') ?? 0 };
    };
    const calm = picks(0);
    const air = picks(4);
    expect(air.at).toBeGreaterThan(calm.at * 1.3);
    expect(air.aa).toBeGreaterThan(calm.aa * 3);
  });
});
