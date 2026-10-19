import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { buildingDef } from '../src/sim/defs';
import { Tile, mirrorPoint, mirrorRect, type GameMap, type MapId } from '../src/sim/map';
import { MAP_IDS, createMap } from '../src/sim/maps';
import { PathFinder } from '../src/sim/path';
import { TPS } from '../src/sim/types';
import { World, type PlayerSetup } from '../src/sim/world';

const NEW_MAPS: MapId[] = ['desert', 'winter', 'urban'];

function digest(m: GameMap) {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 16777619) >>> 0;
  };
  for (const arr of [m.tiles, m.trees, m.ore, m.oreKind, m.blocked]) for (let i = 0; i < arr.length; i++) mix(arr[i]);
  for (let i = 0; i < m.heights.length; i++) mix(Math.round(m.heights[i] * 1e5));
  return [h, JSON.stringify({ s: m.structures, b: m.bridges, o: m.oils, r: m.roads, st: m.starts, t: m.techSites, d: m.deco })];
}

function world(map: MapId, seed: number, players = 2) {
  const all: PlayerSetup[] = [
    { name: 'A', faction: 'usa', color: 0x2f7dff, isAI: true },
    { name: 'B', faction: 'russia', color: 0xe0322b, isAI: true },
  ];
  return new World({ seed, map, players: all.slice(0, players) });
}

