import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { DEFS, FACTION_INFO, WEAPONS, buildingDef, unitDef } from '../sim/defs';
import { groundHeight, standHeight } from '../sim/map';
import type { Entity, Projectile, SimEvent } from '../sim/types';
import type { World } from '../sim/world';
import { Effects } from './effects';
import { FogOfWar } from './fog';
import { createModel, type Model, type ModelStyle } from './models';
import { Terrain } from './terrain';

export type Quality = 'low' | 'medium' | 'high';

export const AIR_ALT = 1.7;
const CAM_DIR = new THREE.Vector3(1, 1.18, 1).normalize();
const CAM_DIST = 80;
const BASE_VIEW = 22;

interface Visual {
  id: number;
  model: Model;
  owner: number;
  def: string;
  ring: THREE.Mesh | null;
  muzzleIdx: number;
  walk: number;
  fxTimer: number;
  emitTimer: number;
  recoil: number;
  visible: boolean;
  lastX: number;
  lastY: number;
  dying: number;
}

interface ProjVisual {
  obj: THREE.Object3D;
  y0: number;
  kind: 'shell' | 'rocket' | 'missile' | 'artillery';
}

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.35 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = 1.0 - dot(d, d) * strength * 2.2;
    c.rgb = mix(vec3(dot(c.rgb, vec3(0.299,0.587,0.114))), c.rgb, 1.08); gl_FragColor = vec4(c.rgb * v, c.a); }`,
};

export function styleFor(world: World, owner: number): ModelStyle {
  if (owner < 0) return { team: 0x9a9a9a, hull: 0x8a8070, accent: 0x6a6a6a, flag: [0x888888, 0xaaaaaa, 0x888888] };
  const p = world.players[owner];
  const f = FACTION_INFO[p.faction];
  return { team: p.color, hull: f.hull, accent: f.accent, flag: f.flag };
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly fog: FogOfWar;
  readonly terrain: Terrain;
  readonly effects: Effects;
  readonly target = new THREE.Vector3();
  zoom = 1;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private sun: THREE.DirectionalLight;
  private visuals = new Map<number, Visual>();
  private projVis = new Map<number, ProjVisual>();
  private ghost: THREE.Group | null = null;
  private ghostKey = '';
  private ghostTiles: THREE.Mesh[] = [];
  private ringGeo = new THREE.RingGeometry(0.92, 1.05, 32).rotateX(-Math.PI / 2);
  private boxRingGeo = new THREE.RingGeometry(0.95, 1.05, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2);
  private ringMats = new Map<string, THREE.MeshBasicMaterial>();
  private scheduled: { t: number; fn: () => void }[] = [];
  private time = 0;
  private width = 1;
  private height = 1;
  selection = new Set<number>();
  /** Player whose fog of war is shown (-1 = reveal all, e.g. attract mode). */
  viewer: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly world: World,
    viewer: number,
    readonly quality: Quality,
  ) {
    this.viewer = viewer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0x07090b);
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 400);

    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x5a4a35, 1.25);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = quality !== 'low';
    const sm = quality === 'high' ? 4096 : 2048;
    this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.AmbientLight(0x404858, 0.4));

    const { map } = world;
    this.fog = new FogOfWar(map.w, map.h);
    this.terrain = new Terrain(map, this.fog, quality);
    this.scene.add(this.terrain.group);
    this.effects = new Effects(this.scene, this.fog, quality);

    if (quality !== 'low') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.composer.addPass(new ShaderPass(VignetteShader));
    }

    if (viewer >= 0) {
      const p = world.players[viewer];
      this.target.set(p.startX + 0.5, 0, p.startY + 0.5);
      this.fog.update(p.explored, p.visible, 1, true);
    } else {
      this.target.set(map.w / 2, 0, map.h / 2);
      this.fog.revealAll();
      this.fog.uniforms.fogEnabled.value = 0;
    }
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w / 2, h / 2);
    this.updateCamera();
  }

  // ------------------------------------------------------------------ camera

  private updateCamera() {
    const aspect = this.width / Math.max(1, this.height);
    const vh = BASE_VIEW / this.zoom;
    this.camera.left = (-vh * aspect) / 2;
    this.camera.right = (vh * aspect) / 2;
    this.camera.top = vh / 2;
    this.camera.bottom = -vh / 2;
    this.camera.updateProjectionMatrix();
    const ty = groundHeight(this.world.map, this.target.x, this.target.z);
    const shake = this.effects?.shake ?? 0;
    const sx = shake ? (Math.random() - 0.5) * shake : 0;
    const sz = shake ? (Math.random() - 0.5) * shake : 0;
    this.camera.position.set(this.target.x + CAM_DIR.x * CAM_DIST + sx, ty + CAM_DIR.y * CAM_DIST, this.target.z + CAM_DIR.z * CAM_DIST + sz);
    this.camera.lookAt(this.target.x + sx, ty, this.target.z + sz);
    this.camera.updateMatrixWorld();
    // shadow frustum follows the view
    const r = vh * aspect * 0.75 + 4;
    const sc = this.sun.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 1;
    sc.far = 120;
    sc.updateProjectionMatrix();
    this.sun.position.set(this.target.x - 22, 40, this.target.z + 14);
    this.sun.target.position.set(this.target.x, 0, this.target.z);
    this.effects?.setPointScale((this.height * this.renderer.getPixelRatio()) / vh);
  }

  setZoom(z: number) {
    this.zoom = Math.max(0.45, Math.min(2.4, z));
  }

  /** Pan by screen-space pixels. */
  panPixels(dx: number, dy: number) {
    const vh = BASE_VIEW / this.zoom;
    const wpp = vh / this.height;
    const right = new THREE.Vector3(1, 0, -1).normalize();
    const up = new THREE.Vector3(-1, 0, -1).normalize();
    const elev = Math.asin(CAM_DIR.y);
    this.target.addScaledVector(right, dx * wpp);
    this.target.addScaledVector(up, (-dy * wpp) / Math.sin(elev));
    this.clampTarget();
  }

  centerOn(x: number, y: number) {
    this.target.set(x, 0, y);
    this.clampTarget();
  }

  private clampTarget() {
    const { w, h } = this.world.map;
    this.target.x = Math.max(2, Math.min(w - 2, this.target.x));
    this.target.z = Math.max(2, Math.min(h - 2, this.target.z));
  }

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  /** Screen pixel -> map tile-space point on the terrain. */
  screenToGround(sx: number, sy: number): { x: number; y: number } {
    this.ndc.set((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    let h = 0;
    let px = 0;
    let pz = 0;
    for (let i = 0; i < 5; i++) {
      const t = (o.y - h) / -d.y;
      px = o.x + d.x * t;
      pz = o.z + d.z * t;
      const { w, h: mh } = this.world.map;
      h = standHeight(this.world.map, Math.max(0, Math.min(w - 0.01, px)), Math.max(0, Math.min(mh - 0.01, pz)));
    }
    return { x: px, y: pz };
  }

  private v3 = new THREE.Vector3();
  project(x: number, y: number, z: number): { x: number; y: number } {
    this.v3.set(x, y, z).project(this.camera);
    return { x: ((this.v3.x + 1) / 2) * this.width, y: ((1 - this.v3.y) / 2) * this.height };
  }

  /** Ground-plane corners of the current view (for the minimap). */
  viewCorners(): { x: number; y: number }[] {
    return [
      this.screenToGround(0, 0),
      this.screenToGround(this.width, 0),
      this.screenToGround(this.width, this.height),
      this.screenToGround(0, this.height),
    ];
  }

  // ---------------------------------------------------------------- entities

  entityPos(e: Entity, alpha: number): THREE.Vector3 {
    const x = e.px + (e.x - e.px) * alpha;
    const y = e.py + (e.y - e.py) * alpha;
    let h = standHeight(this.world.map, x, y);
    if (e.kind === 'unit' && unitDef(e.def).air) h = Math.max(h, 0) + this.altitude(e);
    return new THREE.Vector3(x, h, y);
  }

  altitude(e: Entity) {
    const d = unitDef(e.def);
    if (!d.air) return 0;
    if (d.kamikaze) {
      const t = this.world.get(e.targetId);
      const dist = t ? Math.hypot(t.x - e.x, t.y - e.y) : 9;
      return Math.min(1.4, 0.25 + dist * 0.35);
    }
    const base = d.model === 'jet' ? AIR_ALT + 0.6 : AIR_ALT;
    return base + Math.sin(this.time * 1.7 + e.id) * 0.06;
  }

  isVisibleToViewer(e: Entity): boolean {
    if (this.viewer < 0 || e.owner === this.viewer) return true;
    const p = this.world.players[this.viewer];
    const { w } = this.world.map;
    if (e.kind === 'building') {
      const d = buildingDef(e.def);
      for (let y = e.ty; y < e.ty + d.h; y++) for (let x = e.tx; x < e.tx + d.w; x++) if (p.explored[y * w + x]) return true;
      return false;
    }
    const tx = Math.floor(e.x);
    const ty = Math.floor(e.y);
    return p.visible[ty * w + tx] > 0;
  }

  private makeVisual(e: Entity): Visual {
    const d = DEFS[e.def];
    const model = createModel(d.model, styleFor(this.world, e.owner), this.fog);
    this.scene.add(model.root);
    return { id: e.id, model, owner: e.owner, def: e.def, ring: null, muzzleIdx: 0, walk: Math.random() * 6, fxTimer: Math.random(), emitTimer: Math.random(), recoil: 0, visible: true, lastX: e.x, lastY: e.y, dying: 0 };
  }

  private removeVisual(v: Visual) {
    this.scene.remove(v.model.root);
    if (v.ring) this.scene.remove(v.ring);
    this.visuals.delete(v.id);
  }

  private ringMat(color: number) {
    const key = color.toString(16);
    let m = this.ringMats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
      this.ringMats.set(key, m);
    }
    return m;
  }

  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpN = new THREE.Vector3();
  private yAxis = new THREE.Vector3(0, 1, 0);

  private syncEntities(alpha: number, dt: number) {
    const w = this.world;
    const seen = new Set<number>();
    for (const e of w.list) {
      if (e.dead) continue;
      seen.add(e.id);
      let v = this.visuals.get(e.id);
      if (v && v.owner !== e.owner) {
        this.removeVisual(v);
        v = undefined;
      }
      if (!v) {
        v = this.makeVisual(e);
        this.visuals.set(e.id, v);
      }
      const vis = this.isVisibleToViewer(e);
      v.model.root.visible = vis;
      v.visible = vis;
      const d = DEFS[e.def];
      const root = v.model.root;
      if (e.kind === 'building') {
        const bd = buildingDef(e.def);
        const h = groundHeight(w.map, e.x, e.y);
        root.position.set(e.tx + bd.w / 2, Math.max(h, -0.1), e.ty + bd.h / 2);
        const k = e.buildAnim;
        const ease = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3);
        root.scale.set(1, Math.max(0.02, ease), 1);
        if (k < 1 && vis && Math.random() < dt * 20) this.effects.smoke(root.position.x + (Math.random() - 0.5) * bd.w, h + 0.1, root.position.z + (Math.random() - 0.5) * bd.h, 0.6, false);
        if (v.model.turret) v.model.turret.rotation.y = -lerpAngle(e.pturret, e.turret, alpha);
      } else {
        const ud = unitDef(e.def);
        const p = this.entityPos(e, alpha);
        root.position.copy(p);
        const yaw = -lerpAngle(e.pfacing, e.facing, alpha);
        if (ud.air) {
          const bank = Math.max(-0.5, Math.min(0.5, angleDiff(e.pfacing, e.facing) * 6));
          root.rotation.set(bank, yaw, 0, 'YXZ');
          if (ud.kamikaze) root.rotation.z = -0.25;
        } else if (ud.category === 'vehicle') {
          // tilt to the terrain slope
          const m = w.map;
          const hx = standHeight(m, p.x + 0.35, p.z) - standHeight(m, p.x - 0.35, p.z);
          const hz = standHeight(m, p.x, p.z + 0.35) - standHeight(m, p.x, p.z - 0.35);
          this.tmpN.set(-hx / 0.7, 1, -hz / 0.7).normalize();
          this.tmpQ.setFromUnitVectors(this.yAxis, this.tmpN);
          this.tmpQ2.setFromAxisAngle(this.yAxis, yaw);
          root.quaternion.copy(this.tmpQ).multiply(this.tmpQ2);
        } else {
          root.rotation.set(0, yaw, 0);
        }
        if (v.model.turret) v.model.turret.rotation.y = -angleDiff(lerpAngle(e.pfacing, e.facing, alpha), lerpAngle(e.pturret, e.turret, alpha));
        // walking animation
        const moved = Math.hypot(e.x - v.lastX, e.y - v.lastY);
        v.lastX = e.x;
        v.lastY = e.y;
        if (v.model.legs) {
          if (moved > 0.001 || e.moving) v.walk += dt * 11;
          const swing = e.moving ? Math.sin(v.walk) * 0.6 : 0;
          v.model.legs[0].rotation.z = swing;
          v.model.legs[1].rotation.z = -swing;
        }
        for (const r of v.model.rotors) r.rotation.y += dt * 40;
        // damage smoke on vehicles
        if (vis && ud.category !== 'infantry' && e.hp < e.maxHp * 0.35) {
          v.fxTimer -= dt;
          if (v.fxTimer <= 0) {
            v.fxTimer = 0.18;
            this.effects.smoke(p.x, p.y + 0.35, p.z, 0.7);
            if (e.hp < e.maxHp * 0.18) this.effects.flame(p.x, p.y + 0.3, p.z, 0.6);
          }
        }
        // EW jamming pulse
        if (vis && ud.ewRadius) {
          v.emitTimer -= dt;
          if (v.emitTimer <= 0) {
            v.emitTimer = 1.4;
            this.effects.jamPulse(p.x, p.y, p.z, ud.ewRadius);
          }
        }
        if (vis && e.jammedUntil > w.tick && Math.random() < dt * 8) this.effects.spark(p.x, p.y, p.z, 0x70b0ff);
      }
      // recoil
      if (v.model.recoil && v.recoil > 0) {
        v.recoil = Math.max(0, v.recoil - dt * 4);
        for (const r of v.model.recoil) r.position.x = (r.userData.baseX ??= r.position.x) - v.recoil * 0.12;
      }
      for (const s of v.model.spinners) s.obj.rotation[s.axis] += s.speed * dt;
      for (const g of v.model.glow) {
        const gm = g as THREE.MeshStandardMaterial;
        if ('emissiveIntensity' in gm && gm.userData.pulse) gm.emissiveIntensity = 2 + Math.sin(this.time * 4) * 1;
      }
      if (vis && e.kind === 'building') {
        const bd = buildingDef(e.def);
        const lowPower = e.owner >= 0 && w.isLowPower(w.players[e.owner]);
        // ambient emitters (steam, smoke)
        v.emitTimer -= dt;
        if (v.model.emitters.length && v.emitTimer <= 0 && e.buildAnim >= 1) {
          v.emitTimer = lowPower ? 0.6 : 0.25;
          for (const em of v.model.emitters) {
            const wp = em.pos.clone().applyMatrix4(root.matrixWorld);
            if (em.kind === 'spark') this.effects.spark(wp.x, wp.y, wp.z);
            else this.effects.smoke(wp.x, wp.y, wp.z, em.kind === 'steam' ? 0.9 : 0.6, em.kind === 'smoke');
          }
        }
        // damage fires
        if (e.hp < e.maxHp * 0.5) {
          v.fxTimer -= dt;
          if (v.fxTimer <= 0) {
            v.fxTimer = 0.15;
            const fx = e.tx + 0.3 + Math.random() * (bd.w - 0.6);
            const fz = e.ty + 0.3 + Math.random() * (bd.h - 0.6);
            const fy = groundHeight(w.map, fx, fz) + v.model.height * 0.6;
            this.effects.smoke(fx, fy, fz, 1);
            if (e.hp < e.maxHp * 0.25) this.effects.flame(fx, fy, fz, 1.2);
          }
        }
        if (e.repairing && Math.random() < dt * 3) this.effects.spark(root.position.x + (Math.random() - 0.5) * bd.w, root.position.y + v.model.height * Math.random(), root.position.z + (Math.random() - 0.5) * bd.h, 0x80ff80);
      }
      // selection ring
      const sel = this.selection.has(e.id) && vis;
      if (sel && !v.ring) {
        const own = e.owner === this.viewer;
        const mat = this.ringMat(own ? 0x5dff7a : e.owner < 0 ? 0xffe060 : 0xff4040);
        if (e.kind === 'building') {
          const bd = buildingDef(e.def);
          v.ring = new THREE.Mesh(this.boxRingGeo, mat);
          v.ring.scale.set((bd.w / 2) * 1.414 * 0.98, 1, (bd.h / 2) * 1.414 * 0.98);
        } else {
          v.ring = new THREE.Mesh(this.ringGeo, mat);
          v.ring.scale.setScalar(Math.max(0.28, (d as { radius?: number }).radius! * 1.25));
        }
        v.ring.renderOrder = 2;
        this.scene.add(v.ring);
      } else if (!sel && v.ring) {
        this.scene.remove(v.ring);
        v.ring = null;
      }
      if (v.ring) {
        const rp = root.position;
        const gy = e.kind === 'unit' && unitDef(e.def).air ? standHeight(w.map, rp.x, rp.z) : rp.y;
        v.ring.position.set(rp.x, gy + 0.04, rp.z);
      }
    }
    for (const v of [...this.visuals.values()]) if (!seen.has(v.id)) this.removeVisual(v);
  }

  // ------------------------------------------------------------- projectiles

  private projMats = {
    shell: new THREE.MeshBasicMaterial({ color: 0xffd080, toneMapped: false }),
    body: new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5, metalness: 0.4 }),
    nose: new THREE.MeshBasicMaterial({ color: 0xff7030, toneMapped: false }),
  };
  private projGeo = {
    shell: new THREE.SphereGeometry(0.05, 6, 4),
    rocket: new THREE.CylinderGeometry(0.03, 0.03, 0.28, 6).rotateZ(Math.PI / 2),
    missile: new THREE.CylinderGeometry(0.07, 0.08, 0.8, 8).rotateZ(Math.PI / 2),
  };

  private projPos(p: Projectile, v: ProjVisual, t: number): THREE.Vector3 {
    const x = p.sx + (p.tx - p.sx) * t;
    const z = p.sy + (p.ty - p.sy) * t;
    const tgt = this.world.get(p.targetId);
    let y1 = standHeight(this.world.map, p.tx, p.ty) + 0.2;
    if (tgt && tgt.kind === 'unit' && unitDef(tgt.def).air) y1 = standHeight(this.world.map, tgt.x, tgt.y) + this.altitude(tgt);
    const dist = Math.hypot(p.tx - p.sx, p.ty - p.sy);
    const arc = v.kind === 'artillery' ? dist * 0.32 : v.kind === 'missile' ? Math.min(9, dist * 0.55) : v.kind === 'rocket' ? dist * 0.06 : dist * 0.02;
    const y = v.y0 + (y1 - v.y0) * t + Math.sin(Math.PI * t) * arc;
    return new THREE.Vector3(x, y, z);
  }

  private syncProjectiles(alpha: number) {
    const seen = new Set<number>();
    for (const p of this.world.projectiles) {
      seen.add(p.id);
      let v = this.projVis.get(p.id);
      const wpn = WEAPONS[p.weapon];
      if (!v) {
        const kind: ProjVisual['kind'] = wpn.projectile === 'shell' ? 'shell' : wpn.projectile === 'missile' ? 'missile' : wpn.projectile === 'artillery' ? 'artillery' : 'rocket';
        let obj: THREE.Object3D;
        if (kind === 'shell' || (kind === 'artillery' && wpn.warhead !== 'thermo')) obj = new THREE.Mesh(this.projGeo.shell, this.projMats.shell);
        else if (kind === 'missile') {
          obj = new THREE.Group();
          obj.add(new THREE.Mesh(this.projGeo.missile, this.projMats.body));
          const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 8).rotateZ(-Math.PI / 2), this.projMats.nose);
          nose.position.x = 0.5;
          obj.add(nose);
        } else obj = new THREE.Mesh(this.projGeo.rocket, this.projMats.body);
        const src = this.world.get(p.sourceId);
        const y0 = src ? this.entityPos(src, 1).y + (src.kind === 'building' ? 0.9 : 0.35) : standHeight(this.world.map, p.sx, p.sy) + 0.4;
        v = { obj, y0, kind: kind === 'artillery' && wpn.warhead === 'thermo' ? 'rocket' : kind };
        this.scene.add(obj);
        this.projVis.set(p.id, v);
      }
      const t = Math.max(0, Math.min(1, p.progress - p.step * (1 - alpha)));
      const pos = this.projPos(p, v, t);
      const ahead = this.projPos(p, v, Math.min(1, t + 0.02));
      v.obj.position.copy(pos);
      if (ahead.distanceToSquared(pos) > 1e-8) {
        v.obj.lookAt(ahead);
        v.obj.rotateY(-Math.PI / 2);
      }
      const visible = this.viewer < 0 || this.world.visibleTo(this.viewer, pos.x, pos.z) || p.owner === this.viewer;
      v.obj.visible = visible;
      if (visible) this.effects.trail(pos, v.kind);
    }
    for (const [id, v] of this.projVis) {
      if (!seen.has(id)) {
        this.scene.remove(v.obj);
        this.projVis.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ events

  private muzzleOf(e: Entity): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    const v = this.visuals.get(e.id);
    const dir = new THREE.Vector3(Math.cos(e.turret), 0, Math.sin(e.turret));
    if (v && v.model.muzzles.length) {
      const m = v.model.muzzles[v.muzzleIdx++ % v.model.muzzles.length];
      v.model.root.updateMatrixWorld(true);
      const pos = new THREE.Vector3();
      m.getWorldPosition(pos);
      v.recoil = 1;
      return { pos, dir };
    }
    const p = this.entityPos(e, 1);
    p.y += e.kind === 'building' ? 0.9 : 0.3;
    p.addScaledVector(dir, 0.3);
    return { pos: p, dir };
  }

  private targetPoint(id: number, x: number, y: number): THREE.Vector3 {
    const t = this.world.get(id);
    if (t) {
      const p = this.entityPos(t, 1);
      if (t.kind === 'building') p.y += 0.4;
      else if (!unitDef(t.def).air) p.y += unitDef(t.def).category === 'infantry' ? 0.18 : 0.25;
      if (t.kind === 'building') {
        p.x = x;
        p.z = y;
      }
      return p;
    }
    return new THREE.Vector3(x, standHeight(this.world.map, x, y) + 0.2, y);
  }

  private visibleAt(x: number, y: number) {
    return this.viewer < 0 || this.world.visibleTo(this.viewer, x, y);
  }

  handleEvent(ev: SimEvent) {
    const fx = this.effects;
    switch (ev.t) {
      case 'fire': {
        const src = this.world.get(ev.id);
        if (!src) break;
        if (!this.visibleAt(ev.x, ev.y) && !this.visibleAt(ev.tx, ev.ty)) break;
        const wpn = WEAPONS[ev.weapon];
        const { pos, dir } = this.muzzleOf(src);
        const tp = this.targetPoint(ev.targetId, ev.tx, ev.ty);
        switch (wpn.projectile) {
          case 'instant':
            fx.muzzle(pos, dir, wpn.warhead === 'flak' ? 0.6 : 0.4);
            fx.tracer(pos, tp);
            break;
          case 'beam':
            fx.laser(pos, tp);
            break;
          case 'shell':
            fx.muzzle(pos, dir, 1.2);
            break;
          case 'artillery':
            fx.muzzle(pos, dir, wpn.warhead === 'thermo' ? 0.8 : 1.6);
            break;
          case 'rocket':
          case 'missile':
            fx.muzzle(pos, dir, wpn.projectile === 'missile' ? 1.6 : 0.6, 0xfff0c0);
            break;
          case 'spawn':
            fx.muzzle(pos, dir, 0.5, 0xfff0c0);
            break;
        }
        break;
      }
      case 'impact': {
        if (!this.visibleAt(ev.x, ev.y)) break;
        const wpn = WEAPONS[ev.weapon];
        let y = standHeight(this.world.map, ev.x, ev.y) + 0.1;
        if (ev.air) y += 1.0;
        if (wpn.projectile === 'instant' && wpn.damage < 30) break; // tracer already shows the hit
        if (wpn.projectile === 'beam') break;
        const size = wpn.damage >= 200 ? 'huge' : wpn.damage >= 85 || wpn.splash ? 'medium' : wpn.damage >= 50 ? 'small' : 'tiny';
        fx.explosion(ev.x, y, ev.y, wpn.warhead === 'thermo' ? 'medium' : size, wpn.warhead === 'thermo' ? 'thermo' : ev.air ? 'air' : 'fire');
        break;
      }
      case 'intercept': {
        const t = this.world.get(ev.id);
        if (!t || !this.visibleAt(ev.x, ev.y)) break;
        const p = this.entityPos(t, 1);
        p.y += 0.45;
        p.x += Math.cos(t.turret) * 0.5;
        p.z += Math.sin(t.turret) * 0.5;
        fx.intercept(p);
        break;
      }
      case 'death': {
        if (!this.visibleAt(ev.x, ev.y)) break;
        const d = DEFS[ev.def];
        const gy = standHeight(this.world.map, ev.x, ev.y);
        if (d.kind === 'building') {
          const bd = buildingDef(ev.def);
          const n = bd.w * bd.h;
          for (let i = 0; i < Math.min(8, n + 1); i++) {
            const ex = ev.x + (Math.random() - 0.5) * bd.w;
            const ez = ev.y + (Math.random() - 0.5) * bd.h;
            this.schedule(i * 0.12, () => fx.explosion(ex, gy + 0.3, ez, i === 0 ? 'large' : 'medium'));
          }
          this.schedule(0.5, () => fx.explosion(ev.x, gy + 0.2, ev.y, bd.w >= 3 ? 'huge' : 'large'));
          this.schedule(0.6, () => fx.scorch(ev.x, gy, ev.y, Math.max(bd.w, bd.h) * 0.8));
          for (let i = 0; i < 20; i++) this.schedule(0.6 + i * 0.25, () => fx.smoke(ev.x + (Math.random() - 0.5) * bd.w, gy + 0.2, ev.y + (Math.random() - 0.5) * bd.h, 1.6));
        } else {
          const ud = d as ReturnType<typeof unitDef>;
          if (ud.air) {
            const y = gy + (ud.kamikaze ? 0.8 : AIR_ALT);
            fx.explosion(ev.x, y, ev.y, ud.kamikaze ? 'small' : 'medium', 'air');
            if (!ud.kamikaze) this.schedule(0.5, () => fx.explosion(ev.x, gy + 0.1, ev.y, 'medium'));
          } else if (ud.category === 'infantry') {
            fx.explosion(ev.x, gy + 0.05, ev.y, 'small', 'dust');
          } else {
            fx.explosion(ev.x, gy + 0.2, ev.y, ud.harvester || ud.mcv ? 'huge' : 'large');
            for (let i = 0; i < 12; i++) this.schedule(0.3 + i * 0.3, () => {
              fx.smoke(ev.x, gy + 0.3, ev.y, 1.1);
              if (i < 6) fx.flame(ev.x, gy + 0.2, ev.y, 0.9);
            });
          }
        }
        break;
      }
      case 'placed':
      case 'deployed': {
        const b = this.world.get(ev.id);
        if (!b || !this.visibleAt(b.x, b.y)) break;
        const bd = buildingDef(b.def);
        const gy = groundHeight(this.world.map, b.x, b.y);
        fx.ring(b.x, gy + 0.05, b.y, 0.5, Math.max(bd.w, bd.h) * 1.1, 0.7, 0xd8c8a0, false);
        for (let i = 0; i < 10; i++) fx.smoke(b.x + (Math.random() - 0.5) * bd.w, gy + 0.1, b.y + (Math.random() - 0.5) * bd.h, 1, false);
        break;
      }
      case 'sold':
      case 'captured': {
        const b = this.world.entities.get(ev.id);
        if (!b || !this.visibleAt(b.x, b.y)) break;
        const gy = groundHeight(this.world.map, b.x, b.y);
        for (let i = 0; i < 8; i++) fx.smoke(b.x + (Math.random() - 0.5) * 2, gy + 0.2, b.y + (Math.random() - 0.5) * 2, 1, false);
        break;
      }
    }
  }

  private schedule(delay: number, fn: () => void) {
    this.scheduled.push({ t: this.time + delay, fn });
  }

  // ---------------------------------------------------------- placement ghost

  setGhost(defId: string | null, tx: number, ty: number, valid: boolean, owner: number) {
    if (!defId) {
      if (this.ghost) this.scene.remove(this.ghost);
      for (const t of this.ghostTiles) this.scene.remove(t);
      this.ghost = null;
      this.ghostKey = '';
      this.ghostTiles = [];
      return;
    }
    const d = buildingDef(defId);
    if (this.ghostKey !== defId) {
      this.setGhost(null, 0, 0, false, owner);
      const model = createModel(d.model, styleFor(this.world, owner), null);
      const mat = new THREE.MeshBasicMaterial({ color: 0x80ff90, transparent: true, opacity: 0.45, depthWrite: false });
      model.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          (o as THREE.Mesh).material = mat;
          o.castShadow = false;
        }
      });
      this.ghost = model.root;
      this.scene.add(this.ghost);
      this.ghostKey = defId;
      const tileGeo = new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2);
      for (let i = 0; i < d.w * d.h; i++) {
        const m = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.35, depthWrite: false }));
        m.renderOrder = 5;
        this.ghostTiles.push(m);
        this.scene.add(m);
      }
    }
    const g = this.ghost!;
    const color = valid ? 0x80ff90 : 0xff5050;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(color);
    });
    const cx = tx + d.w / 2;
    const cy = ty + d.h / 2;
    g.position.set(cx, groundHeight(this.world.map, cx, cy), cy);
    let i = 0;
    for (let y = 0; y < d.h; y++)
      for (let x = 0; x < d.w; x++) {
        const m = this.ghostTiles[i++];
        const px = tx + x + 0.5;
        const pz = ty + y + 0.5;
        m.position.set(px, standHeight(this.world.map, px, pz) + 0.05, pz);
        (m.material as THREE.MeshBasicMaterial).color.setHex(valid ? 0x40ff60 : 0xff3030);
      }
  }

  // ------------------------------------------------------------------- frame

  render(alpha: number, dt: number) {
    this.time += dt;
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      if (this.scheduled[i].t <= this.time) {
        const s = this.scheduled[i];
        this.scheduled.splice(i, 1);
        s.fn();
      }
    }
    if (this.viewer >= 0) {
      const p = this.world.players[this.viewer];
      this.fog.update(p.explored, p.visible, dt);
    }
    this.syncEntities(alpha, dt);
    this.syncProjectiles(alpha);
    this.terrain.update(this.time);
    if (Math.floor(this.time * 4) !== Math.floor((this.time - dt) * 4)) this.terrain.updateOre();
    this.effects.update(dt);
    this.updateCamera();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Model height for a live entity (health bar placement). */
  visualHeight(id: number): number {
    return this.visuals.get(id)?.model.height ?? 0.5;
  }

  isShown(id: number) {
    return this.visuals.get(id)?.visible ?? false;
  }

  dispose() {
    this.renderer.dispose();
    this.composer?.dispose();
  }
}

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function lerpAngle(a: number, b: number, t: number) {
  return a + angleDiff(a, b) * t;
}
