import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/*
 * Shared bits of the post-processing chain (src/render/post/*): render target
 * helpers, the full-screen vertex shader and depth reconstruction GLSL.
 */

/** Can this device render into half-float colour targets (HDR scene buffer, bloom mips)? */
export function halfFloatTargets(r: THREE.WebGLRenderer): boolean {
  try {
    const ext = r.extensions;
    return ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
  } catch {
    return false;
  }
}

/** A colour-only render target (no depth), linear filtered, no mipmaps. */
export function colorTarget(w: number, h: number, type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type, depthBuffer: false, stencilBuffer: false, minFilter: filter, magFilter: filter, generateMipmaps: false });
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

/** A full-screen shader material (no depth test, never tone mapped by three). */
export function fsMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines?: Record<string, string | number>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, defines: defines ?? {}, vertexShader: FS_VERT, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending });
}

/** One shared quad for every full-screen draw of the chain (the material is swapped per draw). */
export class Blitter {
  private quad = new FullScreenQuad();
  draw(r: THREE.WebGLRenderer, mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    r.setRenderTarget(target);
    this.quad.render(r);
  }
  dispose() {
    this.quad.dispose();
  }
}

/**
 * View-space position from a depth texture (perspective or orthographic, with
 * any projection jitter): needs `tDepth` and `projInv`.
 */
export const VIEWPOS_GLSL = /* glsl */ `
uniform highp sampler2D tDepth;
uniform mat4 projInv;
vec3 viewPosAt( vec2 uv, float d ) {
  vec4 p = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  return p.xyz / p.w;
}
vec3 viewPos( vec2 uv ) { return viewPosAt( uv, texture2D( tDepth, uv ).x ); }
`;

/** Linear depth (positive distance along the view axis) packed into two 8-bit channels (0..1 of `far`). */
export const PACK_GLSL = /* glsl */ `
vec2 packDepth16( float z ) {
  float v = floor( clamp( z, 0.0, 1.0 ) * 65535.0 + 0.5 );
  float hi = floor( v / 256.0 );
  return vec2( hi, v - hi * 256.0 ) / 255.0;
}
float unpackDepth16( vec2 p ) { return ( p.x * 255.0 * 256.0 + p.y * 255.0 ) / 65535.0; }
`;
