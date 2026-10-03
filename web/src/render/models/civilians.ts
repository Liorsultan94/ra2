import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import { GeoBuilder } from '../geo';
import { HEAT_LAYER } from '../thermal';

/*
 * Civilians for the ambient life (src/render/ambient/people.ts): ONE low-poly
 * figure that every pedestrian, shepherd, vendor, police officer and
 * paramedic is drawn from, as a single instanced draw call.
 *
 * The figure is modelled in metres (1.75 m adult, +X forward, origin on the
 * ground between the feet) and vertex-animated in the shader: thighs / shins
 * swing about hip and knee pivots, arms about the shoulders (with sideways
 * lift), the upper body leans about the pelvis, and a pose code switches to
 * sitting, gesturing, hands-up alarm, carrying, holding a child's hand,
 * being carried, kicking a ball, waving or handling goods.
 *
 * Optional parts (skirt, robe, long coat, hats, keffiyeh, backpack, cane,
 * shopping bag, peaked uniform cap, hi-vis band) are all in the geometry and
 * collapsed per instance by a bit mask, so men, women, kids, the elderly and
 * every biome's clothing share the one mesh. Colours come per instance (skin,
 * top, bottom, hat / hair).
 *
 * Per vertex: `pmo` = (part, material slot, option bit). Per instance:
 *  - aA: walk phase, stride (0 idle, 1 walk, ~1.6 run), pose code, option mask
 *  - aB: skin rgb, forward lean (radians)
 *  - aTop / aBot / aHat: clothing colours
 */

/** Metres -> tiles at the infantry scale (soldier 1.8 m = 0.34 tiles, enlarged x1.4 by the renderer). */
export const CIV_SCALE = (0.34 / 1.8) * 1.4;

export const enum Part {
  Static = 0,
  Pelvis = 1,
  Torso = 2,
  Head = 3,
  ArmL = 4,
  ArmR = 5,
  ThighL = 6,
  ThighR = 7,
  ShinL = 8,
  ShinR = 9,
  Skirt = 10,
}

export const enum Slot {
  Skin = 0,
  Top = 1,
  Bottom = 2,
  Hat = 3,
  Shoe = 4,
  Accent = 5,
  Wood = 6,
  Bag = 7,
  HiVis = 8,
  Lens = 9,
}

/** Option bits (aA.w mask). */
export const enum Opt {
  LongHair = 1,
  Skirt = 2,
  Robe = 4,
  Beanie = 8,
  Keffiyeh = 16,
  Cap = 32,
  Backpack = 64,
  Coat = 128,
  Cane = 256,
  Bag = 512,
  Peaked = 1024,
  HiVis = 2048,
  Headscarf = 4096,
  BrimHat = 8192,
}

/** Pose codes (aA.z). */
export const enum Pose {
  Walk = 0,
  Sit = 1,
  Chat = 2,
  Alarm = 3,
  Carry = 4,
  HoldHand = 5,
  Child = 6,
  Carried = 7,
  Kick = 8,
  Lying = 9,
  Wave = 10,
  Vendor = 11,
}

export const HIP_Y = 0.92;
export const SEAT_Y = 0.46;

const trs = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));

