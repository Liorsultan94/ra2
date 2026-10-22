/*
 * Screen-space helpers for picking with a finger (game.ts pick).
 *
 * A building is a tall box: seen from the oblique camera, a tap on its roof lands on the ground BEHIND its
 * footprint, so testing the ground tile alone (or a small box at mid height) misses the upper part of the
 * building and the order becomes "walk to the ground behind it". The shape the player sees is the convex
 * hull of the box's projected corners; a tap inside it (plus a fingertip margin) hits the building.
 */

export type Pt = [number, number];

/** Convex hull (monotone chain), counter-clockwise in screen y-down terms; fewer than 3 points come back as they are. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  const up: Pt[] = [];
  for (const p of pts.slice().reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Distance from p to the segment a-b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L)) : 0;
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}

/** True when p is inside the hull, or within `margin` pixels of its outline. */
export function hullHit(hull: Pt[], p: Pt, margin: number): boolean {
  if (hull.length === 0) return false;
  if (hull.length === 1) return Math.hypot(p[0] - hull[0][0], p[1] - hull[0][1]) <= margin;
  let inside = false;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const a = hull[i];
    const b = hull[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) if (segDist(p, hull[i], hull[j]) <= margin) return true;
  return false;
}

/** Centroid of the hull's points (for choosing between buildings that overlap on screen). */
export function hullCentre(hull: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of hull) {
    x += p[0];
    y += p[1];
  }
  return [x / Math.max(1, hull.length), y / Math.max(1, hull.length)];
}

/**
 * Which unit does a finger mean? `dist` is the distance from the tap to the unit's axis, `body` its on-screen
 * half width. Nearest wins, but a big vehicle's wide halo must not swallow a tap meant for the soldier standing
 * beside it: a bigger body costs a few pixels of distance.
 */
export function touchScore(dist: number, body: number): number {
  return dist + 0.35 * body;
}
