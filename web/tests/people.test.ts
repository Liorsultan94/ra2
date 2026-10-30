import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createMap } from '../src/sim/maps';
import type { MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
import { PathFinder, RES, WF, buildWalkGrid, costAt, dryAt, flagAt, zebraBands, type WalkGrid } from '../src/render/ambient/walkgrid';
import { Tile, WATER_LEVEL } from '../src/sim/map';
import { surfaceHeight } from '../src/render/ground';

const MAPS: MapId[] = ['frontline', 'desert', 'winter', 'urban'];

function setup(id: MapId) {
  const m = createMap(id, 1);
  const layout = buildLayout(m);
  const net = roadNetFor(m, layout);
  const grid = buildWalkGrid(m, layout, net);
  return { m, layout, net, grid };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Random cheap (pavement-like) points away from roads and bases. */
function cheapPoints(g: WalkGrid, n: number, seed: number) {
  const r = rng(seed);
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < 200000 && out.length < n; k++) {
    const x = r() * g.w;
    const y = r() * g.h;
    const c = costAt(g, x, y);
    if (c && c <= 2 && !(flagAt(g, x, y) & (WF.Road | WF.Base | WF.Field))) out.push({ x, y });
  }
  return out;
}

describe('pedestrian walk grid', () => {
  for (const id of MAPS) {
    it(`${id}: closes water / structures, prices roads above pavements`, () => {
      const { m, grid } = setup(id);
      expect(grid.gw).toBe(m.w * RES);
      for (const st of m.structures) expect(costAt(grid, st.x + st.w / 2, st.y + st.h / 2)).toBe(0);
      let road = 0;
      let dear = 0;
      for (let k = 0; k < grid.cost.length; k++)
        if (grid.flag[k] & WF.Road && !(grid.flag[k] & WF.Zebra)) {
          road++;
          if (grid.cost[k] >= 6) dear++;
        }
      expect(road).toBeGreaterThan(100);
      // nothing walkable in the water or on the waterline
      for (let k = 0; k < grid.cost.length; k += 3) {
        if (!grid.cost[k]) continue;
        const x = ((k % grid.gw) + 0.5) / RES;
        const y = (((k / grid.gw) | 0) + 0.5) / RES;
        const t = m.tiles[(y | 0) * m.w + (x | 0)];
        expect(t).not.toBe(Tile.Water);
        if (t !== Tile.Bridge) expect(surfaceHeight(m, x, y)).toBeGreaterThan(WATER_LEVEL + 0.08);
        expect(dryAt(m, x, y)).toBe(true);
      }
      expect(dear / road).toBeGreaterThan(0.95);
    });

    it(`${id}: routes between nearby spots on the cheap ground`, () => {
      const { m, grid } = setup(id);
      const pf = new PathFinder(grid, 20000);
      // (as many points per tile as on a 128 x 128 map, so a bigger map gets as many close pairs)
      const pts = cheapPoints(grid, Math.max(1000, Math.round((1000 * m.w * m.h) / (128 * 128))), 3);
      const lab = grid.region;
      const cell = (p: { x: number; y: number }) => Math.floor(p.y * RES) * grid.gw + Math.floor(p.x * RES);
      const out = new Float32Array(96);
      let tried = 0;
      let ok = 0;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const a = pts[i];
        const b = pts[i + 1];
        if (Math.hypot(a.x - b.x, a.y - b.y) > 12) continue;
        const same = lab[cell(a)] === lab[cell(b)];
        const n = pf.find(a.x, a.y, b.x, b.y, out);
        // never a calm route between regions the road separates
        if (!same) {
          expect(n).toBe(0);
          continue;
        }
        tried++;
        if (!n) continue;
        ok++;
        // ends on the goal, never through closed cells
        // (float32 path points: some 1e-5 off on a map over 128 tiles)
        expect(out[(n - 1) * 2]).toBeCloseTo(b.x, 4);
        let px = a.x;
        let py = a.y;
        for (let j = 0; j < n; j++) {
          const qx = out[j * 2];
          const qy = out[j * 2 + 1];
          const L = Math.hypot(qx - px, qy - py);
          for (let s = 0.5; s < L * RES * 2 - 0.5; s++) {
            const t = s / (L * RES * 2);
            expect(costAt(grid, px + (qx - px) * t, py + (qy - py) * t)).toBeGreaterThan(0);
          }
          px = qx;
          py = qy;
        }
      }
      expect(tried).toBeGreaterThan(5);
      // (same region but a long way round, e.g. a river with few bridges, may run out of the search budget)
      expect(ok / tried).toBeGreaterThan(0.6);
    });
  }

  it('urban: city crossings have zebras, and walkers mostly cross on them', () => {
    const { m, layout, net, grid } = setup('urban');
    const z = zebraBands(m, layout, net);
    expect(z.length).toBeGreaterThan(40);
    const pf = new PathFinder(grid, 20000);
    const pts = cheapPoints(grid, 300, 9);
    const out = new Float32Array(96);
    let roadCells = 0;
    let zebraCells = 0;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = pts[i];
      const b = pts[i + 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 14) continue;
      const n = pf.find(a.x, a.y, b.x, b.y, out);
      let px = a.x;
      let py = a.y;
      for (let j = 0; j < n; j++) {
        const qx = out[j * 2];
        const qy = out[j * 2 + 1];
        const L = Math.hypot(qx - px, qy - py);
        const steps = Math.ceil(L * RES * 2);
        for (let s = 1; s < steps; s++) {
          const f = flagAt(grid, px + ((qx - px) * s) / steps, py + ((qy - py) * s) / steps);
          if (f & WF.Road) {
            roadCells++;
            if (f & WF.Zebra) zebraCells++;
          }
        }
        px = qx;
        py = qy;
      }
    }
    expect(roadCells).toBeGreaterThan(10);
    // calm walkers never set foot on the road outside the zebras
    expect(zebraCells / roadCells).toBeGreaterThan(0.97);
  });

  it('panic routes may cross the road anywhere', () => {
    const { grid } = setup('urban');
    const pf = new PathFinder(grid, 20000);
    const pts = cheapPoints(grid, 200, 5);
    const out = new Float32Array(96);
    let calm = 0;
    let panic = 0;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = pts[i];
      const b = pts[i + 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 10) continue;
      const len = (n: number) => {
        let L = 0;
        let px = a.x;
        let py = a.y;
        for (let j = 0; j < n; j++) {
          L += Math.hypot(out[j * 2] - px, out[j * 2 + 1] - py);
          px = out[j * 2];
          py = out[j * 2 + 1];
        }
        return L;
      };
      const n0 = pf.find(a.x, a.y, b.x, b.y, out);
      const l0 = n0 ? len(n0) : 0;
      const n1 = pf.find(a.x, a.y, b.x, b.y, out, true);
      const l1 = n1 ? len(n1) : 0;
      if (n0 && n1) {
        calm += l0;
        panic += l1;
      }
    }
    expect(panic).toBeLessThanOrEqual(calm * 1.001);
  });
});

