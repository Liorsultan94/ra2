import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { FogOfWar } from './fog';
import { assetBase } from './photoground';

/*
 * Burnt-out vehicle hulks built in Blender (CF1, render only): tools/blender/hulkkit.py -> public/models/hulks.glb.
 *
 * When a ground vehicle dies, its model is swapped (under the fireball) for the twisted, scorched hulk of its class -
 * main battle tank, infantry fighting vehicle, truck or harvester - fitted to the dead model's footprint: the turret
 * knocked askew or blown off (the blown-off one is thrown by the cook-off and lies where it lands), the gun drooping,
 * a track thrown off, skirts and bins torn, a penetration crater where the round hit. The hulk burns, smoulders with
 * glowing embers (fading as it cools) and is then kept by the battle scars (scars.ts / scarsmesh.ts) as before.
 *
 * Per vertex (aHulk, baked in Blender): R ambient occlusion, G rust / ash mask, B ember mask. No UVs or textures:
 * the charred steel, rust, ash and the embers' glow are shaded from that and world-space noise (HULK_GLSL).
 */

export type HulkClass = 'mbt' | 'ifv' | 'truck' | 'harv';

/** The hull's nominal footprint in the kit (game units: length along x, width along z, height): fitted to the model. */
const NOMINAL: Record<HulkClass, { L: number; W: number; H: number }> = {
  mbt: { L: 1.0, W: 0.58, H: 0.38 },
  ifv: { L: 1.0, W: 0.56, H: 0.43 },
  truck: { L: 1.18, W: 0.52, H: 0.42 },
  harv: { L: 1.2, W: 0.7, H: 0.6 },
};

/** Where flames lick out of each hulk (nominal kit space: hatches, engine deck, the turret ring, the cab). */
export const HULK_FIRES: Record<HulkClass, [number, number, number][]> = {
  mbt: [
    [-0.32, 0.29, 0],
    [0.23, 0.3, -0.1],
    [0.02, 0.3, 0.02],
  ],
  ifv: [
    [-0.4, 0.3, 0],
    [0.25, 0.36, 0.08],
    [0.0, 0.36, 0.0],
  ],
  truck: [
    [0.36, 0.3, 0],
    [-0.2, 0.22, 0.05],
    [0.52, 0.25, 0],
  ],
  harv: [
    [-0.12, 0.5, 0],
    [0.43, 0.42, -0.2],
    [0.0, 0.32, 0.3],
  ],
};

export interface HulkKit {
  geos: Record<string, THREE.BufferGeometry>;
}

let kitLoad: Promise<HulkKit | null> | null = null;
let kitReady: HulkKit | null = null;

const KEYS = ['mbt', 'mbt_open', 'mbt_turret', 'ifv', 'ifv_open', 'ifv_turret', 'truck', 'harv'];

/** Plain geometry (dequantised, node transform applied): position, normal, aHulk. */
function bake(mesh: THREE.Mesh): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const src = mesh.geometry;
  const n = src.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const P = src.attributes.position;
  const N = src.attributes.normal;
  const C = src.attributes.color;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld);
    pos.set([v.x, v.y, v.z], i * 3);
    v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
    nrm.set([v.x, v.y, v.z], i * 3);
    if (C) col.set([C.getX(i), C.getY(i), C.getZ(i)], i * 3);
    else col.set([0.6, 0.3, 0], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aHulk', new THREE.BufferAttribute(col, 3));
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint16Array.from(src.index.array as ArrayLike<number>), 1));
  g.computeBoundingSphere();
  return g;
}

/** Load the kit once in the background (null if it cannot be loaded: wrecks keep the burnt model as before). */
export function loadHulkKit(): Promise<HulkKit | null> {
  if (kitLoad) return kitLoad;
  kitLoad = (async () => {
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(`${assetBase()}models/hulks.glb`);
      gltf.scene.updateMatrixWorld(true);
      const geos: Record<string, THREE.BufferGeometry> = {};
      for (const k of KEYS) {
        let hit: THREE.Mesh | null = null;
        gltf.scene.traverse((o) => {
          if (!hit && (o as THREE.Mesh).isMesh && (o.name === k || o.parent?.name === k)) hit = o as THREE.Mesh;
        });
        if (!hit) throw new Error('hulks.glb: no mesh ' + k);
        geos[k] = bake(hit);
      }
      kitReady = { geos };
      return kitReady;
    } catch (e) {
      console.warn('[hulks] hulk kit unavailable, keeping the burnt models', e);
      return null;
    }
  })();
  return kitLoad;
}

/** The kit, once loaded (synchronous: a death before it arrives keeps the old burnt model). */
export function hulkKit(): HulkKit | null {
  return kitReady;
}

