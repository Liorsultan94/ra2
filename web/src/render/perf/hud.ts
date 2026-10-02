import type * as THREE from 'three';

/**
 * Performance preferences (Settings: "Show FPS", "Battery saver") and the
 * small on-screen perf readout.
 *
 * - showFps / ?fps=1: fps, frame ms, draw calls, triangles, shader programs
 *   and the quality governor rung, refreshed twice a second.
 * - battery / ?fps30=1: frames are capped at 30 fps (frameGate) and the
 *   governor judges frames against that budget.
 */
export const perfPrefs = { showFps: false, battery: false };

const qs = typeof location !== 'undefined' ? location.search : '';
if (/[?&]fps=1\b/.test(qs)) perfPrefs.showFps = true;
if (/[?&]fps30=1\b/.test(qs)) perfPrefs.battery = true;

export function setPerfPrefs(p: { showFps?: boolean; battery?: boolean }) {
  if (/[?&]fps=1\b/.test(qs)) perfPrefs.showFps = true;
  else perfPrefs.showFps = !!p.showFps;
  perfPrefs.battery = !!p.battery || /[?&]fps30=1\b/.test(qs);
}

let lastShown = -1e9;
/**
 * Battery saver frame cap: true when this animation frame should be skipped
 * (call first thing in the rAF callback, before the frame's dt is taken).
 */
export function skipFrame(now: number): boolean {
  if (!perfPrefs.battery) return false;
  // 2 ms slack: on a 60 Hz display every second vsync is taken (33.3 ms), on 120 Hz every fourth
  if (now - lastShown < 1000 / 30 - 2) return true;
  lastShown = now;
  return false;
}

export interface PerfHudSource {
  gl: THREE.WebGLRenderer;
  level: number;
  levels: number;
  pr: number;
  extra?: string;
}

/** Tiny fixed overlay; created lazily when shown. */
export class PerfHud {
  private el: HTMLDivElement | null = null;
  private times: number[] = [];
  private last = 0;
  private calls = 0;
  private tris = 0;
  private n = 0;
  private refresh = 0;

  /** Call once per rendered frame after all passes (info.autoReset is off, so the counts cover the whole frame). */
  frame(src: PerfHudSource) {
    if (!perfPrefs.showFps) {
      if (this.el) this.el.style.display = 'none';
      return;
    }
    const now = performance.now();
    if (this.last) this.times.push(now - this.last);
    else this.refresh = now;
    this.last = now;
    const info = src.gl.info.render;
    this.calls += info.calls;
    this.tris += info.triangles;
    this.n++;
    if (now - this.refresh < 500) return;
    if (!this.el) {
      const el = document.createElement('div');
      el.className = 'perf-hud';
      el.style.cssText =
        'position:fixed;left:50%;top:max(2px,env(safe-area-inset-top));transform:translateX(-50%);z-index:9999;pointer-events:none;' +
        'font:600 10px/1.25 ui-monospace,Menlo,Consolas,monospace;color:#d8f0c0;background:rgba(0,0,0,.55);padding:2px 6px;border-radius:4px;white-space:pre;text-shadow:0 1px 0 #000';
      document.body.appendChild(el);
      this.el = el;
    }
    this.el.style.display = '';
    const t = this.times;
    const span = now - this.refresh;
    const avg = t.length ? t.reduce((a, b) => a + b, 0) / t.length : span;
    const worst = t.length ? Math.max(...t) : span;
    const fps = avg > 0 ? 1000 / avg : 0;
    this.refresh = now;
    const k = Math.max(1, this.n);
    const progs = src.gl.info.programs?.length ?? 0;
    const tri = this.tris / k;
    this.el.textContent =
      `${fps.toFixed(fps < 10 ? 1 : 0)} fps  ${avg.toFixed(1)} ms (max ${worst.toFixed(0)})${perfPrefs.battery ? '  30cap' : ''}\n` +
      `${Math.round(this.calls / k)} calls  ${tri >= 1e6 ? (tri / 1e6).toFixed(2) + 'M' : Math.round(tri / 1000) + 'k'} tris  ${progs} prg  Q${src.level}/${src.levels - 1} pr${src.pr}${src.extra ? '  ' + src.extra : ''}`;
    t.length = 0;
    this.calls = this.tris = this.n = 0;
  }

  dispose() {
    this.el?.remove();
    this.el = null;
  }
}
