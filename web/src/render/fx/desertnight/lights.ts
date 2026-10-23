import * as THREE from 'three';
import type { FogOfWar } from '../../fog';
import { FOG_GLSL } from '../../fog';
import type { DesertPlan, NightLamp, NightPost, NightWindow } from './places';

/*
 * The instanced light meshes of the desert night (NT1). All of them are static: positions are baked once from the
 * plan, and the shaders animate everything from the clock (a TV's flicker, a cooking fire, a buoy's blink, the
 * bedtime switch-off), so a lit village costs no CPU per frame and four draw calls in all:
 *   - windows: a lit pane with a faint spill, one quad per lit window;
 *   - sprites: soft camera-facing points (porch and street lamps, minaret, fires, buoys, derrick lights...);
 *   - pools: flat soft pools of light on the ground under the lamps and fires;
 *   - posts: the street lamps' poles (lit by the scene's own light, so they show by day too).
 * All of it is additive, depth-tested, hidden under the fog of war's shroud and gone by day.
 */

export interface LightUniforms {
  uNight: { value: number };
  uTime: { value: number };
  /** 0 evening .. 1 the small hours: windows go dark as the town goes to bed (nightlife.ts CITY_LATE). */
  uLate: { value: number };
}

const COMMON = /* glsl */ `
uniform float uNight;
uniform float uTime;
uniform float uLate;
float nh( float n ) { return fract( sin( n ) * 43758.5453 ); }
`;

// ------------------------------------------------------------------ windows

const WIN_VERT = /* glsl */ `
attribute vec4 aWin;   // tv, tone, shop, sleep threshold
attribute float aAlive;
varying vec2 vQ;
varying vec4 vWin;
varying vec3 vW;
varying float vFade;
uniform float uNight;
void main() {
  vQ = position.xy * 2.0;
  vWin = aWin;
  vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vW = wp.xyz;
  float d = distance( wp.xyz, cameraPosition );
  vFade = aAlive * ( 1.0 - smoothstep( 90.0, 170.0, d ) );
  gl_Position = projectionMatrix * viewMatrix * wp;
  if ( uNight < 0.01 || vFade < 0.01 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}`;

const WIN_FRAG = /* glsl */ `
${COMMON}
varying vec2 vQ;
varying vec4 vWin;
varying vec3 vW;
varying float vFade;
${FOG_GLSL}
void main() {
  // the quad is the pane grown by SPILL: the pane is |q| < 1 / SPILL, the rest a faint spill of light on the wall
  const float SPILL = 1.9;
  vec2 q = vQ;
  vec2 p = abs( q ) * SPILL;
  float pane = 1.0 - smoothstep( 0.86, 1.0, max( p.x, p.y ) );
  // a window frame: a mullion cross and a darker rim, so a lit pane reads as glass in a wall
  float bar = max( step( abs( q.x * SPILL ), 0.05 ), step( abs( q.y * SPILL + 0.12 ), 0.05 ) );
  bar *= 0.55;
  float rim = smoothstep( 0.74, 0.9, max( p.x, p.y ) );
  float spill = exp( -dot( q, q ) * 3.2 ) * 0.1;
  float isTv = vWin.x;
  float isShop = vWin.z;
  // bedtime: the lit windows go dark one by one through the night; shop fronts, the mosque and TVs stay a while
  float thr = vWin.w;
  float up = 1.0 - step( thr, uLate * 1.2 );
  up = max( up, step( 1.9, thr ) );
  float id = vWin.y * 97.0;
  vec3 warm = mix( vec3( 1.0, 0.56, 0.22 ), vec3( 1.0, 0.78, 0.46 ), vWin.y );
  vec3 col = warm;
  if ( isShop > 0.5 ) col = vec3( 1.0, 0.84, 0.62 );
  float level = 0.8 + 0.2 * nh( id );
  if ( isTv > 0.5 ) {
    // a TV's cold flicker: scene changes at irregular moments, a slow wash in between
    float t = uTime * 1.6 + id;
    float cut = nh( floor( t * 2.3 ) + id );
    float fl = 0.55 + 0.45 * sin( uTime * 9.0 + id * 3.0 ) * sin( uTime * 3.1 + id );
    col = mix( vec3( 0.34, 0.52, 1.0 ), vec3( 0.95, 0.9, 0.8 ), step( 0.7, cut ) * 0.7 );
    level = 0.45 + 0.55 * fl;
    up = 1.0;
  }
  float a = ( pane * ( 1.0 - bar ) * ( 1.0 - 0.35 * rim ) + spill ) * level;
  float vis = 1.0;
  if ( fogEnabled > 0.5 ) vis = smoothstep( 0.1, 0.45, fogSample( vW ) );
  float k = a * up * uNight * vis * vFade;
  if ( k < 0.002 ) discard;
  gl_FragColor = vec4( col * k * 1.05, 1.0 );
}`;