/** Which hulk a dead ground vehicle leaves (null: keep its own burnt model, e.g. small robots). */
export function hulkClass(o: { harvester?: boolean; mcv?: boolean; turret?: boolean; armor?: string; wheeled?: boolean; size?: { x: number } }): HulkClass | null {
  if (o.harvester || o.mcv) return 'harv';
  if (o.size && o.size.x < 0.55) return null;
  if (o.wheeled) return 'truck';
  if (o.turret && o.armor === 'heavy') return 'mbt';
  return 'ifv';
}

/**
 * The shading shared by the burning hulk (its own mesh) and the kept hulks (scarsmesh.ts batch). Needs vFogP,
 * fogNoise, fogTime (FogOfWar.apply) and a vec3 hv: x rust amount, y shade (occlusion), z ember glow 0..1.
 */
export const HULK_ALBEDO_GLSL = /* glsl */ `
  {
    float scN = texture2D( fogNoise, vFogP.xz * 1.9 + vFogP.y * 0.8 ).r;
    float scN2 = texture2D( fogNoise, vFogP.xz * 6.3 - vFogP.y * 2.1 ).g;
    float scRust = smoothstep( 0.32, 0.72, hv.x + ( scN - 0.5 ) * 0.7 + ( scN2 - 0.5 ) * 0.25 );
    vec3 scChar = vec3( 0.03, 0.027, 0.024 ) * ( 0.75 + 0.6 * scN2 );
    // pale grey ash and burnt-off paint where the fire was fiercest (on top of the hot spots)
    scChar = mix( scChar, vec3( 0.11, 0.105, 0.1 ), smoothstep( 0.62, 0.85, scN2 + hv.z * 0.35 ) * 0.55 );
    vec3 scRustC = mix( vec3( 0.13, 0.042, 0.014 ), vec3( 0.075, 0.03, 0.012 ), scN );
    diffuseColor.rgb = mix( scChar, scRustC, scRust ) * hv.y;
  }
`;

/** Embers glowing in the cracks of a smouldering hulk (soft: never brighter than a warm glow). */
export const HULK_EMBER_GLSL = /* glsl */ `
  if ( hv.z > 0.003 ) {
    float hkCr = texture2D( fogNoise, vFogP.xz * 9.0 + vFogP.y * 4.3 ).b;
    float hkFl = texture2D( fogNoise, vFogP.xz * 2.3 + vec2( fogTime * 0.11, -fogTime * 0.07 ) ).r;
    float hkG = hv.z * smoothstep( 0.42, 0.78, hkCr + hv.z * 0.3 ) * ( 0.5 + 0.8 * hkFl );
    totalEmissiveRadiance += mix( vec3( 0.75, 0.12, 0.02 ), vec3( 1.0, 0.42, 0.1 ), hkG ) * hkG * 0.9;
  }
`;

/** The material of a burning hulk (one per wreck: its heat uniform cools down). */
export function hulkMaterial(fog: FogOfWar): THREE.MeshStandardMaterial & { userData: { heat: { value: number } } } {
  const heat = { value: 1 };
  const mat = fog.apply(new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.2 }));
  const fogObc = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    fogObc.call(mat, sh, r);
    sh.uniforms.hkHeat = heat;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aHulk;\nvarying vec3 vHulk;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvHulk = aHulk;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHulk;\nuniform float hkHeat;')
      .replace('#include <color_fragment>', `#include <color_fragment>\nvec3 hv = vec3( vHulk.g * 0.25, 0.35 + 0.75 * vHulk.r, vHulk.b * hkHeat );\n${HULK_ALBEDO_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${HULK_EMBER_GLSL}`);
  };
  mat.customProgramCacheKey = () => 'hulk-burning';
  mat.userData.heat = heat;
  return mat as THREE.MeshStandardMaterial & { userData: { heat: { value: number } } };
}

/**
 * The hulk mesh for a dead model of class cls, fitted to its footprint (size: the model's x length, y height,
 * z width). variant: '' (turret on, knocked askew), '_open' (turret blown off) or '_turret' (the turret alone,
 * fitted with the hull's scale). mirror flips it left / right for variety.
 */
export function hulkMesh(kit: HulkKit, cls: HulkClass, variant: '' | '_open' | '_turret', size: { x: number; y: number; z: number }, mat: THREE.Material, mirror: boolean): THREE.Mesh | null {
  const key = cls + variant;
  const g = kit.geos[key] ?? kit.geos[cls];
  if (!g) return null;
  const nm = NOMINAL[cls];
  const sx = size.x / nm.L;
  const sz = size.z / nm.W;
  const sy = Math.min(size.y / nm.H, (sx + sz) / 2) * 0.95;
  const m = new THREE.Mesh(g, mat);
  m.scale.set(sx, Math.max(0.5, sy), sz * (mirror ? -1 : 1));
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = 'hulk-' + key;
  m.userData.hulk = cls;
  return m;
}
