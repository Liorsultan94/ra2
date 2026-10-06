import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { Tile, type GameMap, type MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { Ground } from '../src/render/ground';
import { biomeLook } from '../src/render/biome';
import { canopyRadius, treeSpots } from '../src/render/vegetation';
import { FOG_DIM, MINIMAP_MAX_BYTES, MinimapBake, fillFog, fogAlpha } from '../src/render/minimap';
import { reliefHeight } from '../src/render/relief';
import type { FogOfWar } from '../src/render/fog';

/** Everything the bake reads, as Terrain.steps builds it (the ground's control maps painted on the CPU). */
function inputs(id: MapId) {
  const map = createMap(id, 1);
  const layout = buildLayout(map);
  const trees = treeSpots(map, 'medium');
  const shade = trees.map((t) => ({ x: t.x, y: t.y, r: canopyRadius(t) }));
  const fog = { apply: (x: unknown) => x } as unknown as FogOfWar;
  const ground = new Ground(map, layout, shade, fog, 'medium', true);
  const N = map.w * ground.res;
  // (only the CPU painting of the control maps: the GPU half of Ground.steps needs a document)
  const paint = (ground as unknown as { paint: (...a: unknown[]) => Iterable<void> }).paint.bind(ground);
  for (const _ of paint(ground.splat, ground.tint, new Uint8Array(N * N * 4), shade)) void _;
  reliefHeight(map, 1, 1); // the relief field is built (memoised) by the terrain before the bake
  return { map, layout, look: ground.look, ground, trees };
}

function bake(id: MapId) {
  const inp = inputs(id);
  const b = new MinimapBake(inp);
  const slices: number[] = [];
  let t = performance.now();
  for (const _ of b.steps()) {
    void _;
    slices.push(performance.now() - t);
    t = performance.now();
  }
  return { ...inp, b, slices };
}

const px = (b: MinimapBake, x: number, y: number) => {
  const i = (Math.floor(y * b.S) * b.W + Math.floor(x * b.S)) * 4;
  return [b.pixels![i], b.pixels![i + 1], b.pixels![i + 2]];
};

describe('minimap recon photo', () => {
  const F = bake('frontline');

  it('bakes in slices within the loading budget, its size capped', () => {
    const { b, slices, map } = F;
    expect(b.ready).toBe(true);
    expect(b.W).toBe(map.w * b.S);
    expect(b.H).toBe(map.h * b.S);
    // 2x the ~2.6 canvas px a tile gets on the minimap
    expect(b.S).toBeGreaterThanOrEqual(5);
    expect(b.bytes()).toBeLessThanOrEqual(MINIMAP_MAX_BYTES);
    expect(b.pixels!.length).toBe(b.W * b.H * 4);
    // a band of rows per yield: many small slices, none a long task
    expect(slices.length).toBeGreaterThanOrEqual(b.H / 10);
    const sorted = [...slices].sort((a, c) => a - c);
    // (wall clock: generous, the full suite runs files in parallel)
    expect(sorted[Math.floor(sorted.length * 0.9)]).toBeLessThan(80);
    expect(b.totalMs).toBeLessThan(5000);
  });

  it('caps the size on a much larger map (fewer pixels per tile)', () => {
    const m = F.map;
    const W = 320;
    const big: GameMap = { ...m, w: W, h: W, tiles: new Uint8Array(W * W), trees: new Uint8Array(W * W), heights: new Float32Array((W + 1) * (W + 1)), structures: [], bridges: [], roads: [] };
    const b = new MinimapBake({ map: big, layout: { ...F.layout, roads: [], fields: [], edges: [] }, look: F.look, ground: F.ground, trees: [] });
    expect(b.S).toBeLessThan(5);
    expect(b.bytes()).toBeLessThanOrEqual(MINIMAP_MAX_BYTES);
  });

  it('shows the real terrain: water, forest canopy, roads', () => {
    const { b, map } = F;
    // deep river water: blue-green and dark
    let wi = -1;
    for (let i = 0; i < map.w * map.h && wi < 0; i++) {
      const x = i % map.w;
      const y = Math.floor(i / map.w);
      if (x > 2 && y > 2 && x < map.w - 3 && y < map.h - 3 && [-1, 0, 1].every((d) => map.tiles[i + d] === Tile.Water && map.tiles[i + d * map.w] === Tile.Water && map.tiles[i + 2 * d] === Tile.Water)) wi = i;
    }
    expect(wi).toBeGreaterThan(0);
    const w = px(b, (wi % map.w) + 0.5, Math.floor(wi / map.w) + 0.5);
    expect(w[2]).toBeGreaterThan(w[0]);
    expect(w[0] + w[1] + w[2]).toBeLessThan(330);
    // a tree crown is darker than the open meadow around the woods
    const t = F.trees.find((s) => s.x > 3 && s.y > 3 && s.x < map.w - 3 && s.y < map.h - 3)!;
    const crown = px(b, t.x, t.y);
    const lum = (c: number[]) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    let meadow = 0;
    let n = 0;
    for (let y = 0; y < map.h; y += 3)
      for (let x = 0; x < map.w; x += 3) {
        const i = y * map.w + x;
        if (map.tiles[i] === Tile.Grass && !map.trees[i]) {
          meadow += lum(px(b, x + 0.5, y + 0.5));
          n++;
        }
      }
    expect(lum(crown)).toBeLessThan(meadow / n);
    // a highway: grey asphalt (low saturation)
    const road = F.layout.roads.find((r) => r.variant === 0)!;
    const p = road.pts[Math.floor(road.pts.length / 2)];
    const a = px(b, p.x + 0.4, p.y);
    expect(Math.max(...a) - Math.min(...a)).toBeLessThan(40);
  });

  it('a destroyed bridge updates the photo (partial re-bake), and a rebuilt one restores it', () => {
    const { b, map } = F;
    expect(map.bridges.length).toBeGreaterThan(0);
    const br = map.bridges[0];
    const before = b.pixels!.slice();
    const v0 = b.version;
    const deck = px(b, br.x, br.y);
    expect(b.setBridgeDown(0, true)).toBe(true);
    expect(b.setBridgeDown(0, true)).toBe(false); // no change, no re-bake
    expect(b.version).toBe(v0 + 1);
    expect(b.rebakes).toBe(1);
    const gap = px(b, br.x, br.y);
    // the concrete deck is gone: the river shows (blue over red, darker than the deck)
    expect(gap[2]).toBeGreaterThan(gap[0]);
    expect(gap[0] + gap[1] + gap[2]).toBeLessThan(deck[0] + deck[1] + deck[2] - 60);
    // only the bridge's patch changed
    let changed = 0;
    let far = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] === b.pixels![i] && before[i + 1] === b.pixels![i + 1] && before[i + 2] === b.pixels![i + 2]) continue;
      changed++;
      const x = (i / 4) % b.W;
      const y = Math.floor(i / 4 / b.W);
      if (Math.hypot(x / b.S - br.x, y / b.S - br.y) > br.length / 2 + 3) far++;
    }
    expect(changed).toBeGreaterThan(50);
    expect(far).toBe(0);
    // engineers rebuild it: the photo is as baked
    expect(b.setBridgeDown(0, false)).toBe(true);
    expect(b.pixels!.every((v, i) => v === before[i])).toBe(true);
  });

  it('a destroyed building leaves its ruin in the photo, and its lights go out', () => {
    const { b, map } = F;
    const st = map.structures.find((s) => s.w * s.h >= 2)!;
    const cx = st.x + st.w / 2;
    const cy = st.y + st.h / 2;
    const roof = px(b, cx, cy);
    const li = (Math.floor(cy * b.LS) * b.LW + Math.floor(cx * b.LS)) * 4;
    const lightsBefore = b.lightPixels!.slice();
    b.ruin(cx, cy, st.w, st.h);
    const rubble = px(b, cx, cy);
    expect(rubble).not.toEqual(roof);
    let lit0 = 0;
    let lit1 = 0;
    for (let y = Math.floor(st.y * b.LS); y < Math.ceil((st.y + st.h) * b.LS); y++)
      for (let x = Math.floor(st.x * b.LS); x < Math.ceil((st.x + st.w) * b.LS); x++) {
        const i = (y * b.LW + x) * 4;
        lit0 += lightsBefore[i] + lightsBefore[i + 1];
        lit1 += b.lightPixels![i] + b.lightPixels![i + 1];
      }
    expect(lit1).toBeLessThan(lit0);
    void li;
  });
});

