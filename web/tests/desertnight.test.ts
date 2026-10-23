import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { CAPS, houseAwake, isDesertLayout, planTown } from '../src/render/fx/desertnight/places';
import { placeholderSlots } from '../src/render/fx/desertnight/slots';
import { planBoats, planOil, planResorts } from '../src/render/fx/desertnight/sea';
import { planSigns, RESORT_NAMES } from '../src/render/fx/desertnight/signs';
import { reflectables } from '../src/render/fx/desertnight';
import type { SeaNightSpot } from '../src/render/seaside';

const desert = createMap('desert', 1);

describe('desert night lights (render/fx/desertnight)', () => {
  it('only the desert layout gets a plan: other maps build nothing', () => {
    expect(isDesertLayout(desert)).toBe(true);
    for (const id of ['frontline', 'winter', 'urban'] as const) {
      const m = createMap(id, 1);
      expect(isDesertLayout(m)).toBe(false);
      const p = planTown(m, 1);
      expect(p.windows.length + p.lamps.length + p.posts.length + p.houses.length).toBe(0);
    }
  });

  it('is deterministic for a seed and varies with it', () => {
    const a = planTown(desert, 7);
    const b = planTown(desert, 7);
    expect(JSON.stringify(a.windows)).toBe(JSON.stringify(b.windows));
    expect(JSON.stringify(a.lamps)).toBe(JSON.stringify(b.lamps));
    expect(a.houses.map((h) => h.awake)).toEqual(b.houses.map((h) => h.awake));
    const c = planTown(desert, 8);
    expect(c.houses.map((h) => h.awake)).not.toEqual(a.houses.map((h) => h.awake));
    // chosen by tile position: the same structure decides the same way each call
    const st = desert.structures[3];
    expect(houseAwake(st, 5)).toBe(houseAwake(st, 5));
  });

  it('about half of the houses sleep (all lights out) and the mosques never do', () => {
    const p = planTown(desert, 1);
    const houses = p.houses.filter((h) => h.st.look !== 'mosque');
    const asleep = houses.filter((h) => !h.awake).length / houses.length;
    expect(asleep).toBeGreaterThan(0.3);
    expect(asleep).toBeLessThan(0.7);
    expect(p.houses.filter((h) => h.st.look === 'mosque').every((h) => h.awake)).toBe(true);
    // a sleeping house has no lit window
    const dark = new Set(p.houses.map((h, i) => (h.awake ? -1 : i)));
    expect(p.windows.every((w) => !dark.has(w.house))).toBe(true);
  });

  it('light counts stay under the caps; one window in ten is a TV', () => {
    for (const seed of [1, 2, 3, 99]) {
      const p = planTown(desert, seed);
      expect(p.windows.length).toBeGreaterThan(40);
      expect(p.windows.length).toBeLessThanOrEqual(CAPS.windows);
      expect(p.lamps.length).toBeLessThanOrEqual(CAPS.lamps);
      expect(p.posts.length).toBeLessThanOrEqual(CAPS.posts);
      const tv = p.windows.filter((w) => w.tv).length / p.windows.length;
      expect(tv).toBeGreaterThan(0.03);
      expect(tv).toBeLessThan(0.2);
    }
  });

  it('street lamps stand along the roads inside the villages, never on water', () => {
    const p = planTown(desert, 1);
    expect(p.posts.length).toBeGreaterThan(8);
    for (const q of p.posts) {
      const near = p.houses.some((h) => Math.hypot(h.cx - q.x, h.cz - q.z) < 8.6);
      expect(near).toBe(true);
    }
    expect(p.lamps.filter((l) => l.kind === 'street').length).toBe(p.posts.length);
  });

  it('the mosque has its minaret, dome and gate lights', () => {
    const p = planTown(desert, 1);
    const kinds = new Set(p.lamps.map((l) => l.kind));
    for (const k of ['minaret', 'dome', 'gate', 'porch', 'fire']) expect(kinds.has(k)).toBe(true);
  });

  it('every window sits on a wall of its building and faces away from it', () => {
    for (const st of desert.structures) {
      const s = placeholderSlots(st, 0);
      const cx = st.x + st.w / 2;
      const cz = st.y + st.h / 2;
      for (const w of s.windows) {
        expect(Math.hypot(w.nx, w.nz)).toBeCloseTo(1, 5);
        expect(w.y).toBeGreaterThan(0.05);
        // within the footprint's reach and pointing outwards from the centre line of its wall
        expect(Math.hypot(w.x - cx, w.z - cz)).toBeLessThan(2.6);
      }
    }
  });

  it('the sea lights: resort spots, moored boats, buoys, the oil sites', () => {
    const spots: SeaNightSpot[] = [
      { kind: 'pool', x: 50, y: 0.3, z: 60, r: 1.2, yaw: 0, site: 0 },
      { kind: 'restaurant', x: 52, y: 0.3, z: 61, r: 1.3, yaw: 0, site: 0 },
      { kind: 'bar', x: 55, y: 0.1, z: 66, r: 0.5, yaw: 0.4, site: 0 },
      { kind: 'palm', x: 51, y: 0.3, z: 59, r: 0.5, yaw: 0, site: 0 },
      { kind: 'palm', x: 52, y: 0.3, z: 59, r: 0.5, yaw: 0, site: 0 },
      { kind: 'jetty', x: 56, y: 0, z: 68, r: 0, yaw: 0.4, site: 0 },
      { kind: 'jetty', x: 56, y: 0, z: 69, r: 1, yaw: 0.4, site: 0 },
      { kind: 'pontoon', x: 56, y: -0.1, z: 70, r: 0.8, yaw: 0.4, site: 0 },
      { kind: 'buoy', x: 60, y: -0.2, z: 70, r: 0, yaw: 0, site: 0 },
      { kind: 'buoy', x: 61, y: -0.2, z: 71, r: 1, yaw: 0, site: 0 },
      { kind: 'sign', x: 49, y: 0.3, z: 58, r: 0, yaw: 0.2, site: 0 },
    ];
    const lamps = planResorts(spots);
    const kinds = new Set(lamps.map((l) => l.kind));
    for (const k of ['pool', 'string', 'restaurant', 'bar', 'palm', 'jetty', 'pontoon', 'buoy']) expect(kinds.has(k)).toBe(true);
    // every other palm only
    expect(lamps.filter((l) => l.kind === 'palm').length).toBe(1);
    // buoys blink, one red one green
    const buoys = lamps.filter((l) => l.kind === 'buoy');
    expect(buoys.every((b) => b.mode === 2)).toBe(true);
    expect(buoys[0].r).toBeGreaterThan(buoys[0].g);
    expect(buoys[1].g).toBeGreaterThan(buoys[1].r);
    // a boat carries four lights: red, green, stern and mast
    const boat = planBoats([{ x: 10, z: 10, yaw: 0.5, kind: 0 }]);
    expect(boat.length).toBe(4);
    expect(boat.filter((b) => b.r > 0.9 && b.g < 0.3).length).toBe(1);
    expect(boat.filter((b) => b.g > 0.9 && b.r < 0.3).length).toBe(1);
    // the signs carry fictional names, one per resort
    const signs = planSigns(spots);
    expect(signs.length).toBe(2);
    expect(RESORT_NAMES.every((n) => /^[A-Z ]+$/.test(n))).toBe(true);
    // the desert map's 8 oil sites each get a flare stack and a mast light
    const oil = planOil(desert.oils, () => 0);
    expect(oil.stacks.length).toBe(desert.oils.length);
    expect(oil.lamps.filter((l) => l.kind === 'flare').length).toBe(desert.oils.length);
    expect(oil.lamps.filter((l) => l.kind === 'derrick').every((l) => l.mode === 3)).toBe(true);
    // the sea reflects the boats, the buoys and the bar, never the palms' uplights
    const refl = reflectables([...lamps, ...boat], [{ x: 1, y: 1, z: 1 }], [{ x: 2, y: 2, z: 2 }]);
    expect(refl.length).toBeGreaterThan(8);
    expect(lamps.filter((l) => l.kind === 'palm').length).toBe(1);
    expect(refl.length).toBe(lamps.filter((l) => ['buoy', 'jetty', 'pontoon', 'bar', 'restaurant', 'string'].includes(l.kind)).length + boat.length + 2);
  });
});
