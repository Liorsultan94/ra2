import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { FinalPass } from '../post';
import { TiltShiftPass } from '../tiltshift';
import { JitterRenderPass, TemporalPass } from '../ultra/temporal';
import { AOPass, DepthTap } from './ao';
import { BloomPass } from './bloom';
import { DofPass } from './dof';
import { GradeLut, type GradeInput } from './grade';
import { makeLensDirt } from './lens';
import { Blitter, halfFloatTargets } from './util';

/*
 * The cinematic post chain (all quality levels with a half-float target):
 *
 *   scene (MSAA 4x on high; jittered on ultra) -> depth tap -> GTAO (half
 *   res) -> [ultra: SSR / contact shadows / TAA] -> [bokeh DOF: photo mode,
 *   intro] -> bloom mip chain -> FinalPass (AO apply, bloom, lens, AgX,
 *   3D LUT grade, vignette, grain, FXAA) -> [tilt-shift at close zoom, high]
 *   (-> night vision / thermal, appended by atmos.ts / viewmodes.ts).
 *
 * Low runs scene -> FinalPass only (tone map + grade + FXAA). Each optional
 * stage is a rung of the renderer's dynamic quality ladder (applyStep), and
 * the governor sheds them in this order: lens extras -> AO -> bloom quality
 * -> (resolution) -> bloom.
 */

export type BaseQuality = 'low' | 'medium' | 'high';

/** The post-relevant part of one quality ladder rung. */
export interface PostStep {
  ao: boolean;
  /** 0 = off, 1 = cheap, 2 = full. */
  bloomQ: 0 | 1 | 2;
  lens: boolean;
  /** Ultra extras (TAA + sharpen, SSR, screen-space contact shadows). */
  ultra: boolean;
}

/** Lens finishing per quality: chromatic aberration (uv at the corners), dirt, streak, grain. */
const LENS: Record<BaseQuality, { ca: number; dirt: number; streak: number; grain: number }> = {
  high: { ca: 0.0028, dirt: 0.55, streak: 0.22, grain: 0.02 },
  medium: { ca: 0.0022, dirt: 0, streak: 0, grain: 0.016 },
  low: { ca: 0, dirt: 0, streak: 0, grain: 0 },
};

export class PostChain {
  readonly composer: EffectComposer;
  readonly final: FinalPass;
  readonly lut = new GradeLut();
  readonly depth: DepthTap | null = null;
  readonly ao: AOPass | null = null;
  readonly bloom: BloomPass | null = null;
  readonly dof: DofPass | null = null;
  readonly tilt: TiltShiftPass | null = null;
  readonly jitter: JitterRenderPass | null = null;
  readonly temporal: TemporalPass | null = null;
  private dirtTex: THREE.DataTexture | null = null;
  private blit = new Blitter();
  private lens: (typeof LENS)[BaseQuality];
  private warmed = false;
  /** Cinematic DOF target (photo mode / intro), eased per frame. */
  private dofFocus = 20;
  private dofAmount = 0;
  private dofGoal = 0;

