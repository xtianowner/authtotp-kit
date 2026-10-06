import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { EASE, enter, exit } from '../lib/motion.js'
import { AlertCircle, Ban, Check, Clipboard, Clock, Copy, Eye, EyeOff, FileImage, KeyRound, Loader2, Pencil, Plus, Power, RefreshCw, Search, ShieldAlert, ShieldCheck, Trash2, Upload, Users } from 'lucide-react'
import Dialog from './ui/Dialog.jsx'
import AddTokenDialog from './AddTokenDialog.jsx'
import { TokenDialog } from './CallersView.jsx'
import DecodeNumber from './ui/DecodeNumber.jsx'
import FlipCode from './ui/FlipCode.jsx'
import { CopyLock, useCopyFeedback } from './ui/copyFeedback.jsx'
import { usePrefersReducedMotion } from '../showcase/motion.js'
import { useRollingCode } from '../lib/useRollingCode.js'
import CloseConfirm, { useBeforeUnloadWhile } from './ui/CloseConfirm.jsx'
import { useToast } from './ui/Toast.jsx'
import { decodeQrFile } from '../lib/qr.js'
import { patch, post, remove } from '../lib/api.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

const purposes = [['automation', '自动化'], ['personal', '个人'], ['finance', '财务'], ['admin', '管理员'], ['other', '其他']]

// Card entrance (首次出现): each card starts 40 ms after the previous one, capped so the whole batch finishes
// within 0.6 s (0.2 s last start + 0.4 s run) on the baseline curve. Later additions enter without a delay.
const STAGGER = 0.04
const STAGGER_CAP = 0.2
const CARD_DUR = 0.4
const cardEnter = (delay) => ({ duration: CARD_DUR, ease: EASE, delay })

function normalizeSeed(value) {
  return String(value || '').replace(/\s+/g, '').replace(/=+$/g, '').toUpperCase()
}

function seedFromUri(uri) {
  try { return normalizeSeed(new URL(uri).searchParams.get('secret')) }
  catch { return '' }
}

