/**
 * Procedural sound system: every effect, the radio chatter, the ambience and
 * the background music are synthesized at runtime with the Web Audio API.
 * There are no audio asset files.
 *
 * Combat sounds are baked once at load into AudioBuffer variants (weapons.ts,
 * rendered by bake.ts in OfflineAudioContexts) and played through a pool of
 * 24 positional voices; until a sound is baked its live node-graph version
 * (live.ts) plays through the same voice.
 *
 * Graph:
 *   source -> voice gain -> low-pass -> stereo pan -> sfxBus -> sfxGain -----------------------\
 *                                                 \-> wet -> sfxWetBus -> sfxWetGain -> outdoor IR -+
 *   ambience beds / aircraft engines -> sfxBus                                                    |
 *   UI sounds (live patches) -> [pan] -> sfxBus                                                   |
 *   music (music.ts) -> musicPlay -> musicDuck -> musicGain ---------------------------------------+-> compressor -> master
 *                                                          \-> musicWet -> hall reverb ------------/
 *
 * Positional audio: the camera reports itself every frame (setListener); a
 * sound played with a world position gets pan, distance gain, air-absorption
 * low-pass, off-screen muffling and a (capped) speed-of-sound delay
 * (spatial.ts). Voice priority keeps a big battle readable and cheap.
 *
 * The battle score adapts to a combat intensity inferred from the effects and
 * announcer lines that pass through here (see intensity.ts).
 */
import { Bank, Patch, clamp, makeImpulse } from './core';
import { CombatHeat } from './intensity';
import { MUSIC_LEVEL, MusicEngine, type MusicMode, type StingerKind } from './music';
import { LIVE, type Build, type LiveName } from './live';
import { bakeAll, type BakeStats, type BakedSound } from './bake';
import { type BakedName } from './weapons';
import { makeOutdoorImpulse } from './reverb';
import { type Listener, type Spatial, type VoiceInfo, chooseSlot, defaultListener, makeSpatial, spatialize } from './spatial';
import { Ambience, type AmbienceState, type BedName, type EngineKind, EngineVoices, ENGINE_SLOTS, defaultAmbience } from './ambience';
import { type RadioProfile, radioAck, radioClose, radioFor, radioOpen, radioStatic } from './radio';

export type Sfx =
  | LiveName
  | 'autocannon' | 'interceptorLaunch' | 'mortar' | 'bridgeCollapse' | 'jetFlyby' | 'thunder'
  /** A vehicle ran a soldier over (crunch + thud); a short alarmed radio squelch (soldiers dodging a vehicle). */
  | 'crush' | 'squelch'
  /** Civilian ambience of the render-only set pieces (render/landmarks/sound.ts): played only once baked. */
  | 'trainPass' | 'trainHorn' | 'crossingBell' | 'churchBell' | 'jetHigh' | 'heliPass' | 'shipHorn'
  /** Police (wail) / ambulance (hi-lo) siren cycle, about 2 s (render/ambient/emergency.ts). */
  | 'siren' | 'sirenHiLo';

/** A world position (sim x / y on the ground, z = height above it). */
export interface SoundPos {
  x: number;
  y: number;
  z?: number;
}

/** Combat voices playing at once (UI sounds have their own small budget). */
export const MAX_VOICES = 24;
const MAX_UI = 8;

/** Maps a screen x coordinate to a stereo pan in -0.8..0.8. */
export function panFor(screenX: number, screenWidth: number): number {
  if (!(screenWidth > 0) || !Number.isFinite(screenX)) return 0;
  const x = clamp(screenX / screenWidth, 0, 1);
  return (x * 2 - 1) * 0.8;
}

// ---------------------------------------------------------------------------
// Sound table
// ---------------------------------------------------------------------------

interface Meta {
  /** base level */
  lvl: number;
  /** reverb send */
  wet: number;
  /** minimum interval between identical sounds, seconds */
  gap: number;
  /** combat sound: baked, pooled, positional */
  combat: boolean;
  /** priority class weight */
  weight: number;
  /** max simultaneous voices of this sound */
  cap: number;
  /** random pitch spread per play */
  jitter: number;
  /** live fallback while not baked */
  live: LiveName;
}

const C = (lvl: number, wet: number, gap: number, weight: number, cap: number, live: LiveName, jitter = 0.06): Meta => ({ lvl, wet, gap, combat: true, weight, cap, jitter, live });

