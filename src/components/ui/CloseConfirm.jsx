import { useEffect, useId, useRef } from 'react'
import { ShieldAlert } from 'lucide-react'

// Inline "close anyway?" step that replaces a dialog's action row. Used when closing would lose something:
// a one-time secret that cannot be shown again (tone="warning") or unsaved form input (tone="neutral").
// Focus lands on the safe choice (keep) as soon as it appears; the confirm choice uses the quiet danger style.
export default function CloseConfirm({ title, detail, keepLabel, confirmLabel, onKeep, onConfirm, tone = 'neutral', className = 'mt-5' }) {
  const textId = useId()
  const keepRef = useRef(null)
  useEffect(() => { keepRef.current?.focus() }, [])
  return (
    <div className={`${className} rounded-card border ${tone === 'warning' ? 'border-warning' : 'border-border'} bg-tint p-4`}>
      <div id={textId}>
        <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-text">
          {tone === 'warning' && <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />}
          {title}
        </p>
        {detail && <p className="mt-1 text-sm leading-relaxed text-muted">{detail}</p>}
      </div>
      <div className="mt-3 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" className="btn-danger-quiet" onClick={onConfirm}>{confirmLabel}</button>
        <button ref={keepRef} type="button" className="btn-secondary" onClick={onKeep} aria-describedby={textId}>{keepLabel}</button>
      </div>
    </div>
  )
}

// Warn before a reload / tab close would drop unsaved dialog input.
export function useBeforeUnloadWhile(active) {
  useEffect(() => {
    if (!active) return undefined
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])
}
