import { describe, expect, it } from 'vitest';
import { buildingDef } from '../src/sim/defs';
import { Tile, groundHeight, isleAt, seaDist, terrainBuildable, type GameMap } from '../src/sim/map';
import { createMap } from '../src/sim/maps';
import { Loco } from '../src/sim/slope';
import type { Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

// SN1: Wadi Al-Rimal is the Sinai Peninsula. The bases sit on the Egyptian (west) and Arabian (east) mainlands,
// the Sinai between them; ground forces go round the heads of the two gulfs over land (no bridges), aircraft
// fly over. The halves mirror across the x == y diagonal (the screen's left-right mirror) for everything that
// affects play; the canal (west) and the granite ridge (east) north of the corridors differ only in look.

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
/** The canal's and the ridge's tiles: impassable on both halves, water on one, rock on the other. */
function barrier(m: GameMap, i: number) {
  const x = i % m.w;
  const y = Math.floor(i / m.w);
  const j = x * m.w + y;
  return (m.tiles[i] === Tile.Water && m.tiles[j] === Tile.Rock) || (m.tiles[i] === Tile.Rock && m.tiles[j] === Tile.Water);
}

describe('Wadi Al-Rimal: the Sinai (SN1)', () => {
  it('reads as the Sinai: the Mediterranean on top, the gulfs down both sides meeting the Red Sea at the tip, the bases on the two mainlands', () => {
    const m = createMap('desert', 1);
    const sea = m.deco!.sea!;
    const c = m.w / 2;
    const at = (e: number, s: number) => ({ x: (s + e) / Math.SQRT2, y: (s - e) / Math.SQRT2 });
    const water = (e: number, s: number) => {
      const p = at(e, s);
      return m.tiles[Math.floor(p.y) * m.w + Math.floor(p.x)] === Tile.Water;
    };
    const top = c * Math.SQRT2;
    // the Mediterranean across the top corner, the Red Sea across the bottom one
    expect(water(0, 20)).toBe(true);
    expect(water(0, 2 * top - 12)).toBe(true);
    // north Sinai is land between them; the gulfs are water down both sides of the peninsula, land beyond them
    expect(water(0, top - 30)).toBe(false);
    expect(water(0, top + 40)).toBe(false);
    for (const s of [top - 5, top + 20, top + 50]) {
      // the widest run of water west of the axis (an oasis is no gulf)
      let lo = 1;
      let hi = 1;
      let run = -1;
      for (let e = 0; e > -top; e -= 0.5) {
        if (water(e, s)) {
          if (run > 0) run = e;
          if (run - e > hi - lo || hi > 0) {
            hi = run;
            lo = e;
          }
        } else run = 1;
      }
      expect(hi, `the Gulf of Suez at S ${s}`).toBeLessThan(0);
      expect(hi - lo, `the Gulf of Suez's width at S ${s}`).toBeGreaterThan(5);
      // the Gulf of Aqaba is its mirror
      expect(water(-hi + 0.6, s)).toBe(true);
    }
    expect(sea.gulfs.length).toBe(2);
    // blue (player 0) on the Egyptian mainland west of the upper Gulf of Suez, red on the Arabian mainland east of
    // the Gulf of Aqaba (its mirror)
    const [s0, s1] = m.starts;
    const head = sea.gulfs[0][0];
    expect(E(s0.x + 0.5, s0.y + 0.5)).toBeLessThan(E(head.x, head.y) - 20);
    expect(Math.abs(S(s0.x + 0.5, s0.y + 0.5) - S(head.x, head.y))).toBeLessThan(15);
    expect([s1.x, s1.y]).toEqual([s0.y, s0.x]);
    // no bridges anywhere
    expect(m.bridges).toEqual([]);
    // Tiran: real land in the mouth of the Gulf of Aqaba that no ground unit reaches; the Blue Hole off the Aqaba shore
    expect(sea.isle).toBeTruthy();
    expect(E(sea.isle!.x, sea.isle!.y)).toBeGreaterThan(5);
    expect(S(sea.isle!.x, sea.isle!.y)).toBeGreaterThan(top + 50);
    expect(E(sea.hole!.x, sea.hole!.y)).toBeGreaterThan(5);
  });

  it('is fair: everything that affects play mirrors across the diagonal (seeds 1, 2, 7)', () => {
    for (const seed of [1, 2, 7]) {
      const w = world(seed);
      const m = w.map;
      const N = m.w;
      expect(m.mirror).toBe('transpose');
      let diff = 0;
      let hd = 0;
      let bar = 0;
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          const j = x * N + y;
          if (m.offshore?.[i] || m.offshore?.[j]) continue;
          if (barrier(m, i)) {
            bar++;
            expect(w.pass[i] + w.pass[j]).toBe(0);
            continue;
          }
          if (m.tiles[i] !== m.tiles[j] || m.ore[i] !== m.ore[j] || m.oreKind[i] !== m.oreKind[j] || !!m.trees[i] !== !!m.trees[j] || m.blocked[i] !== m.blocked[j] || w.pass[i] !== w.pass[j]) diff++;
          for (let c = 0; c < 2; c++) if (w.regions[c][i] === w.mainlands[c] && !(w.regions[c][j] === w.mainlands[c])) diff++;
          // the slope rules: the same steps blocked for vehicles and soldiers
          if (w.pass[i]) {
            for (let k = 0; k < 4; k++) {
              const km = [2, 3, 0, 1][k];
              // (steps onto ground nobody stands on do not count)
              const nx = x + [1, -1, 0, 0][k];
              const ny = y + [0, 0, 1, -1][k];
              if (nx < 0 || ny < 0 || nx >= N || ny >= N || !w.pass[ny * N + nx]) continue;
              for (let c = 0; c < 2; c++) if (((w.slope.block[c][i] >> k) & 1) !== ((w.slope.block[c][j] >> km) & 1)) diff++;
            }
            for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) hd = Math.max(hd, Math.abs(m.heights[vy * (N + 1) + vx] - m.heights[vx * (N + 1) + vy]));
          }
        }
      expect(diff, `seed ${seed}: tiles / ore / trees / passability / regions / slopes`).toBe(0);
      expect(hd, `seed ${seed}: heights of the ground units stand on`).toBeLessThan(1e-4);
      expect(bar, `seed ${seed}: the canal and the ridge`).toBeGreaterThan(100);
      // ore mines, oil, structures and neutral buildings: each has its mirror twin
      const key = (a: { x: number; y: number }[]) => new Set(a.map((p) => `${p.x},${p.y}`));
      const mines = key(m.oreMines);
      for (const p of m.oreMines) expect(mines.has(`${p.y},${p.x}`)).toBe(true);
      const oils = key(m.oils);
      for (const p of m.oils) expect(oils.has(`${p.y},${p.x}`)).toBe(true);
      const sk = new Set(m.structures.map((s) => `${s.kind}:${s.x},${s.y},${s.w},${s.h}`));
      for (const s of m.structures) expect(sk.has(`${s.kind}:${s.y},${s.x},${s.h},${s.w}`), `structure ${s.x},${s.y}`).toBe(true);
      const ents = w.list.filter((e: Entity) => e.owner < 0 && e.kind === 'building');
      const ek = new Set(ents.map((e) => `${e.def}@${e.tx},${e.ty}`));
      for (const e of ents) {
        const d = buildingDef(e.def);
        expect(ek.has(`${e.def}@${e.ty},${e.tx}`) || d.w !== d.h, `${e.def}@${e.tx},${e.ty}`).toBe(true);
      }
      expect(ents.some((e) => e.def === 'bridge' || e.def === 'bridgehut')).toBe(false);
    }
  });

  it('is fair in numbers: paths to the enemy and to the ore within 3%, build space within 5%, the same houses and tech sites', () => {
    const w = world(1);
    const m = w.map;
    const [s0, s1] = m.starts;
    const a = route(w, s0.x, s0.y, s1.x, s1.y);
    const b = route(w, s1.x, s1.y, s0.x, s0.y);
    expect(a.ok && b.ok).toBe(true);
    expect(Math.abs(a.len - b.len) / a.len).toBeLessThan(0.03);
    // each start to every ore field (its own and the far ones): the same as the mirrored route
    let own0 = 0;
    let own1 = 0;
    for (const p of m.oreMines) {
      const r0 = route(w, s0.x, s0.y, p.x, p.y);
      const r1 = route(w, s1.x, s1.y, p.y, p.x);
      expect(r0.ok && r1.ok, `ore at ${p.x},${p.y}`).toBe(true);
      expect(Math.abs(r0.len - r1.len) / Math.max(10, r0.len), `ore at ${p.x},${p.y}: ${r0.len.toFixed(1)} / ${r1.len.toFixed(1)}`).toBeLessThan(0.03);
      if (Math.hypot(p.x - s0.x, p.y - s0.y) < Math.hypot(p.x - s1.x, p.y - s1.y)) own0 += r0.len;
      else own1 += route(w, s1.x, s1.y, p.x, p.y).len;
    }
    expect(Math.abs(own0 - own1) / own0).toBeLessThan(0.03);
    // ore and oil amounts
    let ore0 = 0;
    let ore1 = 0;
    for (let i = 0; i < m.w * m.h; i++) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      const v = m.ore[i] * (m.oreKind[i] === 2 ? 2 : 1);
      if (x < y) ore0 += v;
      else if (x > y) ore1 += v;
    }
    expect(ore0).toBe(ore1);
    expect(m.oils.filter((o) => o.x < o.y).length).toBe(m.oils.filter((o) => o.x > o.y).length);
    // build space: open, gentle 2 x 2 spots within 20 tiles of each start
    const room = (s: { x: number; y: number }) => {
      let n = 0;
      for (let y = s.y - 20; y <= s.y + 20; y++)
        for (let x = s.x - 20; x <= s.x + 20; x++) if (Math.hypot(x - s.x, y - s.y) <= 20 && x >= 0 && y >= 0 && x < m.w - 1 && y < m.h - 1 && terrainBuildable(m, x, y, 2, 2)) n++;
      return n;
    };
    const r0 = room(s0);
    const r1 = room(s1);
    expect(r0).toBeGreaterThan(600);
    expect(Math.abs(r0 - r1) / r0).toBeLessThan(0.05);
    // garrisonable houses and tech sites: as many on each side, at the same distances
    const side = (pick: (e: Entity) => boolean) => {
      const d0: number[] = [];
      const d1: number[] = [];
      for (const e of w.list.filter((e: Entity) => e.owner < 0 && e.kind === 'building' && pick(e))) {
        const da = Math.hypot(e.x - s0.x - 0.5, e.y - s0.y - 0.5);
        const db = Math.hypot(e.x - s1.x - 0.5, e.y - s1.y - 0.5);
        if (da < db) d0.push(da);
        else if (db < da) d1.push(db);
      }
      d0.sort((p, q) => p - q);
      d1.sort((p, q) => p - q);
      return [d0, d1];
    };
    for (const [name, pick] of [
      ['houses', (e: Entity) => !!buildingDef(e.def).garrison],
      ['tech', (e: Entity) => !!buildingDef(e.def).techKind],
    ] as [string, (e: Entity) => boolean][]) {
      const [d0, d1] = side(pick);
      expect(d0.length, name).toBe(d1.length);
      expect(d0.length, name).toBeGreaterThan(name === 'houses' ? 12 : 3);
      d0.forEach((d, k) => expect(Math.abs(d - d1[k]), `${name} ${k}`).toBeLessThan(0.75));
    }
  });

  it('the two crossings are the only ground links: land corridors of the same width at the heads of the gulfs, each with its village', () => {
    const w = world(1);
    const m = w.map;
    const N = m.w;
    const sea = m.deco!.sea!;
    const head = sea.gulfs[0][0];
    // the corridor: open ground between the gulf's head and the canal (west) / the ridge (east), measured across
    const across = (gx: number, gy: number) => {
      // walk north (screen up: -x, -y) from the gulf's head until the barrier
      let open = 0;
      for (let t = 0; t < 30; t += 0.5) {
        const x = gx - t / Math.SQRT2;
        const y = gy - t / Math.SQRT2;
        const i = Math.floor(y) * N + Math.floor(x);
        if (seaDist(sea, x, y) > 0) continue;
        if (m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Rock) {
          if (open > 0) break;
          continue;
        }
        open += 0.5;
      }
      return open;
    };
    const wW = across(head.x, head.y);
    const wE = across(head.y, head.x);
    expect(wW).toBeGreaterThan(9);
    expect(wW).toBeLessThan(20);
    expect(wE).toBe(wW);
    // cut both corridors: the starts fall apart; cut one: still apart (every route takes both)
    const [s0, s1] = m.starts;
    const cutAt = (cx: number, cy: number) => {
      const pass = w.pass.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < 11) pass[y * N + x] = 0;
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
    // (the corridor's middle: between the gulf's head and the lake's south shore)
    const cw = { x: head.x - 4.5 / Math.SQRT2 * 1.4, y: head.y - 4.5 / Math.SQRT2 * 1.4 };
    expect(reach(cutAt(cw.x, cw.y))).toBe(false);
    expect(reach(cutAt(cw.y, cw.x))).toBe(false);
    // a village at each crossing: the same number of garrisonable houses within 16 tiles of each corridor
    const houses = (cx: number, cy: number) => w.list.filter((e: Entity) => e.owner < 0 && e.kind === 'building' && buildingDef(e.def).garrison && Math.hypot(e.x - cx, e.y - cy) < 16).length;
    expect(houses(cw.x, cw.y)).toBeGreaterThanOrEqual(8);
    expect(houses(cw.y, cw.x)).toBe(houses(cw.x, cw.y));
  });

  it('keeps the Sinai places: Sharm with its resort and town on the tip, resorts on both gulf shores, Tiran offshore, the canyons and the massif', () => {
    const w = world(3);
    const m = w.map;
    const sea = m.deco!.sea!;
    const top = (m.w / 2) * Math.SQRT2;
    // three resorts: Sharm (look 0) on the tip, one on each gulf's Sinai shore, mirrored compounds
    expect(sea.sites.length).toBe(3);
    const sharm = sea.sites.find((s) => s.look === 0)!;
    expect(Math.abs(E(sharm.x, sharm.y))).toBeLessThan(0.01);
    expect(S(sharm.x, sharm.y)).toBeGreaterThan(top + 70);
    const gulf = sea.sites.filter((s) => s.look !== 0);
    expect(Math.sign(E(gulf[0].x, gulf[0].y))).toBe(-Math.sign(E(gulf[1].x, gulf[1].y)));
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
    // the coloured canyons: two, mirrored, on each player's own half; the massif high in the south between them
    const cs = m.deco!.canyons!;
    expect(cs.length).toBe(2);
    expect(E(cs[0].pts[0].x, cs[0].pts[0].y)).toBeLessThan(0);
    expect(E(cs[1].pts[0].x, cs[1].pts[0].y)).toBeGreaterThan(0);
    let peak = 0;
    for (let s = top + 20; s < top + 50; s += 1) for (let e = -20; e <= 20; e += 1) peak = Math.max(peak, groundHeight(m, (s + e) / Math.SQRT2, (s - e) / Math.SQRT2));
    expect(peak).toBeGreaterThan(4.5);
  });
});
