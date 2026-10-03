import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { Tile, type MapId } from '../src/sim/map';
import { buildLayout, occAt, OCC_ROAD, OCC_TRACK } from '../src/render/layout';
import { planProps, type PropsManifest } from '../src/render/props';

// the manifest the runtime loads (tools/bake-props.mjs)
import manRaw from '../public/props/props.json?raw';

const man = JSON.parse(manRaw) as PropsManifest;

describe('map props', () => {
  it('manifest stays within the triangle and download budgets', () => {
    for (const [id, p] of Object.entries(man.props)) {
      expect(p.tris[0], id).toBeLessThanOrEqual(1500);
      expect(p.tris[1], id).toBeLessThanOrEqual(300);
      expect(p.biomes.length, id).toBeGreaterThan(0);
    }
    const tiers = (man as unknown as { tiers: { medium: number; high: number } }).tiers;
    expect(tiers.medium).toBeLessThan(4 * 1048576);
    expect(tiers.high).toBeLessThan(8 * 1048576);
  });

  for (const id of ['frontline', 'desert', 'winter', 'urban'] as MapId[]) {
    it(`${id}: deterministic, off roads / bases / water`, () => {
      const m = createMap(id, 1);
      const layout = buildLayout(m);
      const a = planProps(m, layout, 'high', man);
      const b = planProps(m, layout, 'high', man);
      expect(JSON.stringify([...a])).toBe(JSON.stringify([...b]));
      const med = planProps(m, layout, 'medium', man);
      expect(planProps(m, layout, 'low', man).size).toBe(0);
      let total = 0;
      let totalMed = 0;
      for (const l of med.values()) totalMed += l.length;
      for (const [pid, spots] of a) {
        expect(man.props[pid].biomes, pid).toContain(m.biome);
        for (const s of spots) {
          total++;
          const i = Math.floor(s.z) * m.w + Math.floor(s.x);
          expect(m.tiles[i], `${pid} on water/bridge`).not.toBe(Tile.Water);
          expect(m.tiles[i]).not.toBe(Tile.Bridge);
          expect(occAt(layout, m, s.x, s.z) & (OCC_ROAD | OCC_TRACK), `${pid} on a road at ${s.x.toFixed(1)},${s.z.toFixed(1)}`).toBe(0);
          for (const st of m.starts) expect(Math.hypot(s.x - st.x - 0.5, s.z - st.y - 0.5), `${pid} in a base`).toBeGreaterThan(12);
          for (const o of m.ore.keys()) if (m.ore[o]) expect(o === i, `${pid} on ore`).toBe(false);
        }
      }
      const kinds = a.size;
      console.info(`${id}: ${total} props (medium ${totalMed}) of ${kinds} kinds`, Object.fromEntries([...a].map(([k, v]) => [k, v.length])));
      expect(total).toBeGreaterThan(40);
      expect(totalMed).toBeLessThan(total);
      expect(kinds).toBeLessThanOrEqual(16);
    });
  }
});
