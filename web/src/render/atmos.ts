import * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { World } from '../sim/world';
import type { Effects } from './effects';
import { EnvDamage } from './envdamage';
import type { FogOfWar } from './fog';
import type { GroundMarks } from './marks';
import type { AnimState, Model } from './models';
import { NightLights, NightVisionPass } from './night';
import type { FinalPass } from './post';
import type { Terrain } from './terrain';
import { WeatherFx } from './weather';
import { WX } from './wxuniforms';
import { TPS } from '../sim/types';

/*
 * Time of day, weather and night vision (all purely visual).
 *
 * Settings come from the URL (?tod=day|dusk|night|cycle, ?weather=clear|rain|snow|sandstorm,
 * ?nv=1) or, for a skirmish, from the saved menu settings (`tod`, `weather`).
 * Day + clear leaves the renderer exactly as it is: no presets are applied and
 * no extra objects are created.
 */

export type TimeOfDay = 'day' | 'dusk' | 'night' | 'cycle';
export type Weather = 'clear' | 'rain' | 'snow' | 'sandstorm';
type Q = 'low' | 'medium' | 'high';

export interface AtmosConfig {
  tod: TimeOfDay;
  weather: Weather;
  nv: boolean;
}

const TODS: TimeOfDay[] = ['day', 'dusk', 'night', 'cycle'];
const WEATHERS: Weather[] = ['clear', 'rain', 'snow', 'sandstorm'];

/** Resolve the atmosphere: URL params win; skirmishes (viewer >= 0) fall back to the saved menu settings. */
export function atmosConfig(viewer: number): AtmosConfig {
  const cfg: AtmosConfig = { tod: 'day', weather: 'clear', nv: false };
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
      set({ sunI: 0.45, hemiI: 0.62, env: 0.13, cloud: 0.14, sat: 0.9, vignette: 0.46, bloom: 0.72, exposure: 1.23, spec: 0.55, dark: 0.88 }, 0xa080b0, 0x4c5894, 0x1c1820, [0.1, 0.08, 0.12], [-0.01, 0.0, 0.036], [0.02, 0.004, 0.0], 0x0e0c14, [0.4, 0.38, 0.5]);
      light = 0.28;
      break;
    case 'predawn':
      set({ sunI: 0.5, hemiI: 0.62, env: 0.12, cloud: 0.12, sat: 0.88, vignette: 0.46, bloom: 0.72, exposure: 1.23, spec: 0.5, dark: 0.88 }, 0x9aa0d8, 0x48589a, 0x161a24, [0.07, 0.08, 0.12], [-0.01, 0.0, 0.034], [0.006, 0.006, 0.01], 0x0a0c14, [0.34, 0.36, 0.5]);
      light = 0.28;
      break;
    case 'dawn':
      set({ sunI: 2.4, hemiI: 0.6, env: 0.26, cloud: 0.2, sat: 1.08, vignette: 0.38, bloom: 0.55, exposure: 1.17, spec: 0.9, dark: 0.42 }, 0xff9a70, 0x8a94c8, 0x4a3a34, [0.3, 0.24, 0.26], [-0.012, 0.0, 0.045], [0.05, 0.012, -0.03], 0x1c1820, [0.8, 0.68, 0.72]);
      p.hazeP.set(3, 70, 0.45, 50); // morning mist
      light = 0.6;
      break;
    case 'morning':
      set({ sunI: 3.0, hemiI: 0.78, env: 0.4, cloud: 0.3, sat: 1.04, vignette: 0.3, bloom: 0.42, exposure: 1.18, spec: 1, dark: 0.04 }, 0xffdcb0, 0x9ab8e6, 0x64503a, [0.3, 0.3, 0.31], [-0.012, 0.0, 0.024], [0.025, 0.01, -0.02], 0x2a2826, [0.95, 0.95, 1]);
      p.hazeP.set(4, 80, 0.4, 52);
      light = 0.95;
      break;
  }
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

/** One full day at 1x game speed: 22 real minutes (driven by the sim tick, so it follows the game speed). */
export const CYCLE_TICKS = TPS * 60 * 22;

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

