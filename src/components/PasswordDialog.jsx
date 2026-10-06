import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, KeyRound, LockKeyhole, RefreshCw, ShieldAlert } from 'lucide-react'
import Dialog from './ui/Dialog.jsx'
import SecondFactorField from './ui/SecondFactorField.jsx'
import { useToast } from './ui/Toast.jsx'
import { get, post } from '../lib/api.js'
import { authErrorMessage, isRecoveryCode, isTotpCode } from '../lib/authErrors.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// Change the admin password (POST /api/auth/password). Passwords live only in React state: they are wiped on
// every close and never persisted as a draft. With typed input, a backdrop click keeps the dialog open and
// Esc / × / Cancel ask before discarding.
const emptyForm = { current: '', next: '', confirm: '', code: '', mode: 'totp' }

function Notice({ children }) {
  return (
    <p className="notice-warning">
      <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function PasswordInput({ value, onChange, label, inputRef, autoComplete, invalid, helper, disabled }) {
  const { t } = useLocale()
  const helperId = useId()
  const [visible, setVisible] = useState(false)
  return (
    <label className="field-group">
      <span>{label}</span>
      <div className="relative">
        <input ref={inputRef} className={`field pr-12 ${invalid ? 'border-danger' : ''}`} type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={invalid || undefined} aria-describedby={helper ? helperId : undefined} disabled={disabled} spellCheck={false} autoCapitalize="off" />
        <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? t('twofa.hidePassword') : t('twofa.showPassword')} className="absolute inset-y-0 right-0 grid min-w-11 place-items-center text-muted hover:text-text">
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {helper && <p id={helperId} className="mt-2 text-xs font-normal leading-relaxed text-muted">{helper}</p>}
    </label>
  )
}

const fieldFromValidation = (fields = []) => {
  const names = fields.map((item) => item.loc.at(-1))
  if (names.includes('new_password')) return 'next'
  if (names.includes('current_password')) return 'current'
  if (names.includes('code')) return 'code'
  return null
}

export default function PasswordDialog({ open, onClose }) {
  const { t, locale } = useLocale()
  const { push } = useToast()
  const [phase, setPhase] = useState('loading') // loading | load-error | signed-out | form
  const [enrolled, setEnrolled] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState(null) // { message, field }
  const [errorSeq, setErrorSeq] = useState(0)
  const [busy, setBusy] = useState(false)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const [backdropHint, setBackdropHint] = useState(false)
  const refs = { current: useRef(null), next: useRef(null), confirm: useRef(null), code: useRef(null) }
  const keepEditingRef = useRef(null)
  const dirty = Boolean(form.current || form.next || form.confirm || form.code)
  const locked = lockedUntil > 0

  const reset = () => {
    setForm(emptyForm); setError(null); setBusy(false); setDiscardPrompt(false); setBackdropHint(false)
  }
  const load = async () => {
    setPhase('loading')
    try {
      const data = await get('/api/auth/status')
      setEnrolled(Boolean(data.totp_enrolled))
      setPhase(data.authenticated ? 'form' : 'signed-out')
    } catch {
      setPhase('load-error')
    }
  }
  useEffect(() => {
    if (open) load()
    else reset()
    // load is stable in behaviour; re-run only when the dialog opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!(open && phase === 'form')) return undefined
    const timer = window.setTimeout(() => refs.current.current?.focus(), 40)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase])
  // Focus the field an error points at, after the render that shows the error.
  useEffect(() => {
    if (!errorSeq || !error?.field) return
    refs[error.field]?.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorSeq])
  useEffect(() => { if (discardPrompt) keepEditingRef.current?.focus() }, [discardPrompt])
  useEffect(() => {
    if (!lockedUntil) return undefined
    const timer = window.setTimeout(() => setLockedUntil(0), Math.max(0, lockedUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [lockedUntil])
  useEffect(() => {
    if (!(open && dirty)) return undefined
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [open, dirty])

  const close = () => { reset(); onClose() }
  const requestClose = () => {
    if (busy) return
    if (dirty && phase === 'form') { setDiscardPrompt(true); setBackdropHint(false); return }
    close()
  }
  const backdrop = () => {
    if (busy) return
    if (dirty && phase === 'form') { setBackdropHint(true); return }
    close()
  }
  const update = (key) => (value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setBackdropHint(false)
    if (error?.field === key || (key === 'next' && error?.field === 'confirm')) setError(null)
  }
  const fail = (message, field = null) => { setError({ message, field }); setErrorSeq((current) => current + 1) }

  const submit = async (event) => {
    event.preventDefault()
    if (busy || locked) return
    setDiscardPrompt(false); setBackdropHint(false)
    if (!form.current) return fail(t('password.currentRequired'), 'current')
    if (!form.next) return fail(t('password.newRequired'), 'next')
    if (form.confirm !== form.next) return fail(t('password.mismatch'), 'confirm')
    if (enrolled && !(form.mode === 'totp' ? isTotpCode(form.code) : isRecoveryCode(form.code))) {
      return fail(form.mode === 'totp' ? t('auth.codeRequired') : t('auth.recoveryInvalid'), 'code')
    }
    setBusy(true); setError(null)
    try {
      await post('/api/auth/password', { current_password: form.current, new_password: form.next, ...(enrolled ? { code: form.code } : {}) })
      push(t('password.success'))
      close()
    } catch (requestError) {
      setBusy(false)
      const code = requestError.code
      if (requestError.status === 401) { window.location.reload(); return }
      if (code === 'PASSWORD_UNCHANGED') return fail(t('auth.error.PASSWORD_UNCHANGED'), 'next')
      if (code === 'TOTP_CODE_REQUIRED') { setEnrolled(true); return fail(t('auth.error.TOTP_CODE_REQUIRED'), 'code') }
      if (code === 'INVALID_CREDENTIALS') {
        // Same answer whichever factor was wrong; the code box is cleared because a TOTP step may be spent.
        setForm((current) => ({ ...current, code: '' }))
        return fail(enrolled ? t('password.invalid') : t('password.invalidNoTotp'), enrolled ? 'code' : 'current')
      }
      if ((code === 'LOGIN_LOCKED' || code === 'RATE_LIMITED') && requestError.retryAfter) setLockedUntil(Date.now() + requestError.retryAfter * 1000)
      return fail(authErrorMessage(t, locale, requestError, { recoveryMode: form.mode === 'recovery' }), code === 'VALIDATION_ERROR' ? fieldFromValidation(requestError.fields) : null)
    }
    setBusy(false)
  }

  const actions = 'flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end'
  const invalid = (field) => error?.field === field
  return (
    <Dialog open={open} onClose={requestClose} onBackdropClick={backdrop} title={t('password.title')} description={t('password.description')}>
      {phase === 'loading' && <div className="grid min-h-40 place-items-center"><div className="loader" role="status" aria-label={t('common.loading')} /></div>}
      {phase === 'load-error' && (
        <div className="space-y-4">
          <p role="alert" className="form-error">{t('password.loadFailed')}</p>
          <div className={actions}><button type="button" className="btn-secondary" onClick={load}><RefreshCw size={16} />{t('common.retry')}</button></div>
        </div>
      )}
      {phase === 'signed-out' && (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted">{t('password.signedOut')}</p>
          <div className={actions}>
            <button type="button" className="btn-secondary" onClick={close}>{t('common.close')}</button>
            <a href="/vault" className="btn-primary"><LockKeyhole size={16} />{t('nav.vault')}</a>
          </div>
        </div>
      )}
      {phase === 'form' && (
        <form onSubmit={submit} className="space-y-5" noValidate>
          <PasswordInput inputRef={refs.current} label={t('password.current')} autoComplete="current-password" value={form.current} onChange={update('current')} invalid={invalid('current')} disabled={busy} />
          <PasswordInput inputRef={refs.next} label={t('password.new')} autoComplete="new-password" value={form.next} onChange={update('next')} invalid={invalid('next')} helper={t('password.newHelper')} disabled={busy} />
          <PasswordInput inputRef={refs.confirm} label={t('password.confirm')} autoComplete="new-password" value={form.confirm} onChange={update('confirm')} invalid={invalid('confirm')} disabled={busy} />
          {enrolled && (
            <SecondFactorField
              fieldRef={refs.code}
              mode={form.mode}
              onModeChange={(next) => { setForm((current) => ({ ...current, mode: next })); if (error?.field === 'code') setError(null) }}
              code={form.code}
              onCodeChange={update('code')}
              invalid={invalid('code')}
              disabled={busy}
            />
          )}
          {error && <p role="alert" className="form-error">{error.message}</p>}
          {/* Always mounted so the hint is announced; while empty it is taken out of flow (no extra form gap). */}
          <div role="status" aria-live="polite" className="empty:absolute">{backdropHint && <Notice>{t('password.backdropHint')}</Notice>}</div>
          {discardPrompt ? (
            <div className="rounded-card border border-border bg-tint p-4">
              <p className="text-sm font-semibold text-heading">{t('password.discardTitle')}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{t('password.discardText')}</p>
              <div className={`${actions} mt-3`}>
                <button type="button" className="btn-danger-quiet" onClick={close}>{t('password.discard')}</button>
                <button ref={keepEditingRef} type="button" className="btn-secondary" onClick={() => setDiscardPrompt(false)}>{t('password.keepEditing')}</button>
              </div>
            </div>
          ) : (
            <div className={actions}>
              <button type="button" className="btn-secondary" onClick={requestClose} disabled={busy}>{t('common.cancel')}</button>
              <button type="submit" className="btn-primary" disabled={busy || locked}><KeyRound size={17} />{locked ? t('auth.lockedButton') : busy ? t('twofa.processing') : t('password.submit')}</button>
            </div>
          )}
        </form>
      )}
    </Dialog>
  )
}
