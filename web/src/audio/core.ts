/**
 * Shared Web Audio building blocks for the procedural sound effects and the
 * music engine: noise/curve banks, the impulse response, envelope helpers and
 * the self-cleaning Patch (a group of nodes making up one sound).
 */

export type NoiseKind = 'white' | 'pink' | 'brown';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function rng32(seed: number): () => number {
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

export class Bank {
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

export function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
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

export function env(p: AudioParam, t: number, peak: number, a: number, hold: number, d: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (hold > 0) p.setValueAtTime(peak, t + a + hold);
  p.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
}

export function glide(p: AudioParam, t: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(Math.max(from, 0.01), t);
  p.exponentialRampToValueAtTime(Math.max(to, 0.01), t + Math.max(dur, 0.002));
}

/** Short spikes on a gain param (crackles, ratchets, claps). Times must be ascending. */
export function spikes(p: AudioParam, times: number[], peaks: number[], tau: number): void {
  for (let i = 0; i < times.length; i++) {
    p.setValueAtTime(peaks[i], times[i]);
    p.setTargetAtTime(0, times[i] + 0.001, tau);
  }
}

export interface NoiseOpts {
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

export interface ToneOpts {
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
export class Patch {
  private nodes: AudioNode[] = [];
  private srcs: AudioScheduledSourceNode[] = [];
  private lastSrc: AudioScheduledSourceNode | null = null;
  private disposed = false;
  end = 0;
  onDone: (() => void) | null = null;

  constructor(readonly ctx: BaseAudioContext, readonly bank: Bank) {}

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
