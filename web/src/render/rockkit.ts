import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { FogOfWar } from './fog';
import { assetBase } from './photoground';
import { ROCK_DETAIL_GLSL, rockDetail, rockMean, type RockKind } from './rockdetail';

/*
 * The desert's rock kit (GD4, render only): granite tors, corestones and boulders, rockfall talus blocks, scree
 * slabs and chips, sculpted and baked in Blender (tools/blender/rockkit.py -> public/tex/rocks/rockkit.glb), two
 * levels of detail each, instanced by rocks.ts (CulledInstances + SceneryLod).
 *
 * No UVs or textures of their own: they wear the cliffs' triplanar granite / sandstone (rockdetail.ts) in world
 * space, so a block fallen from a cliff matches it. Baked per vertex (colour attribute, renamed aRock):
 * R ambient occlusion, G fresh fracture faces (paler, pinker, not yet varnished), B convexity (worn, dusty edges).
 */

export const KIT_KEYS = ['tor', 'corestone', 'boulder', 'slab', 'talus1', 'talus2', 'chip'] as const;
export type KitKey = (typeof KIT_KEYS)[number];

export interface RockKit {
  /** Per piece: near / far geometry (horizontal radius 1, base at y = -0.4, like rocks.ts' rocks). */
  geos: Record<KitKey, { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }>;
}

let kitLoad: Promise<RockKit | null> | null = null;

/** Plain geometry (dequantised, node transform applied): position, normal, aRock. */
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
    else col.set([1, 0, 0.5], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aRock', new THREE.BufferAttribute(col, 3));
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint16Array.from(src.index.array as ArrayLike<number>), 1));
  g.computeBoundingSphere();
  return g;
}

/** Load the kit once (null if it cannot be loaded: the callers keep their procedural rocks). */
export function loadRockKit(): Promise<RockKit | null> {
  if (kitLoad) return kitLoad;
  kitLoad = (async () => {
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(`${assetBase()}tex/rocks/rockkit.glb`);
      gltf.scene.updateMatrixWorld(true);
      const find = (name: string) => {
        let hit: THREE.Mesh | null = null;
        gltf.scene.traverse((o) => {
          if (!hit && (o as THREE.Mesh).isMesh && (o.name === name || o.parent?.name === name)) hit = o as THREE.Mesh;
        });
        if (!hit) throw new Error('rockkit.glb: no mesh ' + name);
        return bake(hit);
      };
      const geos = {} as RockKit['geos'];
      for (const k of KIT_KEYS) geos[k] = { hi: find(`${k}_hi`), lo: find(`${k}_lo`) };
      return { geos };
    } catch (e) {
      console.warn('[rockkit] rock kit unavailable, keeping the procedural rocks', e);
      return null;
    }
  })();
  return kitLoad;
}

/**
 * The kit's material: the rock's triplanar detail (world space) on a base colour, the baked occlusion, fresh
 * fracture faces and worn edges, a little drift dust on top. `color` is the rock's average colour (linear).
 */
export function rockKitMaterial(fog: FogOfWar, kind: RockKind, quality: 'medium' | 'high', color: THREE.Color): THREE.MeshStandardMaterial {
  const det = rockDetail(kind, quality === 'high' ? 1024 : 512);
  const u = {
    rkA: det.a,
    rkN: det.n,
    rkMean: { value: rockMean(kind) },
    rkCol: { value: color.clone() },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: kind === 'granite' ? 0.86 : 0.92, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRock;\nvarying vec3 vRock;\nvarying vec3 vRkN;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRock = aRock;
        {
          vec3 rn = objectNormal;
          #ifdef USE_INSTANCING
            rn = mat3( instanceMatrix ) * rn;
          #endif
          vRkN = normalize( mat3( modelMatrix ) * rn );
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRock;
        varying vec3 vRkN;
        uniform sampler2D rkA;
        uniform sampler2D rkN;
        uniform vec3 rkMean;
        uniform vec3 rkCol;
        vec3 rkWN;
        ${ROCK_DETAIL_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 n = normalize( vRkN );
          vec3 alb;
          float rh;
          // (a finer scale than the cliffs: a boulder shows the grain and cracks, not whole joint blocks)
          rdTri( rkA, rkN, vFogP, n, ${kind === 'granite' ? '0.9' : '0.8'}, alb, rkWN, rh );
          vec3 c = rkCol * alb / rkMean;
          // fresh fracture faces: paler and pinker, no varnish yet; worn convex edges a touch paler (dust)
          float fresh = vRock.g;
          c *= mix( vec3( 1.0 ), vec3( 1.22, 1.12, 1.04 ), fresh * 0.75 );
          c *= 1.0 + clamp( vRock.b - 0.5, -0.5, 0.5 ) * 0.3;
          // baked occlusion (contact shade at the foot, the cracks)
          c *= mix( 0.6, 1.0, vRock.r );
          // drift dust on the tops
          float up = smoothstep( 0.6, 0.95, n.y );
          c = mix( c, vec3( 0.52, 0.38, 0.24 ) * 0.62, up * 0.3 );
          diffuseColor.rgb *= c;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize( ( viewMatrix * vec4( rkWN, 0.0 ) ).xyz );`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'rockkit-' + kind;
  return mat;
}
