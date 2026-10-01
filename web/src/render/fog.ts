import * as THREE from 'three';

/**
 * Fog of war is a small W x H texture (0 = unexplored, ~0.5 = explored,
 * 1 = visible) sampled in world space by every lit material via a shader
 * patch, which gives soft, smooth shroud edges for free.
 */
export class FogOfWar {
  readonly texture: THREE.DataTexture;
  readonly uniforms: { fogTex: { value: THREE.Texture }; fogSize: { value: THREE.Vector2 }; fogEnabled: { value: number } };
  private data: Uint8Array;
  private cur: Float32Array;

  constructor(
    private w: number,
    private h: number,
  ) {
    this.data = new Uint8Array(w * h);
    this.cur = new Float32Array(w * h);
    this.texture = new THREE.DataTexture(this.data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this.uniforms = {
      fogTex: { value: this.texture },
      fogSize: { value: new THREE.Vector2(w, h) },
      fogEnabled: { value: 1 },
    };
  }

  update(explored: Uint8Array, visible: Uint8Array, dt: number, snap = false) {
    const k = snap ? 1 : Math.min(1, dt * 5);
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const target = visible[i] ? 1 : explored[i] ? 0.5 : 0;
      const c = this.cur[i] + (target - this.cur[i]) * k;
      this.cur[i] = c;
      this.data[i] = (c * 255) | 0;
    }
    this.texture.needsUpdate = true;
  }

  revealAll() {
    this.cur.fill(1);
    this.data.fill(255);
    this.texture.needsUpdate = true;
  }

  /** Patch a built-in material so it darkens under the shroud. */
  apply<T extends THREE.Material>(mat: T): T {
    const uniforms = this.uniforms;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFogW;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 fogWp = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            fogWp = instanceMatrix * fogWp;
          #endif
          fogWp = modelMatrix * fogWp;
          vFogW = fogWp.xz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vFogW;
          uniform sampler2D fogTex;
          uniform vec2 fogSize;
          uniform float fogEnabled;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `float fogV = texture2D( fogTex, vFogW / fogSize ).r;
          float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + ( fogV - 0.5 ) * 1.1;
          outgoingLight *= mix( 1.0, fogK, fogEnabled );
          #include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'fog';
    return mat;
  }
}
