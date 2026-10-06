import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider.jsx'
import { attribution, attributionLabel } from '../brand/index.js'

// Shared chrome of the four display-layer pages (public home, vault login, /code, 404): fixed HUD background,
// HUD corner frame, top bar and the signature footer. Pure CSS (showcase.css), no WebGL — the public home adds
// its own WebGL canvas on top of this background.

/**
 * Fixed background: HUD grid, perspective floor (slow scroll), scanlines, sweep; `poster` adds the still aurora
 * band on the horizon (every page except the public home in WebGL mode, which draws it live).
 */
export function HudBackdrop({ poster = true }) {
  return (
    <>
      <div className="sc-bg" aria-hidden="true">
        <div className="sc-grid" />
        <div className="sc-floor"><div className="sc-floor-plane" /></div>
        <div className="sc-scanlines" />
        <div className="sc-sweep" />
      </div>
      {poster && <div className="sc-aurora-poster" aria-hidden="true" />}
    </>
  )
}

/** HUD corner frame with two small mono labels (decorative, aria-hidden). */
export function HudFrame({ left, right }) {
  return (
    <div className="sc-hud" aria-hidden="true">
      <span className="sc-corner sc-corner-tl" />
      <span className="sc-corner sc-corner-tr" />
      <span className="sc-corner sc-corner-bl" />
      <span className="sc-corner sc-corner-br" />
      {left && <span className="sc-hud-index sc-mono">{left}</span>}
      {right && <span className="sc-hud-mode sc-mono">{right}</span>}
    </div>
  )
}

/** Brand mark + name. href = null renders a plain label (the /code page has no navigation). */
export function ShowcaseBrand({ href = '/', label }) {
  const content = (
    <>
      <span className="sc-mark"><ShieldCheck size={18} aria-hidden="true" /></span>
      <span>AuthTOTP</span>
    </>
  )
  return href
    ? <a className="sc-brand" href={href} aria-label={label}>{content}</a>
    : <span className="sc-brand">{content}</span>
}

export function ShowcaseTop({ brandHref = '/', brandLabel, children }) {
  return (
    <header className="sc-top sc-frame">
      <ShowcaseBrand href={brandHref} label={brandLabel} />
      {children && <div className="sc-top-right">{children}</div>}
    </header>
  )
}

/** Live HUD clock; isolated so its once-a-second tick never re-renders the page. */
export function HudClock() {
  const { locale } = useLocale()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="sc-clock sc-mono" aria-hidden="true">
      <span className="sc-live" />
      {now.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })}
    </span>
  )
}

/** Signature line (炫技指导 §2.7); text and link come from the brand package config. */
export function ShowcaseFooter() {
  const { locale } = useLocale()
  if (!attribution) return null
  return (
    <footer className="sc-footer">
      <a href={attribution.href}>{attributionLabel(locale)}</a>
    </footer>
  )
}
