import * as THREE from 'three';
import { standHeight } from '../sim/map';
import type { GameMap } from '../sim/map';

/**
 * Ground-hugging combat UI drawn in the 3D scene: holographic selection
 * rings / building brackets, hover highlight and animated order markers
 * (move chevrons, attack reticle, attack-move, rally beacon).
 *
 * Everything is a flat quad with a small procedural shader, tilted to the
 * terrain normal under it. Animation runs on real time so it keeps its pace
 * during slow-motion cinematics.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform vec3 color;
uniform float time;
uniform float mode;   // 0 unit ring, 1 building brackets, 2 move, 3 attack-move, 4 attack, 5 rally, 6 hover ring, 7 hover box, 8 promotion
uniform float elite;  // 1 = elite unit: golden shimmer on the selection ring
uniform float age;    // 0..1 life of a marker / selection pop-in
uniform float opacity;
uniform vec2 halfExt; // footprint half extents in world units (buildings)
varying vec2 vUv;

#define PI 3.14159265

float band( float d, float w ) { return 1.0 - smoothstep( w * 0.5, w * 0.5 + fwidth( d ) * 1.2, abs( d ) ); }

// chevron pointing towards the centre along +x at distance r
float chevron( vec2 q, float r, float size ) {
  float d = q.x - r - abs( q.y ) * 0.9;
  return band( d, 0.075 * size ) * step( abs( q.y ), 0.32 * size );
}

void main() {
  vec2 p = vUv;
  float r = length( p );
  float a = atan( p.y, p.x );
  float alpha = 0.0;
  vec3 col = color;
  if ( mode < 0.5 ) {
    // ---- unit selection: segmented rotating ring + counter-rotating brackets + soft fill
    float pop = 1.0 + ( 1.0 - age ) * 0.35;
    float rr = r * pop;
    float seg = step( 0.16, fract( a / ( 2.0 * PI ) * 6.0 + time * 0.12 ) );
    float ring = band( rr - 0.8, 0.06 ) * mix( 0.45, 1.0, seg );
    float br = band( rr - 0.93, 0.07 ) * step( 0.72, fract( a / ( 2.0 * PI ) * 4.0 - time * 0.08 ) );
    float fill = smoothstep( 0.2, 0.8, rr ) * step( rr, 0.8 ) * 0.16;
    float scan = band( rr - fract( time * 0.6 ) * 0.8, 0.05 ) * 0.25;
    alpha = max( max( ring, br ), fill + scan );
    if ( elite > 0.5 ) {
      // elite: a thin golden halo with a glint sweeping around it
      float halo = band( rr - 0.87, 0.035 );
      float glint = pow( 0.5 + 0.5 * cos( a - time * 1.7 ), 10.0 );
      float sh = halo * ( 0.35 + 0.65 * glint ) + band( rr - 0.8, 0.06 ) * glint * 0.6;
      col = mix( col, vec3( 1.0, 0.82, 0.38 ), clamp( sh * 1.6, 0.0, 0.85 ) );
      alpha = max( alpha, sh );
    }
    alpha *= mix( 0.4, 1.0, age );
  } else if ( mode > 7.5 ) {
    // ---- promotion: golden shock rings, star rays and a soft core, fading out
    float k = age;
    float e1 = band( r - mix( 0.15, 0.95, sqrt( k ) ), 0.07 ) * ( 1.0 - k );
    float e2 = band( r - mix( 0.1, 0.7, smoothstep( 0.15, 1.0, k ) ), 0.045 ) * ( 1.0 - k ) * step( 0.15, k );
    float rays = pow( abs( cos( a * 4.0 + time * 0.8 ) ), 24.0 ) * smoothstep( 0.95, 0.25, r ) * smoothstep( 0.05, 0.25, r ) * ( 1.0 - k ) * 0.8;
    float core = ( 1.0 - smoothstep( 0.0, 0.45, r ) ) * ( 1.0 - k ) * 0.45;
    alpha = max( max( e1, e2 ), rays + core );
    col = mix( vec3( 1.0, 0.78, 0.3 ), vec3( 1.0, 0.95, 0.7 ), e1 );
  } else if ( mode < 1.5 || ( mode > 6.5 ) ) {
    // ---- building: corner brackets on the footprint + scan line
    vec2 q = abs( p ) * halfExt;           // world units from the centre
    vec2 e = halfExt - q;                  // distance to the edges
    float lw = 0.07;
    float L = min( 0.55, min( halfExt.x, halfExt.y ) * 0.45 );
    float edge = step( min( e.x, e.y ), lw ) * step( 0.0, min( e.x, e.y ) );
    float corner = step( e.x, L ) * step( e.y, L );
    float brackets = edge * corner;
    if ( mode > 6.5 ) {
      alpha = brackets * 0.55;
    } else {
      float outline = edge * 0.22;
      float sweep = fract( time * 0.35 );
      float scan = band( p.y * 0.5 + 0.5 - sweep, 0.03 ) * 0.18 * step( 0.0, min( e.x, e.y ) );
      float fill = 0.05;
      alpha = max( brackets, outline + scan + fill * step( 0.0, min( e.x, e.y ) ) );
      alpha *= mix( 0.4, 1.0, age );
    }
  } else if ( mode < 3.5 ) {
    // ---- move / attack-move: four chevrons converging on the point
    float k = age;
    float rad = mix( 0.95, 0.22, smoothstep( 0.0, 0.75, k ) );
    float m = 0.0;
    for ( int i = 0; i < 4; i++ ) {
      float ang = float( i ) * PI * 0.5 + PI * 0.25;
      vec2 q = vec2( cos( ang ) * p.x + sin( ang ) * p.y, -sin( ang ) * p.x + cos( ang ) * p.y );
      m = max( m, chevron( q, rad, 1.0 ) );
    }
    float centre = band( r - 0.12 * ( 1.0 + k ), 0.05 ) * smoothstep( 0.3, 0.7, k );
    float x = 0.0;
    if ( mode > 2.5 ) {
      // attack-move: a small cross in the middle
      vec2 rp = vec2( p.x + p.y, p.x - p.y ) * 0.7071;
      x = ( band( rp.x, 0.05 ) + band( rp.y, 0.05 ) ) * step( r, 0.2 );
    }
    alpha = max( max( m, centre ), x ) * ( 1.0 - smoothstep( 0.7, 1.0, k ) );
  } else if ( mode < 4.5 ) {
    // ---- attack: red pulsing reticle locked on the target
    float pulse = 0.5 + 0.5 * sin( time * 14.0 );
    float k = age;
    float shrink = mix( 1.25, 1.0, smoothstep( 0.0, 0.25, k ) );
    float rr = r * shrink;
    float circle = band( rr - 0.62, 0.05 + 0.03 * pulse );
    float outer = band( rr - 0.9, 0.05 ) * step( 0.78, fract( a / ( 2.0 * PI ) * 4.0 + time * 0.3 ) );
    float ticks = 0.0;
    vec2 ap = abs( p );
    ticks += band( ap.y, 0.05 ) * step( 0.4, ap.x ) * step( ap.x, 0.78 );
    ticks += band( ap.x, 0.05 ) * step( 0.4, ap.y ) * step( ap.y, 0.78 );
    float dot_ = 1.0 - smoothstep( 0.05, 0.09, r );
    alpha = max( max( circle, outer ), max( ticks, dot_ ) ) * ( 0.75 + 0.25 * pulse ) * ( 1.0 - smoothstep( 0.75, 1.0, k ) );
  } else if ( mode < 5.5 ) {
    // ---- rally point: expanding sonar rings + diamond beacon
    float k = age;
    float rings = 0.0;
    for ( int i = 0; i < 3; i++ ) {
      float t = fract( time * 0.8 + float( i ) / 3.0 );
      rings = max( rings, band( r - t * 0.95, 0.05 ) * ( 1.0 - t ) );
    }
    float dia = band( abs( p.x ) + abs( p.y ) - 0.3, 0.07 );
    alpha = max( rings, dia ) * ( 1.0 - smoothstep( 0.7, 1.0, k ) );
  } else {
    // ---- hover: thin quiet ring
    alpha = band( r - 0.84, 0.045 ) * 0.6;
  }
  alpha *= opacity;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( col * 1.35, alpha );
}`;

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  born: number;
  seen: boolean;
  selected: boolean;
  key: string;
}

interface Marker {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  t0: number;
  life: number;
  follow: (() => THREE.Vector3 | null) | null;
}

export type OrderKind = 'move' | 'attackMove' | 'attack' | 'rally';

const MODE: Record<OrderKind, number> = { move: 2, attackMove: 3, attack: 4, rally: 5 };
const ORDER_COLOR: Record<OrderKind, number> = { move: 0x5dffa0, attackMove: 0xff8a3a, attack: 0xff3a30, rally: 0xf0ff60 };

export class CombatOverlay {
  readonly group = new THREE.Group();
  private geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  private rings = new Map<number, Ring>();
  private markers: Marker[] = [];
  private n = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();

  constructor(private map: GameMap) {
    this.group.name = 'combat-overlay';
  }

  private now() {
    return performance.now() / 1000;
  }

  private material(color: number, mode: number): THREE.ShaderMaterial {
    const c = new THREE.Color(color);
    // holographic: lift the team colour towards white a little
    c.lerp(new THREE.Color(0xffffff), 0.22);
    return new THREE.ShaderMaterial({
      uniforms: {
        color: { value: c },
        time: { value: 0 },
        mode: { value: mode },
        elite: { value: 0 },
        age: { value: 0 },
        opacity: { value: 1 },
        halfExt: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }

  /** Lay a quad flat on the terrain at (x, y), tilted to the ground normal. */
  private hug(mesh: THREE.Object3D, x: number, y: number, spin = 0, lift = 0.05, tilt = true) {
    const m = this.map;
    const cx = Math.max(0.4, Math.min(m.w - 0.4, x));
    const cy = Math.max(0.4, Math.min(m.h - 0.4, y));
    const h = standHeight(m, cx, cy);
    mesh.position.set(x, h + lift, y);
    if (tilt) {
      const e = 0.35;
      const hx = standHeight(m, Math.min(m.w - 0.01, cx + e), cy) - standHeight(m, Math.max(0, cx - e), cy);
      const hz = standHeight(m, cx, Math.min(m.h - 0.01, cy + e)) - standHeight(m, cx, Math.max(0, cy - e));
      this.n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
      this.q.setFromUnitVectors(this.up, this.n);
      this.q2.setFromAxisAngle(this.up, spin);
      mesh.quaternion.copy(this.q).multiply(this.q2);
    } else mesh.quaternion.setFromAxisAngle(this.up, spin);
  }

  /**
   * Per-entity selection / hover ring. Call every frame for entities that are
   * shown and selected or hovered; rings not touched in a frame are removed by endFrame().
   */
  ring(id: number, x: number, y: number, groundY: number, color: number, selected: boolean, building: { w: number; h: number } | null, radius: number, elite = false) {
    const key = `${color}:${selected ? 1 : 0}:${building ? 'b' : 'u'}:${elite ? 1 : 0}`;
    let r = this.rings.get(id);
    if (r && r.key !== key) {
      this.group.remove(r.mesh);
      r.mat.dispose();
      this.rings.delete(id);
      r = undefined;
    }
    if (!r) {
      const mode = building ? (selected ? 1 : 7) : selected ? 0 : 6;
      const mat = this.material(color, mode);
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      mat.uniforms.elite.value = elite && selected ? 1 : 0;
      r = { mesh, mat, born: this.now(), seen: true, selected, key };
      this.rings.set(id, r);
    }
    r.seen = true;
    if (building) {
      const pad = 0.12;
      r.mesh.scale.set(building.w / 2 + pad, 1, building.h / 2 + pad);
      r.mat.uniforms.halfExt.value.set(building.w / 2 + pad, building.h / 2 + pad);
      r.mesh.position.set(x, groundY + 0.06, y);
      r.mesh.quaternion.identity();
    } else {
      const s = Math.max(0.3, radius * 1.3);
      r.mesh.scale.set(s, 1, s);
      this.hug(r.mesh, x, y, 0, 0.05);
    }
  }

  /** Spawn an order marker on the ground. `follow` keeps an attack reticle on a moving target. */
  order(kind: OrderKind, x: number, y: number, follow: (() => THREE.Vector3 | null) | null = null, size = 1) {
    // only one move-type marker at a time keeps the screen readable
    if (kind !== 'rally') {
      for (const m of this.markers) if (m.mat.uniforms.mode.value !== MODE.rally && m.mat.uniforms.mode.value !== 8) m.life = Math.min(m.life, this.now() - m.t0 + 0.05);
    }
    const mat = this.material(ORDER_COLOR[kind], MODE[kind]);
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    const s = (kind === 'attack' ? 0.75 : kind === 'rally' ? 0.7 : 0.62) * size;
    mesh.scale.set(s, 1, s);
    this.hug(mesh, x, y);
    this.group.add(mesh);
    this.markers.push({ mesh, mat, t0: this.now(), life: kind === 'attack' ? 1.3 : kind === 'rally' ? 1.6 : 0.95, follow });
  }

  /** Veterancy: golden promotion burst under a unit; `follow` keeps it on a moving unit. */
  promote(x: number, y: number, follow: (() => THREE.Vector3 | null) | null, size = 1) {
    const mat = this.material(0xffc850, 8);
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.scale.set(1.1 * size, 1, 1.1 * size);
    this.hug(mesh, x, y);
    this.group.add(mesh);
    this.markers.push({ mesh, mat, t0: this.now(), life: 1.7, follow });
  }

  private pinPool: THREE.Mesh[] = [];
  private pinWhite = new THREE.Color(0xffffff);

  /** Waypoint pins of the selection's queued orders / patrol routes (src/ui/controls.ts); the full list every frame. */
  pins(list: { x: number; y: number; color: number }[]) {
    const t = this.now();
    for (let i = 0; i < list.length; i++) {
      let m = this.pinPool[i];
      if (!m) {
        m = new THREE.Mesh(this.geo, this.material(0xffffff, MODE.rally));
        m.renderOrder = 3;
        m.frustumCulled = false;
        this.group.add(m);
        this.pinPool.push(m);
      }
      const u = (m.material as THREE.ShaderMaterial).uniforms;
      u.color.value.setHex(list[i].color).lerp(this.pinWhite, 0.22);
      u.time.value = t + i * 0.37;
      u.age.value = 0.3;
      u.opacity.value = 0.8;
      m.scale.set(0.45, 1, 0.45);
      this.hug(m, list[i].x, list[i].y);
      m.visible = true;
    }
    for (let i = list.length; i < this.pinPool.length; i++) this.pinPool[i].visible = false;
  }

  /** Remove rings that were not refreshed this frame and animate everything. */
  endFrame() {
    const t = this.now();
    for (const [id, r] of this.rings) {
      if (!r.seen) {
        this.group.remove(r.mesh);
        r.mat.dispose();
        this.rings.delete(id);
        continue;
      }
      r.seen = false;
      r.mat.uniforms.time.value = t;
      r.mat.uniforms.age.value = Math.min(1, (t - r.born) / 0.22);
    }
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      const k = (t - m.t0) / m.life;
      if (k >= 1) {
        this.group.remove(m.mesh);
        m.mat.dispose();
        this.markers.splice(i, 1);
        continue;
      }
      if (m.follow) {
        const p = m.follow();
        if (p) {
          m.mesh.position.set(p.x, p.y + 0.06, p.z);
          m.mesh.quaternion.identity();
        }
      }
      m.mat.uniforms.time.value = t;
      m.mat.uniforms.age.value = k;
    }
  }

  dispose() {
    for (const r of this.rings.values()) r.mat.dispose();
    for (const m of this.markers) m.mat.dispose();
    for (const m of this.pinPool) (m.material as THREE.ShaderMaterial).dispose();
    this.geo.dispose();
  }
}
