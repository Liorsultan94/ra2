import type * as THREE from 'three';
import type { Faction } from '../../sim/types';

/*
 * Shared contract for every model builder (buildings, vehicles, aircraft,
 * infantry, munitions, and glTF overrides).
 *
 * Conventions: 1 map tile = 1 world unit, Y up.
 *  - Units: origin on the ground at the footprint centre, forward = +X.
 *    Aircraft: origin at the aircraft's own centre (the renderer lifts it).
 *  - Buildings: origin at the footprint centre on the ground; the footprint
 *    spans x in [-w/2, w/2], z in [-h/2, h/2]; the "front" (doors) faces +Z.
 *  - The camera looks from the +X/+Z side at ~40 deg elevation.
 */

export type Region = 'west' | 'east' | 'asia' | 'mideast';

export const FACTION_REGION: Record<Faction, Region> = {
  usa: 'west',
  germany: 'west',
  israel: 'west',
  russia: 'east',
  ukraine: 'east',
  china: 'asia',
  korea: 'asia',
  iran: 'mideast',
  turkey: 'mideast',
};

export interface ModelStyle {
  team: number; // player colour: stripes, panels, flag trim
  hull: number; // faction vehicle base paint
  accent: number; // faction building trim colour
  flag: number[]; // 3 horizontal flag stripe colours
  faction: Faction | 'neutral';
  region: Region;
}

/** Per-frame animation input, provided by the renderer. */
export interface AnimState {
  dt: number; // seconds since last frame (0 while paused)
  time: number; // renderer clock, seconds
  moving: boolean;
  speed: number; // current ground speed, tiles / second
  dist: number; // cumulative distance travelled (tiles) - drive track scrolling / wheel spin from this
  turn: number; // yaw rate, rad / second (+ = turning left in model space)
  fired: number; // seconds since the last shot (Infinity if never)
  dead: number; // 0 while alive; seconds since death (infantry death animation)
  damage: number; // 0 = pristine .. 1 = destroyed
  built: number; // building construction progress 0..1 (1 = done)
  powered: boolean; // buildings: false when the owner is low on power
  /** Ground vehicles: terrain roughness under the hull, 0 (bridge / smooth) .. 1 (ore field, broken ground); set by the renderer's unit pose (render/unitpose.ts). */
  rough?: number;
  /** Airlift transports: ramp door target, 0 closed .. 1 open (the model eases towards it). */
  ramp?: number;
  /** Infantry: 1 while hanging under a parachute canopy, 0 on the ground (the model blends its pose). */
  para?: number;
  /**
   * Tanks / IFVs with a crew hatch: 1 = the commander may ride head-and-shoulders out of the open hatch
   * (default when undefined), 0 = button up (combat nearby). The model adds its own calm-down delay and
   * also closes up on its own when it fires or takes damage.
   */
  hatch?: number;
  /** MCV: deploy (unfold into a construction yard) progress 0..1, driven by the renderer's deploy overlay. */
  deploy?: number;
  /** Infantry: seconds since the soldier started digging in (undefined / 0 = not digging); the dig motion plays for the first ~2.4 s, then he kneels in the foxhole. */
  dig?: number;
  /** Infantry death: 1 = run over by a vehicle (flattened, pressed into the ground) instead of the fall. */
  crushed?: number;
  /** Infantry: head yaw (radians, + = turned left in model space) towards a threat, e.g. a vehicle about to run him over; undefined = none. */
  look?: number;
  /** Infantry: seconds into a dive and roll out of a vehicle's path (undefined / 0 = none; ~1.2 s long). */
  dive?: number;
  /** Production buildings: seconds since this building last rolled out a unit (undefined / Infinity = never); drives doors / lifts / beacons. */
  produced?: number;
  /** Stable per-unit seed (the entity id): de-synchronises idle motion, gestures and death variants. Render only. */
  seed?: number;
  /** Infantry animation detail: 0 / undefined = full (leg IK, gestures), 1 = cheap cycle (far zoom / low quality), 2 = off screen (clocks only). */
  lod?: number;
}

export interface Model {
  root: THREE.Group;
  /** Rotated about local Y by the renderer (relative to the body). */
  turret?: THREE.Object3D;
  /** Empty objects at barrel tips / launch rails; cycled per shot for muzzle flashes and projectile spawn points. */
  muzzles: THREE.Object3D[];
  /** Approximate model top (health bar placement). */
  height: number;
  /** Bounding size of the model (x = length, y = height, z = width). */
  size?: { x: number; y: number; z: number };
  /** Emissive materials (renderer may pulse or dim them on low power). */
  glow: THREE.Material[];
  /** Local-space ambient particle sources. */
  emitters: { pos: THREE.Vector3; kind: 'smoke' | 'steam' | 'spark' | 'fire' }[];
  /** Barrels the renderer kicks back along local -X when firing (each must sit at its rest position inside a parent). */
  recoil?: THREE.Object3D[];
  /** All per-frame animation (tracks, wheels, rotors, legs, radar dishes...). */
  anim?: (s: AnimState) => void;
  /** Ground marks: half the distance between left/right track (or tyre) centres, and each mark's width. */
  trackGauge?: number;
  trackWidth?: number;
  wheeled?: boolean;
  /** Infantry: the model plays its own death animation via anim(s.dead > 0); renderer removes it after ~2.5 s. */
  infantry?: boolean;
  /**
   * Battle-damage particle sources (vehicles / aircraft), in root-local space.
   * Each point starts emitting once AnimState.damage >= `at` (e.g. engine deck
   * smoke at 0.35, fire at 0.7, sparks from torn plates). Transform with
   * root.matrixWorld like `emitters`.
   */
  damageFx?: { pos: THREE.Vector3; kind: 'smoke' | 'fire' | 'spark'; at: number }[];
  /** Aircraft: empty objects at the rear (flare / chaff dispensers); use getWorldPosition() to spawn flares (they follow the bank / roll). */
  flareDispensers?: THREE.Object3D[];
  /** Buildings: local-space lamp/floodlight points for night mode (shared per template, read-only). */
  nightLights?: { pos: THREE.Vector3; color: number; intensity: number }[];

  // ---- legacy fields (older builders) ----
  spinners?: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number }[];
  legs?: [THREE.Object3D, THREE.Object3D];
  rotors?: THREE.Object3D[];
}

/** Projectile visual, built once per projectile. Forward = +X, origin at the centre. */
export interface MunitionModel {
  root: THREE.Group;
  /** Local position of the motor nozzle (exhaust flame / smoke trail source); undefined for unpowered shells. */
  nozzle?: THREE.Vector3;
  length: number;
}

export type MunitionKind =
  | 'tankShell'
  | 'artilleryShell'
  | 'mortarBomb'
  | 'rpg'
  | 'atgm'
  | 'rocket' // unguided artillery / helicopter rocket
  | 'thermoRocket'
  | 'sam'
  | 'interceptor'
  | 'airMissile' // air-to-ground / air-to-air missile (Hellfire, AIM-120 style)
  | 'ballistic' // Fateh-110 style
  | 'hypersonic'; // DF-17 style glide vehicle on a booster
