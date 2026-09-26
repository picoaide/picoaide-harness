/**
 * 打包版的**调试开关闸门**（2026-09-26 第二十五轮审计 Y4-01，P1）。
 *
 * ## 为什么需要它（威胁模型与实测证据）
 *
 * 本仓的本地写面/会话面用**持有性证明**把"同机同用户任意进程"挡在外面
 * （`write-proof.ts:1-14`、`desktop-update-route.ts:35-58` 明写这就是边界）：
 * 只有"真的是本应用自己的页面"才拿得到 `dsh-auth-<authority>` 这个
 * HttpOnly + SameSite=Strict 的 cookie。而打包版客户端**接受调试类命令行开关**，
 * 于是一个普通本机进程只要按自己的 argv 启动本应用就能整体击穿那道围栏
 * （2026-09-26 用打包产物 + Xvfb 实跑，证据 `temp/r25/Y4-fresh/probe/`）：
 *
 *  - `--inspect=9337` ⇒ CDP 直通**主进程** V8：`Runtime.evaluate` 拿回
 *    `{pid, dshHome, electron}`，`process.getBuiltinModule('node:fs'|'node:child_process')`
 *    可用、`app.asar` 可读 ⇒ 主进程任意代码执行（主进程内存里就是企业会话 bearer）。
 *  - `--remote-debugging-port=9334` ⇒ `Network.getAllCookies`（CDP 内建，HttpOnly 无效）
 *    读出 `dsh-auth-*`；把它交给一个普通 node 进程重放，
 *    `POST /api/pico/desktop/update/check` 从 `403 browser session proof required`
 *    变成 **`202 {"accepted":true}`**。
 *
 * 前提只有"同机同用户能起一个进程 + 能按自己的 argv 启动本应用"
 * —— 与本仓写面围栏自己的威胁模型同级，无需提权、无需读写 `$DSH_HOME`。
 *
 * ## 为什么必须"拒绝启动"，而不是 `removeSwitch` / 关 devTools
 *
 *  `--inspect` 的监听在 **JS 跑之前**就已经建好（V8 inspector 是运行时启动参数），
 *  任何在 JS 里做的开关净化都晚了一步；`--remote-debugging-port` 同理由 Chromium
 *  在浏览器进程初始化时读取。所以唯一可靠的处置是**在模块作用域拒绝启动**
 *  （早于 `app.whenReady()`，与 `applySystemProxyPolicy` 同一位置）。
 *  注意 `webPreferences.devTools = false`（`window-options.ts`）对 CDP **完全无效**：
 *  它只关渲染进程的 DevTools 前端，不关调试端口。
 *
 * ## 开发态不得被误伤
 *
 * 闸门只在 `app.isPackaged` 为真时生效。`yarn dev`（`!app.isPackaged`）下
 * `--inspect`/`--remote-debugging-port` 是**正常调试手段**，一律放行。
 *
 * ## 逃生门（有意保留，且如实说明其能力边界）
 *
 * 本仓对"启动期策略"的既有惯例是留一个**显式环境变量逃生门**
 * （`PICOAI_ALLOW_SYSTEM_PROXY`，`network-policy.ts:26-31`），这里同形：
 * 真实进程环境里的 `PICOAI_ALLOW_DEBUG_SWITCHES=1` 放行本次运行，并在启动日志里
 * 明示"本次运行的调试开关保护已关闭"。它存在的理由是我们的 E2E/真机探针
 * （`scripts/e2e-*.mjs`、`integration-tests/electron-shots/`）本来就靠
 * `--remote-debugging-port` 驱动**打包产物**。
 *
 * **能力边界（认账，不当作安全边界）**：在"同机同用户任意进程"这一威胁模型下，
 * 攻击者同时控制 argv **与环境**，所以逃生门对他不构成障碍 —— 他能拿到的主进程
 * RCE 不会因为多写一个 `PICOAI_ALLOW_DEBUG_SWITCHES=1` 而少。这条闸门因此拦的是
 * **无意/遗留/被误导的调试开关**（快捷方式、IDE 启动配置、排障指引）与"静默暴露"，
 * 并把"本次真的绕过了保护"变成启动日志里的一行。真正闭合 cookie 窃取那一半需要
 * 结构性修法（持有性证明不再依赖 cookie 罐的保密性，见审计报告 Y4-01 修复方向②）。
 * @module dsh-plugin-desktop/debug-switches
 */

