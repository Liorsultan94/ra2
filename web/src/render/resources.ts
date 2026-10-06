import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Tile, type GameMap } from '../sim/map';
import { hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GeoBuilder } from './geo';
import { surfaceHeight } from './ground';
import { PER_GEM, PER_ORE, oreFieldKinds, pieceScale, planOreSlots, type OreSlot } from './orefield';
import { assetBase, fetchBitmap } from './photoground';

/*
 * Harvestable resources. Gems (oreKind 2) are faceted crystal clusters
 * growing out of the ground: translucent violet glass with inclusions, an
 * inner glow, facet glints that flash as the camera or the sun moves and a
 * soft emissive light by night. Ore (oreKind 1) is dark rock rubble cut by
 * native-gold veins, with gold nuggets that glint.
 *
 * The models are authored in Blender (tools/blender/crystals.py): low-poly
 * game meshes with a normal map (bevelled, chipped edges) and a mask (AO,
 * inclusions / veins, glass-or-gold flag) baked from high-poly sources, in
 * public/tex/crystals/. Until they stream in (or if they fail to load) the
 * old procedural rubble stands in.
 *
 * Pieces come from orefield.ts (planOreSlots): every tile of a field gets a
 * few, and they shrink and vanish as the tile is mined (pieceScale). One
 * instanced mesh per deposit and piece type; the night glow pools on the
 * ground are one more instanced mesh for the whole map, drawn only at night.
 * Each regrowth point (map.oreMines) gets a small drilling rig.
 */

// ------------------------------------------------------------ procedural stand-ins

function chunkGeo(seed: number, detail: number, sharp: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    const r = 1 + (valueNoise(x * 2 + z, y * 2 + 3, seed) - 0.5) * sharp + (valueNoise(z * 3, x * 3 + y, seed + 1) - 0.5) * sharp * 0.5;
    P.setXYZ(i, x * r, Math.max(-0.3, y * r), z * r);
  }
  g = g.toNonIndexed(); // faceted, catches light like broken rock
  g.computeVertexNormals();
  return g;
}

/** Several chunks merged into one "pile" geometry with per-vertex colour. */
function pileGeo(seed: number, n: number, col: (k: number) => THREE.Color): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (let k = 0; k < n; k++) {
    const c = chunkGeo(seed + k * 7, 0, 0.7);
    const a = hash2(k, seed, 1) * Math.PI * 2;
    const rr = k === 0 ? 0 : 0.35 + hash2(k, seed, 2) * 0.35;
    const s = k === 0 ? 0.5 : 0.25 + hash2(k, seed, 3) * 0.22;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * rr, s * 0.35, Math.sin(a) * rr),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(hash2(k, seed, 4) * 3, hash2(k, seed, 5) * 3, hash2(k, seed, 6) * 3)),
      new THREE.Vector3(s, s * 0.7, s),
    );
    const cc = col(k);
    b.add(c, m, null, (p) => cc.clone().multiplyScalar(0.75 + Math.min(0.35, p.y * 0.6) + (hash2(Math.floor(p.x * 50), Math.floor(p.z * 50), k) - 0.5) * 0.2));
  }
  return b.build();
}

function standIns(quality: 'low' | 'medium' | 'high') {
  const rust = (k: number) => new THREE.Color().setRGB(0.3 + hash2(k, 1, 9) * 0.1, 0.17 + hash2(k, 2, 9) * 0.05, 0.11 + hash2(k, 3, 9) * 0.04);
  const chunks = quality === 'high' ? 4 : 3;
  const nugget = new GeoBuilder();
  for (let k = 0; k < 2; k++) {
    const m4 = new THREE.Matrix4().compose(new THREE.Vector3((k - 1) * 0.5, 0.2, (hash2(k, 4, 4) - 0.5) * 0.6), new THREE.Quaternion().setFromEuler(new THREE.Euler(k, k * 2, k * 0.5)), new THREE.Vector3(0.45, 0.4, 0.45));
    nugget.add(chunkGeo(40 + k, 0, 0.9), m4, null, new THREE.Color().setRGB(0.72, 0.45 + k * 0.05, 0.22));
  }
  const crystal = new GeoBuilder();
  for (let k = 0; k < 3; k++) {
    const c = new THREE.OctahedronGeometry(0.3, 0).scale(0.55, 1.6, 0.55);
    c.computeVertexNormals();
    const m4 = new THREE.Matrix4().compose(
      new THREE.Vector3((hash2(k, 1, 5) - 0.5) * 0.7, 0.25, (hash2(k, 2, 5) - 0.5) * 0.7),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((hash2(k, 3, 5) - 0.5) * 1.2, hash2(k, 4, 5) * 3, (hash2(k, 5, 5) - 0.5) * 1.2)),
      new THREE.Vector3(0.6 + k * 0.1, 0.6 + k * 0.12, 0.6 + k * 0.1),
    );
    crystal.add(c, m4, null, new THREE.Color().setRGB(0.9, 0.9, 0.95));
  }
  const cr = crystal.build();
  return { gemBig: cr, gemSmall: cr, oreBig: pileGeo(3, chunks, rust), oreSmall: nugget.build() };
}