// levels balanced by measured loudness: sustained roars (rocket / missile / thermobaric / jet) carry
// 8-12 dB more RMS than the impulsive cannon and blast buffers, so they sit lower here
const META: Record<Sfx, Meta> = {
  rifle: C(0.42, 0.12, 0.04, 0.8, 6, 'rifle'),
  mg: C(0.45, 0.1, 0.05, 0.8, 5, 'mg'),
  autocannon: C(0.55, 0.14, 0.06, 1.1, 4, 'flak'),
  flak: C(0.5, 0.14, 0.05, 1, 4, 'flak'),
  cannon: C(0.72, 0.2, 0.05, 1.5, 5, 'cannon'),
  cannonHeavy: C(0.82, 0.22, 0.06, 1.6, 4, 'cannonHeavy'),
  rocket: C(0.36, 0.16, 0.05, 1.3, 5, 'rocket'),
  missileLaunch: C(0.38, 0.22, 0.08, 2, 3, 'missileLaunch'),
  interceptorLaunch: C(0.66, 0.2, 0.06, 1.8, 4, 'missileLaunch'),
  laser: C(0.45, 0.22, 0.05, 1.1, 3, 'laser'),
  artillery: C(0.85, 0.3, 0.06, 1.8, 4, 'artillery'),
  mortar: C(0.6, 0.22, 0.06, 1.2, 3, 'artillery', 0.08),
  thermo: C(0.44, 0.2, 0.08, 1.8, 2, 'thermo'),
  explosionSmall: C(0.6, 0.2, 0.045, 1.2, 6, 'explosionSmall', 0.1),
  explosionMedium: C(0.78, 0.24, 0.05, 1.8, 5, 'explosionMedium', 0.08),
  explosionLarge: C(0.95, 0.28, 0.06, 2.6, 4, 'explosionLarge', 0.07),
  buildingCollapse: C(0.95, 0.3, 0.2, 3.2, 2, 'buildingCollapse', 0.05),
  bridgeCollapse: C(1, 0.32, 0.3, 3.5, 1, 'buildingCollapse', 0.04),
  intercept: C(0.55, 0.16, 0.05, 1.3, 3, 'intercept'),
  droneLaunch: C(0.5, 0.15, 0.1, 1, 3, 'droneLaunch'),
  droneBuzz: C(0.35, 0.08, 0.08, 0.6, 2, 'droneBuzz'),
  jetFlyby: C(0.5, 0.2, 0.8, 2, 2, 'droneBuzz', 0.05),
  thunder: C(0.9, 0.25, 0.5, 2.2, 2, 'explosionLarge', 0.12),
  // civilian ambience: low priority (never steals a combat voice), one or two at a time
  trainPass: C(0.5, 0.18, 3, 0.3, 2, 'droneBuzz', 0.04),
  trainHorn: C(0.42, 0.3, 4, 0.4, 1, 'droneBuzz', 0.02),
  crossingBell: C(0.3, 0.12, 1.5, 0.3, 2, 'droneBuzz', 0),
  churchBell: C(0.42, 0.35, 1.2, 0.4, 2, 'droneBuzz', 0.01),
  jetHigh: C(0.32, 0.25, 6, 0.25, 1, 'droneBuzz', 0.04),
  heliPass: C(0.4, 0.12, 2, 0.35, 2, 'droneBuzz', 0.03),
  shipHorn: C(0.42, 0.35, 5, 0.3, 1, 'droneBuzz', 0.02),
  siren: C(0.34, 0.16, 1.5, 0.35, 2, 'droneBuzz', 0.01),
  sirenHiLo: C(0.34, 0.16, 1.5, 0.35, 2, 'droneBuzz', 0.01),
  crush: C(0.6, 0.1, 0.06, 1, 3, 'explosionSmall', 0.1),
  jam: { lvl: 0.4, wet: 0.08, gap: 0.08, combat: false, weight: 1, cap: 2, jitter: 0, live: 'jam' },
  click: ui('click'),
  tab: ui('tab'),
  build: ui('build'),
  place: ui('place'),
  sell: ui('sell'),
  error: ui('error'),
  select: ui('select'),
  ack: ui('ack'),
  alarm: ui('alarm'),
  money: ui('money'),
  deploy: ui('deploy'),
  repair: ui('repair'),
  squelch: { ...ui('ack'), gap: 3 },
  // victory fireworks: non-positional live patches (panned), a few at once
  fwLaunch: { ...ui('fwLaunch'), cap: 3 },
  fwBoom: { ...ui('fwBoom'), cap: 4 },
  fwCrackle: { ...ui('fwCrackle'), cap: 2 },
};

function ui(name: LiveName): Meta {
  const d = LIVE[name];
  return { lvl: d.lvl, wet: d.wet, gap: d.gap, combat: false, weight: 5, cap: 4, jitter: 0.08, live: name };
}

/** Civilian ambience sounds: no live fallback, silent until baked. */
const CIVIL = new Set<Sfx>(['trainPass', 'trainHorn', 'crossingBell', 'churchBell', 'jetHigh', 'heliPass', 'shipHorn', 'siren', 'sirenHiLo']);

