#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const baseUrl = process.argv[2] || 'http://127.0.0.1:18474'
const qrFixture = process.argv[3] || ''
const qrExpectation = process.argv[4] || 'valid'
const fixtureSeed = 'JBSWY3DPEHPK3PXP'
const outDir = 'verify-shots'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = join(tmpdir(), `authtotp-verify-${process.pid}-${Math.random().toString(36).slice(2)}`)
const proc = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars',
], { stdio: 'ignore', detached: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/, 1)[0])
      if (Number.isInteger(port) && (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) return port
    } catch { /* retry */ }
    await sleep(250)
  }
  throw new Error('Chrome CDP 启动超时')
}

function createSession(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl)
  const pending = new Map()
  let sequence = 0

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
    else resolve(message.result)
  }
  ws.onclose = () => rejectPending(new Error('Chrome CDP 连接已关闭'))
  ws.onerror = () => rejectPending(new Error('Chrome CDP 连接异常'))

  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return {
    ws,
    open,
    send(method, params = {}, timeoutMs = 8_000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        if (ws.readyState !== WebSocket.OPEN) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new Error(`CDP ${method} 发送失败：连接未打开`))
          return
        }
        try { ws.send(JSON.stringify({ id, method, params })) }
        catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
  }
}

async function evaluate(send, expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

async function waitUntil(check, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(75)
  }
  throw new Error(`${label}超时`)
}

mkdirSync(outDir, { recursive: true })
let ws
let send

// 全站只做暗色：原来的「双主题」步骤改为「始终暗色」断言（系统偏好被模拟为浅色，旧 localStorage theme=light 也写进去）。
const assertDark = async (where) => {
  const state = await evaluate(send, `(() => ({ body: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, theme: document.documentElement.dataset.theme || null, prefersLight: matchMedia('(prefers-color-scheme: light)').matches, themeColor: document.querySelector('meta[name=theme-color]')?.content }))()`)
  if (state.body !== 'rgb(13, 17, 23)' || state.scheme !== 'dark' || state.theme !== null || state.themeColor !== '#0D1117' || !state.prefersLight) throw new Error(`${where} 不是始终暗色：${JSON.stringify(state)}`)
}
const clickText = (text) => evaluate(send, `(() => {
  const element=[...document.querySelectorAll('button,a')].find(item=>item.offsetParent!==null && item.textContent.includes(${JSON.stringify(text)}));
  if(!element)return false;
  element.click();
  return true;
})()`)
const dialogHeadingVisible = (heading) => evaluate(send, `
  [...document.querySelectorAll('[role=dialog] h2')].some(item=>item.textContent===${JSON.stringify(heading)})
`)
const pressEscape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
}