/** Build the civilian figure (indexed geometry with position / normal / pmo). */
export function civilianGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, part: Part, slot: Slot, opt = 0) => {
    // pmo is carried in the colour channel while building
    b.add(g, m, null, new THREE.Color(part, slot, opt));
  };
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const cyl = (rt: number, rb: number, h: number, seg = 6) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);
  const sph = (r: number, w = 7, h = 5) => new THREE.SphereGeometry(r, w, h);

  for (const s of [1, -1]) {
    const z = s * 0.1;
    const thigh = s > 0 ? Part.ThighL : Part.ThighR;
    const shin = s > 0 ? Part.ShinL : Part.ShinR;
    put(cyl(0.078, 0.06, 0.44), trs(0, 0.7, z), thigh, Slot.Bottom);
    put(cyl(0.058, 0.045, 0.43), trs(0, 0.285, z), shin, Slot.Bottom);
    put(box(0.25, 0.08, 0.1), trs(0.045, 0.04, z), shin, Slot.Shoe);
    // arms: sleeve + hand
    const arm = s > 0 ? Part.ArmL : Part.ArmR;
    const az = s * 0.215;
    put(cyl(0.052, 0.042, 0.56), trs(0, 1.14, az), arm, Slot.Top);
    put(sph(0.045, 5, 4), trs(0, 0.83, az), arm, Slot.Skin);
  }
  // pelvis, torso (tapered to the waist), shoulders, neck, head with a hair shell
  put(box(0.22, 0.17, 0.33), trs(0, 0.93, 0), Part.Pelvis, Slot.Bottom);
  put(cyl(0.2, 0.165, 0.46, 7), trs(0, 1.2, 0, 0, 0, 0, 0.62, 1, 1), Part.Torso, Slot.Top);
  put(sph(0.12, 7, 4), trs(0, 1.4, 0, 0, 0, 0, 0.9, 0.55, 1.75), Part.Torso, Slot.Top);
  put(cyl(0.045, 0.05, 0.1, 5), trs(0, 1.49, 0), Part.Head, Slot.Skin);
  put(sph(0.105, 8, 6), trs(0.005, 1.63, 0, 0, 0, 0, 1, 1.12, 0.95), Part.Head, Slot.Skin);
  put(sph(0.112, 8, 4), trs(-0.012, 1.665, 0, 0, 0, 0, 1, 0.9, 0.98), Part.Head, Slot.Hat);
  // a nose so the heading reads at a glance
  put(box(0.03, 0.04, 0.03), trs(0.105, 1.615, 0), Part.Head, Slot.Skin);
  // ---- optional parts
  put(box(0.08, 0.3, 0.2), trs(-0.075, 1.5, 0), Part.Head, Slot.Hat, Opt.LongHair);
  put(cyl(0.2, 0.3, 0.46, 8), trs(0, 0.77, 0, 0, 0, 0, 0.8, 1, 1), Part.Skirt, Slot.Bottom, Opt.Skirt);
  put(cyl(0.21, 0.31, 1.28, 8), trs(0, 0.74, 0, 0, 0, 0, 0.82, 1, 1), Part.Skirt, Slot.Top, Opt.Robe);
  put(cyl(0.21, 0.27, 0.5, 8), trs(0, 0.74, 0, 0, 0, 0, 0.82, 1, 1), Part.Skirt, Slot.Top, Opt.Coat);
  put(sph(0.122, 8, 4, ), trs(-0.005, 1.68, 0, 0, 0, 0, 1, 0.85, 1), Part.Head, Slot.Hat, Opt.Beanie);
  put(box(0.04, 0.05, 0.04), trs(-0.005, 1.785, 0), Part.Head, Slot.Hat, Opt.Beanie);
  // keffiyeh: cloth over the head, falling to the shoulders; a dark agal ring
  put(sph(0.125, 8, 5), trs(-0.01, 1.655, 0, 0, 0, 0, 1, 1.05, 1.02), Part.Head, Slot.Hat, Opt.Keffiyeh);
  put(box(0.16, 0.26, 0.27), trs(-0.06, 1.5, 0), Part.Head, Slot.Hat, Opt.Keffiyeh);
  put(cyl(0.118, 0.118, 0.03, 8), trs(-0.005, 1.73, 0), Part.Head, Slot.Shoe, Opt.Keffiyeh);
  // headscarf (wrapped round the face, falling behind)
  put(sph(0.122, 8, 5), trs(-0.015, 1.65, 0, 0, 0, 0, 1, 1.08, 1.02), Part.Head, Slot.Hat, Opt.Headscarf);
  put(box(0.1, 0.2, 0.22), trs(-0.07, 1.48, 0), Part.Head, Slot.Hat, Opt.Headscarf);
  // cap / flat cap with a brim
  put(cyl(0.112, 0.115, 0.06, 8), trs(-0.005, 1.71, 0), Part.Head, Slot.Hat, Opt.Cap);
  put(box(0.1, 0.015, 0.16), trs(0.12, 1.69, 0), Part.Head, Slot.Hat, Opt.Cap);
  // wide brim hat (shepherds, farmers)
  put(cyl(0.2, 0.2, 0.02, 10), trs(0, 1.7, 0), Part.Head, Slot.Hat, Opt.BrimHat);
  put(cyl(0.09, 0.11, 0.1, 8), trs(0, 1.75, 0), Part.Head, Slot.Hat, Opt.BrimHat);
  // peaked uniform cap
  put(cyl(0.125, 0.105, 0.07, 8), trs(0, 1.73, 0), Part.Head, Slot.Hat, Opt.Peaked);
  put(box(0.09, 0.012, 0.17), trs(0.115, 1.7, 0), Part.Head, Slot.Shoe, Opt.Peaked);
  put(box(0.24, 0.05, 0.36), trs(0, 1.08, 0), Part.Torso, Slot.HiVis, Opt.HiVis);
  put(box(0.14, 0.3, 0.26), trs(-0.17, 1.2, 0), Part.Torso, Slot.Accent, Opt.Backpack);
  // cane in the right hand, shopping bag in the left
  put(cyl(0.012, 0.012, 0.86, 4), trs(0.05, 0.42, -0.215, 0, 0, -0.12), Part.ArmR, Slot.Wood, Opt.Cane);
  put(box(0.16, 0.2, 0.06), trs(0, 0.7, 0.24), Part.ArmL, Slot.Bag, Opt.Bag);
  const geo = b.build(false);
  geo.setAttribute('pmo', geo.getAttribute('color'));
  geo.deleteAttribute('color');
  geo.deleteAttribute('uv');
  return geo;
}

