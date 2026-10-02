import * as THREE from 'three';

/*
 * Battle damage, dust and mud for vehicle / aircraft materials.
 *
 * `wearPatch()` chains an onBeforeCompile on a (cached, shared) material:
 *  - dust & mud (vehicles): per-vertex `aWear.x` (0 clean .. 1 caked, baked
 *    from the root-space height when the template is built, stronger on the
 *    running gear) blends a noisy dust -> mud gradient into the albedo;
 *  - battle damage (uniform uDmg): darkened / battered plates, a growing
 *    noise-based soot + scorch pattern and higher roughness;
 *  - loose parts (vehicles): `aWear.y` = piece id + 256 * mode, `aWear.zw` =
 *    hinge (x, y). Once uDmg passes a per-piece threshold (hashed with uSeed)
 *    a mode-1 piece (ERA brick, stowage bin, jerry can) is blown off and a
 *    mode-2 / 3 piece (side skirt) hangs from its front / rear top corner.
 *
 * Damage never clones per unit: `wearVariant(base, level, seed)` returns a
 * shared material per (base, quantised damage level, seed 0..3) with the same
 * shader program, so a damaged unit keeps its draw-call count and units at the
 * same damage level batch state changes.
 */

export interface WearCfg {
  dirt: boolean;
  loose: boolean;
  /** Noise frequency per local unit (vehicles ~ tiles, aircraft ~ metres). */
  scale: number;
}

interface WearU {
  uDmg: { value: number };
  uSeed: { value: number };
  uWScale: { value: number };
  uDust: { value: THREE.Color };
  uMud: { value: THREE.Color };
}

const U = new WeakMap<THREE.Material, WearU>();
const CFG = new WeakMap<THREE.Material, WearCfg>();
const BASE = new WeakMap<THREE.Material, THREE.Material>();

function makeU(cfg: WearCfg, dmg = 0, seed = 0): WearU {
  return {
    uDmg: { value: dmg },
    uSeed: { value: seed },
    uWScale: { value: cfg.scale },
    uDust: { value: new THREE.Color(0x9c8a68) },
    uMud: { value: new THREE.Color(0x45382a) },
  };
}

const NOISE = /* glsl */ `
uniform float uDmg;
uniform float uSeed;
uniform float uWScale;
float wHash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float wNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wHash3(i + vec3(0, 0, 0)), wHash3(i + vec3(1, 0, 0)), f.x),
                 mix(wHash3(i + vec3(0, 1, 0)), wHash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(wHash3(i + vec3(0, 0, 1)), wHash3(i + vec3(1, 0, 1)), f.x),
                 mix(wHash3(i + vec3(0, 1, 1)), wHash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float wFbm(vec3 p) {
  return 0.55 * wNoise(p) + 0.3 * wNoise(p * 2.13 + 3.1) + 0.15 * wNoise(p * 4.37 + 7.7);
}
`;

function inject(shader: THREE.WebGLProgramParametersWithUniforms, u: WearU, cfg: WearCfg) {
  Object.assign(shader.uniforms, u);
  const attr = cfg.dirt || cfg.loose;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>
    uniform float uDmg;
    uniform float uSeed;
    ${attr ? 'attribute vec4 aWear;' : ''}
    varying vec3 vWPos;
    varying float vWDirt;`,
  );
  if (cfg.loose) {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        mat3 wRot = mat3(1.0);
        vec3 wPiv = vec3(0.0);
        float wHide = 0.0;
        if (aWear.y > 0.5 && uDmg > 0.0) {
          float wMode = floor(aWear.y / 256.0);
          float wId = aWear.y - wMode * 256.0;
          float wh = fract(sin(wId * 12.9898 + uSeed * 78.233 + wMode * 4.1) * 43758.5453);
          if (uDmg > 0.42 + 0.58 * wh) {
            if (wMode < 1.5) wHide = 1.0;
            else {
              // hanging by one end: droop about Z around the hinge (x, y) = aWear.zw
              float wa = (0.09 + 0.09 * fract(wh * 7.13)) * (wMode < 2.5 ? 1.0 : -1.0);
              float wc = cos(wa);
              float ws = sin(wa);
              wRot = mat3(wc, ws, 0.0, -ws, wc, 0.0, 0.0, 0.0, 1.0);
              wPiv = vec3(aWear.z, aWear.w, 0.0);
            }
          }
        }
        objectNormal = wRot * objectNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWPos = transformed;
        transformed = wHide > 0.5 ? vec3(0.0) : wRot * (transformed - wPiv) + wPiv;`,
      );
  } else {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vWPos = transformed;`,
    );
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
    vWDirt = ${cfg.dirt ? 'aWear.x' : '0.0'};`,
  );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      ${NOISE}
      uniform vec3 uDust;
      uniform vec3 uMud;
      varying vec3 vWPos;
      varying float vWDirt;`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec3 wP = vWPos * uWScale;
      float wSoot = 0.0;
      ${
        cfg.dirt
          ? `if (vWDirt > 0.01) {
        // broad patches with vertical run-off streaks (no fine speckle: reads as stucco on flat armour)
        float dn = wNoise(wP * vec3(1.1, 0.35, 1.1) + 11.0) * 0.55 + wNoise(wP * vec3(3.6, 0.9, 3.6) + 5.0) * 0.3 + wNoise(wP * vec3(9.0, 1.6, 9.0)) * 0.15;
        float dk = clamp(vWDirt * (0.5 + 1.1 * (dn - 0.35)), 0.0, 1.0);
        vec3 dc = mix(uDust, uMud, smoothstep(0.5, 0.95, vWDirt * (0.65 + 0.7 * dn)));
        diffuseColor.rgb = mix(diffuseColor.rgb, dc, dk * 0.9);
      }`
          : ''
      }
      float wPock = 0.0;
      if (uDmg > 0.001) {
        // battered plates: random panels darkened / discoloured
        vec3 wCell = floor(wP * 1.3 + uSeed * 3.7);
        float wch = wHash3(wCell + 0.5);
        diffuseColor.rgb *= 1.0 - step(wch, uDmg * 0.45) * (0.16 + 0.16 * wch);
        // soot & scorch: patches stretched upward like smoke stains, coverage grows with damage
        float wn = 0.62 * wNoise(wP * vec3(0.55, 0.3, 0.55) + uSeed * 13.1) + 0.38 * wFbm(wP * vec3(2.2, 1.3, 2.2) + uSeed * 7.0);
        float wEdge = 0.9 - uDmg * 0.42;
        wSoot = smoothstep(wEdge - 0.05, wEdge + 0.14, wn) * (0.6 + 0.4 * uDmg);
        float wRim = smoothstep(wEdge - 0.17, wEdge - 0.02, wn) * (1.0 - wSoot);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.6, 0.48, 0.38), wRim * 0.65);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.018, 0.016), wSoot * 0.92);
        // fragment / bullet strikes: bare-metal pocks
        vec3 wpk = wP * 10.0 + uSeed * 5.3;
        float wph = wHash3(floor(wpk));
        float wpd = length(fract(wpk) - 0.5);
        wPock = step(wph, uDmg * 0.05) * (1.0 - smoothstep(0.08, 0.16, wpd)) * (1.0 - wSoot);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.46, 0.44, 0.4), wPock * 0.9);
        diffuseColor.rgb *= 1.0 - 0.36 * uDmg * uDmg;
      }`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 1.0, max(wSoot, ${cfg.dirt ? 'clamp(vWDirt, 0.0, 1.0) * 0.6' : '0.0'}));`,
    )
    .replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
      metalnessFactor = mix(metalnessFactor * (1.0 - wSoot * 0.8), 0.85, wPock);`,
    );
}

