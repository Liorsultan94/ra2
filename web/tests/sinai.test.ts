import { describe, expect, it } from 'vitest';
import { buildingDef } from '../src/sim/defs';
import { Tile, groundHeight, isleAt, terrainBuildable } from '../src/sim/map';
import { createMap, sinaiPoint } from '../src/sim/maps';
import { SINAI_MASK, SINAI_MASK_H, SINAI_MASK_W } from '../src/sim/sinaimask';
import { Loco } from '../src/sim/slope';
import type { Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

// SN1: Wadi Al-Rimal is the Sinai Peninsula, its coasts traced from the owner's picture (sim/sinaimask.ts). The
// bases sit where the owner marked them, on the Egyptian (west) and Arabian (east) mainlands, the Sinai between them;
// ground forces go round the heads of the two gulfs over land (no bridges), aircraft fly over. The sides are not
// mirror images; what each holds is kept equal by hand (counted for the base nearer by road).

function world(seed = 1) {
  return new World({
    seed,
    map: 'desert',
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: true },
      { name: 'B', faction: 'russia', color: 0, isAI: true },
    ],
  });
}
const E = (x: number, y: number) => (x - y) / Math.SQRT2;
const S = (x: number, y: number) => (x + y) / Math.SQRT2;
/** Path length (tiles) of a path finder result from (sx, sy). */
function pathLen(w: World, sx: number, sy: number, p: number[]) {
  let L = 0;
  let x = sx;
  let y = sy;
  for (const t of p) {
    const tx = t % w.map.w;
    const ty = Math.floor(t / w.map.w);
    L += Math.hypot(tx - x, ty - y);
    x = tx;
    y = ty;
  }
  return L;
}
function route(w: World, sx: number, sy: number, gx: number, gy: number) {
  w.pfs[Loco.Vehicle].clearCache?.();
  const p = w.pfs[Loco.Vehicle].find(sx, sy, gx, gy, 400000);
  return { ok: p.length > 0 && p[p.length - 1] === gy * w.map.w + gx, len: pathLen(w, sx, sy, p) };
}
/** The picture's water mask (1 = water). */
function mask() {
  const m = new Uint8Array(SINAI_MASK_W * SINAI_MASK_H);
  SINAI_MASK.split(';').forEach((row, y) => {
    const n = row.split(',').map(Number);
    for (let k = 0; k + 1 < n.length; k += 2) m.fill(1, y * SINAI_MASK_W + n[k], y * SINAI_MASK_W + n[k] + n[k + 1]);
  });
  return m;
}

