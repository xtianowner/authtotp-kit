import { Camera, Geometry, Mesh, Program, Triangle } from 'ogl'
import fullscreenVertex from './fullscreen.vert.glsl?raw'
import shieldVertex from './shield.vert.glsl?raw'
import auroraFragment from './aurora.frag.glsl?raw'
import shieldFragment from './shield.frag.glsl?raw'
import { buildShield } from '../shieldGeometry.js'
import { createRenderer, readRgb, releaseContext } from '../gl.js'
import { startLoop } from '../motion.js'

// Public home WebGL scene (from the showcase lab, candidate 4). Loaded on demand (dynamic import from PublicTotp),
// so ogl and the shaders are never part of the first-screen bundle. ONE WebGL context, one canvas, two passes:
//   1. aurora pass: full-screen triangle (folded light sheets on the HUD horizon + sparse stars)
//   2. shield pass: the 3D shield on top (clear: false), scroll-driven between section anchors.
// Anchor attributes: data-rx / data-ry (rotation), data-scale (size multiplier), data-holo (0 solid → 1 hologram),
// data-spin (rad/s slow turn while parked there), data-oy (upward offset, fraction of the anchor height),
// data-hold-narrow (stay parked for this many viewport heights past the anchor's rest point on narrow, single-
// column layouts, where the section's copy sits below the anchor — keeps the hologram behind the figure while the
// copy is read instead of already flying on, which pushed its tip out under the base at 390 px).
// No scroll hijacking; DPR ≤ 2 (gl.js); paused while the tab is hidden. It only receives "a new code arrived"
// pulses — never the code or the secret.
const FOV = 35
const DIST = 6
const VIEW_H = 2 * DIST * Math.tan(((FOV * Math.PI) / 180) / 2)
const SHIELD_H = 1.98
const SCAN_MS = 1100
const PULSE_MS = 1400
const TAU = Math.PI * 2

const NARROW = 860 // = the single-column breakpoint in showcase.css
const ease = (t) => t * t * (3 - 2 * t)
const mix = (a, b, t) => a + (b - a) * t

