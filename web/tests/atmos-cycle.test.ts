import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

// The atmosphere's scene helpers need WebGL / the full scene: light stand-ins (the lighting maths is what's tested).
vi.mock('../src/render/envdamage', () => ({
  EnvDamage: class {
    group = new THREE.Group();
    update() {}
    blast() {}
  },
}));
vi.mock('../src/render/fx/nature', () => ({
  LivingWorld: class {
    snow = 0;
    update() {}
    sky() {}
    impact() {}
    dispose() {}
  },
}));
vi.mock('../src/render/groundfog', () => ({
  GroundFog: class {
    mesh = new THREE.Group();
    update() {}
    setDawn() {}
  },
}));
vi.mock('../src/render/night', () => ({
  NightLights: class {
    darkness = 0;
    setDark(d: number) {
      this.darkness = d;
    }
    update() {}
    dispose() {}
  },
  NightVisionPass: class {},
}));
vi.mock('../src/render/weather', () => ({
  WeatherFx: class {
    mesh = new THREE.Group();
    kind: string;
    struck = false;
    intensity = 0;
    light = 1;
    constructor(kind: string) {
      this.kind = kind;
    }
    setKind(k: string) {
      this.kind = k;
    }
    setIntensity(k: number) {
      this.intensity = k;
    }
    setWind() {}
    setLight(k: number) {
      this.light = k;
    }
    strike() {
      this.struck = true;
    }
    update() {
      return 0;
    }
  },
}));

const { Atmosphere, ATMOS_DEFAULTS, GAME_HOUR_TICKS, hourToU, lightLevel, saneSunDir } = await import('../src/render/atmos');
const { GradeLut, sanitizeGrade } = await import('../src/render/post/grade');
const { FogOfWar } = await import('../src/render/fog');
const { World } = await import('../src/sim/world');

type MapId = 'frontline' | 'desert' | 'winter' | 'urban';

function makeAtmos(map: MapId, seed = 777) {
  (globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
  ATMOS_DEFAULTS.live = true;
  const world = new World({ seed, map, players: [{ name: 'A', faction: 'israel', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 1, isAI: true }] });
  const finalUniforms = {
    exposure: { value: 1 },
    saturation: { value: 1 },
    shadowTint: { value: new THREE.Vector3() },
    highTint: { value: new THREE.Vector3() },
    vignette: { value: 0.3 },
  };
  const host = {
    renderer: { toneMappingExposure: 1.2 },
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    sun: new THREE.DirectionalLight(0xffffff, 3),
    hemi: new THREE.HemisphereLight(0xffffff, 0x444444, 0.8),
    fog: new FogOfWar(world.map.w, world.map.h),
    terrain: { waterMat: { uniforms: { wxLight: { value: new THREE.Vector3(1, 1, 1) }, wxSpec: { value: 1 } } } },
    effects: { wind: { x: 0.3, z: 0.1 } },
    marks: {},
    world,
    quality: 'medium',
    composer: null,
    finalPass: { uniforms: finalUniforms },
    bloom: { strength: 0.4 },
    canvas: { style: { filter: '' } },
  };
  const atmos = new Atmosphere(host as never, 0);
  return { atmos, host, world };
}

const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x));
const MAPS: MapId[] = ['desert', 'frontline', 'urban', 'winter'];

/** Everything the atmosphere hands to the renderer this frame. */
function outputs(atmos: InstanceType<typeof Atmosphere>, host: ReturnType<typeof makeAtmos>['host']) {
  const u = host.fog.uniforms;
  return [
    host.sun.intensity,
    ...host.sun.color.toArray(),
    host.hemi.intensity,
    ...host.hemi.color.toArray(),
    ...host.hemi.groundColor.toArray(),
    host.renderer.toneMappingExposure,
    host.finalPass.uniforms.exposure.value,
    host.finalPass.uniforms.saturation.value,
    host.finalPass.uniforms.vignette.value,
    host.bloom.strength,
    host.scene.environmentIntensity,
    ...(host.scene.background as THREE.Color).toArray(),
    atmos.daylight,
    ...(atmos.sunBase?.toArray() ?? [NaN]),
    ...u.hazeColor.value.toArray(),
    ...u.hazeParams.value.toArray(),
    u.cloudAmount.value,
    ...WX_ALL(),
  ];
}
const { WX, WXM } = await import('../src/render/wxuniforms');
const WX_ALL = () => [WX.wxWet.value, WX.wxDust.value, WX.wxRain.value, WX.wxSnow.value, WXM.mistAmount.value, ...WXM.mistColor.value.toArray(), ...WXM.mistDrift.value.toArray()];

