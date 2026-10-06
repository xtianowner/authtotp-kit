#!/usr/bin/env node
// verify-render — 真渲染机检（交付检查清单的机检部分，零依赖，Node ≥ 21）。
// 对每个 URL × 视口(桌面 1280 / 移动 375) × 主题(dark / light)：截图 + 横向溢出断言。
// 截图仍须人工复核视觉层级（build ≠ 渲染，断言 ≠ 肉眼）；本工具只把可机检项变成硬门禁。
//
// 用法：npm run verify [-- <url> ...]      默认 http://localhost:5173（先起 dev server）
// 环境：CDP_PORT=9333 复用已在跑的 Chrome CDP 实例；CHROME_PATH 指定浏览器二进制。
// 产出：./verify-shots/<page>-<viewport>-<theme>.png；任一断言失败以非零码退出。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URLS = process.argv.slice(2).length ? process.argv.slice(2) : ['http://localhost:5173']
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'laptop', width: 1024, height: 900 },
  { name: 'desktop', width: 1440, height: 1000 },
]
const THEMES = ['dark'] // 全站只做暗色（视觉基线 v1.4 §14），不再切换主题
const OUT_DIR = 'verify-shots'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

async function findChrome() {
  const { access } = await import('node:fs/promises')
  for (const p of CHROME_CANDIDATES) {
    try { await access(p); return p } catch { /* next */ }
  }
  return null
}

async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function launchChrome() {
  if (process.env.CDP_PORT) {
    const port = Number(process.env.CDP_PORT)
    if (await waitForCdp(port, 2000)) return { port, proc: null, profile: null }
    console.error(`✗ CDP_PORT=${port} 无响应`)
    process.exit(2)
  }
  const chrome = await findChrome()
  if (!chrome) {
    console.error('✗ 未找到浏览器二进制（设 CHROME_PATH），或设 CDP_PORT 复用已在跑的实例。')
    console.error('  无 headless 环境时按认可回落路径：请用户浏览器实看四档响应式 + 双主题。')
    process.exit(2)
  }
  const port = 9200 + Math.floor(Math.random() * 500)
  const profile = join(tmpdir(), `verify-render-${port}`)
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--enable-unsafe-swiftshader',
  ], { stdio: 'ignore' })
  if (!(await waitForCdp(port))) {
    proc.kill('SIGKILL')
    console.error('✗ Chrome CDP 启动超时')
    process.exit(2)
  }
  return { port, proc, profile }
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
  }
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const open = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  return { ws, send, open }
}

const failures = []
async function verifyPage(port, url) {
  const page = new URL(url).pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'index'
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const { ws, send, open } = cdpSession(created.webSocketDebuggerUrl)
  await open
  await send('Page.enable')
  await new Promise((r) => setTimeout(r, 2500)) // 首载 + 字体 + 动效入场

  // 防呆：打印页面标题——默认端口可能被别的 dev server 占用（Vite 会静默换端口），
  // 不核对标题就会把别人的应用验成"全绿"。
  const titleRes = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
  console.log(`· ${url} → 页面标题「${titleRes.result?.result?.value ?? '(无)'}」——先核对这是不是要验的应用`)

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.name === 'mobile' })
    for (const theme of THEMES) {
      await new Promise((r) => setTimeout(r, 500))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const file = join(OUT_DIR, `${page}-${vp.name}-${theme}.png`)
      if (shot.result?.data) writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      else failures.push(`${file}: 截图失败 ${JSON.stringify(shot.error || {})}`)
      const ov = await send('Runtime.evaluate', {
        expression: 'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        returnByValue: true,
      })
      const overflowPx = ov.result?.result?.value ?? 0
      const ok = overflowPx <= 0
      if (!ok) failures.push(`${url} [${vp.name}/${theme}]: 横向溢出 ${overflowPx}px`)
      console.log(`${ok ? '✓' : '✗'} ${page} ${vp.name}/${theme} → ${file}${ok ? '' : `（溢出 ${overflowPx}px)`}`)
    }
  }
  ws.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`)
}

mkdirSync(OUT_DIR, { recursive: true })
const { port, proc, profile } = await launchChrome()
try {
  for (const url of URLS) await verifyPage(port, url)
} finally {
  if (proc) { proc.kill('SIGKILL'); if (profile) rmSync(profile, { recursive: true, force: true }) }
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项未过：\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`\n✓ 机检全过。截图在 ./${OUT_DIR}/ —— 仍须人工复核视觉层级（断言 ≠ 肉眼）。`)
