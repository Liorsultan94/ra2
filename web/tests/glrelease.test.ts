import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { releaseMaterialListeners } from '../src/render/glrelease';

const listeners = (m: THREE.Material) => ((m as unknown as { _listeners?: Record<string, unknown[]> })._listeners?.dispose ?? []).slice();

describe('releaseMaterialListeners', () => {
  it("takes a finished renderer's listener off shared materials and leaves the others", () => {
    // two "renderers": the finished match's and one that lives on (a cameo / the next match)
    const oldR = () => {};
    const liveR = () => {};
    const shared = new THREE.MeshStandardMaterial();
    const offScene = new THREE.MeshBasicMaterial(); // a session cache's material, not in the scene right now
    const own = [new THREE.MeshStandardMaterial(), new THREE.MeshLambertMaterial(), new THREE.MeshBasicMaterial()];
    for (const m of [shared, offScene, ...own]) m.addEventListener('dispose', oldR);
    shared.addEventListener('dispose', liveR);
    offScene.addEventListener('dispose', liveR);
    const scene = new THREE.Scene();
    const g = new THREE.BoxGeometry();
    for (const m of [shared, ...own]) scene.add(new THREE.Mesh(g, m));

    expect(releaseMaterialListeners(scene)).toBe(5);
    expect(listeners(shared)).toEqual([liveR]);
    expect(listeners(offScene)).toEqual([liveR]);
    for (const m of own) expect(listeners(m)).toEqual([]);
  });

  it('does nothing when no listener stands out', () => {
    const a = () => {};
    const b = () => {};
    const m1 = new THREE.MeshBasicMaterial();
    const m2 = new THREE.MeshBasicMaterial();
    m1.addEventListener('dispose', a);
    m2.addEventListener('dispose', b);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), m1), new THREE.Mesh(new THREE.BoxGeometry(), m2));
    expect(releaseMaterialListeners(scene)).toBe(0);
    expect(listeners(m1)).toEqual([a]);
    expect(listeners(m2)).toEqual([b]);
  });
});
