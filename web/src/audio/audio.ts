/**
 * Procedural sound system: every effect, the announcer radio chatter and the
 * background music are synthesized at runtime with the Web Audio API.
 * There are no audio asset files.
 *
 * Graph:
 *   voice -> [panner] -> sfxBus -> sfxGain ----------------\
 *                     \-> wetSend -> sfxWetBus -> sfxWetGain -> reverb -\
 *   music notes -> modeBus(battle|menu) -> musicPlay -> musicGain ------+-> compressor -> master -> destination
 *                                                      \-> musicWet -> reverb
 */

export type Sfx =
  | 'rifle' | 'mg' | 'cannon' | 'cannonHeavy' | 'rocket' | 'missileLaunch' | 'flak' | 'laser'
  | 'artillery' | 'thermo' | 'explosionSmall' | 'explosionMedium' | 'explosionLarge' | 'buildingCollapse'
  | 'intercept' | 'droneLaunch' | 'droneBuzz' | 'click' | 'tab' | 'build' | 'place' | 'sell' | 'error'
  | 'select' | 'ack' | 'alarm' | 'money' | 'deploy' | 'repair' | 'jam';

type MusicMode = 'menu' | 'battle';
type NoiseKind = 'white' | 'pink' | 'brown';

const MAX_VOICES = 24;
const LOOKAHEAD = 0.12;
/** internal music mix level (before the user music volume) */
const MUSIC_LEVEL = 0.45;
const TICK_MS = 25;

/** Maps a screen x coordinate to a stereo pan in -0.8..0.8. */
export function panFor(screenX: number, screenWidth: number): number {
  if (!(screenWidth > 0) || !Number.isFinite(screenX)) return 0;
  const x = clamp(screenX / screenWidth, 0, 1);
  return (x * 2 - 1) * 0.8;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Shared buffers (generated once per context)
// ---------------------------------------------------------------------------

function makeCurve(drive: number) {
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / norm;
  }
  return c;
}

function makeCrushCurve(levels: number) {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

type Curve = ReturnType<typeof makeCurve>;

class Bank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly crush: Curve;
  private curves = new Map<number, Curve>();

  constructor(ctx: BaseAudioContext) {
    const len = Math.floor(ctx.sampleRate * 2);
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    this.pink = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0);
    const p = this.pink.getChannelData(0);
    const b = this.brown.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const x = Math.random() * 2 - 1;
      w[i] = x;
      b0 = 0.99886 * b0 + x * 0.0555179;
      b1 = 0.99332 * b1 + x * 0.0750759;
      b2 = 0.969 * b2 + x * 0.153852;
      b3 = 0.8665 * b3 + x * 0.3104856;
      b4 = 0.55 * b4 + x * 0.5329522;
      b5 = -0.7616 * b5 - x * 0.016898;
      p[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
      b6 = x * 0.115926;
      last = (last + 0.02 * x) / 1.02;
      b[i] = last;
    }
    // Make the coloured noises loop without a step at the wrap point, then level-match.
    for (const d of [p, b]) {
      const drift = d[len - 1] - d[0];
      for (let i = 0; i < len; i++) d[i] -= (drift * i) / (len - 1);
    }
    for (const d of [w, p, b]) normalizeRms(d, 0.33);
    this.crush = makeCrushCurve(5);
  }

  buffer(kind: NoiseKind): AudioBuffer {
    return kind === 'white' ? this.white : kind === 'pink' ? this.pink : this.brown;
  }

  curve(drive: number): Curve {
    const key = Math.round(drive * 10) / 10;
    let c = this.curves.get(key);
    if (!c) {
      c = makeCurve(Math.max(0.1, key));
      this.curves.set(key, c);
    }
    return c;
  }
}

function normalizeRms(d: Float32Array, target: number): void {
  let mean = 0;
  for (let i = 0; i < d.length; i++) mean += d[i];
  mean /= d.length;
  let sq = 0;
  for (let i = 0; i < d.length; i++) {
    d[i] -= mean;
    sq += d[i] * d[i];
  }
  const rms = Math.sqrt(sq / d.length) || 1;
  const k = target / rms;
  for (let i = 0; i < d.length; i++) d[i] = clamp(d[i] * k, -1, 1);
}

function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.012);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      if (i < pre) {
        d[i] = 0;
        continue;
      }
      const k = (i - pre) / (len - pre);
      const x = (Math.random() * 2 - 1) * Math.pow(1 - k, 2.6);
      // progressively darker tail
      y += (0.55 - 0.45 * k) * (x - y);
      d[i] = y;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function env(p: AudioParam, t: number, peak: number, a: number, hold: number, d: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (hold > 0) p.setValueAtTime(peak, t + a + hold);
  p.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
}

function glide(p: AudioParam, t: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(Math.max(from, 0.01), t);
  p.exponentialRampToValueAtTime(Math.max(to, 0.01), t + Math.max(dur, 0.002));
}

/** Short spikes on a gain param (crackles, ratchets, claps). Times must be ascending. */
function spikes(p: AudioParam, times: number[], peaks: number[], tau: number): void {
  for (let i = 0; i < times.length; i++) {
    p.setValueAtTime(peaks[i], times[i]);
    p.setTargetAtTime(0, times[i] + 0.001, tau);
  }
}

interface NoiseOpts {
  kind?: NoiseKind;
  type?: BiquadFilterType;
  f: number;
  f2?: number;
  sweep?: number;
  q?: number;
  a?: number;
  hold?: number;
  d: number;
  peak: number;
  rate?: number;
  drive?: number;
}

interface ToneOpts {
  type?: OscillatorType;
  f: number;
  f2?: number;
  glide?: number;
  a?: number;
  hold?: number;
  d: number;
  peak: number;
  detune?: number;
  lp?: number;
  drive?: number;
}

/**
 * A set of nodes making up one sound. Tracks every node so it can all be
 * disconnected once the longest-running source has ended.
 */
class Patch {
  private nodes: AudioNode[] = [];
  private srcs: AudioScheduledSourceNode[] = [];
  private lastSrc: AudioScheduledSourceNode | null = null;
  private disposed = false;
  end = 0;
  onDone: (() => void) | null = null;

