import { beforeAll, describe, expect, it } from 'vitest';
import { DEF_LIST, buildingDef, unitDef } from '../src/sim/defs';
import { Tile } from '../src/sim/map';
import { SHIP_H, SHIP_W, beachSpot, cargoRoom, shipSite } from '../src/sim/naval';
import { Loco } from '../src/sim/slope';
import { FACTIONS } from '../src/sim/defs';
import { TPS, type Entity, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV1 navy: the Shipyard's coast rule, water locomotion (boats never on land, landing craft beach), landing
 * craft loading and unloading, every nation's navy, naval path determinism.
 */

const mk = (map: 'desert' | 'frontline' = 'desert', seed = 1, a: Faction = 'usa', b: Faction = 'russia') =>
  new World({ seed, map, players: [
    { name: 'A', faction: a, color: 0, isAI: false },
    { name: 'B', faction: b, color: 0, isAI: false },
  ] });

/** The Shipyard spot nearest a player's start. */
function spotNear(w: World, pid: number): [number, number] {
  const s = w.map.starts[pid];
  let best = Infinity;
  let at = -1;
  for (const i of w.shipSpots) {
    const d = Math.hypot((i % w.map.w) + SHIP_W / 2 - s.x, Math.floor(i / w.map.w) + SHIP_H / 2 - s.y);
    if (d < best) (best = d), (at = i);
  }
  return [at % w.map.w, Math.floor(at / w.map.w)];
}

/** A base with every prerequisite of the navy for player pid (instant structures beside its start). */
function base(w: World, pid: number) {
  const f = w.players[pid].faction;
  const s = w.map.starts[pid];
  for (const e of w.list) if (e.owner === pid && e.kind === 'unit' && unitDef(e.def).mcv) w.remove(e);
  w.spawnBuilding(`${f}_conyard`, pid, s.x - 1, s.y - 1, true);
  w.players[pid].credits = 100000;
  const yard = spotNear(w, pid);
  expect(w.canPlace(pid, `${f}_shipyard`, yard[0], yard[1])).toBe(true);
  // (the prerequisite roles, standing well away from everything: hasRole only counts them)
  let k = 0;
  for (const r of ['power', 'barracks', 'refinery', 'factory', 'radar']) {
    const d = buildingDef(`${f}_${r}`);
    w.spawnBuilding(d.id, pid, 2 + k * 4, pid === 0 ? w.map.h - 6 : 2, true);
    k++;
  }
  return w.spawnBuilding(`${f}_shipyard`, pid, yard[0], yard[1], true);
}

function runUntil(w: World, cond: () => boolean, max: number) {
  for (let i = 0; i < max && !cond(); i++) w.step();
  return cond();
}

describe('shipyard placement', () => {
  let w: World;
  beforeAll(() => {
    w = mk();
  });

  it('only maps with open sea offer the navy (the river maps do not)', () => {
    expect(w.hasSea).toBe(true);
    expect(w.shipSpots.length).toBeGreaterThan(40);
    const f = mk('frontline');
    expect(f.hasSea).toBe(false);
    expect(f.canBuild(0, 'usa_shipyard')).toBe(false);
  });

  it('accepts a coast footprint and rejects all-land and all-water ones', () => {
    const [x, y] = spotNear(w, 0);
    const s = shipSite(w.map, w.naval.sea, x, y);
    expect(s.ok).toBe(true);
    expect(s.water).toBeGreaterThanOrEqual(7);
    expect(s.land).toBeGreaterThanOrEqual(7);
    // all land: the start area
    const st = w.map.starts[0];
    const land = shipSite(w.map, w.naval.sea, st.x + 3, st.y + 3);
    expect(land.ok).toBe(false);
    expect(land.reason).toMatch(/sea/);
    // all water: somewhere in the open sea
    let sea = -1;
    for (let i = 0; i < w.map.w * w.map.h && sea < 0; i++) {
      const tx = i % w.map.w;
      const ty = Math.floor(i / w.map.w);
      if (tx + SHIP_W > w.map.w || ty + SHIP_H > w.map.h) continue;
      let all = true;
      for (let yy = ty; yy < ty + SHIP_H && all; yy++) for (let xx = tx; xx < tx + SHIP_W; xx++) if (w.map.tiles[yy * w.map.w + xx] !== Tile.Water) all = false;
      if (all) sea = i;
    }
    expect(sea).toBeGreaterThanOrEqual(0);
    const wet = shipSite(w.map, w.naval.sea, sea % w.map.w, Math.floor(sea / w.map.w));
    expect(wet.ok).toBe(false);
    expect(wet.reason).toMatch(/land/);
  });

  it('the world rule: next to the base, explained when refused', () => {
    const w2 = mk();
    const f = 'usa';
    const s = w2.map.starts[0];
    w2.spawnBuilding(`${f}_conyard`, 0, s.x - 1, s.y - 1, true);
    const [x, y] = spotNear(w2, 0);
    expect(w2.canPlace(0, `${f}_shipyard`, x, y)).toBe(true);
    expect(w2.placeWhy(0, `${f}_shipyard`, s.x + 3, s.y + 3)).toMatch(/sea/);
    const b = w2.spawnBuilding(`${f}_shipyard`, 0, x, y, true);
    // the slipway faces the water
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const [dx, dy] = dirs[b.slip ?? 0];
    const mx = Math.floor(b.x + dx * 2.5);
    const my = Math.floor(b.y + dy * 2.5);
    expect(w2.map.tiles[my * w2.map.w + mx]).toBe(Tile.Water);
    // boats cannot sail through the yard
    for (let yy = y; yy < y + SHIP_H; yy++) for (let xx = x; xx < x + SHIP_W; xx++) expect(w2.passes[Loco.Boat][yy * w2.map.w + xx]).toBe(0);
  });
});

describe('naval units', () => {
  it('every nation can build its navy, launched onto the water', () => {
    const w = mk();
    base(w, 0);
    const p = w.players[0];
    for (const f of FACTIONS.map((x) => x.id)) {
      p.faction = f;
      const navy = DEF_LIST.filter((d) => d.kind === 'unit' && d.faction === f && d.category === 'naval' && d.buildable);
      expect(navy.length).toBe(3);
      expect(new Set(navy.map((d) => d.model)).size).toBe(3);
      for (const d of navy) {
        expect(w.canBuild(0, d.id)).toBe(true);
        const before = w.list.filter((e) => !e.dead && e.def === d.id).length;
        w.issue(0, { type: 'produce', def: d.id });
        expect(runUntil(w, () => w.list.filter((e) => !e.dead && e.def === d.id).length > before, TPS * 40)).toBe(true);
        const u = w.list.find((e) => !e.dead && e.def === d.id)!;
        expect(w.map.tiles[w.tileOf(u.x, u.y)]).toBe(Tile.Water);
      }
    }
    // every nation's boats look different
    const models = DEF_LIST.filter((d) => d.kind === 'unit' && d.category === 'naval').map((d) => d.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it('boats never enter land; landing craft keep to the water (hovercraft to the beach)', () => {
    const w = mk();
    base(w, 0);
    const [x, y] = spotNear(w, 0);
    const units: Entity[] = [];
    const spawnNear = (def: string, k: number) => {
      const lc = w.locoOfDef(unitDef(def));
      const sp = w.nearestPassable(x + 2 + (k % 3) * 2, y + 2 + Math.floor(k / 3) * 2, 12, 0, lc)!;
      units.push(w.spawnUnit(def, 0, sp[0] + 0.5, sp[1] + 0.5));
    };
    ['usa_patrol', 'usa_patrol', 'usa_corvette', 'israel_lander', 'usa_lander', 'iran_patrol'].forEach(spawnNear);
    // orders all over the map, onto the land too
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < TPS * 90; t++) {
      if (t % (TPS * 15) === 0) for (const u of units) w.issue(0, { type: 'move', ids: [u.id], x: rnd() * w.map.w, y: rnd() * w.map.h });
      w.step();
      for (const u of units) {
        const i = w.tileOf(u.x, u.y);
        const d = unitDef(u.def);
        if (d.naval === 'hover') expect(w.naval.base[2][i]).toBe(1);
        else expect(w.map.tiles[i]).toBe(Tile.Water);
        if (d.naval === 'boat') expect(w.naval.base[0][i]).toBe(1);
      }
    }
    // and they did sail
    expect(units.some((u) => Math.hypot(u.x - x, u.y - y) > 10)).toBe(true);
  });

  it('a landing craft loads on a beach, crosses the sea and puts tank and soldiers ashore', () => {
    const w = mk();
    base(w, 0);
    const s = w.map.starts[0];
    const lc = Loco.Landing;
    // a beach near the base, on the water that reaches the enemy's coast
    const s1 = w.map.starts[1];
    const e1 = beachSpot(w, s1.x, s1.y, 0, lc, 30)!;
    const R = w.regions[lc][e1[1] * w.map.w + e1[0]];
    const b0 = beachSpot(w, s.x, s.y, R, lc, 30)!;
    expect(b0).not.toBeNull();
    const craft = w.spawnUnit('usa_lander', 0, b0[0] + 0.5, b0[1] + 0.5);
    const land = (cls: number) => w.nearestPassable(b0[0] + 0.5, b0[1] + 0.5, 6, 0, cls)!;
    const tank = w.spawnUnit('usa_mbt', 0, land(Loco.Vehicle)[0] + 0.5, land(Loco.Vehicle)[1] + 0.5);
    const inf = [0, 1, 2].map(() => w.spawnUnit('usa_rifle', 0, land(Loco.Foot)[0] + 0.5, land(Loco.Foot)[1] + 0.5));
    w.issue(0, { type: 'enter', ids: [tank.id, ...inf.map((e) => e.id)], target: craft.id });
    expect(runUntil(w, () => craft.passengers.length === 4, TPS * 40)).toBe(true);
    expect(cargoRoom(w, craft)).toBe(11 - 3 - 3);
    expect(tank.inside).toBe(craft.id);
    // a beach far away, across the water: the enemy's side
    const goal = w.nearestPassable(s1.x + 0.5, s1.y + 0.5, 12, 0, Loco.Vehicle)!;
    const b1 = beachSpot(w, goal[0], goal[1], w.regionOf(craft.x, craft.y, lc), lc, 40)!;
    expect(b1).not.toBeNull();
    const ashore = w.nearestPassable(b1[0] + 0.5, b1[1] + 0.5, 4, 0, Loco.Vehicle)!;
    w.issue(0, { type: 'move', ids: [craft.id], x: ashore[0] + 0.5, y: ashore[1] + 0.5 });
    expect(runUntil(w, () => craft.passengers.length === 0, TPS * 240)).toBe(true);
    for (const u of [tank, ...inf]) {
      expect(u.inside).toBe(-1);
      expect(w.map.tiles[w.tileOf(u.x, u.y)]).not.toBe(Tile.Water);
      expect(w.pass[w.tileOf(u.x, u.y)]).toBe(1);
      expect(Math.hypot(u.x - b1[0], u.y - b1[1])).toBeLessThan(8);
    }
  });

  it('naval pathing is deterministic', () => {
    const run = () => {
      const w = mk('desert', 3);
      base(w, 0);
      const [x, y] = spotNear(w, 0);
      const ids: number[] = [];
      for (let k = 0; k < 5; k++) {
        const sp = w.nearestPassable(x + 3 + k, y + 3, 12, 0, Loco.Boat)!;
        ids.push(w.spawnUnit('usa_patrol', 0, sp[0] + 0.5, sp[1] + 0.5).id);
      }
      const s1 = w.map.starts[1];
      w.issue(0, { type: 'move', ids, x: s1.x, y: s1.y });
      for (let t = 0; t < TPS * 60; t++) w.step();
      const p = w.pfs[Loco.Boat].find(x + 3, y + 3, s1.x, s1.y);
      return JSON.stringify([ids.map((id) => { const e = w.get(id)!; return [e.x, e.y, e.facing]; }), p]);
    };
    expect(run()).toBe(run());
  });
});
