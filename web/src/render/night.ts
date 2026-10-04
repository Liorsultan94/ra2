import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { DEFS, unitDef } from '../sim/defs';
import { groundHeight, standHeight } from '../sim/map';
import type { World } from '../sim/world';
import type { VisualLike } from './atmos';

/*
 * Night lighting: building lamps (Model.nightLights) as additive flares and
 * light pools on the ground, brighter window glow, vehicle headlights
 * (beams + pools from the model's size, no model changes needed), slowly
 * sweeping searchlights on defences, and a small fixed pool of real point
 * lights given to the lamps nearest the view centre. Everything is instanced
 * (three draw calls) and filled per frame without allocations.
 */

const MAX_FLARES = 900;
const MAX_POOLS = 260;
const MAX_CONES = 220;
const MAX_CARS = 48;
/** Floats per queued civilian headlight: x, y, z, yaw, k, size. */
const CAR_STRIDE = 6;
/** Car body length (tiles) the civilian beam below was tuned for (the old half-scale sedan). */
export const CAR_LIGHT_REF_LEN = 0.5;
/** Civilian beam pool at CAR_LIGHT_REF_LEN: length (from the bumper) and width. */
const CAR_BEAM_LEN = 2.4;
const CAR_BEAM_WID = 1.5;
const MAX_OUTAGES = 16;

/** Stable 0..1 hash of a position (which lamps die in an outage). */
function hashXZ(x: number, z: number) {
  const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

const FLARE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vec3 c = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float s = length(instanceMatrix[0].xyz);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  // pulled towards the camera so the sprite isn't cut by the lamp's own geometry
  mv.xyz += normalize(-mv.xyz) * 0.3;
  mv.xy += position.xy * s;
  vUv = position.xy * 2.0;
  vCol = instanceColor;
  gl_Position = projectionMatrix * mv;
}`;
const FLARE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float r2 = dot(vUv, vUv);
  float a = exp(-r2 * 4.5) * 0.55 + exp(-r2 * 45.0) * 2.2;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;
const POOL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vShape;
void main() {
  vUv = uv * 2.0 - 1.0;
  vCol = instanceColor;
  // the pool lies flat (the plane has no height): its y scale picks the shape (1 round, 2 headlight beam)
  vShape = length(instanceMatrix[1].xyz);
  gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const POOL_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vShape;
void main() {
  float a;
  if (vShape > 1.5) {
    // headlight beam on the road: starts at the bumper (x = -1), widens and fades forward
    float t = vUv.x * 0.5 + 0.5;
    float w = mix(0.22, 1.0, t);
    a = (1.0 - smoothstep(w * 0.15, w, abs(vUv.y))) * smoothstep(0.0, 0.12, t) * pow(1.0 - t, 1.6) * 1.4;
  } else {
    float r = length(vUv);
    a = 1.0 - smoothstep(0.0, 1.0, r);
    a *= a;
  }
  gl_FragColor = vec4(vCol * a, 1.0);
}`;
const CONE_VERT = /* glsl */ `
varying float vT;
varying float vFace;
varying vec3 vCol;
void main() {
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(instanceMatrix) * normal);
  vec3 v = normalize(cameraPosition - wp.xyz);
  vFace = abs(dot(n, v));
  vT = position.x;
  vCol = instanceColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const CONE_FRAG = /* glsl */ `
