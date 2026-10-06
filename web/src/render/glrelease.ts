import * as THREE from 'three';

/*
 * three adds a 'dispose' listener to every material a WebGLRenderer compiles and takes it off only when that
 * material itself is disposed. The session caches share materials between matches (munitions, cargo, model
 * templates...), so every finished match's WebGLRenderer, with its whole program cache (uniform locations,
 * cache keys: some MB per match), stayed reachable through them. The materials that ever got a 'dispose'
 * listener are tracked here (weakly), so a finished renderer's listener can be taken off all of them.
 * (Nothing in the game adds 'dispose' listeners to materials itself: they all belong to renderers.)
 */
const tracked: WeakRef<THREE.Material>[] = [];
const isTracked = new WeakSet<THREE.Material>();
type Listen = (this: THREE.Material, type: string, fn: unknown) => void;
const proto = THREE.Material.prototype as unknown as { addEventListener: Listen };
const base = proto.addEventListener;
proto.addEventListener = function (type, fn) {
  if (type === 'dispose' && !isTracked.has(this)) {
    isTracked.add(this);
    tracked.push(new WeakRef(this));
  }
  base.call(this, type, fn);
};

const disposeListeners = (m: THREE.Material): unknown[] => (m as unknown as { _listeners?: Record<string, unknown[]> })._listeners?.dispose ?? [];

/**
 * A match's renderer is done: find its material listener (the one on the most of its scene's materials, which
 * only it drew) and take it off every material. Call with the scene still populated. Returns the number of
 * materials it was removed from (0 when the listener could not be told apart).
 */
export function releaseMaterialListeners(scene: THREE.Object3D): number {
  const count = new Map<unknown, number>();
  const seen = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      for (const f of new Set(disposeListeners(mat))) count.set(f, (count.get(f) ?? 0) + 1);
    }
  });
  let best: unknown = null;
  let bc = 0;
  let second = 0;
  for (const [f, c] of count) {
    if (c > bc) {
      second = bc;
      bc = c;
      best = f;
    } else if (c > second) second = c;
  }
  // (an unplayed match drew little: leave everything as it is rather than guess)
  if (!best || bc < seen.size * 0.5 || second >= bc) return 0;
  let n = 0;
  for (let i = tracked.length - 1; i >= 0; i--) {
    const m = tracked[i].deref();
    if (!m) {
      tracked[i] = tracked[tracked.length - 1];
      tracked.pop();
      continue;
    }
    const ls = disposeListeners(m);
    if (!ls.includes(best)) continue;
    m.removeEventListener('dispose', best as () => void);
    n++;
  }
  return n;
}