try {
  const port = await waitForCdp()
  const target = await (await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${baseUrl}/`)}`,
    { method: 'PUT', signal: AbortSignal.timeout(3000) },
  )).json()
  const connection = createSession(target.webSocketDebuggerUrl)
  ws = connection.ws
  send = connection.send
  await Promise.race([
    connection.open,
    sleep(5000).then(() => { throw new Error('Chrome CDP WebSocket 连接超时') }),
  ])
  await send('Page.enable')
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('theme', 'light') } catch (e) {}" })
  const setup = await evaluate(send, `(async () => {
    const json=(path,options={})=>fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}}).then(async response=>({ok:response.ok,status:response.status,data:await response.json()}));
    const status=await json('/api/auth/status');
    if(!status.data.bootstrapped)await json('/api/auth/bootstrap',{method:'POST',body:JSON.stringify({password:'render test password 12345'})});
    else if(!status.data.authenticated)await json('/api/auth/login',{method:'POST',body:JSON.stringify({password:'render test password 12345'})});
    const csrf=decodeURIComponent((document.cookie.match(/(?:^|; )authtotp_csrf=([^;]+)/)||[])[1]||'');
    const headers={'X-CSRF-Token':csrf};
    const entries=await json('/api/entries');
    if(!entries.data.length)await json('/api/entries',{method:'POST',headers,body:JSON.stringify({otpauth_uri:'otpauth://totp/Existing%3Aentry?secret=MFRGGZDFMZTWQ2LK&issuer=Existing',purpose:'automation'})});
    return true;
  })()`, true)
  if (!setup) throw new Error('隔离测试数据初始化失败')

  await send('Page.navigate', { url: `${baseUrl}/vault?view=entries` })
  await waitUntil(() => evaluate(send, `Boolean(document.querySelector('#entries-heading'))`), '验证码库载入')
  console.log('✓ 一次性密钥专项：隔离数据与验证码库已就绪')
  if (!(await clickText('导入验证码'))) throw new Error('找不到导入验证码按钮')
  await waitUntil(() => dialogHeadingVisible('导入 TOTP 验证码'), '导入弹窗显示')

  if (!qrFixture) throw new Error('专项验证需要二维码 fixture 路径')
  const documentNode = await send('DOM.getDocument')
  const fileInput = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type=file]' })
  if (!fileInput.nodeId) throw new Error('找不到二维码文件输入框')
  await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [qrFixture] })
  const qrExpectedText = qrExpectation === 'empty-secret' ? 'TOTP 密钥为空' : '已读取标准 TOTP 二维码'
  await waitUntil(
    () => evaluate(send, `[...document.querySelectorAll('[role=dialog]')].some(dialog=>dialog.innerText.includes(${JSON.stringify(qrExpectedText)}))`),
    '二维码读取',
  )

  if (qrExpectation !== 'valid') {
    if (await dialogHeadingVisible('保存这份 Base32 密钥')) throw new Error('失败二维码错误地显示一次性密钥')
    console.log(`✓ 二维码失败态不显示一次性密钥（${qrExpectation}）`)
  } else {
    await evaluate(send, `Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copiedOneTimeSeed=String(value)}}})`)
    if (!(await clickText('确认导入'))) throw new Error('找不到确认导入按钮')
    await waitUntil(() => dialogHeadingVisible('保存这份 Base32 密钥'), '新建成功的一次性密钥弹窗', 6_000)
    if (!(await clickText('复制 Base32 密钥'))) throw new Error('找不到一次性密钥复制按钮')
    await waitUntil(() => evaluate(send, `window.__copiedOneTimeSeed===${JSON.stringify(fixtureSeed)}`), '一次性密钥复制')
    await sleep(3_800)

    for (const [width, height] of [[375, 812], [1440, 1000]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 375 })
      for (const theme of ['dark']) { // 只剩暗色：断言始终暗色
        await assertDark(`一次性密钥弹窗 ${width}`)
        await sleep(120)
        const overflow = await evaluate(send, 'document.documentElement.scrollWidth-document.documentElement.clientWidth')
        if (overflow > 0) throw new Error(`一次性密钥弹窗 ${width}/${theme} 横向溢出 ${overflow}px`)
        const screenshot = await send('Page.captureScreenshot', { format: 'png' })
        const file = join(outDir, `one-time-seed-${width}-${theme}.png`)
        writeFileSync(file, Buffer.from(screenshot.data, 'base64'))
        console.log(`✓ 一次性密钥弹窗 ${width}px ${theme} → ${file}`)
      }
    }

    await pressEscape()
    // 一次性密钥弹窗按 Esc 先出「关闭前确认」，点「确定已保存，关闭」
    await waitUntil(() => evaluate(send, `[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('确定已保存'))`), 'Esc 后出现关闭前确认')
    if (!(await clickText('确定已保存'))) throw new Error('找不到「确定已保存，关闭」')
    await waitUntil(
      () => evaluate(send, `!document.body.textContent.includes(${JSON.stringify(fixtureSeed)}) && ![...document.querySelectorAll('[role=dialog] h2')].some(item=>item.textContent==='保存这份 Base32 密钥')`),
      'Esc 清空一次性密钥',
    )
    console.log('✓ QR 新建、复制、Esc → 关闭前确认 → 清空通过')

    const safety = await evaluate(send, `(async()=>{
      const response=await fetch('/api/entries',{credentials:'same-origin'});
      const entries=await response.json();
      const storageValues=storage=>Array.from({length:storage.length},(_,index)=>storage.getItem(storage.key(index))||'');
      const serialized=JSON.stringify(entries);
      return {
        hasSensitiveKey:entries.some(entry=>Object.keys(entry).some(key=>/secret|seed/i.test(key))),
        containsSeed:serialized.includes(${JSON.stringify(fixtureSeed)}),
        hasRevealEntry:[...document.querySelectorAll('button,a')].some(item=>/Base32|导出密钥|显示密钥/.test(item.textContent||'')),
        url:location.href,
        stored:[...storageValues(localStorage),...storageValues(sessionStorage)],
      };
    })()`, true)
    if (safety.hasSensitiveKey || safety.containsSeed) throw new Error('GET /api/entries 暴露 secret/seed')
    if (safety.hasRevealEntry) throw new Error('现有条目出现再次显示或导出密钥入口')
    if (safety.url.includes(fixtureSeed) || safety.stored.some((value) => value.includes(fixtureSeed))) throw new Error('一次性密钥进入 URL 或浏览器存储')

    await send('Page.reload', { ignoreCache: true }, 10_000)
    await waitUntil(() => evaluate(send, `Boolean(document.querySelector('#entries-heading'))`), '刷新后验证码库恢复', 6_000)
    if (await evaluate(send, `document.body.textContent.includes(${JSON.stringify(fixtureSeed)}) || [...document.querySelectorAll('[role=dialog] h2')].some(item=>item.textContent==='保存这份 Base32 密钥')`)) throw new Error('刷新后恢复了一次性密钥')
    console.log('✓ 响应脱敏、无持久化与刷新不恢复通过')

    if (!(await clickText('导入验证码'))) throw new Error('无法打开重复导入弹窗')
    await waitUntil(() => dialogHeadingVisible('导入 TOTP 验证码'), '重复导入弹窗')
    if (!(await clickText('粘贴 URI'))) throw new Error('找不到 URI 导入方式')
    await evaluate(send, `(() => {
      const field=document.querySelector('[role=dialog] textarea');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(field,'otpauth://totp/AuthTOTP-Fixture?secret=${fixtureSeed}&issuer=AuthTOTP-Fixture');
      field.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    if (!(await clickText('确认导入'))) throw new Error('重复导入时找不到确认按钮')
    await waitUntil(() => evaluate(send, `[...document.querySelectorAll('[role=dialog] [role=alert]')].some(item=>item.textContent.includes('已经存在'))`), '重复导入失败提示')
    if (await dialogHeadingVisible('保存这份 Base32 密钥')) throw new Error('重复导入错误地显示一次性密钥')
    console.log('✓ 重复导入失败态未显示一次性密钥')
    console.log('✓ QR 新建仅成功后显示；复制、截图、Esc、重复失败、刷新和列表脱敏全部通过')
  }
} finally {
  try { ws?.close() } catch { /* already closed */ }
  try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') }
  await sleep(500)
  rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
}
