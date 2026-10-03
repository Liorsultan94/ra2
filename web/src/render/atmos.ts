import * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { World } from '../sim/world';
import type { Effects } from './effects';
import { EnvDamage } from './envdamage';
import type { FogOfWar } from './fog';
import type { GroundMarks } from './marks';
import type { AnimState, Model } from './models';
import { GroundFog } from './groundfog';
import { NightLights, NightVisionPass } from './night';
import type { FinalPass } from './post';
import type { Sky, SkyState } from './sky';
import type { Terrain } from './terrain';
import { windTime } from './vegetation';
import { WeatherFx } from './weather';
import { WeatherCycle, type WxEventKind, type WxKind, type WxState } from './weathercycle';
import { WX, WXM } from './wxuniforms';
import { LivingWorld } from './fx/nature';
import { biomeLook, type BiomeLook } from './biome';
import { CITY_NIGHT } from './models/citybldgs';
import { TPS } from '../sim/types';

/*
 * Time of day, weather and night vision (all purely visual).
 *
 * Settings come from the URL (?tod=day|dusk|night|cycle|mist,
 * ?weather=clear|rain|snow|sandstorm|dynamic, ?nv=1) or, for a skirmish, from
 * the saved menu settings (`tod`, `weather`). Day + clear leaves the renderer
 * exactly as it is: no presets are applied and no extra objects are created.
 *
 * 'dynamic' weather follows a deterministic timeline (weathercycle.ts, seeded
 * from the world, driven by the sim tick): clouds gather, the wind picks up,
 * rain starts lightly, builds (sometimes to a thunderstorm), eases and stops,
 * the ground dries. Everything is faded by uniforms (no shader recompiles).
 * Ground fog (groundfog.ts + the height fog in the shared fog shader) rises at
 * dawn in the cycle, on the 'mist' time of day and after rain.
 *
 * The 'cycle' time of day is the live day: 1 real minute = 1 game hour at 1x
 * game speed, starting at 05:30 (the HUD clock reads `clock()`); hourToU maps
 * the clock onto the lighting stops. Battles started from the menu default to
 * it with dynamic weather (ATMOS_DEFAULTS).
 *
 * Debug / screenshots: ?clock=HH:MM starts the live day at that time,
 * ?todphase=<u> pins the cycle phase, ?wxt=<game seconds> pins the weather timeline,
 * ?wxseed=<n> picks the timeline, ?mist=<0..1> forces the ground fog
 * (also `wxTimeOverride`, `wxForce`, `mistOverride` on the instance).
 */

export type TimeOfDay = 'day' | 'dusk' | 'night' | 'cycle' | 'mist';
export type Weather = 'clear' | 'rain' | 'snow' | 'sandstorm' | 'dynamic';
type Q = 'low' | 'medium' | 'high';

export interface AtmosConfig {
  tod: TimeOfDay;
  weather: Weather;
  nv: boolean;
}

const TODS: TimeOfDay[] = ['day', 'dusk', 'night', 'cycle', 'mist'];
const WEATHERS: Weather[] = ['clear', 'rain', 'snow', 'sandstorm', 'dynamic'];

/**
 * Defaults when neither the URL nor the saved menu settings pick a time of day / weather.
 * `live` (set by the Game for battles started from the menu: skirmish and quick battle) makes the
 * live day (the 'cycle' clock, 1 real minute = 1 game hour) with the map climate's dynamic weather
 * the default; test / screenshot URLs (?play=, ?demo=) and the demo behind the menu keep the plain
 * day with the map's own weather.
 */
export const ATMOS_DEFAULTS = { live: false };

/**
 * Resolve the atmosphere: URL params win; skirmishes (viewer >= 0) fall back to the saved menu settings,
 * then to the defaults (ATMOS_DEFAULTS) and the map's own weather (`mapWeather`: snow on the winter map, ...).
 * The saved weather 'map' means the map's own fixed weather.
 */
export function atmosConfig(viewer: number, mapWeather: Weather = 'clear', live = ATMOS_DEFAULTS.live): AtmosConfig {
  const def = live && viewer >= 0;
  const cfg: AtmosConfig = { tod: def ? 'cycle' : 'day', weather: def ? 'dynamic' : mapWeather, nv: false };
  let saved: { tod?: string; weather?: string } = {};
  if (viewer >= 0) {
    try {
      saved = JSON.parse(localStorage.getItem('ironfront.settings.v1') ?? '{}') ?? {};
    } catch {
      saved = {};
    }
  }
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const tod = params.get('tod') ?? saved.tod;
  const wx = params.get('weather') ?? saved.weather;
  if (TODS.includes(tod as TimeOfDay)) cfg.tod = tod as TimeOfDay;
  if (WEATHERS.includes(wx as Weather)) cfg.weather = wx as Weather;
  else if (wx === 'map') cfg.weather = mapWeather;
  cfg.nv = params.get('nv') === '1';
  return cfg;
}

/** The renderer's view of an entity visual (subset of GameRenderer's private Visual). */
export interface VisualLike {
  id: number;
  def: string;
  model: Model;
  visible: boolean;
  speed: number;
  anim: AnimState;
}

/** Anything with a re-iterable `values()` (the renderer's visual map). */
export interface VisualSource {
  values(): Iterable<VisualLike>;
}

export interface AtmosHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fog: FogOfWar;
  terrain: Terrain;
  effects: Effects;
  marks: GroundMarks;
  world: World;
  quality: Q;
  composer: EffectComposer | null;
  finalPass: FinalPass | null;
  bloom: UnrealBloomPass | null;
  canvas: HTMLCanvasElement;
}

interface Preset {
  sunC: THREE.Color;
  sunI: number;
  sky: THREE.Color;
  gnd: THREE.Color;
  hemiI: number;
  env: number;
  haze: THREE.Color;
  hazeP: THREE.Vector4;
  cloud: number;
  sat: number;
  shadowTint: THREE.Vector3;
  highTint: THREE.Vector3;
  vignette: number;
  bloom: number;
  exposure: number;
  bg: THREE.Color;
  water: THREE.Vector3;
  spec: number;
  /** 0 = full daylight .. 1 = dark night: drives building lights / headlights. */
  dark: number;
}

const C = (h: number) => new THREE.Color(h);

/** The battle's biome look (set by the Atmosphere; every preset passes through its grade). */
let BIOME: BiomeLook | null = null;

/** Climate grade of a time-of-day preset (in place): haze, sky / ground light, sun tint, saturation. */
function applyBiome(p: Preset, light: number) {
  const a = BIOME?.atmos;
  if (!a) return;
  if (a.haze) {
    p.haze.lerp(new THREE.Color(a.haze[0], a.haze[1], a.haze[2]).multiplyScalar(Math.max(0.1, light)), 0.7);
    p.bg.lerp(new THREE.Color(a.haze[0], a.haze[1], a.haze[2]).multiplyScalar(0.35 * Math.max(0.1, light)), 0.5);
  }
  p.hazeP.y *= a.hazeK;
  p.hazeP.z = Math.min(0.62, p.hazeP.z / a.hazeK);
  if (a.sky !== null) p.sky.lerp(C(a.sky), 0.5 * light);
  if (a.gnd !== null) p.gnd.lerp(C(a.gnd), 0.6 * Math.max(0.3, light));
  if (a.sun !== null) p.sunC.lerp(C(a.sun), 0.45 * light);
  p.sunI *= 1 + (a.sunK - 1) * light;
  p.sat *= a.sat;
  if (a.highTint) p.highTint.lerp(new THREE.Vector3(...a.highTint), 0.6 * light);
  // snow fields bounce a lot of light back up
  if (BIOME?.biome === 'winter') p.hemiI *= 1 + 0.15 * light;
}

