/*
 * Frame-time statistics for perf_sample (render side, O(1) per frame, no allocation):
 * a 1 ms histogram of frame times and the frame rate of every whole second.
 */

const BUCKETS = 251; // 0..249 ms, 250+ ms
const MAX_SECONDS = 3600;

export interface FrameSummary {
  avg_fps: number;
  min_fps: number;
  p5_fps: number;
  frame_ms_p95: number;
  frames: number;
}

export class FrameStats {
  private hist = new Uint32Array(BUCKETS);
  private frames = 0;
  private total = 0;
  /** Frames counted in each whole second of play. */
  private secs = new Uint16Array(MAX_SECONDS);
  private nSecs = 0;
  private secStart = -1;
  private secFrames = 0;

  /** One frame of `dt` ms ending at `now` (ms). Gaps over 1 s (tab hidden, a debugger) are not frames. */
  add(dt: number, now: number) {
    if (!(dt > 0) || dt > 1000) {
      this.secStart = -1;
      return;
    }
    this.hist[Math.min(BUCKETS - 1, Math.floor(dt))]++;
    this.frames++;
    this.total += dt;
    if (this.secStart < 0) {
      this.secStart = now;
      this.secFrames = 0;
    }
    this.secFrames++;
    if (now - this.secStart >= 1000) {
      if (this.nSecs < MAX_SECONDS) this.secs[this.nSecs++] = Math.min(65535, Math.round((this.secFrames * 1000) / (now - this.secStart)));
      this.secStart = now;
      this.secFrames = 0;
    }
  }

  /** Frame time (ms) at quantile q (0..1) of all frames. */
  quantileMs(q: number): number {
    if (!this.frames) return 0;
    const want = q * this.frames;
    let acc = 0;
    for (let i = 0; i < BUCKETS; i++) {
      acc += this.hist[i];
      if (acc >= want) return i + 1;
    }
    return BUCKETS;
  }

  summary(): FrameSummary {
    const s = Array.from(this.secs.subarray(0, this.nSecs)).sort((a, b) => a - b);
    const avg = this.total > 0 ? (this.frames * 1000) / this.total : 0;
    return {
      avg_fps: Math.round(avg * 10) / 10,
      min_fps: s.length ? s[0] : Math.round(avg),
      p5_fps: s.length ? s[Math.floor(s.length * 0.05)] : Math.round(avg),
      frame_ms_p95: this.quantileMs(0.95),
      frames: this.frames,
    };
  }
}
