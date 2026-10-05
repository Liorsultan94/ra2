/*
 * Phone texture / memory caps.
 *
 * Phones run at most 'high' (autoquality.ts ceilingFor), but 'high' was sized
 * for desktops: 1024 px photoscanned ground arrays (~100 MB of GPU memory with
 * mips), a 4096 shadow map, 1024 vehicle bake atlases. On a phone screen the
 * difference is invisible while the memory pushes the tab towards the
 * browser's out-of-memory kill ("Aw, Snap" / page reloads). Touch devices get
 * the next size down, but only when they report 4 GB of memory or less (navigator.deviceMemory):
 * capable phones keep full quality. ?caps=0 lifts the caps, ?caps=1 forces them (screenshots / A-B checks).
 */

let cached: boolean | null = null;

/** True on touch-first devices (coarse pointer): cap texture sizes. */
export function phoneCaps(): boolean {
  if (cached !== null) return cached;
  try {
    const off = typeof location !== 'undefined' && /[?&]caps=0\b/.test(location.search);
    // only low-memory devices (navigator.deviceMemory <= 4 GB, where the browser reports it): the owner wants
    // no visible quality loss, so capable phones keep the full-size textures and shadows; ?caps=1 forces the caps
    const force = typeof location !== 'undefined' && /[?&]caps=1\b/.test(location.search);
    const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    const mem = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
    cached = !off && (force || (touch && typeof mem === 'number' && mem <= 4));
  } catch {
    cached = false;
  }
  return cached;
}
