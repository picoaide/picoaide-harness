/**
 * 真实 Electron + Xvfb + CDP 截图验证(v3b 集成测试, 非 CI)。
 *
 * 流程: 启动打包 app(带远程调试) → 登录页应显示两步式 Step1 →
 * 输入真实服务端地址 → 下一步 → 品牌区(服务端渠道显示名) + 方式选择器 →
 * 输入本地账号登录 → 进入应用 → 截图留档。
 *
 * 前置: Xvfb :99、可达的服务端(默认 127.0.0.1:8091)、dist/linux-unpacked。
 * 用法: node electron-shots.mjs [--server http://127.0.0.1:8091] [--shots <dir>] [--app <bin>]
 *
 * P2-60: 打包产物路径与截图目录改为按脚本位置推导(原来硬编码
 *   /data/picoaide-harness,换机器/换 clone 目录即失效)。
 * P3: 补断言(原来只 console.log 不判定)——任一断言失败以非零退出。
 *
 * 2026-09-23(第四轮审计 R4-A-17 / R4-A-18)之后的两条结构性改动:
 *   ① **判据表外置**:本文件不再自带断言逻辑,而是按 id 求值 `assertions.mjs` 里那张表
 *      (运行期与门禁消费同一份)。此前"把 `check(…)` 改成常量"这类掏空**零守卫覆盖** ——
 *      `scripts/check-integration-tests.mjs` 只做字符串 needle 检查,门禁会给这个文件背书;
 *      现在门禁跑 `assertions.mjs --self-test`(每条判据都配正例 + 负例),并断言本文件
 *      **逐条引用**了表里的每个 id。
 *   ② **品牌断言改为渠道驱动**:Step2 品牌区断言的是服务端 `GET /api/client/v2/channel`
 *      的 `login.display_name`(缺失回落随包品牌 `PicoAide`),不再是已退役的旧夹具
 *      `Acme AI` —— 后者在当前实现里**永远不可能 PASS**(登录页品牌区只渲染渠道内容,
 *      见 `packages/host/enterprise/src/auth-gate.ts:433`/`:667`)。
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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expectedBrandName } from './assertions.mjs'
import { createReporter, runReporterSelfCheck } from './report.mjs'

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
  if (arg.startsWith('--') && !['--server', '--shots', '--app', '--display', '--help', '--self-check'].includes(arg)) {
    console.error(`[USAGE] 未知参数 ${arg}`)
    process.exit(EXIT_USAGE)
  }
}
if (args.includes('--help')) {
  console.log('用法: node electron-shots.mjs [--server http://127.0.0.1:8091] [--shots <dir>] [--app <bin>] [--display :99]')
  console.log('       node electron-shots.mjs --self-check   # 不开应用:把全部夹具经 report() 通道求值(门禁用)')
  console.log('  --self-check 证明运行期真的按判据表判:恒真/恒假的 report() 会让负例夹具报出不符(exit 1)')
  console.log('环境变量: ELECTRON_SHOTS_APP 覆盖打包产物路径(CI 用), DISPLAY 指定 X 显示。')
  console.log('退出码: 0=PASS 1=FAIL 2=用法错误 77=SKIP(前置环境缺失,未验证任何东西)')
  console.log('判据表: ./assertions.mjs(自检 node assertions.mjs --self-test,门禁会跑)')
  process.exit(EXIT_PASS)
}

/**
 * 判定通道(2026-09-23 第五轮审计 N7，复审 D-1 收口):判定与失败计数**下沉**到
 * `./report.mjs`,本文件只做接线 —— 而且**只允许解构绑定**通道自己的方法
 * (`const { report, … } = reporter`),不允许在这里再包一层
 * (`const report = (id, observation) => reporter.report(id, observation)`)。
 *
 * 为什么(复审 D-1 的现场):那层包装是一句**可变代码**。把它改成"返回常量对象、
 * 且 `ok` 不落在首键"(键序变形)或 early-return 恒真之后 —— 9 处 `report(id, …)`
 * 引用一字未改 —— `check-integration-tests.mjs` 仍然 **EXIT=0**:静态判据当时只认
 * "`ok` 是对象字面量**首键**"这一种形态,而当时的 `--self-check` 走的是
 * `report.mjs` **内部另建**的通道,不经过这句包装。
 * 现在两条腿同时收口:
 *   · `--self-check` 把**本文件解构出来的同一批绑定**交给 `runReporterSelfCheck`,
 *     包装被换掉 ⇒ 夹具结论与 `expect` 不符 ⇒ 非零;
 *   · `scripts/check-integration-tests.mjs` 另有结构判据(必须是解构绑定、不得自写
 *     `report` 函数)与两条**针对本文件**的端到端变异(键序变形 / early-return)。
 */
