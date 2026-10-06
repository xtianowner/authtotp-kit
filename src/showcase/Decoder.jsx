import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { startLoop } from './motion.js'

// Code display for the display layer (视觉基线 v1.3 §13: 「解码定格 + 发光倒计时环」), 6–8 digits.
// The real code is written into the cells within the first frames: cell i locks at i × DECODE_MS / (n − 1) ms after
// the code arrives, so the first digit is on screen in the next frame and every digit ≤ ~80 ms after Web Crypto /
// the server returns, even with React's commit and frame alignment on top (§12: ≤ 100 ms).
// While no code is shown the cells keep re-rolling dimly; `burst` (typing) makes them churn faster.
// Visual layer only: it receives the code, never the secret. Cells are aria-hidden — pages expose the code as
// text separately. Reduced motion / hidden tab: no scramble, the code is written at once.
const DECODE_MS = 45
const DIGITS = '0123456789'
const MAX_CELLS = 8
const rand = () => DIGITS[(Math.random() * 10) | 0]

function Decoder({ code, length = 6, generation = 0, burst = 0, reduced, className = '' }) {
  const n = code ? code.length : length
  const split = Math.ceil(n / 2)
  const cellsRef = useRef([])
  const rootRef = useRef(null)
  const state = useRef({ mode: 'idle', target: '', start: 0, step: 0, next: new Array(MAX_CELLS).fill(0), burstUntil: 0 })

  // Code arrival: switch to decode mode synchronously so the very next frame already shows the first digit.
  useLayoutEffect(() => {
    const s = state.current
    const cells = cellsRef.current.slice(0, n).filter(Boolean)
    if (!code) {
      s.mode = 'idle'
      cells.forEach((cell) => {
        cell.dataset.state = 'idle'
        cell.textContent = reduced ? '–' : rand()
      })
      return
    }
    s.mode = 'decode'
    s.target = code
    s.start = performance.now()
    s.step = n > 1 ? DECODE_MS / (n - 1) : 0
    const immediate = reduced || document.hidden
    cells.forEach((cell, i) => {
      if (immediate) {
        cell.textContent = code[i]
        cell.dataset.state = 'locked'
      } else {
        cell.dataset.state = 'decoding'
      }
    })
  }, [code, generation, reduced, n])

  useEffect(() => {
    state.current.burstUntil = performance.now() + 380
  }, [burst])

  useEffect(() => {
    if (reduced) return undefined
    return startLoop((time) => {
      const s = state.current
      const cells = cellsRef.current
      const bursting = time < s.burstUntil
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i]
        if (!cell) continue
        if (s.mode === 'idle') {
          if (time >= s.next[i] || bursting) {
            cell.textContent = rand()
            s.next[i] = time + (bursting ? 30 : 110 + Math.random() * 190)
          }
        } else if (cell.dataset.state === 'decoding') {
          if (time - s.start >= i * s.step) {
            cell.textContent = s.target[i] ?? ''
            cell.dataset.state = 'locked'
          } else {
            cell.textContent = rand()
          }
        }
      }
    }, { target: rootRef.current })
  }, [reduced])

  return (
    <div className={`sc-cells ${className}`.trim()} ref={rootRef} style={{ '--n': n }} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        // Cells are written imperatively (no React children), so re-renders never overwrite a locked digit.
        <span key={i} className={`sc-cell${i === split ? ' sc-cell-split' : ''}`} ref={(node) => { cellsRef.current[i] = node }} data-state="idle" />
      ))}
    </div>
  )
}

export default memo(Decoder)
