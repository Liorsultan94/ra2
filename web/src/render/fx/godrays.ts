import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/*
 * Crepuscular rays through smoke (high quality only).
 *
 * 1. The smoke particles are drawn once more, as plain density, into a
 *    quarter-resolution buffer.
 * 2. A rays pass marches that buffer from each pixel towards the sun's
 *    screen direction and accumulates how much smoke the light had to cross
 *    on the way (transmittance). Smoke that light reaches glows a little
 *    (in-scatter on the lit side), and the haze behind dense smoke falls into
 *    shadow - light / shadow shafts streaming away from the sun.
 * 3. The final post pass adds the (signed) result in linear HDR before tone
 *    mapping. Scaled by the sun's strength, so it is off at night and faint
 *    under rain.
 */

const RAYS_FRAG = /* glsl */ `
  uniform sampler2D tDens;
  uniform vec2 uDir;      // screen-space step towards the sun (uv per sample)
  uniform vec3 uCol;
  uniform float uOn;
  varying vec2 vUv;
  void main() {
    float d0 = texture2D( tDens, vUv ).r;
    float occ = 0.0;
    float j = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    vec2 p = vUv + uDir * j;
    for ( int i = 0; i < 20; i++ ) {
      p += uDir;
      float w = 1.0 - float( i ) / 20.0;
      vec2 inb = step( vec2( 0.0 ), p ) * step( p, vec2( 1.0 ) );
      occ += texture2D( tDens, p ).r * w * inb.x * inb.y;
    }
    float T = exp( -occ * 0.55 );
    // in-scatter: thin / mid smoke that the sun reaches lights up; haze behind dense smoke is shadowed
    float scatter = smoothstep( 0.02, 0.5, d0 ) * ( 1.0 - smoothstep( 0.9, 2.5, d0 ) );
    float shaft = scatter * T * 0.55 - ( 1.0 - T ) * ( 0.1 + 0.25 * min( d0, 1.0 ) );
    gl_FragColor = vec4( uCol * shaft * uOn, 1.0 );
  }
`;

export class GodRays {
  private dens: THREE.WebGLRenderTarget;
  private rays: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private quad: FullScreenQuad;
  private mat: THREE.ShaderMaterial;
  private col = new THREE.Vector3();
  private strength = 0;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private clear = new THREE.Color();

  /** Overall strength multiplier (subtle by default). */
  intensity = 0.55;

  constructor(
    private camera: THREE.Camera,
    density: THREE.Points,
  ) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.dens = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rays = new THREE.WebGLRenderTarget(1, 1, opts);
    this.scene.add(density);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tDens: { value: this.dens.texture }, uDir: { value: new THREE.Vector2() }, uCol: { value: this.col }, uOn: { value: 1 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: RAYS_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  setSize(w: number, h: number) {
    const W = Math.max(1, Math.round(w / 4));
    const H = Math.max(1, Math.round(h / 4));
    this.dens.setSize(W, H);
    this.rays.setSize(W, H);
  }

  /** Sun direction (towards the sun), its colour (already scaled by intensity) and a 0..1 daylight factor. */
  setSun(dir: THREE.Vector3, col: THREE.Vector3, day: number) {
    this.sunDir.copy(dir);
    this.col.copy(col).multiplyScalar(this.intensity * day);
    this.strength = day * this.intensity;
  }

  /** Render the rays buffer (null when there is nothing to add). */
  render(renderer: THREE.WebGLRenderer): THREE.Texture | null {
    if (this.strength < 0.02) return null;
    // screen direction towards the sun: project the view centre and a point a little sunwards of it
    const cam = this.camera;
    cam.getWorldDirection(this.a);
    const c = this.a.multiplyScalar(12).add(cam.position);
    this.b.copy(c).addScaledVector(this.sunDir, 2).project(cam);
    c.project(cam);
    let dx = this.b.x - c.x;
    let dy = this.b.y - c.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-4) return null;
    // ~0.3 of the screen height of march, in uv units
    const step = 0.3 / 20;
    dx = (dx / l) * step * (this.dens.height / Math.max(1, this.dens.width));
    dy = (dy / l) * step;
    this.mat.uniforms.uDir.value.set(dx, dy);
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.setRenderTarget(this.dens);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, cam);
    renderer.setRenderTarget(this.rays);
    this.quad.render(renderer);
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
    return this.rays.texture;
  }
}
