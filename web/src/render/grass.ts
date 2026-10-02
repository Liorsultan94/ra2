import * as THREE from 'three';
import { groundHeight, type GameMap } from '../sim/map';
import { buildingDef, unitDef } from '../sim/defs';
import type { Entity } from '../sim/types';
import type { FogOfWar } from './fog';
import type { Ground } from './ground';
import { GRASS_GLSL } from './grasstex';
import { windTime } from './vegetation';

/*
 * 3D grass: GPU-instanced tufts of blades on a camera-following grid.
 *
 * One draw call. The instance grid is toroidal: instance i always owns the
 * world cells congruent to it modulo the grid size, so moving the camera never
 * re-uploads anything - the vertex shader derives each tuft's world cell from
 * gl_InstanceID and the patch centre, hashes a position, and reads density,
 * height and colour from the ground's control maps (the very maps the ground
 * shader colours the turf with). Blades sway in the shared wind clock, bend
 * away from vehicles and lie flat in their trail (a small "trample" texture,
 * stamped on the CPU from the unit positions and decaying in the shader), and
 * shrink away towards the edge of the patch and at far zoom.
 */

interface GrassCfg {
  /** Grid cell (tiles); one tuft per cell. */
  cell: number;
  /** Cells per side. */
  grid: number;
  /** Blades per tuft. */
  blades: number;
  /** Segments per blade (1 = one triangle). */
  segs: number;
  /** View span (camera height) where the blades start / finish fading out. */
  fadeFrom: number;
  fadeTo: number;
}

const CFG: Record<'medium' | 'high', GrassCfg> = {
  // medium: 64^2 tufts x 4 one-triangle blades = 49k vertices; high: 104^2 x 4 x 5 = 216k
  medium: { cell: 0.26, grid: 64, blades: 4, segs: 1, fadeFrom: 12.5, fadeTo: 16 },
  high: { cell: 0.17, grid: 104, blades: 4, segs: 2, fadeFrom: 15, fadeTo: 19.5 },
};

/** Trample map resolution (pixels per tile). */
const TRES = 4;

