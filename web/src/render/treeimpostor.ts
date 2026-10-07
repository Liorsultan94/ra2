import * as THREE from 'three';
import type { FogOfWar } from './fog';
import { ALPHA_MIP, WIND_VERT, treeWind } from './trees';
import { windTime } from './treekinds';

/*
 * Materials of the Blender-built trees (tools/blender/trees.py, loaded by treeassets.ts):
 *
 *  - hero: the close-range model (trunk and limbs as tubes, foliage as leaf-cluster
 *    cards from the baked card atlas, canopy normals, ray-cast vertex AO), lit like
 *    the procedural trees (wrap diffuse, translucency, wind, alpha-tested shadows);
 *  - impostor: mid / far range, one camera-facing quad per tree drawing its
 *    multi-angle atlas (12 azimuths x 3 elevations; the four nearest frames are
 *    blended, each sampled where the view ray meets that frame's own plane so the
 *    blend doesn't ghost). The atlas carries albedo + coverage and an octahedral
 *    object-space normal + depth + leaf translucency, so the impostor is lit per
 *    pixel by the game's sun / moon / lamps / sky exactly like the full model
 *    (shadows received, leaves glowing against a low sun, snow and wet weather on
 *    the upward normals). Its shadow pass picks the frames seen from the sun.
 *
 * The two crossfade per tree with a screen-space dither over a band of projected
 * size (pixels per world unit, from the main camera; TREE_LOD): the hero where the
 * impostor would be magnified, the impostor once a frame texel is no bigger than a
 * screen pixel. The CPU split (CulledInstances.attachFar + lodSplit) hands each
 * mesh only the cells it may draw.
 */

/** xyz: main camera position, w: K = px per world unit at distance 1 (perspective) or -px per unit (orthographic). */
export const TREE_LOD = { value: new THREE.Vector4(0, 0, 0, 1000) };
let bufH = 800;
let lastK = 0;
const lodCis: { version: number }[] = [];
const _v2 = new THREE.Vector2();

/** Bias on the hero / impostor switch (?treelod=1.3: hero trees further out). */
export const LOD_BIAS = (() => {
  try {
    const m = typeof location !== 'undefined' ? /[?&]treelod=([\d.]+)/.exec(location.search) : null;
    return m ? Math.max(0.2, Math.min(5, +m[1])) : 1;
  } catch {
    return 1;
  }
})();

/** Track a culled store whose split depends on the LOD scale (re-culled when the viewport changes). */
export function trackLod(ci: { version: number }) {
  lodCis.push(ci);
}

/** The drawing buffer height (px): called from the trees' onBeforeRender. */
export function noteTreeRenderer(r: THREE.WebGLRenderer) {
  r.getDrawingBufferSize(_v2);
  if (_v2.y > 0) bufH = _v2.y;
}

/** Per frame (main camera only): the LOD camera and scale. */
export function updateTreeLod(cam: THREE.Camera) {
  const p11 = cam.projectionMatrix.elements[5];
  const K = (bufH * p11) / 2;
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera) TREE_LOD.value.set(cam.position.x, cam.position.y, cam.position.z, -K);
  else TREE_LOD.value.set(cam.position.x, cam.position.y, cam.position.z, K);
  if (Math.abs(K - lastK) > lastK * 0.02) {
    lastK = K;
    for (const ci of lodCis) ci.version++;
  }
}

/** Per kind: the switch, in px per world unit: hero above `hi`, impostor below `lo`. */
export function lodBand(framePx: number, Rf: number): [number, number] {
  const t = (framePx / (2 * Rf)) * LOD_BIAS;
  return [t * 1.3, t * 1.02];
}

/**
 * CPU side of the crossfade for one 4-tile cell (centre x, z): 1 = only the hero can show,
 * 2 = only the impostor, 3 = both (the band, the camera lag and the cell's extent).
 */