  constructor(readonly ctx: AudioContext, readonly bank: Bank) {}

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  gain(v = 0): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, f: number, q = 0.707): BiquadFilterNode {
    const n = this.add(this.ctx.createBiquadFilter());
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    return n;
  }

  shaper(drive: number): WaveShaperNode {
    const s = this.add(this.ctx.createWaveShaper());
    s.curve = this.bank.curve(drive);
    return s;
  }

  crusher(): WaveShaperNode {
    const s = this.add(this.ctx.createWaveShaper());
    s.curve = this.bank.crush;
    return s;
  }

  osc(type: OscillatorType, f: number, t0: number, t1: number): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = f;
    this.sched(o, t0, t1, 0);
    return o;
  }

  noise(kind: NoiseKind, t0: number, t1: number, rate = 1): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    const buf = this.bank.buffer(kind);
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    this.sched(s, t0, t1, Math.random() * (buf.duration - 0.05));
    return s;
  }

  private sched(s: AudioScheduledSourceNode, t0: number, t1: number, offset: number): void {
    if (s instanceof AudioBufferSourceNode) s.start(t0, offset);
    else s.start(t0);
    s.stop(t1);
    this.srcs.push(s);
    if (t1 >= this.end) {
      this.end = t1;
      this.lastSrc = s;
    }
  }

  /** Filtered noise burst with an envelope. */
  nh(dest: AudioNode, t: number, o: NoiseOpts): GainNode {
    const a = Math.max(0.001, o.a ?? 0.001);
    const hold = o.hold ?? 0;
    const end = t + a + hold + o.d;
    const src = this.noise(o.kind ?? 'white', t, end + 0.03, o.rate ?? 1);
    const f = this.filter(o.type ?? 'bandpass', o.f, o.q ?? 0.8);
    if (o.f2 !== undefined) glide(f.frequency, t, o.f, o.f2, o.sweep ?? a + hold + o.d);
    const g = this.gain(0);
    env(g.gain, t, o.peak, a, hold, o.d);
    src.connect(f);
    if (o.drive) {
      const s = this.shaper(o.drive);
      f.connect(s);
      s.connect(g);
    } else {
      f.connect(g);
    }
    g.connect(dest);
    return g;
  }

  /** Oscillator tone with optional pitch glide, drive and lowpass. */
  th(dest: AudioNode, t: number, o: ToneOpts): OscillatorNode {
    const a = Math.max(0.001, o.a ?? 0.002);
    const hold = o.hold ?? 0;
    const end = t + a + hold + o.d;
    const osc = this.osc(o.type ?? 'sine', o.f, t, end + 0.03);
    if (o.detune) osc.detune.value = o.detune;
    if (o.f2 !== undefined) glide(osc.frequency, t, o.f, o.f2, o.glide ?? a + hold + o.d);
    let n: AudioNode = osc;
    if (o.drive) {
      const s = this.shaper(o.drive);
      n.connect(s);
      n = s;
    }
    if (o.lp) {
      const f = this.filter('lowpass', o.lp, 0.7);
      n.connect(f);
      n = f;
    }
    const g = this.gain(0);
    env(g.gain, t, o.peak, a, hold, o.d);
    n.connect(g);
    g.connect(dest);
    return osc;
  }

  /** Random crackles: one noise source gated by short spikes. */
  crackle(dest: AudioNode, t: number, dur: number, count: number, f: number, peak: number): void {
    const src = this.noise('white', t, t + dur + 0.1);
    const bp = this.filter('bandpass', f, 1.4);
    const g = this.gain(0);
    const times: number[] = [];
    for (let i = 0; i < count; i++) times.push(t + Math.random() * dur);
    times.sort((x, y) => x - y);
    const peaks = times.map(() => peak * (0.35 + 0.65 * Math.random()));
    spikes(g.gain, times, peaks, 0.006 + Math.random() * 0.01);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
  }

  /** Arm cleanup once all sources are scheduled. */
  finish(): void {
    if (!this.lastSrc) {
      this.dispose();
      return;
    }
    this.lastSrc.onended = () => this.dispose();
  }

  /** Stop all sources early (voice stealing). */
  kill(at: number): void {
    for (const s of this.srcs) {
      try {
        s.stop(at);
      } catch {
        /* already stopped */
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const s of this.srcs) s.onended = null;
    this.nodes.length = 0;
    this.srcs.length = 0;
    this.lastSrc = null;
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }
}

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------

type Build = (p: Patch, o: AudioNode, t: number, r: number) => void;

interface SfxDef {
  /** base level */
  lvl: number;
  /** reverb send */
  wet: number;
  /** minimum interval between identical sounds, seconds */
  gap: number;
  build: Build;
}

function bigBoom(p: Patch, o: AudioNode, t: number, r: number): void {
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2100 * r, f2: 120, sweep: 1.2, q: 0.9, d: 1.35, peak: 1, drive: 2.5 });
  p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 450, f2: 150, sweep: 1.3, a: 0.02, d: 1.4, peak: 0.9 });
  p.th(o, t, { f: 70 * r, f2: 25, glide: 0.9, d: 1.1, peak: 1, drive: 2 });
  p.nh(o, t, { type: 'bandpass', f: 1600, q: 1, d: 0.05, peak: 0.5 });
  p.crackle(o, t + 0.08, 0.9, 7, 2500, 0.25);
}

