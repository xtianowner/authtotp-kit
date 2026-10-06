import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowUp, Check, Copy, Eye, EyeOff, KeyRound, LockKeyhole, Settings } from 'lucide-react'
import PreferencesDialog from './PreferencesDialog.jsx'
import { useLocale } from '../i18n/LocaleProvider.jsx'
import { useToast } from './ui/Toast.jsx'
import { decodeBase32, generateTotp, normalizeBase32Secret, secondsRemaining } from '../lib/totp.js'
import { backToField, usePrefersReducedMotion, useRevealOnScroll } from '../showcase/motion.js'
import Decoder from '../showcase/Decoder.jsx'
import CountdownRing from '../showcase/CountdownRing.jsx'
import ShieldPoster from '../showcase/ShieldPoster.jsx'
import { HudBackdrop, HudClock, HudFrame, ShowcaseFooter, ShowcaseTop } from '../showcase/chrome.jsx'
import { homeFigure } from '../brand/index.js'
import '../showcase/showcase.css'

// Public tool home (display layer; AuthTOTP is dark-only — 视觉基线 v1.4 §14; design = showcase lab candidate 4 「合版」):
//   screen 1  HUD hero: the working generator + 3D keyhole shield over the horizon aurora
//   screen 2  dark-studio figure in front of the hologram shield + stats
//   screen 3  closing line + back-to-tool
// Shared by the main build's `/` and `npm run build:public`. The WebGL scene (ogl + shaders) is a separate chunk
// loaded after first paint; the code is visible as soon as Web Crypto returns, never gated by an animation.
// Animations get only `code` / `generation` / `burst` counters — nothing in the visual layer reads the secret.
const PERIOD_SECONDS = 30
const SAMPLE_SECRET = 'JBSWY3DPEHPK3PXP'
// The scene module evaluates in one task and the scene starts in the next (separate tasks keep each under 50 ms).
const loadScene = () => import('../showcase/scene/homeScene.js')
  .then((mod) => new Promise((resolve) => { window.setTimeout(() => resolve(mod), 0) }))
const windowProgress = () => ((Date.now() / 1000) % PERIOD_SECONDS) / PERIOD_SECONDS

function secretError(secret, t) {
  const normalized = normalizeBase32Secret(secret)
  if (!normalized) return t('public.secretRequired')
  if (normalized.length < 8) return t('public.secretTooShort')
  try {
    decodeBase32(normalized)
    return ''
  } catch {
    return t('public.secretInvalid')
  }
}

function useActiveSection(rootRef) {
  const [active, setActive] = useState(1)
  useEffect(() => {
    const sections = [...rootRef.current.querySelectorAll('[data-section]')]
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setActive(Number(entry.target.dataset.section))
      })
    }, { rootMargin: '-45% 0px -45% 0px' })
    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [rootRef])
  return active
}

