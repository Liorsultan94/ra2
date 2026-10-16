import * as THREE from 'three';
import { Blitter, fsMaterial } from './post/util';

/*
 * Baked ground ambient occlusion (GD5, the desert): computed once per map on
 * the GPU, then sampled by the ground shader on every quality level (phones
 * included; it costs one texture fetch per ground pixel).
 *
 *  1. Height capture: the whole map is drawn once from straight above with an
 *     orthographic camera into a depth texture: the ground's height field plus
 *     everything static standing on it (rocks, talus, palms, the town and the
 *     resort, canyon ledges). Cheap depth-only materials; alpha-tested leaves
 *     keep their cut-outs, wind-animated plants use their own depth material.
 *  2. Horizon AO: per texel, 12 directions x 9 steps out to ~6.5 tiles find the
 *     highest horizon (with a distance falloff); the cosine-weighted sky
 *     visibility is 1 - sin^2(horizon). Two scales: r = the whole reach (terrain
 *     folds, canyon floors, the foot of cliffs and buildings), g = only within
 *     ~1 tile (contact darkening around rocks, trunks and walls). Directions
 *     turn per texel on a 4x4 Bayer pattern and a 4x4 box resolves it.
 *  3. Read back once into a small RG8 DataTexture (survives a WebGL context
 *     loss: three re-uploads it).
 *
 * The ground applies r to its indirect (sky / environment) light and a part
 * of g to its direct light (Ground TERRAIN_AO, GROUND_AO define). Units and
 * player buildings move or appear: they keep their contact shadows
 * (contactshadow.ts) and, on high, the screen-space AO (post/ao.ts).
 */

/** Height capture: depth of the top-down orthographic view. */
const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 mapSize;
uniform vec2 texel;
uniform float top;
uniform float near;
uniform float far;
varying vec2 vUv;
const int DIRS = 12;
const float PI2 = 6.2831853;
float H( vec2 uv ) {
  // map uv (x / w, z / h) -> capture uv (the camera's screen up is -z)
  float d = texture2D( tDepth, vec2( uv.x, 1.0 - uv.y ) ).x;
  return top - ( near + d * ( far - near ) );
}
// 4x4 ordered dither 0..15/16
float bayer2( vec2 a ) {
  a = floor( a );
  return fract( dot( a, vec2( 0.5, a.y * 0.75 ) ) );
}
float bayer4( vec2 a ) {
  return bayer2( 0.5 * a ) * 0.25 + bayer2( a );
}
void main() {
  vec2 uv = vUv;
  float h0 = H( uv );
  float rot = bayer4( gl_FragCoord.xy ) * PI2 / float( DIRS );
  float occF = 0.0;
  float occN = 0.0;
  for ( int i = 0; i < DIRS; i++ ) {
    float a = rot + float( i ) * PI2 / float( DIRS );
    vec2 dir = vec2( cos( a ), sin( a ) ) / mapSize;
    float sF = 0.0;
    float sN = 0.0;
    float r = 0.18;
    for ( int j = 0; j < 9; j++ ) {
      float dh = H( uv + dir * r ) - h0;
      float s = max( dh, 0.0 ) * inversesqrt( dh * dh + r * r );
      sF = max( sF, s * ( 1.0 - smoothstep( 3.2, 6.6, r ) ) );
      sN = max( sN, s * ( 1.0 - smoothstep( 0.6, 1.25, r ) ) );
      r *= 1.46;
    }
    occF += sF * sF;
    occN += sN * sN;
  }
  gl_FragColor = vec4( 1.0 - occF / float( DIRS ), 1.0 - occN / float( DIRS ), 0.0, 1.0 );
}`;

/** 4x4 box: exactly one period of the direction pattern. */
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec2 s = vec2( 0.0 );
  for ( int j = 0; j < 4; j++ )
    for ( int i = 0; i < 4; i++ ) s += texture2D( tAO, vUv + ( vec2( float( i ), float( j ) ) - 1.5 ) * texel ).rg;
  gl_FragColor = vec4( s / 16.0, 0.0, 1.0 );
}`;

export class GroundAO {
  /** RG8: r = sky visibility (whole reach), g = contact (within ~1 tile); white until baked. */
  readonly texture: THREE.DataTexture;
  readonly size: number;
  baked = false;
  /** Bake time in ms (debug / report). */
  ms = 0;