/** Ground light x exposure on screen (atmos.lightLevel of the host's lights). */
function onScreen(atmos: InstanceType<typeof Atmosphere>, host: ReturnType<typeof makeAtmos>['host']) {
  const p = { sunI: host.sun.intensity, sunC: host.sun.color, hemiI: host.hemi.intensity, sky: host.hemi.color, gnd: host.hemi.groundColor };
  return lightLevel(p, atmos.sunBase!.y) * host.finalPass.uniforms.exposure.value;
}

describe('live day + dynamic weather over three days (0 .. 72 game hours)', () => {
  for (const map of MAPS) {
    it(`${map}: every lighting / fog / grade value stays finite and sane (several matches)`, () => {
      const bad: string[] = [];
      for (const seed of [777, 4242, 90001, 123457]) {
        const { atmos, host, world } = makeAtmos(map, seed);
        expect(atmos.cfg.tod).toBe('cycle');
        expect(atmos.cfg.weather).toBe('dynamic');
        const visuals = { values: () => [] };
        const target = new THREE.Vector3(world.map.w / 2, 0, world.map.h / 2);
        // game-minute steps (1 game minute = one real second at 1x), across day 1, 2 and 3
        for (let m = 0; m <= 72 * 60; m++) {
          world.tick = Math.round((m / 60) * GAME_HOUR_TICKS);
          atmos.update(1 / 30, m, visuals, target, 0.6 + (m % 7) * 0.25, host.camera);
          const v = outputs(atmos, host);
          if (!finite(...v) && bad.length < 5) bad.push(`${map}/${seed} ${atmos.clock().day}/${atmos.clock().text}: ${v.map((x) => +x.toFixed(3)).join(',')}`);
          // sane: never black (sky fill + exposure floors), the key light above the horizon
          expect(host.hemi.intensity).toBeGreaterThan(0.1);
          expect(host.finalPass.uniforms.exposure.value).toBeGreaterThanOrEqual(0.7);
          expect(host.finalPass.uniforms.exposure.value).toBeLessThanOrEqual(2.5);
          expect(atmos.sunBase!.y).toBeGreaterThan(0);
          expect(atmos.daylight).toBeGreaterThanOrEqual(0);
          expect(atmos.daylight).toBeLessThanOrEqual(1);
        }
        expect(atmos.repaired).toBe(0);
      }
      expect(bad).toEqual([]);
    });
  }

  it('the clock and the day phase keep running past day 1 (no drift at day 2 / 3)', () => {
    for (const h of [8.883, 32.883, 56.883]) expect(hourToU(h)).toBeCloseTo(hourToU(8.883), 9);
    for (let h = 0; h <= 72; h += 0.01) {
      const u = hourToU(h);
      expect(Number.isFinite(u) && u >= 0 && u <= 1).toBe(true);
    }
  });

  it('light follows the clock: dawn ramps up, full day, sunset ramps down, night (clear sky)', () => {
    const { atmos, host, world } = makeAtmos('desert');
    atmos.wxForce = { cover: 0, precip: 0, storm: 0, mist: 0 };
    const at = (h: number) => {
      world.tick = Math.round((h - atmos.startHour) * GAME_HOUR_TICKS);
      atmos.update(1 / 30, h * 60, { values: () => [] }, new THREE.Vector3(40, 0, 40), 1, host.camera);
      return { day: atmos.daylight, lit: onScreen(atmos, host) };
    };
    const night = at(2);
    const dawn = at(6);
    const morning = at(9);
    const noon = at(12);
    const aft = at(15);
    const dusk = at(19.5);
    const late = at(23);
    expect(night.day).toBeLessThan(0.2);
    expect(dawn.day).toBeGreaterThan(night.day);
    expect(morning.day).toBeGreaterThan(dawn.day);
    expect(noon.day).toBeGreaterThan(0.95);
    expect(aft.day).toBeGreaterThan(0.95);
    expect(dusk.day).toBeLessThan(aft.day);
    expect(late.day).toBeLessThan(0.2);
    expect(noon.lit).toBeGreaterThan(dawn.lit);
    expect(noon.lit).toBeGreaterThan(night.lit * 2);
    // gradual: no jumps from one game minute to the next over the whole day
    let prev = at(0).day;
    for (let h = 0; h <= 48; h += 1 / 60) {
      const d = at(h).day;
      expect(Math.abs(d - prev)).toBeLessThan(0.03);
      prev = d;
    }
  });

  for (const map of MAPS) {
    it(`${map}: weather never drives the daytime into darkness`, () => {
      for (const seed of [777, 4242, 90001]) {
        const { atmos, host, world } = makeAtmos(map, seed);
        const target = new THREE.Vector3(world.map.w / 2, 0, world.map.h / 2);
        let worst = 9;
        let worstAt = '';
        for (let m = 0; m <= 48 * 60; m += 2) {
          world.tick = Math.round((m / 60) * GAME_HOUR_TICKS);
          // the clear sky of this minute, then the real weather
          atmos.wxForce = { cover: 0, precip: 0, storm: 0, mist: 0 };
          atmos.update(1 / 30, m, { values: () => [] }, target, 1, host.camera);
          const clear = onScreen(atmos, host);
          atmos.wxForce = null;
          atmos.update(1 / 30, m, { values: () => [] }, target, 1, host.camera);
          if (atmos.daylight < 0.85) continue;
          const r = onScreen(atmos, host) / clear;
          if (r < worst) {
            worst = r;
            worstAt = `${atmos.clock().day}/${atmos.clock().text} m=${m} ${atmos.wx?.event?.kind} s=${atmos.wx?.storm.toFixed(2)} p=${atmos.wx?.precip.toFixed(2)}`;
          }
        }
        // (rain may be greyer and flatter, but at least ~60% of the clear-sky light on screen by day)
        expect(worst, worstAt).toBeGreaterThan(0.58);
      }
    });
  }

  it('desert sandstorm: bright, warm, sand-coloured light at its peak (not dark)', () => {
    const { atmos, host, world } = makeAtmos('desert', 4242);
    const c = atmos.wxCycle!;
    c.eventAt(24 * 60);
    const e = c.events.find((x) => x.kind === 'dust')!;
    const peak = e.start + e.build + e.ramp + e.hold * 0.5;
    world.tick = Math.round(peak * 20);
    atmos.wxForce = { cover: 0, precip: 0, storm: 0, mist: 0 };
    atmos.update(1 / 30, 0, { values: () => [] }, new THREE.Vector3(40, 0, 40), 1, host.camera);
    const clear = onScreen(atmos, host);
    atmos.wxForce = null;
    atmos.update(1 / 30, 0, { values: () => [] }, new THREE.Vector3(40, 0, 40), 1, host.camera);
    expect(atmos.wx!.fall).toBe('sandstorm');
    expect(atmos.wx!.precip).toBeGreaterThan(0.6);
    if (atmos.daylight > 0.85) expect(onScreen(atmos, host) / clear).toBeGreaterThan(0.75);
    // warm sky fill and haze (the sand colour), no night lights
    const sky = host.hemi.color;
    expect(sky.r).toBeGreaterThan(sky.b);
    const hz = host.fog.uniforms.hazeColor.value;
    expect(hz.r).toBeGreaterThan(hz.b * 1.3);
  });
});

