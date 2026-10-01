import * as THREE from 'three';
import type { FogOfWar } from './fog';

function makeSpriteTexture(kind: 'glow' | 'smoke'): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  if (kind === 'glow') {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  } else {
    // lumpy smoke puff made of several soft blobs
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = i === 0 ? 0 : s * 0.16;
      const x = s / 2 + Math.cos(a) * r;
      const y = s / 2 + Math.sin(a) * r;
      const rad = s * (i === 0 ? 0.3 : 0.2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

export interface ParticleOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  sizeEnd?: number;
  color: number;
  colorEnd?: number;
  alpha?: number;
  drag?: number;
  gravity?: number;
}

class ParticleSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private a0: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private count = 0;
  private geo: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;

  constructor(
    private max: number,
    additive: boolean,
    fog: FogOfWar,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        tex: { value: makeSpriteTexture(additive ? 'glow' : 'smoke') },
        scale: { value: 30 },
        ...fog.uniforms,
      },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        uniform float scale;
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          float fogV = texture2D(fogTex, position.xz / fogSize).r;
          vAlpha = alpha * mix(1.0, smoothstep(0.55, 0.85, fogV), fogEnabled);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tex;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(tex, gl_PointCoord);
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  spawn(o: ParticleOpts) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos.set([o.x, o.y, o.z], i * 3);
    this.vel.set([o.vx ?? 0, o.vy ?? 0, o.vz ?? 0], i * 3);
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.s0[i] = o.size;
    this.s1[i] = o.sizeEnd ?? o.size;
    const c = new THREE.Color(o.color);
    const ce = new THREE.Color(o.colorEnd ?? o.color);
    this.c0.set([c.r, c.g, c.b], i * 3);
    this.c1.set([ce.r, ce.g, ce.b], i * 3);
    this.a0[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 0;
    this.grav[i] = o.gravity ?? 0;
  }

  update(dt: number) {
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.kill(i);
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      for (let c = 0; c < 3; c++) this.col[i * 3 + c] = this.c0[i * 3 + c] + (this.c1[i * 3 + c] - this.c0[i * 3 + c]) * t;
      this.alpha[i] = this.a0[i] * (t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9);
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    for (const a of ['position', 'color', 'size', 'alpha']) (this.geo.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }

  private kill(i: number) {
    const j = --this.count;
    if (i === j) return;
    const copy3 = (arr: Float32Array) => arr.copyWithin(i * 3, j * 3, j * 3 + 3);
    const copy1 = (arr: Float32Array) => (arr[i] = arr[j]);
    copy3(this.pos);
    copy3(this.vel);
    copy3(this.col);
    copy3(this.c0);
    copy3(this.c1);
    for (const a of [this.size, this.alpha, this.life, this.maxLife, this.s0, this.s1, this.a0, this.drag, this.grav]) copy1(a);
  }

  get active() {
    return this.count;
  }
}

interface Timed {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  life: number;
  max: number;
  grow?: number;
  base?: number;
  alpha0?: number;
}

export class Effects {
  readonly group = new THREE.Group();
  readonly fire: ParticleSystem;
  readonly smokeSys: ParticleSystem;
  private timed: Timed[] = [];
  private lights: { light: THREE.PointLight; life: number; max: number; power: number }[] = [];
  private beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  private ringGeo = new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2);
  private discGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  private scorchTex: THREE.Texture;
  private scorches: THREE.Mesh[] = [];
  shake = 0;

  constructor(
    scene: THREE.Scene,
    fog: FogOfWar,
    private quality: 'low' | 'medium' | 'high',
  ) {
    const mult = quality === 'low' ? 0.5 : 1;
    this.fire = new ParticleSystem(Math.floor(5000 * mult), true, fog);
    this.smokeSys = new ParticleSystem(Math.floor(4000 * mult), false, fog);
    this.group.add(this.fire.points, this.smokeSys.points);
    scene.add(this.group);
    if (quality !== 'low') {
      for (let i = 0; i < 4; i++) {
        const l = new THREE.PointLight(0xffa040, 0, 6, 1.6);
        this.group.add(l);
        this.lights.push({ light: l, life: 1, max: 1, power: 0 });
      }
    }
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(15,12,10,0.85)');
    g.addColorStop(0.5, 'rgba(25,20,15,0.55)');
    g.addColorStop(1, 'rgba(25,20,15,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.scorchTex = new THREE.CanvasTexture(c);
  }

  setPointScale(s: number) {
    this.fire.material.uniforms.scale.value = s;
    this.smokeSys.material.uniforms.scale.value = s;
  }

  private rand(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  private flashLight(x: number, y: number, z: number, power: number, color: number, life: number) {
    if (!this.lights.length) return;
    let slot = this.lights[0];
    for (const l of this.lights) if (l.life / l.max >= slot.life / slot.max) slot = l;
    slot.light.position.set(x, y + 0.6, z);
    slot.light.color.setHex(color);
    slot.life = 0;
    slot.max = life;
    slot.power = power;
  }

  // ------------------------------------------------------------------ public

  explosion(x: number, y: number, z: number, size: 'tiny' | 'small' | 'medium' | 'large' | 'huge', kind: 'fire' | 'thermo' | 'dust' | 'laser' | 'air' = 'fire') {
    const S = { tiny: 0.25, small: 0.5, medium: 1, large: 1.7, huge: 2.6 }[size];
    const q = this.quality === 'low' ? 0.5 : 1;
    if (kind === 'dust') {
      for (let i = 0; i < 6 * q; i++)
        this.smokeSys.spawn({ x, y: y + 0.05, z, vx: this.rand(-0.6, 0.6) * S, vy: this.rand(0.3, 0.9) * S, vz: this.rand(-0.6, 0.6) * S, life: this.rand(0.4, 0.8), size: 0.25 * S, sizeEnd: 0.6 * S, color: 0x9a8a70, alpha: 0.6, drag: 3 });
      for (let i = 0; i < 4 * q; i++) this.fire.spawn({ x, y: y + 0.1, z, vx: this.rand(-2, 2), vy: this.rand(0.5, 2), vz: this.rand(-2, 2), life: 0.15, size: 0.08, color: 0xffe0a0, gravity: 6 });
      return;
    }
    const hot = kind === 'laser' ? 0xffb090 : kind === 'thermo' ? 0xffd070 : 0xffc060;
    const mid = kind === 'laser' ? 0xc02010 : kind === 'thermo' ? 0xe05a10 : 0xd04a08;
    // core flash
    this.fire.spawn({ x, y: y + 0.2 * S, z, life: 0.16, size: 1.1 * S, sizeEnd: 1.8 * S, color: 0xfff0c0, colorEnd: mid, alpha: 0.75 });
    // fireball
    const nFire = Math.round((kind === 'thermo' ? 22 : 12) * S * q) + 3;
    for (let i = 0; i < nFire; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.rand(0.4, 1.6) * S;
      this.fire.spawn({
        x: x + Math.cos(a) * 0.1 * S,
        y: y + this.rand(0.05, 0.3) * S,
        z: z + Math.sin(a) * 0.1 * S,
        vx: Math.cos(a) * sp,
        vy: this.rand(0.4, 1.6) * S,
        vz: Math.sin(a) * sp,
        life: this.rand(0.35, 0.75) * (kind === 'thermo' ? 1.5 : 1),
        size: this.rand(0.35, 0.7) * S,
        sizeEnd: this.rand(0.7, 1.2) * S,
        color: hot,
        colorEnd: 0x4a0c00,
        alpha: 0.8,
        drag: 2.5,
        gravity: -0.6,
      });
    }
    // sparks
    for (let i = 0; i < 10 * S * q; i++) {
      this.fire.spawn({ x, y: y + 0.15, z, vx: this.rand(-4, 4) * S, vy: this.rand(1, 5) * S, vz: this.rand(-4, 4) * S, life: this.rand(0.3, 0.7), size: 0.07, color: 0xffd080, colorEnd: 0xff4000, gravity: 9, drag: 0.5 });
    }
    // smoke
    if (kind !== 'air' || S > 0.6) {
      const nSmoke = Math.round(8 * S * q) + 2;
      for (let i = 0; i < nSmoke; i++) {
        this.smokeSys.spawn({
          x: x + this.rand(-0.3, 0.3) * S,
          y: y + this.rand(0.2, 0.5) * S,
          z: z + this.rand(-0.3, 0.3) * S,
          vx: this.rand(-0.4, 0.4) * S,
          vy: this.rand(0.4, 1.0) * S,
          vz: this.rand(-0.4, 0.4) * S,
          life: this.rand(1.4, 2.8) * Math.sqrt(S),
          size: this.rand(0.5, 0.9) * S,
          sizeEnd: this.rand(1.6, 2.6) * S,
          color: 0x3a3632,
          colorEnd: 0x6a645c,
          alpha: 0.75,
          drag: 1.2,
          gravity: -0.15,
        });
      }
    }
    // debris
    if (S >= 1 && kind !== 'air') {
      for (let i = 0; i < 8 * S * q; i++)
        this.smokeSys.spawn({ x, y: y + 0.2, z, vx: this.rand(-2.5, 2.5) * S, vy: this.rand(2, 5) * S, vz: this.rand(-2.5, 2.5) * S, life: this.rand(0.6, 1.1), size: 0.09, color: 0x1a1612, alpha: 1, gravity: 10 });
    }
    // shockwave ring
    if (S >= 1.5) this.ring(x, y + 0.05, z, 0.3 * S, 2.2 * S, 0.4, 0xa07040, true, 0.45);
    if (S >= 0.5 && kind !== 'air') this.scorch(x, y, z, 0.55 * S);
    this.flashLight(x, y, z, 6 * S, kind === 'laser' ? 0xff5030 : 0xffa040, 0.35 + 0.1 * S);
    if (S >= 1.7) this.shake = Math.max(this.shake, 0.18 * S);
  }

  muzzle(p: THREE.Vector3, dir: THREE.Vector3, scale = 1, color = 0xffe08a) {
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.07, size: 0.45 * scale, sizeEnd: 0.2 * scale, color });
    this.fire.spawn({ x: p.x + dir.x * 0.12 * scale, y: p.y + dir.y * 0.12, z: p.z + dir.z * 0.12 * scale, life: 0.06, size: 0.3 * scale, color: 0xffa040 });
    if (scale > 0.8) {
      for (let i = 0; i < 3; i++)
        this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vx: dir.x * 1.2 + this.rand(-0.2, 0.2), vy: this.rand(0.2, 0.6), vz: dir.z * 1.2 + this.rand(-0.2, 0.2), life: this.rand(0.5, 1), size: 0.2 * scale, sizeEnd: 0.6 * scale, color: 0x8a8580, alpha: 0.5, drag: 3 });
      this.flashLight(p.x, p.y - 0.4, p.z, 2.5 * scale, 0xffb060, 0.08);
    }
  }

  /** A short glowing line (bullet tracer, laser beam). */
  beam(a: THREE.Vector3, b: THREE.Vector3, color: number, width: number, life: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const m = new THREE.Mesh(this.beamGeo, mat);
    const len = a.distanceTo(b);
    m.position.copy(a);
    m.lookAt(b);
    m.scale.set(width, width, len);
    m.renderOrder = 4;
    this.group.add(m);
    this.timed.push({ obj: m, mat, life: 0, max: life });
  }

  laser(a: THREE.Vector3, b: THREE.Vector3) {
    this.beam(a, b, 0xff3a1a, 0.09, 0.22);
    this.beam(a, b, 0xffe6d0, 0.03, 0.18);
    for (let i = 0; i < 5; i++) this.fire.spawn({ x: b.x, y: b.y, z: b.z, vx: this.rand(-1.5, 1.5), vy: this.rand(0.5, 2), vz: this.rand(-1.5, 1.5), life: 0.25, size: 0.1, color: 0xffb090, colorEnd: 0xff2000, gravity: 5 });
    this.fire.spawn({ x: b.x, y: b.y, z: b.z, life: 0.15, size: 0.7, color: 0xff6040 });
    this.flashLight(b.x, b.y, b.z, 2, 0xff4020, 0.15);
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3) {
    const len = Math.max(0.01, a.distanceTo(b));
    const seg = Math.min(1, 0.6 / len);
    const t0 = Math.random() * (1 - seg);
    this.beam(a.clone().lerp(b, t0), a.clone().lerp(b, t0 + seg), 0xffd27a, 0.018, 0.07);
    this.fire.spawn({ x: b.x, y: b.y, z: b.z, vx: this.rand(-1, 1), vy: this.rand(0.5, 1.5), vz: this.rand(-1, 1), life: 0.12, size: 0.06, color: 0xffe0a0, gravity: 6 });
  }

  ring(x: number, y: number, z: number, r0: number, r1: number, life: number, color: number, additive: boolean, opacity = 0.9) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.set(x, y, z);
    m.scale.setScalar(r0);
    m.renderOrder = 3;
    this.group.add(m);
    this.timed.push({ obj: m, mat, life: 0, max: life, grow: r1, base: r0, alpha0: opacity });
  }

  marker(x: number, y: number, z: number, attack: boolean) {
    this.ring(x, y + 0.04, z, 0.6, 0.1, 0.45, attack ? 0xff3030 : 0x40ff70, true);
    this.ring(x, y + 0.04, z, 0.35, 0.05, 0.35, attack ? 0xff8080 : 0xa0ffb0, true);
  }

  scorch(x: number, y: number, z: number, r: number) {
    const mat = new THREE.MeshBasicMaterial({ map: this.scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const m = new THREE.Mesh(this.discGeo, mat);
    m.position.set(x, y + 0.03, z);
    m.scale.setScalar(r * this.rand(0.8, 1.2));
    m.rotation.y = Math.random() * 6;
    m.renderOrder = 1;
    this.group.add(m);
    this.scorches.push(m);
    this.timed.push({ obj: m, mat, life: 0, max: 40, base: -1 });
    if (this.scorches.length > 80) {
      const old = this.scorches.shift()!;
      const t = this.timed.find((tt) => tt.obj === old);
      if (t) t.life = t.max;
    }
  }

  smoke(x: number, y: number, z: number, size = 1, dark = true) {
    this.smokeSys.spawn({ x: x + this.rand(-0.1, 0.1), y, z: z + this.rand(-0.1, 0.1), vx: this.rand(-0.1, 0.1) + 0.15, vy: this.rand(0.5, 0.9), vz: this.rand(-0.1, 0.1) - 0.1, life: this.rand(1.8, 3), size: 0.25 * size, sizeEnd: 1.1 * size, color: dark ? 0x2a2725 : 0xd8d8d8, colorEnd: dark ? 0x5a5550 : 0xf0f0f0, alpha: dark ? 0.55 : 0.35, drag: 0.4, gravity: -0.1 });
  }

  flame(x: number, y: number, z: number, size = 1) {
    this.fire.spawn({ x: x + this.rand(-0.15, 0.15) * size, y, z: z + this.rand(-0.15, 0.15) * size, vy: this.rand(0.6, 1.2), life: this.rand(0.3, 0.6), size: 0.35 * size, sizeEnd: 0.1, color: 0xffc050, colorEnd: 0xb02000, gravity: -0.5 });
  }

  spark(x: number, y: number, z: number, color = 0x80c0ff) {
    for (let i = 0; i < 3; i++) this.fire.spawn({ x, y, z, vx: this.rand(-1, 1), vy: this.rand(0, 1.5), vz: this.rand(-1, 1), life: 0.25, size: 0.07, color, gravity: 3 });
    this.fire.spawn({ x, y, z, life: 0.12, size: 0.35, color });
  }

  intercept(p: THREE.Vector3) {
    for (let i = 0; i < 10; i++) this.fire.spawn({ x: p.x, y: p.y, z: p.z, vx: this.rand(-3, 3), vy: this.rand(0, 3), vz: this.rand(-3, 3), life: 0.3, size: 0.08, color: 0xfff0c0, colorEnd: 0xff8000, gravity: 6 });
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.15, size: 0.9, color: 0xfff0d0 });
    this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vy: 0.4, life: 1, size: 0.3, sizeEnd: 0.8, color: 0x8a8a8a, alpha: 0.6, drag: 1 });
    this.flashLight(p.x, p.y, p.z, 2.5, 0xfff0c0, 0.12);
  }

  jamPulse(x: number, y: number, z: number, r: number) {
    this.ring(x, y + 0.1, z, 0.2, r, 1.1, 0x50a0ff, true);
  }

  /** Trail particles behind moving projectiles. */
  trail(p: THREE.Vector3, kind: 'shell' | 'rocket' | 'missile' | 'artillery') {
    if (kind === 'shell') {
      this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.08, size: 0.18, color: 0xffd080 });
      return;
    }
    const big = kind === 'missile' ? 1.8 : kind === 'artillery' ? 0.8 : 1;
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.1, size: 0.3 * big, color: 0xfff0b0, colorEnd: 0xff6010 });
    this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vx: this.rand(-0.05, 0.05), vy: 0.15, vz: this.rand(-0.05, 0.05), life: this.rand(0.7, 1.3) * big, size: 0.12 * big, sizeEnd: 0.45 * big, color: 0xb0aca8, colorEnd: 0xd8d4d0, alpha: 0.45, drag: 1 });
  }

  update(dt: number) {
    this.fire.update(dt);
    this.smokeSys.update(dt);
    this.shake = Math.max(0, this.shake - dt * 0.8);
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const t = this.timed[i];
      t.life += dt;
      const k = t.life / t.max;
      if (k >= 1) {
        this.group.remove(t.obj);
        t.mat.dispose();
        if (t.base === -1) this.scorches.splice(this.scorches.indexOf(t.obj as THREE.Mesh), 1);
        this.timed.splice(i, 1);
        continue;
      }
      if (t.base === -1) t.mat.opacity = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
      else t.mat.opacity = (t.alpha0 ?? 1) * (1 - k);
      if (t.grow !== undefined && t.base !== undefined) t.obj.scale.setScalar(t.base + (t.grow - t.base) * Math.sqrt(k));
    }
    for (const l of this.lights) {
      l.life += dt;
      const k = Math.min(1, l.life / l.max);
      l.light.intensity = l.power * (1 - k) * (1 - k);
    }
  }

  get activeParticles() {
    return this.fire.active + this.smokeSys.active;
  }
}

