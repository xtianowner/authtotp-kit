import { useEffect, useId, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import Dialog from './ui/Dialog.jsx'
import CloseConfirm, { useBeforeUnloadWhile } from './ui/CloseConfirm.jsx'
import TokenLifetimeField, { useDefaultLifetime } from './ui/TokenLifetime.jsx'
import { post } from '../lib/api.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// 「新增令牌」 from an entry card: a caller whose allow-list is exactly this one entry, with a chosen lifetime.
// The entry is fixed (read-only header); 「给谁用」 is required, 「用途」 falls back to 「取码」. Same close rules as the
// other form dialogs: with unsaved input, backdrop / Esc / × / 取消 ask first. On success the parent shows the
// one-time token dialog (with the colleague code link) and reloads callers and the summary cards.
export default function AddTokenDialog({ entry, onClose, onCreated }) {
  const { t } = useLocale()
  const nameId = useId()
  const nameErrorId = useId()
  const lifetimeDefault = useDefaultLifetime()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [ttl, setTtl] = useState(null) // null = follow the server default until the owner picks one
  const [nameError, setNameError] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const ttlValue = ttl ?? (lifetimeDefault.ready ? lifetimeDefault.hours : null)
  useEffect(() => {
    setName(''); setPurpose(''); setTtl(null); setNameError(false); setError(''); setConfirmDiscard(false)
  }, [entry])
  const dirty = Boolean(entry) && (Boolean(name) || Boolean(purpose) || (ttl !== null && ttl !== lifetimeDefault.hours))
  useBeforeUnloadWhile(dirty)
  const requestClose = () => { if (busy) return; if (dirty) setConfirmDiscard(true); else onClose() }
  const submit = async (event) => {
    event.preventDefault(); setError('')
    if (!name.trim()) { setNameError(true); document.getElementById(nameId)?.focus(); return }
    if (ttlValue === null) return
    setBusy(true)
    try {
      const result = await post('/api/callers', {
        name: name.trim(),
        purpose: purpose.trim() || t('addToken.purposeDefault'),
        allowed_entry_ids: [entry.id],
        expires_in_hours: ttlValue,
      })
      onClose()
      await onCreated(result, entry)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={Boolean(entry)} onClose={requestClose} title={t('addToken.title')} description={t('addToken.description')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="token-entry" aria-label={t('addToken.entry')} data-testid="add-token-entry">
          <span className="vf-avatar" aria-hidden="true">{(entry?.issuer || entry?.label || '?').slice(0, 1).toUpperCase()}</span>
          <div className="min-w-0 flex-1">
            <p className="[overflow-wrap:anywhere] text-sm font-semibold leading-snug text-heading">{entry?.label}</p>
            <p className="mt-0.5 [overflow-wrap:anywhere] text-xs text-muted">{entry?.account_ref || entry?.issuer || t('addToken.noAccount')}</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field-group">
            <label htmlFor={nameId} className="mb-2 block">{t('addToken.name')}</label>
            <input id={nameId} className="field" value={name} maxLength={120} required aria-invalid={nameError || undefined} aria-describedby={nameError ? nameErrorId : undefined} onChange={(event) => { setName(event.target.value); if (event.target.value.trim()) setNameError(false) }} placeholder={t('addToken.namePlaceholder')} autoComplete="off" />
            {nameError && <p id={nameErrorId} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs font-normal text-danger"><AlertCircle size={14} className="mt-px shrink-0" aria-hidden="true" />{t('addToken.nameRequired')}</p>}
          </div>
          <label className="field-group"><span>{t('addToken.purpose')}</span><input className="field" value={purpose} maxLength={160} onChange={(event) => setPurpose(event.target.value)} placeholder={t('addToken.purposePlaceholder')} autoComplete="off" /></label>
        </div>
        <TokenLifetimeField value={ttlValue} onChange={setTtl} />
        {error && <p role="alert" className="form-error">{error}</p>}
        {confirmDiscard
          ? <CloseConfirm className="" title={t('form.discardTitle')} detail={t('form.discardText')} keepLabel={t('form.keepEditing')} confirmLabel={t('form.discard')} onKeep={() => setConfirmDiscard(false)} onConfirm={onClose} />
          : <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end"><button type="button" onClick={requestClose} className="btn-secondary">{t('common.cancel')}</button><button type="submit" disabled={busy || ttlValue === null} className="btn-primary">{busy ? t('addToken.submitting') : t('addToken.submit')}</button></div>}
      </form>
    </Dialog>
  )
}
