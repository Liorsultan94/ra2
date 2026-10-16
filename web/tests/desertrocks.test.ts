import { describe, expect, it } from 'vitest';
import { PHOTO_SIZES, PHOTO_STACKS } from '../src/render/terrainset';
import { photoMaterial, photoStack } from '../src/render/photoground';
import { GRANITE_BYTES, ROCK_FACE_BYTES, ROCK_FACES, ROCK_KIT } from '../src/render/rockset';
import { KIT_KEYS } from '../src/render/rockkit';

// GD4: the desert's Blender-baked rock set
const files = Object.keys(import.meta.glob('../public/tex/**/*.{webp,glb}', { query: '?url', eager: true })).map((k) => k.replace('../public/', ''));

describe('desert rock set (GD4)', () => {
  it('the desert ground takes the baked granite for its bare rock; the other biomes keep the scan', () => {
    const st = photoStack('desert');
    expect(st.layers).not.toContain('greyrock');
    expect(st.layers[st.slot.rock]).toBe('dgranite');
    expect(photoMaterial('dgranite')).toBe(ROCK_FACES.dgranite);
    expect(PHOTO_STACKS.urban.layers).toContain('greyrock');
    expect(photoStack('urban')).toBe(PHOTO_STACKS.urban);
  });

  it('both rock faces have both maps at every size, and the kit is there', () => {
    for (const k of Object.keys(ROCK_FACES)) for (const S of PHOTO_SIZES) for (const m of ['a', 'n']) expect(files, `${S}/${k}_${m}`).toContain(`tex/terrain/${S}/${k}_${m}.webp`);
    expect(files).toContain('tex/rocks/rockkit.glb');
    for (const k of KIT_KEYS) expect(ROCK_KIT.tris[k], k).toBeTruthy();
  });

  it('fits the phone budgets: <= 512 KB per family at phone size, <= 2k triangles near and 300 far per rock', () => {
    expect(ROCK_FACE_BYTES[512] + ROCK_KIT.bytes).toBeLessThanOrEqual(512 * 1024);
    expect(GRANITE_BYTES[512]).toBeLessThan(ROCK_FACE_BYTES[512]);
    for (const [k, t] of Object.entries(ROCK_KIT.tris)) {
      expect(t.hi, k).toBeLessThanOrEqual(2000);
      expect(t.lo, k).toBeLessThanOrEqual(300);
    }
    expect(photoStack('desert').bytes[512]).toBeLessThan(6 * 1048576);
  });
});

describe('rockfall at the cliff feet (GD4)', () => {
  it('lays talus blocks inside the rock only and keeps the chips off roads, tracks and buildings', async () => {
    const { createMap } = await import('../src/sim/maps');
    const { Tile } = await import('../src/sim/map');
    const { buildLayout, occAt, OCC_BUILT, OCC_ROAD, OCC_TRACK } = await import('../src/render/layout');
    const { buildTalus } = await import('../src/render/rocks');
    const { oreKeepOut } = await import('../src/render/orefield');
    const m = createMap('desert', 4);
    const layout = buildLayout(m);
    const sets = buildTalus(m, layout, oreKeepOut(m, 1), 'medium');
    const tile = (x: number, z: number) => m.tiles[Math.floor(z) * m.w + Math.floor(x)];
    let blocks = 0;
    for (const s of sets) {
      if (s.key === 'chip') {
        expect(s.list.length).toBeGreaterThan(100);
        for (const c of s.list) {
          expect(c.sx).toBeLessThan(0.1);
          if (tile(c.x, c.z) !== Tile.Rock) expect(occAt(layout, m, c.x, c.z) & (OCC_ROAD | OCC_TRACK | OCC_BUILT)).toBe(0);
        }
        continue;
      }
      for (const b of s.list) expect(tile(b.x, b.z)).toBe(Tile.Rock);
      blocks += s.list.length;
    }
    // the canyon's blocks are sandstone
    expect(sets.find((s) => s.sand)!.list.length).toBeGreaterThan(10);
    expect(blocks).toBeGreaterThan(200);
    expect(blocks).toBeLessThan(6000);
    console.info('talus', sets.map((s) => `${s.key}${s.sand ? '/sand' : ''} ${s.list.length}`).join(', '));
  });
});
