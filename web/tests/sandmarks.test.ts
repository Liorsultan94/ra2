import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SandMarks } from '../src/render/sandmarks';
import { WXS } from '../src/render/wxuniforms';
import { createMap } from '../src/sim/maps';
import type { FogOfWar } from '../src/render/fog';

// GD1: persistent tracks in the desert sand (render only)
function fogStub(): FogOfWar {
  const u = { fogTex: { value: null }, fogSize: { value: new THREE.Vector2(128, 128) }, fogEnabled: { value: 0 }, fogNoise: { value: null } };
  return { uniforms: u } as unknown as FogOfWar;
}

describe('persistent sand tracks (GD1)', () => {
  const map = createMap('desert', 1);
  const sun = { value: new THREE.Vector3(0, 1, 0) };
  const sunK = { value: 1 };

  it('lays a track piece every ~0.3 tiles along a straight run', () => {
    const m = new SandMarks(map, fogStub(), 200, sun, sunK);
    for (let i = 0; i <= 60; i++) m.track(7, 40 + i * 0.1, 40, 0, 0.22, false, 1);
    // 6 tiles of travel
    expect(m.laid).toBeGreaterThanOrEqual(15);
    expect(m.laid).toBeLessThanOrEqual(21);
    expect(m.mesh.count).toBe(m.laid);
  });

  it('a second vehicle along the same line moments later does not stack its track on the first', () => {
    const m = new SandMarks(map, fogStub(), 200, sun, sunK);
    for (let i = 0; i <= 40; i++) m.track(1, 40 + i * 0.1, 50, 0, 0.22, false, 1);
    const first = m.laid;
    for (let i = 0; i <= 40; i++) m.track(2, 40 + i * 0.1, 50.02, 0, 0.22, false, 1);
    expect(m.laid).toBe(first);
    expect(m.skipped).toBeGreaterThan(8);
    // ... but a crossing track is laid
    for (let i = 0; i <= 40; i++) m.track(3, 42, 48 + i * 0.1, Math.PI / 2, 0.22, false, 1);
    expect(m.laid).toBeGreaterThan(first + 8);
  });

  it('erodes on a clock that a sandstorm speeds up, and shortens the lives when the pool cycles', () => {
    const m = new SandMarks(map, fogStub(), 50, sun, sunK);
    const u = (m as unknown as { uniforms: { uClock: { value: number }; uLife: { value: number } } }).uniforms;
    m.update(1);
    expect(u.uClock.value).toBeCloseTo(1, 5);
    WXS.sandAmt.value = 1;
    m.update(1);
    expect(u.uClock.value).toBeCloseTo(16, 5);
    WXS.sandAmt.value = 0;
    // fill the pool fast: 80 pieces in ~16 clock seconds
    for (let i = 0; i < 80; i++) {
      m.boot(30 + i * 0.05, 30, 0);
      m.update(0.2);
    }
    for (let i = 0; i < 20; i++) m.update(0.5);
    expect(u.uLife.value).toBeLessThan(60);
    expect(u.uLife.value).toBeGreaterThanOrEqual(12);
  });
});
