import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import PreferencesDialog from './PreferencesDialog.jsx'
import TwoFactorDialog from './TwoFactorDialog.jsx'
import PasswordDialog from './PasswordDialog.jsx'
import { get } from '../lib/api.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// Vault settings = the display preferences (PreferencesDialog) plus the account-security group.
// security=false: display preferences only — no account-security group and no vault API calls.
export default function SettingsDialog({ open, onClose, security = true }) {
  const { t } = useLocale()
  const [twoFactor, setTwoFactor] = useState({ loading: true, enrolled: null })
  const [twoFactorOpen, setTwoFactorOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  useEffect(() => {
    if (!open || !security) return undefined
    let cancelled = false
    setTwoFactor((current) => ({ ...current, loading: true }))
    get('/api/auth/status')
      .then((data) => { if (!cancelled) setTwoFactor({ loading: false, enrolled: Boolean(data.totp_enrolled) }) })
      .catch(() => { if (!cancelled) setTwoFactor({ loading: false, enrolled: null }) })
    return () => { cancelled = true }
  }, [open, security])
  const openTwoFactor = () => { onClose(); setTwoFactorOpen(true) }
  const openPassword = () => { onClose(); setPasswordOpen(true) }
  const statusLabel = twoFactor.loading ? t('common.loading') : twoFactor.enrolled === null ? t('twofa.statusUnknown') : twoFactor.enrolled ? t('twofa.statusOn') : t('twofa.statusOff')
  return <><PreferencesDialog open={open} onClose={onClose} description={t(security ? 'settings.description' : 'settings.descriptionPublic')}>{security && <section aria-labelledby="settings-security-heading" className="border-t border-border pt-5"><h3 id="settings-security-heading" className="mb-2 text-sm font-medium text-heading">{t('settings.security')}</h3><div className="space-y-3"><div className="flex flex-col gap-3 rounded-card border border-border bg-tint p-3 sm:flex-row sm:items-center"><div className="flex min-w-0 flex-1 items-start gap-3">{twoFactor.enrolled ? <ShieldCheck size={19} className="mt-0.5 shrink-0 text-success" aria-hidden="true" /> : <ShieldOff size={19} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />}<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-heading">{t('twofa.title')}</span><span className={`status-dot ${twoFactor.enrolled ? 'status-active' : 'status-disabled'}`}>{statusLabel}</span></div><p className="mt-1 text-xs leading-relaxed text-muted">{t('twofa.settingsHint')}</p></div></div><button type="button" className="btn-secondary shrink-0" onClick={openTwoFactor} aria-label={t('twofa.manage')}><ShieldCheck size={16} aria-hidden="true" />{t('twofa.manageShort')}</button></div><div className="flex flex-col gap-3 rounded-card border border-border bg-tint p-3 sm:flex-row sm:items-center"><div className="flex min-w-0 flex-1 items-start gap-3"><KeyRound size={19} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" /><div className="min-w-0"><span className="text-sm font-semibold text-heading">{t('password.settingsTitle')}</span><p className="mt-1 text-xs leading-relaxed text-muted">{t('password.settingsHint')}</p></div></div><button type="button" className="btn-secondary shrink-0" onClick={openPassword} aria-label={t('password.title')}><KeyRound size={16} aria-hidden="true" />{t('password.changeShort')}</button></div></div></section>}</PreferencesDialog>{security && <><TwoFactorDialog open={twoFactorOpen} onClose={() => setTwoFactorOpen(false)} onStatusChange={(data) => setTwoFactor({ loading: false, enrolled: Boolean(data.totp_enrolled) })} /><PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} /></>}</>
}
