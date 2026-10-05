import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { detectionRange, hitThreat, launch } from '../src/sim/ballistics';
import { AIRDROP_COOLDOWN, AIRDROP_FIRST, airdropStatus } from '../src/sim/airdrop';
import { WEAPONS, buildingDef, unitDef } from '../src/sim/defs';
import { Tile, terrainPassable } from '../src/sim/map';
import { BRIDGE_DEF, BRIDGE_HP, BRIDGE_HUT_DEF, BRIDGE_REPAIR_TICKS, bankOf, bridgeImpact, hurtBridge, pathCrosses } from '../src/sim/bridges';
import { PathFinder } from '../src/sim/path';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';
import { ELITE, RANK_ARMOR, RANK_FIREPOWER, RANK_ROF, VETERAN, canRank, rankFor, rankThreshold } from '../src/sim/veterancy';

function aiWorld(seed = 1) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: 'usa', color: 0x2f7dff, isAI: true },
      { name: 'B', faction: 'russia', color: 0xe0322b, isAI: true },
    ],
  });
  w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
  return w;
}

describe('map', () => {
  it('connects both start positions by land', () => {
    const w = new World({ players: [{ name: 'A', faction: 'usa', color: 0, isAI: true }] });
    const m = w.map;
    const pass = new Uint8Array(m.w * m.h);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) pass[y * m.w + x] = terrainPassable(m, x, y) ? 1 : 0;
    const pf = new PathFinder(m.w, m.h, pass);
    const [a, b] = m.starts;
    const path = pf.find(a.x, a.y, b.x, b.y, 100000);
    const last = path[path.length - 1];
    expect(last).toBe(b.y * m.w + b.x);
  });
});

