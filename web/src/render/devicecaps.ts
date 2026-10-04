/*
 * Phone texture / memory caps.
 *
 * Phones run at most 'high' (autoquality.ts ceilingFor), but 'high' was sized
 * for desktops: 1024 px photoscanned ground arrays (~100 MB of GPU memory with
 * mips), a 4096 shadow map, 1024 vehicle bake atlases. On a phone screen the
 * difference is invisible while the memory pushes the tab towards the
 * browser's out-of-memory kill ("Aw, Snap" / page reloads). Touch devices get
 * the next size down; ?caps=0 lifts the caps (screenshots / A-B checks).
 */

let cached: boolean | null = null;

/** True on touch-first devices (coarse pointer): cap texture sizes. */
export function phoneCaps(): boolean {
  if (cached !== null) return cached;
  try {
    const off = typeof location !== 'undefined' && /[?&]caps=0\b/.test(location.search);
    cached = !off && typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    cached = false;
  }
  return cached;
}
