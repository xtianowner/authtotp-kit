import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { startLoop } from '../../showcase/motion.js'

// 查看验证码 = 单卡 demo D 的展示 ①「精修翻牌 + 彗星环读条」，从 src/lab/vault-cards/d/codes.jsx 与
// src/lab/vault-cards/shared/clock.js 复制而来（产品代码不 import src/lab）。样式：src/styles/vault-motion.css（.vm-flip）。
// - 翻牌：没有方框，只留一条细中缝；3+3 分组（7/8 位按前多后少分）。新码到达时，上半片落下途中闪过乱码，下半片落定定格；
//   第 i 位在 i × lockStep 毫秒起翻，最后一位 24ms 起翻，整串在码到达后约 0.1 秒内可读。
// - 读条：左侧细环按服务器时钟走完当前窗口，彗星头随进度绕圈；最后 5 秒环、头、秒数转琥珀色（--warning）。
// - 换码：`live.prev` 是被换下的旧码，翻牌从旧码翻到新码；首次显示从占位点翻起。
// - 「减少动态效果」或页面隐藏时不翻牌、不绕圈，直接写数字；读条每秒 4 次跳格，不连续滑动。
// 每帧直接写 DOM（rAF，页面隐藏或滚出视口时暂停），不触发 React 渲染。

export const WARN_SECONDS = 5
const PLACEHOLDER = '·'
const FALL_MS = 45
const LAND_MS = 120
const RING_R = 28
const RING_C = 2 * Math.PI * RING_R
const DIGITS = '0123456789'
const randomDigit = () => DIGITS[(Math.random() * 10) | 0]
const split = (n) => Math.ceil(n / 2)
// Cell i starts flipping at i × step ms; the last one by 24 ms.
const lockStep = (n) => (n > 1 ? Math.min(5, 24 / (n - 1)) : 0)

/**
 * WAAPI handles owned by one digit display. Cancelling through the handles avoids Element.getAnimations() (it
 * flushes style per call). add() pins the start time to the current timeline time, so a late compositor start
 * catches up instead of shifting the whole flip.
 */
function useAnimationBag() {
  const bag = useRef([])
  return useMemo(() => ({
    add(animation) {
      const now = document.timeline.currentTime
      if (now != null) animation.startTime = now
      bag.current.push(animation)
      return animation
    },
    cancel() { bag.current.forEach((animation) => animation.cancel()); bag.current = [] },
  }), [])
}

/** Calls onFrame() every frame while `active` (paused while hidden / off screen); 4×/s under reduced motion. */
function useFrameLoop(active, onFrame, { targetRef, reduced }) {
  const frame = useRef(onFrame)
  frame.current = onFrame
  useEffect(() => {
    if (!active) return undefined
    const run = () => frame.current()
    run()
    if (reduced) {
      const id = window.setInterval(run, 250)
      return () => window.clearInterval(id)
    }
    return startLoop(run, { target: targetRef?.current })
  }, [active, reduced, targetRef])
}

/** Where the shown code's window stands on the server clock: elapsed fraction, whole seconds left (period → 1), warn. */
function windowState(live, period) {
  const left = Math.max(0, live.until - (Date.now() + live.offset)) / 1000
  const remaining = Math.max(1, Math.ceil(left))
  return { progress: Math.min(1, Math.max(0, 1 - left / period)), remaining, warn: remaining <= WARN_SECONDS }
}

