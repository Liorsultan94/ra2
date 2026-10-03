import * as THREE from 'three';
import { Tile, standHeight, type GameMap } from '../sim/map';
import { noiseTexture } from './fog';
import { WX } from './wxuniforms';

/*
 * Light reflections on wet ground: while the ground is wet (WX.wxWet), every
 * light flare near the ground (street lamps, headlights, tail lights, beacons,
 * fires; the night-light and ambient-life flare pools) gets a mirrored glint
 * where its reflection lands on the ground for this camera, stretched towards
 * the viewer the way wet asphalt smears a light into a streak. The streak is
 * brightest over the puddle field (the same noise the ground's puddles use)
 * and broken up by the water film and the rain. One additive instanced draw,
 * depth-tested against the scene, rebuilt each frame from the flare buffers
 * (no allocations); not built on low quality.
 */

const MAX: Record<'medium' | 'high', number> = { medium: 120, high: 280 };
/** Flare sources: instanced meshes (scale = flare size, translation = position, instanceColor). */
const SOURCES = ['night-flares', 'ambient-flares'];

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vW;
void main() {
  vUv = uv;
  vCol = instanceColor;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
uniform sampler2D fogNoise;
uniform float wxWet;
uniform float wxRain;
uniform float wxTime;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vW;
void main() {
  // x along the streak (+1 = towards the camera), y across it
  vec2 q = vUv * 2.0 - 1.0;
  float a = exp(-q.y * q.y * 4.5) * (1.0 - smoothstep(0.5, 1.0, abs(q.x)));
  // the mirrored light itself sits a little behind the middle; the smear tails off towards the viewer
  float c = q.x + 0.25;
  a *= 0.45 + 1.1 * exp(-c * c * 9.0);
  // puddle field (as the ground's puddles: they mirror sharply) and the broken water film between them
  float pud = smoothstep(0.52, 0.66, texture2D(fogNoise, vW.xz * 0.085 + 0.13).g * 0.78 + texture2D(fogNoise, vW.xz * 0.33 + 0.57).r * 0.22 + (1.0 - wxWet) * -0.1);
  float film = smoothstep(0.25, 0.75, texture2D(fogNoise, vW.xz * vec2(2.3, 1.7) + 0.4).r);
  a *= mix(0.25 + 0.5 * film, 1.25, pud) * smoothstep(0.0, 0.6, wxWet);
  // falling drops ruffle the water: the glint shimmers
  float rip = texture2D(fogNoise, vW.xz * 3.1 + wxTime * vec2(0.23, -0.19)).a;
  a *= 1.0 - 0.45 * wxRain * smoothstep(0.35, 0.75, rip);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class WetGlints {
  readonly mesh: THREE.InstancedMesh;
  private max: number;
  private sources: THREE.InstancedMesh[] = [];
  private lookAgain = 0;
  /** Glints drawn last frame (stats / tests). */
  count = 0;

  constructor(
    private map: GameMap,
    quality: 'medium' | 'high',
    /** Brightness of a reflection relative to its flare. */
    private gain = 0.2,
  ) {
    this.max = MAX[quality];
    const mat = new THREE.ShaderMaterial({
      uniforms: { fogNoise: { value: noiseTexture() }, wxWet: WX.wxWet, wxRain: WX.wxRain, wxTime: WX.wxTime },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    const m = (this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, this.max));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    m.renderOrder = 3;
    m.name = 'wet-glints';
  }

  /** Per frame: mirror the flares of the last frame into the wet ground for this camera. */
  update(scene: THREE.Object3D, camera: THREE.Camera, time: number) {
    const m = this.mesh;
    const wet = WX.wxWet.value;
    if (wet < 0.03 || WX.wxGloss.value < 0.5) {
      m.visible = false;
      this.count = 0;
      return;
    }
    // the flare pools are created by other systems (some late): look them up now and then
    if (this.sources.length < SOURCES.length && time >= this.lookAgain) {
      this.lookAgain = time + 2;
      this.sources.length = 0;
      for (const n of SOURCES) {
        const o = scene.getObjectByName(n);
        if (o && (o as THREE.InstancedMesh).isInstancedMesh) this.sources.push(o as THREE.InstancedMesh);
      }
    }
    const cam = camera.position;
    const map = this.map;
    let n = 0;
    for (const src of this.sources) {
      if (!src.visible || !src.parent || src.count === 0 || !src.instanceColor) continue;
      const a = src.instanceMatrix.array;
      const col = src.instanceColor.array;
      for (let i = 0; i < src.count && n < this.max; i++) {
        const o = i * 16;
        const r = col[i * 3];
        const g = col[i * 3 + 1];
        const b = col[i * 3 + 2];
        if (r + g + b < 0.08) continue;
        const x = a[o + 12];
        const y = a[o + 13];
        const z = a[o + 14];
        if (x < 0 || z < 0 || x >= map.w || z >= map.h) continue;
        const tx = Math.floor(x);
        const tz = Math.floor(z);
        if (map.tiles[tz * map.w + tx] === Tile.Water) continue;
        const gy = standHeight(map, x, z);
        const h = y - gy;
        // only lights near the ground mirror in it (not aircraft, not lamps high on a building)
        if (h < 0.02 || h > 2.6) continue;
        const size = Math.hypot(a[o], a[o + 1], a[o + 2]);
        // where the camera sees the mirror image (x, gy - h, z) through the ground plane
        const ch = cam.y - gy;
        if (ch <= 0.1) continue;
        const t = ch / (ch + h);
        const px = cam.x + (x - cam.x) * t;
        const pz = cam.z + (z - cam.z) * t;
        let dx = cam.x - px;
        let dz = cam.z - pz;
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl;
        dz /= dl;
        // longer smear for higher lights and bigger flares; wet asphalt stretches it towards the viewer
        const len = 0.22 + h * 1.3 + size * 1.4;
        const wid = 0.05 + size * 0.75 + h * 0.08;
        _q.setFromAxisAngle(UP, Math.atan2(-dz, dx));
        _m.compose(_p.set(px + dx * len * 0.12, standHeight(map, px, pz) + 0.035, pz + dz * len * 0.12), _q, _s.set(len, 1, wid));
        m.setMatrixAt(n, _m);
        // a bright flare's reflection saturates less than the flare (it reads as the light, not a halo)
        const k = this.gain / (1 + 0.25 * Math.max(r, g, b));
        m.setColorAt(n, _c.setRGB(r * k, g * k, b * k));
        n++;
      }
    }
    this.count = n;
    m.count = n;
    m.visible = n > 0;
    if (n > 0) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.clearUpdateRanges();
      m.instanceColor!.addUpdateRange(0, n * 3);
      m.instanceColor!.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
