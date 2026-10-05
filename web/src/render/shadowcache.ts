import * as THREE from 'three';

/*
 * Static shadow caster cache for the sun's shadow map (not ultra's cascades).
 *
 * The sun shadow map is re-rendered every frame on high (every second one on
 * medium) because units move. Most of what casts into it does not: rocks,
 * houses, pylons, walls, bridges, field clutter. This keeps the depth those
 * static casters leave in the map in a second depth target and, while the
 * shadow camera stands still, starts each refresh by copying it back (one
 * depth blit) and then draws only the dynamic casters on top, without a clear.
 * The depth test keeps the nearest depth either way, so the resulting map is
 * exactly the one a full render produces: same shadows, same filtering.
 *
 * The cache is rebuilt whenever the shadow camera changes (pan, zoom, view
 * rotation, a sun step: see GameRenderer.fitShadow) or any static caster
 * changes: each refresh compares a small signature per caster (visibility,
 * geometry, material, instance count / data version, world matrix). Casters
 * that keep changing (swaying, bobbing, animated) are moved to the dynamic set
 * for good; casters with a custom depth material (wind-animated foliage) are
 * dynamic from the start. ?scache=0 switches it off (A/B checks).
 */

const STRIDE = 22;

type Caster = THREE.Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: THREE.BufferAttribute };

export class ShadowCache {
  enabled = true;
  private target: THREE.WebGLRenderTarget | null = null;
  private valid = false;
  /** Static casters this refresh and their signature (STRIDE numbers each). */
  private statics: Caster[] = [];
  private sig = new Float64Array(0);
  private prevSig = new Float64Array(0);
  /** Casters inside the static roots that are not cached (custom depth, demoted). */
  private others: THREE.Object3D[] = [];
  /** Top-level scene children hidden for the static pass. */
  private hiddenTop: THREE.Object3D[] = [];
  /** Caster ids blamed for invalidations; three strikes and they are dynamic for good. */
  private strikes = new Map<number, { n: number; at: number }>();
  private demoted = new Set<number>();
  private key = new Float64Array(12);
  /** Debug counters: full rebuilds, cached refreshes. */
  rebuilds = 0;
  hits = 0;

  constructor(
    private gl: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    /** Groups whose shadow casters may be static (terrain, outskirts, bridges, buildings...). */
    private roots: () => readonly THREE.Object3D[],
  ) {}

  /** Force a rebuild on the next refresh (context restore, quality change). */
  invalidate() {
    this.valid = false;
  }

  dispose() {
    if (this.orig) (this.gl.shadowMap as unknown as { render: unknown }).render = this.orig;
    this.orig = null;
    this.light = null;
    this.target?.dispose();
    this.target = null;
    this.valid = false;
  }

