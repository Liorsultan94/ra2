import * as THREE from 'three';
import { Tile, WATER_LEVEL, frameUV, groundHeight, type GameMap, type SeaDeco } from '../sim/map';
import { hash2 } from '../sim/rng';
import { LAGOON, lagoonAt, lagoonDepth } from './bluehole';
import type { FogOfWar } from './fog';
import { Kit } from './models/landmarks';
import { RIVER } from './water';

/*
 * Life in the Red Sea's clear shallows (render only: nothing here is in the sim, all placement is hashed).
 * Per corner two draw calls, both drawn after the water and coloured through it (the deeper, the more the
 * water's turquoise / blue swallows them, until they are gone):
 *  - the reef: one merged static mesh of coral heads (branching, brain, fan and table corals in several
 *    colours) in gardens on the reef flat, round the Blue Hole's rim and its islets, plus the submerged part of
 *    the wreck on the rim with algae and coral growing on its plating (its dry part is the seaside's mesh);
 *  - the fauna: one instanced mesh (a small library of fish, starfish, jellyfish, a turtle and a ray, picked
 *    per instance in the vertex shader) whose swimming, drifting, pulsing and flapping all run on the GPU off
 *    the water clock; no per-frame CPU work. Zoomed far out (sub-pixel fish) it is left out.
 * Night: lit like the water (wxLight), nothing glows.
 */

const C = (hex: number) => new THREE.Color(hex);
const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Frame point (continuous map coordinates) of a reef area's (u along the shore, v seaward). */
type FrameP = (u: number, v: number) => THREE.Vector2;

/**
 * A stretch of reef to fill (SN1: the resort beaches and the Blue Hole's lagoon each have their own straight
 * frame): its frame, its along-shore range, how far out the reef goes, the bathing beach kept clear of corals,
 * and the Blue Hole with the wreck on its rim.
 */
export interface ReefArea {
  P: FrameP;
  u0: number;
  u1: number;
  v1: number;
  beach?: [number, number];
  lagoon?: boolean;
  wreck?: Wreck;
}

/** lagoonAt away from the Blue Hole. */
const NO_LAGOON = { plat: 0, virt: 0, wall: 0, reef: 0, t: 1e3 };

const enum K {
  Fish = 0,
  Star = 1,
  Jelly = 2,
  Turtle = 3,
  Ray = 4,
}

// ------------------------------------------------------------------ the wreck

export interface Wreck {
  /** The whole wreck (world space; the seaside merges it into its landmark mesh). */
  kit: Kit;
  /** Local -> world placement. */
  base: THREE.Matrix4;
  /** Hull part of each vertex (algae grow on the plating more than on the superstructure). */
  growth: number[];
}

/**
 * A rusty coastal cargo ship run aground on the Blue Hole's rim: the bow up on the reef flat, the stern
 * sloping down into the hole's turquoise drop-off, rolled over a little, its back broken behind the hatches
 * (the after part sagging lower), plating holed and streaked with rust. No name, no markings.
 */
