import { useCallback, useEffect, useState } from 'react'
import { useToast } from './Toast.jsx'

// Unified copy feedback for the vault's inner pages (视觉基线 v1.3 §3 / §5, 干活层; §13 AuthTOTP HUD language):
// on success four L-shaped corner marks close in from outside onto the button's edges (~0.3 s), hold while the
// button reads 「已复制」 (1.5 s), then fade out with it; success / failure toasts as before. Vault-only — the
// public build never imports this file. Styles: src/styles/vault-motion.css (.vm-copy / .vm-lock).
export const COPIED_MS = 1500

// Corner marks. Put it inside a button that has the `vm-copy` class and pass the button's copied state.
export function CopyLock({ on }) {
  return <span className={`vm-lock${on ? ' is-on' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>
}

// copy(text): write the text; success → `copied` for COPIED_MS (a repeat click restarts the window) + success
// toast; failure → error toast.
export function useCopyFeedback({ copiedMessage, failedMessage }) {
  const { push } = useToast()
  const [copied, setCopied] = useState(0)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(0), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied((current) => current + 1)
      if (copiedMessage) push(copiedMessage)
    } catch {
      setCopied(0)
      push(failedMessage, 'error')
    }
  }, [copiedMessage, failedMessage, push])
  return { copied: copied > 0, copy }
}
