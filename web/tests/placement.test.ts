import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { neutralSites } from '../src/sim/capture';
import { buildingDef } from '../src/sim/defs';
import { BRIDGE_HEAD_RUN, StructureKind, Tile, buildMaxRise, footprintRise, onBridgeHead, terrainBuildable, terrainPassable, type GameMap, type MapId } from '../src/sim/map';
import { createMap } from '../src/sim/maps';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';
import { buildLayout, pylonFooting, spanClear } from '../src/render/layout';

/*
 * Map layout and building placement rules: buildings only on gentle ground and never on a bridge
 * head, no unreachable walkable pockets, neutral sites off the roads, tracks, fields and hedges,
 * power-line towers on dry level ground with clear spans, desert houses on gentle ground.
 */

const CASES: [MapId, number][] = [
  ['frontline', 1],
  ['desert', 437163864],
  ['desert', 777],
  ['desert', 42],
  ['winter', 1],
  ['urban', 1],
];

const mkWorld = (map: MapId, seed: number, ai = false) =>
  new World({
    seed,
    map,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: ai },
      { name: 'B', faction: 'russia', color: 0, isAI: ai },
    ],
  });

function reach(m: GameMap) {
  const seen = new Uint8Array(m.w * m.h);
  const q = [m.starts[0].y * m.w + m.starts[0].x];
  seen[q[0]] = 1;
  while (q.length) {
    const t = q.pop()!;
    const x = t % m.w;
    const y = (t / m.w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h || !terrainPassable(m, xx, yy) || seen[yy * m.w + xx]) continue;
      seen[yy * m.w + xx] = 1;
      q.push(yy * m.w + xx);
    }
  }
  return seen;
}

