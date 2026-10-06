import { useRef } from 'react'
import { Activity, Bot, ShieldAlert, ShieldCheck } from 'lucide-react'
import { motion } from 'motion/react'
import { EASE } from '../lib/motion.js'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// Row entrance: rows fade in (opacity only, never moved). The rows the list first shows with are staggered
// (15 ms apart, last start capped at 0.2 s); rows that arrive later, e.g. after new code reads, fade in at once.
const rowFade = (delay) => ({ duration: 0.45, ease: EASE, delay })

const actionNames = { 'admin.bootstrap': '初始化控制台', 'admin.login': '解锁控制台', 'admin.logout': '锁定控制台', 'entry.create': '导入验证码', 'entry.update': '更新条目', 'entry.delete': '删除条目', 'code.read': '读取验证码', 'caller.create': '创建调用方', 'caller.update': '更新调用方', 'caller.revoke': '撤销调用方' }

// Localized label when messages.js has one; otherwise the legacy table, then the raw value.
function lookup(t, key, fallback) {
  const text = t(key)
  return text === key ? fallback : text
}

function EventAction({ event, t }) {
  const name = lookup(t, `audit.action.${event.action}`, actionNames[event.action] || event.action)
  const reason = event.reason ? lookup(t, `audit.reason.${event.reason}`, null) : null
  // Right password + wrong second factor: the password itself may have leaked.
  const alarm = ['admin.login', 'admin.password.change'].includes(event.action) && event.reason === 'invalid_second_factor'
  return (
    <div className="min-w-0">
      <span className="text-text">{name}</span>
      {alarm ? (
        <span className="mt-2 flex items-start gap-2 rounded-field border border-warning/50 bg-elev px-3 py-2 text-xs leading-relaxed">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <span><strong className="block font-semibold text-heading">{reason}</strong><span className="text-muted">{t('audit.reason.invalid_second_factorHint')}</span></span>
        </span>
      ) : reason && <span className="mt-1 block text-xs text-muted">{reason}</span>}
      {event.entry_id && <code className="mt-1 block break-all font-mono text-xs text-muted">{event.entry_id}</code>}
    </div>
  )
}

export default function AuditView({ events, loading }) {
  const { t, locale } = useLocale()
  const formatter = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'medium' })
  const firstBatch = useRef(null)
  if (!firstBatch.current && !loading && events.length) firstBatch.current = new Set(events.map((event) => event.id))
  const rowDelay = (id, index) => (firstBatch.current?.has(id) ? Math.min(index * 0.015, 0.2) : 0)
  return <section aria-labelledby="audit-heading"><div className="page-heading"><div><span className="vh-tag" aria-hidden="true">[03/03]<span>AUDIT</span></span><h1 id="audit-heading">{t('audit.title')}</h1><p>{t('audit.subtitle')}</p></div></div>{loading ? <div className="vf h-64 animate-pulse" /> : events.length ? <div className="vf overflow-hidden"><div className="vf-well hidden grid-cols-[minmax(9rem,1.1fr)_minmax(8rem,1fr)_minmax(0,1.4fr)_6.5rem] gap-4 border-b border-border px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted md:grid"><span>时间</span><span>执行者</span><span>动作</span><span>结果</span></div><div className="divide-y divide-border">{events.map((event, index) => <motion.article key={event.id} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: rowFade(rowDelay(event.id, index)) }} className="list-row grid gap-3 px-5 py-4 text-sm md:grid-cols-[minmax(9rem,1.1fr)_minmax(8rem,1fr)_minmax(0,1.4fr)_6.5rem] md:items-center md:gap-4"><time className="text-muted" dateTime={event.occurred_at}>{formatter.format(new Date(event.occurred_at))}</time><span className="flex min-w-0 items-center gap-2 break-all text-text">{event.actor_type === 'caller' ? <Bot size={16} className="text-accent" /> : <ShieldCheck size={16} className="text-accent" />}{event.actor_id || '未知调用方'}</span><EventAction event={event} t={t} /><span className={`status-dot w-fit ${event.result === 'success' ? 'status-active' : 'status-disabled'}`}>{event.result === 'success' ? '成功' : '拒绝'}</span></motion.article>)}</div></div> : <div className="empty-state vf"><Activity size={32} /><h2>{t('audit.empty')}</h2><p>完成首次导入或取码后，这里会出现脱敏事件。</p></div>}</section>
}

