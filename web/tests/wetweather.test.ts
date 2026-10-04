import { describe, expect, it } from 'vitest';
import { WeatherCycle, WX_PRESETS, wxPreset } from '../src/render/weathercycle';
import { WX, wxPins } from '../src/render/wxuniforms';

describe('wet weather debug overrides', () => {
  it('parses ?wx= presets and ignores unknown names', () => {
    expect(wxPreset('?wx=heavy')).toBe(WX_PRESETS.heavy);
    expect(wxPreset('?map=urban&wx=drying&q=high')?.wet).toBeCloseTo(0.45);
    expect(wxPreset('?wx=toString')).toBeNull();
    expect(wxPreset('?wx=')).toBeNull();
    expect(wxPreset('')).toBeNull();
  });

  it('presets run from dry through soaking to drying out', () => {
    const order = ['clear', 'drizzle', 'light', 'rain', 'heavy'].map((k) => WX_PRESETS[k].wet ?? 0);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(WX_PRESETS.drying.precip).toBe(0);
    expect(WX_PRESETS.drying.wet!).toBeGreaterThan(WX_PRESETS.damp.wet!);
    expect(WX_PRESETS.snow.fall).toBe('snow');
  });

  it('a forced preset replaces the timeline state (after a few frames of nothing falling)', () => {
    const w = new WeatherCycle(5, { climate: 'urban' });
    w.force = WX_PRESETS.heavy;
    const first = w.at(10);
    expect(first.precip).toBe(0);
    expect(first.wet).toBe(1);
    w.at(10.1);
    w.at(10.2);
    const s = w.at(10.3);
    expect(s.precip).toBe(1);
    expect(s.cover).toBe(1);
    expect(s.fall).toBe('rain');
    expect(s.event).toBeNull();
  });

  it('parses ?wet= / ?rain= / ?snow= pins, clamped to 0..1', () => {
    expect(wxPins('?wet=0.4&rain=2&snow=-1')).toEqual({ wxWet: 0.4, wxRain: 1, wxSnow: 0 });
    expect(wxPins('?wet=abc&rain=')).toEqual({});
  });

  it('has a wet-surface tier uniform (low quality = darkening only)', () => {
    expect(WX.wxGloss.value).toBe(1);
  });
});
