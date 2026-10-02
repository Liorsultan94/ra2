import * as THREE from 'three';
import { BRIDGE_HEIGHT, Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';
import { WX, WX_PARS } from './wxuniforms';

/*
 * The river: a flat, alpha-blended sheet at WATER_LEVEL covering only the
 * tiles near water, shaded with
 *  - flow-mapped ripples (a tiling procedural normal map scrolled along the
 *    river's local direction, two phases cross-faded so it never stretches),
 *  - reflections: HIGH renders the scene mirrored into a half resolution
 *    target (every other frame, only while the ladder is near the top);
 *    MEDIUM marches the reflected ray through a coarse height field of the
 *    banks, trees and bridge decks (cheap screen-space-like bank / bridge
 *    reflections); LOW only reflects a sky gradient with fresnel,
 *  - shoreline foam from a precomputed distance-to-shore map (bridge piers
 *    count as shore) with lapping bands, and wakes trailing behind the piers.
 * Fog of war keeps the `fogV / fogK` block that FogOfWar.upgradeShader swaps
 * for the shared shroud / haze, and atmos.ts tints it through wxLight.
 */

export type WaterQuality = 'low' | 'medium' | 'high';

/** Pixels per tile of the shore / flow / wake data map. */
const RES = 4;
/** Shore distance (tiles) stored in the data map's G channel at 1.0. */
const SHORE_MAX = 3;
/** Main river direction (downstream). */
const FLOW = new THREE.Vector2(1, 1).normalize();

function periodicNoise(N: number, cells: number, seed: number) {
  const g = new Float32Array(cells * cells);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < g.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    g[i] = s / 4294967296;
  }
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const xi = Math.floor(fx);
      const yi = Math.floor(fy);
      let u = fx - xi;
      let v = fy - yi;
      u = u * u * (3 - 2 * u);
      v = v * v * (3 - 2 * v);
      const at = (a: number, b: number) => g[((b + cells) % cells) * cells + ((a + cells) % cells)];
      const a = at(xi, yi);
      const b = at(xi + 1, yi);
      const c = at(xi, yi + 1);
      const d = at(xi + 1, yi + 1);
      out[y * N + x] = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
  return out;
}

let waveTexC: THREE.DataTexture | null = null;
/** Tiling ripple map: RG = surface slope (x, z), B = height, A = foam breakup noise. */
function waveTexture(): THREE.DataTexture {
  if (waveTexC) return waveTexC;
  const N = 128;
  const H = new Float32Array(N * N);
  // a few periodic directional waves (integer frequencies tile seamlessly) + noise chop
  const waves = [
    [3, 1, 0.5, 0.3],
    [-2, 3, 0.35, 1.7],
    [5, -2, 0.22, 2.9],
    [1, 7, 0.14, 0.8],
    [-7, -4, 0.1, 4.1],
    [9, 5, 0.07, 5.3],
  ];
  const n1 = periodicNoise(N, 8, 11);
  const n2 = periodicNoise(N, 16, 23);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      let h = 0;
      for (const [a, b, amp, ph] of waves) h += Math.sin((a * u + b * v) * Math.PI * 2 + ph) * amp;
      h += (n1[y * N + x] - 0.5) * 0.7 + (n2[y * N + x] - 0.5) * 0.35;
      H[y * N + x] = h;
    }
  const foam1 = periodicNoise(N, 12, 37);
  const foam2 = periodicNoise(N, 32, 41);
  const data = new Uint8Array(N * N * 4);
  const at = (x: number, y: number) => H[((y + N) % N) * N + ((x + N) % N)];
  let mn = Infinity;
  let mx = -Infinity;
  for (const h of H) {
    mn = Math.min(mn, h);
    mx = Math.max(mx, h);
  }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * 8;
      const dz = (at(x, y + 1) - at(x, y - 1)) * 0.5 * 8;
      const k = (y * N + x) * 4;
      data[k] = Math.max(0, Math.min(255, dx * 127.5 + 127.5));
      data[k + 1] = Math.max(0, Math.min(255, dz * 127.5 + 127.5));
      data[k + 2] = ((H[y * N + x] - mn) / (mx - mn)) * 255;
      data[k + 3] = Math.max(0, Math.min(1, foam1[y * N + x] * 0.65 + foam2[y * N + x] * 0.35)) * 255;
    }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  waveTexC = t;
  return t;
}

