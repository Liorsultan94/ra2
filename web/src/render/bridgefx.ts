import * as THREE from 'three';
import { BRIDGE_REPAIR_TICKS, type BridgeState, type BridgeStatus } from '../sim/bridges';
import { BRIDGE_HEIGHT, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { World } from '../sim/world';
import { BLASTS, type Effects } from './effects';
import type { FogOfWar } from './fog';
import { GeoBuilder } from './geo';
import { deckLift, deckRamps, rampHeight } from './deckramp';
import { surfaceHeight } from './ground';
import { buildLayout } from './layout';
import { sharedRoadMaterial } from './scenery';
import { buildingTextures, roadTexture } from './terraintex';

/*
 * River bridges, drawn and animated from the simulation's bridge table
 * (sim/bridges.ts). Each bridge is split into fixed parts (piers, pier caps,
 * abutments and short deck stubs on the banks) and four deck spans that can
 * move on their own:
 *
 *  - damage: scorch / crack decals appear per span as HP drops, real impact
 *    points leave their own scorch, below half HP the spans swap to a holed
 *    variant (punched-through slab with rebar, broken and hanging parapet
 *    segments), below a quarter the centre spans sag; smoke, flames and dust
 *    trickle from the holes;
 *  - collapse: charges of rubble blow at the supports, the spans hinge off
 *    their piers, tear free, tumble into the river with splashes, debris and
 *    a dust cloud, and settle tilted on the river bed; jagged stumps with
 *    bent rebar remain and smoke lingers;
 *  - rebuild: the wreck sinks away, scaffold towers rise on the piers and the
 *    spans are re-cast one after another from the banks (welding sparks),
 *    then the scaffolding comes down.
 *
 * The water shader's occluder map (bridge deck heights for the medium
 * reflection march) is patched while a bridge is down. Render-only state;
 * Math.random is fine here.
 */

const D = Math.SQRT1_2;
const W = 2.1; // deck width
const STUB = 0.34; // deck stub left on each bank
const DECK_Y = BRIDGE_HEIGHT - 0.1; // slab centre
const RIVERBED = -0.84;
const GRAV = 3.6; // tiles / s^2 (slowed a little for drama)
const DECAL_TIERS = [0.8, 0.55, 0.3];

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')), V(sx, sy, sz));
}

type Col = number | THREE.Color | ((p: THREE.Vector3, n: THREE.Vector3) => number | THREE.Color);
function box(b: GeoBuilder, w: number, h: number, d: number, m: THREE.Matrix4, c: Col) {
  b.add(new THREE.BoxGeometry(w, h, d).toNonIndexed(), m, null, c);
}

/** Box-project UVs (concrete texture) for vertices from `from` on. */
function boxUV(b: GeoBuilder, from: number, scale: number) {
  for (let i = from; i < b.count; i++) {
    const x = b.pos[i * 3];
    const y = b.pos[i * 3 + 1];
    const z = b.pos[i * 3 + 2];
    const nx = Math.abs(b.nor[i * 3]);
    const ny = Math.abs(b.nor[i * 3 + 1]);
    const nz = Math.abs(b.nor[i * 3 + 2]);
    const [u, v] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y];
    b.uv[i * 2] = u * scale;
    b.uv[i * 2 + 1] = v * scale;
  }
}

/** Thin beam between two points. */
function beam(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, t: number, col: Col) {
  const len = a.distanceTo(c);
  const mid = a.clone().add(c).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), c.clone().sub(a).normalize());
  b.add(new THREE.BoxGeometry(t, len, t).toNonIndexed(), new THREE.Matrix4().compose(mid, q, V(1, 1, 1)), null, col);
}

