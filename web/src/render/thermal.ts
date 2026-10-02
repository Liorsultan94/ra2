import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

/*
 * Thermal imaging (FLIR) look, shared by the full-screen thermal mode and the
 * drone camera picture-in-picture.
 *
 * The scene is rendered normally; a cheap low-resolution "heat mask" pass then
 * draws only the hot things (the largest meshes of every unit / wreck, tagged
 * with HEAT_LAYER) with one unlit matcap override material. The thermal shader
 * maps the normal image to a compressed, cool grey range (terrain, buildings;
 * lit windows come out faintly warm), adds the heat mask on top and detects
 * fires / explosions / muzzle flashes / tracers by their hot orange-white colour.
 * Grain, scanlines and a slight lens vignette finish the sensor look.
 */

/** Camera layer of meshes that glow in thermal view (units, aircraft, wrecks). */
export const HEAT_LAYER = 20;

export type Polarity = 'white' | 'black';

/** Radial matcap: faces towards the sensor read hottest, grazing edges cooler. */
function heatMatcap(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      // brighter on the upper side (engine decks / exhausts face up from the sky)
      const v = Math.round(255 * Math.max(0, Math.min(1, 1 - 0.45 * r * r + dy * 0.12)));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, n, n);
  t.needsUpdate = true;
  return t;
}

let sharedHeatMat: THREE.MeshMatcapMaterial | null = null;
/** Override material for the heat mask pass. */
export function heatMaterial(): THREE.MeshMatcapMaterial {
  if (!sharedHeatMat) {
    const m = new THREE.MeshMatcapMaterial({ matcap: heatMatcap(), color: 0xffffff, fog: false });
    // models face +X: the engine deck / exhausts at the rear and the running gear low down run hottest
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vHeatPos;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeatPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHeatPos;')
        .replace('#include <opaque_fragment>', 'outgoingLight *= 0.62 + 0.42 * smoothstep(0.1, -0.45, vHeatPos.x) + 0.16 * smoothstep(0.1, 0.0, vHeatPos.y);\n#include <opaque_fragment>');
    };
    sharedHeatMat = m;
  }
  return sharedHeatMat;
}

/**
 * Render the heat mask (hot meshes only) into `target` from `camera`.
 * Shadows are not re-rendered and the background is cleared to black.
 */
export function renderHeatMask(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
  const mask = camera.layers.mask;
  const bg = scene.background;
  const env = scene.environment;
  const ov = scene.overrideMaterial;
  const sh = renderer.shadowMap.autoUpdate;
  const prevRT = renderer.getRenderTarget();
  const clear = renderer.getClearColor(new THREE.Color());
  const clearA = renderer.getClearAlpha();
  camera.layers.set(HEAT_LAYER);
  scene.background = null;
  scene.environment = null;
  scene.overrideMaterial = heatMaterial();
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 1);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(clear, clearA);
  renderer.shadowMap.autoUpdate = sh;
  scene.overrideMaterial = ov;
  scene.environment = env;
  scene.background = bg;
  camera.layers.mask = mask;
}

/** GLSL: thermal mapping of one pixel (shared by the full-screen pass and the PiP). */
export const THERMAL_GLSL = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tHeat;
uniform float time;
uniform vec2 res;
uniform float polarity;   // 1 = white-hot, -1 = black-hot
uniform float linearIn;   // 1 when tDiffuse holds linear, un-tonemapped colour
uniform float grain;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 srcColor(vec2 uv) {
  vec3 c = texture2D(tDiffuse, uv).rgb;
  if (linearIn > 0.5) {
    c = c / (1.0 + c) * 1.6;
    c = pow(clamp(c, 0.0, 1.0), vec3(0.4545));
  }
  return clamp(c, 0.0, 1.0);
}
float heatAt(vec2 uv) {
  vec3 c = srcColor(uv);
  float l = dot(c, vec3(0.3, 0.59, 0.11));
  // cool world: compressed grey range keeps the terrain readable
  float cold = 0.05 + 0.5 * pow(l, 1.15);
  // fire, explosions, tracers, muzzle flashes, lit windows: hot orange-yellow-white
  float warm = smoothstep(0.22, 0.6, c.r - c.b) * smoothstep(0.5, 0.95, c.r);
  float white = smoothstep(0.86, 1.0, min(c.r, min(c.g, c.b))) * 0.75;
  float v = max(cold, max(warm, white));
  // hot bodies: blurred mask so engines bloom a little; the visible image adds surface detail
  vec2 px = 1.0 / res;
  float h0 = texture2D(tHeat, uv).r;
  float h = h0 * 0.6
    + (texture2D(tHeat, uv + vec2(px.x * 2.0, 0.0)).r + texture2D(tHeat, uv - vec2(px.x * 2.0, 0.0)).r
     + texture2D(tHeat, uv + vec2(0.0, px.y * 2.0)).r + texture2D(tHeat, uv - vec2(0.0, px.y * 2.0)).r) * 0.1;
  float body = 0.3 + h * 0.5 + (l - 0.35) * 0.45 * step(0.02, h0);
  v = max(v, body);
  return v;
}
float thermal(vec2 uv) {
  float v = heatAt(uv);
  if (polarity < 0.0) v = 1.04 - v;
  float n = hash(floor(uv * res) + fract(time * 17.31) * 113.0);
  v += (n - 0.5) * grain;
  v *= 0.95 + 0.05 * sin(uv.y * res.y * 2.2);
  vec2 d = uv - 0.5;
  v *= 1.0 - dot(d, d) * 0.55;
  return clamp(v, 0.0, 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function thermalUniforms() {
  return {
    tDiffuse: { value: null as THREE.Texture | null },
    tHeat: { value: null as THREE.Texture | null },
    time: { value: 0 },
    res: { value: new THREE.Vector2(1, 1) },
    polarity: { value: 1 },
    linearIn: { value: 0 },
    grain: { value: 0.05 },
  };
}

/** Full-screen thermal: a composer pass (post chain on), or a quad drawn from an offscreen frame (post chain off). */
export class ThermalPass extends Pass {
  readonly uniforms = thermalUniforms();
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: THERMAL_GLSL + `
        varying vec2 vUv;
        void main() {
          float v = thermal(vUv);
          // a hint of the classic slightly-cool sensor tint
          gl_FragColor = vec4(vec3(v * 0.97, v, v * 1.02), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(w: number, h: number) {
    this.uniforms.res.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.linearIn.value = 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  /** Without a post chain: draw `src` (linear colour) through the thermal mapping to the screen. */
  renderDirect(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = src.texture;
    this.uniforms.linearIn.value = 1;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
