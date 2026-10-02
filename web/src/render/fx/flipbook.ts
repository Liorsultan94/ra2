import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import type { ParticleUniforms } from './gpuparticles';

/*
 * Pre-rendered volumetric flipbooks (explosions, smoke, fire, dust, sparks).
 *
 * The atlases are baked offline by tools/bake-fx.mjs (a CPU ray-marcher over
 * animated noise volumes) into public/fx/: 8 effects x 64 frames, stored as
 * "6-way lightmaps" (how much light reaches the visible gas from the right /
 * top / left / bottom / camera side / back) plus opacity and blackbody
 * emission. Here every sprite is relit per pixel from the live sun direction
 * and colour, the sky ambient and the strongest nearby fire lights, so a
 * baked fireball sits in noon, dusk, night or storm lighting and still has a
 * correctly lit / shadowed side when the view rotates. Rotated / mirrored
 * sprites rotate the light basis with them.
 *
 * Rendering: one instanced draw call of camera-facing quads, sorted back to
 * front on the CPU (a few hundred sprites at most), premultiplied-alpha
 * blending (lit smoke + additive fire in one pass), smooth frame blending,
 * soft contact with the terrain (height texture), near-camera fade and the
 * fog of war. Loading is lazy and never blocks: until the atlases arrive (or
 * on low quality) `ready` is false and the callers keep the procedural path.
 * The shader program is compiled once with a 1x1 placeholder texture.
 */

export type FlipKind = 'fireball' | 'burst' | 'fuel' | 'dust' | 'smoke' | 'flame' | 'sparks' | 'airburst';

export interface FlipOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** World size (quad edge, tiles) at birth and death. */
  size: number;
  sizeEnd?: number;
  /** Seconds; defaults to the effect's baked length. */
  life?: number;
  /** Seconds before the sprite appears. */
  delay?: number;
  /** Albedo of the smoke / dust (linear multiply of the baked grey), default light grey. */
  tint?: number;
  alpha?: number;
  /** Emission multiplier (0 = no fire glow). */
  emissive?: number;
  /** Blackbody ramp shift: > 0 whiter / hotter, < 0 deeper orange-red. */
  heat?: number;
  drag?: number;
  /** Upward acceleration (buoyancy), tiles / s^2. */
  rise?: number;
  /** Wind response (0..1). */
  wind?: number;
  /** Max random rotation (radians, default PI). */
  rot?: number;
  /** Angular speed (rad / s). */
  spin?: number;
  /** Pin the bottom of the image (the baked ground line) to the spawn point. */
  ground?: boolean;
  /** Playback time warp: frame = t^warp (< 1 spends less time on the early frames). */
  warp?: number;
}

interface Sprite {
  kind: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  s0: number;
  s1: number;
  age: number;
  life: number;
  rot: number;
  spin: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  emis: number;
  heat: number;
  drag: number;
  rise: number;
  wind: number;
  anchor: number;
  mirror: number;
  warp: number;
  loop: boolean;
  depth: number;
}

interface Manifest {
  frame: number;
  grid: number;
  blocks: [number, number];
  effects: Record<string, { block: number; life: number; loop: boolean; emission: number }>;
}

const KINDS: FlipKind[] = ['fireball', 'burst', 'fuel', 'dust', 'smoke', 'flame', 'sparks', 'airburst'];
/** Floats per instance. */
const STRIDE = 16;