import { writeSync } from 'node:fs'
import { isEnabledFlag } from './network-policy.ts'

/**
 * 允许调试开关的显式逃生门（**只认真实进程环境**）。
 *
 * 与 `PICOAI_ALLOW_SYSTEM_PROXY` 同形：必须在 `app.whenReady()` 之前就能读到，
 * 所以不读 Harness home 的 `.env` 分层（那一层到 `start()` 才加载）。
 */
export const ALLOW_DEBUG_SWITCHES_ENV = 'PICOAI_ALLOW_DEBUG_SWITCHES'

/**
 * 受管开关名（**唯一字面量出处**，不含前导 `--`）。
 *
 * 两个族，危害不同但都必须拦：
 *  - 主进程 / V8 控制面：`inspect`、`inspect-brk`、`inspect-port`、`js-flags`
 *    ⇒ 任意代码执行（那里有企业会话 bearer 与 safeStorage 解密能力）；
 *  - 渲染进程 CDP：`remote-debugging-port`、`remote-debugging-pipe`
 *    ⇒ 读出 HttpOnly 的持有性证明 cookie，把"只有真页面能证明自己"这一前提推翻。
 *
 * `inspect-brk` / `inspect-port` 必须单列：按 `名字=` 前缀匹配时
 * `--inspect-brk=9229` 不会命中 `inspect`（`inspect` 后面紧跟的是 `-`）。
 */
export const DEBUG_SWITCHES: readonly string[] = [
  'inspect',
  'inspect-brk',
  'inspect-port',
  'remote-debugging-port',
  'remote-debugging-pipe',
  'js-flags',
]

/** 一个被命中的调试开关。 */
export interface DebugSwitchMatch {
  /** 受管开关名（不含 `--`，取自 {@link DEBUG_SWITCHES}）。 */
  readonly name: string
  /** 原始 argv 元素（如实回报，便于定位是哪个启动项带来的）。 */
  readonly raw: string
  /** 来自应用 argv 还是 Node/Electron 的 `process.execArgv`。 */
  readonly source: 'argv' | 'execArgv'
}

/** {@link detectDebugSwitches} 的判定结果。 */
export interface DebugSwitchGate {
  /** 是否打包态（false ⇒ 开发态，一律放行，一个开关都不拦）。 */
  readonly packaged: boolean
  /** 逃生门是否开启（真实进程环境里的 `PICOAI_ALLOW_DEBUG_SWITCHES`）。 */
  readonly hatch: boolean
  /** 命中的开关（先 argv 后 execArgv，按出现顺序）。 */
  readonly matches: readonly DebugSwitchMatch[]
  /** 本次真的靠逃生门放行（= 有命中 + 开了逃生门）。用于启动日志明示。 */
  readonly escaped: boolean
  /** 打包态 + 有命中 + 没有逃生门 ⇒ 必须拒绝启动。 */
  readonly refused: boolean
}

/**
 * 判一个 argv 元素是不是受管调试开关。
 *
 * 只认两种形状：`--<name>` 与 `--<name>=<value>`（Node 与 Chromium 的取值写法）。
 * 因此 `--inspection-mode`、`--no-inspect`、`--remote-debugging-portx` 都**不**命中
 * —— 闸门宁可漏判一个我们没见过的开关名，也不能把正常启动参数误判成调试开关
 * （误判的代价是"打包版直接起不来"）。
 * @param argument - 单个 argv 元素。
 * @returns 命中的开关名，或 undefined。
 */
export function matchDebugSwitch(argument: string): string | undefined {
  if (!argument.startsWith('--')) return undefined
  const body = argument.slice(2)
  return DEBUG_SWITCHES.find(name => body === name || body.startsWith(`${name}=`))
}

/**
 * 收集两组 argv 里的调试开关。
 * @param argv - 应用 argv（`process.argv`）。
 * @param execArgv - Node/Electron 的 `process.execArgv`。
 * @returns 命中的开关（argv 在前）。
 */