const SFX: Record<Sfx, SfxDef> = {
  rifle: {
    lvl: 0.55, wet: 0.1, gap: 0.045,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 2600 * r, q: 0.9, d: 0.055, peak: 0.9 });
      p.nh(o, t, { type: 'highpass', f: 5000, d: 0.018, peak: 0.22 });
      p.th(o, t, { f: 170 * r, f2: 60, glide: 0.05, d: 0.06, peak: 0.55 });
    },
  },
  mg: {
    lvl: 0.47, wet: 0.08, gap: 0.04,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 1800 * r, q: 1, d: 0.04, peak: 0.85 });
      p.nh(o, t, { type: 'highpass', f: 4000, d: 0.012, peak: 0.18 });
      p.th(o, t, { f: 140 * r, f2: 55, glide: 0.04, d: 0.045, peak: 0.5 });
    },
  },
  flak: {
    lvl: 0.5, wet: 0.12, gap: 0.045,
    build(p, o, t, r) {
      p.th(o, t, { f: 240 * r, f2: 75, glide: 0.08, d: 0.13, peak: 0.9, drive: 2 });
      p.nh(o, t, { type: 'bandpass', f: 1300 * r, q: 1.2, d: 0.06, peak: 0.6 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 700, d: 0.16, peak: 0.45 });
    },
  },
  cannon: {
    lvl: 0.7, wet: 0.18, gap: 0.05,
    build(p, o, t, r) {
      p.th(o, t, { f: 120 * r, f2: 40, glide: 0.25, d: 0.5, peak: 1, drive: 1.5 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 1200 * r, f2: 180, sweep: 0.4, d: 0.55, peak: 0.9 });
      p.nh(o, t, { type: 'bandpass', f: 1600, q: 1, d: 0.03, peak: 0.5 });
    },
  },
  cannonHeavy: {
    lvl: 0.8, wet: 0.2, gap: 0.06,
    build(p, o, t, r) {
      p.th(o, t, { f: 100 * r, f2: 30, glide: 0.45, d: 0.9, peak: 1, drive: 2.5 });
      p.th(o, t, { type: 'triangle', f: 55, f2: 28, glide: 0.6, d: 0.9, peak: 0.5 });
      p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 900 * r, f2: 120, sweep: 0.8, d: 1.0, peak: 1, drive: 1.5 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2500, f2: 400, sweep: 0.25, d: 0.25, peak: 0.6 });
      p.nh(o, t, { type: 'bandpass', f: 1400, q: 1, d: 0.04, peak: 0.55 });
    },
  },
  rocket: {
    lvl: 0.65, wet: 0.15, gap: 0.05,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 1100, q: 1, d: 0.04, peak: 0.6 });
      p.th(o, t, { f: 220 * r, f2: 80, glide: 0.06, d: 0.07, peak: 0.5 });
      p.nh(o, t, { type: 'bandpass', f: 600 * r, f2: 2600 * r, sweep: 0.45, q: 2.2, a: 0.04, d: 0.5, peak: 0.55 });
    },
  },
  missileLaunch: {
    lvl: 0.65, wet: 0.2, gap: 0.08,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 1000, q: 1, d: 0.05, peak: 0.7 });
      p.th(o, t, { f: 200 * r, f2: 70, glide: 0.08, d: 0.1, peak: 0.6 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 350, f2: 1800 * r, sweep: 1.0, q: 1.5, a: 0.1, d: 1.1, peak: 0.9, drive: 2 });
      p.nh(o, t, { type: 'bandpass', f: 500, f2: 3200 * r, sweep: 1.1, q: 2.5, a: 0.15, d: 1.0, peak: 0.4 });
      p.th(o, t, { type: 'triangle', f: 55, f2: 85, glide: 1.0, a: 0.1, d: 1.0, peak: 0.3 });
    },
  },
  laser: {
    lvl: 0.45, wet: 0.22, gap: 0.05,
    build(p, o, t, r) {
      const lp = p.filter('lowpass', 3200, 1.2);
      lp.connect(o);
      p.th(lp, t, { type: 'sawtooth', f: 2500 * r, f2: 280, glide: 0.2, a: 0.003, d: 0.28, peak: 0.2 });
      p.th(lp, t, { type: 'sine', f: 2500 * r, f2: 280, glide: 0.2, a: 0.003, d: 0.3, peak: 0.32, detune: 14 });
      p.th(lp, t, { type: 'sine', f: 1250 * r, f2: 140, glide: 0.22, a: 0.003, d: 0.25, peak: 0.18, detune: -9 });
    },
  },
  artillery: {
    lvl: 0.75, wet: 0.3, gap: 0.06,
    build(p, o, t, r) {
      const lp = p.filter('lowpass', 420 * r, 0.7);
      lp.connect(o);
      p.th(lp, t, { f: 75 * r, f2: 30, glide: 0.6, d: 1.0, peak: 1, drive: 1.5 });
      p.nh(lp, t, { kind: 'brown', type: 'lowpass', f: 600, f2: 120, sweep: 0.9, a: 0.01, d: 1.1, peak: 1 });
      p.nh(lp, t, { kind: 'pink', type: 'lowpass', f: 1500, f2: 300, sweep: 0.3, d: 0.3, peak: 0.45 });
    },
  },
  thermo: {
    lvl: 0.6, wet: 0.2, gap: 0.08,
    build(p, o, t, r) {
      for (let i = 0; i < 4; i++) {
        const ti = t + i * 0.075 + Math.random() * 0.015;
        p.th(o, ti, { f: 160 * r, f2: 50, glide: 0.09, d: 0.12, peak: 0.8 });
        p.nh(o, ti, { type: 'bandpass', f: 900 + i * 60, q: 1, d: 0.05, peak: 0.5 });
      }
      p.nh(o, t, { type: 'bandpass', f: 700, f2: 2400, sweep: 0.5, q: 1.8, a: 0.05, d: 0.55, peak: 0.35 });
    },
  },
  explosionSmall: {
    lvl: 0.6, wet: 0.18, gap: 0.045,
    build(p, o, t, r) {
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2600 * r, f2: 280, sweep: 0.35, d: 0.4, peak: 0.9 });
      p.th(o, t, { f: 95 * r, f2: 35, glide: 0.25, d: 0.3, peak: 0.7 });
      p.nh(o, t, { type: 'bandpass', f: 1900, q: 1, d: 0.035, peak: 0.4 });
    },
  },
  explosionMedium: {
    lvl: 0.75, wet: 0.22, gap: 0.05,
    build(p, o, t, r) {
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2300 * r, f2: 190, sweep: 0.7, d: 0.8, peak: 1, drive: 1.5 });
      p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 500, a: 0.01, d: 1.0, peak: 0.7 });
      p.th(o, t, { f: 80 * r, f2: 30, glide: 0.5, d: 0.65, peak: 0.9, drive: 1.5 });
      p.nh(o, t, { type: 'bandpass', f: 1700, q: 1, d: 0.04, peak: 0.45 });
    },
  },
  explosionLarge: {
    lvl: 0.9, wet: 0.28, gap: 0.06,
    build: bigBoom,
  },
  buildingCollapse: {
    lvl: 0.95, wet: 0.3, gap: 0.2,
    build(p, o, t, r) {
      bigBoom(p, o, t, r);
      // rumbling debris
      const src = p.noise('brown', t, t + 2.6);
      const lp = p.filter('lowpass', 260, 1);
      glide(lp.frequency, t, 300, 140, 2.4);
      const g = p.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.85, t + 0.35);
      g.gain.setValueAtTime(0.85, t + 1.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
      src.connect(lp);
      lp.connect(g);
      g.connect(o);
      p.crackle(o, t + 0.3, 2.0, 14, 3000, 0.2);
      for (let i = 0; i < 4; i++) {
        const ti = t + 0.4 + Math.random() * 1.6;
        p.th(o, ti, { f: 75 + Math.random() * 20, f2: 35, glide: 0.12, d: 0.15, peak: 0.4 + Math.random() * 0.2 });
      }
    },
  },
  intercept: {
    lvl: 0.6, wet: 0.15, gap: 0.05,
    build(p, o, t, r) {
      p.th(o, t, { f: 3150 * r, a: 0.001, d: 0.11, peak: 0.2 });
      p.th(o, t, { f: 4630 * r, a: 0.001, d: 0.08, peak: 0.1 });
      p.th(o, t, { type: 'triangle', f: 2120 * r, a: 0.001, d: 0.14, peak: 0.15 });
      p.nh(o, t + 0.015, { type: 'bandpass', f: 1400, q: 1, d: 0.05, peak: 0.5 });
      p.th(o, t + 0.015, { f: 300, f2: 110, glide: 0.05, d: 0.07, peak: 0.45 });
    },
  },
  droneLaunch: {
    lvl: 0.5, wet: 0.15, gap: 0.1,
    build(p, o, t, r) {
      const end = t + 1.05;
      const bp = p.filter('bandpass', 700, 1.4);
      glide(bp.frequency, t, 700, 1500, 0.8);
      const trem = p.gain(0.65);
      const lfo = p.osc('sine', 26, t, end);
      const depth = p.gain(0.3);
      lfo.connect(depth);
      depth.connect(trem.gain);
      const e = p.gain(0);
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(0.5, t + 0.12);
      e.gain.linearRampToValueAtTime(0.45, t + 0.75);
      e.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      for (const det of [0, 12]) {
        const s = p.osc('sawtooth', 180 * r, t, end);
        s.detune.value = det;
        glide(s.frequency, t, 180 * r, 420 * r, 0.8);
        s.connect(bp);
      }
      bp.connect(trem);
      trem.connect(e);
      e.connect(o);
      p.nh(o, t, { type: 'bandpass', f: 1500, f2: 3000, q: 1.5, a: 0.1, d: 0.6, peak: 0.12 });
    },
  },
  droneBuzz: {
    lvl: 0.35, wet: 0.08, gap: 0.08,
    build(p, o, t, r) {
      const end = t + 0.3;
      const bp = p.filter('bandpass', 1100, 1.2);
      const trem = p.gain(0.65);
      const lfo = p.osc('sine', 32, t, end);
      const depth = p.gain(0.35);
      lfo.connect(depth);
      depth.connect(trem.gain);
      const e = p.gain(0);
      env(e.gain, t, 0.45, 0.03, 0.05, 0.17);
      p.osc('sawtooth', 250 * r, t, end).connect(bp);
      p.osc('sawtooth', 253 * r, t, end).connect(bp);
      bp.connect(trem);
      trem.connect(e);
      e.connect(o);
    },
  },
  jam: {
    lvl: 0.4, wet: 0.08, gap: 0.08,
    build(p, o, t) {
      const dur = 0.4;
      const end = t + dur + 0.05;
      const sq = p.osc('square', 600, t, end);
      const sg = p.gain(0);
      const noise = p.noise('white', t, end);
      const nbp = p.filter('bandpass', 2800, 0.6);
      const ng = p.gain(0);
      const steps = 18;
      for (let i = 0; i < steps; i++) {
        const ti = t + i * (dur / steps);
        sq.frequency.setValueAtTime(200 + Math.random() * 1800, ti);
        sg.gain.setValueAtTime(Math.random() < 0.7 ? 0.25 + Math.random() * 0.25 : 0, ti);
        ng.gain.setValueAtTime(Math.random() < 0.6 ? 0.4 + Math.random() * 0.6 : 0.05, ti);
      }
      sg.gain.setValueAtTime(0, t + dur);
      ng.gain.setValueAtTime(0, t + dur);
      sq.connect(sg);
      noise.connect(nbp);
      nbp.connect(ng);
      const crush = p.crusher();
      const hp = p.filter('highpass', 350, 0.7);
      const lp = p.filter('lowpass', 4500, 0.7);
      const e = p.gain(0);
      env(e.gain, t, 0.45, 0.005, dur - 0.06, 0.05);
      sg.connect(crush);
      ng.connect(crush);
      crush.connect(hp);
      hp.connect(lp);
      lp.connect(e);
      e.connect(o);
    },
  },
  click: {
    lvl: 0.55, wet: 0, gap: 0.03,
    build(p, o, t, r) {
      p.th(o, t, { type: 'triangle', f: 1500 * r, f2: 1100, glide: 0.012, a: 0.001, d: 0.025, peak: 0.35 });
      p.nh(o, t, { type: 'highpass', f: 4000, d: 0.008, peak: 0.12 });
    },
  },
  tab: {
    lvl: 0.55, wet: 0, gap: 0.03,
    build(p, o, t, r) {
      p.th(o, t, { type: 'triangle', f: 950 * r, f2: 750, glide: 0.02, a: 0.001, d: 0.04, peak: 0.35 });
      p.nh(o, t, { type: 'bandpass', f: 2400, q: 2, d: 0.01, peak: 0.15 });
    },
  },
  build: {
    lvl: 0.6, wet: 0.05, gap: 0.05,
    build(p, o, t) {
      [660, 990].forEach((f, i) => {
        const ti = t + i * 0.085;
        p.th(o, ti, { type: 'square', f, lp: 2400, a: 0.004, hold: 0.03, d: 0.1, peak: 0.13 });
        p.th(o, ti, { type: 'triangle', f, a: 0.004, hold: 0.03, d: 0.12, peak: 0.22 });
      });
    },
  },
  place: {
    lvl: 0.6, wet: 0.08, gap: 0.06,
    build(p, o, t, r) {
      p.th(o, t, { f: 120 * r, f2: 45, glide: 0.12, d: 0.18, peak: 0.9 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 500, d: 0.1, peak: 0.5 });
      const tc = t + 0.055;
      p.nh(o, tc, { type: 'bandpass', f: 2300 * r, q: 7, d: 0.07, peak: 0.6 });
      p.th(o, tc, { type: 'square', f: 330 * r, lp: 1500, d: 0.06, peak: 0.12 });
      p.th(o, tc, { type: 'square', f: 517 * r, lp: 1800, d: 0.05, peak: 0.09 });
    },
  },
  sell: {
    lvl: 0.6, wet: 0.05, gap: 0.08,
    build(p, o, t) {
      [1318, 1046, 880, 659].forEach((f, i) => {
        const ti = t + i * 0.06;
        p.th(o, ti, { type: 'square', f, lp: 3000, a: 0.002, hold: 0.015, d: 0.04, peak: 0.12 });
        p.th(o, ti, { type: 'triangle', f, a: 0.002, hold: 0.015, d: 0.06, peak: 0.18 });
      });
      p.nh(o, t + 0.25, { type: 'bandpass', f: 5000, q: 3, d: 0.08, peak: 0.15 });
      p.th(o, t + 0.25, { f: 2637, d: 0.25, peak: 0.07 });
    },
  },
  error: {
    lvl: 0.5, wet: 0, gap: 0.12,
    build(p, o, t) {
      for (let i = 0; i < 2; i++) {
        const ti = t + i * 0.15;
        p.th(o, ti, { type: 'square', f: 170, lp: 1100, a: 0.005, hold: 0.09, d: 0.025, peak: 0.25 });
        p.th(o, ti, { type: 'sawtooth', f: 171.5, lp: 900, a: 0.005, hold: 0.09, d: 0.025, peak: 0.12 });
      }
    },
  },
  select: {
    lvl: 0.6, wet: 0, gap: 0.04,
    build(p, o, t, r) {
      p.th(o, t, { f: 950 * r, f2: 1500 * r, glide: 0.045, a: 0.004, d: 0.06, peak: 0.3 });
      p.th(o, t, { type: 'triangle', f: 475 * r, f2: 750 * r, glide: 0.045, a: 0.004, d: 0.05, peak: 0.1 });
    },
  },
  ack: {
    lvl: 0.6, wet: 0.03, gap: 0.06,
    build(p, o, t, r) {
      const hp = p.filter('highpass', 450, 0.7);
      const sh = p.shaper(3);
      const lp = p.filter('lowpass', 3200, 0.7);
      const pre = p.gain(0.6);
      pre.connect(hp);
      hp.connect(sh);
      sh.connect(lp);
      lp.connect(o);
      p.nh(pre, t, { type: 'bandpass', f: 2200, q: 0.7, d: 0.05, peak: 0.35 });
      p.th(pre, t, { type: 'square', f: 1250 * r, f2: 1700 * r, glide: 0.04, a: 0.003, hold: 0.03, d: 0.02, peak: 0.12 });
      p.th(pre, t + 0.075, { type: 'square', f: 1550 * r, f2: 2050 * r, glide: 0.04, a: 0.003, hold: 0.03, d: 0.02, peak: 0.12 });
      p.nh(pre, t + 0.13, { type: 'bandpass', f: 2000, q: 0.7, d: 0.06, peak: 0.25 });
    },
  },
  alarm: {
    lvl: 0.5, wet: 0.08, gap: 0.9,
    build(p, o, t) {
      const end = t + 1.1;
      const lp = p.filter('lowpass', 2000, 1);
      const sh = p.shaper(1.5);
      const e = p.gain(0);
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(0.3, t + 0.02);
      e.gain.setValueAtTime(0.3, t + 0.95);
      e.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
      const lfo = p.osc('sine', 7, t, end);
      const vib = p.gain(15);
      lfo.connect(vib);
      const freqs = [620, 465, 620, 465];
      for (const [type, mul, lvl] of [['sawtooth', 1, 1], ['square', 0.5, 0.5]] as const) {
        const s = p.osc(type, freqs[0] * mul, t, end);
        freqs.forEach((f, i) => {
          const ti = t + i * 0.25;
          s.frequency.setValueAtTime((i === 0 ? f : freqs[i - 1]) * mul, ti);
          s.frequency.linearRampToValueAtTime(f * mul, ti + 0.02);
        });
        vib.connect(s.detune);
        const g = p.gain(lvl);
        s.connect(g);
        g.connect(sh);
      }
      sh.connect(lp);
      lp.connect(e);
      e.connect(o);
    },
  },
  money: {
    lvl: 0.6, wet: 0.04, gap: 0.05,
    build(p, o, t) {
      p.th(o, t, { type: 'square', f: 988, lp: 4000, a: 0.002, hold: 0.05, d: 0.02, peak: 0.13 });
      p.th(o, t, { type: 'triangle', f: 988, a: 0.002, hold: 0.05, d: 0.02, peak: 0.15 });
      p.th(o, t + 0.06, { type: 'square', f: 1319, lp: 4000, a: 0.002, d: 0.2, peak: 0.13 });
      p.th(o, t + 0.06, { type: 'triangle', f: 1319, a: 0.002, d: 0.22, peak: 0.15 });
    },
  },
  deploy: {
    lvl: 0.5, wet: 0.1, gap: 0.1,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 3500 * r, f2: 2000, sweep: 0.45, q: 0.8, a: 0.04, hold: 0.25, d: 0.2, peak: 0.3 });
      p.th(o, t, { type: 'sawtooth', f: 90, f2: 70, glide: 0.4, lp: 400, a: 0.05, hold: 0.3, d: 0.1, peak: 0.15 });
      const tc = t + 0.5;
      p.th(o, tc, { f: 150 * r, f2: 55, glide: 0.1, d: 0.14, peak: 0.9 });
      p.nh(o, tc, { type: 'bandpass', f: 1000, q: 3, d: 0.06, peak: 0.45 });
      p.th(o, tc, { type: 'square', f: 280 * r, lp: 1400, d: 0.05, peak: 0.1 });
    },
  },
  repair: {
    lvl: 0.65, wet: 0.05, gap: 0.1,
    build(p, o, t, r) {
      const n = 7;
      const times: number[] = [];
      const pk: number[] = [];
      const pk2: number[] = [];
      for (let i = 0; i < n; i++) {
        times.push(t + i * 0.045);
        pk.push(i % 2 ? 0.5 : 0.8);
        pk2.push(i % 2 ? 0.06 : 0.12);
      }
      const end = t + n * 0.045 + 0.1;
      const src = p.noise('white', t, end);
      const bp = p.filter('bandpass', 3600 * r, 4);
      const g = p.gain(0);
      spikes(g.gain, times, pk, 0.006);
      src.connect(bp);
      bp.connect(g);
      g.connect(o);
      const tri = p.osc('triangle', 2700 * r, t, end);
      const g2 = p.gain(0);
      spikes(g2.gain, times, pk2, 0.01);
      tri.connect(g2);
      g2.connect(o);
      const tc = t + 0.34;
      p.th(o, tc, { type: 'square', f: 600 * r, lp: 2000, d: 0.06, peak: 0.08 });
      p.nh(o, tc, { type: 'bandpass', f: 2000, q: 5, d: 0.05, peak: 0.4 });
    },
  },
};

