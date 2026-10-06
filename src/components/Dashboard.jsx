import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, Bot, KeyRound, LockKeyhole, Menu, Settings, ShieldCheck, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import EntriesView from './EntriesView.jsx'
import CallersView from './CallersView.jsx'
import AuditView from './AuditView.jsx'
import SettingsDialog from './SettingsDialog.jsx'
import AccessSwitcher from './AccessSwitcher.jsx'
import { get, post } from '../lib/api.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'
import { useToast } from './ui/Toast.jsx'
import { enter, exit } from '../lib/motion.js'
import '../styles/vault-motion.css'
import '../styles/vault-hud.css'

const validViews = new Set(['entries', 'callers', 'audit'])
const focusable = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
// Page transition between the three views: the new view fades in and rises 8 px over 0.45 s on the baseline curve.
// No exit animation, so the next view is never held back by the old one (干活层「动而不挡事」).
const viewEnter = { opacity: 0, y: 8 }

// Active-item highlight that slides to the newly selected item (shared layout animation). One layoutId per
// navigation surface — sidebar, drawer, bottom bar — so the three never animate into each other.
function NavPill({ group, className = 'vm-nav-pill' }) {
  return <motion.span layoutId={`vm-nav-${group}`} className={className} transition={enter} aria-hidden="true" />
}

// Mobile navigation drawer: same three guarantees as Dialog — visible × button, Esc closes, focus stays inside
// while open and returns to the menu button afterwards; the page behind does not scroll.
function useDrawerFocus(open, onClose, panelRef) {
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useLayoutEffect(() => {
    if (!open) return undefined
    const returnFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const timer = window.setTimeout(() => panelRef.current?.querySelector(focusable)?.focus(), 0)
    const keydown = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); return }
      const panel = panelRef.current
      if (event.key !== 'Tab' || !panel) return
      const items = [...panel.querySelectorAll(focusable)]
      if (!items.length) return
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus() }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.clearTimeout(timer)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keydown, true)
      // Next tick: React restores focus to the still-mounted (exiting) drawer button at the end of this commit.
      window.setTimeout(() => returnFocus?.focus?.(), 0)
    }
  }, [open, panelRef])
}

function initialView() {
  const value = new URLSearchParams(window.location.search).get('view') || 'entries'
  return validViews.has(value) ? value : 'not-found'
}

