import { useState } from 'react'
import { Languages, Minus, Plus } from 'lucide-react'
import Dialog from './ui/Dialog.jsx'
import { useLocale } from '../i18n/LocaleProvider.jsx'

const sizes = ['compact', 'default', 'large']

// Display preferences only (language, font size; AuthTOTP is dark-only — 视觉基线 v1.4 §14 — so there is no theme
// choice) — no vault imports and no API calls, so the standalone public build can use it. SettingsDialog wraps it and
// passes the account-security group as children.
export default function PreferencesDialog({ open, onClose, description, children }) {
  const { locale, setLocale, t } = useLocale()
  const [size, setSizeState] = useState(() => document.documentElement.dataset.fontSize || 'default')
  const setSize = (next) => {
    document.documentElement.dataset.fontSize = next
    setSizeState(next)
    try { localStorage.setItem('fontSize', next) } catch { /* ignore */ }
  }
  const index = sizes.indexOf(size)
  return <Dialog open={open} onClose={onClose} title={t('nav.settings')} description={description}><div className="space-y-5"><fieldset><legend className="mb-2 text-sm font-semibold text-heading">语言</legend><div className="grid grid-cols-2 gap-3"><button type="button" className={`setting-choice ${locale === 'zh' ? 'active' : ''}`} onClick={() => setLocale('zh')} aria-pressed={locale === 'zh'}><Languages size={19} />中文</button><button type="button" className={`setting-choice ${locale === 'en' ? 'active' : ''}`} onClick={() => setLocale('en')} aria-pressed={locale === 'en'}><Languages size={19} />English</button></div></fieldset><fieldset><legend className="mb-2 text-sm font-semibold text-heading">界面字号</legend><div className="flex items-center justify-between rounded-full border border-border bg-tint p-1"><button type="button" className="icon-button" onClick={() => setSize(sizes[Math.max(0, index - 1)])} disabled={index <= 0} aria-label="缩小字号"><Minus size={18} /></button><span className="text-sm font-semibold text-heading">{size === 'compact' ? '紧凑' : size === 'large' ? '大号' : '标准'}</span><button type="button" className="icon-button" onClick={() => setSize(sizes[Math.min(sizes.length - 1, index + 1)])} disabled={index >= sizes.length - 1} aria-label="放大字号"><Plus size={18} /></button></div></fieldset>{children}</div><button type="button" className="btn-primary mt-6 w-full" onClick={onClose}>完成</button></Dialog>
}
