/**
 * 真实 Electron + Xvfb + CDP 截图验证(v3b 集成测试, 非 CI)。
 *
 * 流程: 启动打包 app(带远程调试) → 登录页应显示两步式 Step1 →
 * 输入真实服务端地址 → 下一步 → 品牌区(服务端渠道显示名) + 方式选择器 →
 * 输入本地账号登录 → 进入应用 → 截图留档。
 *
 * 前置: Xvfb(缺省 `:99`, 可用 `--display` 指定)、可达的服务端(默认 127.0.0.1:8091)、
 *   `dist/linux-unpacked`(或用 `--app` / `ELECTRON_SHOTS_APP` 指向别的产物)。
 * 用法: node electron-shots.mjs [--server http://127.0.0.1:8091] [--shots <dir>] [--app <bin>]
 *   `--help` 打印完整参数表。
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
 * 2026-09-25(第二十五轮审计 FIX-29, P1 + 同文件 P2)之后的结构性改动 —— 这一段的
 * 主题是**"判据看起来在跑、其实没跑"**:
 *   ① **CDP 端点必须先证明归属**(P1)。旧实现写死 `127.0.0.1:9224`、spawn 前不查占用、
 *      拿到 `/json/list` 就取**第一个** `type:'page'` 当被测 app —— 实测把 `--app` 指向
 *      一个纯 bash 桩(没有窗口、没有页面、没有 Electron)时,13 条判定全 `[ok]`、
 *      `RESULT: PASS`、exit 0,还写出 5 张来自**假 CDP** 的"证据截图"。真实触发路径不是
 *      攻击:并发跑第二次、或上一次被打断留下的孤儿 app 就占着那个端口。
 *      现在只有**本次拉起的那个进程**自己宣告的调试端点才被接受:
 *        · 缺省 `--remote-debugging-port=0`(由 Chromium 自选空闲端口),不再有固定端口;
 *        · 显式 `--cdp-port <n>` 时 spawn 前先探占用,占用即 fail-loud;
 *        · 端口必须来自子进程的 `DevTools listening on ws://127.0.0.1:<port>/…`
 *          **或**本次全新 HOME 下 Chromium 自己写的 `DevToolsActivePort`
 *          (两者都有时必须一致,不一致 = 拿不准 ⇒ 失败);
 *        · `/json/version` 必须是 Electron 形状(UA 里有 `Electron/<major>`,且与本仓
 *          声明的 Electron 主版本一致)、浏览器路径要与 app 宣告的一致;
 *        · page target 必须是**本 app 的主窗口**(排除内置浏览器预热出来的
 *          `/browser-shell`、`/browser-overlay`),且回读它的 `location.href` 必须与
 *          选中的 target 同源 —— 截图证据只能来自这个 target。
 *      任何一条不成立都走 `script-completed` 判失败**并点名原因**,绝不继续截图。
 *   ② **同文件四条 P2**:`send()` 每条 CDP 命令加超时(握手成功但永不回包曾是永久挂起);
 *      `--display` 真的被 spawn 使用(旧实现只拿它做前置探测、spawn 里写死 `:99`);
 *      缺省截图输出改到临时运行目录(旧缺省就地覆盖随仓证据目录里**已入库**的 5 张 PNG,
 *      其中一张画面里就是 `--server` 的地址字符串),并且拒绝写进仓内非 `temp/` 的路径;
 *      每次运行用**全新**的 HOME/XDG(旧实现固定 `/tmp/dsh-shot-home` 且零清理 ⇒ 二次
 *      运行要么带着上次的登录态、要么被单实例锁顶掉)并在收尾清理 + 杀掉整棵进程组;
 *      单横线/位置参数 fail-loud(旧实现静默忽略 `-server <别处>` 并按缺省地址报 PASS)。
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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expectedBrandName } from './assertions.mjs'
import { createReporter, runReporterSelfCheck } from './report.mjs'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const EXIT_SKIP = 77

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'host', 'desktop')

/** 单条 CDP 命令的**缺省**预算(协议层,与工具预算无关)。挂住 ⇒ 判失败,不无限等。 */
const CDP_COMMAND_TIMEOUT_MS = 15_000
/**
 * 单条 CDP 命令的**生效**预算(`--cdp-timeout <ms>` > `ELECTRON_SHOTS_CDP_TIMEOUT_MS` > 缺省)。
 * 用 `let` 而不是再抄一份常量:标志/环境变量必须真的作用到 `send()` 上 ——
 * "参数写在那里但没人读"正是本文件被审计的同一类形态(见 `--display` 那条)。
 */