export default function Dashboard() {
  const { t } = useLocale()
  const { push } = useToast()
  const [view, setView] = useState(initialView)
  const [entries, setEntries] = useState([])
  const [callers, setCallers] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const drawerRef = useRef(null)
  useDrawerFocus(mobileOpen, () => setMobileOpen(false), drawerRef)
  // The first view appears with the page; only later switches get the transition.
  const switched = useRef(false)
  useEffect(() => { switched.current = true }, [])

  const handleError = useCallback((requestError) => {
    if (requestError.status === 401) window.location.reload()
    setError(true); push(requestError.message, 'error')
  }, [push])
  const loadCore = useCallback(async () => {
    setLoading(true); setError(false)
    try {
      const [entryData, callerData] = await Promise.all([get('/api/entries'), get('/api/callers')])
      setEntries(entryData); setCallers(callerData)
    } catch (requestError) { handleError(requestError) } finally { setLoading(false) }
  }, [handleError])
  const loadAudit = useCallback(async () => {
    try { setEvents(await get('/api/audit?limit=200')) } catch (requestError) { if (requestError.status === 401) window.location.reload() }
  }, [])
  useEffect(() => { loadCore(); loadAudit() }, [loadCore, loadAudit])
  useEffect(() => {
    const pop = () => setView(initialView())
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  const navigate = (next) => {
    const url = new URL(window.location.href); url.searchParams.set('view', next)
    window.history.pushState({}, '', url); setView(next); setMobileOpen(false)
    if (next === 'audit') loadAudit()
  }
  const logout = async () => {
    try { await post('/api/auth/logout', {}); window.location.reload() } catch (requestError) { push(requestError.message, 'error') }
  }
  const nav = [
    ['entries', t('nav.entries'), KeyRound],
    ['callers', t('nav.callers'), Bot],
    ['audit', t('nav.audit'), Activity],
  ]
  return (
    // .vh: inner-page HUD scope (src/styles/vault-hud.css) — also switches on the static HUD grid behind the page
    // (body::before, CSS only, no WebGL).
    <div className="vh min-h-screen">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <header className="topbar">
        <div className="page-frame topbar-inner">
          <div className="flex min-w-0 items-center gap-3"><button type="button" className="icon-button -ml-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="打开导航" aria-expanded={mobileOpen}><Menu size={20} /></button><div className="brand-mark"><ShieldCheck size={22} /></div><div className="min-w-0"><div className="brand-title">AuthTOTP</div><div className="hidden truncate text-xs text-muted md:block">{t('brand.subtitle')}</div></div></div>
          <div className="topbar-actions"><span className="private-status"><ShieldCheck size={14} />{t('vault.ownerOnly')}</span><button type="button" className="btn-quiet hidden sm:inline-flex" onClick={logout}><LockKeyhole size={16} />{t('nav.logout')}</button><AccessSwitcher current="vault" /><button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label={t('nav.settings')}><Settings size={18} /></button></div>
        </div>
      </header>
      <AnimatePresence>{mobileOpen && <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: enter }} exit={{ opacity: 0, transition: exit }} onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false) }}><motion.aside ref={drawerRef} role="dialog" aria-modal="true" aria-label="导航" className="drawer-panel" initial={{ x: '-100%' }} animate={{ x: 0, transition: enter }} exit={{ x: '-100%', transition: exit }}><div className="mb-8 flex items-center justify-between"><strong className="text-lg text-heading">AuthTOTP</strong><button type="button" className="icon-button" onClick={() => setMobileOpen(false)} aria-label="关闭导航" title="关闭（Esc）"><X size={20} /></button></div><nav className="space-y-1">{nav.map(([id, label, Icon]) => <button key={id} type="button" className={`nav-item vm-nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}>{view === id && <NavPill group="drawer" />}<Icon size={18} /><span>{label}</span></button>)}</nav><button type="button" className="btn-quiet mt-8" onClick={logout}><LockKeyhole size={16} />{t('nav.logout')}</button></motion.aside></motion.div>}</AnimatePresence>
      <div className="vault-shell">
        <aside className="sidebar hidden lg:flex"><nav aria-label="主导航" className="flex flex-col gap-1">{nav.map(([id, label, Icon]) => <button key={id} type="button" className={`nav-item vm-nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}>{view === id && <NavPill group="side" />}<Icon size={18} /><span>{label}</span></button>)}</nav><div className="sidebar-note vf"><div className="mb-2 flex items-center gap-2 font-semibold text-heading"><ShieldCheck size={15} className="text-success" />{t('vault.boundaryTitle')}</div>{t('vault.boundaryText')}</div></aside>
        <main id="main-content" className="main-content" tabIndex="-1">
          <motion.div key={view} initial={switched.current ? viewEnter : false} animate={{ opacity: 1, y: 0, transition: enter }}>
            {view === 'entries' && <EntriesView entries={entries} callers={callers} loading={loading} error={error} onReload={loadCore} onAuditChanged={loadAudit} />}
            {view === 'callers' && <CallersView callers={callers} entries={entries} loading={loading} onReload={async () => { await loadCore(); await loadAudit() }} />}
            {view === 'audit' && <AuditView events={events} loading={loading} />}
            {view === 'not-found' && <div className="empty-state vf"><ShieldCheck size={32} /><h1>页面不存在</h1><p>这个控制台入口无效。</p><button className="btn-primary" onClick={() => navigate('entries')}>返回验证码库</button></div>}
          </motion.div>
        </main>
      </div>
      <nav className="mobile-nav lg:hidden" aria-label="移动端主导航">{nav.map(([id, label, Icon]) => <button key={id} type="button" className={`vm-tab ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}>{view === id && <NavPill group="bottom" className="vm-tab-pill" />}<Icon size={20} /><span>{label}</span></button>)}</nav>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
