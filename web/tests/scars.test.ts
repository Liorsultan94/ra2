import { describe, expect, it } from 'vitest';
import { scarAtlas } from '../src/render/scarsdecal';

// battle scars (src/render/scarsdecal.ts): the channel atlas the live and baked decals share
describe('scar atlas', () => {
  const T = 64;
  const tex = scarAtlas(T);
  const W = T * 4;
  const d = tex.image.data as Uint8Array;
  const px = (tile: number, u: number, v: number) => {
    const x = (tile % 4) * T + Math.floor(u * (T - 1));
    const y = Math.floor(tile / 4) * T + Math.floor(v * (T - 1));
    const o = (y * W + x) * 4;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]];
  };

  it('craters have a deep bowl, a raised rim and nothing at the tile edge', () => {
    for (const t of [0, 1]) {
      const c = px(t, 0.5, 0.5);
      expect(c[2]).toBeGreaterThan(180); // depth
      let rim = 0;
      for (let a = 0; a < 16; a++) rim = Math.max(rim, px(t, 0.5 + Math.cos(a) * 0.22, 0.5 + Math.sin(a) * 0.22)[3]);
      expect(rim).toBeGreaterThan(80);
      expect(px(t, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(px(t, 1, 0.5)).toEqual([0, 0, 0, 0]);
    }
  });

  it('scorches are char only, potholes are deep', () => {
    const s = px(2, 0.5, 0.5);
    expect(s[0]).toBeGreaterThan(80);
    expect(s[2]).toBe(0);
    expect(px(4, 0.5, 0.5)[2]).toBeGreaterThan(120);
  });
});