const GRASS_VERT_PARS = /* glsl */ `
${GRASS_GLSL}
uniform float gCell;
uniform float gGrid;
uniform vec2 gCenter;
uniform vec3 gFade;
uniform float gWidth;
uniform vec2 terrMapSize;
uniform sampler2D gHeightTex;
uniform sampler2D bladeTex;
uniform sampler2D ctlTex;
uniform sampler2D tintTex;
uniform sampler2D gNoise;
uniform sampler2D trampleTex;
uniform float gNow8;
uniform float windTime;
uniform float wxSnow;
varying vec3 vGrassC;
vec3 gP;
vec3 gN;
vec2 gHash2( vec2 p ) {
  p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
  return fract( sin( p ) * 43758.5453 );
}
void grassBlade() {
  float fi = float( gl_InstanceID );
  vec2 idx = vec2( mod( fi, gGrid ), floor( fi / gGrid ) );
  vec2 cc = floor( gCenter / gCell );
  // the world cell this instance owns: congruent to idx (mod grid), within half a grid of the centre
  vec2 wc = idx + gGrid * ceil( ( cc - gGrid * 0.5 - idx ) / gGrid );
  vec2 hh = gHash2( wc );
  vec2 root = ( wc + 0.1 + hh * 0.8 ) * gCell;
  float bi = position.x;
  float t = position.y;
  float side = position.z;
  vec2 bh = gHash2( wc * 1.37 + vec2( bi * 7.13, bi * 3.71 ) );
  float ang = bh.y * 6.2832 + bi * 2.39996;
  float spread = ( 0.15 + 0.85 * fract( bh.x * 13.7 ) ) * gCell * 0.38;
  vec2 off = vec2( cos( ang ), sin( ang ) ) * spread;
  vec2 base = root + off;
  vec2 uv = base / terrMapSize;
  float inside = step( 0.0, base.x ) * step( 0.0, base.y ) * step( base.x, terrMapSize.x ) * step( base.y, terrMapSize.y );
  vec4 bm = texture2D( bladeTex, uv );
  float keep = step( bh.x, bm.r * inside );
  float d = length( root - gCenter );
  float fade = ( 1.0 - smoothstep( gFade.x, gFade.y, d ) ) * gFade.z;
  // the odd taller bunch where the meadow grows long
  float tallT = step( 0.86, hh.y ) * smoothstep( 0.3, 0.7, bm.g );
  float H = ( 0.06 + 0.1 * bm.g ) * ( 0.6 + 0.7 * fract( bh.y * 5.31 ) ) * ( 1.0 + 0.9 * tallT ) * fade * keep * ( 1.0 - 0.75 * wxSnow );
  // lean: blades splay out of the tuft, combed by the wind
  vec2 outD = off / max( spread, 1e-4 );
  vec2 bend = outD * ( 0.22 + 0.4 * fract( bh.y * 7.3 ) );
  vec2 wdir = vec2( 0.82, 0.57 );
  float gust = texture2D( gNoise, base * 0.045 - wdir * windTime * 0.05 ).r;
  float ph = windTime * 1.9 + dot( base, vec2( 0.71, 0.53 ) ) * 1.7;
  bend += wdir * ( ( gust - 0.35 ) * 0.9 + sin( ph ) * 0.12 + sin( ph * 2.3 + bi ) * 0.05 );
  // trample: r/g stamp time (1/8 s, 16 bit), b direction, a strength (1 = building: no grass)
  vec4 tr = texelFetch( trampleTex, ivec2( clamp( base * ${TRES.toFixed(1)}, vec2( 0.0 ), terrMapSize * ${TRES.toFixed(1)} - 1.0 ) ), 0 );
  float trF = 0.0;
  if ( tr.a > 0.0 ) {
    float age = mod( gNow8 - ( tr.r * 65280.0 + tr.g * 255.0 ), 65536.0 ) / 8.0;
    float flat_ = tr.a > 0.7 ? 1.0 - smoothstep( 2.0, 24.0, age ) * 0.92 : 1.0 - smoothstep( 0.25, 1.6, age );
    float f = clamp( tr.a * 1.18, 0.0, 1.0 ) * flat_;
    trF = f;
    float ta = tr.b * 6.2832;
    bend = mix( bend, vec2( cos( ta ), sin( ta ) ) * 1.5, f );
    H *= 1.0 - 0.45 * f;
    if ( tr.a > 0.99 ) H = 0.0;
  }
  float bl = length( bend );
  if ( bl > 1.5 ) bend *= 1.5 / bl;
  float b2 = min( 1.0, dot( bend, bend ) * 0.45 );
  vec2 wv = normalize( vec2( -bend.y, bend.x ) + vec2( cos( ang * 3.1 ), sin( ang * 3.1 ) ) * 0.6 );
  float W = ( 0.011 + 0.008 * bh.x ) * gWidth * ( 1.0 - t ) * step( 0.0001, H );
  vec3 hp = vec3( base, 0.0 );
  float gy = texture2D( gHeightTex, ( base * ${2.0.toFixed(1)} + 0.5 ) / ( terrMapSize * 2.0 + 1.0 ) ).r;
  gP = vec3( base.x + bend.x * H * t * t + wv.x * side * W, gy - 0.01 + H * t * sqrt( 1.0 - b2 * t ), base.y + bend.y * H * t * t + wv.y * side * W );
  // soft, mostly upward normals: blades shade like the turf, with a hint of their facing
  vec3 face = vec3( -wv.y, 0.0, wv.x );
  gN = normalize( vec3( 0.0, 1.0, 0.0 ) + face * 0.35 * sign( bh.x - 0.5 ) + vec3( bend.x, 0.0, bend.y ) * 0.25 * t );
  // colour: the turf's palette at the root, darker in the tuft, lighter towards the tips
  vec4 ct = texture2D( ctlTex, uv );
  vec4 tn = texture2D( tintTex, uv );
  float drift = texture2D( gNoise, base * 0.043 ).b - 0.5 + texture2D( gNoise, base * 0.0117 + 0.5 ).g - 0.5;
  vec3 c = grassBase( ct.r, tn.a, drift * 0.8 );
  float v = fract( bh.x * 31.7 );
  c = mix( c, gcFresh, step( 0.72, v ) * ( 0.5 - tn.a * 0.3 ) );
  c = mix( c, gcDry * vec3( 1.2, 1.08, 0.78 ), step( v, 0.1 ) * ( 0.35 + tn.a * 0.5 ) );
  c = mix( c, gcClover, ct.g * 0.4 );
  c *= tn.rgb * 2.0 * ( 0.86 + 0.28 * hh.x );
  // pressed-down blades show their lighter, sheeny backs
  c *= 1.0 + 0.3 * trF;
  vec3 tipC = c * vec3( 1.22, 1.17, 0.88 );
  // wildflower patches: some blades carry a flower head
  if ( ct.b > 0.25 && v > 0.55 && v < 0.55 + ct.b * 0.25 ) {
    float sp = texture2D( gNoise, base * 0.09 + 0.7 ).a;
    tipC = sp < 0.42 ? vec3( 0.82, 0.82, 0.72 ) : sp < 0.68 ? vec3( 0.86, 0.6, 0.06 ) : vec3( 0.42, 0.22, 0.66 );
    tipC *= tn.rgb * 2.0;
  }
  vGrassC = mix( c * 0.42, c * 1.0, smoothstep( 0.0, 0.65, t ) );
  vGrassC = mix( vGrassC, tipC, smoothstep( 0.6, 1.0, t ) );
}
`;