// ------------------------------------------------------------ baked models (Blender)

interface CrystalAssets {
  geos: Record<string, THREE.BufferGeometry>;
  normal: THREE.Texture;
  mask: THREE.Texture;
}

const MODELS = ['gem_big_a', 'gem_big_b', 'gem_small', 'ore_rock_a', 'ore_rock_b', 'ore_nugget'];
let assetsLoad: Promise<CrystalAssets | null> | null = null;

/** Plain float geometry (node transform applied) from a loaded glTF mesh. */
function flatten(mesh: THREE.Mesh): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function loadCrystals(): Promise<CrystalAssets | null> {
  if (assetsLoad) return assetsLoad;
  const dir = `${assetBase()}tex/crystals/`;
  const tex = async (url: string) => {
    const t = new THREE.Texture(await fetchBitmap(url));
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  assetsLoad = (async () => {
    try {
      const [gltf, normal, mask] = await Promise.all([new GLTFLoader().loadAsync(`${dir}crystals.glb`), tex(`${dir}crystals_n.webp`), tex(`${dir}crystals_m.webp`)]);
      gltf.scene.updateMatrixWorld(true);
      const geos: Record<string, THREE.BufferGeometry> = {};
      for (const name of MODELS) {
        let hit: THREE.Mesh | null = null;
        gltf.scene.traverse((o) => {
          if (!hit && (o as THREE.Mesh).isMesh && (o.name === name || o.parent?.name === name)) hit = o as THREE.Mesh;
        });
        if (!hit) throw new Error('crystals.glb: no mesh ' + name);
        geos[name] = flatten(hit);
      }
      return { geos, normal, mask };
    } catch (e) {
      console.warn('[resources] crystal models unavailable, keeping the procedural rubble', e);
      return null;
    }
  })();
  return assetsLoad;
}

// ------------------------------------------------------------ shading

/** 0 = day .. 1 = full night (the renderer sets it every frame). */
const NIGHT = { value: 0 };

const VERT_PARS = /* glsl */ `
varying float vSeed;
varying float vH;`;
const VERT_MAIN = /* glsl */ `
vH = position.y;
{
  vec3 seedP = vec3( 0.0 );
  #ifdef USE_INSTANCING
    seedP = instanceMatrix[ 3 ].xyz;
  #endif
  // one value per facet (flat normals) and instance: which facets glint, and where they point
  vSeed = fract( sin( dot( normal, vec3( 12.9898, 78.233, 37.719 ) ) + dot( seedP, vec3( 0.731, 0.0, 1.379 ) ) ) * 43758.5453 );
}`;
const FRAG_PARS = /* glsl */ `
uniform sampler2D oreMask;
uniform float oreNight;
varying float vSeed;
varying float vH;
// a facet is a tiny mirror tilted a little off its face: it flashes when it throws the sun into the camera
float oreGlint( vec3 N, vec3 V, vec3 L, float seed, float spread, float power ) {
  vec3 j = fract( sin( vec3( seed * 91.3, seed * 47.1 + 3.1, seed * 13.7 + 7.7 ) ) * 43758.5453 ) - 0.5;
  vec3 Ng = normalize( N + j * spread );
  return pow( max( dot( reflect( -V, Ng ), L ), 0.0 ), power );
}`;
const GLINT = (k: number) => /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  vec3 gV = normalize( vViewPosition );
  float gl = oreGlint( nonPerturbedNormal, gV, directionalLights[ 0 ].direction, vSeed, 0.6, 160.0 ) * step( 0.4, fract( vSeed * 7.31 ) );
  reflectedLight.directSpecular += directionalLights[ 0 ].color * gl * oreSpark * ${k.toFixed(2)};
}
#endif`;

