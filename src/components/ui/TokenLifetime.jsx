import { useEffect, useId, useState } from 'react'
import { get } from '../../lib/api.js'
import { useLocale } from '../../i18n/LocaleProvider.jsx'

// Caller-token lifetime picker, shared by 「新增令牌」 (entry card) and 「创建调用方」 (callers page).
// Values are hours sent as `expires_in_hours` to POST /api/callers: 0 = never expires.
export const TOKEN_LIFETIMES = [24, 168, 720, 2160, 0]
const FALLBACK_HOURS = 720

// Default choice from the server's caller_token_default_hours: 0 → never, an offered value → that value,
// anything else (or no answer) → 30 days.
export function defaultLifetime(serverHours) {
  if (serverHours === 0) return 0
  return TOKEN_LIFETIMES.includes(serverHours) ? serverHours : FALLBACK_HOURS
}

// One GET /api/meta per page load; a failed request is forgotten so the next dialog mount asks again.
let metaRequest = null
function loadDefaultHours() {
  if (!metaRequest) {
    metaRequest = get('/api/meta')
      .then((data) => (Number.isInteger(data?.caller_token_default_hours) ? data.caller_token_default_hours : null))
      .catch(() => { metaRequest = null; return null })
  }
  return metaRequest
}

// The lifetime to preselect; `ready` turns true once the server answered (or failed → 30 days).
export function useDefaultLifetime() {
  const [state, setState] = useState({ ready: false, hours: FALLBACK_HOURS })
  useEffect(() => {
    let alive = true
    loadDefaultHours().then((hours) => { if (alive) setState({ ready: true, hours: defaultLifetime(hours) }) })
    return () => { alive = false }
  }, [])
  return state
}

export function isNeverExpiring(expiresAt) {
  return expiresAt === null || expiresAt === undefined || (typeof expiresAt === 'string' && expiresAt.trim() === '')
}

// Local date + time in the UI language (null when the value is missing or unreadable).
export function formatLocalTime(value, locale) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

// Radio pills (native radios: arrow keys move the choice, Tab enters / leaves the group as one stop).
export default function TokenLifetimeField({ value, onChange, disabled = false }) {
  const { locale, t } = useLocale()
  const name = useId()
  const hintId = useId()
  const preview = value > 0 ? formatLocalTime(Date.now() + value * 3600 * 1000, locale) : null
  return (
    <fieldset aria-describedby={hintId} disabled={disabled}>
      <legend className="mb-2 text-sm font-semibold text-heading">{t('ttl.label')}</legend>
      <div className="ttl-group">
        {TOKEN_LIFETIMES.map((hours) => (
          <label key={hours} className="ttl-pill">
            <input type="radio" className="sr-only" name={name} value={hours} checked={value === hours} onChange={() => onChange(hours)} />
            <span>{t(`ttl.option.${hours}`)}</span>
          </label>
        ))}
      </div>
      <p id={hintId} className="mt-2 text-xs leading-relaxed text-muted">
        {value === null ? t('common.loading') : value === 0 ? t('ttl.hintNever') : t('ttl.hintUntil').replace('{date}', preview || '—')}
      </p>
    </fieldset>
  )
}
