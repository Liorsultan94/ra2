import type { Quality } from './renderer';

/*
 * Automatic graphics quality ("Auto" in the settings).
 *
 * probeDevice() looks at what the browser tells us about the GPU and the
 * machine: WebGL2, float render targets + max texture size (the renderer's
 * ultra requirements), the unmasked GPU name (WEBGL_debug_renderer_info),
 * device memory, cores, pixel ratio, coarse pointer, plus an optional short
 * (<= ~150 ms) offscreen fragment-shader micro-benchmark. pickQuality() maps
 * that to a tier: strong desktops 'ultra', good phones 'high' (the renderer's
 * frame-time governor scales resolution / effects down when needed), weaker
 * devices 'medium' / 'low'. The result is cached in localStorage per device
 * signature, so the probe runs once.
 *
 * Runtime safety (AutoQualityMonitor, fed by the renderer's governor): a
 * session that started on the auto pick and spent a long time below ~30 fps
 * on the governor's lowest rung stores a downgrade for the next session; one
 * that held ~60 fps on the top rung for minutes stores a promotion (up to
 * what the device can run). Nothing here touches the simulation.
 */

const ORDER: Quality[] = ['low', 'medium', 'high', 'ultra'];
const KEY = 'ironfront.autoq.v1';
/** Promotion is not attempted for this long after a demotion. */
const COOL_MS = 3 * 24 * 3600 * 1000;

export type GpuClass = 'software' | 'weak' | 'mid' | 'good' | 'strong' | 'unknown';

export interface DeviceProbe {
  webgl2: boolean;
  /** Float / half-float colour buffers (TAA history, SSR): the renderer's ultra requirement together with maxTex >= 4096. */
  float: boolean;
  maxTex: number;
  /** Unmasked GPU name ('' when the browser hides it). */
  gpu: string;
  gpuClass: GpuClass;
  /** navigator.deviceMemory (GB), 0 when unknown (Safari, Firefox). */
  mem: number;
  cores: number;
  dpr: number;
  coarse: boolean;
  /** Micro-benchmark throughput (G shader iterations / s), -1 when not run. */
  bench: number;
}

// --------------------------------------------------------------- classify

/** Rough GPU class from the unmasked renderer string. */
export function classifyGpu(name: string): GpuClass {
  const s = name.toLowerCase();
  if (!s) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|lavapipe/.test(s)) return 'software';
  // ---- desktop discrete / high end
  if (/geforce|nvidia|quadro|rtx|gtx|tesla/.test(s)) {
    // old / entry-level GeForce
    if (/gt \d{3}\b|gtx (4|5|6)\d\d\b|mx\s?\d{3}|geforce (8|9)\d{3}/.test(s)) return 'mid';
    return 'strong';
  }
  if (/radeon/.test(s)) {
    // APU graphics: 680M / 780M class are decent, older "Radeon(TM) Graphics" / Vega 3-11 are not
    if (/(680|760|780|880|890)m\b/.test(s)) return 'good';
    if (/\brx\b|radeon pro|vega (56|64)|radeon vii|\br9\b/.test(s) && !/vega \d\b/.test(s)) return 'strong';
    return 'mid';
  }
  if (/apple m\d|apple m\d (pro|max|ultra)/.test(s)) return 'strong';
  if (/intel/.test(s)) {
    if (/arc/.test(s)) return 'strong';
    if (/iris|xe/.test(s)) return 'good';
    if (/uhd/.test(s)) return 'mid';
    return 'weak'; // HD 4000-era
  }
  // ---- mobile
  if (/apple gpu|apple a\d+/.test(s)) return 'good'; // iOS / iPadOS hide the model; recent devices are all capable
  const adreno = /adreno[^\d]*(\d{3})/.exec(s);
  if (adreno) {
    const n = +adreno[1];
    if (n >= 730 || (n >= 640 && n < 700)) return 'good';
    if (n >= 540) return 'mid'; // 540-63x, 7xx entry parts (710, 720)
    return 'weak';
  }
  if (/immortalis|xclipse/.test(s)) return 'good';
  const mali = /mali-?\s?([gt])?(\d+)/.exec(s);
  if (mali) {
    const g = mali[1] === 'g';
    const n = +mali[2];
    if (!g) return 'weak'; // Mali-4xx / T6xx-T8xx
    if (n >= 610 || (n >= 71 && n < 100)) return n === 71 || n === 72 ? 'mid' : 'good'; // G76-G78, G610-G720
    if (n >= 52 && n < 100) return 'mid'; // G52 / G57 / G68
    return 'weak'; // G31 / G51
  }
  if (/powervr|sgx|rogue|img /.test(s)) return 'weak';
  if (/maleoon|videocore|vivante|tegra/.test(s)) return 'weak';
  return 'unknown';
}

