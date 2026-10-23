import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StructureKind, type Structure } from '../src/sim/map';
import { createMap } from '../src/sim/maps';
import { CARDS, FLOOR, PALETTES, VARIANTS, planBuilding, type BuildingPlan, type Op } from '../src/render/buildingplan';
import { buildingInfo, buildingSlots, slotWorld } from '../src/render/buildingslots';

/** BD1: the desert town's building plans: 16 + 3 silhouettes, 9 palettes, deterministic, same footprints, storeys that read as storeys, openings for the night lights. */

const mud = (x: number, y: number, look?: Structure['look']): Structure => ({ kind: StructureKind.MudHouse, x, y, w: 2, h: 2, rot: 0, look });
const court = (x: number, y: number, look?: Structure['look']): Structure => ({ kind: StructureKind.Courtyard, x, y, w: 3, h: 2, rot: 0, look });

function grid(f: (x: number, y: number) => Structure): Structure[] {
  const out: Structure[] = [];
  for (let y = 0; y < 150; y += 3) for (let x = 0; x < 150; x += 3) out.push(f(x, y));
  return out;
}

/** The horizontal extent of an op (local tiles). */
function extent(o: Op): [number, number, number, number] | null {
  switch (o.t) {
    case 'box':
    case 'sw':
    case 'geo': {
      // (the box turned by ry: its axis-aligned extent)
      const c = Math.abs(Math.cos(o.ry ?? 0));
      const sn = Math.abs(Math.sin(o.ry ?? 0));
      const hx = (c * o.w + sn * o.d) / 2;
      const hz = (sn * o.w + c * o.d) / 2;
      return [o.x - hx, o.x + hx, o.z - hz, o.z + hz];
    }
    case 'piece':
      return [o.x - 0.1, o.x + 0.1, o.z - 0.1, o.z + 0.1];
    case 'card':
      return [o.x, o.x, o.z, o.z];
    default:
      return null;
  }
}

