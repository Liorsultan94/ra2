import * as THREE from 'three';
import { Tile, standHeight, type GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { surfaceHeight } from '../ground';
import { HEAT_LAYER } from '../thermal';

/*
 * Shared plumbing of the ambient life (civilian traffic, livestock, birds):
 * the per-frame context handed to each subsystem, fog-of-war lookups, ground
 * heights and the vertex-animated instanced material all three use.
 *
 * Everything under src/render/ambient is purely visual: it reads the map, the
 * scenery layout, the fog texture and sim events, never writes to the sim, and
 * may use Math.random freely.
 */

/** Something scary happened at tile (x, y): creatures within `r` react. */
export interface Danger {
  x: number;
  y: number;
  /** Scare radius (tiles). */
  r: number;
  /** Lethal radius (tiles); 0 = noise only (gunfire, a unit driving past). */
  kill: number;
  /** Loudness 0..1 (gunfire ~0.3, shells ~0.7, heavy blasts 1). */
  power: number;
}

export interface AmbientFrame {
  dt: number;
  time: number;
  /** Dangers raised this frame (events + units nearby). */
  dangers: readonly Danger[];
  /** Military ground units: x, y pairs (refreshed a few times a second). */
  units: Float32Array;
  nUnits: number;
  /** Aircraft (helicopters, drones, jets) at low altitude: x, y pairs. */
  air: Float32Array;
  nAir: number;
  /** 0 = daylight .. 1 = full night. */
  dark: number;
  /** Rain / snow / sandstorm. */
  foul: boolean;
  /** View rectangle on the ground (tile space) with a margin: off-screen things update less often. */
  vx0: number;
  vy0: number;
  vx1: number;
  vy1: number;
}

export type Quality = 'low' | 'medium' | 'high';

/** Fog of war: true while (x, y) is currently seen by the viewer (always, when the fog is off). */
export class FogProbe {
  private data: Uint8Array;
  constructor(
    private fog: FogOfWar,
    private w: number,
    private h: number,
  ) {
    this.data = fog.texture.image.data as Uint8Array;
  }

  visible(x: number, y: number): boolean {
    if (this.fog.uniforms.fogEnabled.value < 0.5) return true;
    const tx = x < 0 ? 0 : x >= this.w ? this.w - 1 : x | 0;
    const ty = y < 0 ? 0 : y >= this.h ? this.h - 1 : y | 0;
    return this.data[ty * this.w + tx] > 175;
  }
}

export function clampX(m: GameMap, x: number) {
  return x < 0 ? 0 : x > m.w - 0.01 ? m.w - 0.01 : x;
}
export function clampY(m: GameMap, y: number) {
  return y < 0 ? 0 : y > m.h - 0.01 ? m.h - 0.01 : y;
}

/** Height of the drawn ground (bridge decks lift to the deck). */
export function groundAt(m: GameMap, x: number, y: number): number {
  const cx = clampX(m, x);
  const cy = clampY(m, y);
  const t = m.tiles[(cy | 0) * m.w + (cx | 0)];
  if (t === Tile.Bridge || t === Tile.Water) return standHeight(m, cx, cy);
  return surfaceHeight(m, cx, cy);
}

/** Can a cow / an off-road car stand here (no water, no buildings, not off the map)? */
export function walkable(m: GameMap, x: number, y: number): boolean {
  if (x < 0.3 || y < 0.3 || x > m.w - 0.3 || y > m.h - 0.3) return false;
  const i = (y | 0) * m.w + (x | 0);
  const t = m.tiles[i];
  return t !== Tile.Water && t !== Tile.Bridge && t !== Tile.Rock && !m.blocked[i];
}

export function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export interface Rig {
  /** Rig constants handed to the vertex shader (doors hinge / neck pivot / leg tops). */
  rig: THREE.Vector4;
}

/**
 * Vertex-animated instanced material. Geometry carries a per-vertex `flex`
 * part code (GeoBuilder flex attribute); instances carry `aA` (vec4 animation
 * state) and `aPaint` (vec3 paint / coat colour). `kind` selects the rig:
 *  - car:    flex 1 painted body, 2 / 3 left / right door (painted, swing open by aA.y);
 *            aA.x burnt
 *  - animal: flex 1 coat, 4 head (pitches down by aA.y), 5 / 6 leg pairs (swing by sin(aA.x) * aA.z);
 *            aA.w dead (darkened)
 *  - bird:   flex 1 wings (flap: phase aA.x, amplitude aA.y, folded by aA.z); all painted
 */
export function ambientMaterial(fog: FogOfWar, kind: 'car' | 'animal' | 'bird', rig: THREE.Vector4, rough = 0.8, metal = 0): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal, side: kind === 'bird' ? THREE.DoubleSide : THREE.FrontSide });
  const color =
    kind === 'car'
      ? `float painted = step(0.5, flex) * step(flex, 3.5);
         vColor.rgb *= mix(vec3(1.0), aPaint, painted);
         vColor.rgb = mix(vColor.rgb, vec3(0.05, 0.045, 0.04) + vColor.rgb * 0.08, aA.x);`
      : kind === 'animal'
        ? `float painted = step(0.5, flex) * step(flex, 4.5);
           vColor.rgb *= mix(vec3(1.0), aPaint, painted);
           vColor.rgb *= 1.0 - aA.w * 0.45;`
        : `vColor.rgb *= aPaint;`;
  const anim =
    kind === 'car'
      ? `if (flex > 1.5 && flex < 3.5) {
           float side = flex < 2.5 ? 1.0 : -1.0;
           float ang = aA.y * 1.05 * side;
           vec2 hinge = vec2(aRig.x, side * aRig.y);
           vec2 d = transformed.xz - hinge;
           float c = cos(ang); float s = sin(ang);
           transformed.xz = hinge + vec2(d.x * c + d.y * s, -d.x * s + d.y * c);
         }`
      : kind === 'animal'
        ? `if (flex > 3.5 && flex < 4.5) {
             float ang = -aA.y * aRig.z;
             vec2 d = transformed.xy - aRig.xy;
             float c = cos(ang); float s = sin(ang);
             transformed.xy = aRig.xy + vec2(d.x * c - d.y * s, d.x * s + d.y * c);
           }
           if (flex > 4.5) {
             float sgn = flex < 5.5 ? 1.0 : -1.0;
             transformed.x += max(0.0, aRig.w - transformed.y) * sin(aA.x) * aA.z * sgn * 0.6;
           }
           transformed.y += abs(sin(aA.x)) * aA.z * 0.014;`
        : `if (flex > 0.5) {
             float side = transformed.z > 0.0 ? 1.0 : -1.0;
             float span = abs(transformed.z) * (1.0 - aA.z * 0.82);
             transformed.z = side * span;
             transformed.y += span * sin(aA.x) * aA.y;
             transformed.x -= span * aA.z * 0.5;
           }`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.aRig = { value: rig };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float flex;\nattribute vec4 aA;\nattribute vec3 aPaint;\nuniform vec4 aRig;')
      .replace('#include <color_vertex>', `#include <color_vertex>\n${color}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${anim}`);
  };
  fog.apply(mat);
  // fog.apply keys every patched material 'fog2': ours differ (attributes / rig), so key them apart
  mat.customProgramCacheKey = () => `fog2-ambient-${kind}`;
  return mat;
}