  constructor(
    private w: number,
    private h: number,
    texelsPerTile: number,
  ) {
    this.size = Math.min(1024, Math.max(64, Math.round(Math.max(w, h) * texelsPerTile)));
    const n = this.size;
    const t = new THREE.DataTexture(new Uint8Array(n * n * 2).fill(255), n, n, THREE.RGFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.flipY = false;
    t.needsUpdate = true;
    this.texture = t;
  }

  /**
   * Draw `roots` from straight above and bake the AO. `skip` objects (water, grass blades, ...) and
   * transparent / depth-less materials stay out. The camera carries userData.waterReflection so the
   * scenery's camera hooks (LOD, culling, shadow switches) ignore it.
   */
  bake(r: THREE.WebGLRenderer, roots: THREE.Object3D[], skip: Set<THREE.Object3D>) {
    const t0 = performance.now();
    const n = this.size;
    const { w, h } = this;
    // height range of the capture
    const box = new THREE.Box3();
    for (const o of roots) box.expandByObject(o);
    const lo = Math.max(-30, Number.isFinite(box.min.y) ? box.min.y : -10) - 1;
    const hi = Math.min(80, Number.isFinite(box.max.y) ? box.max.y : 20) + 1;
    const top = hi + 1;
    const near = 0.5;
    const far = top - lo + near;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, near, far);
    cam.position.set(w / 2, top, h / 2);
    cam.up.set(0, 0, -1);
    cam.lookAt(w / 2, 0, h / 2);
    cam.updateMatrixWorld();
    cam.userData.waterReflection = true;
    cam.userData.groundAO = true;

    const rt = new THREE.WebGLRenderTarget(n, n, { depthBuffer: true, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    rt.depthTexture = new THREE.DepthTexture(n, n, THREE.UnsignedIntType);
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;

    // depth-only stand-in materials (restored afterwards)
    const plain = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const cut = new Map<THREE.Texture, THREE.MeshBasicMaterial>();
    const swapped: { m: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
    const hidden: THREE.Object3D[] = [];
    const stand = (m: THREE.Mesh, mat: THREE.Material): THREE.Material | null => {
      if (!mat.visible || !mat.depthWrite || (mat.transparent && !(mat.alphaTest > 0))) return null;
      if ((mat as THREE.ShaderMaterial).isShaderMaterial) return null;
      if (m.customDepthMaterial) return m.customDepthMaterial;
      const map = (mat as THREE.MeshStandardMaterial).alphaMap ?? (mat as THREE.MeshStandardMaterial).map;
      if (mat.alphaTest > 0 && map) {
        let c = cut.get(map);
        if (!c) cut.set(map, (c = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, map, alphaTest: mat.alphaTest })));
        return c;
      }
      return plain;
    };
    const none = new THREE.MeshBasicMaterial({ visible: false });
    for (const root of roots)
      root.traverse((o) => {
        if (skip.has(o)) {
          if (o.visible) {
            o.visible = false;
            hidden.push(o);
          }
          return;
        }
        const m = o as THREE.Mesh;
        if (!m.isMesh) {
          if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) {
            if (o.visible) {
              o.visible = false;
              hidden.push(o);
            }
          }
          return;
        }
        const src = m.material;
        const repl = Array.isArray(src) ? src.map((x) => stand(m, x) ?? none) : stand(m, src) ?? none;
        swapped.push({ m, mat: src });
        m.material = repl;
      });
    // (a hidden ancestor hides its subtree: skip-listed objects are simply invisible for the capture)
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.shadowMap.autoUpdate = false;
    r.autoClear = true;
    r.setClearColor(0x000000, 1);
    try {
      r.setRenderTarget(rt);
      r.clear(true, true, false);
      for (const root of roots) {
        r.autoClear = false;
        r.render(root, cam);
      }
    } finally {
      for (const s of swapped) s.m.material = s.mat;
      for (const o of hidden) o.visible = true;
      r.autoClear = prevAuto;
      r.shadowMap.autoUpdate = prevShadow;
    }

    // horizon AO, then the 4x4 resolve
    const blit = new Blitter();
    const aoRT = new THREE.WebGLRenderTarget(n, n, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    aoRT.texture.wrapS = aoRT.texture.wrapT = THREE.ClampToEdgeWrapping;
    const outRT = aoRT.clone();
    const tx = new THREE.Vector2(1 / n, 1 / n);
    const aoMat = fsMaterial(AO_FRAG, { tDepth: { value: rt.depthTexture }, mapSize: { value: new THREE.Vector2(w, h) }, texel: { value: tx }, top: { value: top }, near: { value: near }, far: { value: far } });
    const blurMat = fsMaterial(BLUR_FRAG, { tAO: { value: aoRT.texture }, texel: { value: tx } });
    const px = new Uint8Array(n * n * 4);
    try {
      blit.draw(r, aoMat, aoRT);
      blit.draw(r, blurMat, outRT);
      r.readRenderTargetPixels(outRT, 0, 0, n, n, px);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
    }
    const d = this.texture.image.data as Uint8Array;
    let sum = 0;
    for (let i = 0, j = 0; i < n * n; i++, j += 4) {
      d[i * 2] = px[j];
      d[i * 2 + 1] = px[j + 1];
      sum += px[j];
    }
    this.texture.needsUpdate = true;
    this.mean = sum / (n * n * 255);
    for (const x of [rt, aoRT, outRT]) x.dispose();
    rt.depthTexture.dispose();
    for (const x of [aoMat, blurMat, plain, none, ...cut.values()]) x.dispose();
    blit.dispose();
    this.baked = true;
    this.ms = performance.now() - t0;
  }

  /** Mean sky visibility of the bake (debug / tests: 1 = nothing occluded). */
  mean = 1;

  dispose() {
    this.texture.dispose();
  }
}