describe('Wadi Al-Rimal: the Sinai (SN1)', () => {
  it("is traced from the owner's picture: its seas and gulfs, the bases at the owner's marks, no bridges", () => {
    const m = createMap('desert', 1);
    const sea = m.deco!.sea!;
    expect(m.mirror).toBe('none');
    expect(sea.grid).toBeTruthy();
    const water = (u: number, v: number) => {
      const p = sinaiPoint(u, v);
      return m.tiles[Math.floor(p.y) * m.w + Math.floor(p.x)] === Tile.Water;
    };
    // the map's water where the picture's is, away from the coasts (the coast runs between the pixels)
    const pic = mask();
    const at = (u: number, v: number) => pic[Math.max(0, Math.min(SINAI_MASK_H - 1, v)) * SINAI_MASK_W + Math.max(0, Math.min(SINAI_MASK_W - 1, u))];
    let n = 0;
    let same = 0;
    for (let v = 3; v < SINAI_MASK_H - 3; v += 3)
      for (let u = 3; u < SINAI_MASK_W - 3; u += 3) {
        const wv = at(u, v);
        let edge = false;
        for (let dv = -3; dv <= 3 && !edge; dv++) for (let du = -3; du <= 3; du++) if (at(u + du, v + dv) !== wv) edge = true;
        if (edge) continue;
        n++;
        // (Tiran is land in the strait where the picture has sea)
        const p = sinaiPoint(u + 0.5, v + 0.5);
        if (sea.isle && isleAt(sea.isle, p.x, p.y) < 1.5) {
          same++;
          continue;
        }
        if (water(u + 0.5, v + 0.5) === !!wv) same++;
      }
    expect(same / n).toBeGreaterThan(0.99);
    // the Mediterranean on top, the Red Sea round the tip, the peninsula's middle land
    expect(water(125, 8)).toBe(true);
    expect(water(125, 255)).toBe(true);
    expect(water(125, 130)).toBe(false);
    // the Gulf of Suez long and wide down the west, the Gulf of Aqaba narrower down the east
    const run = (v: number, u0: number, u1: number) => {
      let best = 0;
      let cur = 0;
      for (let u = u0; u <= u1; u += 0.5) {
        cur = water(u, v) ? cur + 0.5 : 0;
        best = Math.max(best, cur);
      }
      return best;
    };
    for (const v of [100, 130, 160]) expect(run(v, 0, 60), `the Gulf of Suez at v ${v}`).toBeGreaterThan(14);
    for (const v of [110, 140]) {
      expect(run(v, 180, 245), `the Gulf of Aqaba at v ${v}`).toBeGreaterThan(8);
      expect(run(v, 180, 245)).toBeLessThan(run(v, 0, 60));
    }
    // blue on the Egyptian mainland west of the upper Gulf of Suez, red on the Arabian mainland east of the lower Gulf
    // of Aqaba, where the owner marked them
    const [s0, s1] = m.starts;
    const b = sinaiPoint(11, 67);
    const r = sinaiPoint(214, 183);
    expect(Math.hypot(s0.x + 0.5 - b.x, s0.y + 0.5 - b.y)).toBeLessThan(1);
    expect(Math.hypot(s1.x + 0.5 - r.x, s1.y + 0.5 - r.y)).toBeLessThan(1);
    expect(m.bridges).toEqual([]);
    // Tiran in the mouth of the Gulf of Aqaba, the Blue Hole off the Sinai's Aqaba coast
    const px = (x: number, y: number) => 125 + E(x, y) / 0.48;
    expect(px(sea.isle!.x, sea.isle!.y)).toBeGreaterThan(150);
    expect(px(sea.hole!.x, sea.hole!.y)).toBeGreaterThan(160);
  });

  it('is fair in what each side holds: ore, oil, build space, houses and tech sites equal; roads to them close', () => {
    const w = world(1);
    const m = w.map;
    const st = m.starts;
    const a = route(w, st[0].x, st[0].y, st[1].x, st[1].y);
    const b = route(w, st[1].x, st[1].y, st[0].x, st[0].y);
    expect(a.ok && b.ok).toBe(true);
    expect(Math.abs(a.len - b.len) / a.len).toBeLessThan(0.03);
    // everything neutral counts for the base nearer to it by road
    const near = (x: number, y: number) => st.map((s) => route(w, s.x, s.y, Math.floor(x), Math.floor(y)));
    const sideOf = (r: { len: number; ok: boolean }[]) => (r[0].len <= r[1].len ? 0 : 1);
    // ore: each field's value (the ore tiles nearest it) and the road to it
    const fields = m.oreMines.map((f) => ({ ...f, r: near(f.x, f.y), value: 0 }));
    for (let i = 0; i < m.w * m.h; i++) {
      if (!m.ore[i]) continue;
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      let best = fields[0];
      for (const f of fields) if (Math.hypot(f.x - x, f.y - y) < Math.hypot(best.x - x, best.y - y)) best = f;
      best.value += m.ore[i] * (m.oreKind[i] === 2 ? 2 : 1);
    }
    const value = [0, 0];
    const road = [0, 0];
    const count = [0, 0];
    for (const f of fields) {
      expect(f.r[0].ok && f.r[1].ok, `ore at ${f.x},${f.y}`).toBe(true);
      const s = sideOf(f.r);
      value[s] += f.value;
      road[s] += f.r[s].len;
      count[s]++;
    }
    expect(count[0]).toBe(count[1]);
    expect(value[0]).toBe(value[1]);
    // (the roads to each side's fields: within 5%)
    expect(Math.abs(road[0] - road[1]) / road[0]).toBeLessThan(0.05);
    const oil = [0, 0];
    for (const o of m.oils) oil[sideOf(near(o.x + 1, o.y + 1))]++;
    expect(oil[0]).toBe(oil[1]);
    // build space: open, gentle 2 x 2 spots within 20 tiles of each start (within 5%)
    const room = (s: { x: number; y: number }) => {
      let k = 0;
      for (let y = s.y - 20; y <= s.y + 20; y++)
        for (let x = s.x - 20; x <= s.x + 20; x++) if (Math.hypot(x - s.x, y - s.y) <= 20 && x >= 0 && y >= 0 && x < m.w - 1 && y < m.h - 1 && terrainBuildable(m, x, y, 2, 2)) k++;
      return k;
    };
    const r0 = room(st[0]);
    const r1 = room(st[1]);
    expect(r1).toBeGreaterThan(450);
    expect(Math.abs(r0 - r1) / r0).toBeLessThan(0.05);
    // garrisonable houses and tech sites: as many on each side
    for (const [name, pick, min] of [
      ['houses', (e: Entity) => !!buildingDef(e.def).garrison, 12],
      ['tech', (e: Entity) => !!buildingDef(e.def).techKind, 3],
    ] as [string, (e: Entity) => boolean, number][]) {
      const k = [0, 0];
      for (const e of w.list) if (e.owner < 0 && e.kind === 'building' && pick(e)) k[sideOf(near(e.x, e.y))]++;
      expect(k[0], name).toBe(k[1]);
      expect(k[0], name).toBeGreaterThan(min);
    }
    expect(w.list.some((e: Entity) => e.def === 'bridge' || e.def === 'bridgehut')).toBe(false);
  });

  it('the two crossings are the only ground links: land at the heads of the gulfs, each with its village', () => {
    const w = world(1);
    const m = w.map;
    const N = m.w;
    const [s0, s1] = m.starts;
    const cutAt = (cx: number, cy: number) => {
      const pass = w.pass.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < 12) pass[y * N + x] = 0;
      return pass;
    };
    const reach = (pass: Uint8Array) => {
      const seen = new Uint8Array(N * N);
      const q = [s0.y * N + s0.x];
      seen[q[0]] = 1;
      while (q.length) {
        const t = q.pop()!;
        const x = t % N;
        for (const u of [t - 1, t + 1, t - N, t + N]) {
          if (u < 0 || u >= N * N || seen[u] || !pass[u] || Math.abs((u % N) - x) > 1) continue;
          seen[u] = 1;
          q.push(u);
        }
      }
      return !!seen[s1.y * N + s1.x];
    };
    expect(reach(w.pass)).toBe(true);
    // (the AI's crossings, ai.ts: one at each gulf's head; cut either and the starts fall apart)
    const lanes = m.lanes!;
    expect(lanes.length).toBe(2);
    for (const l of lanes) expect(reach(cutAt(l.x + 0.5, l.y + 0.5))).toBe(false);
    // the crossings are open ground some ten tiles across
    for (const l of lanes) {
      let open = 0;
      for (let y = Math.floor(l.y) - 7; y <= l.y + 7; y++) for (let x = Math.floor(l.x) - 7; x <= l.x + 7; x++) if (Math.hypot(x - l.x, y - l.y) <= 7 && w.pass[y * N + x]) open++;
      expect(open, `crossing at ${l.x},${l.y}`).toBeGreaterThan(80);
    }
    // a village by each crossing, as many garrisonable houses in each
    const houses = (c: { x: number; y: number }) => w.list.filter((e: Entity) => e.owner < 0 && e.kind === 'building' && buildingDef(e.def).garrison && Math.hypot(e.x - c.x, e.y - c.y) < 22).length;
    expect(houses(lanes[0])).toBeGreaterThanOrEqual(6);
    expect(houses(lanes[1])).toBe(houses(lanes[0]));
  });

  it('keeps the Sinai places: Sharm on the tip, resorts on both gulf coasts, the Blue Hole by Dahab, Tiran offshore, the canyon by Nuweiba and the massif', () => {
    const w = world(3);
    const m = w.map;
    const sea = m.deco!.sea!;
    const px = (x: number, y: number) => ({ u: 125 + E(x, y) / 0.48, v: 135 + (S(x, y) - (m.w / 2) * Math.SQRT2) / 0.48 });
    // three resorts: Sharm (look 0) on the tip, one on each gulf's Sinai coast
    expect(sea.sites.length).toBe(3);
    const site = (look: number) => sea.sites.find((s) => s.look === look)!;
    expect(px(site(0).x, site(0).y).v).toBeGreaterThan(200);
    expect(px(site(1).x, site(1).y).u).toBeLessThan(70);
    expect(px(site(2).x, site(2).y).u).toBeGreaterThan(150);
    const hole = px(sea.hole!.x, sea.hole!.y);
    expect(hole.u).toBeGreaterThan(170);
    expect(hole.v).toBeGreaterThan(130);
    // Tiran: open ground on it, all of it cut off from the mainland
    let open = 0;
    for (let i = 0; i < m.w * m.h; i++) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      if (isleAt(sea.isle!, x + 0.5, y + 0.5) >= 0) continue;
      expect(m.offshore![i]).toBe(1);
      if (w.pass[i]) {
        open++;
        expect(w.region[i]).not.toBe(w.mainland);
      }
    }
    expect(open).toBeGreaterThan(6);
    // the coloured canyon inland of the Aqaba coast; the massif high in the south of the peninsula
    const cs = m.deco!.canyons!;
    expect(cs.length).toBe(1);
    expect(px(cs[0].pts[0].x + 0.5, cs[0].pts[0].y + 0.5).u).toBeGreaterThan(140);
    let peak = 0;
    for (let v = 140; v < 190; v += 1)
      for (let u = 90; u <= 160; u += 1) {
        const p = sinaiPoint(u, v);
        peak = Math.max(peak, groundHeight(m, p.x, p.y));
      }
    expect(peak).toBeGreaterThan(4.5);
  });
});
