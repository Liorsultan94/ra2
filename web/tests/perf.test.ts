import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HIDE_INSTANCED, HIDE_LOD, applyLod, prepareLod, restoreMain, setCasting, setHidden } from '../src/render/perf/lod';
import { OccluderGrid } from '../src/render/perf/occlusion';
import { RingPool } from '../src/render/perf/ringpool';
import type { GameMap } from '../src/sim/map';

function flatMap(w: number, h: number): GameMap {
  return { w, h, tiles: new Uint8Array(w * h), heights: new Float32Array((w + 1) * (h + 1)), trees: new Uint8Array(w * h) } as unknown as GameMap;
}

describe('perf: layer-0 hide reasons', () => {
  it('a mesh is drawn again only once every reason is cleared', () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    setHidden(m, HIDE_LOD, true);
    setHidden(m, HIDE_INSTANCED, true);
    expect(m.layers.isEnabled(0)).toBe(false);
    setHidden(m, HIDE_INSTANCED, false);
    expect(m.layers.isEnabled(0)).toBe(false);
    setHidden(m, HIDE_LOD, false);
    expect(m.layers.isEnabled(0)).toBe(true);
    setHidden(m, HIDE_LOD, true);
    const g = new THREE.Group().add(m);
    restoreMain(g);
    expect(m.layers.isEnabled(0)).toBe(true);
  });

  it('LOD drops small parts at far zoom and keeps team colour parts', () => {
    const root = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.7), new THREE.MeshStandardMaterial({ color: 0x777755 }));
    const antenna = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.05, 0.01), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: 0x2f8fff }));
    for (const m of [hull, antenna, stripe]) {
      m.castShadow = true;
      root.add(m);
    }
    const info = prepareLod(root, 'vehicle', true, 0x2f8fff);
    expect(info.detail).toContain(antenna);
    expect(info.detail).not.toContain(stripe);
    expect(info.detail).not.toContain(hull);
    // medium: the tiny antenna no longer casts into the shadow map
    expect(antenna.castShadow).toBe(false);
    expect(hull.castShadow).toBe(true);
    applyLod(info, 5); // a few px on screen
    expect(antenna.layers.isEnabled(0)).toBe(false);
    applyLod(info, 200);
    expect(antenna.layers.isEnabled(0)).toBe(true);
    setCasting(info, false);
    expect(hull.castShadow).toBe(false);
    setCasting(info, true);
    expect(hull.castShadow).toBe(true);
  });

  it('infantry never cast sun shadows on medium', () => {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), new THREE.MeshStandardMaterial());
    body.castShadow = true;
    root.add(body);
    prepareLod(root, 'infantry', true, 0xff0000);
    expect(body.castShadow).toBe(false);
    const root2 = new THREE.Group();
    const body2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), new THREE.MeshStandardMaterial());
    body2.castShadow = true;
    root2.add(body2);
    prepareLod(root2, 'infantry', false, 0xff0000);
    expect(body2.castShadow).toBe(true);
  });
});

describe('perf: x-ray occluder grid', () => {
  const dir = new THREE.Vector3(1, 1.1, 1).normalize();
  it('open ground hides nothing; a building between unit and camera may', () => {
    const map = flatMap(32, 32);
    const g = new OccluderGrid(map, []);
    expect(g.mayHide(10.5, 0, 10.5, dir.x, dir.y, dir.z)).toBe(false);
    g.setBuildings([{ id: 1, tx: 11, ty: 11, w: 2, h: 2, height: 1.5 }]);
    expect(g.mayHide(10.5, 0, 10.5, dir.x, dir.y, dir.z)).toBe(true);
    // the building behind the unit (away from the camera) can't hide it
    expect(g.mayHide(15.5, 0, 15.5, dir.x, dir.y, dir.z)).toBe(false);
  });
  it('trees count as occluders', () => {
    const map = flatMap(32, 32);
    const g = new OccluderGrid(map, [{ x: 12, y: 12, s: 1 }]);
    expect(g.mayHide(11.2, 0, 11.2, dir.x, dir.y, dir.z)).toBe(true);
    expect(g.mayHide(20.5, 0, 5.5, dir.x, dir.y, dir.z)).toBe(false);
  });
});

describe('perf: instanced rings', () => {
  it('rings live for their lifetime and are drawn in two instanced batches', () => {
    const pool = new RingPool(new THREE.RingGeometry(0.9, 1, 8), 16);
    pool.ring(1, 0, 1, 0.2, 2, 0.5, 0xffffff, true, 0.5);
    pool.ring(2, 0, 2, 0.2, 2, 1, 0xffffff, false, 0.5);
    pool.update(0.1);
    const [add, norm] = pool.group.children as THREE.InstancedMesh[];
    expect(add.count).toBe(1);
    expect(norm.count).toBe(1);
    pool.update(0.5);
    expect(add.count).toBe(0);
    expect(add.visible).toBe(false);
    expect(norm.count).toBe(1);
    for (let i = 0; i < 40; i++) pool.ring(0, 0, 0, 0.1, 1, 2, 0xff0000, true, 1);
    pool.update(0.01);
    expect(add.count).toBe(16);
  });
});