/** Radio blip + squelch played before announcer lines. */
const radioBlip: Build = (p, o, t) => {
  const hp = p.filter('highpass', 500, 0.7);
  const lp = p.filter('lowpass', 3000, 0.7);
  const sh = p.shaper(2.5);
  hp.connect(sh);
  sh.connect(lp);
  lp.connect(o);
  p.th(hp, t, { f: 1350, a: 0.002, hold: 0.035, d: 0.02, peak: 0.25 });
  p.nh(hp, t + 0.06, { type: 'bandpass', f: 1800, q: 0.6, a: 0.005, d: 0.11, peak: 0.12 });
};

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

type Riff = (number | null)[];
const R1: Riff = [0, null, 0, 0, 12, null, 0, 0, 0, null, 0, 0, 10, null, 7, null];
const R2: Riff = [0, 0, null, 0, 0, 12, null, 0, 3, null, 0, 0, 7, null, 5, 3];
const R3: Riff = [0, null, null, null, 0, null, null, 0, null, null, 0, null, 12, null, 10, null];
const BASS_FILL = [0, 3, 5, 7];

/** chord roots (semitones from E) per bar, 4-bar cycle, one per section */
const BATTLE_PROG = [
  [0, 0, -4, -2],
  [0, 3, -4, -2],
  [0, 0, -4, -2],
  [0, -4, -7, -2],
];