/** Which baked sound a combat Sfx plays. */
function bakedFor(name: Sfx): BakedName | null {
  return META[name].combat ? (name as BakedName) : null;
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/** A pooled voice: persistent gain -> low-pass -> panner (+ reverb send) chain. */
interface Voice extends VoiceInfo {
  input: GainNode;
  lp: BiquadFilterNode;
  pan: StereoPannerNode | null;
  wet: GainNode;
  src: AudioBufferSourceNode | null;
  patch: Patch | null;
  busy: boolean;
}

interface UiVoice {
  patch: Patch;
  out: GainNode;
  level: number;
  start: number;
  end: number;
}

/** The mixing graph, independent of the context type so it can be rendered offline. */
export interface MixGraph {
  bank: Bank;
  sfxBus: GainNode;
  sfxGain: GainNode;
  sfxWetBus: GainNode;
  sfxWetGain: GainNode;
  /** start/stop fades of the music (0 or MUSIC_LEVEL) */
  musicPlay: GainNode;
  /** dips the music under announcer lines */
  musicDuck: GainNode;
  /** user music volume */
  musicGain: GainNode;
  master: GainNode;
  music: MusicEngine;
}

interface Graph extends MixGraph {
  ctx: AudioContext;
  voices: Voice[];
  ambience: Ambience;
  engines: EngineVoices;
}

/** Builds buses, reverbs, compressor and the music engine on any (also offline) context. */
export function buildAudioGraph(ctx: BaseAudioContext, sfxVol: number, musicVol: number): MixGraph {
  const bank = new Bank(ctx);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  comp.connect(master);
  master.connect(ctx.destination);

  // the music's hall
  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx, 1.4);
  const revOut = ctx.createGain();
  revOut.gain.value = 0.55;
  reverb.connect(revOut);
  revOut.connect(comp);

  // the battlefield: outdoor slap-back echoes and a terrain tail
  const outdoor = ctx.createConvolver();
  outdoor.buffer = makeOutdoorImpulse(ctx);
  const outOut = ctx.createGain();
  outOut.gain.value = 0.7;
  outdoor.connect(outOut);
  outOut.connect(comp);

  const sfxBus = ctx.createGain();
  const sfxGain = ctx.createGain();
  sfxGain.gain.value = sfxVol;
  sfxBus.connect(sfxGain);
  sfxGain.connect(comp);
  const sfxWetBus = ctx.createGain();
  const sfxWetGain = ctx.createGain();
  sfxWetGain.gain.value = sfxVol;
  sfxWetBus.connect(sfxWetGain);
  sfxWetGain.connect(outdoor);

  const musicGain = ctx.createGain();
  musicGain.gain.value = musicVol;
  musicGain.connect(comp);
  const musicWet = ctx.createGain();
  musicWet.gain.value = 0.26;
  musicGain.connect(musicWet);
  musicWet.connect(reverb);
  const musicDuck = ctx.createGain();
  musicDuck.connect(musicGain);
  const musicPlay = ctx.createGain();
  musicPlay.gain.value = 0;
  musicPlay.connect(musicDuck);

  const music = new MusicEngine(ctx, bank, musicPlay);
  return { bank, sfxBus, sfxGain, sfxWetBus, sfxWetGain, musicPlay, musicDuck, musicGain, master, music };
}

function makeVoice(ctx: BaseAudioContext, bus: AudioNode, wetBus: AudioNode): Voice {
  const input = ctx.createGain();
  input.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 20000;
  lp.Q.value = 0.5;
  input.connect(lp);
  let tail: AudioNode = lp;
  let pan: StereoPannerNode | null = null;
  if (typeof ctx.createStereoPanner === 'function') {
    pan = ctx.createStereoPanner();
    lp.connect(pan);
    tail = pan;
  }
  tail.connect(bus);
  const wet = ctx.createGain();
  wet.gain.value = 0;
  tail.connect(wet);
  wet.connect(wetBus);
  return { input, lp, pan, wet, src: null, patch: null, busy: false, name: '', level: 0, weight: 1, start: 0, end: 0 };
}

/** announcer lines that tell the score something about the battle */
const SAY_CUES: Record<string, { floor: number; hold: number; sting?: StingerKind }> = {
  'Our base is under attack': { floor: 0.55, hold: 12, sting: 'dread' },
  'Unit under attack': { floor: 0.35, hold: 8 },
  'Structure lost': { floor: 0.6, hold: 12, sting: 'dread' },
  'Ore harvester lost': { floor: 0.4, hold: 8 },
  'Mission failed': { floor: 0, hold: 0, sting: 'dread' },
};

export class AudioSystem {
  private g: Graph | null = null;
  private failed = false;
  private gestured = false;
  private uiVoices: UiVoice[] = [];
  private active: Voice[] = [];
  private lastPlay = new Map<Sfx, number>();
  private lastVariant = new Map<string, number>();
  private baked = new Map<BakedName, BakedSound>();
  private sfxVol = 0.8;
  private musicVol = 0.35;
  private voiceOn = true;
  private musicWanted = false;
  private musicMode: MusicMode = 'battle';
  private heat = new CombatHeat();
  private intensityOverride: number | null = null;
  private listener: Listener = defaultListener();
  private hasListener = false;
  private sp: Spatial = makeSpatial();
  private spFlat: Spatial = makeSpatial();
  private amb: AmbienceState = defaultAmbience();
  private nation: RadioProfile = radioFor(null);
  private ackSeed = 1;
  private lastAck = -1;
  private hiddenSuspend = false;
  private lifecycleHooked = false;
  /** Bake statistics (null while still baking). */
  bakeStats: BakeStats | null = null;

  // speech
  private speechQueue: string[] = [];
  private speaking = false;
  private lastSaid = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null = null;
  private voicesHooked = false;
  private radioBed: { patch: Patch; gain: GainNode } | null = null;

  constructor() {
    // Intentionally does nothing that touches browser globals.
  }

  get unlocked(): boolean {
    return this.g !== null && this.g.ctx.state === 'running';
  }

  /** Smoothed combat intensity 0..1 currently driving the battle music. */
  get musicIntensity(): number {
    if (this.intensityOverride !== null) return this.intensityOverride;
    const g = this.g;
    return g ? this.heat.update(g.ctx.currentTime) : this.heat.value;
  }

