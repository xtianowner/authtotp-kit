import { useEffect, useId, useMemo, useState } from 'react'
import { Bot, Check, Clock, Pencil, Plus, Search, SearchX, ShieldAlert, Trash2, X } from 'lucide-react'
import { motion } from 'motion/react'
import { enter } from '../lib/motion.js'
import Dialog from './ui/Dialog.jsx'
import CopyButton from './ui/CopyButton.jsx'
import CloseConfirm, { useBeforeUnloadWhile } from './ui/CloseConfirm.jsx'
import TokenLifetimeField, { formatLocalTime, isNeverExpiring, useDefaultLifetime } from './ui/TokenLifetime.jsx'
import { useToast } from './ui/Toast.jsx'
import { patch, post } from '../lib/api.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

const purposeSearchTerms = {
  automation: '自动化 automation',
  personal: '个人 personal',
  finance: '财务 finance',
  admin: '管理员 admin administrator',
  other: '其他 other',
}

function hasExpired(expiresAt) {
  if (isNeverExpiring(expiresAt)) return false
  const timestamp = new Date(expiresAt).getTime()
  return Number.isFinite(timestamp) && timestamp <= Date.now()
}

// 「有效期：到 2026/10/07 13:39」 — local time to the minute, same digits in both UI languages.
function formatValidUntil(expiresAt) {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Runnable Mac/Linux command for one allowed entry, aimed at the origin this vault is served from. The token is
// never embedded: it comes from $AUTHTOTP_TOKEN, filled by TOKEN_PREPARE_COMMAND (no echo, no shell history).
const TOKEN_PREPARE_COMMAND = 'read -rs AUTHTOTP_TOKEN'
function curlCommand(entryId) {
  return `curl -sS -X POST -H "Authorization: Bearer $AUTHTOTP_TOKEN" ${window.location.origin}/v1/totp/${entryId}/code`
}

// Colleague code page link (src/components/CodePage.jsx): everything rides in the fragment, which browsers never
// send to the server. n = account (or the entry name), p = platform (omitted when the entry has none or is unknown).
function colleagueCodeLink(entryId, entry, token) {
  const params = [`e=${encodeURIComponent(entryId)}`, `t=${encodeURIComponent(token)}`, `n=${encodeURIComponent(entry?.account_ref || entry?.label || '')}`]
  if (entry?.issuer) params.push(`p=${encodeURIComponent(entry.issuer)}`)
  return `${window.location.origin}/code#${params.join('&')}`
}

function matchesEntry(entry, query) {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase()
  if (!needle) return true
  return [entry.label, entry.issuer, entry.account_ref, entry.purpose, purposeSearchTerms[entry.purpose]]
    .some((value) => String(value || '').normalize('NFKC').toLocaleLowerCase().includes(needle))
}

function CallerDialog({ open, caller, entries, onClose, onSaved, onToken }) {
  const { locale, t } = useLocale()
  const [form, setForm] = useState({ name: '', purpose: '', allowed_entry_ids: [] })
  const [entryQuery, setEntryQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // Token lifetime (create only): null = follow the server default (GET /api/meta) until the owner picks one.
  const lifetimeDefault = useDefaultLifetime()
  const [ttl, setTtl] = useState(null)
  const ttlValue = ttl ?? (lifetimeDefault.ready ? lifetimeDefault.hours : null)
  const searchId = useId()
  const searchSummaryId = useId()
  const initial = useMemo(() => (caller ? { name: caller.name, purpose: caller.purpose, allowed_entry_ids: caller.allowed_entry_ids } : { name: '', purpose: '', allowed_entry_ids: [] }), [caller])
  useEffect(() => {
    setForm(initial)
    setEntryQuery('')
    setError('')
    setConfirmDiscard(false)
    setTtl(null)
  }, [initial, open])
  // The entry search box is not saved data; only name, purpose and the allow-list count as unsaved input.
  const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id))
  const dirty = open && (form.name !== initial.name || form.purpose !== initial.purpose || !sameIds(form.allowed_entry_ids, initial.allowed_entry_ids) || (!caller && ttl !== null && ttl !== lifetimeDefault.hours))
  const requestClose = () => { if (busy) return; if (dirty) setConfirmDiscard(true); else onClose() }
  useBeforeUnloadWhile(dirty)
  const filteredEntries = useMemo(() => entries.filter((entry) => matchesEntry(entry, entryQuery)), [entries, entryQuery])
  const toggle = (id) => setForm((current) => ({ ...current, allowed_entry_ids: current.allowed_entry_ids.includes(id) ? current.allowed_entry_ids.filter((item) => item !== id) : [...current.allowed_entry_ids, id] }))
  const submit = async (event) => {
    event.preventDefault(); setError('')
    if (!form.name.trim() || !form.purpose.trim()) return setError('调用方名称和用途都不能为空。')
    setBusy(true)
    try {
      const result = caller ? await patch(`/api/callers/${caller.id}`, form) : await post('/api/callers', { ...form, expires_in_hours: ttlValue })
      await onSaved()
      onClose()
      if (result.token) onToken(result)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }
  const highRiskSelected = entries.some((entry) => form.allowed_entry_ids.includes(entry.id) && ['finance', 'admin'].includes(entry.purpose))
  const resultSummary = locale === 'zh'
    ? <>显示 <strong className="font-semibold text-heading">{filteredEntries.length}</strong> / {entries.length}；已选 <strong className="font-semibold text-heading">{form.allowed_entry_ids.length}</strong></>
    : <><strong className="font-semibold text-heading">{filteredEntries.length}</strong> of {entries.length} shown; <strong className="font-semibold text-heading">{form.allowed_entry_ids.length}</strong> selected</>
  return <Dialog open={open} onClose={requestClose} title={caller ? '编辑调用方权限' : '创建自动化调用方'} description="调用方凭据只显示一次；之后只能撤销重建，不能再次查看。" size="lg"><form onSubmit={submit} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><label className="field-group"><span>调用方名称</span><input className="field" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：本机浏览器任务" /></label><label className="field-group"><span>用途说明</span><input className="field" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} placeholder="用于哪个自动化流程" /></label></div>{!caller && <TokenLifetimeField value={ttlValue} onChange={setTtl} />}<fieldset><legend className="mb-2 text-sm font-semibold text-heading">允许读取的条目</legend><div className="mb-3 space-y-2"><label htmlFor={searchId} className="sr-only">{t('callers.entriesSearch')}</label><div className="search-field max-w-none"><Search size={18} aria-hidden="true" /><input id={searchId} type="search" value={entryQuery} onChange={(event) => setEntryQuery(event.target.value)} placeholder={t('callers.entriesSearch')} autoComplete="off" aria-describedby={searchSummaryId} />{entryQuery && <button type="button" onClick={() => setEntryQuery('')} className="icon-button -mr-2 shrink-0" aria-label={t('callers.entriesClear')}><X size={17} /></button>}</div><p id={searchSummaryId} role="status" aria-live="polite" className="text-xs text-muted">{resultSummary}</p></div><div className="max-h-64 space-y-2 overflow-y-auto rounded-card border border-border p-2">{entries.length ? filteredEntries.length ? filteredEntries.map((entry) => <label key={entry.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded px-3 py-2 transition-colors hover:bg-tint"><input type="checkbox" checked={form.allowed_entry_ids.includes(entry.id)} onChange={() => toggle(entry.id)} className="h-4 w-4 accent-accent" /><span className="min-w-0 flex-1"><strong className="block [overflow-wrap:anywhere] text-sm text-text">{entry.label}</strong><span className="block break-all text-xs text-muted">{entry.account_ref || entry.issuer}</span></span>{['finance', 'admin'].includes(entry.purpose) && <ShieldAlert size={17} className="shrink-0 text-warning" />}</label>) : <div className="flex min-h-40 flex-col items-center justify-center p-4 text-center text-muted"><SearchX size={28} aria-hidden="true" /><p className="mt-3 text-sm font-semibold text-heading">{t('callers.entriesNoMatch')}</p><p className="mt-1 text-xs leading-relaxed">{t('callers.entriesNoMatchHint')}</p><button type="button" onClick={() => setEntryQuery('')} className="btn-quiet mt-2">{t('callers.entriesClear')}</button></div> : <p className="p-4 text-center text-sm text-muted">请先创建验证码条目。</p>}</div></fieldset>{highRiskSelected && <p role="alert" className="form-warning"><ShieldAlert size={18} />所选范围包含财务或管理员条目。建议取消并保留人工验证。</p>}{error && <p role="alert" className="form-error">{error}</p>}{confirmDiscard ? <CloseConfirm className="" title={t('form.discardTitle')} detail={t('form.discardText')} keepLabel={t('form.keepEditing')} confirmLabel={t('form.discard')} onKeep={() => setConfirmDiscard(false)} onConfirm={onClose} /> : <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end"><button type="button" onClick={requestClose} className="btn-secondary">取消</button><button type="submit" disabled={busy || (!caller && ttlValue === null)} className="btn-primary">{busy ? '正在保存…' : caller ? '保存权限' : '创建并生成凭据'}</button></div>}</form></Dialog>
}

