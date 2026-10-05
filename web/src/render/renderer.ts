import * as THREE from 'three';
import { phoneCaps } from './devicecaps';
import { releaseFog } from './fogcache';
import { ShadowCache } from './shadowcache';
import type { Slicer } from './slice';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { DEFS, FACTION_INFO, WEAPONS, buildingDef, unitDef } from '../sim/defs';
import { groundHeight, standHeight } from '../sim/map';
import { TPS, type Entity, type Projectile, type SimEvent } from '../sim/types';
import type { World } from '../sim/world';
import { BridgeFx } from './bridgefx';
import { unitStandHeight } from './deckramp';
import { SuperFx } from './fx/superfx';
import { SniperFx } from './fx/sniperfx';
import { Debris } from './debris';
import { Fracture, type FracWreck } from './fracture';
import { BattleScars } from './scars';
import { prefetchScarAtlas, scarAtlasTile } from './scarsdecal';
import { Secondaries } from './fx/secondary';
import { BLASTS, Effects, type BlastProfile } from './effects';
import { FogOfWar } from './fog';
import { GroundMarks } from './marks';
import { FACTION_REGION, createModel, createMunition, type AnimState, type Model, type ModelStyle, type MunitionKind } from './models';
import { Outskirts } from './outskirts';
import { reliefClearance } from './relief';
import { Paradrop } from './paradrop';
import { UnitLife } from './unitlife';
import { DeployFx } from './deployfx';
import { CombatOverlay } from './overlay';
import { Readability } from './readability';
import { emitDamageFx, ejectCasing, popFlares } from './fx/unitfx';
import { loadSkyEnvironment, type FinalPass } from './post';
import { PostChain } from './post/chain';
import { sanitizeGrade, type GradeInput } from './post/grade';
import type { BloomPass } from './post/bloom';
import { Terrain } from './terrain';
import { Atmosphere } from './atmos';
import { Sky } from './sky';
import { updateCloudShadows } from './cloudshadow';
import { AmbientLife, ambientEnabled } from './ambient';
import { WaterFx } from './fx/waterfx';
import type { TiltShiftPass } from './tiltshift';
import { AirShadows, bumpVehicle, poseGroundVehicle, poseInfantry } from './unitpose';
import { AutoQualityMonitor } from './autoquality';
import { CONTACT_LAYER, ContactShadows } from './contactshadow';
import { CascadeSun } from './ultra/cascades';
import type { TemporalPass } from './ultra/temporal';
import { PerfHud, perfPrefs } from './perf/hud';
import { loadBuildingPhotos } from './models/bldtex';
import { PerfProbe } from './perf/probe';
import { applyLod, prepareLod, restoreMain, setCasting, type LodInfo } from './perf/lod';
import { AutoInstancer } from './perf/instancer';
import { setBakeEnabled, setBakeRenderer, setBakeSize } from './models/vehbake';
import { setWearBiome } from './models/wear';
import { OccluderGrid } from './perf/occlusion';
import { treeSpots } from './vegetation';

/** Largest sun step the shadow lags behind (radians, 0.02 degrees). */
const SHADOW_STEP = 0.02 * (Math.PI / 180);

/** 'ultra' (manual choice only) = 'high' plus TAA, cascaded shadows, SSR and screen-space contact shadows. */
export type Quality = 'low' | 'medium' | 'high' | 'ultra';

/** Battlefield parts built ahead of the renderer in time slices (GameRenderer.prebuild). */
export interface RendererParts {
  fog: FogOfWar;
  occluders: OccluderGrid;
  terrain: Terrain;
  outskirts: Outskirts;
}
/** The tier the scene subsystems (terrain, effects, weather, ...) are built for. */
type BaseQuality = 'low' | 'medium' | 'high';

/** Can this device run the ultra extras (float render targets for TAA history, big shadow atlas)? */
function ultraCapable(r: THREE.WebGLRenderer): boolean {
  try {
    const ext = r.extensions;
    const float = ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
    return float && r.capabilities.maxTextureSize >= 4096;
  } catch {
    return false;
  }
}

/** Per-frame hook for whole-view modes (src/render/viewmodes.ts). */
export interface ViewHook {
  before(dt: number): void;
  /** Return true when the hook rendered the main view itself. */
  renderMain(): boolean;
  after(dt: number): void;
}

// ~35 degree elevation: a touch lower than before so units and buildings show more of their sides (RA2-like)
const CAM_DIR = new THREE.Vector3(1, 1.0, 1).normalize();
const CAM_DIST = 80;
/** Perspective camera (C&C3-like): vertical field of view and pitch range (far zoom .. close zoom), degrees. */
const PERSP_FOV = 38;
const PITCH_FAR = 55;
const PITCH_NEAR = 43;
/** World units visible vertically at zoom 1 (game.ts picking relies on this). */
export const BASE_VIEW = 22;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3.6;
/** Direction towards the late-afternoon sun: low, from the upper left of the screen. */
const SUN_DIR = new THREE.Vector3(-0.985, 0.8, 0.2).normalize();

/** One rung of the dynamic quality ladder (index 0 = best). */
interface QualityStep {
  pr: number;
  /** Ambient occlusion (post/ao.ts). */
  ao: boolean;
  /** Bloom: 0 off, 1 cheap, 2 full (post/bloom.ts). */
  bloomQ: 0 | 1 | 2;
  /** Lens extras: edge chromatic aberration, lens dirt, flare streak (post/chain.ts). */
  lens: boolean;
  shadow: number;
  post: boolean;
  /** Ultra extras (TAA + sharpen, SSR, screen-space contact shadows) on this rung. */
  ultra: boolean;
}

export interface Visual {
  id: number;
  model: Model;
  owner: number;
  def: string;
  /** Production buildings: renderer time of the last unit rolled out (factory doors / lifts). */
  prodAt?: number;
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
  /** Far-zoom detail LOD (src/render/perf/lod.ts). */
  lod: LodInfo;
  /** Something (tree, building, ridge) may hide this unit from the camera: x-ray proxies needed (perf/occlusion.ts). */
  occl: boolean;
  /** The model or its shadow may be on screen (last sync). */
  near: boolean;
  /** Animation time banked while off screen (handed to the next pose update). */
  animDebt?: number;
  /** Its programs are still compiling (parallel compile): not drawn yet. */
  pending?: boolean;
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
  /** Buildings on medium / high: the model broken into rigid chunks (fracture.ts). */
  frac?: FracWreck;
  /** Battle scars (scars.ts): the building still owes its ruin / the vehicle was offered as a hulk. */
  ruin?: boolean;
  /** ...as a flat cratered slab (the airbase), not a rubble heap with wall stubs. */
  flatRuin?: boolean;
  kept?: boolean;
}

interface ProjVisual {
  obj: THREE.Object3D;
  streak: THREE.Mesh | null;
  last: THREE.Vector3;
  first: boolean;
}

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
  cruise: 'airMissile',
};

/*
 * Units are drawn larger than their 1-tile sim footprint so they read clearly
 * on small screens (visual only; the simulation is unchanged).
 */