describe('simulation', () => {
  it('is deterministic', () => {
    const a = aiWorld(7);
    const b = aiWorld(7);
    for (let i = 0; i < TPS * 120; i++) {
      a.step();
      b.step();
    }
    const snap = (w: World) => w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}`).join('|');
    expect(snap(a)).toBe(snap(b));
    expect(a.players.map((p) => p.credits)).toEqual(b.players.map((p) => p.credits));
  }, 60000);

  it('AI builds a base, harvests and fights', () => {
    const w = aiWorld(3);
    let fired = 0;
    let deaths = 0;
    for (let i = 0; i < TPS * 60 * 14 && !w.over; i++) {
      w.step();
      for (const e of w.drainEvents()) {
        if (e.t === 'fire') fired++;
        if (e.t === 'death') deaths++;
      }
      if (i === TPS * 240) {
        for (const p of w.players) {
          const roles = w.list.filter((e) => !e.dead && e.owner === p.id && e.kind === 'building').map((e) => buildingDef(e.def).role);
          console.log(p.name, 'at 4min', roles.join(','), 'credits', Math.round(p.credits), 'harvested', p.stats.harvested);
          expect(roles).toContain('refinery');
          expect(roles).toContain('factory');
          expect(p.stats.harvested).toBeGreaterThan(0);
        }
      }
    }
    for (const p of w.players) console.log(p.name, JSON.stringify(p.stats), 'defeated', p.defeated);
    console.log('tick', w.tick, 'over', w.over, 'winner', w.winner, 'fired', fired, 'deaths', deaths);
    expect(fired).toBeGreaterThan(50);
    expect(deaths).toBeGreaterThan(10);
  }, 120000);
});

describe('factions', () => {
  it('every faction can play a full AI game', () => {
    const ids = ['usa', 'israel', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran'] as const;
    const wins: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 4) % ids.length];
      const w = new World({
        seed: 11 + i,
        players: [
          { name: a, faction: a, color: 0, isAI: true },
          { name: b, faction: b, color: 0, isAI: true },
        ],
      });
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      const built = new Set<string>();
      for (let t = 0; t < TPS * 60 * 16 && !w.over; t++) {
        w.step();
        for (const e of w.drainEvents()) if (e.t === 'unitReady') built.add(e.def);
      }
      const winner = w.over ? w.players[w.winner]?.name ?? 'draw' : 'timeout';
      wins[winner] = (wins[winner] ?? 0) + 1;
      console.log(`${a} vs ${b}: ${winner} @${Math.round(w.tick / TPS / 60)}min built=${[...built].join(',')}`);
    }
    console.log(JSON.stringify(wins));
  }, 300000);
});

describe('special mechanics', () => {
  function duel() {
    const w = new World({
      seed: 5,
      players: [
        { name: 'A', faction: 'israel', color: 0, isAI: false },
        { name: 'B', faction: 'ukraine', color: 0, isAI: false },
      ],
    });
    // clear starting forces
    for (const e of w.list) if (e.owner >= 0) e.dead = true;
    w.list = w.list.filter((e) => !e.dead);
    // keep both players alive (no buildings = defeat)
    w.spawnBuilding('israel_conyard', 0, 4, 88, true);
    w.spawnBuilding('ukraine_conyard', 1, 88, 4, true);
    return w;
  }

  it('active protection intercepts rockets', () => {
    const w = duel();
    const tank = w.spawnUnit('israel_mbt', 0, 40.5, 60.5);
    tank.hp = tank.maxHp = 1e6;
    for (let i = 0; i < 4; i++) w.spawnUnit('ukraine_at', 1, 44.5, 58.5 + i * 0.4);
    let intercepts = 0;
    for (let t = 0; t < TPS * 40; t++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'intercept') intercepts++;
    }
    expect(intercepts).toBeGreaterThan(5);
  });

  it('FPV teams launch kamikaze drones and EW jams them', () => {
    const w = duel();
    const target = w.spawnUnit('israel_mbt', 0, 40.5, 60.5);
    target.hp = target.maxHp = 1e6;
    w.spawnUnit('ukraine_fpvteam', 1, 46.5, 60.5);
    let launched = 0;
    let hits = 0;
    for (let t = 0; t < TPS * 20; t++) {
      w.step();
      for (const e of w.drainEvents()) {
        if (e.t === 'fire' && e.weapon.includes('fpvLaunch')) launched++;
        if (e.t === 'impact' && e.weapon === 'fpvWarhead' && e.direct) hits++;
      }
    }
    expect(launched).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);

    // with a jammer next to the target the drones should mostly fail
    const w2 = new World({
      seed: 5,
      players: [
        { name: 'A', faction: 'russia', color: 0, isAI: false },
        { name: 'B', faction: 'ukraine', color: 0, isAI: false },
      ],
    });
    for (const e of w2.list) if (e.owner >= 0) e.dead = true;
    w2.list = w2.list.filter((e) => !e.dead);
    w2.spawnBuilding('russia_conyard', 0, 4, 88, true);
    w2.spawnBuilding('ukraine_conyard', 1, 88, 4, true);
    const t2 = w2.spawnUnit('russia_mbt', 0, 40.5, 60.5);
    t2.hp = t2.maxHp = 1e6;
    w2.spawnUnit('russia_ew', 0, 39.5, 60.5);
    w2.spawnUnit('ukraine_fpvteam', 1, 46.5, 60.5);
    let hits2 = 0;
    for (let t = 0; t < TPS * 20; t++) {
      w2.step();
      for (const e of w2.drainEvents()) if (e.t === 'impact' && e.weapon === 'fpvWarhead' && e.direct) hits2++;
    }
    expect(hits2).toBeLessThan(hits);
  });
});

describe('air defence', () => {
  it('Iron Dome shoots down incoming ballistic missiles and rockets', () => {
    const w = new World({
      seed: 9,
      players: [
        { name: 'A', faction: 'israel', color: 0, isAI: false },
        { name: 'B', faction: 'iran', color: 0, isAI: false },
      ],
    });
    for (const e of w.list) if (e.owner >= 0) e.dead = true;
    w.list = w.list.filter((e) => !e.dead);
    const target = w.spawnBuilding('israel_conyard', 0, 30, 60, true);
    target.hp = target.maxHp = 1e7;
    w.spawnBuilding('israel_power', 0, 26, 60, true);
    w.spawnBuilding('israel_power', 0, 26, 63, true);
    w.spawnBuilding('israel_def_aa', 0, 33, 59, true);
    w.spawnBuilding('iran_conyard', 1, 88, 4, true);
    const launcher = w.spawnUnit('iran_fateh', 1, 44.5, 62.5);
    launcher.hp = launcher.maxHp = 1e6;
    w.issue(1, { type: 'attack', ids: [launcher.id], target: target.id });
    let kills = 0;
    let launches = 0;
    for (let t = 0; t < TPS * 90; t++) {
      w.step();
      // keep the launcher's view of the target (it needs vision to aim)
      w.players[1].visible.fill(1);
      for (const e of w.drainEvents()) {
        if (e.t === 'launch' && e.flight === 'ballistic') launches++;
        if (e.t === 'airburst' && e.kind === 'kill') kills++;
      }
    }
    expect(launches).toBeGreaterThan(3);
    expect(kills).toBeGreaterThan(0);
  });
});

describe('missile toughness and variety', () => {
  /** Defender (player 0) base at (30, 60) with `batteries` air-defence sites; attacker (player 1) launchers 17 tiles east. */
  function range(def: 'israel' | 'usa' | 'germany', att: 'iran' | 'usa' | 'russia' | 'germany' | 'china', launchers: string[], batteries: number, seed = 9) {
    const w = new World({
      seed,
      players: [
        { name: 'D', faction: def, color: 0, isAI: false },
        { name: 'A', faction: att, color: 0, isAI: false },
      ],
    });
    for (const e of w.list) if (e.owner >= 0) e.dead = true;
    w.list = w.list.filter((e) => !e.dead);
    const target = w.spawnBuilding(`${def}_conyard`, 0, 30, 60, true);
    target.hp = target.maxHp = 1e7;
    for (let i = 0; i < 3; i++) w.spawnBuilding(`${def}_power`, 0, 22, 56 + i * 3, true);
    const sites: Entity[] = [];
    for (let i = 0; i < batteries; i++) sites.push(w.spawnBuilding(`${def}_def_aa`, 0, 33 + i, 58 - i * 2, true));
    w.spawnBuilding(`${att}_conyard`, 1, 88, 4, true);
    const units = launchers.map((d, i) => {
      const l = w.spawnUnit(d, 1, 47.5, 60.5 + i * 1.5);
      l.hp = l.maxHp = 1e6;
      w.issue(1, { type: 'attack', ids: [l.id], target: target.id });
      return l;
    });
    return { w, target, sites, units };
  }

  it('a 3-hp Khorramshahr survives intercepts until the third hit, flying on damaged and off course', () => {
    const { w, target } = range('israel', 'iran', [], 0);
    const launcher = w.spawnUnit('iran_khorramshahr', 1, 47.5, 60.5);
    const m = launch(w, launcher, target, WEAPONS.khorramshahr, target.x, target.y);
    expect(m.hp).toBe(3);
    expect(m.maxHp).toBe(3);
    for (let i = 0; i < 30; i++) w.step();
    w.drainEvents();

    // first hit: damaged, not destroyed
    expect(hitThreat(w, m, 'patriot', m.x, m.y, m.z)).toBe(false);
    expect(m.dead).toBe(false);
    expect(m.hp).toBe(2);
    expect(m.hits).toBe(1);
    const ev1 = w.drainEvents().find((e) => e.t === 'airburst');
    expect(ev1).toMatchObject({ t: 'airburst', kind: 'hit', victimId: m.id, hpLeft: 2, maxHp: 3, victim: 'ballistic', victimWeapon: 'khorramshahr' });
    for (let i = 0; i < 10; i++) w.step();
    expect(w.projectiles).toContain(m);

    // second hit: still flying
    expect(hitThreat(w, m, 'patriot', m.x, m.y, m.z)).toBe(false);
    expect(m.hp).toBe(1);
    expect(m.hits).toBe(2);
    for (let i = 0; i < 5; i++) w.step();
    expect(w.projectiles).toContain(m);

    // third hit: destroyed
    w.drainEvents();
    expect(hitThreat(w, m, 'patriot', m.x, m.y, m.z)).toBe(true);
    expect(m.dead).toBe(true);
    expect(w.drainEvents().find((e) => e.t === 'airburst')).toMatchObject({ kind: 'kill', victimId: m.id, hpLeft: 0 });
    w.step();
    expect(w.projectiles).not.toContain(m);

    // a damaged missile that is not finished off still arrives, but off its aim point
    const m2 = launch(w, launcher, target, WEAPONS.khorramshahr, target.x, target.y);
    for (let i = 0; i < 40; i++) w.step();
    hitThreat(w, m2, 'patriot', m2.x, m2.y, m2.z);
    let impact: { x: number; y: number } | null = null;
    for (let i = 0; i < TPS * 15 && !impact; i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'impact' && e.weapon === 'khorramshahr') impact = e;
    }
    expect(impact).not.toBeNull();
    const miss = Math.hypot(impact!.x - target.x, impact!.y - target.y);
    expect(miss).toBeGreaterThan(0.3);
    expect(miss).toBeLessThan(1.5);
  });

  it('batteries keep engaging a damaged heavy missile and need three hits to kill it', () => {
    const { w } = range('israel', 'iran', ['iran_khorramshahr'], 2);
    const hits = new Map<number, number>();
    let kills = 0;
    let launches = 0;
    for (let t = 0; t < TPS * 90; t++) {
      w.step();
      for (const e of w.drainEvents()) {
        if (e.t === 'launch' && e.weapon === 'khorramshahr') launches++;
        if (e.t !== 'airburst' || e.victimWeapon !== 'khorramshahr') continue;
        if (e.kind === 'hit') hits.set(e.victimId!, (hits.get(e.victimId!) ?? 0) + 1);
        if (e.kind === 'kill') {
          kills++;
          // every kill took exactly two earlier hits that the missile survived
          expect(hits.get(e.victimId!)).toBe(2);
        }
      }
      // never more interceptors in the air against one missile than hits still needed (+1 spare)
      for (const p of w.projectiles) if (p.weapon === 'khorramshahr') expect(p.engaged).toBeLessThanOrEqual(p.hp + 1);
    }
    expect(launches).toBeGreaterThan(1);
    expect(kills).toBeGreaterThan(0);
  });

  it('cruise missiles are only detected at a fraction of a battery range', () => {
    // distances (battery -> threat) at which the Patriot site launched its interceptors
    const engageDist = () => {
      const { w, sites } = range('usa', 'usa', ['usa_typhon'], 1);
      const site = sites[0];
      const out: number[] = [];
      for (let t = 0; t < TPS * 60; t++) {
        w.step();
        for (const e of w.drainEvents()) {
          if (e.t !== 'launch' || e.sourceId !== site.id) continue;
          const ic = w.projectiles.find((p) => p.id === e.id);
          const threat = ic && w.projectiles.find((p) => p.id === ic.targetProj);
          if (threat) out.push(Math.hypot(threat.x - site.x, threat.y - site.y));
        }
      }
      const wpn = WEAPONS[buildingDef(site.def).weapon!];
      return { out, range: w.weaponRange(site, wpn) };
    };
    const stealthy = engageDist();
    expect(stealthy.out.length).toBeGreaterThan(0);
    const limit = detectionRange(stealthy.range, WEAPONS.tomahawk, false);
    expect(limit).toBeLessThan(stealthy.range * 0.5);
    // measured one tick after the detection check: allow one tick of cruise-missile travel
    for (const d of stealthy.out) expect(d).toBeLessThanOrEqual(limit + 0.3);
    // the same Tomahawk without its low-observable signature is engaged much further out
    const lo = WEAPONS.tomahawk.lowObservable;
    try {
      WEAPONS.tomahawk.lowObservable = undefined;
      const visible = engageDist();
      expect(Math.max(...visible.out)).toBeGreaterThan(limit + 2);
    } finally {
      WEAPONS.tomahawk.lowObservable = lo;
    }
  });

  it('is deterministic with the new missiles in flight', () => {
    const run = () => {
      const { w } = range('israel', 'russia', ['iran_khorramshahr', 'russia_iskander', 'germany_taurus', 'usa_typhon', 'china_df', 'israel_lora'], 2, 13);
      let events = 0;
      for (let t = 0; t < TPS * 75; t++) {
        w.step();
        events += w.drainEvents().length;
      }
      const ents = w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp.toFixed(2)}`).join('|');
      const projs = w.projectiles.map((p) => `${p.id}:${p.weapon}:${p.x.toFixed(4)}:${p.y.toFixed(4)}:${p.z.toFixed(4)}:${p.hp}:${p.hits}`).join('|');
      return { ents, projs, events, rng: w.rng.next() };
    };
    const a = run();
    const b = run();
    expect(a.events).toBeGreaterThan(50);
    expect(a).toEqual(b);
  });
});