let cdpCommandTimeoutMs = CDP_COMMAND_TIMEOUT_MS
/** CDP WebSocket 握手的预算(连不上不能永久挂住)。 */
const CDP_OPEN_TIMEOUT_MS = 10_000
/** 等**本次拉起的 app**宣告调试端点的预算(真实打包产物冷启动实测 2–10s)。 */
const CDP_ANNOUNCE_TIMEOUT_MS = 30_000
/**
 * 等本 app **主窗口** page target 出现的预算。
 *
 * 调试端点在 app 启动早期就有了,而主窗口 target 要晚一些 —— 实测直接查 `/json/list`
 * 会先看到内置浏览器预热出来的 `/browser-overlay`、`/browser-shell`(甚至一条都没有)。
 * 所以这里是"等到本 app 的窗口出现",而不是"取第一眼看到的那条 page"。
 */
const PAGE_TARGET_TIMEOUT_MS = 30_000
/** 启动前探测端口占用的预算。 */
const PORT_PROBE_TIMEOUT_MS = 2_000

/**
 * 参数归一化 + **fail-loud 校验**。
 *
 * 旧实现只扫 `arg.startsWith('--')` 且只认精确的 `--name`,于是 `-server <别处>`、
 * `--shots=<dir>`、以及任何位置参数都被**静默忽略** —— 用例会按缺省地址跑完并报
 * `RESULT: PASS`:`--server` 敲错一个横线 = "验证了哪个部署"这件事静默换人。
 * 两个姊妹用例(`dex-sso-test.py` / `ldap-rbac-brand-test.py`)对不认识的 `-` 开头
 * 参数一律 exit 2,这里与它们对齐;`--k=v` 形态归一化成 `--k v`(而不是静默丢弃)。
 */
const args = []
for (const raw of process.argv.slice(2)) {
  if (raw.startsWith('--') && raw.includes('=')) {
    const index = raw.indexOf('=')
    args.push(raw.slice(0, index), raw.slice(index + 1))
  } else {
    args.push(raw)
  }
}

function usageFail(message) {
  console.error(`[USAGE] ${message}`)
  process.exit(EXIT_USAGE)
}

/** 取 `--flag <value>` 的值(缺值即用法错误)。 */
function flagValue(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    console.error(`[USAGE] ${name} 需要一个值`)
    process.exit(EXIT_USAGE)
  }
  return value
}

