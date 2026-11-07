import { describe, expect, it } from 'vitest';
import { Tile, terrainBuildable, unitPassable, type GameMap } from '../src/sim/map';
import { createMap, litaniRiver, litaniSea, mapInfo } from '../src/sim/maps';
import { LITANI_N, LITANI_WINDOW } from '../src/sim/litanidata';
import { SEA_MIN, SHIP_YARD_REACH, navalTerrain, shipSite } from '../src/sim/naval';
import { Loco } from '../src/sim/slope';
import { World } from '../src/sim/world';

/*
 * The Litani river mouth (map id 'frontline'): real terrain baked by tools/litani-terrain.mjs. The map must come out
 * the same everywhere, the Litani must run unbroken from the map's east edge into the sea, the banks may only be
 * crossed by land over the bridges, and both bases need room to build.
 */

/** FNV-1a over the bytes of a typed array. */
function fnv(a: ArrayBufferView) {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return h;
}

/** 4-connected flood over tiles where `ok` holds, from tile `from`. */
function flood(m: GameMap, from: number, ok: (i: number) => boolean) {
  const seen = new Uint8Array(m.w * m.h);
  const q = [from];
  seen[from] = 1;
  while (q.length) {
    const t = q.pop()!;
    const x = t % m.w;
    const y = (t / m.w) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
      const u = ny * m.w + nx;
      if (seen[u] || !ok(u)) continue;
      seen[u] = 1;
      q.push(u);
    }
  }
  return seen;
}