/** Patch a material in place (call AFTER fog.apply so the program cache key stays unique). */
export function wearPatch<T extends THREE.Material>(m: T, cfg: WearCfg): T {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();
  const key = `${prevKey}|wear${cfg.dirt ? 'D' : ''}${cfg.loose ? 'L' : ''}`;
  m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    const u = U.get(this);
    const c = CFG.get(this);
    if (u && c) inject(shader, u, c);
  };
  m.customProgramCacheKey = () => key;
  U.set(m, makeU(cfg));
  CFG.set(m, cfg);
  return m;
}

export const isWearMaterial = (m: THREE.Material) => U.has(m);

/** Number of quantised damage levels above 0. */
export const WEAR_LEVELS = 5;
/** Quantise a 0..1 damage value (0 = pristine). Slight hysteresis is the caller's business. */
export function wearLevel(damage: number): number {
  if (!(damage > 0.06)) return 0;
  return Math.min(WEAR_LEVELS, 1 + Math.floor(((damage - 0.06) / 0.94) * WEAR_LEVELS));
}
const levelDamage = (l: number) => (l <= 0 ? 0 : 0.14 + ((l - 1) / (WEAR_LEVELS - 1)) * 0.82);

const variants = new Map<THREE.Material, THREE.Material[]>();

/** Shared damaged variant of a wear-patched base material (level 0 = the base itself). */
export function wearVariant(base: THREE.Material, level: number, seed: number): THREE.Material {
  const root = BASE.get(base) ?? base;
  if (level <= 0 || !U.has(root)) return root;
  let list = variants.get(root);
  if (!list) variants.set(root, (list = []));
  const idx = (level - 1) * 4 + (seed & 3);
  let v = list[idx];
  if (!v) {
    v = root.clone();
    v.onBeforeCompile = root.onBeforeCompile;
    v.customProgramCacheKey = root.customProgramCacheKey;
    U.set(v, makeU(CFG.get(root)!, levelDamage(level), (seed & 3) + 1));
    CFG.set(v, CFG.get(root)!);
    BASE.set(v, root);
    list[idx] = v;
  }
  return v;
}

/** Set the damage directly on a per-instance material (e.g. track belts). */
export function setWear(m: THREE.Material, damage: number, seed: number) {
  const u = U.get(m);
  if (!u) return;
  u.uDmg.value = damage;
  u.uSeed.value = (seed & 3) + 1;
}

/**
 * Per-instance damage driver: swaps the meshes' managed materials to the shared
 * variant for the current damage level (only when the level changes). Meshes
 * whose material was replaced by something else (e.g. the renderer's burnt
 * wreck material) are left alone.
 */
export class WearDriver {
  private level = 0;
  private meshes: { m: THREE.Mesh; base: THREE.Material }[] = [];
  constructor(
    root: THREE.Object3D,
    readonly seed: number,
    private readonly perInstance: THREE.Material[] = [],
  ) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      const mat = m.material as THREE.Material;
      if (U.has(mat) && !perInstance.includes(mat)) this.meshes.push({ m, base: BASE.get(mat) ?? mat });
    });
  }
  update(damage: number) {
    let l = wearLevel(damage);
    // hysteresis: do not flicker between two levels on small hp changes
    if (l === this.level - 1 && wearLevel(damage + 0.03) === this.level) l = this.level;
    if (l === this.level) return;
    this.level = l;
    for (const e of this.meshes) {
      const cur = e.m.material as THREE.Material;
      if (!U.has(cur)) continue; // replaced externally
      e.m.material = wearVariant(e.base, l, this.seed);
    }
    for (const m of this.perInstance) setWear(m, levelDamage(l), this.seed);
  }
  get current() {
    return this.level;
  }
}
