import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Clipboard, Clock, Link2Off, RefreshCw } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider.jsx'
import { useToast } from './ui/Toast.jsx'
import { usePrefersReducedMotion } from '../showcase/motion.js'
import Decoder from '../showcase/Decoder.jsx'
import CountdownRing from '../showcase/CountdownRing.jsx'
import { HudBackdrop, HudFrame, ShowcaseTop } from '../showcase/chrome.jsx'
import '../showcase/showcase.css'

// Shared-code page for colleagues: /code#e=<entry_id>&t=<caller token>&n=<account display name>&p=<platform name>.
// p is optional: without it the page uses generic wording ("Sign-in code", "the site").
// Link parameters are read from the fragment only — browsers never send it to the server, so it stays out of
// request lines and logs — and nothing is written to localStorage / sessionStorage / cookies. The page talks to
// POST /v1/totp/{e}/code only (no /api/*), and requests a new code once per TOTP window, right after expiry.
// Display layer (dark showcase, 视觉基线 v1.4 §14), one screen, one job: the big decode-lock code with the
// glowing countdown ring, copy and refresh; no figure, no vault entry points. Invalid / revoked link → dark notice.
const PLATFORM_MAX_LENGTH = 40 // characters (code points); p is display text only
const TOKEN_PATTERN = /^[\x21-\x7E]+$/ // anything else cannot go into an Authorization header
const RATE_LIMIT_WAIT_SECONDS = 60 // the backend limit is a 60 s sliding window and sends no Retry-After

function readLink() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const entryId = (params.get('e') || '').trim()
  const token = (params.get('t') || '').trim()
  const name = (params.get('n') || '').trim()
  // URLSearchParams already percent-decodes; rendered as plain React text only.
  const platform = Array.from((params.get('p') || '').trim()).slice(0, PLATFORM_MAX_LENGTH).join('').trim()
  return { entryId, token, name, platform, valid: Boolean(entryId && token && TOKEN_PATTERN.test(token)) }
}