/** Lighting keys: the three static times of day plus the extra stops of the dynamic cycle. */
type Key = TimeOfDay | 'noon' | 'golden' | 'sunset' | 'twilight' | 'predawn' | 'dawn' | 'morning';

/** Base (clear weather) preset of a time-of-day key; `light` = overall daylight 0..1 (weather haze scaling). */
function todPreset(key: Key): { p: Preset; light: number } {
  const p: Preset = {
    sunC: C(0xffc68c),
    sunI: 3.2,
    sky: C(0x9fbcea),
    gnd: C(0x6a5232),
    hemiI: 0.8,
    env: 0.42,
    haze: new THREE.Color(0.3, 0.29, 0.27),
    hazeP: new THREE.Vector4(4, 80, 0.38, 52),
    cloud: 0.32,
    sat: 1.06,
    shadowTint: new THREE.Vector3(-0.012, 0.0, 0.022),
    highTint: new THREE.Vector3(0.03, 0.012, -0.03),
    vignette: 0.3,
    bloom: 0.42,
    exposure: 1.2,
    bg: C(0x2a2824),
    water: new THREE.Vector3(1, 1, 1),
    spec: 1,
    dark: 0,
  };
  let light = 1;
  const set = (o: Partial<Record<'sunI' | 'hemiI' | 'env' | 'cloud' | 'sat' | 'vignette' | 'bloom' | 'exposure' | 'spec' | 'dark', number>>, sunC: number, sky: number, gnd: number, haze: [number, number, number], shadow: [number, number, number], high: [number, number, number], bg: number, water: [number, number, number]) => {
    Object.assign(p, o);
    p.sunC.set(sunC);
    p.sky.set(sky);
    p.gnd.set(gnd);
    p.haze.setRGB(...haze);
    p.shadowTint.set(...shadow);
    p.highTint.set(...high);
    p.bg.set(bg);
    p.water.set(...water);
  };
  switch (key) {
    case 'day':
      break;
    case 'dusk':
      set({ sunI: 2.3, hemiI: 0.55, env: 0.24, cloud: 0.22, sat: 1.12, vignette: 0.38, bloom: 0.55, exposure: 1.15, spec: 0.9, dark: 0.55 }, 0xff8a4c, 0x7a84b8, 0x4a3424, [0.3, 0.19, 0.16], [-0.012, 0.0, 0.04], [0.06, 0.015, -0.05], 0x1c1418, [0.72, 0.6, 0.62]);
      light = 0.6;
      break;
    case 'night':
      set({ sunI: 1.0, hemiI: 0.62, env: 0.08, cloud: 0.1, sat: 0.8, vignette: 0.5, bloom: 0.8, exposure: 1.25, spec: 0.35, dark: 1 }, 0x8ea8ff, 0x3a5296, 0x0e1118, [0.022, 0.03, 0.055], [-0.008, 0.0, 0.03], [0.0, 0.004, 0.012], 0x04060a, [0.2, 0.25, 0.38]);
      light = 0.12;
      break;
    // ---- extra stops of the dynamic cycle
    case 'noon':
      set({ sunI: 3.3, hemiI: 0.85, env: 0.45, cloud: 0.34, sat: 1.04, vignette: 0.28, bloom: 0.38, exposure: 1.13, spec: 1, dark: 0 }, 0xfff0dc, 0xa6c4f0, 0x6a5434, [0.3, 0.31, 0.32], [-0.012, 0.0, 0.024], [0.015, 0.008, -0.015], 0x2a2824, [1, 1, 1]);
      break;
    case 'golden':
      set({ sunI: 3.0, hemiI: 0.68, env: 0.34, cloud: 0.28, sat: 1.14, vignette: 0.33, bloom: 0.5, exposure: 1.2, spec: 1, dark: 0.1 }, 0xffa458, 0x8c9cd0, 0x5a4028, [0.34, 0.25, 0.19], [-0.014, 0.0, 0.032], [0.06, 0.02, -0.05], 0x241a16, [0.9, 0.78, 0.7]);
      light = 0.85;
      break;
    case 'sunset':
      set({ sunI: 2.5, hemiI: 0.6, env: 0.27, cloud: 0.22, sat: 1.08, vignette: 0.38, bloom: 0.56, exposure: 1.17, spec: 0.95, dark: 0.38 }, 0xff9858, 0x7c86b8, 0x4a3628, [0.31, 0.21, 0.18], [-0.012, 0.0, 0.045], [0.05, 0.012, -0.045], 0x1e1418, [0.78, 0.62, 0.62]);
      light = 0.65;
      break;
    case 'twilight':
      set({ sunI: 0.62, hemiI: 0.68, env: 0.14, cloud: 0.14, sat: 0.9, vignette: 0.46, bloom: 0.72, exposure: 1.25, spec: 0.55, dark: 0.88 }, 0xa080b0, 0x5462a0, 0x1c1820, [0.1, 0.08, 0.12], [-0.01, 0.0, 0.036], [0.02, 0.004, 0.0], 0x0e0c14, [0.4, 0.38, 0.5]);
      light = 0.28;
      break;
    case 'predawn':
      set({ sunI: 0.65, hemiI: 0.68, env: 0.13, cloud: 0.12, sat: 0.88, vignette: 0.46, bloom: 0.72, exposure: 1.25, spec: 0.5, dark: 0.88 }, 0x9aa0d8, 0x4e5ea2, 0x161a24, [0.07, 0.08, 0.12], [-0.01, 0.0, 0.034], [0.006, 0.006, 0.01], 0x0a0c14, [0.34, 0.36, 0.5]);
      light = 0.28;
      break;
    case 'dawn':
      set({ sunI: 2.5, hemiI: 0.6, env: 0.26, cloud: 0.2, sat: 1.12, vignette: 0.38, bloom: 0.55, exposure: 1.17, spec: 0.9, dark: 0.42 }, 0xff9468, 0x8a90c4, 0x4a3a34, [0.34, 0.24, 0.26], [-0.012, 0.0, 0.045], [0.07, 0.02, -0.03], 0x1c1820, [0.8, 0.68, 0.72]);
      p.hazeP.set(3, 70, 0.45, 50); // morning mist
      light = 0.6;
      break;
    case 'morning':
      set({ sunI: 3.0, hemiI: 0.78, env: 0.4, cloud: 0.3, sat: 1.04, vignette: 0.3, bloom: 0.42, exposure: 1.18, spec: 1, dark: 0.04 }, 0xffdcb0, 0x9ab8e6, 0x64503a, [0.3, 0.3, 0.31], [-0.012, 0.0, 0.024], [0.025, 0.01, -0.02], 0x2a2826, [0.95, 0.95, 1]);
      p.hazeP.set(4, 80, 0.4, 52);
      light = 0.95;
      break;
    case 'mist':
      // misty morning: a low, soft, warm sun through damp air (the ground fog itself is separate)
      set({ sunI: 2.7, hemiI: 0.8, env: 0.34, cloud: 0.14, sat: 0.97, vignette: 0.34, bloom: 0.56, exposure: 1.2, spec: 0.9, dark: 0.1 }, 0xffc8a0, 0x9eaacc, 0x5a4c40, [0.4, 0.4, 0.43], [-0.012, 0.0, 0.034], [0.05, 0.02, -0.02], 0x26262a, [0.85, 0.84, 0.9]);
      p.hazeP.set(2, 62, 0.5, 50);
      light = 0.8;
      break;
  }
  applyBiome(p, light);
  return { p, light };
}

