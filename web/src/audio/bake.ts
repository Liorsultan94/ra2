/**
 * Renders the baked sound table (weapons.ts) into AudioBuffers, one
 * OfflineAudioContext per sound (all its variants back to back), one sound at
 * a time with a short pause in between so the main thread never stalls: the
 * offline rendering itself runs on the browser's audio thread. Until a sound
 * is ready the AudioSystem plays its live (node graph) fallback.
 */
import type { Bank } from './core';
import { BAKED, BAKE_ORDER, type BakeDef, type BakedName, buildVariants, slotLength } from './weapons';

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

export function offlineCtor(): OfflineCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const w = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null;
}

/** startRendering() as a promise on old (event-based) and new implementations. */
export function renderOffline(ctx: OfflineAudioContext): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let done = false;
    ctx.oncomplete = (e) => {
      if (!done) {
        done = true;
        resolve(e.renderedBuffer);
      }
    };
    try {
      const p = ctx.startRendering() as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') {
        p.then(
          (b) => {
            if (!done) {
              done = true;
              resolve(b);
            }
          },
          (err) => {
            if (!done) {
              done = true;
              reject(err);
            }
          },
        );
      }
    } catch (err) {
      reject(err);
    }
  });
}

export interface BakedSound {
  buffers: AudioBuffer[];
  /** Duration of the longest variant (seconds). */
  dur: number;
}

/** Peak-normalise, trim trailing silence and fade the end of one variant (in place on a copy). */
export function finishVariant(src: Float32Array[], peakTarget: number, trimDb = -66): { data: Float32Array[]; peak: number } {
  let peak = 0;
  for (const d of src) for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak && Number.isFinite(a)) peak = a;
  }
  const k = peak > 1e-9 ? peakTarget / peak : 0;
  const thr = Math.pow(10, trimDb / 20) * peakTarget;
  let last = 0;
  for (const d of src) {
    for (let i = d.length - 1; i > last; i--) {
      if (Math.abs(d[i] * k) > thr) {
        last = i;
        break;
      }
    }
  }
  const len = Math.min(src[0].length, last + 64);
  const out = src.map((d) => {
    const o = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = d[i] * k;
      o[i] = Number.isFinite(v) ? v : 0;
    }
    const f = Math.min(len, 96);
    for (let i = 0; i < f; i++) o[len - 1 - i] *= i / f;
    return o;
  });
  return { data: out, peak };
}

/**
 * Seamless loop: the rendered take is `len + x` samples; the head is crossfaded
 * with what follows the loop point so the end flows into the start.
 */
export function loopify(d: Float32Array, len: number, x: number): Float32Array {
  const o = new Float32Array(len);
  for (let i = 0; i < len; i++) o[i] = d[i];
  const n = Math.min(x, d.length - len, len);
  for (let i = 0; i < n; i++) {
    const a = i / n;
    // equal-power: the noise parts are uncorrelated, the periodic parts line up exactly
    o[i] = d[i] * Math.sin((a * Math.PI) / 2) + d[len + i] * Math.cos((a * Math.PI) / 2);
  }
  return o;
}

/** Render every variant of one definition and slice them into buffers made on `target`. */
export async function bakeOne(target: BaseAudioContext, bank: Bank, name: BakedName, def: BakeDef, seed: number): Promise<BakedSound | null> {
  const Ctor = offlineCtor();
  if (!Ctor) return null;
  const sr = def.sr;
  const ch = def.stereo ? 2 : 1;
  const slot = slotLength(def);
  const total = Math.ceil(slot * def.variants * sr) + 16;
  const ctx = new Ctor(ch, total, sr);
  buildVariants(ctx, bank, def, seed);
  const rendered = await renderOffline(ctx);
  const buffers: AudioBuffer[] = [];
  let dur = 0;
  const chans: Float32Array[] = [];
  for (let c = 0; c < ch; c++) chans.push(rendered.getChannelData(c));
  for (let i = 0; i < def.variants; i++) {
    const a = Math.round((i * slot + 0.004) * sr);
    const b = Math.min(chans[0].length, Math.round(((i + 1) * slot) * sr));
    let parts = chans.map((d) => d.subarray(a, b));
    let len: number;
    if (def.loop) {
      const L = Math.round(def.dur * sr);
      const X = Math.round(def.loop * sr);
      parts = parts.map((d) => loopify(d, L, X));
      // loops keep their exact length (no trim) and are normalised a little lower
      let peak = 0;
      for (const d of parts) for (let k = 0; k < d.length; k++) peak = Math.max(peak, Math.abs(d[k]));
      const g = peak > 1e-9 ? 0.7 / peak : 0;
      for (const d of parts) for (let k = 0; k < d.length; k++) d[k] = Number.isFinite(d[k] * g) ? d[k] * g : 0;
      len = L;
    } else {
      const f = finishVariant(parts, 0.89);
      parts = f.data;
      len = parts[0].length;
    }
    const buf = target.createBuffer(ch, Math.max(1, len), sr);
    for (let c = 0; c < ch; c++) buf.getChannelData(c).set(parts[c].subarray(0, len));
    buffers.push(buf);
    dur = Math.max(dur, len / sr);
  }
  void name;
  return { buffers, dur };
}

const yieldFrame = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BakeStats {
  sounds: number;
  bytes: number;
  ms: number;
  failed: string[];
}

/**
 * Bake the whole table in BAKE_ORDER, handing each finished sound to `onReady`.
 * `alive()` lets the caller abort (context closed).
 */
export async function bakeAll(
  target: BaseAudioContext,
  bank: Bank,
  onReady: (name: BakedName, s: BakedSound) => void,
  alive: () => boolean = () => true,
  pauseMs = 12,
): Promise<BakeStats> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const stats: BakeStats = { sounds: 0, bytes: 0, ms: 0, failed: [] };
  let seed = 0x1f0e;
  for (const name of BAKE_ORDER) {
    if (!alive()) break;
    seed = (seed * 1103515245 + 12345) >>> 0;
    try {
      const s = await bakeOne(target, bank, name, BAKED[name], seed);
      if (!s) {
        stats.failed.push(name);
        break; // no OfflineAudioContext at all: keep the live fallbacks
      }
      for (const b of s.buffers) stats.bytes += b.length * b.numberOfChannels * 4;
      stats.sounds++;
      onReady(name, s);
    } catch {
      stats.failed.push(name);
    }
    await yieldFrame(pauseMs);
  }
  stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return stats;
}