  private orig: ((lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => void) | null = null;
  private light: THREE.DirectionalLight | null = null;
  private frame = 0;

  /**
   * Take over the sun's shadow map refresh. Wraps WebGLShadowMap.render (it runs inside
   * renderer.render, where three's render state is set up): when the sun's shadow is due, the cached
   * path below renders it; every other light and every other case goes through three as before.
   */
  install(light: THREE.DirectionalLight) {
    if (this.orig) return;
    this.light = light;
    const sm = this.gl.shadowMap as THREE.WebGLShadowMap & { render: (l: THREE.Light[], s: THREE.Scene, c: THREE.Camera) => void };
    const orig = (this.orig = sm.render.bind(sm));
    sm.render = (lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => {
      const L = this.light;
      if (!L || !this.enabled || scene !== this.scene || !L.castShadow || !L.shadow.map || !L.shadow.needsUpdate || L.shadow.autoUpdate || !lights.includes(L) || (sm.autoUpdate === false && sm.needsUpdate === false) || !this.gl.capabilities.isWebGL2) {
        if (L && L.shadow.needsUpdate) this.valid = false;
        return orig(lights, scene, camera);
      }
      const map = L.shadow.map;
      if (L.shadow.mapSize.x !== map.width || L.shadow.mapSize.y !== map.height) {
        // the shadow map is about to be resized (quality ladder): three rebuilds it, the cache follows next time
        this.valid = false;
        return orig(lights, scene, camera);
      }
      this.refresh(L, camera);
      // the other shadow-casting lights (if any) as usual; the sun is done
      if (lights.length > 1) orig(lights, scene, camera);
    };
  }

  /** The sun's shadow map for this frame: cached static depth + dynamic casters, or a rebuild. */
  private refresh(light: THREE.DirectionalLight, camera: THREE.Camera) {
    const orig = this.orig!;
    const shadow = light.shadow;
    const gl = this.gl;
    const map = shadow.map!;
    const w = map.width;
    const h = map.height;
    this.frame++;
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
      this.target.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      this.target.depthTexture.format = THREE.DepthFormat;
      gl.initRenderTarget(this.target);
      this.valid = false;
    }
    this.collect(camera);
    // shadow camera pose: the light and its target, the frustum
    const k = this.key;
    const lp = light.matrixWorld.elements;
    const tp = light.target.matrixWorld.elements;
    const c = shadow.camera;
    let keyChanged = false;
    const set = (i: number, v: number) => {
      if (k[i] !== v) {
        k[i] = v;
        keyChanged = true;
      }
    };
    set(0, lp[12]);
    set(1, lp[13]);
    set(2, lp[14]);
    set(3, tp[12]);
    set(4, tp[13]);
    set(5, tp[14]);
    set(6, c.left);
    set(7, c.right);
    set(8, c.top);
    set(9, c.bottom);
    set(10, c.near);
    set(11, c.far);
    const sigChanged = this.compare();
    const one = [light] as THREE.Light[];
    if (!this.valid || keyChanged || sigChanged) {
      // rebuild: the static casters alone into the shadow map, keep a copy, then the dynamic ones on top
      this.rebuilds++;
      this.setStaticOnly(true);
      shadow.needsUpdate = true;
      try {
        orig(one, this.scene, camera);
      } finally {
        this.setStaticOnly(false);
      }
      this.valid = this.blit(map, this.target);
    } else {
      this.hits++;
      if (!this.blit(this.target, map)) {
        // (no framebuffer yet: plain full render)
        this.valid = false;
        shadow.needsUpdate = true;
        orig(one, this.scene, camera);
        return;
      }
    }
    // dynamic casters over the static depth (no clear)
    const st = this.statics;
    for (let i = 0; i < st.length; i++) st[i].visible = false;
    const clear = gl.clear;
    gl.clear = noClear;
    shadow.needsUpdate = true;
    try {
      orig(one, this.scene, camera);
    } finally {
      gl.clear = clear;
      for (let i = 0; i < st.length; i++) st[i].visible = true;
    }
    shadow.needsUpdate = false;
  }

  /** Find this frame's visible static casters and their signature. */
  private collect(camera: THREE.Camera) {
    const st = this.statics;
    const ot = this.others;
    st.length = 0;
    ot.length = 0;
    // (only leaf casters are cached: hiding a cached caster for the dynamic pass must not hide anything else,
    // and everything under a dynamic caster stays dynamic)
    const roots = this.roots();
    for (let i = 0; i < roots.length; i++) if (roots[i].parent === this.scene) this.visit(roots[i], false, camera.layers);
    // signature
    const n = st.length * STRIDE;
    if (this.sig.length !== n) this.sig = new Float64Array(n);
    const s = this.sig;
    for (let i = 0; i < st.length; i++) {
      const m = st[i];
      const o = i * STRIDE;
      const g = m.geometry;
      const mat = m.material as THREE.Material | THREE.Material[];
      s[o] = m.id;
      s[o + 1] = g.id;
      s[o + 2] = Array.isArray(mat) ? -mat.length : matId(mat) + mat.version * 1e-3;
      s[o + 3] = m.isInstancedMesh ? (m.count ?? 0) + (m.instanceMatrix ? m.instanceMatrix.version * 1e-4 : 0) : -1;
      s[o + 4] = g.drawRange.start * 1e6 + (g.drawRange.count === Infinity ? -1 : g.drawRange.count);
      s[o + 5] = ((g.attributes.position as THREE.BufferAttribute | undefined)?.version ?? 0) + (g.index ? g.index.version * 1e-4 : 0);
      const e = m.matrixWorld.elements;
      for (let j = 0; j < 16; j++) s[o + 6 + j] = e[j];
    }
  }

  /** collect(): one object of the static roots (a method, not a closure per refresh: no allocation). */
  private visit(o: THREE.Object3D, dynParent: boolean, layers: THREE.Layers) {
    if (!o.visible) return;
    const m = o as Caster;
    const ch = o.children;
    if ((m.isMesh || (m as unknown as THREE.Points).isPoints || (m as unknown as THREE.Line).isLine) && m.castShadow && o.layers.test(layers)) {
      const dyn = dynParent || ch.length > 0 || this.demoted.has(o.id) || !!m.customDepthMaterial || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh || !!m.morphTargetInfluences || o.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow || !m.isMesh;
      if (dyn) {
        this.others.push(o);
        dynParent = true;
      } else this.statics.push(m);
    }
    for (let i = 0; i < ch.length; i++) this.visit(ch[i], dynParent, layers);
  }

  /** Did any static caster change since the last refresh? Blames the ones that did. */
  private compare(): boolean {
    const a = this.sig;
    const b = this.prevSig;
    let changed = false;
    if (a.length !== b.length) changed = true;
    else {
      for (let i = 0; i < a.length; i += STRIDE) {
        let diff = false;
        for (let j = 0; j < STRIDE; j++)
          if (a[i + j] !== b[i + j]) {
            diff = true;
            break;
          }
        if (!diff) continue;
        changed = true;
        // the same caster (same slot, same object) changed: a strike against it
        if (a[i] === b[i]) {
          // (a one-off change, e.g. a level-of-detail swap or a knocked-over tree, is forgiven after a while)
          const id = a[i];
          const st = this.strikes.get(id);
          const n = st && this.frame - st.at < 90 ? st.n + 1 : 1;
          this.strikes.set(id, { n, at: this.frame });
          if (n >= 3) this.demoted.add(id);
        }
      }
    }
    if (changed) {
      if (this.prevSig.length !== a.length) this.prevSig = new Float64Array(a.length);
      this.prevSig.set(a);
    }
    return changed;
  }

  /** Static pass: everything but the static casters out of the shadow pass (restored afterwards). */
  private setStaticOnly(on: boolean) {
    if (on) {
      const roots = this.roots();
      const ht = this.hiddenTop;
      ht.length = 0;
      for (const c of this.scene.children) {
        if (!c.visible || roots.includes(c)) continue;
        c.visible = false;
        ht.push(c);
      }
      for (const o of this.others) o.visible = false;
    } else {
      for (const c of this.hiddenTop) c.visible = true;
      for (const o of this.others) o.visible = true;
      this.hiddenTop.length = 0;
    }
  }

  /** Depth copy between two targets of the same size and format. */
  private blit(src: THREE.RenderTarget, dst: THREE.RenderTarget): boolean {
    const gl = this.gl;
    const ctx = gl.getContext() as WebGL2RenderingContext;
    const props = gl.properties;
    const fs = (props.get(src) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    const fd = (props.get(dst) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!fs || !fd) return false;
    const state = gl.state;
    state.setScissorTest(false);
    state.bindFramebuffer(ctx.READ_FRAMEBUFFER, fs);
    state.bindFramebuffer(ctx.DRAW_FRAMEBUFFER, fd);
    ctx.blitFramebuffer(0, 0, src.width, src.height, 0, 0, dst.width, dst.height, ctx.DEPTH_BUFFER_BIT, ctx.NEAREST);
    state.bindFramebuffer(ctx.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(ctx.DRAW_FRAMEBUFFER, null);
    return true;
  }
}

const matIds = new WeakMap<THREE.Material, number>();
let nextMat = 1;
function matId(m: THREE.Material): number {
  let i = matIds.get(m);
  if (i === undefined) matIds.set(m, (i = nextMat++));
  return i;
}

function noClear() {
  /* the dynamic casters draw over the copied static depth */
}
