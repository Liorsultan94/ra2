import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { airdropStatus } from '../src/sim/airdrop';
import { buildingDef } from '../src/sim/defs';
import { GARRISON_RANGE, canGarrisonUnit } from '../src/sim/garrison';
import { IRON_BEAM_TICKS, SW_INFO } from '../src/sim/specialdefs';
import { SuperweaponAI, superweaponStatus } from '../src/sim/superweapons';
import { TPS, type Entity, type Faction, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Two players, starting forces cleared, a conyard + power each so nobody is defeated. */
function cleanWorld(a: Faction = 'usa', b: Faction = 'russia', seed = 21) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: a, color: 0, isAI: false },
      { name: 'B', faction: b, color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding(`${a}_conyard`, 0, 4, 88, true);
  w.spawnBuilding(`${b}_conyard`, 1, 88, 4, true);
  for (let i = 0; i < 3; i++) {
    w.spawnBuilding(`${a}_power`, 0, 8 + i * 3, 88, true);
    w.spawnBuilding(`${b}_power`, 1, 80 - i * 3, 4, true);
  }
  return w;
}

const houses = (w: World) => w.list.filter((e) => !e.dead && e.kind === 'building' && !!buildingDef(e.def).garrison);
const run = (w: World, ticks: number, onEv?: (e: SimEvent) => void) => {
  for (let i = 0; i < ticks; i++) {
    w.step();
    const ev = w.drainEvents();
    if (onEv) for (const e of ev) onEv(e);
  }
};

/** A house of player 0's village (civ_house at 25,49) and riflemen next to it. */
function garrisonSetup(w: World, n = 6, def = 'usa_rifle') {
  const house = houses(w).find((h) => h.def === 'civ_house' && h.tx === 25 && h.ty === 49)!;
  const units: Entity[] = [];
  for (let i = 0; i < n; i++) units.push(w.spawnUnit(def, 0, 25.5 + (i % 3) * 0.4, 52.5 + Math.floor(i / 3) * 0.4));
  return { house, units };
}

