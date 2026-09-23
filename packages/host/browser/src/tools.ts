/**
 * Model-facing `browser_*` tool suite v4 over the grouped browser runtime.
 * This module owns schemas, argument validation, prompt guidance, group
 * permission checks (every call resolves its session group; cross-group tab
 * references are rejected) and semantic presentation; execution delegates to
 * the BrowserRuntime.
 * @module @picoaide/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { BrowserRuntime, type WaitForOptions } from './runtime.ts'
import { browserError } from './errors.ts'
import type { BrowserSurface } from './surface.ts'
import { httpOriginOf } from './credential-site.ts'
import { snapshotNote } from './snapshot.ts'
import { BROWSER_TOOL_TIMEOUT_MS, BROWSER_WAIT_FOR_DEADLINE_MS, TOOL_DEADLINE_MARGIN_MS, WAIT_FOR_MAX_MS } from './budgets.ts'
import type { BrowserWaitUntil } from './types.ts'

/** Valid waitUntil values for navigation tools. */
const WAIT_UNTILS: readonly BrowserWaitUntil[] = ['domcontentloaded', 'load', 'networkidle']

const WAIT_CONDITIONS = ['element-present', 'element-visible', 'text-appear', 'url-change', 'network-idle', 'settled'] as const

/** Tool guidance band shown to the model (v4 wording). */
const BROWSER_GUIDANCE = `You have an embedded browser shared with the user. Rules:
1. Start with browser_open (url optional), then browser_navigate. browser_get_snapshot lists numbered interactable elements; target them by number or CSS selector.
2. After navigation or any page change, take a fresh snapshot — pages re-render and renumber.
3. browser_screenshot only for visual confirmation; snapshots/text are cheaper. browser_eval runs one expression (a heuristic guardrail rejects statements/assignments and eval/Function; fetch/XHR and any page JS are allowed) and returns its resolved value — promise results are awaited.
4. The user may take over the browser at any time from the browser window. Your queued actions then wait; only the user gives control back — never ask for it back, there is no tool for that, so do not fight the user. While the user holds control your browser actions fail with a 'window-controlled' error saying the user is operating the browser: that is NOT a broken page — ask the user to hand control back from the browser window, then retry (browser_list_tabs reports the same state).
5. Use wait_for before acting on dynamic pages (SPAs) instead of sleeping.
6. Bookmarks/history/downloads are shared with the user; save important pages with bookmarks_add; check your results via downloads_list (paths are usable by file tools).
7. Close tabs you no longer need with browser_close_tab. Tabs are GLOBAL: every session and the user share one tab pool.`

/** Resolve `target` (snapshot number or CSS selector) to a selector. */
async function resolveTarget(runtime: BrowserRuntime, tabId: number, target: number | string, signal?: AbortSignal): Promise<string> {
  if (typeof target === 'string') {
    if (target.trim() === '') throw new Error('target selector must not be empty')
    return target.trim()
  }
  if (!Number.isInteger(target) || target < 1) throw new Error('target number must be a positive integer')
  const snapshot = await runtime.snapshot(tabId, signal)
  const entry = snapshot.find((item) => item.index === target)
  if (entry === undefined) {
    throw browserError('not-found', `browser: no snapshot element ${target} — call browser_get_snapshot first (${snapshot.length} elements)`)
  }
  return entry.selector
}

/** Present a pending browser operation as a generic card. */
function present(title: string): (args: unknown) => GenericCallView {
  return (args) => ({ card: 'generic', kind: 'other', title, rawInput: args as Record<string, unknown> })
}

/**
 * 真正**声明**了 `app_id` 参数的工具（§16.1：应用窗口只能显式寻址）。
 *
 * 今天只有 `browser_navigate` 分派到应用 surface。这份名单与 {@link guardStrayAppId}
 * 合起来构成同一条事实的两个方向：在名单里的工具必须**真的**把操作落到那个 surface
 * 自己的 `webContents` 上；不在名单里的工具收到 `app_id` 必须 fail-loud。
 */
const APP_SURFACE_TOOLS: ReadonlySet<string> = new Set(['browser_navigate'])

/**
 * 一次调用的落点（§16.1）：要么是某个**应用窗口 surface**，要么是某个**浏览器标签**。
 *
 * 判别联合而不是"tab id"：错目标的缺陷之所以能发生，就是因为应用窗口被降级成了一个
 * 数字，落回浏览器标签时没有任何类型能拦住。工具实现必须按 `kind` 分派。
 */
type SurfaceTarget =
  | { kind: 'app', surface: BrowserSurface }
  | { kind: 'browser-tab', tab: number }

/**
 * 把"给不接受 `app_id` 的工具传了 `app_id`"变成**明确的结构化错误**。
 *
 * 为什么必须有这道闸（与 `browser_navigate` 的 P1 同族，2026-09-21）：上游工具参数
 * schema 的 `additionalProperties` 是**未声明**（宽松）的 —— 模型传一个未声明的
 * `app_id` 不会在参数校验处被拦下，而是原样进入 `execute` 后被**忽略**，操作便落在
 * **浏览器标签**上，而模型以为自己驱动的是应用窗口。对 snapshot / get_text / eval /
 * screenshot / wait_for / reload / close 这些工具，这就是同一族的静默错目标；唯一
 * 正确的行为是拒绝，并把"该怎么寻址"告诉模型。
 *
 * 包装发生在**注册点**：这是所有工具（含以后新加的）唯一的共同入口，逐工具手写检查
 * 必然漏。
 * @param definition - `defineTool` 产出的定义。
 * @returns 带参数闸门的定义（在名单里的工具原样返回）。
 */
function guardStrayAppId(definition: ReturnType<typeof defineTool>): ReturnType<typeof defineTool> {
  if (APP_SURFACE_TOOLS.has(definition.name)) return definition
  const inner = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      const appId = (args as { app_id?: unknown } | null | undefined)?.app_id
      if (typeof appId === 'string' && appId !== '') {
        throw browserError('policy', `${definition.name} cannot act on an application window (app_id ${JSON.stringify(appId)}) — only browser_navigate dispatches to application windows today; every other tool addresses browser tabs (browser_list_tabs lists both kinds)`)
      }
      return await inner(args, exec)
    },
  }
}

/**
 * Read the verdict of the operation that just finished back out of the runtime's
 * own op log (2026-09-15 审计 P2).
 *
 * `browser_press` 的页内兜底脚本在"没有任何元素能接收按键"时只返回 'none'，
 * 而 `runtime.pressKey` 不把这个结果交给调用方：它写进 op log 的 `failed` 标记，
 * 工具却无条件回 `{ok:true}` —— 模型据此认为按键生效了，oplog/活动面板也记成功。
 * 这里按 `browser_type` 的读回口径把这个页内否定结果变成明确的失败。
 *
 * `runtime.opLog` 是**最新在前**的，所以 `find` 拿到的就是本次调用刚写的那条；
 * 工具调用在全局互斥里串行，中间不会插进同一 tool+tab 的记录。
 */
function assertNoFailedOp(runtime: BrowserRuntime, tabId: number, tool: string, message: string): void {
  const entry = runtime.opLog.find((op) => op.tool === tool && op.tab === tabId)
  if (entry !== undefined && entry.failed === true) throw browserError('not-found', message)
}

/**
 * 站点绑定（2026-09-15 审计 BUG-03）。
 *
 * 现场：`browser_fill_credentials` 只按 connectorId 解析就把用户名/口令写进
 * **当前文档**——模型可以先把标签页开到任意站点再注入，凭据就落进了另一个
 * origin 的登录框（钓鱼页天然受益）。
 *
 * 这里在调用 runtime 之前把 `new URL(tab.url).origin` 与 connector 的站点
 * origin 比对；不一致、记录里没有可用 URL、或部署没提供基准，一律拒绝。
 *
 * 基准挂在凭证解析器上（与既有的 `resolver.list` 同一形状：
 * `resolveCredentials.originOf = …` / `urlOf = …`），由 index.ts 注入，取值
 * 逻辑唯一实现在 credential-site.ts（显式配置 → 凭据字段里的地址）。
 */
