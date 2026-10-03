import * as THREE from 'three';
import { Tile, standHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';
import { WX } from './wxuniforms';

/*
 * Ground decals drawn as instanced quads that fade with age: tank tread
 * prints and tyre marks (~10 s), deep ruts on soft ground (mud, sand, dirt,
 * snow; ~45 s), blast craters (~4.5 min) and burnt patches (~4 min). Each decal
 * is tilted to the terrain normal so it hugs slopes. Ruts and craters carry a
 * relief (normal) map lit by the sun, so berms and crater rims read embossed.
 */

/** Tangent-space normal map from a height field (u along x, v along rows). */
function reliefTex(n: number, height: (u: number, v: number) => number, strength: number): THREE.DataTexture {
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = height((x + 0.5) / n, (y + 0.5) / n);
  const d = new Uint8Array(n * n * 4);
  const at = (x: number, y: number) => h[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * n + x) * 4;
      d[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      d[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      d[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  const t = new THREE.DataTexture(d, n, n);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

const gauss = (x: number, w: number) => Math.exp(-(x * x) / (w * w));
const RELIEF = {
  // a pressed groove with pushed-up berms either side and track-cleat bars along it
  rut: () =>
    reliefTex(64, (u, v) => {
      const a = Math.abs(v - 0.5);
      const cleat = (u * 4) % 1 < 0.45 ? -0.18 : 0;
      return -gauss(a, 0.22) * (1 + cleat * gauss(a, 0.18)) + 0.55 * gauss(a - 0.41, 0.07);
    }, 6),
  // compressed snow trench: a deep flat-bottomed groove, high crumbly berms, sharp cleat ridges
  snowRut: () =>
    reliefTex(64, (u, v) => {
      const a = Math.abs(v - 0.5);
      const cleat = (u * 4) % 1 < 0.4 ? -0.25 : 0;
      return -Math.min(1, gauss(a, 0.3) * 1.4) * (1 + cleat * gauss(a, 0.24)) + 0.8 * gauss(a - 0.43, 0.06);
    }, 9),
  // a boot print pressed into the ground: sole and heel
  boot: () =>
    reliefTex(32, (u, v) => {
      const sole = Math.max(0, 1 - Math.hypot((u - 0.36) / 0.27, (v - 0.5) / 0.36));
      const heel = Math.max(0, 1 - Math.hypot((u - 0.8) / 0.13, (v - 0.5) / 0.3));
      return -Math.min(1, (sole + heel) * 2.5);
    }, 5),
  // bowl with a raised rim
  crater: () =>
    reliefTex(128, (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5);
      const bowl = r < 0.4 ? -(1 - (r / 0.4) * (r / 0.4)) : 0;
      return bowl + 0.45 * gauss(r - 0.42, 0.07);
    }, 14),
};

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const TEX = {
  tread: () =>
    canvasTex(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      // track plates: transverse bars with gaps
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = 'rgba(30,24,16,0.85)';
        ctx.fillRect(i * 16 + 2, 4, 9, s - 8);
        ctx.fillStyle = 'rgba(30,24,16,0.35)';
        ctx.fillRect(i * 16 + 11, 10, 4, s - 20);
      }
    }),
  tire: () =>
    canvasTex(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, 'rgba(30,24,16,0)');
      g.addColorStop(0.25, 'rgba(30,24,16,0.65)');
      g.addColorStop(0.75, 'rgba(30,24,16,0.65)');
      g.addColorStop(1, 'rgba(30,24,16,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let i = 0; i < 8; i++) ctx.fillRect(i * 8, 18, 3, s - 36);
    }),
  rut: () =>
    canvasTex(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      // dark wet groove, lighter churned berms
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, 'rgba(70,58,42,0)');
      g.addColorStop(0.1, 'rgba(78,64,46,0.45)');
      g.addColorStop(0.25, 'rgba(34,26,18,0.75)');
      g.addColorStop(0.5, 'rgba(22,17,12,0.9)');
      g.addColorStop(0.75, 'rgba(34,26,18,0.75)');
      g.addColorStop(0.9, 'rgba(78,64,46,0.45)');
      g.addColorStop(1, 'rgba(70,58,42,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = 'rgba(10,8,5,0.35)';
      for (let i = 0; i < 4; i++) ctx.fillRect(i * 16 + 2, 18, 7, s - 36);
    }),
  snowRut: () =>
    canvasTex(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      // packed blue-grey trench, bright churned berms, darker cleat imprints
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, 'rgba(236,242,250,0)');
      g.addColorStop(0.08, 'rgba(240,245,252,0.6)');
      g.addColorStop(0.2, 'rgba(150,164,186,0.75)');
      g.addColorStop(0.5, 'rgba(112,126,150,0.9)');
      g.addColorStop(0.8, 'rgba(150,164,186,0.75)');
      g.addColorStop(0.92, 'rgba(240,245,252,0.6)');
      g.addColorStop(1, 'rgba(236,242,250,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = 'rgba(70,82,104,0.4)';
      for (let i = 0; i < 4; i++) ctx.fillRect(i * 16 + 2, 16, 6, s - 32);
    }),
  boot: (r: number, g: number, b: number, a: number) =>
    canvasTex(32, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.beginPath();
      ctx.ellipse(s * 0.36, s * 0.5, s * 0.25, s * 0.33, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s * 0.8, s * 0.5, s * 0.11, s * 0.27, 0, 0, Math.PI * 2);
      ctx.fill();
    }),
  // muzzle blast: grass blown flat in radial streaks (pale undersides), or snow blown off the ground
  blastFan: (light: boolean) =>
    canvasTex(128, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      for (let i = 0; i < 160; i++) {
        const a = Math.random() * Math.PI * 2;
        const r0 = c * (0.05 + Math.random() * 0.2);
        const r1 = c * (0.35 + Math.random() * 0.6);
        ctx.strokeStyle = light ? `rgba(${170 + Math.random() * 40},${170 + Math.random() * 30},${100 + Math.random() * 30},${0.08 + Math.random() * 0.14})` : `rgba(${70 + Math.random() * 20},${64 + Math.random() * 16},${56},${0.08 + Math.random() * 0.16})`;
        ctx.lineWidth = 0.8 + Math.random() * 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.5);
      g.addColorStop(0, light ? 'rgba(150,150,90,0.3)' : 'rgba(60,56,50,0.55)');
      g.addColorStop(1, 'rgba(60,56,50,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }),
  crater: () =>
    canvasTex(128, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      // ejecta streaks
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * Math.PI * 2;
        const r0 = c * 0.45;
        const r1 = c * (0.6 + Math.random() * 0.4);
        ctx.strokeStyle = `rgba(${40 + Math.random() * 30},${32 + Math.random() * 20},${22},${0.25 + Math.random() * 0.3})`;
        ctx.lineWidth = 1 + Math.random() * 3;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.stroke();
      }
      // raised rim (lit) and dark bowl
      let g = ctx.createRadialGradient(c, c, c * 0.2, c, c, c * 0.62);
      g.addColorStop(0, 'rgba(18,14,10,0.95)');
      g.addColorStop(0.55, 'rgba(38,30,22,0.9)');
      g.addColorStop(0.8, 'rgba(120,100,76,0.55)');
      g.addColorStop(1, 'rgba(90,72,52,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.62, 0, Math.PI * 2);
      ctx.fill();
      g = ctx.createRadialGradient(c - c * 0.08, c - c * 0.1, 0, c, c, c * 0.35);
      g.addColorStop(0, 'rgba(8,6,4,0.9)');
      g.addColorStop(1, 'rgba(8,6,4,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.35, 0, Math.PI * 2);
      ctx.fill();
      // scattered clods
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = c * (0.5 + Math.random() * 0.45);
        ctx.fillStyle = `rgba(50,40,28,${0.5 + Math.random() * 0.4})`;
        ctx.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 2 + Math.random() * 3, 2 + Math.random() * 3);
      }
    }),
  scorch: () =>
    canvasTex(128, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      for (let i = 0; i < 6; i++) {
        const ox = c + (Math.random() - 0.5) * c * 0.5;
        const oy = c + (Math.random() - 0.5) * c * 0.5;
        const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, c * (0.5 + Math.random() * 0.4));
        g.addColorStop(0, 'rgba(10,8,6,0.75)');
        g.addColorStop(0.6, 'rgba(20,16,12,0.35)');
        g.addColorStop(1, 'rgba(20,16,12,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
    }),
};

