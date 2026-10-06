import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { enter, exit } from '../../lib/motion.js'

const focusable = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// onBackdropClick (optional): replaces onClose for clicks on the backdrop only — forms with unsaved input use it
// so a stray click outside never discards what was typed. Esc and the × button still call onClose.
export default function Dialog({ open, onClose, onBackdropClick, title, description, children, size = 'md' }) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef(null)
  const returnFocus = useRef(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useLayoutEffect(() => {
    if (!open) return undefined
    returnFocus.current = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const panel = panelRef.current
    window.setTimeout(() => panel?.querySelector(focusable)?.focus(), 0)
    const keydown = (event) => {
      if (event.key === 'Escape') onCloseRef.current()
      if (event.key !== 'Tab' || !panel) return
      const items = [...panel.querySelectorAll(focusable)]
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keydown, true)
      returnFocus.current?.focus?.()
    }
  }, [open])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1, transition: enter }} exit={{ opacity: 0, transition: exit }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) (onBackdropClick || onClose)() }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onClose()
            }
          }}
        >
          <motion.section
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            className={`dialog-panel ${size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}
            initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: enter }} exit={{ opacity: 0, y: 12, scale: 0.98, transition: exit }}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-xl font-semibold text-heading">{title}</h2>
                {description && <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
              </div>
              <button type="button" onClick={onClose} aria-label="关闭弹窗" className="icon-button -mr-2 -mt-1 shrink-0" title="关闭（Esc）">
                <X size={20} />
              </button>
            </div>
            {children}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
