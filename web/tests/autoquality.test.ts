import { describe, expect, it } from 'vitest';
import { classifyGpu, pickQuality, type DeviceProbe } from '../src/render/autoquality';

const dev = (o: Partial<DeviceProbe>): DeviceProbe => ({ webgl2: true, float: true, maxTex: 16384, gpu: '', gpuClass: 'unknown', mem: 8, cores: 8, dpr: 1, coarse: false, bench: -1, ...o });
const withGpu = (gpu: string, o: Partial<DeviceProbe> = {}) => dev({ gpu, gpuClass: classifyGpu(gpu), ...o });

describe('auto quality', () => {
  it('classifies common GPU strings', () => {
    expect(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('strong');
    expect(classifyGpu('ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('strong');
    expect(classifyGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe('strong');
    expect(classifyGpu('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('good');
    expect(classifyGpu('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('mid');
    expect(classifyGpu('AMD Radeon(TM) Graphics')).toBe('mid');
    expect(classifyGpu('Apple GPU')).toBe('good');
    expect(classifyGpu('Adreno (TM) 740')).toBe('good');
    expect(classifyGpu('Adreno (TM) 610')).toBe('mid');
    expect(classifyGpu('Adreno (TM) 506')).toBe('weak');
    expect(classifyGpu('Mali-G78 MP14')).toBe('good');
    expect(classifyGpu('Mali-G52 MC2')).toBe('mid');
    expect(classifyGpu('Mali-T830')).toBe('weak');
    expect(classifyGpu('PowerVR Rogue GE8320')).toBe('weak');
    expect(classifyGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('software');
  });

  it('gives strong desktops ultra, good phones high and weak devices less', () => {
    expect(pickQuality(withGpu('NVIDIA GeForce RTX 4070'))).toBe('ultra');
    // ultra needs float render targets and a big texture size
    expect(pickQuality(withGpu('NVIDIA GeForce RTX 4070', { float: false }))).toBe('high');
    expect(pickQuality(withGpu('Intel(R) Iris(R) Xe Graphics'))).toBe('high');
    expect(pickQuality(withGpu('Apple GPU', { coarse: true, mem: 0, cores: 6, dpr: 3 }))).toBe('high');
    expect(pickQuality(withGpu('Adreno (TM) 740', { coarse: true, cores: 8, dpr: 3 }))).toBe('high');
    expect(pickQuality(withGpu('Mali-G52 MC2', { coarse: true, mem: 4, dpr: 2 }))).toBe('medium');
    expect(pickQuality(withGpu('Mali-T830', { coarse: true, mem: 2, cores: 4 }))).toBe('low');
    expect(pickQuality(withGpu('SwiftShader'))).toBe('low');
    expect(pickQuality(dev({ webgl2: false }))).toBe('low');
  });

  it('lets the benchmark veto an optimistic GPU name and rate unknown ones', () => {
    expect(pickQuality(withGpu('NVIDIA GeForce RTX 4070', { bench: 12 }))).toBe('high');
    expect(pickQuality(dev({ bench: 300 }))).toBe('ultra');
    expect(pickQuality(dev({ bench: 3, coarse: true }))).toBe('medium');
  });
});
