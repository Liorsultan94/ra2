// SL1: slopes. Steps too steep for a locomotion class are closed (sim/slope.ts); the maps' tracks and footpaths
// (sim/maps.ts DESERT_RAMPS) lead up the mountains; groups flow through the canyon and over the tracks.
import { describe, expect, it } from 'vitest';
import { buildingDef } from '../src/sim/defs';
import { MAP_IDS, SINAI_OLD } from '../src/sim/maps';
import { LOCO_COUNT, Loco, MAX_GRADE, OPP } from '../src/sim/slope';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

function world(map: (typeof MAP_IDS)[number], seed = 1) {
  return new World({ seed, map, players: [
    { name: 'A', faction: 'usa', color: 0, isAI: true },
    { name: 'B', faction: 'russia', color: 0, isAI: true },
  ] });
}

/** Walk a path (tile indices) from tile (sx, sy) as a unit does (straight legs between waypoints): steepest step and length. */
function walk(w: World, sx: number, sy: number, path: number[]) {
  const W = w.map.w;
  let steep = 0;
  let len = 0;
  let x = sx + 0.5;
  let y = sy + 0.5;
  let prev = sy * W + sx;
  for (const t of path) {
    const tx = (t % W) + 0.5;
    const ty = Math.floor(t / W) + 0.5;
    const L = Math.hypot(tx - x, ty - y);
    len += L;
    for (let i = 1, n = Math.ceil(L / 0.05); i <= n; i++) {
      const c = w.tileOf(x + ((tx - x) * i) / n, y + ((ty - y) * i) / n);
      if (c === prev) continue;
      // grade of the move between the two tiles (orthogonal neighbours; a corner crossing takes the gentler side)
      const k = [1, -1, W, -W].indexOf(c - prev);
      const g = k >= 0 ? w.slope.grade[prev * 8 + k] : Math.min(...[1, -1].flatMap((sx) => [W, -W].map((sy) => (prev + sx + sy === c ? Math.max(w.slope.grade[prev * 8 + (sx > 0 ? 0 : 1)], w.slope.grade[(prev + sx) * 8 + (sy > 0 ? 2 : 3)]) : Infinity))));
      steep = Math.max(steep, g);
      prev = c;
    }
    x = tx;
    y = ty;
  }
  return { steep, len };
}

