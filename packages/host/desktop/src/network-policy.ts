/**
 * 客户端网络出口策略：**默认禁止使用任何代理**（2026-09-22 定案）。
 *
 * 背景与判据（全部为真机实测，矩阵见 `temp/proxy-probe/REPORT.md`）：
 *  - Chromium 栈（`session.defaultSession.fetch` 的 gatewayFetch、更新检查的 `net.fetch`、
 *    渲染进程的渠道 logo、内置浏览器与 WASM 应用窗口各自的分区）**默认跟随宿主机代理**
 *    （系统代理设置 / 环境变量 / PAC 自动发现），且 `session.setProxy({mode:'direct'})`
 *    只对**单个 session** 生效 —— 分区仍会走代理。
 *  - `app.commandLine.appendSwitch('no-proxy-server')`（**必须在 `app.whenReady()` 之前**）
 *    一次覆盖全部 session 与后建分区，连显式 `--proxy-server` 也压得住。
 *  - 主进程 Node 栈（undici）默认直连，只有宿主机显式 `NODE_USE_ENV_PROXY=1`（Node 22.21+/24+）
 *    时才走环境代理；此时**事后删除代理环境变量无效**（Node 在启动时就构造了 agent），
 *    唯一可用的端内手段是把 undici 的全局 dispatcher 换成直连 Agent。
 *
 * 代价（有意接受）：内置浏览器也失去系统代理 —— 在"只有经代理才能出公网"的办公网里
 * AI 浏览器访问外网会失败（透明代理/TUN 不受影响）。需要保留代理的渠道用
 * `desktop.allow_system_proxy` 或环境变量关掉这条策略。
 * @module dsh-plugin-desktop/network-policy
 */

/** Chromium 侧"永不使用代理"的启动期开关。唯一字面量出处。 */
export const NO_PROXY_SWITCH = 'no-proxy-server'

/**
 * 允许使用宿主机代理的排障开关。
 *
 * 只认**真实进程环境**（`PICOAI_ALLOW_SYSTEM_PROXY=1`）：Chromium 的开关必须在
 * `app.whenReady()` 之前 append，而 Harness home 的 `.env` 分层要到 `start()` 里才加载，
 * 结构上赶不上；部署级的"允许代理"请用渠道包字段。
 */
export const ALLOW_SYSTEM_PROXY_ENV = 'PICOAI_ALLOW_SYSTEM_PROXY'

/**
 * 进程环境里会改变出站路由的代理名。
 *
 * 大小写两套都列：Chromium 在 Linux 读小写，Node 与 curl/git 两套都认，
 * Windows 的环境名大小写不敏感。`NO_PROXY` 也一并清掉 —— 没有代理时它没有任何意义。
 */
export const PROXY_ENV_NAMES: readonly string[] = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
]

/** Node 的"按环境变量走代理"开关（Node 22.21+/24+）。 */
export const NODE_ENV_PROXY_FLAG = 'NODE_USE_ENV_PROXY'

/** 策略来源：显式环境变量 > 渠道包 > 默认（禁止）。 */
export type SystemProxySource = 'environment' | 'channel' | 'default'

/** 本次启动的出口策略判定结果。 */
export interface SystemProxyPolicy {
  /** true = 跟随宿主机代理；false = 强制直连（默认）。 */
  readonly allow: boolean
  /** 判定来自哪一层（用于启动日志与排障）。 */
  readonly source: SystemProxySource
}

/** 渠道包（`build/channel.json`）里与出口策略相关的字段。 */
export interface SystemProxyChannelInput {
  /** `desktop.allow_system_proxy === true` 时才允许代理。 */
  readonly allowSystemProxy?: boolean
}