/** Sun direction (towards the sun, world space), shared by every relief decal. */
const SUN = { value: new THREE.Vector3(-0.7, 0.6, 0.15).normalize() };
/** Sun strength relative to daylight (0 at night .. 1): scales the relief highlights. */
const SUN_K = { value: 1 };

class DecalLayer {
  readonly mesh: THREE.InstancedMesh;
  private birth: Float32Array;
  private attr: THREE.InstancedBufferAttribute;
  private next = 0;
  private used = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private n = new THREE.Vector3();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3();
  readonly uniforms: { time: { value: number } };

  constructor(
    tex: THREE.Texture,
    private max: number,
    life: number,
    opacity: number,
    fog: FogOfWar,
    order: number,
    relief: THREE.Texture | null = null,
    snowTint = false,
    /** Rain: 1 = prints on hard ground go darker (the tyres squeeze the water film off), 2 = ruts fill with water. */
    wet = 0,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.birth = new Float32Array(max).fill(-1e6);
    this.attr = new THREE.InstancedBufferAttribute(this.birth, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBirth', this.attr);
    this.uniforms = { time: { value: 0 } };
    const defines: Record<string, number> = {};
    if (relief) defines.RELIEF = 1;
    if (snowTint) defines.SNOW_TINT = 1;
    defines.WET = wet;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2 - order,
      polygonOffsetUnits: -2,
      defines,
      uniforms: { map: { value: tex }, relief: { value: relief }, uSun: SUN, uSunK: SUN_K, wxSnow: WX.wxSnow, wxWet: WX.wxWet, wxGloss: WX.wxGloss, time: this.uniforms.time, life: { value: life }, opacity: { value: opacity }, ...fog.uniforms },
      vertexShader: /* glsl */ `
        attribute float aBirth;
        varying vec2 vUv;
        varying float vAge;
        varying vec2 vW;
        varying vec3 vT;
        varying vec3 vB;
        varying vec3 vN;
        uniform float time;
        void main() {
          vUv = uv;
          vAge = time - aBirth;
          mat3 m = mat3( modelMatrix * instanceMatrix );
          vT = normalize( m * vec3( 1.0, 0.0, 0.0 ) );
          vB = normalize( m * vec3( 0.0, 0.0, -1.0 ) );
          vN = normalize( m * vec3( 0.0, 1.0, 0.0 ) );
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform sampler2D relief;
        uniform vec3 uSun;
        uniform float uSunK;
        uniform float wxSnow;
        uniform float wxWet;
        uniform float wxGloss;
        uniform vec3 hazeColor;
        uniform float life;
        uniform float opacity;
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec2 vUv;
        varying float vAge;
        varying vec2 vW;
        varying vec3 vT;
        varying vec3 vB;
        varying vec3 vN;
        void main() {
          float k = clamp(vAge / life, 0.0, 1.0);
          float fade = 1.0 - smoothstep(0.6, 1.0, k);
          vec4 t = texture2D(map, vUv);
          #ifdef SNOW_TINT
          // ruts in snow: blue-grey shadowed troughs instead of brown mud
          t.rgb = mix( t.rgb, vec3( 0.32, 0.36, 0.44 ) * ( 0.6 + t.rgb * 2.0 ), wxSnow );
          #endif
          float fogV = texture2D(fogTex, vW / fogSize).r;
          float f = mix(1.0, smoothstep(0.2, 0.6, fogV), fogEnabled);
          float ta = t.a * opacity;
          vec3 rgb = t.rgb;
          #ifdef RELIEF
          // embossed relief: light / shade relative to the flat ground, composited over the albedo
          vec3 nm = texture2D( relief, vUv ).xyz * 2.0 - 1.0;
          vec3 n = normalize( vT * nm.x + vB * nm.y + vN * nm.z );
          float e = ( dot( n, uSun ) - dot( vN, uSun ) ) * 1.6;
          float w = clamp( abs( e ), 0.0, 0.5 ) * ( e > 0.0 ? uSunK : 0.4 + 0.6 * uSunK );
          vec3 target = e > 0.0 ? mix( vec3( 0.2, 0.16, 0.11 ), vec3( 0.6, 0.64, 0.7 ), wxSnow ) : vec3( 0.004, 0.003, 0.002 );
          float ao = 1.0 - ( 1.0 - w ) * ( 1.0 - ta );
          rgb = ( target * w + ( 1.0 - w ) * ta * t.rgb ) / max( ao, 1e-3 );
          ta = ao * smoothstep( 0.0, 0.08, t.a + w * 0.2 );
          #endif
          #if WET == 1
          // wet road: the tyres wipe the water film off, the prints read darker and stay visible longer
          rgb *= 1.0 - 0.45 * wxWet;
          ta = min(1.0, ta * (1.0 + 0.8 * wxWet));
          fade = mix(fade, 1.0 - smoothstep(0.8, 1.0, k), wxWet);
          #elif WET == 2
          // wet soft ground: the rut darkens and water stands in its bottom, catching the sky
          rgb *= 1.0 - 0.35 * wxWet;
          if ( wxGloss > 0.5 && wxWet > 0.2 ) {
            float pool = smoothstep( 0.2, 0.05, abs( vUv.y - 0.5 ) ) * smoothstep( 0.2, 0.7, wxWet ) * ta;
            vec3 sky = hazeColor / ( 1.0 + max( hazeColor.r, max( hazeColor.g, hazeColor.b ) ) );
            rgb = mix( rgb, vec3( 0.02, 0.022, 0.026 ) + sky * 0.55, pool * 0.75 );
            ta = max( ta, pool * 0.85 );
          }
          #endif
          gl_FragColor = vec4(rgb, ta * fade * f);
          if (gl_FragColor.a < 0.004) discard;
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1 + order;
    this.mesh.count = 0;
    this.mesh.visible = false; // no draw call until the first decal
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  add(map: GameMap, x: number, z: number, angle: number, length: number, width: number, time: number, lift = 0.012) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.used = Math.min(this.max, this.used + 1);
    const cx = Math.max(0, Math.min(map.w - 0.01, x));
    const cz = Math.max(0, Math.min(map.h - 0.01, z));
    const e = 0.3;
    const hx = standHeight(map, Math.min(map.w - 0.01, cx + e), cz) - standHeight(map, Math.max(0, cx - e), cz);
    const hz = standHeight(map, cx, Math.min(map.h - 0.01, cz + e)) - standHeight(map, cx, Math.max(0, cz - e));
    this.n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
    this.q.setFromUnitVectors(this.up, this.n);
    this.q2.setFromAxisAngle(this.up, -angle);
    this.q.multiply(this.q2);
    this.m4.compose(this.p.set(x, standHeight(map, cx, cz) + lift, z), this.q, this.sc.set(length, 1, width));
    this.mesh.setMatrixAt(i, this.m4);
    this.birth[i] = time;
    this.mesh.count = this.used;
    this.mesh.visible = true;
    // upload only the touched instance
    this.mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.addUpdateRange(i, 1);
    this.attr.needsUpdate = true;
  }
}

export class GroundMarks {
  readonly group = new THREE.Group();
  private tread: DecalLayer;
  private tire: DecalLayer;
  private rut: DecalLayer;
  private crater: DecalLayer;
  private scorch: DecalLayer;
  /** Snow: deep packed trenches under tracks / tyres, boot prints; mud / sand: faint prints. */
  private snowRut: DecalLayer;
  private footSnow: DecalLayer;
  private footSoft: DecalLayer;
  /** Muzzle blast: grass blown flat (springs back in seconds) / snow blown off the ground. */
  private flat: DecalLayer;
  private blown: DecalLayer;
  /** Tiles under paved roads (the sim marks roads as dirt): no ruts there. */
  private paved: Uint8Array;
  private layers: DecalLayer[];
  time = 0;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
  ) {
    this.tread = new DecalLayer(TEX.tread(), 5000, 10, 0.55, fog, 0, null, false, 1);
    this.tire = new DecalLayer(TEX.tire(), 3000, 10, 0.45, fog, 0, null, false, 1);
    // soft ground keeps deep ruts much longer
    this.rut = new DecalLayer(TEX.rut(), 9000, 45, 0.8, fog, 0, RELIEF.rut(), true, 2);
    // battle damage persists: burnt patches ~4 min, craters ~4.5 min
    this.scorch = new DecalLayer(TEX.scorch(), 600, 240, 0.9, fog, 1);
    this.crater = new DecalLayer(TEX.crater(), 600, 270, 1, fog, 2, RELIEF.crater());
    // snow keeps every print for minutes
    this.snowRut = new DecalLayer(TEX.snowRut(), 7000, 150, 0.9, fog, 0, RELIEF.snowRut());
    const boot = RELIEF.boot();
    this.footSnow = new DecalLayer(TEX.boot(96, 112, 140, 0.8), 4000, 120, 0.85, fog, 0, boot);
    this.footSoft = new DecalLayer(TEX.boot(42, 32, 22, 0.7), 2500, 30, 0.4, fog, 0, boot);
    this.flat = new DecalLayer(TEX.blastFan(true), 120, 9, 0.8, fog, 0);
    this.blown = new DecalLayer(TEX.blastFan(false), 160, 100, 0.75, fog, 0);
    this.layers = [this.tread, this.tire, this.rut, this.snowRut, this.footSnow, this.footSoft, this.flat, this.blown, this.scorch, this.crater];
    for (const l of this.layers) this.group.add(l.mesh);
    this.paved = new Uint8Array(map.w * map.h);
    for (const r of map.roads ?? [])
      for (let k = 0; k < r.length - 1; k++) {
        const ax = r[k].x + 0.5;
        const az = r[k].y + 0.5;
        const bx = r[k + 1].x + 0.5;
        const bz = r[k + 1].y + 0.5;
        const dx = bx - ax;
        const dz = bz - az;
        const L2 = Math.max(1e-6, dx * dx + dz * dz);
        for (let y = Math.max(0, Math.floor(Math.min(az, bz) - 2)); y <= Math.min(map.h - 1, Math.ceil(Math.max(az, bz) + 2)); y++)
          for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - 2)); x <= Math.min(map.w - 1, Math.ceil(Math.max(ax, bx) + 2)); x++) {
            const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - az) * dz) / L2));
            if (Math.hypot(x + 0.5 - ax - dx * t, y + 0.5 - az - dz * t) < 1.2) this.paved[y * map.w + x] = 1;
          }
      }
  }

  /** Soft ground that takes deep ruts: dirt and sand always, grass when wet, anything but rock in snow. */
  private soft(x: number, z: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return false;
    if (this.paved[tz * m.w + tx]) return false;
    const t = m.tiles[tz * m.w + tx];
    if (t === Tile.Dirt || t === Tile.Sand) return true;
    if (t === Tile.Grass) return WX.wxWet.value > 0.25 || WX.wxSnow.value > 0;
    return false;
  }

  /** Paved road under (x, z) (the sim marks roads as dirt). */
  isPaved(x: number, z: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    return tx >= 0 && tz >= 0 && tx < m.w && tz < m.h && this.paved[tz * m.w + tx] === 1;
  }

  private tileAt(x: number, z: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return Tile.Rock;
    return m.tiles[tz * m.w + tx];
  }

  /** Track or tyre print segment under one track (a deep rut on soft ground, a packed trench in snow). */
  print(x: number, z: number, angle: number, len: number, width: number, wheeled: boolean) {
    if (WX.wxSnow.value > 0.3) {
      const t = this.tileAt(x, z);
      if (t !== Tile.Water && t !== Tile.Bridge) {
        this.snowRut.add(this.map, x, z, angle, len, width * (wheeled ? 1.6 : 1.9), this.time, 0.015);
        return;
      }
    }
    if (this.soft(x, z)) this.rut.add(this.map, x, z, angle, len, width * (wheeled ? 1.5 : 1.8), this.time, 0.014);
    else (wheeled ? this.tire : this.tread).add(this.map, x, z, angle, len, width, this.time);
  }

  /**
   * One boot print of a walking soldier (side = -1 left / +1 right foot):
   * deep in snow, faint in mud (rain) and dry sand / dirt, none on grass, rock or roads.
   */
  footstep(x: number, z: number, angle: number, side: number) {
    const t = this.tileAt(x, z);
    if (t === Tile.Water || t === Tile.Bridge) return;
    const ox = -Math.sin(angle) * 0.022 * side;
    const oz = Math.cos(angle) * 0.022 * side;
    if (WX.wxSnow.value > 0.3) {
      this.footSnow.add(this.map, x + ox, z + oz, angle, 0.075, 0.04, this.time, 0.016);
      return;
    }
    if (t === Tile.Rock || this.isPaved(x, z)) return;
    if (t === Tile.Grass && !(WX.wxWet.value > 0.3)) return;
    this.footSoft.add(this.map, x + ox, z + oz, angle, 0.07, 0.036, this.time, 0.015);
  }

  /** Muzzle blast pressure on the ground: grass blown flat in radial streaks, or snow blown off. */
  blastAt(x: number, z: number, r: number) {
    const t = this.tileAt(x, z);
    if (t === Tile.Water || t === Tile.Bridge) return;
    if (WX.wxSnow.value > 0.3) this.blown.add(this.map, x, z, Math.random() * 6.28, r * 2, r * 2, this.time, 0.013);
    else if (t === Tile.Grass) this.flat.add(this.map, x, z, Math.random() * 6.28, r * 2, r * 2, this.time, 0.013);
  }

  craterAt(x: number, z: number, r: number) {
    this.crater.add(this.map, x, z, Math.random() * 6.28, r * 2, r * 2, this.time, 0.02);
  }

  scorchAt(x: number, z: number, r: number) {
    this.scorch.add(this.map, x, z, Math.random() * 6.28, r * 2, r * 2, this.time, 0.016);
  }

  /** Sun direction (towards the sun) for the relief decals. */
  setSun(dir: THREE.Vector3, strength = 1) {
    SUN.value.copy(dir);
    SUN_K.value = Math.max(0, Math.min(1, strength));
  }

  update(dt: number) {
    this.time += dt;
    for (const l of this.layers) l.uniforms.time.value = this.time;
  }
}
