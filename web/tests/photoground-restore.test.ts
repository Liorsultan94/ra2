import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PhotoGround } from '../src/render/photoground';

describe('photo ground after a lost WebGL context', () => {
  it('falls back to the mean-colour placeholders and streams the scans in again', async () => {
    // the scans cannot load here: the timeline of a load is what matters
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', async () => ({}));
    const g = new PhotoGround('desert', 512, {});
    const placeholder = g.albedo.value;
    expect(placeholder.image.width).toBe(1);
    const n = g.stack.layers.length;
    // pretend the real (GPU-only) arrays were in place
    const real = new THREE.DataArrayTexture(null, 512, 512, n);
    g.albedo.value = real;
    g.normal.value = new THREE.DataArrayTexture(null, 512, 512, n);
    g.ready = true;
    const calls = fetchMock.mock.calls.length;
    g.restore();
    // a non-black placeholder right away (each layer's mean colour), and a fresh download
    expect(g.ready).toBe(false);
    expect(g.albedo.value).not.toBe(real);
    expect(g.albedo.value.image.width).toBe(1);
    const px = g.albedo.value.image.data as Uint8Array;
    expect(px.length).toBe(n * 4);
    for (let i = 0; i < n; i++) expect(px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]).toBeGreaterThan(30);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    vi.unstubAllGlobals();
  });
});