describe('minimap fog of war overlay', () => {
  it('unexplored dark, explored out of sight dimmed, visible clear', () => {
    expect(fogAlpha(1, 1)).toBe(0);
    expect(fogAlpha(0, 1)).toBe(FOG_DIM);
    expect(fogAlpha(0, 0)).toBe(255);
    expect(FOG_DIM).toBeGreaterThan(40);
    expect(FOG_DIM).toBeLessThan(160); // dimmed, not hidden
  });

  it('fills the overlay per tile: night fog dims explored ground, the classic day fog keeps it clear', () => {
    const n = 6;
    const explored = Uint8Array.from([1, 1, 1, 0, 0, 1]);
    const visibleNight = Uint8Array.from([1, 0, 0, 0, 0, 1]);
    const data = new Uint8ClampedArray(n * 4);
    fillFog(data, visibleNight, explored);
    expect([...Array(n)].map((_, i) => data[i * 4 + 3])).toEqual([0, FOG_DIM, FOG_DIM, 255, 255, 0]);
    // by day (classic fog, world.ts updateVisibility): visible = explored, nothing explored is dimmed
    fillFog(data, explored, explored);
    expect([...Array(n)].map((_, i) => data[i * 4 + 3])).toEqual([0, 0, 0, 255, 255, 0]);
    // the shroud is the radar's dark blue-black
    expect([data[12], data[13], data[14]]).toEqual([4, 7, 10]);
  });
});

describe('minimap biomes', () => {
  it.each(['desert', 'winter', 'urban'] as MapId[])('%s bakes a full photo', (id) => {
    const { b, map, slices } = bake(id);
    expect(b.ready).toBe(true);
    expect(slices.length).toBeGreaterThan(10);
    // the biome reads through: winter mostly white snow, the desert warm sand, the city grey
    let r = 0;
    let g = 0;
    let bl = 0;
    const p = b.pixels!;
    for (let i = 0; i < p.length; i += 4 * 97) {
      r += p[i];
      g += p[i + 1];
      bl += p[i + 2];
    }
    if (id === 'winter') expect(bl).toBeGreaterThan(r);
    if (id === 'desert') expect(r).toBeGreaterThan(bl * 1.2);
    if (id === 'urban') expect(Math.abs(r - bl)).toBeLessThan(r * 0.25);
    expect(biomeLook(map).biome).toBe(map.biome);
  });
});
