import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { surfaceHeight } from '../ground';
import { CELLS, CELL_COUNT, SIGN_KINDS, SignKind, type Sign } from './signplan';
import { cellUvs, signAtlas } from './signart';
import type { RoadNet } from './roadnet';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from './shared';

/*
 * The Sinai's roadside signs, drawn: one instanced mesh per shape (ten shapes, each frame and both faces merged into
 * one geometry), one material, one small atlas (signart.ts). A sign's size class, shape, height, lean, facing,
 * weathering (sun fade, sand blasting, peeling paint, rust), frame palette and designs come from the plan
 * (signplan.ts); the shader does the weathering from a per-instance amount. Hidden at far zoom and under the fog
 * of war, culled to the view a few times a second, the big boards lit by their lamps at night. At most one draw call
 * per shape in view.
 */

const FAR = 62;
const FIXED = 3;

/** Frame / post palettes (multiplied into the frame's grey): steel, rust, bottle green, whitewash, faded blue, ochre. */
const FRAME_TINTS: [number, number, number][] = [
  [0.9, 0.92, 0.95],
  [0.72, 0.42, 0.28],
  [0.3, 0.5, 0.42],
  [1.0, 0.96, 0.86],
  [0.38, 0.5, 0.74],
  [0.86, 0.66, 0.34],
];

class Parts {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  side: number[] = [];
  add(g: THREE.BufferGeometry, shade: number, side: number, rgb?: [number, number, number]) {
    const ng = g.index ? g.toNonIndexed() : g;
    const n = ng.attributes.position.count;
    const p = ng.attributes.position.array as Float32Array;
    const nn = ng.attributes.normal.array as Float32Array;
    const u = ng.attributes.uv.array as Float32Array;
    for (let i = 0; i < n; i++) {
      this.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.nor.push(nn[i * 3], nn[i * 3 + 1], nn[i * 3 + 2]);
      this.uv.push(u[i * 2], u[i * 2 + 1]);
      if (rgb) this.col.push(rgb[0], rgb[1], rgb[2]);
      else this.col.push(shade, shade, shade);
      this.side.push(side);
    }
  }
  /** A box (w along x, h up, d along z) centred at (x, y + h / 2, z): frame / post (tinted by the palette). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, shade = 1) {
    this.add(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), shade, 0);
  }
  /** Hardware of fixed colour (lamps, catwalks). */
  hw(w: number, h: number, d: number, x: number, y: number, z: number, hex: number) {
    const c = new THREE.Color(hex);
    this.add(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), 1, FIXED, [c.r, c.g, c.b]);
  }
  /** A face (w wide along z, h high) at x, centred on height y: front (+x) or back (-x). */
  face(w: number, h: number, x: number, y: number, front: boolean) {
    const g = new THREE.PlaneGeometry(w, h).rotateY(front ? Math.PI / 2 : -Math.PI / 2).translate(x, y, 0);
    this.add(g, 1, front ? 1 : 2);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(this.side, 1));
    return g;
  }
}

const KIND_NAMES = ['board', 'big', 'pole', 'square', 'stack', 'wall', 'shop', 'round', 'tri', 'arrow'];

/** Lamp positions (local x, y, z) of a shape, for the night flares. */
const LAMPS: Partial<Record<SignKind, [number, number, number][]>> = {};

