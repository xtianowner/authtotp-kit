import { useEffect, useState } from 'react'

// Display-layer motion helpers (copied from the showcase lab, src/lab is never imported by product code).
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia(REDUCE_QUERY).matches
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    const query = window.matchMedia(REDUCE_QUERY)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * requestAnimationFrame loop that stops while the tab is hidden or `target` is off screen, and resumes after
 * (炫技验收 §12 资源节制). Returns a dispose function.
 */
export function startLoop(frame, { target } = {}) {
  let raf = 0
  let running = false
  let onScreen = true
  const tick = (time) => {
    raf = window.requestAnimationFrame(tick)
    frame(time)
  }
  const update = () => {
    const shouldRun = !document.hidden && onScreen
    if (shouldRun && !running) {
      running = true
      raf = window.requestAnimationFrame(tick)
    } else if (!shouldRun && running) {
      running = false
      window.cancelAnimationFrame(raf)
    }
  }
  document.addEventListener('visibilitychange', update)
  let observer
  if (target && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting
      update()
    })
    observer.observe(target)
  }
  update()
  return () => {
    document.removeEventListener('visibilitychange', update)
    observer?.disconnect()
    window.cancelAnimationFrame(raf)
    running = false
  }
}

/** Adds `is-in` to elements carrying [data-reveal] once they enter the viewport (one-shot). */
export function useRevealOnScroll(rootRef) {
  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const items = [...root.querySelectorAll('[data-reveal]')]
    if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
      items.forEach((item) => item.classList.add('is-in'))
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-in')
        observer.unobserve(entry.target)
      })
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 })
    items.forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [rootRef])
}

/** Scroll back to the top of the page and focus a field there (closing call-to-action of the public home). */
export function backToField(field) {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  field?.focus({ preventScroll: true })
}
