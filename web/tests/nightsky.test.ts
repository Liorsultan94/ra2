import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NSKY, NightSkyDriver, moonAge, moonIllum } from '../src/render/nightsky';

const elev = (v: THREE.Vector3) => THREE.MathUtils.radToDeg(Math.asin(v.y));

describe('desert night sky', () => {
  it('the celestial frame is a rotation and turns westward with the clock (like the sun)', () => {
    const ns = new NightSkyDriver(1234, { x: 64, z: 64 });
    const moon = new THREE.Vector3(-0.5, 0.6, -0.6).normalize();
    const sun = new THREE.Vector3(0.6, -0.3, 0.7).normalize();
    ns.update(20.25, 0, 1, 0, 0, moon, sun);
    const m = NSKY.nsRot.value.clone();
    expect(Math.abs(m.determinant())).toBeCloseTo(1, 5);
    // the galactic centre crosses the meridian (south, the noon sun's azimuth 222 deg) at 20:15, low
    const gc = NSKY.nsGalC.value.clone();
    expect(THREE.MathUtils.radToDeg(Math.atan2(gc.z, gc.x)) + 360).toBeCloseTo(222, -1);
    expect(elev(gc)).toBeGreaterThan(25);
    expect(elev(gc)).toBeLessThan(40);
    // three hours later it has sunk towards the west (the sun sets at azimuth ~143)
    ns.update(23.25, 0, 1, 0, 0, moon, sun);
    const gc2 = NSKY.nsGalC.value.clone();
    expect(elev(gc2)).toBeLessThan(elev(gc) - 8);
    const az2 = (THREE.MathUtils.radToDeg(Math.atan2(gc2.z, gc2.x)) + 360) % 360;
    expect(az2).toBeLessThan(215);
    // the galactic frame stays orthonormal
    expect(NSKY.nsGalN.value.dot(NSKY.nsGalC.value)).toBeCloseTo(0, 3);
    expect(NSKY.nsGalY.value.dot(NSKY.nsGalC.value)).toBeCloseTo(0, 5);
  });

  it('the moon: seeded per match, a crescent to waxing gibbous on the first night, a day older each night', () => {
    for (let s = 0; s < 200; s++) {
      const a = moonAge(s * 7919, 0);
      expect(a).toBeGreaterThanOrEqual(3);
      expect(a).toBeLessThan(9.5);
      expect(moonAge(s * 7919, 0)).toBe(a);
      expect(moonAge(s * 7919, 2)).toBeCloseTo(a + 2, 9);
    }
    expect(moonIllum(0)).toBeCloseTo(0, 6);
    expect(moonIllum(29.53 / 2)).toBeCloseTo(1, 6);
    // glow follows the phase; no moon up = no glow
    const ns = new NightSkyDriver(1, null);
    const sun = new THREE.Vector3(0, -1, 0);
    ns.ageOverride = 14.7;
    ns.update(23, 0, 1, 0, 0, new THREE.Vector3(0, 1, 0), sun);
    expect(ns.moonGlow).toBeGreaterThan(0.95);
    ns.ageOverride = 1;
    ns.update(23, 0, 1, 0, 0, new THREE.Vector3(0, 1, 0), sun);
    expect(ns.moonGlow).toBeLessThan(0.01);
    ns.update(23, 0, 1, 0, 0, null, sun);
    expect(NSKY.nsMoon.value.w).toBe(0);
  });

  it('the town glow: directional from afar, all round inside the town', () => {
    const ns = new NightSkyDriver(1, { x: 64, z: 64 });
    ns.camera(new THREE.Vector3(10, 5, 64));
    const t = NSKY.nsTown.value;
    expect(t.x).toBeCloseTo(1, 5);
    expect(t.y).toBeCloseTo(0, 5);
    expect(t.z).toBeCloseTo(1, 5);
    ns.camera(new THREE.Vector3(64, 5, 64));
    expect(Math.hypot(t.x, t.y)).toBeLessThan(0.01);
  });
});