// ------------------------------------------------------------------ sprites

const SPR_VERT = /* glsl */ `
attribute vec4 aSpr;   // x, y, z, size
attribute vec4 aCol;   // r, g, b, mode
attribute vec4 aPh;    // phase, alive, sleep threshold, 0
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPh;
varying vec3 vW;
varying float vFade;
uniform float uNight;
void main() {
  vec4 mv = viewMatrix * vec4( aSpr.xyz, 1.0 );
  float d = length( mv.xyz );
  // pulled a little towards the camera so the sprite is not cut by the lamp's own post
  mv.xyz += normalize( -mv.xyz ) * 0.08;
  // a point never shrinks under a pixel's worth of the view: stays a soft dot far away
  mv.xy += position.xy * aSpr.w * ( 1.0 + smoothstep( 40.0, 120.0, d ) * 1.2 );
  vUv = position.xy * 2.0;
  vCol = aCol;
  vPh = aPh;
  vW = aSpr.xyz;
  vFade = aPh.y * ( 1.0 - smoothstep( 110.0, 200.0, d ) );
  gl_Position = projectionMatrix * mv;
  if ( uNight < 0.01 || vFade < 0.01 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}`;

const SPR_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPh;
varying vec3 vW;
varying float vFade;
${FOG_GLSL}
void main() {
  float r2 = dot( vUv, vUv );
  if ( r2 > 1.0 ) discard;
  // a small bright core and a soft halo: gentle, never a blown-out disc
  float a = exp( -r2 * 5.0 ) * 0.42 + exp( -r2 * 38.0 ) * 1.1;
  float mode = vCol.a;
  float ph = vPh.x;
  float lvl = 1.0;
  if ( mode > 0.5 && mode < 1.5 ) {
    // cooking fire: an irregular flicker
    lvl = 0.72 + 0.18 * sin( uTime * 11.0 + ph * 40.0 ) + 0.1 * sin( uTime * 27.0 + ph * 90.0 + sin( uTime * 5.0 ) );
  } else if ( mode > 1.5 && mode < 2.5 ) {
    // a buoy's slow blink: a short flash every ~4 s
    float t = fract( uTime / 4.0 + ph );
    lvl = 0.06 + 0.94 * smoothstep( 0.0, 0.03, t ) * ( 1.0 - smoothstep( 0.1, 0.16, t ) );
  } else if ( mode > 2.5 && mode < 3.5 ) {
    // a red mast light: a slow pulse
    lvl = 0.25 + 0.75 * pow( 0.5 + 0.5 * sin( uTime * 2.2 + ph * 6.28 ), 3.0 );
  } else if ( mode > 3.5 ) {
    lvl = 0.94 + 0.06 * sin( uTime * 50.0 + ph * 20.0 );
  }
  // lamps on a house go out when the house sleeps (street lamps stay)
  float up = 1.0 - step( vPh.z, uLate * 1.2 );
  float vis = 1.0;
  if ( fogEnabled > 0.5 ) vis = smoothstep( 0.1, 0.45, fogSample( vW ) );
  float k = a * lvl * up * uNight * vis * vFade;
  if ( k < 0.002 ) discard;
  gl_FragColor = vec4( vCol.rgb * k, 1.0 );
}`;

// ------------------------------------------------------------------ pools

const POOL_VERT = /* glsl */ `
attribute vec4 aPool;  // x, y, z, radius
attribute vec4 aCol;   // r, g, b, mode
attribute vec4 aPh;    // phase, alive, sleep threshold, 0
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPh;
varying vec3 vW;
varying float vFade;
uniform float uNight;
void main() {
  vec3 w = vec3( aPool.x + position.x * aPool.w * 2.0, aPool.y, aPool.z + position.z * aPool.w * 2.0 );
  vUv = position.xz * 2.0;
  vCol = aCol;
  vPh = aPh;
  vW = w;
  float d = distance( w, cameraPosition );
  vFade = aPh.y * ( 1.0 - smoothstep( 80.0, 150.0, d ) );
  gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
  if ( uNight < 0.01 || vFade < 0.01 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}`;

const POOL_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPh;
varying vec3 vW;
varying float vFade;
${FOG_GLSL}
void main() {
  float r = length( vUv );
  if ( r > 1.0 ) discard;
  float a = 1.0 - smoothstep( 0.0, 1.0, r );
  a *= a;
  float mode = vCol.a;
  float lvl = 1.0;
  if ( mode > 0.5 && mode < 1.5 ) lvl = 0.72 + 0.18 * sin( uTime * 11.0 + vPh.x * 40.0 ) + 0.1 * sin( uTime * 27.0 + vPh.x * 90.0 + sin( uTime * 5.0 ) );
  float up = 1.0 - step( vPh.z, uLate * 1.2 );
  float vis = 1.0;
  if ( fogEnabled > 0.5 ) vis = smoothstep( 0.1, 0.45, fogSample( vW ) );
  float k = a * lvl * up * uNight * vis * vFade;
  if ( k < 0.002 ) discard;
  gl_FragColor = vec4( vCol.rgb * k, 1.0 );
}`;

function additive(vert: string, frag: string, u: Record<string, THREE.IUniform>, poly = false) {
  const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
  if (poly) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -4;
  }
  return m;
}

