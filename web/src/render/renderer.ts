import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { DEFS, FACTION_INFO, WEAPONS, buildingDef, unitDef } from '../sim/defs';
import { groundHeight, standHeight } from '../sim/map';
import { TPS, type Entity, type Projectile, type SimEvent } from '../sim/types';
import type { World } from '../sim/world';
import { Debris } from './debris';
import { BLASTS, Effects, type BlastProfile } from './effects';
import { FogOfWar } from './fog';
import { GroundMarks } from './marks';
import { FACTION_REGION, createModel, createMunition, type AnimState, type Model, type ModelStyle, type MunitionKind } from './models';
import { Terrain } from './terrain';

export type Quality = 'low' | 'medium' | 'high';

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
  fxTimer: number;
  emitTimer: number;
  exhaustTimer: number;
  recoil: number;
  visible: boolean;
  lastX: number;
  lastZ: number;
  lastYaw: number;
  dist: number;
  speed: number;
  turn: number;
  lastFire: number;
  trackAcc: number;
  bank: number;
  anim: AnimState;
}

interface Wreck {
  kind: 'infantry' | 'vehicle' | 'air' | 'building' | 'sold';
  root: THREE.Object3D;
  model: Model;
  t: number;
  max: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  size: number;
  h: number;
  w: number;
  d: number;
  turret?: { obj: THREE.Object3D; vx: number; vy: number; vz: number; wx: number; wz: number; landed: boolean };
  landed: boolean;
  anim?: AnimState;
}

