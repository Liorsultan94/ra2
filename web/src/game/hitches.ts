/**
 * Hitch recorder (?hitch=1, or F8 in game): finds the frames that stutter and says what they spent the time on.
 *
 * Every frame the game loop reports how long its parts took (simulation ticks, events, render, HUD) and the
 * renderer's counters (shader programs, textures, geometries). A frame much longer than the display's normal
 * frame is a hitch; it is logged with its breakdown, the GPU-side news (new programs = shader compiles, new
 * textures = uploads) and the "unaccounted" share: time between frames that none of our code used (garbage
 * collection, the browser, the GPU driver). Long tasks reported by the browser (PerformanceObserver) are
 * counted too.
 *
 * Zero cost unless enabled. The overlay keeps the last 12 hitches and a 3-second frame-time graph; "Copy"
 * puts a text report on the clipboard to send.
 */

export interface FrameParts {
  sim: number; // ms in world.step() this frame
  ticks: number; // sim ticks run this frame
  events: number; // ms handling sim events (sounds, effects)
  render: number; // ms in renderer.render()
  hud: number; // ms in HUD / minimap / overlays
  programs: number; // shader programs linked so far (renderer.info.programs.length)
  textures: number; // textures in GPU memory
  geometries: number; // geometries in GPU memory
  evNames: string; // the kinds of sim events this frame (deduplicated, short)
}

interface Hitch extends FrameParts {
  at: number; // seconds since the recorder started
  gap: number; // ms since the previous frame
  newPrograms: number;
  newTextures: number;
  newGeometries: number;
  other: number; // ms of the gap not spent in our code
}

export class HitchRecorder {
  enabled = false;
  private el: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private log: Hitch[] = [];
  private gaps: number[] = [];
  private lastAt = 0;
  private t0 = 0;
  private prev: FrameParts | null = null;
  private longTasks = 0;
  private longTaskMs = 0;
  private obs: PerformanceObserver | null = null;
  private frames = 0;
  private hitches = 0;
  private worst = 0;
  /** Typical frame (median of recent gaps): a hitch is a frame over 2x this and over 25 ms. */
  private typical = 16.7;
  private drawAt = 0;