describe('emergency vehicle routes', () => {
  for (const id of MAPS) {
    it(`${id}: reach the roads by the houses from an entry, on the drivable surface`, async () => {
      const { planRoute, routePolyline, reverseSegs } = await import('../src/render/ambient/emroute');
      const { onSurface } = await import('../src/render/ambient/roadnet');
      const { m, net } = setup(id);
      let tried = 0;
      let ok = 0;
      for (const st of m.structures.slice(0, 24)) {
        const x = st.x + st.w / 2;
        const y = st.y + st.h / 2;
        tried++;
        const r = planRoute(net, x, y, 4.5, 12, 75);
        if (!r) continue;
        ok++;
        expect(r.len).toBeGreaterThanOrEqual(12);
        const poly = routePolyline(net, r.segs, 0.25, 1.4, 0.4); // (as emergency.ts drives it in: blue lights, near the centre line)
        const back = routePolyline(net, reverseSegs(r.segs));
        // ends near the house, comes back to where it started
        const end = poly[poly.length - 1];
        expect(Math.hypot(end.x - x, end.y - y)).toBeLessThan(4.5 + Math.max(st.w, st.h));
        // (the other lane: up to a wide avenue apart)
        expect(Math.hypot(back[back.length - 1].x - poly[0].x, back[back.length - 1].y - poly[0].y)).toBeLessThan(2.2);
        let on = 0;
        for (const p of poly) if (onSurface(net, p.x, p.y)) on++;
        expect(on / poly.length).toBeGreaterThan(0.9);
      }
      expect(ok / tried).toBeGreaterThan(0.5);
    });
  }
});

/*
 * Fear ahead of the troops (danger.ts wary layer): walkers ~30 tiles (~170 m) from a force on the
 * move go indoors or walk away; a herd walks off (bolts when it is ~15 tiles off), the shepherd leading.
 */
