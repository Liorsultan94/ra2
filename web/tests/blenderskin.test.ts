import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

// geometry-only canvas stub (the procedural builders paint a few canvas textures)
const ctx: Record<string | symbol, unknown> = new Proxy(
  {},
  {
    get(t: Record<string | symbol, unknown>, k) {
      if (k in t) return t[k];
      if (k === 'getImageData' || k === 'createImageData') return (x: number, y: number, w?: number, h?: number) => ({ data: new Uint8ClampedArray(Math.max(4, ((w ?? x) | 0) * ((h ?? y) | 0) * 4)), width: w ?? x, height: h ?? y });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t: Record<string | symbol, unknown>, k, v) {
      t[k] = v;
      return true;
    },
  },
);

const style = (team: number) => ({ team, hull: 0x8a8070, accent: 0x888888, flag: [0xffffff, 0x0038b8, 0xffffff], faction: 'israel', region: 'west' }) as never;
const box = (s: number) => new THREE.BoxGeometry(s, s, s);
const tex = () => new THREE.Texture();

describe('Blender skins (models/blenderskin.ts)', () => {
  beforeAll(() => {
    (globalThis as unknown as { document: unknown }).document = { createElement: () => ({ width: 1, height: 1, style: {}, getContext: () => ctx, toDataURL: () => '' }) };
  });

  it('swap only the static meshes of the skinned parts and keep every rig hook', async () => {
    const { createModel } = await import('../src/render/models');
    const { registerSkin } = await import('../src/render/models/blenderskin');
    const plain = createModel('mbt', style(0x11aa22), null);
    const skinGeo = { body: [box(0.5), box(0.4), box(0.3)], turret: [box(0.3), box(0.2), box(0.1)], recoil: [box(0.1), box(0.08), box(0.05)] };
    registerSkin({ def: { id: 'test', model: 'mbt', faction: 'israel' }, parts: new Map(Object.entries(skinGeo)), albedo: tex(), normal: tex(), orm: tex() });
    const m = createModel('mbt', style(0x2a6cff), null);
    // the skin meshes sit in the moving parts, with the wear data copied from the procedural pieces
    const skinned: THREE.Mesh[] = [];
    m.root.traverse((o) => {
      if (o.userData.bk === 'skin') skinned.push(o as THREE.Mesh);
    });
    expect(skinned.length).toBe(3);
    for (const s of skinned) expect(s.geometry.getAttribute('aWear')).toBeTruthy();
    expect(skinned.some((s) => s.parent === m.turret)).toBe(true);
    // no procedural camo / paint / metal bucket left in the skinned parts
    for (const s of skinned) for (const c of s.parent!.children) expect(['s-1', 'D', 'M']).not.toContain(c.userData.bk);
    // rig: turret, muzzle, recoil, wheels and belts, lamps, damage points, size / height kept
    expect(m.turret).toBeTruthy();
    expect(m.muzzles.length).toBe(plain.muzzles.length);
    expect(m.recoil?.length).toBe(plain.recoil?.length);
    const count = (r: THREE.Object3D, tag: string) => {
      let n = 0;
      r.traverse((o) => (n += o.userData.tag === tag ? 1 : 0));
      return n;
    };
    expect(count(m.root, 'belt')).toBe(count(plain.root, 'belt'));
    expect(count(m.root, 'wheels')).toBe(count(plain.root, 'wheels'));
    expect(m.damageFx?.length).toBe(plain.damageFx?.length);
    expect(m.height).toBeCloseTo(plain.height, 6);
    expect(m.anim).toBeTypeOf('function');
    m.anim!({ dt: 0.05, time: 1, moving: true, speed: 1, dist: 1, turn: 0, fired: 0.1, dead: 0, damage: 0.8, built: 1, powered: true });
  });

  it('War Factory: structure swapped, animated nodes / lights / damage FX kept', async () => {
    const { createModel } = await import('../src/render/models');
    const { registerSkin } = await import('../src/render/models/blenderskin');
    const plain = createModel('factory', style(0x11aa22), null);
    registerSkin({ def: { id: 'test-f', model: 'factory', faction: 'israel' }, parts: new Map([['root', [box(2), box(1.5), box(1)]]]), albedo: tex(), normal: tex(), orm: tex() });
    const b = createModel('factory', style(0x2a6cff), null);
    expect(b.root.children.filter((o) => o.name === 'skin').length).toBe(1);
    for (const n of ['bigdoor', 'beaconL', 'beaconR', 'tv0']) expect(b.root.getObjectByName(n)).toBeTruthy();
    expect(b.nightLights?.length).toBe(plain.nightLights?.length);
    expect(b.damageFx?.length).toBe(plain.damageFx?.length);
    b.anim!({ dt: 0.05, time: 1, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0.5, built: 0.5, powered: true, produced: 1 });
  });
});
