import { describe, expect, it } from 'vitest';
import { Flipbooks } from '../src/render/fx/flipbook';

// The Blender-authored flipbook atlases (tools/blender/fx_volumes.py + fx_pack.py) must match the runtime.
const man = Object.values(import.meta.glob('../public/fx/fx.json', { eager: true, import: 'default' }))[0] as {
  frame: number;
  grid: number;
  blocks: [number, number];
  motion?: { scale: number };
  effects: Record<string, { block: number; life: number; loop: boolean }>;
};
// bytes of every shipped file (base64 data URLs: 3 bytes per 4 characters)
const sizes: Record<string, number> = {};
for (const [k, v] of Object.entries(import.meta.glob('../public/fx/*.webp', { query: '?inline', eager: true, import: 'default' }))) {
  const s = v as string;
  sizes[k.replace('../public/fx/', '')] = ((s.length - s.indexOf(',') - 1) * 3) / 4;
}

describe('flipbook atlases', () => {
  it('every effect kind the game spawns is in the manifest, each in its own block', () => {
    const blocks = new Set<number>();
    for (const k of Flipbooks.kinds()) {
      const e = man.effects[k];
      expect(e, k).toBeTruthy();
      expect(e.block).toBeLessThan(man.blocks[0] * man.blocks[1]);
      expect(blocks.has(e.block), k).toBe(false);
      blocks.add(e.block);
      expect(e.life).toBeGreaterThan(0);
    }
    expect(man.effects.flame.loop && man.effects.smokeloop.loop).toBe(true);
  });

  it('atlases fit a 4096 texture and the downloads stay within budget', () => {
    expect(man.blocks[0] * man.grid * man.frame).toBeLessThanOrEqual(4096);
    expect(man.blocks[1] * man.grid * man.frame).toBeLessThanOrEqual(4096);
    expect(man.motion?.scale).toBeGreaterThan(0);
    const sum = (fs: string[]) => fs.reduce((a, f) => a + (sizes[f] ?? NaN), 0);
    const desk = sum(['fx-l0.webp', 'fx-l1.webp', 'fx-c.webp', 'fx-e.webp', 'fx-m.webp']);
    const phone = sum(['fx-l0.webp', 'fx-l1.webp', 'fx-c-half.webp', 'fx-e-half.webp', 'fx-m-half.webp']);
    expect(desk).toBeLessThan(1.5e6);
    expect(phone).toBeLessThan(0.8e6);
  });
});
