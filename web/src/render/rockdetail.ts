import * as THREE from 'three';
import { assetBase, fetchBitmap } from './photoground';
import { ROCK_FACES } from './rockset';

/*
 * The desert's rock-face detail (GD4, render only): Blender-baked granite and sandstone (tools/blender/rockface.py,
 * public/tex/terrain/<size>/{dgranite,dsandst}_{a,n}.webp: albedo with the AO folded in; normal XY + height) for
 * the cliff relief (relief.ts), the canyon's ledges and blocks (canyon.ts, on the cliff material) and the rock kit
 * (rockkit.ts).
 *
 * Triplanar mapping, done properly:
 *  - each projection keeps its texture the right way round on the faces turned away from its axis (the u axis
 *    flips with the face's side, the tangent normal with it), so lighting on the detail agrees across projections;
 *  - the normal maps' Z is rebuilt from XY (the B channel holds height, not Z);
 *  - the weights are height-blended (Golus): where two projections meet (a face turned ~45 degrees) the higher
 *    relief of either map wins pixel by pixel, a crisp, rocky transition, instead of a wide cross-fade of two
 *    unrelated images (the ghosted seam the old pow(|n|, 4) blend showed on 45-degree faces).
 */

export type RockKind = 'granite' | 'sandstone';

interface Pair {
  a: { value: THREE.Texture };
  n: { value: THREE.Texture };
}