/** Weather on top of a time-of-day preset (in place). */
function applyWeather(p: Preset, weather: Weather, light: number) {
  const mixC = (c: THREE.Color, h: number, k: number) => c.lerp(C(h), k);
  if (weather === 'rain') {
    p.sunI *= 0.32;
    mixC(p.sunC, 0xc4ccd8, 0.6);
    mixC(p.sky, 0x8592a6, 0.6);
    p.env *= 0.8;
    p.haze.setRGB(0.2, 0.22, 0.25).multiplyScalar(Math.max(0.15, light));
    p.hazeP.set(2, 50, 0.55, 48);
    p.cloud = 0;
    p.sat *= 0.82;
    p.water.multiplyScalar(0.8);
    p.dark = Math.min(1, p.dark + 0.3);
  } else if (weather === 'snow') {
    p.sunI *= 0.55;
    mixC(p.sunC, 0xe2eaff, 0.6);
    mixC(p.gnd, 0xb0b8c8, light < 0.3 ? 0.25 : 0.7);
    p.hemiI *= 1.05;
    p.haze.setRGB(0.6, 0.64, 0.7).multiplyScalar(Math.max(0.12, light));
    p.hazeP.set(2, 55, 0.5, 48);
    p.cloud = 0.08;
    p.sat *= 0.85;
    p.shadowTint.set(-0.016, 0.0, 0.036);
    p.highTint.set(-0.012, 0.0, 0.02);
    p.water.multiplyScalar(0.9);
    p.dark = Math.min(1, p.dark + 0.15);
  } else if (weather === 'sandstorm') {
    p.sunI *= 0.42;
    mixC(p.sunC, 0xffa860, 0.6);
    mixC(p.sky, 0xc49a64, 0.7);
    mixC(p.gnd, 0x7a5530, 0.6);
    p.haze.setRGB(0.58, 0.4, 0.22).multiplyScalar(Math.max(0.12, light));
    p.hazeP.set(0, 30, 0.8, 40);
    p.cloud = 0;
    p.sat *= 0.9;
    p.highTint.set(0.05, 0.02, -0.04);
    p.water.multiplyScalar(0.85);
    p.dark = Math.min(1, p.dark + 0.3);
  }
}

function buildPreset(cfg: AtmosConfig): Preset {
  const { p, light } = todPreset(cfg.tod === 'cycle' ? 'day' : cfg.tod);
  applyWeather(p, cfg.weather, light);
  return p;
}

function lerpPreset(out: Preset, a: Preset, b: Preset, k: number) {
  out.sunC.copy(a.sunC).lerp(b.sunC, k);
  out.sky.copy(a.sky).lerp(b.sky, k);
  out.gnd.copy(a.gnd).lerp(b.gnd, k);
  out.haze.copy(a.haze).lerp(b.haze, k);
  out.bg.copy(a.bg).lerp(b.bg, k);
  out.hazeP.copy(a.hazeP).lerp(b.hazeP, k);
  out.shadowTint.copy(a.shadowTint).lerp(b.shadowTint, k);
  out.highTint.copy(a.highTint).lerp(b.highTint, k);
  out.water.copy(a.water).lerp(b.water, k);
  const n = (x: number, y: number) => x + (y - x) * k;
  out.sunI = n(a.sunI, b.sunI);
  out.hemiI = n(a.hemiI, b.hemiI);
  out.env = n(a.env, b.env);
  out.cloud = n(a.cloud, b.cloud);
  out.sat = n(a.sat, b.sat);
  out.vignette = n(a.vignette, b.vignette);
  out.bloom = n(a.bloom, b.bloom);
  out.exposure = n(a.exposure, b.exposure);
  out.spec = n(a.spec, b.spec);
  out.dark = n(a.dark, b.dark);
}

// ------------------------------------------------------------ dynamic day / night cycle

/**
 * The live day: one game hour = one real minute at 1x game speed, so a full day is 24 real minutes.
 * Driven by the sim tick: it follows the game speed and pause and is the same for every player.
 */
export const GAME_HOUR_TICKS = TPS * 60;
/** One full day of the cycle. */
export const CYCLE_TICKS = GAME_HOUR_TICKS * 24;
/** The live day starts just before sunrise (?clock=HH:MM overrides it for debugging / screenshots). */
export const START_HOUR = 5.5;

/**
 * Lighting stops of the cycle. u = fraction of the day starting at midday. Sun / moon paths are in degrees:
 * elevation and azimuth (0 = +x, 90 = +z) in the classic view frame; the late-afternoon 'day' stop sits
 * exactly on the static day sun so the cycle passes through the familiar look.
 */
const CYCLE_KEYS: { u: number; key: Key }[] = [
  { u: 0.0, key: 'noon' },
  { u: 0.2, key: 'day' },
  { u: 0.31, key: 'golden' },
  { u: 0.375, key: 'sunset' },
  { u: 0.425, key: 'dusk' },
  { u: 0.46, key: 'twilight' },
  { u: 0.51, key: 'night' },
  { u: 0.72, key: 'night' },
  { u: 0.77, key: 'predawn' },
  { u: 0.81, key: 'dawn' },
  { u: 0.88, key: 'morning' },
  { u: 1.0, key: 'noon' },
];

/**
 * Clock hour -> cycle phase u. Each lighting stop of CYCLE_KEYS (and the sun / moon paths) sits at the
 * hour it shows, so the clock reads true while the tuned look stays as it was: noon 12:00, the static
 * 'day' sun 15:00, golden hour 17:30, sunset 18:30, dusk 19:15, twilight 19:45, night 21:00 .. 04:30,
 * predawn 05:15, dawn 06:00, morning 08:00. Hours run noon .. next noon (12 .. 36); linear in between,
 * so the game clock advances evenly and the night (21:00 .. 04:30) lasts 7.5 real minutes.
 */
export const HOUR_U: readonly (readonly [number, number])[] = [
  [12, 0],
  [15, 0.2],
  [17.5, 0.31],
  [18.5, 0.375],
  [19.25, 0.425],
  [19.75, 0.46],
  [21, 0.51],
  [28.5, 0.72],
  [29.25, 0.77],
  [30, 0.81],
  [32, 0.88],
  [36, 1],
];

/** Cycle phase u (0 = midday) of a clock hour (any number of hours; wraps every 24). */
export function hourToU(hours: number): number {
  let x = ((hours % 24) + 24) % 24;
  if (x < 12) x += 24;
  let i = 1;
  while (i < HOUR_U.length - 1 && x > HOUR_U[i][0]) i++;
  const [h0, u0] = HOUR_U[i - 1];
  const [h1, u1] = HOUR_U[i];
  return u0 + ((u1 - u0) * (x - h0)) / (h1 - h0);
}

/** Clock hour (0 .. 24) of a cycle phase u (the inverse of hourToU; photo mode's time slider). */
export function uToHour(u: number): number {
  const x = ((u % 1) + 1) % 1;
  let i = 1;
  while (i < HOUR_U.length - 1 && x > HOUR_U[i][1]) i++;
  const [h0, u0] = HOUR_U[i - 1];
  const [h1, u1] = HOUR_U[i];
  return (h0 + ((h1 - h0) * (x - u0)) / (u1 - u0)) % 24;
}

/** Hours since midnight of day 1 at a sim tick (the live day starts at `start`). */
export function clockHours(tick: number, start = START_HOUR): number {
  return start + tick / GAME_HOUR_TICKS;
}