interface OriginAwareCredentialResolver {
  originOf?: (connectorId: string) => Promise<string | null | undefined> | string | null | undefined
  urlOf?: (connectorId: string) => Promise<string | null | undefined> | string | null | undefined
}

/** Refuse the injection when the tab's origin is not the connector's origin. */
async function assertCredentialOrigin(runtime: BrowserRuntime, tabId: number, connectorId: string): Promise<string> {
  const resolver = (runtime as unknown as { credentials?: OriginAwareCredentialResolver }).credentials
  const lookup = resolver?.originOf ?? resolver?.urlOf
  // fail-closed（BUG-03）：能力缺席**不再**等于"放行"。旧实现在部署没注入 origin
  // 能力时直接 return，工具对外宣称的 SITE-BOUND 就只是文档承诺 —— 模型把标签页
  // 开到钓鱼页即可拿到连接器凭据。现在拿不到基准就拒绝，并在错误里说明怎么登记站点。
  if (resolver === undefined || lookup === undefined) {
    throw browserError('policy', 'browser_fill_credentials refused: this deployment exposes no connector site URL, so the credential injection cannot be bound to an origin. Enter the value with browser_type instead, and ask the user (or the deployment) to record the connector\'s site address as a base-URL field or a credentialSites entry.')
  }
  const expected = httpOriginOf(await lookup.call(resolver, connectorId))
  if (expected === null) {
    throw browserError('policy', `browser_fill_credentials refused: the stored connector record for ${JSON.stringify(connectorId)} has no usable http(s) site URL, so the injection cannot be bound to an origin. Enter the value with browser_type instead, and ask the user to record the connector's site address (a base-URL field) or declare it in the browser plugin's credentialSites config.`)
  }
  // 原始 URL 派生（runtime.tabOrigin），**不得**读 tabState() 的脱敏投影：投影会把
  // 注入过的口令逐字擦成 `****`，口令恰好落在主机名里时（≥8 字符）origin 本身被改写，
  // 同 origin 的后续注入会被永久误拒并回显畸形主机（2026-09-17 审计 S02-01）。
  // 与 runtime.fillCredentials 临界区内的 TOCTOU 复核同源。
  const actual = runtime.tabOrigin(tabId)
  if (actual === null) {
    // 非 http(s) 文档（客户端内部协议、about:、file: …）没有可绑定站点 ⇒ 如实降级：
    // 拒绝注入 + 说清出路，而不是让模型以为"页面没加载好"而反复重试。
    // 文案不出现被观测 URL（S02-01 口径）。
    throw browserError('policy', `browser_fill_credentials refused: this tab has no http(s) origin, while connector ${JSON.stringify(connectorId)} is bound to ${expected}. Credential autofill applies to http(s) sites only — a non-http(s) document has no site a stored credential can be bound to, so nothing was injected. Enter the value with browser_type instead, or navigate the tab to ${expected} first.`)
  }
  if (actual !== expected) {
    // 比对用 raw origin（runtime.tabOrigin），文案里**一个字节的被观测 origin 都不出现**
    // （2026-09-17 三轮对抗复核 S02-01 残留）：被观测方是页面影响的不可信侧 —— 页面可以把
    // 注入过的口令拼进弹窗/跳转主机名（https://<口令>.evil.example），而任何"投影后再回显"
    // 的写法都挡不住它：URL 解析把主机名折叠成小写（口令 Sup3rSecret 变成 sup3rsecret），
    // 逐字脱敏是按大小写敏感的 indexOf 匹配；<8 字符的口令又只按整 token 匹配（`.`/`-`/`_`
    // 都算词字符），于是短口令原样回显。模型只需要知道"不是这个站点"以及该去哪儿，
    // 所以文案只保留连接器 id 与**用户自己登记**的期望 origin（可信侧）。
    throw browserError('policy', `browser_fill_credentials refused: this tab is not on the site connector ${JSON.stringify(connectorId)} is bound to (${expected}). Credentials are only injected into their own site — a look-alike page must not receive them; navigate the tab to ${expected} first.`)
  }
  return expected
}

/** Result meta projection helpers. */
function metaFrom(value: JsonValue): JsonValue {
  return value
}

/** Snapshot the calling agent's identity (oplog attribution). */
function noteAgent(runtime: BrowserRuntime, agent: unknown): void {
  const id = (agent as { id?: string } | undefined)?.id
  runtime.setAgentContext(id)
}

/** The live agent/session shape inspected for the workspace path (defensive —
 * fields vary across DSH versions). */
interface AgentProjectInfo {
  id?: string
  session?: {
    header?: { cwd?: string }
    meta?: { cwd?: string }
    cwd?: string
  }
}

/** Upload whitelist: downloads dir (always) + the calling session's cwd. */
function uploadAllowDirs(runtime: BrowserRuntime, session: AgentProjectInfo['session']): string[] {
  const dirs = [runtime.options.downloadDir]
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') dirs.push(cwd.trim())
  return dirs
}

/**
 * Register the full browser tool suite (v4, 31 tools: `browser_release` was
 * removed by the 2026-09-15 audit — only the user's 交给 AI button may end the
 * user gate).
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations.
 * @param runtime - the grouped embedded browser runtime.
 * @returns a disposer that unregisters every tool + the guidance section. The
 *   caller MUST run it from the plugin fiber (`ctx.effect`): the registry's
 *   own disposers are not effect-scoped here, so dropping them left 32 tools
 *   registered against a disposed runtime (P2-29).
 */
