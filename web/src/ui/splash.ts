/*
 * Boot splash controller.
 *
 * The splash markup, its CSS animation and a tiny inline script live in
 * index.html so the emblem paints before any JavaScript has downloaded. This
 * module (part of the small entry chunk, no heavy imports) drives the progress
 * bar and status lines from real loading milestones, streams the game chunks
 * with byte progress, and finally morphs the emblem + wordmark into the main
 * menu title.
 */

type Win = Window & { __ifT0?: number; __ifWordT?: number; __IF_PRELOAD?: [string, number][] };
const win = window as Win;

/** Minimum time on screen so the emblem animation reads (unless tapped). */
const MIN_MS = 1500;
/** Time the wordmark slam needs to settle before the splash may leave. */
const WORD_SETTLE_MS = 750;

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const mb = (b: number) => (b / 1048576).toFixed(1);

function unionRect(els: Element[]): DOMRect | null {
  const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (!rs.length) return null;
  const l = Math.min(...rs.map((r) => r.left));
  const t = Math.min(...rs.map((r) => r.top));
  const r = Math.max(...rs.map((x) => x.right));
  const b = Math.max(...rs.map((x) => x.bottom));
  return new DOMRect(l, t, r - l, b - t);
}

export class Splash {
  private readonly el = document.getElementById('splash');
  private p = 0.02;
  private from = 0;
  private to = 0.05;
  private creep = 0;
  private tapped = false;
  private tapWaiters: (() => void)[] = [];
  private gesture: (() => void) | null = null;

  constructor() {
    if (!this.el) return;
    const tap = () => {
      this.tapped = true;
      this.gesture?.();
      for (const f of this.tapWaiters.splice(0)) f();
    };
    this.el.addEventListener('pointerdown', tap);
    const key = (e: KeyboardEvent) => {
      if (!this.el?.isConnected) return window.removeEventListener('keydown', key);
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') tap();
    };
    window.addEventListener('keydown', key);
  }

  get active() {
    return !!this.el?.isConnected;
  }

  /** Called synchronously inside the user gesture that taps the splash (audio unlock). */
  onGesture(fn: () => void) {
    this.gesture = fn;
  }

  /** Start a loading stage covering the progress range [from, to]. */
  stage(text: string, from: number, to: number, detail = '') {
    this.from = from;
    this.to = to;
    this.setP(from);
    this.setDetail(detail);
    const lines = this.el?.querySelector('.bs-lines');
    if (!lines) return;
    if (lines.querySelector<HTMLElement>('.now')?.dataset.t === text) return;
    this.markDone();
    const d = document.createElement('div');
    d.className = 'now';
    d.dataset.t = text;
    d.textContent = `${text}…`;
    lines.appendChild(d);
    while (lines.children.length > 3) lines.firstElementChild!.remove();
  }

  /** Progress inside the current stage (k = 0..1). */
  sub(k: number, detail?: string) {
    this.setP(this.from + (this.to - this.from) * Math.max(0, Math.min(1, k)));
    if (detail !== undefined) this.setDetail(detail);
  }

  /**
   * Load the game module. In a build the entry knows every chunk the game needs
   * (index.html carries the list): they are streamed in parallel with real byte
   * progress, then imported from the HTTP cache. In dev (or if streaming fails)
   * it just imports, with a gentle creep on the bar.
   */
  async loadModule<T>(load: () => Promise<T>): Promise<T> {
    const list = win.__IF_PRELOAD;
    if (list?.length && typeof fetch === 'function' && this.el) {
      try {
        await this.stream(list);
      } catch (e) {
        console.warn('[splash] chunk streaming failed, importing directly', e);
      }
    } else {
      this.startCreep();
    }
    try {
      return await load();
    } finally {
      this.stopCreep();
    }
  }

