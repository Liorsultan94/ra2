/*
 * Strike camera (drone feed / targeting pod / helicopter sight) maths, kept free of WebGL and the DOM so it
 * can be unit tested: sensor geometry, field of view, projection of the target into the picture, the HUD
 * readouts, the symbology helpers and which strike the picture-in-picture follows.
 *
 * Scale. The RTS world is drawn with its heights squeezed: a strike drone cruises 1.7 tiles above a tank
 * that is half a tile tall. A sensor placed at that height would look across the ground, not down on it.
 * The feed therefore models the aircraft at ALT_EXAG times its drawn height above the ground (directly above
 * its real ground position, on its real bearing to the target), and every readout comes from that same
 * geometry at M_PER_TILE metres per tile. So the depression angle seen in the picture, the altitude and the
 * slant range on the HUD always agree with each other. At 35 m per tile the sim's speeds read true to type
 * (a jet's 6 tiles/s bombing run is 410 kt, a drone or helicopter at 3 tiles/s 200 kt), the altitudes too
 * (a hovering attack helicopter ~530 ft, a strike drone ~780 ft, a jet on its run ~1,200 ft), and a 96-tile
 * map is a 3.4 km front.
 */

/** Metres per map tile for the feed readouts. */
export const M_PER_TILE = 35;
/** Vertical scale of the sensor position over the drawn flight altitude (see the header). */
export const ALT_EXAG = 4;
export const FT_PER_M = 3.2808;
export const KT_PER_MS = 1.9438;

export type FeedKind = 'uav' | 'kami' | 'jet' | 'heli';

// ------------------------------------------------------------------ geometry (three.js axes: x east, y up, z south)

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Sensor position of an aircraft: above its ground point, ALT_EXAG times its height over the target's
 * ground level (at least `minAgl` tiles drawn height, so a jet low on its run still looks down).
 */
export function podPosition(aircraft: V3, groundY: number, minAgl = 0.4): V3 {
  const agl = Math.max(minAgl, aircraft.y - groundY);
  return { x: aircraft.x, y: groundY + agl * ALT_EXAG, z: aircraft.z };
}

/** Compass heading (degrees, 0 = north = -z, 90 = east = +x) of a horizontal direction. */
export function headingDeg(dx: number, dz: number): number {
  const h = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return ((h % 360) + 360) % 360;
}

/** Heading of a sim facing (radians, 0 = +x east, PI/2 = +y south). */
export function facingHeading(facing: number): number {
  return headingDeg(Math.cos(facing), Math.sin(facing));
}

/** Depression angle (degrees below the horizon) of the line of sight from `cam` to `tgt`. */
export function depressionDeg(cam: V3, tgt: V3): number {
  const h = Math.hypot(tgt.x - cam.x, tgt.z - cam.z);
  return (Math.atan2(cam.y - tgt.y, h) * 180) / Math.PI;
}

/**
 * Vertical field of view (degrees) that shows `footprint` tiles across the picture at `dist` tiles
 * (on the line of sight), for a picture of aspect `aspect` (width / height).
 */
export function fovFor(dist: number, footprint: number, aspect: number): number {
  const half = Math.atan(footprint / 2 / Math.max(0.01, dist));
  const v = 2 * Math.atan(Math.tan(half) / Math.max(0.1, aspect));
  return Math.min(70, Math.max(0.5, (v * 180) / Math.PI));
}

/**
 * Ground width (tiles) the sensor frames: the target with room around it (`extent` = its largest horizontal
 * size in tiles), or a wide field of view while there is no target (extent 0).
 */
export function footprintFor(kind: FeedKind, extent: number): number {
  if (extent <= 0) return kind === 'kami' ? 6 : 9;
  return Math.max(kind === 'heli' ? 2.8 : 3.2, extent * 2.8);
}

/** Narrow / wide field of view marker: wide above this footprint (tiles). */
export const WFOV_ABOVE = 6;

/** Column-major 4x4 matrix (THREE.Matrix4.elements). */
export type M4 = ArrayLike<number>;

/** Project a world point with a view-projection matrix to picture pixels (top-left origin). null when behind. */
export function projectPx(vp: M4, p: V3, w: number, h: number): { x: number; y: number } | null {
  const e = vp;
  const cw = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
  if (cw <= 1e-6) return null;
  const cx = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / cw;
  const cy = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / cw;
  return { x: ((cx + 1) / 2) * w, y: ((1 - cy) / 2) * h };
}

/** Screen box (pixels) of a world-space axis-aligned box: the 2D bounds of its 8 projected corners. */
export function projectBox(vp: M4, min: V3, max: V3, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const c: V3[] = [];
  for (let i = 0; i < 8; i++) c.push({ x: i & 1 ? max.x : min.x, y: i & 2 ? max.y : min.y, z: i & 4 ? max.z : min.z });
  return projectCorners(vp, c, w, h);
}

/** Screen box (pixels) of a set of world points (e.g. an oriented box's corners). null when one is behind. */
export function projectCorners(vp: M4, pts: readonly V3[], w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    const q = projectPx(vp, p, w, h);
    if (!q) return null;
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1 };
}

/** Exponential smoothing factor for a rate (1/s) over dt. */
export function smoothK(dt: number, rate: number): number {
  return 1 - Math.exp(-Math.max(0, dt) * rate);
}

/** Turn angle `a` towards `b` (radians) by at most `step`. */
export function slewAngle(a: number, b: number, step: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) <= step ? b : a + Math.sign(d) * step;
}

// ------------------------------------------------------------------ readouts