describe('airborne drop support power', () => {
  /** USA (player 0) vs Russia, starting forces cleared; an airfield for player 0 unless told otherwise. */
  function dropWorld(seed = 11, airfield = true) {
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
    w.spawnBuilding('usa_power', 0, 8, 88, true);
    if (airfield) w.spawnBuilding('usa_airfield', 0, 4, 83, true);
    return w;
  }
  const charge = (w: World) => {
    w.step();
    w.players[0].airdropAt = w.tick; // skip the recharge wait
  };
  const transports = (w: World) => w.list.filter((e) => !e.dead && e.def.endsWith('_transport'));
  const troops = (w: World, owner = 0) => w.list.filter((e) => !e.dead && e.owner === owner && unitDef(e.def).category === 'infantry');

  it('needs an airfield and a full charge, then goes on cooldown', () => {
    const none = dropWorld(11, false);
    for (let i = 0; i < 5; i++) none.step();
    expect(none.players[0].airdropAt).toBe(-1);
    none.issue(0, { type: 'airdrop', x: 48, y: 48 });
    none.step();
    expect(transports(none).length).toBe(0);

    const w = dropWorld();
    w.step();
    // first charge takes 90 s after the airfield is up
    expect(airdropStatus(w, 0).unlocked).toBe(true);
    expect(airdropStatus(w, 0).ready).toBe(false);
    w.issue(0, { type: 'airdrop', x: 48, y: 48 });
    w.step();
    expect(transports(w).length).toBe(0);
    for (let i = 0; i < AIRDROP_FIRST; i++) w.step();
    expect(airdropStatus(w, 0).ready).toBe(true);
    // the enemy has no airfield: its command is rejected
    w.issue(1, { type: 'airdrop', x: 48, y: 48 });
    w.issue(0, { type: 'airdrop', x: 48, y: 48 });
    w.step();
    expect(transports(w).length).toBe(1);
    expect(transports(w)[0].owner).toBe(0);
    // recharging: a second call is refused
    w.issue(0, { type: 'airdrop', x: 30, y: 60 });
    w.step();
    expect(transports(w).length).toBe(1);
    expect(airdropStatus(w, 0).ready).toBe(false);
    expect(w.players[0].airdropAt - w.tick).toBeGreaterThan(AIRDROP_COOLDOWN - TPS * 2);
  });

  it('jumpers descend under canopy, land and become normal infantry; the pallet heals', () => {
    const w = dropWorld();
    charge(w);
    w.issue(0, { type: 'airdrop', x: 40, y: 56 });
    let landed = 0;
    let paradrop = 0;
    let sawAirborne = false;
    let hurt: Entity | null = null;
    for (let i = 0; i < TPS * 60; i++) {
      if (i === TPS * 32) {
        // supply pallet on the ground: it patches up wounded units nearby
        const crate = w.list.find((e) => !e.dead && e.def === 'supply_crate' && !e.para);
        expect(crate).toBeTruthy();
        hurt = w.spawnUnit('usa_engineer', 0, crate!.x + 1, crate!.y);
        hurt.hp = 20;
      }
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.t === 'landed') landed++;
        if (ev.t === 'paradrop') paradrop++;
      }
      for (const e of troops(w)) if (e.para && e.z > 1) sawAirborne = true;
    }
    expect(paradrop).toBe(1);
    expect(sawAirborne).toBe(true);
    const inf = troops(w).filter((e) => e !== hurt);
    expect(inf.length).toBe(6);
    expect(inf.filter((e) => e.def === 'usa_at').length).toBe(1);
    expect(landed).toBe(7); // six jumpers + the supply pallet
    expect(hurt!.hp).toBeGreaterThan(60);
    for (const e of inf) {
      expect(e.para).toBeNull();
      expect(e.z).toBe(0);
      expect(Math.hypot(e.x - 40, e.y - 56)).toBeLessThan(4);
      expect(w.pf.passable(Math.floor(e.x), Math.floor(e.y))).toBe(true);
    }
    // the transport has left the map
    expect(transports(w).length).toBe(0);
    // they take orders like any squad
    const ids = inf.map((e) => e.id);
    w.issue(0, { type: 'move', ids, x: 34, y: 60 });
    for (let i = 0; i < TPS * 20; i++) w.step();
    for (const id of ids) expect(Math.hypot(w.get(id)!.x - 34, w.get(id)!.y - 60)).toBeLessThan(2.5);
  });

  it('shooting the transport down before the drop loses the stick; damage costs jumpers', () => {
    const w = dropWorld();
    charge(w);
    w.issue(0, { type: 'airdrop', x: 40, y: 56 });
    w.step();
    const plane = transports(w)[0];
    const shooter = w.spawnUnit('russia_rifle', 1, 2, 2);
    for (let i = 0; i < TPS * 2; i++) w.step();
    expect(plane.drop!.phase).toBe('inbound');
    w.damage(plane, 1e6, 'missile', shooter);
    expect(plane.dead).toBe(true);
    for (let i = 0; i < TPS * 40; i++) w.step();
    expect(troops(w).length).toBe(0);
    expect(w.list.some((e) => !e.dead && e.def === 'supply_crate')).toBe(false);

    const w2 = dropWorld();
    charge(w2);
    w2.issue(0, { type: 'airdrop', x: 40, y: 56 });
    w2.step();
    const p2 = transports(w2)[0];
    p2.hp = p2.maxHp * 0.4;
    for (let i = 0; i < TPS * 40; i++) w2.step();
    expect(troops(w2).length).toBe(3);
    expect(troops(w2).filter((e) => e.def === 'usa_at').length).toBe(1);
    expect(w2.list.some((e) => !e.dead && e.def === 'supply_crate')).toBe(false);
  });

  it('jumpers can be shot while descending', () => {
    const w = dropWorld();
    charge(w);
    w.issue(0, { type: 'airdrop', x: 40, y: 56 });
    for (let i = 0; i < 4; i++) w.spawnUnit('russia_rifle', 1, 41.5 + (i % 2) * 0.4, 57.5 + i * 0.3);
    let hitInAir = 0;
    for (let i = 0; i < TPS * 40; i++) {
      w.step();
      for (const e of troops(w)) if (e.para && e.hp < e.maxHp) hitInAir++;
    }
    expect(hitInAir).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const w = dropWorld(21);
      charge(w);
      w.issue(0, { type: 'airdrop', x: 52, y: 44 });
      w.spawnBuilding('russia_def_aa', 1, 60, 36, true);
      w.spawnBuilding('russia_power', 1, 62, 36, true);
      for (let i = 0; i < TPS * 50; i++) w.step();
      return w.list
        .filter((e) => !e.dead)
        .map((e) => `${e.id}:${e.def}:${e.x.toFixed(5)}:${e.y.toFixed(5)}:${e.z.toFixed(4)}:${e.hp.toFixed(3)}`)
        .join('|');
    };
    const a = run();
    expect(a).toBe(run());
    expect(a).toContain('usa_rifle');
  });

  it('the AI calls in paratroopers once it has an airfield', () => {
    const w = aiWorld(5);
    let drops = 0;
    for (let i = 0; i < TPS * 60 * 11 && !w.over && drops === 0; i++) {
      w.step();
      for (const ev of w.drainEvents()) if (ev.t === 'airdrop') drops++;
    }
    expect(drops).toBeGreaterThan(0);
  });
});

