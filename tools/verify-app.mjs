#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const baseUrl = process.argv[2] || 'http://127.0.0.1:18474'
const qrFixture = process.argv[3] || ''
const qrExpectation = process.argv[4] || 'valid'
const outDir = 'verify-shots'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = join(tmpdir(), `authtotp-verify-${process.pid}-${Math.random().toString(36).slice(2)}`)
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars'], { stdio: 'ignore', detached: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitUntil(check, timeoutMs = 1600) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}
async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/, 1)[0])
      if (Number.isInteger(port) && (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) return port
    } catch { /* retry */ }
    await sleep(250)
  }
  throw new Error('Chrome CDP 启动超时')
}
function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject, timer } = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(timer)
    if (message.error) reject(new Error(`CDP ${message.error.message}`))
    else resolve(message)
  }
  ws.onclose = () => rejectPending(new Error('Chrome CDP 连接已关闭'))
  ws.onerror = () => rejectPending(new Error('Chrome CDP 连接异常'))
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const current = ++id
    const timer = setTimeout(() => {
      pending.delete(current)
      reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(current, { resolve, reject, timer })
    if (ws.readyState !== WebSocket.OPEN) {
      clearTimeout(timer)
      pending.delete(current)
      reject(new Error(`CDP ${method} 发送失败：连接未打开`))
      return
    }
    try { ws.send(JSON.stringify({ id: current, method, params })) }
    catch (error) {
      clearTimeout(timer)
      pending.delete(current)
      reject(error)
    }
  })
  return { ws, open, send }
}
async function evaluate(send, expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text)
  return result.result?.result?.value
}

mkdirSync(outDir, { recursive: true })
let ws
let send

// 全站只做暗色：原来的「双主题」步骤改为「始终暗色」断言（系统偏好被模拟为浅色，旧 localStorage theme=light 也写进去）。
const assertDark = async (where) => {
  const state = await evaluate(send, `(() => ({ body: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, theme: document.documentElement.dataset.theme || null, prefersLight: matchMedia('(prefers-color-scheme: light)').matches, themeColor: document.querySelector('meta[name=theme-color]')?.content }))()`)
  if (state.body !== 'rgb(13, 17, 23)' || state.scheme !== 'dark' || state.theme !== null || state.themeColor !== '#0D1117' || !state.prefersLight) throw new Error(`${where} 不是始终暗色：${JSON.stringify(state)}`)
}