function placeholder(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const l2s = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
const KEY: Record<RockKind, 'dgranite' | 'dsandst'> = { granite: 'dgranite', sandstone: 'dsandst' };
const sets = new Map<string, Pair>();

/**
 * The detail maps of a rock at a texture size (shared uniform objects: the cliffs, the canyon and the kit all
 * point at them). They start as the rock's mean colour / a flat normal and switch when the WebPs arrive.
 */
export function rockDetail(kind: RockKind, size: 512 | 1024): Pair {
  const key = `${kind}-${size}`;
  let p = sets.get(key);
  if (p) return p;
  const m = ROCK_FACES[KEY[kind]];
  p = { a: { value: placeholder(l2s(m.mean[0]), l2s(m.mean[1]), l2s(m.mean[2]), true) }, n: { value: placeholder(128, 128, 128, false) } };
  sets.set(key, p);
  const pair = p;
  if (typeof createImageBitmap !== 'undefined') {
    const dir = `${assetBase()}tex/terrain/${size}/`;
    const load = (ch: 'a' | 'n') =>
      fetchBitmap(`${dir}${KEY[kind]}_${ch}.webp`).then((bm) => {
        const t = new THREE.Texture(bm);
        t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = ch === 'a' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = 4;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.needsUpdate = true;
        return t;
      });
    void Promise.all([load('a'), load('n')])
      .then(([a, n]) => {
        pair.a.value = a;
        pair.n.value = n;
      })
      .catch((e) => console.warn('[rockdetail] rock faces unavailable', kind, e));
  }
  return pair;
}

/** Mean albedo (linear) of a rock's detail map: shaders divide by it to keep their own colour and take the detail. */
export function rockMean(kind: RockKind): THREE.Vector3 {
  const m = ROCK_FACES[KEY[kind]].mean;
  return new THREE.Vector3(m[0], m[1], m[2]);
}

/**
 * GLSL: `rdTri( A, N, p, n, k, out alb, out wn, out h )` samples a rock's maps at world position p (scaled by k:
 * repeats per world unit) on a face with world normal n (normalised): triplanar albedo (linear), the detailed world
 * normal and the blended height. `rdTriGrad` is the same with explicit derivatives (for use inside branches).
 */
export const ROCK_DETAIL_GLSL = /* glsl */ `
  // tangent normal from the map: XY (+Y = image up = against the texture's v), Z rebuilt
  vec3 rdTn( vec4 t ) {
    vec2 xy = ( t.rg * 2.0 - 1.0 ) * vec2( 1.0, -1.0 );
    return vec3( xy, sqrt( max( 0.0, 1.0 - dot( xy, xy ) ) ) );
  }
  // height-blended triplanar weights: base weights from the normal, sharpened by each projection's height
  vec3 rdWeights( vec3 n, vec3 hgt ) {
    vec3 b = max( abs( n ) - 0.18, 0.0 );
    b /= max( 1e-4, dot( b, vec3( 1.0 ) ) );
    vec3 h = hgt * 0.9 + b * 2.6;
    float hs = max( max( h.x, h.y ), h.z ) - 0.32;
    vec3 w = max( h - hs, 0.0 );
    return w / max( 1e-4, dot( w, vec3( 1.0 ) ) );
  }
  // AS / NS on the side projections (X, Z: scale kS), AT / NT on the top one (Y: scale kT), tinted tS / tT;
  // w: the blend weights used
  void rdTri3( sampler2D AS, sampler2D NS, sampler2D AT, sampler2D NT, vec3 p, vec3 n, float kS, float kT, vec3 tS, vec3 tT, vec3 dpx, vec3 dpy, out vec3 alb, out vec3 wn, out float h, out vec3 w ) {
    vec3 sg = sign( n + 1e-5 );
    vec3 q = p * kS;
    vec3 gx = dpx * kS;
    vec3 gy = dpy * kS;
    float kt = kT / kS;
    // u flips with the face's side (no mirrored detail on the faces turned away from an axis)
    vec2 uX = vec2( q.z * sg.x, q.y );
    vec2 uY = vec2( q.x * sg.y, q.z ) * kt + 0.41;
    vec2 uZ = vec2( -q.x * sg.z, q.y ) + 0.73;
    vec2 gXx = vec2( gx.z * sg.x, gx.y ), gXy = vec2( gy.z * sg.x, gy.y );
    vec2 gYx = vec2( gx.x * sg.y, gx.z ) * kt, gYy = vec2( gy.x * sg.y, gy.z ) * kt;
    vec2 gZx = vec2( -gx.x * sg.z, gx.y ), gZy = vec2( -gy.x * sg.z, gy.y );
    vec4 nX = textureGrad( NS, uX, gXx, gXy );
    vec4 nY = textureGrad( NT, uY, gYx, gYy );
    vec4 nZ = textureGrad( NS, uZ, gZx, gZy );
    w = rdWeights( n, vec3( nX.b, nY.b, nZ.b ) );
    alb = textureGrad( AS, uX, gXx, gXy ).rgb * tS * w.x + textureGrad( AT, uY, gYx, gYy ).rgb * tT * w.y + textureGrad( AS, uZ, gZx, gZy ).rgb * tS * w.z;
    h = nX.b * w.x + nY.b * w.y + nZ.b * w.z;
    // whiteout blend, the tangent X following the u flip
    vec3 tX = rdTn( nX );
    vec3 tY = rdTn( nY );
    vec3 tZ = rdTn( nZ );
    tX.x *= sg.x;
    tY.x *= sg.y;
    tZ.x *= -sg.z;
    vec3 wX = vec3( abs( tX.z ) * n.x, tX.y + n.y, tX.x + n.z );
    vec3 wY = vec3( tY.x + n.x, abs( tY.z ) * n.y, tY.y + n.z );
    vec3 wZ = vec3( tZ.x + n.x, tZ.y + n.y, abs( tZ.z ) * n.z );
    wn = normalize( wX * w.x + wY * w.y + wZ * w.z );
  }
  void rdTriGrad( sampler2D A, sampler2D N, vec3 p, vec3 n, float k, vec3 dpx, vec3 dpy, out vec3 alb, out vec3 wn, out float h ) {
    vec3 w;
    rdTri3( A, N, A, N, p, n, k, k, vec3( 1.0 ), vec3( 1.0 ), dpx, dpy, alb, wn, h, w );
  }
  void rdTri( sampler2D A, sampler2D N, vec3 p, vec3 n, float k, out vec3 alb, out vec3 wn, out float h ) {
    rdTriGrad( A, N, p, n, k, dFdx( p ), dFdy( p ), alb, wn, h );
  }
`;