const reporter = createReporter()
const { report, failures, lines, exitCode } = reporter

if (args.includes('--self-check')) {
  const selfCheck = runReporterSelfCheck({ report, failures, lines })
  for (const failure of selfCheck.failures) console.error(`[FAIL] ${failure}`)
  console.log(`reporter self-check: ${selfCheck.passed}/${selfCheck.total} 条夹具经 report() 求值符合预期`)
  process.exit(selfCheck.failures.length === 0 ? EXIT_PASS : EXIT_FAIL)
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

/** 抓一帧并落盘;返回 `{ name, size, bytes }`(字节供"两帧是否相同"的判据用)。 */
async function shot(send, name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  // 截图必须真实落盘且非空(P3 断言;下界判据在 assertions.mjs 的 screenshot-nonempty)。
  const bytes = readFileSync(file)
  const frame = { name, size: statSync(file).size, bytes }
  report('screenshot-nonempty', { screenshot: frame })
  return frame
}

async function evalJS(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result?.value
}

/** 页面文本(判据表多条断言都吃它)。 */
const pageTextOf = send => evalJS(send, 'document.body.innerText')

/**
 * 读服务端渠道内容(`GET /api/client/v2/channel`)—— Step2 的品牌断言以它为准。
 * 取不到时返回 undefined ⇒ 期望值回落随包品牌(`PicoAide`),而不是判据失效。
 */
async function fetchChannel() {
  try {
    const response = await fetch(new URL('/api/client/v2/channel', SERVER), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

let scriptError = null
try {
  // Keep the socket referenced until the script exits: a dropped WS reference
  // would let GC close it mid-flight (unused-var audit 2026-08-31).
  const { ws, send } = await connect()
  void ws
  await send('Page.enable')
  await sleep(2500)
  const step1Shot = await shot(send, '01-login-step1.png')

  // 检查是否两步式登录页(Step1 有 '连接服务端')
  const step1Text = await pageTextOf(send)
  const step1 = typeof step1Text === 'string' && step1Text.includes('连接服务端')
  report('step1-login-page', { pageText: step1Text })
  if (step1) {
    report('two-step-login-page', { phaseOk: true })
    // 输入服务端地址
    await evalJS(send, `(() => {
      const i = document.getElementById('server'); if (i) { i.value = '${SERVER}'; i.dispatchEvent(new Event('input')) }
    })()`)
    await sleep(300)
    const filled = await evalJS(send, `document.getElementById('server')?.value`)
    report('server-filled', { server: SERVER, serverValue: filled })
    await shot(send, '02-step1-filled.png')
    // 点下一步
    await evalJS(send, `document.getElementById('next-btn')?.click()`)
    await sleep(2000)
    const step2Shot = await shot(send, '03-step2-brand.png')
    // 品牌区 = 服务端渠道显示名(缺失回落随包品牌)⇒ 期望值从服务端读,不写死夹具名。
    const channel = await fetchChannel()
    const step2Text = await pageTextOf(send)
    report('step2-brand', { pageText: step2Text, expectedBrand: expectedBrandName(channel) })
    // 两张截图必须不同:随仓证据里曾出现 4/5 逐字节相同(唯一判据只有"字节数 > 1000")。
    report('step2-shot-differs-from-step1', { baseline: step1Shot, current: step2Shot })
    const meth = await evalJS(send, `document.querySelectorAll('.method').length`)
    report('method-picker', { methodCount: meth })
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
    report('left-login-page', { pageText: await pageTextOf(send) })
  } else {
    report('two-step-login-page', { phaseOk: false })
  }
} catch (err) {
  scriptError = err instanceof Error ? err.message : String(err)
} finally {
  app.kill('SIGTERM')
  await sleep(1500)
  app.kill('SIGKILL')
}
// 最后一条:整段流程有没有未捕获异常(观察对象携带异常消息)。
report('script-completed', { error: scriptError })

// 退出码判据来自判定通道(不在本文件里另算一份);EXIT_FAIL 必须与通道的 exitCode() 同值。
// 这里的 `exitCode` / `failures` 与上面的 `report` 一样,都是**解构绑定**自同一个通道
// (不允许在本文件里再包一层 —— 那层包装就是 D-1 的逃逸点)。
if (exitCode() !== EXIT_PASS) {
  console.error(`RESULT: FAIL(${failures()} 项断言失败)`)
  process.exit(EXIT_FAIL)
}
console.log('RESULT: PASS')
process.exit(EXIT_PASS)