describe('maps', () => {
  it('every map lists a biome and the default stays Frontline Crossing', () => {
    expect(MAP_IDS).toEqual(['frontline', 'desert', 'winter', 'urban']);
    const w = new World({ players: [{ name: 'A', faction: 'usa', color: 0, isAI: true }] });
    expect(w.map.id).toBe('frontline');
    expect(w.map.biome).toBe('temperate');
    expect(createMap('desert', 1).biome).toBe('desert');
    expect(createMap('winter', 1).biome).toBe('winter');
    expect(createMap('urban', 1).biome).toBe('urban');
  });

  it('generates each map deterministically from the seed', () => {
    for (const id of MAP_IDS) {
      for (const seed of [1, 424242]) expect(digest(createMap(id, seed))).toEqual(digest(createMap(id, seed)));
    }
    // the seed varies the new maps' details; Frontline Crossing is fixed
    for (const id of NEW_MAPS) expect(digest(createMap(id, 1))[0]).not.toBe(digest(createMap(id, 2))[0]);
    expect(digest(createMap('frontline', 1))).toEqual(digest(createMap('frontline', 2)));
  });

  it('is point symmetric (fair) for winter and urban (the Sinai mirrors across its diagonal: tests/sinai.test.ts)', () => {
    for (const id of ['winter', 'urban'] as MapId[]) {
      const m = createMap(id, 5);
      const n = m.w * m.h;
      let diff = 0;
      for (let i = 0; i < n; i++) if (m.tiles[i] !== m.tiles[n - 1 - i] || !!m.trees[i] !== !!m.trees[n - 1 - i] || m.oreKind[i] !== m.oreKind[n - 1 - i] || m.blocked[i] !== m.blocked[n - 1 - i]) diff++;
      expect(diff).toBe(0);
      expect(m.structures.length % 2).toBe(0);
    }
  });

  it('every map has balanced ore, oil, ore mines and neutral structures (BAL1)', () => {
    for (const id of MAP_IDS) {
      const w = world(id, 3);
      const m = w.map;
      // (the Sinai is traced from a picture, no mirror: tests/sinai.test.ts counts what each side holds)
      if (m.mirror === 'none') continue;
      const n = m.w * m.h;
      if (id !== 'desert') {
        let diff = 0;
        for (let i = 0; i < n; i++) if (m.tiles[i] !== m.tiles[n - 1 - i] || m.trees[i] !== m.trees[n - 1 - i] || m.ore[i] !== m.ore[n - 1 - i] || w.pass[i] !== w.pass[n - 1 - i]) diff++;
        expect(diff, `${id}: tiles / trees / ore / passability`).toBe(0);
        const nv = (m.w + 1) * (m.h + 1);
        let hd = 0;
        for (let i = 0; i < nv; i++) hd = Math.max(hd, Math.abs(m.heights[i] - m.heights[nv - 1 - i]));
        expect(hd, `${id}: heights`).toBeLessThan(0.05);
      }
      // (each map's own mirror: through the centre, or the Sinai's across its diagonal)
      const pts = (a: { x: number; y: number }[], size: number) => {
        const k = new Set(a.map((p) => `${p.x},${p.y}`));
        return a.filter((p) => {
          const q = mirrorRect(m, p.x, p.y, size, size);
          return !k.has(`${q.x},${q.y}`);
        }).length;
      };
      expect(pts(m.oils, 2), `${id}: oil derricks (2 x 2)`).toBe(0);
      expect(pts(m.oreMines, 1), `${id}: ore mines`).toBe(0);
      // neutral entities (derricks, tech sites, bridge huts, garrisons): each has its mirror twin
      const ents = w.list.filter((e) => e.owner < 0 && e.def !== 'bridge');
      const ek = new Set(ents.map((e) => `${e.def}@${e.x},${e.y}`));
      const lone = ents.filter((e) => {
        const q = mirrorPoint(m, e.x, e.y);
        return !ek.has(`${e.def}@${q.x},${q.y}`);
      }).map((e) => `${e.def}@${e.x},${e.y}`);
      expect(lone, `${id}: neutral structures`).toEqual([]);
    }
  });

  it('Wadi Al-Rimal: each coloured canyon is a passable sandy floor between rock walls, mouth to mouth', () => {
    for (const seed of [1, 5]) {
      const w = world('desert', seed);
      const m = w.map;
      const pf = new PathFinder(m.w, m.h, w.pass);
      for (const c of m.deco!.canyons!) {
        const a = c.pts[0];
        const b = c.pts[c.pts.length - 1];
        // the floor along the course is passable sand (no trees) about four tiles across, the walls beside it mostly rock
        expect(c.hw, 'floor half width').toBeGreaterThanOrEqual(2);
        let floor = 0;
        let sand = 0;
        let across = 0;
        let open = 0;
        let wall = 0;
        let beside = 0;
        for (let k = 0; k < c.pts.length - 1; k++) {
          const p = c.pts[k];
          const q = c.pts[k + 1];
          const len = Math.hypot(q.x - p.x, q.y - p.y);
          for (let t = 0; t < len; t += 0.5) {
            const x = Math.round(p.x + ((q.x - p.x) * t) / len);
            const y = Math.round(p.y + ((q.y - p.y) * t) / len);
            floor++;
            if (m.tiles[y * m.w + x] === Tile.Sand && w.pass[y * m.w + x]) sand++;
            const nx = -(q.y - p.y) / len;
            const ny = (q.x - p.x) / len;
            for (const s of [-1, 1]) {
              // the floor's width: passable out to 1.6 tiles either side of the centre line (tile centres)
              for (const r of [0.8, 1.6]) {
                const fx = Math.round(p.x + ((q.x - p.x) * t) / len + nx * s * r);
                const fy = Math.round(p.y + ((q.y - p.y) * t) / len + ny * s * r);
                across++;
                if (w.pass[fy * m.w + fx]) open++;
              }
              const wx = Math.round(p.x + ((q.x - p.x) * t) / len + nx * s * (c.hw + 0.7));
              const wy = Math.round(p.y + ((q.y - p.y) * t) / len + ny * s * (c.hw + 0.7));
              beside++;
              if (m.tiles[wy * m.w + wx] === Tile.Rock) wall++;
            }
          }
        }
        expect(sand / floor, `seed ${seed}: canyon floor`).toBeGreaterThan(0.95);
        expect(open / across, `seed ${seed}: canyon floor width`).toBeGreaterThan(0.95);
        expect(wall / beside, `seed ${seed}: canyon walls`).toBeGreaterThan(0.45);
        // a ground route runs from mouth to mouth (through it or round it) and the canyon floor is its own way through
        const path = pf.find(Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y), 200000);
        expect(path.length, `seed ${seed}: mouth to mouth`).toBeGreaterThan(0);
      }
    }
  });

  it('every start can reach the other start and every ore field, on every map', () => {
    for (const id of MAP_IDS) {
      for (const seed of [3, 99]) {
        const w = world(id, seed);
        const m = w.map;
        // the world's own passability: terrain + oil derricks, civilian buildings, tech sites, bridge huts
        const pf = new PathFinder(m.w, m.h, w.pass);
        const reach = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const p = pf.find(a.x, a.y, b.x, b.y, 200000);
          return p.length > 0 && p[p.length - 1] === b.y * m.w + b.x;
        };
        for (const a of m.starts) {
          for (const b of m.starts) if (a !== b) expect(reach(a, b), `${id}/${seed}: start ${a.x},${a.y} -> ${b.x},${b.y}`).toBe(true);
          for (const o of m.oreMines) {
            // the nearest ore tile of the field
            let best = -1;
            let bd = Infinity;
            for (let y = o.y - 4; y <= o.y + 4; y++)
              for (let x = o.x - 4; x <= o.x + 4; x++) {
                if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
                const i = y * m.w + x;
                if (!m.ore[i] || !w.pass[i]) continue;
                const d = Math.hypot(x - o.x, y - o.y);
                if (d < bd) {
                  bd = d;
                  best = i;
                }
              }
            expect(best, `${id}: ore field at ${o.x},${o.y} has ore`).toBeGreaterThanOrEqual(0);
            expect(reach(a, { x: best % m.w, y: Math.floor(best / m.w) }), `${id}/${seed}: start ${a.x},${a.y} -> ore ${o.x},${o.y}`).toBe(true);
          }
        }
        // the bases have room: the start tiles and their surroundings are open ground
        for (const s of m.starts) {
          let open = 0;
          for (let y = s.y - 6; y <= s.y + 6; y++) for (let x = s.x - 6; x <= s.x + 6; x++) if (w.pass[y * m.w + x] && m.tiles[y * m.w + x] !== Tile.Bridge) open++;
          expect(open, `${id}: open ground around the start`).toBeGreaterThan(150);
        }
      }
    }
  });

  it('places garrisonable civilian buildings and tech sites on the new maps', () => {
    for (const id of NEW_MAPS) {
      const w = world(id, 11);
      const civ = w.list.filter((e) => e.kind === 'building' && buildingDef(e.def).garrison);
      const tech = w.list.filter((e) => e.kind === 'building' && buildingDef(e.def).capturable && buildingDef(e.def).techKind);
      expect(civ.length, id).toBeGreaterThanOrEqual(id === 'urban' ? 40 : 8);
      expect(tech.length, id).toBeGreaterThanOrEqual(4);
    }
  });

  for (const id of NEW_MAPS) {
    it(`a short AI-vs-AI game runs on ${id}`, () => {
      const w = world(id, 21);
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      for (let i = 0; i < TPS * 150 && !w.over; i++) w.step();
      for (const p of w.players) {
        const roles = w.list.filter((e) => !e.dead && e.owner === p.id && e.kind === 'building').map((e) => buildingDef(e.def).role);
        expect(roles, `${id}: ${p.name}`).toContain('conyard');
        expect(roles, `${id}: ${p.name}`).toContain('refinery');
      }
      expect(w.players.some((p) => p.stats.harvested > 0), `${id}: ore harvested`).toBe(true);
    }, 120000);
  }
});