export function lodSplit(x: number, z: number, cell: number, band: [number, number]): number {
  const L = TREE_LOD.value;
  if (L.w < 0) {
    const ppu = -L.w;
    return (ppu > band[1] * 0.97 ? 1 : 0) | (ppu < band[0] * 1.03 ? 2 : 0) || 1;
  }
  const dy = L.y - 0.8;
  const d = Math.sqrt((x - L.x) ** 2 + (z - L.z) ** 2 + dy * dy);
  const r = cell * 0.72 + 1.6 + 2.4;
  const ppuMax = L.w / Math.max(0.3, d - r);
  const ppuMin = L.w / (d + r);
  return (ppuMax > band[1] ? 1 : 0) | (ppuMin < band[0] ? 2 : 0) || 1;
}

const LOD_PARS = /* glsl */ `
uniform vec4 treeLod;
uniform vec3 lodPpu;
float treeFade( vec3 wc ) {
  float ppu = treeLod.w > 0.0 ? treeLod.w / max( 0.2, distance( treeLod.xyz, wc ) ) : - treeLod.w;
  return clamp( ( lodPpu.x - ppu ) / max( 1e-3, lodPpu.x - lodPpu.y ), 0.0, 1.0 );
}
`;
const DITHER = /* glsl */ `
float treeDither() {
  return fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

/**
 * Leaves: wrap lighting and sun-through-the-leaves translucency, stronger when the sun
 * (or moon) is low: at dawn and dusk the crowns glow where the light comes through them.
 */
const FOLIAGE_LIGHT2 = /* glsl */ `
#undef RE_Direct
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float tnl = dot( geometryNormal, directLight.direction );
  float twrap = clamp( ( tnl + 0.55 ) / 1.55, 0.0, 1.0 ) - clamp( tnl, 0.0, 1.0 );
  float tback = pow( clamp( dot( - geometryViewDir, directLight.direction ), 0.0, 1.0 ), 3.0 );
  float tthru = clamp( - tnl, 0.0, 1.0 );
  // low sun: 1 at the horizon .. 0 from ~35 degrees up (world up in view space = viewMatrix[ 1 ])
  float tlow = 1.0 - smoothstep( 0.08, 0.58, dot( directLight.direction, normalize( viewMatrix[ 1 ].xyz ) ) );
  vec3 tglow = directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( 1.05, 1.1, 0.75 );
  reflectedLight.directDiffuse += tglow * ( twrap * 0.55 * fLeafAmt + fTransl * ( tback * ( 1.15 + 0.9 * tlow ) + tthru * ( 0.4 + 0.75 * tlow ) ) );
}
#define RE_Direct RE_Direct_Foliage
`;

/** Bark keeps the tint's brightness only (charring); leaves take its colour. Base tint brightness ~0.5. */
const TINT_GLSL = /* glsl */ `
vec3 treeTintOf( vec3 tint, float leafK ) {
  float tlum = dot( tint, vec3( 0.2126, 0.7152, 0.0722 ) );
  return mix( vec3( clamp( tlum * 2.4, 0.0, 1.0 ) ), tint * 2.0, leafK );
}
`;

const OCT_GLSL = /* glsl */ `
vec3 octDecode( vec2 e ) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3( e, 1.0 - abs( e.x ) - abs( e.y ) );
  if ( n.z < 0.0 ) n.xy = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
  return normalize( n );
}
`;

export interface KindMeta {
  H: number;
  Rf: number;
  Cx: number;
  Cy: number;
  Cz: number;
  flexK: number;
}

export interface FrameLayout {
  grid: number;
  az: number;
  els: number[];
}

// ------------------------------------------------------------------ hero

export interface TreeMatPair {
  mat: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
}

/** Hero material of one kind (programs are shared between kinds; only the uniforms differ). */
export function heroMaterial(fog: FogOfWar, quality: 'low' | 'medium' | 'high', cardA: THREE.Texture, cardN: THREE.Texture, cellPx: number, cols: number, meta: KindMeta, band: [number, number]): TreeMatPair {
  const px = cellPx * cols;
  const lodPpu = { value: new THREE.Vector3(band[0], band[1], meta.H * 0.5) };
  const mat = new THREE.MeshStandardMaterial({
    map: cardA,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.74,
    metalness: 0,
    alphaToCoverage: quality !== 'low',
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windTime;
    shader.uniforms.treeWind = treeWind;
    shader.uniforms.treeLod = TREE_LOD;
    shader.uniforms.lodPpu = lodPpu;
    shader.uniforms.cardN = { value: cardN };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float windTime;\nuniform vec3 treeWind;\nattribute float flex;\nattribute float leaf;\nvarying float vLeaf;\nvarying float vTreeFade;\n${LOD_PARS}\n${TINT_GLSL}`)
      .replace(
        '#include <color_vertex>',
        `vColor = vec4( 1.0 );
        #ifdef USE_COLOR
          vColor.rgb *= color.rgb;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= treeTintOf( instanceColor.rgb, clamp( leaf, 0.0, 1.0 ) );
        #endif
        vLeaf = leaf;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${WIND_VERT}
        #ifdef USE_INSTANCING
          vTreeFade = treeFade( ( instanceMatrix * vec4( 0.0, lodPpu.z, 0.0, 1.0 ) ).xyz );
          // toppled trees (envdamage.ts) always show the full model
          if ( instanceMatrix[ 1 ].y < 0.97 * length( instanceMatrix[ 1 ].xyz ) ) vTreeFade = 0.0;
        #else
          vTreeFade = 0.0;
        #endif`,
      )
      .replace('#include <project_vertex>', `#include <project_vertex>\nif ( vTreeFade > 0.999 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D cardN;\nvarying float vLeaf;\nvarying float vTreeFade;\nfloat fTransl = 0.0;\nfloat fLeafAmt = 0.0;\n${DITHER}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif ( treeDither() < vTreeFade ) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${ALPHA_MIP(px)}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${FOLIAGE_LIGHT2}`)
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        // canopy normals on both faces of the cards, the cluster's own leaf relief on top (half strength)
        normal = normalize( vNormal );
        vec4 cardNrm = texture2D( cardN, vMapUv );
        {
          vec3 q0 = dFdx( - vViewPosition );
          vec3 q1 = dFdy( - vViewPosition );
          vec2 st0 = dFdx( vMapUv );
          vec2 st1 = dFdy( vMapUv );
          vec3 q1perp = cross( q1, normal );
          vec3 q0perp = cross( normal, q0 );
          vec3 T = q1perp * st0.x + q0perp * st1.x;
          vec3 B = q1perp * st0.y + q0perp * st1.y;
          float det = max( dot( T, T ), dot( B, B ) );
          float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
          vec3 mapN = cardNrm.xyz * 2.0 - 1.0;
          mapN.xy *= 0.5 * clamp( vLeaf, 0.0, 1.0 );
          // (card v runs top-down in the atlas)
          normal = normalize( T * ( mapN.x * scale ) - B * ( mapN.y * scale ) + normal * mapN.z );
        }
        fLeafAmt = clamp( vLeaf, 0.0, 1.0 );
        fTransl = fLeafAmt * cardNrm.a * smoothstep( 0.2, 0.85, dot( vColor.rgb, vec3( 0.33 ) ) );`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'trees-hero-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: cardA, alphaTest: 0.42, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windTime;
    shader.uniforms.treeWind = treeWind;
    shader.uniforms.treeLod = TREE_LOD;
    shader.uniforms.lodPpu = lodPpu;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float windTime;\nuniform vec3 treeWind;\nattribute float flex;\nattribute float leaf;\nvarying float vTreeFade;\n${LOD_PARS}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${WIND_VERT}
        #ifdef USE_INSTANCING
          vTreeFade = treeFade( ( instanceMatrix * vec4( 0.0, lodPpu.z, 0.0, 1.0 ) ).xyz );
          if ( instanceMatrix[ 1 ].y < 0.97 * length( instanceMatrix[ 1 ].xyz ) ) vTreeFade = 0.0;
        #else
          vTreeFade = 0.0;
        #endif`,
      )
      .replace('#include <project_vertex>', `#include <project_vertex>\nif ( vTreeFade > 0.999 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vTreeFade;\n${DITHER}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif ( treeDither() < vTreeFade ) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${ALPHA_MIP(px)}`);
  };
  depth.customProgramCacheKey = () => 'trees-hero-depth-v1';
  return { mat, depth };
}

