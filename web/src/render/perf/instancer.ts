import * as THREE from 'three';
import { HIDE_INSTANCED, setHidden } from './lod';

/**
 * Automatic per-frame instancing of unit meshes (draw call reduction).
 *
 * Unit models are clones of cached templates: every tank of a type and team
 * shares the same geometry + material per part. Each frame, after the world
 * matrices are up to date, the visible units' plain meshes are grouped by
 * (geometry, material, shadow flags, render order) and every group is drawn as
 * one InstancedMesh whose instance matrices are copied from the meshes'
 * current world matrices. The original meshes leave layer 0 (main view and
 * shadow pass) for that frame but stay in the scene graph, so the model
 * builders' animation (turrets, recoil, wheels, rotors, bobbing...) keeps
 * working untouched and the outline mask, heat mask and x-ray proxies still
 * use them.
 *
 * Skinned, morphed, transparent, multi-material, LOD-hidden and hooked
 * (custom onBeforeRender) meshes are left alone. A group only starts being
 * instanced once its instanced shader variant has compiled in the background
 * (compileAsync), so a new unit type never causes a compile hitch.
 */

interface Pool {
  mesh: THREE.InstancedMesh;
  cap: number;
  ready: boolean;
  members: THREE.Mesh[];
}

const noopBR = THREE.Object3D.prototype.onBeforeRender;

/** Per-mesh cache (stored on the mesh as `__pfi`): the pool for its current signature and its hidden state. */
interface MeshState {
  g: THREE.BufferGeometry;
  mat: THREE.Material;
  cs: boolean;
  rs: boolean;
  ro: number;
  /** Eligible for instancing (static checks for this geometry / material). */
  ok: boolean;
  pool: Pool | null;
  /** Frame it was last drawn through a pool. */
  f: number;
  hid: boolean;
}
type Tracked = THREE.Mesh & { __pfi?: MeshState };
const ids = new WeakMap<object, number>();
let nextId = 1;
/** Stable small id per material object (three's runtime ids aren't typed for materials). */
function uid(o: object): number {
  let i = ids.get(o);
  if (i === undefined) ids.set(o, (i = nextId++));
  return i;
}

export class AutoInstancer {
  readonly group = new THREE.Group();
  enabled = true;
  private pools = new Map<string, Pool>();
  private used: Pool[] = [];
  private hidden: Tracked[] = [];
  private nextHidden: Tracked[] = [];
  private frame = 0;
  /** Draw calls saved last frame (meshes merged into instanced draws minus the draws). */
  saved = 0;

  constructor(
    private gl: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    /** onBeforeRender hooks that are safe to ignore (the outline mask's colour hook). */
    private allowHook: (m: THREE.Mesh) => boolean = () => false,
  ) {
    this.group.name = 'instanced';
    this.group.userData.perfCat = 'instanced';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
  }

  /** Put every mesh hidden by the instancer back on layer 0. */
  restore() {
    for (const m of this.hidden) {
      const st = m.__pfi;
      if (st) st.hid = false;
      setHidden(m, HIDE_INSTANCED, false);
    }
    this.hidden.length = 0;
  }

