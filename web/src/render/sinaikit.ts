import * as THREE from 'three';
import type { FogOfWar } from './fog';
import { LM_NIGHT } from './landmarks/material';
import { assetBase } from './photoground';

/*
 * The South Sinai (Sharm) building kit (GD2): modular pieces modelled and baked in Blender
 * (tools/blender/sinai/sinai_kit.py -> pack.mjs -> public/models/sinai/):
 *  - wall cards: recessed windows (plain, open / closed louvred shutters, iron grilles, arched, a lattice),
 *    doors, a yard gate, a shop front, an open arch, hotel windows and balcony doors - quads on the walls
 *    whose depth comes from the high -> low bake (normal + AO);
 *  - 3D pieces (LOD0 + LOD1 each): split AC units, water tanks, satellite dishes, solar heaters, railings,
 *    awnings, domes, the mosque's drum and dome, the minaret, merlons, cafe tables, the promenade kiosk;
 *  - swatches: flat atlas patches for code-built trim (paint, wood, steel, stone, glass...);
 *  - a tileable rendered-plaster texture (cracks, stains, streaks) mapped in world space on every wall.
 * One shared atlas (albedo, normal, ORM: AO / roughness / tint class / glass), two materials: the walls
 * (plaster) and the kit. The kit's tint class picks per texel between its own colour, the wall's plaster
 * (sampled in world space with the wall colour, so a card's surround is seamless with its wall) and an
 * accent paint colour (shutters, doors, awnings, tanks); glass glows at night where a window is lit.
 * Built into merged meshes (render/sinaitown.ts, seaside.ts): the instancing is the merge.
 */

export interface KitManifest {
  atlas: number;
  plasterTile: number;
  cards: Record<string, { uv: [number, number, number, number]; size: [number, number] }>;
  swatches: Record<string, [number, number]>;
  pieces: Record<string, number[]>;
}

export interface SinaiKit {
  man: KitManifest;
  /** Piece geometries by glTF node name ('tank', 'tank_l1', ...): float copies (position, normal, uv), indexed. */
  geo: Map<string, THREE.BufferGeometry>;
  atlas: { albedo: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture };
  plaster: { albedo: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture };
  /** Download (bytes) and decode time, for the log. */
  bytes: number;
}

let pending: Promise<SinaiKit | null> | null = null;
let ready: SinaiKit | null = null;

/** The loaded kit (null until loadSinaiKit() resolved, in tests, or after a failure). */
export function sinaiKit(): SinaiKit | null {
  return ready;
}

async function tex(url: string, srgb: boolean, repeat: boolean, counter: { bytes: number }): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  counter.bytes += blob.size;
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

const _v = new THREE.Vector3();

/** Float copy of a (quantised) glTF geometry with its node transform baked in. */
function dequantize(src: THREE.BufferGeometry, world: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  g.applyMatrix4(world);
  const n = g.getAttribute('normal');
  if (n) for (let i = 0; i < n.count; i++) _v.fromBufferAttribute(n, i).normalize().toArray(n.array as Float32Array, i * 3);
  return g;
}

/**
 * Fetch the kit (manifest, pieces, atlas, plaster) once; resolves null when it cannot load (no fetch in tests,
 * ?sinai=0 for comparison shots, a network failure): the town then keeps its procedural buildings.
 */