  /** Can this device run the chain at all (half-float colour targets)? */
  static supported(r: THREE.WebGLRenderer): boolean {
    return halfFloatTargets(r);
  }

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    readonly quality: BaseQuality,
    readonly ultra: boolean,
    fogNoise: THREE.Texture | null,
  ) {
    const hdr = THREE.HalfFloatType;
    const withDepth = quality !== 'low';
    // the scene buffer keeps its depth (AO, DOF; ultra: TAA reprojection, SSR, contact shadows)
    const target = new THREE.WebGLRenderTarget(1, 1, { type: hdr, samples: quality === 'high' ? 4 : 0, depthTexture: withDepth ? new THREE.DepthTexture(1, 1) : null });
    const comp = (this.composer = new EffectComposer(renderer, target));
    if (ultra) comp.addPass((this.jitter = new JitterRenderPass(scene, camera)));
    else comp.addPass(new RenderPass(scene, camera));
    if (withDepth) {
      comp.addPass((this.depth = new DepthTap()));
      comp.addPass((this.ao = new AOPass(camera, this.depth, ultra ? 3 : 2)));
    }
    if (this.jitter) comp.addPass((this.temporal = new TemporalPass(this.jitter, camera, fogNoise)));
    if (withDepth) comp.addPass((this.dof = new DofPass(camera, this.depth!, hdr, ultra ? 64 : 48)));
    if (quality !== 'low') comp.addPass((this.bloom = new BloomPass(hdr)));
    const f = (this.final = new FinalPass());
    f.uniforms.fxaa.value = quality === 'high' ? 0 : 1;
    f.bloom = this.bloom;
    f.ao = this.ao;
    f.depth = this.depth;
    f.dof = this.dof;
    f.lut = this.lut;
    f.camera = camera;
    comp.addPass(f);
    // miniature-style tilt-shift at close zoom (high quality only, src/render/tiltshift.ts)
    if (quality === 'high') comp.addPass((this.tilt = new TiltShiftPass()));
    this.lens = LENS[quality];
    if (this.lens.dirt > 0) f.uniforms.tDirt.value = this.dirtTex = makeLensDirt();
    f.grainAmt = this.lens.grain;
    if (/[?&]tm=aces\b/.test(typeof location !== 'undefined' ? location.search : '')) f.uniforms.tonemap.value = 0;
  }

  /** Apply the post part of a quality rung. */
  applyStep(s: PostStep) {
    if (this.ao) this.ao.enabled = s.ao;
    if (this.bloom) {
      this.bloom.enabled = s.bloomQ > 0;
      this.bloom.quality = s.bloomQ === 2 ? 2 : 1;
      this.bloom.streakOn = s.lens && this.lens.streak > 0;
    }
    const f = this.final;
    f.ca = s.lens ? this.lens.ca : 0;
    f.dirt = s.lens ? this.lens.dirt : 0;
    f.streak = s.lens ? this.lens.streak : 0;
    if (this.jitter) this.jitter.jitter = s.ultra;
    if (this.temporal) {
      if (this.temporal.enabled !== s.ultra) this.temporal.reset();
      this.temporal.enabled = s.ultra;
    }
    f.uniforms.sharpen.value = s.ultra ? 0.3 : 0;
  }

  /**
   * Depth of field target: focus distance (view-axis world units) and amount
   * 0..1 (0 = off). Eased over a few frames; the pass switches itself off at 0.
   */
  setDof(focus: number, amount: number, instant = false) {
    this.dofFocus = focus;
    this.dofGoal = amount;
    if (instant) this.dofAmount = amount;
  }

  /** True while the bokeh DOF pass runs. */
  get dofActive(): boolean {
    return !!this.dof && this.dof.enabled;
  }

  /** Per-frame: the grade LUT and the DOF state (call before composer.render). */
  update(dt: number, grade: GradeInput) {
    this.lut.update(this.renderer, this.blit, grade);
    const d = this.dof;
    if (d) {
      const k = 1 - Math.exp(-Math.max(0, dt) * 6);
      this.dofAmount += (this.dofGoal - this.dofAmount) * (dt > 0 ? k : 1);
      if (Math.abs(this.dofGoal - this.dofAmount) < 0.004) this.dofAmount = this.dofGoal;
      d.focus = this.dofFocus;
      d.amount = this.dofAmount;
      d.enabled = this.dofAmount > 0.01;
    }
  }

  /** Render one frame through the chain. The first frame runs every optional pass once (shader warm-up). */
  render(dt: number) {
    if (!this.warmed) {
      this.warmed = true;
      const ao = this.ao?.enabled;
      const bl = this.bloom?.enabled;
      const dof = this.dof?.enabled;
      const tilt = this.tilt?.enabled;
      if (this.ao) this.ao.enabled = true;
      if (this.bloom) this.bloom.enabled = true;
      if (this.dof) {
        this.dof.enabled = true;
        this.dof.amount = Math.max(this.dof.amount, 0.05);
      }
      if (this.tilt) this.tilt.enabled = true;
      this.composer.render(dt);
      if (this.ao) this.ao.enabled = !!ao;
      if (this.bloom) this.bloom.enabled = !!bl;
      if (this.dof) this.dof.enabled = !!dof;
      if (this.tilt) this.tilt.enabled = !!tilt;
    }
    this.composer.render(dt);
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.tilt?.setSize(w * pixelRatio, h * pixelRatio);
  }

  /** Enabled passes and their full-screen draws (debug / perf report). */
  stats(): { passes: string[]; draws: number; lutBakes: number } {
    const passes: string[] = [];
    let draws = 0;
    for (const p of this.composer.passes) {
      if (!p.enabled) continue;
      const name = p.constructor.name;
      passes.push(name);
      if (p === this.bloom) draws += this.bloom.draws;
      else if (p === this.ao) draws += 2;
      else if (p === this.dof) draws += 3;
      else if (p === this.temporal) draws += 2;
      else if (p !== this.depth && !(p instanceof RenderPass)) draws += 1;
    }
    return { passes, draws, lutBakes: this.lut.bakes };
  }

  dispose() {
    this.composer.dispose();
    for (const p of this.composer.passes) (p as { dispose?: () => void }).dispose?.();
    this.lut.dispose();
    this.dirtTex?.dispose();
    this.blit.dispose();
  }
}
