import * as THREE from 'three';

/*
 * Screen-space heat haze and shockwave distortion.
 *
 * Distortion sources are point sprites rendered (additively, no depth) into
 * a quarter-resolution half-float target that stores a UV offset per pixel.
 * The final post pass reads it and shifts its lookup into the scene colour.
 *   kind 0: heat shimmer (fires, rocket exhaust, fresh fireballs)
 *   kind 1: spherical shockwave seen from the camera (air bursts)
 *   kind 2: ground shockwave (squashed to the camera's view of the ground plane)
 * Nothing is rendered (and the post pass skips the lookup) while no source
 * is alive.
 */

const RES = 0.25; // fraction of the drawing-buffer resolution
/** sin(camera elevation): ground circles appear this squashed vertically. */
const GROUND_SQUASH = 0.58;

export class HazeField {
  private max: number;
  private pos: Float32Array;
  private size: Float32Array;
  private str: Float32Array;
  private kind: Float32Array;
  private prog: Float32Array;
  private seed: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private vy: Float32Array;
  private count = 0;
  private ones: Float32Array[];
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private rt: THREE.WebGLRenderTarget;
  private clear = new THREE.Color();
  private time = 0;

  constructor(
    private camera: THREE.Camera,
    quality: 'low' | 'medium' | 'high',
  ) {
    const max = (this.max = quality === 'high' ? 320 : 160);
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.str = new Float32Array(max);
    this.kind = new Float32Array(max);
    this.prog = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.ones = [this.size, this.str, this.kind, this.prog, this.seed, this.s0, this.s1, this.a0, this.life, this.maxLife, this.vy];
    const attr = (name: string, arr: Float32Array, n: number) => this.geo.setAttribute(name, new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    attr('position', this.pos, 3);
    attr('size', this.size, 1);
    attr('strength', this.str, 1);
    attr('kind', this.kind, 1);
    attr('prog', this.prog, 1);
    attr('seed', this.seed, 1);
    this.mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: { scale: { value: 10 }, time: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float strength;
        attribute float kind;
        attribute float prog;
        attribute float seed;
        uniform float scale;
        varying float vS;
        varying float vK;
        varying float vSeed;
        void main() {
          vS = strength;
          vK = kind;
          vSeed = seed;
          gl_PointSize = size * scale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform float time;
        varying float vS;
        varying float vK;
        varying float vSeed;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          c.y = -c.y;
          vec2 off;
          if ( vK < 0.5 ) {
            float r = length( c ) * 2.0;
            float fall = 1.0 - smoothstep( 0.2, 1.0, r );
            // rising shimmer: noise scrolls upwards
            float n1 = sin( c.y * 34.0 - time * 13.0 + vSeed ) + 0.6 * sin( c.x * 27.0 + c.y * 11.0 - time * 9.0 + vSeed * 2.3 );
            float n2 = cos( c.x * 31.0 + time * 11.0 + vSeed * 1.7 ) + 0.6 * cos( c.y * 43.0 - time * 15.0 + vSeed );
            off = vec2( n1, n2 ) * fall * vS;
          } else {
            vec2 q = c;
            if ( vK > 1.5 ) q.y /= ${GROUND_SQUASH.toFixed(2)};
            float r = length( q ) * 2.0;
            float d = ( r - 0.8 ) / 0.13;
            float prof = exp( -d * d ) * step( r, 1.0 );
            off = q / max( length( q ), 1e-3 ) * prof * vS;
            if ( vK > 1.5 ) off.y *= ${GROUND_SQUASH.toFixed(2)};
          }
          gl_FragColor = vec4( off, 0.0, 1.0 );
        }`,
    });
    const pts = new THREE.Points(this.geo, this.mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
  }

  get active() {
    return this.count;
  }

  /** Pixels per world unit at full resolution (same as the particle point scale). */
  setScale(s: number) {
    this.mat.uniforms.scale.value = s * RES;
  }

  setSize(w: number, h: number) {
    this.rt.setSize(Math.max(4, Math.round(w * RES)), Math.max(4, Math.round(h * RES)));
  }

  private add(x: number, y: number, z: number, kind: number, s0: number, s1: number, strength: number, life: number, vy: number) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.kind[i] = kind;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.size[i] = s0;
    this.a0[i] = strength;
    this.str[i] = 0;
    this.life[i] = 0;
    this.maxLife[i] = life;
    this.seed[i] = Math.random() * 50;
    this.vy[i] = vy;
  }

  /** Heat shimmer blob (size = diameter in tiles). */
  heat(x: number, y: number, z: number, size: number, life: number, strength = 0.0035, rise = 0.6) {
    this.add(x, y, z, 0, size, size * 1.3, strength, life, rise);
  }

  /** Expanding shockwave ring of final radius r (tiles). flat = on the ground. */
  ring(x: number, y: number, z: number, r: number, life: number, strength = 0.012, flat = true) {
    const d = (2 * r) / 0.8;
    this.add(x, y, z, flat ? 2 : 1, d * 0.1, d, strength, life, 0);
  }

  update(dt: number) {
    this.time += dt;
    this.mat.uniforms.time.value = this.time;
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        const j = --this.count;
        if (i !== j) {
          this.pos.copyWithin(i * 3, j * 3, j * 3 + 3);
          for (const a of this.ones) a[i] = a[j];
        }
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      if (this.kind[i] < 0.5) {
        this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
        this.str[i] = this.a0[i] * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
        this.pos[i * 3 + 1] += this.vy[i] * dt;
      } else {
        const e = 1 - (1 - t) * (1 - t);
        this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * e;
        this.str[i] = this.a0[i] * (1 - t) * (1 - t);
      }
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    for (const k in this.geo.attributes) (this.geo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Render the distortion buffer; returns its texture, or null when there is nothing to distort. */
  render(renderer: THREE.WebGLRenderer): THREE.Texture | null {
    if (!this.count) return null;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.autoClear = prevAuto;
    return this.rt.texture;
  }
}
