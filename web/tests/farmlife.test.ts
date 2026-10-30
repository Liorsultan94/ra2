import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { estateChimneys, estatePlans, tractorAt, tractorRoute } from '../src/render/farm';
import { farmSmokeAmount } from '../src/render/fx/atmosrules';
import { surfaceHeight } from '../src/render/ground';

/*
 * FM1: life on the desert farm estates (render only): the tractor at work on one field, the livestock on
 * another, the farmhouse chimney's evening smoke. All placed from the estate hashes.
 */

const m = createMap('desert', 1);
const layout = buildLayout(m);

describe('desert farm estates: tractors, herds, chimneys', () => {
  it('the plans are deterministic and shared', () => {
    const a = estatePlans(m, layout);
    expect(a.length).toBe(layout.pivots!.length);
    expect(estatePlans(m, layout)).toBe(a);
    const m2 = createMap('desert', 1);
    const b = estatePlans(m2, buildLayout(m2));
    expect(b.map((p) => [p.tractor, p.graze, p.chimney, p.fields.map((f) => f.crop)])).toEqual(a.map((p) => [p.tractor, p.graze, p.chimney, p.fields.map((f) => f.crop)]));
  });

  it('most estates have a tractor at work and a grazing field, never the same one', () => {
    const plans = estatePlans(m, layout);
    expect(plans.filter((p) => p.tractor).length).toBeGreaterThanOrEqual(Math.ceil(plans.length * 0.75));
    for (const p of plans) {
      if (p.tractor && p.graze >= 0) expect(p.tractor.field).not.toBe(p.graze);
      if (p.graze >= 0) expect(['stubble', 'grove', 'fodder']).toContain(p.fields[p.graze].crop);
    }
  });

  it('the tractor drives up and down its field, turning on the headland, inside the estate', () => {
    const pivots = layout.pivots!;
    for (const p of estatePlans(m, layout)) {
      if (!p.tractor) continue;
      const e = p.fields[p.tractor.field];
      const r = tractorRoute(e.f, p.tractor.passes, p.tractor.reach);
      expect(p.tractor.passes.length).toBeGreaterThanOrEqual(2);
      expect(r.len).toBeGreaterThan(p.tractor.passes.length * 2 * p.tractor.reach);
      const pv = pivots[p.k];
      const at = { x: 0, z: 0, yaw: 0 };
      let seg = 0;
      for (let s = 0; s < r.len * 2; s += 0.05) {
        seg = tractorAt(r, s, seg, at);
        expect(Math.hypot(at.x - pv.x, at.z - pv.y)).toBeLessThan(pv.r + 0.5);
        // across the field: within its width (wheat: or on the dirt track along it)
        const dx = at.x - e.f.cx;
        const dz = at.z - e.f.cy;
        expect(Math.abs(-dx * Math.sin(e.f.angle) + dz * Math.cos(e.f.angle))).toBeLessThan(e.f.hw + (e.crop === 'wheat' ? 0.05 + 0.13 + 0.01 : 0.05));
      }
    }
  });

  it('the chimney stands on the farmhouse roof', () => {
    for (const c of estateChimneys(m, layout)) {
      const g = surfaceHeight(m, c.x, c.z);
      expect(c.y - g).toBeGreaterThan(0.4);
      expect(c.y - g).toBeLessThan(0.5);
    }
  });

  it('the farmhouse hearth smokes in the evening and night, not at midday', () => {
    expect(farmSmokeAmount(12)).toBe(0);
    expect(farmSmokeAmount(14.5)).toBe(0);
    expect(farmSmokeAmount(20)).toBeGreaterThan(0.9);
    expect(farmSmokeAmount(23)).toBeGreaterThan(0.6);
    expect(farmSmokeAmount(2)).toBeGreaterThan(0.5);
    expect(Math.abs(farmSmokeAmount(23.999) - farmSmokeAmount(0))).toBeLessThan(0.01);
    expect(farmSmokeAmount(10)).toBe(0);
    for (let h = 0; h < 24; h += 0.25) {
      expect(farmSmokeAmount(h)).toBeGreaterThanOrEqual(0);
      expect(farmSmokeAmount(h)).toBeLessThanOrEqual(1);
    }
  });
});
