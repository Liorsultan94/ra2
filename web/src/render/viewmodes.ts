import * as THREE from 'three';
import { DEFS } from '../sim/defs';
import type { SimEvent } from '../sim/types';
import { DroneCam } from './dronecam';
import type { GameRenderer, ViewHook } from './renderer';
import { ThermalPass, renderHeatMask, type Polarity } from './thermal';
import { UnitTagger } from './xray';

/*
 * Whole-view modes hooked into the renderer's frame (GameRenderer.viewHook):
 *  - thermal view (key T: white-hot, again: black-hot, again: off),
 *  - x-ray silhouettes of hidden units (UnitTagger, always cheap),
 *  - the drone camera picture-in-picture (DroneCam).
 */
export class ViewModes implements ViewHook {
  readonly tagger: UnitTagger;
  readonly drone: DroneCam | null;
  private thermalOn = false;
  polarity: Polarity = 'white';
  private pass: ThermalPass | null = null;
  private inComposer = false;
  private heatRT: THREE.WebGLRenderTarget | null = null;
  private directRT: THREE.WebGLRenderTarget | null = null;
  private time = 0;
  private size = new THREE.Vector2();
  /** X-ray silhouettes setting (hidden while the thermal view is on: heat already shows through). */
  xray = true;
  /** Called when the thermal mode changes (HUD button state). */
  onChange: (() => void) | null = null;

  constructor(
    private r: GameRenderer,
    container: HTMLElement | null,
    onJump: (x: number, y: number) => void,
  ) {
    const color = r.viewer >= 0 ? r.world.players[r.viewer].color : 0x2f8fff;
    this.tagger = new UnitTagger(color);
    this.drone = container && r.viewer >= 0 ? new DroneCam(r, container, onJump) : null;
  }

  get thermal(): boolean {
    return this.thermalOn;
  }

  /** Thermal view on / off (night vision is switched off: the two are exclusive). */
  setThermal(on: boolean, polarity?: Polarity) {
    if (polarity) this.polarity = polarity;
    this.thermalOn = on;
    if (on && this.r.atmos.nightVision) this.r.atmos.setNightVision(false);
    if (on && !this.pass) this.pass = new ThermalPass();
    if (this.pass) {
      this.pass.uniforms.polarity.value = this.polarity === 'black' ? -1 : 1;
      this.pass.enabled = on;
    }
    this.onChange?.();
  }

  /** Key T cycle: off -> white-hot -> black-hot -> off. */
  cycleThermal() {
    if (!this.thermalOn) this.setThermal(true, 'white');
    else if (this.polarity === 'white') this.setThermal(true, 'black');
    else this.setThermal(false);
  }

  /** Night vision was switched on elsewhere (key N): leave thermal. */
  syncNightVision() {
    if (this.r.atmos.nightVision && this.thermalOn) this.setThermal(false);
  }

  onEvent(ev: SimEvent) {
    this.drone?.onEvent(ev);
  }

  private isUnit = (def: string) => DEFS[def]?.kind === 'unit';

  before(dt: number) {
    this.time += dt;
    const r = this.r;
    this.tagger.xray = this.xray && !this.thermalOn;
    this.tagger.update(r.visuals.values(), r.viewer, this.isUnit, this.time);
    if (!this.thermalOn || !this.pass) return;
    const gl = r.renderer;
    gl.getDrawingBufferSize(this.size);
    const hw = Math.max(64, Math.round(this.size.x / 3));
    const hh = Math.max(48, Math.round(this.size.y / 3));
    if (!this.heatRT) this.heatRT = new THREE.WebGLRenderTarget(hw, hh, { depthBuffer: true });
    else if (this.heatRT.width !== hw || this.heatRT.height !== hh) this.heatRT.setSize(hw, hh);
    renderHeatMask(gl, r.scene, r.camera, this.heatRT);
    const u = this.pass.uniforms;
    u.tHeat.value = this.heatRT.texture;
    u.time.value = this.time;
    u.res.value.copy(this.size);
    const comp = r.postComposer;
    if (comp && !this.inComposer) {
      comp.addPass(this.pass);
      this.inComposer = true;
    }
  }

  renderMain(): boolean {
    if (!this.thermalOn || !this.pass || this.r.postActive) return false;
    // no post chain: draw the scene offscreen, then through the thermal mapping
    const gl = this.r.renderer;
    if (!this.directRT) this.directRT = new THREE.WebGLRenderTarget(this.size.x, this.size.y, { depthBuffer: true });
    else if (this.directRT.width !== this.size.x || this.directRT.height !== this.size.y) this.directRT.setSize(this.size.x, this.size.y);
    gl.setRenderTarget(this.directRT);
    gl.render(this.r.scene, this.r.camera);
    this.pass.renderDirect(gl, this.directRT);
    return true;
  }

  after(dt: number) {
    this.drone?.frame(dt);
  }

  dispose() {
    this.tagger.dispose();
    this.drone?.dispose();
    this.pass?.dispose();
    this.heatRT?.dispose();
    this.directRT?.dispose();
  }
}
