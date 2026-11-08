import { describe, expect, it } from 'vitest';
import { Tile, terrainBuildable, unitPassable, type GameMap } from '../src/sim/map';
import { createMap, litaniRiver, litaniSea, mapInfo } from '../src/sim/maps';
import { LITANI_N, LITANI_WINDOW } from '../src/sim/litanidata';
import { SEA_MIN, SHIP_YARD_REACH, navalTerrain, shipSite } from '../src/sim/naval';
import { DX, DY, Loco, slopeField } from '../src/sim/slope';
import { neutralSites } from '../src/sim/capture';
import { World } from '../src/sim/world';
import { footprintRise, groundHeight } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';

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

  it('closes the hills and the gorge to vehicles but not to infantry; every field, derrick, site and bridge in reach', () => {
    const w = new World({ seed: 1, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 0, isAI: false }] });
    const mm = w.map;
    const sf = slopeField(mm);
    const n = mm.w * mm.h;
    // the ground each class reaches from the south base (4-connected over steps within its grade limit)
    const reach = (c: number) => {
      const seen = new Uint8Array(n);
      const q = [mm.starts[0].y * mm.w + mm.starts[0].x];
      seen[q[0]] = 1;
      while (q.length) {
        const t = q.pop()!;
        for (let k = 0; k < 4; k++) {
          if ((sf.block[c][t] >> k) & 1) continue;
          const j = t + DY[k] * mm.w + DX[k];
          if (!seen[j] && w.passes[c][j]) (seen[j] = 1), q.push(j);
        }
      }
      return seen;
    };
    const veh = reach(Loco.Vehicle);
    const foot = reach(Loco.Foot);
    let land = 0;
    let footOnly = 0;
    let cut = 0;
    for (let i = 0; i < n; i++) {
      if (mm.tiles[i] === Tile.Water || mm.tiles[i] === Tile.Rock || mm.trees[i] || mm.blocked[i]) continue;
      land++;
      if (foot[i] && !veh[i]) footOnly++;
      if (!foot[i]) cut++;
    }
    // the hills (the real ground over 40 m off the roads and tracks: GameMap.vehicleHills) and the gorge: the
    // infantry's, not the vehicles' - about a third of the open land; none cut off for all
    expect(footOnly / land).toBeGreaterThan(0.28);
    expect(cut / land).toBeLessThan(0.005);
    // the hill ground itself: hardly any of it in the vehicles' reach (only near-level ground where a road leads in)
    let hill = 0;
    let hillVeh = 0;
    for (let i = 0; i < n; i++) if (mm.vehicleHills?.[i] && w.passes[Loco.Foot][i]) (hill++, veh[i] && hillVeh++);
    expect(hill).toBeGreaterThan(5000);
    expect(hillVeh / hill).toBeLessThan(0.1);
    // every ore field, oil derrick, tech site and both bases in the vehicles' reach (both banks: over the bridges)
    const near = (x: number, y: number, r: number) => {
      for (let yy = Math.floor(y - r); yy <= y + r; yy++) for (let xx = Math.floor(x - r); xx <= x + r; xx++) if (xx >= 0 && yy >= 0 && xx < mm.w && yy < mm.h && veh[yy * mm.w + xx]) return true;
      return false;
    };
    expect(veh[mm.starts[1].y * mm.w + mm.starts[1].x]).toBe(1);
    for (const f of mm.oreMines) expect(near(f.x, f.y, 2), `ore ${f.x},${f.y}`).toBe(true);
    for (const s of neutralSites(mm)) expect(near(s.x + s.w / 2 - 0.5, s.y + s.h / 2 - 0.5, Math.max(s.w, s.h) / 2 + 1), `${s.def} ${s.x},${s.y}`).toBe(true);
  });

  it('builds the villages where the real buildings stand, the streets left open', () => {
    // every OSM building of the window bar greenhouses, sheds by the bases and the game's pieces: some 2000 of 3300
    const v = m.deco?.village ?? [];
    expect(v.length).toBeGreaterThan(1800);
    for (const h of v) {
      expect(h.x > 0 && h.y > 0 && h.x < m.w && h.y < m.h).toBe(true);
      expect(h.hl).toBeGreaterThanOrEqual(h.hw);
    }
    // no road is built over: every point along the paved roads stays passable
    for (const r of m.roads)
      for (let k = 1; k < r.length; k++)
        for (let t = 0; t <= 1; t += 0.1) {
          const x = Math.floor(r[k - 1].x + (r[k].x - r[k - 1].x) * t + 0.5);
          const y = Math.floor(r[k - 1].y + (r[k].y - r[k - 1].y) * t + 0.5);
          if (x >= 0 && y >= 0 && x < m.w && y < m.h) expect(m.blocked[y * m.w + x], `road at ${x},${y}`).toBe(0);
        }
  });

  it('makes sense on its slopes: roundabouts level, roads no steeper than the tanks climb, pads level, houses and fields off the crags', () => {
    const gh = (x: number, y: number) => groundHeight(m, Math.max(0, Math.min(m.w - 0.01, x)), Math.max(0, Math.min(m.h - 0.01, y)));
    // every roundabout and turning circle (render/ambient/roadnet.ts) on level ground
    const net = roadNetFor(m, buildLayout(m));
    expect(net.loops.length).toBeGreaterThan(8);
    for (const lp of net.loops) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let r = 0; r <= lp.R + 0.3; r += 0.4)
        for (let a = 0; a < 16; a++) {
          const h = gh(lp.x + Math.cos((a * Math.PI) / 8) * r, lp.y + Math.sin((a * Math.PI) / 8) * r);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      expect(hi - lo, `loop at ${lp.x.toFixed(1)},${lp.y.toFixed(1)}`).toBeLessThan(0.25);
    }
    // no paved road (but a hairpin's inside) steeper than the tanks climb, step by step along it
    const sf = slopeField(m);
    const onRoad = new Uint8Array(m.w * m.h);
    for (const l of m.roads)
      for (let k = 1; k < l.length; k++)
        for (let t = 0; t <= 1; t += 0.02) onRoad[Math.round(l[k - 1].y + (l[k].y - l[k - 1].y) * t) * m.w + Math.round(l[k - 1].x + (l[k].x - l[k - 1].x) * t)] = 1;
    let steep = 0;
    for (let i = 0; i < m.w * m.h; i++)
      if (onRoad[i])
        for (let k = 0; k < 4; k++) {
          const nx = (i % m.w) + DX[k];
          const ny = ((i / m.w) | 0) + DY[k];
          if (nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && onRoad[ny * m.w + nx] && sf.grade[i * 8 + k] > 0.53) steep++;
        }
    expect(steep).toBeLessThan(8);
    // the derricks on level pads (the tech buildings on their gentle spots), the mosques and water towers on level footings
    for (const s of neutralSites(m)) expect(footprintRise(m, s.x, s.y, s.w, s.h), `${s.def} ${s.x},${s.y}`).toBeLessThan(s.def === 'oil' ? 0.2 : 0.45);
    for (const st of m.structures) if (st.kind === 4 || st.kind === 7) expect(footprintRise(m, st.x, st.y, st.w, st.h), `${st.kind} ${st.x},${st.y}`).toBeLessThan(0.15);
    // no house on a crag, no greenhouse or field on a near cliff
    for (const h of m.deco?.village ?? []) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const [u, v] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const y = gh(h.x + u * h.hl * Math.cos(h.ang) - v * h.hw * Math.sin(h.ang), h.y + u * h.hl * Math.sin(h.ang) + v * h.hw * Math.cos(h.ang));
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      expect(hi - lo, `house at ${h.x},${h.y}`).toBeLessThan(0.75);
    }
    expect((m.deco?.plots ?? []).length).toBeGreaterThan(600);
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
          // (the north base on its plateau inland: its coast within twice the reach, on its own bank - a second
          // Construction Yard on the plain below puts the yard down)
          if (Math.hypot(x + 2 - s.x, y + 2 - s.y) > SHIP_YARD_REACH * (s === m.starts[1] ? 2 : 1)) continue;
          if (!shipSite(m, nav.sea, x, y).ok) continue;
          for (let yy = y; yy < y + 4 && !yard; yy++) for (let xx = x; xx < x + 4; xx++) if (own[yy * m.w + xx]) yard = true;
        }
      expect(yard).toBe(true);
    }
  });
});