export function buildWreck(P: FrameP): Wreck {
  const L = LAGOON;
  const dir = (r: number) => P(L.hu + Math.cos(L.wreckA) * (L.R + r), L.hv + Math.sin(L.wreckA) * (L.R + r));
  const bow = dir(L.wreckBow);
  const stern = dir(L.wreckStern);
  const yaw = Math.atan2(bow.y - stern.y, bow.x - stern.x);
  const pitch = 0.2;
  const roll = 0.17;
  const base = new THREE.Matrix4().compose(
    new THREE.Vector3((bow.x + stern.x) / 2, WATER_LEVEL + 0.05, (bow.y + stern.y) / 2),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, -yaw, pitch, 'YZX')),
    new THREE.Vector3(1, 1, 1),
  );
  const k = new Kit();
  const growth: number[] = [];
  const grow = (g: number) => {
    while (growth.length < k.count) growth.push(g);
  };
  const D = 0.32;
  const RUST = 0x562a1a;
  const RUST_LT = 0x7a4224;
  const RUST_DK = 0x3e2018;
  const DECK = 0x5a4434;
  const HOUSE = 0x9c907c;
  const hull = (pts: [number, number][], m: THREE.Matrix4) => {
    const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: D, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2).translate(0, -D, 0);
    k.base.multiplyMatrices(base, m);
    k.add(g, null, RUST);
    grow(1);
    // the deck: a slightly inset plate in deck brown
    const dk = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x * 0.97, z * 0.9))));
    dk.rotateX(-Math.PI / 2).translate(0, 0.004, 0);
    k.add(dk, null, DECK);
    grow(0.6);
  };
  // the fore part (to the break) and the sagging after part, broken off with jagged plating
  const fore: [number, number][] = [
    [-0.05, -0.21],
    [0.7, -0.22],
    [1.02, -0.15],
    [1.25, 0],
    [1.02, 0.15],
    [0.7, 0.22],
    [-0.05, 0.21],
    [-0.12, 0.1],
    [0.0, 0.0],
    [-0.1, -0.1],
  ];
  const aft: [number, number][] = [
    [-1.22, -0.19],
    [-0.2, -0.21],
    [-0.13, -0.08],
    [-0.24, 0.02],
    [-0.15, 0.12],
    [-0.2, 0.21],
    [-1.22, 0.19],
    [-1.27, 0.1],
    [-1.27, -0.1],
  ];
  const I = new THREE.Matrix4();
  hull(fore, I);
  // the after part: hinged down at the break (the keel there), rolled a little further
  const sag = new THREE.Matrix4()
    .makeTranslation(-0.15, -D, 0)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.08, 0, -0.13, 'XYZ')))
    .multiply(new THREE.Matrix4().makeTranslation(0.15, D, 0));
  hull(aft, sag);
  // fore part: forecastle, two hatches (one cover gone, one askew), the foremast and a cargo boom
  k.base.copy(base);
  k.box(0.32, 0.08, 0.34, 1.0, 0.04, 0, RUST_LT);
  k.box(0.34, 0.05, 0.27, 0.66, 0.025, 0, 0x4a3628);
  k.box(0.3, 0.05, 0.27, 0.2, 0.025, 0, RUST_DK);
  k.box(0.26, 0.025, 0.22, 0.24, 0.07, 0.05, 0x7a4a2e, 0.35, 0.15, 0.1);
  k.beam(0.93, 0, 0, 0.93, 0.5, 0, 0.035, RUST_DK);
  k.beam(0.93, 0.08, 0, 0.5, 0.36, 0.02, 0.025, RUST);
  grow(0.4);
  // holes and rust streaks down the fore part's sides
  for (const s of [-1, 1]) {
    for (const [x, w] of [
      [0.35, 0.12],
      [0.82, 0.08],
    ])
      k.box(w, 0.09, 0.012, x, -0.13, s * 0.222, 0x120c0a);
    for (let x = -0.02; x < 0.85; x += 0.17) k.box(0.025, 0.2, 0.01, x + (s > 0 ? 0.05 : 0), -0.09, s * 0.224, RUST_LT);
  }
  grow(1);
  // the after part: the bridge house, its wheelhouse and the funnel, all sagging with the stern
  k.base.multiplyMatrices(base, sag);
  k.box(0.36, 0.3, 0.37, -0.98, 0.15, 0, HOUSE);
  k.box(0.24, 0.12, 0.42, -0.9, 0.36, 0, 0xa29480);
  k.box(0.012, 0.045, 0.32, -0.775, 0.38, 0, 0x1e2426);
  k.box(0.012, 0.05, 0.3, -0.795, 0.2, 0, 0x2a2a28);
  for (const z of [-0.12, 0, 0.12]) k.box(0.02, 0.2, 0.025, -0.795, 0.12, z, 0x8a5434);
  k.cyl(0.065, 0.058, 0.2, -1.1, 0.3, 0, 0x3a2a22, 8);
  k.cyl(0.067, 0.067, 0.04, -1.1, 0.42, 0, 0x7a3a26, 8);
  k.box(0.28, 0.05, 0.27, -0.5, 0.025, 0, RUST_DK);
  grow(0.6);
  for (const s of [-1, 1]) {
    k.box(0.14, 0.1, 0.012, -0.62, -0.15, s * 0.212, 0x120c0a);
    for (let x = -1.15; x < -0.3; x += 0.19) k.box(0.025, 0.2, 0.01, x, -0.09, s * 0.214, RUST_LT);
  }
  grow(1);
  // torn plating sticking up at the break
  k.base.copy(base);
  k.box(0.02, 0.16, 0.2, -0.14, -0.04, 0.08, RUST_DK, 0, 0.5, 0.3);
  k.box(0.02, 0.12, 0.16, -0.17, -0.1, -0.1, RUST, 0, -0.4, -0.2);
  grow(1);
  return { kit: k, base, growth };
}

// ------------------------------------------------------------------ the shader

const VERT_COMMON = /* glsl */ `
  uniform float time;
  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vCol;
  varying float vA;
  varying float vAlg;
`;

