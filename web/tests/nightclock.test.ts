import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The atmosphere's scene helpers need WebGL / the full scene: light stand-ins (only the clock is tested here).
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
    setKind() {}
    setIntensity() {}
    setWind() {}
    setLight() {}
    strike() {}
    update() {
      return 0;
    }
  },
}));

const { Atmosphere, ATMOS_DEFAULTS, MOON_RISE, MOON_SET, atmosConfig, formatClock, hourToU, simClockOf, CYCLE_TICKS, GAME_HOUR_TICKS } = await import('../src/render/atmos');
const { FogOfWar } = await import('../src/render/fog');
const { World } = await import('../src/sim/world');
const { NIGHT_FROM, NIGHT_TO, isNight, nightLevel, nightSight } = await import('../src/sim/clock');

const g = globalThis as unknown as { window?: unknown; location?: unknown; localStorage?: unknown };

function setUrl(search: string, saved: Record<string, unknown> = {}) {
  g.window ??= { addEventListener() {}, removeEventListener() {} };
  g.location = { search };
  const store = new Map<string, string>([['ironfront.settings.v1', JSON.stringify(saved)]]);
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
}

/** A battle as the Game builds it: the world's clock from the resolved atmosphere, then the renderer's sky. */
function battle(live: boolean) {
  const clock = simClockOf(atmosConfig(0, 'clear', live));
  const world = new World({ seed: 5, clock, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 1, isAI: true }] });
  ATMOS_DEFAULTS.live = live;
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
    finalPass: { uniforms: { exposure: { value: 1 }, saturation: { value: 1 }, shadowTint: { value: new THREE.Vector3() }, highTint: { value: new THREE.Vector3() }, vignette: { value: 0.3 } } },
    bloom: { strength: 0.4 },
    canvas: { style: { filter: '' } },
  };
  const atmos = new Atmosphere(host as never, 0);
  return { world, atmos, clock };
}

afterEach(() => {
  ATMOS_DEFAULTS.live = false;
  g.location = undefined;
  g.localStorage = undefined;
});

describe('night clock (sim/clock.ts)', () => {
  it('night falls at moon rise and ends at moon set, the hours the sky uses for night', () => {
    expect(hourToU(NIGHT_FROM)).toBeCloseTo(MOON_RISE, 6);
    expect(hourToU(NIGHT_TO)).toBeCloseTo(MOON_SET, 6);
    // full day / full night, a gradual hour around each switch-over
    for (const h of [6, 10, 12, 15, 18.5, 19.2]) expect(nightLevel(h)).toBe(0);
    for (const h of [20.3, 21, 23, 0, 2, 4.7]) expect(nightLevel(h)).toBe(1);
    expect(nightLevel(NIGHT_FROM)).toBeCloseTo(0.5, 6);
    expect(nightLevel(NIGHT_TO)).toBeCloseTo(0.5, 6);
    let prev = -1;
    for (let h = 19.2; h <= 20.3; h += 0.05) {
      const l = nightLevel(h);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
    expect(isNight(nightLevel(19.7))).toBe(false);
    expect(isNight(nightLevel(19.8))).toBe(true);
    expect(isNight(nightLevel(5.2))).toBe(true);
    expect(isNight(nightLevel(5.3))).toBe(false);
    // ordinary sight: half by night
    expect(nightSight(0)).toBe(1);
    expect(nightSight(1)).toBe(0.5);
    expect(nightLevel(NIGHT_FROM + 24 * 3)).toBeCloseTo(0.5, 6); // later days too
  });

  it('the sim clock matches the render clock (menu start times, ?clock=, fixed skies)', () => {
    const cases: { url: string; saved?: Record<string, unknown>; live: boolean; start: number; running: boolean }[] = [
      { url: '', live: true, start: 5.5, running: true }, // menu battle, default dawn start
      { url: '', saved: { tod: 'night' }, live: true, start: 21, running: true },
      { url: '', saved: { tod: 'dusk' }, live: true, start: 17.5, running: true },
      { url: '', saved: { tod: 'day' }, live: true, start: 10, running: true },
      { url: '?clock=23:30', live: true, start: 23.5, running: true },
      { url: '?clock=2', live: false, start: 2, running: true }, // ?clock implies the live day on test URLs too
      { url: '?tod=night', live: false, start: 23, running: false }, // fixed sky
      { url: '?tod=dusk', live: true, start: 19.25, running: false },
      { url: '', live: false, start: 15, running: false }, // test URL: the plain day
    ];
    for (const c of cases) {
      setUrl(c.url, c.saved);
      const { world, atmos, clock } = battle(c.live);
      expect(clock.start).toBeCloseTo(c.start, 9);
      expect(clock.live).toBe(c.running);
      for (const t of [0, 1, 777, GAME_HOUR_TICKS * 3 + 77, Math.floor(CYCLE_TICKS * 1.37)]) {
        world.tick = t;
        const sky = atmos.clock();
        expect(sky.text).toBe(formatClock(world.hours()));
        expect(sky.live).toBe(c.running);
      }
    }
  });

  it('the world follows its clock at the fog cadence: night rules from moon rise', () => {
    setUrl('?clock=19:00');
    const { world } = battle(true);
    expect(world.night).toBe(false);
    expect(world.fog).toBe('classic');
    // 19:00 + 50 game minutes = 19:50: past moon rise
    for (let i = 0; i < 50 * 20; i++) world.step();
    expect(world.hours()).toBeCloseTo(19 + 50 / 60, 6);
    expect(world.night).toBe(true);
    expect(world.fog).toBe('modern');
    expect(world.nightLevel).toBeCloseTo(nightLevel(world.hours()), 2);
  });
});
