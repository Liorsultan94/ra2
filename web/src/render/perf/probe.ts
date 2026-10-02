import * as THREE from 'three';

/**
 * Frame cost probe (debug / benchmark only, zero cost until enable()).
 *
 * Wraps WebGLRenderer.render / renderBufferDirect / shadowMap.render to
 * tally draw calls and triangles per render pass (main view, shadow maps,
 * outline mask, AO normals, reflection, drone feed, post quads...) and per
 * scene category (units, buildings, terrain chunks, vegetation, effects...),
 * and times the renderer's CPU systems. Read by the benchmark script
 * (window.ironfront.game.renderer.perf) and the ?perf=1 overlay.
 */

type Tally = { calls: number; tris: number };

/** Category of a drawn object: the nearest userData.perfCat up the parent chain, else "<scene child>/<its child>" names. */
function catOf(o: THREE.Object3D, scene: THREE.Object3D): string {
  let prev: THREE.Object3D | null = null;
  for (let p: THREE.Object3D | null = o; p; prev = p, p = p.parent) {
    const c = p.userData.perfCat as string | undefined;
    if (c) return c;
    if (p.parent === scene || !p.parent) {
      const top = p.name || p.type;
      return prev && prev.name ? `${top}/${prev.name}` : top;
    }
  }
  return '?';
}

function trisOf(geometry: THREE.BufferGeometry, object: THREE.Object3D, group: { count: number } | null): number {
  const idx = geometry.index;
  let n = group ? group.count : idx ? idx.count : (geometry.attributes.position?.count ?? 0);
  const dr = geometry.drawRange;
  if (!group && dr.count !== Infinity) n = Math.min(n, dr.count);
  const m = object as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; count?: number; isInstancedMesh?: boolean; isBatchedMesh?: boolean };
  if (m.isPoints || m.isLine) return 0;
  let inst = 1;
  if (m.isInstancedMesh) inst = m.count ?? 1;
  else if ((geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry) inst = (geometry as THREE.InstancedBufferGeometry).instanceCount;
  if (!Number.isFinite(inst)) inst = 1;
  return (n / 3) * inst;
}

export class PerfProbe {
  private installed = false;
  enabled = false;
  frames = 0;
  passes = new Map<string, Tally>();
  cats = new Map<string, Tally>();
  sys = new Map<string, number>();
  private pass = 'other';
  /** Names for secondary cameras (drone feed, reflection...). */
  readonly names = new WeakMap<THREE.Camera, string>();
  private depth = 0;

  constructor(
    private gl: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {}

  /** Start collecting (installs the wrappers once). */
  enable(systems?: Record<string, { obj: object; fn: string }>) {
    this.enabled = true;
    if (this.installed) return;
    this.installed = true;
    const gl = this.gl;
    const self = this;
    const render = gl.render.bind(gl);
    gl.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
      if (!self.enabled) return render(scene, camera);
      const prev = self.pass;
      self.pass = self.label(scene, camera);
      self.depth++;
      const t0 = performance.now();
      render(scene, camera);
      if (self.depth === 1) self.add(self.sys, 'gl.render (submit)', performance.now() - t0);
      self.depth--;
      self.pass = prev;
    };
    const sm = gl.shadowMap as THREE.WebGLShadowMap & { render: (...a: unknown[]) => void };
    const shadowRender = sm.render.bind(sm);
    sm.render = (...a: unknown[]) => {
      const prev = self.pass;
      self.pass = 'shadow';
      shadowRender(...a);
      self.pass = prev;
    };
    const rbd = gl.renderBufferDirect.bind(gl);
    gl.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      rbd(camera, scene, geometry, material, object, group);
      if (!self.enabled) return;
      const tris = trisOf(geometry, object, group);
      const pass = scene === null && self.pass !== 'shadow' ? 'shadow' : self.pass;
      self.tally(self.passes, pass, tris);
      if (pass === 'main' || pass === 'shadow' || pass === 'outline' || pass === 'ao' || pass.startsWith('other-cam')) self.tally(self.cats, `${pass}:${catOf(object, self.scene)}`, tris);
    };
    if (systems)
      for (const [name, s] of Object.entries(systems)) {
        const o = s.obj as Record<string, unknown>;
        const f = o[s.fn];
        if (typeof f !== 'function') continue;
        o[s.fn] = function (this: unknown, ...a: unknown[]) {
          if (!self.enabled) return (f as (...x: unknown[]) => unknown).apply(this, a);
          const t0 = performance.now();
          const r = (f as (...x: unknown[]) => unknown).apply(this, a);
          self.add(self.sys, name, performance.now() - t0);
          return r;
        };
      }
  }

  disable() {
    this.enabled = false;
  }

  reset() {
    this.frames = 0;
    this.passes.clear();
    this.cats.clear();
    this.sys.clear();
  }

  /** Call once per rendered frame. */
  frame() {
    if (this.enabled) this.frames++;
  }

  private label(scene: THREE.Object3D, camera: THREE.Camera): string {
    const sc = scene as THREE.Scene;
    if (scene !== this.scene) return 'aux:' + (scene.name || (sc.children.length === 1 ? (sc.children[0].name || sc.children[0].type) : 'scene'));
    if (camera.name) return camera.name;
    if (sc.overrideMaterial) {
      if ((sc.overrideMaterial as THREE.ShaderMaterial).userData?.outlineMask) return 'outline';
      return 'ao';
    }
    if (camera !== this.camera) {
      return this.names.get(camera) ?? (camera.layers.mask !== this.camera.layers.mask ? 'other-cam/layers' : 'other-cam');
    }
    if (camera.layers.mask !== (this.camera.layers.mask | 0)) return 'outline';
    return 'main';
  }

  private add(m: Map<string, number>, k: string, v: number) {
    m.set(k, (m.get(k) ?? 0) + v);
  }

  private tally(m: Map<string, Tally>, k: string, tris: number) {
    let t = m.get(k);
    if (!t) m.set(k, (t = { calls: 0, tris: 0 }));
    t.calls++;
    t.tris += tris;
  }

  /** Per-frame averages since the last reset. */
  snapshot() {
    const n = Math.max(1, this.frames);
    const per = (m: Map<string, Tally>) =>
      Object.fromEntries(
        [...m.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([k, v]) => [k, { calls: Math.round((v.calls / n) * 10) / 10, tris: Math.round(v.tris / n) }]),
      );
    let calls = 0;
    let tris = 0;
    for (const v of this.passes.values()) {
      calls += v.calls;
      tris += v.tris;
    }
    return {
      frames: this.frames,
      calls: Math.round(calls / n),
      tris: Math.round(tris / n),
      programs: this.gl.info.programs?.length ?? 0,
      passes: per(this.passes),
      cats: per(this.cats),
      sysMs: Object.fromEntries([...this.sys.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / n) * 100) / 100])),
    };
  }
}