// 验证码库条目卡 = 单卡 demo D「卡面 2 · 渐变细描边」（src/lab/vault-cards/d/Face.jsx，复制而来，不 import src/lab）。
// 层级：头部（首字母、名称、账号、状态）→ 验证码区（主角：展示 ① 精修翻牌 + 彗星环读条）→ 底部一行小字
// （用途 · 规格 · 调用方 · 截断的条目 ID + 复制图标）→ 低频操作（编辑、停用 / 启用；右侧：可用时「新增令牌」，停用后永久删除）。编辑不放头部：
// 1440 宽三列时卡宽约 325px，头部再加一个按钮会把标题挤到很窄。
// 材质与布局：src/styles/vault-hud.css（.vf / .vf-entry）；悬停绕边光与翻牌：src/styles/vault-motion.css。
// 查看后到期自动换码（src/lib/useRollingCode.js）；「隐藏」随时手动收起。复制 = 角标锁定 + 「已复制」1.5 秒 + toast。
function EntryCard({ entry, onChanged, onEdit, onAddToken, onAuditChanged }) {
  const { t } = useLocale()
  const { push } = useToast()
  const titleId = useId()
  const reduced = usePrefersReducedMotion()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const active = entry.status === 'active'
  const onError = useCallback((error) => push(error.message, 'error'), [push])
  const { live, loading, reveal, hide } = useRollingCode(entry.id, { onRevealed: onAuditChanged, onError })
  // Disabling the entry (here or after a reload) closes an open code at once.
  useEffect(() => { if (!active) hide() }, [active, hide])
  const codeCopy = useCopyFeedback({ copiedMessage: t('common.copied'), failedMessage: t('public.copyFailed') })
  const idCopy = useCopyFeedback({ copiedMessage: t('entries.idCopied'), failedMessage: t('entries.idCopyFailed') })
  const copyCode = () => { if (live) codeCopy.copy(live.code) }
  const shortId = entry.id.length > 16 ? `${entry.id.slice(0, 10)}…${entry.id.slice(-4)}` : entry.id
  const purpose = purposes.find(([value]) => value === entry.purpose)?.[1] || entry.purpose
  const highRisk = ['finance', 'admin'].includes(entry.purpose)
  const toggle = async () => {
    setBusy(true)
    try { await patch(`/api/entries/${entry.id}`, { status: active ? 'disabled' : 'active' }); await onChanged() }
    catch (error) { push(error.message, 'error') } finally { setBusy(false) }
  }
  const destroy = async () => {
    setBusy(true)
    try { await remove(`/api/entries/${entry.id}`, { confirmation: 'DELETE' }); setConfirmDelete(false); push('条目已永久删除'); await onChanged() }
    catch (error) { push(error.message, 'error') } finally { setBusy(false) }
  }
  return (
    <article className="vf vf-hover vf-entry" aria-labelledby={titleId}>
      <span className="vf-trace" aria-hidden="true"><i /></span>
      <span className="vf-trace vf-trace-soft" aria-hidden="true"><i /></span>
      <header className="vf-head">
        <span className="vf-avatar" aria-hidden="true">{(entry.issuer || entry.label || '?').slice(0, 1).toUpperCase()}</span>
        <div className="vf-title"><h3 id={titleId}>{entry.label}</h3><p>{entry.account_ref || entry.issuer || '未设置账号标识'}</p></div>
        <span className={`vf-status${active ? '' : ' is-off'}`}><i aria-hidden="true" />{t(`common.${entry.status}`)}</span>
      </header>
      <section className="vf-code" aria-label="验证码">
        <FlipCode digits={entry.digits} period={entry.period_seconds} live={live} reduced={reduced} onCopy={copyCode} />
        <div className="vf-bar">
          {live ? (
            <>
              <button type="button" className={`vf-copy vm-copy${codeCopy.copied ? ' is-copied' : ''}`} onClick={copyCode} aria-label={t('entries.copy')} title={t('entries.copy')}>
                {codeCopy.copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                <span aria-hidden="true">{codeCopy.copied ? t('common.copied') : t('common.copy')}</span>
                <CopyLock on={codeCopy.copied} />
              </button>
              <button type="button" className="vf-icon" onClick={hide} aria-label={t('entries.hide')} title={t('entries.hide')}><EyeOff size={17} aria-hidden="true" /></button>
            </>
          ) : (
            <button type="button" className="vf-reveal" onClick={reveal} disabled={loading || !active}><Eye size={17} aria-hidden="true" />{loading ? '正在生成…' : t('entries.reveal')}</button>
          )}
        </div>
      </section>
      <footer className="vf-meta">
        <span>{highRisk && <i className="vf-risk" aria-hidden="true" />}{purpose}{highRisk && <span className="sr-only">（高风险用途）</span>}</span><span className="vf-dot" aria-hidden="true">·</span>
        <span>{entry.digits} 位 · {entry.period_seconds}s · {entry.algorithm}</span><span className="vf-dot" aria-hidden="true">·</span>
        <span>{entry.caller_count} {t('entries.callers').trim()}</span>
        {/* The real entry_id used by caller API requests: shown shortened, copy always takes the full value. */}
        <span className="vf-id">
          <code title={entry.id} data-testid="entry-id">{idCopy.copied ? t('common.copied') : shortId}</code>
          <button type="button" className={`vf-id-copy vm-copy${idCopy.copied ? ' is-copied' : ''}`} onClick={() => idCopy.copy(entry.id)} aria-label={t('entries.copyId')} title={t('entries.copyId')}>
            {idCopy.copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <CopyLock on={idCopy.copied} />
          </button>
        </span>
      </footer>
      <div className="vf-actions">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onEdit(entry)} className="btn-quiet" aria-label={`编辑 ${entry.label}`}><Pencil size={16} aria-hidden="true" />编辑</button>
          <button type="button" onClick={toggle} disabled={busy} className="btn-quiet">{active ? <><Ban size={16} />{t('entries.disable')}</> : <><Power size={16} />{t('entries.enable')}</>}</button>
        </div>
        {active
          ? <button type="button" onClick={() => onAddToken(entry)} className="btn-quiet" aria-label={t('entries.addTokenFor').replace('{name}', entry.label)}><KeyRound size={16} aria-hidden="true" />{t('entries.addToken')}</button>
          : <button type="button" onClick={() => setConfirmDelete(true)} className="btn-danger-quiet"><Trash2 size={16} />{t('entries.delete')}</button>}
      </div>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="永久删除这个验证码？" description="密钥会从数据库中移除，相关调用方权限也会一起删除。请确认你已经保存平台恢复码。"><div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" onClick={() => setConfirmDelete(false)} className="btn-secondary">取消</button><button type="button" onClick={destroy} disabled={busy} className="btn-danger">{busy ? '正在删除…' : '确认永久删除'}</button></div></Dialog>
    </article>
  )
}

function ManualFields({ form, setForm }) {
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value })
  return <><label className="field-group"><span>Base32 设置密钥</span><input className="field font-mono" value={form.secret} onChange={set('secret')} autoCapitalize="characters" autoComplete="off" placeholder="平台显示的设置密钥" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="field-group"><span>条目名称</span><input className="field" value={form.label} onChange={set('label')} placeholder="例如：GitHub 部署账号" /></label><label className="field-group"><span>平台</span><input className="field" value={form.issuer} onChange={set('issuer')} placeholder="GitHub" /></label><label className="field-group"><span>账号标识</span><input className="field" value={form.account_ref} onChange={set('account_ref')} placeholder="脱敏邮箱或昵称" /></label><label className="field-group"><span>用途</span><select className="field" value={form.purpose} onChange={set('purpose')}>{purposes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field-group"><span>算法</span><select className="field" value={form.algorithm} onChange={set('algorithm')}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label><div className="grid grid-cols-2 gap-3"><label className="field-group"><span>位数</span><select className="field" value={form.digits} onChange={set('digits')}><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label><label className="field-group"><span>周期（秒）</span><input className="field" type="number" min="15" max="120" value={form.period_seconds} onChange={set('period_seconds')} /></label></div></div></>
}

