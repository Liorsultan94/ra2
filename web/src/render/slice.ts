import type * as THREE from 'three';

/*
 * Cooperative time slicing for long loading work.
 *
 * Browsers show "Page unresponsive - Wait / Exit page" when the main thread
 * does not get back to input for several seconds; on a phone the battle build
 * (models, vehicle bakes, shader programs) used to run as one task of many
 * seconds. Loading code calls `await slicer.tick()` between units of work:
 * once the slice budget (~35 ms) is used up it yields one macrotask, so input,
 * the loading screen and the compositor keep running, and the next slice
 * starts fresh.
 */

type SchedulerYield = { yield?: () => Promise<void> };

/** Give the event loop one turn (input, timers, rendering) and continue. */
export function yieldNow(): Promise<void> {
  const s = (globalThis as { scheduler?: SchedulerYield }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((res) => setTimeout(res, 0));
}

/** One animation frame (the loading overlay / briefing gets painted). */
export function nextFrame(): Promise<void> {
  return new Promise((res) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => res()) : setTimeout(res, 16)));
}

/** Thrown by a Slicer whose owner went away (a battle quit while it was still loading). */
export class Aborted extends Error {
  constructor() {
    super('aborted');
  }
}

export class Slicer {
  private t0 = performance.now();
  /** Longest slice seen (ms), for the loading stats. */
  worst = 0;
  /** `abort` is checked at every yield: once it returns true the work stops (Aborted is thrown). */
  constructor(
    readonly budget = 35,
    private abort: () => boolean = () => false,
  ) {}

  /** Yield if this slice has used its budget. */
  async tick(): Promise<void> {
    if (performance.now() - this.t0 < this.budget) return;
    await this.yield();
  }

  /** Yield now (a step that is known to be heavy follows). */
  async yield(): Promise<void> {
    this.worst = Math.max(this.worst, performance.now() - this.t0);
    await yieldNow();
    if (this.abort()) throw new Aborted();
    this.t0 = performance.now();
  }

  /** Restart the slice clock (after an await that already yielded). */
  reset() {
    if (this.abort()) throw new Aborted();
    this.t0 = performance.now();
  }
}

interface ProgramLike {
  isReady(): boolean;
  getUniforms(): unknown;
}

const settled = new WeakSet<object>();

/**
 * Finish every shader program the renderer has created so far, a few at a time.
 *
 * With KHR_parallel_shader_compile (most browsers) the driver compiles in the
 * background: wait (asynchronously) until each program reports ready. Without
 * it (some drivers, software GL) the first use of a program blocks until it is
 * linked; doing that here, one program per step with yields in between, keeps
 * each blocking wait to a single program instead of the whole batch landing
 * in the first frame that draws them.
 */
export async function settlePrograms(gl: THREE.WebGLRenderer, slicer: Slicer): Promise<number> {
  const parallel = !!gl.extensions.get('KHR_parallel_shader_compile');
  const list = (gl.info.programs ?? []) as unknown as ProgramLike[];
  let n = 0;
  for (const p of list.slice()) {
    if (settled.has(p)) continue;
    if (parallel) {
      let waited = 0;
      while (!p.isReady() && waited < 20000) {
        await new Promise((r) => setTimeout(r, 8));
        waited += 8;
        slicer.reset();
      }
    }
    try {
      p.getUniforms(); // first use: links / reads the uniform table (blocking only without parallel compile)
    } catch {
      /* a failed program is reported by three when it is drawn */
    }
    settled.add(p);
    n++;
    // without parallel compile each program is a blocking step of its own
    if (parallel) await slicer.tick();
    else await slicer.yield();
  }
  return n;
}