/**
 * 解析"是否允许使用宿主机代理"。
 *
 * 判定顺序（先到先得）：
 *  1. 进程环境变量 `PICOAI_ALLOW_SYSTEM_PROXY`（显式 `0`/`false` 也生效 —— 它是**双向**开关）；
 *  2. 渠道包 `desktop.allow_system_proxy: true`；
 *  3. 默认：禁止。
 * @param env - 进程环境（只读）。
 * @param channel - 随包渠道内容（可缺省）。
 * @returns 判定结果与来源。
 */
export function resolveSystemProxyPolicy(
  env: Readonly<Record<string, string | undefined>>,
  channel: SystemProxyChannelInput | undefined,
): SystemProxyPolicy {
  for (const name of [ALLOW_SYSTEM_PROXY_ENV, ALLOW_SYSTEM_PROXY_ENV.toLowerCase()]) {
    const value = env[name]
    if (value !== undefined) return { allow: isEnabledFlag(value), source: 'environment' }
  }
  if (channel?.allowSystemProxy === true) return { allow: true, source: 'channel' }
  return { allow: false, source: 'default' }
}

/**
 * 判定一个开关值的真值。空串、`0`、`false`、`no`、`off` 视为关闭，其余非空值视为开启。
 * @param value - 环境变量原文。
 * @returns 是否开启。
 */
export function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
    && normalized !== 'no' && normalized !== 'off'
}

/** `app.commandLine` 里本模块用到的那一面（避免在纯 Node 测试里 import electron）。 */
export interface CommandLineSwitches {
  /** Append one Chromium command-line switch. */
  appendSwitch(name: string): void
}

/**
 * 把策略落到 Chromium 的启动期开关上。**必须在 `app.whenReady()` 之前调用**：
 * 晚于 ready 时 Chromium 已经读过代理配置，append 会静默无效。
 * @param commandLine - `app.commandLine`。
 * @param policy - {@link resolveSystemProxyPolicy} 的结果。
 * @returns 是否真的 append 了开关（true = 本次强制直连）。
 */
export function applySystemProxyPolicy(commandLine: CommandLineSwitches, policy: SystemProxyPolicy): boolean {
  if (policy.allow) return false
  commandLine.appendSwitch(NO_PROXY_SWITCH)
  return true
}

/**
 * 从进程环境里删掉全部代理名与 `NODE_USE_ENV_PROXY`。
 *
 * 为什么必须删：agent 的 shell 子进程（curl / git / npm / MCP stdio）由
 * `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 从 `process.env` 派生，
 * 它只滤敏感名与 `DSH_` 前缀 —— 代理名会原样继承。
 *
 * 注意它**不能**撤销已经装上的 env-proxy agent（Node 在启动时采样该开关），
 * 那一半由 {@link enforceDirectNodeTransport} 负责。
 * @param env - 通常是 `process.env`（原地修改）。
 * @returns 实际被删掉的名字（供启动日志记录，按删除顺序）。
 */
export function stripProxyEnvironment(env: Record<string, string | undefined>): readonly string[] {
  const removed: string[] = []
  for (const name of [...PROXY_ENV_NAMES, NODE_ENV_PROXY_FLAG, NODE_ENV_PROXY_FLAG.toLowerCase()]) {
    if (env[name] === undefined) continue
    removed.push(name)
    // `process.env` 与普通对象都支持 delete。
    Reflect.deleteProperty(env, name)
  }
  return removed
}

/**
 * 环境分层（Harness home 的 `.env`）里配了排障开关、但**已经太晚**时给出可诊断的一行。
 *
 * 判定的时机是模块作用域（Chromium 开关必须早于 ready），而 `.env` 分层要到 `start()`
 * 才加载 —— 所以写在 `.env` 里的 `PICOAI_ALLOW_SYSTEM_PROXY` 结构上不生效。静默无效
 * 是这类"看起来装了闸门"的典型坑，这里把它变成启动日志里的一行。
 * @param env - `loadLayeredEnv()` 之后的 `process.env`。
 * @param policy - 启动时定下的策略。
 * @returns 需要记录的日志正文，或 undefined（没有这种情况）。
 */
