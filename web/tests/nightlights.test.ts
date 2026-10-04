import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAR_LIGHT_REF_LEN, NightLights } from '../src/render/night';
import { CAR_SCALE, carModel } from '../src/render/ambient/models';

describe('night lights (render/night.ts)', () => {
  it('shelling knocks some lamps out for a while, then they come back', () => {
    const n = new NightLights(new THREE.Scene(), 'medium', 1);
    expect(n.lampFactor(10, 10, 0)).toBe(1);
    n.outage(10, 10, 4, 100, 30);
    // far away: untouched
    expect(n.lampFactor(30, 30, 105)).toBe(1);
    // within the radius: some of a grid of lamps are dead mid-outage
    let dead = 0;
    let lamps = 0;
    for (let x = 8; x <= 12; x += 0.5)
      for (let z = 8; z <= 12; z += 0.5) {
        lamps++;
        if (n.lampFactor(x, z, 110) === 0) dead++;
      }
    expect(dead).toBeGreaterThan(lamps * 0.2);
    expect(dead).toBeLessThan(lamps * 0.8);
    // long after: all back on
    for (let x = 8; x <= 12; x += 0.5) expect(n.lampFactor(x, 10, 140)).toBe(1);
  });

  it('civilian headlights size their beam pool from the car', () => {
    const n = new NightLights(new THREE.Scene(), 'low', 1);
    // default size: the car the beam was tuned for
    n.carLight(5, 0, 5, 0, 1);
    const ref = n.carBeam(0)!;
    expect(ref.len).toBeGreaterThan(1);
    // the beam starts at the bumper: its centre sits half its length ahead
    expect(ref.ahead).toBeCloseTo(ref.len / 2, 6);
    // a car at unit scale (CAR_SCALE) throws a proportionally longer and wider pool
    const sedan = carModel(0);
    expect(sedan.len).toBeCloseTo(0.5 * CAR_SCALE, 6);
    n.carLight(6, 0, 5, 0, 1, sedan.len);
    const big = n.carBeam(1)!;
    const s = Math.sqrt(sedan.len / CAR_LIGHT_REF_LEN); // pools grow with sqrt(size) (no white wash in queues)
    expect(big.len).toBeCloseTo(ref.len * s, 5);
    expect(big.wid).toBeCloseTo(ref.wid * s, 5);
    expect(big.ahead).toBeCloseTo(big.len / 2, 5);
    // a bad size is ignored, and the queue is capped
    n.carLight(7, 0, 5, 0, 1, 0);
    n.carLight(7, 0, 5, 0, 1, Number.NaN);
    expect(n.queuedCars).toBe(2);
    for (let i = 0; i < 100; i++) n.carLight(i, 0, 5, 0, 1, 0.9);
    expect(n.queuedCars).toBeLessThanOrEqual(64);
    expect(n.carBeam(n.queuedCars)).toBeNull();
    // the next update draws the queue and empties it
    n.update(0.016, 1, [], new THREE.Vector3(), { map: { w: 8, h: 8 } } as never);
    expect(n.queuedCars).toBe(0);
  });
});
