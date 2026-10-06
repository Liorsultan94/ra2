import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { ORE_MAX, type MapId } from '../src/sim/map';
import { World } from '../src/sim/world';
import { buildLayout } from '../src/render/layout';
import { PER_GEM, PER_ORE, oreFieldKinds, oreKeepOut, pieceScale, planOreSlots } from '../src/render/orefield';
import { planGroundCover } from '../src/render/vegetation';
import { planProps, type PropsManifest } from '../src/render/props';
import manRaw from '../public/props/props.json?raw';

const MAPS: MapId[] = ['frontline', 'desert', 'winter', 'urban'];

describe('ore depletion', () => {
  it('pieces shrink with the amount, the higher ranks vanish first, the last goes with the last unit', () => {
    for (const per of [PER_GEM, PER_ORE]) {
      for (let r = 0; r < per; r++) {
        expect(pieceScale(0, r, per)).toBe(0);
        expect(pieceScale(ORE_MAX, r, per)).toBeCloseTo(1, 6);
        let prev = 0;
        for (let a = 0; a <= ORE_MAX; a++) {
          const s = pieceScale(a, r, per);
          expect(s).toBeGreaterThanOrEqual(prev); // never grows as the tile is mined
          expect(s).toBeLessThanOrEqual(1);
          if (s > 0) expect(s).toBeGreaterThanOrEqual(0.3);
          prev = s;
        }
      }
      // the main piece stays (small) down to the last unit
      expect(pieceScale(1, 0, per)).toBeGreaterThan(0);
      expect(pieceScale(1, 0, per)).toBeLessThan(0.5);
      // fewer pieces on a half-mined tile than on a full one
      const count = (a: number) => [...Array(per).keys()].filter((r) => pieceScale(a, r, per) > 0).length;
      expect(count(ORE_MAX)).toBe(per);
      expect(count(Math.round(ORE_MAX * 0.4))).toBeLessThan(per);
      expect(count(1)).toBe(1);
      for (let a = 1; a < ORE_MAX; a++) expect(count(a)).toBeLessThanOrEqual(count(a + 1));
    }
  });
});

describe('ore fields are tidy', () => {
  for (const id of MAPS) {
    it(`${id}: pieces only on field tiles, inside their tile; no plants, stones or props in a field`, () => {
      const m = createMap(id, 1);
      const kinds = oreFieldKinds(m);
      const slots = planOreSlots(m, kinds);
      expect(slots.length).toBeGreaterThan(50);
      expect(JSON.stringify(planOreSlots(m, kinds))).toBe(JSON.stringify(slots));
      const covered = new Set(slots.map((s) => s.tile));
      for (let i = 0; i < m.ore.length; i++) if (m.ore[i] && !m.blocked[i]) expect(covered.has(i), `ore tile ${i % m.w},${(i / m.w) | 0} has no pieces`).toBe(true);
      for (const s of slots) {
        expect(kinds[s.tile]).toBe(s.kind);
        expect(Math.floor(s.x) + Math.floor(s.z) * m.w, 'piece outside its tile').toBe(s.tile);
        // the piece's footprint (about 0.6 x its scale across) stays inside the tile too
        const fx = s.x - Math.floor(s.x);
        const fz = s.z - Math.floor(s.z);
        expect(Math.min(fx, 1 - fx, fz, 1 - fz)).toBeGreaterThanOrEqual(0.14 - 1e-9);
      }
      // render-only ground cover keeps a tile clear around every field
      const keep = oreKeepOut(m, 1, kinds);
      const L = buildLayout(m);
      for (const q of ['low', 'medium', 'high'] as const) {
        const gc = planGroundCover(m, L, q);
        for (const [what, list] of Object.entries(gc))
          for (const p of list) expect(keep[Math.floor(p.z) * m.w + Math.floor(p.x)], `${q} ${what} at ${p.x.toFixed(1)},${p.z.toFixed(1)} in an ore field`).toBe(0);
      }
      // map props never stand on a field tile
      const man = JSON.parse(manRaw) as PropsManifest;
      for (const spots of planProps(m, L, 'high', man).values()) for (const s of spots) expect(kinds[Math.floor(s.z) * m.w + Math.floor(s.x)], `prop at ${s.x.toFixed(1)},${s.z.toFixed(1)} in an ore field`).toBe(0);
    });
  }

  it('the regrowing ore never leaves the field (the ground stain and the crystals cover it all)', () => {
    const w = new World({
      seed: 5,
      players: [
        { name: 'A', faction: 'usa', color: 0, isAI: false },
        { name: 'B', faction: 'russia', color: 0, isAI: false },
      ],
    });
    const m = w.map;
    const kinds = oreFieldKinds(m);
    // a mined-out field regrows from its rig
    const mm = m.oreMines[0];
    for (let y = mm.y - 6; y <= mm.y + 6; y++) for (let x = mm.x - 6; x <= mm.x + 6; x++) if (x >= 0 && y >= 0 && x < m.w && y < m.h) m.ore[y * m.w + x] = 0;
    for (let t = 0; t < 20 * 4 * 60; t++) w.step();
    let grown = 0;
    for (let i = 0; i < m.ore.length; i++) {
      if (!m.ore[i]) continue;
      expect(kinds[i], `ore at ${i % m.w},${(i / m.w) | 0} outside the field`).toBeGreaterThan(0);
      if (Math.abs((i % m.w) - mm.x) <= 6 && Math.abs(((i / m.w) | 0) - mm.y) <= 6) grown++;
    }
    expect(grown).toBeGreaterThan(5);
  });
});
