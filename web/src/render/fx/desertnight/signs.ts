import * as THREE from 'three';
import type { FogOfWar } from '../../fog';
import { FOG_GLSL } from '../../fog';
import type { SeaNightSpot } from '../../seaside';
import { lightBlend, type LightUniforms } from './lights';

/*
 * The resorts' lit name boards (NT1). Fictional names only (no real brands, no real hotel chains): one board on
 * two posts by the sea edge of each resort's deck (day: a painted board, night: its letters glow, softly), and a
 * smaller one at each beach bar. The lettering is painted into one small canvas atlas; the glow is one instanced
 * additive quad per board. 2 draw calls in all.
 */

export const RESORT_NAMES = ['CORAL BAY RESORT', 'PEARL OASIS HOTEL', 'BLUE LAGOON BEACH', 'PALM HAVEN INN', 'SUNSET BAY HOTEL'];
export const BAR_NAMES = ['SUNSET BAR', 'REEF CAFE', 'SHELL BAR', 'TIDE BAR'];

export interface Sign {
  x: number;
  y: number;
  z: number;
  /** World yaw of the board's front (+z of the quad). */
  face: number;
  /** Width in tiles; the height is a fifth of it. */
  w: number;
  /** Row of the atlas. */
  row: number;
  /** Letter colour. */
  c: [number, number, number];
}

const ROWS = RESORT_NAMES.length + BAR_NAMES.length;
const ATLAS_W = 512;
const ATLAS_H = 64;

/** The signs of the resorts: a name board per resort and one per beach bar. */
export function planSigns(spots: readonly SeaNightSpot[]): Sign[] {
  const out: Sign[] = [];
  const LETTER: [number, number, number][] = [
    [1.0, 0.82, 0.5],
    [0.55, 0.9, 1.0],
    [1.0, 0.6, 0.55],
    [0.7, 1.0, 0.7],
    [1.0, 0.9, 0.6],
  ];
  for (const s of spots) {
    if (s.kind === 'sign') {
      const i = s.site % RESORT_NAMES.length;
      out.push({ x: s.x, y: s.y + 0.3, z: s.z, face: Math.atan2(Math.sin(s.yaw), -Math.cos(s.yaw)), w: 0.9, row: i, c: LETTER[i % LETTER.length] });
    } else if (s.kind === 'bar') {
      const i = s.site % BAR_NAMES.length;
      // by the bar, on the sea side of its thatch
      const nx = Math.sin(s.yaw);
      const nz = -Math.cos(s.yaw);
      out.push({ x: s.x + nx * 0.62, y: s.y + 0.2, z: s.z + nz * 0.62, face: Math.atan2(nx, nz), w: 0.5, row: RESORT_NAMES.length + i, c: LETTER[(i + 2) % LETTER.length] });
    }
  }
  return out;
}

function atlasTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = ATLAS_W;
  c.height = ATLAS_H * ROWS;
  const g = c.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, c.width, c.height);
  const names = [...RESORT_NAMES, ...BAR_NAMES];
  names.forEach((n, i) => {
    const y = i * ATLAS_H;
    // the board: a dark panel with a thin border, the letters in white (tinted at draw time)
    g.fillStyle = 'rgba(255,255,255,0.0)';
    g.fillRect(0, y, ATLAS_W, ATLAS_H);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 3;
    g.strokeRect(5, y + 5, ATLAS_W - 10, ATLAS_H - 10);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 34;
    g.font = `bold ${size}px "Trebuchet MS", Verdana, sans-serif`;
    while (g.measureText(n).width > ATLAS_W - 40 && size > 14) {
      size -= 2;
      g.font = `bold ${size}px "Trebuchet MS", Verdana, sans-serif`;
    }
    g.fillText(n, ATLAS_W / 2, y + ATLAS_H / 2 + 2);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  return t;
}

const VERT = /* glsl */ `
attribute vec4 aSig;   // row, r, g, b
varying vec2 vUv;
varying vec4 vSig;
varying vec3 vW;
varying float vFace;
uniform float uNight;
void main() {
  vUv = uv;
  vSig = aSig;
  vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vW = wp.xyz;
  vec3 n = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
  vFace = dot( n, normalize( cameraPosition - wp.xyz ) );
  gl_Position = projectionMatrix * viewMatrix * wp;
  if ( uNight < 0.01 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uNight;
uniform float uTime;
varying vec2 vUv;
varying vec4 vSig;
varying vec3 vW;
varying float vFace;
${FOG_GLSL}
void main() {
  float rows = ${ROWS}.0;
  vec2 uv = vec2( vFace >= 0.0 ? vUv.x : 1.0 - vUv.x, ( rows - 1.0 - vSig.x + vUv.y ) / rows );
  vec4 t = texture2D( uAtlas, uv );
  float a = t.a;
  // a faint soft halo round the letters (the atlas' mips carry it)
  float halo = texture2D( uAtlas, uv, 3.0 ).a * 0.35;
  float buzz = 0.96 + 0.04 * sin( uTime * 53.0 + vSig.x * 7.0 );
  float vis = 1.0;
  if ( fogEnabled > 0.5 ) vis = smoothstep( 0.1, 0.45, fogSample( vW ) );
  float k = ( a * 0.85 + halo ) * buzz * uNight * vis;
  if ( k < 0.003 ) discard;
  gl_FragColor = vec4( vSig.yzw * k, 1.0 );
}`;

/** The glow quads and the boards with their posts. */
export class SignBoards {
  readonly group = new THREE.Group();
  private glow: THREE.InstancedMesh | null = null;
  private atlas: THREE.Texture | null = null;
  private u: Record<string, THREE.IUniform>;

  constructor(
    fog: FogOfWar,
    signs: readonly Sign[],
    uniforms: LightUniforms,
  ) {
    this.group.name = 'desert-signs';
    this.u = { ...(fog.uniforms as unknown as Record<string, THREE.IUniform>), ...uniforms, uAtlas: { value: null } } as Record<string, THREE.IUniform>;
    if (!signs.length) return;
    const n = signs.length;
    // the boards and their posts (always there: by day a dark painted board; the letters glow only at night)
    const parts: THREE.BufferGeometry[] = [];
    parts.push(new THREE.BoxGeometry(1, 0.22, 0.03).translate(0, 0.0, -0.001));
    for (const sx of [-0.4, 0.4]) parts.push(new THREE.CylinderGeometry(0.012, 0.014, 0.34, 6).translate(sx, -0.28, -0.01));
    const board = mergeBoard(parts);
    const bmat = new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: 0.7, metalness: 0.2 });
    fog.apply(bmat);
    const boards = new THREE.InstancedMesh(board, bmat, n);
    boards.name = 'desert-sign-boards';
    boards.castShadow = false;
    boards.userData.perfCat = 'seaside';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const aSig = new Float32Array(n * 4);
    signs.forEach((s, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.face);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, sc.set(s.w, s.w, s.w));
      boards.setMatrixAt(i, m);
      aSig.set([s.row, s.c[0], s.c[1], s.c[2]], i * 4);
    });
    this.group.add(boards);
    // the lettering (night)
    const tex = (this.atlas = atlasTexture());
    if (!tex) return;
    this.u.uAtlas.value = tex;
    const mat = lightBlend(new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    const geo = new THREE.PlaneGeometry(0.96, 0.18);
    const glow = new THREE.InstancedMesh(geo, mat, n);
    signs.forEach((s, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.face);
      // a hair in front of the board, on both faces (the shader mirrors the text on the back)
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, sc.set(s.w, s.w, s.w));
      glow.setMatrixAt(i, m);
    });
    glow.geometry.setAttribute('aSig', new THREE.InstancedBufferAttribute(aSig, 4));
    glow.frustumCulled = false;
    glow.renderOrder = 7;
    glow.name = 'desert-sign-glow';
    this.glow = glow;
    this.group.add(glow);
  }

  update(night: number) {
    if (this.glow) this.glow.visible = night > 0.01;
  }

  stats() {
    return { signs: this.glow?.count ?? 0 };
  }

  dispose() {
    this.group.removeFromParent();
    this.atlas?.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
  }
}

function mergeBoard(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const g of list) {
    const base = pos.length / 3;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
    }
    for (let i = 0; i < g.index!.count; i++) idx.push(base + g.index!.getX(i));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
