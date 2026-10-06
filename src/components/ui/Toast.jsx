import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { enter, exit } from '../../lib/motion.js'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const dismiss = useCallback((id) => setItems((current) => current.filter((item) => item.id !== id)), [])
  const push = useCallback((message, tone = 'success') => {
    const id = crypto.randomUUID()
    setItems((current) => [...current, { id, message, tone }])
    window.setTimeout(() => dismiss(id), 3000)
  }, [dismiss])
  const value = useMemo(() => ({ push }), [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-region pointer-events-none fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-toast flex flex-col items-end gap-2 sm:bottom-6" aria-live="polite">
          <AnimatePresence>
            {items.map((item) => (
              <motion.div key={item.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: enter }} exit={{ opacity: 0, x: 16, transition: exit }} className={`toast-item ${item.tone === 'error' ? 'is-error' : 'is-success'}`}>
                {item.tone === 'error' ? <CircleAlert className="shrink-0 text-danger" size={19} aria-hidden="true" /> : <CheckCircle2 className="shrink-0 text-accent" size={19} aria-hidden="true" />}
                <span className="min-w-0 flex-1 text-sm font-semibold text-heading">{item.message}</span>
                <button type="button" onClick={() => dismiss(item.id)} aria-label="关闭提示" className="icon-button shrink-0"><X size={16} /></button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>, document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}