function FlipDigits({ code, prev, n, reduced }) {
  const tiles = useRef([])
  const anims = useAnimationBag()
  useLayoutEffect(() => {
    const nodes = tiles.current.slice(0, n)
    const parts = (tile) => ({ up: tile.children[0].firstChild, dn: tile.children[1].firstChild, fu: tile.children[2], fd: tile.children[3] })
    const show = (text, state) => nodes.forEach((tile, i) => {
      const p = parts(tile)
      p.up.textContent = text[i] ?? text
      p.dn.textContent = text[i] ?? text
      p.fu.dataset.on = '0'
      p.fd.dataset.on = '0'
      tile.dataset.state = state
    })
    anims.cancel()
    if (!code) { show(PLACEHOLDER, 'idle'); return undefined }
    if (reduced || document.hidden) { show(code, 'locked'); return undefined }
    const step = lockStep(n)
    const start = performance.now()
    nodes.forEach((tile, i) => {
      const p = parts(tile)
      const from = prev ? prev[i] : PLACEHOLDER
      p.fu.firstChild.textContent = from
      p.fd.firstChild.textContent = code[i]
      p.up.textContent = code[i]
      p.dn.textContent = from
      p.fu.dataset.on = '1'
      p.fd.dataset.on = '1'
      tile.dataset.state = 'decoding'
      const delay = i * step
      anims.add(p.fu.animate([{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(-90deg)' }], { duration: FALL_MS, delay, easing: 'cubic-bezier(0.55, 0, 0.85, 0.35)', fill: 'both' }))
      const land = anims.add(p.fd.animate(
        [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(-7deg)', offset: 0.55 }, { transform: 'rotateX(0deg)' }],
        { duration: LAND_MS, delay: delay + FALL_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
      ))
      land.onfinish = () => {
        p.dn.textContent = code[i]
        p.fu.dataset.on = '0'
        p.fd.dataset.on = '0'
        tile.dataset.state = 'locked'
      }
    })
    // Decode: the falling upper flap flickers through scrambled digits until it has fallen.
    let frame = window.requestAnimationFrame(function tick() {
      const elapsed = performance.now() - start
      let pending = false
      nodes.forEach((tile, i) => {
        if (elapsed < i * step + FALL_MS) { pending = true; parts(tile).fu.firstChild.textContent = randomDigit() }
      })
      if (pending) frame = window.requestAnimationFrame(tick)
    })
    return () => { window.cancelAnimationFrame(frame); anims.cancel(); show(code, 'locked') }
  }, [code, prev, n, reduced, anims])

  return (
    <span className="vm-tiles" style={{ '--n': n }} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        // Written imperatively (no React children), so re-renders never overwrite a running flip.
        <span key={i} ref={(node) => { tiles.current[i] = node }} className={`vm-tile${i === split(n) ? ' vm-split' : ''}`} data-state="idle">
          <span className="vm-half vm-up"><b /></span>
          <span className="vm-half vm-dn"><b /></span>
          <span className="vm-half vm-up vm-flap" data-on="0"><b /></span>
          <span className="vm-half vm-dn vm-flap" data-on="0"><b /></span>
        </span>
      ))}
    </span>
  )
}

/**
 * live: { code, prev, until, offset } from useRollingCode (until = window end, ms on the server clock;
 * offset = server − local clock), or null while hidden. Clicking the digits copies (mouse shortcut).
 */
export default function FlipCode({ digits, period, live, reduced, onCopy }) {
  const rootRef = useRef(null)
  const arcRef = useRef(null)
  const cometRef = useRef(null)
  const secRef = useRef(null)
  useFrameLoop(Boolean(live), () => {
    if (!live) return
    const { progress, remaining, warn } = windowState(live, period)
    const p = reduced ? (period - remaining) / period : progress
    if (arcRef.current) {
      arcRef.current.style.strokeDasharray = `${((1 - p) * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`
      arcRef.current.style.strokeDashoffset = (-p * RING_C).toFixed(2)
    }
    if (cometRef.current) cometRef.current.style.transform = `rotate(${(p * 360).toFixed(2)}deg)`
    if (secRef.current && secRef.current.textContent !== String(remaining)) secRef.current.textContent = String(remaining)
    const flag = warn ? '1' : '0'
    if (rootRef.current && rootRef.current.dataset.warn !== flag) rootRef.current.dataset.warn = flag
  }, { targetRef: rootRef, reduced })
  useLayoutEffect(() => {
    if (live || !rootRef.current) return
    rootRef.current.dataset.warn = '0'
    if (secRef.current) secRef.current.textContent = '--'
  }, [live])
  return (
    <div ref={rootRef} className={`vm-flip${live ? ' is-live' : ''}`} data-warn="0">
      <div className="vm-ring" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <circle className="vm-ring-track" cx="32" cy="32" r={RING_R} />
          {live && <circle className="vm-ring-arc" ref={arcRef} cx="32" cy="32" r={RING_R} transform="rotate(-90 32 32)" />}
        </svg>
        {live && !reduced && <span className="vm-comet" ref={cometRef}><i className="vm-tail" /><i className="vm-head" /></span>}
        <span className="vm-ring-sec" ref={secRef}>--</span>
      </div>
      <button type="button" className="vm-flip-hit" onClick={onCopy} tabIndex={-1} aria-hidden="true" disabled={!live}>
        <FlipDigits code={live?.code} prev={live?.prev} n={digits} reduced={reduced} />
      </button>
      <span className="sr-only" data-testid="vault-code">{live?.code ?? ''}</span>
    </div>
  )
}