const VERT = /* glsl */ `
  attribute vec4 iA;  // centre xyz, size
  attribute vec4 iB;  // rotation, frame, block, alpha
  attribute vec4 iC;  // albedo rgb, emission
  attribute vec4 iD;  // heat, anchor, mirror, loop
  uniform vec2 uBlocks;
  uniform float uGrid;
  uniform vec3 uSunDir;
  uniform vec4 uFireP[4];
  uniform vec3 uFireC[4];
  uniform sampler2D fogTex;
  uniform vec2 fogSize;
  uniform float fogEnabled;
  varying vec2 vUv;
  varying vec4 vCell;     // atlas cell origin of frame 0 / frame 1 (uv units)
  varying float vBlend;
  varying vec4 vCol;      // albedo, alpha
  varying vec4 vFx;       // emission, heat, fade-near, frame-uv scale
  varying vec3 vSunA;     // 6-way weights: +x, +y, -x
  varying vec3 vSunB;     // -y, front, back
  varying vec3 vAmbA;
  varying vec3 vAmbB;
  varying vec3 vWarm;
  varying vec3 vWorld;
  vec2 cellOf( float f, float block ) {
    float bx = mod( block, uBlocks.x );
    float by = floor( block / uBlocks.x );
    float cx = mod( f, uGrid );
    float cy = floor( f / uGrid );
    return vec2( bx * uGrid + cx, by * uGrid + cy ) / ( uBlocks * uGrid );
  }
  vec3 w6a( vec3 l, vec3 R, vec3 U, vec3 F ) {
    float r = dot( l, R ), u = dot( l, U );
    return vec3( r > 0.0 ? r * r : 0.0, u > 0.0 ? u * u : 0.0, r < 0.0 ? r * r : 0.0 );
  }
  vec3 w6b( vec3 l, vec3 R, vec3 U, vec3 F ) {
    float u = dot( l, U ), f = dot( l, F );
    return vec3( u < 0.0 ? u * u : 0.0, f > 0.0 ? f * f : 0.0, f < 0.0 ? f * f : 0.0 );
  }
  void main() {
    vec3 camR = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
    vec3 camU = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
    vec3 camF = vec3( viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2] );
    float cs = cos( iB.x ), sn = sin( iB.x );
    vec3 R = ( camR * cs + camU * sn ) * iD.z;
    vec3 U = -camR * sn + camU * cs;
    float size = iA.w;
    // ground-anchored effects: the baked ground line (10% above the frame bottom) sits on the spawn point
    vec3 centre = iA.xyz + camU * size * 0.45 * iD.y;
    vec3 wp = centre + ( R * position.x + U * position.y ) * size * 0.5;
    vWorld = wp;
    vUv = vec2( position.x * 0.5 + 0.5, 0.5 - position.y * 0.5 );
    float f0 = floor( iB.y );
    float f1 = iD.w > 0.5 ? mod( f0 + 1.0, uGrid * uGrid ) : min( f0 + 1.0, uGrid * uGrid - 1.0 );
    vCell = vec4( cellOf( f0, iB.z ), cellOf( f1, iB.z ) );
    vBlend = iB.y - f0;
    float fogV = texture2D( fogTex, iA.xz / fogSize ).r;
    float a = iB.w * mix( 1.0, smoothstep( 0.55, 0.85, fogV ), fogEnabled );
    vCol = vec4( iC.rgb, a );
    vec4 mv = viewMatrix * vec4( wp, 1.0 );
    // fade sprites the (photo / intro) camera flies through
    float near = smoothstep( size * 0.25, size * 0.9, -( viewMatrix * vec4( centre, 1.0 ) ).z );
    vFx = vec4( iC.a, iD.x, near, 1.0 / ( uBlocks.x * uGrid ) );
    vSunA = w6a( uSunDir, R, U, camF );
    vSunB = w6b( uSunDir, R, U, camF );
    vec3 up = vec3( 0.0, 1.0, 0.0 );
    vAmbA = w6a( up, R, U, camF );
    vAmbB = w6b( up, R, U, camF );
    vec3 warm = vec3( 0.0 );
    for ( int i = 0; i < 4; i++ ) {
      vec3 d = centre - uFireP[i].xyz;
      warm += uFireC[i] * ( uFireP[i].w / ( 1.0 + dot( d, d ) * 1.2 ) );
    }
    vWarm = min( warm * 0.1, vec3( 1.4 ) );
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tA;
  uniform sampler2D tB;
  uniform vec2 uBlocks;
  uniform float uGrid;
  uniform float uTexel;
  uniform vec3 uSunCol;
  uniform vec3 uAmbCol;
  uniform sampler2D heightTex;
  uniform vec2 heightSize;
  uniform float heightOn;
  uniform float uEmis;
  varying vec2 vUv;
  varying vec4 vCell;
  varying float vBlend;
  varying vec4 vCol;
  varying vec4 vFx;
  varying vec3 vSunA;
  varying vec3 vSunB;
  varying vec3 vAmbA;
  varying vec3 vAmbB;
  varying vec3 vWarm;
  varying vec3 vWorld;
  vec3 ramp( float e, float heat ) {
    // blackbody-ish: deep red -> orange -> yellow -> white
    float x = clamp( e * ( 1.0 + heat ), 0.0, 1.6 );
    vec3 c = mix( vec3( 0.55, 0.06, 0.01 ), vec3( 1.0, 0.32, 0.05 ), smoothstep( 0.0, 0.3, x ) );
    c = mix( c, vec3( 1.0, 0.66, 0.25 ), smoothstep( 0.25, 0.65, x ) );
    c = mix( c, vec3( 1.0, 0.93, 0.8 ), smoothstep( 0.6, 1.2, x ) );
    return c;
  }
  void main() {
    vec2 uv = clamp( vUv, vec2( uTexel ), vec2( 1.0 - uTexel ) ) * vFx.w * vec2( 1.0, uBlocks.x / uBlocks.y );
    vec4 a0 = texture2D( tA, vCell.xy + uv );
    vec4 a1 = texture2D( tA, vCell.zw + uv );
    vec4 b0 = texture2D( tB, vCell.xy + uv );
    vec4 b1 = texture2D( tB, vCell.zw + uv );
    vec4 A = mix( a0, a1, vBlend );
    vec4 B = mix( b0, b1, vBlend );
    float soft = 1.0;
    if ( heightOn > 0.5 ) {
      float g = texture2D( heightTex, ( vWorld.xz + 0.5 ) / heightSize ).r;
      soft = smoothstep( -0.05, 0.3, vWorld.y - g );
    }
    float alpha = A.a * vCol.a * soft * vFx.z;
    vec3 la = A.rgb * A.rgb;
    vec3 lb = B.rgb * B.rgb;
    float e = B.a * B.a * uEmis;
    if ( alpha < 0.002 && e * vFx.x < 0.002 ) discard;
    float sun = dot( la, vSunA ) + dot( lb, vSunB );
    float sky = dot( la, vAmbA ) + dot( lb, vAmbB );
    float avg = ( la.x + la.y + la.z + lb.x + lb.y + lb.z ) / 6.0;
    vec3 light = uSunCol * sun * 1.15 + uAmbCol * ( 0.55 * sky + 0.45 * avg + 0.12 ) * 1.25 + vWarm * ( 0.65 * lb.x + 0.35 * avg );
    vec3 col = vCol.rgb * light * alpha;
    // blackbody emission (premultiplied: also glows through thin smoke), hot enough to bloom
    float em = e * vFx.x;
    col += ramp( sqrt( e ), vFx.y ) * em * 5.0 * vCol.a * soft * vFx.z;
    gl_FragColor = vec4( col, alpha );
  }
`;

