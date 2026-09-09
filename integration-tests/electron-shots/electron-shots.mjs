/**
 * 真实 Electron + Xvfb + CDP 截图验证(v3b 集成测试, 非 CI)。
 *
 * 流程: 启动打包 app(带远程调试) → 登录页应显示两步式 Step1 →
 * 输入真实服务端地址(8091) → 下一步 → 品牌区(Acme AI) + 方式选择器 →
 * 输入本地账号(admin)登录 → 进入应用 → 截图留档。
 *
 * 前置: Xvfb :99、服务端 8091(品牌已启用 Acme AI)、dist/linux-unpacked。
 * 用法: node electron-shots.mjs [--server http://127.0.0.1:8091]
 *
 * P2-60: 打包产物路径与截图目录改为按脚本位置推导(原来硬编码
 *   /data/picoaide-harness,换机器/换 clone 目录即失效)。
 * P3: 补断言(原来只 console.log 不判定)——任一断言失败以非零退出。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'host', 'desktop')
const APP = join(PACKAGE_ROOT, 'dist', 'linux-unpacked', 'dsh-plugin-desktop')
const CDP = 9224
const args = process.argv.slice(2)
const SERVER = args.includes('--server') ? args[args.indexOf('--server') + 1] : 'http://127.0.0.1:8091'
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : SCRIPT_DIR

const HOME = '/tmp/dsh-shot-home'
mkdirSync(SHOTS, { recursive: true })

if (!existsSync(APP)) {
  console.error(`[FAIL] 未找到打包产物: ${APP}\n  先构建: yarn workspace dsh-plugin-desktop dist:linux --no-prebuild`)
  process.exit(1)
}

let failures = 0
/** 断言(替代原来的 console.log):失败累计,结尾统一以非零退出。 */
function check(name, cond, detail = '') {
  console.log(`[${cond ? 'ok' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}

const app = spawn(APP, ['--no-sandbox', `--remote-debugging-port=${CDP}`], {
  env: {
    ...process.env,
    DISPLAY: ':99',
    HOME,
    DSH_HOME: join(HOME, '.dsh'),
    XDG_CONFIG_HOME: join(HOME, '.config'),
  },
  stdio: 'ignore',
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const main = list.find(t => t.type === 'page')
      if (main) {
        const ws = new WebSocket(main.webSocketDebuggerUrl)
        let id = 0; const pending = new Map()
        const send = (method, params = {}) => new Promise((res, rej) => {
          const mid = ++id; pending.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
        ws.onmessage = d => {
          const m = JSON.parse(d.data)
          if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
        }
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        return { ws, send }
      }
    } catch { /* retry */ }
    await sleep(1000)
  }
  throw new Error('cannot connect to app')
}

async function shot(send, name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  // 截图必须真实落盘且非空(P3 断言)。
  const size = statSync(file).size
  check(`截图 ${name}`, size > 1000, `${size} B`)
  return file
}

async function evalJS(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result?.value
}

try {
  // Keep the socket referenced until the script exits: a dropped WS reference
  // would let GC close it mid-flight (unused-var audit 2026-08-31).
  const { ws, send } = await connect()
  void ws
  await send('Page.enable')
  await sleep(2500)
  await shot(send, '01-login-step1.png')

  // 检查是否两步式登录页(Step1 有 '连接服务端')
  const step1 = await evalJS(send, `document.body.innerText.includes('连接服务端')`)
  check('Step1 登录页(含「连接服务端」)', step1 === true)
  if (step1) {
    // 输入服务端地址
    await evalJS(send, `(() => {
      const i = document.getElementById('server'); if (i) { i.value = '${SERVER}'; i.dispatchEvent(new Event('input')) }
    })()`)
    await sleep(300)
    const filled = await evalJS(send, `document.getElementById('server')?.value`)
    check('服务端地址已填入', filled === SERVER, String(filled))
    await shot(send, '02-step1-filled.png')
    // 点下一步
    await evalJS(send, `document.getElementById('next-btn')?.click()`)
    await sleep(2000)
    await shot(send, '03-step2-brand.png')
    const brand = await evalJS(send, `document.body.innerText.includes('Acme AI')`)
    check('Step2 品牌 Acme AI', brand === true)
    const meth = await evalJS(send, `document.querySelectorAll('.method').length`)
    check('方式选择器存在', typeof meth === 'number' && meth > 0, `count=${meth}`)
    // 输入本地账号登录
    await evalJS(send, `(() => {
      const u = document.getElementById('username'); if (u) { u.value = 'admin'; u.dispatchEvent(new Event('input')) }
      const p = document.getElementById('password'); if (p) { p.value = 'admin123456'; p.dispatchEvent(new Event('input')) }
    })()`)
    await sleep(200)
    await shot(send, '04-step2-filled.png')
    await evalJS(send, `document.getElementById('btn')?.click()`)
    await sleep(3000)
    await shot(send, '05-after-login.png')
    // 登录后应离开登录页(P3 断言:原来只截图不断言)。
    const stillLogin = await evalJS(send, `document.body.innerText.includes('连接服务端')`)
    check('登录后离开登录页', stillLogin === false)
  } else {
    check('两步式登录页', false, '未检测到(可能已登录或页面不同)')
  }
} catch (err) {
  check('脚本执行', false, err instanceof Error ? err.message : String(err))
} finally {
  app.kill('SIGTERM')
  await sleep(1500)
  app.kill('SIGKILL')
}

if (failures > 0) {
  console.error(`RESULT: FAIL(${failures} 项断言失败)`)
  process.exit(1)
}
console.log('RESULT: PASS')
