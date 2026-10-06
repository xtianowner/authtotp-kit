import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Clipboard, Download, Eye, EyeOff, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react'
import Dialog from './ui/Dialog.jsx'
import SecondFactorField from './ui/SecondFactorField.jsx'
import { useToast } from './ui/Toast.jsx'
import { CopyLock, useCopyFeedback } from './ui/copyFeedback.jsx'
import { api, get, post } from '../lib/api.js'
import { authErrorMessage, isRecoveryCode, isTotpCode } from '../lib/authErrors.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// Steps: loading | load-error | off | scan | codes | on | regenerate | disable | disable-confirm
// Secrets (setup key, QR, recovery codes) live only in React state and are wiped on every close.
const initialState = { step: 'loading', setup: null, qr: '', qrFailed: false, codes: null, codesToast: '', refocusCode: 0, ack: false, ackPrompt: false, code: '', mode: 'totp', password: '', error: '', codeInvalid: false }

function Notice({ children }) {
  return (
    <p className="notice-warning">
      <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function PasswordInput({ value, onChange, label, inputRef }) {
  const { t } = useLocale()
  const [visible, setVisible] = useState(false)
  return (
    <label className="field-group">
      <span>{label}</span>
      <div className="relative">
        <input ref={inputRef} className="field pr-12" type={visible ? 'text' : 'password'} autoComplete="current-password" value={value} onChange={(event) => onChange(event.target.value)} />
        <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? t('twofa.hidePassword') : t('twofa.showPassword')} className="absolute inset-y-0 right-0 grid min-w-11 place-items-center text-muted hover:text-text">
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </label>
  )
}

export default function TwoFactorDialog({ open, onClose, onStatusChange }) {
  const { t, locale } = useLocale()
  const { push } = useToast()
  const [state, setState] = useState(initialState)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const focusRef = useRef(null)
  const codeRef = useRef(null)
  const ackRef = useRef(null)
  const statusListener = useRef(onStatusChange)
  useEffect(() => { statusListener.current = onStatusChange }, [onStatusChange])
  const patch = useCallback((next) => setState((current) => ({ ...current, ...next })), [])
  const { step, setup, codes, ack, code, mode, password, error } = state

  const applyStatus = useCallback((data) => {
    setStatus(data)
    statusListener.current?.(data)
  }, [])
  const load = useCallback(async () => {
    setState(initialState)
    try {
      const data = await get('/api/auth/status')
      if (!data.authenticated) { window.location.reload(); return }
      applyStatus(data)
      setState({ ...initialState, step: data.totp_enrolled ? 'on' : 'off' })
    } catch {
      setState({ ...initialState, step: 'load-error' })
    }
  }, [applyStatus])
  useEffect(() => {
    if (open) load()
    else setState(initialState)
  }, [open, load])

  // Move focus to the main control of each step (the dialog itself focuses its close button on open).
  const focusCodeFirst = step === 'scan' || step === 'regenerate' || (step === 'disable' && state.codeInvalid)
  useEffect(() => {
    if (!open) return undefined
    const timer = window.setTimeout(() => (focusCodeFirst ? codeRef : focusRef).current?.focus(), 40)
    return () => window.clearTimeout(timer)
    // Runs per step change only; focusCodeFirst is read from the render that changed the step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step])

  // After a rejected code the boxes are cleared; refocus once that render is committed.
  useEffect(() => { if (state.refocusCode) codeRef.current?.focus() }, [state.refocusCode])

  // QR is drawn locally from the otpauth URI; nothing leaves the browser.
  useEffect(() => {
    if (!setup?.otpauth_uri) return undefined
    let cancelled = false
    import('qrcode')
      .then((module) => (module.default ?? module).toDataURL(setup.otpauth_uri, { errorCorrectionLevel: 'M', margin: 2, width: 384 }))
      .then((url) => { if (!cancelled) patch({ qr: url, qrFailed: false }) })
      .catch(() => { if (!cancelled) patch({ qr: '', qrFailed: true }) })
    return () => { cancelled = true }
  }, [setup, patch])

  // Recovery codes are unrecoverable once dismissed, so a reload/tab close asks first.
  useEffect(() => {
    if (!(open && step === 'codes' && !ack)) return undefined
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [open, step, ack])

  const requestClose = () => {
    if (step === 'codes' && !ack) {
      patch({ ackPrompt: true })
      ackRef.current?.focus()
      return
    }
    if (step === 'codes') push(state.codesToast)
    setState(initialState)
    onClose()
  }
  // The success toast waits until the codes are acknowledged so it never covers the ack checkbox on phones.
  const finishCodes = () => {
    push(state.codesToast)
    setState({ ...initialState, step: 'on' })
  }
  const goto = (next) => setState((current) => ({ ...current, step: next, error: '', code: '', mode: 'totp', password: '', codeInvalid: false }))

  const fail = (requestError, { recoveryMode = false } = {}) => {
    if (requestError.status === 401) { window.location.reload(); return }
    const message = authErrorMessage(t, locale, requestError, { recoveryMode })
    if (['TOTP_ALREADY_ENROLLED', 'TOTP_NOT_ENROLLED', 'TOTP_SETUP_REQUIRED'].includes(requestError.code)) {
      push(message, 'error')
      load()
      return
    }
    const wrongCode = ['INVALID_TOTP_CODE', 'INVALID_CREDENTIALS'].includes(requestError.code)
    setState((current) => ({ ...current, error: message, ...(wrongCode ? { code: '', codeInvalid: true, refocusCode: current.refocusCode + 1 } : {}) }))
  }
  const checkCode = (allowRecovery) => {
    const ok = mode === 'totp' || !allowRecovery ? isTotpCode(code) : isRecoveryCode(code)
    if (ok) return true
    patch({ error: mode === 'totp' || !allowRecovery ? t('auth.codeRequired') : t('auth.recoveryInvalid'), codeInvalid: true })
    codeRef.current?.focus()
    return false
  }
  const run = async (task) => {
    setBusy(true)
    try { await task() } finally { setBusy(false) }
  }

  const startSetup = () => run(async () => {
    patch({ error: '' })
    try {
      const data = await api('/api/auth/totp/setup', { method: 'POST' })
      setState({ ...initialState, step: 'scan', setup: data })
    } catch (requestError) { fail(requestError) }
  })
  const confirmSetup = (event) => {
    event.preventDefault()
    if (!checkCode(false)) return
    run(async () => {
      try {
        const data = await post('/api/auth/totp/confirm', { code })
        setState({ ...initialState, step: 'codes', codes: data.recovery_codes, codesToast: t('twofa.enabledToast') })
        applyStatus({ ...status, totp_enrolled: true })
      } catch (requestError) { fail(requestError) }
    })
  }
  const regenerate = (event) => {
    event.preventDefault()
    if (!checkCode(true)) return
    run(async () => {
      try {
        const data = await post('/api/auth/recovery-codes/regenerate', { code })
        setState({ ...initialState, step: 'codes', codes: data.recovery_codes, codesToast: t('twofa.regeneratedToast') })
      } catch (requestError) { fail(requestError, { recoveryMode: mode === 'recovery' }) }
    })
  }
  const reviewDisable = (event) => {
    event.preventDefault()
    if (!password) {
      patch({ error: t('twofa.passwordRequired') })
      focusRef.current?.focus()
      return
    }
    if (!checkCode(true)) return
    patch({ step: 'disable-confirm', error: '' })
  }
  const disable = () => run(async () => {
    try {
      await post('/api/auth/totp/disable', { password, code })
      setState({ ...initialState, step: 'off' })
      applyStatus({ ...status, totp_enrolled: false })
      push(t('twofa.disabledToast'))
    } catch (requestError) {
      patch({ step: 'disable' })
      fail(requestError, { recoveryMode: mode === 'recovery' })
    }
  })

  // Unified copy feedback (corner lock + 「已复制」 for 1.5 s + toasts), one per button.
  const secretCopy = useCopyFeedback({ copiedMessage: t('twofa.secretCopied'), failedMessage: t('twofa.copyFailed') })
  const codesCopy = useCopyFeedback({ copiedMessage: t('twofa.copiedAll'), failedMessage: t('twofa.copyFailed') })
  const downloadCodes = () => {
    const now = new Date()
    const time = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(now)
    const lines = [t('twofa.fileTitle'), t('twofa.fileGenerated').replace('{time}', time), t('twofa.fileNote'), '', ...codes.map((item, index) => `${String(index + 1).padStart(2, ' ')}. ${item}`), '']
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    link.href = url
    link.download = `authtotp-recovery-codes-${stamp}.txt`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const factorField = (allowRecovery, label) => (
    <SecondFactorField
      fieldRef={codeRef}
      mode={allowRecovery ? mode : 'totp'}
      onModeChange={(next) => patch({ mode: next, error: '', codeInvalid: false })}
      code={code}
      onCodeChange={(next) => patch({ code: next, codeInvalid: false })}
      allowRecovery={allowRecovery}
      label={label}
      invalid={state.codeInvalid}
      disabled={busy}
    />
  )
  const errorLine = error ? <p role="alert" className="form-error">{error}</p> : null
  const actions = 'flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end'

  const titles = {
    loading: [t('twofa.title'), ''],
    'load-error': [t('twofa.title'), ''],
    off: [t('twofa.title'), t('twofa.enrollDescription')],
    scan: [t('twofa.scanTitle'), t('twofa.scanDescription')],
    codes: [t('twofa.codesTitle'), t('twofa.codesDescription')],
    on: [t('twofa.title'), ''],
    regenerate: [t('twofa.regenerate'), t('twofa.regenerateDescription')],
    disable: [t('twofa.disable'), t('twofa.disableDescription')],
    'disable-confirm': [t('twofa.disableConfirmTitle'), t('twofa.disableConfirmText')],
  }
  const [title, description] = titles[step]

  return (
    <Dialog open={open} onClose={requestClose} title={title} description={description || undefined} size="lg">
      {step === 'loading' && <div className="grid min-h-40 place-items-center"><div className="loader" role="status" aria-label={t('common.loading')} /></div>}

      {step === 'load-error' && (
        <div className="space-y-4">
          <p role="alert" className="form-error">{t('twofa.loadFailed')}</p>
          <div className={actions}><button ref={focusRef} type="button" className="btn-secondary" onClick={load}><RefreshCw size={16} />{t('common.retry')}</button></div>
        </div>
      )}

      {step === 'off' && (
        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-card border border-border bg-tint p-4">
            <ShieldOff size={20} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold text-heading">{t('twofa.offTitle')}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{t('twofa.offText')}</p>
            </div>
          </div>
          {status?.totp_required && <Notice>{t('twofa.requiredNote')}</Notice>}
          {errorLine}
          <div className={actions}>
            <button type="button" className="btn-secondary" onClick={requestClose}>{t('common.close')}</button>
            <button ref={focusRef} type="button" className="btn-primary" onClick={startSetup} disabled={busy}><Smartphone size={17} />{busy ? t('twofa.processing') : t('twofa.enroll')}</button>
          </div>
        </div>
      )}

      {step === 'scan' && setup && (
        <form onSubmit={confirmSetup} className="space-y-5" noValidate>
          <section>
            <h3 className="text-sm font-medium text-heading">{t('twofa.stepScan')}</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
              <div className="mx-auto grid h-48 w-48 place-items-center overflow-hidden rounded-card border border-border bg-tint sm:mx-0">
                {state.qr
                  ? <img src={state.qr} alt={t('twofa.qrAlt')} className="h-full w-full" />
                  : state.qrFailed
                    ? <p className="p-4 text-center text-xs leading-relaxed text-muted">{t('twofa.qrFailed')}</p>
                    : <div className="loader" role="status" aria-label={t('common.loading')} />}
              </div>
              <div className="code-block min-w-0 p-4">
                <p className="text-xs font-medium text-muted">{t('twofa.manualTitle')}</p>
                <p className="mt-2 select-all [overflow-wrap:anywhere] font-mono text-base font-semibold leading-relaxed text-heading">{setup.secret_base32.match(/.{1,4}/g).join(' ')}</p>
                <p className="mt-2 text-xs leading-relaxed text-muted">{t('twofa.manualMeta')}</p>
                <button type="button" className="btn-secondary vm-copy mt-3 w-full sm:w-auto" onClick={() => secretCopy.copy(setup.secret_base32)}>
                  {secretCopy.copied ? <Check size={16} /> : <Clipboard size={16} />}{secretCopy.copied ? t('common.copied') : t('twofa.copySecret')}
                  <CopyLock on={secretCopy.copied} />
                </button>
              </div>
            </div>
          </section>
          {factorField(false, t('twofa.stepConfirm'))}
          <p className="text-xs leading-relaxed text-muted">{t('twofa.newSecretNote')}</p>
          {errorLine}
          <div className={actions}>
            <button type="button" className="btn-secondary" onClick={requestClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn-primary" disabled={busy}><Check size={17} />{busy ? t('twofa.processing') : t('twofa.confirm')}</button>
          </div>
        </form>
      )}

      {step === 'codes' && codes && (
        <div className="space-y-4">
          <div className="sensitive-panel">
            <div className="flex items-start gap-3">
              <ShieldAlert size={22} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-base font-semibold text-text">{t('twofa.codesWarning')}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t('twofa.codesWarningText')}</p>
              </div>
            </div>
            <ol aria-label={t('twofa.codesListLabel')} className="mt-4 grid grid-cols-2 gap-2">
              {codes.map((item, index) => (
                <li key={item} className="code-block flex min-w-0 items-center gap-2 px-3 py-2">
                  <span className="w-5 shrink-0 text-right font-mono text-xs text-muted" aria-hidden="true">{index + 1}</span>
                  <code className="min-w-0 select-all break-all font-mono text-sm font-semibold tracking-wider text-heading sm:text-base">{item}</code>
                </li>
              ))}
            </ol>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button ref={focusRef} type="button" className="btn-secondary vm-copy" onClick={() => codesCopy.copy(codes.join('\n'))}>
              {codesCopy.copied ? <Check size={16} /> : <Clipboard size={16} />}{codesCopy.copied ? t('twofa.copiedAll') : t('twofa.copyAll')}
              <CopyLock on={codesCopy.copied} />
            </button>
            <button type="button" className="btn-secondary" onClick={downloadCodes}><Download size={16} />{t('twofa.download')}</button>
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-border bg-tint px-3 py-3 text-sm font-semibold text-heading">
            <input ref={ackRef} type="checkbox" checked={ack} onChange={(event) => patch({ ack: event.target.checked, ackPrompt: false })} className="mt-0.5 h-4 w-4 shrink-0 accent-accent" />
            <span>{t('twofa.ack')}</span>
          </label>
          <div role="status" aria-live="polite">{state.ackPrompt && !ack && <Notice>{t('twofa.ackRequired')}</Notice>}</div>
          <button type="button" className="btn-primary w-full" disabled={!ack} onClick={finishCodes}><Check size={17} />{t('twofa.done')}</button>
        </div>
      )}

      {step === 'on' && (
        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-card border border-border bg-tint p-4">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold text-heading">{t('twofa.onTitle')}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{t('twofa.onText')}</p>
            </div>
          </div>
          <div className="divide-y divide-border rounded-card border border-border">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-sm leading-relaxed text-muted">{t('twofa.regenerateHint')}</p>
              <button ref={focusRef} type="button" className="btn-secondary shrink-0" onClick={() => goto('regenerate')}><RefreshCw size={16} />{t('twofa.regenerate')}</button>
            </div>
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-sm leading-relaxed text-muted">{t('twofa.disableHint')}</p>
              <button type="button" className="btn-danger-quiet shrink-0" onClick={() => goto('disable')}><ShieldOff size={16} />{t('twofa.disable')}</button>
            </div>
          </div>
          <div className={actions}><button type="button" className="btn-secondary" onClick={requestClose}>{t('common.close')}</button></div>
        </div>
      )}

      {step === 'regenerate' && (
        <form onSubmit={regenerate} className="space-y-5" noValidate>
          {factorField(true)}
          {errorLine}
          <div className={actions}>
            <button type="button" className="btn-secondary" onClick={() => goto('on')}><ArrowLeft size={16} />{t('twofa.back')}</button>
            <button type="submit" className="btn-primary" disabled={busy}><RefreshCw size={16} />{busy ? t('twofa.processing') : t('twofa.regenerateSubmit')}</button>
          </div>
        </form>
      )}

      {step === 'disable' && (
        <form onSubmit={reviewDisable} className="space-y-5" noValidate>
          <PasswordInput inputRef={focusRef} value={password} onChange={(next) => patch({ password: next })} label={t('twofa.password')} />
          {factorField(true)}
          {errorLine}
          <div className={actions}>
            <button type="button" className="btn-secondary" onClick={() => goto('on')}><ArrowLeft size={16} />{t('twofa.back')}</button>
            <button type="submit" className="btn-primary">{t('twofa.disableContinue')}</button>
          </div>
        </form>
      )}

      {step === 'disable-confirm' && (
        <div className="space-y-5">
          {errorLine}
          <div className={actions}>
            <button ref={focusRef} type="button" className="btn-secondary" onClick={() => goto('on')}>{t('common.cancel')}</button>
            <button type="button" className="btn-danger" onClick={disable} disabled={busy}><ShieldOff size={16} />{busy ? t('twofa.processing') : t('twofa.disableConfirm')}</button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
