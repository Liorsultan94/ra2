import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { groundY } from '../landmarks/ground';
import { landmarkMaterial } from '../landmarks/material';
import { civSound } from '../landmarks/sound';
import { HELI_HUB, airliner, heliBody, heliRotor, lightPlane } from '../models/landmarks-vehicles';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from './shared';

/*
 * Civilian air traffic (render only, never near the sim):
 *
 *  - airliners crossing high over the map now and then, leaving a pair of
 *    contrails that spread and fade (a distant jet whine as they pass);
 *  - a news helicopter that turns up when a big battle is raging, circles it
 *    at a respectful distance (above and wider than any military aircraft
 *    nearby, it climbs away from them) with its camera on the action, and
 *    leaves when things calm down;
 *  - a light plane pottering over the countryside;
 *  - Canal City: an air ambulance visiting the hospital's rooftop helipad.
 *
 * Distinct from the military: civilian liveries (white / blue / red), steady
 * navigation lights (red / green wingtips, a white strobe) instead of combat
 * markings, and they stay out of the low airspace the military fly in.
 * Draw calls: one instanced mesh per aircraft type on screen (+1 for the
 * rotors, +1 for the contrails while one is alive). Low quality: none.
 */

const ALT_JET = 13.5;
/**
 * Contrails hang at a fixed altitude high in the sky, above any game camera (the RTS camera never sees
 * them; a low photo / cinematic view sees them up in the sky, thin, fading with distance). They never
 * come near the ground, so they can't read as roads or bars across the map.
 */
const ALT_SKY = 78;
/** Airliner altitude / scale this frame (follows the camera height, smoothed; at ALT_SKY when the view looks out at the sky). */
let jetAlt = ALT_JET;
let jetScale = 1;
let jetSky = false;
const ALT_NEWS = 4.6;
const ALT_PLANE = 5.4;
const TRAIL_N = 64;

interface Jet {
  on: boolean;
  x: number;
  y: number;
  dx: number;
  dy: number;
  v: number;
  t: number;
  life: number;
  heard: boolean;
  trailT: number;
  /** Ring buffer of contrail points: x, z, age. */
  pts: Float32Array;
  n: number;
  head: number;
}

