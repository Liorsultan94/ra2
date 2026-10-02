import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DEFS, WEAPONS, unitDef } from '../sim/defs';
import type { Entity, UnitDef } from '../sim/types';
import type { World } from '../sim/world';
import type { Model } from './models';

/*
 * Phone readability aids (Settings: "Unit icons when zoomed out", "Unit outlines").
 *
 *  - UnitIcons: team-coloured NATO-style strategic icons drawn over every visible
 *    unit once units get small on screen (pixels per world unit at the unit's depth,
 *    so it works with the perspective camera, any zoom and the 90 degree rotation).
 *    Constant pixel size, one instanced draw from a procedural sprite atlas, in a
 *    tiny scene drawn straight to the screen after the main frame (crisp: no post
 *    chain, no TAA blur, the drone feed and HUD stay on top). Buildings get small
 *    footprint markers. Fog: only what the renderer shows (visual.visible).
 *  - UnitOutlines: a thin team-coloured rim around every unit's silhouette: the
 *    unit meshes (OUTLINE_LAYER, only the main camera's mask pass uses it) go into a
 *    small colour mask, one full-screen pass draws the rim. Wrecks are untagged the
 *    frame they die; off in thermal view and when the setting is off.
 *  - Move-route arrows (CombatOverlay.routes): line + arrowhead from each selected
 *    group's centre to its destination, shown after the order / on re-selection.
 */

/** Camera layer of the outline hulls: only the main view camera enables it. */
export const OUTLINE_LAYER = 25; // 20 heat, 21 x-ray, 22 contact shadows

/** User preferences (menu.ts keeps them in sync with the saved settings). */
export const readabilityPrefs = { icons: true, outlines: true };
export function setReadabilityPrefs(p: { icons?: boolean; outlines?: boolean }) {
  readabilityPrefs.icons = p.icons !== false;
  readabilityPrefs.outlines = p.outlines !== false;
}

/** Icon fade range in CSS pixels per world unit at the unit (start showing .. fully shown). */
const FADE_START = 21;
const FADE_FULL = 14;

// ------------------------------------------------------------------ atlas

const CELL = 96;
const COLS = 8;
const ROWS = 3;
const enum Cell {
  FrameOwn = 0,
  FrameFoe = 1,
  Tank = 2,
  Ifv,
  Arty,
  Aa,
  Inf,
  Jet,
  Heli,
  Drone,
  Harv,
  Mcv,
  Missile,
  Recon,
  Support,
  Vehicle,
  None,
}

