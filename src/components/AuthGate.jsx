import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, Globe2, KeyRound } from 'lucide-react'
import { motion } from 'motion/react'
import { enter } from '../lib/motion.js'
import { get, post } from '../lib/api.js'
import { authErrorMessage, isRecoveryCode, isTotpCode } from '../lib/authErrors.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'
import SecondFactorField from './ui/SecondFactorField.jsx'
import { usePrefersReducedMotion } from '../showcase/motion.js'
import { HudBackdrop, HudClock, HudFrame, ShowcaseFooter, ShowcaseTop } from '../showcase/chrome.jsx'
import GateOverlay from '../showcase/GateOverlay.jsx'
import { loginFigure } from '../brand/index.js'
import '../showcase/showcase.css'

function PasswordField({ value, onChange, label }) {
  const [visible, setVisible] = useState(false)
  return (
    <label className="field-group">
      <span>{label}</span>
      <div className="relative">
        <input className="field pr-12" type={visible ? 'text' : 'password'} autoComplete="current-password" value={value} onChange={(event) => onChange(event.target.value)} />
        <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? '隐藏密码' : '显示密码'} className="absolute inset-y-0 right-0 grid min-w-11 place-items-center text-muted hover:text-text">
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </label>
  )
}

// Vault gate. Signed out it is a display-layer page (dark showcase, 视觉基线 v1.4 §14): first-run setup, sign-in and
// the second factor (authenticator code or recovery code), with the door-pushing figure. A successful sign-in plays
// the light gate (GateOverlay) over the page; the inner pages (also dark — the whole site is) mount as the doors start
// to part and fade in over 0.45 s (.sc-arrive), so the hand-off is never a hard cut. Under reduced motion there is no
// gate and the same 0.45 s fade (opacity only) runs at once. Signed in on load: `children` render directly.
// gate: idle → closing (doors shut, 240 ms) → closed (waiting for the session) → opening (980 ms) → idle.
export default function AuthGate({ children, onUnlockStart }) {
  const [status, setStatus] = useState({ loading: true, bootstrapped: false, authenticated: false })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { t, locale } = useLocale()
  const [factorMode, setFactorMode] = useState('totp')
  const [code, setCode] = useState('')
  const [codeInvalid, setCodeInvalid] = useState(false)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [refocusCode, setRefocusCode] = useState(0)
  const [gate, setGate] = useState('idle')
  const codeRef = useRef(null)
  // Form mode captured when the gate starts: the status refresh lands while the doors are still fading in, and the
  // half-hidden page must not flip from 首次设置 to 解锁 underneath them.
  const gateForm = useRef(null)
  // How the inner pages arrive after a sign-in in this page load: 'gated' (mounted as the doors open → the fade waits
  // for them to start parting) or 'plain' (reduced motion / skipped gate → fade at once). null = signed in on load.
  const arrival = useRef(null)
  const titleId = useId()
  const reduced = usePrefersReducedMotion()

  const refresh = () => get('/api/auth/status')
    .then((data) => { setStatus({ ...data, loading: false }); return data })
    .catch(() => { setStatus({ loading: false, bootstrapped: false, authenticated: false, error: true }); return null })
  useEffect(() => { refresh() }, [])
  // Runs after the cleared code is committed, so focus lands on the first box rather than the stale last one.
  useEffect(() => { if (refocusCode) codeRef.current?.focus() }, [refocusCode])
  useEffect(() => {
    if (!lockedUntil) return undefined
    const timer = window.setTimeout(() => setLockedUntil(0), Math.max(0, lockedUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [lockedUntil])
  // Doors are shut and the session is confirmed: open the gate.
  useEffect(() => { if (gate === 'closed' && status.authenticated) setGate('opening') }, [gate, status.authenticated])
  if (status.loading) return <div className="grid min-h-screen place-items-center"><div className="loader" aria-label="正在载入" /></div>

  const unlocked = status.authenticated && (gate === 'idle' || gate === 'opening')
  const overlay = gate !== 'idle' && (
    <GateOverlay
      phase={gate}
      onClosed={() => setGate((current) => (current === 'closing' ? 'closed' : current))}
      onOpened={() => setGate('idle')}
      onSkip={() => setGate('idle')}
    />
  )
  if (unlocked) {
    if (gateForm.current && !arrival.current) arrival.current = gate === 'opening' ? 'gated' : 'plain'
    const page = arrival.current ? <div className={`sc-arrive${arrival.current === 'gated' ? ' is-gated' : ''}`}>{children}</div> : children
    return <>{page}{overlay}</>
  }

  const frozen = gate !== 'idle' ? gateForm.current : null
  const setup = frozen ? frozen.setup : !status.bootstrapped
  const needsCode = frozen ? frozen.needsCode : !setup && Boolean(status.totp_enrolled)
  const locked = lockedUntil > 0
  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setCodeInvalid(false)
    if (setup && password.length < 12) return setError('管理密码至少需要 12 个字符。')
    if (setup && password !== confirm) return setError('两次输入的密码不一致。')
    if (needsCode && !(factorMode === 'totp' ? isTotpCode(code) : isRecoveryCode(code))) {
      setCodeInvalid(true)
      codeRef.current?.focus()
      return setError(factorMode === 'totp' ? t('auth.codeRequired') : t('auth.recoveryInvalid'))
    }
    setSubmitting(true)
    try {
      await post(setup ? '/api/auth/bootstrap' : '/api/auth/login', needsCode ? { password, code } : { password })
      setCode('')
      onUnlockStart?.() // start fetching the vault pages while the doors close
      gateForm.current = { setup, needsCode }
      if (!reduced) setGate('closing')
      const next = await refresh()
      if (!next?.authenticated) setGate('idle')
    } catch (requestError) {
      const errorCode = requestError.code
      if (errorCode === 'TOTP_CODE_REQUIRED') setStatus((current) => ({ ...current, totp_enrolled: true }))
      if (errorCode === 'BOOTSTRAP_REQUIRED') refresh()
      if (errorCode === 'LOGIN_LOCKED' && requestError.retryAfter) setLockedUntil(Date.now() + requestError.retryAfter * 1000)
      if (errorCode === 'INVALID_CREDENTIALS') {
        setCode('')
        setCodeInvalid(true)
        setRefocusCode((current) => current + 1)
      }
      setError(authErrorMessage(t, locale, requestError, { recoveryMode: factorMode === 'recovery' }))
    } finally {
      setSubmitting(false)
    }
  }

  const figure = loginFigure
  const figureStyle = figure ? { '--fig-ratio': `${figure.width} / ${figure.height}` } : undefined
  return (
    <div className="sc sc-login">
      <HudBackdrop />
      <HudFrame left="[ VAULT ]" right={setup ? 'FIRST RUN · SETUP' : 'OWNER ONLY · LOCKED'} />
      <a href="#vault-login" className="skip-link">{t('common.skip')}</a>
      <ShowcaseTop brandLabel={t('public.homeLabel')}>
        <HudClock />
      </ShowcaseTop>
      <main id="vault-login" className="sc-frame sc-login-main" tabIndex="-1">
        <div className="sc-login-stage" aria-hidden="true">
          <div className="sc-halo" />
          <div className="sc-pool" />
          {figure && (
            <>
              <img className="sc-fig-reflect" src={figure.src} alt="" width={figure.width} height={figure.height} style={figureStyle} decoding="async" />
              <img className="sc-fig" src={figure.src} alt="" width={figure.width} height={figure.height} style={figureStyle} decoding="async" />
            </>
          )}
        </div>
        <motion.section initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0, transition: enter }} className="sc-panel sc-login-panel" aria-labelledby={titleId}>
          <span className="sc-bracket sc-bracket-tl" aria-hidden="true" />
          <span className="sc-bracket sc-bracket-br" aria-hidden="true" />
          <div className="sc-panel-head sc-mono" aria-hidden="true">
            <span>VAULT · {setup ? 'SETUP' : 'AUTH'}</span>
            <span className="is-locked">{needsCode ? 'PASSWORD + TOTP' : 'PASSWORD'}</span>
          </div>
          <div className="mb-1 inline-flex items-center gap-2 rounded-full border border-border bg-tint px-3 py-1 text-xs font-semibold text-muted"><KeyRound size={14} />{setup ? '首次安全设置' : '本地控制台已锁定'}</div>
          <h1 id={titleId} className="sc-login-title">{setup ? '创建管理密码' : '解锁验证码库'}</h1>
          {/* Setup hint, true for both deployments (Mac: Keychain; server: protected key file). Both languages live here rather
              than in messages.js, which the public build bundles. */}
          <p className="sc-login-hint">{setup ? (locale === 'en' ? 'The password only unlocks this console; the TOTP master key is held by the server (the macOS Keychain on a Mac, a protected key file on a server) and is never shown on the page.' : '密码只用于解锁本机控制台；TOTP 主密钥由服务器托管（Mac 本机用钥匙串，服务器用受保护的密钥文件），不会显示在页面上。') : needsCode ? t('auth.unlockHintTotp') : t('auth.unlockHint')}</p>
          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <PasswordField value={password} onChange={setPassword} label="管理密码" />
            {setup && <PasswordField value={confirm} onChange={setConfirm} label="再次输入" />}
            {needsCode && <SecondFactorField fieldRef={codeRef} mode={factorMode} onModeChange={setFactorMode} code={code} onCodeChange={(value) => { setCode(value); setCodeInvalid(false) }} invalid={codeInvalid} />}
            {error && <p role="alert" className="form-error">{error}</p>}
            <button className="btn-primary w-full" type="submit" disabled={submitting || locked}>{locked ? t('auth.lockedButton') : submitting ? '正在处理…' : setup ? '完成设置并进入' : '解锁控制台'}</button>
          </form>
          <div className="sc-login-foot"><a href="/" className="btn-quiet"><Globe2 size={16} />使用公开本地生成工具</a><p>公开工具与这座私有保险库相互隔离。</p></div>
        </motion.section>
      </main>
      <ShowcaseFooter />
      {overlay}
    </div>
  )
}