interface Heli {
  on: boolean;
  /** 0 inbound, 1 orbit / hover, 2 landing, 3 on the pad, 4 take-off, 5 outbound. */
  st: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  t: number;
  ang: number;
  r: number;
  rot: number;
  soundT: number;
  ambulance: boolean;
  tx: number;
  ty: number;
  tz: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

export class AirTraffic {
  readonly group = new THREE.Group();
  private jets: Jet[] = [];
  private jetIm: THREE.InstancedMesh | null = null;
  private trail: THREE.Mesh | null = null;
  private trailPos: Float32Array | null = null;
  private trailA: Float32Array | null = null;
  private newsIm: THREE.InstancedMesh | null = null;
  private ambIm: THREE.InstancedMesh | null = null;
  private rotorIm: THREE.InstancedMesh | null = null;
  private planeIm: THREE.InstancedMesh | null = null;
  private news: Heli;
  private amb: Heli;
  private plane = { on: false, x: 0, y: 0, yaw: 0, t: 0, wait: 40, turn: 0.12, life: 0 };
  private jetWait = 25;
  private ambWait = 70;
  /** Battle heat: decayed sum of blast power and its centroid. */
  private heat = 0;
  private hx = 0;
  private hy = 0;
  private time = 0;
  private enabled: boolean;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
    private helipad: { x: number; y: number; z: number } | null,
    /** The view camera (airliners fly at a fraction of its height so they read as high and small). */
    private cam: () => THREE.Camera | undefined = () => undefined,
  ) {
    this.group.name = 'air-traffic';
    this.news = newHeli(false);
    this.amb = newHeli(true);
    this.enabled = quality !== 'low';
    if (!this.enabled) return;
    const mat = landmarkMaterial(fog);
    const mk = (geo: THREE.BufferGeometry, n: number, name: string) => {
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.name = name;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      im.visible = false;
      this.group.add(im);
      return im;
    };
    this.jetIm = mk(airliner(), 2, 'airliners');
    this.newsIm = mk(heliBody(false), 1, 'news-heli');
    if (helipad) this.ambIm = mk(heliBody(true), 1, 'air-ambulance');
    this.rotorIm = mk(heliRotor(), 2, 'heli-rotors');
    this.planeIm = mk(lightPlane(), 1, 'light-plane');
    for (let i = 0; i < 2; i++) this.jets.push({ on: false, x: 0, y: 0, dx: 1, dy: 0, v: 7, t: 0, life: 0, heard: false, trailT: 0, pts: new Float32Array(TRAIL_N * 3), n: 0, head: 0 });
    // contrails: two ribbons per jet, a quad per segment
    const maxQ = 2 * 2 * (TRAIL_N - 1);
    this.trailPos = new Float32Array(maxQ * 6 * 3);
    this.trailA = new Float32Array(maxQ * 6 * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aT', new THREE.BufferAttribute(this.trailA, 2).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const tm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uNight: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec2 aT;
        varying vec2 vT;
        varying float vFade;
        void main() {
          vT = aT;
          // thin out with distance (and never in the camera's face)
          float dist = length( position - cameraPosition );
          vFade = smoothstep( 520.0, 260.0, dist ) * smoothstep( 25.0, 60.0, dist );
          gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying vec2 vT;
        varying float vFade;
        void main() {
          // vT.x: age 0..1, vT.y: across -1..1
          float edge = 1.0 - vT.y * vT.y;
          float a = edge * ( 1.0 - vT.x ) * smoothstep( 0.0, 0.04, vT.x ) * 0.42 * vFade;
          if ( a < 0.003 ) discard;
          vec3 c = mix( vec3( 0.97, 0.97, 1.0 ), vec3( 0.32, 0.34, 0.4 ), uNight );
          gl_FragColor = vec4( c, a );
        }`,
    });
    this.trail = new THREE.Mesh(g, tm);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 6;
    this.trail.name = 'contrails';
    this.group.add(this.trail);
  }

  /** A blast (ambient danger scale): feeds the battle heat that brings the news helicopter. */
  blast(x: number, y: number, kill: number) {
    const w = kill;
    const tot = this.heat + w;
    this.hx = (this.hx * this.heat + x * w) / tot;
    this.hy = (this.hy * this.heat + y * w) / tot;
    this.heat = tot;
  }

  update(f: AmbientFrame) {
    if (!this.enabled) return;
    const dt = f.dt;
    this.time += dt;
    this.heat *= Math.exp(-dt / 25);
    this.updateJets(f);
    this.updateNews(f);
    this.updateAmbulance(f);
    this.updatePlane(f);
    this.drawHelis(f);
  }

  // ---------------------------------------------------------------- airliners

  private updateJets(f: AmbientFrame) {
    const dt = f.dt;
    const m = this.map;
    this.jetWait -= dt;
    if (this.jetWait <= 0) {
      const j = this.jets.find((o) => !o.on);
      if (j) {
        // a straight route across the map (and the sky beyond), passing within ~35 tiles of the centre
        const a = Math.random() * Math.PI * 2;
        const off = (Math.random() - 0.5) * 70;
        j.dx = Math.cos(a);
        j.dy = Math.sin(a);
        const cx = m.w / 2 - j.dy * off;
        const cy = m.h / 2 + j.dx * off;
        j.x = cx - j.dx * 150;
        j.y = cy - j.dy * 150;
        j.v = 6.5 + Math.random() * 1.5;
        j.t = 0;
        j.life = 300 / j.v;
        j.on = true;
        j.heard = false;
        j.n = 0;
        j.head = 0;
        j.trailT = 0;
      }
      this.jetWait = 55 + Math.random() * 70;
    }
    // fly at ~55 % of the camera height, drawn smaller the closer to the camera: a distant airliner, never a giant;
    // a view looking out at the sky (photo / cinematic cameras) sees it up at its contrails' altitude instead
    const cam = this.cam();
    const cy0 = Math.max(8, cam?.position.y ?? 30);
    let sky = false;
    if (cam) {
      cam.getWorldDirection(_p);
      sky = _p.y > -0.42;
    }
    if (sky !== jetSky) {
      jetSky = sky;
      jetAlt = sky ? ALT_SKY : Math.max(5.5, Math.min(ALT_JET, cy0 * 0.55));
    }
    const alt = sky ? ALT_SKY : Math.max(5.5, Math.min(ALT_JET, cy0 * 0.55));
    jetAlt += (alt - jetAlt) * Math.min(1, dt * 0.5);
    jetScale = sky ? 3.4 : Math.max(0.3, Math.min(1, ((cy0 - jetAlt) / cy0) * 0.95));
    const ALT = jetAlt;
    const SC = jetScale;
    const im = this.jetIm!;
    let n = 0;
    let q = 0;
    const P = this.trailPos!;
    const A = this.trailA!;
    const cx = (f.vx0 + f.vx1) / 2;
    const cy = (f.vy0 + f.vy1) / 2;
    for (const j of this.jets) {
      if (!j.on) continue;
      j.t += dt;
      j.x += j.dx * j.v * dt;
      j.y += j.dy * j.v * dt;
      // contrail points every 0.4 s, aging out over ~24 s
      j.trailT -= dt;
      if (j.trailT <= 0 && j.t < j.life - 4) {
        j.trailT = 0.4;
        const k = j.head;
        j.pts[k * 3] = j.x - j.dx * 1.1;
        j.pts[k * 3 + 1] = j.y - j.dy * 1.1;
        j.pts[k * 3 + 2] = this.time;
        j.head = (j.head + 1) % TRAIL_N;
        j.n = Math.min(TRAIL_N, j.n + 1);
      }
      if (j.t > j.life + 26) {
        j.on = false;
        continue;
      }
      if (!j.heard && Math.hypot(j.x - cx, j.y - cy) < 26) {
        j.heard = true;
        civSound('jetHigh', 0.8, j.x, j.y, ALT);
      }
      if (j.t < j.life && j.x > f.vx0 - 40 && j.x < f.vx1 + 40 && j.y > f.vy0 - 40 && j.y < f.vy1 + 40) {
        _q.setFromEuler(_e.set(0, -Math.atan2(j.dy, j.dx), 0, 'YXZ'));
        _m.compose(_p.set(j.x, ALT, j.y), _q, _s.set(SC, SC, SC));
        _s.set(1, 1, 1);
        im.setMatrixAt(n++, _m);
        // navigation lights: red / green wingtips, white strobe
        const nx = -j.dy;
        const ny = j.dx;
        const k = 0.5 + f.dark;
        this.lights.flare(j.x - j.dx * 0.25 * SC + nx * 1.05 * SC, ALT, j.y - j.dy * 0.25 * SC + ny * 1.05 * SC, 0.14, 0.2 * k, 1.6 * k, 0.4 * k);
        this.lights.flare(j.x - j.dx * 0.25 * SC - nx * 1.05 * SC, ALT, j.y - j.dy * 0.25 * SC - ny * 1.05 * SC, 0.14, 1.8 * k, 0.15 * k, 0.1 * k);
        if ((this.time * 1.2) % 1 < 0.08) this.lights.flare(j.x - j.dx * 1.2, ALT + 0.35, j.y - j.dy * 1.2, 0.3, 2.5, 2.5, 2.5);
      }
      // contrail quads (two trails, one per engine pair)
      const nx = -j.dy;
      const ny = j.dx;
      for (let i = 0; i < j.n - 1; i++) {
        const a = (j.head - 1 - i + TRAIL_N * 2) % TRAIL_N;
        const b = (j.head - 2 - i + TRAIL_N * 2) % TRAIL_N;
        const ageA = (this.time - j.pts[a * 3 + 2]) / 24;
        const ageB = (this.time - j.pts[b * 3 + 2]) / 24;
        if (ageA >= 1) break;
        // thin trails that spread as they age, at the fixed sky altitude (contrail world units, not the jet's scale)
        const wA = 0.22 + ageA * 1.9;
        const wB = 0.22 + Math.min(1, ageB) * 1.9;
        for (const side of [-0.9, 0.9]) {
          const ax = j.pts[a * 3] + nx * side * (1 + ageA * 0.8);
          const ay = j.pts[a * 3 + 1] + ny * side * (1 + ageA * 0.8);
          const bx = j.pts[b * 3] + nx * side * (1 + ageB * 0.8);
          const by = j.pts[b * 3 + 1] + ny * side * (1 + ageB * 0.8);
          const h = ALT_SKY - ageA * 1.5;
          const verts = [
            [ax - nx * wA, h, ay - ny * wA, ageA, -1],
            [ax + nx * wA, h, ay + ny * wA, ageA, 1],
            [bx + nx * wB, h, by + ny * wB, Math.min(1, ageB), 1],
            [ax - nx * wA, h, ay - ny * wA, ageA, -1],
            [bx + nx * wB, h, by + ny * wB, Math.min(1, ageB), 1],
            [bx - nx * wB, h, by - ny * wB, Math.min(1, ageB), -1],
          ];
          for (const v of verts) {
            P[q * 3] = v[0];
            P[q * 3 + 1] = v[1];
            P[q * 3 + 2] = v[2];
            A[q * 2] = v[3];
            A[q * 2 + 1] = v[4];
            q++;
          }
        }
      }
    }
    im.count = n;
    im.visible = n > 0;
    if (n) im.instanceMatrix.needsUpdate = true;
    const tr = this.trail!;
    tr.geometry.setDrawRange(0, q);
    tr.visible = q > 0;
    (tr.material as THREE.ShaderMaterial).uniforms.uNight.value = f.dark;
    if (q) {
      const pa = tr.geometry.attributes.position as THREE.BufferAttribute;
      const aa = tr.geometry.attributes.aT as THREE.BufferAttribute;
      pa.clearUpdateRanges();
      pa.addUpdateRange(0, q * 3);
      pa.needsUpdate = true;
      aa.clearUpdateRanges();
      aa.addUpdateRange(0, q * 2);
      aa.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- helicopters

  /** Clear of the military: climb and widen when an aircraft is close. */
  private militaryNear(f: AmbientFrame, x: number, y: number, r: number): boolean {
    for (let i = 0; i < f.nAir; i++) if (Math.hypot(f.air[i * 2] - x, f.air[i * 2 + 1] - y) < r) return true;
    return false;
  }

  private edgeEntry(tx: number, ty: number) {
    // come in from the nearest side, from well outside the map
    const m = this.map;
    const d = [tx, ty, m.w - tx, m.h - ty];
    const k = d.indexOf(Math.min(...d));
    const out = 26;
    return k === 0 ? { x: -out, y: ty } : k === 1 ? { x: tx, y: -out } : k === 2 ? { x: m.w + out, y: ty } : { x: tx, y: m.h + out };
  }

  private updateNews(f: AmbientFrame) {
    const H = this.news;
    const dt = f.dt;
    if (!H.on) {
      if (this.heat > 7) {
        const e = this.edgeEntry(this.hx, this.hy);
        Object.assign(H, { on: true, st: 0, x: e.x, y: e.y, z: ALT_NEWS + 1, t: 0, ang: Math.atan2(e.y - this.hy, e.x - this.hx), r: 7 });
      }
      return;
    }
    H.t += dt;
    const busy = this.militaryNear(f, H.x, H.y, 4.5);
    const r = busy ? 9.5 : 7;
    const alt = busy ? ALT_NEWS + 2.2 : ALT_NEWS;
    H.r += (r - H.r) * Math.min(1, dt * 0.4);
    if (H.st === 0) {
      // inbound to the orbit
      const ox = this.hx + Math.cos(H.ang) * H.r;
      const oy = this.hy + Math.sin(H.ang) * H.r;
      this.flyTo(H, ox, oy, alt, 3.2, dt);
      if (Math.hypot(ox - H.x, oy - H.y) < 1) H.st = 1;
    } else if (H.st === 1) {
      // circle the battle, nose (camera) towards the action
      H.ang += (dt * 0.9) / H.r;
      const ox = this.hx + Math.cos(H.ang) * H.r;
      const oy = this.hy + Math.sin(H.ang) * H.r;
      H.x += (ox - H.x) * Math.min(1, dt * 1.5);
      H.y += (oy - H.y) * Math.min(1, dt * 1.5);
      H.z += (alt - H.z) * Math.min(1, dt * 0.8);
      H.yaw = turn(H.yaw, Math.atan2(this.hy - H.y, this.hx - H.x) - 0.5, dt * 1.2);
      if (this.heat < 1.5 && H.t > 40) {
        const e = this.edgeEntry(H.x, H.y);
        H.st = 5;
        H.tx = e.x;
        H.ty = e.y;
      }
    } else {
      this.flyTo(H, H.tx, H.ty, alt + 1.5, 3.6, dt);
      if (Math.hypot(H.tx - H.x, H.ty - H.y) < 2) H.on = false;
    }
    H.rot += dt * 32;
  }

  private flyTo(H: Heli, tx: number, ty: number, tz: number, v: number, dt: number) {
    const dx = tx - H.x;
    const dy = ty - H.y;
    const d = Math.hypot(dx, dy) || 1;
    const s = Math.min(d, v * dt);
    H.x += (dx / d) * s;
    H.y += (dy / d) * s;
    H.z += (tz - H.z) * Math.min(1, dt * 0.8);
    H.yaw = turn(H.yaw, Math.atan2(dy, dx), dt * 1.5);
    H.vx = (dx / d) * v;
    H.vy = (dy / d) * v;
  }

  private updateAmbulance(f: AmbientFrame) {
    const pad = this.helipad;
    const H = this.amb;
    if (!pad || !this.ambIm) return;
    const dt = f.dt;
    if (!H.on) {
      this.ambWait -= dt;
      if (this.ambWait <= 0) {
        const e = { x: pad.x - 40, y: pad.y + (Math.random() - 0.5) * 60 };
        Object.assign(H, { on: true, st: 0, x: e.x, y: e.y, z: pad.y + 4, t: 0 });
        this.ambWait = 110 + Math.random() * 70;
      }
      return;
    }
    H.t += dt;
    H.rot += dt * (H.st === 3 ? (H.t < 3 ? 32 * (1 - H.t / 3) : 0) : 32);
    if (H.st === 0) {
      this.flyTo(H, pad.x, pad.z, pad.y + 2.2, 3.4, dt);
      if (Math.hypot(pad.x - H.x, pad.z - H.y) < 0.15) H.st = 2;
    } else if (H.st === 2) {
      H.z = Math.max(pad.y + 0.24, H.z - dt * 0.7);
      if (H.z <= pad.y + 0.241) {
        H.st = 3;
        H.t = 0;
      }
    } else if (H.st === 3) {
      if (H.t > 16) {
        H.st = 4;
        H.t = 0;
      }
    } else if (H.st === 4) {
      H.z += dt * 0.8;
      if (H.z > pad.y + 2.5) {
        H.st = 5;
        H.tx = pad.x - 40;
        H.ty = pad.z + (Math.random() - 0.5) * 60;
      }
    } else if (H.st === 5) {
      this.flyTo(H, H.tx, H.ty, pad.y + 4, 3.6, dt);
      if (Math.hypot(H.tx - H.x, H.ty - H.y) < 2) H.on = false;
    }
  }

  private drawHelis(f: AmbientFrame) {
    const rot = this.rotorIm!;
    let nr = 0;
    for (const [H, im] of [
      [this.news, this.newsIm],
      [this.amb, this.ambIm],
    ] as const) {
      if (!im) continue;
      const vis = H.on && H.x > f.vx0 - 8 && H.x < f.vx1 + 8 && H.y > f.vy0 - 8 && H.y < f.vy1 + 8;
      im.visible = vis;
      im.count = vis ? 1 : 0;
      if (!vis) continue;
      // nose down a little in forward flight
      const fwd = H.st === 0 || H.st === 5 ? 0.12 : 0.03;
      _q.setFromEuler(_e.set(Math.sin(this.time * 0.7) * 0.03, -H.yaw, -fwd, 'YXZ'));
      _m.compose(_p.set(H.x, H.z, H.y), _q, _s);
      im.setMatrixAt(0, _m);
      im.instanceMatrix.needsUpdate = true;
      _p.set(HELI_HUB.x, HELI_HUB.y, 0).applyMatrix4(_m);
      _q.setFromEuler(_e.set(0, H.rot, 0));
      _m.compose(_p, _q, _s);
      rot.setMatrixAt(nr++, _m);
      const dk = f.dark;
      const k = 0.4 + dk * 1.4;
      if (Math.sin(this.time * 6) > 0.6) this.lights.flare(H.x, H.z - 0.12, H.y, 0.1, 2 * k, 0.2 * k, 0.15 * k);
      if (!H.ambulance && dk > 0.15 && H.st === 1) {
        // the camera team's spotlight on the battle
        this.lights.pool(this.hx, groundY(this.map, this.hx, this.hy), this.hy, 0, 2.6, 2.6, 0.35 * dk, 0.35 * dk, 0.3 * dk);
      }
      H.soundT -= f.dt;
      if (H.soundT <= 0 && this.probe.visible(H.x, H.y)) {
        H.soundT = 2.6;
        civSound('heliPass', H.ambulance && H.st === 3 ? 0.3 : 0.75, H.x, H.y, H.z);
      }
    }
    rot.count = nr;
    rot.visible = nr > 0;
    if (nr) rot.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- light plane

  private updatePlane(f: AmbientFrame) {
    const P = this.plane;
    const im = this.planeIm!;
    const dt = f.dt;
    const m = this.map;
    if (!P.on) {
      P.wait -= dt;
      im.visible = false;
      if (P.wait <= 0) {
        // over the countryside: away from the battle heat
        const a = Math.random() * Math.PI * 2;
        P.x = m.w / 2 + Math.cos(a) * 90;
        P.y = m.h / 2 + Math.sin(a) * 90;
        P.yaw = a + Math.PI + (Math.random() - 0.5) * 0.6;
        P.turn = (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.08);
        P.t = 0;
        P.life = 70;
        P.on = true;
        P.wait = 80 + Math.random() * 60;
      }
      return;
    }
    P.t += dt;
    // a lazy turn over the middle of its flight, then off
    if (P.t > 20 && P.t < 45) P.yaw += P.turn * dt;
    // keep clear of the military and the battle
    if (this.militaryNear(f, P.x, P.y, 6) || (this.heat > 4 && Math.hypot(P.x - this.hx, P.y - this.hy) < 14)) P.yaw += dt * 0.5;
    P.x += Math.cos(P.yaw) * 2.6 * dt;
    P.y += Math.sin(P.yaw) * 2.6 * dt;
    if (P.t > P.life) P.on = false;
    const vis = P.x > f.vx0 - 8 && P.x < f.vx1 + 8 && P.y > f.vy0 - 8 && P.y < f.vy1 + 8;
    im.visible = vis;
    im.count = vis ? 1 : 0;
    if (!vis) return;
    const bank = P.t > 20 && P.t < 45 ? -P.turn * 3 : 0;
    _q.setFromEuler(_e.set(bank, -P.yaw, 0, 'YXZ'));
    _m.compose(_p.set(P.x, ALT_PLANE, P.y), _q, _s);
    im.setMatrixAt(0, _m);
    im.instanceMatrix.needsUpdate = true;
    const k = 0.4 + f.dark * 1.3;
    const nx = -Math.sin(P.yaw);
    const ny = Math.cos(P.yaw);
    this.lights.flare(P.x + nx * 0.5, ALT_PLANE + 0.09, P.y + ny * 0.5, 0.09, 0.2 * k, 1.5 * k, 0.4 * k);
    this.lights.flare(P.x - nx * 0.5, ALT_PLANE + 0.09, P.y - ny * 0.5, 0.09, 1.7 * k, 0.15 * k, 0.1 * k);
  }

  /** Debug: bring an airliner / the news helicopter / the light plane in now. */
  debugSpawn(what: 'jet' | 'news' | 'plane' | 'ambulance', x?: number, y?: number) {
    if (what === 'jet') this.jetWait = 0;
    if (what === 'news') {
      this.heat = 12;
      this.hx = x ?? this.map.w / 2;
      this.hy = y ?? this.map.h / 2;
    }
    if (what === 'plane') this.plane.wait = 0;
    if (what === 'ambulance') this.ambWait = 0;
  }

  /** Debug / tests. */
  stats() {
    return { jets: this.jets.filter((j) => j.on).map((j) => ({ x: +j.x.toFixed(1), y: +j.y.toFixed(1), n: j.n })), news: { on: this.news.on, st: this.news.st, x: +this.news.x.toFixed(1), y: +this.news.y.toFixed(1) }, amb: { on: this.amb.on, st: this.amb.st }, plane: { on: this.plane.on, x: +this.plane.x.toFixed(1), y: +this.plane.y.toFixed(1) }, heat: +this.heat.toFixed(2) };
  }
}

function newHeli(ambulance: boolean): Heli {
  return { on: false, st: 0, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, t: 0, ang: 0, r: 7, rot: 0, soundT: 0, ambulance, tx: 0, ty: 0, tz: 0 };
}

function turn(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + Math.max(-k, Math.min(k, d));
}