function drawAtlas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = CELL * COLS;
  cv.height = CELL * ROWS;
  const g = cv.getContext('2d')!;
  // opaque black everywhere: channels hold coverage, no premultiplied-alpha fringes
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  g.globalCompositeOperation = 'lighter';
  const at = (i: number, fn: () => void) => {
    g.save();
    g.translate((i % COLS) * CELL + CELL / 2, Math.floor(i / COLS) * CELL + CELL / 2);
    g.scale(CELL, CELL); // draw in cell units, centre 0, +-0.5
    fn();
    g.restore();
  };
  const rrect = (w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect(-w / 2, -h / 2, w, h, r);
  };
  const diamond = (s: number) => {
    g.beginPath();
    g.moveTo(0, -s);
    g.lineTo(s, 0);
    g.lineTo(0, s);
    g.lineTo(-s, 0);
    g.closePath();
  };
  // frames: red = fill, green = fill dilated (dark rim / selection rim)
  at(Cell.FrameOwn, () => {
    g.fillStyle = '#0f0';
    rrect(0.94, 0.7, 0.12);
    g.fill();
    g.fillStyle = '#f00';
    rrect(0.8, 0.56, 0.07);
    g.fill();
  });
  at(Cell.FrameFoe, () => {
    g.fillStyle = '#0f0';
    diamond(0.49);
    g.fill();
    g.fillStyle = '#f00';
    diamond(0.4);
    g.fill();
  });
  // glyphs: white strokes inside a +-0.3 x +-0.2 box
  const LW = 0.065;
  const glyph = (i: number, fn: () => void) =>
    at(i, () => {
      g.strokeStyle = '#fff';
      g.fillStyle = '#fff';
      g.lineWidth = LW;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      fn();
    });
  const line = (pts: number[]) => {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
  };
  const X = () => {
    line([-0.27, -0.2, 0.27, 0.2]);
    line([-0.27, 0.2, 0.27, -0.2]);
  };
  glyph(Cell.Tank, () => {
    g.beginPath();
    g.ellipse(0, 0, 0.25, 0.13, 0, 0, Math.PI * 2);
    g.stroke();
  });
  glyph(Cell.Ifv, () => {
    X();
    g.beginPath();
    g.ellipse(0, 0, 0.17, 0.09, 0, 0, Math.PI * 2);
    g.stroke();
  });
  glyph(Cell.Inf, X);
  glyph(Cell.Arty, () => {
    g.beginPath();
    g.arc(0, 0, 0.09, 0, Math.PI * 2);
    g.fill();
  });
  glyph(Cell.Missile, () => {
    // rocket artillery: a launch rail with a missile pointing up
    line([0, 0.2, 0, -0.12]);
    g.beginPath();
    g.moveTo(-0.08, -0.06);
    g.lineTo(0, -0.21);
    g.lineTo(0.08, -0.06);
    g.closePath();
    g.fill();
    line([-0.2, 0.2, 0.2, 0.2]);
  });
  glyph(Cell.Aa, () => {
    g.beginPath();
    g.arc(0, 0.2, 0.22, Math.PI, 0);
    g.stroke();
    g.beginPath();
    g.arc(0, 0.04, 0.05, 0, Math.PI * 2);
    g.fill();
  });
  glyph(Cell.Recon, () => line([-0.27, 0.2, 0.27, -0.2]));
  glyph(Cell.Support, () => {
    line([-0.2, 0, 0.2, 0]);
    line([0, -0.17, 0, 0.17]);
  });
  glyph(Cell.Vehicle, () => {
    g.beginPath();
    g.ellipse(0, 0.04, 0.22, 0.1, 0, 0, Math.PI * 2);
    g.stroke();
    line([-0.12, -0.14, 0.12, -0.14]);
  });
  glyph(Cell.Harv, () => {
    // ore crystal over a supply bar
    g.beginPath();
    g.moveTo(0, -0.2);
    g.lineTo(0.11, -0.05);
    g.lineTo(0, 0.09);
    g.lineTo(-0.11, -0.05);
    g.closePath();
    g.fill();
    line([-0.24, 0.17, 0.24, 0.17]);
  });
  glyph(Cell.Mcv, () => {
    // construction: a house outline
    line([-0.17, 0.18, -0.17, -0.03, 0, -0.19, 0.17, -0.03, 0.17, 0.18, -0.17, 0.18]);
  });
  glyph(Cell.Jet, () => {
    g.beginPath();
    g.moveTo(0, -0.22);
    g.lineTo(0.05, -0.06);
    g.lineTo(0.26, 0.1);
    g.lineTo(0.05, 0.06);
    g.lineTo(0.04, 0.16);
    g.lineTo(0.11, 0.21);
    g.lineTo(-0.11, 0.21);
    g.lineTo(-0.04, 0.16);
    g.lineTo(-0.05, 0.06);
    g.lineTo(-0.26, 0.1);
    g.lineTo(-0.05, -0.06);
    g.closePath();
    g.fill();
  });
  glyph(Cell.Heli, () => {
    // NATO rotary wing: bow tie
    g.beginPath();
    g.moveTo(-0.27, -0.15);
    g.lineTo(0, 0);
    g.lineTo(-0.27, 0.15);
    g.closePath();
    g.moveTo(0.27, -0.15);
    g.lineTo(0, 0);
    g.lineTo(0.27, 0.15);
    g.closePath();
    g.fill();
  });
  glyph(Cell.Drone, () => {
    // UAV: a flat chevron
    g.beginPath();
    g.moveTo(-0.27, 0.0);
    g.lineTo(0, -0.17);
    g.lineTo(0.27, 0.0);
    g.lineTo(0.27, 0.1);
    g.lineTo(0, -0.05);
    g.lineTo(-0.27, 0.1);
    g.closePath();
    g.fill();
  });
  return cv;
}