describe('fear: civilians and herds', () => {
  async function civ(id: MapId) {
    // (the ambient life rolls Math.random: seeded here so the herds and walkers are the same every run;
    // some rolls give frontline no shepherded flock to test, this one does)
    let seed = 7;
    const rnd = vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
    onTestFinished(() => rnd.mockRestore());
    const { World } = await import('../src/sim/world');
    const { People } = await import('../src/render/ambient/people');
    const { Animals } = await import('../src/render/ambient/animals');
    const { FogProbe } = await import('../src/render/ambient/shared');
    const { DangerField } = await import('../src/render/ambient/danger');
    const w = new World({ seed: 1, map: id, players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] } as never);
    const m = w.map;
    const layout = buildLayout(m);
    const net = roadNetFor(m, layout);
    const fog = { apply: (x: unknown) => x, uniforms: { fogEnabled: { value: 0 } }, texture: { image: { data: new Uint8Array(m.w * m.h) } } } as never;
    const probe = new FogProbe(fog, m.w, m.h);
    const people = new People(m, layout, w, net, fog, probe, 'high', false);
    const animals = new Animals(m, layout, fog, probe, 'high', false, people.figures, (tx, ty) => people.builtAt(tx, ty));
    const field = new DangerField(m.w, m.h);
    people.field = field;
    animals.field = field;
    const frame = { dt: 0.1, time: 0, dangers: [], units: new Float32Array(2), nUnits: 0, air: new Float32Array(2), nAir: 0, dark: 0, foul: false, vx0: -1e9, vy0: -1e9, vx1: 1e9, vy1: 1e9 };
    let ft = 0;
    /** Run `sec` seconds with (or without) a moving force at `at` (re-stamped 4 times a second, as AmbientLife does). */
    const run = (sec: number, at: { x: number; y: number } | null, each?: () => void) => {
      for (let t = 0; t < sec; t += 0.1) {
        frame.time += 0.1;
        ft += 0.1;
        if (ft >= 0.25) {
          field.begin();
          if (at) field.threat(at.x, at.y, 36);
          field.commit(ft);
          ft = 0;
        }
        people.update(frame as never);
        animals.update(frame as never);
        each?.();
      }
    };
    return { m, people, animals, field, run };
  }

  type P = { x: number; y: number; s: number; goal: number; show: boolean };
  const INSIDE = 4;
  const FLEE = 9;
  const GONE = 11;

  it('urban: walkers ~30 tiles from a moving column go indoors or walk away; with it parked they carry on', async () => {
    for (const moving of [false, true]) {
      const { m, people, run } = await civ('urban');
      run(5, null);
      const peds = (people as unknown as { peds: P[] }).peds;
      // the column 30 tiles from the middle of the walkers
      let cx = 0;
      let cy = 0;
      for (const p of peds) {
        cx += p.x;
        cy += p.y;
      }
      cx /= peds.length;
      cy /= peds.length;
      const ang = Math.atan2(m.h / 2 - cy, m.w / 2 - cx) + Math.PI;
      const col = { x: cx + Math.cos(ang) * 30, y: cy + Math.sin(ang) * 30 };
      const ring = peds.filter((p) => p.show && p.s !== INSIDE && Math.hypot(p.x - col.x, p.y - col.y) > 22 && Math.hypot(p.x - col.x, p.y - col.y) < 33);
      const d0 = new Map(ring.map((p) => [p, Math.hypot(p.x - col.x, p.y - col.y)]));
      const before = { ...people.stat };
      run(40, moving ? col : null);
      // indoors, gone, or further off than they were
      const away = ring.filter((p) => p.s === INSIDE || p.s === GONE || Math.hypot(p.x - col.x, p.y - col.y) > d0.get(p)! + 2);
      if (moving) {
        expect(ring.length).toBeGreaterThan(4);
        expect(people.stat.wary - before.wary).toBeGreaterThan(ring.length * 0.5);
        expect(away.length).toBeGreaterThan(ring.length * 0.7);
        // nobody left lingering out there within ~100 m of it
        const near = peds.filter((p) => p.show && p.s !== INSIDE && p.s !== GONE && p.s !== FLEE && Math.hypot(p.x - col.x, p.y - col.y) < 16);
        expect(near.length).toBeLessThanOrEqual(1);
      } else expect(people.stat.wary).toBe(0);
    }
  });

  for (const dist of [15, 26]) {
    it(`frontline: a herd ${dist} tiles from a moving force moves off away from it${dist > 18 ? ' at a walk, the shepherd leading' : ''}`, async () => {
      const { m, animals, run } = await civ('frontline');
      type An = { x: number; y: number; s: number };
      type Hd = { sp: number; kind: number; animals: An[]; man: { x: number; y: number } | null };
      const herds = (animals as unknown as { herds: Hd[] }).herds.filter((h) => h.animals.length >= 3 && (dist < 18 || h.man));
      expect(herds.length).toBeGreaterThan(0);
      const h = herds[0];
      const centre = () => {
        let x = 0;
        let y = 0;
        for (const a of h.animals) {
          x += a.x;
          y += a.y;
        }
        return { x: x / h.animals.length, y: y / h.animals.length };
      };
      const c0 = centre();
      // the force on the map-edge side: the way away is open country
      const ang = Math.atan2(c0.y - m.h / 2, c0.x - m.w / 2);
      const src = { x: c0.x + Math.cos(ang) * dist, y: c0.y + Math.sin(ang) * dist };
      const man0 = h.man ? Math.hypot(h.man.x - src.x, h.man.y - src.y) : 0;
      let panic = 0;
      run(30, src, () => {
        for (const a of h.animals) if (a.s === 2) panic++;
      });
      const c1 = centre();
      const moved = Math.hypot(c1.x - src.x, c1.y - src.y) - dist;
      expect(moved).toBeGreaterThan(3);
      if (dist < 18) expect(panic).toBeGreaterThan(0);
      else {
        expect(panic).toBe(0);
        expect(Math.hypot(h.man!.x - src.x, h.man!.y - src.y)).toBeGreaterThan(man0 + 2);
      }
    });
  }
});
