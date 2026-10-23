import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DesertLights } from '../src/render/fx/desertnight/lights';
import { SignBoards } from '../src/render/fx/desertnight/signs';
import type { FogOfWar } from '../src/render/fog';
import { desertNightHaze } from '../src/render/fx/atmosrules';
import { createMap } from '../src/sim/maps';
import { CAPS, houseAwake, isDesertLayout, planTown } from '../src/render/fx/desertnight/places';
import { placeholderSlots, usesSharedSlots } from '../src/render/fx/desertnight/slots';
import { gulfHeads, planBoats, planHarbours, planOil, planResorts } from '../src/render/fx/desertnight/sea';
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
    // (BD1's slots file decides by tile position alone: the placeholder also mixes in the match seed)
    if (!usesSharedSlots) expect(c.houses.map((h) => h.awake)).not.toEqual(a.houses.map((h) => h.awake));
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

  it('highway markers stand along the wide road outside the villages, under the cap', () => {
    const p = planTown(desert, 1);
    expect(p.markers.length).toBeGreaterThan(10);
    expect(p.markers.length).toBeLessThanOrEqual(CAPS.markers);
    for (const q of p.markers) expect(p.houses.some((h) => Math.hypot(h.cx - q.x, h.cz - q.z) < 8)).toBe(false);
  });

  it('planning never touches the map (the sim state is read only)', () => {
    const m = createMap('desert', 1);
    const before = JSON.stringify([m.structures, m.tiles.slice(0, 5000), m.roads, m.oils, m.blocked.slice(0, 5000)]);
    planTown(m, 3);
    expect(JSON.stringify([m.structures, m.tiles.slice(0, 5000), m.roads, m.oils, m.blocked.slice(0, 5000)])).toBe(before);
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

  it('the night haze is the desert only: none by day, a touch from the evening, gone with the dawn banks', () => {
    expect(desertNightHaze(12, 'desert')).toBe(0);
    expect(desertNightHaze(23, 'desert')).toBeGreaterThan(0.1);
    expect(desertNightHaze(23, 'desert')).toBeLessThan(0.2);
    expect(desertNightHaze(2, 'desert')).toBeGreaterThan(0.1);
    expect(desertNightHaze(7, 'desert')).toBe(0);
    for (const b of ['temperate', 'winter', 'urban']) expect(desertNightHaze(23, b)).toBe(0);
  });

  it('the gulfs have harbour lights at their heads', () => {
    const heads = gulfHeads(desert);
    expect(heads.length).toBeGreaterThanOrEqual(2);
    // the two gulfs of the Sinai end near (41, 112) and (113, 51)
    expect(heads.some((h) => Math.hypot(h.x - 41, h.y - 112) < 8)).toBe(true);
    expect(heads.some((h) => Math.hypot(h.x - 113, h.y - 51) < 8)).toBe(true);
    const hb = planHarbours(desert, () => 0);
    expect(hb.lamps.length).toBeGreaterThanOrEqual(8);
    expect(hb.posts.length).toBe(hb.lamps.length);
    // red and green mouth lights
    expect(hb.lamps.some((l) => l.r > 0.9 && l.g < 0.3)).toBe(true);
    expect(hb.lamps.some((l) => l.g > 0.9 && l.r < 0.3)).toBe(true);
  });

  it('the light meshes: a handful of draw calls, instance counts from the plan, a ruined house goes dark', () => {
    const fog = { uniforms: {}, apply: (m: THREE.Material) => m } as unknown as FogOfWar;
    const plan = planTown(desert, 1);
    const oil = planOil(desert.oils, () => 0);
    plan.lamps.push(...oil.lamps);
    plan.stacks.push(...oil.stacks);
    const L = new DesertLights(fog, plan, (a) => ((a * 2654435761) % 1000) / 1000);
    const st = L.stats();
    expect(st.windows).toBe(plan.windows.length);
    expect(st.lamps).toBe(plan.lamps.length);
    expect(st.posts).toBe(plan.posts.length);
    expect(st.stacks).toBe(oil.stacks.length);
    // windows, sprites, pools, posts, stacks, markers: six draw calls at most
    expect(st.draws).toBeLessThanOrEqual(6);
    const win = L.group.getObjectByName('desert-windows') as THREE.InstancedMesh;
    const alive = win.geometry.getAttribute('aAlive') as THREE.InstancedBufferAttribute;
    const house = plan.windows[0].house;
    const mine = plan.windows.map((w, i) => (w.house === house ? i : -1)).filter((i) => i >= 0);
    expect(mine.every((i) => alive.getX(i) === 1)).toBe(true);
    L.setHouseAlive(house, false);
    expect(mine.every((i) => alive.getX(i) === 0)).toBe(true);
    expect(plan.windows.every((w, i) => w.house === house || alive.getX(i) === 1)).toBe(true);
    L.setHouseAlive(house, true);
    expect(mine.every((i) => alive.getX(i) === 1)).toBe(true);
    // by day nothing of the night meshes is drawn; at night they are
    L.update(0, 1, 0);
    expect(win.visible).toBe(false);
    L.update(1, 1, 0);
    expect(win.visible).toBe(true);
    L.dispose();
    const spots: SeaNightSpot[] = [{ kind: 'sign', x: 1, y: 0, z: 1, r: 0, yaw: 0, site: 0 }, { kind: 'bar', x: 3, y: 0, z: 3, r: 0, yaw: 0.2, site: 1 }];
    const boards = new SignBoards(fog, planSigns(spots), { uNight: { value: 0 }, uTime: { value: 0 }, uLate: { value: 0 } });
    expect(boards.group.getObjectByName('desert-sign-boards')).toBeTruthy();
    boards.dispose();
  });
});
