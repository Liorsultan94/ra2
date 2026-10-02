/**
 * One-shot percussion for the music, rendered once per context into
 * AudioBuffers (plain JS DSP, a few hundred ms of audio each). Playing a hit
 * is then a single AudioBufferSourceNode + GainNode instead of a handful of
 * oscillators and filters, which keeps dense drum patterns cheap on phones.
 * Pitch/size variations use playbackRate.
 */

type Kind = 'lowpass' | 'highpass' | 'bandpass';

/** RBJ biquad, processed in place. */
function biquad(d: Float32Array, sr: number, kind: Kind, f: number, q: number): void {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = b0;
  } else if (kind === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    d[i] = y;
  }
}

/** Seeded noise so the buffers are identical every run. */
function noise(n: number, seed: number): Float32Array {
  const d = new Float32Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    d[i] = a / 2147483648 - 1;
  }
  return d;
}

/** Exponential decay to -80 dB over `d` seconds after a linear attack `a`. */
function envAt(t: number, a: number, d: number): number {
  if (t < a) return t / a;
  return Math.exp((-9.21 * (t - a)) / d);
}

/** Sine (or triangle) with an exponential pitch drop from f0 to f1 (time constant tau). */
function addDrop(out: Float32Array, sr: number, f0: number, f1: number, tau: number, a: number, d: number, peak: number, tri = false): void {
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / tau);
    ph += f / sr;
    ph -= Math.floor(ph);
    const s = tri ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(2 * Math.PI * ph);
    out[i] += s * peak * envAt(t, a, d);
  }
}

function addNoise(out: Float32Array, sr: number, seed: number, kind: Kind, f: number, q: number, a: number, d: number, peak: number): void {
  const n = noise(out.length, seed);
  biquad(n, sr, kind, f, q);
  if (kind === 'bandpass') biquad(n, sr, kind, f, q);
  for (let i = 0; i < out.length; i++) out[i] += n[i] * peak * envAt(i / sr, a, d);
}

function normalize(d: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m <= 0) return;
  const k = peak / m;
  for (let i = 0; i < d.length; i++) d[i] *= k;
  // 3 ms fade-out so the buffer ends at zero
  const f = Math.min(d.length, 128);
  for (let i = 0; i < f; i++) d[d.length - 1 - i] *= i / f;
}

export interface DrumKit {
  taiko: AudioBuffer;
  thump: AudioBuffer;
  tick: AudioBuffer;
  anvil: AudioBuffer;
  shaker: AudioBuffer;
  pulse: AudioBuffer;
}

/** Render the music percussion. All buffers peak at 1.0; levels are applied when played. */
export function makeDrumKit(ctx: BaseAudioContext): DrumKit {
  const sr = ctx.sampleRate;
  const make = (secs: number, fill: (d: Float32Array) => void): AudioBuffer => {
    const b = ctx.createBuffer(1, Math.max(1, Math.floor(sr * secs)), sr);
    const d = b.getChannelData(0);
    fill(d);
    normalize(d, 1);
    return b;
  };
  return {
    // war drum: dropping sine body, a woody 2nd partial and a skin slap
    taiko: make(0.75, (d) => {
      addDrop(d, sr, 100, 50, 0.07, 0.003, 0.6, 1);
      addDrop(d, sr, 210, 118, 0.03, 0.002, 0.14, 0.28, true);
      addNoise(d, sr, 11, 'lowpass', 1100, 0.8, 0.001, 0.07, 0.45);
    }),
    // heartbeat / muffled thump, with enough 100-200 Hz to be heard on small speakers
    thump: make(0.36, (d) => {
      addDrop(d, sr, 74, 44, 0.05, 0.006, 0.26, 1);
      addDrop(d, sr, 150, 96, 0.03, 0.004, 0.12, 0.42, true);
      addNoise(d, sr, 23, 'lowpass', 380, 0.7, 0.003, 0.08, 0.35);
    }),
    // clock tick (play at rate ~0.72 for the "tock")
    tick: make(0.05, (d) => {
      addNoise(d, sr, 37, 'bandpass', 3600, 5, 0.0008, 0.022, 4);
      addDrop(d, sr, 1650, 1650, 1, 0.0008, 0.03, 0.12, true);
    }),
    // metallic anvil / snare-like backbeat
    anvil: make(0.42, (d) => {
      addDrop(d, sr, 1046, 1046, 1, 0.001, 0.34, 0.35);
      addDrop(d, sr, 2887, 2887, 1, 0.001, 0.15, 0.2);
      addDrop(d, sr, 1683, 1683, 1, 0.001, 0.09, 0.12);
      addNoise(d, sr, 41, 'bandpass', 1500, 0.9, 0.001, 0.13, 2.2);
      addNoise(d, sr, 43, 'highpass', 5000, 0.7, 0.001, 0.04, 0.5);
    }),
    shaker: make(0.06, (d) => {
      addNoise(d, sr, 53, 'highpass', 7000, 0.7, 0.004, 0.035, 1);
    }),
    // distorted low pulse (D1 saw, driven and low-passed) with a sub drop
    pulse: make(0.48, (d) => {
      const f = 36.71;
      let ph = 0;
      const saw = new Float32Array(d.length);
      for (let i = 0; i < d.length; i++) {
        ph += f / sr;
        ph -= Math.floor(ph);
        const t = i / sr;
        saw[i] = Math.tanh(4 * (2 * ph - 1) * (t < 0.054 ? Math.min(1, t / 0.004) : Math.exp((-9.21 * (t - 0.054)) / 0.32))) / Math.tanh(4);
      }
      biquad(saw, sr, 'lowpass', 650, 0.7);
      for (let i = 0; i < d.length; i++) d[i] = saw[i] * 0.45;
      addDrop(d, sr, 58, 36, 0.07, 0.004, 0.4, 1);
    }),
  };
}

/**
 * One loop of an endless Shepard-Risset glissando: `octaves` sine voices one
 * octave apart, each rising one octave per loop under a sin^2 loudness
 * envelope over its whole life. The base frequency is nudged so that
 * base * T / ln2 is an integer: then every voice ends the loop with exactly
 * the phase the next-higher voice starts with, so the buffer loops without a
 * seam and the rise never ends.
 */
export function makeShepard(ctx: BaseAudioContext, loopSeconds: number, base: number, octaves: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(loopSeconds * sr));
  const T = n / sr;
  const k = Math.max(1, Math.round((base * T) / Math.LN2));
  const f0 = (k * Math.LN2) / T;
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  const TAU = 2 * Math.PI;
  for (let v = 0; v < octaves; v++) {
    const fv = f0 * Math.pow(2, v);
    const c = (fv * T) / Math.LN2; // phase (cycles) = c * (2^(t/T) - 1)
    for (let i = 0; i < n; i++) {
      const x = i / n;
      const e = Math.sin((Math.PI * (v + x)) / octaves);
      d[i] += Math.sin(TAU * c * (Math.pow(2, x) - 1)) * e * e;
    }
  }
  // the sin^2 envelopes of voices spaced 1/octaves apart sum to octaves/2
  const g = 2 / octaves;
  for (let i = 0; i < n; i++) d[i] *= g;
  return b;
}