describe('hard guards', () => {
  it('a broken preset (NaN / Infinity) falls back to daylight values, never black', () => {
    const { atmos, host, world } = makeAtmos('desert');
    world.tick = 27 * GAME_HOUR_TICKS;
    // poison the cycle's lighting stops and the weather blend target
    const keys = (atmos as unknown as { keys: { p: Record<string, unknown> }[] }).keys;
    for (const k of keys) {
      k.p.sunI = NaN;
      k.p.exposure = Infinity;
      (k.p.sunC as THREE.Color).setRGB(NaN, 1, 1);
      k.p.hemiI = NaN;
    }
    atmos.update(1 / 30, 0, { values: () => [] }, new THREE.Vector3(40, 0, 40), 1, host.camera);
    expect(finite(...outputs(atmos, host))).toBe(true);
    expect(host.finalPass.uniforms.exposure.value).toBeGreaterThanOrEqual(0.7);
    expect(host.hemi.intensity).toBeGreaterThan(0.1);
    expect(atmos.repaired).toBeGreaterThan(0);
  });

  it('a degenerate key light direction falls back to the day sun', () => {
    for (const v of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(NaN, 1, 0), new THREE.Vector3(1, -0.5, 0)]) {
      const d = saneSunDir(v);
      expect(finite(d.x, d.y, d.z)).toBe(true);
      expect(d.length()).toBeCloseTo(1, 6);
      expect(d.y).toBeGreaterThan(0);
    }
  });

  it('the grade input is sanitised (a NaN look would bake a black LUT)', () => {
    const g = sanitizeGrade({ daylight: NaN, sunY: Infinity, warmth: NaN, rain: NaN, storm: -1, sand: 2, snow: NaN });
    expect(finite(g.daylight, g.sunY, g.warmth, g.rain, g.storm, g.sand, g.snow)).toBe(true);
    expect(g.daylight).toBe(1);
    const lut = new GradeLut();
    const v = lut.blend({ daylight: NaN, sunY: NaN, warmth: NaN, rain: 0, storm: 0, sand: 0, snow: 0 });
    expect(Array.from(v).every((x) => Number.isFinite(x))).toBe(true);
  });
});