// ------------------------------------------------------------------ impostor

/** Shared vertex code: the camera-facing quad, the four frames and their per-frame UVs. */
const IMP_VERT = /* glsl */ `
{
  mat3 tR = mat3( normalize( instanceMatrix[ 0 ].xyz ), normalize( instanceMatrix[ 1 ].xyz ), normalize( instanceMatrix[ 2 ].xyz ) );
  vec3 wC = ( modelMatrix * instanceMatrix * vec4( impC, 1.0 ) ).xyz;
  vec3 vw = isOrthographic ? vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] ) : cameraPosition - wC;
  vec3 v = transpose( tR ) * normalize( vw );
  v.y = clamp( v.y, -0.3, 0.985 );
  v = normalize( v );
  float az = atan( v.z, v.x );
  if ( az < 0.0 ) az += 6.28318530718;
  float fa = az / 6.28318530718 * IMP_AZ;
  float a0 = floor( fa );
  float wa = fa - a0;
  float a1 = mod( a0 + 1.0, IMP_AZ );
  a0 = mod( a0, IMP_AZ );
  float fe = clamp( ( asin( v.y ) - impEl.x ) / impEl.y, 0.0, IMP_EL - 1.0 );
  float e0 = min( floor( fe ), IMP_EL - 2.0 );
  float we = fe - e0;
  vec3 f = - v;
  vec3 r = normalize( cross( f, vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 u = cross( r, f );
  vec3 P = impC + ( r * position.x + u * position.y ) * impRf;
  vImpA = vec4( impProj( P, f, impDir( a0, e0 ) ), impProj( P, f, impDir( a1, e0 ) ) );
  vImpB = vec4( impProj( P, f, impDir( a0, e0 + 1.0 ) ), impProj( P, f, impDir( a1, e0 + 1.0 ) ) );
  vImpW = vec4( wa, we, a0 + e0 * IMP_AZ, a1 + e0 * IMP_AZ );
  transformed = P;
  // wind: the crown leans and sways like the full model's
  float leaf = 0.0;
  float flex = impWind * pow( max( 0.0, P.y ) / max( 0.05, impC.y * 2.0 ), 2.0 );
  ${WIND_VERT}
  vTreeFade = treeFade( wC );
  // toppled trees: the full model only
  if ( instanceMatrix[ 1 ].y < 0.97 * length( instanceMatrix[ 1 ].xyz ) ) vTreeFade = 0.0;
  #ifdef IMP_LIT
    vImpN0 = normalize( ( viewMatrix * modelMatrix * vec4( tR[ 0 ], 0.0 ) ).xyz );
    vImpN1 = normalize( ( viewMatrix * modelMatrix * vec4( tR[ 1 ], 0.0 ) ).xyz );
    vImpN2 = normalize( ( viewMatrix * modelMatrix * vec4( tR[ 2 ], 0.0 ) ).xyz );
  #endif
}
`;