interface ProjVisual {
  obj: THREE.Object3D;
  streak: THREE.Mesh | null;
  last: THREE.Vector3;
  first: boolean;
}

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.32 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = 1.0 - dot(d, d) * strength * 2.2;
    c.rgb = mix(vec3(dot(c.rgb, vec3(0.299,0.587,0.114))), c.rgb, 1.1); gl_FragColor = vec4(c.rgb * v, c.a); }`,
};

export function styleFor(world: World, owner: number): ModelStyle {
  if (owner < 0) return { team: 0x9a9a9a, hull: 0x8a8070, accent: 0x6a6a6a, flag: [0x888888, 0xaaaaaa, 0x888888], faction: 'neutral', region: 'west' };
  const p = world.players[owner];
  const f = FACTION_INFO[p.faction];
  return { team: p.color, hull: f.hull, accent: f.accent, flag: f.flag, faction: p.faction, region: FACTION_REGION[p.faction] };
}

function newAnim(): AnimState {
  return { dt: 0, time: 0, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true };
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

const MUNITION_FALLBACK: Record<string, MunitionKind> = {
  shell: 'tankShell',
  artillery: 'artilleryShell',
  mortar: 'mortarBomb',
  rocketSalvo: 'rocket',
  atgm: 'atgm',
  topAttack: 'atgm',
  sam: 'sam',
  interceptor: 'interceptor',
  airMissile: 'airMissile',
  ballistic: 'ballistic',
  hypersonic: 'hypersonic',
};

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly fog: FogOfWar;
  readonly terrain: Terrain;
  readonly effects: Effects;
  readonly debris: Debris;
  readonly marks: GroundMarks;
  readonly target = new THREE.Vector3();
  zoom = 1;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private gtao: GTAOPass | null = null;
  private sun: THREE.DirectionalLight;
  private visuals = new Map<number, Visual>();
  private wrecks: Wreck[] = [];
  private projVis = new Map<number, ProjVisual>();
  private ghost: THREE.Group | null = null;
  private ghostKey = '';
  private ghostTiles: THREE.Mesh[] = [];
  private ringGeo = new THREE.RingGeometry(0.92, 1.05, 32).rotateX(-Math.PI / 2);
  private boxRingGeo = new THREE.RingGeometry(0.95, 1.05, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2);
  private ringMats = new Map<string, THREE.MeshBasicMaterial>();
  private burnt: THREE.MeshStandardMaterial;
  private streakGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  private streakMat = new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  private scheduled: { t: number; fn: () => void }[] = [];
  private time = 0;
  private width = 1;
  private height = 1;
  private frameTimes: number[] = [];
  private pixelRatio: number;
  private maxPixelRatio: number;
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
    this.maxPixelRatio = Math.min(window.devicePixelRatio, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0x07090b);
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 400);

    // image based lighting for believable metal and glass
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x5a4a35, 1.0);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
    this.sun.castShadow = quality !== 'low';
    const sm = quality === 'high' ? 4096 : 2048;
    this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.AmbientLight(0x404858, 0.3));

    const { map } = world;
    this.fog = new FogOfWar(map.w, map.h);
    this.terrain = new Terrain(map, this.fog, quality);
    this.scene.add(this.terrain.group);
    this.effects = new Effects(this.scene, this.fog, quality);
    this.debris = new Debris(map, this.effects, this.fog);
    this.marks = new GroundMarks(map, this.fog);
    this.effects.debris = this.debris;
    this.effects.marks = this.marks;
    this.scene.add(this.debris.group, this.marks.group);
    this.burnt = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x1c1916, roughness: 0.95, metalness: 0.15 }));

    if (quality !== 'low') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      if (quality === 'high') {
        try {
          this.gtao = new GTAOPass(this.scene, this.camera, 256, 256);
          this.gtao.blendIntensity = 0.85;
          this.gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1, scale: 1 });
          this.composer.addPass(this.gtao);
        } catch {
          this.gtao = null;
        }
      }
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.85);
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
    this.zoom = Math.max(0.45, Math.min(3.2, z));
  }

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

  viewCorners(): { x: number; y: number }[] {
    return [this.screenToGround(0, 0), this.screenToGround(this.width, 0), this.screenToGround(this.width, this.height), this.screenToGround(0, this.height)];
  }

  // ---------------------------------------------------------------- entities

  /** World position of an entity (x, height, y). Aircraft use their simulated altitude. */
  entityPos(e: Entity, alpha: number): THREE.Vector3 {
    const x = e.px + (e.x - e.px) * alpha;
    const y = e.py + (e.y - e.py) * alpha;
    let h = standHeight(this.world.map, x, y);
    if (e.kind === 'unit' && unitDef(e.def).air) {
      const d = unitDef(e.def);
      const z = e.pz + (e.z - e.pz) * alpha;
      h = Math.max(h, 0) + z + (d.kamikaze || d.fixedWing ? 0 : Math.sin(this.time * 1.7 + e.id) * 0.04);
    }
    return new THREE.Vector3(x, h, y);
  }

  isVisibleToViewer(e: Entity): boolean {
    if (e.inside >= 0) return false;
    if (this.viewer < 0 || e.owner === this.viewer) return true;
    const p = this.world.players[this.viewer];
    const { w } = this.world.map;
    if (e.kind === 'building') {
      const d = buildingDef(e.def);
      for (let y = e.ty; y < e.ty + d.h; y++) for (let x = e.tx; x < e.tx + d.w; x++) if (p.explored[y * w + x]) return true;
      return false;
    }
    return p.visible[Math.floor(e.y) * w + Math.floor(e.x)] > 0;
  }

  private makeVisual(e: Entity): Visual {
    const d = DEFS[e.def];
    const model = createModel(d.model, styleFor(this.world, e.owner), this.fog);
    this.scene.add(model.root);
    return {
      id: e.id,
      model,
      owner: e.owner,
      def: e.def,
      ring: null,
      muzzleIdx: 0,
      fxTimer: Math.random(),
      emitTimer: Math.random(),
      exhaustTimer: Math.random() * 0.2,
      recoil: 0,
      visible: true,
      lastX: e.x,
      lastZ: e.y,
      lastYaw: -e.facing,
      dist: 0,
      speed: 0,
      turn: 0,
      lastFire: -1e9,
      trackAcc: 0,
      bank: 0,
      anim: newAnim(),
    };
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

  private legacyAnim(m: Model, s: AnimState) {
    for (const r of m.rotors ?? []) r.rotation.y += s.dt * 40;
    for (const sp of m.spinners ?? []) sp.obj.rotation[sp.axis] += sp.speed * s.dt;
    if (m.legs) {
      const swing = s.moving ? Math.sin(s.dist * 18) * 0.6 : 0;
      m.legs[0].rotation.z = swing;
      m.legs[1].rotation.z = -swing;
    }
  }

  private syncEntities(alpha: number, dt: number) {
    const w = this.world;
    const seen = new Set<number>();
    for (const e of w.list) {
      if (e.dead || e.inside >= 0) continue;
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
      const a = v.anim;
      a.dt = dt;
      a.time = this.time;
      a.fired = this.time - v.lastFire;
      a.damage = 1 - e.hp / e.maxHp;
      if (e.kind === 'building') {
        const bd = buildingDef(e.def);
        const h = groundHeight(w.map, e.x, e.y);
        root.position.set(e.tx + bd.w / 2, Math.max(h, -0.1), e.ty + bd.h / 2);
        const k = e.buildAnim;
        const ease = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3);
        root.scale.set(1, Math.max(0.02, ease), 1);
        a.built = k;
        a.powered = e.owner < 0 || !w.isLowPower(w.players[e.owner]);
        a.moving = false;
        if (k < 1 && vis && Math.random() < dt * 20) this.effects.dust(root.position.x + (Math.random() - 0.5) * bd.w, h + 0.05, root.position.z + (Math.random() - 0.5) * bd.h, 1.5);
        if (v.model.turret) v.model.turret.rotation.y = -lerpAngle(e.pturret, e.turret, alpha);
        if (vis) this.buildingFx(e, v, dt);
      } else {
        const ud = unitDef(e.def);
        const p = this.entityPos(e, alpha);
        root.position.copy(p);
        const yaw = -lerpAngle(e.pfacing, e.facing, alpha);
        const moved = Math.hypot(p.x - v.lastX, p.z - v.lastZ);
        v.lastX = p.x;
        v.lastZ = p.z;
        const yawRate = dt > 0 ? angleDiff(v.lastYaw, yaw) / dt : 0;
        v.lastYaw = yaw;
        v.dist += moved;
        if (dt > 0) v.speed += (moved / dt - v.speed) * Math.min(1, dt * 8);
        v.turn += (yawRate - v.turn) * Math.min(1, dt * 6);
        a.moving = v.speed > 0.05 || e.moving;
        a.speed = v.speed;
        a.dist = v.dist;
        a.turn = v.turn;
        if (ud.air) {
          // bank into turns, pitch nose-down with speed (helicopters)
          v.bank += (Math.max(-0.6, Math.min(0.6, -v.turn * (ud.fixedWing ? 0.45 : 0.18))) - v.bank) * Math.min(1, dt * 4);
          const pitch = ud.fixedWing || ud.kamikaze ? 0 : -Math.min(0.18, v.speed * 0.05);
          root.rotation.set(v.bank, yaw, pitch, 'YXZ');
          if (ud.kamikaze) {
            const climb = (e.z - e.pz) * TPS;
            root.rotation.z = Math.max(-0.9, Math.min(0.4, climb * 0.25));
          }
        } else if (ud.category === 'vehicle') {
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
        if (vis) this.unitFx(e, v, p, yaw, moved, dt);
      }
      if (v.model.anim) v.model.anim(a);
      this.legacyAnim(v.model, a);
      if (v.model.recoil && v.recoil > 0) {
        v.recoil = Math.max(0, v.recoil - dt * 4);
        for (const r of v.model.recoil) r.position.x = (r.userData.baseX ??= r.position.x) - v.recoil * 0.12;
      }
      this.updateRing(e, v, d);
    }
    for (const v of [...this.visuals.values()]) if (!seen.has(v.id)) this.removeVisual(v);
  }

  private unitFx(e: Entity, v: Visual, p: THREE.Vector3, yaw: number, moved: number, dt: number) {
    const ud = unitDef(e.def);
    const m = v.model;
    // ground marks under tracks / tyres
    if (m.trackGauge && !ud.air && moved > 0) {
      v.trackAcc += moved;
      const seg = 0.13;
      if (v.trackAcc >= seg) {
        v.trackAcc %= seg;
        const facing = -yaw;
        const fx = Math.cos(facing);
        const fz = Math.sin(facing);
        const px = -fz;
        const pz = fx;
        const g = m.trackGauge;
        this.marks.print(p.x + px * g, p.z + pz * g, facing, seg * 1.25, m.trackWidth ?? 0.12, !!m.wheeled);
        this.marks.print(p.x - px * g, p.z - pz * g, facing, seg * 1.25, m.trackWidth ?? 0.12, !!m.wheeled);
        if (Math.random() < 0.35) this.effects.dust(p.x - fx * 0.4, p.y, p.z - fz * 0.4, 0.8);
      }
    }
    // exhaust while driving
    if (v.anim.moving && !ud.air && m.emitters.length) {
      v.exhaustTimer -= dt;
      if (v.exhaustTimer <= 0) {
        v.exhaustTimer = 0.08;
        for (const em of m.emitters) {
          if (em.kind !== 'smoke') continue;
          const wp = em.pos.clone().applyMatrix4(m.root.matrixWorld);
          this.effects.exhaust(wp.x, wp.y, wp.z);
        }
      }
    }
    for (const em of m.emitters) {
      if (em.kind === 'spark' && Math.random() < dt * 3) {
        const wp = em.pos.clone().applyMatrix4(m.root.matrixWorld);
        this.effects.spark(wp.x, wp.y, wp.z);
      }
    }
    // battle damage
    if (ud.category !== 'infantry' && e.hp < e.maxHp * 0.4) {
      v.fxTimer -= dt;
      if (v.fxTimer <= 0) {
        v.fxTimer = 0.14;
        this.effects.smoke(p.x, p.y + (m.height ?? 0.4) * 0.8, p.z, 0.7);
        if (e.hp < e.maxHp * 0.2) this.effects.flame(p.x, p.y + 0.3, p.z, 0.6);
      }
    }
    if (ud.ewRadius) {
      v.emitTimer -= dt;
      if (v.emitTimer <= 0) {
        v.emitTimer = 1.4;
        this.effects.jamPulse(p.x, p.y, p.z, ud.ewRadius);
      }
    }
    if (e.jammedUntil > this.world.tick && Math.random() < dt * 8) this.effects.spark(p.x, p.y, p.z, 0x70b0ff);
    // rotor downwash kicks up dust under low-flying helicopters
    if (ud.air && !ud.fixedWing && !ud.kamikaze && e.z < 1.4 && Math.random() < dt * 6) this.effects.dust(p.x, standHeight(this.world.map, p.x, p.z), p.z, 1.5);
  }

  private buildingFx(e: Entity, v: Visual, dt: number) {
    const bd = buildingDef(e.def);
    const root = v.model.root;
    const w = this.world;
    const lowPower = e.owner >= 0 && w.isLowPower(w.players[e.owner]);
    v.emitTimer -= dt;
    if (v.model.emitters.length && v.emitTimer <= 0 && e.buildAnim >= 1) {
      v.emitTimer = lowPower ? 0.6 : 0.22;
      for (const em of v.model.emitters) {
        const wp = em.pos.clone().applyMatrix4(root.matrixWorld);
        if (em.kind === 'spark') this.effects.spark(wp.x, wp.y, wp.z);
        else if (em.kind === 'fire') this.effects.flame(wp.x, wp.y, wp.z, 0.6);
        else this.effects.smoke(wp.x, wp.y, wp.z, em.kind === 'steam' ? 0.9 : 0.6, em.kind === 'smoke');
      }
    }
    if (e.hp < e.maxHp * 0.55) {
      v.fxTimer -= dt;
      if (v.fxTimer <= 0) {
        v.fxTimer = 0.12;
        const fx = e.tx + 0.3 + Math.random() * (bd.w - 0.6);
        const fz = e.ty + 0.3 + Math.random() * (bd.h - 0.6);
        const fy = groundHeight(w.map, fx, fz) + (v.model.height ?? 0.6) * (0.4 + Math.random() * 0.4);
        this.effects.smoke(fx, fy, fz, 1.1);
        if (e.hp < e.maxHp * 0.3) this.effects.flame(fx, fy, fz, 1.3);
      }
    }
    if (e.repairing && Math.random() < dt * 3) this.effects.spark(root.position.x + (Math.random() - 0.5) * bd.w, root.position.y + (v.model.height ?? 0.6) * Math.random(), root.position.z + (Math.random() - 0.5) * bd.h, 0x80ff80);
  }

  private updateRing(e: Entity, v: Visual, d: (typeof DEFS)[string]) {
    const sel = this.selection.has(e.id) && v.visible;
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
      const rp = v.model.root.position;
      const gy = e.kind === 'unit' && unitDef(e.def).air ? standHeight(this.world.map, rp.x, rp.z) : rp.y;
      v.ring.position.set(rp.x, gy + 0.04, rp.z);
    }
  }

  // ------------------------------------------------------------------ wrecks

  private toWreck(v: Visual, e: { def: string; x: number; y: number }) {
    this.visuals.delete(v.id);
    if (v.ring) this.scene.remove(v.ring);
    const d = DEFS[e.def];
    const root = v.model.root;
    const pos = root.position.clone();
    const base: Wreck = { kind: 'vehicle', root, model: v.model, t: 0, max: 26, x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, spin: 0, size: 1, h: v.model.height ?? 0.5, w: 1, d: 1, landed: true };
    if (d.kind === 'building') {
      const bd = buildingDef(e.def);
      this.wrecks.push({ ...base, kind: 'building', max: 40, w: bd.w, d: bd.h, size: Math.max(bd.w, bd.h) });
      return;
    }
    const ud = unitDef(e.def);
    if (ud.category === 'infantry') {
      if (v.model.infantry && v.model.anim) this.wrecks.push({ ...base, kind: 'infantry', max: 3, anim: { ...v.anim, dead: 0.001, moving: false } });
      else this.wrecks.push({ ...base, kind: 'infantry', max: 2.2 });
      return;
    }
    // vehicles and aircraft burn as blackened wrecks
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = this.burnt;
    });
    if (ud.air) {
      const sp = ud.speed * (ud.fixedWing ? 1 : 0.4);
      this.wrecks.push({ ...base, kind: 'air', max: 30, vx: Math.cos(-root.rotation.y) * sp, vz: Math.sin(-root.rotation.y) * sp, vy: 0.5, spin: (Math.random() - 0.5) * 6, landed: false });
      return;
    }
    const wr: Wreck = { ...base, kind: 'vehicle', size: ud.harvester || ud.mcv ? 1.4 : 1 };
    if (v.model.turret && Math.random() < 0.6) {
      // turret tossed off by the ammunition cook-off
      const t = v.model.turret;
      this.scene.attach(t);
      wr.turret = { obj: t, vx: (Math.random() - 0.5) * 1.5, vy: 4 + Math.random() * 2, vz: (Math.random() - 0.5) * 1.5, wx: (Math.random() - 0.5) * 8, wz: (Math.random() - 0.5) * 8, landed: false };
    }
    this.wrecks.push(wr);
  }

  private updateWrecks(dt: number) {
    const map = this.world.map;
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.t += dt;
      const r = w.root;
      if (w.kind === 'infantry') {
        if (w.anim && w.model.anim) {
          w.anim.dead = w.t;
          w.anim.dt = dt;
          w.model.anim(w.anim);
        } else r.rotation.z = Math.min(Math.PI / 2, w.t * 5) * 0.95;
        if (w.t > w.max - 0.6) r.position.y = w.y - (w.t - (w.max - 0.6)) * 0.3;
      } else if (w.kind === 'air' && !w.landed) {
        // spiral down trailing fire and smoke, explode on impact
        w.vy -= 6 * dt;
        w.x += w.vx * dt;
        w.z += w.vz * dt;
        w.y += w.vy * dt;
        r.position.set(w.x, w.y, w.z);
        r.rotation.y += w.spin * dt;
        r.rotation.z = Math.max(-0.9, r.rotation.z - dt * 0.8);
        this.effects.smoke(w.x, w.y, w.z, 0.8);
        this.effects.flame(w.x, w.y, w.z, 0.7);
        const g = standHeight(map, Math.max(0, Math.min(map.w - 0.01, w.x)), Math.max(0, Math.min(map.h - 0.01, w.z)));
        if (w.y <= g + 0.1) {
          w.landed = true;
          w.y = g + 0.05;
          w.t = 0;
          w.max = 18;
          r.position.y = w.y;
          r.rotation.x = (Math.random() - 0.5) * 0.4;
          this.effects.blast(BLASTS.aircraft, w.x, g + 0.2, w.z, g);
          this.marks.craterAt(w.x, w.z, 0.5);
        }
      } else if (w.kind === 'building') {
        // collapse: sink and crumble, then smoulder as a rubble pile
        const k = Math.min(1, w.t / 2.4);
        r.position.y = w.y - w.h * 0.75 * k * k;
        r.scale.y = Math.max(0.08, 1 - k * 0.85);
        r.rotation.z = Math.sin(w.t * 9) * 0.01 * (1 - k) + k * 0.04;
        if (w.t < 2.4) {
          if (Math.random() < dt * 30) this.effects.dust(w.x + (Math.random() - 0.5) * w.w, w.y + 0.1, w.z + (Math.random() - 0.5) * w.d, 3);
          if (Math.random() < dt * 8) this.debris.burst('concrete', w.x + (Math.random() - 0.5) * w.w, w.y + w.h * (1 - k), w.z + (Math.random() - 0.5) * w.d, 2, 2, 0.08);
        } else if (w.t < 25 && Math.random() < dt * 10) {
          this.effects.smoke(w.x + (Math.random() - 0.5) * w.w * 0.8, w.y + 0.2, w.z + (Math.random() - 0.5) * w.d * 0.8, 1.4);
          if (w.t < 14 && Math.random() < 0.6) this.effects.flame(w.x + (Math.random() - 0.5) * w.w * 0.7, w.y + 0.1, w.z + (Math.random() - 0.5) * w.d * 0.7, 1.3);
        }
        if (w.t > w.max - 3) r.position.y -= dt * 0.15;
      } else if (w.kind === 'sold') {
        const k = Math.min(1, w.t / w.max);
        r.scale.y = Math.max(0.01, 1 - k);
        if (Math.random() < dt * 20) this.effects.dust(w.x + (Math.random() - 0.5) * w.w, w.y + 0.05, w.z + (Math.random() - 0.5) * w.d, 1.5);
      } else {
        // burning vehicle wreck
        if (w.t < 9 && Math.random() < dt * 14) this.effects.flame(w.x + (Math.random() - 0.5) * 0.4 * w.size, w.y + 0.3, w.z + (Math.random() - 0.5) * 0.4 * w.size, 0.9 * w.size);
        if (w.t < 20 && Math.random() < dt * 8) this.effects.smoke(w.x, w.y + 0.4, w.z, 1.0 * w.size);
        if (w.t > w.max - 2.5) r.position.y = w.y - (w.t - (w.max - 2.5)) * 0.25;
      }
      const tt = w.turret;
      if (tt && !tt.landed) {
        tt.vy -= 9 * dt;
        tt.obj.position.x += tt.vx * dt;
        tt.obj.position.y += tt.vy * dt;
        tt.obj.position.z += tt.vz * dt;
        tt.obj.rotation.x += tt.wx * dt;
        tt.obj.rotation.z += tt.wz * dt;
        if (Math.random() < dt * 20) this.effects.smoke(tt.obj.position.x, tt.obj.position.y, tt.obj.position.z, 0.5);
        const gx = Math.max(0, Math.min(map.w - 0.01, tt.obj.position.x));
        const gz = Math.max(0, Math.min(map.h - 0.01, tt.obj.position.z));
        if (tt.vy < 0 && tt.obj.position.y <= standHeight(map, gx, gz) + 0.08) {
          tt.landed = true;
          tt.obj.position.y = standHeight(map, gx, gz) + 0.08;
          this.effects.dust(tt.obj.position.x, tt.obj.position.y, tt.obj.position.z, 2);
        }
      }
      if (tt && w.t > w.max - 2.5) tt.obj.position.y -= dt * 0.25;
      if (w.t >= w.max) {
        this.scene.remove(r);
        if (tt) this.scene.remove(tt.obj);
        this.wrecks.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------- projectiles

  private munition(p: Projectile): THREE.Object3D {
    const wpn = WEAPONS[p.weapon];
    const kind = (wpn.munition as MunitionKind) ?? MUNITION_FALLBACK[p.flight];
    const team = p.owner >= 0 ? this.world.players[p.owner].color : 0xaaaaaa;
    const m = createMunition(kind, team);
    if (m) return m.root;
    const g = new THREE.Group();
    const big = p.flight === 'ballistic' || p.flight === 'hypersonic' ? 2.5 : p.flight === 'sam' ? 1.6 : 1;
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.025 * big, 0.03 * big, 0.25 * big, 8).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5, metalness: 0.4 })));
    return g;
  }

  private syncProjectiles(alpha: number) {
    const seen = new Set<number>();
    const pos = new THREE.Vector3();
    const vel = new THREE.Vector3();
    for (const p of this.world.projectiles) {
      seen.add(p.id);
      let v = this.projVis.get(p.id);
      if (!v) {
        const obj = p.flight === 'shell' ? new THREE.Group() : this.munition(p);
        const streak = p.flight === 'shell' || p.flight === 'artillery' ? new THREE.Mesh(this.streakGeo, this.streakMat) : null;
        if (streak) {
          streak.renderOrder = 4;
          this.scene.add(streak);
        }
        this.scene.add(obj);
        v = { obj, streak, last: new THREE.Vector3(p.px, p.pz, p.py), first: true };
        this.projVis.set(p.id, v);
      }
      pos.set(p.px + (p.x - p.px) * alpha, p.pz + (p.z - p.pz) * alpha, p.py + (p.y - p.py) * alpha);
      const visible = this.viewer < 0 || p.owner === this.viewer || this.world.visibleTo(this.viewer, pos.x, pos.z);
      v.obj.visible = visible;
      v.obj.position.copy(pos);
      vel.set(p.vx, p.vz, p.vy);
      if (vel.lengthSq() > 1e-6) {
        v.obj.lookAt(pos.clone().add(vel));
        v.obj.rotateY(-Math.PI / 2);
      }
      if (v.streak) {
        v.streak.visible = visible;
        const from = v.first ? pos.clone().addScaledVector(vel, -0.03) : v.last;
        const len = Math.max(0.05, from.distanceTo(pos) * 1.4);
        v.streak.position.copy(pos);
        v.streak.lookAt(from);
        const wdt = p.flight === 'shell' ? 0.02 : 0.03;
        v.streak.scale.set(wdt, wdt, Math.min(len, 1.2));
      }
      if (visible && !v.first) {
        const k = p.T > 0 ? p.age / p.T : 0;
        const boost =
          p.flight === 'ballistic' ? k < 0.4 : p.flight === 'hypersonic' ? k < 0.3 : p.flight === 'rocketSalvo' ? k < 0.6 : p.flight === 'artillery' || p.flight === 'mortar' || p.flight === 'shell' ? false : true;
        this.effects.trail(v.last, pos, p.flight, boost);
      }
      v.last.copy(pos);
      v.first = false;
    }
    for (const [id, v] of this.projVis) {
      if (seen.has(id)) continue;
      this.scene.remove(v.obj);
      if (v.streak) this.scene.remove(v.streak);
      this.projVis.delete(id);
    }
  }

  // ------------------------------------------------------------------ events

  private muzzleOf(e: Entity): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    const v = this.visuals.get(e.id);
    const dir = new THREE.Vector3(Math.cos(e.turret), 0, Math.sin(e.turret));
    if (v) v.lastFire = this.time;
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
      if (t.kind === 'building') {
        p.x = x;
        p.z = y;
        p.y += 0.4;
      } else if (!unitDef(t.def).air) p.y += unitDef(t.def).category === 'infantry' ? 0.18 : 0.28;
      return p;
    }
    return new THREE.Vector3(x, standHeight(this.world.map, x, y) + 0.2, y);
  }

  private visibleAt(x: number, y: number) {
    return this.viewer < 0 || this.world.visibleTo(this.viewer, x, y);
  }

  private blastFor(weaponId: string, air: boolean): BlastProfile | null {
    const w = WEAPONS[weaponId];
    if (!w) return null;
    if (weaponId.includes('shahed')) return BLASTS.shahed;
    if (weaponId.includes('fpv') || weaponId.includes('micro')) return BLASTS.drone;
    if (w.projectile === 'instant') return w.warhead === 'flak' ? BLASTS.flak : null;
    if (w.projectile === 'beam') return null;
    let p: BlastProfile;
    switch (w.flight) {
      case 'shell':
        p = BLASTS.shell;
        break;
      case 'artillery':
        p = BLASTS.artillery;
        break;
      case 'mortar':
        p = BLASTS.mortar;
        break;
      case 'rocketSalvo':
        p = w.warhead === 'thermo' ? BLASTS.thermo : BLASTS.rocket;
        break;
      case 'ballistic':
      case 'hypersonic':
        p = BLASTS.ballistic;
        break;
      case 'airMissile':
        p = w.warhead === 'missile' ? BLASTS.missile : BLASTS.heat;
        break;
      default:
        p = BLASTS.heat;
    }
    if (air && p.size > BLASTS.airSmall.size) return { ...BLASTS.airSmall, size: p.size * 0.7, fire: p.fire, light: p.light };
    return p;
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
        if (ev.targetId < 0) {
          if (wpn.projectile === 'beam') fx.laser(pos, new THREE.Vector3(ev.tx, standHeight(this.world.map, ev.tx, ev.ty) + 3, ev.ty));
          break;
        }
        const tp = this.targetPoint(ev.targetId, ev.tx, ev.ty);
        switch (wpn.projectile) {
          case 'instant': {
            const t = this.world.get(ev.targetId);
            fx.muzzle(pos, dir, wpn.warhead === 'flak' ? 0.55 : 0.35);
            fx.tracer(pos, tp, !(t && t.kind === 'unit' && unitDef(t.def).air));
            break;
          }
          case 'beam':
            fx.laser(pos, tp);
            break;
          case 'shell':
            fx.muzzle(pos, dir, 1.3);
            break;
          case 'artillery':
            fx.muzzle(pos, dir, wpn.flight === 'mortar' ? 0.7 : 1.7);
            break;
          case 'spawn':
            fx.muzzle(pos, dir, 0.4, 0xfff0c0);
            break;
        }
        break;
      }
      case 'launch': {
        if (!this.visibleAt(ev.x, ev.y)) break;
        const src = this.world.get(ev.sourceId);
        if (src) {
          const v = this.visuals.get(src.id);
          if (v) v.lastFire = this.time;
        }
        const p = new THREE.Vector3(ev.x, ev.z, ev.y);
        const dir = src ? new THREE.Vector3(Math.cos(src.turret), 0, Math.sin(src.turret)) : new THREE.Vector3(1, 0, 0);
        fx.launch(ev.flight, p, dir, standHeight(this.world.map, ev.x, ev.y));
        break;
      }
      case 'airburst': {
        if (!this.visibleAt(ev.x, ev.y)) break;
        const big = ev.victim === 'ballistic' || ev.victim === 'hypersonic';
        fx.airburst(ev.x, ev.z, ev.y, ev.kind === 'kill', standHeight(this.world.map, ev.x, ev.y), big);
        break;
      }
      case 'impact': {
        if (!this.visibleAt(ev.x, ev.y)) break;
        const prof = this.blastFor(ev.weapon, !!ev.air);
        if (!prof) break;
        const g = standHeight(this.world.map, ev.x, ev.y);
        fx.blast(prof, ev.x, Math.max(ev.z, g + 0.05), ev.y, g);
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
        const v = this.visuals.get(ev.id);
        const shown = this.visibleAt(ev.x, ev.y);
        const d = DEFS[ev.def];
        const gy = standHeight(this.world.map, ev.x, ev.y);
        if (d.kind === 'building') {
          const bd = buildingDef(ev.def);
          if (shown) {
            for (let i = 0; i < Math.min(7, bd.w * bd.h); i++) {
              const ex = ev.x + (Math.random() - 0.5) * bd.w;
              const ez = ev.y + (Math.random() - 0.5) * bd.h;
              this.schedule(i * 0.16, () => fx.blast(i === 0 ? BLASTS.vehicle : BLASTS.rocket, ex, gy + 0.4, ez, gy));
            }
            this.schedule(0.45, () => fx.blast({ ...BLASTS.building, size: bd.w >= 3 ? 2.4 : 1.7 }, ev.x, gy + 0.3, ev.y, gy));
          }
          if (v) {
            if (shown) this.toWreck(v, ev);
            else this.removeVisual(v);
          }
          break;
        }
        const ud = unitDef(ev.def);
        if (ud.kamikaze) {
          if (v) {
            if (shown) fx.blast(BLASTS.airSmall, v.model.root.position.x, v.model.root.position.y, v.model.root.position.z, gy);
            this.removeVisual(v);
          }
          break;
        }
        if (shown) {
          if (ud.air) {
            const pos = v?.model.root.position ?? new THREE.Vector3(ev.x, gy + 1.5, ev.y);
            fx.blast(BLASTS.airSmall, pos.x, pos.y, pos.z, gy);
          } else if (ud.category === 'infantry') {
            fx.explosion(ev.x, gy, ev.y, 'small', 'dust');
          } else {
            fx.blast(ud.harvester || ud.mcv ? BLASTS.bigVehicle : BLASTS.vehicle, ev.x, gy + 0.25, ev.y, gy);
            // secondary ammunition cook-off
            this.schedule(0.5 + Math.random() * 0.4, () => fx.blast(BLASTS.heat, ev.x + (Math.random() - 0.5) * 0.3, gy + 0.4, ev.y + (Math.random() - 0.5) * 0.3, gy));
          }
        }
        if (v) {
          if (shown) this.toWreck(v, ev);
          else this.removeVisual(v);
        }
        break;
      }
      case 'placed':
      case 'deployed': {
        const b = this.world.get(ev.id);
        if (!b || !this.visibleAt(b.x, b.y)) break;
        const bd = buildingDef(b.def);
        const gy = groundHeight(this.world.map, b.x, b.y);
        fx.ring(b.x, gy + 0.05, b.y, 0.5, Math.max(bd.w, bd.h) * 1.1, 0.7, 0xd8c8a0, false, 0.5);
        for (let i = 0; i < 14; i++) fx.dust(b.x + (Math.random() - 0.5) * bd.w, gy, b.y + (Math.random() - 0.5) * bd.h, 2.5);
        break;
      }
      case 'sold': {
        const v = this.visuals.get(ev.id);
        const b = this.world.entities.get(ev.id);
        if (v && b) {
          const bd = buildingDef(b.def);
          this.visuals.delete(v.id);
          if (v.ring) this.scene.remove(v.ring);
          const p = v.model.root.position;
          this.wrecks.push({ kind: 'sold', root: v.model.root, model: v.model, t: 0, max: 1.2, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, spin: 0, size: 1, h: 1, w: bd.w, d: bd.h, landed: true });
        }
        break;
      }
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

  /** Keep the frame rate up on weak GPUs by lowering the render resolution. */
  private adaptResolution(dt: number) {
    if (dt <= 0) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((s, x) => s + x, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    let pr = this.pixelRatio;
    if (avg > 1 / 28 && pr > 0.7) pr = Math.max(0.7, pr - 0.15);
    else if (avg < 1 / 55 && pr < this.maxPixelRatio) pr = Math.min(this.maxPixelRatio, pr + 0.1);
    if (pr !== this.pixelRatio) {
      this.pixelRatio = pr;
      this.renderer.setPixelRatio(pr);
      this.resize(this.width, this.height);
    }
  }

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
    this.updateWrecks(dt);
    this.syncProjectiles(alpha);
    this.terrain.update(this.time);
    if (Math.floor(this.time * 4) !== Math.floor((this.time - dt) * 4)) this.terrain.updateOre();
    this.effects.update(dt);
    this.updateCamera();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.adaptResolution(dt);
  }

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