const KNOWN_FLAGS = ['--server', '--shots', '--app', '--display', '--cdp-port', '--cdp-timeout', '--help', '--self-check']
/** 需要跟一个值的标志（校验时要跳过它的值，否则值会被当成位置参数）。 */
const VALUE_FLAGS = new Set(['--server', '--shots', '--app', '--display', '--cdp-port', '--cdp-timeout'])
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (!arg.startsWith('-')) {
    usageFail(`不支持位置参数 ${JSON.stringify(arg)} —— 服务端地址请写 \`--server <url>\`（静默把位置参数当缺省值用 = 验证错了部署还报 PASS）`)
  }
  if (!arg.startsWith('--')) {
    usageFail(`不支持单横线参数 ${JSON.stringify(arg)} —— 长参数要写两个横线（例如 \`--server http://127.0.0.1:8091\`）`)
  }
  if (!KNOWN_FLAGS.includes(arg)) usageFail(`未知参数 ${arg}`)
  // 值由 flagValue 校验（缺值 / 值本身形如 `--x` 都在那里 fail-loud）。
  if (VALUE_FLAGS.has(arg) && args[index + 1] !== undefined && !args[index + 1].startsWith('-')) index += 1
}
if (args.includes('--help')) {
  console.log('用法: node electron-shots.mjs [--server http://127.0.0.1:8091] [--shots <dir>] [--app <bin>] [--display :99]')
  console.log('       [--cdp-port <n>] [--cdp-timeout <ms>]')
  console.log('       node electron-shots.mjs --self-check   # 不开应用:把全部夹具经 report() 通道求值(门禁用)')
  console.log('  --self-check 证明运行期真的按判据表判:恒真/恒假的 report() 会让负例夹具报出不符(exit 1)')
  console.log('  --shots      截图输出目录。缺省 = 每次运行新开的临时目录(<tmp>/electron-shots-XXXX/shots);')
  console.log('               **拒绝**写进仓内非 temp/ 的路径(避免覆盖已入库的证据 PNG)。')
  console.log('  --cdp-port   远程调试端口。缺省 0 = 由 Chromium 自选空闲端口(推荐);显式给端口时会先探占用,')
  console.log('               占用即失败。端口必须由**本次拉起的 app**自己宣告才会被使用(归属校验)。')
  console.log('  --cdp-timeout 单条 CDP 命令的预算(毫秒,缺省 15000)。')
  console.log('环境变量: ELECTRON_SHOTS_APP 覆盖打包产物路径(CI 用), DISPLAY 指定 X 显示,')
  console.log('         ELECTRON_SHOTS_CDP_TIMEOUT_MS 覆盖单条 CDP 命令预算(CI 用)。')
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

/**
 * **先把全部参数读出来**（含取值校验）——"参数写错了"必须在**探测环境之前**就判用法错误。
 * 否则 `--shots`(缺值) 这类错误会被"没有 X 显示 ⇒ SKIP(77)"掩盖成"环境缺失"。
 */
const SERVER = flagValue('--server') ?? process.env.SERVER_BASE ?? 'http://127.0.0.1:8091'
// ELECTRON_SHOTS_APP 是给 CI / 门禁用的覆盖点（打包产物可能不在默认位置，或需要显式
// 指到一个不存在的路径来驱动"缺产物 ⇒ SKIP"的判据）。
const APP = flagValue('--app') ?? process.env.ELECTRON_SHOTS_APP ?? join(PACKAGE_ROOT, 'dist', 'linux-unpacked', 'dsh-plugin-desktop')
const SHOTS_OPTION = flagValue('--shots')
const REQUESTED_CDP_PORT = Number(flagValue('--cdp-port') ?? 0)
if (!Number.isInteger(REQUESTED_CDP_PORT) || REQUESTED_CDP_PORT < 0 || REQUESTED_CDP_PORT > 65535) {
  usageFail('--cdp-port 需要 0..65535 的整数（0 = 由 Chromium 自选空闲端口）')
}
{
  const requested = Number(flagValue('--cdp-timeout') ?? process.env.ELECTRON_SHOTS_CDP_TIMEOUT_MS ?? CDP_COMMAND_TIMEOUT_MS)
  if (!Number.isFinite(requested) || requested <= 0) {
    usageFail('--cdp-timeout / ELECTRON_SHOTS_CDP_TIMEOUT_MS 需要正数毫秒')
  }
  cdpCommandTimeoutMs = requested
}

/**
 * 截图输出目录的**写面守卫**:仓内只允许写 gitignored 的 `temp/`。
 *
 * 旧缺省是 `SCRIPT_DIR`(= `integration-tests/electron-shots/`)——README 给的示例命令
 * 不带 `--shots`,于是任何一次真机运行都会就地覆盖仓里**已入库**的
 * `01-login-step1.png … 05-after-login.png`;其中 `02-step1-filled.png` 的画面里就是
 * `--server` 的原样字符串(公开仓纪律:一次 `git add -A` 就把真实部署地址带进仓)。
 * 缺省已经改成临时运行目录,这里再拦一道显式传入的仓内路径。
 * @param target - 已 resolve 的绝对路径。
 */
function assertOutsideTrackedTree(target) {
  if (target !== REPO_ROOT && !target.startsWith(REPO_ROOT + sep)) return
  const relative = target.slice(REPO_ROOT.length + 1)
  if (relative === 'temp' || relative.startsWith(`temp${sep}`)) return
  usageFail(`--shots 指向仓内非 temp/ 的路径（${target}）—— 本仓是公开仓,截图会渲染 --server 的地址、`
    + '且随仓证据目录里已有入库的 PNG(会被就地覆盖)。请写到仓外或 <repo>/temp/ 下,或直接用缺省(临时目录)。')
}
if (SHOTS_OPTION !== undefined) assertOutsideTrackedTree(resolve(SHOTS_OPTION))

/**
 * SKIP 的**原因码闭集**（本用例允许打出的那几个）。
 *
 * 门禁（`scripts/check-integration-tests.mjs`）按它做双向对账：它的登记表里的 `skipReasons`
 * 必须与这里逐字相等、每个原因码都必须有调用点、每个调用点都必须给登记过的原因码。
 * 新增原因码要同时改这里与门禁的 `SKIP_REASON_CODES` —— "未登记的原因"不再是一张免检牌。
 */
const SKIP_REASONS = ['missing-app', 'missing-display', 'missing-server']

/** 以 SKIP(77) 收尾的**唯一出口**（原因码必须登记在 SKIP_REASONS 里）。 */
function skip(code, reason, hint) {
  if (!SKIP_REASONS.includes(code)) throw new Error(`未登记的 SKIP 原因码: ${code}`)
  if (!reason) throw new Error('SKIP 必须带可读的观测细节（否则聚合层只剩"跳过"两个字）')
  console.log(`SKIP[${code}]: ${reason} —— 本次未验证任何东西`)
  if (hint !== undefined) console.log(`  处置: ${hint}`)
  process.exit(EXIT_SKIP)
}

// ── 前置探测 1:打包产物 ──────────────────────────────────────────────────────
if (!existsSync(APP)) {
  skip('missing-app', `未找到打包产物: ${APP}`,
    '先构建: yarn workspace dsh-plugin-desktop dist:linux --no-prebuild（或用 --app / ELECTRON_SHOTS_APP 指向已有产物）')
}

// ── 前置探测 2:X 显示（Linux 上检查 Xvfb/真实 X 的 unix socket；其它平台跳过） ──
// 解析出来的 DISPLAY 是**唯一真源**:spawn 用它、探测也用它(旧实现只拿它探测、
// spawn 里写死 `:99` ⇒ 操作者按帮助给了 `--display :77` 而 app 仍在 `:99` 上找不到显示)。
const DISPLAY = flagValue('--display') ?? process.env.DISPLAY ?? ':99'
if (process.platform === 'linux') {
  const screen = /^:(\d+)/u.exec(DISPLAY)?.[1]
  const socket = screen === undefined ? undefined : `/tmp/.X11-unix/X${screen}`
  const usable = socket !== undefined && existsSync(socket) && statSync(socket).isSocket()
  if (!usable) {
    skip('missing-display', `没有可用的 X 显示（DISPLAY=${DISPLAY}，${socket ?? 'X socket'} 不是可连接的 unix socket）`,
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
    skip('missing-server', `服务端 ${SERVER}/healthz 不可达/非 200（${detail}）`,
      '起服务端或用 --server 指向正确的地址')
  }
}

// ── 运行目录：每次运行**全新**的 HOME/XDG + 截图目录（不再复用 /tmp/dsh-shot-home） ──
//
// 旧实现把 HOME/DSH_HOME/XDG_CONFIG_HOME 全部钉在 `/tmp/dsh-shot-home` 且从不清理：
//   (a) 上次成功登录留下的 `session.json` 会让下一次启动直接进应用 ⇒ 登录页断言必然
//       失败（假红）；
//   (b) Electron 的单实例锁按 userData 目录判重 ⇒ 第二次运行的实例立刻退出，于是它
//       按"固定端口上的别人的 CDP"接管第一次运行的窗口（假绿）；
//   (c) `/tmp` 被清掉后 userData 里的 `SingletonSocket` 会变成悬空符号链接。
// 现在每次 mkdtempSync 一个新目录：run-home 是**一次性**的（收尾删除），截图与日志留档。
const RUN_DIR = mkdtempSync(join(tmpdir(), 'electron-shots-'))
const RUN_HOME = join(RUN_DIR, 'home')
const APP_LOG = join(RUN_DIR, 'app.log')
mkdirSync(RUN_HOME, { recursive: true })

/**
 * 截图输出目录:缺省落在本次运行目录里(`<tmp>/electron-shots-XXXX/shots`),**绝不**默认
 * 写进随仓的证据目录(写面守卫见上面的 `assertOutsideTrackedTree`)。
 */
const SHOTS = resolve(SHOTS_OPTION ?? join(RUN_DIR, 'shots'))
assertOutsideTrackedTree(SHOTS)
mkdirSync(SHOTS, { recursive: true })

/** 期望的 Electron 主版本(读本仓声明的版本;读不到就不 pin 这一条)。 */
const EXPECTED_ELECTRON_MAJOR = (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'))
    return /^(\d+)\./u.exec(String(manifest.version))?.[1]
  } catch { return undefined }
})()

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 端口是否已被占用（spawn 前预检:占着端口的**绝不是**本次要测的 app）。 */
function portInUse(port) {
  return new Promise(resolveProbe => {
    const probe = createServer()
    const done = used => {
      probe.removeAllListeners()
      try { probe.close() } catch { /* 已经关了 */ }
      resolveProbe(used)
    }
    probe.once('error', () => done(true))
    probe.once('listening', () => done(false))
    probe.listen({ port, host: '127.0.0.1', exclusive: true })
    setTimeout(() => done(true), PORT_PROBE_TIMEOUT_MS).unref?.()
  })
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 解析一个 URL 并判它是否指向本机回环 —— 被测 app 的页面只可能来自它自己的本机 host。
 * @returns 归一化后的 origin；不是回环 http(s) 时返回 undefined。
 */
function loopbackOriginOf(value) {
  if (typeof value !== 'string' || value === '') return undefined
  let url
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  return url.origin
}

/**
 * 选**本 app 的主窗口** target。
 *
 * `/json/list` 里还有内置浏览器预热出来的两个页面(`/browser-shell`、`/browser-overlay`),
 * 它们同属本 app 但**不是**登录/会话 UI —— 取错会让全部断言在 app 健康时失败
 * (`packages/host/desktop/scripts/e2e-client.mjs:105-118` 记着同一条)。
 * 旧实现是 `list.find(t => t.type === 'page')`:既不看 url/title,也不排除这两个,
 * 更不问"这个端点是不是本次拉起的 app"。
 */
function pickAppTarget(list) {
  if (!Array.isArray(list)) return undefined
  const pages = list.filter(target => target?.type === 'page' && typeof target.url === 'string')
  const appPages = pages.filter(target => !/\/(?:browser-shell|browser-overlay)(?:\?|$)/u.test(target.url))
  const loopback = appPages.filter(target => loopbackOriginOf(target.url) !== undefined)
  return loopback.find(target => new URL(target.url).pathname === '/') ?? loopback[0]
}

/** 把观测到的 target 清单压成一行（诊断用;绝不把整份 list 打进结论）。 */
const describeTargets = list => (Array.isArray(list) ? list : [])
  .map(target => `${target?.type ?? '?'}:${target?.url ?? '?'}`).slice(0, 8).join(' | ')

/**
 * 等本 app 的**主窗口** target 出现（见 {@link PAGE_TARGET_TIMEOUT_MS}）。
 * @returns 选中的 target（`{ id, type, title, url, webSocketDebuggerUrl }`）。
 */
async function waitForAppTarget(port) {
  const deadline = Date.now() + PAGE_TARGET_TIMEOUT_MS
  let observed
  for (;;) {
    try {
      observed = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()
    } catch {
      observed = undefined
    }
    const picked = pickAppTarget(observed)
    if (picked !== undefined) return picked
    if (Date.now() >= deadline) {
      throw new Error(`等了 ${PAGE_TARGET_TIMEOUT_MS / 1000}s 也没等到本 app 的主窗口 page target`
        + `(观测到:${describeTargets(observed) || '(空)'}) —— app 可能没把窗口挂起来,`
        + '或这个端点是别人的(内置浏览器的 /browser-shell、/browser-overlay 不算主窗口)')
    }
    await sleep(500)
  }
}

/** 子进程输出里由 Chromium 自己打印的调试端点宣告。 */
function announcedFromOutput(output) {
  const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)(\/devtools\/browser\/[0-9a-fA-F-]+)/u.exec(output)
  if (match === null) return undefined
  const port = Number(match[1])
  // `:0` 不是可连接的端点（`--remote-debugging-port=0` 是让 Chromium 自选，它宣告的是
  // **选好的**那个端口）⇒ `:0` 只可能是伪造/误读，按"没宣告"处理。
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { port, browserPath: match[2], source: '子进程 stderr/stdout 的 "DevTools listening on …"' }
}

