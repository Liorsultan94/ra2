import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLARE_ALT, FlareFx, UnitVeil } from '../src/render/nightops';
import { FLARE_TICKS } from '../src/sim/night';
import { TPS, type Flare } from '../src/sim/types';
import { World } from '../src/sim/world';

function model() {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 0.6), mat);
  const turret = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.4), mat);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshBasicMaterial({ transparent: true }));
  hull.add(turret);
  root.add(hull, glow);
  return { root, hull, turret, mat };
}

describe('night visuals', () => {
  it('a fading unit wears a veil over its solid meshes only while fading; its own materials stay untouched', () => {
    const v = new UnitVeil();
    const m = model();
    v.set(7, m.root, 0.25);
    expect(v.has(7)).toBe(true);
    const veils: THREE.Mesh[] = [];
    m.root.traverse((o) => (o as unknown as { isVeil?: boolean }).isVeil && veils.push(o as THREE.Mesh));
    expect(veils.length).toBe(2); // hull + turret, not the transparent glow
    const mat = veils[0].material as THREE.ShaderMaterial;
    expect(mat.uniforms.opacity.value).toBeCloseTo(0.75, 6);
    expect(m.hull.material).toBe(m.mat);
    v.set(7, m.root, 0.9);
    expect(mat.uniforms.opacity.value).toBeCloseTo(0.1, 6);
    v.set(7, m.root, 1);
    expect(v.has(7)).toBe(false);
    let left = 0;
    m.root.traverse((o) => (o as unknown as { isVeil?: boolean }).isVeil && left++);
    expect(left).toBe(0);
  });

  it('a flare pops high, sinks to the ground over its burn, sways, and flickers within bounds', () => {
    const w = new World({ seed: 3, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 0, isAI: false }] });
    const f: Flare = { id: 5, owner: 0, from: 1, x: 40, y: 50, fired: 0, at: 40, end: 40 + FLARE_TICKS };
    const t0 = f.at / TPS;
    const life = FLARE_TICKS / TPS;
    const g = FlareFx.position(f, t0, w.map, new THREE.Vector3());
    let prevY = Infinity;
    let maxOff = 0;
    for (let t = t0; t <= t0 + life; t += 0.5) {
      const p = FlareFx.position(f, t, w.map, new THREE.Vector3());
      expect(p.y).toBeLessThanOrEqual(prevY + 1e-9);
      prevY = p.y;
      maxOff = Math.max(maxOff, Math.hypot(p.x - f.x, p.z - f.y));
      const k = FlareFx.brightness(f, t);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
    expect(g.y - prevY).toBeGreaterThan(FLARE_ALT * 0.8);
    expect(maxOff).toBeGreaterThan(0.1); // it sways
    expect(maxOff).toBeLessThan(0.7); // ... but stays over its spot (the sim reveals around f.x, f.y)
    expect(FlareFx.brightness(f, t0 - 0.1)).toBe(0); // shell still in the air
    expect(FlareFx.brightness(f, t0 + 5)).toBeGreaterThan(0.8);
    expect(FlareFx.brightness(f, t0 + life + 0.01)).toBe(0);
  });
});
