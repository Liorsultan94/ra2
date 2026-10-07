import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { SandStorm } from '../src/render/sandstorm';
import { WeatherCycle } from '../src/render/weathercycle';

/*
 * The sandstorm front (render/sandstorm.ts) rolls across the map on the seeded weather timeline: it starts
 * beyond the upwind edge, sweeps over the whole map while the sand ramps up, and the clear air behind its
 * trailing edge follows as it eases. Pure function of game time: every player sees the same storm.
 */
describe('sandstorm front', () => {
  const m = createMap('desert', 437163864);
  const c = new WeatherCycle(1234, { climate: 'desert' });
  c.eventAt(5000);
  const e = c.events.find((q) => q.kind === 'dust')!;
  const dx = Math.cos(e.dir);
  const dz = Math.sin(e.dir);
  const proj = (x: number, y: number) => x * dx + y * dz;
  const corners = [proj(0, 0), proj(m.w, 0), proj(0, m.h), proj(m.w, m.h)];
  const lo = Math.min(...corners);
  const hi = Math.max(...corners);
  const fr = new THREE.Vector4();

  it('the desert has dust fronts', () => expect(e).toBeTruthy());

  it('arrives from beyond the upwind edge and covers the whole map at the peak', () => {
    let prev = -Infinity;
    for (let t = e.start; t < e.start + e.build + e.ramp + e.hold * 0.5; t += 0.5) {
      SandStorm.front(m, e, t, c.end(e), dx, dz, fr);
      expect(fr.x).toBeGreaterThanOrEqual(prev);
      prev = fr.x;
    }
    SandStorm.front(m, e, e.start + e.build * 0.31, c.end(e), dx, dz, fr);
    expect(fr.x).toBeLessThan(lo);
    SandStorm.front(m, e, e.start + e.build + e.ramp + e.hold * 0.5, c.end(e), dx, dz, fr);
    expect(fr.x).toBeGreaterThan(hi);
    expect(fr.y).toBeLessThan(lo);
  });

  it('leaves behind its trailing edge, and blows only during the event', () => {
    const end = c.end(e);
    const amt = SandStorm.front(m, e, end - e.clear * 0.31, end, dx, dz, fr);
    expect(fr.y).toBeGreaterThan(hi);
    expect(amt).toBeCloseTo(e.precip);
    expect(SandStorm.front(m, e, e.start, end, dx, dz, fr)).toBe(0);
    expect(SandStorm.front(m, e, end, end, dx, dz, fr)).toBe(0);
    // no event (static sandstorm, forced weather): everywhere, full strength
    expect(SandStorm.front(m, null, 0, 0, dx, dz, fr)).toBe(1);
    expect(fr.x).toBeGreaterThan(1e5);
    expect(fr.y).toBeLessThan(-1e5);
  });
});