const emptyImportForm = { secret: '', label: '', issuer: '', account_ref: '', purpose: 'automation', algorithm: 'SHA1', digits: 6, period_seconds: 30 }
// Selects hand back strings, so compare field values as strings.
const sameFields = (current, initial, keys = Object.keys(initial)) => keys.every((key) => String(current?.[key] ?? '') === String(initial?.[key] ?? ''))

function ImportDialog({ open, onClose, onCreated }) {
  const { t } = useLocale()
  const { push } = useToast()
  const [mode, setMode] = useState('qr')
  const [uri, setUri] = useState('')
  const [form, setForm] = useState(emptyImportForm)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [qrReading, setQrReading] = useState(false)
  const [qrName, setQrName] = useState('')
  const reset = () => { setMode('qr'); setUri(''); setError(''); setQrName(''); setForm(emptyImportForm); setConfirmDiscard(false) }
  const close = () => { if (!busy) { reset(); onClose() } }
  // Unsaved input (a read QR / URI or any changed field) is never dropped by a stray click: backdrop, Esc, ×
  // and 取消 ask first. Secrets are never kept as drafts.
  const dirty = open && (Boolean(uri) || !sameFields(form, emptyImportForm))
  const requestClose = () => { if (busy) return; if (dirty) setConfirmDiscard(true); else close() }
  useBeforeUnloadWhile(dirty)
  const readQr = useCallback(async (file, displayName) => {
    setError('')
    setQrName(displayName || file?.name || '二维码图片')
    setQrReading(true)
    try { setUri(await decodeQrFile(file)) }
    catch (readError) { setUri(''); setError(readError.message) }
    finally { setQrReading(false) }
  }, [])
  useEffect(() => {
    if (!open || mode !== 'qr') return undefined
    const handlePaste = (event) => {
      const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith('image/'))
        || [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'))?.getAsFile()
      if (!file) return
      event.preventDefault()
      readQr(file, '剪贴板图片')
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [mode, open, readQr])
  const pasteQr = async () => {
    if (!navigator.clipboard?.read) {
      setError('当前浏览器不支持按钮读取剪贴板；请复制图片后在弹窗内按 ⌘V / Ctrl+V。')
      return
    }
    setError('')
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (imageType) {
          await readQr(await item.getType(imageType), '剪贴板图片')
          return
        }
      }
      setError('剪贴板里没有图片。请先复制完整的二维码截图。')
    } catch {
      setError('浏览器未允许读取剪贴板；请保持弹窗打开，直接按 ⌘V / Ctrl+V。')
    }
  }
  const submit = async (event) => {
    event.preventDefault(); setError('')
    const body = mode === 'manual' ? { ...form, digits: Number(form.digits), period_seconds: Number(form.period_seconds) } : { otpauth_uri: uri, purpose: form.purpose }
    if (mode !== 'manual' && !uri) return setError('请先读取二维码或粘贴 otpauth URI。')
    if (mode === 'manual' && (!form.secret || !form.label)) return setError('设置密钥和条目名称都不能为空。')
    setBusy(true)
    try {
      const createdEntry = await post('/api/entries', body)
      const createdSeed = mode === 'manual' ? normalizeSeed(form.secret) : seedFromUri(uri)
      push('验证码已安全导入')
      reset()
      onClose()
      await onCreated(createdSeed, createdEntry)
    }
    catch (error) { setError(error.code === 'DUPLICATE_TOTP_SECRET' ? '这个验证码密钥已经存在。' : error.message) } finally { setBusy(false) }
  }
  return <Dialog open={open} onClose={requestClose} title="导入 TOTP 验证码" description="二维码只在浏览器本地识别；服务端最终只接收标准 otpauth URI 或 Base32 设置密钥。" size="lg"><div className="segmented mb-5" role="tablist" aria-label="导入方式">{[['qr', '二维码图片', FileImage], ['uri', '粘贴 URI', KeyRound], ['manual', '手动密钥', Pencil]].map(([value, label, Icon]) => <button key={value} type="button" role="tab" aria-selected={mode === value} onClick={() => { setMode(value); setError('') }} className={mode === value ? 'active' : ''}><Icon size={16} />{label}</button>)}</div><form onSubmit={submit} className="space-y-4" noValidate>{mode === 'qr' && <div className="space-y-3"><label className="upload-zone"><input type="file" accept="image/*" className="sr-only" onChange={(event) => readQr(event.target.files?.[0])} />{uri ? <><Check className="text-success" size={26} /><strong>已读取标准 TOTP 二维码</strong><span>{qrName}</span></> : qrReading ? <><span className="loader" /><strong>正在本地识别二维码…</strong><span>图片不会上传到外部服务</span></> : <><Upload size={26} /><strong>选择二维码截图</strong><span>PNG、JPG 或 WebP，最大 8 MB</span></>}</label><div className="flex flex-col gap-3 rounded-card border border-border bg-tint p-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm leading-relaxed text-muted">复制二维码图片后，可直接按 <kbd className="rounded-field border border-border bg-elev px-1.5 py-0.5 font-mono text-xs text-heading">⌘V / Ctrl+V</kbd></p><button type="button" className="btn-secondary shrink-0" onClick={pasteQr} disabled={qrReading}><Clipboard size={17} />读取剪贴板图片</button></div></div>}{mode === 'uri' && <label className="field-group"><span>otpauth URI</span><textarea className="field min-h-28 resize-y font-mono text-sm" value={uri} onChange={(event) => setUri(event.target.value)} placeholder="otpauth://totp/平台:账号?secret=…" /></label>}{mode === 'manual' && <ManualFields form={form} setForm={setForm} />}{mode !== 'manual' && <label className="field-group"><span>用途分类</span><select className="field" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}>{purposes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}{error && <p role="alert" className="form-error">{error}</p>}{confirmDiscard ? <CloseConfirm className="" title={t('form.discardTitle')} detail={t('form.discardText')} keepLabel={t('form.keepEditing')} confirmLabel={t('form.discard')} onKeep={() => setConfirmDiscard(false)} onConfirm={close} /> : <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end"><button type="button" className="btn-secondary" onClick={requestClose}>取消</button><button type="submit" className="btn-primary" disabled={busy || qrReading}>{busy ? '正在加密保存…' : '确认导入'}</button></div>}</form></Dialog>
}

// Current code for a just-created entry, read from the server (proves the stored seed decrypts correctly).
// One request per TOTP window: the next one is scheduled just after the server-reported expiry.
// Clearing `entryId` (dialog closed) cancels the timer, drops in-flight replies and wipes the code.
function useServerCode(entryId, onRead) {
  const [state, setState] = useState({ status: 'idle', code: null, error: '' })
  const [now, setNow] = useState(Date.now())
  const [attempt, setAttempt] = useState(0)
  const onReadRef = useRef(onRead)
  useEffect(() => { onReadRef.current = onRead }, [onRead])
  useEffect(() => {
    if (!entryId) { setState({ status: 'idle', code: null, error: '' }); return undefined }
    let alive = true
    let timer = 0
    const load = async () => {
      setState((current) => ({ ...current, status: current.code ? 'refreshing' : 'loading', error: '' }))
      try {
        const data = await post(`/api/entries/${entryId}/code`, {})
        if (!alive) return
        // remaining_seconds is relative to the server clock, so the deadline does not depend on browser clock skew.
        const deadline = Date.now() + data.remaining_seconds * 1000
        setState({ status: 'ready', code: { ...data, deadline }, error: '' })
        setNow(Date.now())
        onReadRef.current?.()
        timer = window.setTimeout(load, deadline - Date.now() + 300)
      } catch (error) {
        if (alive) setState({ status: 'error', code: null, error: error.code || 'REQUEST_FAILED' })
      }
    }
    load()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [entryId, attempt])
  useEffect(() => {
    if (!state.code) return undefined
    const tick = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(tick)
  }, [state.code])
  const remaining = state.code ? Math.max(0, Math.ceil((state.code.deadline - now) / 1000)) : 0
  return { ...state, remaining, retry: () => setAttempt((current) => current + 1) }
}

const codeErrorKeys = { CLOCK_UNHEALTHY: 'seed.codeErrorClock', KEY_UNAVAILABLE: 'seed.codeErrorKey', ENTRY_NOT_FOUND: 'seed.codeErrorGone', ENTRY_DISABLED: 'seed.codeErrorGone' }

function NewEntryCode({ entry, onAuditChanged }) {
  const { t } = useLocale()
  const headingId = useId()
  const { status, code, error, remaining, retry } = useServerCode(entry?.id, onAuditChanged)
  const { copied, copy } = useCopyFeedback({ copiedMessage: t('seed.codeCopied'), failedMessage: t('seed.codeCopyFailed') })
  const digits = code?.digits || entry?.digits || 6
  const period = code?.period_seconds || entry?.period_seconds || 30
  return (
    <section className="code-panel mt-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold text-heading">{t('seed.codeTitle')}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted">{t('seed.codeHint').replace('{digits}', String(digits))}</p>
      {code ? (
        <div className="mt-3">
          <div className="flex items-center gap-3">
            <svg className="h-11 w-11 shrink-0 -rotate-90" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="none" className="timer-track" strokeWidth="3" /><circle cx="20" cy="20" r="16" fill="none" className="timer-progress" strokeWidth="3" strokeLinecap="round" strokeDasharray="100.5" strokeDashoffset={100.5 * (1 - remaining / period)} /></svg>
            <div className="min-w-0 flex-1">
              <p className="otp-code whitespace-nowrap text-3xl leading-tight" aria-live="polite" data-testid="new-entry-code">{code.code}</p>
              <p className="mt-0.5 text-xs text-muted">{status === 'refreshing' ? t('seed.codeRefreshing') : t('seed.codeRefreshIn').replace('{seconds}', String(remaining))}</p>
            </div>
            <button type="button" className={`copy-chip vm-copy ${copied ? 'is-copied' : ''}`} onClick={() => copy(code.code)} aria-label={t('seed.codeCopy')} title={t('seed.codeCopy')}>{copied ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}<span aria-hidden="true">{copied ? t('common.copied') : t('common.copy')}</span><CopyLock on={copied} /></button>
          </div>
          {code.refresh_recommended && status === 'ready' && <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted"><Clock size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />{t('seed.codeExpiringSoon')}</p>}
        </div>
      ) : status === 'error' ? (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p role="alert" className="flex items-start gap-2 text-sm leading-relaxed text-text"><AlertCircle size={17} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />{t(codeErrorKeys[error] || 'seed.codeErrorGeneric')}</p>
          <button type="button" className="btn-secondary shrink-0" onClick={retry}><RefreshCw size={16} aria-hidden="true" />{t('common.retry')}</button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 text-sm text-muted" aria-busy="true"><Loader2 size={18} className="animate-spin text-accent" aria-hidden="true" />{t('seed.codeLoading')}</div>
      )}
    </section>
  )
}

// Backdrop / Esc / × only ask first (the seed cannot be shown again); 「我已保存，关闭」 closes directly.
function OneTimeSeedDialog({ created, onClose, onAuditChanged }) {
  const { t } = useLocale()
  const seed = created?.seed || ''
  const { copied, copy } = useCopyFeedback({ copiedMessage: t('seed.copied'), failedMessage: t('seed.copyFailed') })
  const [confirmClose, setConfirmClose] = useState(false)
  useEffect(() => { setConfirmClose(false) }, [seed])
  return (
    <Dialog
      open={Boolean(seed)}
      onClose={() => setConfirmClose(true)}
      title={t('seed.title')}
      description={t('seed.description')}
    >
      <div className="sensitive-panel">
        <div className="flex items-start gap-3">
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-muted">{t('seed.warning')}</p>
        </div>
        <div className="code-block mt-4 p-4">
          <p className="mb-2 text-xs font-semibold text-muted">{t('seed.label')}</p>
          <p className="select-all break-all font-mono text-lg font-semibold leading-relaxed tracking-[0.06em] text-heading">{seed}</p>
        </div>
      </div>
      {created?.entry?.id && <NewEntryCode entry={created.entry} onAuditChanged={onAuditChanged} />}
      {confirmClose ? (
        <CloseConfirm tone="warning" title={t('seed.closeConfirm')} keepLabel={t('seed.keepViewing')} confirmLabel={t('seed.closeConfirmYes')} onKeep={() => setConfirmClose(false)} onConfirm={onClose} />
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button type="button" className="btn-primary vm-copy" onClick={() => copy(seed)}>
            {copied ? <Check size={17} /> : <Clipboard size={17} />}
            {copied ? t('seed.copiedButton') : t('seed.copy')}
            <CopyLock on={copied} />
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>{t('seed.close')}</button>
        </div>
      )}
    </Dialog>
  )
}

const editableEntryFields = ['label', 'issuer', 'account_ref', 'purpose']

function EditDialog({ entry, onClose, onSaved }) {
  const { t } = useLocale()
  const { push } = useToast()
  const [form, setForm] = useState(entry || {})
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  useEffect(() => { setForm(entry || {}); setConfirmDiscard(false) }, [entry])
  const dirty = Boolean(entry) && !sameFields(form, entry, editableEntryFields)
  useBeforeUnloadWhile(dirty)
  if (!entry) return null
  const requestClose = () => { if (busy) return; if (dirty) setConfirmDiscard(true); else onClose() }
  const save = async (event) => { event.preventDefault(); setBusy(true); try { await patch(`/api/entries/${entry.id}`, { label: form.label, issuer: form.issuer, account_ref: form.account_ref, purpose: form.purpose }); push('条目信息已更新'); await onSaved(); onClose() } catch (error) { push(error.message, 'error') } finally { setBusy(false) } }
  return <Dialog open={Boolean(entry)} onClose={requestClose} title="编辑条目信息" description="这里只修改显示信息和用途，不会改变平台绑定密钥。"><form onSubmit={save} className="space-y-4"><label className="field-group"><span>条目名称</span><input className="field" value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label><div className="grid gap-4 sm:grid-cols-2"><label className="field-group"><span>平台</span><input className="field" value={form.issuer || ''} onChange={(e) => setForm({ ...form, issuer: e.target.value })} /></label><label className="field-group"><span>账号标识</span><input className="field" value={form.account_ref || ''} onChange={(e) => setForm({ ...form, account_ref: e.target.value })} /></label></div><label className="field-group"><span>用途</span><select className="field" value={form.purpose || 'automation'} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>{purposes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{confirmDiscard ? <CloseConfirm className="" title={t('form.discardTitle')} detail={t('form.discardText')} keepLabel={t('form.keepEditing')} confirmLabel={t('form.discard')} onKeep={() => setConfirmDiscard(false)} onConfirm={onClose} /> : <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end"><button type="button" className="btn-secondary" onClick={requestClose}>取消</button><button type="submit" className="btn-primary" disabled={busy}>{busy ? '正在保存…' : '保存修改'}</button></div>}</form></Dialog>
}

export default function EntriesView({ entries, callers, loading, error, onReload, onAuditChanged }) {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  // { seed, entry } of the entry just created; cleared on close so the seed and its live code leave memory.
  const [justCreated, setJustCreated] = useState(null)
  // 「新增令牌」: the entry whose dialog is open, then { caller (with the one-time token), entry } for the token dialog.
  const [tokenEntry, setTokenEntry] = useState(null)
  const [issued, setIssued] = useState(null)
  const tokenCreated = async (caller, entry) => {
    setIssued({ caller, entry })
    await onReload()
    onAuditChanged?.()
  }
  const created = async (seed, entry) => {
    if (seed) setJustCreated({ seed, entry })
    await onReload()
  }
  const filtered = useMemo(() => { const needle = query.trim().toLowerCase(); return needle ? entries.filter((entry) => [entry.label, entry.issuer, entry.account_ref, entry.purpose].some((value) => value?.toLowerCase().includes(needle))) : entries }, [entries, query])
  const active = entries.filter((entry) => entry.status === 'active').length
  const activeCallers = callers.filter((caller) => caller.status === 'active').length
  const highRisk = entries.filter((entry) => ['finance', 'admin'].includes(entry.purpose) && entry.caller_count > 0).length
  // Skeleton only until the first answer: a reload after toggling, deleting or importing keeps the cards on screen,
  // so additions and removals animate in place instead of the whole list being rebuilt.
  const settled = useRef(false)
  if (!loading) settled.current = true
  const showSkeleton = loading && (!settled.current || !entries.length)
  // The batch the list first shows with is staggered; cards added later (or re-shown by a search) enter at once.
  const intro = useRef(null)
  if (!intro.current && !showSkeleton) intro.current = { ids: filtered.map((entry) => entry.id), at: performance.now() }
  const introDelay = (id) => {
    const index = intro.current?.ids.indexOf(id) ?? -1
    if (index < 0 || performance.now() - intro.current.at > 600) return 0
    return Math.min(index * STAGGER, STAGGER_CAP)
  }
  // Cards: popLayout takes a removed card out of the flow at once, and the others slide to their new slots
  // (position only — a size change snaps, so card content is never scaled while it moves).
  const stats = [[entries.length, t('summary.total'), KeyRound], [active, t('summary.active'), ShieldCheck], [activeCallers, t('summary.callers'), Users], [highRisk, t('summary.risk'), Ban]]
  return <section aria-labelledby="entries-heading"><div className="page-heading"><div><span className="vh-tag" aria-hidden="true">[01/03]<span>ENTRIES</span></span><h1 id="entries-heading">{t('entries.title')}</h1><p>{t('entries.subtitle')}</p></div><button type="button" className="btn-primary" onClick={() => setImportOpen(true)}><Plus size={18} />{t('entries.add')}</button></div><div className="summary-grid">{stats.map(([value, label, Icon], index) => <motion.div key={label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: cardEnter(index * STAGGER) }}><div className="summary-card vf"><div><span>{label}</span><DecodeNumber value={value} /></div><Icon size={20} className={highRisk && index === 3 ? 'text-warning' : 'text-accent'} /></div></motion.div>)}</div><div className="toolbar"><label className="search-field"><Search size={18} /><span className="sr-only">{t('entries.search')}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('entries.search')} /></label><div className="toolbar-meta">显示 {filtered.length} / {entries.length}</div></div>{showSkeleton ? <CardSkeletons /> : error ? <ErrorState onRetry={onReload} /> : filtered.length ? <div className="vf-grid relative"><AnimatePresence mode="popLayout">{filtered.map((entry) => <motion.div key={entry.id} className="min-w-0" layout="position" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: cardEnter(introDelay(entry.id)) }} exit={{ opacity: 0, scale: 0.98, transition: exit }} transition={enter}><EntryCard entry={entry} onChanged={onReload} onEdit={setEditing} onAddToken={setTokenEntry} onAuditChanged={onAuditChanged} /></motion.div>)}</AnimatePresence></div> : <EmptyEntries query={query} onAdd={() => setImportOpen(true)} />}<ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onCreated={created} /><OneTimeSeedDialog created={justCreated} onClose={() => setJustCreated(null)} onAuditChanged={onAuditChanged} /><EditDialog entry={editing} onClose={() => setEditing(null)} onSaved={onReload} /><AddTokenDialog entry={tokenEntry} onClose={() => setTokenEntry(null)} onCreated={tokenCreated} /><TokenDialog caller={issued?.caller} entries={entries} shareEntry={issued?.entry} onClose={() => setIssued(null)} /></section>
}

function CardSkeletons() { return <div className="vf-grid" aria-label="正在载入">{[0,1,2].map((item) => <div key={item} className="vf h-72 animate-pulse"><div className="vf-well m-5 h-10 rounded" /><div className="vf-well m-5 h-6 rounded" /><div className="vf-well m-5 mt-20 h-12 rounded" /></div>)}</div> }
function ErrorState({ onRetry }) { return <div className="empty-state vf"><Ban size={30} /><h2>载入失败</h2><p>控制台暂时无法读取数据，请确认本地服务仍在运行。</p><button className="btn-secondary" onClick={onRetry}>重试</button></div> }
function EmptyEntries({ query, onAdd }) { const { t } = useLocale(); return <div className="empty-state vf"><KeyRound size={32} /><h2>{query ? '没有匹配的条目' : t('entries.empty')}</h2><p>{query ? '换一个平台、账号或用途关键词试试。' : t('entries.emptyHint')}</p>{!query && <button className="btn-primary" onClick={onAdd}><Plus size={18} />{t('entries.add')}</button>}</div> }