export function lateAllowSystemProxyWarning(
  env: Readonly<Record<string, string | undefined>>,
  policy: SystemProxyPolicy,
): string | undefined {
  if (policy.source === 'environment') return undefined
  const enabled = [ALLOW_SYSTEM_PROXY_ENV, ALLOW_SYSTEM_PROXY_ENV.toLowerCase()]
    .some(name => isEnabledFlag(env[name]))
  if (!enabled) return undefined
  return `${ALLOW_SYSTEM_PROXY_ENV} was ignored: it is read from the real process environment before app ready, not from a .env layer`
}

/** undici 里本模块用到的那一面。 */
export interface NodeDispatcherModule {
  /** 直连 agent。 */
  readonly Agent: new () => unknown
  /** 当前全局 dispatcher（仅测试断言用）。 */
  getGlobalDispatcher(): unknown
  /** 安装全局 dispatcher。 */
  setGlobalDispatcher(dispatcher: unknown): void
}

/** {@link enforceDirectNodeTransport} 的判定结果。 */
export type NodeTransportOutcome =
  /** 宿主机没有要求 Node 走环境代理：什么都没做。 */
  | 'not-requested'
  /** 已把全局 dispatcher 换成直连 Agent。 */
  | 'swapped'
  /** 环境要求走代理，但 undici 不可用（打包缺件）：只能按现状继续，并如实记日志。 */
  | 'unavailable'

/**
 * 撤销 Node 的"按环境变量走代理"。
 *
 * 只在 `NODE_USE_ENV_PROXY` 存在且非关闭值时动手 —— 这是 Node 唯一会自动装 env-proxy
 * agent 的入口（我们自己的启动路径从不调用 `installProxyFromEnvironment`）。
 * 换 dispatcher 必须发生在**任何出站请求之前**。
 * @param env - 判定用的环境（`process.env` 的当前快照或 `LaunchEnvironmentSnapshot` 之外的对象）。
 * @param load - undici 加载器，可注入（测试用）。
 * @returns 判定结果。
 */
export async function enforceDirectNodeTransport(
  env: Readonly<Record<string, string | undefined>>,
  load: () => Promise<NodeDispatcherModule> = loadUndici,
): Promise<NodeTransportOutcome> {
  const requested = isEnabledFlag(env[NODE_ENV_PROXY_FLAG])
    || isEnabledFlag(env[NODE_ENV_PROXY_FLAG.toLowerCase()])
  if (!requested) return 'not-requested'
  try {
    const undici = await load()
    undici.setGlobalDispatcher(new undici.Agent())
    return 'swapped'
  } catch {
    return 'unavailable'
  }
}

/** 默认加载器：运行期闭包里已有 undici（`@deepseek-ai/dsh-http-proxy` 的依赖，已显式声明）。 */
async function loadUndici(): Promise<NodeDispatcherModule> {
  // 动态 import：纯 Node 单测不加载它，且打包后按 node_modules 解析。
  return await import('undici') as unknown as NodeDispatcherModule
}

/**
 * {@link enforceDirectTransport} 的注入接缝（**只给测试用**；生产调用点必须省略它，
 * 由 AST 判据要求实参个数恰好为 2）。
 */
export interface DirectTransportEnforcementDeps {
  /** 撤销 Node 的 env-proxy dispatcher（缺省 {@link enforceDirectNodeTransport}）。 */
  readonly enforceNodeTransport?: (env: NodeJS.ProcessEnv) => Promise<NodeTransportOutcome>
  /** 删除代理环境变量（缺省 {@link stripProxyEnvironment}）。 */
  readonly stripEnvironment?: (env: NodeJS.ProcessEnv) => readonly string[]
}

