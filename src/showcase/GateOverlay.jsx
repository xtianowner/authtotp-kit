import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// 「光门开启」 (视觉基线 v1.3 §13/§14): after a successful sign-in two dark vault-door halves close over the login page
// (phase closing, 240 ms), hold with a pulsing seam until the session is confirmed (closed), then teal light leaks
// through the seam, the dial turns and the halves slide apart (opening, 980 ms), revealing the vault, whose dark
// inner pages fade in over 0.45 s as the doors part (AuthGate → .sc-arrive in showcase.css).
// transform / opacity only (showcase.css .sc-gate*). Click, Esc, Enter or Space skips. Never used under reduced motion.
export const GATE_CLOSE_MS = 240
export const GATE_OPEN_MS = 980

const BOLTS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2
  return [Math.cos(angle) * 82, Math.sin(angle) * 82]
})

function Dial() {
  return (
    <svg viewBox="-100 -100 200 200" aria-hidden="true">
      <circle className="sc-gate-ring is-strong" r="97" />
      <circle className="sc-gate-ticks" r="89" />
      <circle className="sc-gate-ring" r="74" />
      <circle className="sc-gate-ring is-strong" r="54" />
      <circle className="sc-gate-ring" r="31" />
      {BOLTS.map(([x, y]) => <circle key={`${x}-${y}`} className="sc-gate-bolt" cx={x} cy={y} r="2.6" />)}
    </svg>
  )
}

export default function GateOverlay({ phase, onClosed, onOpened, onSkip }) {
  const { t } = useLocale()
  const handlers = useRef({ onClosed, onOpened, onSkip })
  handlers.current = { onClosed, onOpened, onSkip }

  useEffect(() => {
    if (phase !== 'closing' && phase !== 'opening') return undefined
    const timer = window.setTimeout(
      () => (phase === 'closing' ? handlers.current.onClosed() : handlers.current.onOpened()),
      phase === 'closing' ? GATE_CLOSE_MS : GATE_OPEN_MS,
    )
    return () => window.clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    const keydown = (event) => {
      if (['Escape', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        handlers.current.onSkip()
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [])

  return createPortal(
    <div className="sc-gate" data-phase={phase} onClick={() => handlers.current.onSkip()}>
      <div className="sc-gate-door is-left"><div className="sc-gate-dial"><Dial /></div></div>
      <div className="sc-gate-door is-right"><div className="sc-gate-dial"><Dial /></div></div>
      <div className="sc-gate-bloom" aria-hidden="true" />
      <div className="sc-gate-seam" aria-hidden="true" />
      <button type="button" className="sc-gate-skip">{t('show.gateSkip')}</button>
      <p className="sr-only" role="status">{t('show.gateStatus')}</p>
    </div>,
    document.body,
  )
}
