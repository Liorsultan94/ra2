import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { installShadowFilter } from '../src/render/shadowfilter';

describe('sun shadow filter (GD5)', () => {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  const orig = C.shadowmap_pars_fragment;

  it('turns the PCF disk by the shadow map cell (world-anchored), not the screen pixel', () => {
    expect(installShadowFilter('medium')).toBe(true);
    const s = C.shadowmap_pars_fragment;
    const pcf = s.slice(s.indexOf('float getShadow( sampler2DShadow'), s.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'));
    expect(pcf).toContain('interleavedGradientNoise( floor( shadowCoord.xy * shadowMapSize * 2.0 ) )');
    expect(pcf).not.toContain('interleavedGradientNoise( gl_FragCoord.xy )');
    expect(pcf.match(/vogelDiskSample\( \d+, 5, phi \)/g)?.length).toBe(5);
  });

  it('high takes 12 taps; re-installing starts from three’s own chunk', () => {
    expect(installShadowFilter('high')).toBe(true);
    const s = C.shadowmap_pars_fragment;
    const pcf = s.slice(s.indexOf('float getShadow( sampler2DShadow'), s.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'));
    expect(pcf.match(/vogelDiskSample\( \d+, 12, phi \)/g)?.length).toBe(12);
    expect(pcf.match(/vogelDiskSample\( \d+, 5, phi \)/g)).toBeNull();
    expect(s.length).toBeGreaterThan(orig.length);
    C.shadowmap_pars_fragment = orig;
  });
});
