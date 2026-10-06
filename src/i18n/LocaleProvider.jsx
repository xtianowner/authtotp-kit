import { createContext, useContext, useMemo, useState, useCallback } from 'react'
import { messages } from './messages.js'

const LocaleContext = createContext(null)

export function LocaleProvider({ children, defaultLocale = 'zh' }) {
  const [locale, setLocale] = useState(() => {
    try {
      return localStorage.getItem('locale') || defaultLocale
    } catch {
      return defaultLocale
    }
  })
  const setLocalePersisted = useCallback((next) => {
    setLocale(next)
    try { localStorage.setItem('locale', next) } catch { /* ignore */ }
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  }, [])
  const toggle = useCallback(() => setLocalePersisted(locale === 'zh' ? 'en' : 'zh'), [locale, setLocalePersisted])
  const t = useCallback((key) => messages[locale]?.[key] ?? key, [locale])
  const value = useMemo(() => ({ locale, setLocale: setLocalePersisted, toggle, t }), [locale, setLocalePersisted, toggle, t])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider')
  return ctx
}
