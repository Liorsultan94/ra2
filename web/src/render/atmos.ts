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

/*
 * Time of day, weather and night vision (all purely visual).
 *
 * Settings come from the URL (?tod=day|dusk|night, ?weather=clear|rain|snow|sandstorm,
 * ?nv=1) or, for a skirmish, from the saved menu settings (`tod`, `weather`).
 * Day + clear leaves the renderer exactly as it is: no presets are applied and
 * no extra objects are created.
 */

export type TimeOfDay = 'day' | 'dusk' | 'night';
export type Weather = 'clear' | 'rain' | 'snow' | 'sandstorm';
type Q = 'low' | 'medium' | 'high';

export interface AtmosConfig {
  tod: TimeOfDay;
  weather: Weather;
  nv: boolean;
}

const TODS: TimeOfDay[] = ['day', 'dusk', 'night'];
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

function buildPreset(cfg: AtmosConfig): Preset {
  // --- time of day
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
  if (cfg.tod === 'dusk') {
    Object.assign(p, { sunI: 2.3, hemiI: 0.55, env: 0.24, cloud: 0.22, sat: 1.12, vignette: 0.38, bloom: 0.55, exposure: 1.15, spec: 0.9, dark: 0.55 });
    p.sunC.set(0xff8a4c);
    p.sky.set(0x7a84b8);
    p.gnd.set(0x4a3424);
    p.haze.setRGB(0.3, 0.19, 0.16);
    p.shadowTint.set(-0.012, 0.0, 0.04);
    p.highTint.set(0.06, 0.015, -0.05);
    p.bg.set(0x1c1418);
    p.water.set(0.72, 0.6, 0.62);
    light = 0.6;
  } else if (cfg.tod === 'night') {
    Object.assign(p, { sunI: 1.0, hemiI: 0.62, env: 0.08, cloud: 0.1, sat: 0.8, vignette: 0.5, bloom: 0.8, exposure: 1.25, spec: 0.35, dark: 1 });
    p.sunC.set(0x8ea8ff);
    p.sky.set(0x3a5296);
    p.gnd.set(0x0e1118);
    p.haze.setRGB(0.022, 0.03, 0.055);
    p.shadowTint.set(-0.008, 0.0, 0.03);
    p.highTint.set(0.0, 0.004, 0.012);
    p.bg.set(0x04060a);
    p.water.set(0.2, 0.25, 0.38);
    light = 0.12;
  }
  // --- weather on top
  const mixC = (c: THREE.Color, h: number, k: number) => c.lerp(C(h), k);
  if (cfg.weather === 'rain') {
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
  } else if (cfg.weather === 'snow') {
    p.sunI *= 0.55;
    mixC(p.sunC, 0xe2eaff, 0.6);
    mixC(p.gnd, 0xb0b8c8, cfg.tod === 'night' ? 0.25 : 0.7);
    p.hemiI *= 1.05;
    p.haze.setRGB(0.6, 0.64, 0.7).multiplyScalar(Math.max(0.12, light));
    p.hazeP.set(2, 55, 0.5, 48);
    p.cloud = 0.08;
    p.sat *= 0.85;
    p.shadowTint.set(-0.016, 0.0, 0.036);
    p.highTint.set(-0.012, 0.0, 0.02);
    p.water.multiplyScalar(0.9);
    p.dark = Math.min(1, p.dark + 0.15);
  } else if (cfg.weather === 'sandstorm') {
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
  return p;
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
    this.applyPreset(p);
    if (cfg.weather !== 'clear') {
      this.weather = new WeatherFx(cfg.weather, host.quality, cfg.tod);
      host.scene.add(this.weather.mesh);
    }
    if (p.dark > 0.3) {
      this.night = new NightLights(host.scene, host.quality, p.dark);
    }
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
    h.scene.background = p.bg.clone();
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
