import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { buildingDef } from '../src/sim/defs';
import { terrainPassable } from '../src/sim/map';
import { PathFinder } from '../src/sim/path';
import { TPS } from '../src/sim/types';
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
        if (e.t === 'impact' && e.weapon === 'fpvWarhead' && !e.air) hits++;
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
      for (const e of w2.drainEvents()) if (e.t === 'impact' && e.weapon === 'fpvWarhead' && !e.air) hits2++;
    }
    expect(hits2).toBeLessThan(hits);
  });
});