/** {@link enforceDirectTransport} 的执行结论（调用方据此打启动日志）。 */
export interface DirectTransportEnforcement {
  /** 策略是否**禁止**代理。false 时没有任何副作用（调用方只记一行"允许代理"）。 */
  readonly enforced: boolean
  /** Node dispatcher 的处置结果（未强制执行时为 undefined）。 */
  readonly transport: NodeTransportOutcome | undefined
  /** 实际被删掉的代理环境变量名（按删除顺序）。 */
  readonly cleared: readonly string[]
  /** `.env` 分层里那个"太晚"的排障开关说明（没有这种情况时为 undefined）。 */
  readonly lateWarning: string | undefined
}

/**
 * **强制执行"默认禁止代理"**：把策略落到 Node 栈与子进程两侧。
 *
 * 这是 `main.ts` 的 `start()` 里那一段控制流的**唯一实现**（2026-09-25 审计 B1-03）：
 * 早先它是内联在 `start()` 里的一个 `if (!SYSTEM_PROXY_POLICY.allow) { … }` 块，而"这段
 * 真的会跑"当时只有**源码文本位置**判据（`indexOf` 比较），把它掏成 `if (false && …)`
 * 后 18/18 全绿、真机探针也不经过这段控制流 ⇒ Node 栈与子进程侧的代理剥离可以静默失效。
 * 抽成可调用函数后，"执行过一次 ⇒ 副作用真的发生"变成注入假 deps 就能断言的行为判据。
 *
 * `deps` 是**测试接缝**，不是生产参数（2026-09-26 复审 B-1）：判据全部注入 deps 时，
 * "缺省值是不是真实现"在单测里完全不可见 —— 把两个 `??` 的右侧换成 no-op、或在
 * `main.ts` 的调用点上多喂一个 no-op 第三实参，都会让生产**静默空转**（三个代理环境
 * 变量一个没删、dispatcher 没换、启动日志一行不打）而门禁全绿。现在的两道闸：
 *   * 缺省路径本身有一条**不注入 deps** 的行为判据（`tests/network-policy.spec.ts`
 *     直接断言 dispatcher 的对象身份变了、环境变量真被删了）；
 *   * 生产调用点的 AST 判据要求**实参个数恰好为 2**。
 *
 * 顺序有语义（每一步都依赖**删除前**的环境）：
 *  1. {@link enforceDirectNodeTransport}：Node 在**启动时**按 `NODE_USE_ENV_PROXY` 装好了
 *     走代理的全局 dispatcher，只能是换掉它（旧行为的判据也要在这个变量被删之前读）；
 *  2. {@link lateAllowSystemProxyWarning}：看的是 `.env` 分层注入的排障开关（同样不能被
 *     第 3 步影响）；
 *  3. {@link stripProxyEnvironment}：子进程（agent 的 curl/git/MCP stdio）由
 *     `scrubbedParentEnv()` 从 `process.env` 派生，删掉代理名它们才真正直连。
 * @param env - 通常是 `process.env`（第 3 步**原地修改**它）。
 * @param policy - {@link resolveSystemProxyPolicy} 的结果。
 * @param deps - 注入接缝（**只给测试用**；生产调用点不得传第三个实参，见函数头）。
 * @returns 执行结论；**策略允许代理时一个副作用都不产生**（`enforced: false`）。
 */
export async function enforceDirectTransport(
  env: NodeJS.ProcessEnv,
  policy: SystemProxyPolicy,
  deps: DirectTransportEnforcementDeps = {},
): Promise<DirectTransportEnforcement> {
  if (policy.allow) {
    return { enforced: false, transport: undefined, cleared: [], lateWarning: undefined }
  }
  const enforceNodeTransport = deps.enforceNodeTransport ?? (target => enforceDirectNodeTransport(target))
  const stripEnvironment = deps.stripEnvironment ?? stripProxyEnvironment
  const transport = await enforceNodeTransport(env)
  const lateWarning = lateAllowSystemProxyWarning(env, policy)
  const cleared = stripEnvironment(env)
  return { enforced: true, transport, cleared, lateWarning }
}