varying float vT;
varying float vFace;
varying vec3 vCol;
void main() {
  float a = pow(1.0 - clamp(vT, 0.0, 1.0), 1.6) * pow(vFace, 1.5) * smoothstep(0.0, 0.06, vT);
  gl_FragColor = vec4(vCol * a * 0.22, 1.0);
}`;

function additive(vert: string, frag: string, double = false) {
  return new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: double ? THREE.DoubleSide : THREE.FrontSide, toneMapped: false });
}

function pool(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, name: string) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.count = 0;
  m.name = name;
  return m;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _f = new THREE.Vector3();
const _c = new THREE.Color();
const SIDES = [-1, 1];

function commit(im: THREE.InstancedMesh, n: number) {
  im.count = n;
  im.instanceMatrix.clearUpdateRanges();
  im.instanceMatrix.addUpdateRange(0, n * 16);
  im.instanceMatrix.needsUpdate = true;
  const ic = im.instanceColor!;
  ic.clearUpdateRanges();
  ic.addUpdateRange(0, n * 3);
  ic.needsUpdate = true;
}

export class NightLights {
  readonly group = new THREE.Group();
  private flares: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  private cones: THREE.InstancedMesh;
  private lights: THREE.PointLight[] = [];
  /** Candidate lamps for the real point lights this frame: x, y, z, r, g, b, distance. */
  private cand = new Float32Array(64 * 7);
  private nCand = 0;
  /** Window-glow materials and their daylight emissive intensity (the boost follows `dark`). */
  private boosted = new Map<THREE.Material, number>();
  private boostedAt = -1;
  private nf = 0;
  private np = 0;
  private nc = 0;
  /**
   * Extra lights drawn into the same instanced pools every lit frame (nightlife.ts: street lamps,
   * searchlights, campfires, fireworks glow): no extra draw calls. Called before the commit.
   */
  hook: ((n: NightLights, dark: number, time: number) => void) | null = null;
  /** Civilian headlights queued by the ambient life (x, y, z, yaw, k), drawn on the next update. */
  private cars = new Float32Array(MAX_CARS * CAR_STRIDE);
  private nCars = 0;
  /** Shelling knocks out the lamps around it for a while: x, z, radius, start, end (game-ish seconds). */
  private outages = new Float32Array(MAX_OUTAGES * 5);
  private nOut = 0;

  constructor(
    scene: THREE.Scene,
    quality: 'low' | 'medium' | 'high',
    /** 0 = daylight .. 1 = full night. */
    private dark: number,
  ) {
    this.flares = pool(new THREE.PlaneGeometry(1, 1), additive(FLARE_VERT, FLARE_FRAG), MAX_FLARES, 'night-flares');
    this.flares.renderOrder = 7;
    this.pools = pool(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(POOL_VERT, POOL_FRAG), MAX_POOLS, 'night-pools');
    (this.pools.material as THREE.ShaderMaterial).polygonOffset = true;
    (this.pools.material as THREE.ShaderMaterial).polygonOffsetFactor = -2;
    (this.pools.material as THREE.ShaderMaterial).polygonOffsetUnits = -4;
    this.pools.renderOrder = 2;
    const coneGeo = new THREE.CylinderGeometry(1, 0.03, 1, 14, 1, true).translate(0, 0.5, 0).rotateZ(-Math.PI / 2);
    this.cones = pool(coneGeo, additive(CONE_VERT, CONE_FRAG, true), MAX_CONES, 'night-cones');
    this.cones.renderOrder = 6;
    this.group.add(this.pools, this.cones, this.flares);
    const nl = quality === 'high' ? 4 : quality === 'medium' ? 2 : 0;
    for (let i = 0; i < nl; i++) {
      const l = new THREE.PointLight(0xffe0b0, 0, 4.5, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
    scene.add(this.group);
  }

  /** Undo the window-glow boost on the shared building materials (they outlive this battle). */
  dispose() {
    for (const [g, base] of this.boosted) g.userData.baseEI = base;
    this.boosted.clear();
    this.group.removeFromParent();
  }

  /**
   * Civilian car headlights (ambient life): a beam pool on the road ahead and a faint cone.
   * (x, z) = the front bumper, y = road height, yaw = heading (world, atan2(-dirZ, dirX)), k = 0..1,
   * len = the car's body length in tiles (the beam, its pool and the lamp height scale with the car;
   * CAR_LIGHT_REF_LEN = the size the pools were first tuned at).
   * Queued and drawn on the next update (a frame late: invisible at car speeds).
   */
  carLight(x: number, y: number, z: number, yaw: number, k: number, len = CAR_LIGHT_REF_LEN) {
    if (this.nCars >= MAX_CARS || !(len > 0)) return;
    const c = this.cars;
    const i = this.nCars++ * CAR_STRIDE;
    c[i] = x;
    c[i + 1] = y;
    c[i + 2] = z;
    c[i + 3] = yaw;
    c[i + 4] = k;
    c[i + 5] = len / CAR_LIGHT_REF_LEN;
  }

  /** Beam pool of a queued civilian car (tests / debug): centre offset ahead of the bumper, length, width. */
  carBeam(i: number): { ahead: number; len: number; wid: number } | null {
    if (i < 0 || i >= this.nCars) return null;
    const s = Math.sqrt(this.cars[i * CAR_STRIDE + 5]);
    return { ahead: CAR_BEAM_LEN * 0.5 * s, len: CAR_BEAM_LEN * s, wid: CAR_BEAM_WID * s };
  }

  /** Civilian headlights queued for the next update. */
  get queuedCars(): number {
    return this.nCars;
  }

  /**
   * Shelling at (x, z): building lamps within r flicker; about half of them die for `dark`
   * seconds and then stutter back on.
   */
  outage(x: number, z: number, r: number, time: number, dark: number) {
    let i = this.nOut;
    if (i >= MAX_OUTAGES) {
      // replace the one ending soonest
      i = 0;
      for (let j = 1; j < MAX_OUTAGES; j++) if (this.outages[j * 5 + 4] < this.outages[i * 5 + 4]) i = j;
    } else this.nOut++;
    const o = this.outages;
    o[i * 5] = x;
    o[i * 5 + 1] = z;
    o[i * 5 + 2] = r;
    o[i * 5 + 3] = time;
    o[i * 5 + 4] = time + dark;
  }

  /** Lamp brightness factor at (x, z) under the current outages (1 = normal, 0 = dead). */
  lampFactor(x: number, z: number, time: number): number {
    let f = 1;
    const o = this.outages;
    for (let j = 0; j < this.nOut; j++) {
      const t0 = o[j * 5 + 3];
      const t1 = o[j * 5 + 4];
      if (time > t1 + 1.5 || time < t0) continue;
      const dx = x - o[j * 5];
      const dz = z - o[j * 5 + 1];
      const r = o[j * 5 + 2];
      if (dx * dx + dz * dz > r * r) continue;
      const h = hashXZ(x, z);
      const fl = Math.sin(time * 37 + h * 90) * Math.sin(time * 11.3 + h * 40) > 0.1 ? 1 : 0.08;
      let k: number;
      if (time < t0 + 0.4 + h * 1.5) k = fl; // the blast: everything stutters
      else if (h < 0.5 && time < t1 - h * 8) k = 0; // dead for a while
      else if (h < 0.5 && time < t1 - h * 8 + 1.5) k = fl * 0.7; // coming back on
      else k = 1;
      f = Math.min(f, k);
    }
    return f;
  }

  /** 0 = daylight .. 1 = full night (this frame). */
  get darkness() {
    return this.dark;
  }

  /** Dynamic day / night cycle: 0 = daylight (everything off) .. 1 = full night. */
  setDark(dark: number) {
    this.dark = Math.max(0, Math.min(1, dark));
  }

  /** A camera-facing additive light flare (lamps, fires, beacons). */
  flare(x: number, y: number, z: number, size: number, r: number, g: number, b: number) {
    if (this.nf >= MAX_FLARES) return;
    _m.makeScale(size, size, size).setPosition(x, y, z);
    this.flares.setMatrixAt(this.nf, _m);
    this.flares.setColorAt(this.nf++, _c.setRGB(r, g, b));
  }

  /** A light pool on the ground (additive); `beam` = a headlight beam starting at the -x end. */
  pool(x: number, y: number, z: number, yaw: number, len: number, wid: number, r: number, g: number, b: number, beam = false) {
    if (this.np >= MAX_POOLS) return;
    _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    _m.compose(_p.set(x, y + 0.04, z), _q, _s.set(len, beam ? 2 : 1, wid));
    this.pools.setMatrixAt(this.np, _m);
    this.pools.setColorAt(this.np++, _c.setRGB(r, g, b));
  }

  /** A soft additive light cone from (x, y, z) along yaw / pitch (pitch < 0 = downwards). */
  cone(x: number, y: number, z: number, yaw: number, pitch: number, len: number, rad: number, r: number, g: number, b: number) {
    if (this.nc >= MAX_CONES) return;
    _e.set(0, yaw, pitch, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(len, rad, rad));
    this.cones.setMatrixAt(this.nc, _m);
    this.cones.setColorAt(this.nc++, _c.setRGB(r, g, b));
  }

  private candidate(x: number, y: number, z: number, col: THREE.Color, k: number, tx: number, tz: number) {
    const d = Math.hypot(x - tx, z - tz);
    // (a NaN lamp would light every pixel NaN: the whole frame black)
    if (!(d <= 14) || !Number.isFinite(x + y + z + col.r + col.g + col.b + k)) return;
    let i = this.nCand;
    if (i >= 64) {
      // replace the farthest
      let far = 0;
      for (let j = 1; j < 64; j++) if (this.cand[j * 7 + 6] > this.cand[far * 7 + 6]) far = j;
      if (this.cand[far * 7 + 6] <= d) return;
      i = far;
    } else this.nCand++;
    const c = this.cand;
    c[i * 7] = x;
    c[i * 7 + 1] = y;
    c[i * 7 + 2] = z;
    c[i * 7 + 3] = col.r * k;
    c[i * 7 + 4] = col.g * k;
    c[i * 7 + 5] = col.b * k;
    c[i * 7 + 6] = d;
  }

  update(_dt: number, time: number, visuals: Iterable<VisualLike>, target: THREE.Vector3, world: World) {
    this.nf = this.np = this.nc = this.nCand = 0;
    const map = world.map;
    const dk = this.dark;
    // the cycle changes `dark`: re-apply the window boost when it has moved noticeably
    if (Math.abs(dk - this.boostedAt) > 0.004) {
      this.boostedAt = dk;
      for (const [g, base] of this.boosted) g.userData.baseEI = base * (1 + 1.6 * dk);
    }
    if (dk <= 0.01) {
      // broad daylight: no lamps (pools stay allocated, the point lights keep their slots at zero). One
      // degenerate black instance per pool keeps the materials drawn, so their shaders are compiled
      // up front (warm-up) instead of hitching when the lights come on at dusk.
      _m.makeScale(0, 0, 0);
      _c.setRGB(0, 0, 0);
      for (const im of [this.flares, this.pools, this.cones]) {
        im.setMatrixAt(0, _m);
        im.setColorAt(0, _c);
        commit(im, 1);
      }
      for (const l of this.lights) l.intensity = 0;
      this.nCars = 0;
      return;
    }
    const tx = target.x;
    const tz = target.z;
    for (const v of visuals) {
      if (!v.visible) continue;
      const d = DEFS[v.def];
      if (!d) continue;
      const m = v.model;
      const root = m.root;
      if (d.kind === 'building') {
        if (v.anim.built < 1) continue;
        root.updateMatrix();
        const pw = v.anim.powered ? 1 : 0.25;
        // windows glow harder after dark (template materials: boost their base once)
        for (const g of m.glow) {
          if (this.boosted.has(g) || typeof g.userData.baseEI !== 'number') continue;
          this.boosted.set(g, g.userData.baseEI);
          g.userData.baseEI *= 1 + 1.6 * dk;
        }
        const lamps = m.nightLights;
        if (lamps) {
          let pools = 0;
          for (const L of lamps) {
            _p.copy(L.pos).applyMatrix4(root.matrix);
            _c.setHex(L.color);
            const k = L.intensity * pw * dk * (this.nOut ? this.lampFactor(_p.x, _p.z, time) : 1);
            if (k <= 0.001) continue;
            const blink = L.color === 0xff3020 ? (Math.sin(time * 3 + v.id) > 0.3 ? 1 : 0.1) : 1;
            const fk = 1.3 * blink;
            this.flare(_p.x, _p.y, _p.z, 0.1 + L.intensity * 0.18, _c.r * k * fk, _c.g * k * fk, _c.b * k * fk);
            if (L.intensity >= 0.8 && pools < 3) {
              pools++;
              const gy = groundHeight(map, Math.max(0, Math.min(map.w - 0.01, _p.x)), Math.max(0, Math.min(map.h - 0.01, _p.z)));
              const rr = 0.7 + L.intensity * 0.8;
              const pk = k * 0.13;
              this.pool(_p.x, Math.max(gy, root.position.y), _p.z, 0, rr * 2, rr * 2, _c.r * pk, _c.g * pk, _c.b * pk);
              if (L.intensity >= 0.8) this.candidate(_p.x, _p.y + 0.15, _p.z, _c, k, tx, tz);
            }
          }
        }
        // searchlights on defences: a slow sweep around the post
        if ((d as { category?: string }).category === 'defense' && v.anim.powered && v.id % 2 === 0) {
          const h = (m.height ?? 0.8) * 0.95;
          const yaw = v.id * 2.399 + Math.sin(time * 0.22 + v.id) * 1.4;
          const reach = 4.5;
          const pitch = -Math.atan2(h + 0.2, reach);
          const len = Math.hypot(h + 0.2, reach);
          const ox = root.position.x;
          const oy = root.position.y + h;
          const oz = root.position.z;
          const k = dk;
          this.cone(ox, oy, oz, yaw, pitch, len, 0.55, 0.9 * k, 0.95 * k, 1.0 * k);
          this.flare(ox, oy, oz, 0.45, 2.2 * k, 2.3 * k, 2.5 * k);
          const ex = ox + Math.cos(yaw) * reach;
          const ez = oz - Math.sin(yaw) * reach;
          const gy = standHeight(map, Math.max(0, Math.min(map.w - 0.01, ex)), Math.max(0, Math.min(map.h - 0.01, ez)));
          this.pool(ex, gy, ez, yaw, 2.2, 1.5, 0.55 * k, 0.6 * k, 0.65 * k);
        }
        continue;
      }
      if (d.kind !== 'unit') continue;
      const ud = unitDef(v.def);
      if (ud.air || ud.category !== 'vehicle') continue;
      const sz = m.size;
      const sx = sz ? sz.x : 0.8;
      const sy = sz ? sz.y : 0.4;
      const szz = sz ? sz.z : 0.5;
      root.updateMatrix();
      const k = (0.35 + 0.65 * Math.min(1, v.speed / 0.4)) * dk;
      _f.set(1, 0, 0).transformDirection(root.matrix);
      const yaw = Math.atan2(-_f.z, _f.x);
      for (const side of SIDES) {
        _p.set(sx * 0.47, Math.max(0.12, sy * 0.45), side * szz * 0.3).applyMatrix4(root.matrix);
        this.flare(_p.x, _p.y, _p.z, 0.16, 2.2 * k, 2.0 * k, 1.6 * k);
        this.cone(_p.x, _p.y, _p.z, yaw, -0.14, 2.6, 0.55, 0.9 * k, 0.82 * k, 0.62 * k);
      }
      // tail lights
      _p.set(-sx * 0.48, Math.max(0.1, sy * 0.4), 0).applyMatrix4(root.matrix);
      this.flare(_p.x, _p.y, _p.z, 0.12, 1.4 * dk, 0.08 * dk, 0.04 * dk);
      const px = root.position.x + _f.x * (sx * 0.5 + 1.45);
      const pz = root.position.z + _f.z * (sx * 0.5 + 1.45);
      const gy = standHeight(map, Math.max(0, Math.min(map.w - 0.01, px)), Math.max(0, Math.min(map.h - 0.01, pz)));
      this.pool(px, gy, pz, yaw, 2.9, 1.8, 0.36 * k, 0.33 * k, 0.25 * k, true);
    }
    // civilian headlights (queued by the ambient life)
    const cq = this.cars;
    for (let i = 0; i < this.nCars; i++) {
      const o = i * CAR_STRIDE;
      const x = cq[o];
      const y = cq[o + 1];
      const z = cq[o + 2];
      const yaw = cq[o + 3];
      const k = cq[o + 4] * dk;
      // pools grow with the car's size but slower (sqrt) and dimmer, or a queue of cars merges into one white wash
      const s = Math.sqrt(cq[o + 5]);
      const fx = Math.cos(yaw);
      const fz = -Math.sin(yaw);
      // the beam starts at the bumper
      const bl = CAR_BEAM_LEN * s;
      this.pool(x + fx * bl * 0.5, y, z + fz * bl * 0.5, yaw, bl, CAR_BEAM_WID * s, 0.2 * k, 0.185 * k, 0.14 * k, true);
      this.cone(x, y + 0.09 * s, z, yaw, -0.09, 1.9 * s, 0.38 * s, 0.2 * k, 0.19 * k, 0.15 * k);
    }
    this.nCars = 0;
    // retire finished outages
    for (let j = this.nOut - 1; j >= 0; j--) {
      if (time <= this.outages[j * 5 + 4] + 2) continue;
      this.outages.copyWithin(j * 5, (this.nOut - 1) * 5, this.nOut * 5);
      this.nOut--;
    }
    this.hook?.(this, dk, time);
    commit(this.flares, this.nf);
    commit(this.pools, this.np);
    commit(this.cones, this.nc);
    // real point lights for the lamps nearest the view centre
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      let best = -1;
      for (let j = 0; j < this.nCand; j++) if (this.cand[j * 7 + 6] >= 0 && (best < 0 || this.cand[j * 7 + 6] < this.cand[best * 7 + 6])) best = j;
      if (best < 0) {
        l.intensity = 0;
        continue;
      }
      const c = this.cand;
      l.position.set(c[best * 7], c[best * 7 + 1], c[best * 7 + 2]);
      const mx = Math.max(c[best * 7 + 3], c[best * 7 + 4], c[best * 7 + 5], 1e-3);
      l.color.setRGB(c[best * 7 + 3] / mx, c[best * 7 + 4] / mx, c[best * 7 + 5] / mx);
      l.intensity = 2.2 * mx;
      c[best * 7 + 6] = -1;
    }
    // hard guard: a light (even at intensity 0) with a NaN position or colour turns every lit pixel NaN
    for (const l of this.lights) {
      if (Number.isFinite(l.position.x + l.position.y + l.position.z + l.color.r + l.color.g + l.color.b + l.intensity)) continue;
      l.position.set(tx, 1, tz);
      l.color.setRGB(1, 1, 1);
      l.intensity = 0;
    }
  }
}

// ------------------------------------------------------------ night vision

const NV_SHADER = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec2 res;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.3, 0.59, 0.11));
      // image intensifier: strong gain on the shadows, hot whites bloom out
      l = pow(clamp(l, 0.0, 1.0), 0.55) * 1.25;
      float n = hash(floor(vUv * res * 0.5) + fract(time * 23.17) * 91.0);
      l += (n - 0.5) * 0.16;
      l *= 0.93 + 0.07 * sin(vUv.y * res.y * 1.6 + time * 8.0);
      vec2 d = vUv - 0.5;
      d.x *= res.x / max(1.0, res.y);
      float vig = smoothstep(0.78, 0.38, length(d));
      vec3 g = vec3(0.16, 1.0, 0.3) * l + vec3(0.55, 0.8, 0.55) * max(0.0, l - 0.85);
      gl_FragColor = vec4(g * vig, 1.0);
    }`,
};

/** Green monochrome image-intensifier look with noise, scanlines and a round vignette. */
export class NightVisionPass extends Pass {
  readonly uniforms = { tDiffuse: { value: null as THREE.Texture | null }, time: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } };
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;

  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: NV_SHADER.vertex, fragmentShader: NV_SHADER.fragment, depthTest: false, depthWrite: false, toneMapped: false });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(w: number, h: number) {
    this.uniforms.res.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