interface Pier {
  x: number;
  y: number;
  /** Half extent across the flow / along the flow (tiles). */
  hw: number;
  hl: number;
}

function bridgePiers(m: GameMap): Pier[] {
  const D = Math.SQRT1_2;
  const out: Pier[] = [];
  // same layout as scenery.ts: three piers along the deck, which runs along (1, -1)
  for (const br of m.bridges) {
    const L = br.length;
    for (const k of [-L / 2 + 1.5, 0, L / 2 - 1.5]) out.push({ x: br.x + k * D, y: br.y - k * D, hw: 0.2, hl: 2.1 * 0.35 });
  }
  return out;
}

/**
 * Data map (RES px per tile): R = occluder height (ground, tree canopies,
 * bridge decks) for the medium reflection march, G = distance to the shore,
 * B = local flow angle, A = pier wake / bow foam.
 */
function buildWaterData(m: GameMap): THREE.DataTexture {
  const N = m.w * RES;
  const NH = m.h * RES;
  const piers = bridgePiers(m);
  const inPier = (x: number, y: number, grow = 0) => {
    for (const p of piers) {
      const dx = x - p.x;
      const dy = y - p.y;
      const a = Math.abs(dx * FLOW.x + dy * FLOW.y);
      const c = Math.abs(-dx * FLOW.y + dy * FLOW.x);
      if (a < p.hl + grow && c < p.hw + grow) return true;
    }
    return false;
  };
  const dry = new Uint8Array(N * NH);
  const occ = new Float32Array(N * NH);
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / RES;
      const y = (j + 0.5) / RES;
      const h = groundHeight(m, x, y);
      const k = j * N + i;
      dry[k] = h > WATER_LEVEL || inPier(x, y) ? 1 : 0;
      const tx = Math.min(m.w - 1, Math.floor(x));
      const ty = Math.min(m.h - 1, Math.floor(y));
      const ti = ty * m.w + tx;
      let o = h;
      if (m.trees[ti]) o = Math.max(o, h + 1.1);
      if (m.tiles[ti] === Tile.Bridge) o = Math.max(o, BRIDGE_HEIGHT);
      if (m.blocked[ti]) o = Math.max(o, h + 0.6);
      occ[k] = o;
    }
  // chamfer distance transform (in texels) to the nearest dry texel
  const INF = 1e9;
  const dist = new Float32Array(N * NH);
  for (let k = 0; k < N * NH; k++) dist[k] = dry[k] ? 0 : INF;
  const A = 1;
  const B = Math.SQRT2;
  const relax = (k: number, k2: number, w: number) => {
    const v = dist[k2] + w;
    if (v < dist[k]) dist[k] = v;
  };
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i > 0) relax(k, k - 1, A);
      if (j > 0) {
        relax(k, k - N, A);
        if (i > 0) relax(k, k - N - 1, B);
        if (i < N - 1) relax(k, k - N + 1, B);
      }
    }
  for (let j = NH - 1; j >= 0; j--)
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      if (i < N - 1) relax(k, k + 1, A);
      if (j < NH - 1) {
        relax(k, k + N, A);
        if (i < N - 1) relax(k, k + N + 1, B);
        if (i > 0) relax(k, k + N - 1, B);
      }
    }
  const sd = (i: number, j: number) => {
    const v = dist[Math.max(0, Math.min(NH - 1, j)) * N + Math.max(0, Math.min(N - 1, i))];
    return Math.min(v / RES, SHORE_MAX);
  };
  const data = new Uint8Array(N * NH * 4);
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const o = k * 4;
      data[o] = Math.max(0, Math.min(255, ((occ[k] + 1.5) / 6) * 255));
      const d = sd(i, j);
      data[o + 1] = (d / SHORE_MAX) * 255;
      // flow follows the banks: the main direction with the across-bank part removed
      let fx = FLOW.x;
      let fy = FLOW.y;
      const gx = (sd(i + 2, j) - sd(i - 2, j)) * 0.25;
      const gy = (sd(i, j + 2) - sd(i, j - 2)) * 0.25;
      const gl = Math.hypot(gx, gy);
      if (gl > 0.05 && d < SHORE_MAX - 0.01) {
        const nx = gx / gl;
        const ny = gy / gl;
        const dd = fx * nx + fy * ny;
        fx -= dd * nx;
        fy -= dd * ny;
        const l = Math.hypot(fx, fy);
        if (l > 1e-3) {
          fx /= l;
          fy /= l;
        } else {
          fx = FLOW.x;
          fy = FLOW.y;
        }
      }
      // angle relative to the main direction so the wrap point is upstream (never filtered across in practice)
      const ang = Math.atan2(fy, fx) - Math.PI / 4;
      const an = ((ang / (Math.PI * 2) + 0.5) % 1 + 1) % 1;
      data[o + 2] = an * 255;
    }
  // pier wakes (downstream trails) and bow foam (upstream)
  for (const p of piers) {
    const R = 5;
    const i0 = Math.max(0, Math.floor((p.x - R) * RES));
    const i1 = Math.min(N - 1, Math.ceil((p.x + R) * RES));
    const j0 = Math.max(0, Math.floor((p.y - R) * RES));
    const j1 = Math.min(NH - 1, Math.ceil((p.y + R) * RES));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        if (dry[k]) continue;
        const dx = (i + 0.5) / RES - p.x;
        const dy = (j + 0.5) / RES - p.y;
        const a = dx * FLOW.x + dy * FLOW.y;
        const c = Math.abs(-dx * FLOW.y + dy * FLOW.x);
        let w = 0;
        const t = a - p.hl;
        if (t > -0.1 && t < 3.6) {
          const half = p.hw + 0.04 + t * 0.1;
          w = Math.max(w, (1 - smooth(half * 0.4, half, c)) * (1 - smooth(0.2, 3.6, t)));
        }
        const u = -a - p.hl;
        if (u > -0.2 && u < 0.5) w = Math.max(w, (1 - smooth(0.05, 0.5, u)) * (1 - smooth(p.hw * 0.6, p.hw + 0.35, c)));
        data[k * 4 + 3] = Math.max(data[k * 4 + 3], Math.round(w * 255));
      }
  }
  const t = new THREE.DataTexture(data, N, NH, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Planar reflection for the high setting: the scene seen by a camera
 * mirrored below the water plane (with an oblique near plane at the water)
 * rendered into a half resolution target from the water mesh's
 * onBeforeRender, once every other frame.
 */
export class WaterReflection {
  readonly camera = new THREE.PerspectiveCamera();
  readonly target: THREE.WebGLRenderTarget;
  readonly matrix = new THREE.Matrix4();
  /** Water meshes hidden while the reflection renders. */
  readonly meshes: THREE.Mesh[] = [];
  /** Cleared by the quality ladder when the GPU struggles. */
  enabled = true;
  /** 1 while the target holds a usable image (shader uniform). */
  readonly on = { value: 0 };
  private frame = 0;
  private done = -1;
  private rendering = false;
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly size = new THREE.Vector2();
  private readonly clearC = new THREE.Color();

  constructor(private level: number) {
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.texture.generateMipmaps = false;
    this.camera.userData.waterReflection = true;
  }

  /** Called once per frame (Terrain.update). */
  tick() {
    this.frame++;
  }

  isRendering() {
    return this.rendering;
  }

  readonly hook = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
    if (this.rendering || camera === this.camera) return;
    const cam = camera as THREE.PerspectiveCamera;
    if (!this.enabled || !cam.isPerspectiveCamera) {
      this.on.value = 0;
      return;
    }
    // every other frame (the image lags a frame at most; ripples hide it)
    if (this.done === this.frame || (this.done >= 0 && this.frame - this.done < 2 && this.on.value > 0)) return;
    this.done = this.frame;
    const L = this.level;
    const camPos = this.v1.setFromMatrixPosition(cam.matrixWorld);
    if (camPos.y <= L + 0.05) {
      this.on.value = 0;
      return;
    }
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(64, Math.min(1024, Math.round(this.size.x * 0.5)));
    const h = Math.max(64, Math.round((w * this.size.y) / Math.max(1, this.size.x)));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    // mirrored camera
    const vc = this.camera;
    this.rot.extractRotation(cam.matrixWorld);
    vc.position.set(camPos.x, 2 * L - camPos.y, camPos.z);
    const look = this.v2.set(0, 0, -1).applyMatrix4(this.rot).add(camPos);
    look.y = 2 * L - look.y;
    vc.up.set(0, 1, 0).applyMatrix4(this.rot);
    vc.up.y = -vc.up.y;
    vc.lookAt(look);
    vc.far = cam.far;
    vc.near = cam.near;
    vc.layers.mask = cam.layers.mask;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(cam.projectionMatrix);
    vc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    // oblique near plane at the water surface (Lengyel), as in three's Reflector
    this.plane.setFromNormalAndCoplanarPoint(this.v3.set(0, 1, 0), this.v2.set(0, L, 0));
    this.plane.applyMatrix4(vc.matrixWorldInverse);
    const clip = this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = vc.projectionMatrix.elements;
    const q = this.q.set((Math.sign(clip.x) + pm[8]) / pm[0], (Math.sign(clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1 - 0.003;
    pm[14] = clip.w;
    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // render
    this.rendering = true;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevBg = scene.background;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearC);
    const vis = this.meshes.map((m) => m.visible);
    for (const m of this.meshes) m.visible = false;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, vc);
    this.meshes.forEach((m, i) => (m.visible = vis[i]));
    renderer.setClearColor(this.clearC, prevAlpha);
    scene.background = prevBg;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
    const vp = (cam as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }).viewport;
    if (vp !== undefined) renderer.state.viewport(vp);
    this.rendering = false;
    this.on.value = 1;
  };

  dispose() {
    this.target.dispose();
  }
}