describe('Litani mouth (map frontline)', () => {
  const m = createMap('frontline', 1);
  const at = (p: { x: number; y: number }) => p.y * m.w + p.x;

  it('is the real place, real size, under its real names', () => {
    expect(m.name).toBe('Litani Mouth');
    expect(mapInfo('frontline').region).toMatch(/Litani/);
    expect(m.w).toBe(LITANI_N);
    expect(m.h).toBe(LITANI_N);
    // 35 m a tile: about 5.3 km a side (the window grown from 104 to 152 tiles, east into the hills and the gorge)
    expect(m.w * LITANI_WINDOW.m).toBeGreaterThan(5100);
    expect(m.w * LITANI_WINDOW.m).toBeLessThan(5500);
    expect(m.mirror).toBe('none');
  });

  it('builds the same map every time, whatever the seed', () => {
    const a = createMap('frontline', 1);
    const b = createMap('frontline', 987654);
    expect(fnv(a.heights)).toBe(fnv(b.heights));
    expect(fnv(a.tiles)).toBe(fnv(b.tiles));
    expect(fnv(a.trees)).toBe(fnv(b.trees));
    expect(fnv(a.ore)).toBe(fnv(b.ore));
    expect(JSON.stringify(a.structures)).toBe(JSON.stringify(b.structures));
    expect(JSON.stringify(a.bridges)).toBe(JSON.stringify(b.bridges));
    // the real ground: the coastal plain a few metres up, the hills east of the motorway over 100 m
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of a.heights) (lo = Math.min(lo, h)), (hi = Math.max(hi, h));
    expect(hi).toBeGreaterThan(100 / 35 - 0.25);
    expect(lo).toBeLessThan(-1);
  });

  it('has the sea in the west (the left corner, real north up), big enough for a navy', () => {
    expect(litaniSea(2, m.h - 2)).toBeGreaterThan(5);
    expect(litaniSea(m.w - 2, 2)).toBeLessThan(-20);
    expect(litaniSea(2, 2)).toBeLessThan(-5);
    const nav = navalTerrain(m);
    expect(nav.seaTiles).toBeGreaterThanOrEqual(SEA_MIN);
  });

  it('runs the Litani unbroken from the east edge to the sea', () => {
    // the river leaves the map on its east edge (x = w - 1)
    const edge: number[] = [];
    for (let y = 0; y < m.h; y++) if (m.tiles[y * m.w + m.w - 1] === Tile.Water && litaniRiver(m.w - 0.5, y + 0.5) > 0) edge.push(y * m.w + m.w - 1);
    expect(edge.length).toBeGreaterThan(0);
    // its water (bridge decks span it) reaches the open sea
    const wet = flood(m, edge[0], (i) => m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Bridge);
    let sea = 0;
    for (let i = 0; i < m.w * m.h; i++) if (wet[i] && litaniSea((i % m.w) + 0.5, ((i / m.w) | 0) + 0.5) > 3) sea++;
    expect(sea).toBeGreaterThan(500);
    // every river tile is one stream
    for (let i = 0; i < m.w * m.h; i++) if (m.tiles[i] === Tile.Water && litaniRiver((i % m.w) + 0.5, ((i / m.w) | 0) + 0.5) > 0.3) expect(wet[i]).toBe(1);
  });

  it('crosses the river by land only over its three bridges, at the real crossings', () => {
    expect(m.bridges.length).toBe(3);
    const pass = (i: number) => unitPassable(m, i % m.w, (i / m.w) | 0) || m.tiles[i] === Tile.Bridge;
    const s0 = at(m.starts[0]);
    const s1 = at(m.starts[1]);
    expect(pass(s0) && pass(s1)).toBe(true);
    expect(flood(m, s0, pass)[s1]).toBe(1);
    // over each bridge on its own
    for (let k = 0; k < m.bridges.length; k++) {
      const others = new Set<number>();
      m.bridges.forEach((b, j) => {
        if (j === k) return;
        for (let i = 0; i < m.w * m.h; i++) if (m.tiles[i] === Tile.Bridge && Math.hypot((i % m.w) + 0.5 - b.x, ((i / m.w) | 0) + 0.5 - b.y) < b.length) others.add(i);
      });
      expect(flood(m, s0, (i) => pass(i) && !others.has(i))[s1], `bridge ${k}`).toBe(1);
    }
    // and not without them
    const noBridge = (i: number) => m.tiles[i] !== Tile.Bridge && unitPassable(m, i % m.w, (i / m.w) | 0);
    expect(flood(m, s0, noBridge)[s1]).toBe(0);
  });

  it('lets vehicles drive the exaggerated relief: base to base, and from every deck end to its own base', () => {
    const w = new World({ seed: 1, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 0, isAI: false }] });
    const pf = w.pfs[Loco.Vehicle];
    const reaches = (fx: number, fy: number, t: { x: number; y: number }) => {
      const p = pf.find(Math.floor(fx), Math.floor(fy), t.x, t.y, 2000000);
      return p.length > 0 && p[p.length - 1] === t.y * w.map.w + t.x;
    };
    expect(reaches(w.map.starts[0].x, w.map.starts[0].y, w.map.starts[1])).toBe(true);
    for (const b of w.bridges)
      for (const k of [0, 1] as const) {
        const e = b.ends[k];
        expect(reaches(e.x - b.ux * (k ? -1 : 1), e.y - b.uy * (k ? -1 : 1), w.map.starts[k]), `bridge ${b.idx} end ${k}`).toBe(true);
      }
  });

  it('gives both bases room to build, and a coast for a shipyard', () => {
    for (const s of m.starts) {
      let ok = 0;
      let n = 0;
      for (let y = s.y - 9; y <= s.y + 9; y += 3)
        for (let x = s.x - 9; x <= s.x + 9; x += 3) {
          if (Math.hypot(x - s.x, y - s.y) > 9) continue;
          n++;
          if (terrainBuildable(m, x, y, 3, 3)) ok++;
        }
      expect(ok / n).toBeGreaterThan(0.75);
      expect(terrainBuildable(m, s.x - 1, s.y - 1, 3, 3)).toBe(true);
      // a shipyard site on the own bank within the construction yard's reach
      const nav = navalTerrain(m);
      // (on the own bank: reached by land from the base without a bridge)
      const own = flood(m, at(s), (i) => m.tiles[i] !== Tile.Bridge && unitPassable(m, i % m.w, (i / m.w) | 0));
      let yard = false;
      for (let y = 0; y < m.h - 4 && !yard; y++)
        for (let x = 0; x < m.w - 4 && !yard; x++) {
          if (Math.hypot(x + 2 - s.x, y + 2 - s.y) > SHIP_YARD_REACH) continue;
          if (!shipSite(m, nav.sea, x, y).ok) continue;
          for (let yy = y; yy < y + 4 && !yard; yy++) for (let xx = x; xx < x + 4; xx++) if (own[yy * m.w + xx]) yard = true;
        }
      expect(yard).toBe(true);
    }
  });
});
