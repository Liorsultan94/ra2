import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { INFANTRY } from '../src/render/models/infantry';
import { applyLod, lodGeos, prepareLod } from '../src/render/perf/lod';
import type { AnimState } from '../src/render/models/types';

// minimal canvas stand-in for the procedural texture generators (node has no DOM)
if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  const ctx = new Proxy(
    {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    } as Record<string, unknown>,
    { get: (t, k: string) => (k in t ? t[k] : () => undefined) },
  );
  (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
}

const style = (faction: string) => ({ team: 0x2f6fd0, hull: 0x777755, accent: 0x333333, flag: 0, faction, region: 'west' }) as never;
/** Bounds of the vertices a geometry's index actually uses (body-space metres). */
function box(g: THREE.BufferGeometry) {
  const b = new THREE.Box3();
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const ix = g.index!;
  for (let i = 0; i < ix.count; i++) b.expandByPoint(v.fromBufferAttribute(p, ix.getX(i)));
  return b;
}
const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
const base = (): AnimState => ({ dt: 0.033, time: 1, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true, seed: 3, lod: 0 });

describe('infantry: hero / battle / far geometry LODs', () => {
  for (const key of ['rifle', 'at', 'engineer', 'mortar', 'fpvteam', 'ewinf', 'medic']) {
    it(`${key}: every skinned mesh has LOD1 / LOD2 index subsets, fewer triangles each step`, () => {
      const m = INFANTRY[key](style(key === 'rifle' ? 'iran' : key === 'at' ? 'israel' : 'russia'), null);
      const t = [0, 0, 0];
      let n = 0;
      m.root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (!sm.isSkinnedMesh) return;
        const l = lodGeos(sm.geometry);
        expect(l).not.toBeNull();
        n++;
        t[0] += tris(sm.geometry);
        t[1] += tris(l![0]);
        t[2] += tris(l![1]);
        // subsets share the vertex buffer
        expect(l![0].attributes.position).toBe(sm.geometry.attributes.position);
        // stand-ins sit where the hero parts are (no stray / floating pieces)
        const b0 = box(sm.geometry).expandByScalar(0.03);
        for (const g of l!) {
          const b = box(g);
          if (!b.isEmpty()) expect(b0.containsBox(b)).toBe(true);
        }
      });
      expect(n).toBeGreaterThan(4);
      expect(t[1]).toBeLessThan(t[0] * 0.6);
      expect(t[2]).toBeLessThanOrEqual(t[1]);
      // soldier budget (mortar team = two men + mortar)
      const k = key === 'mortar' ? 2.4 : 1;
      expect(t[0]).toBeLessThan(6000 * k);
      expect(t[1]).toBeLessThan(2400 * k);
      expect(t[2]).toBeLessThan(2000 * k);
    });
  }

  it('the renderer LOD switch swaps infantry geometry by on-screen size', () => {
    const m = INFANTRY.rifle(style('usa'), null);
    m.root.scale.setScalar(1.4);
    const info = prepareLod(m.root, 'infantry', false, 0x2f6fd0);
    expect(info.swaps.length).toBeGreaterThan(4);
    applyLod(info, 1000);
    expect(info.level).toBe(0);
    applyLod(info, 60);
    expect(info.level).toBe(1);
    applyLod(info, 5);
    expect(info.level).toBe(2);
    applyLod(info, 1000);
    expect(info.level).toBe(0);
  });

  it('every nation builds and poses (run, aim, kneel, dive, prone death, crushed) without NaNs', () => {
    for (const f of ['usa', 'israel', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran']) {
      for (const key of ['rifle', 'at']) {
        const m = INFANTRY[key](style(f), null);
        const states: Partial<AnimState>[] = [{ moving: true, speed: 1.3, dist: 0.5 }, { fired: 0.05 }, { fired: 0.05, alt: 1, elev: 0.9, aim: 1 }, { alt: 1, dead: 1 }, { fired: 0.5, dig: 3 }, { dive: 0.4 }, { dead: 2 }, { dead: 0.5, crushed: 1 }];
        for (const st of states) {
          const a = { ...base(), ...st };
          for (let i = 0; i < 5; i++) {
            a.time += 0.033;
            m.anim!(a);
          }
          m.root.updateMatrixWorld(true);
          m.root.traverse((o) => {
            for (const v of o.matrixWorld.elements) expect(Number.isFinite(v)).toBe(true);
          });
        }
      }
    }
  });

  it('wounded soldiers lie on the ground and get back up; a medic kneels to treat (sim/medic.ts)', () => {
    const hipsY = (m: ReturnType<(typeof INFANTRY)['rifle']>, p = 'a') => {
      m.root.updateMatrixWorld(true);
      return m.root.getObjectByName(p + 'hips')!.getWorldPosition(new THREE.Vector3()).y;
    };
    const run = (m: ReturnType<(typeof INFANTRY)['rifle']>, st: Partial<AnimState>, n: number, from = 1) => {
      const a = { ...base(), ...st };
      for (let i = 0; i < n; i++) {
        a.time = from + i * 0.033;
        if (st.wounded) a.wounded = st.wounded + i * 0.033;
        if (st.treat) a.treat = st.treat + i * 0.033;
        m.anim!(a);
      }
      m.root.updateMatrixWorld(true);
      m.root.traverse((o) => {
        for (const v of o.matrixWorld.elements) expect(Number.isFinite(v)).toBe(true);
      });
    };
    for (const key of ['rifle', 'at', 'sniper', 'medic', 'mortar']) {
      const m = INFANTRY[key](style('usa'), null);
      const p = key === 'mortar' ? 'g' : 'a';
      run(m, {}, 10);
      const stand = hipsY(m, p);
      // down wounded: on his back, an arm moving now and then (several gesture cycles)
      run(m, { wounded: 0.01 }, 300);
      const lying = hipsY(m, p);
      expect(lying).toBeLessThan(stand * 0.4);
      // bled out: stays where he lies (no second fall)
      run(m, { wounded: 10, dead: 0.2 }, 20);
      expect(Math.abs(hipsY(m, p) - lying)).toBeLessThan(stand * 0.15);
      // a fresh one treated: back on his feet within ~1.5 s
      const m2 = INFANTRY[key](style('usa'), null);
      run(m2, { wounded: 0.01 }, 120);
      run(m2, {}, 50, 10);
      expect(hipsY(m2, p)).toBeGreaterThan(stand * 0.85);
    }
    // medic at work: kneeling
    const md = INFANTRY.medic(style('china'), null);
    run(md, {}, 10);
    const up = hipsY(md);
    run(md, { treat: 0.1 }, 90);
    expect(hipsY(md)).toBeLessThan(up * 0.75);
    run(md, {}, 90, 10);
    expect(hipsY(md)).toBeGreaterThan(up * 0.9);
  });
});