export function collectDebugSwitches(
  argv: readonly string[],
  execArgv: readonly string[],
): readonly DebugSwitchMatch[] {
  const matches: DebugSwitchMatch[] = []
  for (const [source, list] of [['argv', argv], ['execArgv', execArgv]] as const) {
    for (const raw of list) {
      const name = matchDebugSwitch(raw)
      if (name !== undefined) matches.push({ name, raw, source })
    }
  }
  return matches
}

/**
 * 判定本次启动是否必须被拒绝。
 *
 * 判定顺序（**只有一处**，接线侧不得另写一份条件）：
 *  1. 开发态（`packaged === false`）⇒ 永远放行；
 *  2. 打包态 + 无命中 ⇒ 放行（绝大多数正常启动走这一支）；
 *  3. 打包态 + 命中 + 逃生门开 ⇒ 放行但记 `escaped`（启动日志明示）；
 *  4. 打包态 + 命中 + 无逃生门 ⇒ `refused`。
 * @param input - 三组启动期输入。
 * @returns 判定结果。
 */
export function detectDebugSwitches(input: {
  readonly argv: readonly string[]
  readonly execArgv: readonly string[]
  readonly packaged: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}): DebugSwitchGate {
  const matches = collectDebugSwitches(input.argv, input.execArgv)
  // 真值口径与出口策略共用同一个实现（`0`/`false`/`no`/`off`/空白都算关闭）。
  const hatch = [ALLOW_DEBUG_SWITCHES_ENV, ALLOW_DEBUG_SWITCHES_ENV.toLowerCase()]
    .some(name => isEnabledFlag(input.env[name]))
  const escaped = hatch && matches.length > 0
  return {
    packaged: input.packaged,
    hatch,
    matches,
    escaped,
    refused: input.packaged && matches.length > 0 && !hatch,
  }
}

/**
 * 拒绝启动时给用户看的文案（**可行动**：点名开关、说清危害、给两条出路）。
 *
 * 冷启动失败时窗口/日志都还不存在，这句话可能就是一个打包 GUI 用户能看到的**全部**
 * 信息，所以它自带"是哪个开关、为什么危险、怎么继续"。
 *
 * **为什么是中英双写而不是按 locale 取单语**：这条闸门跑在模块作用域，而
 * Electron 的 `app.getLocale()` 在 ready 之前**返回空串**（2026-09-26 用
 * `node_modules/electron/dist/electron` + xvfb 实测：`PRE-READY {"locale":""}` /
 * `POST-READY {"locale":"zh-CN"}`；`app.getSystemLocale()` 更是明文抛
 * "can only be called after app is ready"）—— 也就是说这里**结构上**拿不到语言，
 * 而按本仓纪律又不允许把语言冻结在模块级常量表里。所以两条都写：中文在前
 * （产品默认语言），英文在后（日志/排障惯例）。
 * @param gate - {@link detectDebugSwitches} 的结果（必须有命中）。
 * @returns 多行文案（不以换行结尾）。
 */
export function debugSwitchRefusalMessage(gate: DebugSwitchGate): string {
  const listed = gate.matches.map(match => match.raw).join(' ')
  return [
    `拒绝启动：本次是以调试类命令行开关启动的打包版（${listed}）。`,
    '这类开关把本应用完整交给"任何以本用户身份运行的进程"：',
    '  --inspect / --inspect-brk / --inspect-port / --js-flags ⇒ 主进程任意代码执行',
    '    （企业会话令牌就在主进程内存里）；',
    '  --remote-debugging-port / --remote-debugging-pipe ⇒ 渲染进程的 cookie，',
    '    含本地写面闸门所信任的 HttpOnly 持有性证明 cookie。',
    '请从启动方式（快捷方式/脚本/IDE 配置）里去掉这个开关；需要在开发态调试请用 `yarn dev`。',
    `确需放行一次：在真实进程环境里设 ${ALLOW_DEBUG_SWITCHES_ENV}=1，`,
    '应用会在启动日志里写明本次运行的这层保护已关闭。',
    '',
    `Refusing to start: this packaged build was launched with a debugging switch (${listed}).`,
    'Such switches hand any process running as this user full control of the application:',
    '  --inspect / --inspect-brk / --inspect-port / --js-flags => arbitrary code execution in the',
    '    Electron main process, where the enterprise session token lives;',
    '  --remote-debugging-port / --remote-debugging-pipe => the renderer cookies, including the',
    '    HttpOnly proof-of-possession cookie the local write routes trust.',
    'Remove the switch from the launcher/shortcut (or use a development build, e.g. yarn dev).',
    `Deliberate one-off run: set ${ALLOW_DEBUG_SWITCHES_ENV}=1 in the real process environment;`,
    'the app then logs on startup that this protection is off for the run.',
  ].join('\n')
}