/** Blade map entries the blade shader samples, shared with the ground. */
type Shared = Record<string, { value: unknown }>;

export class GrassBlades {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private cfg: GrassCfg;
  private count: number;
  private u: {
    gCenter: { value: THREE.Vector2 };
    gFade: { value: THREE.Vector3 };
    gNow8: { value: number };
  };
  // trample map
  private tdata: Uint8Array;
  private tstr: Float32Array;
  private ttime: Float32Array;
  private ttex: THREE.DataTexture;
  private tw: number;
  private th: number;
  private rowLo = 1e9;
  private rowHi = -1;
  private ranges: { start: number; count: number }[] = [];
  private builtSeen = new Set<number>();
  private lastBuildScan = -1e9;
  private now = 0;
  private time = 0;
  private stampAcc = 0;
  private ray = new THREE.Vector3();

  constructor(
    private map: GameMap,
    ground: Ground,
    fog: FogOfWar,
    quality: 'medium' | 'high',
  ) {
    const cfg = (this.cfg = CFG[quality]);
    this.count = cfg.grid * cfg.grid;
    // ---- one tuft
    const pos: number[] = [];
    const idx: number[] = [];
    for (let b = 0; b < cfg.blades; b++) {
      const o = pos.length / 3;
      if (cfg.segs === 1) {
        pos.push(b, 0, -1, b, 0, 1, b, 1, 0);
        idx.push(o, o + 1, o + 2);
      } else {
        pos.push(b, 0, -1, b, 0, 1, b, 0.55, -1, b, 0.55, 1, b, 1, 0);
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4);
      }
    }
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // (computed in the shader; present so the material is not built flat shaded)
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    geo.setIndex(idx);
    geo.instanceCount = this.count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(map.w / 2, 0, map.h / 2), Math.hypot(map.w, map.h));

    // ---- surface height (half float, linear filtered), on the ground mesh grid
    const hdata = new Uint16Array(ground.hx * ground.hy);
    for (let k = 0; k < hdata.length; k++) hdata[k] = THREE.DataUtils.toHalfFloat(ground.heights[k]);
    const htex = new THREE.DataTexture(hdata, ground.hx, ground.hy, THREE.RedFormat, THREE.HalfFloatType);
    htex.magFilter = htex.minFilter = THREE.LinearFilter;
    htex.wrapS = htex.wrapT = THREE.ClampToEdgeWrapping;
    htex.needsUpdate = true;

    // ---- trample map
    this.tw = map.w * TRES;
    this.th = map.h * TRES;
    this.tdata = new Uint8Array(this.tw * this.th * 4);
    this.tstr = new Float32Array(this.tw * this.th);
    this.ttime = new Float32Array(this.tw * this.th).fill(-1e9);
    const tt = (this.ttex = new THREE.DataTexture(this.tdata, this.tw, this.th, THREE.RGBAFormat, THREE.UnsignedByteType));
    tt.magFilter = tt.minFilter = THREE.NearestFilter;
    tt.generateMipmaps = false;
    tt.needsUpdate = true;
    for (let i = 0; i < 256; i++) this.ranges.push({ start: 0, count: 0 });

    const sh = ground.shared as Shared;
    this.u = {
      gCenter: { value: new THREE.Vector2(map.w / 2, map.h / 2) },
      gFade: { value: new THREE.Vector3(1, 2, 0) },
      gNow8: { value: 0 },
    };
    const uniforms: Shared = {
      ...this.u,
      gCell: { value: cfg.cell },
      gGrid: { value: cfg.grid },
      gWidth: { value: quality === 'high' ? 1 : 1.25 },
      gHeightTex: { value: htex },
      trampleTex: { value: tt },
      gNoise: fog.uniforms.fogNoise,
      windTime,
      terrMapSize: sh.terrMapSize,
      bladeTex: sh.bladeTex,
      ctlTex: sh.ctlTex,
      tintTex: sh.tintTex,
      gcLush: sh.gcLush,
      gcMid: sh.gcMid,
      gcDry: sh.gcDry,
      gcFresh: sh.gcFresh,
      gcClover: sh.gcClover,
    };
    const mat = (this.mat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, side: THREE.DoubleSide }));
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GRASS_VERT_PARS}`)
        .replace('#include <beginnormal_vertex>', 'grassBlade();\nvec3 objectNormal = gN;')
        .replace('#include <begin_vertex>', 'vec3 transformed = gP;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassC;')
        .replace('#include <color_fragment>', 'diffuseColor.rgb = vGrassC;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );');
    };
    fog.apply(mat);
    mat.customProgramCacheKey = () => 'grass-blades-1';

    const mesh = (this.mesh = new THREE.Mesh(geo, mat));
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'grass';
    mesh.userData.perfCat = 'grass';
    mesh.visible = false;
    // only the main view draws blades: not the water reflection, nor override-material passes (thermal, masks)
    mesh.onBeforeRender = (_r, scene, camera, geometry, material) => {
      (geometry as THREE.InstancedBufferGeometry).instanceCount = material === this.mat && !camera.userData.waterReflection && !scene.overrideMaterial ? this.count : 0;
    };
  }

  /** Per frame: follow the camera, fade with zoom, stamp the trample map. */
  update(time: number, camera: THREE.Camera | null, units: readonly Entity[] | null) {
    const dt = Math.min(0.25, Math.max(0, time - this.time));
    this.time = time;
    this.now += dt;
    this.u.gNow8.value = Math.floor(this.now * 8) % 65536;
    if (camera) {
      // where the view centre meets the ground
      const cam = camera.position;
      camera.getWorldDirection(this.ray);
      const m = this.map;
      let gy = 0;
      let x = cam.x;
      let z = cam.z;
      for (let k = 0; k < 2; k++) {
        const t = (cam.y - gy) / Math.max(0.05, -this.ray.y);
        x = cam.x + this.ray.x * t;
        z = cam.z + this.ray.z * t;
        gy = groundHeight(m, Math.max(0, Math.min(m.w - 0.01, x)), Math.max(0, Math.min(m.h - 0.01, z)));
      }
      const span = cam.y - gy;
      const c = this.cfg;
      const zoomK = 1 - smooth(c.fadeFrom, c.fadeTo, span);
      // the far side of the view covers more ground: shift the patch that way
      const fl = Math.hypot(this.ray.x, this.ray.z) || 1;
      const half = (c.grid * c.cell) / 2;
      this.u.gCenter.value.set(x + (this.ray.x / fl) * half * 0.18, z + (this.ray.z / fl) * half * 0.18);
      this.u.gFade.value.set(half * 0.62, half * 0.97, zoomK);
      this.mesh.visible = zoomK > 0.01;
    }
    if (units) this.trample(units, dt);
  }

  private trample(units: readonly Entity[], dt: number) {
    this.stampAcc += dt;
    // buildings: no grass under them (scanned twice a second)
    if (this.now - this.lastBuildScan > 0.5) {
      this.lastBuildScan = this.now;
      for (const e of units) {
        if (e.kind !== 'building' || e.dead || this.builtSeen.has(e.id)) continue;
        this.builtSeen.add(e.id);
        const d = buildingDef(e.def);
        if (!d) continue;
        this.stampRect(e.tx - 0.12, e.ty - 0.12, e.tx + d.w + 0.12, e.ty + d.h + 0.12);
      }
    }
    if (this.stampAcc < 1 / 20) {
      this.flush();
      return;
    }
    this.stampAcc = 0;
    const now8 = this.u.gNow8.value;
    for (const e of units) {
      if (e.kind !== 'unit' || e.dead || e.inside >= 0 || e.z > 0.05 || e.para) continue;
      const d = unitDef(e.def);
      if (!d || d.air || d.category === 'air') continue;
      const dx = e.x - e.px;
      const dy = e.y - e.py;
      const moving = dx * dx + dy * dy > 1e-6;
      const head = moving ? Math.atan2(dy, dx) : e.facing;
      if (d.category === 'infantry') {
        if (moving) this.stamp(e.x, e.y, 0.11, 0.6, head, false, now8);
        continue;
      }
      // vehicles: blades bend away around the hull, the trail stays flattened
      if (moving) this.stamp(e.x, e.y, 0.62, 0.55, 0, true, now8);
      this.stamp(e.x, e.y, 0.36, 0.85, head, false, now8);
    }
    this.flush();
  }

  /** Effective strength of a trample pixel now (mirrors the shader's decay). */
  private strength(k: number) {
    const s = this.tstr[k];
    if (s <= 0) return 0;
    if (s > 0.99) return 1;
    const age = this.now - this.ttime[k];
    return s > 0.7 ? s * (1 - smooth(2, 24, age) * 0.92) : s * (1 - smooth(0.25, 1.6, age));
  }

  private stamp(x: number, y: number, r: number, s: number, ang: number, radial: boolean, now8: number) {
    const R = TRES;
    const x0 = Math.max(0, Math.floor((x - r) * R));
    const x1 = Math.min(this.tw - 1, Math.floor((x + r) * R));
    const y0 = Math.max(0, Math.floor((y - r) * R));
    const y1 = Math.min(this.th - 1, Math.floor((y + r) * R));
    if (x1 < x0 || y1 < y0) return;
    const d = this.tdata;
    let touched = false;
    for (let py = y0; py <= y1; py++) {
      let rowTouched = false;
      for (let px = x0; px <= x1; px++) {
        const cx = (px + 0.5) / R - x;
        const cy = (py + 0.5) / R - y;
        const dd = Math.sqrt(cx * cx + cy * cy);
        if (dd > r) continue;
        const k = py * this.tw + px;
        // the bend ring fades out at its rim
        const sv = radial ? s * (1 - smooth(0.6, 1, dd / r)) : s;
        if (sv < 0.05 || this.strength(k) > sv) continue;
        const a = radial ? Math.atan2(cy, cx) : ang;
        this.tstr[k] = sv;
        this.ttime[k] = this.now;
        const o = k * 4;
        d[o] = (now8 >> 8) & 255;
        d[o + 1] = now8 & 255;
        d[o + 2] = Math.round((((a / (Math.PI * 2)) % 1) + 1) % 1 * 255);
        d[o + 3] = Math.round(sv * 255);
        rowTouched = true;
      }
      if (rowTouched) touched = true;
    }
    if (touched) {
      this.rowLo = Math.min(this.rowLo, y0);
      this.rowHi = Math.max(this.rowHi, y1);
      this.colLo = Math.min(this.colLo, x0);
      this.colHi = Math.max(this.colHi, x1);
    }
  }
  private colLo = 1e9;
  private colHi = -1;

  private stampRect(ax: number, ay: number, bx: number, by: number) {
    const R = TRES;
    const x0 = Math.max(0, Math.floor(ax * R));
    const x1 = Math.min(this.tw - 1, Math.ceil(bx * R) - 1);
    const y0 = Math.max(0, Math.floor(ay * R));
    const y1 = Math.min(this.th - 1, Math.ceil(by * R) - 1);
    if (x1 < x0 || y1 < y0) return;
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const k = py * this.tw + px;
        this.tstr[k] = 1;
        this.tdata[k * 4 + 3] = 255;
      }
    this.rowLo = Math.min(this.rowLo, y0);
    this.rowHi = Math.max(this.rowHi, y1);
    this.colLo = Math.min(this.colLo, x0);
    this.colHi = Math.max(this.colHi, x1);
  }

  /** Upload the touched rectangle (one range per row, pooled: no allocations). */
  private flush() {
    if (this.rowHi < this.rowLo) return;
    const t = this.ttex;
    const rows = this.rowHi - this.rowLo + 1;
    if (rows > this.ranges.length) {
      t.clearUpdateRanges();
      t.needsUpdate = true;
    } else {
      t.updateRanges.length = 0;
      for (let i = 0; i < rows; i++) {
        const r = this.ranges[i];
        r.start = ((this.rowLo + i) * this.tw + this.colLo) * 4;
        r.count = (this.colHi - this.colLo + 1) * 4;
        t.updateRanges.push(r);
      }
      t.needsUpdate = true;
    }
    this.rowLo = this.colLo = 1e9;
    this.rowHi = this.colHi = -1;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.ttex.dispose();
  }
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
