import { Renderer } from 'ogl'

// One WebGL context per page (炫技验收 §12): the renderer is created on the page's only canvas and nowhere else —
// no separate capability probe. Returns null when WebGL is unavailable so the page falls back to its poster.
export function createRenderer(canvas, options = {}) {
  try {
    const renderer = new Renderer({
      canvas,
      dpr: Math.min(window.devicePixelRatio || 1, 2), // devicePixelRatio cap 2
      antialias: false,
      powerPreference: 'high-performance',
      ...options,
    })
    return renderer.gl ? renderer : null
  } catch {
    return null
  }
}

/** Reads an RGB comma-triplet token (e.g. --glow: 45, 212, 191) as a 0–1 vec3. */
export function readRgb(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const parts = raw.split(',').map((value) => Number(value.trim()) / 255)
  return parts.length === 3 && parts.every((value) => Number.isFinite(value)) ? parts : [0, 0, 0]
}

/** Frees the GPU context on unmount so a remount never holds two contexts. */
export function releaseContext(gl) {
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* already gone */ }
}