/** Model of each shape: the origin is on the ground at the board's centre line, facing +x. */
function model(kind: SignKind): THREE.BufferGeometry {
  const P = new Parts();
  const lamp = (x: number, y: number, z: number, arm = 0.14) => {
    P.hw(arm, 0.012, 0.012, x + arm / 2 - 0.02, y, z, 0x6b6f74);
    P.hw(0.05, 0.025, 0.06, x + arm - 0.02, y - 0.01, z, 0x30343a);
    (LAMPS[kind] ??= []).push([x + arm - 0.02, y + 0.015, z]);
  };
  switch (kind) {
    case SignKind.Board: {
      const W = 1.0;
      const H = 0.5;
      const Y = 0.66;
      P.box(0.05, Y + 0.25, 0.05, -0.04, -0.25, -0.38);
      P.box(0.05, Y + 0.25, 0.05, -0.04, -0.25, 0.38);
      P.box(0.03, H + 0.05, W + 0.05, 0, Y - H / 2 - 0.025, 0, 0.78);
      P.face(W, H, 0.017, Y, true);
      P.face(W, H, -0.017, Y, false);
      P.hw(0.1, 0.012, W, 0.07, Y - H / 2 - 0.03, 0, 0x6b6f74);
      lamp(0, Y + H / 2 + 0.04, -0.25);
      lamp(0, Y + H / 2 + 0.04, 0.25);
      break;
    }
    case SignKind.Big: {
      const W = 2.0;
      const H = 0.8;
      const Y = 1.34;
      P.box(0.1, Y + 0.25, 0.1, -0.06, -0.25, -0.8);
      P.box(0.1, Y + 0.25, 0.1, -0.06, -0.25, 0.8);
      P.box(0.05, H + 0.08, W + 0.08, 0, Y - H / 2 - 0.04, 0, 0.74);
      P.face(W, H, 0.027, Y, true);
      P.face(W, H, -0.027, Y, false);
      // catwalk under the board, a rail, a ladder up one post
      P.hw(0.26, 0.02, W, 0.14, Y - H / 2 - 0.06, 0, 0x7a7e84);
      P.hw(0.012, 0.09, W, 0.27, Y - H / 2 - 0.04, 0, 0x7a7e84);
      P.hw(0.012, Y + 0.1, 0.012, 0.0, -0.1, 0.86, 0x7a7e84);
      P.hw(0.012, Y + 0.1, 0.012, 0.0, -0.1, 0.92, 0x7a7e84);
      for (const z of [-0.62, 0, 0.62]) lamp(0, Y + H / 2 + 0.07, z, 0.26);
      break;
    }
    case SignKind.Pole: {
      const W = 0.4;
      const H = 0.62;
      const Y = 1.36;
      P.box(0.07, Y + H / 2 + 0.3, 0.07, -0.06, -0.25, 0);
      P.box(0.025, H + 0.04, W + 0.04, -0.005, Y - H / 2 - 0.02, 0, 0.8);
      P.face(W, H, 0.009, Y, true);
      P.face(W, H, -0.019, Y, false);
      P.box(0.07, 0.03, 0.18, -0.03, Y - H / 2 - 0.035, 0, 0.9);
      lamp(0, Y + H / 2 + 0.04, 0, 0.12);
      break;
    }
    case SignKind.Square: {
      const S = 0.44;
      const Y = 0.62;
      P.box(0.05, Y + 0.25, 0.05, -0.045, -0.25, 0);
      P.box(0.025, S + 0.04, S + 0.04, 0, Y - S / 2 - 0.02, 0, 0.8);
      P.face(S, S, 0.014, Y, true);
      P.face(S, S, -0.014, Y, false);
      break;
    }
    case SignKind.Stack: {
      const W = 0.84;
      const H = 0.34;
      for (const Y of [1.04, 0.62]) {
        P.box(0.03, H + 0.04, W + 0.04, 0, Y - H / 2 - 0.02, 0, 0.78);
        P.face(W, H, 0.017, Y, true);
        P.face(W, H, -0.017, Y, false);
      }
      P.box(0.05, 1.04 + H / 2 + 0.25, 0.05, -0.04, -0.25, -0.36);
      P.box(0.05, 1.04 + H / 2 + 0.25, 0.05, -0.04, -0.25, 0.36);
      lamp(0, 1.04 + H / 2 + 0.04, -0.2);
      lamp(0, 1.04 + H / 2 + 0.04, 0.2);
      break;
    }
    case SignKind.Wall: {
      P.box(0.17, 0.56, 1.6, 0, 0, 0, 0.92);
      P.box(0.22, 0.05, 1.68, 0, 0.56, 0, 1);
      P.box(0.23, 0.64, 0.14, 0, 0, -0.82, 1);
      P.box(0.23, 0.64, 0.14, 0, 0, 0.82, 1);
      P.face(1.26, 0.4, 0.087, 0.3, true);
      P.face(1.26, 0.4, -0.087, 0.3, false);
      break;
    }
    case SignKind.Shop: {
      const W = 0.5;
      const H = 0.26;
      const Y = 0.4;
      P.box(0.035, Y + 0.2, 0.035, -0.03, -0.2, -0.2);
      P.box(0.035, Y + 0.2, 0.035, -0.03, -0.2, 0.2);
      P.box(0.022, H + 0.03, W + 0.03, 0, Y - H / 2 - 0.015, 0, 0.7);
      P.face(W, H, 0.012, Y, true);
      P.face(W, H, -0.012, Y, false);
      break;
    }
    case SignKind.Round: {
      const D = 0.28;
      const Y = 0.66;
      P.box(0.03, Y + 0.25, 0.03, -0.025, -0.25, 0, 0.9);
      P.face(D, D, 0.004, Y, true);
      P.face(D, D, -0.016, Y, false);
      break;
    }
    case SignKind.Tri: {
      const D = 0.32;
      const Y = 0.64;
      P.box(0.03, Y + 0.25, 0.03, -0.025, -0.25, 0, 0.9);
      P.face(D, D, 0.004, Y, true);
      P.face(D, D, -0.016, Y, false);
      break;
    }
    case SignKind.Arrow: {
      const W = 0.7;
      const H = 0.35;
      const Y = 0.68;
      P.box(0.035, Y + 0.25, 0.035, -0.025, -0.25, 0.22, 0.9);
      P.face(W, H, 0.004, Y, true);
      P.face(W, H, -0.016, Y, false);
      break;
    }
  }
  return P.geometry();
}