// Context attributes = what ogl's Renderer asks for with the options in createRenderer() (gl.js), so the context
// created up front is the one ogl picks up (getContext returns the existing context for the same type).
const CONTEXT_ATTRIBUTES = { alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' }

export function createScene(canvas, { getAnchors, onFail, onReady } = {}) {
  // Start-up is staged over separate tasks so none becomes a long task (炫技验收 §12: no task > 50 ms). Creating the
  // WebGL context alone blocks ~35–45 ms while the GPU process is cold, so this call does only that; the renderer,
  // the two shader programs and the render loop follow in their own tasks.
  let context = null
  try {
    context = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES) || canvas.getContext('webgl', CONTEXT_ATTRIBUTES)
  } catch {
    context = null
  }
  if (!context) return null
  let gl = context
  let renderer = null
  let aurora = null
  let auroraMesh = null
  let scanStart = -Infinity
  let pulseStart = -Infinity
  let teardown = null
  let disposed = false
  let timer = 0
  const steps = [
    () => {
      renderer = createRenderer(canvas, { alpha: true, premultipliedAlpha: true, antialias: true })
      if (!renderer) return false
      gl = renderer.gl
      gl.clearColor(0, 0, 0, 0)
      return true
    },
    () => {
      aurora = new Program(gl, {
        vertex: fullscreenVertex,
        fragment: auroraFragment,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uRes: { value: [1, 1] },
          uGlow: { value: readRgb('--glow') },
          uPulse: { value: 0 },
          uNarrow: { value: 0 },
          uLevel: { value: 0.5 },
        },
      })
      auroraMesh = new Mesh(gl, { geometry: new Triangle(gl), program: aurora })
      return true
    },
    () => {
      teardown = build()
      return true
    },
  ]
  const next = () => {
    timer = window.setTimeout(() => {
      if (disposed) return
      let ok = false
      try { ok = steps.shift()() } catch { ok = false }
      if (!ok) { onFail?.(); return }
      if (steps.length) next()
    }, 0)
  }
  next()

  function build() {
    const camera = new Camera(gl, { fov: FOV, near: 0.1, far: 40 })
    camera.position.set(0, 0, DIST)
    const data = buildShield()
    const geometry = new Geometry(gl, {
      position: { size: 3, data: data.position },
      normal: { size: 3, data: data.normal },
      uv: { size: 2, data: data.uv },
      index: { data: data.index },
    })
    const shield = new Program(gl, {
      vertex: shieldVertex,
      fragment: shieldFragment,
      transparent: true,
      uniforms: {
        uGlow: { value: readRgb('--glow') },
        uBase: { value: readRgb('--bg-tint') },
        uTime: { value: 0 },
        uScanY: { value: 0 },
        uScan: { value: 0 },
        uHolo: { value: 0 },
      },
    })
    const shieldMesh = new Mesh(gl, { geometry, program: shield })

    let vw = 1
    let vh = 1
    const resize = () => {
      vw = window.innerWidth
      vh = window.innerHeight
      renderer.setSize(vw, vh)
      camera.perspective({ aspect: vw / vh })
      aurora.uniforms.uRes.value = [gl.drawingBufferWidth, gl.drawingBufferHeight]
      aurora.uniforms.uNarrow.value = vw < 760 ? 1 : 0
    }
    resize()
    window.addEventListener('resize', resize)

    const measure = () => {
      const scrollY = window.scrollY
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh)
      const list = getAnchors().map((el) => {
        const r = el.getBoundingClientRect()
        const cy = r.top + r.height / 2 - Number(el.dataset.oy || 0) * r.height
        return {
          cx: r.left + r.width / 2,
          cy,
          h: r.height,
          rest: Math.min(Math.max(cy + scrollY - vh / 2, 0), maxScroll),
          hold: vw < NARROW ? Number(el.dataset.holdNarrow || 0) * vh : 0,
          rx: Number(el.dataset.rx || 0),
          ry: Number(el.dataset.ry || 0),
          scale: Number(el.dataset.scale || 1),
          holo: Number(el.dataset.holo || 0),
          spin: Number(el.dataset.spin || 0),
        }
      })
      if (!list.length) return null
      let i = 0
      while (i < list.length - 1 && scrollY >= list[i + 1].rest) i += 1
      const a = list[i]
      const b = list[Math.min(i + 1, list.length - 1)]
      const leave = Math.min(a.rest + a.hold, b.rest)
      const span = b.rest - leave
      const t = a === b || span <= 0 ? 0 : Math.min(1, Math.max(0, (scrollY - leave) / span))
      const e = ease(t)
      const cx = mix(a.cx, b.cx, e)
      const cy = mix(a.cy, b.cy, e)
      const h = mix(a.h, b.h, e)
      return {
        segment: t > 0.5 ? i + 1 : i,
        x: (cx / vw - 0.5) * VIEW_H * (vw / vh),
        y: (0.5 - cy / vh) * VIEW_H,
        s: ((h * 0.7) / vh) * VIEW_H / SHIELD_H * mix(a.scale, b.scale, e),
        rx: mix(a.rx, b.rx, e),
        ry: mix(a.ry, b.ry, e),
        holo: mix(a.holo, b.holo, e),
        spin: mix(a.spin, b.spin, e),
      }
    }

    const current = { x: 0, y: 0, s: 0.5, rx: 0, ry: 0, holo: 0 }
    let spinAngle = 0
    let ready = false
    let announced = false
    let lastSegment = -1
    let lastTime = 0

    const frame = (time) => {
      const dt = Math.min(0.05, (time - lastTime) / 1000 || 0.016)
      lastTime = time
      const target = measure()
      if (!target) return
      if (target.segment !== lastSegment) {
        if (lastSegment !== -1) scanStart = time
        lastSegment = target.segment
      }
      const k = ready ? 1 - Math.exp(-dt * 7) : 1
      ready = true
      for (const key of ['x', 'y', 's', 'rx', 'ry', 'holo']) current[key] += (target[key] - current[key]) * k
      // Slow hologram turn: accumulates while parked on a spinning anchor; elsewhere it unwinds (≤ half a turn).
      spinAngle += dt * target.spin
      spinAngle -= TAU * Math.round(spinAngle / TAU)
      spinAngle *= 1 - Math.min(1, dt * 3 * (1 - Math.min(1, target.spin / 0.3)))

      const seconds = time / 1000
      const sway = 1 - current.holo
      shieldMesh.position.set(current.x, current.y + Math.sin(seconds * 0.9) * 0.03 * current.s, 0)
      shieldMesh.rotation.set(current.rx + Math.sin(seconds * 0.7) * 0.04 * sway, current.ry + spinAngle + Math.sin(seconds * 0.5) * 0.14 * sway, 0)
      shieldMesh.scale.set(current.s, current.s, current.s)
      const p = (time - scanStart) / SCAN_MS
      shield.uniforms.uScan.value = p >= 0 && p <= 1 ? Math.sin(p * Math.PI) : 0
      shield.uniforms.uScanY.value = current.y + current.s * (0.95 - 2.05 * Math.min(Math.max(p, 0), 1))
      shield.uniforms.uTime.value = seconds
      shield.uniforms.uHolo.value = current.holo

      aurora.uniforms.uTime.value = seconds
      aurora.uniforms.uPulse.value = Math.max(0, 1 - (time - pulseStart) / PULSE_MS)

      renderer.render({ scene: auroraMesh })
      renderer.render({ scene: shieldMesh, camera, clear: false })
      if (!announced) {
        announced = true
        onReady?.()
      }
    }
    const stop = startLoop(frame)

    const onLost = (event) => {
      event.preventDefault()
      stop()
      onFail?.()
    }
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      stop()
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('webglcontextlost', onLost)
    }
  }

  return {
    /** A new code was generated: scan beam over the shield + a light pulse through the aurora. */
    newCode() {
      const now = performance.now()
      scanStart = now
      pulseStart = now
    },
    dispose() {
      disposed = true
      window.clearTimeout(timer)
      teardown?.()
      releaseContext(gl)
    },
  }
}