const BENCH_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uSeed;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy * 0.013 + uSeed;
  float a = 0.0;
  for (int i = 0; i < 96; i++) {
    p = vec2(p.y * 1.0007 + sin(p.x), p.x * 0.9993 - cos(p.y)) * 0.97 + 0.13;
    a += p.x * p.y * 0.001;
  }
  o = vec4(fract(a), fract(p), 1.0);
}`;
const BENCH_VS = /* glsl */ `#version 300 es
in vec2 aP;
void main() { gl_Position = vec4(aP, 0.0, 1.0); }`;
const BENCH_ITERS = 96;
const BENCH_PX = 384;

/**
 * Fragment throughput in G loop iterations / s on an offscreen 384x384 target.
 * Keeps doubling the draw count until a timed run takes >= 18 ms, within `budget` ms overall.
 */
function microBench(gl: WebGL2RenderingContext, budget: number): number {
  const t0 = performance.now();
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, BENCH_VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, BENCH_FS));
  gl.bindAttribLocation(prog, 0, 'aP');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return -1;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, BENCH_PX, BENCH_PX);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, BENCH_PX, BENCH_PX);
  const uSeed = gl.getUniformLocation(prog, 'uSeed');
  const px = new Uint8Array(4);
  const run = (n: number) => {
    for (let i = 0; i < n; i++) {
      gl.uniform1f(uSeed, i * 0.37);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
  };
  // warm-up (shader compile / first-use costs stay out of the measurement)
  run(1);
  let draws = 1;
  let best = -1;
  while (performance.now() - t0 < budget) {
    const s = performance.now();
    run(draws);
    const ms = performance.now() - s;
    if (ms >= 18 || performance.now() - t0 + ms * 2.2 > budget) {
      best = (draws * BENCH_PX * BENCH_PX * BENCH_ITERS) / (Math.max(ms, 0.05) * 1e6);
      break;
    }
    draws *= ms < 4 ? 4 : 2;
  }
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  return best;
}

/** Probe the device (creates and releases a throwaway WebGL2 context). */
export function probeDevice(bench = true): DeviceProbe {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { deviceMemory?: number };
  const p: DeviceProbe = {
    webgl2: false,
    float: false,
    maxTex: 0,
    gpu: '',
    gpuClass: 'unknown',
    mem: nav.deviceMemory ?? 0,
    cores: nav.hardwareConcurrency || 4,
    dpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    coarse: typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
    bench: -1,
  };
  let gl: WebGL2RenderingContext | null = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 4;
    gl = cv.getContext('webgl2', { powerPreference: 'high-performance', antialias: false, depth: false, stencil: false, failIfMajorPerformanceCaveat: false });
    if (gl) {
      p.webgl2 = true;
      p.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      // same test as the renderer's ultraCapable(): float colour buffers for the TAA history
      p.float = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      p.gpu = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '');
      p.gpuClass = classifyGpu(p.gpu);
      if (bench && p.gpuClass !== 'software') p.bench = microBench(gl, 150);
    }
  } catch {
    /* keep what we have */
  } finally {
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* ignore */
    }
  }
  return p;
}

/** Benchmark verdict (G it/s); thresholds are deliberately loose, the governor fine-tunes at runtime. */
function benchClass(b: number): GpuClass {
  if (b < 0) return 'unknown';
  if (b < 3) return 'weak';
  if (b < 20) return 'mid';
  if (b < 200) return 'good';
  return 'strong';
}

/** Highest tier the device may run at all ('ultra' needs the float targets, and phones stop at 'high'). */
export function ceilingFor(p: DeviceProbe): Quality {
  if (!p.webgl2 || p.gpuClass === 'software') return 'low';
  if (p.coarse) return 'high';
  return p.float && p.maxTex >= 4096 ? 'ultra' : 'high';
}

/** Pure mapping from a probe to a tier. */
export function pickQuality(p: DeviceProbe): Quality {
  if (!p.webgl2 || p.gpuClass === 'software') return 'low';
  const ceil = ORDER.indexOf(ceilingFor(p));
  let cls: GpuClass = p.gpuClass;
  const bc = benchClass(p.bench);
  if (cls === 'unknown') cls = bc === 'unknown' ? (p.coarse ? 'mid' : 'good') : bc;
  // the benchmark can veto an optimistic name (thermal-throttled / power-saving GPU, wrong string)
  if (bc === 'weak' && (cls === 'good' || cls === 'strong' || cls === 'mid')) cls = cls === 'mid' ? 'weak' : 'mid';
  else if (bc === 'mid' && cls === 'strong') cls = 'good';
  let t: number;
  switch (cls) {
    case 'strong':
      t = 3;
      break;
    case 'good':
      t = 2;
      break;
    case 'mid':
      t = p.coarse ? 1 : 2;
      break;
    default:
      t = 1;
  }
  // a fast benchmark lifts a 'good' desktop GPU (e.g. Apple M-series under a generic name)
  if (cls === 'good' && bc === 'strong' && !p.coarse) t = 3;
  // memory / cores: ultra wants headroom; tiny devices keep the cheap path
  const mem = p.mem || (p.coarse ? 4 : 8);
  if (t >= 3 && (mem < 8 || p.cores < 6)) t = 2;
  if (mem <= 2 || p.cores <= 2) t = Math.min(t, cls === 'strong' || cls === 'good' ? 1 : 0);
  // very weak GPU names on phones: the cheap path
  if (cls === 'weak' && p.coarse && (bc === 'weak' || mem <= 3)) t = 0;
  // dense phone screens cost a lot of fill rate on mid GPUs
  if (p.coarse && cls === 'mid' && p.dpr >= 3) t = Math.min(t, 1);
  return ORDER[Math.max(0, Math.min(ceil, t))];
}

// ------------------------------------------------------------------ cache

interface Cache {
  /** Device key (no GL needed): cores, memory, pointer, screen, browser. A different key re-probes. */
  qs: string;
  /** Tier from the probe. */
  base: Quality;
  ceil: Quality;
  /** Runtime correction in tiers (-2 .. +1). */
  adj: number;
  /** Last demotion (ms epoch). */
  down: number;
  gpu: string;
  bench: number;
}

function deviceKey(): string {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
    const sc = typeof screen !== 'undefined' ? `${Math.max(screen.width, screen.height)}x${Math.min(screen.width, screen.height)}` : '';
    // browser family + major version: an update can change what the GPU exposes
    const ua = /(firefox|edg|opr|chrome|crios|version)\/(\d+)/i.exec(nav.userAgent);
    return [nav.hardwareConcurrency || 4, nav.deviceMemory ?? 0, coarse ? 1 : 0, sc, ua ? ua[1] + ua[2] : ''].join('|');
  } catch {
    return '';
  }
}
function load(): Cache | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cache;
    return c && typeof c.base === 'string' && ORDER.includes(c.base) && ORDER.includes(c.ceil) && typeof c.adj === 'number' ? c : null;
  } catch {
    return null;
  }
}
function save(c: Cache) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode / quota: fine, we just probe again next time */
  }
}

function resolved(c: Cache): Quality {
  const i = ORDER.indexOf(c.base) + c.adj;
  return ORDER[Math.max(0, Math.min(ORDER.indexOf(c.ceil), i))];
}

/** What the last autoQuality() call picked (the monitor only acts on sessions that use it). */
let session: { pick: Quality; cache: Cache } | null = null;

/**
 * Best quality tier for this device: cached probe result plus the runtime
 * correction. Cheap after the first call (memory / localStorage).
 */
export function autoQuality(): Quality {
  if (session) return session.pick;
  let c = load();
  const qs = deviceKey();
  if (!c || c.qs !== qs) {
    const p = probeDevice(true);
    c = { qs, base: pickQuality(p), ceil: ceilingFor(p), adj: 0, down: 0, gpu: p.gpu, bench: Math.round(p.bench * 10) / 10 };
    save(c);
  }
  const pick = resolved(c);
  session = { pick, cache: c };
  return pick;
}

/** Debug / tests: forget the cached probe (next autoQuality() probes again). */
export function resetAutoQuality() {
  session = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Debug: the cached probe record. */
export function autoQualityInfo(): Record<string, unknown> | null {
  return load() as Record<string, unknown> | null;
}

// ---------------------------------------------------------------- monitor

/**
 * Fed by the renderer's quality governor once per measurement window; on a
 * session running the auto pick, persists a one-tier demotion / promotion for
 * the next session (never changes the current one: the governor already
 * handles that).
 */
export class AutoQualityMonitor {
  private readonly active: boolean;
  private t = 0;
  private slow = 0;
  private fast = 0;
  private done = false;

  constructor(requested: Quality) {
    this.active = !!session && session.pick === requested;
  }

  /**
   * One governor window: `level` of `levels` rungs (0 = best), median frame time (s),
   * frames in the window, battery-saver frame cap on.
   */
  sample(level: number, levels: number, med: number, frames: number, capped: boolean) {
    if (!this.active || this.done || !session) return;
    const dur = Math.min(5, med * frames);
    this.t += dur;
    if (this.t < 20) return; // loading, shader warm-up, first camera moves
    const c = session.cache;
    // sustained < ~30 fps (or < ~22 with the 30 fps battery cap) on the lowest rung
    const bad = level >= levels - 1 && med > (capped ? 1 / 22 : 1 / 30);
    this.slow = bad ? this.slow + dur : Math.max(0, this.slow - dur * 0.5);
    if (this.slow > 25 && c.adj > -2) {
      c.adj -= 1;
      c.down = Date.now();
      save(c);
      this.done = true;
      return;
    }
    // held ~58+ fps at the top rung for minutes (not judged under the battery cap)
    const good = !capped && level === 0 && med < 1 / 57;
    this.fast = good ? this.fast + dur : Math.max(0, this.fast - dur * 2);
    if (this.fast > 150 && c.adj < 1 && resolved(c) !== c.ceil && Date.now() - (c.down || 0) > COOL_MS) {
      c.adj += 1;
      save(c);
      this.done = true;
    }
  }
}
