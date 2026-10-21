import { beforeAll, describe, expect, it } from 'vitest';
import { buildingDef, unitDef } from '../src/sim/defs';
import { DIVE_DEPTH, SONAR_RANGE } from '../src/sim/diver';
import { Tile } from '../src/sim/map';
import { tileDepth } from '../src/sim/naval';
import { Loco } from '../src/sim/slope';
import { TPS, type Entity, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV3 Combat Diver: only with the Shipyard (and the Barracks that trains it); swims a sea and comes ashore; stays on
 * the water when ordered to; walks only where a soldier walks; reaches the lighthouse island no walker can; submerged
 * in deep water it is out of sight, untouchable by anything but ships, and holds its fire; a deterministic path.
 */

const mk = (map: 'desert' | 'frontline' = 'desert', seed = 1, a: Faction = 'usa', b: Faction = 'russia') =>
  new World({ seed, map, players: [
    { name: 'A', faction: a, color: 0, isAI: false },
    { name: 'B', faction: b, color: 0, isAI: false },
  ] });

function runUntil(w: World, cond: () => boolean, max: number) {
  for (let i = 0; i < max && !cond(); i++) w.step();
  return cond();
}

/** A land tile a soldier stands on, nearest (x, y). */
const landNear = (w: World, x: number, y: number) => {
  const p = w.nearestPassable(x, y, 10, 0, Loco.Foot)!;
  expect(p).not.toBeNull();
  return [p[0] + 0.5, p[1] + 0.5] as [number, number];
};

/** The west and the east shore of the sea on the desert map (the two Shipyard coasts), as land tiles. */
function shores(w: World) {
  return { west: landNear(w, 57, 204), east: landNear(w, 200, 70) };
}

/** A tile of the lighthouse island's rim: land (GameMap.offshore) a diver can stand on. */
function islandRim(w: World): [number, number] {
  const off = w.map.offshore!;
  let best = -1;
  for (let i = 0; i < off.length; i++) if (off[i] && w.passes[Loco.Swim][i] && w.map.tiles[i] !== Tile.Water) best = i;
  expect(best, 'the lighthouse island has land a diver can stand on').toBeGreaterThanOrEqual(0);
  return [(best % w.map.w) + 0.5, Math.floor(best / w.map.w) + 0.5];
}

describe('Combat Diver: unlock', () => {
  it('needs the Shipyard (and the Barracks); every nation has one; the same rifle as the rifleman', () => {
    const w = mk();
    const s = w.map.starts[0];
    for (const e of [...w.list]) if (e.owner === 0 && e.kind === 'unit') w.remove(e);
    w.spawnBuilding('usa_conyard', 0, s.x - 1, s.y - 1, true);
    w.players[0].credits = 100000;
    expect(w.canBuild(0, 'usa_diver')).toBe(false);
    for (const [k, r] of ['power', 'barracks', 'refinery', 'factory', 'radar'].entries()) w.spawnBuilding(buildingDef(`usa_${r}`).id, 0, 2 + k * 5, w.map.h - 8, true);
    expect(w.canBuild(0, 'usa_rifle')).toBe(true);
    expect(w.canBuild(0, 'usa_diver')).toBe(false); // the barracks alone is not enough
    let yard: Entity | null = null;
    for (const i of w.shipSpots) {
      const tx = i % w.map.w;
      const ty = Math.floor(i / w.map.w);
      if (!w.canPlace(0, 'usa_shipyard', tx, ty)) continue;
      yard = w.spawnBuilding('usa_shipyard', 0, tx, ty, true);
      break;
    }
    expect(yard).not.toBeNull();
    expect(w.canBuild(0, 'usa_diver')).toBe(true);
    // trained with the soldiers, in the Barracks
    w.issue(0, { type: 'produce', def: 'usa_diver' });
    w.step();
    expect(w.players[0].queues.infantry.map((q) => q.def)).toEqual(['usa_diver']);
    expect(runUntil(w, () => w.list.some((e) => e.def === 'usa_diver'), TPS * 30)).toBe(true);
    const dv = w.list.find((e) => e.def === 'usa_diver')!;
    expect(unitDef(dv.def).category).toBe('infantry');
    expect(unitDef(dv.def).weapon).toBe(unitDef('usa_rifle').weapon);
    expect(unitDef(dv.def).hp).toBeLessThan(unitDef('usa_rifle').hp);
    // without the Shipyard (lost) it cannot be trained any more
    w.remove(yard!);
    expect(w.canBuild(0, 'usa_diver')).toBe(false);
    for (const f of ['usa', 'israel', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran'])
      expect(unitDef(`${f}_diver`).swim, f).toBe(true);
    // a map without sea has no Shipyard to unlock it
    const r = mk('frontline');
    expect(r.canBuild(0, 'usa_diver')).toBe(false);
  });
});

describe('Combat Diver: swimming', () => {
  let w: World;
  beforeAll(() => {
    w = mk();
  });

  it('swims across the sea and comes ashore on the far coast, submerged in the deep water', () => {
    const w2 = mk();
    const { west, east } = shores(w2);
    const dv = w2.spawnUnit('usa_diver', 0, west[0], west[1]);
    w2.issue(0, { type: 'move', ids: [dv.id], x: east[0], y: east[1] });
    let dived = 0;
    let maxDeep = 0;
    const done = () => Math.hypot(dv.x - east[0], dv.y - east[1]) < 2;
    for (let t = 0; t < TPS * 400 && !done(); t++) {
      w2.step();
      const i = w2.tileOf(dv.x, dv.y);
      // (never inside a structure, a cliff or a rock: only where a diver may be)
      expect(w2.passes[Loco.Swim][i], `${dv.x.toFixed(1)},${dv.y.toFixed(1)}`).toBe(1);
      if (dv.dive) dived++;
      if (w2.map.tiles[i] === Tile.Water) maxDeep = Math.max(maxDeep, tileDepth(w2.map, i % w2.map.w, Math.floor(i / w2.map.w)));
    }
    expect(done(), `${dv.x.toFixed(0)},${dv.y.toFixed(0)}`).toBe(true);
    expect(dived).toBeGreaterThan(TPS * 20); // a long swim under the surface
    expect(maxDeep).toBeGreaterThan(DIVE_DEPTH);
    // ashore: on land again, no longer submerged
    expect(w2.map.tiles[w2.tileOf(dv.x, dv.y)]).not.toBe(Tile.Water);
    expect(dv.dive).toBe(false);
    // the rifleman could not have gone this way
    const inf = w2.spawnUnit('usa_rifle', 0, west[0], west[1]);
    w2.issue(0, { type: 'move', ids: [inf.id], x: east[0], y: east[1] });
    for (let t = 0; t < TPS * 30; t++) w2.step();
    expect(w2.map.tiles[w2.tileOf(inf.x, inf.y)]).not.toBe(Tile.Water);
  }, 600_000);

  it('stays on the water when ordered to', () => {
    const w2 = mk();
    const { west } = shores(w2);
    const dv = w2.spawnUnit('usa_diver', 0, west[0], west[1]);
    // deep water some way out
    let goal: [number, number] | null = null;
    for (let r = 12; r < 40 && !goal; r += 2)
      for (let a = 0; a < 6.3 && !goal; a += 0.3) {
        const x = Math.floor(west[0] + Math.cos(a) * r);
        const y = Math.floor(west[1] + Math.sin(a) * r);
        if (x < 1 || y < 1 || x >= w2.map.w - 1 || y >= w2.map.h - 1) continue;
        if (w2.map.tiles[y * w2.map.w + x] === Tile.Water && tileDepth(w2.map, x, y) >= 0.9 && w2.passes[Loco.Swim][y * w2.map.w + x]) goal = [x + 0.5, y + 0.5];
      }
    expect(goal).not.toBeNull();
    w2.issue(0, { type: 'move', ids: [dv.id], x: goal![0], y: goal![1] });
    expect(runUntil(w2, () => Math.hypot(dv.x - goal![0], dv.y - goal![1]) < 1, TPS * 120)).toBe(true);
    for (let t = 0; t < TPS * 20; t++) w2.step();
    expect(w2.map.tiles[w2.tileOf(dv.x, dv.y)]).toBe(Tile.Water);
    expect(dv.dive).toBe(true);
    expect(Math.hypot(dv.x - goal![0], dv.y - goal![1])).toBeLessThan(1.5);
  }, 300_000);

  it('walks only where a soldier walks: the infantry slope rule on land, no rock, no cliff face', () => {
    // every land step the same as the soldier's
    const W = w.map.w;
    let checked = 0;
    for (let y = 2; y < w.map.h - 2; y += 3)
      for (let x = 2; x < W - 2; x += 3) {
        const a = y * W + x;
        if (w.map.tiles[a] === Tile.Water) continue;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]]) {
          const b = (y + dy) * W + x + dx;
          if (w.map.tiles[b] === Tile.Water || !w.passes[Loco.Swim][a] || !w.passes[Loco.Swim][b]) continue;
          // (a diagonal past a corner of water is the diver's to take)
          if (dx && dy && (w.map.tiles[a + dx] === Tile.Water || w.map.tiles[a + dy * W] === Tile.Water)) continue;
          expect(w.stepOk(a, b, Loco.Swim), `${x},${y} -> ${dx},${dy}`).toBe(w.stepOk(a, b, Loco.Foot));
          checked++;
        }
      }
    expect(checked).toBeGreaterThan(1000);
    // rock and blocked ground are no diver's ground either
    let rock = -1;
    for (let i = 0; i < w.map.tiles.length && rock < 0; i++) if (w.map.tiles[i] === Tile.Rock) rock = i;
    expect(rock).toBeGreaterThanOrEqual(0);
    expect(w.passes[Loco.Swim][rock]).toBe(0);
    // ordered onto a rock, it ends beside it, not on it
    const { west } = shores(w);
    const w2 = mk();
    const dv = w2.spawnUnit('usa_diver', 0, west[0], west[1]);
    w2.issue(0, { type: 'move', ids: [dv.id], x: (rock % W) + 0.5, y: Math.floor(rock / W) + 0.5 });
    for (let t = 0; t < TPS * 5; t++) w2.step();
    expect(w2.passes[Loco.Swim][w2.tileOf(dv.x, dv.y)]).toBe(1);
  }, 300_000);

  it('reaches the lighthouse island no soldier can', () => {
    const w2 = mk();
    const rim = islandRim(w2);
    // (a walker has no way there: the island is a ground region of its own)
    expect(w2.regions[Loco.Foot][w2.tileOf(rim[0], rim[1])]).not.toBe(w2.mainlands[Loco.Foot]);
    expect(w2.regions[Loco.Swim][w2.tileOf(rim[0], rim[1])]).toBe(w2.mainlands[Loco.Swim]);
    const { west } = shores(w2);
    const dv = w2.spawnUnit('usa_diver', 0, west[0], west[1]);
    w2.issue(0, { type: 'move', ids: [dv.id], x: rim[0], y: rim[1] });
    expect(runUntil(w2, () => dv.order.type === 'idle' && Math.hypot(dv.x - rim[0], dv.y - rim[1]) < 1.5, TPS * 400)).toBe(true);
    expect(w2.map.offshore![w2.tileOf(dv.x, dv.y)]).toBe(1);
    expect(dv.dive).toBe(false); // standing on its sand
    // and the rifleman sent after it stays on the mainland
    const inf = w2.spawnUnit('usa_rifle', 0, west[0], west[1]);
    w2.issue(0, { type: 'move', ids: [inf.id], x: rim[0], y: rim[1] });
    for (let t = 0; t < TPS * 60; t++) w2.step();
    expect(w2.map.offshore![w2.tileOf(inf.x, inf.y)]).toBe(0);
  }, 600_000);

  it('the swim path is deterministic', () => {
    const run = () => {
      const w2 = mk('desert', 3);
      const { west, east } = shores(w2);
      const ids = [0, 1, 2].map((k) => w2.spawnUnit('usa_diver', 0, west[0] + k * 0.3, west[1]).id);
      w2.issue(0, { type: 'move', ids, x: east[0], y: east[1] });
      for (let t = 0; t < TPS * 60; t++) w2.step();
      const p = w2.pfs[Loco.Swim].find(Math.floor(west[0]), Math.floor(west[1]), Math.floor(east[0]), Math.floor(east[1]));
      return JSON.stringify([ids.map((id) => { const e = w2.get(id)!; return [e.x, e.y, e.dive]; }), p?.length]);
    };
    expect(run()).toBe(run());
  }, 300_000);
});

