import type { FogOfWar } from './fog';

/*
 * Per-match model caches.
 *
 * The model builders cache templates and materials per fog of war (the fog
 * uniforms are bound into the materials), keyed by a per-module fog id. Every
 * match - and every demo battle behind the menu - has its own FogOfWar, so
 * without a purge each one added a full set of templates (geometry, materials,
 * and through their uniforms the old FogOfWar itself) that stayed alive for the
 * rest of the session: memory grew match after match until the browser killed
 * the tab. The renderer releases its fog on dispose; every cache drops the
 * entries built for it.
 */

type Purger = (fog: FogOfWar) => void;
const purgers: Purger[] = [];

/** Register a cache purge (module load time). */
export function onFogRelease(fn: Purger) {
  purgers.push(fn);
}

/** A match ended: drop every cached template / material built for its fog of war. */
export function releaseFog(fog: FogOfWar) {
  for (const p of purgers) {
    try {
      p(fog);
    } catch (e) {
      console.warn('[fogcache] purge failed', e);
    }
  }
}

/** Delete the keys of a map that match. */
export function purgeKeys<K, V>(map: Map<K, V>, match: (k: K, v: V) => boolean) {
  for (const [k, v] of [...map]) if (match(k, v)) map.delete(k);
}
