import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { gridSectors, radialSectors, splitInstancesBySector, splitMeshBySector } from '../src/render/sectors';

/** Every triangle of a (piece of a) geometry as a sorted list of vertex position strings. */
function triangles(meshes: THREE.Mesh[]): string[] {
  const out: string[] = [];
  for (const m of meshes) {
    const g = m.geometry;
    const p = g.attributes.position;
    const c = g.attributes.color;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    const s = g.drawRange.start;
    const e = Math.min(n, s + (g.drawRange.count === Infinity ? n : g.drawRange.count));
    for (let i = s; i < e; i += 3) {
      const t: string[] = [];
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx.getX(i + k) : i + k;
        t.push([p.getX(v), p.getY(v), p.getZ(v), c ? c.getX(v) : 0].map((x) => x.toFixed(4)).join(','));
      }
      out.push(t.join('|'));
    }
  }
  return out.sort();
}

function inBounds(meshes: THREE.Mesh[]) {
  for (const m of meshes) {
    const g = m.geometry;
    const p = g.attributes.position;
    const idx = g.index;
    const s = g.drawRange.start;
    const e = s + g.drawRange.count;
    const v = new THREE.Vector3();
    for (let i = s; i < e; i++) {
      v.fromBufferAttribute(p, idx ? idx.getX(i) : i);
      expect(g.boundingSphere!.distanceToPoint(v)).toBeLessThan(1e-4);
    }
  }
}

describe('sector split', () => {
  const plane = () => {
    const g = new THREE.PlaneGeometry(200, 200, 40, 40).rotateX(-Math.PI / 2);
    const col = new Float32Array(g.attributes.position.count * 3).map((_, i) => (i % 7) / 7);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };

  it('indexed: same triangles, shared buffers, tight spheres', () => {
    const mesh = new THREE.Mesh(plane(), new THREE.MeshBasicMaterial());
    mesh.name = 'ground';
    mesh.receiveShadow = true;
    const parts = splitMeshBySector(mesh, gridSectors(50));
    expect(parts.length).toBe(16);
    expect(triangles(parts)).toEqual(triangles([mesh]));
    for (const p of parts) {
      expect(p.geometry.attributes.position).toBe(mesh.geometry.attributes.position);
      expect(p.material).toBe(mesh.material);
      expect(p.name).toBe('ground');
      expect(p.receiveShadow).toBe(true);
      expect(p.geometry.boundingSphere!.radius).toBeLessThan(40);
    }
    inBounds(parts);
  });

  it('non-indexed and radial sectors', () => {
    const mesh = new THREE.Mesh(plane().toNonIndexed(), new THREE.MeshBasicMaterial());
    const parts = splitMeshBySector(mesh, radialSectors(0, 0, 12, [60]));
    expect(parts.length).toBe(24);
    expect(triangles(parts)).toEqual(triangles([mesh]));
    inBounds(parts);
  });

  it('one sector: the mesh itself', () => {
    const mesh = new THREE.Mesh(plane(), new THREE.MeshBasicMaterial());
    expect(splitMeshBySector(mesh, () => 3)).toEqual([mesh]);
  });

  it('instanced: instances, colours and per-instance attributes kept in order', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const n = 300;
    const cell = new Float32Array(n).map((_, i) => i % 2);
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 1));
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), n);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      im.setMatrixAt(i, m.makeTranslation(Math.cos(i) * (20 + i), 0, Math.sin(i) * (20 + i)));
      im.setColorAt(i, new THREE.Color(i / n, 0.5, 1 - i / n));
    }
    const parts = splitInstancesBySector(im, radialSectors(0, 0, 8, [150]));
    expect(parts.length).toBeGreaterThan(8);
    const seen: string[] = [];
    for (const p of parts) {
      for (let k = 0; k < p.count; k++) {
        const a = p.instanceMatrix.array.slice(k * 16, k * 16 + 16);
        const c = p.instanceColor!.array.slice(k * 3, k * 3 + 3);
        const ce = (p.geometry.attributes.aCell as THREE.InstancedBufferAttribute).getX(k);
        seen.push([...a, ...c, ce].map((x) => x.toFixed(4)).join(','));
      }
      expect(p.geometry.attributes.position).toBe(geo.attributes.position);
    }
    const all: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = im.instanceMatrix.array.slice(i * 16, i * 16 + 16);
      const c = im.instanceColor!.array.slice(i * 3, i * 3 + 3);
      all.push([...a, ...c, cell[i]].map((x) => x.toFixed(4)).join(','));
    }
    expect(seen.sort()).toEqual(all.sort());
  });
});
