import { describe, expect, it } from 'vitest';
import { PHOTO_SIZES, PHOTO_STACKS } from '../src/render/terrainset';
import { photoMaterial, photoStack } from '../src/render/photoground';
import { SAND_BYTES } from '../src/render/sandset';

// GD1: the desert's Blender-baked sand layers
const files = Object.keys(import.meta.glob('../public/tex/terrain/**/*.webp', { query: '?url', eager: true })).map((k) => k.replace('../public/', ''));

describe('desert sand layers (GD1)', () => {
  it('the desert stack swaps the dune scan for the baked sand and adds the reg gravel slot', () => {
    const st = photoStack('desert');
    expect(st.layers).not.toContain('dunes');
    expect(st.layers[st.slot.sand]).toBe('dsand');
    expect(st.layers[(st.slot as Record<string, number>).reg]).toBe('dreg');
    for (const k of st.layers) {
      expect(photoMaterial(k), k).toBeTruthy();
      for (const S of PHOTO_SIZES) for (const m of ['a', 'n']) expect(files, `${S}/${k}_${m}`).toContain(`tex/terrain/${S}/${k}_${m}.webp`);
    }
    // the other biomes keep their stacks
    expect(photoStack('temperate')).toBe(PHOTO_STACKS.temperate);
    expect(photoStack('winter')).toBe(PHOTO_STACKS.winter);
  });

  it('keeps the sand family inside the download budget (phones <= 512 KB)', () => {
    expect(SAND_BYTES[512]).toBeLessThanOrEqual(512 * 1024);
    expect(SAND_BYTES[1024]).toBeLessThanOrEqual(1100 * 1024);
    const st = photoStack('desert');
    expect(st.bytes[512]).toBeLessThan(6 * 1048576);
  });
});