/** 拒绝启动时原生错误面的标题（同样中英双写，理由见 {@link debugSwitchRefusalMessage}）。 */
export const DEBUG_SWITCH_REFUSAL_TITLE = '调试开关被拒绝 / Debugging switches are not allowed'

/**
 * 逃生门生效时的启动日志行（**必须留痕**：静默放行等于保护不存在）。
 * @param gate - {@link detectDebugSwitches} 的结果。
 * @returns 日志正文，或 undefined（没开逃生门 / 开了但没有命中）。
 */
export function debugSwitchEscapeLogLine(gate: DebugSwitchGate): string | undefined {
  if (!gate.escaped) return undefined
  const listed = gate.matches.map(match => match.raw).join(' ')
  return `${ALLOW_DEBUG_SWITCHES_ENV} is set: debug switches are allowed for this run (${listed}); `
    + 'any process running as this user can control the application and read its local-API cookies'
}

/** 闸门的副作用接缝（生产实现见 {@link writeStderrSync} 与 `main.ts` 的接线）。 */
export interface DebugSwitchGateIO {
  /** 同步写一行到 stderr（拒绝时 stderr 是唯一还没有窗口的出口）。 */
  write(chunk: string): void
  /** 原生错误面（打包 GUI 没有 stderr 接收方时唯一的用户可见出口）。 */
  showErrorBox(title: string, content: string): void
  /** 立刻退出（非零码）。 */
  exit(code: number): void
}

/** {@link applyDebugSwitchGate} 的结论。 */
export type DebugSwitchVerdict =
  /** 打包态 + 命中 + 无逃生门：已写错误面并请求退出。 */
  | 'refused'
  /** 本次靠逃生门放行（调用方应记 {@link debugSwitchEscapeLogLine}）。 */
  | 'escaped'
  /** 正常放行（开发态，或打包态但没有调试开关）。 */
  | 'allowed'

/**
 * 把判定落到副作用上：**拒绝时必须同时"喊出来"和"退出去"**。
 *
 * 两个副作用都各自 try/catch：原生错误面在无 GUI/受限环境可能抛（比如没有显示
 * 服务器），但那**不能**让进程继续启动 —— 闸门的语义是 fail-loud + fail-closed，
 * 不是"尽力而为"。`exit` 放在最后且不 try/catch（它不该失败；真失败说明进程已不可控）。
 * @param gate - {@link detectDebugSwitches} 的结果。
 * @param io - 副作用接缝（生产接线在 `main.ts`，测试注入假实现）。
 * @returns 结论（拒绝路径返回前已请求退出）。
 */
export function applyDebugSwitchGate(gate: DebugSwitchGate, io: DebugSwitchGateIO): DebugSwitchVerdict {
  if (!gate.refused) return gate.escaped ? 'escaped' : 'allowed'
  const message = debugSwitchRefusalMessage(gate)
  try {
    io.write(`${message}\n`)
  } catch {
    // stderr 不可用（Windows GUI 无控制台）——错误面还有一次机会。
  }
  try {
    io.showErrorBox(DEBUG_SWITCH_REFUSAL_TITLE, message)
  } catch {
    // 原生错误面不可用（无显示器/受限沙箱）——已经写过 stderr，仍然退出。
  }
  io.exit(1)
  return 'refused'
}

/**
 * 生产用的同步 stderr 写（**必须同步**：紧接着就退出，异步写会丢）。
 * @param chunk - 要写的文本。
 */
export function writeStderrSync(chunk: string): void {
  writeSync(2, chunk)
}