export class Atmosphere {
  readonly cfg: AtmosConfig;
  /** Day + clear + no night vision: nothing to do. */
  readonly active: boolean;
  /** Thunder hook (delay already elapsed), volume 0..1. Defaults to the game's large-explosion sound. */
  onThunder: ((volume: number) => void) | null = null;
  readonly weather: WeatherFx | null = null;
  readonly night: NightLights | null = null;
  readonly env: EnvDamage;
  private preset: Preset | null = null;
  private nvPass: NightVisionPass | null = null;
  private nv = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private thunderAt: number[] = [];
  private thunderVol: number[] = [];
  private time = 0;
  /** Dynamic cycle: lighting stops (weather applied) and the blended preset of this frame. */
  private keys: { u: number; p: Preset; light: number }[] | null = null;
  private light = 1;
  /** Direction towards the key light (sun or moon) in the classic view frame; null = the renderer's fixed sun. */
  readonly sunBase: THREE.Vector3 | null = null;
  /** Debug / screenshots: force the cycle to this phase (0 = midday, 0.5 = night). */
  phaseOverride: number | null = null;
  /** Current phase of the cycle (0..1, 0 = midday), -1 when the time of day is fixed. */
  phase = -1;
  private keyI = 1;

  constructor(private host: AtmosHost, viewer: number) {
    const cfg = (this.cfg = atmosConfig(viewer));
    this.active = cfg.tod !== 'day' || cfg.weather !== 'clear' || cfg.nv;
    WX.wxWet.value = cfg.weather === 'rain' ? 1 : 0;
    WX.wxSnow.value = cfg.weather === 'snow' ? 1 : 0;
    WX.wxDust.value = cfg.weather === 'sandstorm' ? 1 : 0;
    // environment destruction is always on (it only reacts to events)
    this.env = new EnvDamage(host.terrain, host.world.map, host.fog, host.effects, host.quality);
    host.scene.add(this.env.group);
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
    const p = (this.preset = buildPreset(cfg));
    if (cfg.tod === 'cycle') {
      this.keys = CYCLE_KEYS.map(({ u, key }) => {
        const t = todPreset(key);
        applyWeather(t.p, cfg.weather, t.light);
        return { u, p: t.p, light: t.light };
      });
      this.sunBase = new THREE.Vector3();
      const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('todphase');
      if (q !== null && Number.isFinite(+q)) this.phaseOverride = +q;
      this.blendCycle(host.world.tick);
    }
    this.applyPreset(p);
    if (cfg.weather !== 'clear') {
      this.weather = new WeatherFx(cfg.weather, host.quality, cfg.tod === 'cycle' ? 'day' : cfg.tod);
      host.scene.add(this.weather.mesh);
    }
    // the cycle keeps its night-light pools for the whole battle (fixed light count: no shader recompiles)
    if (p.dark > 0.3 || this.keys) {
      this.night = new NightLights(host.scene, host.quality, p.dark);
    }
  }

  /** Dynamic cycle: blend the lighting stops and move the sun / moon for this sim tick. */
  private blendCycle(tick: number) {
    const keys = this.keys!;
    const u = (((this.phaseOverride ?? tick / CYCLE_TICKS) % 1) + 1) % 1;
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
    this.light = a.light + (b.light - a.light) * ks;
    // key light: the sun by day, the moon by night; they hand over while the light is dim
    const dir = this.sunBase!;
    const moon = u > MOON_RISE && u < MOON_SET;
    if (moon) pathAt(MOON_PATH, u, dir);
    else pathAt(SUN_PATH, u > MOON_SET ? u - 1 : u, dir);
    // a low sun grazes the ground: give it back part of the lost irradiance so the map doesn't go dark too early
    const comp = Math.min(1.8, Math.sqrt(Math.sin(THREE.MathUtils.degToRad(DAY_ELEV)) / Math.max(0.05, dir.y)));
    this.preset!.sunI *= Math.max(1, moon ? Math.min(comp, 1.3) : comp);
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
    if (this.nvPass && this.nv) this.nvPass.uniforms.time.value = time;
    if (!this.active || !this.preset) return;
    const h = this.host;
    const p = this.preset;
    if (this.keys) {
      this.blendCycle(h.world.tick);
      this.applyPreset(p);
      this.night?.setDark(p.dark);
      this.weather?.setLight(0.25 + 0.75 * this.light);
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
        this.thunderVol.push(0.35 + Math.random() * 0.4);
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
  }

  dispose() {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.night?.dispose();
    this.host.canvas.style.filter = '';
    WX.wxWet.value = 0;
    WX.wxSnow.value = 0;
    WX.wxDust.value = 0;
  }
}
