import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NightLights } from '../src/render/night';
import { queueHeadlights } from '../src/render/fx/nightlife';

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

  it('civilian headlights read the car list read-only and respect the view', () => {
    const n = new NightLights(new THREE.Scene(), 'low', 1);
    const car = (x: number, s = 0, seen = true) => ({ x, y: 5, yaw: 0, hgt: 0, lift: 0, s, seen, model: { len: 0.4 } });
    const traffic = { cars: [car(5), car(6, 4), car(7, 0, false), car(50)] };
    const before = JSON.stringify(traffic);
    queueHeadlights(traffic, n, { vx0: 0, vy0: 0, vx1: 20, vy1: 20 });
    expect(JSON.stringify(traffic)).toBe(before);
    expect((n as unknown as { nCars: number }).nCars).toBe(1);
    // daylight: nothing queued
    n.setDark(0);
    const m = new NightLights(new THREE.Scene(), 'low', 0);
    queueHeadlights(traffic, m, { vx0: 0, vy0: 0, vx1: 20, vy1: 20 });
    expect((m as unknown as { nCars: number }).nCars).toBe(0);
  });
});