// vaultHref: where the 私有保险库 entry points go (top bar + closing line). The main build links to /vault; the
// standalone public build passes VITE_VAULT_URL or nothing, and without a target both entry points are hidden.
export default function PublicTotp({ vaultHref = '/vault' }) {
  const { t } = useLocale()
  const { push } = useToast()
  const reduced = usePrefersReducedMotion()
  const secretId = useId()
  const helperId = useId()
  const errorId = useId()
  const inputRef = useRef(null)
  const tRef = useRef(t)
  tRef.current = t
  const [secret, setSecret] = useState('')
  const [activeSecret, setActiveSecret] = useState('')
  const [algorithm, setAlgorithm] = useState('SHA1')
  const [digits, setDigits] = useState(6)
  const [code, setCode] = useState('')
  const [generation, setGeneration] = useState(0)
  const [regen, setRegen] = useState(0)
  const [burst, setBurst] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sceneFailed, setSceneFailed] = useState(false)
  const [sceneReady, setSceneReady] = useState(false)
  const staticScene = reduced || sceneFailed
  const pageRef = useRef(null)
  const canvasRef = useRef(null)
  const sceneRef = useRef(null)
  const anchors = useRef([])
  const section = useActiveSection(pageRef)
  useRevealOnScroll(pageRef)

  const remaining = secondsRemaining(now, PERIOD_SECONDS)
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS)

  useEffect(() => {
    if (!activeSecret) return undefined
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 250)
    const onVisible = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [activeSecret])

  useEffect(() => {
    if (!activeSecret) return undefined
    let current = true
    setGenerating(true)
    generateTotp({ secret: activeSecret, time: Date.now(), period: PERIOD_SECONDS, digits, algorithm })
      .then((nextCode) => {
        if (!current) return
        setCode(nextCode)
        setGeneration((value) => value + 1)
      })
      .catch(() => { if (current) setError(tRef.current('public.generateFailed')) })
      .finally(() => { if (current) setGenerating(false) })
    return () => { current = false }
    // `counter` changes once per TOTP window and `regen` on 重新生成; `now` itself never retriggers HMAC.
  }, [activeSecret, algorithm, counter, digits, regen])

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  useEffect(() => { setCopied(false) }, [code])

  // WebGL scene: loaded on demand after first paint; one context on the page's only canvas.
  const getAnchors = useCallback(() => anchors.current.filter(Boolean), [])
  useEffect(() => {
    if (staticScene) return undefined
    let disposed = false
    let instance = null
    loadScene()
      .then(({ createScene }) => {
        if (disposed || !canvasRef.current) return
        instance = createScene(canvasRef.current, {
          getAnchors,
          onFail: () => setSceneFailed(true),
          onReady: () => setSceneReady(true),
        })
        if (instance) sceneRef.current = instance
        else setSceneFailed(true)
      })
      .catch(() => { if (!disposed) setSceneFailed(true) })
    return () => {
      disposed = true
      instance?.dispose()
      sceneRef.current = null
    }
  }, [staticScene, getAnchors])
  useEffect(() => {
    if (generation) sceneRef.current?.newCode()
  }, [generation])

  const activate = (value) => {
    const nextError = secretError(value, t)
    setError(nextError)
    if (nextError) {
      inputRef.current?.focus()
      return
    }
    const normalized = normalizeBase32Secret(value)
    setSecret(normalized)
    setNow(Date.now())
    if (normalized === activeSecret) setRegen((current) => current + 1)
    else {
      setCode('')
      setActiveSecret(normalized)
    }
  }

  const submit = (event) => {
    event.preventDefault()
    activate(secret)
  }

  const updateSecret = (event) => {
    setSecret(event.target.value)
    setActiveSecret('')
    setCode('')
    setBurst((current) => current + 1) // visual churn only — the value never reaches the animation
    if (error) setError('')
  }

  const clear = () => {
    setSecret('')
    setActiveSecret('')
    setCode('')
    setError('')
    setVisible(false)
    inputRef.current?.focus()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      push(t('public.copied'))
    } catch {
      push(t('public.copyFailed'), 'error')
    }
  }

  const changeAlgorithm = (event) => { setAlgorithm(event.target.value); setCode('') }
  const changeDigits = (event) => { setDigits(Number(event.target.value)); setCode('') }
  const anchorRef = (i) => (node) => { anchors.current[i] = node }
  const figure = homeFigure
  const digitsLabel = t('show.digitsUnit').replace('{digits}', String(digits))

  return (
    <div className={`sc sc-home${staticScene ? ' is-static' : ''}`} ref={pageRef}>
      <HudBackdrop poster={staticScene} />
      {!staticScene && <canvas className={`sc-gl${sceneReady ? ' is-ready' : ''}`} ref={canvasRef} aria-hidden="true" />}
      <HudFrame left={`[ 0${section} / 03 ]`} right="WEB CRYPTO · LOCAL ONLY" />

      <a href="#public-main" className="skip-link">{t('common.skip')}</a>
      <ShowcaseTop brandLabel={t('public.homeLabel')}>
        <HudClock />
        {vaultHref && (
          <a className="sc-top-link" href={vaultHref}>
            <LockKeyhole size={16} aria-hidden="true" />
            <span>{t('nav.vault')}</span>
          </a>
        )}
        <button type="button" className="sc-icon-btn" onClick={() => setSettingsOpen(true)} aria-label={t('nav.settings')}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </ShowcaseTop>

      <main id="public-main" tabIndex="-1">
        <section className="sc-sec sc-hero" data-section="1" aria-labelledby="public-hero-title">
          <div className="sc-frame sc-hero-grid">
            <div className="sc-copy">
              <span className="sc-tag sc-mono">[ 001 ] {t('show.heroTag')}</span>
              <h1 id="public-hero-title">{t('show.heroTitleA')}<br />{t('show.heroTitleB')}</h1>
              <p className="sc-sub">{t('show.heroSub')}</p>

              <div className="sc-panel">
                <span className="sc-bracket sc-bracket-tl" aria-hidden="true" />
                <span className="sc-bracket sc-bracket-br" aria-hidden="true" />
                <div className="sc-panel-head sc-mono" aria-hidden="true">
                  <span>CHANNEL · LOCAL</span>
                  <span className={code ? 'is-locked' : ''}>{code ? 'LOCKED' : 'STANDBY'}</span>
                </div>
                <div className="sc-readout">
                  <CountdownRing active={Boolean(activeSecret)} reduced={reduced} remaining={remaining} getProgress={windowProgress} />
                  <div className="sc-code-block">
                    <span className="sc-label">{code ? t('public.currentCode') : t('show.waiting')}</span>
                    <div className="sc-code">
                      {code && <span key={generation} className="sc-lockon" aria-hidden="true"><i /><i /><i /><i /></span>}
                      <Decoder code={code} length={digits} generation={generation} burst={burst} reduced={reduced} />
                    </div>
                    <div className="sc-code-meta">
                      <span>{activeSecret ? t('public.refreshIn').replace('{seconds}', String(remaining)) : t('show.period')}</span>
                      <button
                        type="button"
                        className="sc-copybtn"
                        onClick={copy}
                        disabled={!code}
                        data-state={copied ? 'copied' : 'idle'}
                        aria-label={t('public.copyCode')}
                        title={t('public.copyCode')}
                      >
                        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                        <span aria-hidden="true">{copied ? t('common.copied') : t('common.copy')}</span>
                      </button>
                    </div>
                  </div>
                </div>
                {/* The code as text: the decode cells above are decorative (aria-hidden). This live region is what
                    screen readers announce and what the copy button copies — exactly the digits, nothing else. */}
                <p className="sr-only" aria-live="polite" aria-busy={generating}>
                  {code && <>{t('public.currentCode')} <span className="public-code-value">{code}</span></>}
                </p>

                <form className="sc-form" onSubmit={submit} noValidate>
                  <label className="sc-field-label" htmlFor={secretId}>{t('public.secretLabel')}</label>
                  <div className="sc-input-row">
                    <div className="sc-input-wrap">
                      <input
                        ref={inputRef}
                        id={secretId}
                        className="sc-input sc-mono"
                        type={visible ? 'text' : 'password'}
                        value={secret}
                        onChange={updateSecret}
                        onBlur={() => { if (secret) setError(secretError(secret, t)) }}
                        autoCapitalize="characters"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                        placeholder={t('public.secretPlaceholder')}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? errorId : helperId}
                      />
                      <button type="button" className="sc-eye" onClick={() => setVisible((current) => !current)} aria-label={visible ? t('public.hideSecret') : t('public.showSecret')}>
                        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                      </button>
                    </div>
                    <button type="submit" className="sc-btn"><KeyRound size={17} aria-hidden="true" />{t('show.generate')}</button>
                  </div>
                  <div className="sc-form-foot">
                    {error
                      ? <p id={errorId} className="sc-error" role="alert">{error}</p>
                      : <p id={helperId} className="sc-help">{t('show.secretHelper')}</p>}
                    <span className="sc-links">
                      <button type="button" onClick={() => activate(SAMPLE_SECRET)}>{t('show.trySample')}</button>
                      {(secret || code) && <button type="button" onClick={clear}>{t('public.clear')}</button>}
                    </span>
                  </div>
                  <details className="sc-compat">
                    <summary>
                      <span>{t('public.compatibility')}</span>
                      <span className="sc-compat-now sc-mono">{algorithm} · {digitsLabel}</span>
                    </summary>
                    <div className="sc-compat-grid">
                      <label className="sc-compat-field">
                        <span>{t('public.algorithm')}</span>
                        <select className="sc-select" value={algorithm} onChange={changeAlgorithm}>
                          <option>SHA1</option><option>SHA256</option><option>SHA512</option>
                        </select>
                      </label>
                      <label className="sc-compat-field">
                        <span>{t('public.digits')}</span>
                        <select className="sc-select" value={digits} onChange={changeDigits}>
                          <option value="6">6</option><option value="7">7</option><option value="8">8</option>
                        </select>
                      </label>
                    </div>
                    <p className="sc-compat-note">{t('public.periodNote')}</p>
                  </details>
                </form>
              </div>
            </div>

            <div className="sc-anchor sc-anchor-hero" ref={anchorRef(0)} data-rx="0.08" data-ry="-0.5">
              {staticScene && <ShieldPoster tilt={-14} />}
              <span className="sc-callout sc-callout-a sc-mono" aria-hidden="true"><i />HMAC-{algorithm}</span>
              <span className="sc-callout sc-callout-b sc-mono" aria-hidden="true"><i />T = 30 s</span>
              <span className="sc-callout sc-callout-c sc-mono" aria-hidden="true"><i />NO UPLOAD</span>
            </div>
          </div>
        </section>

        <section className="sc-sec sc-s2" data-section="2" aria-labelledby="public-s2-title">
          <div className="sc-frame sc-s2-grid">
            {/* data-oy / data-scale keep the hologram's tip behind the figure's base at every width; data-hold-narrow keeps
                it parked there while the copy below is read on single-column layouts (homeScene.js). */}
            <div className="sc-stage" ref={anchorRef(1)} data-rx="0.04" data-ry="3.6" data-scale="1.16" data-oy="0.17" data-holo="1" data-spin="0.35" data-hold-narrow="0.55" aria-hidden="true">
              {staticScene && <div className="sc-holo-poster"><ShieldPoster /></div>}
              <div className="sc-halo" />
              <div className="sc-pool" />
              {figure && (
                <>
                  <img className="sc-fig-reflect" src={figure.src} alt="" width={figure.width} height={figure.height} style={{ '--fig-ratio': `${figure.width} / ${figure.height}` }} loading="lazy" decoding="async" />
                  <img className="sc-fig" src={figure.src} alt="" width={figure.width} height={figure.height} style={{ '--fig-ratio': `${figure.width} / ${figure.height}` }} loading="lazy" decoding="async" />
                </>
              )}
            </div>
            <div className="sc-s2-copy">
              <span className="sc-tag sc-mono" data-reveal>[ 002 ] {t('show.s2Tag')}</span>
              <h2 id="public-s2-title" data-reveal style={{ '--delay': '60ms' }}>{t('show.s2Title')}</h2>
              <p className="sc-section-sub" data-reveal style={{ '--delay': '100ms' }}>{t('show.s2Sub')}</p>
              <dl className="sc-stats" data-reveal style={{ '--delay': '160ms' }}>
                <div><dt className="sc-mono">0</dt><dd>{t('show.statUploads')}</dd></div>
                <div><dt className="sc-mono">30s</dt><dd>{t('show.statRefresh')}</dd></div>
                <div><dt className="sc-mono">{t('show.statDigitsValue').replace('{digits}', String(digits))}</dt><dd>{t('show.statDigits')}</dd></div>
              </dl>
            </div>
          </div>
        </section>

        <section className="sc-sec sc-s3" data-section="3" aria-labelledby="public-s3-title">
          <div className="sc-frame sc-s3-inner">
            <div className="sc-anchor sc-anchor-s3" ref={anchorRef(2)} data-rx="0.14" data-ry="6.28">
              {staticScene && <ShieldPoster />}
            </div>
            <span className="sc-tag sc-mono" data-reveal>[ 003 ] {t('show.s3Tag')}</span>
            <h2 id="public-s3-title" data-reveal style={{ '--delay': '60ms' }}>{t('show.s3Title')}</h2>
            <p className="sc-section-sub" data-reveal style={{ '--delay': '120ms' }}>{t('show.s3Sub')}</p>
            <div className="sc-s3-actions" data-reveal style={{ '--delay': '180ms' }}>
              <button type="button" className="sc-btn sc-btn-ghost" onClick={() => backToField(inputRef.current)}>
                <ArrowUp size={17} aria-hidden="true" />{t('show.backToTool')}
              </button>
              {vaultHref && <p className="sc-vault-line">{t('show.vaultLine')} <a href={vaultHref}>{t('public.openVault')}</a></p>}
            </div>
          </div>
        </section>
      </main>
      <ShowcaseFooter />
      <PreferencesDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} description={t('settings.descriptionPublic')} />
    </div>
  )
}
