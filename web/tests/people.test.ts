import { describe, expect, it } from 'vitest';
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
      const { grid } = setup(id);
      const pf = new PathFinder(grid, 20000);
      const pts = cheapPoints(grid, 600, 3);
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
        expect(out[(n - 1) * 2]).toBeCloseTo(b.x, 5);
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
        const poly = routePolyline(net, r.segs, 0.25, 1.4);
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