/** A dynamic instanced mesh with the aA / aPaint per-instance attributes. */
export class AnimInstances {
  readonly mesh: THREE.InstancedMesh;
  readonly a: Float32Array;
  readonly paint: Float32Array;
  private aAttr: THREE.InstancedBufferAttribute;
  private pAttr: THREE.InstancedBufferAttribute;
  n = 0;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly max: number, name: string, opts: { shadow?: boolean; heat?: boolean } = {}) {
    const g = geo.clone();
    this.a = new Float32Array(max * 4);
    this.paint = new Float32Array(max * 3);
    this.aAttr = new THREE.InstancedBufferAttribute(this.a, 4);
    this.pAttr = new THREE.InstancedBufferAttribute(this.paint, 3);
    this.aAttr.setUsage(THREE.DynamicDrawUsage);
    this.pAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aA', this.aAttr);
    g.setAttribute('aPaint', this.pAttr);
    const m = new THREE.InstancedMesh(g, mat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = !!opts.shadow;
    m.receiveShadow = false;
    m.count = 0;
    m.visible = false;
    m.name = name;
    if (opts.heat) m.layers.enable(HEAT_LAYER);
    this.mesh = m;
  }

  begin() {
    this.n = 0;
  }

  /** Append one instance; returns false when full. */
  push(mat: THREE.Matrix4, a0: number, a1: number, a2: number, a3: number, r: number, g: number, b: number): boolean {
    const i = this.n;
    if (i >= this.max) return false;
    mat.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    const a = this.a;
    a[i * 4] = a0;
    a[i * 4 + 1] = a1;
    a[i * 4 + 2] = a2;
    a[i * 4 + 3] = a3;
    const p = this.paint;
    p[i * 3] = r;
    p[i * 3 + 1] = g;
    p[i * 3 + 2] = b;
    this.n++;
    return true;
  }

  commit() {
    const n = this.n;
    const m = this.mesh;
    m.count = n;
    m.visible = n > 0;
    if (!n) return;
    for (const [attr, size] of [
      [m.instanceMatrix, 16],
      [this.aAttr, 4],
      [this.pAttr, 3],
    ] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------ light sprites

const FLARE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vec3 c = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float s = length(instanceMatrix[0].xyz);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xyz += normalize(-mv.xyz) * 0.15;
  mv.xy += position.xy * s;
  vUv = position.xy * 2.0;
  vCol = instanceColor;
  gl_Position = projectionMatrix * mv;
}`;
const FLARE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float r2 = dot(vUv, vUv);
  float a = exp(-r2 * 5.0) * 0.5 + exp(-r2 * 40.0) * 2.0;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;
const POOL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv * 2.0 - 1.0;
  vCol = instanceColor;
  gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const POOL_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float r = length(vUv);
  float a = 1.0 - smoothstep(0.0, 1.0, r);
  gl_FragColor = vec4(vCol * a * a, 1.0);
}`;

function additive(vert: string, frag: string) {
  return new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
}

const _lm = new THREE.Matrix4();
const _lq = new THREE.Quaternion();
const _lp = new THREE.Vector3();
const _ls = new THREE.Vector3();
const _lc = new THREE.Color();

/** Headlights, tail / brake lights and hazard blinkers: camera-facing flares + ground pools (2 draw calls, only while lit). */
export class LightSprites {
  readonly group = new THREE.Group();
  private flares: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  private nf = 0;
  private np = 0;

  constructor(private maxF = 96, private maxP = 32) {
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, name: string) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      m.name = name;
      return m;
    };
    this.flares = mk(new THREE.PlaneGeometry(1, 1), additive(FLARE_VERT, FLARE_FRAG), maxF, 'ambient-flares');
    this.flares.renderOrder = 7;
    const pm = additive(POOL_VERT, POOL_FRAG);
    pm.polygonOffset = true;
    pm.polygonOffsetFactor = -2;
    pm.polygonOffsetUnits = -4;
    this.pools = mk(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pm, maxP, 'ambient-pools');
    this.pools.renderOrder = 2;
    this.group.add(this.pools, this.flares);
  }

  begin() {
    this.nf = this.np = 0;
  }

  flare(x: number, y: number, z: number, size: number, r: number, g: number, b: number) {
    if (this.nf >= this.maxF) return;
    _lm.makeScale(size, size, size).setPosition(x, y, z);
    this.flares.setMatrixAt(this.nf, _lm);
    this.flares.setColorAt(this.nf++, _lc.setRGB(r, g, b));
  }

  pool(x: number, y: number, z: number, yaw: number, len: number, wid: number, r: number, g: number, b: number) {
    if (this.np >= this.maxP) return;
    _lq.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    _lm.compose(_lp.set(x, y + 0.03, z), _lq, _ls.set(len, 1, wid));
    this.pools.setMatrixAt(this.np, _lm);
    this.pools.setColorAt(this.np++, _lc.setRGB(r, g, b));
  }

  commit() {
    for (const [im, n] of [
      [this.flares, this.nf],
      [this.pools, this.np],
    ] as const) {
      im.count = n;
      im.visible = n > 0;
      if (!n) continue;
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, n * 16);
      im.instanceMatrix.needsUpdate = true;
      const ic = im.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
    }
  }
}
