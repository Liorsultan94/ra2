import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { Tile, WATER_LEVEL, type MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadClear, roadNetFor } from '../src/render/ambient/clearance';
import { camelSpots, landmarkClear, landmarkPlan } from '../src/render/landmarks/plan';
import { groundY } from '../src/render/landmarks/ground';
import { levelCrossings } from '../src/render/ambient/rail';

const MAPS: MapId[] = ['frontline', 'desert', 'winter', 'urban'];
const WET_OK = new Set(['suspension', 'pond', 'lake', 'icehut']);

describe('landmark plan', () => {
  it('is deterministic per map and seed', () => {
    for (const id of MAPS) {
      const a = landmarkPlan(createMap(id, 7));
      const b = landmarkPlan(createMap(id, 7));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.spots.length).toBeGreaterThan(3);
    }
  });

  it('keeps the railways out of the playable area', () => {
    for (const id of MAPS) {
      const m = createMap(id, 3);
      for (const r of landmarkPlan(m).rails) for (const p of r.pts) expect(p.x < 0 || p.y < 0 || p.x > m.w || p.y > m.h, `${id} rail at ${p.x},${p.y}`).toBe(true);
    }
  });

  it('puts in-map set pieces only on impassable ground, off water and roads', () => {
    for (const id of MAPS) {
      const m = createMap(id, 5);
      buildLayout(m);
      for (const s of landmarkPlan(m).spots) {
        if (!s.inMap || s.kind === 'suspension') continue;
        const t = m.tiles[Math.floor(s.y) * m.w + Math.floor(s.x)];
        expect(t, `${id} ${s.kind}`).toBe(Tile.Rock);
        expect(roadClear(m, s.x, s.y, 0.3)).toBe(true);
      }
    }
  });

  it('stands nothing in the water unless it belongs there', () => {
    for (const id of MAPS) {
      const m = createMap(id, 2);
      buildLayout(m);
      for (const s of landmarkPlan(m).spots) {
        if (WET_OK.has(s.kind)) continue;
        expect(groundY(m, s.x, s.y), `${id} ${s.kind} at ${s.x},${s.y}`).toBeGreaterThan(WATER_LEVEL + 0.08);
      }
    }
  });

  it('marks the landmark sites for the outskirts trees and city blocks', () => {
    const m = createMap('urban', 1);
    const st = landmarkPlan(m).spots.find((s) => s.kind === 'stadium')!;
    expect(landmarkClear(m, st.x, st.y)).toBe(true);
    expect(landmarkClear(m, -60, 130)).toBe(false);
  });

  it('hands the animals camel spots by the oases (desert only)', () => {
    const m = createMap('desert', 4);
    buildLayout(m);
    const c = camelSpots(m);
    expect(c.length).toBeGreaterThan(4);
    for (const p of c) {
      if (p.x < 0 || p.y < 0 || p.x >= m.w || p.y >= m.h) continue;
      expect(m.tiles[Math.floor(p.y) * m.w + Math.floor(p.x)]).not.toBe(Tile.Water);
    }
    expect(camelSpots(createMap('winter', 4)).length).toBe(0);
  });

  it('crosses the highway at the map edge on Frontline Crossing, where the cars drive', () => {
    const m = createMap('frontline', 1);
    const xs = levelCrossings(m);
    expect(xs.length).toBe(2);
    const net = roadNetFor(m, buildLayout(m));
    for (const c of xs.filter((c) => c.traffic)) {
      // a traffic portal (a lane leaving the map) within 2.5 tiles of the crossing
      const near = net.lines.some((L) => L.portal.some((p, e) => p && Math.hypot((e ? L.pts[L.pts.length - 1] : L.pts[0]).x - c.x, (e ? L.pts[L.pts.length - 1] : L.pts[0]).y - c.y) < 2.5));
      expect(near).toBe(true);
    }
  });
});
