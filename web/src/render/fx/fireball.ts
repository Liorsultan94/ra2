import * as THREE from 'three';
import type { FogOfWar } from '../fog';

/*
 * Volumetric-looking 3D fireballs (high quality only).
 *
 * A noise-displaced icosphere whose surface boils (animated 3D value noise in
 * the vertex shader) and whose emissive colour runs down a temperature ramp:
 * white-yellow core -> orange -> deep red -> dark smoke shell. The ball
 * expands violently, rises on its own buoyancy and cools from the rim
 * inwards until only a sooty shell is left, which fades into the particle
 * smoke column spawned by the same blast. A small fixed pool of meshes shares
 * one geometry and one shader program.
 */

export type FireballPalette = 'normal' | 'thermo' | 'white';

const NOISE = /* glsl */ `
  float fbHash( vec3 p ) {
    p = fract( p * 0.3183099 + 0.1 );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }
  float fbNoise( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( fbHash( i ), fbHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( fbHash( i + vec3( 0, 1, 0 ) ), fbHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( fbHash( i + vec3( 0, 0, 1 ) ), fbHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( fbHash( i + vec3( 0, 1, 1 ) ), fbHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }
`;

const VERT = /* glsl */ `
  ${NOISE}
  uniform float uAge;
  uniform float uSeed;
  uniform float uCool;
  varying float vN;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vObj;
  varying vec2 vWorldXZ;
  void main() {
    vec3 p = position;
    vec3 q = p * 2.1 + vec3( uSeed, uSeed * 0.7 - uAge * 1.6, uSeed * 1.3 );
    float n = fbNoise( q ) * 0.6 + fbNoise( q * 2.3 + 4.1 ) * 0.3 + fbNoise( q * 5.1 + 9.7 ) * 0.1;
    vN = n;
    // lumpy, boiling surface; the cooling shell gets lumpier (cauliflower smoke)
    float disp = ( n - 0.45 ) * ( 0.45 + 0.35 * uCool );
    // flatten the bottom a little: a ground burst sits on the dirt
    p *= 1.0 + disp;
    p.y = p.y < 0.0 ? p.y * 0.75 : p.y;
    vObj = position;
    vec4 wp = modelMatrix * vec4( p, 1.0 );
    vWorldXZ = wp.xz;
    vec4 mv = viewMatrix * wp;
    vViewPos = mv.xyz;
    vNormalV = normalize( normalMatrix * normal );
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  ${NOISE}
  uniform float uAge;
  uniform float uSeed;
  uniform float uCool;
  uniform float uFade;
  uniform vec3 uHot;
  uniform vec3 uMid;
  uniform vec3 uSmoke;
  uniform sampler2D fogTex;
  uniform vec2 fogSize;
  uniform float fogEnabled;
  varying float vN;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vObj;
  varying vec2 vWorldXZ;
  void main() {
    vec3 v = normalize( -vViewPos );
    float facing = abs( dot( normalize( vNormalV ), v ) );
    float fine = fbNoise( vObj * 6.0 + vec3( uSeed, -uAge * 2.5, 0.0 ) );
    // temperature: hottest in the middle of the visible disc, cooling from the rim inwards over time
    float temp = facing * 0.75 + vN * 0.45 + fine * 0.25 - uCool * 1.15;
    vec3 c = uSmoke;
    c = mix( c, uMid * 0.35, smoothstep( 0.12, 0.38, temp ) );
    c = mix( c, uMid * 1.5, smoothstep( 0.35, 0.62, temp ) );
    c = mix( c, uHot * 2.4, smoothstep( 0.66, 1.0, temp ) );
    // soft silhouette, sooty shell thins out at the end
    float a = smoothstep( 0.02, 0.45, facing ) * uFade;
    a *= mix( 1.0, 0.55 + 0.45 * fine, uCool );
    float fogV = texture2D( fogTex, vWorldXZ / fogSize ).r;
    a *= mix( 1.0, smoothstep( 0.55, 0.85, fogV ), fogEnabled );
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( c, a );
  }
`;

interface Ball {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  age: number;
  life: number;
  r: number;
  x: number;
  y: number;
  z: number;
  rise: number;
}

const PAL: Record<FireballPalette, [number, number, number]> = {
  normal: [0xfff0c0, 0xff6a1a, 0x1a1512],
  thermo: [0xffe0a0, 0xff7a20, 0x2a1a10],
  white: [0xffffff, 0xffa040, 0x1c1814],
};

export class Fireballs {
  private pool: Ball[] = [];
  private live: Ball[] = [];
  private geo = new THREE.IcosahedronGeometry(1, 4);

  constructor(
    private group: THREE.Group,
    private fog: FogOfWar,
    private max: number,
  ) {}

  get active() {
    return this.live.length;
  }

  /** A fireball for a blast of size S at (x, y, z); `airborne` balls are round and do not sit on the ground. */
  spawn(x: number, y: number, z: number, S: number, pal: FireballPalette, airborne: boolean) {
    let b = this.pool.pop();
    if (!b) {
      if (this.live.length >= this.max) {
        // recycle the oldest
        b = this.live.shift()!;
      } else {
        const mat = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          uniforms: {
            uAge: { value: 0 },
            uSeed: { value: 0 },
            uCool: { value: 0 },
            uFade: { value: 1 },
            uHot: { value: new THREE.Color() },
            uMid: { value: new THREE.Color() },
            uSmoke: { value: new THREE.Color() },
            ...this.fog.uniforms,
          },
          vertexShader: VERT,
          fragmentShader: FRAG,
        });
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        b = { mesh, mat, age: 0, life: 1, r: 1, x: 0, y: 0, z: 0, rise: 0 };
      }
    }
    const [hot, mid, smoke] = PAL[pal];
    const u = b.mat.uniforms;
    (u.uHot.value as THREE.Color).setHex(hot);
    (u.uMid.value as THREE.Color).setHex(mid);
    (u.uSmoke.value as THREE.Color).setHex(smoke);
    u.uSeed.value = Math.random() * 50;
    b.age = 0;
    b.life = (pal === 'thermo' ? 1.8 : 1.15) + 0.3 * S;
    b.r = 0.4 * S * (pal === 'thermo' ? 1.25 : 1);
    b.x = x;
    b.y = y + (airborne ? 0 : b.r * 0.45);
    b.z = z;
    b.rise = 0.55 * Math.sqrt(S);
    b.mesh.scale.setScalar(0.01);
    b.mesh.position.set(x, b.y, z);
    b.mesh.rotation.set(0, Math.random() * 6.28, 0);
    if (!this.live.includes(b)) this.live.push(b);
    this.group.add(b.mesh);
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.age += dt;
      const k = b.age / b.life;
      if (k >= 1) {
        this.group.remove(b.mesh);
        this.live.splice(i, 1);
        this.pool.push(b);
        continue;
      }
      // violent expansion (ease-out), then a slow swell as it cools
      const e = Math.min(1, b.age / (0.22 * b.life));
      const grow = (1 - (1 - e) * (1 - e) * (1 - e)) * (1 + 0.45 * k);
      b.mesh.scale.set(b.r * grow, b.r * grow * (1 + 0.15 * k), b.r * grow);
      // buoyant rise, accelerating as the core lifts off
      b.mesh.position.set(b.x, b.y + b.rise * b.age * (0.4 + k), b.z);
      const u = b.mat.uniforms;
      u.uAge.value = b.age;
      u.uCool.value = THREE.MathUtils.smoothstep(k, 0.08, 0.8);
      u.uFade.value = 1 - THREE.MathUtils.smoothstep(k, 0.55, 1);
    }
  }
}