/** Icon cell for a unit def (cached). */
const kindCache = new Map<string, Cell>();
function unitCell(def: string): Cell {
  let c = kindCache.get(def);
  if (c !== undefined) return c;
  const d = DEFS[def] as UnitDef;
  const w = d.weapon ? WEAPONS[d.weapon] : undefined;
  const model = d.model ?? '';
  if (d.category === 'infantry') c = Cell.Inf;
  else if (d.air) c = d.kamikaze || /uav|fpv|micro|shahed/.test(model) ? Cell.Drone : d.fixedWing ? Cell.Jet : Cell.Heli;
  else if (d.harvester) c = Cell.Harv;
  else if (d.mcv) c = Cell.Mcv;
  else if (d.aiTag === 'aa' || w?.air === 'only') c = Cell.Aa;
  else if (d.aiTag === 'arty' || w?.projectile === 'artillery' || w?.projectile === 'missile' || w?.projectile === 'spawn') c = w?.projectile === 'missile' || w?.projectile === 'spawn' ? Cell.Missile : Cell.Arty;
  else if (d.transport) c = Cell.Ifv;
  else if (d.aiTag === 'scout') c = Cell.Recon;
  else if (d.aiTag === 'support' || d.repairAura || d.ewRadius || !w) c = Cell.Support;
  else if (d.turret && w?.warhead === 'cannon') c = Cell.Tank;
  else c = Cell.Vehicle;
  kindCache.set(def, c);
  return c;
}