function instanced(geo: THREE.BufferGeometry, n: number, mat: THREE.Material, name: string, order: number) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = geo.index;
  g.setAttribute('position', geo.getAttribute('position'));
  g.setAttribute('uv', geo.getAttribute('uv'));
  g.instanceCount = n;
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.name = name;
  return mesh;
}

/** Bedtime threshold of a house's lights: awake houses go dark between ~22:00 and ~02:00 (uLate 0..1); 2 = never. */
function sleepThreshold(h: number, never: boolean) {
  return never ? 2 : 0.3 + 1.2 * h;
}

export class DesertLights {
  readonly group = new THREE.Group();
  readonly uniforms: LightUniforms;
  private windows: THREE.InstancedMesh | null = null;
  private winAlive: THREE.InstancedBufferAttribute | null = null;
  private sprites: THREE.Mesh | null = null;
  private sprAlive: THREE.InstancedBufferAttribute | null = null;
  private poolMesh: THREE.Mesh | null = null;
  private poolAlive: THREE.InstancedBufferAttribute | null = null;
  private postMesh: THREE.InstancedMesh | null = null;
  private stackMesh: THREE.InstancedMesh | null = null;
  /** Instance ranges per house (windows, sprites, pools): to switch a damaged house's lights off. */
  private winOf: number[] = [];
  private sprOf: number[] = [];
  private poolOf: number[] = [];

  constructor(
    private fog: FogOfWar,
    plan: DesertPlan,
    hash: (a: number) => number,
  ) {
    this.group.name = 'desert-night-lights';
    const fu = fog.uniforms as unknown as Record<string, THREE.IUniform>;
    this.uniforms = { uNight: { value: 0 }, uTime: { value: 0 }, uLate: { value: 0 } };
    const U = { ...fu, ...this.uniforms } as Record<string, THREE.IUniform>;
    this.buildWindows(plan, U, hash);
    this.buildLamps(plan, U, hash);
    this.buildPosts(plan.posts);
    this.buildStacks(plan.stacks);
  }

