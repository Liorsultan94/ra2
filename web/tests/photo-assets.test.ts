import { describe, expect, it } from 'vitest';
import { PHOTO_BARKS, PHOTO_HDRIS, PHOTO_MATERIALS, PHOTO_SIZES, PHOTO_STACKS } from '../src/render/terrainset';
import { biomeLook } from '../src/render/biome';

// the baked files (tools/bake-terrain.mjs, tools/bake-rocks.mjs) as Vite sees them
const files = Object.keys(import.meta.glob('../public/tex/**/*.{webp,glb,json,txt}', { query: '?url', eager: true })).map((k) => k.replace('../public/', ''));
const rocks = Object.values(import.meta.glob('../public/tex/rocks/rocks.json', { eager: true, import: 'default' }))[0] as {
  glb: { bytes: number };
  atlas: Record<string, { albedo: number; normal: number }>;
  rocks: { key: string; hiTris: number; loTris: number }[];
};

describe('photoscanned terrain assets', () => {
  it('every layer of every biome stack has both maps at every size', () => {
    for (const [biome, st] of Object.entries(PHOTO_STACKS)) {
      expect(st.layers.length, biome).toBeGreaterThan(4);
      for (const k of st.layers) {
        expect(PHOTO_MATERIALS[k], k).toBeTruthy();
        for (const S of PHOTO_SIZES) for (const m of ['a', 'n']) expect(files, `${biome}: ${S}/${k}_${m}`).toContain(`tex/terrain/${S}/${k}_${m}.webp`);
      }
      for (const [slot, li] of Object.entries(st.slot)) expect(li, `${biome}.${slot}`).toBeLessThan(st.layers.length);
    }
  });

  it('barks, HDRIs, rocks and the credits are there', () => {
    for (const k of Object.keys(PHOTO_BARKS)) expect(files).toContain(`tex/bark/${k}.webp`);
    for (const k of Object.keys(PHOTO_HDRIS)) expect(files).toContain(`tex/hdri/${k}.webp`);
    for (const f of ['rocks.glb', 'rocks_a_512.webp', 'rocks_n_512.webp', 'rocks_a_1024.webp', 'rocks_n_1024.webp']) expect(files).toContain(`tex/rocks/${f}`);
    expect(files).toContain('tex/CREDITS.txt');
    // phone budget for the rock models: <= 2k triangles near, <= 300 far
    for (const r of rocks.rocks) {
      expect(r.hiTris, r.key).toBeLessThanOrEqual(2000);
      expect(r.loTris, r.key).toBeLessThanOrEqual(300);
    }
  });

  it('stays inside the download budget (medium <= 6 MB, high <= 15 MB per map)', () => {
    const barks = Object.values(PHOTO_BARKS).reduce((a, b) => a + b.bytes, 0);
    const hdris = Object.values(PHOTO_HDRIS).reduce((a, h) => a + h.bytes, 0);
    const rk = (S: number) => rocks.glb.bytes + rocks.atlas[S].albedo + rocks.atlas[S].normal;
    for (const [biome, st] of Object.entries(PHOTO_STACKS)) {
      expect(st.bytes[512] + rk(512) + barks, `${biome} medium`).toBeLessThan(6 * 1048576);
      expect(st.bytes[1024] + rk(1024) + barks + hdris, `${biome} high`).toBeLessThan(15 * 1048576);
    }
  });

  it('biome looks derive their ground colours from the scans', () => {
    for (const b of ['temperate', 'desert', 'winter', 'urban'] as const) {
      const g = biomeLook(b).ground;
      for (const v of [g.dirt, g.rock, g.sand, g.mud]) expect(v).toBeGreaterThan(0);
    }
  });
});
