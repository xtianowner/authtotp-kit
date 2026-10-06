import { Check, Clipboard } from 'lucide-react'
import { useLocale } from '../../i18n/LocaleProvider.jsx'
import { CopyLock, useCopyFeedback } from './copyFeedback.jsx'

// Copy chip used next to entry IDs, caller credentials and commands: clipboard → toast, HUD corner marks lock on,
// the chip reads 「已复制」 for 1.5 s (min-width holds both labels, so nothing reflows); a failed write raises an
// error toast. Always copies the full `value`, however the caller displays it. `label` is the accessible name.
export default function CopyButton({ value, label, copiedMessage, failedMessage, className = '' }) {
  const { t } = useLocale()
  const { copied, copy } = useCopyFeedback({ copiedMessage, failedMessage })
  return (
    <button type="button" onClick={() => copy(value)} className={`copy-chip vm-copy ${copied ? 'is-copied' : ''} ${className}`} aria-label={label} title={label}>
      {copied ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
      <span aria-hidden="true">{copied ? t('common.copied') : t('common.copy')}</span>
      <CopyLock on={copied} />
    </button>
  )
}