export function loadSinaiKit(quality: 'low' | 'medium' | 'high'): Promise<SinaiKit | null> {
  if (pending) return pending;
  pending = (async () => {
    if (typeof fetch === 'undefined' || typeof createImageBitmap === 'undefined') return null;
    if (typeof location !== 'undefined' && /[?&]sinai=0\b/.test(location.search)) return null;
    const t0 = performance.now();
    try {
      const dir = `${assetBase()}models/sinai/`;
      const counter = { bytes: 0 };
      const big = quality === 'high';
      const a = big ? '' : '-512';
      const p = big ? '' : '-256';
      const manRes = await fetch(dir + 'sinai-kit.json');
      if (!manRes.ok) throw new Error('sinai-kit.json: HTTP ' + manRes.status);
      const man = (await manRes.json()) as KitManifest;
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      const glbRes = await fetch(dir + 'sinai-kit.glb');
      if (!glbRes.ok) throw new Error('sinai-kit.glb: HTTP ' + glbRes.status);
      const buf = await glbRes.arrayBuffer();
      counter.bytes += buf.byteLength;
      const [gltf, albedo, normal, orm, palb, pnor, porm] = await Promise.all([
        loader.parseAsync(buf, dir),
        tex(`${dir}sinai-atlas-albedo${a}.webp`, true, false, counter),
        tex(`${dir}sinai-atlas-normal${a}.webp`, false, false, counter),
        tex(`${dir}sinai-atlas-orm${a}.webp`, false, false, counter),
        tex(`${dir}sinai-plaster-albedo${p}.webp`, true, true, counter),
        tex(`${dir}sinai-plaster-normal${p}.webp`, false, true, counter),
        tex(`${dir}sinai-plaster-orm${p}.webp`, false, true, counter),
      ]);
      const geo = new Map<string, THREE.BufferGeometry>();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) geo.set(mesh.name, dequantize(mesh.geometry, mesh.matrixWorld));
      });
      ready = { man, geo, atlas: { albedo, normal, orm }, plaster: { albedo: palb, normal: pnor, orm: porm }, bytes: counter.bytes };
      console.info(`[sinai] building kit: ${geo.size} meshes, ${Object.keys(man.cards).length} cards, ${(counter.bytes / 1024).toFixed(0)} KB in ${Math.round(performance.now() - t0)} ms`);
      return ready;
    } catch (e) {
      console.warn('[sinai] building kit unavailable, keeping the procedural town', e);
      return null;
    }
  })();
  return pending;
}

// ------------------------------------------------------------------ materials

const PLASTER_MATS = new WeakMap<FogOfWar, THREE.MeshStandardMaterial>();
const KIT_MATS = new WeakMap<FogOfWar, THREE.MeshStandardMaterial>();

/**
 * The walls: the tileable plaster (world-space box mapping, PLASTER_TILE tiles per repeat) tinted by the vertex
 * colour (the wall colour; envdamage.ts darkens it), grime along the foot of the walls (aBase: the ground
 * height under the building) and darker sun-faded streaks under the parapets.
 */