const IMP_VERT_PARS = /* glsl */ `
uniform float windTime;
uniform vec3 treeWind;
uniform vec3 impC;
uniform float impRf;
uniform vec2 impEl;
uniform float impWind;
varying vec4 vImpA;
varying vec4 vImpB;
varying vec4 vImpW;
varying float vTreeFade;
#ifdef IMP_LIT
  varying vec3 vImpN0;
  varying vec3 vImpN1;
  varying vec3 vImpN2;
#endif
${LOD_PARS}
vec3 impDir( float a, float e ) {
  float az = a * 6.28318530718 / IMP_AZ;
  float el = impEl.x + e * impEl.y;
  return vec3( cos( el ) * cos( az ), sin( el ), cos( el ) * sin( az ) );
}
vec2 impProj( vec3 P, vec3 f, vec3 dk ) {
  vec3 fk = - dk;
  vec3 rk = normalize( cross( fk, vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 uk = cross( rk, fk );
  float t = dot( impC - P, dk ) / min( dot( f, dk ), -0.05 );
  vec3 Q = P + f * t - impC;
  return vec2( dot( Q, rk ), dot( Q, uk ) ) / impRf;
}
`;

const IMP_FRAG_PARS = /* glsl */ `
uniform sampler2D impA;
uniform sampler2D impN;
varying vec4 vImpA;
varying vec4 vImpB;
varying vec4 vImpW;
varying float vTreeFade;
#ifdef IMP_LIT
  varying vec3 vImpN0;
  varying vec3 vImpN1;
  varying vec3 vImpN2;
#endif
${DITHER}
${OCT_GLSL}
vec2 impUv( float k, vec2 q ) {
  k = floor( k + 0.5 );
  vec2 c = vec2( mod( k, IMP_GRID ), floor( k / IMP_GRID ) );
  vec2 l = clamp( q * 0.5 + 0.5, 0.004, 0.996 );
  return ( c + vec2( l.x, 1.0 - l.y ) ) / IMP_GRID;
}
`;