describe('building placement', () => {
  it('rejects steep footprints and bridge heads; every start can deploy its MCV', () => {
    for (const [id, seed] of CASES) {
      const w = mkWorld(id, seed);
      const m = w.map;
      for (const [bw, bh] of [
        [1, 1],
        [2, 2],
        [3, 3],
      ])
        for (let ty = 0; ty + bh <= m.h; ty++)
          for (let tx = 0; tx + bw <= m.w; tx++) {
            if (!terrainBuildable(m, tx, ty, bw, bh)) continue;
            expect(footprintRise(m, tx, ty, bw, bh)).toBeLessThanOrEqual(buildMaxRise(bw, bh));
            for (let y = ty; y < ty + bh; y++) for (let x = tx; x < tx + bw; x++) expect(m.tiles[y * m.w + x] === Tile.Bridge || onBridgeHead(m, x, y)).toBe(false);
          }
      // the deck and the ramp beyond each end are never buildable
      for (const b of m.bridges) {
        const ux = Math.cos(b.angle);
        const uy = Math.sin(b.angle);
        for (const t of [0, b.length / 2 + 1, -(b.length / 2 + 1), b.length / 2 + BRIDGE_HEAD_RUN - 0.6]) expect(terrainBuildable(m, Math.floor(b.x + ux * t), Math.floor(b.y + uy * t))).toBe(false);
      }
      // the starting MCVs deploy where they stand
      for (const s of m.starts) expect(w.canPlace(0, 'usa_conyard', Math.floor(s.x + 0.5) - 1, Math.floor(s.y + 0.5) - 1, -1, false)).toBe(true);
    }
  });

  it('has no walkable pocket the armies can never reach, on any map', () => {
    for (const [id, seed] of CASES) {
      const m = createMap(id, seed);
      const seen = reach(m);
      let cut = 0;
      for (let i = 0; i < m.w * m.h; i++) if (!seen[i] && terrainPassable(m, i % m.w, (i / m.w) | 0)) cut++;
      expect(cut, `${id}#${seed}`).toBe(0);
      expect(seen[m.starts[1].y * m.w + m.starts[1].x]).toBe(1);
    }
  });

  it('plans the neutral sites as a pure function of the map, and the world spawns exactly that plan', () => {
    for (const [id, seed] of CASES) {
      const a = neutralSites(createMap(id, seed));
      expect(neutralSites(createMap(id, seed))).toEqual(a);
      const w = mkWorld(id, seed);
      const spawned = w.list.filter((e) => e.kind === 'building' && e.owner < 0 && (e.def === 'oil' || e.def.startsWith('tech_'))).map((e) => ({ def: e.def, x: e.tx, y: e.ty, w: buildingDef(e.def).w, h: buildingDef(e.def).h }));
      expect(spawned).toEqual(neutralSites(w.map));
      // three tech site pairs on every map
      expect(a.filter((s) => s.def !== 'oil').length).toBe(6);
    }
  });

  it('keeps roads, tracks, fields, hedges, power lines and wrecks off the neutral sites', () => {
    for (const [id, seed] of CASES) {
      const m = mkWorld(id, seed).map;
      const L = buildLayout(m);
      for (const s of neutralSites(m)) {
        const inside = (x: number, y: number, mg: number) => x > s.x - mg && x < s.x + s.w + mg && y > s.y - mg && y < s.y + s.h + mg;
        const tag = `${id}#${seed} ${s.def}@${s.x},${s.y}`;
        for (const r of L.roads) for (const p of r.pts) expect(inside(p.x, p.y, r.width / 2 + 0.1), `road ${tag}`).toBe(false);
        for (const t of L.tracks) for (const p of t.pts) expect(inside(p.x, p.y, t.width / 2 + 0.1), `track ${tag}`).toBe(false);
        for (const f of L.fields) {
          // (the city's painted streets run beside the sites, never over them)
          const ca = Math.cos(f.angle);
          const sa = Math.sin(f.angle);
          for (let a = -f.hl; a <= f.hl; a += 0.25) for (let c = -f.hw; c <= f.hw; c += 0.25) expect(inside(f.cx + ca * a - sa * c, f.cy + sa * a + ca * c, 0), `field ${tag}`).toBe(false);
        }
        for (const e of L.edges) {
          const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) || 1;
          for (let t = 0; t <= len; t += 0.1) expect(inside(e.a.x + ((e.b.x - e.a.x) * t) / len, e.a.y + ((e.b.y - e.a.y) * t) / len, 0.2), `${e.kind} ${tag}`).toBe(false);
        }
        for (const p of [...L.pylons.lines.flat(), ...L.poles.flat(), ...L.wrecks]) expect(inside(p.x, p.y, 0.2), `post ${tag}`).toBe(false);
      }
    }
  });

  it('stands power-line towers on dry level ground, every span clear of rock and hills', () => {
    for (const [id, seed] of CASES) {
      const m = mkWorld(id, seed).map;
      const L = buildLayout(m);
      for (const line of L.pylons.lines) {
        for (const p of line) expect(pylonFooting(m, p.x, p.y), `${id} tower ${p.x.toFixed(1)},${p.y.toFixed(1)}`).toBe(true);
        for (let k = 1; k < line.length; k++) expect(spanClear(m, line[k - 1], line[k]), `${id} span ${k}`).toBe(true);
      }
    }
  });

  it('builds the desert villages on gentle ground', () => {
    for (const seed of [437163864, 777, 1, 42, 2024]) {
      const m = createMap('desert', seed);
      for (const st of m.structures) if (st.kind === StructureKind.MudHouse || st.kind === StructureKind.Courtyard) expect(footprintRise(m, st.x, st.y, st.w, st.h), `#${seed} ${st.x},${st.y}`).toBeLessThanOrEqual(0.4);
      expect(m.structures.length).toBeGreaterThanOrEqual(16);
    }
  });

  it('stays deterministic: two AI games on the same seed play out identically', () => {
    for (const id of ['frontline', 'desert'] as MapId[]) {
      const run = () => {
        const w = mkWorld(id, 777, true);
        w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
        for (let t = 0; t < TPS * 90; t++) w.step();
        return JSON.stringify(w.list.map((e) => [e.id, e.def, e.owner, Math.round(e.x * 1000), Math.round(e.y * 1000), e.hp]));
      };
      const a = run();
      expect(run()).toBe(a);
      // the AI found room for its base
      expect(JSON.parse(a).filter((e: [number, string, number]) => e[2] === 0 && /power|refinery|barracks/.test(e[1])).length).toBeGreaterThan(1);
    }
  });
});
