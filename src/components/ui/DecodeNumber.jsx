import { useLayoutEffect, useRef } from 'react'
import { usePrefersReducedMotion } from '../../showcase/motion.js'

// Stat number with AuthTOTP's decode-lock (same technique as src/showcase/Decoder.jsx — digit cells written
// imperatively, scrambling, then locking one by one from the left), slowed for a stat: the first digit locks at
// 0.2 s, the last at 0.5 s. Runs when the number first appears and again on every change. One fixed-width cell per
// digit (.vm-dec-cell, 1ch, tabular), so the width never jumps while scrambling. The cells are decorative; the value
// is also present as text for screen readers. Reduced motion / hidden tab: the final value is written at once.
// (Decoder itself is not reused: its 45 ms decode and mono size-container cells are tuned for the code display.)
const LOCK_FROM = 200
const LOCK_TO = 500
const REROLL_MS = 50
const rand = () => String((Math.random() * 10) | 0)

export default function DecodeNumber({ value }) {
  const text = String(Math.max(0, Math.round(Number(value) || 0)))
  const cells = useRef([])
  const reduced = usePrefersReducedMotion()

  useLayoutEffect(() => {
    const nodes = cells.current.slice(0, text.length).filter(Boolean)
    const settle = () => nodes.forEach((node, i) => { node.textContent = text[i]; node.dataset.state = 'locked' })
    if (reduced || document.hidden) {
      settle()
      return undefined
    }
    const n = nodes.length
    const lockAt = (i) => (n === 1 ? LOCK_TO : LOCK_FROM + (i * (LOCK_TO - LOCK_FROM)) / (n - 1))
    nodes.forEach((node) => { node.textContent = rand(); node.dataset.state = 'scramble' })
    const start = performance.now()
    let nextReroll = REROLL_MS
    let frame = window.requestAnimationFrame(function step(now) {
      const elapsed = now - start
      const reroll = elapsed >= nextReroll
      if (reroll) nextReroll = elapsed + REROLL_MS
      let pending = false
      nodes.forEach((node, i) => {
        if (node.dataset.state === 'locked') return
        if (elapsed >= lockAt(i)) {
          node.textContent = text[i]
          node.dataset.state = 'locked'
        } else {
          pending = true
          if (reroll) node.textContent = rand()
        }
      })
      if (pending) frame = window.requestAnimationFrame(step)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      settle()
    }
  }, [text, reduced])

  return (
    <strong className="vm-dec">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {Array.from(text, (_, i) => (
          // Written imperatively (no React children), so re-renders never overwrite a running decode.
          <span key={`${text.length}-${i}`} ref={(node) => { cells.current[i] = node }} className="vm-dec-cell" data-state="locked" />
        ))}
      </span>
    </strong>
  )
}