function useCallerCode(link) {
  const [code, setCode] = useState(null) // { value, deadline, period, soon }
  const [problem, setProblem] = useState(link.valid ? null : { kind: 'invalid' })
  const [loading, setLoading] = useState(false)
  // true once the server issued a code for this link: only then may the link's n / p be shown (see CodePage).
  const [verified, setVerified] = useState(false)
  const [now, setNow] = useState(Date.now())
  const timer = useRef(0)
  const generation = useRef(0)
  const retriedRateLimit = useRef(false)

  const load = useCallback(async () => {
    const run = generation.current
    window.clearTimeout(timer.current)
    setLoading(true)
    let response
    try {
      response = await fetch(`/v1/totp/${encodeURIComponent(link.entryId)}/code`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${link.token}` },
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch {
      if (run === generation.current) { setLoading(false); setProblem({ kind: 'network' }) }
      return
    }
    const data = await response.json().catch(() => null)
    if (run !== generation.current) return
    setLoading(false)
    setNow(Date.now())
    if (response.ok && typeof data?.code === 'string') {
      retriedRateLimit.current = false
      // remaining_seconds is relative to the server clock, so the deadline does not depend on browser clock skew.
      const deadline = Date.now() + data.remaining_seconds * 1000
      const period = Math.round((new Date(data.valid_until) - new Date(data.valid_from)) / 1000) || 30
      setCode({ value: data.code, deadline, period, soon: Boolean(data.refresh_recommended) })
      setProblem(null)
      setVerified(true)
      timer.current = window.setTimeout(load, deadline - Date.now() + 300)
      return
    }
    if (response.status === 429) {
      const header = Number.parseInt(response.headers.get('Retry-After') || '', 10)
      const wait = Number.isFinite(header) && header > 0 ? header : RATE_LIMIT_WAIT_SECONDS
      if (retriedRateLimit.current) { setProblem({ kind: 'rate' }); return }
      retriedRateLimit.current = true // one automatic retry per rate-limit episode
      setProblem({ kind: 'rate', retryAt: Date.now() + wait * 1000 })
      timer.current = window.setTimeout(load, wait * 1000)
      return
    }
    const invalid = [401, 403, 404, 409].includes(response.status)
    if (invalid) { setCode(null); setVerified(false) }
    setProblem({ kind: invalid ? 'invalid' : 'unavailable' })
  }, [link.entryId, link.token])

  useEffect(() => {
    generation.current += 1
    retriedRateLimit.current = false
    setCode(null)
    setVerified(false)
    setProblem(link.valid ? null : { kind: 'invalid' })
    if (link.valid) load()
    return () => { generation.current += 1; window.clearTimeout(timer.current) }
  }, [link.valid, load])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(tick)
  }, [])

  const live = code && code.deadline > now ? code : null
  const remaining = live ? Math.max(0, Math.ceil((live.deadline - now) / 1000)) : 0
  const retryIn = problem?.retryAt ? Math.max(0, Math.ceil((problem.retryAt - now) / 1000)) : 0
  const refresh = () => { if (!loading) { retriedRateLimit.current = false; load() } }
  return { code: live, remaining, problem, retryIn, loading, refresh, verified }
}

export default function CodePage() {
  const { t } = useLocale()
  const { push } = useToast()
  const reduced = usePrefersReducedMotion()
  const [link, setLink] = useState(readLink)
  const [copied, setCopied] = useState(false)
  const { code, remaining, problem, retryIn, loading, refresh, verified } = useCallerCode(link)
  const codeRef = useRef(code)
  codeRef.current = code

  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
  useEffect(() => { document.title = t('code.docTitle') }, [t])
  // A new link pasted into the same tab only changes the fragment.
  useEffect(() => {
    const onHash = () => setLink(readLink())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const invalid = problem?.kind === 'invalid'
  // n / p are attacker-controllable URL text. Render them only after the server issued a code for this link;
  // invalid, failed or not-yet-fetched links get fixed wording, so a crafted link cannot put arbitrary text
  // (e.g. phishing instructions) on this domain.
  const trusted = verified && !invalid
  const name = trusted ? link.name : ''
  const platform = trusted ? link.platform : ''
  // Replacer function, not a string: a $-pattern in the link's p must not be interpreted by replaceAll.
  const platformName = platform || t('code.platformFallback')
  const fill = (text) => text.replaceAll('{platform}', () => platformName)
  const title = platform ? fill(t('code.title')) : t('code.titleGeneric')
  const digits = code?.value.length || 6
  // Countdown dial: elapsed fraction of the current window, from the server-relative deadline (display only).
  const progress = useCallback(() => {
    const live = codeRef.current
    return live ? 1 - Math.max(0, live.deadline - Date.now()) / (live.period * 1000) : 0
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.value)
      setCopied(true)
      push(t('code.copiedToast'))
    } catch {
      push(t('code.copyFailed'), 'error')
    }
  }
  const problemText = problem && {
    invalid: t('code.errorInvalid'),
    rate: t('code.errorRate'),
    network: t('code.errorNetwork'),
    unavailable: t('code.errorUnavailable'),
  }[problem.kind]
  const retryLine = problem?.retryAt && retryIn > 0 && <span className="block text-muted">{t('code.retryIn').replace('{seconds}', String(retryIn))}</span>

  return (
    <div className="sc sc-code-page">
      <HudBackdrop />
      <HudFrame left="[ CODE ]" right="CALLER LINK · NO STORAGE" />
      <ShowcaseTop brandHref={null} />
      <main className="sc-frame sc-code-main">
        <section className="sc-panel sc-code-panel" aria-labelledby="code-page-title">
          <span className="sc-bracket sc-bracket-tl" aria-hidden="true" />
          <span className="sc-bracket sc-bracket-br" aria-hidden="true" />
          <div className="sc-panel-head sc-mono" aria-hidden="true">
            <span>CALLER · {platform ? platform.toUpperCase() : 'LINK'}</span>
            <span className={code ? 'is-locked' : ''}>{invalid ? 'LINK INVALID' : code ? 'LIVE' : 'SYNC'}</span>
          </div>
          <div className="sc-code-title">
            {name && <p>{title}</p>}
            <h1 id="code-page-title">{name || title}</h1>
          </div>

          {invalid ? (
            <div className="sc-invalid">
              <span className="sc-invalid-icon"><Link2Off size={30} aria-hidden="true" /></span>
              <h2>{t('show.invalidTitle')}</h2>
              <p role="alert">{problemText}</p>
            </div>
          ) : (
            <>
              <div className="sc-readout" aria-busy={loading}>
                <CountdownRing active={Boolean(code)} reduced={reduced} remaining={remaining} getProgress={progress} />
                <div className="sc-code-block">
                  {code || !problem ? (
                    <>
                      <span className="sc-label">{code ? t('public.currentCode') : t('code.fetching')}</span>
                      <div className="sc-code">
                        {code && <span key={code.deadline} className="sc-lockon" aria-hidden="true"><i /><i /><i /><i /></span>}
                        <Decoder code={code?.value || ''} length={digits} generation={code?.deadline || 0} reduced={reduced} />
                      </div>
                      <div className="sc-code-meta"><span>{code ? t('code.refreshIn').replace('{seconds}', String(remaining)) : ' '}</span></div>
                    </>
                  ) : (
                    <div className="sc-code-status" role="alert">
                      <AlertCircle size={20} className="text-danger" aria-hidden="true" />
                      <span>{problemText}{retryLine}</span>
                    </div>
                  )}
                </div>
              </div>
              {/* The code as text (the decode cells are decorative): announced by screen readers, read by tests. */}
              <p className="sr-only" aria-live="polite" data-testid="caller-code">{code?.value || ''}</p>
              <div role="status" aria-live="polite" className="sc-code-notes">
                {code && code.soon && <p><Clock size={16} className="text-warning" aria-hidden="true" />{t('code.expiringSoon')}</p>}
                {code && problem && <p className="text-text"><AlertCircle size={16} className="text-danger" aria-hidden="true" /><span>{problemText}{retryLine}</span></p>}
              </div>
              <div className="sc-code-actions">
                <button type="button" className="sc-btn" onClick={copy} disabled={!code}>{copied ? <Check size={17} aria-hidden="true" /> : <Clipboard size={17} aria-hidden="true" />}{copied ? t('code.copied') : t('code.copy')}</button>
                <button type="button" className="sc-btn sc-btn-ghost" onClick={refresh} disabled={loading}><RefreshCw size={17} className={loading ? 'animate-spin' : undefined} aria-hidden="true" />{t('code.refresh')}</button>
              </div>
              <div className="sc-howto">
                <h2>{t('code.howTitle')}</h2>
                <ol>
                  <li>{fill(t('code.how1')).replace('{digits}', String(digits))}</li>
                  <li>{t('code.how2').replace('{seconds}', String(code?.period || 30))}</li>
                  <li>{t('code.how3')}</li>
                </ol>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