export function applyBrowserTools(ctx: Context, runtime: BrowserRuntime, enabledGroups: ReadonlySet<string> = DEFAULT_GROUPS): () => void {
  const disposers: Array<() => void> = []
  // Dedicated helper so per-group enablement (enterprise policy, P2) filters
  // registrations without changing the tool definitions.
  const register = (definition: ReturnType<typeof defineTool>): void => {
    const group = GROUP_OF[definition.name] ?? 'control'
    if (enabledGroups.has(group)) disposers.push(ctx.tools.register(guardStrayAppId(definition)))
  }
  disposers.push(ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 111,
    text: BROWSER_GUIDANCE,
  }))

  const tabOf = async (tab: number | undefined): Promise<number> => {
    return runtime.resolveTab(tab)
  }

  /**
   * 本次调用的 deadline（epoch ms）—— BR-3（2026-09-23）。
   *
   * 先例是 `browser_wait_for` 的 `startedAt + BROWSER_WAIT_FOR_DEADLINE_MS − 1000`。
   * 注册预算在**调度时刻**武装，而工具拿到执行权之前可能已经排过队；所以 deadline
   * 在 `execute` 入口算出后交给 runtime，由它按**剩余额度**收紧临界区内的加载等待
   * （`loadBoundMs`）。这样"排队 + 用户闸 + 槽位 + 真正加载"之和不会再超过注册预算，
   * 上游 timeout-policy 就不会把工具自己的、可执行的结果换成笼统超时。
   * @param startedAt - 调用开始时刻（测试可注入）。
   */
  const callDeadline = (startedAt: number = Date.now()): number =>
    startedAt + BROWSER_TOOL_TIMEOUT_MS - TOOL_DEADLINE_MARGIN_MS

  /**
   * 显式应用窗口寻址（§16.1 冻结）：只有 `app_id` 能把操作指向应用窗口。
   *
   * 为什么做成"必须显式"：默认寻址指向浏览器当前标签，是唯一不会误伤的安全默认
   * —— 用户可能正拿着某个应用窗口的控制权，而模型"顺手"操作它是最危险的行为。
   * @param appId - 模型给的 `app_id`（可选）。
   * @returns 应用 surface；没有注册过这个 app_id ⇒ 明确报错（不回落浏览器标签）。
   */
  const appSurfaceOf = (appId: string): BrowserSurface => {
    runtime.syncSurfaces?.()
    const registry = runtime.surfaces
    const surface = registry?.appSurface(appId)
    if (surface === undefined) {
      throw browserError('not-found', `browser: no open application window for app_id ${JSON.stringify(appId)} — call browser_list_tabs to see open surfaces (an application window must be opened from the app center first)`)
    }
    return surface
  }

  /**
   * 把模型给的寻址解析成**一个明确的落点**（§16.1）。
   *
   * 这是"应用窗口 ≠ 浏览器标签"的唯一分派点：`app_id` ⇒ 解析成那个 surface 自己的
   * 目标（{@link SurfaceTarget}），否则才是浏览器标签。此前这里把 `app_id` 校验完就
   * 丢掉、直接返回浏览器当前标签 —— 模型以为自己驱动应用窗口，实际导航了用户的浏览器
   * 标签（P1，2026-09-21）。
   * @param args - 模型的 `tab` / `app_id`。
   * @returns 明确的目标（应用 surface 或浏览器标签 id）。
   */
  const resolveSurfaceTarget = async (args: { tab?: number | undefined, app_id?: string | undefined }): Promise<SurfaceTarget> => {
    const appId = args.app_id
    if (typeof appId === 'string' && appId !== '') {
      if (args.tab !== undefined) {
        // 矛盾的寻址：宁可拒绝，也不要"随便挑一个"（注册表与 resolve() 同一口径）。
        throw browserError('policy', `browser: ambiguous target — pass either tab (browser tab) or app_id (application window), not both (tab=${String(args.tab)} app_id=${JSON.stringify(appId)})`)
      }
      return { kind: 'app', surface: appSurfaceOf(appId) }
    }
    return { kind: 'browser-tab', tab: await tabOf(args.tab) }
  }

  // ----------------------------------------------------------- Navigate (8)

  register(defineTool({
    name: 'browser_open',
    description: '[navigate] Open the browser (shared single tab pool) and optionally navigate a new tab to a URL. Use this as the first browser action.',
    parameters: {
      url: { type: 'string', description: 'Optional URL to open in the new tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tab: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: formatTabOpened(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Open browser'),
    async execute(args, exec) {
      const { url } = args as { url?: string }
      noteAgent(runtime, exec.agent)
      // BR-3（2026-09-23）：deadline 在 dispatch 时刻算好 —— 排队、等用户闸、等槽位
      // 花掉的时间会从"真正加载"的额度里扣掉，内部等待之和不再能超过注册预算。
      const tab = await runtime.open(url, exec.signal, false, undefined, callDeadline())
      exec.signal.throwIfAborted()
      return { tab: tab.id, url: tab.url, title: tab.title }
    },
  }))

  register(defineTool({
    name: 'browser_navigate',
    description: '[navigate] Navigate a tab of your session to a URL (http/https only).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      app_id: { type: 'string', description: 'Address an OPEN application window instead of a browser tab (design §16.1: application windows are never the default target).' },
      url: { type: 'string', required: true, description: 'The URL to navigate to.' },
      waitUntil: { type: 'string', enum: WAIT_UNTILS, description: 'Load milestone to wait for (default domcontentloaded).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' }, title: { type: 'string' }, loading: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: formatNavigation(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Navigate'),
    async execute(args, exec) {
      const { tab, app_id: appId, url, waitUntil } = args as { tab?: number; app_id?: string; url: string; waitUntil?: BrowserWaitUntil }
      if (typeof url !== 'string' || url.trim() === '') throw new Error('url must be a non-empty string')
      noteAgent(runtime, exec.agent)
      // §16.1 寻址：给了 app_id ⇒ **这个应用窗口自己的 webContents**；否则默认指向
      // 浏览器当前标签。两条路径的返回值形状一致（url/title/loading），但落点绝不互换。
      const target = await resolveSurfaceTarget({ tab, ...(appId === undefined ? {} : { app_id: appId }) })
      if (target.kind === 'app') {
        const state = await runtime.navigateAppSurface(target.surface, url.trim(), waitUntil ?? 'domcontentloaded', exec.signal, callDeadline())
        exec.signal.throwIfAborted()
        return state
      }
      await runtime.navigate(target.tab, url.trim(), waitUntil ?? 'domcontentloaded', exec.signal, false, callDeadline())
      exec.signal.throwIfAborted()
      const state = runtime.tabState(target.tab)
      return { url: state.url, title: state.title, loading: state.loading }
    },
  }))

  register(defineTool({
    name: 'browser_reload',
    description: '[navigate] Reload a tab of your session.',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Reloaded ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Reload page'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.reload(tabId, exec.signal, false, callDeadline())
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_go_back',
    description: '[navigate] Navigate back in a tab of your session.',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Back to ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Go back'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.goBack(tabId, exec.signal, false, callDeadline())
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_go_forward',
    description: '[navigate] Navigate forward in a tab of your session.',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Forward to ${String((value as { url?: string }).url ?? '')}` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Go forward'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.goForward(tabId, exec.signal, false, callDeadline())
      exec.signal.throwIfAborted()
      return { url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_list_tabs',
    description: '[navigate] List ALL tabs of the shared browser pool (every session and the user share one pool) with ids, urls, titles and the active marker. Also reports whether the USER currently holds control: while they do, every other browser tool of yours is refused — ask the user to hand control back from the browser window instead of retrying.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                // §16.1：kind/app_id 是 AI 寻址的schema 面 —— 没有它，模型无法区分
                // "浏览器标签"与"应用窗口"，而默认寻址只指向前者。
                kind: { type: 'string', description: '"browser-tab" or "app".' },
                app_id: { type: 'string', description: 'Application id (only for kind="app"; pass it as app_id to address that window).' },
                url: { type: 'string' },
                title: { type: 'string' },
                loading: { type: 'boolean' },
                active: { type: 'boolean' },
                // BR-2（2026-09-23）：自动崩溃恢复放弃之后，模型必须能看见"这个
                // 标签不会再自己回来了，用 browser_reload 显式重试"。
                crashed: { type: 'boolean', description: 'Automatic crash recovery gave up on this tab (the page kept killing its renderer). Nothing reloads it any more — retry explicitly with browser_reload.' },
              },
            },
          },
          // 2026-09-16：控制权状态必须对模型可见。此前只有"操作被拒"这一条出口，
          // 而且（闸门预算比工具预算长时）连那条出口都被 timeout-policy 吞掉，
          // 模型只能靠猜。list_tabs 是不走闸门的只读工具，是唯一任何时候都能问的
          // "现在谁在开浏览器"。
          control: {
            type: 'object',
            additionalProperties: false,
            properties: {
              controlled: { type: 'boolean', description: 'The user holds control of the BROWSER window: your other browser tools are refused until the user hands control back from the browser window.' },
              busy: { type: 'boolean', description: 'A browser operation (yours or the user\'s) is running right now.' },
              busyTool: { type: 'string', description: 'Name of the running tool (empty when idle).' },
              awaitingRelease: { type: 'boolean', description: 'One of your browser calls was already refused because the user holds control — the user must hand control back from the browser window before you can continue.' },
              awaitingReleaseTool: { type: 'string', description: 'The tool whose call was refused (empty when nothing is waiting).' },
              // §16.1 第 3 条：控制权按 surface 记。应用窗口的用户闸不会拦住浏览器
              // 标签，所以它必须与 `controlled` 分开报 —— 否则模型会把"某个应用窗口
              // 归人"误读成"整个浏览器都不能动"。
              userHeldSurfaces: {
                type: 'array',
                description: 'Application windows the USER currently holds (take-over). Your browser_navigate calls against these app_ids are refused until the user clicks "Hand back to AI" in that window; browser tabs are unaffected.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'integer', description: 'Surface id.' },
                    appId: { type: 'string', description: 'Application id (pass it as app_id to browser_navigate).' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatTabs(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List tabs'),
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      // 浏览器台账只含浏览器标签；应用窗口单独列出（kind='app' + app_id），
      // **不占 maxTabs、不进浏览器台账**（§16.1）。
      runtime.syncSurfaces?.()
      const tabs = runtime.listTabs()
      const browserTabs = tabs.map((t) => ({
        id: t.id,
        kind: 'browser-tab',
        app_id: '',
        url: t.url,
        title: t.title,
        loading: t.loading,
        active: t.visible,
        crashed: t.crashed,
      }))
      const appTabs = (runtime.surfaces?.appSurfaces() ?? []).map(surface => ({
        id: surface.id,
        kind: 'app',
        app_id: surface.appId ?? '',
        url: '',
        title: '',
        loading: false,
        active: false,
        // 应用窗口不在浏览器标签池里、也没有"崩溃自动重载"，所以恒为 false
        // （字段在两个 kind 上都存在，模型不需要按行判形状）。
        crashed: false,
      }))
      return {
        tabs: [...browserTabs, ...appTabs],
        control: runtime.controlState(),
      }
    },
  }))

  register(defineTool({
    name: 'browser_switch_tab',
    description: '[navigate] Make a tab of your session its active tab.',
    parameters: { tab: { type: 'integer', required: true, description: 'Your tab id to activate.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tab: { type: 'integer' }, url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Switched to tab ${String((value as { tab?: number }).tab ?? '')}.` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Switch tab'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = (args as { tab: number }).tab
      await runtime.switchTab(tabId, false, exec.signal)
      exec.signal.throwIfAborted()
      return { tab: tabId, url: runtime.tabState(tabId).url }
    },
  }))

  register(defineTool({
    name: 'browser_close_tab',
    description: '[navigate] Close a tab of the shared pool (defaults to your active tab).',
    parameters: { tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Tab closed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Close tab'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      await runtime.closeTab(tabId, false, exec.signal)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  // ---------------------------------------------------------- Interact (7)

  const interactSpecs: Array<{
    name: string
    title: string
    description: string
    run: (r: BrowserRuntime, id: number, sel: string, signal: AbortSignal | undefined, args: Record<string, unknown>) => Promise<unknown> | unknown
  }> = [
    { name: 'browser_click', title: 'Click', description: '[interact] Click an element of your tab (snapshot number or CSS selector).', run: (r, id, sel, signal) => (async () => {
      const point = await r.locateElement(id, sel, signal)
      await r.clickAt(id, point, signal)
      return { ok: true }
    })() },
    { name: 'browser_type', title: 'Type', description: '[interact] Type text into an input of your tab (snapshot number or CSS selector); clears the field first by default.', run: (r, id, sel, signal, args) => r.typeInto(id, sel, String((args as { text: string }).text), (args as { clear?: boolean }).clear !== false, signal) },
    { name: 'browser_select', title: 'Select option', description: '[interact] Select an option in a dropdown of your tab (snapshot number or CSS selector).', run: (r, id, sel, signal, args) => r.selectOption(id, sel, (args as { value: string }).value, signal) },
  ]
  for (const spec of interactSpecs) {
    register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: {
        tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
        target: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true, description: 'Snapshot element number or CSS selector.' },
        ...(spec.name === 'browser_type' ? { text: { type: 'string', required: true, description: 'The text to type (any Unicode).' }, clear: { type: 'boolean', description: 'Clear the field before typing (default true).' } } : {}),
        ...(spec.name === 'browser_select' ? { value: { type: 'string', required: true, description: 'The option value to select.' } } : {}),
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
        render: () => [{ type: 'text', text: `${spec.title}.` }],
      },
      timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      presentCall: present(spec.title),
      async execute(args, exec) {
        noteAgent(runtime, exec.agent)
        const tabId = await tabOf((args as { tab?: number }).tab)
        const selector = await resolveTarget(runtime, tabId, (args as { target: number | string }).target, exec.signal)
        await spec.run(runtime, tabId, selector, exec.signal, args)
        exec.signal.throwIfAborted()
        return { ok: true }
      },
    }))
  }

  register(defineTool({
    name: 'browser_press',
    description: '[interact] Press a key in your tab (Enter, Tab, Escape, Backspace, Delete, Arrows, Home, End, PageUp, PageDown, space). Fails (not-found) when the page had no element able to receive the key, so a "pressed" result always means the key reached the document.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      key: { type: 'string', required: true, description: 'The key to press.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Key pressed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Press key'),
    async execute(args, exec) {
      const { tab, key } = args as { tab?: number; key: string }
      if (typeof key !== 'string' || key.length === 0) throw new Error('key must be a non-empty string')
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      await runtime.pressKey(tabId, key, exec.signal)
      exec.signal.throwIfAborted()
      assertNoFailedOp(runtime, tabId, 'browser_press', `browser: the key press was not delivered — the page had no element to receive "${key}" (nothing was focused and there is no body)`)
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'browser_scroll',
    description: '[interact] Scroll your tab by a vertical delta, or bring a snapshot element into view. A target that does not exist on the page fails (not-found) instead of reporting a successful scroll.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      deltaY: { type: 'integer', description: 'Vertical scroll amount in pixels (negative scrolls up).' },
      target: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: 'Snapshot element number or CSS selector to bring into view.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Scrolled.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Scroll'),
    async execute(args, exec) {
      const { tab, deltaY, target } = args as { tab?: number; deltaY?: number; target?: number | string }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      const selector = target === undefined ? undefined : await resolveTarget(runtime, tabId, target, exec.signal)
      // 2026-09-15 审计 P2：`runtime.scroll` 的页内脚本在元素不存在时只返回
      // 'not found'，而 runtime 丢弃了这个返回值、照常记一条成功——工具于是回
      // {ok:true}，模型以为滚过去了。工具层用一次与 browser_type 同口径的真实
      // DOM 读回（locateElement 就是 `document.querySelector` + 判定，且顺带做了
      // 它要求的 scrollIntoView）把否定结果变成明确的 not-found 失败。
      //
      // 诚实边界：读回之后元素若恰好消失，runtime 那一层仍会静默成功——要彻底
      // 关掉得让 `runtime.scroll` 返回页内判定（runtime 生命周期文件本轮冻结）。
      if (selector !== undefined) await runtime.locateElement(tabId, selector, exec.signal)
      await runtime.scroll(tabId, deltaY ?? 0, selector, exec.signal)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'browser_fill_form',
    description: '[interact] Fill a form of your tab by field names/labels/placeholders (batch) and optionally submit. Prefer over multiple type calls.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      fields: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', required: true, description: 'Input name/id/placeholder/aria-label or label text.' },
            value: { type: 'string', required: true, description: 'Value to fill.' },
          },
        },
      },
      submit: { type: 'boolean', description: 'Submit the enclosing form after filling (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filled: { type: 'integer' },
          submitted: { type: 'boolean' },
          // 逐字段结果（2026-09-15 审计 BUG-04）：没匹配上、或写了但读回不一致
          // 的字段名。旧的"盲计数"让模型以为整批都填好了。
          missed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatFillForm(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Fill form'),
    async execute(args, exec) {
      const { tab, fields, submit } = args as { tab?: number; fields: Array<{ field: string; value: string }>; submit?: boolean }
      if (!Array.isArray(fields) || fields.length === 0) throw new Error('fields must be a non-empty array')
      for (const f of fields) {
        if (typeof f?.field !== 'string' || typeof f?.value !== 'string') throw new Error('each field must have string field and value')
      }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      return await runtime.fillForm(tabId, fields, submit === true, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_upload_file',
    description: '[interact] Upload local files through the page file input (default first input[type=file]; no dialogs). Only paths inside the downloads dir or the current workspace are allowed.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Absolute paths to upload (allowed: downloads dir + current workspace).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { uploaded: { type: 'integer' } } },
      render: (_args, value) => [{ type: 'text', text: `Uploaded ${String((value as { uploaded?: number }).uploaded ?? 0)} file(s).` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Upload file'),
    async execute(args, exec) {
      const { tab, paths } = args as { tab?: number; paths: string[] }
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty array of absolute paths')
      const allowedDirs = uploadAllowDirs(runtime, (exec.agent as AgentProjectInfo | undefined)?.session)
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      return await runtime.uploadFile(tabId, paths, exec.signal, allowedDirs)
    },
  }))

  // -------------------------------------------------------------- Read (5)

  register(defineTool({
    name: 'browser_get_snapshot',
    description: '[read] List the numbered interactable elements of your tab (links, buttons, inputs, selects, textareas) plus page header info (url/title). Numbers are the targets for click/type/select/scroll. Password fields are listed (number/selector usable) but never expose their value: the text reads the field label or "(password field)". On a tab that received credentials through browser_fill_credentials, the injected values are masked (****) in the element text, url and title — VERBATIM occurrences only (a value the page transformed is not covered). The list is bounded: when it was cut, or when the page contains sub-frames / shadow roots whose content this snapshot does NOT include, `truncated`/`total`/`note` say so — an absent element is not proof it does not exist.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                kind: { type: 'string' },
                text: { type: 'string' },
                selector: { type: 'string' },
                visible: { type: 'boolean' },
                disabled: { type: 'boolean' },
              },
            },
          },
          url: { type: 'string' },
          title: { type: 'string' },
          // 2026-09-15 审计 P2：截断/盲区必须对模型可见（旧实现到上限直接
          // break，输出既没有命中总数也没有截断标记，模型会把不完整的列表当完整）。
          truncated: { type: 'boolean', description: 'The element list itself was cut at the limit — the note also reports sub-frames/shadow roots that are not included at all (those do not set this flag).' },
          total: { type: 'integer', description: 'Interactable elements found on the page (a lower bound when the note says "at least").' },
          note: { type: 'string', description: 'Readable explanation of any truncation/blind spot, when present.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Page snapshot'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      const { elements, meta } = await runtime.snapshotWithMeta(tabId, exec.signal)
      exec.signal.throwIfAborted()
      const state = runtime.tabState(tabId)
      // R7（2026-09-13）P0：`selector` 由页面可控的 id/class 拼成（`el.id = password`
      // 时就是 `#<口令>`），必须与 text 同口径做值级擦除，否则它是唯一还能逐字回传
      // 口令的模型面出口。只擦模型看到的这一份：按编号点击走 `resolveTarget` 内部
      // 的未擦除快照，交互不受影响（拿被擦除的 selector 当 CSS 选择器会失败，
      // 属可接受代价）。
      //
      // R7 续（2026-09-13）：selector 是机器串不是散文，按 verbatim 口径擦——否则
      // 短口令（`abc123`）在 `#abc123` 里既不是 assignment 也不是带键名的引号值，
      // 会被散文规则放过，而同一 selector 在交互错误文案里（verbatim）已经打码：
      // 同一个出口两套口径。verbatim 的整 token 规则不会误伤 `/test-report`。
      const safeElements = elements.map((element) => {
        const selector = runtime.redactTabSecrets(tabId, element.selector, { verbatim: true })
        return selector === element.selector ? element : { ...element, selector }
      })
      const note = snapshotNote(meta)
      return {
        elements: safeElements,
        url: state.url,
        title: state.title,
        truncated: meta.truncated,
        total: meta.total,
        ...(note === undefined ? {} : { note }),
      }
    },
  }))

  register(defineTool({
    name: 'browser_get_text',
    description: '[read] Extract the visible text of your tab, or of one element (CSS selector). Bounded output. On a tab that received credentials through browser_fill_credentials, the injected values are masked (****) in the returned text for the rest of that tab\'s life — VERBATIM occurrences only: text the page derived from the value (base64, reversed, character-split, an image) is not covered, and this tool is not a security boundary against a hostile page.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      selector: { type: 'string', description: 'Optional CSS selector; without it the whole page text is returned.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, truncated: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: formatText(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Page text'),
    async execute(args, exec) {
      const { tab, selector } = args as { tab?: number; selector?: string }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      // 2026-09-15 审计 P2：`truncated` 由 runtime 的文字漏斗（投影前长度 vs 生效
      // 上限 `min(textLimit, 32KiB)`）给出，工具不再用 `runtime.options.textLimit`
      // 自行推算——那会把一条已被 32KiB 截断的文本拿去和 65536 比。
      const { text, truncated } = await runtime.textWithMeta(tabId, selector, exec.signal)
      exec.signal.throwIfAborted()
      return { text, truncated }
    },
  }))

  register(defineTool({
    name: 'browser_screenshot',
    description: '[read] Capture the visible page of your tab as a JPEG image. Use sparingly — snapshots and text are cheaper. REFUSED on a tab inside the credential window (after browser_fill_credentials and before that tab navigates): a page can render an injected credential as text or a barcode, and no image redaction can undo that; the window ends on the next navigation of that tab.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              // The store returns these two optional `ImageAttachmentRef`
              // members for this tool's own input (`name` is always set from
              // `browser-tab-<id>.jpg`), so declaring only the five required
              // fields made the validator reject every successful capture with
              // `"value.image.name" is not a declared property`
              // (real-device report 2026-09-12).
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const image = (value as { image?: ImageAttachmentRef }).image
        return image === undefined
          ? [{ type: 'text', text: 'Screenshot failed.' }]
          : [{ type: 'image', attachment: image }]
      },
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Screenshot'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf((args as { tab?: number }).tab)
      const dataUrl = await runtime.screenshot(tabId, exec.signal)
      exec.signal.throwIfAborted()
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const data = Buffer.from(base64, 'base64')
      const refs = await ctx.attachments.saveImages([{
        data: new Uint8Array(data),
        mediaType: 'image/jpeg' as const,
        name: `browser-tab-${tabId}.jpg`,
      }])
      const ref = refs[0]
      if (ref === undefined) throw new Error('browser: screenshot could not be stored')
      return { image: ref }
    },
  }))

  register(defineTool({
    name: 'browser_wait_for',
    description: `[read] Wait for a page condition (element/text/url/network-idle/settled) before acting — use instead of sleeping on dynamic pages. timeoutMs is clamped to ${String(WAIT_FOR_MAX_MS)} ms of waiting; the tool call itself is budgeted at ${String(Math.round(BROWSER_WAIT_FOR_DEADLINE_MS / 1000))} s, so a user-gate wait plus the full condition wait still returns this tool's own result instead of a generic timeout.`,
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      condition: { type: 'string', enum: WAIT_CONDITIONS, required: true, description: 'What to wait for.' },
      selector: { type: 'string', description: 'CSS selector (element-present / element-visible).' },
      text: { type: 'string', description: 'Text to appear (text-appear).' },
      timeoutMs: { type: 'integer', description: `Budget in ms (default 30000; effective maximum ${String(WAIT_FOR_MAX_MS)}).` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatWait(value) }],
    },
    timeoutMs: BROWSER_WAIT_FOR_DEADLINE_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Wait for condition'),
    async execute(args, exec) {
      const startedAt = Date.now()
      const { tab, condition, selector, text, timeoutMs } = args as { tab?: number; condition: WaitForOptions['condition']; selector?: string; text?: string; timeoutMs?: number }
      if (!WAIT_CONDITIONS.includes(condition)) throw new Error(`condition must be one of: ${WAIT_CONDITIONS.join(', ')}`)
      if ((condition === 'element-present' || condition === 'element-visible') && (selector === undefined || selector === '')) {
        throw new Error('selector is required for element conditions')
      }
      if (condition === 'text-appear' && (text === undefined || text === '')) {
        throw new Error('text is required for text-appear')
      }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      // Clamp the wait itself so gate (10s) + wait (<=40s) stay inside the tool
      // deadline with margin; otherwise timeout-policy replaces the tool's own
      // result with the generic `tool call timed out` at the boundary.
      const waitMs = Math.min(timeoutMs ?? 30_000, WAIT_FOR_MAX_MS)
      return await runtime.waitFor(tabId, {
        condition, selector, text, timeoutMs: waitMs,
        // The registered deadline is armed at dispatch; leave 1s margin for the
        // return path so timeout-policy cannot replace our own result.
        deadlineAt: startedAt + BROWSER_WAIT_FOR_DEADLINE_MS - 1_000,
      }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_eval',
    description: '[write] Evaluate one JavaScript expression in your tab and return its resolved value (promise results are awaited) — for non-explicit page data (SSR globals, hidden fields, datasets) or page-authored requests. A heuristic guardrail accepts a single expression and rejects statements/assignments plus eval/Function and page-writing APIs; the refusal is receiver-aware, so pure data shaping is fine (String.prototype.replace such as document.body.innerText.replace(/\\s+/g, \' \'), trim/split/join, and in-place methods like sort/fill on an array the expression itself built) while navigation and page state changes stay refused (location.replace, history.replaceState, localStorage.setItem, click/submit/write/open) — including when they are reached through Reflect (Reflect.construct is refused like `new`, and Reflect.apply/get must name a statically known function, so localStorage[\'set\'+\'Item\'] is caught); network requests (fetch/XHR/WebSocket) are allowed on ordinary tabs. REFUSED on a tab inside the credential window (after browser_fill_credentials and before that tab navigates): while the injected credential is still in the page any read-back can be a channel, so there is no eval at all until the tab navigates — submit the form with browser_click instead. After that window closes eval works again and the returned value is masked against the values injected into that tab (verbatim occurrences only — a script that returns the value transformed is not covered). It is a misuse guardrail, not a security boundary.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      expression: { type: 'string', required: true, description: 'One expression (no statements/assignments; pure data shaping on strings/arrays is allowed; fetch/XHR/WebSocket allowed except on credential tabs; eval/Function rejected). Helpers: readText(sel)/readAttr(sel,name)/readJson(sel)/readVar(path).' },
      frame: { type: 'integer', description: 'Frame index in DOM order (0 = main frame, default; 1 = first iframe in the page, including cross-origin ones). The expression runs in that frame\'s own JavaScript world, exactly like frame 0 — page globals are visible. If the page contains a frame the index cannot map 1:1, the call fails with an explicit error instead of using a neighbouring frame.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatEval(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Evaluate JS'),
    async execute(args, exec) {
      const { tab, expression, frame } = args as { tab?: number; expression: string; frame?: number }
      if (typeof expression !== 'string' || expression.trim() === '') throw new Error('expression is required')
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      const result = await runtime.eval(tabId, expression, frame, exec.signal)
      exec.signal.throwIfAborted()
      // FIX-03 depth layer (2026-09-12): `runtime.eval` already runs its result
      // through the value-level secret redactor. Re-applying the same reducer
      // at the tool boundary is deliberately redundant: the model-facing exit
      // stays scrubbed even if a future runtime path (or another caller)
      // returns an unredacted value. It closes the read-back channel only —
      // `browser_eval` may still `fetch` a value out (not a security boundary;
      // see the tool description).
      return { result: runtime.redactTabSecrets(tabId, result) }
    },
  }))

  // ------------------------------------------------------------- Memory (4)

  register(defineTool({
    name: 'browser_bookmarks_add',
    description: '[memory] Bookmark a tab of your session (shared work-set; same URL is idempotent).',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      title: { type: 'string', description: 'Optional custom title.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Bookmarked ${String((value as { title?: string }).title ?? '')} (${String((value as { url?: string }).url ?? '')})` }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Bookmark page'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      return await runtime.runGated('browser_bookmarks_add', async () => {
        const tabId = await tabOf((args as { tab?: number }).tab)
        return runtime.addBookmark(tabId, (args as { title?: string }).title)
      }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_bookmarks_list',
    description: '[memory] List bookmarks (shared with the user), newest first.',
    parameters: {
      q: { type: 'string', description: 'Search text in url/title.' },
      limit: { type: 'integer', description: 'Max entries (default 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bookmarks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                createdAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatBookmarks(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List bookmarks'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const { q, limit } = args as { q?: string; limit?: number }
      return { bookmarks: runtime.listBookmarks({ q, limit }).map((b) => ({ id: b.id, url: b.url, title: b.title, createdAt: b.createdAt })) }
    },
  }))

  register(defineTool({
    name: 'browser_bookmarks_remove',
    description: '[memory] Remove a bookmark by id.',
    parameters: { id: { type: 'integer', required: true, description: 'Bookmark id from browser_bookmarks_list.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: (value as { ok?: boolean }).ok === true ? 'Bookmark removed.' : 'Bookmark not found.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Remove bookmark'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      return await runtime.runGated('browser_bookmarks_remove', () => ({ ok: runtime.removeBookmark((args as { id: number }).id) }), exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_history_search',
    description: '[memory] Search the shared visit history (your session + the user\'s), newest first.',
    parameters: {
      q: { type: 'string', description: 'Search text in url/title.' },
      limit: { type: 'integer', description: 'Max entries (default 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'integer' },
                url: { type: 'string' },
                title: { type: 'string' },
                actor: { type: 'string' },
                group: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatHistory(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('Search history'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const { q, limit } = args as { q?: string; limit?: number }
      return { entries: runtime.history({ q, limit }).map((h) => ({ time: h.time, url: h.url, title: h.title, actor: h.actor, group: h.group })) }
    },
  }))

  // ----------------------------------------------------------- Artifacts (3)

  register(defineTool({
    name: 'browser_download',
    description: '[artifacts] Trigger a download of a URL through your session (saved to the programmatic downloads dir; no dialogs).',
    parameters: {
      url: { type: 'string', required: true, description: 'Direct download URL.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { started: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Download started (see downloads_list for progress).' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Download file'),
    async execute(args, exec) {
      const { url } = args as { url: string }
      if (typeof url !== 'string' || url.trim() === '') throw new Error('url is required')
      noteAgent(runtime, exec.agent)
      await runtime.downloadUrl(url.trim(), exec.signal)
      exec.signal.throwIfAborted()
      return { started: true }
    },
  }))

  register(defineTool({
    name: 'browser_downloads_list',
    description: '[artifacts] List downloads (shared) with paths usable by file tools; newest first.',
    parameters: {
      status: { type: 'string', enum: ['in-progress', 'done', 'cancelled', 'rejected'], description: 'Filter by status.' },
      limit: { type: 'integer', description: 'Max entries (default 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          downloads: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                url: { type: 'string' },
                fileName: { type: 'string' },
                path: { type: 'string' },
                size: { type: 'integer' },
                status: { type: 'string' },
                createdAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDownloads(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List downloads'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      const { status, limit } = args as { status?: 'in-progress' | 'done' | 'cancelled' | 'rejected'; limit?: number }
      return { downloads: runtime.downloads({ status, limit }).map((d) => ({ id: d.id, url: d.url, fileName: d.fileName, path: d.path, size: d.size, status: d.status, createdAt: d.createdAt })) }
    },
  }))

  register(defineTool({
    name: 'browser_downloads_remove',
    description: '[artifacts] Remove a download record by id.',
    parameters: { id: { type: 'integer', required: true, description: 'Download id from downloads_list.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Download record removed.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Remove download'),
    async execute(args, exec) {
      noteAgent(runtime, exec.agent)
      return await runtime.runGated('browser_downloads_remove', () => ({ ok: runtime.removeDownload((args as { id: number }).id) }), exec.signal)
    },
  }))

  // ------------------------------------------------------------- Control (5)

  register(defineTool({
    name: 'browser_takeover',
    description: '[control] Hand control to the user (pauses ALL browser actions until the user gives control back). Usually the user takes over from the browser window; this tool exists for guided flows. There is deliberately NO model-side counterpart: control returns to you only when the user chooses it (the hand-back control in the browser window), never because the model asked for it back.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Control handed to the user.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Hand control to user'),
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      runtime.setUserControl(true, 'ai')
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  // 2026-09-15 审计 P1（控制权定案 A 方案）：`browser_release` 已从模型工具面
  // **移除**。用户的闸是用户的安全边界，模型能单方面撤销它等于这条边界不存在
  // （实测：模型一次 browser_release 就能在自己忙时把闸关掉继续点页面）。
  // 恢复只能由用户点「交给 AI」（shell 的胶囊按钮）——即 agent 侧拿不到任何
  // 解除路径。runtime 的 `setUserControl(false, …)` 能力**保留**：用户按钮、
  // 关闭浏览器、会话切换都还在用它（runtime.ts 的 setUserControl / shell-pages）。
  // 同族口径见 CLAUDE/审计记录「只有那个按钮能改变控制权」。

  register(defineTool({
    name: 'browser_fill_credentials',
    description: '[control] Fill the login form of your tab with credentials stored for a connector (shown to the user; never submitted automatically). SITE-BOUND: the tab must be on the connector\'s own origin — a tab on any other site (or a connector record without a site URL) is refused, so navigate to the real login page first. http(s) sites only: a non-http(s) document has no origin a stored credential can be bound to, so autofill is refused there (use browser_type for such pages). IMPORTANT: this opens the tab\'s credential window — from now until that tab navigates, browser_eval and browser_screenshot are refused there (a value still in the page can be read back in ways no masking can undo). Read the page with browser_get_snapshot / browser_get_text, submit with browser_click, and eval/screenshots resume automatically on the next document. The injected value stays masked in every text exit of this tab for the rest of the tab\'s life (page text, titles, URLs, history, downloads) — VERBATIM occurrences only: a page that renders the value transformed (base64, reversed, character-split) is not covered by any value-level rule. Treat this as a bound on accidents, not on a hostile page.',
    parameters: {
      tab: { type: 'integer', description: 'Your tab id (defaults to your active tab).' },
      connectorId: { type: 'string', required: true, description: 'The connector id whose stored credentials to use.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'boolean' },
          password: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatCredentialFill(value) }],
      presentationMeta: (_args, value) => metaFrom(value),
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Fill credentials'),
    async execute(args, exec) {
      const { tab, connectorId } = args as { tab?: number; connectorId: string }
      if (typeof connectorId !== 'string' || connectorId.trim() === '') {
        throw new Error('connectorId must be a non-empty string')
      }
      noteAgent(runtime, exec.agent)
      const tabId = await tabOf(tab)
      // 2026-09-15 审计 P2：注入前先做站点绑定（见 assertCredentialOrigin）。
      const expectedOrigin = await assertCredentialOrigin(runtime, tabId, connectorId.trim())
      // 把基准带进临界区再复核一次（TOCTOU 收口）。
      return await runtime.fillCredentials(tabId, connectorId.trim(), exec.signal, expectedOrigin)
    },
  }))

  register(defineTool({
    name: 'browser_credentials_list',
    description: '[control] List available stored credentials (connector id + username only; never secrets).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          credentials: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatCredentials(value) }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: present('List credentials'),
    async execute(_args, exec) {
      noteAgent(runtime, exec.agent)
      const list = await runtime.credentialsList()
      return { credentials: list }
    },
  }))

  register(defineTool({
    name: 'browser_clear_data',
    description: '[control] Clear site data (storage/cache) for your tabs. Clearing EVERYTHING incl. cookies (all-data) requires the user to confirm in the browser window menu — the tool refuses it.',
    parameters: {
      scope: { type: 'string', enum: ['group', 'all-data'], description: 'What to clear (default group).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Browsing data cleared.' }],
    },
    timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: present('Clear site data'),
    async execute(args, exec) {
      const scope = (args as { scope?: string }).scope
      if (scope === 'all-data') {
        // Design §7.3-4: all-data needs the USER's shell confirmation — the
        // tool surface refuses; users clear everything via the browser menu.
        // 菜单文案是按请求语言渲染的（OVERLAY_COPY.zh/en），而本工具的文案在 apply
        // 期就固定 —— 写死任一种语言的菜单项名，对另一种语言的用户就是一条不存在
        // 的指令（默认 UI 是 zh）。控件一律按功能/位置描述（2026-09-17 审计 S01-4）。
        throw browserError('policy', 'browser: clear_data all-data requires a user confirmation in the browser window menu — ask the user to open the ⋮ menu and pick the destructive clear-browsing-data entry (it asks to confirm clearing everything)')
      }
      noteAgent(runtime, exec.agent)
      await runtime.runGated('browser_clear_data', () => runtime.clearData(false), exec.signal)
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  }))

  // P2-29: the tool registry disposers are collected and returned so the
  // plugin fiber can unregister every tool (+ the guidance section) when the
  // browser plugin is disposed — otherwise they keep pointing at a disposed
  // runtime.
  return () => { for (const dispose of disposers) dispose() }
}

// ------------------------------------------------------------------ formats

function formatCredentialFill(value: unknown): string {
  const v = value as { username?: boolean; password?: boolean }
  const parts: string[] = []
  if (v.username === true) parts.push('username')
  if (v.password === true) parts.push('password')
  return parts.length > 0 ? `Filled ${parts.join(' and ')} from stored credentials (not submitted).` : 'Form fields filled (not submitted).'
}

function formatTabOpened(value: unknown): string {
  const v = value as { tab?: number; url?: string; title?: string }
  return `Opened tab ${String(v.tab ?? '')} — ${v.title !== '' ? `${String(v.title)} — ` : ''}${String(v.url ?? '')}`
}

function formatNavigation(value: unknown): string {
  const v = value as { url?: string; title?: string; loading?: boolean }
  return `Navigated to ${String(v.url ?? '')}${v.title !== undefined && v.title !== '' ? ` (${String(v.title)})` : ''}${v.loading === true ? ' [loading]' : ''}`
}

function formatSnapshot(value: unknown): string {
  const v = value as { elements?: Array<{ index: number; kind: string; text: string; selector: string; visible: boolean; disabled: boolean }>; url?: string; title?: string; note?: string }
  const elements = v.elements ?? []
  const header = [v.title !== undefined && v.title !== '' ? String(v.title) : '', v.url !== undefined ? String(v.url) : ''].filter(Boolean).join(' · ')
  const head = header === '' ? '' : `Page: ${header}\n`
  // 2026-09-15 审计 P2：截断/盲区提示必须出现在模型真正读到的那段文本里
  // （只放进 JSON 字段等于没提示——模型读的是 render 的输出）。
  const note = v.note === undefined || v.note === '' ? '' : `\n${String(v.note)}`
  if (elements.length === 0) {
    return `${head}No interactable elements found.${note}`
  }
  const lines = elements.map((e) => {
    const flags = `${e.visible ? '' : ' (off-screen)'}${e.disabled ? ' (disabled)' : ''}`
    return `${e.index}: [${e.kind}] ${e.text || '(no text)'}${flags}`
  })
  return `${head}Interactable elements:\n${lines.join('\n')}${note}`
}

function formatText(value: unknown): string {
  const v = value as { text?: string; truncated?: boolean }
  const text = v.text ?? ''
  return text === '' ? '(no text)' : `${text}${v.truncated === true ? '\n…(truncated)' : ''}`
}

function formatTabs(value: unknown): string {
  const v = value as {
    tabs?: Array<{ id: number; kind?: string; app_id?: string; url: string; title: string; loading: boolean; active: boolean; crashed?: boolean }>
    control?: {
      controlled?: boolean
      busy?: boolean
      busyTool?: string
      awaitingRelease?: boolean
      awaitingReleaseTool?: string
      userHeldSurfaces?: Array<{ id: number; appId: string }>
    }
  }
  const tabs = v.tabs ?? []
  // 2026-09-23 审计 CP-1：render 必须与 JSON 出口**同构**。此前这里只渲染
  // `title || url`，而应用窗口那两格被刻意置空（§16.1：应用窗口没有浏览器标签的
  // URL/标题）⇒ 模型看到的是 `"7: "` 这样的空白行，`kind`/`app_id` 只存在于模型
  // 永远读不到的 JSON 里 ⇒ 应用窗口寻址对模型断路。行形状与快照的
  // `index: [kind] text` 一致：`<id>: [<kind>] <label>`。
  const lines = tabs.length === 0
    ? ['No tabs open in this window.']
    : tabs.map((t) => {
        const isApp = t.kind === 'app'
        const kind = isApp ? 'app' : 'browser-tab'
        const label = isApp
          ? `app_id=${t.app_id !== undefined && t.app_id !== '' ? t.app_id : '(unknown)'}`
          : (t.title || t.url)
        return `${t.id}: [${kind}] ${label}${t.active ? ' (active)' : ''}${t.loading ? ' [loading]' : ''}${t.crashed === true ? ' [crashed — retry with browser_reload]' : ''}`
      })
  // 2026-09-16：把"用户拿着控制权"直接写在模型看得到的地方（此前只有被拒的
  // 工具调用会带这个信息，而现场那条出口被工具预算吞掉了）。
  const control = v.control
  if (control?.controlled === true) {
    const blocked = control.awaitingRelease === true
    lines.push(
      'USER HOLDS CONTROL: your other browser tools are refused until the user hands control back from the browser window.'
      + (blocked
        ? ` An earlier call was already refused${control.awaitingReleaseTool ? ` (${control.awaitingReleaseTool})` : ''} — ask the user to hand control back, do NOT retry blindly.`
        : ''),
    )
  }
  // §16.1 第 3 条：应用窗口的用户闸是**按 surface**记的，而这一段此前只存在于
  // JSON（`control.userHeldSurfaces`）—— render 与 JSON 出口的单侧漂移同 CP-1。
  const held = control?.userHeldSurfaces ?? []
  if (held.length > 0) {
    const list = held.map((surface) => `${surface.appId !== '' ? surface.appId : `#${surface.id}`}`).join(', ')
    lines.push(
      `USER HOLDS CONTROL OF APPLICATION WINDOW(S): ${list}. browser_navigate calls against those app_ids are refused until the user hands that window back; browser tabs are unaffected.`,
    )
  }
  return lines.join('\n')
}

function formatFillForm(value: unknown): string {
  const v = value as { filled?: number; submitted?: boolean; missed?: string[] }
  const unmatched = Array.isArray(v.missed) && v.missed.length > 0 ? ` Unmatched field(s): ${v.missed.join(', ')}.` : ''
  return `Filled ${String(v.filled ?? 0)} field(s)${v.submitted === true ? ' and submitted the form' : ''}.${unmatched}`
}

function formatWait(value: unknown): string {
  const v = value as { ok?: boolean; reason?: string }
  return v.ok === true
    ? 'Condition met.'
    : `Condition NOT met: ${String(v.reason ?? '')}`
}

function formatEval(value: unknown): string {
  const v = value as { result?: string }
  return v.result === undefined ? '(no result)' : String(v.result)
}

function formatBookmarks(value: unknown): string {
  const v = value as { bookmarks?: Array<{ id: number; url: string; title: string; createdAt: number }> }
  const items = v.bookmarks ?? []
  if (items.length === 0) return 'No bookmarks.'
  return items.map((b) => `${b.id}: ${b.title} — ${b.url}`).join('\n')
}

function formatHistory(value: unknown): string {
  const v = value as { entries?: Array<{ time: number; url: string; title: string; actor: string; group: string }> }
  const items = v.entries ?? []
  if (items.length === 0) return 'No history entries.'
  return items.map((h) => `${new Date(h.time).toLocaleString()} [${h.actor}] ${h.title || h.url} — ${h.url}`).join('\n')
}

function formatDownloads(value: unknown): string {
  const v = value as { downloads?: Array<{ id: number; url: string; fileName: string; path: string; size: number; status: string; createdAt: number }> }
  const items = v.downloads ?? []
  if (items.length === 0) return 'No downloads.'
  return items.map((d) => `${d.id}: ${d.fileName} (${d.status}) ${d.path || ''}`).join('\n')
}

function formatCredentials(value: unknown): string {
  const v = value as { credentials?: Array<{ id: string; username?: string }> }
  const items = v.credentials ?? []
  if (items.length === 0) return 'No stored credentials.'
  return items.map((c) => `${c.id}${c.username !== undefined ? ` (${c.username})` : ''}`).join('\n')
}

/** Tool → group map used by the enterprise toolGroups policy (P2 §15). */
const GROUP_OF: Record<string, 'navigate' | 'interact' | 'read' | 'write' | 'memory' | 'artifacts' | 'control'> = {
  browser_open: 'navigate', browser_navigate: 'navigate', browser_reload: 'navigate',
  browser_go_back: 'navigate', browser_go_forward: 'navigate', browser_list_tabs: 'navigate',
  browser_switch_tab: 'navigate', browser_close_tab: 'navigate',
  browser_click: 'interact', browser_type: 'interact', browser_press: 'interact',
  browser_select: 'interact', browser_scroll: 'interact', browser_fill_form: 'interact',
  browser_upload_file: 'interact',
  browser_get_snapshot: 'read', browser_get_text: 'read', browser_screenshot: 'read',
  browser_wait_for: 'read',
  // `browser_eval` runs arbitrary JS (including fetch/XHR) — it is a write /
  // eval capability, not a read inspection tool (2026-09-08).
  browser_eval: 'write',
  browser_bookmarks_add: 'memory', browser_bookmarks_list: 'memory',
  browser_bookmarks_remove: 'memory', browser_history_search: 'memory',
  browser_download: 'artifacts', browser_downloads_list: 'artifacts', browser_downloads_remove: 'artifacts',
  browser_takeover: 'control', browser_fill_credentials: 'control',
  browser_clear_data: 'control', browser_credentials_list: 'control',
}

/** Default: every tool group enabled. */
export const DEFAULT_GROUPS: ReadonlySet<string> = new Set(['navigate', 'interact', 'read', 'write', 'memory', 'artifacts', 'control'])

/** Parse a toolGroups config value into a set (unknown values ignored). */
export function parseToolGroups(value: string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return DEFAULT_GROUPS
  const allowed = new Set(['navigate', 'interact', 'read', 'write', 'memory', 'artifacts', 'control'])
  const set = new Set<string>()
  for (const item of value) if (allowed.has(item)) set.add(item)
  return set.size === 0 ? DEFAULT_GROUPS : set
}

/** Present result meta passthrough (kept for future card projections). */
export function browserMetaFromResult(meta: unknown): JsonValue | undefined {
  return meta as JsonValue | undefined
}

/** Present call view helper exported for tests. */
export function presentBrowserCall(kind: string, title: string, args: Record<string, unknown>): GenericCallView {
  return { card: 'generic', kind: kind === 'screenshot' ? 'fetch' : 'other', title, rawInput: args }
}

export type { ToolResult }