function patch(mat: THREE.MeshStandardMaterial, mask: THREE.Texture, frag: { color: string; rough: string; spec: string; emis: string; glint: number }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.oreMask = { value: mask };
    shader.uniforms.oreNight = NIGHT;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${frag.color}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${frag.rough}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${frag.emis}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${frag.spec}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLINT(frag.glint)}`);
  };
}

/** Gem crystals: dark coloured glass (instance colour = hue), inclusions, inner glow, tinted reflections, glints. */
function gemMaterial(a: CrystalAssets, fog: FogOfWar, winter: boolean) {
  const mat = new THREE.MeshStandardMaterial({ normalMap: a.normal, roughness: 0.1, metalness: 0 });
  patch(mat, a.mask, {
    color: /* glsl */ `
      vec3 oreM = texture2D( oreMask, vNormalMapUv ).rgb; // ao, inclusions, glass flag
      vec3 gemC = diffuseColor.rgb;
      float oreSpark = oreM.b;
      diffuseColor.rgb = mix( vec3( 0.075, 0.066, 0.06 ), gemC * ( 0.32 + 0.3 * oreM.g ), oreSpark ) * ( 0.35 + 0.65 * oreM.r );`,
    rough: /* glsl */ `
      roughnessFactor = mix( 0.85, 0.05 + 0.12 * oreM.g, oreSpark );
      metalnessFactor = 0.0;`,
    // high-index glass: stronger, colour-tinted reflections than plain dielectrics
    spec: /* glsl */ `
      material.specularColorBlended = mix( material.specularColorBlended, ( gemC * 0.5 + 0.5 ) * 0.14, oreSpark );`,
    emis: /* glsl */ `
      {
        // light caught inside: a core that glows from the base, seen through the facets facing the viewer,
        // and internal reflections that slide across each facet as the view turns (a refracted ray against
        // a plane picked per facet), dimmed by the cracks and veils; much brighter by night
        vec3 eV = normalize( vViewPosition );
        float ndv = clamp( dot( normal, eV ), 0.0, 1.0 );
        vec3 eR = refract( -eV, normal, 0.6 );
        vec3 pd = normalize( fract( sin( vec3( vSeed * 12.9, vSeed * 78.2 + 1.3, vSeed * 37.7 + 2.1 ) ) * 43758.5 ) - 0.5 );
        float band = pow( abs( dot( eR, pd ) ), 6.0 );
        float core = ( 1.0 - clamp( vH, 0.0, 1.0 ) * 0.6 ) * ( 0.3 + 0.7 * ndv );
        vec3 inner = gemC * ( core * ( 0.55 + 0.9 * oreM.g ) + band * 1.3 ) * ( 0.35 + 0.65 * oreM.r );
        totalEmissiveRadiance += inner * oreSpark * ( 0.8 + 1.4 * oreNight );
      }`,
    glint: 7,
  });
  if (winter) mat.defines = { ...mat.defines, WX_SNOW_K: '0.15' };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-gem-crystal' + (winter ? '-w' : '');
  return mat;
}

/** Ore: dark rock with native-gold veins (mask G) and gold nuggets (mask B); the gold glints. */
function oreMaterial(a: CrystalAssets, fog: FogOfWar, winter: boolean) {
  const mat = new THREE.MeshStandardMaterial({ normalMap: a.normal, roughness: 0.85, metalness: 0 });
  patch(mat, a.mask, {
    color: /* glsl */ `
      vec3 oreM = texture2D( oreMask, vNormalMapUv ).rgb; // ao, veins, nugget flag
      float oreSpark = max( oreM.b, smoothstep( 0.0, 0.16, oreM.g ) ); // nuggets, veins (thickened to read at play zoom)
      // the host rock itself is mineralised: warm bronze with a dull metallic sheen
      vec3 rockC = vec3( 0.21, 0.135, 0.07 ) * ( 0.85 + 0.3 * fract( vSeed * 3.7 ) );
      diffuseColor.rgb = mix( rockC, vec3( 1.0, 0.68, 0.26 ), oreSpark ) * ( 0.3 + 0.7 * oreM.r );`,
    rough: /* glsl */ `
      roughnessFactor = mix( 0.62, 0.22, oreSpark );
      metalnessFactor = mix( 0.3, 1.0, oreSpark );`,
    spec: '',
    // a little self-light so the gold still reads in shade and by night (the env map alone goes flat)
    emis: /* glsl */ `
      totalEmissiveRadiance += vec3( 0.55, 0.33, 0.1 ) * oreSpark * oreM.r * ( 0.45 + 0.45 * oreNight );`,
    glint: 9,
  });
  if (winter) mat.defines = { ...mat.defines, WX_SNOW_K: '0.2' };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-ore-gold' + (winter ? '-w' : '');
  return mat;
}

// ------------------------------------------------------------ night glow pools

const POOL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vWp;
void main() {
  vUv = uv * 2.0 - 1.0;
  vCol = instanceColor;
  vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vWp = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const POOL_FRAG = /* glsl */ `
