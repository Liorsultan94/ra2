import { describe, expect, it } from 'vitest';
import { HULK_FIRES, hulkClass } from '../src/render/hulkkit';
import { HULK_SET } from '../src/render/hulkset';

// CF1: burnt-out vehicle hulks built in Blender (tools/blender/hulkkit.py -> public/models/hulks.glb)
const files = Object.keys(import.meta.glob('../public/models/*.glb', { query: '?url', eager: true })).map((k) => k.replace('../public/', ''));

describe('vehicle hulks (CF1)', () => {
  it('the kit is there with every class, its blown-open hull and its thrown turret', () => {
    expect(files).toContain('models/hulks.glb');
    for (const k of ['mbt', 'mbt_open', 'mbt_turret', 'ifv', 'ifv_open', 'ifv_turret', 'truck', 'harv']) expect(HULK_SET.pieces[k], k).toBeTruthy();
    for (const c of ['mbt', 'ifv', 'truck', 'harv'] as const) expect(HULK_FIRES[c].length).toBeGreaterThan(0);
  });

  it('fits the phone budget: <= 256 KB download, <= 2k triangles per hulk (a hulk is cheaper than the model it replaces)', () => {
    expect(HULK_SET.bytes).toBeLessThanOrEqual(256 * 1024);
    for (const [k, p] of Object.entries(HULK_SET.pieces)) expect(p.tris, k).toBeLessThanOrEqual(2000);
  });

  it('picks the hulk by vehicle class', () => {
    expect(hulkClass({ turret: true, armor: 'heavy', size: { x: 1 } })).toBe('mbt');
    expect(hulkClass({ turret: true, armor: 'light', size: { x: 1 } })).toBe('ifv');
    expect(hulkClass({ wheeled: true, size: { x: 1 } })).toBe('truck');
    expect(hulkClass({ harvester: true, size: { x: 1.3 } })).toBe('harv');
    expect(hulkClass({ mcv: true, wheeled: true, size: { x: 1.3 } })).toBe('harv');
    // small robots keep their own burnt model
    expect(hulkClass({ turret: true, size: { x: 0.4 } })).toBeNull();
  });
});