  /** Number of combat voices playing now (debug / tests). */
  get voiceCount(): number {
    return this.active.length;
  }

  /** Snapshot for debugging / smoke tests (no effect on playback). */
  debugState(): { state: string; voices: string[]; ui: number; baked: number; listener: Listener; ambience: AmbienceState; nation: RadioProfile } | null {
    const g = this.g;
    if (!g) return null;
    return { state: g.ctx.state, voices: this.active.map((v) => v.name), ui: this.uiVoices.length, baked: this.baked.size, listener: { ...this.listener }, ambience: { ...this.amb }, nation: this.nation };
  }

  /** How many sounds are baked so far. */
  get bakedCount(): number {
    return this.baked.size;
  }

  unlock(): void {
    if (typeof window === 'undefined') return;
    this.gestured = true;
    this.hookVoices();
    this.hookLifecycle();
    if (!this.g && !this.failed) {
      try {
        this.g = this.createGraph();
        if (this.g) this.startBake(this.g);
      } catch {
        this.failed = true;
        this.g = null;
      }
    }
    const g = this.g;
    if (!g) return;
    if (g.ctx.state !== 'running' && !(this.hiddenSuspend && document.hidden)) {
      try {
        g.ctx
          .resume()
          .then(() => this.afterResume())
          .catch(() => undefined);
      } catch {
        /* ignore */
      }
    } else {
      this.afterResume();
    }
  }

