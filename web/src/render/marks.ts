import * as THREE from 'three';
import { standHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';

/*
 * Ground decals drawn as instanced quads that fade with age: tank tread
 * prints and tyre marks (~10 s), blast craters and scorch marks. Each decal is
 * tilted to the terrain normal so it hugs slopes.
 */

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const TEX = {
  tread: () =>
    canvasTex(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      // track plates: transverse bars with gaps
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = 'rgba(30,24,16,0.85)';
        ctx.fillRect(i * 16 + 2, 4, 9, s - 8);
        ctx.fillStyle = 'rgba(30,24,16,0.35)';
        ctx.fillRect(i * 16 + 11, 10, 4, s - 20);
      }
    }),
  tire: () =>
    canvasTex(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, 'rgba(30,24,16,0)');
      g.addColorStop(0.25, 'rgba(30,24,16,0.65)');
      g.addColorStop(0.75, 'rgba(30,24,16,0.65)');
      g.addColorStop(1, 'rgba(30,24,16,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let i = 0; i < 8; i++) ctx.fillRect(i * 8, 18, 3, s - 36);
    }),
  crater: () =>
    canvasTex(128, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      // ejecta streaks
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * Math.PI * 2;
        const r0 = c * 0.45;
        const r1 = c * (0.6 + Math.random() * 0.4);
        ctx.strokeStyle = `rgba(${40 + Math.random() * 30},${32 + Math.random() * 20},${22},${0.25 + Math.random() * 0.3})`;
        ctx.lineWidth = 1 + Math.random() * 3;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.stroke();
      }
      // raised rim (lit) and dark bowl
      let g = ctx.createRadialGradient(c, c, c * 0.2, c, c, c * 0.62);
      g.addColorStop(0, 'rgba(18,14,10,0.95)');
      g.addColorStop(0.55, 'rgba(38,30,22,0.9)');
      g.addColorStop(0.8, 'rgba(120,100,76,0.55)');
      g.addColorStop(1, 'rgba(90,72,52,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.62, 0, Math.PI * 2);
      ctx.fill();
      g = ctx.createRadialGradient(c - c * 0.08, c - c * 0.1, 0, c, c, c * 0.35);
      g.addColorStop(0, 'rgba(8,6,4,0.9)');
      g.addColorStop(1, 'rgba(8,6,4,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.35, 0, Math.PI * 2);
      ctx.fill();
      // scattered clods
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = c * (0.5 + Math.random() * 0.45);
        ctx.fillStyle = `rgba(50,40,28,${0.5 + Math.random() * 0.4})`;
        ctx.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 2 + Math.random() * 3, 2 + Math.random() * 3);
      }
    }),
  scorch: () =>
    canvasTex(128, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      for (let i = 0; i < 6; i++) {
        const ox = c + (Math.random() - 0.5) * c * 0.5;
        const oy = c + (Math.random() - 0.5) * c * 0.5;
        const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, c * (0.5 + Math.random() * 0.4));
        g.addColorStop(0, 'rgba(10,8,6,0.75)');
        g.addColorStop(0.6, 'rgba(20,16,12,0.35)');
        g.addColorStop(1, 'rgba(20,16,12,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
    }),
};

class DecalLayer {
  readonly mesh: THREE.InstancedMesh;
  private birth: Float32Array;
  private attr: THREE.InstancedBufferAttribute;
  private next = 0;
  private used = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private n = new THREE.Vector3();
  readonly uniforms: { time: { value: number } };

  constructor(
    tex: THREE.Texture,
    private max: number,
    life: number,
    opacity: number,
    fog: FogOfWar,
    order: number,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.birth = new Float32Array(max).fill(-1e6);
    this.attr = new THREE.InstancedBufferAttribute(this.birth, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBirth', this.attr);
    this.uniforms = { time: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2 - order,
      polygonOffsetUnits: -2,
      uniforms: { map: { value: tex }, time: this.uniforms.time, life: { value: life }, opacity: { value: opacity }, ...fog.uniforms },
      vertexShader: /* glsl */ `
        attribute float aBirth;
        varying vec2 vUv;
        varying float vAge;
        varying vec2 vW;
        uniform float time;
        void main() {
          vUv = uv;
          vAge = time - aBirth;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float life;
        uniform float opacity;
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec2 vUv;
        varying float vAge;
        varying vec2 vW;
        void main() {
          float k = clamp(vAge / life, 0.0, 1.0);
          float fade = 1.0 - smoothstep(0.6, 1.0, k);
          vec4 t = texture2D(map, vUv);
          float fogV = texture2D(fogTex, vW / fogSize).r;
          float f = mix(1.0, smoothstep(0.2, 0.6, fogV), fogEnabled);
          gl_FragColor = vec4(t.rgb, t.a * opacity * fade * f);
          if (gl_FragColor.a < 0.004) discard;
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1 + order;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  add(map: GameMap, x: number, z: number, angle: number, length: number, width: number, time: number, lift = 0.012) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.used = Math.min(this.max, this.used + 1);
    const cx = Math.max(0, Math.min(map.w - 0.01, x));
    const cz = Math.max(0, Math.min(map.h - 0.01, z));
    const e = 0.3;
    const hx = standHeight(map, Math.min(map.w - 0.01, cx + e), cz) - standHeight(map, Math.max(0, cx - e), cz);
    const hz = standHeight(map, cx, Math.min(map.h - 0.01, cz + e)) - standHeight(map, cx, Math.max(0, cz - e));
    this.n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
    this.q.setFromUnitVectors(this.up, this.n);
    this.q2.setFromAxisAngle(this.up, -angle);
    this.q.multiply(this.q2);
    this.m4.compose(new THREE.Vector3(x, standHeight(map, cx, cz) + lift, z), this.q, new THREE.Vector3(length, 1, width));
    this.mesh.setMatrixAt(i, this.m4);
    this.birth[i] = time;
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.needsUpdate = true;
  }
}

export class GroundMarks {
  readonly group = new THREE.Group();
  private tread: DecalLayer;
  private tire: DecalLayer;
  private crater: DecalLayer;
  private scorch: DecalLayer;
  time = 0;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
  ) {
    this.tread = new DecalLayer(TEX.tread(), 5000, 10, 0.55, fog, 0);
    this.tire = new DecalLayer(TEX.tire(), 3000, 10, 0.45, fog, 0);
    this.scorch = new DecalLayer(TEX.scorch(), 200, 45, 0.9, fog, 1);
    this.crater = new DecalLayer(TEX.crater(), 200, 60, 1, fog, 2);
    for (const l of [this.tread, this.tire, this.scorch, this.crater]) this.group.add(l.mesh);
  }

  /** Track or tyre print segment under one track. */
  print(x: number, z: number, angle: number, len: number, width: number, wheeled: boolean) {
    (wheeled ? this.tire : this.tread).add(this.map, x, z, angle, len, width, this.time);
  }

  craterAt(x: number, z: number, r: number) {
    this.crater.add(this.map, x, z, Math.random() * 6.28, r * 2, r * 2, this.time, 0.02);
  }

  scorchAt(x: number, z: number, r: number) {
    this.scorch.add(this.map, x, z, Math.random() * 6.28, r * 2, r * 2, this.time, 0.016);
  }

  update(dt: number) {
    this.time += dt;
    for (const l of [this.tread, this.tire, this.crater, this.scorch]) l.uniforms.time.value = this.time;
  }
}
