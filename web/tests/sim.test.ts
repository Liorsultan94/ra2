import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { detectionRange, hitThreat, launch } from '../src/sim/ballistics';
import { WEAPONS, buildingDef } from '../src/sim/defs';
import { terrainPassable } from '../src/sim/map';
import { PathFinder } from '../src/sim/path';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

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
  });

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
