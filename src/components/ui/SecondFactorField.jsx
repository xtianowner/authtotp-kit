import { useEffect, useId, useImperativeHandle, useRef } from 'react'
import { KeyRound, Smartphone } from 'lucide-react'
import { useLocale } from '../../i18n/LocaleProvider.jsx'
import { formatRecoveryInput } from '../../lib/authErrors.js'

const LENGTH = 6

// Six single-digit boxes: numeric keypad, auto-advance, Backspace steps back, paste/autofill fills all boxes.
// `value` is always a contiguous digit string (0–6 chars); focus never lands past the first empty box.
export function OtpInput({ value, onChange, labelledBy, describedBy, invalid = false, disabled = false, ref }) {
  const { t } = useLocale()
  const boxes = useRef([])
  const programmatic = useRef(false)
  const focusBox = (index) => {
    const box = boxes.current[Math.max(0, Math.min(index, LENGTH - 1))]
    programmatic.current = true
    box?.focus()
    programmatic.current = false
    box?.select()
  }
  useImperativeHandle(ref, () => ({ focus: () => focusBox(Math.min(value.length, LENGTH - 1)) }), [value.length])

  const apply = (index, digits) => {
    if (!digits) return
    const next = (value.slice(0, index) + digits + value.slice(index + digits.length)).slice(0, LENGTH)
    onChange(next)
    focusBox(Math.min(index + digits.length, LENGTH - 1))
  }
  const handleKeyDown = (index, event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (/^\d$/.test(event.key)) {
      event.preventDefault()
      apply(index, event.key)
    } else if (event.key === 'Backspace') {
      event.preventDefault()
      if (value[index]) {
        onChange(value.slice(0, index) + value.slice(index + 1))
        focusBox(index)
      } else if (index > 0) {
        onChange(value.slice(0, index - 1) + value.slice(index))
        focusBox(index - 1)
      }
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault(); focusBox(index - 1)
    } else if (event.key === 'ArrowRight' && index < value.length) {
      event.preventDefault(); focusBox(index + 1)
    }
  }
  // Mobile keyboards and one-time-code autofill arrive here instead of keydown.
  const handleChange = (index, event) => {
    const raw = event.target.value.replace(/\D/g, '')
    if (raw.length >= LENGTH) return apply(0, raw.slice(0, LENGTH))
    if (raw.length === 2 && value[index]) {
      const caret = event.target.selectionStart || 1
      return apply(index, event.target.value[caret - 1]?.replace(/\D/g, '') || raw.slice(-1))
    }
    return apply(index, raw)
  }
  const handlePaste = (index, event) => {
    event.preventDefault()
    const digits = (event.clipboardData?.getData('text') || '').replace(/\D/g, '')
    if (digits.length >= LENGTH) apply(0, digits.slice(0, LENGTH))
    else apply(index, digits)
  }

  return (
    <div role="group" aria-labelledby={labelledBy} className="grid max-w-sm grid-cols-6 gap-2">
      {Array.from({ length: LENGTH }, (_, index) => (
        <input
          key={index}
          ref={(node) => { boxes.current[index] = node }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={t('auth.otpDigit').replace('{n}', String(index + 1))}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={value[index] || ''}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onChange={(event) => handleChange(index, event)}
          onPaste={(event) => handlePaste(index, event)}
          onFocus={(event) => {
            // Programmatic moves run before the parent re-renders with the new value, so skip the guard then.
            if (!programmatic.current && index > value.length) focusBox(value.length)
            else event.target.select()
          }}
          className={`field h-12 min-w-0 px-0 text-center font-mono text-xl font-semibold text-heading ${invalid ? 'border-danger' : ''}`}
        />
      ))}
    </div>
  )
}

// Second-factor entry used by the login gate and the two-step settings dialog:
// authenticator code (6 boxes) or, optionally, a one-time recovery code (XXXX-XXXX).
export default function SecondFactorField({ mode, onModeChange, code, onCodeChange, allowRecovery = true, label, invalid = false, disabled = false, fieldRef }) {
  const { t } = useLocale()
  const labelId = useId()
  const helpId = useId()
  const recoveryId = useId()
  const otpRef = useRef(null)
  const recoveryRef = useRef(null)
  const switched = useRef(false)
  useImperativeHandle(fieldRef, () => ({ focus: () => (mode === 'totp' ? otpRef.current : recoveryRef.current)?.focus() }), [mode])
  useEffect(() => {
    if (!switched.current) return
    switched.current = false
    ;(mode === 'totp' ? otpRef.current : recoveryRef.current)?.focus()
  }, [mode])
  const toggle = () => {
    switched.current = true
    onCodeChange('')
    onModeChange(mode === 'totp' ? 'recovery' : 'totp')
  }

  return (
    <div className="space-y-2">
      {mode === 'totp' ? (
        <>
          <span id={labelId} className="block text-sm font-semibold text-heading">{label || t('auth.codeLabel')}</span>
          <OtpInput ref={otpRef} value={code} onChange={onCodeChange} labelledBy={labelId} describedBy={helpId} invalid={invalid} disabled={disabled} />
          <p id={helpId} className="text-xs leading-relaxed text-muted">{t('auth.codeHelper')}</p>
        </>
      ) : (
        <>
          <label htmlFor={recoveryId} className="block text-sm font-semibold text-heading">{t('auth.recoveryLabel')}</label>
          <input
            ref={recoveryRef}
            id={recoveryId}
            className={`field max-w-sm font-mono tracking-[0.12em] ${invalid ? 'border-danger' : ''}`}
            value={code}
            onChange={(event) => onCodeChange(formatRecoveryInput(event.target.value))}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={9}
            aria-describedby={helpId}
            aria-invalid={invalid || undefined}
            disabled={disabled}
          />
          <p id={helpId} className="text-xs leading-relaxed text-muted">{t('auth.recoveryHelper')}</p>
        </>
      )}
      {allowRecovery && (
        <button type="button" className="btn-quiet -ml-2" onClick={toggle} disabled={disabled}>
          {mode === 'totp' ? <KeyRound size={16} aria-hidden="true" /> : <Smartphone size={16} aria-hidden="true" />}
          {mode === 'totp' ? t('auth.useRecovery') : t('auth.useTotp')}
        </button>
      )}
    </div>
  )
}