describe('garrisonable civilian houses', () => {
  it('village houses are neutral entities on the blocked footprint; pathing unchanged', () => {
    const w = cleanWorld();
    const hs = houses(w);
    expect(hs.length).toBeGreaterThanOrEqual(10);
    for (const h of hs) {
      expect(h.owner).toBe(-1);
      const d = buildingDef(h.def);
      for (let y = h.ty; y < h.ty + d.h; y++) for (let x = h.tx; x < h.tx + d.w; x++) {
        expect(w.map.blocked[y * w.map.w + x]).toBe(1);
        expect(w.pass[y * w.map.w + x]).toBe(0);
      }
    }
    // neutral houses are not targets
    expect(w.isEnemy(0, hs[0].owner)).toBe(false);
  });

  it('infantry enter (up to capacity), the house flips to their side and they fire from the windows with a range bonus', () => {
    const w = cleanWorld();
    const { house, units } = garrisonSetup(w, 7);
    w.issue(0, { type: 'enter', ids: units.map((u) => u.id), target: house.id });
    run(w, TPS * 8);
    const cap = buildingDef(house.def).garrison!;
    expect(house.passengers.length).toBe(cap);
    expect(house.owner).toBe(0);
    expect(units.filter((u) => u.inside === house.id).length).toBe(cap);
    expect(units.filter((u) => u.inside < 0).length).toBe(1); // the 7th stays outside
    const inside = w.get(house.passengers[0])!;
    expect(w.weaponRange(inside, { range: 4.5 } as never)).toBeCloseTo(4.5 + GARRISON_RANGE + 1);
    // an enemy squad walks up: the garrison shoots, the enemy can only hurt the house
    const foes = [0, 1, 2].map((i) => w.spawnUnit('russia_rifle', 1, 26.5 + i * 0.4, 56.6));
    const hp0 = units.filter((u) => u.inside === house.id).map((u) => u.hp);
    let fromInside = 0;
    run(w, TPS * 25, (e) => {
      if (e.t === 'fire' && house.passengers.includes(e.id)) fromInside++;
    });
    expect(fromInside).toBeGreaterThan(3);
    expect(foes.filter((f) => !f.dead).length).toBeLessThan(3);
    expect(units.filter((u) => u.inside === house.id).map((u) => u.hp)).toEqual(hp0);
  });

  it('a destroyed house ejects its survivors (hurt) deterministically; an evacuated one turns neutral', () => {
    const play = () => {
      const w = cleanWorld();
      const { house, units } = garrisonSetup(w, 5);
      w.issue(0, { type: 'enter', ids: units.map((u) => u.id), target: house.id });
      run(w, TPS * 8);
      expect(house.passengers.length).toBe(5);
      const tank = w.spawnUnit('russia_mbt', 1, 40.5, 40.5);
      w.damage(house, house.maxHp * 10, 'cannon', tank);
      expect(house.dead).toBe(true);
      const out = units.filter((u) => !u.dead);
      expect(out.length).toBe(5);
      for (const u of out) {
        expect(u.inside).toBe(-1);
        expect(u.hp).toBeLessThan(u.maxHp);
        expect(w.pass[w.tileOf(u.x, u.y)]).toBe(1);
      }
      // rubble keeps blocking pathing
      expect(w.pass[house.ty * w.map.w + house.tx]).toBe(0);
      return out.map((u) => `${u.x.toFixed(4)},${u.y.toFixed(4)},${u.hp.toFixed(2)}`).join('|');
    };
    expect(play()).toBe(play());

    const w = cleanWorld();
    const { house, units } = garrisonSetup(w, 3);
    w.issue(0, { type: 'enter', ids: units.map((u) => u.id), target: house.id });
    run(w, TPS * 8);
    expect(house.owner).toBe(0);
    w.issue(0, { type: 'evacuate', id: house.id });
    run(w, 6);
    expect(house.passengers.length).toBe(0);
    expect(house.owner).toBe(-1);
    expect(units.every((u) => u.inside < 0)).toBe(true);
  });

  it('enemies and engineers cannot enter a held house; thermobaric hits burn the garrison', () => {
    const w = cleanWorld();
    const { house, units } = garrisonSetup(w, 2);
    w.issue(0, { type: 'enter', ids: units.map((u) => u.id), target: house.id });
    run(w, TPS * 8);
    expect(canGarrisonUnit('usa_engineer')).toBe(false);
    const foe = w.spawnUnit('russia_rifle', 1, 28.5, 52.5);
    const eng = w.spawnUnit('russia_engineer', 1, 28.5, 52.9);
    w.issue(1, { type: 'enter', ids: [foe.id], target: house.id });
    w.issue(1, { type: 'capture', ids: [eng.id], target: house.id });
    foe.hp = foe.maxHp = 1e6; // survive the garrison's fire
    eng.hp = eng.maxHp = 1e6;
    run(w, TPS * 6);
    expect(foe.inside).toBe(-1);
    expect(eng.dead).toBe(false);
    expect(house.owner).toBe(0);
    // thermobaric: the occupants burn too, and the house takes extra damage
    const tos = w.spawnUnit('russia_tos', 1, 40.5, 40.5);
    const hp0 = units.map((u) => u.hp);
    const h0 = house.hp;
    w.damage(house, 100, 'thermo', tos);
    expect(units[0].hp).toBeLessThan(hp0[0]);
    expect(h0 - house.hp).toBeGreaterThan(100 * 1.2);
    // ordinary rounds don't touch the occupants
    const hp1 = units.map((u) => u.hp);
    w.damage(house, 100, 'cannon', tos);
    expect(units.map((u) => u.hp)).toEqual(hp1);
  });
});

describe('capturable tech structures', () => {
  const tech = (w: World, def: string) => w.list.filter((e) => !e.dead && e.def === def).sort((a, b) => a.id - b.id);

  it('mirrored pairs of hospital, comms tower and airport stand on the map, neutral', () => {
    const w = cleanWorld();
    for (const id of ['tech_hospital', 'tech_comms', 'tech_airport']) {
      const [a, b] = tech(w, id);
      expect(a && b).toBeTruthy();
      expect(a.owner).toBe(-1);
      const d = buildingDef(id);
      expect(b.tx).toBe(w.map.w - a.tx - d.w);
      expect(b.ty).toBe(w.map.h - a.ty - d.h);
    }
  });

  it('an engineer captures (and is consumed); hospital heals, comms gives radar, airport speeds up the drop', () => {
    const w = cleanWorld();
    const [hosp] = tech(w, 'tech_hospital');
    const [comms] = tech(w, 'tech_comms');
    const [port] = tech(w, 'tech_airport');
    const engs = [hosp, comms, port].map((t) => w.spawnUnit('usa_engineer', 0, t.tx - 0.5, t.ty + 0.5));
    engs.forEach((e, i) => w.issue(0, { type: 'capture', ids: [e.id], target: [hosp, comms, port][i].id }));
    let captured = 0;
    run(w, TPS * 6, (e) => {
      if (e.t === 'captured' && e.owner === 0) captured++;
    });
    expect(captured).toBe(3);
    expect(engs.every((e) => e.dead)).toBe(true);
    expect([hosp, comms, port].every((t) => t.owner === 0)).toBe(true);
    // comms tower: radar online without a radar building
    expect(w.players[0].radarOnline).toBe(true);
    // hospital heals infantry nearby
    const hurt = w.spawnUnit('usa_rifle', 0, hosp.tx + 2.5, hosp.ty + 2.5);
    hurt.hp = 20;
    run(w, TPS * 3);
    expect(hurt.hp).toBeGreaterThan(20);
    // airport: the airborne drop charges 1.5x as fast
    w.spawnBuilding('usa_airfield', 0, 4, 83, true);
    run(w, 1);
    const a0 = airdropStatus(w, 0).secondsLeft;
    run(w, TPS * 20);
    const a1 = airdropStatus(w, 0).secondsLeft;
    expect(a0 - a1).toBeGreaterThanOrEqual(29);
    // civilian / tech buildings don't keep a player alive and can't be sold
    w.issue(0, { type: 'sell', id: hosp.id });
    run(w, 1);
    expect(hosp.dead).toBe(false);
  });
});