/** 2-bar lead phrases: [step 0..31, semitone from E4, length in steps] */
type Phrase = [number, number, number][];
const M1: Phrase = [
  [0, 7, 3], [3, 7, 1], [4, 10, 2], [6, 12, 4], [10, 10, 2], [12, 7, 4],
  [16, 8, 3], [19, 7, 3], [22, 5, 2], [24, 3, 4], [28, 2, 2], [30, 3, 2],
];
const M2: Phrase = [
  [0, 12, 2], [2, 15, 2], [4, 14, 4], [8, 12, 2], [10, 10, 2], [12, 12, 4],
  [16, 7, 6], [22, 8, 2], [24, 7, 4], [28, 3, 4],
];

function phraseMap(ph: Phrase): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  for (const [s, n, l] of ph) m.set(s, [n, l]);
  return m;
}
const M1_MAP = phraseMap(M1);
const M2_MAP = phraseMap(M2);

const MENU_PROG: { root: number; tones: number[] }[] = [
  { root: 0, tones: [0, 3, 7, 12, 14] }, // Em(add9)
  { root: -4, tones: [0, 4, 7, 11] }, // Cmaj7
  { root: 3, tones: [0, 4, 7, 12] }, // G
  { root: -2, tones: [0, 4, 7, 9] }, // D6
];

const TEMPO: Record<MusicMode, number> = { battle: 140, menu: 78 };

class MusicEngine {
  private timer: number | null = null;
  private mode: MusicMode = 'battle';
  private pending: MusicMode = 'battle';
  private step = 0;
  private bar = 0;
  private next = 0;
  private rnd = rng32(0x5eed1);

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: Bank,
    private readonly buses: Record<MusicMode, GainNode>,
    private readonly play: GainNode,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  setMode(m: MusicMode): void {
    this.pending = m;
    if (this.timer === null) this.mode = m;
  }

  start(): void {
    if (this.timer !== null) return;
    const now = this.ctx.currentTime;
    this.mode = this.pending;
    this.step = 0;
    this.bar = 0;
    this.next = now + 0.08;
    for (const m of ['battle', 'menu'] as const) {
      const g = this.buses[m].gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(m === this.mode ? 1 : 0, now);
    }
    const pg = this.play.gain;
    pg.cancelScheduledValues(now);
    pg.setValueAtTime(pg.value, now);
    pg.linearRampToValueAtTime(MUSIC_LEVEL, now + 0.05);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const now = this.ctx.currentTime;
    const pg = this.play.gain;
    pg.cancelScheduledValues(now);
    pg.setTargetAtTime(0, now, 0.12);
  }