try {
  const port = await waitForCdp()
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(baseUrl)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) })).json()
  const connection = session(target.webSocketDebuggerUrl)
  ws = connection.ws
  send = connection.send
  await Promise.race([
    connection.open,
    sleep(5000).then(() => { throw new Error('Chrome CDP WebSocket 连接超时') }),
  ])
  await send('Page.enable')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('theme', 'light') } catch (e) {}" }) // 旧版浅色选择残留
  await sleep(800)
  const seedResult = await evaluate(send, `(async () => {
    const json = (path, options={}) => fetch(path, {credentials:'same-origin', ...options, headers:{'Content-Type':'application/json', ...(options.headers||{})}}).then(async r => ({ok:r.ok, status:r.status, data:await r.json()}));
    let status = await json('/api/auth/status');
    if (!status.data.bootstrapped) await json('/api/auth/bootstrap', {method:'POST', body:JSON.stringify({password:'render test password 12345'})});
    else if (!status.data.authenticated) await json('/api/auth/login', {method:'POST', body:JSON.stringify({password:'render test password 12345'})});
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )authtotp_csrf=([^;]+)/)||[])[1]||'');
    const headers = {'X-CSRF-Token':csrf};
    let entries = await json('/api/entries');
    if (!entries.data.length) {
      await json('/api/entries', {method:'POST', headers, body:JSON.stringify({otpauth_uri:'otpauth://totp/GitHub%3Ademo-render?secret=MFRGGZDFMZTWQ2LK&issuer=GitHub', purpose:'automation'})});
      await json('/api/entries', {method:'POST', headers, body:JSON.stringify({secret:'KRUGS4ZANFZSAYJA', label:'这是一个超过十二个中文字符的云平台管理员账号', issuer:'Cloud Console', account_ref:'admin-render@example.test', purpose:'admin'})});
      entries = await json('/api/entries');
    }
    const callers = await json('/api/callers');
    if (!callers.data.some(caller => caller.status === 'active')) await json('/api/callers', {method:'POST', headers, body:JSON.stringify({name:'Playwright-like render task', purpose:'验证最小权限显示与长名称换行', allowed_entry_ids:[entries.data[0].id]})});
    return {entries:entries.data.length};
  })()`, true)
  if (!seedResult?.entries) throw new Error('测试数据创建失败')
  await send('Page.navigate', { url: `${baseUrl}/vault?view=entries` })
  await sleep(1200)

  const title = await evaluate(send, 'document.title')
  if (!title.includes('AuthTOTP')) throw new Error(`错误页面标题：${title}`)
  const clickText = async (text) => evaluate(send, `(() => { const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!e)return false; e.click(); return true })()`)
  if (!(await clickText('导入验证码'))) throw new Error('找不到导入验证码按钮')
  await sleep(300)
  if (!(await evaluate(send, "Boolean(document.querySelector('[role=dialog]'))"))) throw new Error('导入弹窗未打开')
  if (qrFixture) {
    await send('DOM.enable')
    const documentNode = await send('DOM.getDocument')
    const fileInput = await send('DOM.querySelector', { nodeId: documentNode.result.root.nodeId, selector: 'input[type=file]' })
    if (!fileInput.result.nodeId) throw new Error('找不到二维码文件输入框')
    await send('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [qrFixture] })
    await evaluate(send, "window.__qrFixtureFile=document.querySelector('input[type=file]').files[0]")
    const expectedText = qrExpectation === 'empty-secret' ? 'TOTP 密钥为空' : '已读取标准 TOTP 二维码'
    const qrRead = await waitUntil(async () => await evaluate(send, `document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(expectedText)})`), 4000)
    if (!qrRead) {
      const errorText = await evaluate(send, "document.querySelector('[role=dialog] [role=alert]')?.textContent || '未返回错误信息'")
      throw new Error(`真实二维码文件路径未得到预期结果：${errorText}`)
    }
    await evaluate(send, "document.querySelector('[role=dialog] button[aria-label=\"关闭弹窗\"]')?.click()")
    // 已读到二维码 = 有未保存输入：× 先出「关闭前确认」，再点「放弃并关闭」
    if (!(await waitUntil(async () => await evaluate(send, "[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('放弃并关闭'))")))) throw new Error('× 未出现关闭前确认')
    await evaluate(send, "[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('放弃并关闭')).click()")
    if (!(await waitUntil(async () => !(await evaluate(send, "Boolean(document.querySelector('[role=dialog]'))"))))) throw new Error('文件检查后弹窗未关闭')
    if (!(await clickText('导入验证码'))) throw new Error('无法重新打开导入弹窗')
    await sleep(300)
    await evaluate(send, `(() => {
      const transfer = new DataTransfer();
      transfer.items.add(window.__qrFixtureFile);
      window.dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer, bubbles:true, cancelable:true}));
    })()`)
    const pasted = await waitUntil(async () => await evaluate(send, `document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(expectedText)})`), 4000)
    if (!pasted) {
      const errorText = await evaluate(send, "document.querySelector('[role=dialog] [role=alert]')?.textContent || '未返回错误信息'")
      throw new Error(`剪贴板二维码路径未得到预期结果：${errorText}`)
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
    await assertDark('导入弹窗 375') // 原为切到浅色截图
    const importScreenshot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `import-qr-${qrExpectation}-375-dark.png`), Buffer.from(importScreenshot.result.data, 'base64'))
  }
  await evaluate(send, "window.__lastVerifyKey=''; document.addEventListener('keydown', event => { window.__lastVerifyKey=event.key }, {once:true})")
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  // 有未保存输入时 Esc 先出「关闭前确认」：确认出现后点「放弃并关闭」（无输入时 Esc 直接关闭，这一步跳过）
  if (await waitUntil(async () => await evaluate(send, "[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('放弃并关闭'))"), 800)) {
    await evaluate(send, "[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('放弃并关闭')).click()")
  }
  const escaped = await waitUntil(async () => !(await evaluate(send, "Boolean(document.querySelector('[role=dialog]'))")))
  if (!escaped) {
    const debug = await evaluate(send, "({key:window.__lastVerifyKey,title:document.querySelector('[role=dialog] h2')?.textContent,overflow:document.body.style.overflow,active:document.activeElement?.outerHTML?.slice(0,180)})")
    await evaluate(send, "document.querySelector('[role=dialog] button[aria-label=\"关闭弹窗\"]')?.click()")
    await sleep(350)
    const clickClosed = !(await evaluate(send, "Boolean(document.querySelector('[role=dialog]'))"))
    throw new Error(`Esc 未关闭弹窗：${JSON.stringify({...debug, clickClosed})}`)
  }
  if (!(await clickText('查看验证码'))) throw new Error('找不到查看验证码按钮')
  // 卡面 2 没有 .code-panel：以条目卡里读屏用的验证码文本非空为「真实渲染出验证码」
  const codeVisible = await waitUntil(async () => await evaluate(send, "/^[0-9]{6,8}$/.test(document.querySelector('[data-testid=vault-code]')?.textContent || '')"), 2500)
  if (!codeVisible) {
    const debug = await evaluate(send, "({button:[...document.querySelectorAll('button')].find(x=>x.textContent.includes('查看验证码'))?.textContent,alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent)})")
    throw new Error(`验证码未真实渲染：${JSON.stringify(debug)}`)
  }

  await send('Page.navigate', { url: `${baseUrl}/vault?view=callers` })
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
  await sleep(700)
  if (!(await clickText('创建调用方'))) throw new Error('找不到创建调用方按钮')
  await sleep(300)
  const setCallerEntrySearch = async (value) => evaluate(send, `(() => {
    const input=[...document.querySelectorAll('[role=dialog] input')].find(item=>item.placeholder.includes('搜索条目'));
    if(!input)return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`)
  if (!(await setCallerEntrySearch('CLOUD'))) throw new Error('找不到调用方条目搜索框')
  await sleep(120)
  const platformSearch = await evaluate(send, `(() => {
    const dialog=document.querySelector('[role=dialog]');
    return {
      hasCloud:dialog.innerText.includes('这是一个超过十二个中文字符的云平台管理员账号'),
      hasGithub:dialog.innerText.includes('GitHub:demo-render'),
      summary:[...dialog.querySelectorAll('[role=status]')].map(item=>item.textContent).join(' '),
    };
  })()`)
  if (!platformSearch.hasCloud || platformSearch.hasGithub || !platformSearch.summary.includes('显示 1 / 2')) throw new Error(`平台搜索结果不正确：${JSON.stringify(platformSearch)}`)
  await evaluate(send, `(() => { const input=document.querySelector('[role=dialog] input[type=checkbox]'); input.click(); return input.checked })()`)
  if (!(await setCallerEntrySearch('GitHub'))) throw new Error('调用方条目搜索框失效')
  await sleep(120)
  const selectionPreserved = await evaluate(send, `(() => {
    const dialog=document.querySelector('[role=dialog]');
    return dialog.innerText.includes('GitHub:demo-render') && dialog.querySelector('[role=status]')?.textContent.includes('已选 1');
  })()`)
  if (!selectionPreserved) throw new Error('切换搜索词后已选权限没有保留')
  if (!(await setCallerEntrySearch('不存在的账号'))) throw new Error('无法输入无结果搜索词')
  await sleep(120)
  if (!(await evaluate(send, `document.querySelector('[role=dialog]')?.innerText.includes('没有匹配的条目')`))) throw new Error('搜索无结果时未显示空态')
  if (!(await setCallerEntrySearch('GitHub'))) throw new Error('无法恢复有结果的搜索词')
  await sleep(120)
  await evaluate(send, `document.querySelector('[role=dialog] input[type=search]')?.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  if (!(await evaluate(send, `document.activeElement?.getAttribute('aria-label') === '清除搜索'`))) throw new Error('键盘 Tab 无法聚焦清除搜索按钮')
  await evaluate(send, `document.activeElement?.click()`)
  await sleep(120)
  const clearedSearch = await evaluate(send, `(() => {
    const dialog=document.querySelector('[role=dialog]');
    return {
      value:dialog.querySelector('input[type=search]')?.value,
      summary:dialog.querySelector('[role=status]')?.textContent,
      overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    };
  })()`)
  if (clearedSearch.value || !clearedSearch.summary.includes('显示 2 / 2') || clearedSearch.overflow > 0) throw new Error(`清除搜索或移动端布局不正确：${JSON.stringify(clearedSearch)}`)
  for (const theme of ['dark']) { // 只剩暗色：断言始终暗色
    await assertDark('调用方条目搜索 375')
    await sleep(120)
    const callerSearchShot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `caller-entry-search-375-${theme}.png`), Buffer.from(callerSearchShot.result.data, 'base64'))
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  for (const theme of ['dark']) { // 只剩暗色：断言始终暗色
    await assertDark('调用方条目搜索 1440')
    await sleep(120)
    const overflow = await evaluate(send, 'document.documentElement.scrollWidth-document.documentElement.clientWidth')
    if (overflow > 0) throw new Error(`调用方条目搜索 1440/${theme} 横向溢出 ${overflow}px`)
    const callerSearchShot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `caller-entry-search-1440-${theme}.png`), Buffer.from(callerSearchShot.result.data, 'base64'))
  }
  await evaluate(send, `document.querySelector('[role=dialog] button[aria-label="关闭弹窗"]')?.click()`)
  // 已勾选条目 = 有未保存输入：× 先出「关闭前确认」，点「放弃并关闭」（否则离开页面会被 beforeunload 拦住）
  if (!(await waitUntil(async () => await evaluate(send, "[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('放弃并关闭'))")))) throw new Error('调用方弹窗 × 未出现关闭前确认')
  await evaluate(send, "[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('放弃并关闭')).click()")
  if (!(await waitUntil(async () => !(await evaluate(send, "Boolean(document.querySelector('[role=dialog]'))"))))) throw new Error('调用方弹窗未关闭')
  await sleep(250)

  const cases = [
    ['entries', 375, 812], ['entries', 768, 900], ['entries', 1024, 900], ['entries', 1440, 1000],
    ['callers', 375, 812], ['callers', 1440, 1000], ['audit', 375, 812], ['audit', 1440, 1000],
  ]
  for (const [view, width, height] of cases) {
    await send('Page.navigate', { url: `${baseUrl}/vault?view=${view}` })
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await sleep(700)
    for (const theme of ['dark']) { // 只剩暗色：断言始终暗色
      await assertDark(`${view} ${width}`)
      await sleep(180)
      const overflow = await evaluate(send, 'document.documentElement.scrollWidth-document.documentElement.clientWidth')
      if (overflow > 0) throw new Error(`${view} ${width}/${theme} 横向溢出 ${overflow}px`)
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      const file = join(outDir, `app-${view}-${width}-${theme}.png`)
      writeFileSync(file, Buffer.from(screenshot.result.data, 'base64'))
      console.log(`✓ ${view} ${width}px ${theme} → ${file}`)
    }
  }
  console.log(`✓ 导入弹窗（含关闭前确认）、Esc、动态码、三页面、四档响应式和始终暗色全部通过${qrFixture ? `；真实二维码文件与剪贴板路径均得到预期结果（${qrExpectation}）` : ''}`)
} finally {
  try { ws?.close() } catch { /* already closed */ }
  try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') }
  await sleep(700)
  rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
}
