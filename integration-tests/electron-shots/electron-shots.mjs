/**
 * 真实 Electron + Xvfb + CDP 截图验证(v3b 集成测试, 非 CI)。
 *
 * 流程: 启动打包 app(带远程调试) → 登录页应显示两步式 Step1 →
 * 输入真实服务端地址(8091) → 下一步 → 品牌区(Acme AI) + 方式选择器 →
 * 输入本地账号(admin)登录 → 进入应用 → 截图留档。
 *
 * 前置: Xvfb :99、服务端 8091(品牌已启用 Acme AI)、dist/linux-unpacked。
 * 用法: node electron-shots.mjs [--server http://127.0.0.1:8091] [--shots <dir>] [--app <bin>]
 *
 * P2-60: 打包产物路径与截图目录改为按脚本位置推导(原来硬编码
 *   /data/picoaide-harness,换机器/换 clone 目录即失效)。
 * P3: 补断言(原来只 console.log 不判定)——任一断言失败以非零退出。
 *
 * 退出码契约(2026-09-23, 与 python 用例脚本对齐 —— 见 ../README.md):
 *   0  = 真的跑过且全部断言通过;
 *   1  = 断言失败(契约不满足);
 *   2  = 用法错误(未知参数);
 *   77 = **SKIP: 前置环境缺失**(打包产物不存在 / 没有可用的 X 显示 / 服务端不可达),
 *        **未验证任何东西** —— "什么都没验证"绝不能报 PASS(旧实现在缺产物时 exit 1,
 *        与"断言失败"同码,聚合层无法区分"环境没起来"和"真的坏了")。
 *
 * 前置探测顺序: 打包产物 → X 显示 → 服务端 /healthz。三者任一缺失即 SKIP(77)。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const EXIT_SKIP = 77

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'host', 'desktop')
const args = process.argv.slice(2)

/** 取 `--flag <value>` 的值(缺值即用法错误)。 */
function flagValue(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`[USAGE] ${name} 需要一个值`)
    process.exit(EXIT_USAGE)
  }
  return value
}

for (const arg of args) {
  if (arg.startsWith('--') && !['--server', '--shots', '--app', '--display', '--help'].includes(arg)) {
    console.error(`[USAGE] 未知参数 ${arg}`)
    process.exit(EXIT_USAGE)
  }
}
if (args.includes('--help')) {
  console.log('用法: node electron-shots.mjs [--server http://127.0.0.1:8091] [--shots <dir>] [--app <bin>] [--display :99]')
  console.log('环境变量: ELECTRON_SHOTS_APP 覆盖打包产物路径(CI 用), DISPLAY 指定 X 显示。')
  console.log('退出码: 0=PASS 1=FAIL 2=用法错误 77=SKIP(前置环境缺失,未验证任何东西)')
  process.exit(EXIT_PASS)
}

const SERVER = flagValue('--server') ?? process.env.SERVER_BASE ?? 'http://127.0.0.1:8091'
const SHOTS = flagValue('--shots') ?? SCRIPT_DIR
// ELECTRON_SHOTS_APP 是给 CI / 门禁用的覆盖点（打包产物可能不在默认位置，或需要显式
// 指到一个不存在的路径来驱动"缺产物 ⇒ SKIP"的判据）。
const APP = flagValue('--app') ?? process.env.ELECTRON_SHOTS_APP ?? join(PACKAGE_ROOT, 'dist', 'linux-unpacked', 'dsh-plugin-desktop')
const CDP = 9224

/** 打印 SKIP 原因并以 77 退出("未验证任何东西"必须与 PASS/FAIL 可区分)。 */
function skip(reason, hint) {
  console.log(`SKIP: ${reason} —— 本次未验证任何东西`)
  if (hint !== undefined) console.log(`  处置: ${hint}`)
  process.exit(EXIT_SKIP)
}

// ── 前置探测 1:打包产物 ──────────────────────────────────────────────────────
if (!existsSync(APP)) {
  skip(`未找到打包产物: ${APP}`,
    '先构建: yarn workspace dsh-plugin-desktop dist:linux --no-prebuild（或用 --app / ELECTRON_SHOTS_APP 指向已有产物）')
}

// ── 前置探测 2:X 显示（Linux 上检查 Xvfb/真实 X 的 unix socket；其它平台跳过） ──
const DISPLAY = flagValue('--display') ?? process.env.DISPLAY ?? ':99'
if (process.platform === 'linux') {
  const screen = /^:(\d+)/u.exec(DISPLAY)?.[1]
  const socket = screen === undefined ? undefined : `/tmp/.X11-unix/X${screen}`
  if (socket === undefined || !existsSync(socket)) {
    skip(`没有可用的 X 显示（DISPLAY=${DISPLAY}，找不到 ${socket ?? 'X socket'}）`,
      '起一个: Xvfb :99 -screen 0 1440x900x24 &（或用 --display 指向已存在的显示）')
  }
}

// ── 前置探测 3:服务端可达（不可达 = 环境缺失，不是断言失败） ──────────────────
{
  let ok = false
  let detail = ''
  try {
    const response = await fetch(new URL('/healthz', SERVER), { signal: AbortSignal.timeout(5000) })
    ok = response.ok
    detail = `status=${response.status}`
  } catch (error) {
    detail = error?.message ?? String(error)
  }
  if (!ok) {
    skip(`服务端 ${SERVER}/healthz 不可达/非 200（${detail}）`, '起服务端或用 --server 指向正确的地址')
  }
}

const HOME = '/tmp/dsh-shot-home'
mkdirSync(SHOTS, { recursive: true })

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
  process.exit(EXIT_FAIL)
}
console.log('RESULT: PASS')
process.exit(EXIT_PASS)