const RIG_GLSL = /* glsl */ `
attribute vec3 pmo;
attribute vec4 aA;
attribute vec4 aB;
attribute vec3 aTop;
attribute vec3 aBot;
attribute vec3 aHat;
varying vec3 vCiv;
vec2 civRot(vec2 d, float a) { float c = cos(a); float s = sin(a); return vec2(d.x * c - d.y * s, d.x * s + d.y * c); }
void civRig(inout vec3 P, inout vec3 N) {
  int part = int(pmo.x + 0.5);
  int slot = int(pmo.y + 0.5);
  int opt = int(pmo.z + 0.5);
  int mask = int(aA.w + 0.5);
  if (opt != 0 && (mask & opt) == 0) { P = vec3(0.0); N = vec3(0.0, 1.0, 0.0); vCiv = vec3(0.0); return; }
  float ph = aA.x;
  float st = aA.y;
  float pose = aA.z;
  float sw = sin(ph);
  float cw = cos(ph);
  float thL = sw * 0.42 * st;
  float thR = -thL;
  float knL = -max(0.0, cw) * 0.75 * st;
  float knR = -max(0.0, -cw) * 0.75 * st;
  float arL = -sw * 0.42 * st;
  float arR = sw * 0.42 * st;
  float abL = 0.06;
  float abR = 0.06;
  if (st > 1.2) { arL *= 1.2; arR *= 1.2; }
  if (pose > 0.5 && pose < 1.5) { thL = 1.5; thR = 1.45; knL = -1.5; knR = -1.45; arL = 0.35; arR = 0.3; }
  else if (pose < 2.5 && pose > 1.5) { arR = 0.45 + 0.35 * sin(ph * 1.7); abR = 0.25; arL = 0.08 + 0.1 * sin(ph * 0.9); }
  else if (pose < 3.5 && pose > 2.5) { arL = 2.5; arR = 2.6; abL = 0.35; abR = 0.35; }
  else if (pose < 4.5 && pose > 3.5) { arL = 1.0; arR = 1.0; abL = -0.15; abR = -0.15; }
  else if (pose < 5.5 && pose > 4.5) { abR = 0.55; arR = 0.25; }
  else if (pose < 6.5 && pose > 5.5) { abL = 1.0; arL = 0.35; }
  else if (pose < 7.5 && pose > 6.5) { thL = 1.35; thR = 1.25; knL = -1.1; knR = -1.2; arL = 0.9; arR = 0.9; abL = -0.3; abR = -0.3; }
  else if (pose < 8.5 && pose > 7.5) { thR = 0.95 * max(0.0, sin(ph * 0.5)); knR = -0.2; thL = -0.15; arL = 0.5; arR = -0.4; abL = 0.4; abR = 0.4; }
  else if (pose < 9.5 && pose > 8.5) { arL = 0.2; arR = -0.1; abL = 0.5; abR = 0.35; thL = 0.1; thR = -0.15; }
  else if (pose < 10.5 && pose > 9.5) { arR = 2.7; abR = 0.5 + 0.35 * sin(ph * 3.0); }
  else if (pose < 11.5 && pose > 10.5) { arL = 0.75 + 0.15 * sin(ph * 1.3); arR = 0.8 + 0.2 * sin(ph * 1.7 + 1.0); abL = -0.2; abR = -0.2; }
  if (part == ${Part.ThighL} || part == ${Part.ShinL} || part == ${Part.ThighR} || part == ${Part.ShinR}) {
    bool left = part == ${Part.ThighL} || part == ${Part.ShinL};
    float zz = left ? 0.1 : -0.1;
    if (part == ${Part.ShinL} || part == ${Part.ShinR}) {
      vec2 d = P.xy - vec2(0.0, 0.5);
      P.xy = vec2(0.0, 0.5) + civRot(d, left ? knL : knR);
      N.xy = civRot(N.xy, left ? knL : knR);
    }
    vec2 d = P.xy - vec2(0.0, ${HIP_Y.toFixed(2)});
    P.xy = vec2(0.0, ${HIP_Y.toFixed(2)}) + civRot(d, left ? thL : thR);
    N.xy = civRot(N.xy, left ? thL : thR);
    if (slot == ${Slot.Bottom} && part >= ${Part.ShinL} && (mask & ${Opt.Skirt}) != 0) slot = ${Slot.Skin};
  }
  if (part == ${Part.Skirt}) {
    float sitK = (pose > 0.5 && pose < 1.5) || (pose > 6.5 && pose < 7.5) ? 1.0 : 0.0;
    float a = sin(ph * 2.0) * 0.03 * st + sitK * 1.35 * clamp((${HIP_Y.toFixed(2)} - P.y) * 4.0, 0.0, 1.0);
    vec2 d = P.xy - vec2(0.0, ${HIP_Y.toFixed(2)});
    P.xy = vec2(0.0, ${HIP_Y.toFixed(2)}) + civRot(d, a);
    N.xy = civRot(N.xy, a);
  }
  if (part == ${Part.ArmL} || part == ${Part.ArmR}) {
    bool left = part == ${Part.ArmL};
    vec3 sh = vec3(0.0, 1.42, left ? 0.215 : -0.215);
    vec3 d = P - sh;
    float ab = left ? abL : -abR;
    d.zy = civRot(d.zy, ab);
    N.zy = civRot(N.zy, ab);
    float sa = left ? arL : arR;
    d.xy = civRot(d.xy, sa);
    N.xy = civRot(N.xy, sa);
    P = sh + d;
  }
  if (part >= ${Part.Torso} && part <= ${Part.ArmR}) {
    float lean = -aB.w;
    vec2 d = P.xy - vec2(0.0, 1.0);
    P.xy = vec2(0.0, 1.0) + civRot(d, lean);
    N.xy = civRot(N.xy, lean);
  }
  if (st > 1.2 && part != ${Part.ThighL} && part != ${Part.ThighR} && part != ${Part.ShinL} && part != ${Part.ShinR}) P.y += abs(cw) * 0.035;
  vec3 c = aB.rgb;
  if (slot == ${Slot.Top}) c = aTop;
  else if (slot == ${Slot.Bottom}) c = aBot;
  else if (slot == ${Slot.Hat}) c = aHat;
  else if (slot == ${Slot.Shoe}) c = vec3(0.07, 0.06, 0.055);
  else if (slot == ${Slot.Accent}) c = aTop * 0.5 + vec3(0.04);
  else if (slot == ${Slot.Wood}) c = vec3(0.36, 0.25, 0.15);
  else if (slot == ${Slot.Bag}) c = vec3(0.86, 0.8, 0.66);
  else if (slot == ${Slot.HiVis}) c = vec3(0.9, 0.95, 0.25);
  vCiv = c;
}
`;

