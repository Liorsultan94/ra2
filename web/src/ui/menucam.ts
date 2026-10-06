import type { Game } from '../game/game';

/*
 * Cinematic camera for the demo battle behind the main menu (menu.ts).
 *
 * The attract game already drifts its view target towards the fighting
 * (game.ts updateCamera); this adds a very slow orbit (about 1.4 degrees a
 * second, the sun turns with the view so the light stays from the upper left)
 * which makes the static RTS view read like a flyover. Costs nothing: it only
 * sets the renderer's view yaw. Off with prefers-reduced-motion.
 */

type Orbit = { yaw: number; yawGoal?: number };

const RATE = 0.025; // rad / s

export function startMenuCamera(get: () => Game | null): () => void {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
  let raf = 0;
  let last = 0;
  let cur: Game | null = null;
  let yaw = 0;
  let t = 0;
  const step = (now: number) => {
    raf = requestAnimationFrame(step);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    const g = get();
    if (!g || document.hidden) return;
    const r = g.renderer as unknown as Orbit;
    if (g !== cur) {
      cur = g;
      yaw = r.yaw;
      t = 0;
    }
    // ease in over the first seconds so the orbit never starts with a jolt
    t += dt;
    yaw += dt * RATE * Math.min(1, t / 3);
    // the renderer animates yaw towards yawGoal (90 degree view steps): keep both in step
    r.yawGoal = yaw;
    r.yaw = yaw;
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    // (the closure outlives the menu in places: do not keep the last demo battle with it)
    cur = null;
  };
}