  private tick(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // Background tabs throttle timers: resync instead of bursting stale notes.
    if (this.next < now - 0.05) {
      this.next = now + 0.05;
      this.step = 0;
      this.bar++;
    }
    while (this.next < now + LOOKAHEAD) {
      if (this.step === 0 && this.pending !== this.mode) this.switchMode(this.next);
      const sd = 60 / TEMPO[this.mode] / 4;
      if (this.step === 12 && this.pending !== this.mode) this.riser(this.next, sd * 4, this.play, 0.18);
      if (this.mode === 'battle') this.battleStep(this.step, this.next, sd);
      else this.menuStep(this.step, this.next, sd);
      this.next += sd;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private switchMode(t: number): void {
    const from = this.mode;
    const to = this.pending;
    this.mode = to;
    this.bar = 0;
    const gNew = this.buses[to].gain;
    const gOld = this.buses[from].gain;
    gNew.cancelScheduledValues(t);
    gNew.setTargetAtTime(1, t, 0.12);
    gOld.cancelScheduledValues(t);
    gOld.setTargetAtTime(0, t, 0.35);
    // transition hit, straight into the post-fade bus
    this.boom(t, this.play, to === 'battle' ? 0.9 : 0.6);
    this.crash(t, this.play, to === 'battle' ? 1 : 0.5);
  }

  private patch(): Patch {
    return new Patch(this.ctx, this.bank);
  }

  // --- battle -------------------------------------------------------------

  private battleStep(s: number, t: number, sd: number): void {
    const bus = this.buses.battle;
    const rnd = this.rnd;
    const sec = Math.floor(this.bar / 8) % 4;
    const bi = this.bar % 8;
    const off = BATTLE_PROG[sec][bi % 4];
    const half = sec === 2 && bi < 4;
    const buildUp = sec === 2 && bi >= 6;

    if (s === 0 && bi === 0) this.crash(t, bus, sec === 3 ? 1 : 0.7);
    if (sec === 2 && bi === 6 && s === 0) this.riser(t, sd * 32, bus, 0.22);

    // kick
    let kick = s % 4 === 0;
    if (half) kick = s === 0 || s === 8 || (s === 10 && bi % 2 === 1);
    if (sec === 3 && s === 14 && bi % 2 === 1) kick = true;
    if (kick) this.kick(t, bus, s === 0 ? 1 : 0.9);
    else if (!half && !buildUp && s === 7 && rnd() < 0.12) this.kick(t, bus, 0.5);

    // snare / clap
    if (buildUp) {
      if (bi === 7 || s % 2 === 0) this.snare(t, bus, bi === 6 ? 0.35 + (s / 16) * 0.3 : 0.45 + (s / 16) * 0.55);
    } else if (half) {
      if (s === 8) this.snare(t, bus, 1);
    } else if (s === 4 || s === 12) {
      this.snare(t, bus, 1);
    } else if (bi === 7 && s >= 13) {
      this.snare(t, bus, 0.45 + (s - 13) * 0.2);
    } else if ((s === 15 || s === 10) && rnd() < 0.12) {
      this.snare(t, bus, 0.22);
    }

    // hats
    if (sec === 0 || half) {
      if (s % 2 === 0) this.hat(t, bus, s % 4 === 2 ? 0.9 : 0.45, false);
    } else if (!buildUp || bi === 6) {
      const v = s % 4 === 2 ? 0.85 : s % 2 === 0 ? 0.45 : 0.25;
      this.hat(t, bus, v * (0.85 + rnd() * 0.3), s === 14 && bi % 2 === 1);
    }

    // bass
    const riff = sec === 1 ? R2 : half ? R3 : sec === 3 && bi % 2 === 1 ? R2 : R1;
    let n = riff[s];
    if (bi === 7 && s >= 12 && !buildUp) n = BASS_FILL[s - 12];
    if (n !== null) this.bass(t, bus, 40 + off + n, sd * (riff === R3 ? 2.6 : 0.85), s % 4 === 0);

    // stabs, pads, lead
    if (sec === 0 && bi % 4 === 3 && (s === 0 || s === 3 || s === 6)) this.stab(t, bus, 52 + off, sd * 1.6, 1);
    if (sec === 1) {
      const ph = bi < 6 ? M1_MAP : M2_MAP;
      const note = ph.get((bi % 2) * 16 + s);
      if (note) this.lead(t, bus, 64 + note[0], sd * note[1]);
      if (bi === 7 && s === 0) this.stab(t, bus, 52 + off, sd * 2, 1);
    }
    if (half && s === 0) this.powerPad(t, bus, 52 + off, sd * 16);
    if (sec === 3) {
      if (bi % 2 === 0 && (s === 0 || s === 3 || s === 6 || s === 10)) this.stab(t, bus, 52 + off, sd * 1.5, 0.9);
      if (bi % 2 === 1) {
        const note = M2_MAP.get(16 + s);
        if (note) this.lead(t, bus, 64 + note[0], sd * note[1]);
      }
    }
  }

  private kick(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    p.th(dest, t, { f: 155, f2: 42, glide: 0.11, a: 0.002, d: 0.34, peak: 0.95 * v, drive: 1.6 });
    p.nh(dest, t, { type: 'highpass', f: 2500, a: 0.001, d: 0.012, peak: 0.16 * v });
    p.finish();
  }

  private snare(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    const src = p.noise('white', t, t + 0.3);
    const bp = p.filter('bandpass', 1700, 0.9);
    const hp = p.filter('highpass', 5000, 0.7);
    const g1 = p.gain(0);
    const g2 = p.gain(0);
    const pk = 0.55 * v;
    spikes(g1.gain, [t, t + 0.011], [pk * 0.8, pk * 0.8], 0.006);
    g1.gain.setValueAtTime(pk, t + 0.022);
    g1.gain.setTargetAtTime(0, t + 0.023, 0.05);
    env(g2.gain, t + 0.02, 0.22 * v, 0.002, 0, 0.1);
    src.connect(bp);
    src.connect(hp);
    bp.connect(g1);
    hp.connect(g2);
    g1.connect(dest);
    g2.connect(dest);
    p.th(dest, t + 0.02, { type: 'triangle', f: 220, f2: 170, glide: 0.06, d: 0.08, peak: 0.35 * v });
    p.finish();
  }

  private hat(t: number, dest: AudioNode, v: number, open: boolean): void {
    const p = this.patch();
    p.nh(dest, t, { type: 'highpass', f: 7500, q: 0.8, a: 0.001, d: open ? 0.16 : 0.035, peak: 0.2 * v });
    p.finish();
  }

  private crash(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    p.nh(dest, t, { type: 'highpass', f: 4500, a: 0.002, d: 1.4, peak: 0.16 * v });
    p.nh(dest, t, { type: 'bandpass', f: 8000, q: 1, a: 0.002, d: 0.6, peak: 0.1 * v });
    p.finish();
  }

  private riser(t: number, dur: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    const src = p.noise('white', t, t + dur + 0.05);
    const bp = p.filter('bandpass', 400, 3);
    glide(bp.frequency, t, 400, 5000, dur);
    const g = p.gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + dur * 0.95);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    p.finish();
  }

  private boom(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    p.th(dest, t, { f: 70, f2: 30, glide: 0.8, d: 1.2, peak: 0.7 * v, drive: 1.5 });
    p.nh(dest, t, { kind: 'brown', type: 'lowpass', f: 300, d: 1.0, peak: 0.5 * v });
    p.finish();
  }

  private bass(t: number, dest: AudioNode, midi: number, dur: number, accent: boolean): void {
    const p = this.patch();
    const f = midiHz(midi);
    const end = t + dur + 0.05;
    const sh = p.shaper(2.5);
    p.osc('sawtooth', f, t, end).connect(sh);
    const sq = p.osc('square', f, t, end);
    sq.detune.value = -6;
    const sqg = p.gain(0.6);
    sq.connect(sqg);
    sqg.connect(sh);
    const lp = p.filter('lowpass', 300, 6);
    glide(lp.frequency, t, 300 + (accent ? 1500 : 800), 220, dur);
    const g = p.gain(0);
    env(g.gain, t, 0.28, 0.003, dur * 0.4, dur * 0.55);
    sh.connect(lp);
    lp.connect(g);
    g.connect(dest);
    if (f / 2 > 35) {
      const sub = p.osc('sine', f / 2, t, end);
      const sg = p.gain(0);
      env(sg.gain, t, 0.3, 0.003, dur * 0.4, dur * 0.55);
      sub.connect(sg);
      sg.connect(dest);
    }
    p.finish();
  }

  private chordOscs(p: Patch, dest: AudioNode, root: number, t: number, end: number): void {
    for (const iv of [0, 7, 12]) {
      const f = midiHz(root + iv);
      for (const det of [-10, 10]) {
        const o = p.osc('sawtooth', f, t, end);
        o.detune.value = det;
        o.connect(dest);
      }
    }
  }

  private stab(t: number, dest: AudioNode, root: number, dur: number, v: number): void {
    const p = this.patch();
    const end = t + dur + 0.1;
    const lp = p.filter('lowpass', 2400, 2);
    glide(lp.frequency, t, 2600, 600, dur);
    const sh = p.shaper(1.5);
    const g = p.gain(0);
    env(g.gain, t, 0.07 * v, 0.004, dur * 0.3, dur * 0.7);
    this.chordOscs(p, lp, root, t, end);
    lp.connect(sh);
    sh.connect(g);
    g.connect(dest);
    p.finish();
  }

  private powerPad(t: number, dest: AudioNode, root: number, dur: number): void {
    const p = this.patch();
    const end = t + dur + 0.6;
    const lp = p.filter('lowpass', 600, 1);
    glide(lp.frequency, t, 500, 1400, dur);
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.25);
    g.gain.setValueAtTime(0.05, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
    this.chordOscs(p, lp, root, t, end);
    lp.connect(g);
    g.connect(dest);
    p.finish();
  }

  private lead(t: number, dest: AudioNode, midi: number, dur: number): void {
    const p = this.patch();
    const f = midiHz(midi);
    const end = t + dur + 0.15;
    const lp = p.filter('lowpass', 2600, 1);
    const lfo = p.osc('sine', 5.5, t, end);
    const vib = p.gain(0);
    vib.gain.setValueAtTime(0, t);
    vib.gain.linearRampToValueAtTime(14, t + Math.min(0.25, dur));
    lfo.connect(vib);
    const a = p.osc('square', f, t, end);
    const b = p.osc('sawtooth', f, t, end);
    b.detune.value = 7;
    vib.connect(a.detune);
    vib.connect(b.detune);
    const ga = p.gain(0.5);
    a.connect(ga);
    ga.connect(lp);
    b.connect(lp);
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.01);
    g.gain.linearRampToValueAtTime(0.08, t + 0.08);
    g.gain.setValueAtTime(0.08, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    lp.connect(g);
    g.connect(dest);
    p.finish();
  }

  // --- menu ---------------------------------------------------------------

  private menuStep(s: number, t: number, sd: number): void {
    const bus = this.buses.menu;
    const rnd = this.rnd;
    const bi = this.bar % 8;
    const sec = Math.floor(this.bar / 8) % 2;
    const chord = MENU_PROG[this.bar % 4];

    if (s === 0) {
      const base = 52 + chord.root;
      const notes = chord.tones.map((x) => base + x);
      this.pad(t, bus, notes, sd * 16);
      this.drone(t, bus, 40 + chord.root, sd * 16);
    }

    // sparse percussion
    if (s === 0) this.kick(t, bus, 0.5);
    if (s === 10 && this.bar % 2 === 1) this.kick(t, bus, 0.3);
    if (s === 8 && this.bar % 2 === 0) this.tom(t, bus, 65, 0.45);
    if (s === 12 && rnd() < 0.6) this.rim(t, bus, 0.5);
    if (this.bar % 4 === 3 && s >= 12) this.tom(t, bus, 70 + (s - 12) * 12, 0.25 + (s - 12) * 0.08);
    if (s % 4 === 2 && rnd() < 0.45) this.hat(t, bus, 0.25, false);
    if (bi === 4 && s === 0 && rnd() < 0.7) this.boom(t + sd * 6, bus, 0.35);

    // slow pulse in the second half of the cycle
    if (sec === 1 && s % 4 === 0) this.pulse(t, bus, 40 + chord.root + (s === 8 ? 12 : 0), sd * 3);

    // sparse bells
    if (s % 2 === 0 && rnd() < 0.22) {
      const tone = chord.tones[Math.floor(rnd() * chord.tones.length)];
      this.bell(t, bus, 76 + chord.root + tone - (chord.root > 0 ? 12 : 0), 0.6 + rnd() * 0.4);
    }
  }

  private pad(t: number, dest: AudioNode, notes: number[], dur: number): void {
    const p = this.patch();
    const end = t + dur + 2.2;
    const lp = p.filter('lowpass', 600, 0.8);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1100, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(650, t + dur + 1);
    const g = p.gain(0);
    const peak = 0.16 / notes.length;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.9);
    g.gain.setValueAtTime(peak, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.5);
    for (const m of notes) {
      const f = midiHz(m);
      for (const det of [-7, 7]) {
        const o = p.osc('sawtooth', f, t, end);
        o.detune.value = det;
        o.connect(lp);
      }
    }
    lp.connect(g);
    g.connect(dest);
    p.finish();
  }