uniform float oreNight;
uniform sampler2D fogTex;
uniform vec2 fogSize;
uniform float fogEnabled;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vWp;
void main() {
  float r = length( vUv );
  float a = 1.0 - smoothstep( 0.0, 1.0, r );
  a *= a;
  // nothing shows through the shroud; dimmer on explored-but-unseen ground
  float v = fogEnabled > 0.5 ? texture2D( fogTex, vWp.xz / fogSize ).r : 1.0;
  float vis = smoothstep( 0.06, 0.4, v ) * ( 0.45 + 0.55 * smoothstep( 0.56, 0.92, v ) );
  gl_FragColor = vec4( vCol * a * oreNight * vis, 1.0 );
}`;

// ------------------------------------------------------------ the deposits

/** One instanced mesh per deposit and piece type, compacted to the pieces still present. */
interface Batch {
  mesh: THREE.InstancedMesh;
  slots: OreSlot[];
  base: THREE.Matrix4[];
  tiles: number[];
  gem: boolean;
  big: boolean;
  /** Which baked model variant (deposits alternate). */
  variant: number;
  /** Per-slot crystal colour (gems). */
  colors: THREE.Color[];
}

export class Resources {
  readonly group = new THREE.Group();
  private batches: Batch[] = [];
  private cache: Uint8Array;
  private beacon: THREE.MeshStandardMaterial;
  private glow: THREE.InstancedMesh;
  private glowTiles: number[] = [];
  private glowBase: THREE.Color[] = [];
  /** The Blender models are in (tests / screenshots). */
  crystalsReady = false;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    const m = map;
    this.cache = new Uint8Array(m.w * m.h).fill(255);
    const shadows = quality === 'high';
    const winter = m.biome === 'winter';

    // stand-in materials (the old procedural look) until the models stream in
    const oreRubbleMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15, flatShading: true }));
    const oreNuggetMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85, flatShading: true, emissive: 0x2a1404, emissiveIntensity: 0.6 }));
    const gemCrystalMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.35, flatShading: true, emissive: 0x1e2a66, emissiveIntensity: 0.4 }));
    if (winter) for (const mt of [oreRubbleMat, oreNuggetMat]) mt.defines = { ...mt.defines, WX_SNOW_K: '0.25' };
    const stand = standIns(quality);

    const kinds = oreFieldKinds(m);
    const slots = planOreSlots(m, kinds);
    // deposit = nearest rig (tiles without a rig nearby form their own group per 16x16 cell)
    const groups = new Map<string, OreSlot[]>();
    const keyOf = new Map<number, string>();
    for (const s of slots) {
      let key = keyOf.get(s.tile);
      if (!key) {
        const x = s.tile % m.w;
        const y = Math.floor(s.tile / m.w);
        key = `c${Math.floor(x / 16)},${Math.floor(y / 16)}`;
        let bd = 9;
        m.oreMines.forEach((mm, k) => {
          const d = Math.max(Math.abs(x - mm.x), Math.abs(y - mm.y));
          if (d < bd) {
            bd = d;
            key = `m${k}`;
          }
        });
        keyOf.set(s.tile, key);
      }
      const full = `${key}:${s.kind}:${s.big ? 1 : 0}`;
      let g = groups.get(full);
      if (!g) groups.set(full, (g = []));
      g.push(s);
    }
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let deposit = 0;
    const hueOf = new Map<string, number>();
    for (const [full, list] of groups) {
      const [key, kindS, bigS] = full.split(':');
      const gem = kindS === '2';
      const big = bigS === '1';
      if (!hueOf.has(key)) hueOf.set(key, deposit++);
      const dep = hueOf.get(key)!;
      const base = list.map((s) => {
        e.set(s.tiltX, s.rotY, s.tiltZ, 'YXZ');
        q.setFromEuler(e);
        const y = surfaceHeight(m, s.x, s.z) - 0.015;
        return new THREE.Matrix4().compose(new THREE.Vector3(s.x, y, s.z), q, new THREE.Vector3(s.scale, s.scale, s.scale));
      });
      const geo = gem ? (big ? stand.gemBig : stand.gemSmall) : big ? stand.oreBig : stand.oreSmall;
      const mat = gem ? gemCrystalMat : big ? oreRubbleMat : oreNuggetMat;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      im.castShadow = shadows && big;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // each gem deposit has its own shade of violet; every crystal varies a little around it
      const h0 = 0.74 + (hash2(dep, 3, 77) - 0.5) * 0.12;
      const colors = gem
        ? list.map((s) => {
            const r = hash2(Math.floor(s.x * 31), Math.floor(s.z * 31), 78);
            return new THREE.Color().setHSL(h0 + (r - 0.5) * 0.07, 0.72, 0.6 + (r - 0.5) * 0.12);
          })
        : [];
      colors.forEach((c, k) => im.setColorAt(k, c));
      const b: Batch = { mesh: im, slots: list, base, tiles: [...new Set(list.map((s) => s.tile))], gem, big, variant: dep % 2, colors };
      this.rebound(b);
      im.name = 'resources';
      this.group.add(im);
      this.batches.push(b);
    }

    // night glow pools: one soft light disc per field tile (gems violet, ore a faint warm gold)
    const tiles: number[] = [];
    for (let i = 0; i < kinds.length; i++) if (kinds[i] && !m.blocked[i]) tiles.push(i);
    this.glowTiles = tiles;
    const pg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const pmat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      uniforms: { oreNight: NIGHT, fogTex: fog.uniforms.fogTex, fogSize: fog.uniforms.fogSize, fogEnabled: fog.uniforms.fogEnabled },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.glow = new THREE.InstancedMesh(pg, pmat, Math.max(1, tiles.length));
    this.glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, tiles.length) * 3), 3);
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3();
    tiles.forEach((i, k) => {
      const x = (i % m.w) + 0.5;
      const z = Math.floor(i / m.w) + 0.5;
      const gem = kinds[i] === 2;
      // lie on the slope of the ground
      nrm.set(surfaceHeight(m, x - 0.4, z) - surfaceHeight(m, x + 0.4, z), 0.8, surfaceHeight(m, x, z - 0.4) - surfaceHeight(m, x, z + 0.4)).normalize();
      const s = gem ? 1.9 : 1.3;
      this.glow.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(x, surfaceHeight(m, x, z) + 0.02, z), new THREE.Quaternion().setFromUnitVectors(up, nrm), new THREE.Vector3(s, 1, s)));
      const r = hash2(x | 0, z | 0, 79);
      this.glowBase.push(gem ? new THREE.Color().setHSL(0.75 + (r - 0.5) * 0.05, 0.85, 0.5).multiplyScalar(0.22) : new THREE.Color(0.5, 0.3, 0.08).multiplyScalar(0.12));
    });
    this.glow.count = tiles.length;
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 2;
    this.glow.visible = false;
    this.glow.name = 'resource-glow';
    this.group.add(this.glow);

    // survey stakes around each deposit + drilling rigs
    this.beacon = new THREE.MeshStandardMaterial({ color: 0xff8a20, emissive: 0xff7010, emissiveIntensity: 2, toneMapped: false });
    fog.apply(this.beacon);
    this.buildRigs(fog, quality !== 'low');
    this.update(true);

    // the Blender models: swap geometry and material in place once they are in
    void loadCrystals().then((a) => {
      if (!a) return;
      const gemMat = gemMaterial(a, fog, winter);
      const oreMat = oreMaterial(a, fog, winter);
      for (const b of this.batches) {
        const name = b.gem ? (b.big ? (b.variant ? 'gem_big_b' : 'gem_big_a') : 'gem_small') : b.big ? (b.variant ? 'ore_rock_b' : 'ore_rock_a') : 'ore_nugget';
        b.mesh.geometry = a.geos[name];
        b.mesh.material = b.gem ? gemMat : oreMat;
        this.rebound(b);
      }
      this.update(true);
      this.crystalsReady = true;
    });
  }

  /** Bounds from every slot at full size (before compaction), so culling stays valid as pieces vanish. */
  private rebound(b: Batch) {
    const n = b.mesh.count;
    b.mesh.count = b.base.length;
    b.base.forEach((mm, k) => b.mesh.setMatrixAt(k, mm));
    b.mesh.computeBoundingSphere();
    b.mesh.computeBoundingBox();
    b.mesh.count = n;
  }

  private buildRigs(fog: FogOfWar, shadows: boolean) {
    const m = this.map;
    const steel = new GeoBuilder();
    const conc = new GeoBuilder();
    const light = new GeoBuilder();
    const box = (b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color | number, rot?: THREE.Euler) => {
      const mm = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler()), new THREE.Vector3(1, 1, 1));
      b.add(new THREE.BoxGeometry(w, h, d).toNonIndexed(), mm, null, c);
    };
    /** Thin beam between two points. */
    const beam = (b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, t: number, col: THREE.Color | number) => {
      const len = a.distanceTo(c);
      const g = new THREE.BoxGeometry(t, len, t).toNonIndexed();
      const mid = a.clone().add(c).multiplyScalar(0.5);
      const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
      b.add(g, new THREE.Matrix4().compose(mid, qq, new THREE.Vector3(1, 1, 1)), null, col);
    };
    const yellow = new THREE.Color(0.85, 0.62, 0.12);
    const grey = new THREE.Color(0.5, 0.5, 0.5);
    const dark = new THREE.Color(0.18, 0.18, 0.19);
    // pad and spoil heap
    box(conc, 0.95, 0.06, 0.95, 0, 0.03, 0, new THREE.Color(0.6, 0.58, 0.54));
    // derrick: tapered lattice
    const H = 1.15;
    const b0 = 0.24;
    const b1 = 0.06;
    const corner = (sx: number, sz: number, t: number) => new THREE.Vector3(sx * (b0 + (b1 - b0) * t), 0.06 + H * t, sz * (b0 + (b1 - b0) * t));
    const cs: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [sx, sz] of cs) beam(steel, corner(sx, sz, 0), corner(sx, sz, 1), 0.03, yellow);
    for (let lv = 0; lv < 4; lv++) {
      const t0 = lv / 4;
      const t1 = (lv + 1) / 4;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = cs[k];
        const [bx, bz] = cs[(k + 1) % 4];
        beam(steel, corner(ax, az, t1), corner(bx, bz, t1), 0.018, yellow);
        beam(steel, corner(ax, az, t0), corner(bx, bz, t1), 0.012, yellow);
      }
    }
    box(steel, 0.18, 0.08, 0.18, 0, 0.06 + H + 0.04, 0, dark);
    // drill string and rotary table
    beam(steel, new THREE.Vector3(0, 0.06, 0), new THREE.Vector3(0, H, 0), 0.025, grey);
    box(steel, 0.2, 0.06, 0.2, 0, 0.12, 0, dark);
    // engine / pump house with exhaust
    box(steel, 0.34, 0.22, 0.24, 0.3, 0.17, -0.28, yellow);
    box(steel, 0.36, 0.03, 0.26, 0.3, 0.295, -0.28, dark);
    beam(steel, new THREE.Vector3(0.4, 0.28, -0.22), new THREE.Vector3(0.4, 0.5, -0.22), 0.035, dark);
    // conveyor to a small ore heap
    beam(steel, new THREE.Vector3(-0.15, 0.2, 0.15), new THREE.Vector3(-0.55, 0.05, 0.5), 0.07, grey);
    // tanks
    const tank = new THREE.CylinderGeometry(0.08, 0.08, 0.3, 10).rotateZ(Math.PI / 2).toNonIndexed();
    steel.add(tank, new THREE.Matrix4().makeTranslation(-0.28, 0.14, -0.3), null, new THREE.Color(0.62, 0.64, 0.66));
    // beacons
    light.add(new THREE.SphereGeometry(0.035, 8, 6).toNonIndexed(), new THREE.Matrix4().makeTranslation(0, 0.06 + H + 0.11, 0), null, 1);
    light.add(new THREE.SphereGeometry(0.025, 8, 6).toNonIndexed(), new THREE.Matrix4().makeTranslation(0.4, 0.52, -0.22), null, 1);

    const steelMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.55 }));
    const concMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    const n = m.oreMines.length;
    const parts: [THREE.BufferGeometry, THREE.Material, boolean][] = [
      [steel.build(), steelMat, shadows],
      [conc.build(), concMat, false],
      [light.build(), this.beacon, false],
    ];
    const stakes = new GeoBuilder();
    box(stakes, 0.025, 0.2, 0.025, 0, 0.1, 0, new THREE.Color(0.75, 0.7, 0.6));
    box(stakes, 0.03, 0.05, 0.03, 0, 0.19, 0, new THREE.Color(0.85, 0.12, 0.08));
    const stakeList: THREE.Matrix4[] = [];
    m.oreMines.forEach((mm, k) => {
      // radius of the deposit
      let r = 2;
      for (let y = mm.y - 6; y <= mm.y + 6; y++)
        for (let x = mm.x - 6; x <= mm.x + 6; x++) if (x >= 0 && y >= 0 && x < m.w && y < m.h && m.oreKind[y * m.w + x]) r = Math.max(r, Math.hypot(x - mm.x, y - mm.y));
      const cnt = Math.round(r * 2.2);
      for (let j = 0; j < cnt; j++) {
        const a = (j / cnt) * Math.PI * 2 + hash2(k, j, 3) * 0.4;
        const sx = mm.x + 0.5 + Math.cos(a) * (r + 1.1);
        const sz = mm.y + 0.5 + Math.sin(a) * (r + 1.1);
        const tx = Math.floor(sx);
        const tz = Math.floor(sz);
        if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) continue;
        const t = m.tiles[tz * m.w + tx];
        if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[tz * m.w + tx]) continue;
        stakeList.push(new THREE.Matrix4().compose(new THREE.Vector3(sx, surfaceHeight(m, sx, sz), sz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, a, 0)), new THREE.Vector3(1, 1, 1)));
      }
    });
    const st = new THREE.InstancedMesh(stakes.build(), concMat, Math.max(1, stakeList.length));
    stakeList.forEach((mm, i) => st.setMatrixAt(i, mm));
    st.count = stakeList.length;
    this.group.add(st);
    for (const [geo, mat, cast] of parts) {
      const im = new THREE.InstancedMesh(geo, mat, n);
      m.oreMines.forEach((mm, k) => {
        const x = mm.x + 0.5;
        const z = mm.y + 0.5;
        im.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(x, surfaceHeight(m, x, z) - 0.02, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(mm.x, mm.y, 5) * 6.28), new THREE.Vector3(1, 1, 1)));
      });
      im.castShadow = cast;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  private tmp = new THREE.Matrix4();
  private sc = new THREE.Matrix4();
  private col = new THREE.Color();

  /** Sync the pieces (and their night glow) with the simulation's ore amounts. */
  update(force = false) {
    const m = this.map;
    for (const b of this.batches) {
      if (!force && !b.tiles.some((t) => this.cache[t] !== m.ore[t])) continue;
      let n = 0;
      for (let k = 0; k < b.slots.length; k++) {
        const s = b.slots[k];
        const f = pieceScale(m.ore[s.tile], s.rank, s.kind === 2 ? PER_GEM : PER_ORE);
        if (f <= 0) continue;
        this.tmp.copy(b.base[k]).multiply(this.sc.makeScale(f, f, f));
        b.mesh.setMatrixAt(n, this.tmp);
        if (b.colors.length) b.mesh.setColorAt(n, b.colors[k]);
        n++;
      }
      b.mesh.count = n;
      b.mesh.visible = n > 0;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    }
    let glowDirty = force;
    for (const t of this.glowTiles) if (this.cache[t] !== m.ore[t]) glowDirty = true;
    if (glowDirty) {
      this.glowTiles.forEach((t, k) => {
        const f = pieceScale(m.ore[t], 0, PER_GEM);
        this.glow.setColorAt(k, this.col.copy(this.glowBase[k]).multiplyScalar(f));
      });
      this.glow.instanceColor!.needsUpdate = true;
    }
    for (const b of this.batches) for (const t of b.tiles) this.cache[t] = m.ore[t];
    for (const t of this.glowTiles) this.cache[t] = m.ore[t];
  }

  /** 0 = daylight .. 1 = full night: the crystals' inner light and the glow pools on the ground. */
  setNight(dark: number) {
    NIGHT.value = Math.max(0, Math.min(1, dark));
    this.glow.visible = NIGHT.value > 0.03;
  }

  animate(time: number) {
    this.beacon.emissiveIntensity = 1.2 + Math.max(0, Math.sin(time * 3.2)) * 2.2;
  }
}