  private afterResume(): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    if (this.musicWanted && !g.music.running) this.musicOn(g);
  }

  /**
   * Phones: suspend the context while the page is hidden (saves battery, and
   * the music scheduler stops piling up), resume when it comes back; iOS can
   * leave the context 'interrupted' after a call, so any later touch resumes it.
   */
  private hookLifecycle(): void {
    if (this.lifecycleHooked || typeof document === 'undefined') return;
    this.lifecycleHooked = true;
    const resume = () => {
      const g = this.g;
      if (!g || document.hidden) return;
      this.hiddenSuspend = false;
      if (g.ctx.state !== 'running') {
        try {
          g.ctx
            .resume()
            .then(() => this.afterResume())
            .catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener('visibilitychange', () => {
      const g = this.g;
      if (!g) return;
      if (document.hidden) {
        if (g.ctx.state === 'running') {
          this.hiddenSuspend = true;
          g.ctx.suspend().catch(() => undefined);
        }
      } else {
        resume();
      }
    });
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    const onGesture = () => {
      if (this.g && this.g.ctx.state !== 'running') resume();
    };
    window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
    window.addEventListener('touchend', onGesture, { capture: true, passive: true });
    window.addEventListener('keydown', onGesture, { capture: true, passive: true });
  }

  private createGraph(): Graph | null {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC({ latencyHint: 'interactive' });
    const mix = buildAudioGraph(ctx, this.sfxVol, this.musicVol);

    // iOS: play a silent buffer inside the gesture
    try {
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
      s.onended = () => s.disconnect();
    } catch {
      /* ignore */
    }

    mix.music.setMode(this.musicMode);
    mix.music.setIntensitySource(() => this.musicIntensity);
    ctx.onstatechange = () => this.afterResume();
    const voices: Voice[] = [];
    for (let i = 0; i < MAX_VOICES; i++) voices.push(makeVoice(ctx, mix.sfxBus, mix.sfxWetBus));
    const ambience = new Ambience(ctx, mix.sfxBus);
    const engines = new EngineVoices(ctx, mix.sfxBus, (n) => this.baked.get(n as BakedName)?.buffers[0] ?? null);
    return { ...mix, ctx, voices, ambience, engines };
  }

  private startBake(g: Graph): void {
    const beds: Partial<Record<BakedName, BedName>> = { windBed: 'wind', rainBed: 'rain', riverBed: 'river', cricketBed: 'crickets' };
    void bakeAll(
      g.ctx,
      g.bank,
      (name, s) => {
        this.baked.set(name, s);
        const bed = beds[name];
        if (bed) g.ambience.setBuffer(bed, s.buffers[0]);
        if (name === 'rainBed') g.ambience.setBuffer('grit', s.buffers[0]);
      },
      () => this.g === g && g.ctx.state !== 'closed',
    ).then((st) => {
      this.bakeStats = st;
    });
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.sfxGain.gain.setTargetAtTime(this.sfxVol, now, 0.03);
    g.sfxWetGain.gain.setTargetAtTime(this.sfxVol, now, 0.03);
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    const g = this.g;
    if (!g) return;
    g.musicGain.gain.setTargetAtTime(this.musicVol, g.ctx.currentTime, 0.05);
  }

  setVoiceEnabled(on: boolean): void {
    this.voiceOn = on;
    if (!on) {
      this.speechQueue.length = 0;
      const synth = this.synth();
      if (synth && this.speaking) {
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
      }
      this.speaking = false;
      this.endRadioBed(false);
    }
  }

  /** The local player's nation: picks the radio character of acknowledgements and announcer lines. */
  setNation(nation: string | null): void {
    this.nation = radioFor(nation);
  }

  // --- listener ---------------------------------------------------------------

  /**
   * The camera, once per frame: view centre on the ground (sim x / y), the
   * screen-right unit vector on the ground, half the visible width / depth
   * (world units) and the renderer zoom.
   */
  setListener(cx: number, cy: number, rx: number, ry: number, halfW: number, halfD: number, zoom: number): void {
    const f = Number.isFinite;
    if (!(f(cx) && f(cy) && f(rx) && f(ry) && f(halfW) && f(halfD) && f(zoom))) return;
    const l = this.listener;
    l.cx = cx;
    l.cy = cy;
    const n = Math.hypot(rx, ry) || 1;
    l.rx = rx / n;
    l.ry = ry / n;
    l.halfW = Math.max(0.5, halfW);
    l.halfD = Math.max(0.5, halfD);
    l.zoom = zoom;
    this.hasListener = true;
    this.amb.zoom = zoom;
  }

  /** Spatial parameters a sound at (x, y, z) would get now (also for the scene's own use). */
  spatial(x: number, y: number, z = 0): Spatial {
    return spatialize(this.listener, x, y, z, this.sp);
  }

  // --- effects ------------------------------------------------------------------

  /**
   * Play an effect. `where` is either a world position (positional: pan,
   * distance, muffling, delay) or, as before, a plain stereo pan -1..1.
   * `panTo` sweeps the pan over the sound (flybys).
   */
  play(name: Sfx, volume = 1, where?: number | SoundPos, panTo?: number): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    const meta = META[name];
    if (!meta) return;
    const vol = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
    const now = g.ctx.currentTime;
    let sp: Spatial;
    if (where !== undefined && typeof where === 'object' && this.hasListener && Number.isFinite(where.x) && Number.isFinite(where.y)) {
      sp = spatialize(this.listener, where.x, where.y, where.z ?? 0, this.sp);
    } else {
      sp = this.spFlat;
      sp.gain = 1;
      sp.pan = typeof where === 'number' && Number.isFinite(where) ? clamp(where, -1, 1) : 0;
      sp.lp = 20000;
      sp.delay = 0;
      sp.wet = 0;
      sp.off = 0;
      sp.heat = 1;
    }
    // the score listens to the battle even when effects are muted
    if (name !== 'thunder') this.feedMusic(g, name, vol * sp.heat, now);
    if (this.sfxVol <= 0) return;
    if (!meta.combat) {
      this.playUi(g, name, vol, sp.pan);
      return;
    }
    const level = vol * meta.lvl * sp.gain;
    if (level < 0.004) return;
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < meta.gap && now >= last) return;
    if (this.startVoice(g, name, meta, level, sp, panTo)) this.lastPlay.set(name, now);
  }

  /** Thunder (atmos.onThunder): non-positional, distant ones darker and quieter. */
  thunder(v: number): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running' || this.sfxVol <= 0) return;
    const vol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    const sp = this.spFlat;
    sp.gain = 1;
    sp.pan = (Math.random() - 0.5) * 1.1;
    sp.lp = 260 + 6000 * vol * vol;
    sp.delay = 0;
    sp.wet = 0.3 * (1 - vol);
    sp.off = 0;
    sp.heat = 0;
    this.startVoice(g, 'thunder', META.thunder, vol * META.thunder.lvl, sp);
  }

  private startVoice(g: Graph, name: Sfx, meta: Meta, level: number, sp: Spatial, panTo?: number): boolean {
    const ctx = g.ctx;
    const now = ctx.currentTime;
    this.reap(now);
    const bn = bakedFor(name);
    const baked = bn ? this.baked.get(bn) : undefined;
    if (!baked && CIVIL.has(name)) return false;
    const rate = 1 + (Math.random() - 0.5) * meta.jitter;
    const t0 = now + 0.005 + sp.delay;
    const estDur = baked ? baked.dur / rate : 1.5;
    const info: VoiceInfo = { name, level, weight: meta.weight, start: t0, end: t0 + estDur };
    const slot = chooseSlot(this.active, MAX_VOICES, info, meta.cap, now);
    if (slot === -2) return false;
    let t = t0;
    if (slot >= 0) {
      this.steal(this.active[slot], now);
      t = Math.max(t, now + 0.03);
    }
    const v = g.voices.find((x) => !x.busy);
    if (!v) return false;
    v.busy = true;
    v.name = name;
    v.level = level;
    v.weight = meta.weight;
    v.start = t;
    // parameters for this sound from its start time (a stolen voice finishes its fade-out first)
    const ig = v.input.gain;
    ig.cancelScheduledValues(t);
    ig.setValueAtTime(level * (0.9 + 0.2 * Math.random()), t);
    v.lp.frequency.cancelScheduledValues(t);
    v.lp.frequency.setValueAtTime(sp.lp, t);
    if (v.pan) {
      v.pan.pan.cancelScheduledValues(t);
      v.pan.pan.setValueAtTime(clamp(sp.pan, -1, 1), t);
    }
    v.wet.gain.cancelScheduledValues(t);
    v.wet.gain.setValueAtTime(clamp(meta.wet + sp.wet * 0.5, 0, 1), t);
    if (baked) {
      const buffers = baked.buffers;
      let k = Math.floor(Math.random() * buffers.length);
      if (buffers.length > 1 && k === this.lastVariant.get(name)) k = (k + 1) % buffers.length;
      this.lastVariant.set(name, k);
      const buf = buffers[k];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(v.input);
      src.start(t);
      v.src = src;
      v.end = t + buf.duration / rate;
      src.onended = () => this.release(v, src);
    } else {
      const p = new Patch(ctx, g.bank);
      const out = p.gain(1);
      out.connect(v.input);
      LIVE[meta.live].build(p, out, t, rate);
      v.patch = p;
      v.end = p.end;
      p.onDone = () => this.release(v, null, p);
      p.finish();
    }
    if (panTo !== undefined && v.pan && Number.isFinite(panTo)) v.pan.pan.linearRampToValueAtTime(clamp(panTo, -1, 1), v.end);
    this.active.push(v);
    return true;
  }

  private release(v: Voice, src: AudioBufferSourceNode | null, patch?: Patch): void {
    if (src) {
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      if (v.src !== src) return;
      v.src = null;
    } else if (patch) {
      if (v.patch !== patch) return;
      v.patch = null;
    }
    v.busy = false;
    const i = this.active.indexOf(v);
    if (i >= 0) this.active.splice(i, 1);
  }

  /** Fade a voice out quickly and free it for the newcomer. */
  private steal(v: Voice, now: number): void {
    const gp = v.input.gain;
    try {
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(gp.value, now);
      gp.linearRampToValueAtTime(0, now + 0.02);
    } catch {
      /* ignore */
    }
    if (v.src) {
      const src = v.src;
      src.onended = () => {
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
      };
      try {
        src.stop(now + 0.025);
      } catch {
        /* ignore */
      }
      v.src = null;
    }
    if (v.patch) {
      const p = v.patch;
      p.onDone = null;
      p.kill(now + 0.025);
      setTimeout(() => p.dispose(), 200);
      v.patch = null;
    }
    v.busy = false;
    const i = this.active.indexOf(v);
    if (i >= 0) this.active.splice(i, 1);
  }

  /** Drop bookkeeping for voices whose onended never fired (context suspended, etc.). */
  private reap(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      if (v.end < now - 0.5) this.steal(v, now);
    }
    for (let i = this.uiVoices.length - 1; i >= 0; i--) {
      const v = this.uiVoices[i];
      if (v.end < now - 0.5) {
        this.uiVoices.splice(i, 1);
        v.patch.onDone = null;
        v.patch.dispose();
      }
    }
  }

  // --- UI / radio (live patches) ---------------------------------------------------

  private playUi(g: Graph, name: Sfx, vol: number, pan: number): void {
    const now = g.ctx.currentTime;
    const meta = META[name];
    if (name === 'ack' && this.voiceOn && this.gestured) {
      // unit acknowledgement over the nation's radio; rapid orders get just the squelch
      const rp = this.nation;
      const seed = this.ackSeed++ * 2654435761;
      if (now - this.lastAck > 0.9) {
        this.lastAck = now;
        this.spawnUi(g, (p, o, t) => void radioAck(p, o, t, rp, seed), 0.75 * vol, 0, 0.04);
      } else {
        this.spawnUi(g, (p, o, t) => radioOpen(p, o, t, rp), 0.5 * vol, 0, 0.02);
      }
      return;
    }
    const level = vol * meta.lvl;
    if (level < 0.005) return;
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < meta.gap && now >= last) return;
    this.lastPlay.set(name, now);
    if (name === 'squelch') {
      // just the nation's radio squelch: a soldier calling out a vehicle bearing down on him
      const rp = this.nation;
      this.spawnUi(g, (p, o, t) => radioOpen(p, o, t, rp), 0.45 * vol, pan, 0.02);
      return;
    }
    this.spawnUi(g, LIVE[meta.live].build, level, pan, meta.wet);
  }

  private spawnUi(g: Graph, build: Build, level: number, pan: number, wet: number): void {
    const ctx = g.ctx;
    const now = ctx.currentTime;
    this.reap(now);
    if (this.uiVoices.length >= MAX_UI) {
      // the oldest UI sound gives way
      const v = this.uiVoices.shift();
      if (v) {
        v.patch.onDone = null;
        try {
          v.out.gain.cancelScheduledValues(now);
          v.out.gain.setValueAtTime(v.out.gain.value, now);
          v.out.gain.linearRampToValueAtTime(0, now + 0.03);
        } catch {
          /* ignore */
        }
        v.patch.kill(now + 0.04);
        const p = v.patch;
        setTimeout(() => p.dispose(), 200);
      }
    }
    const t = now + 0.005;
    const p = new Patch(ctx, g.bank);
    const out = p.gain(level);
    let tail: AudioNode = out;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const sp = p.add(ctx.createStereoPanner());
      sp.pan.value = clamp(pan, -1, 1);
      out.connect(sp);
      tail = sp;
    }
    tail.connect(g.sfxBus);
    if (wet > 0) {
      const w = p.gain(wet);
      tail.connect(w);
      w.connect(g.sfxWetBus);
    }
    build(p, out, t, 1 + (Math.random() - 0.5) * 0.08);
    const rec: UiVoice = { patch: p, out, level, start: t, end: p.end };
    p.onDone = () => {
      const i = this.uiVoices.indexOf(rec);
      if (i >= 0) this.uiVoices.splice(i, 1);
    };
    this.uiVoices.push(rec);
    p.finish();
  }

  // --- aircraft engines and ambience ------------------------------------------------

  /**
   * Continuous engine of an aircraft in engine slot `slot` (0..3): `kind` null
   * (or vol 0) silences the slot. `rate` is the doppler factor.
   */
  setEngine(slot: number, id: number, kind: EngineKind | null, x: number, y: number, z: number, vol: number, rate: number): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running' || slot < 0 || slot >= ENGINE_SLOTS) return;
    const now = g.ctx.currentTime;
    if (!kind || !(vol > 0)) {
      g.engines.set(slot, -1, null, 0, 0, 0, 1, now);
      return;
    }
    const sp = spatialize(this.listener, x, y, z, this.sp);
    g.engines.set(slot, id, kind, vol * sp.gain, sp.pan, sp.lp, rate, now);
  }

  /** Ambience state from the battle (weather, night, river), a few times per second. */
  setAmbience(s: Partial<AmbienceState>): void {
    Object.assign(this.amb, s);
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    g.ambience.update(this.amb, g.ctx.currentTime);
  }

  /** Battle over / back to the menu: ambience and engines fade out. */
  quietScene(): void {
    this.amb.on = false;
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.ambience.silence(now);
    g.engines.silence(now);
  }

  // --- music heat -------------------------------------------------------------------

  /** Combat intensity + stingers from the effects that are being played. */
  private feedMusic(g: Graph, name: Sfx, vol: number, now: number): void {
    if (this.musicMode !== 'battle') return;
    this.heat.hit(name, vol, now);
    if (name === 'alarm') this.heat.raiseFloor(0.45, 10, now);
    if (!g.music.running) return;
    // a ballistic / hypersonic launch on screen reaches volume 1, SAMs stay at 0.75
    if ((name === 'missileLaunch' && vol >= 0.85) || (name === 'explosionLarge' && vol >= 0.92)) g.music.stinger('heavy');
    else if ((name === 'buildingCollapse' || name === 'bridgeCollapse') && vol >= 0.3) g.music.stinger('dread');
  }

  private cueMusic(text: string): void {
    const g = this.g;
    if (!g || this.musicMode !== 'battle') return;
    const now = g.ctx.currentTime;
    if (text === 'Mission accomplished') {
      this.heat.reset(now);
      return;
    }
    const cue = SAY_CUES[text];
    if (!cue) return;
    if (cue.floor > 0) this.heat.raiseFloor(cue.floor, cue.hold, now);
    if (cue.sting && g.music.running && g.ctx.state === 'running') g.music.stinger(cue.sting);
    if (text === 'Mission failed') this.heat.reset(now);
  }

  private duck(on: boolean): void {
    const g = this.g;
    if (!g) return;
    try {
      g.musicDuck.gain.setTargetAtTime(on ? 0.6 : 1, g.ctx.currentTime, on ? 0.08 : 0.5);
    } catch {
      /* ignore */
    }
  }

  // --- announcer ------------------------------------------------------------

  private synth(): SpeechSynthesis | null {
    if (typeof window === 'undefined') return null;
    try {
      if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return null;
      return window.speechSynthesis ?? null;
    } catch {
      return null;
    }
  }

  private hookVoices(): void {
    if (this.voicesHooked) return;
    const synth = this.synth();
    if (!synth) return;
    this.voicesHooked = true;
    try {
      synth.addEventListener('voiceschanged', () => {
        this.voice = null;
      });
      synth.getVoices();
    } catch {
      /* ignore */
    }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    if (this.voice) return this.voice;
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = synth.getVoices();
    } catch {
      return null;
    }
    if (!voices.length) return null;
    const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
    const prefs = [
      'samantha', 'google uk english female', 'zira', 'female', 'serena', 'karen', 'moira',
      'tessa', 'fiona', 'victoria', 'susan', 'hazel', 'libby', 'sonia', 'aria', 'jenny',
    ];
    let pick: SpeechSynthesisVoice | null = null;
    for (const pref of prefs) {
      const v = en.find((x) => x.name.toLowerCase().includes(pref));
      if (v) {
        pick = v;
        break;
      }
    }
    pick = pick ?? en.find((v) => /^en[-_]us/i.test(v.lang)) ?? en[0] ?? null;
    this.voice = pick;
    return pick;
  }

  say(text: string): void {
    if (typeof text === 'string') this.cueMusic(text);
    if (!this.voiceOn || !this.gestured || typeof text !== 'string' || !text.trim()) return;
    const now = Date.now();
    const last = this.lastSaid.get(text);
    if (last !== undefined && now - last < 4000) return;
    this.lastSaid.set(text, now);
    if (this.lastSaid.size > 64) {
      for (const [k, v] of this.lastSaid) if (now - v > 4000) this.lastSaid.delete(k);
    }
    if (!this.synth()) {
      // no speech engine: a non-verbal radio transmission instead
      const g = this.g;
      if (g && g.ctx.state === 'running' && this.sfxVol > 0) {
        const rp = this.nation;
        const seed = this.ackSeed++ * 2246822519;
        this.spawnUi(g, (p, o, t) => void radioAck(p, o, t, rp, seed), 0.6, 0, 0.04);
      }
      return;
    }
    if (this.speechQueue.includes(text)) return;
    this.speechQueue.push(text);
    while (this.speechQueue.length > 2) this.speechQueue.shift();
    if (!this.speaking) this.speakNext();
  }

  /**
   * Speech can't be routed through Web Audio, so the radio "wraps" it: the
   * squelch opens with the nation's click, static and hum sit under the line,
   * and a roger beep + squelch tail close it.
   */
  private startRadioBed(maxDur: number): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running' || this.sfxVol <= 0) return;
    this.endRadioBed(false);
    const rp = this.nation;
    const t = g.ctx.currentTime + 0.005;
    const p = new Patch(g.ctx, g.bank);
    const out = p.gain(0.55);
    out.connect(g.sfxBus);
    radioOpen(p, out, t, rp);
    const gain = radioStatic(p, out, t + 0.04, maxDur, rp);
    p.finish();
    this.radioBed = { patch: p, gain };
  }

  private endRadioBed(beep: boolean): void {
    const bed = this.radioBed;
    this.radioBed = null;
    const g = this.g;
    if (!bed || !g) return;
    const now = g.ctx.currentTime;
    try {
      bed.gain.gain.cancelScheduledValues(now);
      bed.gain.gain.setValueAtTime(bed.gain.gain.value, now);
      bed.gain.gain.linearRampToValueAtTime(0, now + 0.06);
    } catch {
      /* ignore */
    }
    bed.patch.kill(now + 0.08);
    if (beep && g.ctx.state === 'running' && this.sfxVol > 0) {
      const rp = this.nation;
      this.spawnUi(g, (p, o, t) => radioClose(p, o, t, rp), 0.55, 0, 0.03);
    }
  }

  private speakNext(): void {
    const synth = this.synth();
    const text = this.speechQueue.shift();
    if (!synth || text === undefined || !this.voiceOn) {
      this.speaking = false;
      this.duck(false);
      return;
    }
    this.speaking = true;
    this.duck(true);
    const maxMs = 2500 + text.length * 110;
    this.startRadioBed(maxMs / 1000 + 0.5);
    let done = false;
    let watchdog = 0;
    const finish = (stuck: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(watchdog);
      if (stuck) {
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
      }
      this.endRadioBed(true);
      this.speaking = false;
      window.setTimeout(() => {
        if (!this.speaking) this.speakNext();
        if (!this.speaking) this.duck(false);
      }, 260);
    };
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice(synth);
      if (v) u.voice = v;
      u.lang = v?.lang ?? 'en-US';
      u.rate = 1.0;
      u.pitch = 0.9;
      u.volume = clamp(this.sfxVol * 1.25, 0, 1);
      u.onend = () => finish(false);
      u.onerror = () => finish(false);
      watchdog = window.setTimeout(() => finish(true), maxMs);
      window.setTimeout(() => {
        if (done) return;
        try {
          synth.speak(u);
        } catch {
          finish(false);
        }
      }, 120);
    } catch {
      finish(false);
    }
  }

  // --- music ----------------------------------------------------------------

  private musicOn(g: Graph): void {
    const now = g.ctx.currentTime;
    g.music.setMode(this.musicMode);
    g.music.start();
    const pg = g.musicPlay.gain;
    pg.cancelScheduledValues(now);
    pg.setValueAtTime(pg.value, now);
    pg.linearRampToValueAtTime(MUSIC_LEVEL, now + 0.05);
  }

  startMusic(): void {
    this.musicWanted = true;
    const g = this.g;
    if (this.musicMode === 'battle') this.heat.reset(g ? g.ctx.currentTime : undefined);
    if (!g || g.ctx.state !== 'running') return;
    this.musicOn(g);
  }

  stopMusic(): void {
    this.musicWanted = false;
    const g = this.g;
    if (!g) return;
    g.music.stop();
    const now = g.ctx.currentTime;
    const pg = g.musicPlay.gain;
    pg.cancelScheduledValues(now);
    pg.setValueAtTime(pg.value, now);
    pg.setTargetAtTime(0, now, 0.12);
  }

  /** One battle-music stinger (cinematic intro / outro); rate-limited by the music engine. */
  sting(kind: StingerKind = 'heavy'): void {
    const g = this.g;
    if (!g || this.musicMode !== 'battle' || !g.music.running || g.ctx.state !== 'running') return;
    g.music.stinger(kind);
  }

  setMusicMode(mode: 'menu' | 'battle'): void {
    if (mode !== 'menu' && mode !== 'battle') return;
    // every battle starts from calm
    if (mode === 'battle' && this.musicMode !== 'battle') this.heat.reset(this.g ? this.g.ctx.currentTime : undefined);
    this.musicMode = mode;
    if (this.g) this.g.music.setMode(mode);
    if (mode === 'menu') this.quietScene();
  }

  /**
   * Optional: drive the battle music's combat intensity (0..1) directly.
   * Pass null to return to the automatic estimate derived from the effects.
   */
  setMusicIntensity(x: number | null): void {
    this.intensityOverride = x === null || !Number.isFinite(x) ? null : clamp(x, 0, 1);
  }
}