  private drone(t: number, dest: AudioNode, midi: number, dur: number): void {
    const p = this.patch();
    const end = t + dur + 1.8;
    const o = p.osc('sine', midiHz(midi), t, end);
    const tri = p.osc('triangle', midiHz(midi + 12), t, end);
    const tg = p.gain(0.25);
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.8);
    g.gain.setValueAtTime(0.16, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.4);
    o.connect(g);
    tri.connect(tg);
    tg.connect(g);
    g.connect(dest);
    p.finish();
  }

  private pulse(t: number, dest: AudioNode, midi: number, dur: number): void {
    const p = this.patch();
    p.th(dest, t, { type: 'triangle', f: midiHz(midi), lp: 500, a: 0.01, hold: dur * 0.3, d: dur * 0.6, peak: 0.14 });
    p.finish();
  }

  private tom(t: number, dest: AudioNode, f: number, v: number): void {
    const p = this.patch();
    p.th(dest, t, { f: f * 1.5, f2: f, glide: 0.15, d: 0.3, peak: 0.6 * v });
    p.nh(dest, t, { kind: 'pink', type: 'lowpass', f: 1200, d: 0.05, peak: 0.2 * v });
    p.finish();
  }

  private rim(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    p.nh(dest, t, { type: 'bandpass', f: 2200, q: 4, d: 0.03, peak: 0.25 * v });
    p.th(dest, t, { type: 'triangle', f: 800, d: 0.02, peak: 0.12 * v });
    p.finish();
  }

  private bell(t: number, dest: AudioNode, midi: number, v: number): void {
    const p = this.patch();
    const f = midiHz(midi);
    p.th(dest, t, { f, a: 0.003, d: 1.2, peak: 0.07 * v });
    p.th(dest, t, { type: 'triangle', f, a: 0.003, d: 0.6, peak: 0.04 * v });
    p.th(dest, t, { f: f * 2.76, a: 0.002, d: 0.35, peak: 0.02 * v });
    p.finish();
  }
}