// Same rule as the one-time Base32 key: backdrop / Esc / × ask first; 「我已安全保存」 closes directly.
// Opened after 「新建调用方」 (callers page) and 「新增令牌」 (entry card). Top: one /code link per allowed entry, to send
// straight to whoever uses it, plus the single validity line. Below: the developer route (raw token, read -rs, curl).
// shareEntry (optional): the entry a card-created token is for, used only if the entry list does not have it yet.
export function TokenDialog({ caller, entries, shareEntry = null, onClose }) {
  const { t } = useLocale()
  const linksHeadingId = useId()
  const devHeadingId = useId()
  const [confirmClose, setConfirmClose] = useState(false)
  useEffect(() => setConfirmClose(false), [caller])
  const neverExpires = caller && isNeverExpiring(caller.expires_at)
  const allowedIds = caller?.allowed_entry_ids || []
  const entryOf = (id) => entries.find((item) => item.id === id) || (shareEntry?.id === id ? shareEntry : null)
  const codeBlock = 'code-block mt-2 flex items-start gap-2 bg-elev py-0.5 pl-3 pr-0.5'
  const codeText = 'min-w-0 flex-1 select-all break-all py-2.5 font-mono text-xs leading-relaxed text-heading'
  return <Dialog open={Boolean(caller)} onClose={() => setConfirmClose(true)} title="立即保存调用凭据" description="这是唯一一次显示。请放入调用任务的运行时秘密管理器，不要写进脚本、文档或 .env。">
    <section className="code-panel" aria-labelledby={linksHeadingId} data-testid="caller-code-links">
      <h3 id={linksHeadingId} className="text-sm font-semibold text-heading">{t('token.linksTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t(allowedIds.length ? 'token.linksHint' : 'token.linksEmpty')}</p>
      {caller?.token && allowedIds.length > 0 && <ul className="mt-3 space-y-3">{allowedIds.map((id) => { const entry = entryOf(id); const name = entry?.label || t('token.entryMissing'); const link = colleagueCodeLink(id, entry, caller.token); return <li key={id} data-testid="caller-code-link"><strong className="block [overflow-wrap:anywhere] text-sm text-text">{name}</strong>{entry && (entry.account_ref || entry.issuer) && <span className="block break-all text-xs text-muted">{entry.account_ref || entry.issuer}</span>}<div className={codeBlock}><code className={codeText}>{link}</code><CopyButton value={link} label={t('token.copyLink').replace('{name}', name)} copiedMessage={t('token.linkCopied')} failedMessage={t('token.linkCopyFailed')} /></div></li> })}</ul>}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted" data-testid="caller-token-validity"><Clock size={14} className="shrink-0" aria-hidden="true" />{neverExpires ? t('token.validityNever') : t('token.validityUntil').replace('{date}', formatValidUntil(caller?.expires_at))}</p>
    </section>
    <section className="mt-4 rounded-card border border-border bg-tint p-4 text-sm text-muted" aria-labelledby={devHeadingId}>
      <h3 id={devHeadingId} className="font-semibold text-heading">{t('token.commandsTitle')}</h3>
      <div className="sensitive-panel mt-3"><div className="mb-3 flex items-center gap-2 text-sm font-medium text-warning"><ShieldAlert size={18} className="text-warning" aria-hidden="true" />关闭后无法再次查看</div><div className="code-block flex items-center gap-2 p-3"><code className="min-w-0 flex-1 break-all font-mono text-sm text-heading" data-testid="caller-token">{caller?.token}</code><CopyButton value={caller?.token} label="复制调用凭据" copiedMessage="调用凭据已复制" failedMessage={t('twofa.copyFailed')} /></div></div>
      <p className="mt-3 text-xs leading-relaxed">{t('token.prepareHint')}</p>
      <div className={codeBlock} data-testid="caller-prepare"><code className={codeText}>{TOKEN_PREPARE_COMMAND}</code><CopyButton value={TOKEN_PREPARE_COMMAND} label={t('token.copyPrepare')} copiedMessage={t('token.prepareCopied')} failedMessage={t('token.commandCopyFailed')} /></div>
      <p className="mt-3 text-xs leading-relaxed">{t(allowedIds.length ? 'token.commandsHint' : 'token.commandsEmpty')}</p>
      {allowedIds.length ? <ul className="mt-3 space-y-3">{allowedIds.map((id) => { const entry = entryOf(id); const name = entry?.label || t('token.entryMissing'); return <li key={id} data-testid="caller-command"><strong className="block [overflow-wrap:anywhere] text-sm text-text">{name}</strong>{entry && (entry.account_ref || entry.issuer) && <span className="block break-all text-xs text-muted">{entry.account_ref || entry.issuer}</span>}<div className={codeBlock}><code className={codeText}>{curlCommand(id)}</code><CopyButton value={curlCommand(id)} label={t('token.copyCommand').replace('{name}', name)} copiedMessage={t('token.commandCopied')} failedMessage={t('token.commandCopyFailed')} /></div></li> })}</ul> : <code className="mt-2 block break-all font-mono text-xs">{curlCommand('<ENTRY_ID>')}</code>}
    </section>
    {confirmClose ? <CloseConfirm tone="warning" title={t('token.closeConfirm')} keepLabel={t('seed.keepViewing')} confirmLabel={t('seed.closeConfirmYes')} onKeep={() => setConfirmClose(false)} onConfirm={onClose} /> : <button type="button" onClick={onClose} className="btn-primary mt-5 w-full"><Check size={17} />我已安全保存</button>}
  </Dialog>
}

// Validity on a caller card: 「永不过期」, 「<日期> 到期」, or 「已过期」 in the danger colour once the time has passed.
function CallerValidity({ expiresAt }) {
  const { locale, t } = useLocale()
  if (isNeverExpiring(expiresAt)) return <span className="text-right text-xs text-text" data-testid="caller-validity">{t('ttl.never')}</span>
  const when = formatLocalTime(expiresAt, locale)
  if (hasExpired(expiresAt)) return <time className="text-right text-xs font-semibold text-danger" dateTime={expiresAt} title={when || undefined} data-testid="caller-validity">{t('common.expired')}</time>
  return <time className="text-right text-xs text-text" dateTime={expiresAt} data-testid="caller-validity">{when ? t('callers.expiresOn').replace('{date}', when) : '—'}</time>
}

export default function CallersView({ callers, entries, loading, onReload }) {
  const { t } = useLocale()
  const { push } = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [tokenCaller, setTokenCaller] = useState(null)
  const [revoking, setRevoking] = useState(null)
  const revoke = async () => {
    try { await post(`/api/callers/${revoking.id}/revoke`, { confirmation: 'REVOKE' }); setRevoking(null); push('调用方已撤销'); await onReload() }
    catch (error) { push(error.message, 'error') }
  }
  const statusOf = (caller) => caller.status === 'active' && hasExpired(caller.expires_at) ? 'expired' : caller.status
  return <section aria-labelledby="callers-heading"><div className="page-heading"><div><span className="vh-tag" aria-hidden="true">[02/03]<span>CALLERS</span></span><h1 id="callers-heading">{t('callers.title')}</h1><p>{t('callers.subtitle')}</p></div><button type="button" className="btn-primary" onClick={() => { setEditing(null); setDialogOpen(true) }}><Plus size={18} />{t('callers.add')}</button></div>{loading ? <div className="vf h-56 animate-pulse" /> : callers.length ? <div className="vf-grid">{callers.map((caller, index) => { const status = statusOf(caller); return <motion.article key={caller.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: index * 0.04 }} className="vf vf-hover p-5"><span className="vf-trace" aria-hidden="true"><i /></span><span className="vf-trace vf-trace-soft" aria-hidden="true"><i /></span><div className="flex items-start gap-3"><div className="issuer-mark"><Bot size={20} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="[overflow-wrap:anywhere] font-semibold text-heading">{caller.name}</h2><span className={`status-dot ${status === 'active' ? 'status-active' : 'status-disabled'}`}>{t(`common.${status}`)}</span></div><p className="mt-1 [overflow-wrap:anywhere] text-sm text-muted">{caller.purpose}</p></div>{status === 'active' && <button type="button" className="icon-button" onClick={() => { setEditing(caller); setDialogOpen(true) }} aria-label={`编辑 ${caller.name}`}><Pencil size={16} /></button>}</div><div className="vf-well my-4 space-y-2 rounded-card px-3 py-2 text-sm"><div className="flex items-center justify-between"><span className="text-muted">凭据尾号</span><code className="font-mono text-text">{caller.token_hint}</code></div><div className="flex items-center justify-between gap-4"><span className="text-muted">{t('callers.validity')}</span><CallerValidity expiresAt={caller.expires_at} /></div></div><div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('callers.allowed')}</p><div className="flex flex-wrap gap-2">{caller.allowed_entry_ids.length ? caller.allowed_entry_ids.map((id) => { const entry = entries.find((item) => item.id === id); return <span key={id} className="badge">{entry?.label || '已删除条目'}</span> }) : <span className="text-sm text-muted">未授予任何条目</span>}</div></div>{status === 'active' && <div className="mt-5 border-t border-border pt-3 text-right"><button type="button" className="btn-danger-quiet" onClick={() => setRevoking(caller)}><Trash2 size={16} />{t('callers.revoke')}</button></div>}</motion.article> })}</div> : <div className="empty-state vf"><Bot size={32} /><h2>{t('callers.empty')}</h2><p>为某个明确的自动化任务创建最小权限凭据。</p><button className="btn-primary" onClick={() => setDialogOpen(true)}><Plus size={18} />{t('callers.add')}</button></div>}<CallerDialog open={dialogOpen} caller={editing} entries={entries} onClose={() => { setDialogOpen(false); setEditing(null) }} onSaved={onReload} onToken={setTokenCaller} /><TokenDialog caller={tokenCaller} entries={entries} onClose={() => setTokenCaller(null)} /><Dialog open={Boolean(revoking)} onClose={() => setRevoking(null)} title="撤销这个调用方？" description="现有凭据会立即失效，相关自动化任务将无法继续取码。"><div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button className="btn-secondary" onClick={() => setRevoking(null)}>取消</button><button className="btn-danger" onClick={revoke}>确认撤销</button></div></Dialog></section>
}