describe('veterancy', () => {
  function vetWorld() {
    const w = new World({
      seed: 21,
      players: [
        { name: 'A', faction: 'usa', color: 0, isAI: false },
        { name: 'B', faction: 'russia', color: 0, isAI: false },
      ],
    });
    for (const e of w.list) if (e.owner >= 0) e.dead = true;
    w.list = w.list.filter((e) => !e.dead);
    w.spawnBuilding('usa_conyard', 0, 4, 88, true);
    w.spawnBuilding('russia_conyard', 1, 88, 4, true);
    return w;
  }

  it('ranks up by the value destroyed: veteran at its own cost, elite at three times', () => {
    expect(rankThreshold('usa_mbt', VETERAN)).toBe(800);
    expect(rankThreshold('usa_mbt', ELITE)).toBe(2400);
    expect(rankThreshold('usa_rifle', VETERAN)).toBe(150);
    expect(rankFor('usa_mbt', 799)).toBe(0);
    expect(rankFor('usa_mbt', 800)).toBe(VETERAN);
    expect(rankFor('usa_mbt', 2400)).toBe(ELITE);
    expect(canRank(unitDef('ukraine_fpv'))).toBe(false);
    expect(canRank(unitDef('usa_mbt'))).toBe(true);

    const w = vetWorld();
    const tank = w.spawnUnit('usa_mbt', 0, 40.5, 60.5);
    const promos: { id: number; rank: number }[] = [];
    const kill = () => {
      const v = w.spawnUnit('russia_mbt', 1, 44.5, 60.5);
      w.damage(v, 1e6, 'cannon', tank);
      for (const e of w.drainEvents()) if (e.t === 'promoted') promos.push({ id: e.id, rank: e.rank });
    };
    // a cheap kill is not enough
    w.damage(w.spawnUnit('russia_rifle', 1, 44.5, 61.5), 1e6, 'mg', tank);
    expect(tank.xp).toBe(150);
    expect(tank.rank).toBe(0);
    kill();
    expect(tank.rank).toBe(VETERAN);
    expect(promos).toEqual([{ id: tank.id, rank: VETERAN }]);
    kill();
    expect(tank.rank).toBe(VETERAN);
    kill();
    expect(tank.xp).toBe(150 + 3 * 800);
    expect(tank.rank).toBe(ELITE);
    expect(promos).toEqual([
      { id: tank.id, rank: VETERAN },
      { id: tank.id, rank: ELITE },
    ]);
  });

  it('veterans hit harder, take less damage and reload faster; elites self-heal', () => {
    const w = vetWorld();
    const a = w.spawnUnit('usa_mbt', 0, 40.5, 60.5);
    const b = w.spawnUnit('russia_mbt', 1, 50.5, 60.5);
    b.hp = b.maxHp = 1e5;
    a.rank = VETERAN;
    w.damage(b, 100, 'cannon', a);
    expect(1e5 - b.hp).toBeCloseTo(100 * RANK_FIREPOWER[VETERAN], 6);
    const hp0 = b.hp;
    b.rank = ELITE;
    a.rank = 0;
    w.damage(b, 100, 'cannon', a);
    expect(hp0 - b.hp).toBeCloseTo(100 * RANK_ARMOR[ELITE], 6);

    // reload: time between shots of an elite tank vs a rookie
    const gap = (rank: number) => {
      const v = vetWorld();
      const s = v.spawnUnit('usa_mbt', 0, 40.5, 60.5);
      s.rank = rank;
      const t = v.spawnUnit('russia_mbt', 1, 44.5, 60.5);
      t.hp = t.maxHp = 1e7;
      v.issue(0, { type: 'attack', ids: [s.id], target: t.id });
      const shots: number[] = [];
      for (let i = 0; i < TPS * 15; i++) {
        v.step();
        for (const e of v.drainEvents()) if (e.t === 'fire' && e.id === s.id) shots.push(v.tick);
      }
      return shots[shots.length - 1] - shots[shots.length - 2];
    };
    const rof = WEAPONS[unitDef('usa_mbt').weapon!].rof;
    expect(gap(0)).toBe(rof);
    expect(gap(ELITE)).toBe(Math.round(rof * RANK_ROF[ELITE]));

    // elite self-repair
    const e = w.spawnUnit('usa_mbt', 0, 30.5, 60.5);
    e.rank = ELITE;
    e.hp = e.maxHp / 2;
    for (let i = 0; i < TPS * 5; i++) w.step();
    expect(e.hp).toBeGreaterThan(e.maxHp / 2 + e.maxHp * 0.04);
    const r = w.spawnUnit('usa_mbt', 0, 30.5, 64.5);
    r.hp = r.maxHp / 2;
    for (let i = 0; i < TPS * 5; i++) w.step();
    expect(r.hp).toBe(r.maxHp / 2);
  });

  it('drone launchers are credited with their drones’ kills; live fire earns experience', () => {
    const w = new World({
      seed: 5,
      players: [
        { name: 'A', faction: 'israel', color: 0, isAI: false },
        { name: 'B', faction: 'ukraine', color: 0, isAI: false },
      ],
    });
    for (const e of w.list) if (e.owner >= 0) e.dead = true;
    w.list = w.list.filter((e) => !e.dead);
    w.spawnBuilding('israel_conyard', 0, 4, 88, true);
    w.spawnBuilding('ukraine_conyard', 1, 88, 4, true);
    const target = w.spawnUnit('israel_mbt', 0, 40.5, 60.5);
    target.hp = 20;
    const team = w.spawnUnit('ukraine_fpvteam', 1, 46.5, 60.5);
    let promoted = false;
    for (let t = 0; t < TPS * 20 && !target.dead; t++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'promoted' && e.id === team.id) promoted = true;
    }
    expect(target.dead).toBe(true);
    expect(team.xp).toBe(unitDef('israel_mbt').cost);
    expect(team.rank).toBe(VETERAN);
    expect(promoted).toBe(true);

    // a tank shooting infantry ranks up from real combat
    const v = vetWorld();
    const tank = v.spawnUnit('usa_mbt', 0, 40.5, 60.5);
    tank.hp = tank.maxHp = 1e6;
    for (let i = 0; i < 6; i++) v.spawnUnit('russia_rifle', 1, 44.5, 59.5 + i * 0.4);
    for (let t = 0; t < TPS * 60; t++) v.step();
    // (a soldier who goes down wounded already earns the shooter the kill's experience: medic.ts)
    const killed = 6 - v.list.filter((e) => !e.dead && !e.wound && e.owner === 1 && e.kind === 'unit').length;
    expect(killed).toBeGreaterThan(2);
    expect(tank.xp).toBe(killed * 150);
    expect(tank.rank).toBe(rankFor('usa_mbt', tank.xp));
  });

  it('rank survives boarding and unloading a transport', () => {
    const w = vetWorld();
    const apc = w.spawnUnit('usa_apc', 0, 40.5, 60.5);
    const inf = w.spawnUnit('usa_rifle', 0, 41.5, 60.5);
    inf.rank = ELITE;
    inf.xp = 500;
    w.issue(0, { type: 'enter', ids: [inf.id], target: apc.id });
    for (let i = 0; i < TPS * 4; i++) w.step();
    expect(inf.inside).toBe(apc.id);
    w.issue(0, { type: 'deploy', ids: [apc.id] });
    w.step();
    expect(inf.inside).toBe(-1);
    expect(inf.rank).toBe(ELITE);
    expect(inf.xp).toBe(500);
  });

  it('AI games promote units and stay deterministic with veterancy', () => {
    const a = aiWorld(13);
    const b = aiWorld(13);
    let promos = 0;
    for (let i = 0; i < TPS * 60 * 9; i++) {
      a.step();
      b.step();
      for (const e of a.drainEvents()) if (e.t === 'promoted') promos++;
      b.drainEvents();
    }
    const snap = (w: World) => w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}:${e.xp}:${e.rank}`).join('|');
    expect(snap(a)).toBe(snap(b));
    console.log('veterancy promotions in 9 min AI game:', promos);
    expect(promos).toBeGreaterThan(0);
  }, 120000);
});

describe('collapsible bridges', () => {
  const oneSide = () => new World({ seed: 5, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 1, isAI: false }] });
  const reach = (w: World, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const path = w.pf.find(Math.floor(from.x), Math.floor(from.y), Math.floor(to.x), Math.floor(to.y), 100000);
    return path.length > 0 && path[path.length - 1] === Math.floor(to.y) * w.map.w + Math.floor(to.x);
  };

  it('every bridge is a neutral structure with a repair hut on each bank, and the map stays connected', () => {
    const w = oneSide();
    expect(w.bridges.length).toBe(3);
    for (const b of w.bridges) {
      expect(b.tiles.length).toBeGreaterThan(5);
      expect(b.status).toBe('intact');
      const e = w.get(b.entity)!;
      expect(e.def).toBe(BRIDGE_DEF);
      expect(e.owner).toBe(-1);
      expect(e.hp).toBe(BRIDGE_HP);
      expect(b.huts.length).toBe(2);
      b.huts.forEach((id, k) => {
        const hut = w.get(id)!;
        expect(hut.def).toBe(BRIDGE_HUT_DEF);
        expect(bankOf(b, hut.x, hut.y)).toBe(k);
      });
    }
    expect(reach(w, w.map.starts[0], w.map.starts[1])).toBe(true);
  });

  it('only heavy weapons hurt a bridge', () => {
    const w = oneSide();
    const b = w.bridges[0];
    const e = w.get(b.entity)!;
    const src = w.spawnUnit('usa_rifle', 0, 20.5, 80.5);
    w.damage(e, 1e6, 'mg', src);
    w.damage(e, 1e6, 'artillery', src); // direct damage() is ignored: bridges are hurt by impacts
    bridgeImpact(w, b.x, b.y, 'rifle');
    bridgeImpact(w, b.x, b.y, 'flak');
    expect(b.hp).toBe(BRIDGE_HP);
    bridgeImpact(w, b.x, b.y, 'howitzer');
    expect(b.hp).toBeCloseTo(BRIDGE_HP - WEAPONS.howitzer.damage, 5);
    const before = b.hp;
    bridgeImpact(w, b.x, b.y, 'cannon');
    expect(before - b.hp).toBeLessThan(WEAPONS.cannon.damage * 0.2);
    // a shell landing well away from the deck does nothing
    const hp = b.hp;
    bridgeImpact(w, b.x + 6, b.y + 6, 'howitzer');
    expect(b.hp).toBe(hp);
    // riflemen refuse a force-attack order on the bridge; artillery accepts it
    const art = w.spawnUnit('usa_arty', 0, b.ends[0].x - 5, b.ends[0].y + 5);
    w.issue(0, { type: 'attack', ids: [src.id, art.id], target: b.entity });
    w.step();
    expect(src.order.type).toBe('idle');
    expect(art.order.type).toBe('attack');
  });

  it('artillery fire brings a bridge down: the deck turns to water, units on it fall, paths re-plan', () => {
    const w = oneSide();
    const b = w.bridges[0];
    const deckTile = b.tiles[Math.floor(b.tiles.length / 2)];
    const onDeck = w.spawnUnit('russia_rifle', 1, (deckTile % w.map.w) + 0.5, Math.floor(deckTile / w.map.w) + 0.5);
    // a far-away walker routed over this bridge
    const walker = w.spawnUnit('usa_mbt', 0, b.ends[0].x - 6, b.ends[0].y + 6);
    w.issue(0, { type: 'move', ids: [walker.id], x: b.ends[1].x + 6, y: b.ends[1].y - 6 });
    w.step();
    expect(pathCrosses(w, walker, new Set(b.tiles))).toBe(true);
    const art = ['usa_arty', 'usa_arty', 'usa_arty'].map((d, i) => w.spawnUnit(d, 0, b.ends[0].x - 6 + i, b.ends[0].y + 6 + i * 0.5));
    w.issue(0, { type: 'attack', ids: art.map((a) => a.id), target: b.entity });
    let ticks = 0;
    while (b.status === 'intact' && ticks < TPS * 400) {
      w.step();
      ticks++;
    }
    expect(b.status).toBe('down');
    for (const t of b.tiles) {
      expect(w.map.tiles[t]).toBe(Tile.Water);
      expect(w.pass[t]).toBe(0);
    }
    expect(onDeck.dead).toBe(true);
    expect(w.get(b.entity)).toBeUndefined();
    // the gunners stand down, the walker's path no longer uses the fallen deck
    w.step();
    for (const a of art) expect(a.order.type === 'attack').toBe(false);
    expect(walker.dead).toBe(false);
    expect(pathCrosses(w, walker, new Set(b.tiles))).toBe(false);
  });

  it('with every bridge down the banks are cut off; engineers rebuild from either bank', () => {
    const w = oneSide();
    for (const b of w.bridges) hurtBridge(w, b, 1e9);
    expect(w.bridges.every((b) => b.status === 'down')).toBe(true);
    expect(reach(w, w.map.starts[0], w.map.starts[1])).toBe(false);
    // every hut is reachable from its own bank's base
    for (const b of w.bridges)
      b.huts.forEach((id, k) => {
        const hut = w.get(id)!;
        const s = w.map.starts[k];
        const path = w.pf.find(s.x, s.y, hut.tx, hut.ty, 100000);
        const last = path[path.length - 1];
        expect(Math.hypot((last % w.map.w) - hut.tx, Math.floor(last / w.map.w) - hut.ty)).toBeLessThan(1.5);
      });
    // player 0 rebuilds the centre bridge from its bank, player 1 the west one from the other bank
    const [b0, b1] = w.bridges;
    const h0 = w.get(b0.huts[0])!;
    const h1 = w.get(b1.huts[1])!;
    const e0 = w.spawnUnit('usa_engineer', 0, h0.x + 1.5, h0.y + 1.5);
    const e1 = w.spawnUnit('russia_engineer', 1, h1.x - 1.5, h1.y - 1.5);
    w.issue(0, { type: 'attack', ids: [e0.id], target: h0.id });
    w.issue(1, { type: 'capture', ids: [e1.id], target: h1.id });
    for (let i = 0; i < TPS * 15 && (b0.status === 'down' || b1.status === 'down'); i++) w.step();
    expect(b0.status).toBe('repairing');
    expect(b1.status).toBe('repairing');
    expect(e0.dead && e1.dead).toBe(true);
    for (const t of b0.tiles) expect(w.pass[t]).toBe(0); // still closed while rebuilding
    for (let i = 0; i < BRIDGE_REPAIR_TICKS + 2; i++) w.step();
    for (const b of [b0, b1]) {
      expect(b.status).toBe('intact');
      expect(b.hp).toBe(BRIDGE_HP);
      expect(w.get(b.entity)?.hp).toBe(BRIDGE_HP);
      for (const t of b.tiles) expect(w.map.tiles[t]).toBe(Tile.Bridge);
    }
    expect(reach(w, w.map.starts[0], w.map.starts[1])).toBe(true);
    // an engineer at the hut of an intact, undamaged bridge is not used up
    const e2 = w.spawnUnit('usa_engineer', 0, h0.x + 1.5, h0.y + 1.5);
    w.issue(0, { type: 'capture', ids: [e2.id], target: h0.id });
    for (let i = 0; i < TPS * 8; i++) w.step();
    expect(e2.dead).toBe(false);
  });

  it('is deterministic under bridge shelling, collapse and AI play', () => {
    const run = () => {
      const w = aiWorld(11);
      const b = w.bridges[1];
      const art = [0, 1].map((i) => w.spawnUnit('usa_arty', 0, b.ends[0].x - 6 + i, b.ends[0].y + 6));
      for (let i = 0; i < TPS * 200; i++) {
        if (i === 5) w.issue(0, { type: 'attack', ids: art.map((a) => a.id), target: b.entity });
        w.step();
      }
      return { w, snap: w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}`).join('|') + w.bridges.map((x) => `${x.status}:${x.hp}`).join(',') };
    };
    const a = run();
    const b = run();
    expect(a.snap).toBe(b.snap);
    expect(a.w.bridges[1].hp).toBeLessThan(BRIDGE_HP);
  });
});