export interface WaterBuild {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  reflection: WaterReflection | null;
}

export function buildWater(m: GameMap, fog: FogOfWar, quality: WaterQuality): WaterBuild {
  // height texture so the shader knows the depth (vertex grid)
  const hw = m.w + 1;
  const hh = m.h + 1;
  const hdata = new Uint8Array(hw * hh);
  for (let i = 0; i < hw * hh; i++) hdata[i] = Math.max(0, Math.min(255, ((m.heights[i] + 1.5) / 4.5) * 255));
  const htex = new THREE.DataTexture(hdata, hw, hh, THREE.RedFormat, THREE.UnsignedByteType);
  htex.magFilter = htex.minFilter = THREE.LinearFilter;
  htex.needsUpdate = true;
  const reflection = quality === 'high' ? new WaterReflection(WATER_LEVEL) : null;
  const Q = quality === 'high' ? 2 : quality === 'medium' ? 1 : 0;
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    defines: { WATER_Q: Q },
    uniforms: {
      time: { value: 0 },
      heightTex: { value: htex },
      waterData: { value: buildWaterData(m) },
      waveTex: { value: waveTexture() },
      mapSize: { value: new THREE.Vector2(m.w, m.h) },
      sunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      waterLevel: { value: WATER_LEVEL },
      wxLight: { value: new THREE.Vector3(1, 1, 1) },
      wxSpec: { value: 1 },
      skyTop: { value: new THREE.Color(0x4a6488) },
      skyHorizon: { value: new THREE.Color(0x8a8678) },
      reflTex: { value: reflection ? reflection.target.texture : null },
      reflMatrix: { value: reflection ? reflection.matrix : new THREE.Matrix4() },
      reflOn: reflection ? reflection.on : { value: 0 },
      ...fog.uniforms,
      ...WX,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform sampler2D heightTex;
      uniform sampler2D waterData;
      uniform sampler2D waveTex;
      uniform vec2 mapSize;
      uniform vec3 sunDir;
      uniform float waterLevel;
      uniform vec3 wxLight;
      uniform float wxSpec;
      uniform vec3 skyTop;
      uniform vec3 skyHorizon;
      uniform sampler2D reflTex;
      uniform mat4 reflMatrix;
      uniform float reflOn;
      ${WX_PARS}
      uniform sampler2D fogTex;
      uniform vec2 fogSize;
      uniform float fogEnabled;
      varying vec3 vWorld;
      vec2 waveN(vec2 uv) { return texture2D(waveTex, uv).rg * 2.0 - 1.0; }
      void main() {
        vec2 p = vWorld.xz;
        float ground = texture2D(heightTex, (p + 0.5) / (mapSize + 1.0)).r * 4.5 - 1.5;
        float depth = clamp((waterLevel - ground) / 0.7, 0.0, 1.0);
        if (depth <= 0.0) discard;
        vec4 dat = texture2D(waterData, p / mapSize);
        float shore = dat.g * ${SHORE_MAX.toFixed(1)};
        float ang = (dat.b - 0.5) * 6.2832 + 0.7854;
        vec2 flowDir = vec2(cos(ang), sin(ang));
        float speed = 0.3 * smoothstep(0.0, 1.2, shore) + 0.06;
        vec2 fl = flowDir * speed;
        // flow-mapped ripples: two phases cross-faded so the scroll never stretches
        float ph0 = fract(time * 0.12);
        float ph1 = fract(time * 0.12 + 0.5);
        float w0 = 1.0 - abs(1.0 - 2.0 * ph0);
        vec2 b0 = p * 0.42 - fl * ph0 * 8.0;
        vec2 b1 = p * 0.42 - fl * ph1 * 8.0 + 0.37;
        vec2 g = (waveN(b0) * w0 + waveN(b1) * (1.0 - w0)) * 0.07;
        #if WATER_Q > 0
          g += (waveN(b0 * 2.7 + 0.21) * w0 + waveN(b1 * 2.7 + 0.53) * (1.0 - w0)) * 0.035;
        #endif
        // a slow cross swell so still water isn't dead
        g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 2.3 + time * 1.1) * 0.012;
        if (wxRain > 0.001) {
          // rain: rings from drops on the surface (wxRain: while it rains)
          vec2 rp = p / 0.5;
          vec2 ci = floor(rp);
          vec2 h = fract(sin(vec2(dot(ci, vec2(127.1, 311.7)), dot(ci, vec2(269.5, 183.3)))) * 43758.5453);
          vec2 o = rp - (ci + 0.2 + h * 0.6);
          float ph = fract(wxTime * 0.9 + h.x * 7.3);
          float d = length(o) - ph * 0.5;
          g += normalize(o + 1e-4) * sin(d * 40.0) * exp(-abs(d) * 14.0) * (1.0 - ph) * 0.12 * wxRain;
        }
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float cosT = max(dot(n, viewDir), 0.0);
        float fres = 0.3 + 0.7 * pow(1.0 - cosT, 4.0);
        // a lowland river: green-brown in the shallows, dark slate in the channel
        vec3 deep = vec3(0.016, 0.04, 0.046);
        vec3 shallow = vec3(0.07, 0.1, 0.075);
        vec3 col = mix(shallow, deep, smoothstep(0.0, 0.8, depth));
        // reflection: sky gradient, then banks / bridges / everything on high
        vec3 R = reflect(-viewDir, n);
        R.y = abs(R.y);
        vec3 refl = mix(skyHorizon, skyTop, smoothstep(0.05, 0.8, R.y)) * 0.55;
        // drifting clouds in the reflected sky
        float cl = texture2D(waveTex, R.xz / (R.y + 0.25) * 0.12 + vec2(time * 0.004, time * 0.002)).a;
        refl = mix(refl, skyHorizon * 0.9, smoothstep(0.45, 0.75, cl) * 0.6);
        float bankK = 1.0 - smoothstep(0.0, 1.6, shore);
        #if WATER_Q == 0
          // cheap: the banks darken the reflection close to the shore
          refl *= 1.0 - bankK * 0.55;
        #elif WATER_Q >= 1
          #if WATER_Q == 2
          if (reflOn < 0.5) {
          #endif
          // march the reflected ray through the bank / tree / bridge height field
          vec3 rp0 = vec3(p.x, waterLevel, p.y);
          float hit = 0.0;
          float t = 0.12;
          for (int i = 0; i < 7; i++) {
            vec3 q = rp0 + R * t;
            float occ = texture2D(waterData, q.xz / mapSize).r * 6.0 - 1.5;
            if (occ > q.y) { hit = 1.0 - float(i) * 0.08; break; }
            t *= 1.55;
          }
          vec3 bankC = vec3(0.035, 0.04, 0.026);
          refl = mix(refl, bankC, hit);
          #if WATER_Q == 2
          }
          #endif
        #endif
        #if WATER_Q == 2
          if (reflOn > 0.5) {
            vec4 rc = reflMatrix * vec4(vWorld, 1.0);
            vec2 ruv = rc.xy / rc.w + n.xz * 0.05;
            vec4 sc = texture2D(reflTex, ruv);
            refl = mix(refl, sc.rgb, sc.a);
          }
        #endif
        col = mix(col, refl, fres * 0.85);
        col *= wxLight;
        float spec = pow(max(dot(reflect(-sunDir, n), viewDir), 0.0), 90.0);
        col += vec3(1.0, 0.95, 0.85) * spec * 1.6 * wxSpec;
        // shoreline foam: lapping bands that run up to the bank, broken up by noise
        float fn = texture2D(waveTex, p * 0.55 - fl * time * 0.5).a;
        float fn2 = texture2D(waveTex, p * 1.7 + fl * time * 0.3 + 0.4).a;
        float band = 1.0 - smoothstep(0.0, 0.22 + fn * 0.28, shore);
        float lap = 0.5 + 0.5 * sin(shore * 18.0 - time * 1.7 + fn * 5.0);
        float foam = band * smoothstep(0.5, 0.85, fn2 * 0.6 + lap * 0.4 + band * 0.2) * 0.85;
        foam = max(foam, (1.0 - smoothstep(0.0, 0.05 + fn2 * 0.05, shore)) * (0.35 + 0.45 * fn2));
        // pier wakes: foam streaks dragged downstream
        float wk = dat.a;
        if (wk > 0.003) {
          vec2 ax = vec2(dot(p, flowDir), dot(p, vec2(-flowDir.y, flowDir.x)));
          float st = texture2D(waveTex, vec2(ax.x * 0.3 - time * 0.4, ax.y * 2.2)).a;
          float st2 = texture2D(waveTex, vec2(ax.x * 0.9 - time * 0.9, ax.y * 4.1) + 0.5).a;
          float streak = smoothstep(0.5, 0.78, st * 0.65 + st2 * 0.35 + wk * 0.12);
          foam = max(foam, wk * wk * mix(streak, 1.0, smoothstep(0.85, 1.0, wk)) * 0.8);
          col += vec3(0.02, 0.026, 0.026) * wk * wxLight;
        }
        foam = clamp(foam, 0.0, 1.0);
        col = mix(col, vec3(0.78, 0.83, 0.82) * wxLight, foam * 0.75);
        float fogV = texture2D(fogTex, p / fogSize).r;
        float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
        col *= mix(1.0, fogK, fogEnabled);
        float alpha = max(mix(0.55, 0.92, depth), fres * 0.85) + foam * 0.25;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * smoothstep(0.0, 0.06, depth));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  // shared smoky shroud / haze instead of the plain darkening above
  fog.upgradeShader(material);
  const mesh = new THREE.Mesh(waterGeometry(m), material);
  mesh.position.set(0, WATER_LEVEL, 0);
  mesh.renderOrder = 1;
  mesh.name = 'water';
  if (reflection) {
    reflection.meshes.push(mesh);
    mesh.onBeforeRender = reflection.hook;
  }
  mesh.userData.waterReflection = reflection;
  return { mesh, material, reflection };
}

/** Quads over the tiles that are (partly) under water, plus a margin, instead of a map-wide sheet. */
function waterGeometry(m: GameMap): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const W = m.w;
  const H = m.h;
  const vh = (x: number, y: number) => m.heights[Math.max(0, Math.min(H, y)) * (W + 1) + Math.max(0, Math.min(W, x))];
  const wet = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const lo = Math.min(vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1));
      if (lo < WATER_LEVEL + 0.02) wet[y * W + x] = 1;
    }
  // merge runs of wet tiles per row into one quad
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!wet[y * W + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < W && wet[y * W + e]) e++;
      const b = pos.length / 3;
      // extend the edges of the map so the outskirts water meets it
      const x0 = x === 0 ? -0.001 : x;
      const x1 = e === W ? W + 0.001 : e;
      pos.push(x0, 0, y, x1, 0, y, x1, 0, y + 1, x0, 0, y + 1);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      x = e;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