// ---------------------------------------------------------------------------
// AudioSystem
// ---------------------------------------------------------------------------

interface VoiceRec {
  patch: Patch;
  out: GainNode;
  level: number;
  start: number;
  end: number;
}

interface Graph {
  ctx: AudioContext;
  bank: Bank;
  sfxBus: GainNode;
  sfxGain: GainNode;
  sfxWetBus: GainNode;
  sfxWetGain: GainNode;
  musicGain: GainNode;
  master: GainNode;
  music: MusicEngine;
}

export class AudioSystem {
  private g: Graph | null = null;
  private failed = false;
  private gestured = false;
  private voices: VoiceRec[] = [];
  private lastPlay = new Map<Sfx, number>();
  private sfxVol = 0.8;
  private musicVol = 0.35;
  private voiceOn = true;
  private musicWanted = false;
  private musicMode: MusicMode = 'battle';

  // speech
  private speechQueue: string[] = [];
  private speaking = false;
  private lastSaid = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null = null;
  private voicesHooked = false;

  constructor() {
    // Intentionally does nothing that touches browser globals.
  }

  get unlocked(): boolean {
    return this.g !== null && this.g.ctx.state === 'running';
  }

  unlock(): void {
    if (typeof window === 'undefined') return;
    this.gestured = true;
    this.hookVoices();
    if (!this.g && !this.failed) {
      try {
        this.g = this.createGraph();
      } catch {
        this.failed = true;
        this.g = null;
      }
    }
    const g = this.g;
    if (!g) return;
    if (g.ctx.state !== 'running') {
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
    if (this.musicWanted && !g.music.running) g.music.start();
  }

  private createGraph(): Graph | null {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC({ latencyHint: 'interactive' });
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

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 1.4);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.55;
    reverb.connect(revOut);
    revOut.connect(comp);

    const sfxBus = ctx.createGain();
    const sfxGain = ctx.createGain();
    sfxGain.gain.value = this.sfxVol;
    sfxBus.connect(sfxGain);
    sfxGain.connect(comp);
    const sfxWetBus = ctx.createGain();
    const sfxWetGain = ctx.createGain();
    sfxWetGain.gain.value = this.sfxVol;
    sfxWetBus.connect(sfxWetGain);
    sfxWetGain.connect(reverb);

    const musicGain = ctx.createGain();
    musicGain.gain.value = this.musicVol;
    musicGain.connect(comp);
    const musicWet = ctx.createGain();
    musicWet.gain.value = 0.2;
    musicGain.connect(musicWet);
    musicWet.connect(reverb);
    const play = ctx.createGain();
    play.gain.value = 0;
    play.connect(musicGain);

    const battle = ctx.createGain();
    battle.gain.value = 0;
    battle.connect(play);
    const menu = ctx.createGain();
    menu.gain.value = 0;
    menu.connect(play);
    // dotted-eighth echo for the atmospheric menu theme
    const dly = ctx.createDelay(1);
    dly.delayTime.value = (60 / TEMPO.menu) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2200;
    const dOut = ctx.createGain();
    dOut.gain.value = 0.35;
    menu.connect(dly);
    dly.connect(dlp);
    dlp.connect(fb);
    fb.connect(dly);
    dlp.connect(dOut);
    dOut.connect(menu);

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

    const music = new MusicEngine(ctx, bank, { battle, menu }, play);
    music.setMode(this.musicMode);
    ctx.onstatechange = () => this.afterResume();
    return { ctx, bank, sfxBus, sfxGain, sfxWetBus, sfxWetGain, musicGain, master, music };
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
    }
  }

  play(name: Sfx, volume = 1, pan = 0): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    const def = SFX[name];
    if (!def) return;
    const level = clamp(Number.isFinite(volume) ? volume : 0, 0, 1) * def.lvl;
    if (level < 0.005 || this.sfxVol <= 0) return;
    const now = g.ctx.currentTime;
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < def.gap && now >= last) return;

    this.reap(now);
    if (this.voices.length >= MAX_VOICES) {
      let victim = -1;
      let best = Infinity;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        const life = Math.max(0.001, v.end - v.start);
        const remaining = clamp((v.end - now) / life, 0, 1);
        const score = v.level * (0.25 + remaining);
        if (score < best) {
          best = score;
          victim = i;
        }
      }
      // A newcomer quieter than everything already playing is dropped instead.
      if (victim < 0 || level * 1.25 < best) return;
      this.steal(victim, now);
    }
    this.lastPlay.set(name, now);
    this.spawn(g, def.build, level, Number.isFinite(pan) ? pan : 0, def.wet);
  }

  private spawn(g: Graph, build: Build, level: number, pan: number, wet: number): void {
    const ctx = g.ctx;
    const t = ctx.currentTime + 0.005;
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
    const rec: VoiceRec = { patch: p, out, level, start: t, end: p.end };
    p.onDone = () => {
      const i = this.voices.indexOf(rec);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(rec);
    p.finish();
  }

  /** Drop bookkeeping for voices whose onended never fired. */
  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.end < now - 0.5) {
        this.voices.splice(i, 1);
        v.patch.onDone = null;
        v.patch.dispose();
      }
    }
  }

  private steal(i: number, now: number): void {
    const v = this.voices[i];
    this.voices.splice(i, 1);
    v.patch.onDone = null;
    const gp = v.out.gain;
    try {
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(gp.value, now);
      gp.linearRampToValueAtTime(0, now + 0.03);
    } catch {
      /* ignore */
    }
    v.patch.kill(now + 0.04);
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
    if (!this.voiceOn || !this.gestured || typeof text !== 'string' || !text.trim()) return;
    const now = Date.now();
    const last = this.lastSaid.get(text);
    if (last !== undefined && now - last < 4000) return;
    this.lastSaid.set(text, now);
    if (this.lastSaid.size > 64) {
      for (const [k, v] of this.lastSaid) if (now - v > 4000) this.lastSaid.delete(k);
    }
    if (!this.synth()) {
      this.blip();
      return;
    }
    if (this.speechQueue.includes(text)) return;
    this.speechQueue.push(text);
    while (this.speechQueue.length > 2) this.speechQueue.shift();
    if (!this.speaking) this.speakNext();
  }

  private blip(): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running' || this.sfxVol <= 0) return;
    this.spawn(g, radioBlip, 0.55, 0, 0.05);
  }

  private speakNext(): void {
    const synth = this.synth();
    const text = this.speechQueue.shift();
    if (!synth || text === undefined || !this.voiceOn) {
      this.speaking = false;
      return;
    }
    this.speaking = true;
    this.blip();
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
      this.speaking = false;
      window.setTimeout(() => {
        if (!this.speaking) this.speakNext();
      }, 60);
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
      watchdog = window.setTimeout(() => finish(true), 2500 + text.length * 110);
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

  startMusic(): void {
    this.musicWanted = true;
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    g.music.setMode(this.musicMode);
    g.music.start();
  }

  stopMusic(): void {
    this.musicWanted = false;
    const g = this.g;
    if (!g) return;
    g.music.stop();
  }

  setMusicMode(mode: 'menu' | 'battle'): void {
    if (mode !== 'menu' && mode !== 'battle') return;
    this.musicMode = mode;
    if (this.g) this.g.music.setMode(mode);
  }
}