/** Lazily loaded flipbook atlases + the sprite system that draws them. */
export class Flipbooks {
  readonly mesh: THREE.Mesh;
  /** True once the atlases are on the GPU; until then callers keep the procedural effects. */
  ready = false;
  private sprites: Sprite[] = [];
  private data: Float32Array;
  private attr: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private meta: Manifest['effects'] | null = null;
  private v = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private col = new THREE.Color();
  /** Global wind (tiles / s), shared with the particles. */
  wind = { x: 0, z: 0 };

  constructor(
    private max: number,
    private half: boolean,
    fog: FogOfWar,
    pu: ParticleUniforms,
  ) {
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    const quad = new THREE.PlaneGeometry(2, 2);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.data = new Float32Array(max * STRIDE);
    this.attr = new THREE.InstancedInterleavedBuffer(this.data, STRIDE).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(this.attr, 4, 0));
    geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(this.attr, 4, 4));
    geo.setAttribute('iC', new THREE.InterleavedBufferAttribute(this.attr, 4, 8));
    geo.setAttribute('iD', new THREE.InterleavedBufferAttribute(this.attr, 4, 12));
    geo.instanceCount = 0;
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    blank.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        tA: { value: blank },
        tB: { value: blank },
        uBlocks: { value: new THREE.Vector2(4, 2) },
        uGrid: { value: 8 },
        uTexel: { value: 0.5 / 128 },
        uEmis: { value: 1 },
        uSunDir: pu.uSunDir,
        uSunCol: pu.uSunCol,
        uAmbCol: pu.uAmbCol,
        uFireP: pu.uFireP,
        uFireC: pu.uFireC,
        heightTex: pu.heightTex,
        heightSize: pu.heightSize,
        heightOn: pu.heightOn,
        ...fog.uniforms,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2.5;
    this.mesh.name = 'flipbooks';
  }

  /** Fetch the manifest and atlases (call once; resolves false on failure and the game keeps the procedural look). */
  async load(base = 'fx/'): Promise<boolean> {
    try {
      const res = await fetch(base + 'fx.json');
      if (!res.ok) return false;
      const man = (await res.json()) as Manifest;
      const sfx = this.half ? '-half' : '';
      const [a, b] = await Promise.all([this.image(`${base}fx-a${sfx}.webp`), this.image(`${base}fx-b${sfx}.webp`)]);
      const u = this.mat.uniforms;
      u.tA.value = a;
      u.tB.value = b;
      u.uBlocks.value.set(man.blocks[0], man.blocks[1]);
      u.uGrid.value = man.grid;
      u.uTexel.value = 0.5 / (man.frame * (this.half ? 0.5 : 1));
      this.meta = man.effects;
      this.ready = true;
      return true;
    } catch (e) {
      console.warn('flipbook atlases unavailable, keeping procedural effects', e);
      return false;
    }
  }

  private async image(url: string): Promise<THREE.Texture> {
    const blob = await (await fetch(url)).blob();
    // straight (non-premultiplied) data: the alpha channel of the second atlas is emission, not coverage
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const t = new THREE.Texture(bmp);
    t.flipY = false;
    t.premultiplyAlpha = false;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** Baked length of an effect (seconds). */
  life(kind: FlipKind): number {
    return this.meta?.[kind]?.life ?? 2;
  }

  spawn(kind: FlipKind, o: FlipOpts) {
    if (!this.ready || !this.meta) return;
    const m = this.meta[kind];
    if (!m) return;
    let s: Sprite;
    if (this.sprites.length >= this.max) {
      // full: recycle the oldest (relative to its life)
      let best = 0;
      let bk = -1;
      for (let i = 0; i < this.sprites.length; i++) {
        const k = this.sprites[i].age / this.sprites[i].life;
        if (k > bk) {
          bk = k;
          best = i;
        }
      }
      s = this.sprites[best];
    } else {
      s = {} as Sprite;
      this.sprites.push(s);
    }
    const c = this.col.setHex(o.tint ?? 0xb4b0aa);
    const rr = o.rot ?? Math.PI;
    Object.assign(s, {
      kind: m.block,
      x: o.x,
      y: o.y,
      z: o.z,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0,
      vz: o.vz ?? 0,
      s0: o.size,
      s1: o.sizeEnd ?? o.size,
      age: -(o.delay ?? 0),
      life: o.life ?? m.life,
      rot: (Math.random() * 2 - 1) * rr,
      spin: o.spin ?? 0,
      r: c.r,
      g: c.g,
      b: c.b,
      alpha: o.alpha ?? 1,
      emis: o.emissive ?? 1,
      heat: o.heat ?? 0,
      drag: o.drag ?? 0,
      rise: o.rise ?? 0,
      wind: o.wind ?? 0,
      anchor: o.ground ? 1 : 0,
      mirror: Math.random() < 0.5 ? -1 : 1,
      warp: o.warp ?? 1,
      loop: m.loop,
      depth: 0,
    } satisfies Sprite);
  }

  get active() {
    return this.sprites.length;
  }

  clear() {
    this.sprites.length = 0;
    this.geo.instanceCount = 0;
  }

  update(dt: number, camera: THREE.Camera | null) {
    const list = this.sprites;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.age += dt;
      if (s.age >= s.life) {
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      if (s.age < 0) continue;
      const k = Math.exp(-s.drag * dt);
      s.vx = s.vx * k + this.wind.x * s.wind * dt;
      s.vz = s.vz * k + this.wind.z * s.wind * dt;
      s.vy = s.vy * k + s.rise * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rot += s.spin * dt;
    }
    if (!list.length || !camera) {
      this.geo.instanceCount = 0;
      return;
    }
    // back to front
    const cp = this.v.setFromMatrixPosition(camera.matrixWorld);
    const f = camera.getWorldDirection(this.fwd);
    for (const s of list) s.depth = (s.x - cp.x) * f.x + (s.y - cp.y) * f.y + (s.z - cp.z) * f.z;
    list.sort((a, b) => b.depth - a.depth);
    const d = this.data;
    let n = 0;
    const frames = (this.mat.uniforms.uGrid.value as number) ** 2;
    for (const s of list) {
      if (s.age < 0) continue;
      const t = s.age / s.life;
      const o = n * STRIDE;
      const e = 1 - (1 - t) * (1 - t);
      d[o] = s.x;
      d[o + 1] = s.y;
      d[o + 2] = s.z;
      d[o + 3] = s.s0 + (s.s1 - s.s0) * (0.4 * t + 0.6 * e);
      let fr: number;
      let a: number;
      if (s.loop) {
        fr = ((s.age * 26) % frames + frames) % frames;
        a = Math.min(1, s.age / 0.25, (s.life - s.age) / 0.5);
      } else {
        fr = Math.min(frames - 1.001, Math.pow(t, s.warp) * (frames - 1));
        a = Math.min(1, t / 0.03) * (1 - smooth(0.8, 1, t));
      }
      d[o + 4] = s.rot;
      d[o + 5] = fr;
      d[o + 6] = s.kind;
      d[o + 7] = s.alpha * a;
      d[o + 8] = s.r;
      d[o + 9] = s.g;
      d[o + 10] = s.b;
      d[o + 11] = s.emis;
      d[o + 12] = s.heat;
      d[o + 13] = s.anchor;
      d[o + 14] = s.mirror;
      d[o + 15] = s.loop ? 1 : 0;
      n++;
    }
    this.geo.instanceCount = n;
    if (n) {
      this.attr.clearUpdateRanges();
      this.attr.addUpdateRange(0, n * STRIDE);
      this.attr.needsUpdate = true;
    }
  }

  static kinds() {
    return KINDS;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
