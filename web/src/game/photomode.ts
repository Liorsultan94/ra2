import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { groundHeight } from '../sim/map';
import { BASE_VIEW, type GameRenderer, type ViewHook } from '../render/renderer';
import type { ViewModes } from '../render/viewmodes';
import { readabilityPrefs } from '../render/readability';
import '../ui/photomode.css';

/*
 * Photo mode: the battle freezes and a free camera takes over.
 *
 *  - touch: drag = orbit, pinch = zoom, two-finger drag = move;
 *    mouse: left drag = orbit, right / shift drag = move, wheel = zoom;
 *    keys: WASD / arrows move, Q / E orbit, R / F tilt, Z / X zoom,
 *    Space = shutter, H = hide the controls, Y / Esc = leave.
 *  - sliders: time of day (Atmosphere.previewPhase), exposure, depth of field
 *    (screen-space focus band + strength, a golden-angle disc blur like
 *    render/tiltshift.ts) and filters (none / cinematic / night vision /
 *    thermal / black & white). Thermal and night vision reuse the game's own
 *    view modes when the post chain runs (night vision falls back to the
 *    grade shader without it).
 *  - shutter: re-renders the frame at up to 2x resolution (longest side
 *    <= 4096) and downloads it as a PNG.
 *
 * Leaving restores the camera (target, zoom, view rotation untouched), the
 * HUD, the selection, the view modes and the pause / speed state exactly.
 */

type Filter = 'none' | 'cinematic' | 'nv' | 'thermal' | 'bw';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'nv', label: 'Night vision' },
  { id: 'thermal', label: 'Thermal' },
  { id: 'bw', label: 'B&W' },
];
const FILTER_CODE: Record<Filter, number> = { none: 0, cinematic: 1, nv: 2, thermal: 0, bw: 3 };

