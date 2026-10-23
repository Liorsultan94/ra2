import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { Tile, frameUV } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
import { Driver, newDriveCar } from '../src/render/ambient/driver';
import { CAR_SCALE } from '../src/render/ambient/models';
import { onSurface, pointAt, type RoadNet } from '../src/render/ambient/roadnet';
import { SIGN_SIZE, SignKind, isAd, styleOf, type Sign } from '../src/render/ambient/signplan';

/*
 * RD1: the Sinai's roads, roundabouts and signs. The roads and signs are decoration plus traffic: the sim's map
 * (ground, ore, oil, starts, houses) must stay exactly what it was.
 */

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}

const mapOf = () => createMap('desert', 1);
const netOf = (m = mapOf()) => roadNetFor(m, buildLayout(m));

describe('the Sinai map (sim) is untouched by the roads', () => {
  it('ground, ore, oil, starts, houses and the sim roads hash as before', () => {
    const m = mapOf();
    const sig = {
      w: m.w,
      tiles: hash(Array.from(m.tiles).join('')),
      blocked: hash(Array.from(m.blocked).join('')),
      ore: hash(Array.from(m.ore).join('') + Array.from(m.oreKind).join('')),
      trees: hash(Array.from(m.trees).join('')),
      heights: hash(Array.from(m.heights, (h) => h.toFixed(3)).join(',')),
      oils: hash(JSON.stringify(m.oils)),
      starts: hash(JSON.stringify(m.starts)),
      mines: hash(JSON.stringify(m.oreMines)),
      structures: hash(JSON.stringify(m.structures.map((s) => [s.x, s.y, s.w, s.h, s.kind]))),
      roads: hash(JSON.stringify(m.roads)),
      lanes: hash(JSON.stringify(m.lanes)),
    };
    // (recorded on master before RD1)
    expect(sig).toEqual(BASELINE);
  });
});