describe('slopes (SL1)', () => {
  it('the step grades and the closed steps are exactly point mirrored on symmetric maps', () => {
    for (const id of ['frontline', 'winter', 'urban'] as const) {
      const w = world(id, 3);
      const n = w.map.w * w.map.h;
      let bad = 0;
      for (let i = 0; i < n; i++)
        for (let k = 0; k < 8; k++) {
          const j = n - 1 - i;
          if (w.slope.grade[i * 8 + k] !== w.slope.grade[j * 8 + OPP[k]]) bad++;
          for (let c = 0; c < LOCO_COUNT; c++) if (((w.slope.block[c][i] >> k) & 1) !== ((w.slope.block[c][j] >> OPP[k]) & 1)) bad++;
        }
      expect(bad, id).toBe(0);
      for (let i = 0; i < n; i++) if (w.pass[i] !== w.pass[n - 1 - i]) bad++;
      expect(bad, `${id}: passability`).toBe(0);
    }
  });

  it('limits: vehicles about 28 degrees, infantry about 40', () => {
    expect(Math.atan(MAX_GRADE[Loco.Vehicle]) * (180 / Math.PI)).toBeGreaterThan(25);
    expect(Math.atan(MAX_GRADE[Loco.Vehicle]) * (180 / Math.PI)).toBeLessThan(30);
    expect(Math.atan(MAX_GRADE[Loco.Foot]) * (180 / Math.PI)).toBeGreaterThan(35);
    expect(Math.atan(MAX_GRADE[Loco.Foot]) * (180 / Math.PI)).toBeLessThanOrEqual(40);
  });

  it('a tank cannot drive straight up the Sinai massif\'s north face: it winds round to the gentle way up, every step under its limit', () => {
    for (const seed of [1, 2, 3]) {
      const w = world('desert', seed);
      // the north foot of the massif on player 0's side (St Catherine), and the summit plateau above it
      const { dx, dy } = SINAI_OLD;
      const [sx, sy, gx, gy] = [85 + dx, 105 + dy, 93 + dx, 112 + dy];
      const veh = w.pfs[Loco.Vehicle].find(sx, sy, gx, gy, 100000);
      expect(veh[veh.length - 1], `seed ${seed}: the plateau is reachable by vehicles`).toBe(gy * w.map.w + gx);
      const v = walk(w, sx, sy, veh);
      expect(v.steep, `seed ${seed}`).toBeLessThanOrEqual(MAX_GRADE[Loco.Vehicle]);
      // a straight line up would be too steep for it
      expect(w.lineOk(sx + 0.5, sy + 0.5, gx + 0.5, gy + 0.5, Loco.Vehicle)).toBe(false);
      expect(v.len, `seed ${seed}`).toBeGreaterThan(2 * Math.hypot(gx - sx, gy - sy));
      // soldiers take the footpath straight up (steeper than a vehicle can take, under their own limit)
      const ft = w.pfs[Loco.Foot].find(sx, sy, gx, gy, 100000);
      expect(ft[ft.length - 1]).toBe(gy * w.map.w + gx);
      const f = walk(w, sx, sy, ft);
      expect(f.steep, `seed ${seed}`).toBeLessThanOrEqual(MAX_GRADE[Loco.Foot]);
      expect(f.steep, `seed ${seed}: the footpath is too steep for vehicles`).toBeGreaterThan(MAX_GRADE[Loco.Vehicle]);
      expect(f.len, `seed ${seed}`).toBeLessThan(v.len * 0.8);
    }
  });

  it('a move order onto ground a unit cannot reach sends it to the nearest point it can', () => {
    const w = world('desert');
    w.controllers.length = 0;
    const W = w.map.w;
    // a tile soldiers reach but vehicles cannot (a ledge up a cliff), next to the summit plateau or anywhere
    let target = -1;
    for (let i = 0; i < W * w.map.h && target < 0; i++) if (w.pass[i] && w.regions[Loco.Foot][i] === w.mainlands[Loco.Foot] && w.regions[Loco.Vehicle][i] !== w.mainland) target = i;
    expect(target).toBeGreaterThanOrEqual(0);
    const tx = (target % W) + 0.5;
    const ty = Math.floor(target / W) + 0.5;
    const near = w.nearestPassable(tx, ty, 12, w.mainland, Loco.Vehicle)!;
    const at = w.nearestPassable(tx + 6, ty + 6, 12, w.mainland, Loco.Vehicle)!;
    const tank = w.spawnUnit('usa_mbt', 0, at[0] + 0.5, at[1] + 0.5);
    w.issue(0, { type: 'move', ids: [tank.id], x: tx, y: ty });
    w.step();
    for (let t = 0; t < 60 * TPS && tank.order.type !== 'idle'; t++) w.step();
    expect(w.regionOf(tank.x, tank.y, Loco.Vehicle)).toBe(w.mainland);
    expect(Math.hypot(tank.x - (near[0] + 0.5), tank.y - (near[1] + 0.5)), `target ${tx},${ty} nearest ${near} tank ${tank.x.toFixed(1)},${tank.y.toFixed(1)}`).toBeLessThan(2.5);
  });

  it('every start, ore field, oil derrick, tech site and garrisonable house is reachable by vehicles from both starts', () => {
    for (const id of MAP_IDS)
      for (const seed of id === 'desert' ? [1, 2, 3, 7] : [1]) {
        const w = world(id, seed);
        const W = w.map.w;
        const R = w.regions[Loco.Vehicle];
        const s = w.map.starts;
        expect(R[s[0].y * W + s[0].x], `${id}/${seed}: start 0`).toBe(w.mainland);
        expect(R[s[1].y * W + s[1].x], `${id}/${seed}: start 1`).toBe(w.mainland);
        // an ore field: most of its ore within reach
        for (const mn of w.map.oreMines) {
          let n = 0;
          let ok = 0;
          for (let y = mn.y - 5; y <= mn.y + 5; y++)
            for (let x = mn.x - 5; x <= mn.x + 5; x++) {
              const i = y * W + x;
              if (x < 0 || y < 0 || x >= W || y >= w.map.h || !w.map.ore[i]) continue;
              n++;
              if (R[i] === w.mainland) ok++;
            }
          expect(ok / Math.max(1, n), `${id}/${seed}: ore field at ${mn.x},${mn.y}`).toBeGreaterThan(0.9);
        }
        // neutral buildings: a passable tile beside the footprint in the mainland
        const neutral = w.list.filter((e: Entity) => e.kind === 'building' && e.owner < 0 && e.def !== 'bridge' && e.def !== 'bridgehut');
        expect(neutral.length).toBeGreaterThan(4);
        for (const b of neutral) {
          const d = buildingDef(b.def);
          let ok = false;
          for (let y = b.ty - 1; y <= b.ty + d.h && !ok; y++)
            for (let x = b.tx - 1; x <= b.tx + d.w && !ok; x++) if (x >= 0 && y >= 0 && x < W && y < w.map.h && R[y * W + x] === w.mainland) ok = true;
          expect(ok, `${id}/${seed}: ${b.def} at ${b.tx},${b.ty}`).toBe(true);
        }
      }
  });

  /** Groups of tanks and soldiers ordered from a to b (several groups at once); seconds until all arrive, and who did not. */
  function flow(w: World, groups: { owner: number; from: { x: number; y: number }; to: { x: number; y: number }; tanks: number; inf: number }[], T: number) {
    const all: { to: { x: number; y: number }; e: Entity }[] = [];
    for (const g of groups) {
      const ids: number[] = [];
      const put = (def: string, x: number, y: number) => {
        const p = w.nearestPassable(x, y, 6, w.mainlands[Loco.Foot], Loco.Foot)!;
        const e = w.spawnUnit(def, g.owner, p[0] + 0.5, p[1] + 0.5);
        ids.push(e.id);
        all.push({ to: g.to, e });
      };
      for (let i = 0; i < g.tanks; i++) put(`usa_mbt`, g.from.x + ((i % 3) - 1) * 1.1, g.from.y + Math.floor(i / 3) * 1.1);
      for (let i = 0; i < g.inf; i++) put(`usa_rifle`, g.from.x + ((i % 4) - 1.5) * 0.6, g.from.y - 1.5 - Math.floor(i / 4) * 0.6);
      w.issue(g.owner, { type: 'move', ids, x: g.to.x, y: g.to.y });
    }
    let t = 0;
    const left = () => all.filter(({ e, to }) => Math.hypot(e.x - to.x, e.y - to.y) > 4 || w.regionOf(e.x, e.y, w.locoOf(e)) !== w.regionOf(to.x, to.y, w.locoOf(e)));
    for (; t < T * TPS && left().length; t++) w.step();
    return { secs: t / TPS, left: left().map(({ e }) => `${e.def}@${e.x.toFixed(1)},${e.y.toFixed(1)}`) };
  }
  // the old 160 x 160 layout's tiles (moved by whole tiles into the traced peninsula: SINAI_OLD), and its mirror
  // across its own diagonal
  const old = (x: number, y: number) => ({ x: x + SINAI_OLD.dx, y: y + SINAI_OLD.dy });
  const M = (p: { x: number; y: number }) => old(p.y - SINAI_OLD.dy, p.x - SINAI_OLD.dx);
  // the coloured canyon's upper and lower mouths (on the Aqaba side: the old layout's mirrored one), the summit
  // track's foot and the plateau it leads to
  const UP = old(87.8, 69.2);
  const DOWN = old(108.6, 76.7);
  const FOOT = old(75.3, 110);
  const TOP = old(93.9, 112.9);

  it('groups of tanks and soldiers flow through the coloured canyon both ways, either side\'s, and past each other head-on', () => {
    const cases: [string, Parameters<typeof flow>[1]][] = [
      ['down', [{ owner: 0, from: UP, to: DOWN, tanks: 8, inf: 8 }]],
      ['up', [{ owner: 0, from: DOWN, to: UP, tanks: 8, inf: 8 }]],
      ['red down', [{ owner: 1, from: UP, to: DOWN, tanks: 8, inf: 8 }]],
      ['red up', [{ owner: 1, from: DOWN, to: UP, tanks: 8, inf: 8 }]],
      ['head-on', [
        { owner: 0, from: UP, to: DOWN, tanks: 6, inf: 6 },
        { owner: 0, from: DOWN, to: UP, tanks: 6, inf: 6 },
      ]],
    ];
    for (const [name, groups] of cases) {
      const w = world('desert');
      w.controllers.length = 0;
      const r = flow(w, groups, 45);
      expect(r.left, `canyon ${name} (${r.secs} s)`).toEqual([]);
    }
  });

  it('groups climb and descend the summit track, also meeting head-on', () => {
    const cases: [string, Parameters<typeof flow>[1]][] = [
      ['up', [{ owner: 0, from: FOOT, to: TOP, tanks: 6, inf: 6 }]],
      ['down', [{ owner: 0, from: TOP, to: FOOT, tanks: 6, inf: 6 }]],
      ['mirrored up', [{ owner: 1, from: M(FOOT), to: M(TOP), tanks: 6, inf: 6 }]],
      ['head-on', [
        { owner: 0, from: FOOT, to: TOP, tanks: 5, inf: 4 },
        { owner: 0, from: TOP, to: FOOT, tanks: 5, inf: 4 },
      ]],
    ];
    for (const [name, groups] of cases) {
      const w = world('desert');
      w.controllers.length = 0;
      const r = flow(w, groups, 45);
      expect(r.left, `track ${name} (${r.secs} s)`).toEqual([]);
    }
  });
});