  private buildWindows(plan: DesertPlan, U: Record<string, THREE.IUniform>, hash: (a: number) => number) {
    const list = plan.windows;
    if (!list.length) return;
    const n = list.length;
    const win = new Float32Array(n * 4);
    const alive = new Float32Array(n).fill(1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const SPILL = 1.9;
    const mat = additive(WIN_VERT, WIN_FRAG, U);
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, n);
    list.forEach((w: NightWindow, i) => {
      // the quad faces its normal (local +z), upright
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(w.nx, w.nz));
      m.compose(p.set(w.x, w.y, w.z), q, s.set(w.w * SPILL, w.h * SPILL, 1));
      mesh.setMatrixAt(i, m);
      const house = plan.houses[w.house];
      const never = w.shop === 1 || house.st.look === 'mosque';
      win[i * 4] = w.tv;
      win[i * 4 + 1] = w.tone;
      win[i * 4 + 2] = w.shop;
      win[i * 4 + 3] = sleepThreshold(hash(w.house * 131 + (i % 5)), never);
      this.winOf.push(w.house);
    });
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    mesh.name = 'desert-windows';
    mesh.geometry.setAttribute('aWin', new THREE.InstancedBufferAttribute(win, 4));
    this.winAlive = new THREE.InstancedBufferAttribute(alive, 1).setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('aAlive', this.winAlive);
    this.windows = mesh;
    this.group.add(mesh);
  }

  private buildLamps(plan: DesertPlan, U: Record<string, THREE.IUniform>, hash: (a: number) => number) {
    const list = plan.lamps;
    if (!list.length) return;
    const n = list.length;
    const spr = new Float32Array(n * 4);
    const col = new Float32Array(n * 4);
    const ph = new Float32Array(n * 4);
    const pools: NightLamp[] = [];
    list.forEach((l, i) => {
      spr.set([l.x, l.y, l.z, l.size], i * 4);
      col.set([l.r, l.g, l.b, l.mode], i * 4);
      const house = l.house >= 0 ? plan.houses[l.house] : null;
      // house lamps follow the house to bed (a porch lamp stays on longer than the windows); street lamps never
      const thr = house && house.st.look !== 'mosque' ? 0.6 + 1.4 * hash(i * 17 + 3) : 2;
      ph.set([l.phase, 1, thr, 0], i * 4);
      this.sprOf.push(l.house);
      if (l.pool > 0) pools.push(l);
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    const sm = additive(SPR_VERT, SPR_FRAG, U);
    const sMesh = instanced(geo, n, sm, 'desert-lamps', 8);
    const sg = sMesh.geometry as THREE.InstancedBufferGeometry;
    sg.setAttribute('aSpr', new THREE.InstancedBufferAttribute(spr, 4));
    sg.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 4));
    this.sprAlive = new THREE.InstancedBufferAttribute(ph, 4).setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('aPh', this.sprAlive);
    this.sprites = sMesh;
    this.group.add(sMesh);
    if (!pools.length) return;
    const pn = pools.length;
    const pp = new Float32Array(pn * 4);
    const pc = new Float32Array(pn * 4);
    const pph = new Float32Array(pn * 4);
    pools.forEach((l, i) => {
      const k = l.kind === 'fire' ? 0.3 : l.kind === 'street' ? 0.2 : 0.16;
      pp.set([l.x, l.y - (l.kind === 'street' ? 0.54 : l.kind === 'porch' ? 0.2 : 0.05) + 0.045, l.z, l.pool], i * 4);
      pc.set([l.r * k, l.g * k * 0.92, l.b * k * 0.8, l.mode], i * 4);
      const idx = list.indexOf(l);
      pph.set([l.phase, 1, this.sprAlive!.getZ(idx), 0], i * 4);
      this.poolOf.push(l.house);
    });
    const plm = additive(POOL_VERT, POOL_FRAG, U, true);
    const pMesh = instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pn, plm, 'desert-pools', 2);
    const pg = pMesh.geometry as THREE.InstancedBufferGeometry;
    pg.setAttribute('aPool', new THREE.InstancedBufferAttribute(pp, 4));
    pg.setAttribute('aCol', new THREE.InstancedBufferAttribute(pc, 4));
    this.poolAlive = new THREE.InstancedBufferAttribute(pph, 4).setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('aPh', this.poolAlive);
    this.poolMesh = pMesh;
    this.group.add(pMesh);
  }

  private buildPosts(posts: NightPost[]) {
    if (!posts.length) return;
    // a slim pole with an arm and a lamp head (about 0.54 tiles tall)
    const parts: THREE.BufferGeometry[] = [];
    const pole = new THREE.CylinderGeometry(0.012, 0.018, 0.52, 6).translate(0, 0.26, 0);
    parts.push(pole);
    parts.push(new THREE.BoxGeometry(0.07, 0.014, 0.014).translate(0.02, 0.52, 0));
    parts.push(new THREE.BoxGeometry(0.05, 0.022, 0.034).translate(0.05, 0.505, 0));
    const merged = mergeGeos(parts);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.7, metalness: 0.5 });
    this.fog.apply(mat);
    const mesh = new THREE.InstancedMesh(merged, mat, posts.length);
    const m = new THREE.Matrix4();
    posts.forEach((p, i) => {
      // the arm leans over the road: yaw picked from the position
      const yaw = Math.sin(p.x * 12.9898 + p.z * 78.233) * 3.1;
      m.makeRotationY(yaw).setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'desert-lamp-posts';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.perfCat = 'scenery';
    this.postMesh = mesh;
    this.group.add(mesh);
  }

  private buildStacks(stacks: NightPost[]) {
    if (!stacks.length) return;
    const parts: THREE.BufferGeometry[] = [];
    parts.push(new THREE.CylinderGeometry(0.014, 0.024, 0.9, 6).translate(0, 0.45, 0));
    parts.push(new THREE.CylinderGeometry(0.03, 0.02, 0.07, 6).translate(0, 0.93, 0));
    parts.push(new THREE.CylinderGeometry(0.05, 0.06, 0.03, 8).translate(0, 0.015, 0));
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.75, metalness: 0.45 });
    this.fog.apply(mat);
    const mesh = new THREE.InstancedMesh(mergeGeos(parts), mat, stacks.length);
    const m = new THREE.Matrix4();
    stacks.forEach((p, i) => mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'desert-flare-stacks';
    mesh.castShadow = false;
    mesh.userData.perfCat = 'scenery';
    this.group.add(mesh);
    this.stackMesh = mesh;
  }

  /** Lights of one house out (its roof came down) or back. */
  setHouseAlive(house: number, alive: boolean) {
    const v = alive ? 1 : 0;
    let dirty = false;
    if (this.winAlive) {
      for (let i = 0; i < this.winOf.length; i++)
        if (this.winOf[i] === house && this.winAlive.getX(i) !== v) {
          this.winAlive.setX(i, v);
          dirty = true;
        }
      if (dirty) this.winAlive.needsUpdate = true;
    }
    if (this.sprAlive) {
      let d2 = false;
      for (let i = 0; i < this.sprOf.length; i++)
        if (this.sprOf[i] === house && this.sprAlive.getY(i) !== v) {
          this.sprAlive.setY(i, v);
          d2 = true;
        }
      if (d2) this.sprAlive.needsUpdate = true;
    }
    if (this.poolAlive) {
      let d3 = false;
      for (let i = 0; i < this.poolOf.length; i++)
        if (this.poolOf[i] === house && this.poolAlive.getY(i) !== v) {
          this.poolAlive.setY(i, v);
          d3 = true;
        }
      if (d3) this.poolAlive.needsUpdate = true;
    }
  }

  /** Draw-call and instance counts (debug / tests). */
  stats() {
    return {
      windows: this.windows ? this.windows.count : 0,
      lamps: this.sprites ? (this.sprites.geometry as THREE.InstancedBufferGeometry).instanceCount : 0,
      pools: this.poolMesh ? (this.poolMesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0,
      posts: this.postMesh ? this.postMesh.count : 0,
      stacks: this.stackMesh ? this.stackMesh.count : 0,
      draws: [this.windows, this.sprites, this.poolMesh, this.postMesh, this.stackMesh].filter(Boolean).length,
    };
  }

  update(night: number, time: number, late: number) {
    this.uniforms.uNight.value = night;
    this.uniforms.uTime.value = time;
    this.uniforms.uLate.value = late;
    const on = night > 0.01;
    if (this.windows) this.windows.visible = on;
    if (this.sprites) this.sprites.visible = on;
    if (this.poolMesh) this.poolMesh.visible = on;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
  }
}

/** Merge a few indexed or non-indexed geometries with position + normal + uv into one. */
function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const g of list) {
    const base = pos.length / 3;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    const T = g.getAttribute('uv');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      uv.push(T.getX(i), T.getY(i));
    }
    const ix = g.index!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}