describe('building plans (BD1)', () => {
  it('has 16 house silhouettes + 3 courtyard layouts + the mosque, all drawn on a 2 x 2 / 3 x 2 footprint', () => {
    expect(VARIANTS.length).toBeGreaterThanOrEqual(12);
    const ids = new Set<string>();
    for (const st of grid((x, y) => mud(x, y))) ids.add(planBuilding(st, 2).variant);
    for (const st of grid((x, y) => mud(x, y, 'shop'))) ids.add(planBuilding(st, 1).variant);
    for (const st of grid((x, y) => court(x, y))) ids.add(planBuilding(st, 2).variant);
    ids.add(planBuilding(court(3, 3, 'mosque'), 2).variant);
    expect(ids.size).toBeGreaterThanOrEqual(20);
    for (const v of VARIANTS) expect(ids.has(v.id)).toBe(true);
  });

  it('keeps every variant inside its footprint (same w / h as before, nothing sticks into the next tile)', () => {
    const seen = new Set<string>();
    for (const st of [...grid((x, y) => mud(x, y)), ...grid((x, y) => mud(x, y, 'shop')), ...grid((x, y) => court(x, y)), court(3, 3, 'mosque')]) {
      const before = JSON.stringify(st);
      const pl = planBuilding(st, ((st.x + st.y) % 3) as 0 | 1 | 2);
      expect(JSON.stringify(st)).toBe(before);
      seen.add(pl.variant);
      const lx = st.w / 2 + 0.2;
      const lz = st.h / 2 + 0.2;
      for (const o of pl.ops) {
        const e = extent(o);
        if (!e) continue;
        // (the mosque's minaret and the villa's eaves / stairs may reach a little over the edge: 0.2)
        expect(e[0]).toBeGreaterThan(-lx);
        expect(e[1], `${pl.variant} ${JSON.stringify(o)}`).toBeLessThan(lx);
        expect(e[2]).toBeGreaterThan(-lz);
        expect(e[3]).toBeLessThan(lz);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });

  it('chooses variant, mirror, palette, wear and height from the seed (deterministic) and never from Math.random', () => {
    const real = Math.random;
    Math.random = () => {
      throw new Error('Math.random in a building plan');
    };
    try {
      for (const st of grid((x, y) => mud(x, y)).slice(0, 200)) {
        const a = planBuilding(st, 2);
        const b = planBuilding({ ...st }, 2);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    } finally {
      Math.random = real;
    }
    const pls = grid((x, y) => mud(x, y)).map((st) => planBuilding(st, 2));
    expect(new Set(pls.map((p) => p.mirror)).size).toBe(2);
    expect(new Set(pls.map((p) => p.palette)).size).toBeGreaterThanOrEqual(6);
    expect(Math.min(...pls.map((p) => p.wear))).toBeLessThan(0.3);
    expect(Math.max(...pls.map((p) => p.wear))).toBeGreaterThan(0.8);
    // different tile, different house
    expect(new Set(pls.map((p) => p.variant)).size).toBeGreaterThanOrEqual(14);
  });

  it('palettes: at least 6 distinct looks, per town style a different mix', () => {
    expect(PALETTES.length).toBeGreaterThanOrEqual(6);
    const count = (town: 0 | 1 | 2) => {
      const c = new Map<number, number>();
      for (const st of grid((x, y) => mud(x, y))) c.set(planBuilding(st, town).palette, (c.get(planBuilding(st, town).palette) ?? 0) + 1);
      return c;
    };
    const a = count(0);
    const b = count(1);
    expect(a.size).toBeGreaterThanOrEqual(5);
    expect(b.size).toBeGreaterThanOrEqual(5);
    // the Egyptian town has whitewash and no adobe, the Arabian one the other way round
    expect(a.get(0) ?? 0).toBeGreaterThan(b.get(0) ?? 0);
    expect(b.get(3) ?? 0).toBeGreaterThan(a.get(3) ?? 0);
  });

  it('a 1-, 2- and 3-storey house is strictly taller by storeys, about FLOOR (3 m) per floor', () => {
    const by = new Map<number, number[]>();
    for (const st of [...grid((x, y) => mud(x, y)), ...grid((x, y) => mud(x, y, 'shop'))]) {
      const p = planBuilding(st, 2);
      const l = by.get(p.storeys) ?? [];
      l.push(p.height);
      by.set(p.storeys, l);
    }
    expect([...by.keys()].sort()).toEqual([1, 2, 3]);
    const mn = (n: number) => Math.min(...by.get(n)!);
    const mx = (n: number) => Math.max(...by.get(n)!);
    expect(mx(1)).toBeLessThan(mn(2));
    expect(mx(2)).toBeLessThan(mn(3));
    // a storey is about 0.44 tile: 3 storeys at least 2.4x a one-storey house
    expect(mn(3)).toBeGreaterThan(mx(1) * 1.7);
    expect(mn(2)).toBeGreaterThan(FLOOR * 1.9);
    expect(mn(3)).toBeGreaterThan(FLOOR * 2.9);
    // the soldier is 0.34 tile: even the lowest house is clearly taller than him
    expect(Math.min(...by.get(1)!)).toBeGreaterThan(0.34);
  });

  it('every variant has openings for the night lights: windows, a door, valid sizes, inside the footprint', () => {
    const pls = new Map<string, BuildingPlan>();
    for (const st of [...grid((x, y) => mud(x, y)), ...grid((x, y) => mud(x, y, 'shop')), ...grid((x, y) => court(x, y)), court(3, 3, 'mosque')]) {
      const p = planBuilding(st, 2);
      if (!pls.has(p.variant)) pls.set(p.variant, p);
    }
    for (const [id, p] of pls) {
      const w = p.slots.filter((s) => s.kind === 'window' || s.kind === 'balcony' || s.kind === 'shop');
      const d = p.slots.filter((s) => s.kind === 'door' || s.kind === 'shop');
      expect(w.length, `${id}: windows`).toBeGreaterThanOrEqual(4);
      expect(d.length, `${id}: doors`).toBeGreaterThanOrEqual(1);
      for (const s of p.slots) {
        expect(s.w).toBeGreaterThan(0);
        expect(s.h).toBeGreaterThan(0);
        expect(Math.abs(s.x)).toBeLessThan(1.7);
        expect(Math.abs(s.z)).toBeLessThan(1.2);
        expect(s.y).toBeGreaterThan(0);
        expect(s.y).toBeLessThan(p.top + 0.2);
      }
    }
    expect(pls.size).toBeGreaterThanOrEqual(20);
  });

  it('about half of the houses are awake after dark, lit slots only on awake houses', () => {
    const pls = grid((x, y) => mud(x, y)).map((st) => planBuilding(st, 2));
    const awake = pls.filter((p) => p.awake).length / pls.length;
    expect(awake).toBeGreaterThan(0.4);
    expect(awake).toBeLessThan(0.7);
    for (const p of pls) if (!p.awake) expect(p.slots.filter((s) => s.kind !== 'lamp' && s.kind !== 'sign').every((s) => !s.lit)).toBe(true);
    // lit windows are a share of an awake house's windows
    const lit = pls.filter((p) => p.awake).flatMap((p) => p.slots.filter((s) => s.kind === 'window'));
    const share = lit.filter((s) => s.lit).length / lit.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.85);
  });

  it('slotWorld puts a slot where the mesh is: the same rotation as the building (quarter turns about the footprint centre)', () => {
    const st: Structure = { ...mud(31, 17), rot: 1 };
    const info = buildingInfo(createMap('desert', 1), st);
    expect(info.slots.length).toBeGreaterThan(5);
    const base = new THREE.Matrix4().compose(new THREE.Vector3(st.x + 1, 0, st.y + 1), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (st.rot * Math.PI) / 2), new THREE.Vector3(1, 1, 1));
    for (const s of info.slots) {
      const w = slotWorld(st, s);
      const v = new THREE.Vector3(s.x, s.y, s.z).applyMatrix4(base);
      expect(w.x).toBeCloseTo(v.x, 5);
      expect(w.z).toBeCloseTo(v.z, 5);
      const n = new THREE.Vector3(Math.sin(s.ry), 0, Math.cos(s.ry)).applyMatrix4(new THREE.Matrix4().extractRotation(base));
      expect(w.nx).toBeCloseTo(n.x, 5);
      expect(w.nz).toBeCloseTo(n.z, 5);
    }
  });

  it('the cards used by the plans exist in the card table (so the sizes are known)', () => {
    const used = new Set<string>();
    for (const st of [...grid((x, y) => mud(x, y)), ...grid((x, y) => court(x, y)), court(3, 3, 'mosque')]) for (const o of planBuilding(st, 2).ops) if (o.t === 'card') used.add(o.n);
    for (const n of used) expect(CARDS[n], n).toBeDefined();
    expect(used.size).toBeGreaterThanOrEqual(15);
  });

  it('a village of the desert map shows at least 8 different silhouettes (it was 6 on 18 houses)', () => {
    const m = createMap('desert', 1);
    const cl: number[][] = [];
    m.structures.forEach((s, i) => {
      const c = cl.find((c) => c.some((j) => Math.hypot(m.structures[j].x - s.x, m.structures[j].y - s.y) < 9));
      if (c) c.push(i);
      else cl.push([i]);
    });
    cl.sort((a, b) => b.length - a.length);
    const big = cl[0];
    expect(big.length).toBeGreaterThanOrEqual(12);
    const ids = new Set(big.map((i) => buildingInfo(m, m.structures[i]).variant));
    expect(ids.size).toBeGreaterThanOrEqual(8);
    // every structure of the map has a plan with the footprint's openings
    for (const st of m.structures) expect(buildingInfo(m, st).slots.length).toBeGreaterThan(3);
  });

  it('buildingSlots gives the night lights world windows, doors, porch lamps and the mosque lamps', () => {
    const st = mud(40, 60);
    const a = buildingSlots(st, 1.5)!;
    expect(a.windows.length).toBeGreaterThan(5);
    expect(a.doors.length).toBeGreaterThanOrEqual(1);
    for (const w of a.windows) {
      expect(w.y).toBeGreaterThan(1.5);
      expect(Math.hypot(w.nx, w.nz)).toBeCloseTo(1, 5);
      expect(Math.abs(w.x - 41)).toBeLessThan(1.5);
    }
    const mq = buildingSlots(court(10, 10, 'mosque'), 0)!;
    expect(mq.mosque.map((l) => l.kind).sort()).toEqual(['dome', 'gate', 'minaret', 'minaret']);
  });
});