const VEHICLE_SCALE = 1.25;
const INFANTRY_SCALE = 1.4;
const AIR_SCALE = 1.15;
function enlargeUnit(m: Model, k: number) {
  m.root.scale.setScalar(k);
  m.height *= k;
  if (m.size) m.size = { x: m.size.x * k, y: m.size.y * k, z: m.size.z * k };
  if (m.trackGauge) m.trackGauge *= k;
  if (m.trackWidth) m.trackWidth *= k;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** ?cam=ortho keeps the classic orthographic view. */
  readonly perspective: boolean;
  readonly fog: FogOfWar;
  readonly terrain: Terrain;
  readonly effects: Effects;
  readonly debris: Debris;
  /** Building collapse into rigid rubble chunks (medium / high; src/render/fracture.ts). */
  readonly fracture: Fracture;
  /** Ammo / fuel / missile cook-offs after deaths (visual only; fx/secondary.ts). */
  readonly secondaries: Secondaries;
  readonly marks: GroundMarks;
  /** Persistent craters, scorched earth, ruins and hulks (src/render/scars.ts). */
  readonly scars: BattleScars;
  /** ?scars=0 turns the lasting battle scars off (before / after comparisons): fading marks, wrecks sink away. */
  private scarsOn = typeof location === 'undefined' || new URLSearchParams(location.search).get('scars') !== '0';
  readonly bridgeFx: BridgeFx;
  /** Garrison window fire, house damage sync, superweapon blasts / Iron Beam dome (fx/superfx.ts). */
  readonly superFx: SuperFx;
  /** Sniper laser designator: beam + swaying dot while aiming, the shot (fx/sniperfx.ts). */
  readonly sniperFx: SniperFx;
  /** Civilian traffic, livestock and birds (src/render/ambient, visual only). */
  readonly ambient: AmbientLife | null = null;
  /** River weather, ring waves, fuel slicks, floating debris (fx/waterfx.ts, visual only). */
  readonly river: WaterFx;
  /** Selection rings, hover highlight and order markers (src/render/overlay.ts). */
  readonly overlay: CombatOverlay;
  /** Phone readability: strategic icons, unit outlines, move-route arrows (src/render/readability.ts). */
  readonly readability: Readability;
  readonly target = new THREE.Vector3();
  zoom = 1;
  /** Cinematic post chain (src/render/post/chain.ts): AO, bloom, DOF, AgX + LUT grade, lens, AA. */
  private post: PostChain | null = null;
  private composer: EffectComposer | null = null;
  private bloom: BloomPass | null = null;
  private finalPass: FinalPass | null = null;
  private tilt: TiltShiftPass | null = null;
  // ultra quality (src/render/ultra/*): temporal resolve (in the post chain), cascaded sun
  private temporal: TemporalPass | null = null;
  private csm: CascadeSun | null = null;
  /** Soft footprint darkening under ground units and buildings (all but low quality). */
  private contact: ContactShadows | null = null;
  /** Base quality tier the subsystems run at ('ultra' runs as 'high' plus the extras). */
  readonly quality: BaseQuality;
  /** Ultra extras available (requested and supported by the device). */
  readonly ultra: boolean;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  readonly outskirts: Outskirts;
  /** Time of day, weather, night vision and environment destruction (src/render/atmos.ts). */
  readonly atmos: Atmosphere;
  /** Physical sky (src/render/sky.ts; medium / high). */
  sky: Sky | null = null;
  /** Live unit / building visuals by entity id (read by the view modes in viewmodes.ts). */
  readonly visuals = new Map<number, Visual>();
  private wrecks: Wreck[] = [];
  /** Parachute canopies (airborne-drop support power). */
  private chutes: Paradrop;
  /** Crew hatches, transport ramps / walk-in-out, infantry digging in (unitlife.ts). */
  private life: UnitLife;
  /** MCV unfolding into a construction yard (deployfx.ts). */
  private deployFx: DeployFx;
  private projVis = new Map<number, ProjVisual>();
  private ghost: THREE.Group | null = null;
  private ghostKey = '';
  private ghostTiles: THREE.Mesh[] = [];
  private burnt: THREE.MeshStandardMaterial;
  private streakGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  private streakMat = new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  private scheduled: { t: number; fn: () => void }[] = [];
  private time = 0;
  private width = 1;
  private height = 1;
  // dynamic quality governor
  private ladder: QualityStep[] = [];
  private level = 0;
  private usePost = false;
  private adaptive = true;
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private goodWindows = 0;
  private upNeed = 3;
  private lastUpAt = -1e9;
  private lastFt = 0;
  /** Draw call / triangle / CPU breakdown per pass and category (debug + benchmark; inactive until enablePerf()). */
  readonly perf: PerfProbe;
  /** Per-frame automatic instancing of identical unit parts (src/render/perf/instancer.ts). */
  readonly instancer: AutoInstancer;
  private instRoots: THREE.Object3D[] = [];
  private perfHud = new PerfHud();
  selection = new Set<number>();
  /** Entity under the cursor (gets a quiet hover ring), -1 = none. */
  hover = -1;
  /** Player whose fog of war is shown (-1 = reveal all, e.g. attract mode). */
  viewer: number;

  /**
   * Build the heavy CPU-side parts of the battlefield (terrain: ground paint, grass, water, vegetation,
   * rocks, scenery, props; the outskirts) in time slices, ahead of the constructor. Built in one go they
   * took seconds of main thread on a phone (the "Page unresponsive" dialog).
   */
  static async prebuild(world: World, requested: Quality, slicer: Slicer): Promise<RendererParts> {
    const quality: BaseQuality = requested === 'ultra' ? 'high' : requested;
    const { map } = world;
    const fog = new FogOfWar(map.w, map.h);
    // battle-scar decal atlas: built in a worker while the terrain is built here (scarsdecal.ts)
    void prefetchScarAtlas(scarAtlasTile(quality));
    const occluders = new OccluderGrid(map, treeSpots(map, quality));
    await slicer.tick();
    const terrain = await Terrain.build(map, fog, quality, slicer);
    await slicer.tick();
    const outskirts = await Outskirts.build(map, fog, quality, slicer, terrain.ground, terrain.water);
    await slicer.tick();
    return { fog, occluders, terrain, outskirts };
  }

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly world: World,
    viewer: number,
    requested: Quality,
    pre?: RendererParts | null,
  ) {
    this.viewer = viewer;
    const quality: BaseQuality = requested === 'ultra' ? 'high' : requested;
    this.quality = quality;
    // CC0 photoscanned building materials, patched into the building atlas when they arrive
    void loadBuildingPhotos(quality);
    const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    const dpr = window.devicePixelRatio || 1;
    // low renders straight to the (multisampled) canvas; medium/high go through the post chain
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'low', powerPreference: 'high-performance' });
    // production: no per-program info-log queries on first use (each one is a synchronous GPU round trip)
    this.renderer.debug.checkShaderErrors = !!import.meta.env?.DEV;
    // Phones (and desktop GPUs after a driver reset) lose the WebGL context now and then; three.js restores it,
    // but render targets that are only re-rendered on change come back empty. The grade LUT is one of them:
    // left empty it grades every pixel to black (the 'black screen' with only the overlay outlines on top).
    this.onContextLost = (e: Event) => e.preventDefault();
    this.onContextRestored = () => {
      this.post?.lut.invalidate();
      this.sky?.invalidate();
      // the photoscanned ground arrays exist only on the GPU: rebuild them (else the ground stays black)
      this.terrain.ground.photo?.restore();
      this.shadowAge = 1e9;
      this.shadowCache?.invalidate();
    };
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    // (the post chain tone maps itself, AgX + grade LUT; this only covers direct-to-screen frames)
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.ultra = requested === 'ultra' && ultraCapable(this.renderer);
    this.autoMon = new AutoQualityMonitor(requested);
    if (requested === 'ultra' && !this.ultra) console.warn('Ultra quality unsupported on this device (no float render targets): running High');

    this.scene.background = new THREE.Color(0x2a2824);
    this.perspective = !/[?&]cam=ortho\b/.test(location.search);
    this.camera = this.perspective ? new THREE.PerspectiveCamera(PERSP_FOV, 1, 0.5, 400) : new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 400);
    this.perf = new PerfProbe(this.renderer, this.scene, this.camera);
    this.instancer = new AutoInstancer(this.renderer, this.scene, this.camera, (m) => m.userData.outlineColor !== undefined);
    this.instancer.enabled = !/[?&]inst=0\b/.test(location.search);
    // vehicle detail bake (models/vehbake.ts) on this context; weathering palette from the map biome
    setBakeRenderer(this.renderer);
    setBakeSize(quality === 'high' && !phoneCaps() ? 1024 : 512);
    setBakeEnabled(!/[?&]vbake=0\b/.test(location.search));
    setWearBiome(world.map.biome);

    // image based lighting: a neutral room right away, swapped for a real sky HDRI once it has streamed in
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();
    void loadSkyEnvironment(this.renderer).then((env) => {
      // (high quality captures its environment from the physical sky instead: sky.ts)
      if (!env || this.disposed || this.sky?.envCapture) return;
      this.scene.environment?.dispose();
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.42;
    });

    // golden hour: warm low key light, cool sky fill, warm earthy bounce
    this.hemi = new THREE.HemisphereLight(0x9fbcea, 0x6a5232, 0.8);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffc68c, 3.2);
    this.sun.castShadow = quality !== 'low';
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.018;
    this.sun.shadow.radius = 2.2;
    this.scene.add(this.sun, this.sun.target);
    if (this.ultra) {
      // cascaded sun shadows: the directional light stays the controller (atmos / effects read it) but is hidden
      this.csm = new CascadeSun(this.scene, this.camera, 4096);
      this.sun.castShadow = false;
      this.sun.visible = false;
    }

    const { map } = world;
    // (the game builds these heavy parts ahead in time slices: GameRenderer.prebuild)
    this.fog = pre?.fog ?? new FogOfWar(map.w, map.h);
    this.occluders = pre?.occluders ?? new OccluderGrid(map, treeSpots(map, quality));
    this.terrain = pre?.terrain ?? new Terrain(map, this.fog, quality);
    this.scene.add(this.terrain.group);
    this.outskirts = pre?.outskirts ?? new Outskirts(map, this.fog, quality, this.terrain.ground, this.terrain.water);
    this.scene.add(this.outskirts.group);
    this.effects = new Effects(this.scene, this.fog, quality);
    if (this.ultra) {
      // ultra: a few more dynamic fire / explosion lights than high (fx/lights.ts pool)
      const fl = this.effects.lights as unknown as { lights?: THREE.PointLight[]; group?: THREE.Group };
      if (Array.isArray(fl.lights) && fl.group)
        for (let i = 0; i < 4; i++) {
          const l = new THREE.PointLight(0xffa040, 0, 9, 1.4);
          fl.lights.push(l);
          fl.group.add(l);
        }
    }
    if (quality === 'medium' && coarse) {
      // phones: two dynamic fire / explosion lights instead of three (every lit pixel loops over them; the ground glow decals stay)
      const fl = this.effects.lights as unknown as { lights?: THREE.PointLight[]; group?: THREE.Group };
      if (Array.isArray(fl.lights) && fl.group && fl.lights.length > 2) fl.group.remove(fl.lights.pop()!);
    }
    this.debris = new Debris(map, this.effects, this.fog);
    this.fracture = new Fracture(quality);
    this.secondaries = new Secondaries(this.effects);
    this.marks = new GroundMarks(map, this.fog);
    this.effects.debris = this.debris;
    this.effects.marks = this.marks;
    this.effects.setView(this.target, this.camera);
    this.effects.setLights(this.sun, this.hemi);
    this.scene.add(this.debris.group, this.marks.group);
    this.scars = new BattleScars({ map, fog: this.fog, effects: this.effects, quality, visibleAt: (x, z) => this.visibleAt(x, z), isPaved: (x, z) => this.marks.isPaved(x, z),
      occupied: (x, z) => {
        const tx = Math.floor(x);
        const tz = Math.floor(z);
        return tx >= 0 && tz >= 0 && tx < map.w && tz < map.h && this.world.occ[tz * map.w + tx] !== 0;
      },
    });
    if (this.scarsOn) this.effects.scars = this.scars;
    this.scene.add(this.scars.group);
    // collapsible bridges: per-span meshes, damage, collapse and rebuild (bridgefx.ts)
    this.bridgeFx = new BridgeFx(world, this.effects, this.fog, quality, this.terrain.waterMat);
    this.scene.add(this.bridgeFx.group);
    this.overlay = new CombatOverlay(map);
    this.scene.add(this.overlay.group);
    this.readability = new Readability(quality);
    if (quality !== 'low') {
      this.contact = new ContactShadows();
      this.scene.add(this.contact.mesh);
      this.camera.layers.enable(CONTACT_LAYER);
    }
    this.chutes = new Paradrop(this.scene);
    this.burnt = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x1c1916, roughness: 0.95, metalness: 0.15 }));

    // ---- quality ladder (index 0 = best). The governor sheds, in order: lens extras -> AO -> bloom quality
    // -> (ultra extras) -> resolution -> shadow detail / bloom. Every post pass is a rung of its own.
    const maxPR = Math.min(dpr, quality === 'low' ? 1.25 : 2);
    const minPR = Math.min(maxPR, quality === 'low' ? 0.75 : coarse ? 1 : 0.85);
    const startPR = Math.min(maxPR, quality === 'low' ? 1 : quality === 'medium' && coarse ? 1.5 : maxPR);
    const shadow = quality === 'high' ? (phoneCaps() ? 2048 : 4096) : quality === 'medium' ? 2048 : 0; // ultra: per cascade; phones: 2048 (memory)
    const prs: number[] = [];
    for (let p = maxPR; p > minPR + 0.01; p -= 0.25) prs.push(Math.round(p * 100) / 100);
    prs.push(minPR);
    // the post chain needs half-float targets; without them every tier renders straight to the canvas
    const post = PostChain.supported(this.renderer);
    const fx = post && quality !== 'low';
    // AO: high and medium (medium only climbs to it with headroom: it starts below that rung)
    let step: QualityStep = { pr: maxPR, ao: fx, bloomQ: fx ? 2 : 0, lens: fx, shadow, post, ultra: this.ultra };
    const push = (s: QualityStep) => {
      const l = this.ladder[this.ladder.length - 1];
      if (!l || l.pr !== s.pr || l.ao !== s.ao || l.bloomQ !== s.bloomQ || l.lens !== s.lens || l.shadow !== s.shadow || l.post !== s.post || l.ultra !== s.ultra) this.ladder.push(s);
      step = s;
    };
    push(step);
    if (step.lens) push({ ...step, lens: false });
    if (step.ao) push({ ...step, ao: false });
    if (step.bloomQ === 2) push({ ...step, bloomQ: 1 });
    // ultra sheds its extras next (sharper shadows, then TAA / SSR), then walks the normal high ladder
    if (this.ultra) {
      push({ ...step, shadow: 2048 });
      step = { ...step, ultra: false };
    }
    for (const pr of prs) push({ ...step, pr });
    if (step.shadow > 2048) push({ ...step, shadow: 2048 });
    if (step.bloomQ) push({ ...step, bloomQ: 0 });
    if (step.shadow > 1024) push({ ...step, shadow: 1024 });
    // low's last resort: straight to the (multisampled) canvas; medium / high keep tone map + grade + FXAA
    if (step.post && quality === 'low') push({ ...step, post: false });
    const startAt = (s: QualityStep) => s.pr <= startPR + 0.01 && (quality !== 'medium' || !s.ao);
    this.level = Math.max(0, this.ladder.findIndex(startAt));
    this.adaptive = !/[?&]adapt=0\b/.test(location.search);

    if (post) {
      const pc = (this.post = new PostChain(this.renderer, this.scene, this.camera, quality, this.ultra, this.fog.uniforms.fogNoise.value));
      this.composer = pc.composer;
      this.bloom = pc.bloom;
      this.finalPass = pc.final;
      this.tilt = pc.tilt;
      this.temporal = pc.temporal;
      this.finalPass.uniforms.exposure.value = this.renderer.toneMappingExposure;
      if (quality !== 'low') {
        this.finalPass.haze = this.effects.enableHaze(this.camera);
        this.finalPass.rays = this.effects.enableGodRays(this.camera);
      }
    }
    this.applyLevel(this.level, false);
    this.effects.group.name = 'effects';
    this.debris.group.name = 'debris';
    this.marks.group.name = 'marks';
    this.bridgeFx.group.name = 'bridges';
    this.overlay.group.name = 'overlay';
    this.atmos = new Atmosphere({ renderer: this.renderer, scene: this.scene, camera: this.camera, sun: this.sun, hemi: this.hemi, fog: this.fog, terrain: this.terrain, effects: this.effects, marks: this.marks, world, quality, composer: this.composer, finalPass: this.finalPass, bloom: this.bloom as unknown as UnrealBloomPass | null, canvas }, viewer);
    if (this.scarsOn) this.atmos.env.scars = this.scars;
    // physical sky dome + clouds (photo mode, intro, low angles, water reflections); low keeps the flat background
    if (quality !== 'low' && !/[?&]sky=0\b/.test(location.search)) {
      this.sky = new Sky(this.renderer, this.fog, quality, quality === 'high');
      this.scene.add(this.sky.mesh);
    }
    this.superFx = new SuperFx({ world, effects: this.effects, scene: this.scene, env: this.atmos.env, visibleAt: (x, y) => this.visibleAt(x, y), shake: (a, x, y) => this.shake(a, x, y) });
    this.sniperFx = new SniperFx({
      world,
      scene: this.scene,
      effects: this.effects,
      camera: this.camera,
      viewHeight: () => this.height,
      hour: () => {
        const c = this.atmos.clock();
        return c.hours + c.minutes / 60;
      },
      muzzle: (e) => this.sniperMuzzle(e),
      entityPos: (e, a) => this.entityPos(e, a),
      visibleAt: (x, y) => this.visibleAt(x, y),
      markFired: (e) => {
        const v = this.visuals.get(e.id);
        if (v) v.lastFire = this.time;
      },
    });
    this.river = new WaterFx({ world, terrain: this.terrain, effects: this.effects, atmos: this.atmos, fog: this.fog, scene: this.scene, quality, target: this.target, visibleAt: (x, y) => this.visibleAt(x, y) });
    this.life = new UnitLife(this.scene, this.effects, world, (x, z) => standHeight(world.map, x, z), (id) => this.visuals.get(id)?.model);
    this.deployFx = new DeployFx(this.scene, this.effects, (id) => !!world.get(id));
    if (ambientEnabled()) {
      this.ambient = new AmbientLife(this);
      this.scene.add(this.ambient.group);
      this.ambient.group.name = 'ambient';
    }
    // static shadow casters cached between sun shadow refreshes (shadowcache.ts)
    if (!this.csm && this.sun.castShadow) {
      // (battle scars: ruins / hulks only change when one is added, so they are cached like the scenery)
      const roots = [this.terrain.group, this.outskirts.group, this.bridgeFx.group, this.scars.group];
      this.shadowCache = new ShadowCache(this.renderer, this.scene, () => roots);
      this.shadowCache.enabled = !/[?&]scache=0\b/.test(location.search);
      this.shadowCache.install(this.sun);
    }
    if (/[?&]perf=1\b/.test(location.search)) this.enablePerf();

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

  private disposed = false;
  /** Optional view-mode hook (thermal / x-ray / drone camera, src/render/viewmodes.ts). */
  viewHook: ViewHook | null = null;
  /** The post-processing chain, when this quality level has one. */
  get postComposer(): EffectComposer | null {
    return this.composer;
  }
  /** The post chain itself (warm-up compiles its programs ahead of the first frame). */
  get postChain(): PostChain | null {
    return this.post;
  }
  /** True while frames go through the post chain (the quality governor can switch it off). */
  get postActive(): boolean {
    return !!this.composer && this.usePost;
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h, this.renderer.getPixelRatio());
    this.updateCamera();
  }

  /** Apply one rung of the quality ladder. */
  private applyLevel(level: number, doResize = true) {
    const s = this.ladder[level];
    if (!s) return;
    this.level = level;
    this.terrain.setLadder(level / Math.max(1, this.ladder.length - 1));
    if (Math.abs(this.renderer.getPixelRatio() - s.pr) > 0.001) {
      this.renderer.setPixelRatio(s.pr);
      if (doResize) this.resize(this.width, this.height);
    }
    this.post?.applyStep(s);
    this.usePost = !!this.composer && s.post;
    // AO already darkens the ground contact: the footprint shadows back off so the two don't double up
    if (this.contact) this.contact.strength = s.ao && this.usePost ? 0.55 : 1;
    // ultra rungs hint a bigger particle budget
    this.effects.budget = (s.ultra ? 1.3 : 1) - 0.45 * (level / Math.max(1, this.ladder.length - 1));
    if (this.csm) {
      if (s.shadow) this.csm.setMapSize(s.shadow);
    } else if (s.shadow && this.sun.shadow.mapSize.x !== s.shadow) {
      this.sun.shadow.mapSize.set(s.shadow, s.shadow);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  /** Camera shake (0.03 small .. 0.45 huge); with a position (tile x, y) it fades with distance from the view centre. */
  shake(amount: number, x?: number, y?: number) {
    this.effects.addShake(amount, x, y);
  }

  /** Current governor state, for debugging / screenshots. */
  perfStats() {
    const s = this.ladder[this.level];
    return { level: this.level, of: this.ladder.length, ...s, frameMs: Math.round(this.lastFt * 10000) / 10, calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles, watchdog: this.watchdogSteps };
  }

  /** Post chain state (debug / perf report): enabled passes, their full-screen draws, grade look weights. */
  postStats() {
    const st = this.post?.stats();
    return st ? { ...st, active: this.usePost, looks: { ...this.post!.lut.weights() }, dof: this.post!.dofActive } : null;
  }

  /**
   * Photo mode depth of field: focus 0..1 (near .. far around the orbit point) and amount 0..1;
   * null hands the free camera back to the intro / outro look. Returns true when the post chain
   * renders it (a real depth-based bokeh); false = the caller has to fake it.
   */
  setPhotoDof(focus: number | null, amount = 0): boolean {
    if (focus === null) this.photoDof = null;
    else {
      const d = (this.photoDof ??= { focus: 0.5, amount: 0 });
      d.focus = focus;
      d.amount = amount;
    }
    return !!this.post?.dof && this.usePost;
  }
  private photoDof: { focus: number; amount: number } | null = null;
  /** Bokeh amount of the intro / outro flyovers (free camera without photo mode): a gentle miniature look. */
  cinematicDof = 0.32;
  private gradeIn: GradeInput = { daylight: 1, sunY: 0.6, warmth: 0.7, rain: 0, storm: 0, sand: 0, snow: 0 };

  /** Per-frame post inputs: grade look from the atmosphere, depth of field from the free camera. */
  private updatePost(dt: number) {
    const pc = this.post!;
    const g = this.gradeIn;
    const a = this.atmos;
    g.daylight = a.daylight;
    g.sunY = this.sunDir.y;
    const c = this.sun.color;
    g.warmth = (c.r - c.b) / Math.max(1e-3, c.r);
    const wx = a.wx;
    if (wx) {
      // dynamic weather: overcast already greys the look a little, precipitation takes it the rest of the way
      const k = Math.max(wx.precip, wx.cover * 0.55);
      g.rain = wx.fall === 'rain' ? k : 0;
      g.snow = wx.fall === 'snow' ? k * 0.85 : 0;
      g.sand = wx.fall === 'sandstorm' ? Math.max(wx.precip, wx.cover * 0.5) : 0;
      g.storm = wx.storm;
    } else {
      const w = a.cfg.weather;
      g.rain = w === 'rain' ? 1 : 0;
      g.storm = w === 'rain' ? 0.35 : 0;
      g.sand = w === 'sandstorm' ? 1 : 0;
      g.snow = w === 'snow' ? 1 : 0;
    }
    const free = this.photoCam;
    if (free && pc.dof) {
      const dist = this.camera.position.distanceTo(free.look);
      const pd = this.photoDof;
      if (pd) pc.setDof(dist * Math.pow(2, (pd.focus - 0.5) * 3.2), pd.amount);
      else pc.setDof(dist, this.cinematicDof);
    } else pc.setDof(20, 0);
    // hard guard: never hand NaN to the grade (a NaN look bakes a black LUT)
    sanitizeGrade(g);
    pc.update(dt, g);
  }

  /** Start the per-pass / per-category / per-system cost probe (src/render/perf/probe.ts). */
  enablePerf() {
    const sys = (obj: object, fn: string) => ({ obj, fn });
    this.perf.enable({
      'sync entities': sys(this, 'syncEntities'),
      'wrecks': sys(this, 'updateWrecks'),
      'scars': sys(this.scars, 'update'),
      'projectiles': sys(this, 'syncProjectiles'),
      'readability': sys(this, 'updateReadability'),
      'outline+icons draw': sys(this.readability, 'renderOverlays'),
      'camera+shadow fit': sys(this, 'updateCamera'),
      'atmos': sys(this.atmos, 'update'),
      'effects': sys(this.effects, 'update'),
      'water': sys(this.river, 'update'),
      'terrain': sys(this.terrain, 'update'),
      'bridges': sys(this.bridgeFx, 'update'),
      'superfx': sys(this.superFx, 'update'),
      'sniperfx': sys(this.sniperFx, 'update'),
      'fog': sys(this.fog, 'update'),
      ...(this.ambient ? { ambient: sys(this.ambient, 'update') } : {}),
      'instancer': sys(this.instancer, 'update'),
      'frame total': sys(this, 'render'),
    });
  }

  /** Zoom that shows units at a comfortable, RA2-like size for this viewport. */
  defaultZoom(wide = false) {
    // the perspective camera frames a little closer: units read big, the far side recedes
    const visible = (this.perspective ? Math.max(10, Math.min(11.5, this.height / 62)) : Math.max(11, Math.min(12.5, this.height / 58))) * (wide ? 1.4 : 1);
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, BASE_VIEW / visible));
  }

  // ------------------------------------------------------------------ camera

  private sunDir = SUN_DIR.clone();
  private sunRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  private sunUp = new THREE.Vector3().crossVectors(SUN_DIR, this.sunRight).normalize();
  private corner = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  /** Unit vector from the view target towards the camera (rotates with the 90 degree view steps). */
  readonly camDir = CAM_DIR.clone();
  /** Camera yaw in radians (0 = classic view from +X/+Z); animates towards yawGoal. */
  yaw = 0;
  private yawGoal = 0;
  private yawFrom = 0;
  private yawT = 1;
  private yawClock = 0;

  /** Rotate the view by 90 degree steps (animated). */
  rotateView(steps: number) {
    this.yawGoal += steps * (Math.PI / 2);
    this.yawFrom = this.yaw;
    this.yawT = 0;
  }
  /** Settled 90 degree view step 0..3 (where the rotation is heading). */
  get viewStep(): number {
    return ((Math.round(this.yawGoal / (Math.PI / 2)) % 4) + 4) % 4;
  }
  get rotating(): boolean {
    return Math.abs(this.yawGoal - this.yaw) > 1e-3;
  }
  /** Camera elevation above the horizon (radians); the perspective camera tilts lower when zoomed in. */
  elevation(): number {
    if (!this.perspective) return Math.asin(CAM_DIR.y);
    const k = Math.max(0, Math.min(1, (this.zoom - 0.8) / (MAX_ZOOM - 0.8)));
    return THREE.MathUtils.degToRad(PITCH_FAR + (PITCH_NEAR - PITCH_FAR) * k);
  }

  private updateCamera() {
    // animate the view rotation on real time (render dt may be slowed by cinematics)
    const now = performance.now();
    const rdt = this.yawClock ? Math.min(0.1, (now - this.yawClock) / 1000) : 0;
    this.yawClock = now;
    if (this.yaw !== this.yawGoal) {
      this.yawT = Math.min(1, this.yawT + rdt / 0.5);
      const k = this.yawT;
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.yaw = k >= 1 ? this.yawGoal : this.yawFrom + (this.yawGoal - this.yawFrom) * e;
    }
    const elev = this.elevation();
    const ca = Math.PI / 4 + this.yaw;
    this.camDir.set(Math.cos(ca) * Math.cos(elev), Math.sin(elev), Math.sin(ca) * Math.cos(elev));
    // the sun turns with the view so the scene is always lit from the upper left of the screen
    // (the dynamic day / night cycle moves the sun and moon across the sky: atmos.sunBase)
    this.sunDir.copy(this.atmos?.sunBase ?? SUN_DIR).applyAxisAngle(this.yAxis, -this.yaw);
    // hard guard: a degenerate key light (NaN / zero) would turn every lit pixel NaN, i.e. a black screen
    if (!Number.isFinite(this.sunDir.x + this.sunDir.y + this.sunDir.z) || this.sunDir.lengthSq() < 1e-8) this.sunDir.copy(SUN_DIR).applyAxisAngle(this.yAxis, Number.isFinite(this.yaw) ? -this.yaw : 0);
    this.sunRight.crossVectors(this.yAxis, this.sunDir).normalize();
    this.sunUp.crossVectors(this.sunDir, this.sunRight).normalize();
    const D = this.camDir;
    const aspect = this.width / Math.max(1, this.height);
    const vh = BASE_VIEW / this.zoom;
    let dist = CAM_DIST;
    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera) {
      // dolly zoom: the view height at the target matches the orthographic BASE_VIEW / zoom
      dist = vh / (2 * Math.tan(THREE.MathUtils.degToRad(PERSP_FOV / 2)));
      cam.aspect = aspect;
      cam.near = Math.max(0.3, dist * 0.2);
      cam.far = dist + 260;
    } else {
      cam.left = (-vh * aspect) / 2;
      cam.right = (vh * aspect) / 2;
      cam.top = vh / 2;
      cam.bottom = -vh / 2;
    }
    cam.updateProjectionMatrix();
    const ty = groundHeight(this.world.map, this.target.x, this.target.z);
    const so = this.effects?.shakeOffset();
    const sx = so ? so.x : 0;
    const sz = so ? so.z : 0;
    cam.position.set(this.target.x + D.x * dist + sx, ty + D.y * dist, this.target.z + D.z * dist + sz);
    cam.lookAt(this.target.x + sx, ty, this.target.z + sz);
    // photo mode (src/game/photomode.ts): free orbit camera
    const pc = this.photoCam;
    if (pc) {
      if (cam instanceof THREE.PerspectiveCamera) {
        cam.position.copy(pc.pos);
        cam.near = 0.1;
        cam.far = 700;
        cam.updateProjectionMatrix();
      } else cam.position.copy(pc.pos).sub(pc.look).setLength(CAM_DIST).add(pc.look);
      cam.lookAt(pc.look);
      D.copy(cam.position).sub(pc.look).normalize();
    }
    this.camera.updateMatrixWorld();
    this.fitShadow(ty);
    const u = this.fog.uniforms;
    u.fogTarget.value.set(this.target.x, ty, this.target.z);
    u.fogView.value.copy(D).negate();
    u.fogTime.value = this.time;
    this.effects?.setPointScale((this.height * this.renderer.getPixelRatio()) / vh);
    this.tilt?.setZoom(this.zoom, this.defaultZoom(), this.renderer.getPixelRatio());
    if (pc && this.tilt) this.tilt.enabled = false;
  }
  /** Photo mode free camera (position + look-at point); null = the normal RTS camera. */
  photoCam: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

  /**
   * Fit the sun's shadow frustum tightly around what the camera sees, snapped
   * to whole shadow-map texels so the shadows stay crisp and don't shimmer
   * while panning.
   */
  private fitShadow(ty: number) {
    if (this.csm) {
      this.csm.sync(this.sun);
      this.csm.fit(this.camera, this.target, ty, this.sunDir, this.sunRight, this.sunUp, 18 + BASE_VIEW / this.zoom);
      if (this.temporal) this.temporal.sunDir.copy(this.sunDir);
      return;
    }
    if (!this.sun.castShadow) return;
    // The shadow follows the sun in steps of at most SHADOW_STEP (0.02 degrees: a fraction of a shadow texel
    // even for tall buildings): the live day / night cycle moves the sun a little every tick, and every move
    // re-renders the whole shadow map (static casters included, shadowcache.ts). Lighting follows the same
    // direction (it is the light's own position), a difference far below one colour level.
    const sd = this.shadowDir;
    if (this.shadowDirSet !== this.sunDir.x + this.sunDir.y * 3 + this.sunDir.z * 7) {
      this.shadowDirSet = this.sunDir.x + this.sunDir.y * 3 + this.sunDir.z * 7;
      if (sd.lengthSq() === 0 || sd.angleTo(this.sunDir) > SHADOW_STEP) {
        sd.copy(this.sunDir);
        this.shadowR.crossVectors(this.yAxis, sd).normalize();
        this.shadowU.crossVectors(sd, this.shadowR).normalize();
      }
    }
    const R = this.shadowR;
    const U = this.shadowU;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    // footprint of the view frustum on two height slabs; rays diverge with the perspective camera,
    // so far corners are pulled in to keep the shadow map resolution on what matters
    const reach = 18 + BASE_VIEW / this.zoom;
    const tx0 = this.target.x;
    const tz0 = this.target.z;
    for (const nx of [-1, 1])
      for (const ny of [-1, 1]) {
        this.corner.set(nx, ny, -1).unproject(this.camera);
        this.camFwd.set(nx, ny, 1).unproject(this.camera).sub(this.corner).normalize();
        for (const hy of [ty - 1.5, ty + 3.5]) {
          const t = this.camFwd.y < -1e-4 ? (hy - this.corner.y) / this.camFwd.y : 1e4;
          let px = this.corner.x + this.camFwd.x * t;
          const py = hy;
          let pz = this.corner.z + this.camFwd.z * t;
          const dd = Math.hypot(px - tx0, pz - tz0);
          if (dd > reach) {
            px = tx0 + ((px - tx0) * reach) / dd;
            pz = tz0 + ((pz - tz0) * reach) / dd;
          }
          const a = px * R.x + py * R.y + pz * R.z;
          const b = px * U.x + py * U.y + pz * U.z;
          minX = Math.min(minX, a);
          maxX = Math.max(maxX, a);
          minY = Math.min(minY, b);
          maxY = Math.max(maxY, b);
        }
      }
    // quantise the extent (only changes with zoom/resize) and snap the centre to texels
    const hx = Math.ceil(((maxX - minX) / 2 + 1.5) / 2) * 2;
    const hy = Math.ceil(((maxY - minY) / 2 + 1.5) / 2) * 2;
    const size = this.sun.shadow.mapSize.x;
    const tx = (2 * hx) / size;
    const tyx = (2 * hy) / size;
    const cx = Math.round((minX + maxX) / 2 / tx) * tx;
    const cy = Math.round((minY + maxY) / 2 / tyx) * tyx;
    const sc = this.sun.shadow.camera;
    if (sc.right !== hx || sc.top !== hy) {
      sc.left = -hx;
      sc.right = hx;
      sc.top = hy;
      sc.bottom = -hy;
      sc.near = 1;
      sc.far = 140;
      sc.updateProjectionMatrix();
    }
    const cz = this.target.x * -sd.x + ty * -sd.y + this.target.z * -sd.z;
    const c = this.corner.copy(R).multiplyScalar(cx).addScaledVector(U, cy).addScaledVector(sd, -cz);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(sd, 70);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  setZoom(z: number) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  panPixels(dx: number, dy: number) {
    const vh = BASE_VIEW / this.zoom;
    const wpp = vh / this.height;
    // screen right / screen up on the ground plane for the current view rotation
    const ca = Math.PI / 4 + this.yaw;
    const right = new THREE.Vector3(Math.sin(ca), 0, -Math.cos(ca));
    const up = new THREE.Vector3(-Math.cos(ca), 0, -Math.sin(ca));
    const elev = this.elevation();
    this.target.addScaledVector(right, dx * wpp);
    this.target.addScaledVector(up, (-dy * wpp) / Math.sin(elev));
    this.clampTarget();
  }

  centerOn(x: number, y: number) {
    this.target.set(x, 0, y);
    this.clampTarget();
  }

  /** Ground point the camera must look at so the 3D point (x, height h, y) lands in the screen centre. */
  focusPoint(x: number, h: number, y: number): { x: number; y: number } {
    const D = this.camDir;
    const g = standHeight(this.world.map, Math.max(0, Math.min(this.world.map.w - 0.01, x)), Math.max(0, Math.min(this.world.map.h - 0.01, y)));
    const s = (g - h) / D.y;
    return { x: x + D.x * s, y: y + D.z * s };
  }

  /** Screen pixels per world unit at the view target, or at world point p (perspective shrinks with depth). */
  pixelsPerUnit(p?: { x: number; y: number; z: number }): number {
    const base = this.height / (BASE_VIEW / this.zoom);
    const cam = this.camera;
    if (!p || !(cam instanceof THREE.PerspectiveCamera)) return base;
    cam.getWorldDirection(this.camFwd);
    const depth = (p.x - cam.position.x) * this.camFwd.x + (p.y - cam.position.y) * this.camFwd.y + (p.z - cam.position.z) * this.camFwd.z;
    const ty = groundHeight(this.world.map, this.target.x, this.target.z);
    const ref = (this.target.x - cam.position.x) * this.camFwd.x + (ty - cam.position.y) * this.camFwd.y + (this.target.z - cam.position.z) * this.camFwd.z;
    return (base * ref) / Math.max(0.5, depth);
  }

  /** Intersection of the view ray through a screen point with the horizontal plane at height h. */
  screenToPlane(sx: number, sy: number, h: number): { x: number; y: number } {
    this.ndc.set((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    const t = (o.y - h) / Math.max(1e-4, -d.y);
    return { x: o.x + d.x * t, y: o.z + d.z * t };
  }

  /** Drag-scroll: move the view so the ground under (x0, y0) ends up under (x1, y1). */
  panDrag(x0: number, y0: number, x1: number, y1: number) {
    const h = groundHeight(this.world.map, this.target.x, this.target.z);
    const a = this.screenToPlane(x0, y0, h);
    const b = this.screenToPlane(x1, y1, h);
    this.target.x += a.x - b.x;
    this.target.z += a.y - b.y;
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
  entityPos(e: Entity, alpha: number, out?: THREE.Vector3): THREE.Vector3 {
    const x = e.px + (e.x - e.px) * alpha;
    const y = e.py + (e.y - e.py) * alpha;
    // (ground units on a bridge follow the deck's end ramps up onto raised banks: deckramp.ts)
    let h = unitStandHeight(this.world.map, Math.max(0, Math.min(this.world.map.w - 0.01, x)), Math.max(0, Math.min(this.world.map.h - 0.01, y)));
    if (e.kind === 'unit' && unitDef(e.def).air) {
      const d = unitDef(e.def);
      const z = e.pz + (e.z - e.pz) * alpha;
      // (relief.ts: climb over the render-only cliffs, fading out as a drone dives onto its target)
      h = Math.max(h, 0) + z + reliefClearance(this.world.map, x, y) * Math.min(1, z * 2) + (d.kamikaze || d.fixedWing ? 0 : Math.sin(this.time * 1.7 + e.id) * 0.04);
    } else if (e.para || e.pz > 0) {
      // under a parachute canopy
      h = Math.max(h, 0) + e.pz + (e.z - e.pz) * alpha;
    }
    return out ? out.set(x, h, y) : new THREE.Vector3(x, h, y);
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
    const cat = e.kind === 'building' ? 'building' : d.category === 'infantry' ? 'infantry' : d.category === 'air' ? 'aircraft' : 'vehicle';
    model.root.userData.perfCat = cat;
    if (e.kind === 'unit') enlargeUnit(model, d.category === 'infantry' ? INFANTRY_SCALE : d.category === 'air' ? AIR_SCALE : VEHICLE_SCALE);
    const lod = prepareLod(model.root, cat, this.quality === 'medium', e.owner >= 0 ? this.world.players[e.owner].color : 0x9a9a9a);
    this.scene.add(model.root);
    const visual: Visual = {
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
      anim: { ...newAnim(), seed: e.id },
      lod,
      occl: true,
      near: true,
    };
    this.compileAhead(visual, `${d.model}|${e.owner}`);
    return visual;
  }

  private compiledKinds = new Set<string>();
  private compileRT: THREE.WebGLRenderTarget | null = null;
  /**
   * The first model of a type in this match (one the warm-up did not cover, e.g. in the demo battle):
   * with parallel shader compile, compile its programs in the background and hold it back for the
   * few frames that takes, instead of linking them synchronously inside the next frame.
   */
  private compileAhead(v: Visual, kind: string) {
    if (this.compiledKinds.has(kind)) return;
    this.compiledKinds.add(kind);
    if (!this.renderer.extensions.get('KHR_parallel_shader_compile')) return;
    const gl = this.renderer;
    const prev = gl.getRenderTarget();
    // the scene renders into the post chain's linear target: compile that variant
    if (this.postActive) gl.setRenderTarget((this.compileRT ??= new THREE.WebGLRenderTarget(4, 4)));
    v.pending = true;
    let p: Promise<unknown>;
    try {
      p = gl.compileAsync(v.model.root, this.camera, this.scene);
    } catch {
      p = Promise.resolve();
    } finally {
      gl.setRenderTarget(prev);
    }
    // (never hold a unit back for long, whatever the driver does)
    const release = () => (v.pending = false);
    void p.then(release, release);
    setTimeout(release, 3000);
  }

  private removeVisual(v: Visual) {
    this.scene.remove(v.model.root);
    if (v.ring) this.scene.remove(v.ring);
    this.visuals.delete(v.id);
  }

  private airShadows = new AirShadows();
  private occluders: OccluderGrid;
  private viewFrustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private castSphere = new THREE.Sphere();
  /** Off-screen pose animation skip (?pfanim=0 turns it off: A/B checks with the same random sequence). */
  private animSkip = typeof location === 'undefined' || !/[?&]pfanim=0\b/.test(location.search);
  /** Scratch: an entity's interpolated position (syncEntities). */
  private posTmp = new THREE.Vector3();
  /** Scratch: an emitter's world position (exhaust, sparks, chimneys). */
  private emitP = new THREE.Vector3();
  private occlFrame = 0;

  /**
   * Height of a building's ground slab. The airbase (7 x 4) sits level on the highest ground under it,
   * its concrete skirt hiding the slope (a centre sample would let bumps poke through the runway).
   */
  slabHeight(b: Entity): number {
    const map = this.world.map;
    const c = Math.max(groundHeight(map, b.x, b.y), -0.1);
    const bd = buildingDef(b.def);
    if (bd.role !== 'airfield') return c;
    let top = c;
    for (let y = b.ty; y <= b.ty + bd.h; y++) for (let x = b.tx; x <= b.tx + bd.w; x++) top = Math.max(top, groundHeight(map, x, y));
    return Math.min(top, c + 0.35);
  }

  /**
   * Strike jet on the airbase sortie cycle: it sits on its landing gear on the slab (taxi, roll), the gear
   * cycles on climb-out / approach, the nose comes up at rotation, stays up on final and in the flare.
   */
  private poseJet(e: Entity, v: Visual, a: AnimState, alpha: number) {
    const s = e.sortie!;
    const ph = s.phase;
    const z = e.pz + (e.z - e.pz) * alpha;
    const onGround = ph === 'parked' || ph === 'taxiOut' || ph === 'hold' || ph === 'lineup' || ph === 'rollout' || ph === 'taxiIn' || (ph === 'takeoff' && z < 0.005);
    a.ground = onGround ? 1 : 0;
    const gearDown = onGround || ph === 'takeoff' || ph === 'final' || (ph === 'sortie' && z < 0.9) || (ph === 'return' && z < 1.6 && s.v * TPS < 3.6);
    a.gear = gearDown ? 1 : 0;
    // attitude: the flight path angle, plus rotation, approach attitude and the flare
    const ds = Math.hypot(e.x - e.px, e.y - e.py);
    let pitch = ds > 1e-4 ? Math.atan2(e.z - e.pz, ds) * 0.9 : 0;
    if (ph === 'takeoff' && z > 0.001) pitch = Math.max(pitch, 0.17);
    else if (ph === 'final') pitch = z < 0.3 ? 0.17 : 0.07;
    else if (onGround) pitch = 0;
    a.pitch = Math.max(-0.3, Math.min(0.4, pitch));
    // sit on the gear: wheels on the airbase slab (or the terrain off base), blending out on climb-out
    const root = v.model.root;
    const b = s.base >= 0 ? this.world.get(s.base) : undefined;
    const k = Math.max(0, Math.min(1, 1 - z / 0.5));
    if (k > 0) {
      const map = this.world.map;
      const g = b ? this.slabHeight(b) + 0.05 : Math.max(standHeight(map, root.position.x, root.position.z), 0);
      const drop = (v.model.gearDrop ?? 0.08) * root.scale.y;
      const len = v.model.size?.x ?? 1;
      const air = Math.max(standHeight(map, root.position.x, root.position.z), 0) + z;
      root.position.y = air + (g + z + drop + Math.max(0, a.pitch) * len * 0.3 - air) * k;
    }
  }

  /** Contact shadow footprint for one ground unit / building (aircraft have AirShadows). */
  private addContact(e: Entity, v: Visual) {
    const c = this.contact!;
    const m = v.model;
    const root = m.root;
    const map = this.world.map;
    const sz = m.size;
    if (e.kind === 'building') {
      const bd = buildingDef(e.def);
      const hl = Math.min(bd.w * 0.5, sz ? sz.x * 0.5 : bd.w * 0.45) * 0.96;
      const hw = Math.min(bd.h * 0.5, sz ? sz.z * 0.5 : bd.h * 0.45) * 0.96;
      c.add(map, root.position.x, root.position.z, root.rotation.y, hl, hw, 0.3, 0.5 * Math.min(1, v.anim.built * 2));
      return;
    }
    if (unitDef(e.def).air) return;
    const p = root.position;
    const above = p.y - standHeight(map, p.x, p.z);
    if (above > 0.6) return;
    const fade = Math.min(1, 1 - above / 0.6);
    if (m.infantry) c.add(map, p.x, p.z, root.rotation.y, 0.08, 0.08, 0.15, 0.45 * fade);
    else c.add(map, p.x, p.z, 0, (sz ? sz.x * 0.5 : 0.4) * 0.84, (sz ? sz.z * 0.5 : 0.25) * 0.9, 0.24, 0.55 * fade, root.quaternion);
  }
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
    const seen = this.seenIds;
    seen.clear();
    this.airShadows.begin(this.scene);
    this.contact?.begin();
    this.chutes.begin();
    // screen size for the detail LOD: px per world unit = lodK / view depth
    const cam = this.camera;
    cam.getWorldDirection(this.camFwd);
    const cf = this.camFwd;
    const cp = cam.position;
    const ty0 = groundHeight(w.map, this.target.x, this.target.z);
    const persp = cam instanceof THREE.PerspectiveCamera && !this.photoCam;
    const refDepth = persp ? (this.target.x - cp.x) * cf.x + (ty0 - cp.y) * cf.y + (this.target.z - cp.z) * cf.z : 1;
    const lodK = (this.height / (BASE_VIEW / this.zoom)) * refDepth;
    if (this.occlFrame++ % 15 === 0) {
      const bl: { id: number; tx: number; ty: number; w: number; h: number; height: number }[] = [];
      for (const v of this.visuals.values()) {
        const be = v.visible ? w.get(v.id) : undefined;
        if (!be || be.kind !== 'building') continue;
        const bd = buildingDef(be.def);
        bl.push({ id: be.id, tx: be.tx, ty: be.ty, w: bd.w, h: bd.h, height: v.model.height ?? 1 });
      }
      this.occluders.setBuildings(bl);
    }
    const cd = this.camDir;
    // shadow casters: only models whose shadow can reach the view (the sun shadow box spans a much
    // wider rectangle than the perspective view, so off-screen units would otherwise all cast)
    const fr = this.viewFrustum.setFromProjectionMatrix(this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const sd = this.sunDir;
    const sy = Math.max(0.15, sd.y);
    const throwX = -sd.x / sy;
    const throwZ = -sd.z / sy;
    const shadowsOn = this.sun.castShadow || !!this.csm;
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
        // a building going up clears the old battle's rubble / hulks / fresh craters off its footprint (scars.ts)
        if (e.kind === 'building') {
          const bd = buildingDef(e.def);
          this.scars.clearArea(e.tx, e.ty, e.tx + bd.w, e.ty + bd.h);
        }
      }
      const vis = this.isVisibleToViewer(e);
      // (a model of a type new to this match is held back until its shaders have compiled in the background)
      v.model.root.visible = vis && !v.pending;
      v.visible = vis;
      const d = DEFS[e.def];
      const root = v.model.root;
      const a = v.anim;
      a.dt = dt;
      a.time = this.time;
      a.fired = this.time - v.lastFire;
      a.aim = e.aimTarget >= 0 ? 1 : 0; // sniper lock-on: shouldered, kneeling (sim/sniper.ts)
      a.damage = 1 - e.hp / e.maxHp;
      if (e.kind === 'building') {
        const bd = buildingDef(e.def);
        const h = this.slabHeight(e);
        root.position.set(e.tx + bd.w / 2, h, e.ty + bd.h / 2);
        const k = e.buildAnim;
        a.built = k;
        if (this.deployFx.active) {
          // MCV still unfolding over its new yard: the yard appears / rises on the overlay's clock
          const dk = this.deployFx.built(e.id);
          if (dk >= 0) {
            a.built = Math.max(1e-3, dk);
            if (dk <= 0) root.visible = false;
          }
        }
        a.powered = e.owner < 0 || !w.isLowPower(w.players[e.owner]);
        a.produced = v.prodAt !== undefined ? this.time - v.prodAt : Infinity;
        a.moving = false;
        if (k < 1 && vis && Math.random() < dt * 20) this.effects.dust(root.position.x + (Math.random() - 0.5) * bd.w, h + 0.05, root.position.z + (Math.random() - 0.5) * bd.h, 1.5);
        if (v.model.turret) v.model.turret.rotation.y = -lerpAngle(e.pturret, e.turret, alpha);
        if (vis) this.buildingFx(e, v, dt);
        // badly damaged: cut its rubble chunks ahead of time in idle callbacks (fracture.ts)
        if (a.damage > 0.45 && k >= 1) this.fracture.prewarm(root, bd.w, bd.h);
      } else {
        const ud = unitDef(e.def);
        // (a scratch vector: nothing below keeps it past this entity)
        const p = this.entityPos(e, alpha, this.posTmp);
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
          // detailed models bank / pitch an inner group themselves from the anim state
          if (v.model.anim) root.rotation.set(0, yaw, 0, 'YXZ');
          else root.rotation.set(v.bank, yaw, pitch, 'YXZ');
          if (ud.kamikaze) {
            const climb = (e.z - e.pz) * TPS;
            root.rotation.z = Math.max(-0.9, Math.min(0.4, climb * 0.25));
          }
          if (vis) {
            const sz = v.model.size;
            this.airShadows.add(w.map, p.x, p.z, yaw, p.y - standHeight(w.map, p.x, p.z), sz ? sz.x : 0.6, sz ? sz.z : 0.5, !ud.fixedWing && d.model !== 'uav' && d.model !== 'heavy_uav' && d.model !== 'shahed');
          }
        } else if (ud.category === 'vehicle') {
          poseGroundVehicle(v.model, a, w.map, p, yaw, dt, vis);
          this.life.vehicle(e, a, !!ud.transport);
        } else if (v.model.infantry) {
          poseInfantry(v.model, a, w.map, p, yaw, dt);
          this.life.infantry(e, v.model, a, vis, dt);
        } else {
          root.rotation.set(0, yaw, 0);
        }
        // airbase sortie: wheels on the runway, gear, rotation / flare attitude (sim/airbase.ts)
        if (e.sortie && ud.fixedWing) this.poseJet(e, v, a, alpha);
        // airborne drop: transport ramp door, jumpers / supply pallet under canopy
        if (ud.airlift) a.ramp = e.drop?.ramp ?? 0;
        if (v.model.infantry) a.para = e.para ? 1 : 0;
        if (e.para) this.chutes.track(e, v.model, p, yaw, styleFor(w, e.owner).region, !!ud.supply, alpha, vis, this.time, dt, w.map);
        if (v.model.turret) v.model.turret.rotation.y = -angleDiff(lerpAngle(e.pfacing, e.facing, alpha), lerpAngle(e.pturret, e.turret, alpha));
        if (vis) this.unitFx(e, v, p, yaw, moved, dt);
      }
      if (v.model.infantry) a.lod = !vis ? 2 : a.lod === 2 && v.near ? 0 : a.lod;
      // the model or its shadow may be on screen (bounding sphere around the model and its shadow throw)
      let nearNow = false;
      if (vis) {
        const rp = root.position;
        const h = v.model.height ?? 1;
        const tx = shadowsOn ? throwX * h : 0;
        const tz = shadowsOn ? throwZ * h : 0;
        const sph = this.castSphere;
        sph.center.set(rp.x + tx * 0.5, rp.y + h * 0.5, rp.z + tz * 0.5);
        sph.radius = v.lod.radius + Math.hypot(tx, tz) * 0.5 + h * 0.5 + 1.5;
        nearNow = fr.intersectsSphere(sph);
      }
      // Vehicles / buildings / aircraft off screen (model and shadow) or under the shroud: no pose animation.
      // The time is banked and handed over in one step once the model can be seen again (spinners, blends
      // and timers end up where they would have been); infantry have their own cheap off-screen cycle.
      if (!nearNow && !v.model.infantry && !this.photoCam && this.animSkip) v.animDebt = Math.min(5, (v.animDebt ?? 0) + dt);
      else {
        const debt = v.animDebt ?? 0;
        if (debt) {
          a.dt = dt + debt;
          v.animDebt = 0;
        }
        if (v.model.anim) v.model.anim(a);
        this.legacyAnim(v.model, a);
        a.dt = dt;
      }
      if (v.model.recoil && v.recoil > 0) {
        v.recoil = Math.max(0, v.recoil - dt * 4);
        for (const r of v.model.recoil) r.position.x = (r.userData.baseX ??= r.position.x) - v.recoil * 0.12;
      }
      this.updateRing(e, v, d);
      if (vis && this.contact) this.addContact(e, v);
      if (vis) {
        const rp = root.position;
        const depth = persp ? Math.max(0.5, (rp.x - cp.x) * cf.x + (rp.y - cp.y) * cf.y + (rp.z - cp.z) * cf.z) : 1;
        applyLod(v.lod, this.photoCam ? 1e9 : lodK / depth);
        {
          v.near = nearNow;
          if (shadowsOn) setCasting(v.lod, v.near);
          // infantry animation detail for the next frame: off screen / far zoom (soldier under ~16 px) / low quality -> cheaper cycle
          if (v.model.infantry) {
            const hpx = this.photoCam ? 1e9 : (lodK / depth) * (v.model.height ?? 0.5);
            a.lod = !v.near ? 2 : hpx < (this.quality === 'low' ? 40 : 16) ? 1 : 0;
          }
        }
        // (staggered: each unit re-tests every 4th frame)
        if ((this.occlFrame + v.id) % 4 === 0 || this.photoCam) v.occl = e.kind !== 'unit' || !!this.photoCam || this.occluders.mayHide(rp.x, rp.y, rp.z, cd.x, cd.y, cd.z);
      }
    }
    this.airShadows.end();
    this.contact?.end();
    this.chutes.end(dt, this.time);
    // (deleting the current entry while iterating a Map is safe: no per-frame copy of the visual list)
    if (this.visuals.size > seen.size) for (const v of this.visuals.values()) {
      if (seen.has(v.id)) continue;
      // boarding a transport: the soldier first walks up the ramp (unitlife.ts)
      if (v.model.infantry && this.life.adopt(v.id, v.model)) {
        this.visuals.delete(v.id);
        if (v.ring) this.scene.remove(v.ring);
        continue;
      }
      this.removeVisual(v);
    }
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
        this.effects.trackDust(p.x, p.z, fx, fz, v.speed, g, !!m.wheeled, m.size?.x, m.size?.z);
      }
    } else if (m.infantry && !e.para && moved > 0) {
      // boot prints (snow / mud / sand), alternating feet
      v.trackAcc += moved;
      if (v.trackAcc >= 0.15) {
        v.trackAcc %= 0.15;
        this.marks.footstep(p.x, p.z, -yaw, Math.floor(v.dist / 0.15) & 1 ? 1 : -1);
      }
    }
    // exhaust while driving
    if (v.anim.moving && !ud.air && m.emitters.length) {
      v.exhaustTimer -= dt;
      if (v.exhaustTimer <= 0) {
        v.exhaustTimer = 0.08;
        for (const em of m.emitters) {
          if (em.kind !== 'smoke') continue;
          const wp = this.emitP.copy(em.pos).applyMatrix4(m.root.matrixWorld);
          this.effects.exhaust(wp.x, wp.y, wp.z);
        }
      }
    }
    for (const em of m.emitters) {
      if (em.kind === 'spark' && Math.random() < dt * 3) {
        const wp = this.emitP.copy(em.pos).applyMatrix4(m.root.matrixWorld);
        this.effects.spark(wp.x, wp.y, wp.z);
      }
    }
    // battle damage
    if (ud.category !== 'infantry' && emitDamageFx(this.effects, m, v.anim.damage, dt, ud.harvester || ud.mcv ? 1.3 : 1)) {
      // model-specific damage points (smoke columns, fires, sparks)
    } else if (ud.category !== 'infantry' && e.hp < e.maxHp * 0.4) {
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
    if (ud.air && !ud.fixedWing && !ud.kamikaze && e.z < 1.6 && Math.random() < dt * 14) this.effects.rotorWash(p.x, standHeight(this.world.map, p.x, p.z), p.z, Math.min(1, (1.7 - e.z) / 1.2));
    // decoy flares when a missile is homing in
    if (ud.air && !ud.kamikaze && this.effects.flaresDue(e.id)) popFlares(this.effects, m, yaw);
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
        const wp = this.emitP.copy(em.pos).applyMatrix4(root.matrixWorld);
        if (em.kind === 'spark') this.effects.spark(wp.x, wp.y, wp.z);
        else if (em.kind === 'fire') this.effects.flame(wp.x, wp.y, wp.z, 0.6);
        else this.effects.smoke(wp.x, wp.y, wp.z, em.kind === 'steam' ? 0.9 : 0.6, em.kind === 'smoke');
      }
    }
    if (e.buildAnim >= 1 && emitDamageFx(this.effects, v.model, v.anim.damage, dt, Math.max(1, Math.sqrt(bd.w * bd.h) * 0.8))) {
      // model-specific damage points
    } else if (e.hp < e.maxHp * 0.55) {
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

  /** Selection / hover rings live in the combat overlay (src/render/overlay.ts). */
  private updateRing(e: Entity, v: Visual, d: (typeof DEFS)[string]) {
    const sel = this.selection.has(e.id);
    if (!v.visible || (!sel && this.hover !== e.id)) return;
    const rp = v.model.root.position;
    const air = e.kind === 'unit' && unitDef(e.def).air;
    // a jet on its wheels: the ring goes on the airbase slab under it
    const onPad = !!e.sortie && e.z < 0.3 && e.sortie.base >= 0 ? this.world.get(e.sortie.base) : undefined;
    const gy = onPad ? this.slabHeight(onPad) + 0.05 : air ? standHeight(this.world.map, rp.x, rp.z) : rp.y;
    const color = e.owner < 0 ? 0xffd860 : this.world.players[e.owner].color;
    const bd = e.kind === 'building' ? buildingDef(e.def) : null;
    this.overlay.ring(e.id, rp.x, rp.z, gy, color, sel, bd, (d as { radius?: number }).radius ?? 0.4, e.rank >= 2);
  }

  // ------------------------------------------------------------------ wrecks

  private toWreck(v: Visual, e: { def: string; x: number; y: number; cause?: 'crushed' }) {
    this.visuals.delete(v.id);
    // back on layer 0: wrecks and fracture rubble copy / reuse the meshes
    restoreMain(v.model.root);
    if (v.ring) this.scene.remove(v.ring);
    const d = DEFS[e.def];
    const root = v.model.root;
    const pos = root.position.clone();
    const base: Wreck = { kind: 'vehicle', root, model: v.model, t: 0, max: 26, x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, spin: 0, size: 1, h: v.model.height ?? 0.5, w: 1, d: 1, landed: true };
    if (d.kind === 'building') {
      const bd = buildingDef(e.def);
      // medium / high: break the model into rigid chunks (falls back to the sink collapse when the chunk pool is full)
      const frac = this.fracture.shatter(root, bd.w, bd.h, this.scene) ?? undefined;
      if (frac) this.scene.remove(root);
      this.wrecks.push({ ...base, kind: 'building', max: frac ? 44 : 40, w: bd.w, d: bd.h, size: Math.max(bd.w, bd.h), frac, ruin: !bd.garrison, flatRuin: bd.role === 'airfield' });
      return;
    }
    const ud = unitDef(e.def);
    // killed under the canopy: the parachute carries the body down
    if (ud.category === 'infantry' && this.chutes.takeBody(v.id, v.model, v.anim)) return;
    if (ud.category === 'infantry') {
      if (v.model.infantry && v.model.anim) this.wrecks.push({ ...base, kind: 'infantry', max: 3, anim: { ...v.anim, dead: 0.001, moving: false, crushed: e.cause === 'crushed' ? 1 : 0, look: undefined, dive: 0 } });
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
      this.wrecks.push({ ...base, kind: 'air', max: 30, size: ud.fixedWing ? 1 : 0.8, vx: Math.cos(-root.rotation.y) * sp, vz: Math.sin(-root.rotation.y) * sp, vy: 0.5, spin: (Math.random() - 0.5) * 6, landed: false });
      return;
    }
    // crew ducks inside / hatch slammed shut on the burning hull
    v.model.anim?.({ ...v.anim, dt: 0, dead: 1 });
    const wr: Wreck = { ...base, kind: 'vehicle', size: ud.harvester || ud.mcv ? 1.4 : 1 };
    if (v.model.turret && Math.random() < 0.6) {
      // turret tossed off by the ammunition cook-off
      const t = v.model.turret;
      this.scene.attach(t);
      wr.turret = { obj: t, vx: (Math.random() - 0.5) * 1.5, vy: 4 + Math.random() * 2, vz: (Math.random() - 0.5) * 1.5, wx: (Math.random() - 0.5) * 8, wz: (Math.random() - 0.5) * 8, landed: false };
    }
    this.wrecks.push(wr);
  }

  /** Type-specific secondary explosions of a destroyed ground vehicle (visual only). */
  private vehicleCookOff(ud: ReturnType<typeof unitDef>, model: Model | undefined, x: number, gy: number, z: number) {
    const sec = this.secondaries;
    const wpn = ud.weapon ? WEAPONS[ud.weapon] : undefined;
    const wheeled = !!model?.wheeled;
    const h = model?.height ?? 0.5;
    if (wpn && (wpn.projectile === 'missile' || wpn.projectile === 'spawn' || (wpn.projectile === 'rocket' && !ud.turret) || wpn.warhead === 'missile')) {
      // launcher / TEL: rockets and missiles skitter away, the truck's fuel goes up
      sec.cookOff({ ammo: 2, fuel: wheeled ? 1 : 0, missiles: 2 + Math.floor(Math.random() * 3), size: 0.7, span: 2.6 }, x, gy, z, 0.6, 0.6, h * 0.8);
    } else if (wpn && wpn.projectile === 'artillery') {
      // propellant charges and shells in the rack
      sec.cookOff({ ammo: 4 + Math.floor(Math.random() * 3), fuel: wheeled ? 1 : 0, missiles: 0, size: 0.7, span: 2.8 }, x, gy, z, 0.6, 0.6, h * 0.8);
    } else if (ud.harvester || ud.mcv) {
      sec.truckFuel(x, gy, z, 1.05);
      sec.cookOff({ ammo: 2, fuel: 0, missiles: 0, size: 1, span: 2.5 }, x, gy, z, 0.8, 0.8, h * 0.7);
    } else if (wheeled) {
      if (Math.random() < 0.85) sec.truckFuel(x, gy, z, 0.7);
    } else if (ud.turret && ud.armor === 'heavy') {
      // tank ready rack: sometimes a roaring flame fountain out of the turret ring
      if (Math.random() < 0.4) {
        const dur = 1.6 + Math.random() * 1.4;
        this.schedule(0.55 + Math.random() * 0.5, () => sec.fountain(x, gy + h * 0.75, z, dur));
      } else sec.cookOff({ ammo: 3, fuel: 0, missiles: 0, size: 0.6, span: 2 }, x, gy, z, 0.4, 0.4, h * 0.8);
    } else if (Math.random() < 0.6) sec.cookOff({ ammo: 2 + Math.floor(Math.random() * 2), fuel: 0, missiles: 0, size: 0.6, span: 2 }, x, gy, z, 0.4, 0.4, h * 0.8);
  }

  /** A big cook-off sets off nearby wrecks too (visual only). */
  private chainWrecks(x: number, z: number, r: number) {
    const sec = this.secondaries;
    for (const w of this.wrecks) {
      if (w.kind !== 'vehicle' && w.kind !== 'building') continue;
      if (Math.hypot(w.x - x, w.z - z) > r + w.size || w.t > 25 || Math.random() < 0.4) continue;
      const fw = w.frac;
      const px = w.x,
        py = w.y,
        pz = w.z;
      this.schedule(0.8 + Math.random() * 3, () => {
        if (fw) {
          const p = fw.randomPiece(new THREE.Vector3());
          sec.pop(p.x, p.y + 0.1, p.z, py, 1.3);
        } else sec.pop(px, py + 0.35, pz, py, 1.2);
      });
    }
  }

  private updateWrecks(dt: number) {
    const map = this.world.map;
    this.secondaries.update(dt);
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.t += dt;
      const r = w.root;
      // battle scars: a burnt-out vehicle stays as a rusting hulk instead of sinking away (scars.ts)
      if (this.scarsOn && (w.kind === 'vehicle' || (w.kind === 'air' && w.landed)) && !w.kept && w.t > w.max - 2.5) {
        w.kept = true;
        const tt = w.turret;
        if (this.scars.adoptHulk(tt ? [r, tt.obj] : [r], w.x, w.y, w.z, w.size, w.kind === 'vehicle')) {
          this.scene.remove(r);
          if (tt) this.scene.remove(tt.obj);
          this.wrecks.splice(i, 1);
          continue;
        }
      }
      // ...and a destroyed building leaves its ruin, rising as the collapse rubble settles into it
      if (this.scarsOn && w.ruin && w.t > w.max - (w.frac ? 5 : 3)) {
        w.ruin = false;
        this.scars.ruin(w.x, w.z, w.w, w.d, { root: r, rise: w.frac ? 4 : 2.5, flat: w.flatRuin });
      }
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
        this.effects.wreckTrail(w.x, w.y, w.z, w.vx, w.vy, w.vz, dt, 1);
        const g = standHeight(map, Math.max(0, Math.min(map.w - 0.01, w.x)), Math.max(0, Math.min(map.h - 0.01, w.z)));
        if (w.y <= g + 0.1) {
          w.landed = true;
          w.y = g + 0.05;
          w.t = 0;
          w.max = 18;
          r.position.y = w.y;
          r.rotation.x = (Math.random() - 0.5) * 0.4;
          this.effects.airCrash(w.x, g, w.z, w.size);
        }
      } else if (w.kind === 'building' && w.frac) {
        // chunks topple, bounce and pile up (fracture.ts); the rubble then sinks away slowly
        w.frac.update(dt, map, this.effects, this.visibleAt(w.x, w.z));
        if (w.t > w.max - 5) w.frac.group.position.y -= dt * 0.12;
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
          this.effects.column(w.x + (Math.random() - 0.5) * w.w * 0.8, w.y + 0.2, w.z + (Math.random() - 0.5) * w.d * 0.8, 1.4);
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
        if (w.t < 22 && Math.random() < dt * 7) this.effects.column(w.x, w.y + 0.4, w.z, (w.t < 9 ? 1.1 : 0.8) * w.size);
        if (w.t < 9) this.effects.burnGlow(w.x, w.y + 0.3, w.z, 2.6 * w.size * Math.min(1, (9 - w.t) / 3));
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
        if (w.frac) this.fracture.release(w.frac);
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

  private seenIds = new Set<number>();
  private seenProj = new Set<number>();
  private projPos = new THREE.Vector3();
  private projVel = new THREE.Vector3();
  private projLook = new THREE.Vector3();
  private syncProjectiles(alpha: number) {
    const seen = this.seenProj;
    seen.clear();
    const pos = this.projPos;
    const vel = this.projVel;
    for (const p of this.world.projectiles) {
      seen.add(p.id);
      let v = this.projVis.get(p.id);
      if (!v) {
        const obj = p.flight === 'shell' ? new THREE.Group() : this.munition(p);
        // falling jet bombs get the speed streak too, so the drop reads from the RTS camera
        const streak = p.flight === 'shell' || p.flight === 'artillery' || p.flight === 'bomb' ? new THREE.Mesh(this.streakGeo, this.streakMat) : null;
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
        v.obj.lookAt(this.projLook.copy(pos).add(vel));
        v.obj.rotateY(-Math.PI / 2);
        if (p.hits > 0) {
          // damaged rounds wobble as they fly on
          const wk = Math.min(1, p.hits / Math.max(1, p.maxHp)) * 0.45;
          v.obj.rotateZ(Math.sin(this.time * 17 + p.id) * wk);
          v.obj.rotateY(Math.cos(this.time * 13 + p.id * 2) * wk);
        }
      }
      if ((p.flight === 'sam' || p.flight === 'airMissile') && p.targetId >= 0) this.effects.threaten(p.targetId);
      if (v.streak) {
        v.streak.visible = visible;
        const from = v.first ? pos.clone().addScaledVector(vel, -0.03) : v.last;
        const len = Math.max(0.05, from.distanceTo(pos) * 1.4);
        v.streak.position.copy(pos);
        v.streak.lookAt(from);
        const wdt = p.flight === 'shell' ? 0.02 : 0.03;
        v.streak.scale.set(wdt, wdt, Math.min(len, 1.2));
      }
      if (visible && !v.first && p.flight !== 'bomb') {
        const k = p.T > 0 ? p.age / p.T : 0;
        const boost =
          p.flight === 'ballistic' ? k < 0.4 : p.flight === 'hypersonic' ? k < 0.3 : p.flight === 'rocketSalvo' ? k < 0.6 : p.flight === 'artillery' || p.flight === 'mortar' || p.flight === 'shell' ? false : true;
        this.effects.trail(v.last, pos, p.flight, boost, p.age / TPS + p.id * 0.37);
        if (p.hits > 0) this.effects.damagedTrail(v.last, pos, p.hits / Math.max(1, p.maxHp));
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

  /** World position of a unit's first muzzle on its posed model (null without a visible model). */
  private sniperMuzzle(e: Entity): THREE.Vector3 | null {
    const v = this.visuals.get(e.id);
    if (!v || !v.visible || !v.model.muzzles.length) return null;
    const m = v.model.muzzles[0];
    m.updateWorldMatrix(true, false);
    return m.getWorldPosition(new THREE.Vector3());
  }

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
    if (/bomb/i.test(weaponId)) return BLASTS.bomb;
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
      case 'cruise':
        p = BLASTS.heavyMissile;
        break;
      case 'bomb':
        // a jet's 2,000 lb bomb: the big one
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
    this.ambient?.onEvent(ev);
    this.river.onEvent(ev);
    if (this.sniperFx.onEvent(ev)) return; // sniper shots: flash, faint tracer, hit puff (fx/sniperfx.ts)
    if (this.superFx.onEvent(ev)) return; // garrison window fire etc. (fx/superfx.ts)
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
            const inf = src.kind === 'unit' && unitDef(src.def).category === 'infantry';
            fx.tracer(pos, tp, !(t && t.kind === 'unit' && unitDef(t.def).air), inf ? 1 : 2, wpn.warhead === 'flak');
            const sv = inf ? undefined : this.visuals.get(src.id);
            if (sv && sv.visible) ejectCasing(fx, sv.model, dir.x, dir.z, wpn.warhead === 'flak');
            break;
          }
          case 'beam':
            fx.laser(pos, tp);
            break;
          case 'shell': {
            fx.muzzle(pos, dir, 1.3);
            const sv = this.visuals.get(src.id);
            if (sv && sv.visible) ejectCasing(fx, sv.model, dir.x, dir.z, true);
            break;
          }
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
        if (ev.kind === 'hit') {
          fx.airHit(ev.x, ev.z, ev.y, ev.maxHp ? 1 - (ev.hpLeft ?? 0) / ev.maxHp : 0.5);
          break;
        }
        const big = ev.victim === 'ballistic' || ev.victim === 'hypersonic' || (ev.kind === 'kill' && (ev.maxHp ?? 1) >= 3);
        fx.airburst(ev.x, ev.z, ev.y, ev.kind === 'kill', standHeight(this.world.map, ev.x, ev.y), big);
        break;
      }
      case 'impact': {
        if (!ev.air) this.atmos.impact(ev.x, ev.y, this.blastFor(ev.weapon, false)?.size ?? 0);
        if (!this.visibleAt(ev.x, ev.y)) break;
        const prof = this.blastFor(ev.weapon, !!ev.air);
        if (!prof) break;
        const g = standHeight(this.world.map, ev.x, ev.y);
        fx.blast(prof, ev.x, Math.max(ev.z, g + 0.05), ev.y, g);
        break;
      }
      case 'sortie': {
        // jets (sim/airbase.ts): tyre smoke at touchdown, a dust kick at the start of the take-off roll
        if (!this.visibleAt(ev.x, ev.y)) break;
        const j = this.world.get(ev.id);
        const gy = j?.sortie && j.sortie.base >= 0 ? (() => {
          const b = this.world.get(j.sortie!.base);
          return b ? this.slabHeight(b) + 0.06 : standHeight(this.world.map, ev.x, ev.y);
        })() : standHeight(this.world.map, ev.x, ev.y);
        if (ev.what === 'touchdown') {
          const dx = j ? Math.cos(j.facing) : 1;
          const dz = j ? Math.sin(j.facing) : 0;
          for (let i = 0; i < 5; i++) fx.smoke(ev.x - dx * (0.15 + i * 0.12) + (Math.random() - 0.5) * 0.12, gy, ev.y - dz * (0.15 + i * 0.12) + (Math.random() - 0.5) * 0.12, 0.45 + i * 0.05, false);
        } else if (ev.what === 'takeoff') {
          const dx = j ? Math.cos(j.facing) : 1;
          const dz = j ? Math.sin(j.facing) : 0;
          for (let i = 0; i < 3; i++) fx.dust(ev.x - dx * (0.6 + i * 0.2), gy, ev.y - dz * (0.6 + i * 0.2), 0.8);
        }
        break;
      }
      case 'promoted': {
        // veterancy: golden burst under the unit (only if the local player can see it)
        const t = this.world.get(ev.id);
        if (!t || t.inside >= 0 || !this.isShown(t.id) || !this.visibleAt(t.x, t.y)) break;
        const inf = unitDef(t.def).category === 'infantry';
        const ground = () => {
          const u = this.world.get(ev.id);
          if (!u) return null;
          const p = this.entityPos(u, 1);
          p.y = standHeight(this.world.map, p.x, p.z);
          return p;
        };
        this.overlay.promote(t.x, t.y, ground, inf ? 0.75 : 1.15);
        const p = this.entityPos(t, 1);
        for (let i = 0; i < 10; i++) fx.spark(p.x + (Math.random() - 0.5) * 0.5, p.y + 0.2 + Math.random() * 0.5, p.z + (Math.random() - 0.5) * 0.5, i % 3 ? 0xffd060 : 0xfff4c0);
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
        if (d.kind === 'building' || (unitDef(ev.def).category === 'vehicle' && !unitDef(ev.def).air)) this.atmos.impact(ev.x, ev.y, d.kind === 'building' ? 2 : 1.1);
        if (d.kind === 'building') {
          const bd = buildingDef(ev.def);
          if (shown) {
            for (let i = 0; i < Math.min(7, bd.w * bd.h); i++) {
              const ex = ev.x + (Math.random() - 0.5) * bd.w;
              const ez = ev.y + (Math.random() - 0.5) * bd.h;
              this.schedule(i * 0.16, () => fx.blast(i === 0 ? BLASTS.vehicle : BLASTS.rocket, ex, gy + 0.4, ez, gy));
            }
            this.schedule(0.45, () => fx.blast({ ...BLASTS.building, size: bd.w >= 3 ? 2.4 : 1.7 }, ev.x, gy + 0.3, ev.y, gy));
            // stored ammunition / fuel / missiles cook off for a few seconds (visual only)
            const co = Secondaries.forBuilding(bd.superweapon ? 'superweapon' : bd.role);
            if (co) {
              this.secondaries.cookOff(co, ev.x, gy, ev.y, bd.w, bd.h, Math.min(1.2, (v?.model.height ?? 1) * 0.6));
              this.chainWrecks(ev.x, ev.y, 1.2 + Math.max(bd.w, bd.h));
            }
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
            fx.airKill(pos.x, pos.y, pos.z, gy, ud.fixedWing ? 1 : 0.8);
          } else if (ud.category === 'infantry') {
            if (ev.cause !== 'crushed') fx.explosion(ev.x, gy, ev.y, 'small', 'dust'); // run over: the 'crushed' event's puff
          } else {
            fx.blast(ud.harvester || ud.mcv ? BLASTS.bigVehicle : BLASTS.vehicle, ev.x, gy + 0.25, ev.y, gy);
            // secondary ammunition cook-off
            this.schedule(0.5 + Math.random() * 0.4, () => fx.blast(BLASTS.heat, ev.x + (Math.random() - 0.5) * 0.3, gy + 0.4, ev.y + (Math.random() - 0.5) * 0.3, gy));
            this.vehicleCookOff(ud, v?.model, ev.x, gy, ev.y);
          }
        }
        if (v) {
          if (shown) this.toWreck(v, ev);
          else this.removeVisual(v);
        }
        break;
      }
      case 'crushed': {
        // run over: the hull jolts over the body, a small puff of dust and grit under the tracks
        const vv = this.visuals.get(ev.by);
        if (vv) bumpVehicle(vv.model);
        if (!this.visibleAt(ev.x, ev.y)) break;
        const gy = standHeight(this.world.map, ev.x, ev.y);
        for (let i = 0; i < 6; i++) fx.dust(ev.x, gy, ev.y, 0.9 + i * 0.12);
        this.debris.burst('dirt', ev.x, gy + 0.03, ev.y, 5, 0.9, 0.035, { up: 0.6, spread: 0.12 });
        break;
      }
      case 'unitReady': {
        // the producing building (same pick as World.deliverUnit): opens its doors / runs its lift
        const cat = unitDef(ev.def).category;
        let fac: Entity | null = null;
        for (const e of this.world.list) {
          if (e.dead || e.owner !== ev.owner || e.kind !== 'building' || buildingDef(e.def).produces !== cat) continue;
          fac = e;
          if (e.rallyX >= 0) break;
        }
        const fv = fac ? this.visuals.get(fac.id) : undefined;
        if (fv) fv.prodAt = this.time;
        break;
      }
      case 'placed':
      case 'deployed': {
        const b = this.world.get(ev.id);
        if (!b || !this.visibleAt(b.x, b.y)) break;
        if (ev.t === 'deployed' && this.startDeploy(b)) break;
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
          restoreMain(v.model.root);
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

  /** The MCV that just became yard `b` unfolds as an overlay instead of vanishing (deployfx.ts). */
  private startDeploy(b: Entity): boolean {
    for (const v of this.visuals.values()) {
      if (!v.visible || this.world.get(v.id) || DEFS[v.def]?.kind !== 'unit' || !unitDef(v.def).mcv) continue;
      const r = v.model.root;
      if (Math.hypot(r.position.x - b.x, r.position.z - b.y) > 2) continue;
      this.visuals.delete(v.id);
      if (v.ring) this.scene.remove(v.ring);
      restoreMain(r);
      this.deployFx.start(b.id, v.model, v.anim, b.x, groundHeight(this.world.map, b.x, b.y), b.y);
      return true;
    }
    return false;
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

  /**
   * Dynamic quality: watch real frame times and walk the quality ladder
   * (pixel ratio first, then AO / bloom / shadow resolution / post) down when
   * the GPU struggles and back up when there is headroom. Upgrades that get
   * undone quickly make the next upgrade attempt wait longer.
   */
  private adaptQuality() {
    const now = performance.now();
    const gap = (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    if (!this.adaptive || this.governorHold || gap <= 0 || document.hidden) return;
    // Watchdog: frames of a quarter second and more, again and again, mean the page is close to the browser's
    // "Page unresponsive" dialog. Don't wait for a full measurement window: step down two rungs right away
    // (the cheap rungs: lens extras, AO, bloom quality, then resolution; nothing gets rebuilt or recompiled).
    if (gap >= 0.25 && gap <= 5) {
      if (++this.stalls >= 3 && this.level < this.ladder.length - 1 && now - this.lastWatchdog > 2500) {
        this.lastWatchdog = now;
        this.stalls = 0;
        this.frameTimes.length = 0;
        this.goodWindows = 0;
        this.upNeed = Math.min(40, this.upNeed * 2);
        this.applyLevel(Math.min(this.ladder.length - 1, this.level + 2));
        this.fastFrames = 60;
        this.watchdogSteps++;
        return;
      }
    } else if (gap < 0.1) this.stalls = Math.max(0, this.stalls - 0.25);
    // very long gaps are tab switches / pauses, not slow frames; the median filters GC spikes
    if (gap > 1.5) return;
    const ft = gap;
    this.frameTimes.push(ft);
    // short windows while the governor is still finding its level (first seconds, right after a step down)
    if (++this.govFrames < 400) this.fastFrames = Math.max(this.fastFrames, 1);
    const win = this.fastFrames > 0 ? 12 : 30;
    if (this.frameTimes.length < win) return;
    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    this.frameTimes.length = 0;
    const med = sorted[sorted.length >> 1];
    this.lastFt = med;
    if (this.fastFrames > 0) this.fastFrames = Math.max(0, this.fastFrames - win);
    // battery saver caps at 30 fps (perf/hud.ts): judge frames against that budget instead
    const capped = perfPrefs.battery;
    // Auto quality: long stretches at the bottom (or comfortably at the top) adjust the next session's pick
    this.autoMon.sample(this.level, this.ladder.length, med, win, capped);
    const slow = capped ? 1 / 26 : 1 / 42;
    const fast = capped ? 1 / 29 : 1 / 56;
    if (med > slow && this.level < this.ladder.length - 1) {
      // undoing a recent upgrade: be more patient next time
      if (now - this.lastUpAt < 4000) this.upNeed = Math.min(40, this.upNeed * 2);
      this.goodWindows = 0;
      // far off the target (under ~22 fps): skip rungs
      const steps = med > 1 / 16 ? 3 : med > 1 / 24 ? 2 : 1;
      this.applyLevel(Math.min(this.ladder.length - 1, this.level + steps));
      this.fastFrames = 60;
    } else if (med < fast && this.level > 0) {
      if (++this.goodWindows >= this.upNeed) {
        this.goodWindows = 0;
        this.lastUpAt = now;
        this.applyLevel(this.level - 1);
      }
    } else this.goodWindows = 0;
  }
  private govFrames = 0;
  private fastFrames = 0;
  /** Watchdog: recent very long frames (decays on normal ones), last time it stepped down, steps taken. */
  private stalls = 0;
  private lastWatchdog = -1e9;
  watchdogSteps = 0;
  /** True while loading work (shader warm-up) renders frames: they are not judged. */
  governorHold = false;
  private autoMon: AutoQualityMonitor;

  render(alpha: number, dt: number) {
    this.time += dt;
    this.renderer.info.reset();
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
    this.life.update(dt, this.time);
    this.deployFx.update(dt, this.time);
    this.overlay.endFrame();
    this.updateWrecks(dt);
    this.scars.update(dt, this.renderer);
    this.atmos.update(dt, this.time, this.visuals, this.target, this.zoom, this.camera);
    this.ambient?.update(dt);
    this.syncProjectiles(alpha);
    this.terrain.update(this.time, this.world.list);
    if (Math.floor(this.time * 4) !== Math.floor((this.time - dt) * 4)) this.terrain.updateOre();
    this.bridgeFx.update(dt);
    this.superFx.update(dt, this.time);
    this.sniperFx.update(dt, alpha);
    this.effects.update(dt);
    this.river.update(dt);
    this.updateCamera();
    if (this.sky) this.atmos.driveSky(this.sky, dt, this.sunDir, !!this.photoCam);
    // cloud shadows drifting with the wind, god-ray shafts through the gaps (cloudshadow.ts)
    updateCloudShadows(dt, this.atmos, this.fog.uniforms.cloudAmount.value, this.sunDir, this.fog.uniforms.fogTarget.value.y, this.world.map, this.quality);
    this.scheduleShadow(dt);
    this.updateReadability(dt);
    const vh = this.viewHook;
    vh?.before(dt);
    // world matrices once per frame: the main view, AO, outline mask, drone feed and heat mask all reuse them
    const scene = this.scene;
    scene.updateMatrixWorld();
    this.guardLights();
    scene.matrixWorldAutoUpdate = false;
    // identical unit parts drawn as instanced batches (models on or casting into the view only)
    const roots = this.instRoots;
    roots.length = 0;
    if (this.instancer.enabled) for (const v of this.visuals.values()) if (v.visible && v.near && v.lod.kind !== 'infantry') roots.push(v.model.root);
    this.instancer.update(roots);
    try {
      if (vh?.renderMain()) {
        // the view mode drew the frame itself
      } else if (this.post && this.usePost) {
        this.updatePost(dt);
        this.post.render(dt);
      }
      else this.renderer.render(scene, this.camera);
      this.readability.renderOverlays(this.renderer, scene, this.camera);
      vh?.after(dt);
    } finally {
      scene.matrixWorldAutoUpdate = true;
    }
    this.adaptQuality();
    this.perf.frame();
    const st = this.ladder[this.level];
    this.perfHud.frame({ gl: this.renderer, level: this.level, levels: this.ladder.length, pr: st?.pr ?? 1, extra: this.instancer.enabled ? `inst-${this.instancer.saved}` : '' });
  }

  private onContextLost: (e: Event) => void;
  private onContextRestored: () => void;
  private lightList: THREE.Light[] = [];
  private lightScan = 0;
  /** Lights switched off by guardLights (debug / tests). */
  badLights = 0;
  /**
   * Hard guard: one light with a NaN / Infinity position, colour or intensity (even at intensity 0) turns
   * every lit pixel NaN, i.e. a black frame. Such a light is repaired or left out of the frame. The light
   * list is rebuilt every 60 frames; the check itself is a few float tests per light.
   */
  private guardLights() {
    if (this.lightScan-- <= 0) {
      this.lightScan = 60;
      const list = this.lightList;
      list.length = 0;
      this.scene.traverse((o) => {
        if ((o as THREE.Light).isLight) list.push(o as THREE.Light);
      });
    }
    for (const l of this.lightList) {
      const e = l.matrixWorld.elements;
      const c = l.color;
      if (Number.isFinite(e[12] + e[13] + e[14] + c.r + c.g + c.b + l.intensity)) continue;
      this.badLights++;
      if (!Number.isFinite(l.intensity)) l.intensity = 0;
      if (!Number.isFinite(c.r + c.g + c.b)) c.setRGB(1, 1, 1);
      const p = l.position;
      if (!Number.isFinite(p.x + p.y + p.z)) p.set(this.target.x, 8, this.target.z);
      l.updateMatrixWorld(true);
      // still broken (a NaN parent): leave it out of this frame
      if (!Number.isFinite(l.matrixWorld.elements[12] + l.matrixWorld.elements[13] + l.matrixWorld.elements[14])) l.visible = false;
    }
  }

  /** Static shadow caster cache (null on low / ultra). */
  readonly shadowCache: ShadowCache | null = null;
  /** The sun direction the shadow (and the key light) currently use, and its right / up axes (fitShadow). */
  private shadowDir = new THREE.Vector3(0, 0, 0);
  private shadowR = new THREE.Vector3();
  private shadowU = new THREE.Vector3();
  private shadowDirSet = NaN;
  private shadowKey = new Float64Array(9);
  private shadowAge = 0;
  /**
   * Sun shadow map refresh throttle (not ultra's cascades): re-render it whenever the
   * shadow frustum or the sun moves (panning, zoom, day cycle), otherwise every frame on
   * high and every second frame on medium (moving units' shadows trail by one frame,
   * imperceptible), and not at all while the game is paused and the view is still.
   */
  private scheduleShadow(dt: number) {
    const sh = this.sun.shadow;
    if (!this.sun.castShadow || this.csm) {
      sh.autoUpdate = true;
      return;
    }
    sh.autoUpdate = false;
    const k = this.shadowKey;
    const p = this.sun.position;
    const t = this.sun.target.position;
    const c = sh.camera;
    const moved = k[0] !== p.x || k[1] !== p.y || k[2] !== p.z || k[3] !== t.x || k[4] !== t.y || k[5] !== t.z || k[6] !== c.right || k[7] !== c.top || k[8] !== sh.mapSize.x;
    if (moved) {
      k[0] = p.x;
      k[1] = p.y;
      k[2] = p.z;
      k[3] = t.x;
      k[4] = t.y;
      k[5] = t.z;
      k[6] = c.right;
      k[7] = c.top;
      k[8] = sh.mapSize.x;
    }
    const every = this.quality === 'high' ? 1 : 2;
    this.shadowAge++;
    if (moved || !sh.map || (dt > 0 && this.shadowAge >= every) || this.shadowAge > 30) {
      sh.needsUpdate = true;
      this.shadowAge = 0;
    }
  }

  /** Icons / outlines / route arrows (after the camera so icon fades use this frame's view). */
  private updateReadability(dt: number) {
    const ppu = this.pixelsPerUnit();
    this.overlay.pxWorld = 1 / Math.max(1e-3, ppu);
    const thermal = !!(this.viewHook as { thermal?: boolean } | null)?.thermal;
    this.readability.update({ world: this.world, visuals: this.visuals, selection: this.selection, viewer: this.viewer, camera: this.camera, viewHeight: this.height, gl: this.renderer, time: this.time, thermal }, dt);
    this.overlay.routes(this.readability.routes, performance.now() / 1000);
  }

  visualHeight(id: number): number {
    return this.visuals.get(id)?.model.height ?? 0.5;
  }

  isShown(id: number) {
    return this.visuals.get(id)?.visible ?? false;
  }

  dispose() {
    this.disposed = true;
    setBakeRenderer(null);
    this.perfHud.dispose();
    this.instancer.dispose();
    this.life.dispose();
    this.deployFx.dispose();
    this.sniperFx.dispose();
    this.atmos.dispose();
    this.scars.dispose();
    this.sky?.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.readability.dispose();
    this.contact?.dispose();
    this.csm?.dispose();
    this.renderer.dispose();
    this.post?.dispose();
    this.compileRT?.dispose();
    this.shadowCache?.dispose();
    // the model caches built for this match's fog of war (fogcache.ts)
    releaseFog(this.fog);
    // release this match's GPU memory now rather than whenever the canvas gets garbage collected: without it
    // every match (and every demo battle behind the menu) left a live context behind until the next GC
    try {
      this.renderer.forceContextLoss();
    } catch {
      /* already lost */
    }
  }
}