/** Fragment: blend the four frames; fills impAlb, impAlpha (and the lit extras). */
const IMP_SAMPLE = (lit: boolean, px: number) => /* glsl */ `
  float iwa = vImpW.x;
  float iwe = vImpW.y;
  vec4 iw = vec4( ( 1.0 - iwa ) * ( 1.0 - iwe ), iwa * ( 1.0 - iwe ), ( 1.0 - iwa ) * iwe, iwa * iwe );
  vec2 iuv0 = impUv( vImpW.z, vImpA.xy );
  vec2 iuv1 = impUv( vImpW.w, vImpA.zw );
  vec2 iuv2 = impUv( vImpW.z + IMP_AZ, vImpB.xy );
  vec2 iuv3 = impUv( vImpW.w + IMP_AZ, vImpB.zw );
  vec4 ia0 = texture2D( impA, iuv0 );
  vec4 ia1 = texture2D( impA, iuv1 );
  vec4 ia2 = texture2D( impA, iuv2 );
  vec4 ia3 = texture2D( impA, iuv3 );
  vec4 iwc = iw * vec4( ia0.a, ia1.a, ia2.a, ia3.a );
  float impAlpha = iwc.x + iwc.y + iwc.z + iwc.w;
  float iinv = 1.0 / max( impAlpha, 1e-4 );
  vec3 impAlb = ( ia0.rgb * iwc.x + ia1.rgb * iwc.y + ia2.rgb * iwc.z + ia3.rgb * iwc.w ) * iinv;
  {
    // keep the crowns from thinning out in the small mipmaps
    vec2 tdx = dFdx( iuv0 * ${px.toFixed(1)} );
    vec2 tdy = dFdy( iuv0 * ${px.toFixed(1)} );
    float tmip = max( 0.0, 0.5 * log2( max( dot( tdx, tdx ), dot( tdy, tdy ) ) ) );
    impAlpha *= 1.0 + tmip * 0.3;
  }
  ${
    lit
      ? `vec4 in0 = texture2D( impN, iuv0 );
  vec4 in1 = texture2D( impN, iuv1 );
  vec4 in2 = texture2D( impN, iuv2 );
  vec4 in3 = texture2D( impN, iuv3 );
  vec3 impNrm = normalize( octDecode( in0.xy ) * iwc.x + octDecode( in1.xy ) * iwc.y + octDecode( in2.xy ) * iwc.z + octDecode( in3.xy ) * iwc.w + vec3( 0.0, 1e-4, 0.0 ) );
  float impTr = ( in0.a * iwc.x + in1.a * iwc.y + in2.a * iwc.z + in3.a * iwc.w ) * iinv;`
      : ''
  }
`;