/** "HH:MM" of a clock hour (wraps every 24 hours; minutes are floored). */
export function formatClock(hours: number): string {
  const m = Math.floor((((hours % 24) + 24) % 24) * 60 + 1e-6) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Sky icon of the HUD clock. */
export type ClockIcon = 'sunrise' | 'sun' | 'sunset' | 'moon';
/** Weather icon of the HUD clock. */
export type WxIcon = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'dust';

/** Sunrise 05:00 .. 07:00, sun until 17:30, sunset until the twilight at 19:45, then the moon. */
export function clockIcon(hours: number): ClockIcon {
  const x = ((hours % 24) + 24) % 24;
  if (x >= 5 && x < 7) return 'sunrise';
  if (x >= 7 && x < 17.5) return 'sun';
  if (x >= 17.5 && x < 19.75) return 'sunset';
  return 'moon';
}

/** The clock of the fixed times of day (the hour each preset shows: 'day' is the 15:00 sun of the cycle). */
export const FIXED_HOUR: Record<Exclude<TimeOfDay, 'cycle'>, number> = { day: 15, dusk: 19.25, night: 23, mist: 7.25 };

/** What the HUD clock shows. */
export interface ClockState {
  /** Clock hour 0..23 and minute 0..59. */
  hours: number;
  minutes: number;
  /** Day of the battle (1 = the first; only the live day moves on). */
  day: number;
  icon: ClockIcon;
  weather: WxIcon;
  /** The live day (the clock runs); false = a fixed time of day. */
  live: boolean;
  /** "HH:MM". */
  text: string;
}

/** The key light hands over from the sun to the moon (and back) at these points, while it is dim. */
const MOON_RISE = 0.46;
const MOON_SET = 0.77;
const SUN_DIR_DAY = new THREE.Vector3(-0.985, 0.8, 0.2).normalize();
const DAY_ELEV = THREE.MathUtils.radToDeg(Math.asin(SUN_DIR_DAY.y));
const DAY_AZ = THREE.MathUtils.radToDeg(Math.atan2(SUN_DIR_DAY.z, SUN_DIR_DAY.x));
/** Sun path stops [u, elevation, azimuth]: rises far right, passes behind the battlefield, sets far left. */
const SUN_PATH: [number, number, number][] = [
  [MOON_SET - 1, 7, 292],
  [0.81 - 1, 12, 284],
  [0.88 - 1, 30, 262],
  [0.0, 58, 222],
  [0.2, DAY_ELEV, DAY_AZ],
  [0.31, 22, 158],
  [0.375, 13, 150],
  [0.425, 9, 146],
  [MOON_RISE, 7, 143],
];
/** Moon path over the night. */
const MOON_PATH: [number, number, number][] = [
  [MOON_RISE, 18, 268],
  [0.52, 32, 248],
  [0.62, 46, 214],
  [0.72, 34, 186],
  [MOON_SET, 20, 172],
];

function pathAt(path: [number, number, number][], u: number, out: THREE.Vector3) {
  let i = 0;
  while (i < path.length - 2 && u > path[i + 1][0]) i++;
  const [u0, e0, a0] = path[i];
  const [u1, e1, a1] = path[i + 1];
  const k = Math.max(0, Math.min(1, (u - u0) / Math.max(1e-6, u1 - u0)));
  const s = k * k * (3 - 2 * k);
  const el = THREE.MathUtils.degToRad(e0 + (e1 - e0) * s);
  const az = THREE.MathUtils.degToRad(a0 + (a1 - a0) * s);
  return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
}

function clonePreset(p: Preset): Preset {
  return { ...p, sunC: p.sunC.clone(), sky: p.sky.clone(), gnd: p.gnd.clone(), haze: p.haze.clone(), hazeP: p.hazeP.clone(), shadowTint: p.shadowTint.clone(), highTint: p.highTint.clone(), bg: p.bg.clone(), water: p.water.clone() };
}

const FALLS: WxKind[] = ['rain', 'snow', 'sandstorm'];

/** The time-of-day key under each kind of weather (dynamic weather blends towards these by cloud cover). */
function altPresets(key: Key): Record<WxKind, Preset> {
  const o = {} as Record<WxKind, Preset>;
  for (const k of FALLS) {
    const t = todPreset(key);
    applyWeather(t.p, k, t.light);
    o[k] = t.p;
  }
  return o;
}

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Ground fog over the cycle phase (0 = midday): a little in the small hours, thick at dawn, burnt off by mid-morning. */
function dawnMist(u: number) {
  return Math.min(1, 0.22 * sstep(0.55, 0.7, u) * (1 - sstep(0.8, 0.84, u)) + sstep(0.72, 0.8, u) * (1 - sstep(0.85, 0.93, u)));
}

/** 'Misty morning': thick for the first minutes of the battle, then the sun thins it to a light valley mist. */
function morningMist(t: number) {
  return 0.9 - 0.5 * sstep(200, 620, t);
}

/** Calm-weather breeze (world x / z direction, matches the effects' default drift). */
const BREEZE_DIR = -0.55;

export class Atmosphere {
  readonly cfg: AtmosConfig;
  /** The map's climate look (render/biome.ts). */
  readonly look: BiomeLook;
  /** Day + clear + no night vision: nothing to do (photo mode may switch it on for a time-of-day preview). */
  active: boolean;
  /** Thunder hook (delay already elapsed), volume 0..1. Defaults to the game's large-explosion sound. */
  onThunder: ((volume: number) => void) | null = null;
  readonly weather: WeatherFx | null = null;
  readonly night: NightLights | null = null;
  readonly env: EnvDamage;
  /** Living nature, the night life and the victory fireworks (render/fx/nature.ts). */
  readonly living: LivingWorld;
  /** Drifting fog banks over the low ground (mist time of day, dawn in the cycle, dynamic weather). */
  readonly groundFog: GroundFog | null = null;
  /** Dynamic weather timeline (weather = 'dynamic'). */
  readonly wxCycle: WeatherCycle | null = null;
  /** Dynamic weather state of this frame. */
  wx: WxState | null = null;
  /** Debug / screenshots: evaluate the weather timeline at this game time (seconds) instead of the sim tick. */
  wxTimeOverride: number | null = null;
  /** Debug / screenshots: force parts of the dynamic weather state (e.g. { precip: 1, storm: 1 }). */
  wxForce: Partial<WxState> | null = null;
  /** Debug / screenshots: force the ground fog amount 0..1. */
  mistOverride: number | null = null;
  /** Ground fog amount of this frame, 0..1. */
  mist = 0;
  private preset: Preset | null = null;
  private nvPass: NightVisionPass | null = null;
  private nv = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private thunderAt: number[] = [];
  private thunderVol: number[] = [];
  private time = 0;
  /** Dynamic cycle: lighting stops (weather applied) and the blended preset of this frame. */
  private keys: { u: number; p: Preset; light: number; alt?: Record<WxKind, Preset> }[] | null = null;
  private light = 1;
  /** Fixed time of day: its daylight level and clear preset (dynamic weather starts from it every frame). */
  private baseLight = 1;
  private base: Preset | null = null;
  /** Dynamic weather: the fixed time of day under each weather, and this frame's blend target. */
  private alt: Record<WxKind, Preset> | null = null;
  private altP: Preset | null = null;
  /** Presets are re-applied every frame (cycle, dynamic weather, ground fog). */
  private perFrame = false;
  private lastSec = -1;
  private said = '';
  private unhookWind: (() => void) | null = null;
  /** Wind of this frame (0..1 strength, world x / z unit direction) for particles, smoke, foliage and mist. */
  private windK = 0.2;
  private windX = Math.cos(BREEZE_DIR);
  private windZ = Math.sin(BREEZE_DIR);
  private swayExtra = 0;
  /** Direction towards the key light (sun or moon) in the classic view frame; null = the renderer's fixed sun. */
  sunBase: THREE.Vector3 | null = null;
  /** Debug / screenshots: force the cycle to this phase (0 = midday, 0.5 = night). */
  phaseOverride: number | null = null;
  /** Current phase of the cycle (0..1, 0 = midday), -1 when the time of day is fixed. */
  phase = -1;
  /** Clock hour at the start of the battle (the live day; ?clock=HH:MM overrides it). */
  startHour = START_HOUR;
  private keyI = 1;

  constructor(
    private host: AtmosHost,
    private viewer: number,
  ) {
    const look = (this.look = biomeLook(host.world.map));
    BIOME = look.biome === 'temperate' ? null : look;
    const cfg = (this.cfg = atmosConfig(viewer, look.weather));
    const dynamic = cfg.weather === 'dynamic';
    // the other climates always grade the light (Frontline Crossing on a clear day stays untouched)
    this.active = cfg.tod !== 'day' || cfg.weather !== 'clear' || cfg.nv || look.biome !== 'temperate';
    WX.wxWet.value = cfg.weather === 'rain' ? 1 : 0;
    WX.wxRain.value = cfg.weather === 'rain' ? 1 : 0;
    WX.wxSnow.value = Math.max(look.snowFloor, cfg.weather === 'snow' ? 1 : 0);
    WX.wxDust.value = cfg.weather === 'sandstorm' ? 1 : 0;
    // the winter map's snow has lain for weeks: no patchy first minutes
    if (look.snowFloor > 0) WX.wxSnowThin.value = 0;
    CITY_NIGHT.value = 0;
    WXM.mistAmount.value = 0;
    // environment destruction is always on (it only reacts to events)
    this.env = new EnvDamage(host.terrain, host.world.map, host.fog, host.effects, host.quality);
    host.scene.add(this.env.group);
    this.living = new LivingWorld(this, host);
    // night vision is available everywhere (key N), the pass is only built on demand
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'n' || e.key === 'N') this.setNightVision(!this.nv);
    };
    window.addEventListener('keydown', this.keyHandler);
    if (cfg.nv) this.setNightVision(true);
    if (!this.active) return;
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const num = (k: string) => {
      const v = params.get(k);
      return v !== null && v !== '' && Number.isFinite(+v) ? +v : null;
    };
    if (dynamic) {
      // the same timeline for every player: seeded from the match (the sim's PRNG state at the start)
      const rs = (host.world as unknown as { rng?: { s?: number } }).rng?.s ?? 0;
      let seed = (rs ^ 0x9e3779b9) >>> 0;
      for (const ch of host.world.map.name) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
      seed = num('wxseed') ?? seed;
      // the map's climate picks the mix of fronts (desert dust, winter snow; weathercycle.ts)
      this.wxCycle = new WeatherCycle(seed, { climate: look.biome, cold: cfg.tod === 'night' || look.biome === 'winter' });
      this.wxTimeOverride = num('wxt');
      this.wx = this.wxCycle.at(this.wxTimeOverride ?? host.world.tick / TPS);
    }
    this.mistOverride = num('mist');
    const fixedKey: Key = cfg.tod === 'cycle' ? 'day' : cfg.tod;
    const p = (this.preset = buildPreset(dynamic ? { ...cfg, weather: 'clear' } : cfg));
    this.baseLight = todPreset(fixedKey).light;
    if (dynamic) {
      this.base = clonePreset(p);
      this.alt = altPresets(fixedKey);
      this.altP = clonePreset(this.alt.rain);
    }
    if (cfg.tod === 'cycle') {
      this.keys = this.buildKeys();
      this.sunBase = new THREE.Vector3();
      const q = params.get('todphase');
      if (q !== null && Number.isFinite(+q)) this.phaseOverride = +q;
      const ck = /^(\d{1,2})(?::(\d{2}))?$/.exec(params.get('clock') ?? '');
      if (ck) this.startHour = (+ck[1] % 24) + Math.min(59, +(ck[2] ?? 0)) / 60;
      this.blendCycle(host.world.tick);
    } else if (cfg.tod === 'mist') this.mistSun();
    this.applyPreset(p);
    const fxTod = cfg.tod === 'cycle' || cfg.tod === 'mist' ? 'day' : cfg.tod;
    if (dynamic) {
      this.weather = new WeatherFx('rain', host.quality, fxTod, true);
      host.scene.add(this.weather.mesh);
    } else if (cfg.weather !== 'clear' && cfg.weather !== 'dynamic') {
      this.weather = new WeatherFx(cfg.weather, host.quality, fxTod);
      host.scene.add(this.weather.mesh);
    }
    if (dynamic || cfg.tod === 'mist' || cfg.tod === 'cycle') {
      this.groundFog = new GroundFog(host.world.map, host.fog, host.quality, this.wxCycle ? this.wxCycle.events.length + host.world.map.w * 131 : 7);
      host.scene.add(this.groundFog.mesh);
    }
    this.perFrame = !!this.keys || dynamic || !!this.groundFog;
    if (dynamic) this.hookWind();
    // the cycle keeps its night-light pools for the whole battle (fixed light count: no shader recompiles);
    // dynamic weather creates them when a storm could make the scene dark enough
    const darkest = dynamic && this.alt ? Math.max(p.dark, this.alt.rain.dark + 0.15) : p.dark;
    if (darkest > 0.3 || this.keys) {
      this.night = new NightLights(host.scene, host.quality, p.dark);
    }
  }

  /** Lighting stops of the cycle (with their weather variants under dynamic weather). */
  private buildKeys() {
    const dynamic = !!this.wxCycle;
    return CYCLE_KEYS.map(({ u, key }) => {
      const t = todPreset(key);
      applyWeather(t.p, dynamic ? 'clear' : this.cfg.weather, t.light);
      return { u, p: t.p, light: t.light, alt: dynamic ? altPresets(key) : undefined };
    });
  }

  /** 'Misty morning': a fixed low morning sun. */
  private mistSun() {
    const dir = (this.sunBase = pathAt(SUN_PATH, 0.855 - 1, new THREE.Vector3()));
    const comp = Math.min(1.5, Math.sqrt(Math.sin(THREE.MathUtils.degToRad(DAY_ELEV)) / Math.max(0.05, dir.y)));
    if (this.preset) this.preset.sunI *= comp;
    if (this.base) this.base.sunI *= comp;
    if (this.alt) for (const k of FALLS) this.alt[k].sunI *= comp;
  }

  /**
   * Smoke drift and foliage sway follow the weather's wind. Both are owned elsewhere and
   * rewritten every frame (Effects.update sets `effects.wind`, Terrain.update sets the
   * foliage clock), so their values are wrapped in accessors that add the weather on read.
   */
  private hookWind() {
    const w = this.host.effects.wind as { x: number; z: number };
    const raw = { x: w.x, z: w.z };
    const self = this;
    const mixed = (axis: 'x' | 'z') => {
      // calm: the effects' own slowly veering breeze; a front takes over with its own, stronger wind
      const m = sstep(0.25, 0.6, self.windK);
      const dir = axis === 'x' ? self.windX : self.windZ;
      return raw[axis] * (1 - m) + dir * (0.25 + 0.75 * self.windK) * m;
    };
    for (const axis of ['x', 'z'] as const) {
      Object.defineProperty(w, axis, {
        configurable: true,
        enumerable: true,
        get: () => mixed(axis),
        set: (v: number) => {
          raw[axis] = v;
        },
      });
    }
    let clock = windTime.value;
    Object.defineProperty(windTime, 'value', {
      configurable: true,
      enumerable: true,
      get: () => clock + self.swayExtra,
      set: (v: number) => {
        clock = v;
      },
    });
    this.unhookWind = () => {
      for (const axis of ['x', 'z'] as const) Object.defineProperty(w, axis, { value: raw[axis], writable: true, configurable: true, enumerable: true });
      Object.defineProperty(windTime, 'value', { value: clock, writable: true, configurable: true, enumerable: true });
    };
  }

  /** Dynamic cycle: blend the lighting stops and move the sun / moon for this sim tick. */
  private blendCycle(tick: number) {
    const keys = this.keys!;
    const u = this.phaseOverride !== null ? ((this.phaseOverride % 1) + 1) % 1 : hourToU(clockHours(tick, this.startHour));
    this.phase = u;
    let i = Math.min(Math.max(1, this.keyI), keys.length - 1);
    if (u < keys[i - 1].u || u > keys[i].u) {
      i = 1;
      while (i < keys.length - 1 && u > keys[i].u) i++;
    }
    this.keyI = i;
    const a = keys[i - 1];
    const b = keys[i];
    const k = Math.max(0, Math.min(1, (u - a.u) / Math.max(1e-6, b.u - a.u)));
    const ks = k * k * (3 - 2 * k);
    lerpPreset(this.preset!, a.p, b.p, ks);
    const fall = this.wx?.fall ?? 'rain';
    if (this.altP && a.alt && b.alt) lerpPreset(this.altP, a.alt[fall], b.alt[fall], ks);
    this.light = a.light + (b.light - a.light) * ks;
    // key light: the sun by day, the moon by night; they hand over while the light is dim
    const dir = this.sunBase!;
    const moon = u > MOON_RISE && u < MOON_SET;
    if (moon) pathAt(MOON_PATH, u, dir);
    else pathAt(SUN_PATH, u > MOON_SET ? u - 1 : u, dir);
    // a low sun grazes the ground: give it back part of the lost irradiance so the map doesn't go dark too early
    const comp = Math.max(1, moon ? Math.min(Math.min(1.8, Math.sqrt(Math.sin(THREE.MathUtils.degToRad(DAY_ELEV)) / Math.max(0.05, dir.y))), 1.3) : Math.min(1.8, Math.sqrt(Math.sin(THREE.MathUtils.degToRad(DAY_ELEV)) / Math.max(0.05, dir.y))));
    this.preset!.sunI *= comp;
    if (this.altP && a.alt) this.altP.sunI *= comp;
  }

  /** Dynamic weather on top of this frame's clear preset: cloud cover, storm darkness. */
  private applyDynamic(p: Preset, st: WxState) {
    const a = this.altP!;
    const c = st.cover;
    const k = Math.max(c, st.precip);
    const cloud0 = p.cloud;
    lerpPreset(p, p, a, k);
    // broken cloud while it clouds over / clears: more drifting cloud shadows, then flat overcast light
    p.cloud = cloud0 * (1 - k) + a.cloud * k + 1.3 * c * (1 - c);
    const s = st.storm;
    if (s > 0) {
      p.sunI *= 1 - 0.45 * s;
      p.hemiI *= 1 - 0.2 * s;
      p.env *= 1 - 0.3 * s;
      p.dark = Math.min(1, p.dark + 0.15 * s);
      p.bg.multiplyScalar(1 - 0.35 * s);
      p.haze.multiplyScalar(1 - 0.3 * s);
      p.vignette += 0.06 * s;
    }
  }

  private mistC = new THREE.Color();
  /** Ground fog: the shared height fog, a damper haze and the lit colour of the mist. */
  private applyMist(p: Preset, mist: number, light: number, cover: number) {
    const mc = WXM.mistColor.value;
    const lk = 0.16 + 0.84 * light;
    mc.setRGB(0.4, 0.42, 0.46).multiplyScalar(lk * (1 - 0.3 * cover));
    mc.lerp(this.mistC.copy(p.sunC).multiplyScalar(0.62 * lk), 0.2 * (1 - cover));
    WXM.mistAmount.value = mist;
    if (mist <= 0.001) return;
    p.haze.lerp(mc, 0.3 * mist);
    p.hazeP.x += (1 - p.hazeP.x) * mist * 0.5;
    p.hazeP.y += (58 - p.hazeP.y) * mist * 0.5;
    p.hazeP.z += (0.5 - p.hazeP.z) * mist * 0.5;
    p.cloud *= 1 - 0.5 * mist;
    p.sat *= 1 - 0.06 * mist;
    p.bloom += 0.08 * mist;
  }

  /** Photo mode time-of-day preview: the state to put back (fixed time of day only). */
  private photoSaved: { active: boolean; preset: Preset | null; base: Preset; bg: THREE.Color | THREE.Texture | null; exposure: number; envI: number } | null = null;
  private photoPrevPhase: number | null = null;
  private photoCycle = false;

  /**
   * Photo mode: show the day / night cycle at phase u (0 = midday, 0.5 = night)
   * even when the battle runs a fixed time of day; null puts everything back.
   */
  previewPhase(u: number | null) {
    const h = this.host;
    if (this.cfg.tod === 'cycle') {
      if (u === null) {
        if (this.photoCycle) this.phaseOverride = this.photoPrevPhase;
        this.photoCycle = false;
        return;
      }
      if (!this.photoCycle) {
        this.photoPrevPhase = this.phaseOverride;
        this.photoCycle = true;
      }
      this.phaseOverride = u;
      return;
    }
    if (u === null) {
      const sv = this.photoSaved;
      if (!sv) return;
      this.photoSaved = null;
      this.keys = null;
      this.sunBase = null;
      if (this.cfg.tod === 'mist') this.sunBase = pathAt(SUN_PATH, 0.855 - 1, new THREE.Vector3());
      this.phaseOverride = null;
      this.phase = -1;
      this.active = sv.active;
      this.preset = sv.preset;
      this.applyPreset(sv.preset ?? sv.base);
      h.scene.background = sv.bg;
      h.renderer.toneMappingExposure = sv.exposure;
      if (h.finalPass) h.finalPass.uniforms.exposure.value = sv.base.exposure;
      h.scene.environmentIntensity = sv.envI;
      this.night?.setDark(sv.preset?.dark ?? 0);
      return;
    }
    if (!this.photoSaved) {
      // snapshot what the fixed time of day put on the renderer
      const f = h.finalPass?.uniforms;
      const wu = h.terrain.waterMat.uniforms;
      const base: Preset = {
        ...todPreset('day').p,
        sunC: h.sun.color.clone(),
        sunI: h.sun.intensity,
        sky: h.hemi.color.clone(),
        gnd: h.hemi.groundColor.clone(),
        hemiI: h.hemi.intensity,
        env: h.scene.environmentIntensity,
        haze: (h.fog.uniforms.hazeColor.value as THREE.Color).clone(),
        hazeP: (h.fog.uniforms.hazeParams.value as THREE.Vector4).clone(),
        cloud: h.fog.uniforms.cloudAmount.value as number,
        exposure: f ? (f.exposure.value as number) : h.renderer.toneMappingExposure,
        bg: h.scene.background instanceof THREE.Color ? h.scene.background.clone() : new THREE.Color(0x2a2824),
        water: (wu.wxLight.value as THREE.Vector3).clone(),
        spec: wu.wxSpec.value as number,
        dark: this.preset?.dark ?? 0,
      };
      if (f) {
        base.sat = f.saturation.value as number;
        base.shadowTint = (f.shadowTint.value as THREE.Vector3).clone();
        base.highTint = (f.highTint.value as THREE.Vector3).clone();
        base.vignette = f.vignette.value as number;
      }
      if (h.bloom) base.bloom = h.bloom.strength;
      this.photoSaved = { active: this.active, preset: this.preset, base, bg: h.scene.background as THREE.Color | THREE.Texture | null, exposure: h.renderer.toneMappingExposure, envI: h.scene.environmentIntensity };
      this.keys = this.buildKeys();
      this.preset = buildPreset({ ...this.cfg, tod: 'day' });
      if (this.wxCycle && !this.altP) this.altP = clonePreset(this.preset);
      // a real direction right away: the cycle blend only rewrites it on the next frame, and a zero sun breaks shadows
      this.sunBase = pathAt(SUN_PATH, u > MOON_SET ? u - 1 : u, new THREE.Vector3());
      this.active = true;
    }
    this.phaseOverride = u;
  }

  /** Overall daylight of this frame, 0 (night) .. 1 (full day): drives the post-processing grade (post/grade.ts). */
  get daylight(): number {
    return this.active && this.preset ? (this.keys ? this.light : this.baseLight) : 1;
  }

  /**
   * The HUD clock: the live day's time (from the sim tick, so it follows the game speed and pause),
   * the photo mode preview's time, or the hour of a fixed time of day; with the sky and weather icons.
   */
  clock(): ClockState {
    const live = this.cfg.tod === 'cycle';
    const abs = live ? clockHours(this.host.world.tick, this.startHour) : FIXED_HOUR[this.cfg.tod as Exclude<TimeOfDay, 'cycle'>] ?? 12;
    // photo mode preview / ?todphase pins the sky: show its time
    const h = this.phaseOverride !== null ? uToHour(this.phaseOverride) : ((abs % 24) + 24) % 24;
    const text = formatClock(h);
    return { hours: +text.slice(0, 2), minutes: +text.slice(3), day: live ? Math.floor(abs / 24) + 1 : 1, icon: clockIcon(h), weather: this.wxIcon(), live, text };
  }

  /** Weather icon of this frame. */
  private wxIcon(): WxIcon {
    const st = this.wx;
    if (st) {
      if (st.precip > 0.06) return st.fall === 'snow' ? 'snow' : st.fall === 'sandstorm' ? 'dust' : st.storm > 0.3 ? 'storm' : 'rain';
      return st.cover > 0.4 ? 'cloudy' : 'clear';
    }
    const w = this.cfg.weather;
    return w === 'rain' ? 'rain' : w === 'snow' ? 'snow' : w === 'sandstorm' ? 'dust' : 'clear';
  }

  /**
   * Briefing forecast: the fronts of the first `hours` game hours that bring something down (with the
   * clock hour their rain / snow / dust begins), [] for a clear day, null without dynamic weather.
   */
  forecast(hours = 24): { kind: WxEventKind; hour: number; storm: boolean }[] | null {
    const c = this.wxCycle;
    if (!c) return null;
    const secPerHour = GAME_HOUR_TICKS / TPS;
    const t1 = hours * secPerHour;
    c.eventAt(t1);
    return c.events.filter((e) => e.precip > 0 && e.start < t1).map((e) => ({ kind: e.kind, hour: (this.startHour + (e.start + e.build) / secPerHour) % 24, storm: e.storm > 0 }));
  }

  get nightVision() {
    return this.nv;
  }

  /** Toggle the green night-vision look (post pass; CSS filter fallback without post-processing). */
  setNightVision(on: boolean) {
    this.nv = on;
    const h = this.host;
    if (h.composer) {
      if (!this.nvPass && on) {
        this.nvPass = new NightVisionPass();
        h.composer.addPass(this.nvPass);
      }
      if (this.nvPass) this.nvPass.enabled = on;
    } else {
      h.canvas.style.filter = on ? 'grayscale(1) sepia(1) hue-rotate(65deg) saturate(2.6) brightness(1.35) contrast(1.15)' : '';
    }
  }

  private applyPreset(p: Preset) {
    const h = this.host;
    h.sun.color.copy(p.sunC);
    h.sun.intensity = p.sunI;
    h.hemi.color.copy(p.sky);
    h.hemi.groundColor.copy(p.gnd);
    h.hemi.intensity = p.hemiI;
    if (h.scene.background instanceof THREE.Color) h.scene.background.copy(p.bg);
    else h.scene.background = p.bg.clone();
    const u = h.fog.uniforms;
    u.hazeColor.value.copy(p.haze);
    u.hazeParams.value.copy(p.hazeP);
    // city windows and street lamps come on at dusk
    CITY_NIGHT.value = Math.max(0, Math.min(1, (p.dark - 0.25) / 0.5));
    u.cloudAmount.value = p.cloud;
    h.renderer.toneMappingExposure = p.exposure;
    if (h.finalPass) {
      const f = h.finalPass.uniforms;
      f.exposure.value = p.exposure;
      f.saturation.value = p.sat;
      f.shadowTint.value.copy(p.shadowTint);
      f.highTint.value.copy(p.highTint);
      f.vignette.value = p.vignette;
    }
    if (h.bloom) h.bloom.strength = p.bloom;
    const wu = h.terrain.waterMat.uniforms;
    (wu.wxLight.value as THREE.Vector3).copy(p.water);
    wu.wxSpec.value = p.spec;
  }

  /** Per-frame update (after the entities are synced, before the effects / camera). */
  update(dt: number, time: number, visuals: VisualSource, target: THREE.Vector3, zoom: number, camera: THREE.Camera) {
    this.time = time;
    this.env.update(dt, visuals.values());
    this.living.update(dt, time, target, zoom, camera);
    if (this.nvPass && this.nv) this.nvPass.uniforms.time.value = time;
    if (!this.active || !this.preset) return;
    const h = this.host;
    const p = this.preset;
    const gt = h.world.tick / TPS;
    // dynamic weather: where the timeline is at this sim tick
    let st: WxState | null = null;
    if (this.wxCycle) {
      st = this.wx = this.wxCycle.at(this.wxTimeOverride ?? gt, this.wx ?? undefined);
      if (this.wxForce) Object.assign(st, this.wxForce);
      this.windK = st.wind;
      this.windX = Math.cos(st.windDir);
      this.windZ = Math.sin(st.windDir);
      WX.wxWet.value = st.wet;
      WX.wxRain.value = st.fall === 'rain' ? st.precip : 0;
      WX.wxDust.value = st.dust;
      WX.wxSnow.value = Math.max(this.look.snowFloor, this.living.snow);
      // foliage sways faster in the wind (extra clock on top of the terrain's)
      this.swayExtra += dt * 1.8 * Math.max(0, st.wind - 0.2);
    }
    if (this.perFrame) {
      if (this.keys) this.blendCycle(h.world.tick);
      else if (this.base) {
        lerpPreset(p, this.base, this.base, 0);
        if (this.alt && this.altP) lerpPreset(this.altP, this.alt[st?.fall ?? 'rain'], this.alt[st?.fall ?? 'rain'], 0);
      }
      if (st && this.altP) this.applyDynamic(p, st);
      // ground fog: dawn in the cycle, the misty morning, after rain; strong wind tears it up
      let mist = 0;
      if (this.cfg.tod === 'mist') mist = morningMist(gt);
      // (with dynamic weather the dawn mist is light after a dry night, thick after a rainy one)
      if (this.keys) mist = Math.max(mist, dawnMist(this.phase) * (st ? 0.55 + 0.45 * sstep(0.08, 0.45, st.wet) : 1));
      if (st) mist = Math.max(mist, st.mist) * (1 - 0.65 * sstep(0.35, 0.9, st.wind));
      if (this.mistOverride !== null) mist = this.mistOverride;
      this.mist = mist;
      // zoomed in close (phones) the layer thins: the player is looking at their units, not the landscape
      this.applyMist(p, mist * (1 - 0.4 * sstep(1, 1.8, zoom)), this.keys ? this.light : this.baseLight, st?.cover ?? 0);
      this.applyPreset(p);
      this.night?.setDark(p.dark);
      if (this.keys) this.weather?.setLight(0.25 + 0.75 * this.light);
    }
    // keep the busy middle of the view clear of mist (readability): radius ~ half the visible height
    const focus = (22 / Math.max(0.3, zoom)) * 0.45;
    WXM.mistParams.value.z = focus;
    const drift = WXM.mistDrift.value;
    const wv = 0.25 + 0.75 * this.windK;
    drift.x = (drift.x - this.windX * wv * dt * 0.4) % 9600;
    drift.y = (drift.y - this.windZ * wv * dt * 0.4) % 9600;
    this.groundFog?.update(dt, time, WXM.mistAmount.value, this.windX * wv * 1.4, this.windZ * wv * 1.4, focus);
    if (st && this.weather) {
      const wf = this.weather;
      if (wf.kind !== st.fall && st.precip < 0.03) wf.setKind(st.fall);
      wf.setIntensity(wf.kind === st.fall ? st.precip : 0);
      wf.setWind(this.windX * st.wind * 6, this.windZ * st.wind * 6);
      // lightning on whole game seconds picked by the seeded timeline (the same for every player)
      const sec = Math.floor(this.wxTimeOverride ?? gt);
      if (sec !== this.lastSec) {
        if (this.lastSec >= 0 && sec > this.lastSec && sec - this.lastSec < 3 && this.wxCycle!.strikes(sec, st.storm)) wf.strike(time);
        this.lastSec = sec;
      }
      if (this.wxTimeOverride === null && !this.wxForce) this.announce(st);
    }
    WX.wxTime.value = time;
    // the HDRI streams in late and resets the intensity: keep ours
    h.scene.environmentIntensity = p.env;
    let flash = 0;
    if (this.weather) {
      flash = this.weather.update(dt, time, target, zoom, camera, h.world.map);
      if (this.weather.struck) {
        this.weather.struck = false;
        // thunder rolls in a moment later (distance), louder for close strikes
        this.thunderAt.push(time + 0.5 + Math.random() * 2.2);
        this.thunderVol.push((0.35 + Math.random() * 0.4) * (st ? 0.6 + 0.4 * st.storm : 1));
      }
    }
    for (let i = this.thunderAt.length - 1; i >= 0; i--) {
      if (time < this.thunderAt[i]) continue;
      this.thunder(this.thunderVol[i]);
      this.thunderAt.splice(i, 1);
      this.thunderVol.splice(i, 1);
    }
    h.hemi.intensity = p.hemiI + flash * 2.6;
    h.sun.intensity = p.sunI + flash * 1.5;
    this.night?.update(dt, time, visuals.values(), target, h.world);
  }

  private skySt: SkyState = { sun: new THREE.Vector3(0, 1, 0), moon: null, night: 0, cover: 0.3, storm: 0, dust: 0 };
  private skyMoon = new THREE.Vector3();

  /**
   * Drive the physical sky (sky.ts) from the time of day and the weather. keyDir = the renderer's
   * key light direction this frame (sun by day, moon by night; it turns with the view).
   */
  driveSky(sky: Sky, dt: number, keyDir: THREE.Vector3, freeView: boolean) {
    const st = this.skySt;
    const p = this.active ? this.preset : null;
    const light = this.keys ? this.light : p ? this.baseLight : 1;
    const moonUp = this.keys ? this.phase > MOON_RISE && this.phase < MOON_SET : this.cfg.tod === 'night' && !!p;
    st.night = 1 - sstep(0.15, 0.62, light);
    st.sun.copy(keyDir);
    st.moon = null;
    if (moonUp) {
      st.moon = this.skyMoon.copy(keyDir);
      // the sun is well below the horizon on the far side
      st.sun.set(-keyDir.x, 0, -keyDir.z).normalize().multiplyScalar(Math.cos(0.3));
      st.sun.y = -Math.sin(0.3);
    } else if (!this.keys && this.cfg.tod === 'dusk' && p) {
      // fixed dusk: the key light keeps its usual direction, the sky shows a low evening sun in that azimuth
      const h = Math.hypot(keyDir.x, keyDir.z) || 1;
      st.sun.set((keyDir.x / h) * Math.cos(0.09), Math.sin(0.09), (keyDir.z / h) * Math.cos(0.09));
    }
    const wx = this.wx;
    if (wx) {
      st.cover = Math.max(0.2, wx.cover, wx.precip);
      st.storm = wx.storm;
      st.dust = wx.dust;
    } else {
      const w = this.cfg.weather;
      st.cover = w === 'rain' ? 0.95 : w === 'snow' ? 0.85 : w === 'sandstorm' ? 0.55 : 0.28 + (p ? p.cloud : 0.32) * 0.6;
      st.storm = w === 'rain' ? 0.35 : 0;
      st.dust = w === 'sandstorm' ? 1 : 0;
    }
    sky.setFreeView(freeView, dt);
    this.living.sky(keyDir, freeView);
    sky.update(dt, st, this.host.sun.color, this.host.hemi.groundColor);
    if (sky.env && this.host.scene.environment !== sky.env) {
      this.host.scene.environment = sky.env;
      // (the fixed day look normally gets this from the HDRI loader, which the sky capture replaces)
      if (!this.active) this.host.scene.environmentIntensity = 0.42;
    }
  }

  /** Dynamic weather: a short, subtle HUD line when a front arrives, a storm breaks or the sky clears. */
  private announce(st: WxState) {
    const e = st.event;
    const key = e ? `${e.start}:${st.stage}:${st.storm > 0.5 ? 1 : 0}` : 'clear';
    if (key === this.said) return;
    const first = this.said === '';
    this.said = key;
    if (first || !e || this.viewer < 0) return;
    let text = '';
    if (st.stage === 'build') {
      if (e.kind === 'dust') text = 'Dust front approaching';
      else if (e.kind === 'flurries') text = 'Snow flurries moving in';
      else if (e.kind === 'snowfall') text = 'Heavy snow moving in';
      else if (e.kind === 'storm') text = 'Storm front moving in';
      else if (e.kind !== 'overcast') text = 'Clouds gathering: rain expected';
    } else if (st.stage === 'hold' && st.storm > 0.5) text = 'Thunderstorm overhead';
    else if (st.stage === 'clearing' && e.precip > 0) text = e.kind === 'dust' ? 'Dust settling' : e.fall === 'snow' ? 'Snow easing off' : 'Skies clearing';
    if (!text) return;
    try {
      const g = (window as unknown as { ironfront?: { game?: { hud?: { message(t: string, k?: 'info' | 'warn' | 'good'): void } } } }).ironfront?.game;
      g?.hud?.message(text, 'info');
    } catch {
      /* no hud */
    }
  }

  private thunder(vol: number) {
    if (this.onThunder) return this.onThunder(vol);
    try {
      const g = (window as unknown as { ironfront?: { game?: { audio?: { play(n: string, v: number): void } } } }).ironfront?.game;
      g?.audio?.play('explosionLarge', vol * 0.55);
    } catch {
      /* no audio */
    }
  }

  /** A blast on the ground at tile (x, y): environment damage. `size` ~ blast profile size. */
  impact(x: number, y: number, size: number) {
    this.env.blast(x, y, size, this.time);
    this.living.impact(x, y, size, this.time);
  }

  dispose() {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.night?.dispose();
    this.living.dispose();
    this.unhookWind?.();
    this.unhookWind = null;
    this.host.canvas.style.filter = '';
    WX.wxWet.value = 0;
    WX.wxRain.value = 0;
    WX.wxSnow.value = 0;
    WX.wxDust.value = 0;
    WXM.mistAmount.value = 0;
    CITY_NIGHT.value = 0;
    BIOME = null;
  }
}
