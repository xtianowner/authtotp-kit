// Maps /api/auth/* error codes to localized, actionable messages.
// Codes come from the backend contract ({"detail": "<CODE>"}); unknown codes fall back to the raw message.

function formatWait(seconds, locale) {
  const tag = locale === 'zh' ? 'zh-CN' : 'en-US'
  const unit = seconds >= 60 ? 'minute' : 'second'
  const value = seconds >= 60 ? Math.ceil(seconds / 60) : Math.max(1, Math.ceil(seconds))
  return new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay: 'long' }).format(value)
}

// 422 validation errors carry only field paths/types (see api.js); map them to a fixed message.
function validationKey(fields = []) {
  const field = (name) => fields.find((item) => item.loc.at(-1) === name)
  if (field('new_password')) return 'auth.error.NEW_PASSWORD_LENGTH'
  const password = field('password') || field('current_password')
  if (password) return password.type === 'string_too_short' && password.min === 1 ? 'auth.error.PASSWORD_REQUIRED' : 'auth.error.PASSWORD_LENGTH'
  return 'auth.error.VALIDATION_ERROR'
}

export function authErrorMessage(t, locale, error, { recoveryMode = false } = {}) {
  const code = error?.code
  if (code === 'VALIDATION_ERROR') return t(validationKey(error.fields))
  if (code === 'LOGIN_LOCKED') {
    if (!error.retryAfter) return t('auth.error.LOGIN_LOCKED_SOON')
    return t('auth.error.LOGIN_LOCKED').replace('{wait}', formatWait(error.retryAfter, locale))
  }
  if (code === 'RATE_LIMITED' && error.retryAfter) return t('auth.error.RATE_LIMITED_WAIT').replace('{wait}', formatWait(error.retryAfter, locale))
  if (code === 'INVALID_TOTP_CODE' && recoveryMode) return t('auth.error.INVALID_RECOVERY_CODE')
  const key = `auth.error.${code}`
  const text = t(key)
  return text === key ? (error?.message || t('common.error')) : text
}

// Recovery codes are 8 characters shown as XXXX-XXXX; the backend ignores case and dashes.
export function formatRecoveryInput(value) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact
}

export const isTotpCode = (value) => /^\d{6}$/.test(value)
export const isRecoveryCode = (value) => /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(value)