export function sinaiPlasterMaterial(fog: FogOfWar, kit: SinaiKit): THREE.MeshStandardMaterial {
  const c = PLASTER_MATS.get(fog);
  if (c) return c;
  const mat = new THREE.MeshStandardMaterial({
    map: kit.plaster.albedo,
    normalMap: kit.plaster.normal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: kit.plaster.orm,
    aoMap: kit.plaster.orm,
    aoMapIntensity: 0.9,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
    envMapIntensity: 0.6,
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBase;\nvarying float vSkBase;\nvarying float vSkUp;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvSkBase = aBase;\nvSkUp = normalize( mat3( modelMatrix ) * objectNormal ).y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vSkBase;\nvarying float vSkUp;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        // dust and splash grime along the foot of the walls (not on roofs), a little uneven
        float hgt = vFogP.y - vSkBase;
        float gn = texture2D( map, vMapUv * 0.37 + 0.21 ).g;
        float grime = ( 1.0 - smoothstep( 0.0, 0.16 + gn * 0.06, hgt ) ) * ( 1.0 - step( 0.6, abs( vSkUp ) ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.74, 0.68, 0.6 ), grime * 0.55 );
      }`,
    );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-sinai-plaster';
  PLASTER_MATS.set(fog, mat);
  return mat;
}

/**
 * The kit: atlas albedo / normal / ORM. ORM.b is the tint class (0 own colour, 0.5 wall plaster: the world-mapped
 * plaster texture times aTint, 1 accent: albedo times aAccent), ORM.a the glass (lit at night where aGlow).
 */
export function sinaiKitMaterial(fog: FogOfWar, kit: SinaiKit): THREE.MeshStandardMaterial {
  const c = KIT_MATS.get(fog);
  if (c) return c;
  const mat = new THREE.MeshStandardMaterial({
    map: kit.atlas.albedo,
    normalMap: kit.atlas.normal,
    // Blender tangent normals through glTF's flipped v
    normalScale: new THREE.Vector2(1, -1),
    roughnessMap: kit.atlas.orm,
    aoMap: kit.atlas.orm,
    aoMapIntensity: 1,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
    envMapIntensity: 0.7,
  });
  const plaster = { value: kit.plaster.albedo };
  const tile = { value: 1 / kit.man.plasterTile };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.skPlaster = plaster;
    sh.uniforms.skTile = tile;
    sh.uniforms.lmNight = LM_NIGHT;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aTint;\nattribute vec3 aAccent;\nattribute float aGlow;\nvarying vec3 vSkTint;\nvarying vec3 vSkAcc;\nvarying float vSkGlow;\nvarying vec3 vSkN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvSkTint = aTint * 2.0;\nvSkAcc = aAccent * 2.0;\nvSkGlow = aGlow;\nvSkN = normalize( mat3( modelMatrix ) * objectNormal );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D skPlaster;\nuniform float skTile;\nuniform float lmNight;\nvarying vec3 vSkTint;\nvarying vec3 vSkAcc;\nvarying float vSkGlow;\nvarying vec3 vSkN;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec4 skOrm = texture2D( aoMap, vAoMapUv );
        {
          float cls = skOrm.b;
          float wallW = cls < 0.5 ? cls * 2.0 : 2.0 - cls * 2.0;
          float accW = clamp( cls * 2.0 - 1.0, 0.0, 1.0 );
          // the wall plaster, mapped in world space exactly like the walls (sinaitown.ts boxUV)
          vec3 an = abs( vSkN );
          vec2 puv = an.y >= an.x && an.y >= an.z ? vFogP.xz : an.x >= an.z ? vFogP.zy : vFogP.xy;
          vec3 pl = texture2D( skPlaster, puv * skTile ).rgb * vSkTint * ( 0.45 + 0.55 * skOrm.r );
          vec3 own = diffuseColor.rgb;
          diffuseColor.rgb = own * ( 1.0 - wallW - accW ) + pl * wallW + own * vSkAcc * ( accW * 1.3 );
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += skOrm.a * vSkGlow * lmNight * vec3( 1.0, 0.78, 0.48 ) * 1.1;`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-sinai-kit';
  KIT_MATS.set(fog, mat);
  return mat;
}

// ------------------------------------------------------------------ geometry builders

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const WHITE = new THREE.Color(1, 1, 1);

/** Plaster walls: position, normal, world box uv, colour (wall), aBase. */
export class PlasterGeo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  base: number[] = [];
  idx: number[] = [];
  constructor(private tile: number) {}
  get count() {
    return this.pos.length / 3;
  }
  /** Append a geometry transformed by m: world box-projected uvs (the kit's shader maps its plaster the same way). */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, base: number, skipDown = false) {
    const P = g.attributes.position;
    const N = g.attributes.normal;
    _nm.getNormalMatrix(m);
    const start = this.count;
    const map: number[] = [];
    for (let i = 0; i < P.count; i++) {
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      if (skipDown && _n.y < -0.9) {
        map.push(-1);
        continue;
      }
      _p.fromBufferAttribute(P, i).applyMatrix4(m);
      map.push(this.count);
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      const ax = Math.abs(_n.x);
      const ay = Math.abs(_n.y);
      const az = Math.abs(_n.z);
      const [u, v] = ay >= ax && ay >= az ? [_p.x, _p.z] : ax >= az ? [_p.z, _p.y] : [_p.x, _p.y];
      this.uv.push(u * this.tile, v * this.tile);
      this.col.push(color.r, color.g, color.b);
      this.base.push(base);
    }
    const ix = g.index;
    const n = ix ? ix.count : P.count;
    for (let i = 0; i < n; i += 3) {
      const a = map[ix ? ix.getX(i) : i];
      const b = map[ix ? ix.getX(i + 1) : i + 1];
      const c = map[ix ? ix.getX(i + 2) : i + 2];
      if (a < 0 || b < 0 || c < 0) continue;
      this.idx.push(a, b, c);
    }
    return start;
  }
  build(): THREE.BufferGeometry | null {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(this.base, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export interface KitOpts {
  /** Vertex colour (multiplies everything; envdamage.ts darkens it). */
  color?: THREE.Color;
  /** The wall colour for the plaster texels (class 0.5). */
  tint?: THREE.Color;
  /** The accent paint colour (class 1). */
  accent?: THREE.Color;
  /** Lit window at night (glass texels). */
  glow?: number;
}

/** Kit geometry: position, normal, atlas uv, colour, aTint, aAccent (uint8), aGlow. */
export class KitGeo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  tint: number[] = [];
  acc: number[] = [];
  glow: number[] = [];
  idx: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  private push(o: KitOpts) {
    const c = o.color ?? WHITE;
    this.col.push(c.r, c.g, c.b);
    // tints in 0..2 (bright plaster may go a little over 1), stored halved in a byte
    const q = (x: number) => Math.round(Math.min(1, Math.max(0, x / 2)) * 255);
    const t = o.tint ?? WHITE;
    this.tint.push(q(t.r), q(t.g), q(t.b));
    const a = o.accent ?? WHITE;
    this.acc.push(q(a.r), q(a.g), q(a.b));
    this.glow.push(o.glow ? 255 : 0);
  }
  /** Append a geometry with its own uvs (a piece), or every vertex at `uvAt` (a swatch). */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, o: KitOpts, uvAt?: [number, number]) {
    const P = g.attributes.position;
    const N = g.attributes.normal;
    const U = g.attributes.uv;
    _nm.getNormalMatrix(m);
    const start = this.count;
    for (let i = 0; i < P.count; i++) {
      _p.fromBufferAttribute(P, i).applyMatrix4(m);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      if (uvAt) this.uv.push(uvAt[0], uvAt[1]);
      else this.uv.push(U.getX(i), U.getY(i));
      this.push(o);
    }
    const ix = g.index;
    // a mirrored transform (negative scale) turns the winding inside out
    const flip = m.determinant() < 0;
    const n = ix ? ix.count : P.count;
    for (let i = 0; i < n; i += 3) {
      const a = start + (ix ? ix.getX(i) : i);
      const b = start + (ix ? ix.getX(i + 1) : i + 1);
      const c = start + (ix ? ix.getX(i + 2) : i + 2);
      if (flip) this.idx.push(a, c, b);
      else this.idx.push(a, b, c);
    }
    return start;
  }
  /** A card: a quad (w x h, centred, facing local +z) carrying the atlas rect uv = [u0, v0 (top), u1, v1]. */
  quad(m: THREE.Matrix4, w: number, h: number, uv: [number, number, number, number], o: KitOpts) {
    _nm.getNormalMatrix(m);
    _n.set(0, 0, 1).applyMatrix3(_nm).normalize();
    const s = this.count;
    const corners: [number, number, number, number][] = [
      [-w / 2, h / 2, uv[0], uv[1]],
      [w / 2, h / 2, uv[2], uv[1]],
      [-w / 2, -h / 2, uv[0], uv[3]],
      [w / 2, -h / 2, uv[2], uv[3]],
    ];
    for (const [x, y, u, v] of corners) {
      _p.set(x, y, 0).applyMatrix4(m);
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.uv.push(u, v);
      this.push(o);
    }
    if (m.determinant() < 0) this.idx.push(s, s + 1, s + 2, s + 1, s + 3, s + 2);
    else this.idx.push(s, s + 2, s + 1, s + 1, s + 2, s + 3);
  }
  build(): THREE.BufferGeometry | null {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aTint', new THREE.Uint8BufferAttribute(this.tint, 3, true));
    g.setAttribute('aAccent', new THREE.Uint8BufferAttribute(this.acc, 3, true));
    g.setAttribute('aGlow', new THREE.Uint8BufferAttribute(this.glow, 1, true));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();

/** Which LOD meshes get a part: both (the default), the close-up one only (0) or the far one only (1). */
export type Lod = 'both' | 0 | 1;

/**
 * One merged set of building meshes: the plaster walls, the kit at LOD0 (close / play zoom) and at LOD1
 * (zoomed out). Cards and big parts go into both kit meshes, small clutter into LOD0 only.
 */
export class SinaiBuilder {
  readonly pl: PlasterGeo;
  readonly k0 = new KitGeo();
  readonly k1 = new KitGeo();
  constructor(readonly kit: SinaiKit) {
    this.pl = new PlasterGeo(1 / kit.man.plasterTile);
  }

  /** A plaster box (w x h x d, centred on m's origin); the underside is left out unless `bottom`. */
  box(m: THREE.Matrix4, w: number, h: number, d: number, color: THREE.Color, base: number, bottom = false) {
    _m.copy(m).multiply(new THREE.Matrix4().makeScale(w, h, d));
    this.pl.add(BOX, _m, color, base, !bottom);
  }

  /** Any geometry in plaster (cylinders, steps...). */
  plaster(g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, base: number) {
    this.pl.add(g, m, color, base);
  }

  private each(lod: Lod, f: (k: KitGeo) => void) {
    if (lod !== 1) f(this.k0);
    if (lod !== 0) f(this.k1);
  }

  /** A wall card (its local plane xy facing +z, centred on m's origin; sx / sy stretch it). */
  card(name: string, m: THREE.Matrix4, o: KitOpts, sx = 1, sy = 1, lod: Lod = 'both') {
    const c = this.kit.man.cards[name];
    if (!c) return;
    this.each(lod, (k) => k.quad(m, c.size[0] * sx, c.size[1] * sy, c.uv, o));
  }

  /** Card size (tiles). */
  cardSize(name: string): [number, number] {
    return this.kit.man.cards[name]?.size ?? [0.2, 0.2];
  }

  /** A 3D piece: its LOD0 into the close mesh, its LOD1 (when it has one) into the far mesh. */
  piece(name: string, m: THREE.Matrix4, o: KitOpts = {}, lod: Lod = 'both') {
    const g0 = this.kit.geo.get(name);
    const g1 = this.kit.geo.get(name + '_l1');
    if (g0 && lod !== 1) this.k0.add(g0, m, o);
    if (g1 && lod !== 0) this.k1.add(g1, m, o);
  }

  /** A box in a flat atlas swatch (paint, wood, steel, stone, glass, iron...). */
  swatch(m: THREE.Matrix4, w: number, h: number, d: number, sw: string, o: KitOpts, lod: Lod = 'both') {
    const at = this.kit.man.swatches[sw] ?? this.kit.man.swatches.frame;
    _m.copy(m).multiply(new THREE.Matrix4().makeScale(w, h, d));
    this.each(lod, (k) => k.add(BOX, _m, o, at));
  }

  /** Any geometry in a swatch. */
  swatchGeo(g: THREE.BufferGeometry, m: THREE.Matrix4, sw: string, o: KitOpts, lod: Lod = 'both') {
    const at = this.kit.man.swatches[sw] ?? this.kit.man.swatches.frame;
    this.each(lod, (k) => k.add(g, m, o, at));
  }

  counts(): [number, number, number] {
    return [this.pl.count, this.k0.count, this.k1.count];
  }
}

/** Scale matrix helper (uniform or per axis). */
export function scaleM(x: number, y = x, z = x) {
  return new THREE.Matrix4().makeScale(x, y, z);
}

