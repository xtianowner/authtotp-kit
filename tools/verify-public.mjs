#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = (process.argv[2] || 'http://127.0.0.1:18473').replace(/\/+$/, '')
const TEST_SECRET = 'JBSWY3DPEHPK3PXP'
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate)
      return candidate
    } catch { /* try next */ }
  }
  throw new Error('未找到 Chrome/Chromium；可用 CHROME_PATH 指定浏览器。')
}

async function waitForCdp(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch { /* browser is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Chrome CDP 启动超时。')
}

function createSession(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const pending = new Map()
  const listeners = new Map()
  let sequence = 0

  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`))
      else resolve(message.result)
      return
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params)
  }

  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error('无法连接 Chrome CDP。'))
    }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) || []), listener])
    },
  }
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

async function waitFor(session, expression, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(session, expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}超时。`)
}

const chrome = await findChrome()
const port = 9_400 + Math.floor(Math.random() * 400)
const profile = join(tmpdir(), `verify-public-${port}`)
const chromeProcess = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
], { stdio: 'ignore' })

let pageId
try {
  await waitForCdp(port)
  const created = await (await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${BASE_URL}/`)}`,
    { method: 'PUT' },
  )).json()
  pageId = created.id
  const session = createSession(created.webSocketDebuggerUrl)
  await session.ready

  const requests = []
  session.on('Network.requestWillBeSent', ({ request }) => {
    requests.push({ url: request.url, method: request.method, body: request.postData || '' })
  })
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Network.enable')
  await session.send('Page.navigate', { url: `${BASE_URL}/` })
  await waitFor(session, 'Boolean(document.querySelector("#public-main form"))', '公开页载入')

  await evaluate(session, `(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__verifyPublicCopied = String(value) } },
    })
    const input = document.querySelector('#public-main input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(TEST_SECRET)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await evaluate(session, `document.querySelector('#public-main form button[type="submit"]').click()`)
  await waitFor(session, '/^\\d{6}$/.test(document.querySelector(".public-code-value")?.textContent || "")', '生成 6 位验证码')
  const generatedCode = await evaluate(session, 'document.querySelector(".public-code-value").textContent')
  console.log(`✓ 生成：${generatedCode.length} 位数字验证码`)

  await evaluate(session, `document.querySelector('button[aria-label="复制验证码"]').click()`)
  await waitFor(session, 'Boolean(window.__verifyPublicCopied)', '复制验证码')
  const copiedCode = await evaluate(session, 'window.__verifyPublicCopied')
  invariant(copiedCode === generatedCode, '复制内容与显示验证码不一致。')
  console.log('✓ 复制：剪贴板测试替身与显示值一致')

  const exposure = await evaluate(session, `(() => {
    const values = (storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)) || '')
    return {
      location: location.href,
      local: values(localStorage),
      session: values(sessionStorage),
    }
  })()`)
  invariant(!exposure.location.includes(TEST_SECRET), '测试密钥出现在页面 URL。')
  invariant(![...exposure.local, ...exposure.session].some((value) => value.includes(TEST_SECRET)), '测试密钥出现在浏览器存储。')
  console.log(`✓ 隔离：URL、localStorage、sessionStorage 均无测试密钥`)

  await evaluate(session, `Array.from(document.querySelectorAll('#public-main button')).find((button) => button.textContent.includes('清空全部')).click()`)
  await waitFor(session, `document.querySelector('#public-main input').value === '' && !document.querySelector('.public-code-value')`, '清空敏感内容')
  console.log('✓ 清空：输入与验证码均已移除')

  await evaluate(session, `(() => {
    const input = document.querySelector('#public-main input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(TEST_SECRET)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await evaluate(session, `document.querySelector('#public-main form button[type="submit"]').click()`)
  await waitFor(session, 'Boolean(document.querySelector(".public-code-value"))', '刷新前生成验证码')
  await session.send('Page.reload', { ignoreCache: true })
  await waitFor(session, `Boolean(document.querySelector('#public-main form')) && document.querySelector('#public-main input').value === ''`, '刷新后公开页恢复')
  invariant(!(await evaluate(session, 'Boolean(document.querySelector(".public-code-value"))')), '刷新后恢复了验证码。')
  console.log('✓ 刷新：密钥与验证码均未恢复')

  await new Promise((resolve) => setTimeout(resolve, 300))
  const apiRequests = requests.filter(({ url }) => new URL(url).pathname.startsWith('/api'))
  const secretRequests = requests.filter(({ url, body }) => url.includes(TEST_SECRET) || body.includes(TEST_SECRET))
  invariant(apiRequests.length === 0, `公开页发出了 /api 请求：${apiRequests.map(({ url }) => url).join(', ')}`)
  invariant(secretRequests.length === 0, '测试密钥出现在网络请求 URL 或 body。')
  console.log(`✓ 网络：共观察 ${requests.length} 个请求，/api=0，含测试密钥=0`)
  console.log(`✓ 公开页核验通过：${BASE_URL}/`)

  session.socket.close()
} catch (error) {
  console.error(`✗ 公开页核验失败：${error.message}`)
  process.exitCode = 1
} finally {
  if (pageId) {
    try { await fetch(`http://127.0.0.1:${port}/json/close/${pageId}`) } catch { /* browser may already be closing */ }
  }
  chromeProcess.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 250))
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* temporary profile cleanup is best effort */ }
}