/**
 * 本次**全新** HOME 下由 Chromium 自己写的 `DevToolsActivePort`（两行:端口 / 浏览器路径）。
 * 文件落在我们刚 mkdtemp 出来的目录里 ⇒ "它是本次拉起的进程写的"由构造保证。
 */
function announcedFromActivePortFile(homeDir) {
  let entries
  try { entries = readdirSync(homeDir, { recursive: true, withFileTypes: true }) } catch { return undefined }
  for (const entry of entries) {
    if (entry.isFile() !== true || entry.name !== 'DevToolsActivePort') continue
    const file = join(entry.parentPath ?? entry.path, entry.name)
    try {
      const [portLine, browserPath] = readFileSync(file, 'utf8').split('\n')
      const port = Number(portLine)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      return { port, browserPath: browserPath ?? '', source: `本次运行 HOME 下的 ${file}` }
    } catch { /* 读不到就换下一个候选 */ }
  }
  return undefined
}

/** 进程组信号（Electron 会带起 zygote/renderer/gpu 子进程,只杀直接子进程会留孤儿）。 */
function signalTree(child, signal) {
  if (child?.pid === undefined) return
  try { process.kill(-child.pid, signal) } catch { /* 进程组已经不在了 */ }
  try { child.kill(signal) } catch { /* 已经退出 */ }
}