let quadGeo: THREE.BufferGeometry | null = null;
/** The impostor quad (corners at +-1). */
export function impostorQuad(): THREE.BufferGeometry {
  return (quadGeo ??= new THREE.PlaneGeometry(2, 2));
}

/** Impostor material (+ its shadow depth material) of one kind. `band` null: impostor always (outskirts). */
export function impostorMaterial(fog: FogOfWar | null, quality: 'low' | 'medium' | 'high', texA: THREE.Texture, texN: THREE.Texture, framePx: number, layout: FrameLayout, meta: KindMeta, band: [number, number] | null): TreeMatPair {
  const els = layout.els.map((e) => (e * Math.PI) / 180);
  const defs = { IMP_AZ: layout.az.toFixed(1), IMP_EL: els.length.toFixed(1), IMP_GRID: layout.grid.toFixed(1) };
  const u = {
    impA: { value: texA },
    impN: { value: texN },
    impC: { value: new THREE.Vector3(meta.Cx, meta.Cy, meta.Cz) },
    impRf: { value: meta.Rf },
    impEl: { value: new THREE.Vector2(els[0], els[1] - els[0]) },
    impWind: { value: meta.flexK },
    lodPpu: { value: band ? new THREE.Vector3(band[0], band[1], meta.Cy) : new THREE.Vector3(1e6, 1e6 - 1, meta.Cy) },
  };
  const px = framePx * layout.grid;
  const mat = new THREE.MeshStandardMaterial({ alphaTest: 0.5, side: THREE.FrontSide, vertexColors: false, roughness: 0.78, metalness: 0, alphaToCoverage: quality !== 'low' });
  mat.defines = { ...defs, IMP_LIT: '' };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { windTime, treeWind, treeLod: TREE_LOD });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMP_VERT_PARS}\nvarying vec3 vImpTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${IMP_VERT}`)
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vImpTint = instanceColor.rgb;
        #else
          vImpTint = vec3( 0.5 );
        #endif`,
      )
      .replace('#include <project_vertex>', `#include <project_vertex>\nif ( vTreeFade < 0.001 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${IMP_FRAG_PARS}\n${TINT_GLSL}\nvarying vec3 vImpTint;\nfloat fTransl = 0.0;\nfloat fLeafAmt = 0.0;\nvec3 impNrmG = vec3( 0.0, 1.0, 0.0 );`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif ( treeDither() >= vTreeFade ) discard;`)
      .replace(
        '#include <map_fragment>',
        `${IMP_SAMPLE(true, framePx * layout.grid)}
        // leaves take the tree's tint, bark and snow only its brightness (charring)
        float ileaf = smoothstep( 0.02, 0.1, impTr );
        diffuseColor.rgb *= impAlb * treeTintOf( vImpTint, ileaf );
        diffuseColor.a = impAlpha;
        impNrmG = impNrm;
        fLeafAmt = ileaf;
        fTransl = impTr;`,
      )
      .replace('#include <color_fragment>', '')
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${FOLIAGE_LIGHT2}`)
      .replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = 1.0;
        vec3 normal = normalize( mat3( vImpN0, vImpN1, vImpN2 ) * impNrmG );
        vec3 nonPerturbedNormal = normal;`,
      );
  };
  if (fog) fog.apply(mat);
  mat.customProgramCacheKey = () => 'trees-imp-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5, side: THREE.DoubleSide });
  depth.defines = { ...defs };
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { windTime, treeWind, treeLod: TREE_LOD });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMP_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${IMP_VERT}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\nif ( vTreeFade < 0.001 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${IMP_FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif ( treeDither() >= vTreeFade ) discard;`)
      .replace('#include <map_fragment>', `${IMP_SAMPLE(false, px)}\ndiffuseColor.a = impAlpha;`);
  };
  depth.customProgramCacheKey = () => 'trees-imp-depth-v1';
  return { mat, depth };
}