  constructor() {
    if (typeof location !== 'undefined' && /[?&]hitch=1\b/.test(location.search)) this.toggle(true);
    if (typeof window !== 'undefined')
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F8') {
          e.preventDefault();
          this.toggle(!this.enabled);
        }
      });
  }

  toggle(on: boolean) {
    this.enabled = on;
    if (on) {
      this.t0 = performance.now();
      this.lastAt = 0;
      this.prev = null;
      if (!this.obs && typeof PerformanceObserver !== 'undefined') {
        try {
          this.obs = new PerformanceObserver((l) => {
            for (const e of l.getEntries()) {
              this.longTasks++;
              this.longTaskMs += e.duration;
            }
          });
          this.obs.observe({ type: 'longtask', buffered: false });
        } catch {
          this.obs = null; // not supported (Firefox / Safari)
        }
      }
      this.ensureEl();
    }
    if (this.el) this.el.style.display = on ? 'block' : 'none';
  }

  /** Called once per frame, at the end, with the parts measured in this frame. */
  frame(now: number, p: FrameParts) {
    if (!this.enabled) return;
    const gap = this.lastAt ? now - this.lastAt : 0;
    this.lastAt = now;
    const prev = this.prev;
    this.prev = p;
    if (!gap || !prev) return;
    this.frames++;
    this.gaps.push(gap);
    if (this.gaps.length > 180) this.gaps.shift();
    if (this.frames % 60 === 0) {
      const s = this.gaps.slice().sort((a, b) => a - b);
      this.typical = s[s.length >> 1];
    }
    const ours = p.sim + p.events + p.render + p.hud;
    const limit = Math.max(25, this.typical * 2);
    if (gap > limit && gap < 3000) {
      this.hitches++;
      this.worst = Math.max(this.worst, gap);
      this.log.push({
        ...p,
        at: (now - this.t0) / 1000,
        gap,
        newPrograms: p.programs - prev.programs,
        newTextures: Math.max(0, p.textures - prev.textures),
        newGeometries: Math.max(0, p.geometries - prev.geometries),
        // the previous frame's own work ended its share of the gap; what is left was not ours
        other: Math.max(0, gap - ours),
      });
      if (this.log.length > 12) this.log.shift();
    }
    if (now - this.drawAt > 250) {
      this.drawAt = now;
      this.draw();
    }
  }

  /** Hitch cause in a word: the biggest share of the frame. */
  private cause(h: Hitch): string {
    if (h.newPrograms > 0) return `shader compile x${h.newPrograms}`;
    const parts: [string, number][] = [['sim', h.sim], ['events', h.events], ['render', h.render], ['hud', h.hud], ['browser/GC', h.other]];
    parts.sort((a, b) => b[1] - a[1]);
    const up = h.newTextures > 0 ? ` +${h.newTextures} tex` : '';
    return parts[0][0] + up;
  }

  report(): string {
    const s = this.gaps.slice().sort((a, b) => a - b);
    const pct = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1) : '-');
    const lines = [
      `Iron Front hitch report  ${new Date().toISOString()}`,
      `${navigator.userAgent}`,
      `frames ${this.frames}  hitches ${this.hitches}  worst ${this.worst.toFixed(0)} ms  typical ${this.typical.toFixed(1)} ms  p95 ${pct(0.95)}  p99 ${pct(0.99)}`,
      `browser long tasks ${this.longTasks} (${this.longTaskMs.toFixed(0)} ms)`,
      'time   gap  sim(t)   ev  rend  hud other  prog tex geo  cause  events',
    ];
    for (const h of this.log)
      lines.push(
        `${h.at.toFixed(1).padStart(6)} ${h.gap.toFixed(0).padStart(4)} ${h.sim.toFixed(1).padStart(4)}(${h.ticks}) ${h.events.toFixed(1).padStart(4)} ${h.render.toFixed(1).padStart(5)} ${h.hud.toFixed(1).padStart(4)} ${h.other.toFixed(0).padStart(5)}  ${String(h.newPrograms).padStart(4)} ${String(h.newTextures).padStart(3)} ${String(h.newGeometries).padStart(3)}  ${this.cause(h)}  ${h.evNames}`,
      );
    return lines.join('\n');
  }

  private ensureEl() {
    if (this.el || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(0,0,0,.78);color:#cfe;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;padding:6px 8px;border-radius:6px;pointer-events:auto;max-width:96vw;white-space:pre;overflow:auto;max-height:46vh';
    const cv = document.createElement('canvas');
    cv.width = 360;
    cv.height = 60;
    cv.style.cssText = 'display:block;width:360px;height:60px;margin-bottom:4px';
    const txt = document.createElement('div');
    const btn = document.createElement('button');
    btn.textContent = 'Copy report';
    btn.style.cssText = 'margin-top:4px;font:inherit;padding:2px 8px';
    btn.onclick = () => {
      const r = this.report();
      void navigator.clipboard?.writeText(r).then(
        () => (btn.textContent = 'Copied'),
        () => (btn.textContent = 'Copy failed'),
      );
    };
    el.append(cv, txt, btn);
    document.body.appendChild(el);
    this.el = el;
    this.canvas = cv;
  }

  private draw() {
    if (!this.el || !this.canvas) return;
    const g = this.canvas.getContext('2d');
    if (g) {
      const W = this.canvas.width;
      const H = this.canvas.height;
      g.clearRect(0, 0, W, H);
      // guide lines at 16.7 ms (60 fps) and 33.3 ms (30 fps); bars scale to 66 ms
      const y = (ms: number) => H - Math.min(1, ms / 66.7) * H;
      g.fillStyle = 'rgba(255,255,255,.25)';
      g.fillRect(0, y(16.7), W, 1);
      g.fillRect(0, y(33.3), W, 1);
      const n = this.gaps.length;
      const bw = W / 180;
      for (let i = 0; i < n; i++) {
        const ms = this.gaps[i];
        g.fillStyle = ms > Math.max(25, this.typical * 2) ? '#ff5050' : ms > this.typical * 1.4 ? '#ffc040' : '#50e070';
        const top = y(ms);
        g.fillRect((180 - n + i) * bw, top, Math.max(1, bw - 0.5), H - top);
      }
    }
    const txt = this.el.children[1] as HTMLDivElement;
    txt.textContent = this.report().split('\n').slice(2).join('\n');
  }
}

/** Adds this tick's sim event kinds to a short, deduplicated list for the hitch log (e.g. "impact,death,fire"). */
export function hitchEventNames(acc: string, evs: readonly { t: string }[]): string {
  if (!evs.length) return acc;
  const have = new Set(acc ? acc.split(',') : []);
  for (const e of evs) if (have.size < 6) have.add(e.t);
  return [...have].join(',');
}

/** The game's one recorder. */
export const hitches = new HitchRecorder();