export interface PhotoHost {
  readonly renderer: GameRenderer;
  readonly modes: ViewModes;
  /** The game root (gets `photo-on`: HUD hidden, view full screen). */
  readonly root: HTMLElement;
  /** Where the photo controls go (the view wrapper). */
  readonly layer: HTMLElement;
  paused: boolean;
  /** Called when photo mode opens / closes (sound, input state). */
  onToggle?(on: boolean): void;
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    exposure: { value: 1 },
    focus: { value: 0.5 },
    blur: { value: 0 },
    mode: { value: 0 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float exposure;
    uniform float focus;
    uniform float blur;
    uniform int mode;
    uniform float time;
    varying vec2 vUv;
    float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      // depth of field: sharp band around the focus line, disc blur growing away from it
      float k = smoothstep( 0.04, 0.42, abs( vUv.y - focus ) ) * blur;
      if ( k > 0.02 ) {
        vec2 px = 1.0 / resolution;
        float r = k * resolution.y * 0.012;
        vec3 acc = c;
        for ( int i = 1; i < 24; i++ ) {
          float fi = float( i );
          float rr = sqrt( fi / 23.0 ) * r;
          float a = fi * 2.39996323;
          acc += texture2D( tDiffuse, vUv + vec2( cos( a ), sin( a ) ) * rr * px ).rgb;
        }
        c = acc / 24.0;
      }
      c *= exposure;
      float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      vec2 q = vUv - 0.5;
      float vig = 1.0 - dot( q, q ) * 1.1;
      if ( mode == 1 ) {
        // cinematic: teal shadows, warm highlights, gentle S-curve, letterbox 2.39:1
        c = mix( c, c * vec3( 1.1, 1.0, 0.86 ), smoothstep( 0.35, 0.9, lum ) );
        c += ( 1.0 - smoothstep( 0.0, 0.4, lum ) ) * vec3( -0.025, 0.012, 0.04 );
        c = mix( vec3( lum ), c, 0.88 );
        c = c * c * ( 3.0 - 2.0 * c ) * 0.55 + c * 0.45;
        c *= mix( 1.0, vig, 0.9 );
        float aspect = resolution.x / resolution.y;
        float bar = 0.5 * ( 1.0 - aspect / 2.39 );
        if ( bar > 0.0 && ( vUv.y < bar || vUv.y > 1.0 - bar ) ) c = vec3( 0.0 );
      } else if ( mode == 2 ) {
        // night vision (fallback when the game's pass is unavailable): green phosphor, grain, tube vignette
        float g = pow( clamp( lum * 2.2, 0.0, 1.0 ), 0.8 );
        g += ( hash( vUv * resolution + time ) - 0.5 ) * 0.12;
        c = vec3( 0.18, 1.0, 0.32 ) * g;
        c *= smoothstep( 0.75, 0.35, length( q * vec2( resolution.x / resolution.y, 1.0 ) ) );
      } else if ( mode == 3 ) {
        // black & white: punchy contrast, a little grain, vignette
        float g = clamp( lum, 0.0, 1.0 );
        g = g * g * ( 3.0 - 2.0 * g ) * 0.7 + g * 0.3;
        g += ( hash( vUv * resolution ) - 0.5 ) * 0.05;
        c = vec3( g ) * mix( 1.0, vig, 0.8 );
      }
      gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), 1.0 );
    }`,
};

/** Wraps the game's view hook while photo mode is on: same frame, then the photo grade; no drone PiP. */
class PhotoHook implements ViewHook {
  constructor(
    readonly inner: ViewHook | null,
    private pm: PhotoMode,
  ) {}
  /** The renderer asks the hook whether the thermal view is on (readability outlines). */
  get thermal(): boolean {
    return !!(this.inner as { thermal?: boolean } | null)?.thermal;
  }
  before(dt: number) {
    this.inner?.before(dt);
  }
  renderMain(): boolean {
    return this.inner?.renderMain() ?? false;
  }
  after() {
    this.pm.post();
  }
}

interface Saved {
  target: THREE.Vector3;
  zoom: number;
  paused: boolean;
  selection: number[];
  hover: number;
  thermal: boolean;
  polarity: ViewModes['polarity'];
  nv: boolean;
  xray: boolean;
  hook: ViewHook | null;
  icons: boolean;
  outlines: boolean;
  overlay: boolean;
}

export class PhotoMode {
  active = false;
  private saved: Saved | null = null;
  private ui: HTMLElement | null = null;
  // orbit camera
  private look = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0.6;
  private dist = 20;
  private pos = new THREE.Vector3();
  private cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  // look
  private filter: Filter = 'none';
  private exposure = 0;
  private focus = 0.5;
  private blur = 0;
  private tod: number | null = null;
  // post
  private quad: FullScreenQuad | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private tex: THREE.FramebufferTexture | null = null;
  private size = new THREE.Vector2();
  // input
  private pointers = new Map<number, { x: number; y: number; button: number; shift: boolean }>();
  private keys = new Set<string>();
  private raf = 0;
  private last = 0;
  private time = 0;
  private lastUrl = '';

  constructor(private host: PhotoHost) {}

  toggle(resumeOnExit?: boolean) {
    if (this.active) this.exit();
    else this.enter(resumeOnExit);
  }

  /** Enter photo mode; `resumeOnExit` (pause menu) un-pauses on the way out instead of restoring the pause flag. */
  enter(resumeOnExit = false) {
    if (this.active) return;
    const h = this.host;
    const r = h.renderer;
    this.active = true;
    this.saved = {
      target: r.target.clone(),
      zoom: r.zoom,
      paused: resumeOnExit ? false : h.paused,
      selection: [...r.selection],
      hover: r.hover,
      thermal: h.modes.thermal,
      polarity: h.modes.polarity,
      nv: r.atmos.nightVision,
      xray: h.modes.xray,
      hook: r.viewHook,
      icons: readabilityPrefs.icons,
      outlines: readabilityPrefs.outlines,
      overlay: r.overlay.group.visible,
    };
    h.paused = true;
    // a clean frame: no selection rings, hover ring or x-ray silhouettes
    r.selection.clear();
    r.hover = -1;
    h.modes.xray = false;
    // ... nor strategic icons, unit outlines, order markers
    readabilityPrefs.icons = false;
    readabilityPrefs.outlines = false;
    r.overlay.group.visible = false;
    r.viewHook = new PhotoHook(this.saved.hook, this);
    // start the orbit from the current RTS camera
    const c = r.camera;
    const map = r.world.map;
    this.look.set(r.target.x, groundHeight(map, r.target.x, r.target.z), r.target.z);
    const off = c.position.clone().sub(this.look);
    this.dist = Math.max(3, Math.min(90, off.length()));
    this.yaw = Math.atan2(off.z, off.x);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, off.y / Math.max(1e-3, off.length()))));
    this.filter = 'none';
    this.exposure = 0;
    this.blur = 0;
    this.focus = 0.5;
    this.tod = null;
    this.applyCamera();
    h.root.classList.add('photo-on');
    this.buildUi();
    // keep a thermal / night-vision view the player had on
    this.setFilter(this.saved.thermal ? 'thermal' : this.saved.nv ? 'nv' : 'none');
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    this.last = 0;
    this.raf = requestAnimationFrame(this.tick);
    h.onToggle?.(true);
  }

  exit() {
    if (!this.active || !this.saved) return;
    const h = this.host;
    const r = h.renderer;
    const s = this.saved;
    this.setFilter('none');
    if (this.tod !== null) r.atmos.previewPhase(null);
    this.tod = null;
    r.photoCam = null;
    r.target.copy(s.target);
    r.zoom = s.zoom;
    r.viewHook = s.hook;
    for (const id of s.selection) if (r.world.get(id)) r.selection.add(id);
    r.hover = s.hover;
    h.modes.xray = s.xray;
    readabilityPrefs.icons = s.icons;
    readabilityPrefs.outlines = s.outlines;
    r.overlay.group.visible = s.overlay;
    if (s.thermal) h.modes.setThermal(true, s.polarity);
    if (s.nv) r.atmos.setNightVision(true);
    h.paused = s.paused;
    h.root.classList.remove('photo-on');
    this.ui?.remove();
    this.ui = null;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pointers.clear();
    this.keys.clear();
    this.active = false;
    this.saved = null;
    h.onToggle?.(false);
  }

  dispose() {
    if (this.active) this.exit();
    this.mat?.dispose();
    this.tex?.dispose();
    this.mat = null;
    this.tex = null;
    this.quad = null;
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
  }

  // ------------------------------------------------------------------ camera

  private applyCamera() {
    const r = this.host.renderer;
    const map = r.world.map;
    this.pitch = Math.max(0.04, Math.min(1.5, this.pitch));
    this.dist = Math.max(1.5, Math.min(90, this.dist));
    this.look.x = Math.max(0, Math.min(map.w, this.look.x));
    this.look.z = Math.max(0, Math.min(map.h, this.look.z));
    const gy = groundHeight(map, this.look.x, this.look.z);
    this.look.y += (gy - this.look.y) * 0.35;
    const cp = Math.cos(this.pitch);
    this.pos.set(this.look.x + Math.cos(this.yaw) * cp * this.dist, this.look.y + Math.sin(this.pitch) * this.dist, this.look.z + Math.sin(this.yaw) * cp * this.dist);
    // never under the ground
    const px = Math.max(0, Math.min(map.w - 0.01, this.pos.x));
    const pz = Math.max(0, Math.min(map.h - 0.01, this.pos.z));
    const floor = groundHeight(map, px, pz) + 0.35;
    if (this.pos.y < floor) this.pos.y = floor;
    this.cam.pos.copy(this.pos);
    this.cam.look.copy(this.look);
    r.photoCam = this.cam;
    // keep the fog / haze / shadow focus and particle scale on what we look at
    r.target.set(this.look.x, 0, this.look.z);
    r.setZoom(BASE_VIEW / (this.dist * 2 * Math.tan(THREE.MathUtils.degToRad(19))));
  }

  private orbit(dx: number, dy: number) {
    this.yaw += dx * 0.0065;
    this.pitch += dy * 0.005;
  }

  private pan(dx: number, dy: number) {
    // screen right / screen down mapped onto the ground around the view direction
    const k = this.dist * 0.0021;
    const fx = -Math.cos(this.yaw);
    const fz = -Math.sin(this.yaw);
    // right = forward x up
    const rx = -fz;
    const rz = fx;
    this.look.x += (-dx * rx + dy * fx) * k;
    this.look.z += (-dx * rz + dy * fz) * k;
  }

  private zoomBy(f: number) {
    this.dist *= f;
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.time += dt;
    const K = this.keys;
    const mv = 520 * dt;
    let px = 0;
    let py = 0;
    if (K.has('a') || K.has('arrowleft')) px += mv;
    if (K.has('d') || K.has('arrowright')) px -= mv;
    if (K.has('w') || K.has('arrowup')) py += mv;
    if (K.has('s') || K.has('arrowdown')) py -= mv;
    if (px || py) this.pan(px, py);
    if (K.has('q')) this.yaw -= dt * 1.2;
    if (K.has('e')) this.yaw += dt * 1.2;
    if (K.has('r')) this.pitch += dt * 0.8;
    if (K.has('f')) this.pitch -= dt * 0.8;
    if (K.has('z') || K.has('+') || K.has('=')) this.zoomBy(Math.exp(-dt * 1.4));
    if (K.has('x') || K.has('-')) this.zoomBy(Math.exp(dt * 1.4));
    this.applyCamera();
  };

  // ------------------------------------------------------------------ post

  /** Grade pass on top of the finished frame (called from the wrapped view hook). */
  post() {
    const code = FILTER_CODE[this.filter] === 2 && this.host.renderer.postActive ? 0 : FILTER_CODE[this.filter];
    const ev = Math.pow(2, this.exposure);
    if (code === 0 && Math.abs(ev - 1) < 1e-3 && this.blur < 0.01) return;
    const gl = this.host.renderer.renderer;
    gl.getDrawingBufferSize(this.size);
    const w = this.size.x;
    const h = this.size.y;
    if (!this.mat) {
      this.mat = new THREE.ShaderMaterial({ ...GradeShader, uniforms: THREE.UniformsUtils.clone(GradeShader.uniforms), depthTest: false, depthWrite: false });
      this.quad = new FullScreenQuad(this.mat);
    }
    if (!this.tex || this.tex.image.width !== w || this.tex.image.height !== h) {
      this.tex?.dispose();
      this.tex = new THREE.FramebufferTexture(w, h);
      this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    }
    gl.setRenderTarget(null);
    gl.copyFramebufferToTexture(this.tex);
    const u = this.mat.uniforms;
    u.tDiffuse.value = this.tex;
    u.resolution.value.set(w, h);
    u.exposure.value = ev;
    u.focus.value = this.focus;
    u.blur.value = this.blur;
    u.mode.value = code;
    u.time.value = this.time % 100;
    this.quad!.render(gl);
  }

  private setFilter(f: Filter) {
    const h = this.host;
    const r = h.renderer;
    // leave the previous look
    if (this.filter === 'thermal' && f !== 'thermal') h.modes.setThermal(false);
    if (this.filter === 'nv' && f !== 'nv' && r.atmos.nightVision) r.atmos.setNightVision(false);
    this.filter = f;
    if (f === 'thermal') h.modes.setThermal(true, 'white');
    else if (h.modes.thermal) h.modes.setThermal(false);
    if (f === 'nv') {
      // the game's pass when the post chain runs; the grade shader otherwise (a CSS filter would miss the PNG)
      if (r.postActive) r.atmos.setNightVision(true);
      else if (r.atmos.nightVision) r.atmos.setNightVision(false);
    } else if (r.atmos.nightVision) r.atmos.setNightVision(false);
    this.ui?.querySelectorAll<HTMLElement>('.ph-chip').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
  }

  // ------------------------------------------------------------------ capture

  /** Re-render at up to 2x and download a PNG; resolves with the file's object URL. */
  async shutter(): Promise<string> {
    const r = this.host.renderer;
    const gl = r.renderer;
    const canvas = gl.domElement;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    const pr = gl.getPixelRatio();
    gl.getDrawingBufferSize(this.size);
    // up to 2x; phones keep the post chain's render targets within a sane memory budget
    const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
    const maxSide = Math.min(gl.capabilities.maxTextureSize, coarse ? 3200 : 4096);
    const scale = Math.max(1, Math.min(2, maxSide / Math.max(this.size.x, this.size.y)));
    const out = document.createElement('canvas');
    this.ui?.classList.add('flash');
    try {
      if (scale > 1.01) {
        gl.setPixelRatio(pr * scale);
        r.resize(cssW, cssH);
      }
      // temporal AA (ultra) needs a few frames to converge after a resize
      const frames = r.ultra ? 4 : 1;
      for (let i = 0; i < frames; i++) r.render(1, 0);
      out.width = canvas.width;
      out.height = canvas.height;
      out.getContext('2d')!.drawImage(canvas, 0, 0);
    } finally {
      if (scale > 1.01) {
        gl.setPixelRatio(pr);
        r.resize(cssW, cssH);
      }
    }
    setTimeout(() => this.ui?.classList.remove('flash'), 180);
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
    if (!blob) return '';
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
    const url = (this.lastUrl = URL.createObjectURL(blob));
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const name = `iron-front-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // a visible link too (some mobile browsers block the automatic download)
    const saved = this.ui?.querySelector<HTMLAnchorElement>('.ph-saved');
    if (saved) {
      saved.href = url;
      saved.download = name;
      saved.innerHTML = `<img src="${url}" alt=""><span>Saved ${out.width}×${out.height}<small>tap to open</small></span>`;
      saved.classList.remove('hidden');
      clearTimeout(this.savedTimer);
      this.savedTimer = window.setTimeout(() => saved.classList.add('hidden'), 4500);
    }
    return url;
  }
  private savedTimer = 0;

  // ------------------------------------------------------------------ input

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    // sliders keep their arrow keys
    if (t && t.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    e.stopImmediatePropagation();
    const k = e.key.toLowerCase();
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    if (k === 'escape' || k === 'y') {
      e.preventDefault();
      this.exit();
      return;
    }
    if (k === ' ' || k === 'enter') {
      e.preventDefault();
      void this.shutter();
      return;
    }
    if (k === 'h') {
      this.ui?.classList.toggle('ui-hidden');
      return;
    }
    if (k >= '1' && k <= '5') {
      this.setFilter(FILTERS[+k - 1].id);
      return;
    }
    if (k.startsWith('arrow')) e.preventDefault();
    this.keys.add(k);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.active) return;
    e.stopImmediatePropagation();
    this.keys.delete(e.key.toLowerCase());
  };

  private onBlur = () => this.keys.clear();

  private bindGestures(pad: HTMLElement) {
    let pinch = 0;
    let mid = { x: 0, y: 0 };
    const two = () => {
      const [a, b] = [...this.pointers.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      if (this.pointers.size === 2) {
        const t = two();
        pinch = t.d;
        mid = { x: t.x, y: t.y };
      }
    });
    pad.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size >= 2) {
        const t = two();
        if (pinch > 0 && t.d > 0) this.zoomBy(pinch / t.d);
        this.pan(t.x - mid.x, t.y - mid.y);
        pinch = t.d;
        mid = { x: t.x, y: t.y };
      } else if (p.button === 2 || p.button === 1 || p.shift || e.shiftKey) this.pan(dx, dy);
      else this.orbit(dx, dy);
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      pinch = 0;
      if (this.pointers.size === 2) {
        const t = two();
        pinch = t.d;
        mid = { x: t.x, y: t.y };
      }
    };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.0025));
      },
      { passive: false },
    );
  }

  // ------------------------------------------------------------------ UI

  private buildUi() {
    const r = this.host.renderer;
    const ui = document.createElement('div');
    ui.className = 'photo-ui';
    const ico = (p: string) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${p}</svg>`;
    const phase = r.atmos.phase >= 0 ? r.atmos.phase : 0.2;
    ui.innerHTML = `
      <div class="ph-pad"></div>
      <div class="ph-top"><b>PHOTO MODE</b><span class="ph-help">Drag to orbit · pinch / wheel to zoom · two fingers / WASD to move</span></div>
      <div class="ph-bar">
        <button class="ph-btn ph-exit" title="Leave photo mode (Y / Esc)">${ico('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6"/>')}<span>Exit</span></button>
        <button class="ph-btn" data-p="filters" title="Filters (1-5)">${ico('<circle cx="9" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="15" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>')}<span>Filters</span></button>
        <button class="ph-btn" data-p="adjust" title="Time of day, exposure, depth of field">${ico('<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h12M20 18h0" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="6" r="2.2"/><circle cx="9" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/>')}<span>Adjust</span></button>
        <button class="ph-btn ph-hide" title="Hide the controls (H)">${ico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3"/>')}<span>Hide</span></button>
      </div>
      <div class="ph-panel ph-filters hidden">${FILTERS.map((f, i) => `<button class="ph-chip${f.id === 'none' ? ' on' : ''}" data-f="${f.id}" title="${f.label} (${i + 1})">${f.label}</button>`).join('')}</div>
      <div class="ph-panel ph-adjust hidden">
        <label><span>Time of day <em class="ph-todv"></em></span><input type="range" data-s="tod" min="0" max="1" step="0.005" value="${phase}"></label>
        <label><span>Exposure <em class="ph-expv">0.0 EV</em></span><input type="range" data-s="exp" min="-2" max="2" step="0.05" value="0"></label>
        <label><span>Focus <em>near ↔ far</em></span><input type="range" data-s="focus" min="0" max="1" step="0.01" value="0.5"></label>
        <label><span>Depth of field <em class="ph-dofv">off</em></span><input type="range" data-s="blur" min="0" max="1" step="0.01" value="0"></label>
      </div>
      <button class="ph-shutter" title="Take photo (Space)" aria-label="Take photo"><i></i></button>
      <button class="ph-show" title="Show the controls (H)">${ico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3"/>')}</button>
      <a class="ph-saved hidden" target="_blank"></a>
      <div class="ph-flash"></div>`;
    this.host.layer.appendChild(ui);
    this.ui = ui;
    // keep every press inside photo mode away from the game's input
    ui.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bindGestures(ui.querySelector('.ph-pad') as HTMLElement);
    ui.querySelector<HTMLElement>('.ph-exit')!.onclick = () => this.exit();
    ui.querySelector<HTMLElement>('.ph-hide')!.onclick = () => ui.classList.add('ui-hidden');
    ui.querySelector<HTMLElement>('.ph-show')!.onclick = () => ui.classList.remove('ui-hidden');
    ui.querySelector<HTMLElement>('.ph-shutter')!.onclick = () => void this.shutter();
    ui.querySelectorAll<HTMLElement>('[data-p]').forEach((b) => {
      b.onclick = () => {
        const which = b.dataset.p!;
        ui.querySelectorAll<HTMLElement>('.ph-panel').forEach((p) => {
          const show = p.classList.contains(`ph-${which}`) && p.classList.contains('hidden');
          p.classList.toggle('hidden', !show);
        });
        ui.querySelectorAll<HTMLElement>('[data-p]').forEach((x) => x.classList.toggle('on', x === b && !ui.querySelector(`.ph-${which}`)!.classList.contains('hidden')));
      };
    });
    ui.querySelectorAll<HTMLElement>('.ph-chip').forEach((c) => (c.onclick = () => this.setFilter(c.dataset.f as Filter)));
    const todLabel = (u: number) => {
      const names: [number, string][] = [
        [0.1, 'Noon'],
        [0.27, 'Afternoon'],
        [0.35, 'Golden hour'],
        [0.4, 'Sunset'],
        [0.47, 'Dusk'],
        [0.75, 'Night'],
        [0.83, 'Dawn'],
        [0.95, 'Morning'],
        [1.01, 'Noon'],
      ];
      return names.find(([lim]) => u < lim)![1];
    };
    const todV = ui.querySelector<HTMLElement>('.ph-todv')!;
    todV.textContent = todLabel(phase);
    ui.querySelectorAll<HTMLInputElement>('input[data-s]').forEach((inp) => {
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.oninput = () => {
        const v = +inp.value;
        switch (inp.dataset.s) {
          case 'tod':
            this.tod = v;
            r.atmos.previewPhase(v);
            todV.textContent = todLabel(v);
            break;
          case 'exp':
            this.exposure = v;
            ui.querySelector('.ph-expv')!.textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`;
            break;
          case 'focus':
            this.focus = v;
            break;
          case 'blur':
            this.blur = v;
            ui.querySelector('.ph-dofv')!.textContent = v < 0.01 ? 'off' : `${Math.round(v * 100)}%`;
            break;
        }
      };
    });
  }
}
