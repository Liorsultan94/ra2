import type * as THREE from 'three';

/*
 * Black frame watch (self-heal for the post chain; the real fixes live where
 * the causes were: syncDepthSize in post/util.ts, the final pass unbinding
 * the inputs of passes that did not run, the grade LUT re-bake).
 *
 * Every `every` frames a handful of pixels of the finished frame are copied
 * into a pixel pack buffer right after the last pass (no GPU stall: the copy
 * is fenced and collected a frame or more later, when the GPU is done). When
 * all of them come back black, the caller re-checks / re-bakes what can break
 * (PostChain.repair). An odd interval also catches a buffer that fails every
 * other frame. The watch only reads; it never changes what is drawn.
 */

/** Sample points, fractions of the drawing buffer (the centre band, where the battlefield always is). */
const PTS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.3, 0.45],
  [0.7, 0.55],
  [0.42, 0.7],
  [0.58, 0.3],
];

/** Largest channel value (0..255) still counted as black: the final pass dithers +-1 and adds grain. */
const BLACK_MAX = 3;

/** True when every RGBA sample is black (the alpha channel is ignored). */
export function isBlackSample(px: ArrayLike<number>): boolean {
  if (px.length < 4) return false;
  for (let i = 0; i + 3 < px.length; i += 4) if (px[i] > BLACK_MAX || px[i + 1] > BLACK_MAX || px[i + 2] > BLACK_MAX) return false;
  return true;
}

export class BlackFrameWatch {
  private buf: WebGLBuffer | null = null;
  private fence: WebGLSync | null = null;
  private px = new Uint8Array(PTS.length * 4);
  private frame = 0;
  /** Probes taken / found black (debug). */
  probes = 0;
  blacks = 0;

  constructor(private every = 45) {}

  /** The GL objects are gone (context restored): start over. */
  reset() {
    this.buf = null;
    this.fence = null;
  }

  /**
   * Call once per frame right after the last pass drew to the screen. Returns true when a probe that
   * completed this frame found the frame black.
   */
  tick(r: THREE.WebGLRenderer): boolean {
    const gl = r.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== 'function' || gl.isContextLost()) return false;
    this.frame++;
    if (this.fence) {
      const st = gl.clientWaitSync(this.fence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return false;
      gl.deleteSync(this.fence);
      this.fence = null;
      if (st === gl.WAIT_FAILED || !this.buf) return false;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.px);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.probes++;
      const black = isBlackSample(this.px);
      if (black) this.blacks++;
      return black;
    }
    if (this.frame % this.every !== 0) return false;
    // read from the screen (the frame that was just drawn; three keeps the read binding in its state cache)
    r.setRenderTarget(null);
    r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (!this.buf) {
      this.buf = gl.createBuffer();
      if (!this.buf) return false;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.px.byteLength, gl.STREAM_READ);
    } else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    for (let i = 0; i < PTS.length; i++) gl.readPixels(Math.min(w - 1, Math.floor(PTS[i][0] * w)), Math.min(h - 1, Math.floor(PTS[i][1] * h)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, i * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    return false;
  }

  dispose(r: THREE.WebGLRenderer) {
    const gl = r.getContext() as WebGL2RenderingContext;
    if (this.fence) gl.deleteSync(this.fence);
    if (this.buf) gl.deleteBuffer(this.buf);
    this.reset();
  }
}
