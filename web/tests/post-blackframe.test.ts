import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FinalPass } from '../src/render/post';
import { PostChain } from '../src/render/post/chain';
import { syncDepthSize } from '../src/render/post/util';

/** Just enough of a WebGLRenderer for the chain's CPU side (no GL in the test runner). */
function fakeRenderer(): THREE.WebGLRenderer {
  return {
    getPixelRatio: () => 1,
    getSize: (v: THREE.Vector2) => v.set(1, 1),
    setRenderTarget: () => {},
    getRenderTarget: () => null,
    render: () => {},
  } as unknown as THREE.WebGLRenderer;
}

describe('post chain: no black frames after a resize (phone quality steps)', () => {
  it('three leaves a resized target\'s depth texture at the old size; syncDepthSize puts it in step', () => {
    const rt = new THREE.WebGLRenderTarget(981, 600, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(981, 600) });
    rt.setSize(654, 400);
    // (this is what got uploaded, at 981 x 600, by a material still holding the depth texture)
    expect(rt.depthTexture!.image.width).toBe(981);
    expect(syncDepthSize(rt)).toBe(true);
    expect(rt.depthTexture!.image.width).toBe(654);
    expect(rt.depthTexture!.image.height).toBe(400);
    expect(syncDepthSize(rt)).toBe(false);
    expect(syncDepthSize(new THREE.WebGLRenderTarget(4, 4))).toBe(false);
  });

  it('both scene buffers of the composer keep their depth textures at the new size', () => {
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    const pc = new PostChain(fakeRenderer(), scene, cam, 'medium', false, null);
    for (const [w, h, pr] of [
      [377, 231, 2.6],
      [377, 231, 1.5],
      [377, 231, 1],
      [380, 200, 1],
    ] as const) {
      pc.setSize(w, h, pr);
      for (const rt of [pc.composer.renderTarget1, pc.composer.renderTarget2]) {
        expect(rt.depthTexture!.image.width).toBe(rt.width);
        expect(rt.depthTexture!.image.height).toBe(rt.height);
      }
    }
  });

  it('the final pass unbinds the inputs of passes that did not run (no stale depth texture in a sampler)', () => {
    const f = new FinalPass();
    const stale = new THREE.DepthTexture(981, 600);
    f.uniforms.tDepth.value = stale;
    f.uniforms.tAO.value = new THREE.Texture();
    f.uniforms.tBloom.value = new THREE.Texture();
    const rt = new THREE.WebGLRenderTarget(8, 8);
    f.render(fakeRenderer(), rt, rt);
    expect(f.uniforms.aoOn.value).toBe(0);
    expect(f.uniforms.tDepth.value).toBeNull();
    expect(f.uniforms.tAO.value).toBeNull();
    expect(f.uniforms.bloomOn.value).toBe(0);
    expect(f.uniforms.tBloom.value).toBeNull();
    // what the pass does read is untouched
    expect(f.uniforms.tDiffuse.value).toBe(rt.texture);
  });
});