let runningApp
/** 收尾:杀掉整棵进程组,并清掉一次性的运行 HOME（截图与日志留在 RUN_DIR 里）。 */
function teardownSync() {
  signalTree(runningApp, 'SIGTERM')
  signalTree(runningApp, 'SIGKILL')
  try { rmSync(RUN_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { teardownSync(); process.exit(EXIT_FAIL) })
}

async function shutdownApp() {
  if (runningApp !== undefined && runningApp.exitCode === null) {
    signalTree(runningApp, 'SIGTERM')
    await sleep(1500)
    signalTree(runningApp, 'SIGKILL')
  }
  // 一次性的运行 HOME 无论有没有真的拉起过 app 都要清（截图/日志留在 RUN_DIR 里）。
  try { rmSync(RUN_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
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

/**
 * 等**本次拉起的那个 app**自己宣告调试端点,并返回它宣告的端点。
 *
 * 这是 P1 的核心:端点归属的**唯一权威是子进程自己**(它的 stdout/stderr、它在本次
 * 全新 HOME 里写下的 `DevToolsActivePort`),而不是"某个端口上有人在讲 CDP"。
 * 三个出口都是 fail-loud:
 *   · 子进程拉不起来 / 没宣告就退出 / 等满预算仍没宣告 —— 点名原因 + 附最后输出;
 *   · 两个来源宣告了**不同**的端口 —— 拿不准就失败(不挑一个"看起来对"的用);
 *   · 显式 `--cdp-port <n>` 与宣告值不一致 —— 端点不是这次配置出来的那个。
 * @returns `{ port, browserPath, source }`。
 */
async function awaitOwnedEndpoint({ requestedPort, child, readOutput, readError, readExit }) {
  const deadline = Date.now() + CDP_ANNOUNCE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const spawnFailure = readError()
    if (spawnFailure !== null) {
      throw new Error(`拉不起被测 app(${APP}):${spawnFailure} —— 产物可能不存在/不可执行/架构不符`
        + '（"spawn 失败"必须可读,不能只剩裸栈）')
    }
    const exitCode = readExit()
    if (exitCode !== null) {
      throw new Error(`被测 app(${APP})在宣告调试端点之前就退出了(exit=${exitCode})。最后输出:`
        + `${readOutput().trim().split('\n').slice(-5).join(' ⏎ ') || '(空)'}`)
    }
    const fromOutput = announcedFromOutput(readOutput())
    const fromFile = announcedFromActivePortFile(RUN_HOME)
    if (fromOutput !== undefined && fromFile !== undefined && fromOutput.port !== fromFile.port) {
      throw new Error(`端点归属拿不准:子进程输出宣告 :${fromOutput.port},而 ${fromFile.source} 写的是 :${fromFile.port}`
        + ' —— 两个来源不一致时不挑一个用,直接判失败')
    }
    const announced = fromOutput ?? fromFile
    if (announced !== undefined) {
      if (requestedPort > 0 && announced.port !== requestedPort) {
        throw new Error(`--cdp-port ${requestedPort} 与 app 自己宣告的端口 :${announced.port} 不一致`
        + `（来源:${announced.source}）—— 说明 :${requestedPort} 上的东西不是本次拉起的 app`)
      }
      return { ...announced, childPid: child.pid }
    }
    await sleep(250)
  }
  throw new Error(`等了 ${CDP_ANNOUNCE_TIMEOUT_MS / 1000}s,本次拉起的 app(${APP}, pid=${child.pid})**没有宣告任何调试端点**`
    + ' —— 端口上可能有别人的服务,但它不是这次要测的 app(旧实现会照单全收并报 PASS)。最后输出:'
    + `${readOutput().trim().split('\n').slice(-5).join(' ⏎ ') || '(空)'}`)
}

/**
 * 连接**本次拉起的 app**的调试端点,并证明"接下来驱动的就是它"。
 *
 * 归属证明按顺序三道(任何一道不成立即抛,绝不继续截图):
 *   ① `/json/version` 必须是 Electron 形状,浏览器路径必须与 app 自己宣告的一致;
 *   ② page target 必须是本 app 的主窗口(回环 http origin、排除内置浏览器的两个页面);
 *   ③ 连上之后回读 `location.href`,必须与选中的 target **同源**(截图证据只能来自它)。
 */
async function connect(endpoint) {
  const { port } = endpoint
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json()
  const browser = version?.Browser
  if (typeof browser !== 'string' || !/^Chrome\/\d+\./u.test(browser)) {
    throw new Error(`:${port} 的 /json/version 不是 Chromium 形状(Browser=${JSON.stringify(browser)})`
      + ` —— 它不属于本次拉起的 app(来源:${endpoint.source})`)
  }
  const agent = String(version?.['User-Agent'] ?? '')
  const electronMajor = /Electron\/(\d+)\./u.exec(agent)?.[1]
  if (electronMajor === undefined) {
    throw new Error(`:${port} 的 User-Agent 里没有 Electron 标识(UA=${JSON.stringify(agent)})`
      + ' —— 那是浏览器内核或伪造端点,不是被测的 Electron app')
  }
  if (EXPECTED_ELECTRON_MAJOR !== undefined && electronMajor !== EXPECTED_ELECTRON_MAJOR) {
    throw new Error(`:${port} 的 Electron 主版本是 ${electronMajor},本仓声明的是 ${EXPECTED_ELECTRON_MAJOR}`
      + '(packages/host/desktop/node_modules/electron) —— 端点不属于本次构建的 app')
  }
  if (endpoint.browserPath !== '' && !String(version?.webSocketDebuggerUrl ?? '').includes(endpoint.browserPath)) {
    throw new Error(`:${port} 的浏览器路径(${JSON.stringify(version?.webSocketDebuggerUrl)})`
      + `与 app 自己宣告的(${endpoint.browserPath})不一致 —— 拿不准就判失败`)
  }

  const main = await waitForAppTarget(port)
  if (!String(main.webSocketDebuggerUrl ?? '').includes(`:${port}/`)) {
    throw new Error(`page target 的调试地址(${JSON.stringify(main.webSocketDebuggerUrl)})不在 app 宣告的端口 :${port} 上`)
  }

  const ws = new WebSocket(main.webSocketDebuggerUrl)
  let id = 0; const pending = new Map()
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    // 每条 CDP 命令都必须**有界**:握手成功之后对方永不回包是很常见的卡死形态
    // (渲染进程被同步阻塞冻住 / 页面停在原生对话框上 / 端口被转发给一个不回包的进程)。
    // 旧实现没有这个预算 ⇒ 整个脚本永久挂住,而聚合层 `run-all.sh` 也没有 timeout。
    const timer = setTimeout(() => {
      pending.delete(mid)
      rej(new Error(`CDP 命令 ${method} 超过 ${cdpCommandTimeoutMs}ms 没有回包（拿不准 ⇒ 判失败,不继续截图）`))
    }, cdpCommandTimeoutMs)
    pending.set(mid, {
      res: value => { clearTimeout(timer); res(value) },
      rej: error => { clearTimeout(timer); rej(error) },
    })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.onmessage = d => {
    const m = JSON.parse(d.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
  }
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP WebSocket 握手超过 ${CDP_OPEN_TIMEOUT_MS}ms 没完成`)), CDP_OPEN_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); res() }
    ws.onerror = () => { clearTimeout(timer); rej(new Error(`CDP WebSocket 握手失败(${main.webSocketDebuggerUrl})`)) }
  })

  // ③ 回读页面自己的地址:接下来所有截图/求值都打在 `main` 上,它必须是本 app 的页面。
  const href = await evalJS(send, 'location.href')
  const targetOrigin = loopbackOriginOf(main.url)
  const actualOrigin = loopbackOriginOf(href)
  if (actualOrigin === undefined || actualOrigin !== targetOrigin) {
    ws.close()
    throw new Error(`驱动的页面不是刚选中的 target:回读 location.href=${JSON.stringify(href)},`
      + `而 target 是 ${JSON.stringify(main.url)} —— 拿不准就判失败`)
  }
  return { ws, send }
}

let scriptError = null
try {
  // 显式端口:spawn **之前**先探占用。占着它的东西绝不可能是本次要测的 app。
  if (REQUESTED_CDP_PORT > 0 && await portInUse(REQUESTED_CDP_PORT)) {
    throw new Error(`CDP 端口 ${REQUESTED_CDP_PORT} 已被占用 —— 那上面跑的**不是**本次要启动的 app`
      + '（常见成因:上一次被打断的运行留下的孤儿 app,或并发跑的第二次运行）。'
      + '请让占用方退出,或改用缺省 `--cdp-port 0`(由 Chromium 自选空闲端口)')
  }

  const app = spawn(APP, ['--no-sandbox', `--remote-debugging-port=${REQUESTED_CDP_PORT}`], {
    env: {
      ...process.env,
      // 打包版默认拒绝调试类开关（`--remote-debugging-port` 属受管开关，见
      // packages/host/desktop/src/debug-switches.ts）：本脚本**就是**用 CDP 驱动打包产物的
      // 自动化入口，必须显式走逃生门，否则 app 会在暴露 CDP 之前 exit 1。
      PICOAI_ALLOW_DEBUG_SWITCHES: '1',
      // DISPLAY 的唯一真源就是上面解析出来的那个(旧实现这里写死 ':99')。
      DISPLAY,
      HOME: RUN_HOME,
      DSH_HOME: join(RUN_HOME, '.dsh'),
      XDG_CONFIG_HOME: join(RUN_HOME, '.config'),
    },
    // 捕获子进程输出:① 它是"调试端点归属"的权威来源之一;② 失败时能给出可读诊断
    //（旧实现 `stdio:'ignore'` 把 app 自己的 "cannot open display" 全丢了）。
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立进程组:收尾时能一次杀掉 Electron 带起的整棵子树,不留持有端口的孤儿。
    detached: true,
  })
  runningApp = app
  let appOutput = ''
  const capture = chunk => {
    const text = String(chunk)
    appOutput = (appOutput + text).slice(-64_000)
    try { appendFileSync(APP_LOG, text) } catch { /* 日志写不进去不该拖垮用例 */ }
  }
  app.stdout?.on('data', capture)
  app.stderr?.on('data', capture)
  let spawnFailure = null
  app.on('error', error => { spawnFailure = error.message })

  const endpoint = await awaitOwnedEndpoint({
    requestedPort: REQUESTED_CDP_PORT,
    child: app,
    readOutput: () => appOutput,
    readError: () => spawnFailure,
    readExit: () => app.exitCode,
  })
  console.log(`[i] 调试端点归属已证实: :${endpoint.port}（${endpoint.source}）`)

  // Keep the socket referenced until the script exits: a dropped WS reference
  // would let GC close it mid-flight (unused-var audit 2026-08-31).
  const { ws, send } = await connect(endpoint)
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
  await shutdownApp()
}
// 最后一条:整段流程有没有未捕获异常(观察对象携带异常消息)。
report('script-completed', { error: scriptError })

// 退出码判据来自判定通道(不在本文件里另算一份);EXIT_FAIL 必须与通道的 exitCode() 同值。
// 这里的 `exitCode` / `failures` 与上面的 `report` 一样,都是**解构绑定**自同一个通道
// (不允许在本文件里再包一层 —— 那层包装就是 D-1 的逃逸点)。
console.log(`运行目录: ${RUN_DIR}（截图 ${SHOTS}${existsSync(APP_LOG) ? `, 应用输出 ${APP_LOG}` : ''}）`)
if (exitCode() !== EXIT_PASS) {
  console.error(`RESULT: FAIL(${failures()} 项断言失败)`)
  process.exit(EXIT_FAIL)
}
console.log('RESULT: PASS')
process.exit(EXIT_PASS)