  /**
   * Rebuild the instanced draws from these model roots (world matrices must be current).
   * Roots should be visible and on (or casting into) the view.
   */
  update(roots: Iterable<THREE.Object3D>) {
    for (const p of this.used) p.members.length = 0;
    this.used.length = 0;
    if (!this.enabled) {
      this.restore();
      for (const p of this.pools.values()) p.mesh.visible = false;
      return;
    }
    const f = ++this.frame;
    for (const root of roots) this.collect(root, root);
    const next = this.nextHidden;
    next.length = 0;
    let saved = 0;
    for (const p of this.pools.values()) {
      const n = p.members.length;
      if (!p.ready || n === 0) {
        p.mesh.count = 0;
        p.mesh.visible = false;
        p.members.length = 0;
        continue;
      }
      if (n > p.cap) this.grow(p, n);
      const arr = p.mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const m = p.members[i] as Tracked;
        arr.set(m.matrixWorld.elements, i * 16);
        const st = m.__pfi!;
        st.f = f;
        if (!st.hid) {
          st.hid = true;
          setHidden(m, HIDE_INSTANCED, true);
        }
        next.push(m);
      }
      p.mesh.count = n;
      p.mesh.visible = true;
      const im = p.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      this.used.push(p);
      saved += n - 1;
    }
    // meshes drawn through a pool last frame but not this one go back on layer 0
    for (const m of this.hidden) {
      const st = m.__pfi;
      if (st && st.hid && st.f !== f) {
        st.hid = false;
        setHidden(m, HIDE_INSTANCED, false);
      }
    }
    this.nextHidden = this.hidden;
    this.hidden = next;
    this.saved = saved;
  }

  private collect(o: THREE.Object3D, root: THREE.Object3D) {
    if (!o.visible) return;
    if ((o as THREE.Mesh).isMesh && o !== root) this.consider(o as Tracked);
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) this.collect(ch[i], root);
  }

  private consider(m: Tracked) {
    // hidden for another reason (far-zoom LOD)
    const hide = m.userData.hide as number | undefined;
    if (hide && hide & ~HIDE_INSTANCED) return;
    const mat = m.material as THREE.Material;
    const g = m.geometry;
    let st = m.__pfi;
    if (!st || st.g !== g || st.mat !== mat || st.cs !== m.castShadow || st.rs !== m.receiveShadow || st.ro !== m.renderOrder) {
      const ok =
        !(m as THREE.SkinnedMesh).isSkinnedMesh &&
        !(m as THREE.InstancedMesh).isInstancedMesh &&
        !(m as unknown as { isXray?: boolean }).isXray &&
        !!mat &&
        !Array.isArray(m.material) &&
        !mat.transparent &&
        !!g &&
        !g.morphAttributes.position &&
        !m.customDepthMaterial &&
        !m.customDistanceMaterial;
      const prev = st;
      st = { g, mat, cs: m.castShadow, rs: m.receiveShadow, ro: m.renderOrder, ok, pool: null, f: prev ? prev.f : 0, hid: prev ? prev.hid : false };
      if (ok) {
        const key = `${g.id}|${uid(mat)}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}`;
        st.pool = this.pools.get(key) ?? this.create(key, m);
      }
      m.__pfi = st;
    }
    if (!st.ok || !mat.visible || g.drawRange.count !== Infinity || g.drawRange.start !== 0) return;
    if (m.onBeforeRender !== noopBR && !this.allowHook(m)) return;
    st.pool!.members.push(m);
  }

  private create(key: string, m: THREE.Mesh): Pool {
    const mesh = new THREE.InstancedMesh(m.geometry, m.material as THREE.Material, 8);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = m.castShadow;
    mesh.receiveShadow = m.receiveShadow;
    mesh.renderOrder = m.renderOrder;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const p: Pool = { mesh, cap: 8, ready: false, members: [] };
    this.group.add(mesh);
    this.pools.set(key, p);
    // compile the instanced shader variant in the background; the originals draw until it is ready
    try {
      this.gl
        .compileAsync(mesh, this.camera, this.scene)
        .then(() => (p.ready = true))
        .catch(() => (p.ready = true));
    } catch {
      p.ready = true;
    }
    mesh.visible = false;
    return p;
  }

  private grow(p: Pool, n: number) {
    let cap = p.cap;
    while (cap < n) cap *= 2;
    const old = p.mesh;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = old.castShadow;
    mesh.receiveShadow = old.receiveShadow;
    mesh.renderOrder = old.renderOrder;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    p.mesh = mesh;
    p.cap = cap;
  }

  /** Number of live pools / instanced meshes drawn last frame (debug). */
  stats() {
    let inst = 0;
    for (const p of this.used) inst += p.members.length;
    return { pools: this.pools.size, draws: this.used.length, instances: inst, saved: this.saved };
  }

  dispose() {
    this.restore();
    for (const p of this.pools.values()) p.mesh.dispose();
    this.pools.clear();
    this.group.removeFromParent();
  }
}