const FRAG = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec4 wState;
  uniform vec4 wState2;
  uniform vec3 wxLight;
  uniform float waterLevel;
  uniform sampler2D fogTex;
  uniform vec2 fogSize;
  uniform float fogEnabled;
  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vCol;
  varying float vA;
  varying float vAlg;
  void main() {
    // the water over it (anything above the surface is drawn by the scene's own meshes)
    float dS = waterLevel - vWorld.y;
    if (dS < 0.0) discard;
    vec3 n = normalize(vN);
    if (!gl_FrontFacing) n = -n;
    vec3 alb = vCol;
    if (vAlg > 0.0) {
      // the wreck's submerged plating: furred with algae, crusted with coral here and there
      vec3 cell = floor(vWorld * 16.0);
      float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float h2 = fract(h * 13.7 + 0.31);
      vec3 grow = h > 0.86 ? mix(vec3(0.5, 0.18, 0.3), vec3(0.62, 0.48, 0.16), h2) : vec3(0.13, 0.17, 0.06) * (0.8 + 0.5 * h2);
      alb = mix(alb, grow, vAlg * smoothstep(0.01, 0.12, dS) * (0.45 + 0.45 * h));
    }
    float ndl = max(dot(n, sunDir), 0.0);
    vec3 lit = alb * (0.5 + 0.62 * ndl);
    vec3 V = normalize(cameraPosition - vWorld);
    float path = dS / max(V.y, 0.35) + dS;
    vec3 tr = exp(-vec3(5.2, 1.9, 1.55) * path * 0.45);
    vec3 col = lit * tr + vec3(0.035, 0.36, 0.38) * (1.0 - tr) * 0.7;
    col *= wxLight * (1.0 - 0.22 * wState.x) * (1.0 - 0.3 * wState2.x);
    // the deeper, the fainter (gone a metre or so down); murky after heavy rain, dimmer in the chop
    float a = vA * exp(-path * 0.75) * 0.95 * (1.0 - 0.85 * wState.z) * (1.0 - 0.3 * wState.x);
    if (a < 0.01) discard;
    float fogV = texture2D(fogTex, vWorld.xz / fogSize).r;
    float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
    col *= mix(1.0, fogK, fogEnabled);
    col = (col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0) ? min(col, vec3(8.0)) : vec3(0.0);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The reef: static world-space geometry (corals, the wreck's submerged part); fans sway. */
const VERT_REEF = /* glsl */ `
  ${VERT_COMMON}
  attribute vec3 color;
  attribute vec4 aux; // alpha, sway, phase, growth
  void main() {
    vec3 p = position;
    p.xz += aux.y * vec2(sin(time * 1.1 + aux.z), cos(time * 0.9 + aux.z * 1.3)) * 0.035;
    vWorld = p;
    vN = normal;
    vCol = color;
    vA = aux.x;
    vAlg = aux.w;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

/**
 * The fauna: a small library of models (per vertex aux.x = which) instanced; each instance shows one of
 * them (iB.x) and swims its loop. iA: home x, z, depth y, scale; iB: kind, loop radius, angular speed,
 * phase; iC: colour, loop tilt (static ones: heading); iD: place in the school (angle, radius, height),
 * fin beat rate.
 */
const VERT_FAUNA = /* glsl */ `
  ${VERT_COMMON}
  attribute vec3 color;
  attribute vec4 aux; // kind, tint mask, alpha, -
  attribute vec4 iA;
  attribute vec4 iB;
  attribute vec4 iC;
  attribute vec4 iD;
  vec2 loopAt(float th, float R, float rot) {
    vec2 q = vec2(cos(th), sin(th) * 0.72 + 0.14 * sin(2.0 * th)) * R;
    float c = cos(rot);
    float s = sin(rot);
    return vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  }
  void main() {
    if (abs(aux.x - iB.x) > 0.5) {
      // not this instance's model: outside the clip volume (culled)
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float kind = iB.x;
    vec3 p = position;
    vec3 nrm = normal;
    float t = time;
    vec2 at = iA.xy;
    float yaw = iC.w;
    float y = iA.z + iD.z;
    if (kind != 1.0) {
      float sp = iB.z;
      float th = iB.w + iD.x + sp * t;
      float R = iB.y + iD.y;
      vec2 a = loopAt(th, R, iC.w);
      vec2 b = loopAt(th + 0.05 * sign(sp), R, iC.w);
      at += a;
      yaw = atan(b.y - a.y, b.x - a.x);
    }
    if (kind == 0.0) {
      // fish: the body flexes, the tail beats
      float bend = sin(t * iD.w + iB.w * 7.0 + iD.x * 3.0 - p.x * 4.0) * 0.16 * (1.0 - smoothstep(-0.8, 0.3, p.x));
      p.z += bend;
      y += sin(t * 0.7 + iB.w * 5.0 + iD.x) * 0.006;
    } else if (kind == 2.0) {
      // jellyfish: the bell pulses, the tentacles trail and sway; a slow bob
      float pulse = sin(t * 2.1 + iB.w * 9.0);
      if (p.y >= -0.01) {
        p.xz *= 1.0 + 0.13 * pulse;
        p.y *= 1.0 - 0.12 * pulse;
      } else {
        p.xz += vec2(sin(t * 0.9 + p.y * 3.0 + iB.w), cos(t * 0.7 + p.y * 2.0)) * 0.12 * -p.y;
      }
      y += sin(t * 0.5 + iB.w * 4.0) * 0.025;
    } else if (kind == 3.0) {
      // turtle: the flippers row
      p.y += sign(p.z) * step(0.32, abs(p.z)) * sin(t * 1.5 + iB.w + step(p.x, 0.0) * 1.2) * 0.18 * (abs(p.z) - 0.2);
    } else if (kind == 4.0) {
      // ray: a wave runs back along the wings
      p.y += sin(t * 2.2 - p.x * 3.0 + iB.w) * 0.22 * abs(p.z);
    }
    float c = cos(yaw);
    float s = sin(yaw);
    vec3 wp = vec3(at.x + (c * p.x - s * p.z) * iA.w, y + p.y * iA.w, at.y + (s * p.x + c * p.z) * iA.w);
    // the surface's ripples bend the view down to it a little
    wp.xz += vec2(sin(t * 1.3 + wp.z * 3.1), cos(t * 1.1 + wp.x * 2.7)) * 0.008;
    vWorld = wp;
    vN = vec3(c * nrm.x - s * nrm.z, nrm.y, s * nrm.x + c * nrm.z);
    vCol = mix(color, iC.rgb * color.r, aux.y);
    vA = aux.z;
    vAlg = 0.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

function reefMaterial(fog: FogOfWar, wxLight: { value: THREE.Vector3 }, vert: string) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: {
      time: RIVER.time,
      sunDir: RIVER.sunDir,
      wState: RIVER.wState,
      wState2: RIVER.wState2,
      wxLight,
      waterLevel: { value: WATER_LEVEL },
      ...fog.uniforms,
    },
    vertexShader: vert,
    fragmentShader: FRAG,
  });
  fog.upgradeShader(mat);
  return mat;
}

// ------------------------------------------------------------------ the fauna library

/** Library geometry: every model in local units (length ~1 along +X), aux.x = its kind. */
function faunaLibrary(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const aux: number[] = [];
  const add = (g: THREE.BufferGeometry, kind: number, shade: number | THREE.Color, mask: number, alpha: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    const p = ng.attributes.position;
    const n = ng.attributes.normal;
    const c = typeof shade === 'number' ? new THREE.Color(shade, shade, shade) : shade;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
      aux.push(kind, mask, alpha, 0);
    }
  };
  const tri = (a: number[], b: number[], c: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
    return g;
  };
  // fish: a lozenge body (darker back), a forked tail
  {
    const body = new THREE.OctahedronGeometry(0.5).scale(1, 0.34, 0.3).translate(0.05, 0, 0);
    add(body, K.Fish, 1, 1, 1);
    add(tri([-0.42, 0, 0], [-0.72, 0.16, 0.06], [-0.66, 0, 0]), K.Fish, 0.8, 1, 1);
    add(tri([-0.42, 0, 0], [-0.66, 0, 0], [-0.72, -0.16, -0.06]), K.Fish, 0.8, 1, 1);
    add(tri([0.0, 0.15, 0], [0.18, 0.13, 0], [-0.25, 0.22, 0]), K.Fish, 0.7, 1, 1);
  }
  // starfish: five arms, a raised middle
  {
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * Math.PI * 2;
      const a1 = ((i + 1) / 10) * Math.PI * 2;
      const r0 = i % 2 ? 0.17 : 0.5;
      const r1 = i % 2 ? 0.5 : 0.17;
      pts.push(0, 0.09, 0, Math.cos(a1) * r1, 0.015, Math.sin(a1) * r1, Math.cos(a0) * r0, 0.015, Math.sin(a0) * r0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    add(g, K.Star, 1, 1, 1);
  }
  // jellyfish: a translucent bell, trailing tentacles
  {
    const bell = new THREE.SphereGeometry(0.5, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1);
    add(bell, K.Jelly, 1, 1, 0.55);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const cx = Math.cos(a) * 0.28;
      const cz = Math.sin(a) * 0.28;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-cx, -0.02, -cz, cx, -0.02, cz, cx * 0.4, -0.95, cz * 0.4, -cx, -0.02, -cz, cx * 0.4, -0.95, cz * 0.4, -cx * 0.4, -0.95, -cz * 0.4], 3));
      add(g, K.Jelly, 1.1, 1, 0.32);
    }
  }
  // turtle: a domed shell, head and four flippers
  {
    add(new THREE.SphereGeometry(0.5, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.42, 0.78), K.Turtle, C(0x6a5a2e), 0, 1);
    add(new THREE.OctahedronGeometry(0.13).scale(1.3, 0.8, 1).translate(0.58, 0.05, 0), K.Turtle, C(0x8a8a5c), 0, 1);
    for (const s of [-1, 1]) {
      add(tri([0.22, 0.02, s * 0.3], [0.05, 0.02, s * 0.78], [-0.02, 0.02, s * 0.32]), K.Turtle, C(0x7e7e52), 0, 1);
      add(tri([-0.28, 0.02, s * 0.25], [-0.45, 0.02, s * 0.45], [-0.4, 0.02, s * 0.18]), K.Turtle, C(0x7e7e52), 0, 1);
    }
  }
  // ray: a flat diamond with a raised back, a whip tail
  {
    const top = [0.05, 0.06, 0];
    const nose = [0.45, 0, 0];
    const tail = [-0.35, 0, 0];
    for (const s of [-1, 1]) {
      const tip = [-0.02, 0, s * 0.62];
      add(s > 0 ? tri(top, nose, tip) : tri(top, tip, nose), K.Ray, 1, 1, 1);
      add(s > 0 ? tri(top, tip, tail) : tri(top, tail, tip), K.Ray, 0.85, 1, 1);
    }
    add(tri([-0.33, 0.01, 0.03], [-0.33, 0.01, -0.03], [-1.15, 0, 0]), K.Ray, 0.6, 1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aux', new THREE.Float32BufferAttribute(aux, 4));
  return g;
}

// ------------------------------------------------------------------ placement

interface Inst {
  a: [number, number, number, number];
  b: [number, number, number, number];
  c: [number, number, number, number];
  d: [number, number, number, number];
}

const FISH = [0xf2c430, 0x2f6fd8, 0xf07a2a, 0xc8d2d8, 0xf08a8a, 0x8a5ad0, 0x30b8c8].map(C);
const BIG = [0x3e7a8a, 0x4aa890, 0x7a62b8, 0x8a6250, 0x9aa8b0].map(C);
const STARS = [0xd8402a, 0xe8822a, 0x9a3aa0, 0x3a6ad0, 0xe8b040].map(C);
const JELLY = [0xf2dcec, 0xdce8f8, 0xead8f6].map(C);
const CORAL = {
  branch: [0xe07a9a, 0x5a8ad8, 0xe8c040, 0xb08a58, 0xd86a5a],
  brain: [0xb8a050, 0x8aa060, 0xc89060, 0x9a7aa0],
  fan: [0x9a3aa0, 0xd84a4a, 0xe88a3a, 0xc85a9a],
  table: [0xa89a68, 0xb08a60, 0x8a9a7a],
};

export class ReefLife {
  readonly group = new THREE.Group();
  private fauna: THREE.Mesh[] = [];
  /** The view's zoom (renderer.ts via the seaside): far out the fish are left out. */
  zoom = 2;
  private sea: SeaDeco;
  private f = { u: 0, v: 0 };

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
    wxLight: { value: THREE.Vector3 },
    areas: ReefArea[],
  ) {
    this.sea = map.deco!.sea!;
    this.group.name = 'reeflife';
    this.group.userData.perfCat = 'seaside';
    const reefMat = reefMaterial(fog, wxLight, VERT_REEF);
    const faunaMat = reefMaterial(fog, wxLight, VERT_FAUNA);
    const lib = quality === 'low' ? null : faunaLibrary();
    areas.forEach((area, b) => {
      void area.P;
      const reef = this.buildReef(area, b);
      const mesh = new THREE.Mesh(reef, reefMat);
      mesh.name = 'reef-corals';
      mesh.renderOrder = 2;
      this.group.add(mesh);
      if (!lib) return;
      const list = this.placeFauna(area, b);
      if (!list.length) return;
      const g = new THREE.InstancedBufferGeometry();
      for (const name of ['position', 'normal', 'color', 'aux']) g.setAttribute(name, lib.getAttribute(name));
      const box = new THREE.Box3();
      for (const [name, key] of [
        ['iA', 'a'],
        ['iB', 'b'],
        ['iC', 'c'],
        ['iD', 'd'],
      ] as const) {
        const arr = new Float32Array(list.length * 4);
        list.forEach((it, i) => arr.set(it[key], i * 4));
        g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, 4));
      }
      for (const it of list) {
        const r = it.b[1] + Math.abs(it.d[1]) + it.a[3] + 0.3;
        box.expandByPoint(new THREE.Vector3(it.a[0] - r, it.a[2] - 0.6, it.a[1] - r));
        box.expandByPoint(new THREE.Vector3(it.a[0] + r, WATER_LEVEL + 0.1, it.a[1] + r));
      }
      g.instanceCount = list.length;
      g.boundingBox = box;
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const fm = new THREE.Mesh(g, faunaMat);
      fm.name = 'reef-fauna';
      fm.renderOrder = 3;
      this.fauna.push(fm);
      this.group.add(fm);
    });
  }

  /** Water depth as the water shader colours it (the lagoon in), or -1 off the water. */
  private depthAt(x: number, z: number) {
    const m = this.map;
    if (x < 0.3 || z < 0.3 || x > m.w - 0.3 || z > m.h - 0.3) return -1;
    if (m.tiles[Math.floor(z) * m.w + Math.floor(x)] !== Tile.Water) return -1;
    const real = WATER_LEVEL - groundHeight(m, x, z);
    if (real < 0.03) return -1;
    if (!this.sea.hole) return real;
    const f = frameUV(this.sea.hole, x, z, this.f);
    return lagoonDepth(f.u, f.v, real);
  }

  // ---------------------------------------------------------------- corals

  private buildReef(area: ReefArea, b: number): THREE.BufferGeometry {
    const { P, wreck } = area;
    const la0 = (u: number, v: number) => (area.lagoon ? lagoonAt(u, v) : NO_LAGOON);
    const k = new Kit();
    const aux: number[] = [];
    const mark = (alpha: number, sway: number, ph: number, alg = 0) => {
      while (aux.length < k.count * 4) aux.push(alpha, sway, ph, alg);
    };
    const h = (i: number, j: number) => hash2(i, j + b * 173, 5101);
    const pick = (arr: number[], x: number) => arr[Math.floor(x * arr.length) % arr.length];
    const coral = (x: number, z: number, y: number, s: number, i: number) => {
      const r = h(i, 7);
      const yaw = h(i, 8) * 6.28;
      k.at(x, y, z, yaw, s);
      if (r < 0.34) {
        // branching (staghorn): tapered tines fanning up and out
        const c = C(pick(CORAL.branch, h(i, 9)));
        for (let j = 0; j < 6; j++) {
          const a = (j / 6) * Math.PI * 2 + h(i, 10 + j);
          const lean = 0.35 + h(i, 20 + j) * 0.5;
          const len = 0.55 + h(i, 30 + j) * 0.45;
          const g = new THREE.ConeGeometry(0.09, len, 4, 1, true).translate(0, len / 2, 0).rotateZ(-lean).rotateY(a);
          k.add(g, null, c.clone().multiplyScalar(0.85 + h(i, 40 + j) * 0.3));
        }
        mark(1, 0, 0);
      } else if (r < 0.6) {
        // brain / boulder coral: a low dome
        k.dome(0.5, 0, -0.05, 0, pick(CORAL.brain, h(i, 9)), 7, 0.7);
        mark(1, 0, 0);
      } else if (r < 0.88) {
        // sea fan (gorgonian): a broad flat fan on a short stalk, swaying
        const c = pick(CORAL.fan, h(i, 9));
        const g = new THREE.CircleGeometry(0.55, 7, 0, Math.PI).translate(0, 0.12, 0);
        k.add(g, null, c);
        mark(1, 0.6 * s, h(i, 11) * 6.28);
        k.cyl(0.03, 0.025, 0.14, 0, 0, 0, 0x6a4a3a, 4);
        mark(1, 0, 0);
      } else {
        // table coral: a flat plate on a stem
        const c = pick(CORAL.table, h(i, 9));
        k.cyl(0.07, 0.1, 0.22, 0, 0, 0, c, 5);
        k.cyl(0.55, 0.5, 0.06, 0, 0.22, 0, c, 7);
        mark(1, 0, 0);
      }
    };
    let n = 0;
    const L = LAGOON;
    // coral gardens: patchy clumps on the reef flat and the lagoon, crowding round the rim and the islets and
    // along the shore reef's crest
    for (let u = area.u0; u < area.u1; u += 0.42)
      for (let v = 0.3; v < area.v1; v += 0.42) {
        const i = Math.round(u * 10) * 1000 + Math.round(v * 10);
        const uu = u + (h(i, 1) - 0.5) * 0.4;
        const vv = v + (h(i, 2) - 0.5) * 0.4;
        const p = P(uu, vv);
        const d = this.depthAt(p.x, p.y);
        if (d < 0.02 || d > 0.36) continue;
        const la = la0(uu, vv);
        const garden = hash2(Math.floor(uu / 1.7), Math.floor(vv / 1.7), 5107 + b * 11);
        const crest = (1 - la.plat) * ss(1.6, 2.6, vv) * (1 - ss(3.4, 4.2, vv));
        const swim = area.beach && uu > area.beach[0] && uu < area.beach[1] && vv < 3.2 ? 0.35 : 1;
        let pr = (garden > 0.55 ? 0.22 : 0.03) * la.plat + la.reef * 0.55 + crest * 0.32 + (1 - ss(0.2, 1.2, Math.abs(la.t - 0.2))) * 0.25;
        pr *= swim;
        if (h(i, 3) > pr) continue;
        const s = Math.min(0.2 + h(i, 4) * 0.26, d * 2.2 + 0.12);
        coral(p.x, p.y, WATER_LEVEL - d, s, i);
        if (++n > 420) break;
      }
    // coral and algae on the wreck: the underwater copy (algae on the plating), heads along its sunken sides
    if (wreck) {
      const wk = wreck.kit;
      const at = k.count;
      k.pos.push(...wk.pos);
      k.nor.push(...wk.nor);
      k.col.push(...wk.col);
      k.glow.push(...wk.glow);
      for (let i = 0; i < k.count - at; i++) aux.push(1, 0, 0, wreck.growth[i] ?? 1);
      const v = new THREE.Vector3();
      for (let j = 0; j < 14; j++) {
        const x = -1.15 + h(900, j) * 1.3;
        const s = h(901, j) < 0.5 ? -1 : 1;
        v.set(x, -0.04 - h(902, j) * 0.18, s * 0.23).applyMatrix4(wreck.base);
        if (v.y > WATER_LEVEL - 0.05) continue;
        coral(v.x, v.z, v.y - 0.04, 0.1 + h(903, j) * 0.08, 9000 + j);
      }
    }
    void L;
    const g = k.build();
    g.deleteAttribute('aGlow');
    g.setAttribute('aux', new THREE.Float32BufferAttribute(aux, 4));
    return g;
  }

  // ---------------------------------------------------------------- fauna

  private placeFauna(area: ReefArea, b: number): Inst[] {
    const { P, wreck } = area;
    const la0 = (u: number, v: number) => (area.lagoon ? lagoonAt(u, v) : NO_LAGOON);
    const out: Inst[] = [];
    const h = (i: number, j: number) => hash2(i, j + b * 191, 5201);
    const L = LAGOON;
    const wreckAt = wreck ? new THREE.Vector3(-0.3, -0.2, 0).applyMatrix4(wreck.base) : null;
    /** Is a loop round (cx, cz) of radius R (rotated rot) all in water of depth lo..hi? */
    const loopOk = (cx: number, cz: number, R: number, rot: number, lo: number, hi: number) => {
      for (let a = 0; a < 6.28; a += 0.52) {
        const qx = Math.cos(a) * R;
        const qy = (Math.sin(a) * 0.72 + 0.14 * Math.sin(2 * a)) * R;
        const x = cx + Math.cos(rot) * qx - Math.sin(rot) * qy;
        const z = cz + Math.sin(rot) * qx + Math.cos(rot) * qy;
        const d = this.depthAt(x, z);
        if (d < lo || d > hi) return false;
      }
      return true;
    };
    // fish schools: round the hole's rim and islets, over the lagoon, in the shallows off the beach, at the wreck
    const um = (area.u0 + area.u1) / 2;
    const uw = (area.u1 - area.u0) / 2;
    const schools: [number, number][] = area.lagoon
      ? [
          [L.hu - 2.6, L.hv - 0.4],
          [L.hu + 0.7, L.hv + 2.6],
          [L.hu - 1.4, L.hv - 2.5],
          [-3.4, 4.6],
          [-2.2, 6.3],
          [1.9, 5.5],
          [-4.1, 2.2],
          [-1.0, 1.4],
          [1.4, 1.7],
        ]
      : [
          [um - uw * 0.8, 2.0],
          [um - uw * 0.45, 1.7],
          [um - uw * 0.1, 2.3],
          [um + uw * 0.3, 1.9],
          [um + uw * 0.7, 2.6],
          [um + uw * 0.15, 3.4],
        ];
    const school = (cx: number, cz: number, idx: number, fixedR?: number) => {
      const rot = h(idx, 2) * 6.28;
      let R = fixedR ?? 0.6 + h(idx, 3) * 0.6;
      while (R > 0.35 && !loopOk(cx, cz, R + 0.2, rot, 0.06, 0.6)) R -= 0.15;
      if (R <= 0.35) return;
      const d = Math.max(0.06, this.depthAt(cx, cz));
      const n = 9 + Math.floor(h(idx, 4) * 7);
      const col = FISH[Math.floor(h(idx, 5) * FISH.length)];
      const sp = (h(idx, 6) < 0.5 ? -1 : 1) * (0.32 + h(idx, 7) * 0.2) / Math.max(0.5, R);
      const y = WATER_LEVEL - Math.min(0.17, Math.max(0.05, d * 0.45));
      const ph = h(idx, 8) * 6.28;
      const sz = 0.15 + h(idx, 9) * 0.06;
      for (let j = 0; j < n; j++) {
        const c = col.clone().multiplyScalar(0.88 + h(idx * 31 + j, 10) * 0.24);
        out.push({
          a: [cx, cz, y, sz * (0.85 + h(idx * 31 + j, 11) * 0.3)],
          b: [K.Fish, R, sp, ph],
          c: [c.r, c.g, c.b, rot],
          d: [(-(j % 5) * 0.2 * Math.sign(sp) + (h(idx * 31 + j, 12) - 0.5) * 0.08) / R, (Math.floor(j / 5) - 1) * 0.17 + (h(idx * 31 + j, 13) - 0.5) * 0.08, (h(idx * 31 + j, 14) - 0.5) * 0.05, 9 + h(idx * 31 + j, 15) * 5],
        });
      }
    };
    schools.forEach(([u, v], i) => {
      const p = P(u + (h(i, 0) - 0.5) * 0.6, v + (h(i, 1) - 0.5) * 0.6);
      school(p.x, p.y, i);
    });
    if (wreckAt) {
      school(wreckAt.x, wreckAt.z, 50, 0.9);
      school(wreckAt.x, wreckAt.z, 51, 1.35);
    }
    // larger fish cruising alone over the lagoon and along the drop-offs
    for (let i = 0; i < (area.lagoon ? 9 : 4); i++) {
      const u = area.lagoon ? L.pu + (h(100 + i, 0) - 0.5) * L.pru * 1.5 : um + (h(100 + i, 0) - 0.5) * uw * 1.6;
      const v = area.lagoon ? L.pv + (h(100 + i, 1) - 0.5) * L.prv * 1.5 : 1.5 + h(100 + i, 1) * 3.5;
      const p = P(u, v);
      const rot = h(100 + i, 2) * 6.28;
      let R = 1.0 + h(100 + i, 3) * 1.2;
      while (R > 0.5 && !loopOk(p.x, p.y, R, rot, 0.08, 1.6)) R -= 0.25;
      if (R <= 0.5) continue;
      const c = BIG[Math.floor(h(100 + i, 5) * BIG.length)];
      const sp = (h(100 + i, 6) < 0.5 ? -1 : 1) * (0.16 + h(100 + i, 7) * 0.1) / R;
      out.push({ a: [p.x, p.y, WATER_LEVEL - 0.13 - h(100 + i, 8) * 0.06, 0.34 + h(100 + i, 9) * 0.14], b: [K.Fish, R, sp, h(100 + i, 10) * 6.28], c: [c.r, c.g, c.b, rot], d: [0, 0, 0, 5 + h(100 + i, 11) * 2] });
    }
    // starfish on the sand in the shallows
    let stars = 0;
    for (let i = 0; i < 400 && stars < 30; i++) {
      const u = area.u0 + h(200 + i, 0) * (area.u1 - area.u0);
      const v = 0.4 + h(200 + i, 1) * (area.v1 - 0.4);
      const p = P(u, v);
      const d = this.depthAt(p.x, p.y);
      if (d < 0.04 || d > 0.26) continue;
      const la = la0(u, v);
      if (la.reef > 0.15 || (la.plat < 0.5 && v > 3.4)) continue;
      const c = STARS[Math.floor(h(200 + i, 2) * STARS.length)];
      out.push({ a: [p.x, p.y, WATER_LEVEL - d + 0.004, 0.18 + h(200 + i, 3) * 0.08], b: [K.Star, 0, 0, 0], c: [c.r, c.g, c.b, h(200 + i, 4) * 6.28], d: [0, 0, 0, 0] });
      stars++;
    }
    // jellyfish drifting over the lagoon and out over the drop-off and the hole (fading with the depth)
    for (let i = 0; i < 12; i++) {
      const u = area.lagoon ? L.pu + (h(300 + i, 0) - 0.5) * L.pru * 1.8 : um + (h(300 + i, 0) - 0.5) * uw * 1.8;
      const v = 1.5 + h(300 + i, 1) * (area.v1 - 1.5);
      const p = P(u, v);
      const d = this.depthAt(p.x, p.y);
      if (d < 0.12) continue;
      const c = JELLY[Math.floor(h(300 + i, 2) * JELLY.length)];
      out.push({ a: [p.x, p.y, WATER_LEVEL - 0.07 - h(300 + i, 3) * 0.08, 0.18 + h(300 + i, 4) * 0.08], b: [K.Jelly, 0.25 + h(300 + i, 5) * 0.4, (h(300 + i, 6) < 0.5 ? -1 : 1) * 0.06, h(300 + i, 7) * 6.28], c: [c.r, c.g, c.b, h(300 + i, 8) * 6.28], d: [0, 0, 0, 0] });
    }
    // a turtle and two rays cruising the lagoon
    const big = (kind: K, u: number, v: number, R: number, sp: number, s: number, y: number, col: THREE.Color, idx: number) => {
      const p = P(u, v);
      const rot = h(idx, 1) * 6.28;
      while (R > 0.6 && !loopOk(p.x, p.y, R, rot, 0.1, 1.2)) R -= 0.3;
      if (R <= 0.6) return;
      out.push({ a: [p.x, p.y, y, s], b: [kind, R, sp / R, h(idx, 2) * 6.28], c: [col.r, col.g, col.b, rot], d: [0, 0, 0, 0] });
    };
    if (area.lagoon) {
      big(K.Turtle, L.hu - 3.2, L.hv + 1.0, 1.6, 0.2, 0.55, WATER_LEVEL - 0.1, C(0xffffff), 400);
      big(K.Ray, L.hu + 2.6, L.hv + 0.7, 1.5, -0.24, 0.62, WATER_LEVEL - 0.17, C(0x4a4c50), 401);
    } else big(K.Ray, um + uw * 0.4, 3.0, 1.6, 0.24, 0.55, WATER_LEVEL - 0.16, C(0x6a6458), 402 + b);
    return out;
  }

  update() {
    const near = this.zoom >= 0.95;
    for (const m of this.fauna) m.visible = near;
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
}