/** Instanced, vertex-animated civilian material (fog of war applied). */
export function civilianMaterial(fog: FogOfWar): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_GLSL}\nvec3 civP;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n civP = position; civRig(civP, objectNormal);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n transformed = civP;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCiv;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vCiv;');
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-ambient-civilian';
  return mat;
}

/** Dynamic instanced civilians: one draw call for every figure on the map. */
export class CivilianInstances {
  readonly mesh: THREE.InstancedMesh;
  private a: Float32Array;
  private b: Float32Array;
  private top: Float32Array;
  private bot: Float32Array;
  private hat: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  n = 0;

  constructor(fog: FogOfWar, readonly max: number) {
    const g = civilianGeometry();
    const mk = (size: number) => {
      const arr = new Float32Array(max * size);
      const at = new THREE.InstancedBufferAttribute(arr, size);
      at.setUsage(THREE.DynamicDrawUsage);
      return { arr, at };
    };
    const A = mk(4);
    const B = mk(4);
    const T = mk(3);
    const Bo = mk(3);
    const H = mk(3);
    this.a = A.arr;
    this.b = B.arr;
    this.top = T.arr;
    this.bot = Bo.arr;
    this.hat = H.arr;
    g.setAttribute('aA', A.at);
    g.setAttribute('aB', B.at);
    g.setAttribute('aTop', T.at);
    g.setAttribute('aBot', Bo.at);
    g.setAttribute('aHat', H.at);
    this.attrs = [A.at, B.at, T.at, Bo.at, H.at];
    const m = new THREE.InstancedMesh(g, civilianMaterial(fog), max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.count = 0;
    m.visible = false;
    m.name = 'ambient-civilians';
    m.layers.enable(HEAT_LAYER);
    this.mesh = m;
  }

  begin() {
    this.n = 0;
  }

  get full() {
    return this.n >= this.max;
  }

  push(mat: THREE.Matrix4, phase: number, stride: number, pose: number, mask: number, skin: THREE.Color, lean: number, top: THREE.Color, bot: THREE.Color, hat: THREE.Color): boolean {
    const i = this.n;
    if (i >= this.max) return false;
    mat.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    const a = this.a;
    a[i * 4] = phase;
    a[i * 4 + 1] = stride;
    a[i * 4 + 2] = pose;
    a[i * 4 + 3] = mask;
    const b = this.b;
    b[i * 4] = skin.r;
    b[i * 4 + 1] = skin.g;
    b[i * 4 + 2] = skin.b;
    b[i * 4 + 3] = lean;
    top.toArray(this.top, i * 3);
    bot.toArray(this.bot, i * 3);
    hat.toArray(this.hat, i * 3);
    this.n++;
    return true;
  }

  commit() {
    const n = this.n;
    const m = this.mesh;
    m.count = n;
    m.visible = n > 0;
    if (!n) return;
    m.instanceMatrix.clearUpdateRanges();
    m.instanceMatrix.addUpdateRange(0, n * 16);
    m.instanceMatrix.needsUpdate = true;
    for (const at of this.attrs) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------ soft contact shadows

const SHADOW_VERT = /* glsl */ `
attribute vec4 aS;
varying vec2 vUv;
void main() {
  vUv = position.xz * 2.0;
  vec3 p = vec3(aS.x + position.x * aS.w, aS.y + 0.02, aS.z + position.z * aS.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SHADOW_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uK;
void main() {
  float r = dot(vUv, vUv);
  float a = (1.0 - smoothstep(0.15, 1.0, r)) * uK;
  gl_FragColor = vec4(vec3(1.0 - a), 1.0);
}`;

/** Blob shadows under figures (multiplied onto the ground): one draw call. */
export class BlobShadows {
  readonly mesh: THREE.InstancedMesh;
  private s: Float32Array;
  private at: THREE.InstancedBufferAttribute;
  n = 0;
  constructor(readonly max: number, strength = 0.42) {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.s = new Float32Array(max * 4);
    this.at = new THREE.InstancedBufferAttribute(this.s, 4);
    this.at.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aS', this.at);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: { uK: { value: strength } },
      transparent: true,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
    });
    const m = new THREE.InstancedMesh(g, mat, max);
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    m.renderOrder = 1;
    m.name = 'ambient-blob-shadows';
    this.mesh = m;
  }
  begin() {
    this.n = 0;
  }
  push(x: number, y: number, z: number, r: number) {
    const i = this.n;
    if (i >= this.max) return;
    this.s[i * 4] = x;
    this.s[i * 4 + 1] = y;
    this.s[i * 4 + 2] = z;
    this.s[i * 4 + 3] = r;
    this.n++;
  }
  commit() {
    const n = this.n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    this.at.clearUpdateRanges();
    this.at.addUpdateRange(0, n * 4);
    this.at.needsUpdate = true;
  }
}

// ------------------------------------------------------------ market stalls

/**
 * Market stall in tiles (people scale): four posts, a striped awning, a
 * table with crates of produce. Front (the customers' side) faces +X.
 * Built as plain vertex-coloured geometry; people.ts merges all of a map's
 * stalls into one static mesh.
 */
export function marketStall(b: GeoBuilder, m: THREE.Matrix4, awning: THREE.Color, seed: number) {
  const k = CIV_SCALE;
  const W = 2.2 * k; // along the front (z)
  const D = 1.3 * k; // depth (x)
  const wood = new THREE.Color(0.42, 0.3, 0.18);
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, c: THREE.Color, rx = 0, rz = 0) => b.add(g, m.clone().multiply(trs(x, y, z, rx, 0, rz)), null, c);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(0.05 * k, 2.1 * k, 0.05 * k), sx * D * 0.5, 1.05 * k, sz * W * 0.5, wood);
  // table + cloth
  add(new THREE.BoxGeometry(D * 0.9, 0.06 * k, W * 0.95), 0, 0.8 * k, 0, new THREE.Color(0.86, 0.82, 0.72));
  add(new THREE.BoxGeometry(0.02 * k, 0.3 * k, W * 0.95), D * 0.45, 0.66 * k, 0, awning.clone().multiplyScalar(0.8));
  // awning: striped panels sloping down to the front
  const n = 5;
  for (let i = 0; i < n; i++) {
    const c = i % 2 ? new THREE.Color(0.93, 0.92, 0.88) : awning;
    add(new THREE.BoxGeometry(D * 1.25, 0.03 * k, W / n), 0.1 * k, 2.1 * k, -W / 2 + (W / n) * (i + 0.5), c, 0, -0.22);
  }
  // produce in crates
  const produce = [new THREE.Color(0.95, 0.55, 0.1), new THREE.Color(0.85, 0.12, 0.1), new THREE.Color(0.35, 0.65, 0.15), new THREE.Color(0.95, 0.85, 0.2), new THREE.Color(0.5, 0.2, 0.45), new THREE.Color(0.7, 0.45, 0.25)];
  for (let i = 0; i < 4; i++) {
    const z = -W * 0.36 + (W * 0.72 * i) / 3;
    add(new THREE.BoxGeometry(0.45 * k, 0.12 * k, 0.45 * k), 0, 0.89 * k, z, wood);
    const pc = produce[(seed + i * 3) % produce.length];
    add(new THREE.SphereGeometry(0.2 * k, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.93 * k, z, pc);
  }
  // crates stacked beside
  add(new THREE.BoxGeometry(0.5 * k, 0.35 * k, 0.5 * k), -D * 0.2, 0.175 * k, W * 0.5 + 0.3 * k, wood);
  add(new THREE.SphereGeometry(0.22 * k, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), -D * 0.2, 0.35 * k, W * 0.5 + 0.3 * k, produce[(seed + 1) % produce.length]);
}

/** A football (ball) for the kids. */
export function ballGeometry(): THREE.BufferGeometry {
  return new THREE.IcosahedronGeometry(0.11 * CIV_SCALE, 1);
}