describe('superweapons', () => {
  const swDef = (f: Faction) => `${f}_superweapon`;

  it('every nation has one, built from the Battle Lab', () => {
    for (const f of ['usa', 'israel', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran'] as Faction[]) {
      const d = buildingDef(swDef(f));
      expect(d.superweapon).toBeTruthy();
      expect(d.prereq).toContain('tech');
    }
  });

  it('timer, warnings to everybody, validation, launch and cooldown (Dark Eagle)', () => {
    const w = cleanWorld();
    const ev: SimEvent[] = [];
    w.spawnBuilding(swDef('usa'), 0, 12, 82, true);
    run(w, 2, (e) => ev.push(e));
    expect(ev.some((e) => e.t === 'superweapon' && e.phase === 'detected' && e.owner === 0)).toBe(true);
    const st = superweaponStatus(w, 0);
    expect(st.unlocked).toBe(true);
    expect(st.ready).toBe(false);
    expect(st.secondsLeft).toBeGreaterThan(6 * 60);
    // not ready: rejected
    w.issue(0, { type: 'superweapon', x: 80, y: 10 });
    run(w, 2, (e) => ev.push(e));
    expect(ev.some((e) => e.t === 'superweapon' && e.phase === 'launch')).toBe(false);
    // charge it
    w.players[0].sw.at = w.tick + 3;
    run(w, 5, (e) => ev.push(e));
    expect(ev.some((e) => e.t === 'superweapon' && e.phase === 'ready')).toBe(true);
    // bad coordinates: rejected
    w.issue(0, { type: 'superweapon', x: -5, y: 10 });
    w.issue(0, { type: 'superweapon', x: NaN, y: 10 });
    run(w, 1);
    expect(superweaponStatus(w, 0).ready).toBe(true);
    // fire at the enemy base: three hypersonic glide vehicles
    const target = w.list.find((e) => !e.dead && e.def === 'russia_conyard')!;
    let launches = 0;
    let impacts = 0;
    w.issue(0, { type: 'superweapon', x: target.x, y: target.y });
    run(w, TPS * 25, (e) => {
      ev.push(e);
      if (e.t === 'launch' && e.weapon === 'sw_darkEagle') launches++;
      if (e.t === 'impact' && e.weapon === 'sw_darkEagle') impacts++;
    });
    expect(launches).toBe(3);
    expect(impacts).toBe(3);
    expect(target.dead).toBe(true);
    const st2 = superweaponStatus(w, 0);
    expect(st2.ready).toBe(false);
    expect(st2.secondsLeft).toBeGreaterThan(SW_INFO.darkEagle.charge / TPS - 30);
  });

  it('charging pauses on low power and the timer is lost with the structure', () => {
    const w = cleanWorld();
    const b = w.spawnBuilding(swDef('usa'), 0, 12, 82, true);
    run(w, 2);
    const at = w.players[0].sw.at;
    // knock out the power plants
    for (const e of w.list) if (!e.dead && e.owner === 0 && e.def.endsWith('_power')) w.kill(e, -1);
    run(w, TPS * 5);
    expect(w.players[0].sw.at).toBeGreaterThan(at + TPS * 4);
    let lost = false;
    w.kill(b, 1);
    run(w, 2, (e) => {
      if (e.t === 'superweapon' && e.phase === 'lost') lost = true;
    });
    expect(lost).toBe(true);
    expect(superweaponStatus(w, 0).unlocked).toBe(false);
  });

  it('Iron Beam burns ballistic missiles and drones out of the sky inside the dome', () => {
    const w = cleanWorld('israel', 'iran', 31);
    w.spawnBuilding(swDef('israel'), 0, 12, 82, true);
    const target = w.spawnBuilding('israel_barracks', 0, 30, 70, true);
    target.hp = target.maxHp = 1e7;
    run(w, 2);
    w.players[0].sw.at = w.tick;
    w.issue(0, { type: 'superweapon', x: 30, y: 70 });
    run(w, 2);
    expect(w.players[0].sw.beam).not.toBeNull();
    // Iranian Kheibar salvo + a drone pack at the barracks
    w.spawnBuilding(swDef('iran'), 1, 80, 10, true);
    run(w, 2);
    w.players[1].sw.at = w.tick;
    w.issue(1, { type: 'superweapon', x: 31, y: 71 });
    for (let i = 0; i < 4; i++) {
      const d = w.spawnUnit('iran_shahed', 1, 40 + i * 0.5, 60);
      d.z = 2;
      d.targetId = target.id;
      d.order = { type: 'attack', target: target.id };
    }
    let beamed = 0;
    let impacts = 0;
    let zaps = 0;
    run(w, Math.min(IRON_BEAM_TICKS - 10, TPS * 25), (e) => {
      if (e.t === 'airburst' && e.weapon === 'sw_ironBeam' && e.kind === 'kill') beamed++;
      if (e.t === 'impact' && (e.weapon === 'sw_kheibar' || e.weapon === 'sw_fattah' || e.weapon.includes('shahed'))) impacts++;
      if (e.t === 'superweapon' && e.phase === 'beam') zaps++;
    });
    expect(beamed).toBe(6);
    expect(impacts).toBe(0);
    expect(zaps).toBeGreaterThanOrEqual(10);
    expect(w.list.filter((e) => !e.dead && e.def === 'iran_shahed').length).toBe(0);
    expect(target.hp).toBe(1e7);
  });

  it('every nation fires its superweapon and it does damage (and the full game stays deterministic)', () => {
    const play = (f: Faction) => {
      const w = cleanWorld(f, 'russia', 5);
      w.spawnBuilding(swDef(f), 0, 12, 82, true);
      const victims: Entity[] = [];
      for (let i = 0; i < 4; i++) victims.push(w.spawnBuilding('russia_barracks', 1, 62 + (i % 2) * 3, 30 + Math.floor(i / 2) * 3, true));
      for (let i = 0; i < 4; i++) victims.push(w.spawnUnit('russia_mbt', 1, 61.5 + i, 36.5));
      run(w, 2);
      w.players[0].sw.at = w.tick;
      w.players[1].visible.fill(1);
      w.issue(0, { type: 'superweapon', x: 64, y: 33 });
      run(w, TPS * 45);
      const hurt = victims.reduce((s, v) => s + (v.dead ? v.maxHp : v.maxHp - v.hp), 0);
      return { hurt, snap: w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.hp.toFixed(1)}`).join('|') };
    };
    for (const f of ['usa', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran'] as Faction[]) {
      const a = play(f);
      expect(a.hurt, f).toBeGreaterThan(400);
      if (f === 'china' || f === 'iran') expect(play(f).snap).toBe(a.snap);
    }
  }, 60_000);

  it('AI builds and uses superweapons; AI games with them stay deterministic', () => {
    const game = () => {
      const w = new World({
        seed: 13,
        credits: 40000,
        players: [
          { name: 'A', faction: 'turkey', color: 0, isAI: true },
          { name: 'B', faction: 'china', color: 0, isAI: true },
        ],
      });
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'), new SuperweaponAI(w, 0), new SuperweaponAI(w, 1));
      let built = 0;
      let launched = 0;
      for (let t = 0; t < TPS * 60 * 11 && !w.over; t++) {
        w.step();
        // speed the timers up once both have the structure (test time)
        for (const p of w.players) if (p.sw.at > w.tick + TPS * 20) p.sw.at = w.tick + TPS * 20;
        for (const e of w.drainEvents()) {
          if (e.t === 'superweapon' && e.phase === 'detected') built++;
          if (e.t === 'superweapon' && e.phase === 'launch') launched++;
        }
      }
      const snap = w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.hp.toFixed(1)}:${e.owner}`).join('|');
      return { built, launched, snap, credits: w.players.map((p) => Math.round(p.credits)) };
    };
    const a = game();
    const b = game();
    expect(a.built).toBeGreaterThanOrEqual(1);
    expect(a.launched).toBeGreaterThanOrEqual(1);
    expect(a.snap).toBe(b.snap);
    expect(a.credits).toEqual(b.credits);
  }, 120_000);
});