interface Hole {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

/**
 * How the deck asphalt maps onto the road strip texture, set per bridge from the roads it carries:
 * the same look (highway / country road) and the dash phase carried on from the approach road
 * (v at bridge-local x, see BridgeFx.deckLook).
 */
const deckUV = { u0: 0.06, v0: 0, dv: 1 / 6 };

/** Asphalt top quad (the road strip texture): u across the road, v along it (bridge-local x). */
function asphalt(top: GeoBuilder, x0: number, x1: number, z0: number, z1: number, y: number, xBase: number, m: THREE.Matrix4) {
  const w = W - 0.6;
  const n = Math.max(1, Math.ceil((x1 - x0) / SEG));
  for (let i = 0; i < n; i++) {
    const xa = x0 + ((x1 - x0) * i) / n;
    const xb = x0 + ((x1 - x0) * (i + 1)) / n;
    const p = [V(xa, y, z0), V(xb, y, z0), V(xa, y, z1), V(xb, y, z1)].map((v) => v.applyMatrix4(m));
    const ids = p.map((q, k) => {
      const lx = k % 2 ? xb : xa;
      const lz = k < 2 ? z0 : z1;
      return top.vert(q, V(0, 1, 0), deckUV.u0 + ((lz + w / 2) / w) * 0.38, deckUV.v0 + (lx + xBase) * deckUV.dv, 1);
    });
    top.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

/** Deck pieces are cut into SEG-long blocks so they can bend over a raised bank (render/deckramp.ts). */
const SEG = 0.25;
type Lift = (x: number) => number;
const FLAT: Lift = () => 0;

/** Raise vertices [from, count) of `b` by the deck lift at their x (+ xBase: frame offset along the deck). */
function warp(b: GeoBuilder, from: number, lift: Lift, xBase: number) {
  if (lift === FLAT) return;
  for (let i = from; i < b.count; i++) b.pos[i * 3 + 1] += lift(b.pos[i * 3] + xBase);
}

/**
 * Deck section from x0 to x1 (local x, in the frame `m`): slab, sidewalks,
 * parapets with posts, asphalt. `xBase` = offset of the frame's x = 0 from the
 * bridge centre (asphalt v continuity). Damaged: holed slab, missing / hanging
 * parapet segments, soot around the hole.
 */
function addDeck(conc: GeoBuilder, top: GeoBuilder, x0: number, x1: number, m: THREE.Matrix4, xBase: number, seed: number, hole: Hole | null, broken: boolean, lift: Lift = FLAT) {
  const len = x1 - x0;
  const soot = (base: number): Col =>
    hole
      ? (p: THREE.Vector3) => {
          // p is in the frame of `m` applied; spans use an identity-ish frame so local coords work
          const d2 = ((p.x - hole.x) ** 2) / 0.2 + ((p.z - hole.z) ** 2) / 0.2;
          return base * (0.42 + 0.58 * (1 - Math.exp(-d2)));
        }
      : base;
  const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => m.clone().multiply(trs(x, y, z, rx, ry, rz));
  const pt = (x: number, y: number, z: number) => V(x, y, z).applyMatrix4(m);
  const base = conc.count;
  const tbase = top.count;
  // a box from xa to xb cut into SEG-long blocks (bends with the lift)
  const run = (xa: number, xb: number, h: number, d: number, y: number, z: number, c: Col) => {
    const n = Math.max(1, Math.ceil((xb - xa) / SEG - 0.01));
    for (let k = 0; k < n; k++) box(conc, (xb - xa) / n, h, d, at(xa + ((k + 0.5) * (xb - xa)) / n, y, z), c);
  };
  // slab (with a hole: four pieces around it)
  if (hole) {
    const hx0 = hole.x - hole.hx;
    const hx1 = hole.x + hole.hx;
    const hz0 = hole.z - hole.hz;
    const hz1 = hole.z + hole.hz;
    run(x0, hx0, 0.2, W, 0, 0, soot(0.78));
    run(hx1, x1, 0.2, W, 0, 0, soot(0.78));
    box(conc, hx1 - hx0, 0.2, hz0 + W / 2, at(hole.x, 0, (-W / 2 + hz0) / 2), soot(0.78));
    box(conc, hx1 - hx0, 0.2, W / 2 - hz1, at(hole.x, 0, (hz1 + W / 2) / 2), soot(0.78));
    // jagged rim chunks and bent rebar across the hole
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + hash2(seed, k, 3) * 0.6;
      const s = 0.05 + hash2(seed, k, 4) * 0.07;
      box(conc, s, s * 0.8, s * 1.2, at(hole.x + Math.cos(a) * hole.hx * 0.95, 0.08 - hash2(seed, k, 5) * 0.14, hole.z + Math.sin(a) * hole.hz * 0.95, a, a * 1.7, a * 0.6), 0.36);
    }
    for (let k = 0; k < 3; k++) {
      const z = hz0 + ((k + 0.5) / 3) * (hz1 - hz0);
      const sag = 0.05 + hash2(seed, k, 6) * 0.08;
      beam(conc, pt(hx0 - 0.03, -0.02, z), pt(hole.x, -0.02 - sag, z + 0.02), 0.014, 0.22);
      if (hash2(seed, k, 7) < 0.6) beam(conc, pt(hole.x + 0.02, -0.02 - sag * 1.4, z), pt(hx1 - 0.08 * hash2(seed, k, 8), -0.06 - sag, z - 0.03), 0.014, 0.22);
    }
  } else run(x0, x1, 0.2, W, 0, 0, 0.78);
  // sidewalks, parapet segments and posts
  const nSeg = Math.max(2, Math.round(len / 0.75));
  const segL = len / nSeg;
  for (const side of [-1, 1]) {
    run(x0, x1, 0.04, 0.3, 0.12, side * (W / 2 - 0.15), soot(0.85));
    const drop = broken ? Math.floor(hash2(seed, side, 11) * nSeg) : -1;
    const hang = broken && side === (hash2(seed, 0, 12) < 0.5 ? -1 : 1) ? (drop + 1 + Math.floor(hash2(seed, side, 13) * (nSeg - 1))) % nSeg : -1;
    for (let k = 0; k < nSeg; k++) {
      const sx = x0 + (k + 0.5) * segL;
      if (k === drop) {
        // a stub of the parapet and some rubble on the walk
        box(conc, segL * 0.25, 0.08, 0.06, at(x0 + k * segL + segL * 0.12, 0.17, side * (W / 2 - 0.03), 0, 0, 0.3), 0.6);
        box(conc, 0.09, 0.05, 0.07, at(sx + 0.05, 0.155, side * (W / 2 - 0.2), 0.3, 0.8, 0.2), 0.55);
        continue;
      }
      if (k === hang) {
        // knocked outwards, hanging off the deck edge
        box(conc, segL * 0.96, 0.12, 0.06, at(sx, 0.06, side * (W / 2 + 0.05), side * 0.9, 0, 0.12), 0.7);
        continue;
      }
      if (lift === FLAT) box(conc, segL * 0.98, 0.12, 0.06, at(sx, 0.2, side * (W / 2 - 0.03)), soot(0.9));
      else run(sx - segL * 0.49, sx + segL * 0.49, 0.12, 0.06, 0.2, side * (W / 2 - 0.03), soot(0.9));
      const pp = x0 + k * segL + 0.1;
      if (!broken || hash2(seed + k, side, 14) > 0.35) box(conc, 0.05, 0.04, 0.08, at(pp, 0.28, side * (W / 2 - 0.03)), 0.6);
    }
  }
  boxUV(conc, base, 2);
  // asphalt (around the hole)
  const aw = (W - 0.6) / 2;
  if (hole) {
    const hx0 = hole.x - hole.hx;
    const hx1 = hole.x + hole.hx;
    const hz0 = Math.max(-aw, hole.z - hole.hz);
    const hz1 = Math.min(aw, hole.z + hole.hz);
    asphalt(top, x0, hx0, -aw, aw, 0.104, xBase, m);
    asphalt(top, hx1, x1, -aw, aw, 0.104, xBase, m);
    if (hz0 > -aw) asphalt(top, hx0, hx1, -aw, hz0, 0.104, xBase, m);
    if (hz1 < aw) asphalt(top, hx0, hx1, hz1, aw, 0.104, xBase, m);
  } else asphalt(top, x0, x1, -aw, aw, 0.104, xBase, m);
  warp(conc, base, lift, xBase);
  warp(top, tbase, lift, xBase);
}

/** Scorch (left) and crack (right) decal atlas. */
let atlas: THREE.CanvasTexture | null = null;
function decalAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S * 2;
  c.height = S;
  const ctx = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // scorch: soft dark blotch with a broken rim
  const g = ctx.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(12,10,8,0.95)');
  g.addColorStop(0.45, 'rgba(22,18,14,0.75)');
  g.addColorStop(0.8, 'rgba(40,34,28,0.25)');
  g.addColorStop(1, 'rgba(40,34,28,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2;
    const r = S * (0.15 + rnd() * 0.3);
    ctx.fillStyle = `rgba(10,8,6,${0.15 + rnd() * 0.3})`;
    ctx.beginPath();
    ctx.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 2 + rnd() * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  // cracks: branching random walks from the centre
  ctx.strokeStyle = 'rgba(14,12,10,0.9)';
  ctx.lineCap = 'round';
  const walk = (x: number, y: number, a: number, n: number, w: number) => {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let i = 0; i < n; i++) {
      a += (rnd() - 0.5) * 0.9;
      x += Math.cos(a) * 5;
      y += Math.sin(a) * 5;
      if (x < S + 2 || x > 2 * S - 2 || y < 2 || y > S - 2) break;
      ctx.lineTo(x, y);
      if (rnd() < 0.12 && w > 0.8) {
        ctx.stroke();
        walk(x, y, a + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6), Math.floor(n * 0.5), w * 0.6);
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  };
  for (let k = 0; k < 6; k++) walk(S * 1.5, S / 2, (k / 6) * Math.PI * 2 + rnd() * 0.5, 12, 2.2);
  ctx.fillStyle = 'rgba(20,16,12,0.85)';
  ctx.beginPath();
  ctx.arc(S * 1.5, S / 2, 5, 0, Math.PI * 2);
  ctx.fill();
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  return atlas;
}

/** One decal quad on the deck top (span-local), atlas cell 0 = scorch, 1 = crack. */
function decal(b: GeoBuilder, x: number, z: number, y: number, size: number, rot: number, cell: number) {
  const c = Math.cos(rot) * size * 0.5;
  const s = Math.sin(rot) * size * 0.5;
  const pts = [V(x - c + s, y, z - s - c), V(x + c + s, y, z + s - c), V(x - c - s, y, z - s + c), V(x + c - s, y, z + s + c)];
  const u0 = cell * 0.5;
  const ids = pts.map((p, k) => b.vert(p, V(0, 1, 0), u0 + (k % 2 ? 0.5 : 0), k < 2 ? 0 : 1, 1));
  b.quad(ids[0], ids[1], ids[2], ids[3]);
}

type Phase = 'stand' | 'wait' | 'hinge' | 'fall' | 'settle' | 'rest' | 'sink' | 'build';

interface Span {
  g: THREE.Group;
  intact: THREE.Mesh[];
  damaged: THREE.Mesh[];
  tiers: THREE.Mesh[];
  hits: THREE.Group;
  cx: number;
  len: number;
  /** -1: hinges at its left (bank 0 side) support, +1 right, 0: drops flat. */
  hinge: number;
  delay: number;
  hole: Hole | null;
  phase: Phase;
  a: number;
  w: number;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  rz: number;
  rx: number;
  wz: number;
  wx: number;
  rest: { y: number; rz: number; rx: number };
  t: number;
  splashed: boolean;
}

interface View {
  b: BridgeState;
  root: THREE.Group;
  spans: Span[];
  broken: THREE.Mesh;
  scaffold: THREE.Group;
  status: BridgeStatus;
  t0: number;
  lastHitAt: number;
  nHits: number;
  hitTier: number;
  holed: boolean;
  smokeAcc: number;
  scafOut: number;
  orig: Uint8Array | null;
  /** deck lift (above BRIDGE_HEIGHT) at bridge-local x: the ends rise onto banks higher than the deck */
  lift: Lift;
}

export class BridgeFx {
  readonly group = new THREE.Group();
  private views: View[] = [];
  private time = 0;
  private concMat: THREE.Material;
  private roadMat: THREE.Material;
  private decalMat: THREE.Material;
  private hitGeo: THREE.BufferGeometry;
  private waterData: THREE.DataTexture | null;

  constructor(
    private world: World,
    private fx: Effects,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
    waterMat?: THREE.ShaderMaterial,
  ) {
    this.group.name = 'bridges';
    const shadows = quality !== 'low';
    const tex = buildingTextures(quality === 'low' ? 128 : 256);
    this.concMat = fog.apply(new THREE.MeshStandardMaterial({ map: tex.plaster, vertexColors: true, roughness: 0.9 }));
    // the decks wear the roads' own asphalt (scenery.ts: photoscan + markings mask, biome dust / snow)
    this.roadMat =
      sharedRoadMaterial(world.map) ??
      fog.apply(new THREE.MeshStandardMaterial({ map: roadTexture(quality === 'high' ? 256 : 128), alphaTest: 0.5, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    this.decalMat = fog.apply(
      new THREE.MeshStandardMaterial({ map: decalAtlas(), transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
    );
    const steel = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35 }));
    {
      const hb = new GeoBuilder();
      decal(hb, 0, 0, 0, 1, 0, 0);
      this.hitGeo = hb.build();
    }
    const wd = waterMat?.uniforms.waterData?.value as THREE.DataTexture | undefined;
    this.waterData = wd && wd.image && (wd.image.data as Uint8Array) ? wd : null;

    for (const b of world.bridges) {
      const br = world.map.bridges[b.idx];
      const L = br.length;
      const root = new THREE.Group();
      root.position.set(br.x, 0, br.y);
      root.rotation.y = Math.PI / 4;
      this.group.add(root);
      root.updateMatrixWorld(true);
      const seed = b.idx * 97 + 13;
      this.deckLook(b, L);
      const ramp = deckRamps(world.map)[b.idx];
      const lift: Lift = ramp && ramp.lift.some((h) => h > 0) ? (x: number) => deckLift(ramp, x) : FLAT;
      const piers = [-L / 2 + 1.5, 0, L / 2 - 1.5];
      // ---- fixed: piers, caps, abutments, bank stubs
      const fixed = new GeoBuilder();
      const ftop = new GeoBuilder();
      for (const k of piers) {
        box(fixed, 0.4, 1.5, W * 0.7, trs(k, BRIDGE_HEIGHT - 0.95, 0), 0.62);
        box(fixed, 0.6, 0.12, W * 0.85, trs(k, BRIDGE_HEIGHT - 0.24, 0), 0.7);
      }
      // abutments: up to the slab's underside, wherever the deck's end sits
      for (const k of [-L / 2, L / 2]) {
        const h = 1.0 + lift(k);
        box(fixed, 0.5, h, W, trs(k + Math.sign(k) * 0.05, BRIDGE_HEIGHT - 1.1 + h / 2, 0), 0.65);
      }
      boxUV(fixed, 0, 2);
      addDeck(fixed, ftop, -L / 2, -L / 2 + STUB, trs(0, DECK_Y, 0), 0, seed + 1, null, false, lift);
      addDeck(fixed, ftop, L / 2 - STUB, L / 2, trs(0, DECK_Y, 0), 0, seed + 2, null, false, lift);
      // the approaches: expansion joints, kerbs, wing walls under the ramps, flared guard rails
      const rails = new GeoBuilder();
      const fb = fixed.count;
      for (const end of [-1, 1]) this.approach(root, L, end, fixed, rails, lift);
      boxUV(fixed, fb, 2);
      const fm = new THREE.Mesh(fixed.build(), this.concMat);
      fm.castShadow = shadows;
      fm.receiveShadow = true;
      const ft = new THREE.Mesh(ftop.build(), this.roadMat);
      ft.receiveShadow = true;
      const rm = new THREE.Mesh(rails.build(), steel);
      rm.castShadow = shadows;
      root.add(fm, ft, rm);
      // ---- broken stumps: jagged edges and bent rebar where spans tore away
      const bk = new GeoBuilder();
      const edges: [number, number][] = [
        [-L / 2 + STUB, 1],
        [L / 2 - STUB, -1],
        ...piers.flatMap((p) => [[p - 0.2, -1] as [number, number], [p + 0.2, 1] as [number, number]]),
      ];
      edges.forEach(([x, dir], ei) => {
        const pier = ei >= 2;
        for (let k = 0; k < 9; k++) {
          const z = -W / 2 + ((k + hash2(seed, ei * 9 + k, 21)) / 9) * W;
          const s = 0.06 + hash2(seed, ei * 9 + k, 22) * 0.1;
          const y = pier ? BRIDGE_HEIGHT - 0.16 + hash2(seed, ei * 9 + k, 23) * 0.1 : DECK_Y + lift(x) + (hash2(seed, ei * 9 + k, 23) - 0.5) * 0.14;
          box(bk, s, s * 0.9, s * 1.3, trs(x + dir * s * 0.3, y, z, k, k * 1.3, k * 0.7), 0.5);
        }
        if (!pier)
          for (let k = 0; k < 6; k++) {
            const z = -W / 2 + 0.2 + (k / 5) * (W - 0.4);
            const l = 0.14 + hash2(seed, ei * 6 + k, 24) * 0.2;
            beam(bk, V(x, DECK_Y + lift(x) - 0.03, z), V(x + dir * l, DECK_Y + lift(x) - 0.05 - l * (0.3 + hash2(seed, k, 25)), z + (hash2(seed, k, 26) - 0.5) * 0.1), 0.016, 0.2);
          }
      });
      boxUV(bk, 0, 2);
      const broken = new THREE.Mesh(bk.build(), this.concMat);
      broken.castShadow = shadows;
      broken.visible = false;
      root.add(broken);
      // ---- scaffolding (grows up from the river bed while rebuilding)
      const sc = new GeoBuilder();
      const base = RIVERBED - 0.1;
      const top = BRIDGE_HEIGHT + 0.32 - base;
      const grey = new THREE.Color(0.58, 0.6, 0.62);
      const orange = new THREE.Color(0.95, 0.5, 0.08);
      for (const p of piers) {
        const cs = [V(p - 0.38, 0, -0.62), V(p + 0.38, 0, -0.62), V(p + 0.38, 0, 0.62), V(p - 0.38, 0, 0.62)];
        for (const c of cs) beam(sc, c, c.clone().setY(top), 0.03, grey);
        for (let y = 0.3; y < top; y += 0.32) for (let i = 0; i < 4; i++) beam(sc, cs[i].clone().setY(y), cs[(i + 1) % 4].clone().setY(y), 0.022, i % 2 ? grey : orange);
        for (let y = 0; y + 0.32 < top; y += 0.32) {
          beam(sc, cs[0].clone().setY(y), cs[1].clone().setY(y + 0.32), 0.016, grey);
          beam(sc, cs[2].clone().setY(y), cs[3].clone().setY(y + 0.32), 0.016, grey);
        }
      }
      for (const side of [-1, 1]) {
        const z = side * (W / 2 + 0.14);
        beam(sc, V(-L / 2 + 0.2, top, z), V(L / 2 - 0.2, top, z), 0.03, orange);
        beam(sc, V(-L / 2 + 0.2, top - 0.2, z), V(L / 2 - 0.2, top - 0.2, z), 0.02, grey);
        for (let x = -L / 2 + 0.2; x <= L / 2 - 0.1; x += 0.75) beam(sc, V(x, top - 0.55, z), V(x, top + 0.02, z), 0.024, grey);
      }
      // a couple of work lamps
      for (const p of [piers[0], piers[2]]) box(sc, 0.1, 0.07, 0.07, trs(p, top + 0.08, 0.66), new THREE.Color(1, 0.85, 0.4));
      const scaffold = new THREE.Group();
      const sm = new THREE.Mesh(sc.build(), steel);
      sm.castShadow = shadows;
      scaffold.add(sm);
      scaffold.position.y = base;
      scaffold.visible = false;
      root.add(scaffold);
      // ---- spans between the bank stubs and the piers
      const xs = [-L / 2 + STUB, piers[0], piers[1], piers[2], L / 2 - STUB];
      const order = [2, 1, 3, 0]; // centre spans go first
      const spans: Span[] = [];
      for (let i = 0; i < 4; i++) {
        const x0 = xs[i];
        const x1 = xs[i + 1];
        const len = x1 - x0;
        const cx = (x0 + x1) / 2;
        const s = seed * 31 + i * 7;
        const holed = hash2(s, 1, 30) < (len > 2 ? 0.85 : 0.45);
        const hole: Hole | null = holed
          ? { x: (hash2(s, 2, 31) - 0.5) * (len - 0.8), z: (hash2(s, 3, 32) - 0.5) * 0.7, hx: 0.16 + hash2(s, 4, 33) * 0.14, hz: 0.14 + hash2(s, 5, 34) * 0.14 }
          : null;
        const g = new THREE.Group();
        g.position.set(cx, DECK_Y, 0);
        root.add(g);
        const mk = (dmg: boolean) => {
          const c = new GeoBuilder();
          const t = new GeoBuilder();
          addDeck(c, t, -len / 2, len / 2, new THREE.Matrix4(), cx, s, dmg ? hole : null, dmg, lift);
          const cm = new THREE.Mesh(c.build(), this.concMat);
          cm.castShadow = shadows;
          cm.receiveShadow = true;
          const tm = new THREE.Mesh(t.build(), this.roadMat);
          tm.receiveShadow = true;
          cm.visible = tm.visible = !dmg;
          g.add(cm, tm);
          return [cm, tm];
        };
        const intact = mk(false);
        const damaged = mk(true);
        const tiers = DECAL_TIERS.map((_, k) => {
          const db = new GeoBuilder();
          const n = 1 + Math.round(len * (0.6 + k * 0.4));
          for (let j = 0; j < n; j++) {
            const q = s * 13 + k * 101 + j;
            decal(db, (hash2(q, 1, 40) - 0.5) * (len - 0.2), (hash2(q, 2, 41) - 0.5) * (W - 0.7), 0.106 + k * 0.0015 + j * 0.0002, 0.35 + hash2(q, 3, 42) * (0.35 + k * 0.2), hash2(q, 4, 43) * 6.28, hash2(q, 5, 44) < 0.45 ? 1 : 0);
          }
          warp(db, 0, lift, cx);
          const m = new THREE.Mesh(db.build(), this.decalMat);
          m.visible = false;
          m.renderOrder = 2;
          g.add(m);
          return m;
        });
        const hits = new THREE.Group();
        g.add(hits);
        const hinge = i === 0 ? -1 : i === 3 ? 1 : i === 1 ? (hash2(seed, 1, 50) < 0.5 ? -1 : 0) : hash2(seed, 2, 51) < 0.6 ? 1 : 0;
        const restRz = (hinge === 0 ? (hash2(s, 6, 52) - 0.5) * 0.25 : hinge * (0.22 + hash2(s, 7, 53) * 0.2)) || 0.08;
        spans.push({
          g,
          intact,
          damaged,
          tiers,
          hits,
          cx,
          len,
          hinge,
          delay: order.indexOf(i) * 0.28 + hash2(s, 8, 54) * 0.1,
          hole,
          phase: 'stand',
          a: 0,
          w: 0,
          pos: g.position.clone(),
          prev: g.position.clone(),
          vel: new THREE.Vector3(),
          rz: 0,
          rx: 0,
          wz: 0,
          wx: 0,
          rest: { y: RIVERBED + 0.12 + Math.abs(Math.sin(restRz)) * len * 0.5, rz: restRz, rx: (hash2(s, 9, 55) - 0.5) * 0.3 },
          t: 0,
          splashed: false,
        });
      }
      const v: View = { b, root, spans, broken, scaffold, status: 'intact', t0: 0, lastHitAt: b.hitAt, nHits: 0, hitTier: -1, holed: false, smokeAcc: 0, scafOut: 0, orig: null, lift };
      this.views.push(v);
      if (b.status !== 'intact') this.snapDown(v);
    }
  }

  // ------------------------------------------------------------ approaches

  /**
   * Deck markings carried on from the roads at either end: their look (highway / country road) and
   * the dash phase (the road strip's v at the deck end, running on in the same direction).
   */
  private deckLook(b: BridgeState, L: number) {
    deckUV.u0 = 0.06;
    deckUV.v0 = 0;
    deckUV.dv = 1 / 6;
    const roads = buildLayout(this.world.map).roads;
    const at = (e: { x: number; y: number }) => {
      for (const r of roads) {
        if (r.painted || r.ring) continue;
        const n = r.pts.length;
        for (const k of [0, n - 1]) {
          const p = r.pts[k];
          if (Math.hypot(p.x - e.x, p.y - e.y) > 0.4) continue;
          let len = 0;
          for (let i = 1; i < n; i++) len += Math.hypot(r.pts[i].x - r.pts[i - 1].x, r.pts[i].y - r.pts[i - 1].y);
          const variant = r.taper?.v[k] ?? r.variant;
          // v at the end, and +1 when the road's v grows towards the deck
          return { v: k ? len / 6 : 0, grows: k ? 1 : -1, variant };
        }
      }
      return null;
    };
    const a = at(b.ends[0]);
    const c = at(b.ends[1]);
    const look = a ?? c;
    if (!look) return;
    deckUV.u0 = look.variant === 0 ? 0.06 : 0.56;
    // local x runs from ends[0] (x = -L/2) to ends[1] (x = +L/2): v carries on from the road at ends[0]
    if (a) {
      deckUV.dv = a.grows / 6;
      deckUV.v0 = a.v + (L / 2) * deckUV.dv;
      // and lands in phase with the road at the far end (the dashes repeat every 1/8 of v)
      if (c && c.grows === -a.grows) {
        const vEnd = deckUV.v0 + (L / 2) * deckUV.dv;
        let d = c.v - vEnd;
        d -= Math.round(d * 8) / 8;
        deckUV.dv += d / L;
        deckUV.v0 = a.v + (L / 2) * deckUV.dv;
      }
    } else if (c) {
      deckUV.dv = -c.grows / 6;
      deckUV.v0 = c.v - (L / 2) * deckUV.dv;
    }
  }

  /**
   * One end of a bridge (end = -1 at ends[0], +1 at ends[1], bridge-local x outwards): an expansion
   * joint across the road at the deck end, the deck's kerbs running on and down the ramp, wing walls
   * closing the space under the ramped road, and steel guard rails flaring out and down to the ground.
   */
  private approach(root: THREE.Group, L: number, end: number, conc: GeoBuilder, rails: GeoBuilder, lift: Lift) {
    const m = this.world.map;
    root.updateMatrixWorld(true);
    const toW = (x: number, z: number) => V(x, 0, z).applyMatrix4(root.matrixWorld);
    // height of the road ribbon there (scenery.ts ramps the roads onto the decks: render/deckramp.ts)
    const roadH = (x: number, z: number) => {
      const w = toW(x, z);
      return rampHeight(m, w.x, w.z, surfaceHeight(m, w.x, w.z), 0.03);
    };
    const groundH = (x: number, z: number) => {
      const w = toW(x, z);
      return surfaceHeight(m, w.x, w.z);
    };
    const xe = end * (L / 2);
    const deckTop = DECK_Y + 0.1 + lift(xe);
    // expansion joint: a steel strip with teeth across the whole deck at the end
    box(conc, 0.07, 0.012, W - 0.02, trs(xe - end * 0.03, deckTop + 0.012, 0), 0.24);
    for (let k = 0; k < 12; k++) box(conc, 0.02, 0.013, 0.07, trs(xe - end * 0.03, deckTop + 0.013, -W / 2 + 0.12 + (k / 11) * (W - 0.24)), 0.5);
    // kerbs + wing walls along both sides of the ramp
    const run = 1.6;
    const N = 8;
    for (const side of [-1, 1]) {
      for (let i = 0; i < N; i++) {
        const t0 = i / N;
        const t1 = (i + 1) / N;
        const xa = xe + end * run * t0;
        const xb = xe + end * run * t1;
        // the kerb eases from the sidewalk's edge in to the road's shoulder
        const za = side * (W / 2 - 0.12 - 0.08 * t0);
        const zb = side * (W / 2 - 0.12 - 0.08 * t1);
        const ha = roadH(xa, za);
        const hb = roadH(xb, zb);
        const kh = 0.05 * (1 - t0 * 0.7);
        const mid = V((xa + xb) / 2, (ha + hb) / 2 + kh / 2, (za + zb) / 2);
        const len = Math.hypot(xb - xa, zb - za);
        const pitch = Math.atan2(hb - ha, (xb - xa) * end) * end;
        box(conc, len + 0.02, kh, 0.08, new THREE.Matrix4().compose(mid, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-(zb - za), xb - xa), pitch, 'YXZ')), V(1, 1, 1)), 0.82);
        // wing wall: from under the kerb down into the ground (no daylight under the ramped road)
        const gz = side * (W / 2 - 0.08);
        const ga = Math.min(groundH(xa, gz), ha) - 0.3;
        const gb = Math.min(groundH(xb, gz), hb) - 0.3;
        const wall = new THREE.BufferGeometry();
        const zz = side * (W / 2 - 0.06);
        wall.setAttribute(
          'position',
          new THREE.Float32BufferAttribute([xa, ha, zz, xb, hb, zz, xa, ga, zz, xb, hb, zz, xb, gb, zz, xa, ga, zz, xa, ha, zz, xa, ga, zz, xb, hb, zz, xb, hb, zz, xa, ga, zz, xb, gb, zz], 3),
        );
        wall.computeVertexNormals();
        conc.add(wall, new THREE.Matrix4(), null, 0.7);
      }
      // guard rail: from the parapet end, flaring out and down to an anchor in the ground
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const x = xe + end * 1.3 * t;
        const z = side * (W / 2 - 0.03 + 0.32 * t * t);
        const top = i === 0 ? deckTop + 0.2 : Math.max(groundH(x, z), roadH(x, z) - 0.02) + 0.16 * (1 - t * t * 0.85);
        pts.push(V(x, top, z));
      }
      for (let i = 0; i < pts.length - 1; i++) {
        beam(rails, pts[i], pts[i + 1], 0.035, 0.75);
        beam(rails, pts[i].clone().setY(pts[i].y - 0.045), pts[i + 1].clone().setY(pts[i + 1].y - 0.045), 0.02, 0.7);
      }
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        beam(rails, V(p.x, Math.min(groundH(p.x, p.z), p.y - 0.1) - 0.05, p.z), p, 0.022, 0.45);
      }
    }
  }

  // ------------------------------------------------------------ helpers

  /** World position of a bridge-local point. */
  private toWorld(v: View, x: number, y: number, z: number) {
    return V(x, y, z).applyMatrix4(v.root.matrixWorld);
  }

  /** Occluder map: drop / restore the deck height over this bridge's tiles. */
  private patchWater(v: View, down: boolean) {
    const t = this.waterData;
    if (!t) return;
    const data = t.image.data as Uint8Array;
    const m: GameMap = this.world.map;
    const RES = Math.round(t.image.width / m.w);
    const N = t.image.width;
    if (!v.orig) {
      v.orig = new Uint8Array(v.b.tiles.length * RES * RES);
      let o = 0;
      for (const ti of v.b.tiles) for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) v.orig[o++] = data[(((Math.floor(ti / m.w) * RES + j) * N + (ti % m.w) * RES + i) * 4)];
    }
    let o = 0;
    for (const ti of v.b.tiles) {
      const tx = ti % m.w;
      const ty = Math.floor(ti / m.w);
      for (let j = 0; j < RES; j++)
        for (let i = 0; i < RES; i++) {
          const k = ((ty * RES + j) * N + tx * RES + i) * 4;
          const h = groundHeight(m, tx + (i + 0.5) / RES, ty + (j + 0.5) / RES);
          data[k] = down ? Math.max(0, Math.min(255, ((h + 1.5) / 6) * 255)) : v.orig[o];
          o++;
        }
    }
    t.needsUpdate = true;
  }

  private setVariant(s: Span, damaged: boolean) {
    for (const m of s.intact) m.visible = !damaged;
    for (const m of s.damaged) m.visible = damaged;
  }

  private applyPose(s: Span) {
    s.g.position.copy(s.pos);
    s.g.rotation.set(s.rx, 0, s.rz, 'XYZ');
  }

  private resetSpan(s: Span) {
    s.phase = 'stand';
    s.pos.set(s.cx, DECK_Y, 0);
    s.rz = s.rx = s.wz = s.wx = 0;
    s.vel.set(0, 0, 0);
    s.splashed = false;
    s.g.scale.set(1, 1, 1);
    s.g.visible = true;
    this.applyPose(s);
    for (const m of s.tiers) m.visible = false;
    s.hits.clear();
    this.setVariant(s, false);
  }

  /** Bridge already down when the view is built: wreck at rest, no fanfare. */
  private snapDown(v: View) {
    v.status = v.b.status;
    v.broken.visible = true;
    for (const s of v.spans) {
      s.phase = 'rest';
      this.setVariant(s, true);
      for (const m of s.tiers) m.visible = true;
      s.pos.set(s.cx + s.hinge * -0.25, s.rest.y, 0);
      s.rz = s.rest.rz;
      s.rx = s.rest.rx;
      this.applyPose(s);
    }
    this.patchWater(v, true);
  }

  // ------------------------------------------------------------ per frame

  update(dt: number) {
    this.time += dt;
    for (const v of this.views) {
      const b = v.b;
      if (b.status !== v.status) this.transition(v, b.status);
      v.root.updateMatrixWorld();
      if (b.status === 'intact' && v.status === 'intact') this.updateIntact(v, dt);
      else if (b.status === 'down') this.updateCollapse(v, dt);
      else if (b.status === 'repairing') this.updateRepair(v, dt);
      if (v.scafOut > 0) {
        v.scafOut = Math.max(0, v.scafOut - dt);
        v.scaffold.scale.y = Math.max(0.02, v.scafOut / 1.2);
        if (v.scafOut === 0) v.scaffold.visible = false;
      }
    }
  }

  private transition(v: View, to: BridgeStatus) {
    const from = v.status;
    v.status = to;
    v.t0 = this.time;
    if (to === 'down') {
      this.startCollapse(v);
    } else if (to === 'repairing') {
      v.scaffold.visible = true;
      v.scaffold.scale.y = 0.02;
      v.scafOut = 0;
      for (const s of v.spans) s.t = 0;
    } else if (to === 'intact') {
      for (const s of v.spans) this.resetSpan(s);
      v.broken.visible = false;
      v.hitTier = -1;
      v.holed = false;
      v.nHits = 0;
      v.lastHitAt = v.b.hitAt;
      if (from !== 'intact') {
        this.patchWater(v, false);
        if (v.scaffold.visible) v.scafOut = 1.2;
        const c = this.toWorld(v, 0, BRIDGE_HEIGHT, 0);
        for (let i = 0; i < 6; i++) this.fx.dust(c.x + (Math.random() - 0.5) * 3, c.y + 0.1, c.z + (Math.random() - 0.5) * 3, 1.2);
      }
    }
  }

  /** Progressive damage while standing: decals, holed variant, sag, smoke / fire / dust; impact scorches. */
  private updateIntact(v: View, dt: number) {
    const b = v.b;
    const f = b.hp / b.maxHp;
    let tier = -1;
    for (let k = 0; k < DECAL_TIERS.length; k++) if (f < DECAL_TIERS[k]) tier = k;
    if (tier !== v.hitTier || f < 0.5 !== v.holed) {
      v.hitTier = tier;
      v.holed = f < 0.5;
      for (const s of v.spans) {
        s.tiers.forEach((m, k) => (m.visible = k <= tier));
        this.setVariant(s, v.holed);
      }
    }
    // the centre spans sag once the bridge is close to failing
    const sag = smooth(0.3, 0.1, f);
    for (let i = 1; i <= 2; i++) {
      const s = v.spans[i];
      s.g.rotation.z = (i === 1 ? -1 : 1) * 0.045 * sag;
      s.g.position.y = DECK_Y - 0.04 * sag;
    }
    // fresh impact: scorch decal where it struck + chips flying
    if (b.hitAt !== v.lastHitAt) {
      v.lastHitAt = b.hitAt;
      const dx = b.hitX - v.root.position.x;
      const dz = b.hitY - v.root.position.z;
      const lx = dx * D - dz * D;
      const lz = dx * D + dz * D;
      if (Math.abs(lz) < W / 2 + 0.3) {
        const s = v.spans.find((sp) => lx >= sp.cx - sp.len / 2 && lx <= sp.cx + sp.len / 2);
        if (s && Math.abs(lz) < W / 2 - 0.1) {
          if (s.hits.children.length >= 6) s.hits.remove(s.hits.children[0]);
          const m = new THREE.Mesh(this.hitGeo, this.decalMat);
          m.position.set(lx - s.cx, 0.108 + v.lift(lx) + (v.nHits++ % 8) * 0.0004, lz);
          // lying on the deck, also where it bends up onto a bank
          m.rotation.set(0, Math.random() * 6.28, Math.atan((v.lift(lx + 0.1) - v.lift(lx - 0.1)) / 0.2), 'ZYX');
          m.scale.setScalar(0.5 + Math.random() * 0.35);
          m.renderOrder = 2;
          s.hits.add(m);
        }
        const p = this.toWorld(v, lx, BRIDGE_HEIGHT + 0.05, Math.max(-W / 2, Math.min(W / 2, lz)));
        this.fx.debris?.burst('concrete', p.x, p.y, p.z, 6, 1.6, 0.08, { up: 1.2, smoke: 0.4 });
        this.fx.dust(p.x, p.y, p.z, 1.1);
        // chunks dropping into the river below
        if (f < 0.6) this.fx.splash(p.x + (Math.random() - 0.5) * 0.4, WATER_LEVEL, p.z + (Math.random() - 0.5) * 0.4, 0.45);
      }
    }
    // smoke and fire from the holes; dust and grit trickling into the water
    if (f < 0.5) {
      v.smokeAcc += dt * (f < 0.25 ? 5 : 2);
      while (v.smokeAcc >= 1) {
        v.smokeAcc -= 1;
        const s = v.spans[Math.floor(Math.random() * 4)];
        const hx = s.hole ? s.cx + s.hole.x : s.cx + (Math.random() - 0.5) * s.len;
        const hz = s.hole ? s.hole.z : (Math.random() - 0.5) * W;
        const p = this.toWorld(v, hx, BRIDGE_HEIGHT + 0.05, hz);
        this.fx.smoke(p.x, p.y, p.z, f < 0.25 ? 1 : 0.6, true);
        if (f < 0.25 && s.hole && Math.random() < 0.5) {
          this.fx.flame(p.x, p.y + 0.02, p.z, 0.5);
          this.fx.burnGlow(p.x, p.y, p.z, 1.2);
        }
        if (Math.random() < 0.5) {
          const u = this.toWorld(v, hx, DECK_Y - 0.15, hz);
          this.fx.dust(u.x, u.y, u.z, 0.5);
        }
      }
    }
  }

  private startCollapse(v: View) {
    v.broken.visible = true;
    this.patchWater(v, true);
    const L = v.b.length;
    // demolition: charges of rubble blow at every support, staggered
    const pts = [-L / 2 + STUB, -L / 2 + 1.5, 0, L / 2 - 1.5, L / 2 - STUB];
    pts.forEach((x, i) => {
      const p = this.toWorld(v, x, BRIDGE_HEIGHT, (Math.random() - 0.5) * 0.6);
      this.fx.after(Math.abs(i - 2) * 0.12 + Math.random() * 0.08, () => {
        this.fx.blast(i === 2 ? BLASTS.bigVehicle : BLASTS.vehicle, p.x, p.y, p.z, WATER_LEVEL);
        this.fx.debris?.burst('concrete', p.x, p.y, p.z, 8, 2.6, 0.09, { up: 2, smoke: 0.6, spread: 0.5 });
      });
    });
    const c = this.toWorld(v, 0, BRIDGE_HEIGHT, 0);
    this.fx.addShake(0.6, c.x, c.z);
    this.fx.flashLight(c.x, c.y + 1, c.z, 14, 0xffb060, 0.7);
    for (const s of v.spans) {
      this.setVariant(s, true);
      for (const m of s.tiers) m.visible = true;
      s.phase = 'wait';
      s.t = 0;
      s.a = 0;
      s.w = 0;
      s.pos.copy(s.g.position);
      s.rz = s.g.rotation.z;
      s.rx = 0;
      s.splashed = false;
    }
  }

  /** Span ends in bridge-local coordinates (for splashes / contact). */
  private lowPoint(s: Span) {
    const h = s.len / 2;
    const c = Math.cos(s.rz);
    const sn = Math.sin(s.rz);
    // ends of the slab centreline after pitch about z
    const yA = s.pos.y - sn * h;
    const yB = s.pos.y + sn * h;
    return { y: Math.min(yA, yB) - 0.1, x: yA < yB ? s.pos.x - c * h : s.pos.x + c * h };
  }

  private updateCollapse(v: View, dt: number) {
    if (dt <= 0) return;
    const age = this.time - v.t0;
    for (const s of v.spans) {
      s.t += dt;
      s.prev.copy(s.pos);
      switch (s.phase) {
        case 'wait':
          // shudder before letting go
          s.pos.set(s.cx + (Math.random() - 0.5) * 0.02, DECK_Y + (Math.random() - 0.5) * 0.015, 0);
          if (age >= s.delay) {
            s.phase = s.hinge === 0 ? 'fall' : 'hinge';
            s.vel.set(0, -0.2, 0);
            s.wx = (Math.random() - 0.5) * 0.6;
            s.wz = s.hinge === 0 ? (Math.random() - 0.5) * 0.5 : 0;
            const ex = s.cx + (s.hinge === 0 ? 0 : -s.hinge * s.len * 0.5);
            const p = this.toWorld(v, ex, DECK_Y, 0);
            this.fx.debris?.burst('concrete', p.x, p.y, p.z, 10, 1.8, 0.093, { up: 0.6, smoke: 0.6, spread: 1 });
            this.fx.dust(p.x, p.y, p.z, 1.6);
          }
          break;
        case 'hinge': {
          // pivot about the supported end; the free end drops
          s.w += (GRAV / (s.len * 0.5)) * Math.cos(s.a) * dt * 0.9;
          s.a += s.w * dt;
          const px = s.cx + s.hinge * s.len * 0.5;
          const ang = s.hinge * s.a;
          s.rz = ang;
          s.pos.set(px - s.hinge * s.len * 0.5 * Math.cos(ang), DECK_Y - s.hinge * s.len * 0.5 * Math.sin(ang), 0);
          if (s.a > 0.42) {
            // tears away from the support
            s.phase = 'fall';
            s.vel.subVectors(s.pos, s.prev).divideScalar(dt);
            s.wz = s.hinge * s.w * 0.8;
            const p = this.toWorld(v, px, DECK_Y, 0);
            this.fx.debris?.burst('concrete', p.x, p.y, p.z, 8, 1.4, 0.08, { up: 0.4, smoke: 0.5 });
            for (let k = 0; k < 3; k++) this.fx.spark(p.x + (Math.random() - 0.5) * 0.6, p.y, p.z + (Math.random() - 0.5) * 0.6, 0xffc070);
          }
          break;
        }
        case 'fall': {
          s.vel.y -= GRAV * dt;
          s.pos.addScaledVector(s.vel, dt);
          s.rz += s.wz * dt;
          s.rx += s.wx * dt;
          const lp = this.lowPoint(s);
          if (lp.y <= WATER_LEVEL) {
            s.phase = 'settle';
            s.t = 0;
            s.vel.multiplyScalar(0.25);
            if (Math.sign(s.rz) && Math.sign(s.rest.rz) !== Math.sign(s.rz)) s.rest.rz = -s.rest.rz;
            // the big splash along the span, spray, debris
            for (let k = 0; k < 2; k++) {
              const lx = s.pos.x + (k - 0.5) * s.len * 0.6;
              const p = this.toWorld(v, lx, WATER_LEVEL, (Math.random() - 0.5) * 0.8);
              this.fx.after(k * 0.07, () => this.fx.splash(p.x, WATER_LEVEL, p.z, 1.5 + Math.random() * 0.4));
            }
            const p = this.toWorld(v, lp.x, WATER_LEVEL, 0);
            this.fx.debris?.burst('concrete', p.x, WATER_LEVEL + 0.1, p.z, 6, 2, 0.08, { up: 1.4, spread: 0.6 });
            this.fx.addShake(0.25, p.x, p.z);
          }
          break;
        }
        case 'settle': {
          // water drag: ease into the resting pose on the river bed
          const k = 1 - Math.exp(-dt * 2.2);
          s.pos.x += s.vel.x * dt;
          s.vel.multiplyScalar(Math.exp(-dt * 3));
          s.pos.y += (s.rest.y - s.pos.y) * k;
          s.rz += (s.rest.rz - s.rz) * k;
          s.rx += (s.rest.rx - s.rx) * k;
          if (Math.random() < dt * 1.2 && s.t < 2.5) {
            // churned water / foam around the sinking slab
            const p = this.toWorld(v, s.pos.x + (Math.random() - 0.5) * s.len, WATER_LEVEL, (Math.random() - 0.5) * W);
            this.fx.smoke(p.x, WATER_LEVEL + 0.05, p.z, 0.7, false);
          }
          if (s.t > 4) s.phase = 'rest';
          break;
        }
        default:
          break;
      }
      this.applyPose(s);
    }
    // dust cloud over the gap, then smoke lingering from the stumps for a while
    if (age < 2.2 && Math.random() < dt * 14) {
      const p = this.toWorld(v, (Math.random() - 0.5) * v.b.length, BRIDGE_HEIGHT - Math.random() * 0.6, (Math.random() - 0.5) * W * 1.5);
      this.fx.dust(p.x, p.y, p.z, 2 + Math.random());
    }
    const linger = Math.max(0, 1 - age / 40);
    if (linger > 0 && Math.random() < dt * 3.5 * linger) {
      const L = v.b.length;
      const xs = [-L / 2 + STUB, L / 2 - STUB, -L / 2 + 1.5, 0, L / 2 - 1.5];
      const x = xs[Math.floor(Math.random() * xs.length)];
      const p = this.toWorld(v, x, BRIDGE_HEIGHT, (Math.random() - 0.5) * W);
      if (Math.random() < 0.5) this.fx.column(p.x, p.y, p.z, 0.8 + linger * 0.6, true);
      else this.fx.smoke(p.x, p.y, p.z, 1 + linger, true);
      if (age < 9 && Math.random() < 0.4) this.fx.flame(p.x, p.y, p.z, 0.5);
    }
  }

  /** Rebuild: wreck sinks away, scaffolding rises, spans are re-cast from the banks. */
  private updateRepair(v: View, dt: number) {
    const b = v.b;
    const p = Math.min(1, b.repairT / BRIDGE_REPAIR_TICKS);
    v.scaffold.visible = true;
    v.scaffold.scale.y = Math.max(0.02, smooth(0, 0.18, p));
    const order = [0, 3, 1, 2]; // from the banks inwards
    for (let i = 0; i < 4; i++) {
      const s = v.spans[i];
      const k0 = 0.2 + order.indexOf(i) * 0.19;
      const k = smooth(k0, k0 + 0.19, p);
      if (k <= 0) {
        // the wreck sinks away under the work
        if (s.phase !== 'sink' && s.phase !== 'build') s.phase = 'sink';
        if (s.phase === 'sink') {
          s.pos.y = Math.max(RIVERBED - 1.2, s.pos.y - dt * 0.5);
          this.applyPose(s);
          if (s.pos.y <= RIVERBED - 1.15) s.g.visible = false;
        }
        continue;
      }
      if (s.phase !== 'build') {
        s.phase = 'build';
        s.g.visible = true;
        this.setVariant(s, false);
        for (const m of s.tiers) m.visible = false;
        s.hits.clear();
        s.rz = s.rx = 0;
      }
      // grows out from the support nearer the bank it is built from
      const from = i < 2 ? -1 : 1;
      const end = s.cx + from * s.len * 0.5;
      s.g.scale.set(Math.max(0.02, k), 1, 1);
      s.pos.set(end - from * s.len * 0.5 * k, DECK_Y, 0);
      this.applyPose(s);
      if (k < 1 && dt > 0 && Math.random() < dt * 18) {
        const q = this.toWorld(v, end - from * s.len * k, DECK_Y, (Math.random() - 0.5) * W);
        this.fx.spark(q.x, q.y, q.z, Math.random() < 0.5 ? 0xffe0a0 : 0x9fd0ff);
        if (Math.random() < 0.25) this.fx.dust(q.x, q.y - 0.1, q.z, 0.6);
      }
    }
  }
}