  private async stream(list: [string, number][]) {
    const total = list.reduce((s, [, n]) => s + n, 0) || 1;
    let got = 0;
    let shown = -1;
    const update = () => {
      const k = Math.min(1, got / total);
      if (k - shown < 0.005 && k < 1) return;
      shown = k;
      this.sub(k, `${mb(got)} / ${mb(total)} MB`);
    };
    update();
    await Promise.all(
      list.map(async ([file, size]) => {
        const res = await fetch(new URL(file, document.baseURI).href);
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        let mine = 0;
        const add = (n: number) => {
          const d = Math.min(n, size - mine);
          if (d <= 0) return;
          mine += d;
          got += d;
          update();
        };
        if (res.body) {
          const rd = res.body.getReader();
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            add(value.byteLength);
          }
        } else {
          await res.arrayBuffer();
        }
        add(size);
      }),
    );
  }

  private startCreep() {
    this.stopCreep();
    this.creep = window.setInterval(() => this.setP(this.p + (this.to - this.p) * 0.05), 120);
  }

  private stopCreep() {
    if (this.creep) clearInterval(this.creep);
    this.creep = 0;
  }

  private setP(p: number) {
    p = Math.max(this.p, Math.min(1, p));
    this.p = p;
    if (!this.el) return;
    const bar = this.el.querySelector<HTMLElement>('.bs-bar i');
    if (bar) bar.style.transform = `scaleX(${Math.max(0.02, p).toFixed(4)})`;
    const pct = this.el.querySelector('.bs-pct');
    const v = String(Math.round(p * 100));
    if (pct) pct.textContent = `${v}%`;
    this.el.setAttribute('aria-valuenow', v);
  }

  private setDetail(text: string) {
    const d = this.el?.querySelector('.bs-detail');
    if (d) d.textContent = text;
  }

  private markDone() {
    const now = this.el?.querySelector<HTMLElement>('.bs-lines .now');
    if (!now) return;
    now.classList.remove('now');
    now.textContent = now.dataset.t ?? now.textContent;
  }

  private waitTap(ms: number): Promise<void> {
    if (this.tapped) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        res();
      }
      this.tapWaiters.push(done);
    });
  }

  /**
   * Loading is complete: keep the splash up for the minimum time (a tap skips
   * it), ask for a tap if the tab is in the background, then morph the emblem
   * and wordmark into the menu title rendered underneath (menuRoot).
   */
  async finish(menuRoot: HTMLElement | null) {
    const el = this.el;
    if (!el?.isConnected) return;
    this.stopCreep();
    this.markDone();
    this.setP(1);
    this.setDetail('Battlefield ready');
    const title = menuRoot?.querySelector<HTMLElement>('.title-screen') ?? null;
    title?.classList.add('intro');
    // let the animation read: at least MIN_MS after first paint and the wordmark settled
    const t0 = win.__ifT0 ?? 0;
    for (;;) {
      const wordT = win.__ifWordT;
      const until = Math.max(t0 + MIN_MS, (wordT ?? performance.now() + 100) + WORD_SETTLE_MS);
      const left = until - performance.now();
      if (left <= 0 || this.tapped) break;
      await this.waitTap(Math.min(left, 250));
    }
    if (document.hidden && !this.tapped) {
      const lines = el.querySelector('.bs-lines');
      if (lines) {
        const d = document.createElement('div');
        d.className = 'tap';
        d.textContent = 'Tap to start';
        lines.appendChild(d);
        while (lines.children.length > 3) lines.firstElementChild!.remove();
      }
      await this.waitTap(1e9);
    }
    await this.morph(el, title);
  }

  private async morph(el: HTMLElement, title: HTMLElement | null) {
    const reduce = reducedMotion();
    el.classList.add('out');
    const word = el.querySelector<HTMLElement>('.bs-word');
    const em = el.querySelector<HTMLElement>('.bs-em');
    const pairs: [HTMLElement | null, DOMRect | null, 'h' | 'w'][] = title
      ? [
          [word, unionRect([...title.querySelectorAll('.logo-top, .logo-bottom')]), 'h'],
          [em, unionRect([...title.querySelectorAll('.logo-emblem')]), 'w'],
        ]
      : [];
    if (reduce || !title) {
      el.style.transition = 'opacity .5s ease';
      el.style.opacity = '0';
      title?.classList.remove('intro');
      await sleep(520);
      el.remove();
      return;
    }
    for (const [src, to, fit] of pairs) {
      if (!src) continue;
      const from = src.getBoundingClientRect();
      src.style.animation = 'none';
      if (!to || !from.width) {
        src.style.transition = 'opacity .4s ease';
        src.style.opacity = '0';
        continue;
      }
      const s = fit === 'h' ? to.height / from.height : to.width / from.width;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      void src.offsetWidth;
      src.style.transition = 'transform .8s cubic-bezier(.65,0,.25,1), opacity .38s ease .44s';
      src.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(4)})`;
      src.style.opacity = '0';
    }
    // the menu title fades in under the arriving lockup (crossfade)
    await sleep(430);
    title.classList.remove('intro');
    await sleep(420);
    el.remove();
  }

  /** Loading failed: say so and reload on tap. */
  fail(msg: string) {
    const lines = this.el?.querySelector('.bs-lines');
    if (!lines) return;
    this.stopCreep();
    const d = document.createElement('div');
    d.className = 'tap';
    d.textContent = `${msg} · tap to retry`;
    lines.appendChild(d);
    while (lines.children.length > 3) lines.firstElementChild!.remove();
    this.tapWaiters.push(() => location.reload());
  }

  /** Quick fade (debug URLs that skip the menu, or a battle's own loading overlay taking over). */
  dismiss() {
    const el = this.el;
    if (!el?.isConnected) return;
    this.stopCreep();
    el.classList.add('out');
    el.style.transition = 'opacity .4s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 450);
  }
}