const ICON_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCol;   // sRGB team colour, alpha = fade
attribute vec4 iA;     // frame cell, glyph cell, size (CSS px), flags (1 selected, 2 dark glyph, 4 hostile frame, 8 no lift)
uniform vec2 res;      // drawing buffer, device px
uniform float pr;      // device px per CSS px
varying vec2 vFrame;
varying vec2 vGlyph;
varying vec2 vLocal;
varying vec4 vCol;
varying float vSel;
varying float vDark;
vec2 cellUv(float cell, vec2 uv) {
  float cx = mod(cell, ${COLS}.0);
  float cy = floor(cell / ${COLS}.0);
  return vec2((cx + uv.x) / ${COLS}.0, 1.0 - (cy + 1.0 - uv.y) / ${ROWS}.0);
}
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  float flags = iA.w;
  float sel = mod(flags, 2.0);
  float dark = mod(floor(flags / 2.0), 2.0);
  float foe = mod(floor(flags / 4.0), 2.0);
  float nolift = mod(floor(flags / 8.0), 2.0);
  if (iCol.a < 0.004 || clip.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float size = iA.z * pr * (1.0 + sel * 0.16) * mix(0.82, 1.0, iCol.a);
  vec2 off = position.xy * size;
  off.y += (1.0 - nolift) * size * 0.62;
  clip.xy += off * 2.0 / res * clip.w;
  clip.z = 0.0;
  gl_Position = clip;
  vec2 uv = position.xy + 0.5;
  vFrame = cellUv(iA.x, uv);
  // hostile diamonds have less room inside: shrink the glyph
  vec2 g = (uv - 0.5) / mix(1.0, 0.74, foe) + 0.5;
  vLocal = g;
  vGlyph = cellUv(iA.y, clamp(g, 0.0, 1.0));
  vCol = iCol;
  vSel = sel;
  vDark = dark;
}`;

const ICON_FRAG = /* glsl */ `
uniform sampler2D atlas;
uniform float time;
varying vec2 vFrame;
varying vec2 vGlyph;
varying vec2 vLocal;
varying vec4 vCol;
varying float vSel;
varying float vDark;
void main() {
  vec4 f = texture2D(atlas, vFrame);
  float inside = step(0.0, vLocal.x) * step(vLocal.x, 1.0) * step(0.0, vLocal.y) * step(vLocal.y, 1.0);
  float gl = texture2D(atlas, vGlyph).r * inside;
  float fill = f.r;
  float rim = max(f.g, fill);
  vec3 team = vCol.rgb;
  // selected: white rim with a slow glint, brighter fill
  vec3 rimCol = mix(vec3(0.03, 0.04, 0.05), vec3(1.0, 1.0, 0.92) * (0.85 + 0.15 * sin(time * 5.0)), vSel);
  team = mix(team, min(vec3(1.0), team * 1.18 + 0.06), vSel);
  vec3 c = mix(rimCol, team, fill);
  c = mix(c, mix(vec3(1.0), vec3(0.06), vDark), gl * fill);
  float a = rim * vCol.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;

/** Visual fields the readability layers read (GameRenderer's Visual). */
export interface ReadVisual {
  id: number;
  model: Model;
  owner: number;
  def: string;
  visible: boolean;
}

class UnitIcons {
  readonly scene = new THREE.Scene();
  private geo = new THREE.InstancedBufferGeometry();
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private cap = 0;
  private pos!: THREE.InstancedBufferAttribute;
  private col!: THREE.InstancedBufferAttribute;
  private dat!: THREE.InstancedBufferAttribute;
  private tex: THREE.CanvasTexture;
  count = 0;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.tex = new THREE.CanvasTexture(drawAtlas());
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.anisotropy = 1;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: this.tex }, res: { value: new THREE.Vector2(1, 1) }, pr: { value: 1 }, time: { value: 0 } },
      vertexShader: ICON_VERT,
      fragmentShader: ICON_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.grow(256);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  private grow(n: number) {
    const cap = Math.max(n, this.cap * 2);
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const dat = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    for (const a of [pos, col, dat]) a.setUsage(THREE.DynamicDrawUsage);
    if (this.cap) {
      pos.array.set(this.pos.array);
      col.array.set(this.col.array);
      dat.array.set(this.dat.array);
    }
    this.pos = pos;
    this.col = col;
    this.dat = dat;
    this.geo.setAttribute('iPos', pos);
    this.geo.setAttribute('iCol', col);
    this.geo.setAttribute('iA', dat);
    this.cap = cap;
  }

  begin() {
    this.count = 0;
  }

  push(x: number, y: number, z: number, rgb: [number, number, number], fade: number, frame: Cell, glyph: Cell, size: number, flags: number) {
    if (this.count >= this.cap) this.grow(this.count + 1);
    const i = this.count++;
    const p = this.pos.array as Float32Array;
    const c = this.col.array as Float32Array;
    const d = this.dat.array as Float32Array;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    c[i * 4] = rgb[0];
    c[i * 4 + 1] = rgb[1];
    c[i * 4 + 2] = rgb[2];
    c[i * 4 + 3] = fade;
    d[i * 4] = frame;
    d[i * 4 + 1] = glyph;
    d[i * 4 + 2] = size;
    d[i * 4 + 3] = flags;
  }

  end(time: number) {
    this.geo.instanceCount = this.count;
    for (const a of [this.pos, this.col, this.dat]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
    this.mat.uniforms.time.value = time;
  }

  render(gl: THREE.WebGLRenderer, camera: THREE.Camera) {
    if (!this.count) return;
    const u = this.mat.uniforms;
    gl.getDrawingBufferSize(u.res.value);
    u.pr.value = gl.getPixelRatio();
    const auto = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.render(this.scene, camera);
    gl.autoClear = auto;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

// ------------------------------------------------------------------ outlines

/*
 * Screen-space team outline: the live units' solid meshes (tagged with OUTLINE_LAYER)
 * are drawn once into a small colour mask (flat team colour, one override material),
 * then one full-screen pass draws a thin rim wherever a pixel is outside every unit
 * but next to one. The outline follows the union silhouette of all parts (no inner
 * lines), costs one extra cheap draw per tagged mesh plus one full-screen quad, and
 * is composited straight to the screen after the post chain (drone feed / HUD on top).
 */
const MASK_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}`;

const MASK_FRAG = /* glsl */ `
uniform vec3 color;
void main() { gl_FragColor = vec4(color, 1.0); }`;

const RIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const RIM_FRAG = /* glsl */ `
uniform sampler2D mask;
uniform vec2 texel;
uniform float opacity;
varying vec2 vUv;
void main() {
  float self = texture2D(mask, vUv).a;
  if (self > 0.97) discard;
  vec4 best = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a));
    vec4 s = texture2D(mask, vUv + d * texel * 1.25);
    if (s.a > best.a) best = s;
    s = texture2D(mask, vUv + d * texel * 0.6);
    if (s.a > best.a) best = s;
  }
  float a = best.a * (1.0 - self) * opacity;
  if (a < 0.02) discard;
  gl_FragColor = vec4(best.rgb / max(best.a, 1e-3), a);
}`;

interface Tagged {
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
}

const noopBR = THREE.Object3D.prototype.onBeforeRender;

/** Solid parts of a model worth outlining, largest first. */
function outlineMeshes(root: THREE.Object3D, max: number): THREE.Mesh[] {
  const list: { m: THREE.Mesh; r: number }[] = [];
  root.updateMatrixWorld(true);
  const s = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry || (m as unknown as { isXray?: boolean }).isXray) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(m.material) || !mat || mat.transparent || !mat.visible || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
    const g = m.geometry;
    if (!g.attributes.position || g.morphAttributes.position) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    m.getWorldScale(s);
    list.push({ m, r: (g.boundingSphere?.radius ?? 0) * Math.max(s.x, s.y, s.z) });
  });
  list.sort((a, b) => b.r - a.r);
  const top = list.length ? list[0].r : 0;
  return list.filter((x, i) => i < max && x.r >= top * 0.1).map((x) => x.m);
}

class UnitOutlines {
  private tagged = new Map<number, Tagged>();
  private seen = new Set<number>();
  private maskMat: THREE.ShaderMaterial;
  private rimMat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private rt: THREE.WebGLRenderTarget | null = null;
  private size = new THREE.Vector2();
  private clear = new THREE.Color();
  private on = false;
  /** Meshes drawn into the mask last frame (perf stats). */
  drawn = 0;

  constructor(
    private perUnit: number,
    private scale: number,
  ) {
    this.maskMat = new THREE.ShaderMaterial({ uniforms: { color: { value: new THREE.Color() } }, vertexShader: MASK_VERT, fragmentShader: MASK_FRAG, fog: false, toneMapped: false });
    this.rimMat = new THREE.ShaderMaterial({
      uniforms: { mask: { value: null }, texel: { value: new THREE.Vector2() }, opacity: { value: 0.9 } },
      vertexShader: RIM_VERT,
      fragmentShader: RIM_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.rimMat);
  }

  /** onBeforeRender of tagged meshes: hand the mask material this mesh's team colour. */
  private readonly brMask = function (this: THREE.Mesh, _r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, mat: THREE.Material) {
    const sm = mat as THREE.ShaderMaterial;
    if (sm.userData.outlineMask) {
      sm.uniforms.color.value.copy(this.userData.outlineColor);
      sm.uniformsNeedUpdate = true;
    }
  };

  update(visuals: Iterable<ReadVisual>, isUnit: (def: string) => boolean, color: (owner: number) => number, on: boolean) {
    this.on = on;
    const seen = this.seen;
    seen.clear();
    for (const v of visuals) {
      if (v.owner < 0 || !isUnit(v.def)) continue;
      seen.add(v.id);
      let t = this.tagged.get(v.id);
      if (t && t.root !== v.model.root) {
        this.untag(t);
        t = undefined;
      }
      if (!t && v.visible) {
        t = this.tag(v.model.root, color(v.owner));
        this.tagged.set(v.id, t);
      }
    }
    for (const [id, t] of this.tagged) {
      if (seen.has(id)) continue;
      // the model became a wreck (or vanished): wrecks are not outlined
      this.untag(t);
      this.tagged.delete(id);
    }
  }

  private tag(root: THREE.Object3D, teamColor: number): Tagged {
    const col = new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), 0.32);
    const meshes = outlineMeshes(root, this.perUnit);
    for (const m of meshes) {
      m.layers.enable(OUTLINE_LAYER);
      m.userData.outlineColor = col;
      if (m.onBeforeRender === noopBR) m.onBeforeRender = this.brMask;
    }
    return { root, meshes };
  }

  private untag(t: Tagged) {
    for (const m of t.meshes) {
      m.layers.disable(OUTLINE_LAYER);
      if (m.onBeforeRender === this.brMask) m.onBeforeRender = noopBR;
      delete m.userData.outlineColor;
    }
    t.meshes.length = 0;
  }

  /** Mask pass + rim composite, straight to the screen. */
  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.drawn = 0;
    if (!this.on || !this.tagged.size) return;
    gl.getDrawingBufferSize(this.size);
    // mask resolution: ~1 mask texel per CSS pixel (rim ~1.3 CSS px)
    const sc = this.scale || (gl.getPixelRatio() >= 1.4 ? 0.5 : 0.75);
    const w = Math.max(16, Math.round(this.size.x * sc));
    const h = Math.max(16, Math.round(this.size.y * sc));
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
      this.rt.texture.generateMipmaps = false;
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.maskMat.userData.outlineMask = true;
    const mask = camera.layers.mask;
    const bg = scene.background;
    const env = scene.environment;
    const ov = scene.overrideMaterial;
    const sh = gl.shadowMap.autoUpdate;
    const clear = gl.getClearColor(this.clear);
    const clearA = gl.getClearAlpha();
    const auto = gl.autoClear;
    camera.layers.set(OUTLINE_LAYER);
    scene.background = null;
    scene.environment = null;
    scene.overrideMaterial = this.maskMat;
    gl.shadowMap.autoUpdate = false;
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(this.rt);
    gl.autoClear = true;
    const calls = gl.info.render.calls;
    gl.render(scene, camera);
    this.drawn = gl.info.autoReset ? gl.info.render.calls : gl.info.render.calls - calls;
    gl.setRenderTarget(null);
    gl.setClearColor(clear, clearA);
    gl.shadowMap.autoUpdate = sh;
    scene.overrideMaterial = ov;
    scene.environment = env;
    scene.background = bg;
    camera.layers.mask = mask;
    // rim: ~1.3 mask texels around every unit silhouette
    const u = this.rimMat.uniforms;
    u.mask.value = this.rt.texture;
    u.texel.value.set(1 / w, 1 / h);
    gl.autoClear = false;
    this.quad.render(gl);
    gl.autoClear = auto;
  }

  get meshCount() {
    let n = 0;
    for (const t of this.tagged.values()) n += t.meshes.length;
    return n;
  }

  dispose() {
    for (const t of this.tagged.values()) this.untag(t);
    this.tagged.clear();
    this.rt?.dispose();
    this.maskMat.dispose();
    this.rimMat.dispose();
    this.quad.dispose();
  }
}

// ------------------------------------------------------------------ routes

/** One move-route arrow for CombatOverlay.routes(). */
export interface Route {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: number;
  alpha: number;
}

interface RouteGroup {
  dx: number;
  dy: number;
  born: number;
  seen: boolean;
}

// ------------------------------------------------------------------ facade

const camFwd = new THREE.Vector3();
const rgbOf = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const lumOf = (c: [number, number, number]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

export interface ReadabilityInput {
  world: World;
  visuals: ReadonlyMap<number, ReadVisual>;
  selection: Set<number>;
  viewer: number;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** CSS pixel height of the view. */
  viewHeight: number;
  gl: THREE.WebGLRenderer;
  time: number;
  /** Thermal / whole-view modes that make outlines pointless. */
  thermal: boolean;
}

export class Readability {
  readonly icons = new UnitIcons();
  readonly outlines: UnitOutlines;
  private master = 1;
  private outlineOn = true;
  private groups: RouteGroup[] = [];
  private selKey = '';
  /** Routes of the selected groups, rebuilt each frame (drawn by CombatOverlay.routes). */
  readonly routes: Route[] = [];
  /** Hidden in photo mode / cinematics by other systems. */
  hidden = false;

  constructor(quality: 'low' | 'medium' | 'high') {
    this.outlines = new UnitOutlines(quality === 'low' ? 3 : quality === 'medium' ? 6 : 12, quality === 'low' ? 0.5 : 0);
  }

  private isUnit = (def: string) => DEFS[def]?.kind === 'unit';

  update(inp: ReadabilityInput, dt: number) {
    const { world, camera } = inp;
    this.lastCam = camera;
    this.lastH = inp.viewHeight;
    const players = world.players;
    const colorOf = (o: number) => (o >= 0 ? players[o].color : 0xaaaaaa);
    // ---- outlines
    this.outlineOn = readabilityPrefs.outlines && !inp.thermal && !this.hidden;
    this.outlines.update(inp.visuals.values(), this.isUnit, colorOf, this.outlineOn);
    // ---- icons
    const want = readabilityPrefs.icons && !this.hidden ? 1 : 0;
    // eased on/off (the settings toggle); jumps while the game is paused (dt 0)
    this.master = dt > 0 ? this.master + (want - this.master) * Math.min(1, dt * 6) : want;
    if (Math.abs(this.master - want) < 0.01) this.master = want;
    const icons = this.icons;
    icons.begin();
    // CSS px per world unit at view depth w: P11 * h / 2 / w
    const persp = camera instanceof THREE.PerspectiveCamera;
    const k = camera.projectionMatrix.elements[5] * 0.5 * inp.viewHeight;
    camera.getWorldDirection(camFwd);
    const cp = camera.position;
    const fadeAt = (x: number, y: number, z: number, start = FADE_START) => {
      const w = persp ? (x - cp.x) * camFwd.x + (y - cp.y) * camFwd.y + (z - cp.z) * camFwd.z : 1;
      if (w <= 0.01) return 0;
      const ppu = k / w;
      const t = Math.max(0, Math.min(1, (start - ppu) / (start - FADE_FULL)));
      return t * t * (3 - 2 * t);
    };
    if (this.master > 0.001) {
      const sel = inp.selection;
      const viewer = inp.viewer;
      const units: ReadVisual[] = [];
      for (const v of inp.visuals.values()) {
        if (!v.visible || v.owner < 0 || !v.model.root.visible) continue;
        const d = DEFS[v.def];
        if (!d) continue;
        const p = v.model.root.position;
        if (d.kind === 'building') {
          const f = fadeAt(p.x, p.y, p.z) * this.master;
          if (f < 0.004) continue;
          const c = rgbOf(colorOf(v.owner));
          const foe = viewer >= 0 && v.owner !== viewer;
          const s = sel.has(v.id) ? 1 : 0;
          icons.push(p.x, p.y + 0.15, p.z, c, f * 0.9, foe ? Cell.FrameFoe : Cell.FrameOwn, Cell.None, d.category === 'defense' ? 9 : 12, s | 8);
        } else units.push(v);
      }
      // units over buildings, selected units on top
      for (let pass = 0; pass < 2; pass++) {
        for (const v of units) {
          const isSel = sel.has(v.id);
          if ((pass === 1) !== isSel) continue;
          const d = unitDef(v.def);
          if (d.temp && !d.kamikaze) continue;
          const p = v.model.root.position;
          const top = p.y + (v.model.height ?? 0.5);
          const f = fadeAt(p.x, top, p.z, isSel ? FADE_START * 1.2 : FADE_START) * this.master;
          if (f < 0.004) continue;
          const c = rgbOf(colorOf(v.owner));
          const foe = viewer >= 0 && v.owner !== viewer;
          const cell = unitCell(v.def);
          const size = cell === Cell.Inf ? 16 : cell === Cell.Harv || cell === Cell.Mcv ? 22 : d.temp ? 13 : 19;
          icons.push(p.x, top, p.z, c, f, foe ? Cell.FrameFoe : Cell.FrameOwn, cell, size, (isSel ? 1 : 0) | (lumOf(c) > 0.62 ? 2 : 0) | (foe ? 4 : 0));
        }
      }
    }
    icons.end(inp.time);
    // ---- routes of the selected groups
    this.updateRoutes(inp);
  }

  private lastCam: THREE.Camera | null = null;
  private lastH = 1;

  /** Icon fade (0..1) at a world point, as drawn last frame (HUD: lift health bars above the icons). */
  fadeAtPoint(x: number, y: number, z: number): number {
    const camera = this.lastCam as THREE.PerspectiveCamera | null;
    if (!camera || this.master < 0.01 || !readabilityPrefs.icons || this.hidden) return 0;
    const k = camera.projectionMatrix.elements[5] * 0.5 * this.lastH;
    camera.getWorldDirection(camFwd);
    const cp = camera.position;
    const w = camera.isPerspectiveCamera ? (x - cp.x) * camFwd.x + (y - cp.y) * camFwd.y + (z - cp.z) * camFwd.z : 1;
    if (w <= 0.01) return 0;
    const t = Math.max(0, Math.min(1, (FADE_START - k / w) / (FADE_START - FADE_FULL)));
    return t * t * (3 - 2 * t) * this.master;
  }

  private updateRoutes(inp: ReadabilityInput) {
    const { world, selection, viewer } = inp;
    const now = performance.now() / 1000;
    this.routes.length = 0;
    // selection change (incl. re-selecting a group) shows the routes again
    let key = selection.size + ':';
    let sum = 0;
    for (const id of selection) sum = (sum + id * 2654435761) % 4294967296;
    key += sum;
    const reshow = key !== this.selKey;
    this.selKey = key;
    // cluster the selected units' move destinations
    const cl: { dx: number; dy: number; cx: number; cy: number; n: number; am: boolean }[] = [];
    for (const id of selection) {
      const e: Entity | undefined = world.get(id);
      if (!e || e.dead || e.kind !== 'unit' || (viewer >= 0 && e.owner !== viewer) || e.inside >= 0) continue;
      const o = e.order;
      if (o.type !== 'move' && o.type !== 'attackMove') continue;
      let c = cl.find((c) => Math.hypot(c.dx / c.n - o.x, c.dy / c.n - o.y) < 3.5);
      if (!c) cl.push((c = { dx: 0, dy: 0, cx: 0, cy: 0, n: 0, am: false }));
      c.dx += o.x;
      c.dy += o.y;
      c.cx += e.x;
      c.cy += e.y;
      c.n++;
      c.am ||= o.type === 'attackMove';
    }
    for (const g of this.groups) g.seen = false;
    for (const c of cl) {
      const dx = c.dx / c.n;
      const dy = c.dy / c.n;
      let g = this.groups.find((g) => !g.seen && Math.hypot(g.dx - dx, g.dy - dy) < 2);
      if (!g) {
        g = { dx, dy, born: now, seen: true };
        this.groups.push(g);
      }
      g.seen = true;
      g.dx = dx;
      g.dy = dy;
      if (reshow) g.born = now;
      const age = now - g.born;
      const a = 1 - Math.max(0, Math.min(1, (age - 3.5) / 1.2));
      const x0 = c.cx / c.n;
      const y0 = c.cy / c.n;
      if (a <= 0.01 || Math.hypot(dx - x0, dy - y0) < 1.2) continue;
      this.routes.push({ x0, y0, x1: dx, y1: dy, color: c.am ? 0xff9a48 : 0x5dffa0, alpha: a * Math.min(1, age / 0.15 + 0.3) });
    }
    this.groups = this.groups.filter((g) => g.seen);
  }

  /** Outlines, then icons, straight to the screen (after the main frame and its post chain). */
  renderOverlays(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    if (this.hidden) return;
    this.outlines.render(gl, scene, camera);
    this.icons.render(gl, camera);
  }

  /** Extra draw calls this frame (debug / perf stats). */
  stats() {
    return { icons: this.icons.count, iconDraws: this.icons.count ? 1 : 0, outlineMeshes: this.outlines.meshCount, outlineMaskDraws: this.outlines.drawn, routes: this.routes.length };
  }

  dispose() {
    this.icons.dispose();
    this.outlines.dispose();
  }
}