export interface Readouts {
  /** Sensor altitude above the target's ground (feet). */
  altFt: number;
  /** Slant range sensor -> target (metres). */
  slantM: number;
  /** Line of sight compass heading (degrees). */
  losHdg: number;
}

export function readouts(cam: V3, tgt: V3, groundY: number): Readouts {
  return {
    altFt: Math.max(0, cam.y - groundY) * M_PER_TILE * FT_PER_M,
    slantM: Math.hypot(cam.x - tgt.x, cam.y - tgt.y, cam.z - tgt.z) * M_PER_TILE,
    losHdg: headingDeg(tgt.x - cam.x, tgt.z - cam.z),
  };
}

/** Ground speed (knots) from a ground displacement per sim tick (tiles) at `tps` ticks per second. */
export function groundSpeedKt(dxPerTick: number, dyPerTick: number, tps: number): number {
  return Math.hypot(dxPerTick, dyPerTick) * tps * M_PER_TILE * KT_PER_MS;
}

/**
 * Where north points in the picture: clockwise angle (degrees) from picture-up, given the camera's world
 * right and up axes (three.js: north = -z). Holds looking straight down, too.
 */
export function northInPicture(right: V3, up: V3): number {
  return (Math.atan2(-right.z, -up.z) * 180) / Math.PI;
}

/** Compass tape label at a 30 degree mark. */
export function tapeLabel(deg: number): string {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10).padStart(2, '0');
}

export function fmtAlt(ft: number): string {
  return `${Math.round(ft / 10) * 10}`;
}
export function fmtRange(m: number): string {
  return m >= 10000 ? `${(m / 1000).toFixed(1)}K` : `${Math.round(m / 10) * 10}`;
}
export function fmtHdg(h: number): string {
  return String(Math.round(h) % 360).padStart(3, '0');
}
export function fmtTti(s: number): string {
  const v = Math.max(0, s);
  return v >= 10 ? v.toFixed(0).padStart(2, '0') : `0${v.toFixed(1)}`;
}

// ------------------------------------------------------------------ titles

/** Short airframe designation from a unit name: 'F-35A Lightning II' -> 'F-35A', 'Eurofighter Typhoon' -> 'TYPHOON'. */
export function airframe(name: string): string {
  const n = name.toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim();
  if (!n) return 'UNK';
  const words = n.split(/\s+/);
  // a designation has digits (F-35A, AH-64E, KA-52, T129); otherwise the last word is the type name
  const des = words.find((w) => /\d/.test(w));
  return (des ?? words[words.length - 1]).slice(0, 10);
}

/** Helicopter sight system by airframe: the Apache's TADS, the T129's ASELFLIR, else a neutral FLIR. */
export function heliSight(name: string): string {
  const a = airframe(name);
  if (a.startsWith('AH-64')) return 'TADS';
  if (a === 'T129') return 'ASELFLIR';
  return 'FLIR';
}

export function feedTitle(kind: FeedKind, name: string, callsign: string): string {
  if (kind === 'jet') return `${airframe(name)} · TGT POD`;
  if (kind === 'heli') return `${airframe(name)} · ${heliSight(name)}`;
  if (kind === 'uav') return `${airframe(name)} · ${callsign}`;
  return `MUNITION FEED · ${callsign}`;
}

// ------------------------------------------------------------------ which strike the feed follows

/** Priorities: an explicitly selected unit, a jet bombing run, a helicopter attack, a kamikaze dive, a drone attack. */
export const PRIO = { selected: 5, jet: 4, heli: 3, kami: 2, uav: 1 } as const;

export function prioOf(kind: FeedKind, selected: boolean): number {
  return selected ? PRIO.selected : PRIO[kind];
}

/** Minimum time (s) a feed stays up before an automatic switch (an ended feed or a fresh selection switch at once). */
export const MIN_HOLD = 4;

export interface FeedCand {
  id: number;
  kind: FeedKind;
  prio: number;
}

export interface CurFeed {
  id: number;
  prio: number;
  /** Time the feed came up. */
  since: number;
  /** Its strike / engagement is over (or the aircraft is lost and the static has played). */
  ended: boolean;
  /** Ridden kamikaze munition still diving: only a fresh selection takes the feed off it. */
  locked?: boolean;
}

/**
 * Pick the feed: returns the candidate to switch to, or null to keep the current feed (or stay closed when
 * there is none). Highest priority wins (ties: the current one, then the newest unit); a running feed is kept
 * for MIN_HOLD seconds unless it ended or the player just selected another unit.
 */
export function pickFeed(cur: CurFeed | null, cands: readonly FeedCand[], now: number, hold = MIN_HOLD): FeedCand | null {
  let best: FeedCand | null = null;
  for (const c of cands) {
    if (!best || c.prio > best.prio || (c.prio === best.prio && (c.id === cur?.id || (best.id !== cur?.id && c.id > best.id)))) best = c;
  }
  if (!cur || cur.ended) return best;
  if (!best || best.id === cur.id) return null;
  if (best.prio >= PRIO.selected && cur.prio < PRIO.selected) return best;
  if (cur.locked) return null;
  if (now - cur.since < hold) return null;
  const still = cands.find((c) => c.id === cur.id);
  if (still && best.prio <= still.prio) return null;
  return best;
}

/** Jet bombing run: on a sortie with its bomb aboard, closing on a target, release within `lead` seconds. */
export function jetRunStarted(phase: string, ammo: number, hasTarget: boolean, dist: number, speedTilesPerSec: number, releaseDist = 3, lead = 3.2): boolean {
  if (phase !== 'sortie' || ammo <= 0 || !hasTarget) return false;
  return (dist - releaseDist) / Math.max(0.1, speedTilesPerSec) <= lead;
}
