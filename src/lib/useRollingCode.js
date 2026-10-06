import { useCallback, useEffect, useRef, useState } from 'react'
import { post } from './api.js'

// 保险库卡片「查看验证码」的取码与到期自动换码（src/components/EntriesView.jsx）。
// - 一次 POST /api/entries/{id}/code 返回当前窗口的码和 `next`（下一个窗口的码，只有所有者接口返回）。
// - 当前码到期的那一刻直接换上 `next`，不收起、不发请求；`next` 也到期时（卡片开着超过一个周期）再请求一次，
//   新响应又带着下一个 `next`。所以卡片一直开着时，每两个窗口一次请求、一条 code.read 审计。
// - 页面隐藏时不发请求：到期时如果手里没有可用的 `next`，就等页面重新可见，那时码已过期才请求一次。
// - 时间都按服务器时钟：`offset` = 服务器时钟 − 本机时钟，本机时钟偏差超过约 1 秒时用 remaining_seconds 估出来，
//   否则为 0（remaining_seconds 只精确到秒）。
// - 只有 reveal() 会开始取码（点击里发起，不放在 effect 里，StrictMode 下不会重复请求）；hide() 和卸载都会停掉计时、
//   丢掉手里的码。
// 返回 { live, loading, reveal, hide }；live = { code, prev, until, offset } 或 null（prev 是被换下的旧码，用于翻牌）。

const REQUEST_DELAY_MS = 150 // asking the server: wait a moment past the boundary so it is surely in the new window

function clockOffset(data, localNow) {
  const until = Date.parse(data.valid_until)
  const remaining = Number(data.remaining_seconds)
  if (!Number.isFinite(until) || !Number.isFinite(remaining)) return 0
  // The server's clock was in [until − remaining s, until − remaining s + 1 s) when it answered.
  const serverFrom = until - remaining * 1000
  if (localNow >= serverFrom - 250 && localNow <= serverFrom + 1250) return 0
  return serverFrom + 500 - localNow
}

const windowOf = (data) => ({ code: data.code, until: Date.parse(data.valid_until) })

export function useRollingCode(entryId, { onRevealed, onError } = {}) {
  const [live, setLive] = useState(null)
  const [loading, setLoading] = useState(false)
  const session = useRef(null)
  const callbacks = useRef({ onRevealed, onError })
  callbacks.current = { onRevealed, onError }

  const stop = useCallback(() => {
    const current = session.current
    if (!current) return
    current.alive = false
    window.clearTimeout(current.timer)
    document.removeEventListener('visibilitychange', current.onVisible)
    session.current = null
  }, [])

  const hide = useCallback(() => {
    stop()
    setLoading(false)
    setLive(null)
  }, [stop])

  const reveal = useCallback(async () => {
    if (session.current) return
    const s = { alive: true, timer: 0, offset: 0, current: null, next: null, inflight: false }
    session.current = s
    const now = () => Date.now() + s.offset
    const publish = (prev) => setLive({ code: s.current.code, prev, until: s.current.until, offset: s.offset })
    const arm = () => {
      window.clearTimeout(s.timer)
      if (!s.alive || !s.current) return
      const wait = Math.max(0, s.current.until - now()) + (s.next ? 1 : REQUEST_DELAY_MS)
      s.timer = window.setTimeout(advance, wait)
    }
    const request = async (shown) => {
      if (s.inflight) return
      s.inflight = true
      try {
        const data = await post(`/api/entries/${entryId}/code`, {})
        if (!s.alive) return
        s.offset = clockOffset(data, Date.now())
        s.current = windowOf(data)
        s.next = data.next ? windowOf(data.next) : null
        if (shown === s.current.code) setLive((cur) => (cur ? { ...cur, until: s.current.until, offset: s.offset } : cur))
        else publish(shown || null)
        if (!shown) callbacks.current.onRevealed?.()
        advance()
      } catch (error) {
        if (!s.alive) return
        // A failed read (first or automatic) closes the code area; 查看验证码 is the retry.
        stop()
        setLive(null)
        setLoading(false)
        callbacks.current.onError?.(error)
      } finally {
        s.inflight = false
        if (!shown && s.alive) setLoading(false)
      }
    }
    // Called at the shown window's end, and when the page becomes visible again.
    function advance() {
      if (!s.alive || !s.current) return
      const t = now()
      if (t < s.current.until) { arm(); return }
      if (s.next && t < s.next.until) {
        const shown = s.current.code
        s.current = s.next
        s.next = null
        publish(shown)
        arm()
        return
      }
      if (document.hidden) return // no request while hidden; onVisible picks it up
      request(s.current.code)
    }
    s.onVisible = () => { if (!document.hidden) advance() }
    document.addEventListener('visibilitychange', s.onVisible)
    setLoading(true)
    await request(null)
  }, [entryId, stop])

  useEffect(() => stop, [stop])
  return { live, loading, reveal, hide }
}