interface Inst {
  s: Sign;
  h: number;
  /** World matrix pieces. */
  scale: number;
}

class Bank {
  readonly mesh: THREE.InstancedMesh;
  readonly a: THREE.InstancedBufferAttribute;
  readonly b: THREE.InstancedBufferAttribute;
  vis: number[] = [];
  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly items: Inst[],
    name: string,
    shadow: boolean,
  ) {
    const n = Math.max(1, items.length);
    geo.setAttribute('aA', (this.a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)));
    geo.setAttribute('aB', (this.b = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)));
    this.a.setUsage(THREE.DynamicDrawUsage);
    this.b.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = shadow;
    m.count = 0;
    m.visible = false;
    m.name = name;
    this.mesh = m;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _ax = new THREE.Vector3(1, 0, 0);
const _az = new THREE.Vector3(0, 0, 1);

export class Signs {
  readonly group = new THREE.Group();
  private banks: Bank[] = [];
  private mat: THREE.MeshStandardMaterial | null = null;
  private refreshT = 0;
  private hidden = false;

  constructor(
    map: GameMap,
    net: RoadNet,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
  ) {
    this.group.name = 'roadside-signs';
    if (quality === 'low' || !net.signs.length) return;
    const atlas = signAtlas(quality === 'high' ? 1 : 0.5);
    if (!atlas) return;
    const shadow = quality === 'high';
    const tex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const uvs = cellUvs();
    const uCells = { value: Array.from({ length: CELL_COUNT }, (_, i) => new THREE.Vector4(uvs[i * 4], uvs[i * 4 + 1], uvs[i * 4 + 2], uvs[i * 4 + 3])) };
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, roughness: 0.6, metalness: 0.05 });
    mat.defines = { WHITE_CELL: CELLS.white };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uCells = uCells;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec4 aA;\nattribute vec4 aB;\nattribute float aSide;\nuniform vec4 uCells[${CELL_COUNT}];\nvarying vec4 vA;\nvarying vec4 vB;\nvarying float vSide;\nvarying vec2 vFace;`)
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          {
            int ci = WHITE_CELL;
            if ( aSide > 0.5 && aSide < 1.5 ) ci = int( aA.x + 0.5 );
            else if ( aSide > 1.5 && aSide < 2.5 ) ci = int( aA.y + 0.5 );
            vec4 cr = uCells[ ci ];
            #ifdef USE_MAP
              vMapUv = cr.xy + uv * cr.zw;
            #endif
            vA = aA;
            vB = aB;
            vSide = aSide;
            vFace = uv;
          }`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec4 vA;
          varying vec4 vB;
          varying float vSide;
          varying vec2 vFace;
          float h21( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }`,
        )
        .replace(
          '#include <map_fragment>',
          `vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          bool isFace = vSide > 0.5 && vSide < 2.5;
          float wear = vA.z;
          float wseed = vA.w;
          if ( isFace ) {
            if ( sampledDiffuseColor.a < 0.5 ) discard;
            vec3 col = sampledDiffuseColor.rgb;
            float lum = dot( col, vec3( 0.3, 0.59, 0.11 ) );
            // sun fade: colour drains to a warm grey
            col = mix( col, vec3( lum ) * vec3( 1.1, 1.0, 0.82 ) + 0.07, wear * 0.55 );
            // sand blasting: fine speckles of bare board; peeling: patches of primer
            float fine = h21( floor( vFace * vec2( 120.0, 60.0 ) ) + wseed );
            float coarse = h21( floor( vFace * vec2( 9.0, 5.0 ) ) + wseed * 1.7 );
            float grain = h21( floor( vFace * 40.0 ) + wseed * 0.3 );
            col = mix( col, vec3( 0.8, 0.72, 0.58 ), step( 1.0 - wear * 0.28, fine ) * 0.75 );
            float peel = smoothstep( 1.0 - wear * 0.42, 1.0 - wear * 0.42 + 0.06, coarse * ( 0.7 + 0.3 * grain ) ) * step( 0.35, wear );
            col = mix( col, vec3( 0.86, 0.84, 0.78 ), peel * 0.8 );
            sampledDiffuseColor.rgb = col;
          }
          diffuseColor *= sampledDiffuseColor;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if ( vSide < 0.5 ) {
            // the frame: the palette, and rust where it has stood a while
            float rn = h21( floor( vFace * 14.0 ) + wseed );
            float rust = clamp( ( rn - 0.55 ) * 2.2, 0.0, 1.0 ) * wear;
            diffuseColor.rgb = mix( diffuseColor.rgb * vB.rgb, vec3( 0.42, 0.2, 0.09 ), rust * 0.85 );
          }`,
        )
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n          totalEmissiveRadiance *= isFace ? sampledDiffuseColor.rgb * vB.w : vec3( 0.0 );`);
    };
    fog.apply(mat);
    mat.customProgramCacheKey = () => 'fog2-signs';
    this.mat = mat;

    const gh = (x: number, y: number) => surfaceHeight(map, x, y);
    const byKind: Inst[][] = Array.from({ length: SIGN_KINDS }, () => []);
    for (const s of net.signs) byKind[s.kind].push({ s, h: gh(s.x, s.y), scale: s.scale });
    byKind.forEach((items, kind) => {
      if (!items.length) return;
      const b = new Bank(model(kind), mat, items, 'sign-' + KIND_NAMES[kind], shadow);
      this.banks.push(b);
      this.group.add(b.mesh);
    });
  }

  private refresh(f: AmbientFrame) {
    const vis = (it: Inst) => it.s.x > f.vx0 && it.s.x < f.vx1 && it.s.y > f.vy0 && it.s.y < f.vy1 && this.probe.visible(it.s.x, it.s.y);
    for (const b of this.banks) {
      let n = 0;
      b.vis.length = 0;
      b.items.forEach((it, i) => {
        if (!vis(it)) return;
        const s = it.s;
        _q.setFromAxisAngle(_up, -s.yaw);
        _qr.setFromAxisAngle(_ax, s.roll);
        _qp.setFromAxisAngle(_az, s.pitch);
        _q.multiply(_qr).multiply(_qp);
        _m.compose(_p.set(s.x, it.h + s.lift, s.y), _q, _s.set(it.scale, it.scale, it.scale));
        b.mesh.setMatrixAt(n, _m);
        const t = FRAME_TINTS[s.pal % FRAME_TINTS.length];
        b.a.setXYZW(n, s.front, s.back, s.wear, (s.seed % 997) / 7);
        b.b.setXYZW(n, t[0], t[1], t[2], s.kind >= SignKind.Round ? 0.3 : s.kind === SignKind.Shop || s.kind === SignKind.Wall ? 0 : s.lamp ? 1 : 0.55);
        b.vis.push(i);
        n++;
      });
      b.mesh.count = n;
      b.mesh.visible = n > 0;
      if (n) {
        b.mesh.instanceMatrix.clearUpdateRanges();
        b.mesh.instanceMatrix.addUpdateRange(0, n * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        for (const at of [b.a, b.b]) {
          at.clearUpdateRanges();
          at.addUpdateRange(0, n * 4);
          at.needsUpdate = true;
        }
      }
    }
  }

  draw(f: AmbientFrame) {
    if (!this.banks.length) return;
    if (f.vx1 - f.vx0 > FAR) {
      if (!this.hidden) for (const b of this.banks) b.mesh.visible = false;
      this.hidden = true;
      return;
    }
    this.refreshT -= f.dt;
    if (this.hidden || this.refreshT <= 0) {
      this.refreshT = 0.3;
      this.refresh(f);
      this.hidden = false;
    }
    const dk = f.dark;
    // adverts glow at night, the lit boards' lamps shine on them
    if (this.mat) this.mat.emissiveIntensity = dk * 0.85;
    if (dk > 0.1) {
      for (const b of this.banks) {
        const kind = b.items[0]?.s.kind;
        const lamps = LAMPS[kind as SignKind];
        if (!lamps) continue;
        for (const i of b.vis) {
          const it = b.items[i];
          const s = it.s;
          if (!s.lamp) continue;
          const c = Math.cos(s.yaw);
          const sn = Math.sin(s.yaw);
          for (const [lx, ly, lz] of lamps) {
            const x = s.x + (lx * c - lz * sn) * it.scale;
            const y = s.y + (lx * sn + lz * c) * it.scale;
            this.lights.flare(x, it.h + s.lift + ly * it.scale, y, 0.1 * it.scale, 1.6 * dk, 1.5 * dk, 1.2 * dk);
          }
        }
      }
    }
  }
}
