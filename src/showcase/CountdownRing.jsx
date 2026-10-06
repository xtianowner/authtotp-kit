import { useEffect, useRef } from 'react'
import { startLoop } from './motion.js'

// Glowing countdown dial (HUD flavour, from the showcase lab's candidate 3): 60 ticks go dark as the window runs
// out, over a thin continuous arc. getProgress() returns the elapsed fraction of the current window (0 → 1);
// it is polled per frame (rAF, paused when hidden / off screen) or once a second under reduced motion.
// Lit ticks are only touched when their count changes. Glow = --glow via a CSS drop-shadow filter.
const TICKS = 60
const SIZE = 120
const C = SIZE / 2
const ARC_R = 44
const ARC = 2 * Math.PI * ARC_R
const IDS = Array.from({ length: TICKS }, (_, i) => i)

export default function CountdownRing({ active, reduced, remaining, getProgress, unit = 'SEC', className = '' }) {
  const rootRef = useRef(null)
  const tickRefs = useRef([])
  const arcRef = useRef(null)
  const litRef = useRef(-1)
  const progressRef = useRef(getProgress)
  progressRef.current = getProgress

  useEffect(() => {
    if (!active) { litRef.current = -1; return undefined }
    const run = () => {
      const progress = Math.min(1, Math.max(0, progressRef.current()))
      if (arcRef.current) arcRef.current.style.strokeDashoffset = String(ARC * progress)
      const lit = Math.ceil(TICKS * (1 - progress))
      if (lit === litRef.current) return
      litRef.current = lit
      tickRefs.current.forEach((tick, i) => {
        if (tick) tick.setAttribute('data-on', i < lit ? (i === lit - 1 ? 'head' : 'on') : 'off')
      })
    }
    run()
    if (reduced) {
      const timer = window.setInterval(run, 1000)
      return () => window.clearInterval(timer)
    }
    return startLoop(run, { target: rootRef.current })
  }, [active, reduced])

  return (
    <div ref={rootRef} className={`sc-ring${active ? ' is-active' : ''} ${className}`.trim()} aria-hidden="true">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {IDS.map((i) => (
          <line
            key={i}
            ref={(node) => { tickRefs.current[i] = node }}
            className="sc-tick"
            data-on={active ? 'on' : 'off'}
            x1={C}
            y1={4}
            x2={C}
            y2={i % 5 === 0 ? 13 : 10}
            transform={`rotate(${i * 6} ${C} ${C})`}
          />
        ))}
        <circle className="sc-ring-track" cx={C} cy={C} r={ARC_R} />
        {active && <circle className="sc-ring-arc" ref={arcRef} cx={C} cy={C} r={ARC_R} strokeDasharray={ARC} transform={`rotate(-90 ${C} ${C})`} />}
      </svg>
      <span className="sc-ring-value sc-mono">{active ? remaining : '--'}</span>
      <span className="sc-ring-unit sc-mono">{unit}</span>
    </div>
  )
}