describe('Combat Diver: diving', () => {
  it('submerged it is out of sight, only a ship or boat can hurt it, it holds its fire; surfaced it fights like a rifleman', () => {
    const w = mk();
    const { west } = shores(w);
    // deep water off the west coast
    let deep: [number, number] | null = null;
    for (let r = 14; r < 40 && !deep; r += 2)
      for (let a = 0; a < 6.3 && !deep; a += 0.3) {
        const x = Math.floor(west[0] + Math.cos(a) * r);
        const y = Math.floor(west[1] + Math.sin(a) * r);
        if (x < 3 || y < 3 || x >= w.map.w - 3 || y >= w.map.h - 3) continue;
        if (w.map.tiles[y * w.map.w + x] === Tile.Water && tileDepth(w.map, x, y) >= 0.9) deep = [x + 0.5, y + 0.5];
      }
    expect(deep).not.toBeNull();
    for (const p of w.players) p.explored.fill(1);
    const dv = w.spawnUnit('usa_diver', 0, deep![0], deep![1]);
    w.step();
    expect(dv.dive).toBe(true);
    // the enemy cannot see it, wherever its sight reaches
    const foe = w.spawnUnit('russia_rifle', 1, deep![0] + 2, deep![1]);
    foe.x = foe.px = deep![0] + 2;
    expect(w.sees(1, dv)).toBe(false);
    expect(w.sees(0, dv)).toBe(true); // its own side always
    // a rifle, a shell and a bomb do nothing
    const hp0 = dv.hp;
    w.damage(dv, 80, 'mg', foe);
    const tank = w.spawnUnit('russia_mbt', 1, deep![0] + 3, deep![1]);
    w.damage(dv, 500, 'artillery', tank);
    w.splash(dv.x, dv.y, 3, 400, 'artillery', tank, -1);
    expect(dv.hp).toBe(hp0);
    // a boat's sonar finds it, and its gun hurts it
    const boat = w.spawnUnit('russia_patrol', 1, deep![0] + 3, deep![1] + 1);
    w.step();
    expect(Math.hypot(boat.x - dv.x, boat.y - dv.y)).toBeLessThan(SONAR_RANGE);
    expect(w.sees(1, dv)).toBe(true);
    w.damage(dv, 40, 'mg', boat);
    expect(dv.hp).toBeLessThan(hp0);
    // far from the boat it is hidden again
    boat.x = boat.px = deep![0] + 3 + SONAR_RANGE + 2;
    w.step();
    expect(w.sees(1, dv)).toBe(false);
    // (the others leave, so the shore fight is a fair one)
    for (const e of [foe, tank, boat]) w.remove(e);
    dv.hp = unitDef('usa_diver').hp;
    // it holds its fire under the water: nothing to shoot at from there, and an attack order brings it in
    const tgt = w.spawnUnit('russia_rifle', 1, west[0], west[1]);
    tgt.hp = 25; // (a wounded rifleman: the diver is as good as a rifleman, not better, so the duel is kept short)
    w.issue(0, { type: 'attack', ids: [dv.id], target: tgt.id });
    const d0 = Math.hypot(dv.x - tgt.x, dv.y - tgt.y);
    for (let t = 0; t < TPS * 8; t++) w.step();
    expect(Math.hypot(dv.x - tgt.x, dv.y - tgt.y)).toBeLessThan(d0 - 4);
    // in the shallows / on land it is a rifleman: it fires and kills
    expect(runUntil(w, () => tgt.dead, TPS * 120)).toBe(true);
    expect(dv.dive).toBe(false);
    expect(dv.dead).toBe(false);
  }, 300_000);
});