describe('roads, roundabouts and signs of the Sinai', () => {
  const m = mapOf();
  const L = buildLayout(m);
  const n = netOf(m);

  it('a modest network: a few more paved links and 4 town roundabouts with a centrepiece each', () => {
    // (the sim's three roads, cut at the bases and the villages: 5 pieces before; plus the links)
    const paved = L.roads.filter((r) => !r.ring && r.lot === undefined);
    expect(paved.length).toBeGreaterThanOrEqual(8);
    expect(paved.length).toBeLessThanOrEqual(14);
    const rounds = n.loops.filter((lp) => !lp.dead);
    expect(rounds.length).toBeGreaterThanOrEqual(4);
    expect(rounds.length).toBeLessThanOrEqual(5);
    for (const lp of rounds) {
      expect(lp.town).toBe(true);
      expect(lp.paved).toBe(true);
      expect(lp.ri).toBeGreaterThan(0.4);
      // three or more paved roads meet there
      expect(n.nodes[lp.node].arms.length).toBeGreaterThanOrEqual(3);
      expect(n.nodes[lp.node].arms.every((a) => n.lines[a.line].paved)).toBe(true);
    }
    // no traffic lights in the desert
    expect(n.signals.length).toBe(0);
  });

  it('the roads and roundabouts keep off water, rock, houses, ore, oil and the bases', () => {
    const bad = (x: number, y: number) => {
      const i = Math.floor(y) * m.w + Math.floor(x);
      return m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Rock || m.blocked[i] || m.ore[i];
    };
    for (const lp of n.loops)
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        expect(bad(lp.x + Math.cos(a) * lp.R, lp.y + Math.sin(a) * lp.R), `loop ${lp.x.toFixed(1)},${lp.y.toFixed(1)}`).toBeFalsy();
      }
    for (const r of L.roads)
      for (const p of r.pts) {
        expect(bad(p.x, p.y), `road at ${p.x.toFixed(1)},${p.y.toFixed(1)}`).toBeFalsy();
        for (const s of m.starts) expect(Math.hypot(p.x - s.x - 0.5, p.y - s.y - 0.5)).toBeGreaterThan(8);
      }
    for (const o of m.oils) for (const r of L.roads) for (const p of r.pts) expect(Math.hypot(p.x - o.x - 1, p.y - o.y - 1)).toBeGreaterThan(1.5);
  });

  it('signs: at least 12 billboards, road signs too, nothing on the sea, the roads or in the bases', () => {
    const ads = n.signs.filter((s) => isAd(s.kind));
    expect(ads.length).toBeGreaterThanOrEqual(12);
    expect(n.signs.filter((s) => s.kind === SignKind.Round).length).toBeGreaterThanOrEqual(3);
    expect(n.signs.filter((s) => s.kind === SignKind.Tri).length).toBeGreaterThanOrEqual(3);
    expect(n.signs.filter((s) => s.kind === SignKind.Arrow).length).toBeGreaterThanOrEqual(1);
    for (const s of n.signs) {
      const i = Math.floor(s.y) * m.w + Math.floor(s.x);
      expect(m.tiles[i], `sign ${s.x},${s.y}`).not.toBe(Tile.Water);
      expect(m.tiles[i]).not.toBe(Tile.Rock);
      expect(m.blocked[i] + m.ore[i] + m.trees[i]).toBe(0);
      expect(onSurface(n, s.x, s.y)).toBe(false);
      for (const st of m.starts) expect(Math.hypot(s.x - st.x - 0.5, s.y - st.y - 0.5)).toBeGreaterThan(13);
      for (const lp of n.loops) expect(Math.hypot(s.x - lp.x, s.y - lp.y)).toBeGreaterThan(lp.R + 0.5);
      for (const o of m.oils) expect(Math.hypot(s.x - o.x - 1, s.y - o.y - 1)).toBeGreaterThan(2);
      // not in a resort or on its beach front, nor on the sea's busy strip
      for (const st of m.deco!.sea!.sites) {
        const f = frameUV(st, s.x, s.y);
        expect(f.u > st.resort.u0 - 1 && f.u < st.resort.u1 + 1 && f.v > st.resort.v0 - 1 && f.v < 1, `sign ${s.x.toFixed(1)},${s.y.toFixed(1)} in a resort`).toBe(false);
      }
      // not on a house
      for (const h of m.structures) expect(s.x > h.x - 0.1 && s.x < h.x + h.w + 0.1 && s.y > h.y - 0.1 && s.y < h.y + h.h + 0.1).toBe(false);
    }
  });

  it('signs differ in size, shape, palette, wear, lean and height', () => {
    const kinds = new Set(n.signs.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(8);
    const sizes = new Set(n.signs.map((s) => SIGN_SIZE[s.kind]));
    expect(sizes.size).toBe(4);
    expect(new Set(n.signs.map((s) => s.pal)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(n.signs.map((s) => s.front)).size).toBeGreaterThanOrEqual(12);
    expect(n.signs.some((s) => s.wear > 0.7)).toBe(true);
    expect(n.signs.some((s) => s.wear < 0.15)).toBe(true);
    expect(n.signs.some((s) => Math.abs(s.roll) > 0.12)).toBe(true);
    expect(n.signs.some((s) => s.lift > 0.1)).toBe(true);
    expect(n.signs.some((s) => s.kind === SignKind.Wall)).toBe(true);
    expect(n.signs.some((s) => s.kind === SignKind.Shop)).toBe(true);
  });

  it('never the same board twice in a row on one road (shape or size or design differs)', () => {
    const byLine = new Map<number, Sign[]>();
    for (const s of n.signs) if (isAd(s.kind)) byLine.set(s.line, [...(byLine.get(s.line) ?? []), s]);
    let pairs = 0;
    for (const list of byLine.values()) {
      list.sort((a, b) => a.arc - b.arc);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1];
        const b = list[i];
        pairs++;
        expect(a.kind !== b.kind || SIGN_SIZE[a.kind] !== SIGN_SIZE[b.kind] || styleOf(a) !== styleOf(b), `signs at arc ${a.arc.toFixed(0)} and ${b.arc.toFixed(0)}`).toBe(true);
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic: the roads, roundabouts, lots and signs are the same on a rebuild', () => {
    const sig = (net: RoadNet) =>
      hash(JSON.stringify({ loops: net.loops.map((l) => [l.x, l.y, l.R]), lots: net.lots.map((l) => [l.x, l.y]), signs: net.signs, props: net.props.map((p) => [p.kind, p.x, p.y]) }));
    expect(sig(netOf())).toBe(sig(n));
  });

  it('lots by the towns and the resort: cars park there', () => {
    expect(n.lots.length).toBeGreaterThanOrEqual(4);
  });
});

// ------------------------------------------------------------------ traffic on the new roads

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('traffic on the new roads', () => {
  it('cars drive the links and circle every town roundabout, never leaving the road', () => {
    const n = netOf();
    const rand = rng(7);
    const drv = new Driver(n, () => true, rand);
    type C = ReturnType<typeof newDriveCar> & { driving: boolean };
    const cars: C[] = [];
    const lines = n.lines.map((_, i) => i).filter((i) => n.lines[i].paved && n.lines[i].lot < 0 && n.lines[i].a1 - n.lines[i].a0 > 3);
    // cars start near each roundabout, on each road leading to it
    for (const lp of n.loops.filter((l) => !l.dead)) {
      for (const a of n.nodes[lp.node].arms) {
        const L = n.lines[a.line];
        for (const back of [5, 9]) {
          const arc = a.edge + a.dir * back;
          if (arc < L.a0 + 0.5 || arc > L.a1 - 0.5) continue;
          const p = pointAt(L, arc);
          const dir = -a.dir;
          const x = p.x - p.ty * dir * L.lane;
          const y = p.y + p.tx * dir * L.lane;
          if (!onSurface(n, x, y) || cars.some((o) => Math.hypot(o.x - x, o.y - y) < 1.4)) continue;
          const c = newDriveCar(0, 0.5 * CAR_SCALE, a.line, arc, dir, x, y, Math.atan2(p.ty * dir, p.tx * dir), 1.2) as C;
          c.driving = true;
          cars.push(c);
        }
      }
    }
    expect(cars.length).toBeGreaterThan(10);
    expect(lines.length).toBeGreaterThan(5);
    const circled = new Set<number>();
    const used = new Set<number>();
    let off = 0;
    const dt = 0.05;
    for (let t = 0; t < 200; t += dt) {
      for (const c of cars) {
        drv.step(c, cars, t, dt);
        if (c.loop >= 0) circled.add(c.loop);
        used.add(c.line);
        if (c.loop < 0 && !c.kt && c.pk === 0) {
          let ok = onSurface(n, c.x, c.y);
          for (let k = 0; k < 8 && !ok; k++) ok = onSurface(n, c.x + Math.cos(k * 0.785) * 0.12, c.y + Math.sin(k * 0.785) * 0.12);
          if (!ok) off++;
        }
      }
    }
    for (const [i, lp] of n.loops.entries()) if (!lp.dead) expect(circled.has(i), `roundabout ${i} at ${lp.x.toFixed(1)},${lp.y.toFixed(1)}`).toBe(true);
    expect(off).toBe(0);
    expect(used.size).toBeGreaterThanOrEqual(5);
  });
});

const BASELINE = {
  w: 208,
  tiles: 'c7b45e97',
  blocked: '7070b12d',
  ore: '183c74e3',
  trees: '97cc29a7',
  heights: '77912d0e',
  oils: 'f581f679',
  starts: '8467f377',
  mines: '8036ce75',
  structures: '55b00e80',
  roads: '6dac8fc0',
  lanes: 'ed9b37b9',
};
