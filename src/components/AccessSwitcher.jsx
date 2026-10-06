import { LockKeyhole, Smartphone } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// 公开工具 / 私有保险库 switch shared by both top bars; sits on the right, just left of the settings gear.
// Below sm the labels become sr-only, so each icon-only link keeps its accessible name.
// vaultHref defaults to the same-origin vault; the standalone public build passes its absolute VITE_VAULT_URL.
export default function AccessSwitcher({ current, vaultHref = '/vault' }) {
  const { t } = useLocale()
  const items = [['public', '/', Smartphone, t('nav.public')], ['vault', vaultHref, LockKeyhole, t('nav.vault')]]
  return (
    <nav className="access-switcher" aria-label={t('public.accessNav')}>
      {items.map(([key, href, Icon, label]) => (
        <a key={key} href={href} className={current === key ? 'active' : undefined} aria-current={current === key ? 'page' : undefined}>
          <Icon size={17} aria-hidden="true" /><span className="sr-only sm:not-sr-only">{label}</span>
        </a>
      ))}
    </nav>
  )
}
