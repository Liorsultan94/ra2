import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Cheap screen-space tilt-shift ("miniature" depth of field): a single
 * 16-tap golden-angle disc blur whose radius grows towards the top and
 * bottom of the screen, leaving a sharp horizontal band in the middle.
 * Runs after the final grade pass, so it blurs display-ready colours.
 */
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    amount: { value: 0 }, // 0..1
    maxRadius: { value: 5.0 }, // pixels at full amount (at the very top / bottom edge)
    band: { value: new THREE.Vector2(0.18, 0.5) }, // sharp half-height, fully blurred at
    centre: { value: 0.52 }, // vertical focus line (uv.y), slightly above the middle
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float amount;
    uniform float maxRadius;
    uniform vec2 band;
    uniform float centre;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      float d = abs( vUv.y - centre );
      float k = smoothstep( band.x, band.y, d ) * amount;
      if ( k < 0.02 ) { gl_FragColor = base; return; }
      vec2 px = 1.0 / resolution;
      float r = k * maxRadius;
      vec3 acc = base.rgb;
      float wsum = 1.0;
      // golden-angle spiral
      for ( int i = 1; i < 16; i++ ) {
        float fi = float( i );
        float rr = sqrt( fi / 15.0 ) * r;
        float a = fi * 2.39996323;
        vec2 o = vec2( cos( a ), sin( a ) ) * rr * px;
        acc += texture2D( tDiffuse, vUv + o ).rgb;
        wsum += 1.0;
      }
      gl_FragColor = vec4( acc / wsum, base.a );
    }`,
};

export class TiltShiftPass extends ShaderPass {
  constructor() {
    super(TiltShiftShader);
    this.enabled = false;
  }

  setSize(width: number, height: number) {
    this.uniforms.resolution.value.set(width, height);
  }

  /** Blur strength from the camera zoom: off when zoomed out, subtle when close in. */
  setZoom(zoom: number, defaultZoom: number, pixelRatio: number) {
    const k = THREE.MathUtils.smoothstep(zoom / Math.max(0.01, defaultZoom), 0.95, 1.7);
    this.uniforms.amount.value = k;
    this.uniforms.maxRadius.value = 4.5 * pixelRatio;
    this.enabled = k > 0.02;
  }
}
