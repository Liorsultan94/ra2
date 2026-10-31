import type { DeviceClass } from './events';

/** Phone / tablet / desktop from the pointer and the screen's short side. */
export function deviceClass(): DeviceClass {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
  if (!coarse) return 'desktop';
  const s = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  return s < 600 ? 'phone' : 'tablet';
}

/** Unmasked GPU name of a live WebGL context ('' if hidden). One getParameter call. */
export function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined): string {
  try {
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '').slice(0, 120);
  } catch {
    return '';
  }
}
