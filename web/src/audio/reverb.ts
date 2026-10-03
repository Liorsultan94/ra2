/**
 * Synthesised impulse response for an outdoor battlefield: no room, but a
 * handful of discrete slap-back echoes (treelines, buildings, a hillside),
 * then a slowly building, darkening diffuse tail (the terrain's scattered
 * echoes). Decorrelated left / right for width on headphones.
 */
import { rng32 } from './core';

export interface OutdoorIR {
  /** Total length, seconds. */
  seconds: number;
  /** Diffuse tail T60, seconds. */
  t60: number;
  /** Number of discrete slap-back echoes per channel. */
  taps: number;
  seed: number;
}

/** Fill one channel of the outdoor impulse response (pure; exported for tests). */
export function outdoorChannel(d: Float32Array, sr: number, o: OutdoorIR, ch: number): void {
  const R = rng32(o.seed * 7 + ch * 101 + 1);
  const len = d.length;
  const pre = Math.floor(sr * 0.016);
  // direct-ish blip so the wet signal has a clear onset
  d[pre] = 0.35;
  // slap-back: discrete echoes 35..280 ms, quieter and duller the later they come
  for (let k = 0; k < o.taps; k++) {
    const at = 0.035 + Math.pow(R(), 0.9) * 0.245;
    const i0 = Math.floor(at * sr);
    const amp = (0.55 - 0.35 * (at / 0.28)) * (0.6 + 0.4 * R()) * (R() < 0.5 ? -1 : 1);
    const w = Math.max(2, Math.floor(sr * (0.0008 + at * 0.006)));
    for (let j = 0; j < w * 2 && i0 + j < len; j++) {
      const x = j / w - 1;
      d[i0 + j] += amp * Math.exp(-4 * x * x) * (1 - 0.4 * Math.abs(x));
    }
  }
  // diffuse tail: builds over ~90 ms, decays with T60, low-passes as it goes
  const start = Math.floor(sr * 0.05);
  const decay = 6.91 / Math.max(0.1, o.t60);
  let y = 0;
  for (let i = start; i < len; i++) {
    const t = (i - start) / sr;
    const build = Math.min(1, t / 0.09);
    const env = build * Math.exp(-decay * t) * 0.32;
    const x = (R() * 2 - 1) * env;
    const k = i / len;
    const a = 0.62 - 0.5 * k;
    y += a * (x - y);
    d[i] += y;
  }
  // end at zero
  const f = Math.min(len, Math.floor(sr * 0.02));
  for (let i = 0; i < f; i++) d[len - 1 - i] *= i / f;
}

export function makeOutdoorImpulse(ctx: BaseAudioContext, o: Partial<OutdoorIR> = {}): AudioBuffer {
  const cfg: OutdoorIR = { seconds: 1.25, t60: 1.15, taps: 7, seed: 11, ...o };
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(sr * cfg.seconds));
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) outdoorChannel(buf.getChannelData(ch), sr, cfg, ch);
  return buf;
}
