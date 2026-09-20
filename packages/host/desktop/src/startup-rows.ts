/**
 * Post-boot assertion that this shell's own Loader rows really activated.
 *
 * 为什么需要（2026-09-20 DSH 0.1.6 升级审计 P0-9）：
 * 0.1.6-alpha.2 用 `auditStartupEntries` 取代了 `assertEntriesActivated`，而它只对
 * 7 个全局 required id（`agent-loop`/`webserver`/`modules`/`connection`/
 * `headless-runner`/`acp`/`sdk-jsonrpc-server`）+ bootstrap Include 抛错，其余
 * inactive 条目只 warn；并且**它明确忽略"树上不存在的 required id"与"被 disabled 的
 * required 条目"**（`deepseek-harness/packages/boot/app-boot/src/index.ts:870-884`）。
 * 我们这 18 个 `desktop-*`/`picoaide-*`/`pico-*` 行一个都不在那张表里。
 *
 * 四种形态实测（`temp/upgrade-016/probe-row-failure-classes.mjs`，逐类真跑）：
 *   A. 行的 `inject` 里有一个永远不出现的服务 ⇒ fiber 停在 PENDING(0)：上游**只打一条
 *      warn**、`boot()` 正常 resolve ⇒ 生产里就是"功能不见了但启动成功"；Windows GUI
 *      没有 stderr 接收方，连那条 warn 都看不到。← 本次要修的主形态
 *   B. 必需行被 `disabled: true`：上游**连 warn 都没有**（doc: disabled required
 *      entries are ignored）⇒ 组合里误 disable 一个必需行完全无声。我方
 *      `cordis.patch.yml` 有大量 disable 行，这个形态很现实。
 *   C. `apply` 同步抛异常：上游 `mountRootInclude` 直接 reject（`plugin tree failed to
 *      load`）—— 这一类本来就 fail-loud，**不是**本次修复的对象，别夸大守卫的作用。
 *   D. 包说明符解析不到：上游同样直接 reject（`failed to import loader entry`）。
 * 门禁侧则完全看不见：`verify-loader-boot.mjs` 原先只有**存在性**断言，两版都绿。
 *
 * 因此这里做两件事：把"我方必需行"显式列出来并在 boot 之后断言它们处于 ACTIVE；
 * 同时把列表本身交给一条组合树测试守住（行被改名/被 `filterRows` 丢掉时测试先红，
 * 而不是等到真机启动才发现）。全量组合树上的激活断言在
 * `scripts/verify-profile-boot.mjs`（唯一真正挂载完整个桌面组合树的地方）。
 * @module dsh-plugin-desktop/startup-rows
 */

/**
 * `FiberState.ACTIVE`。
 *
 * cordis 的 `FiberState` 是 `const enum`（`lib/types/fiber.d.ts`），**运行时被擦除**，
 * 所以这里钉住数值并由 `tests/startup-rows.spec.ts` 与上游声明对拍 —— 上游改动枚举
 * 顺序时测试会红，而不是让断言悄悄恒假。
 */
export const FIBER_ACTIVE = 2

/**
 * `FiberState.FAILED`。
 *
 * 与 `FIBER_ACTIVE` 同理（`const enum`，运行时擦除，编译产物里内联 `3`）。
 * 它用于"组合树里任何已启用行都不该是 FAILED"这条判据：FAILED 意味着插件的
 * `apply` 或配置校验抛了异常，**任何环境里都不合法**；PENDING 则可能是环境相关
 * （headless 冒烟里某个服务本来就不存在），所以判据只对 FAILED 严格。
 */
export const FIBER_FAILED = 3

/**
 * 桌面 shell 要求必须 ACTIVE 的 Loader 行 id。
 *
 * 判据是「缺了它这个产品就不是它」：窗口与壳、桌面自有路由、登录门、企业面、
 * 四个自研业务面。**不含**可选客户端 UI 行 —— `profile.ts` 的 `filterRows` 会有意
 * 丢弃组合里解析不到的客户端行，把它们放进来会造成启动假报警。
 * 共 18 条；`tests/startup-rows.spec.ts` 会逐条断言它们真的在组合树里且未被 disable。
 */
export const REQUIRED_DESKTOP_ROWS = [
  // 桌面壳与其自有路由（desktop/cordis.patch.yml）
  'desktop-shell',
  'desktop-diagnostics',
  'desktop-updates',
  'desktop-loop-notify',
  'desktop-asar-fs',
  'desktop-asar-guidance',
  // 企业面（enterprise/cordis.patch.yml）
  'picoaide-enterprise',
  'picoaide-session',
  'picoaide-gateway-model',
  'picoaide-bootstrap',
  'picoaide-auth-gate',
  'picoaide-channel-sync',
  'picoaide-error-reporting',
  // 自研业务面
  'pico-connectors',
  'pico-cron',
  'pico-browser',
  'pico-wasm-apps-host',
  'picoaide-account-card',
] as const

/** Loader 条目里本模块读取的最小形状（避免把上游 Loader 类型引进来）。 */
export interface LoaderEntryLike {
  options?: { id?: string }
  disabled?: boolean
  fiber?: { state?: number }
}

/** One required row that is not active, with the reason the check could tell. */
export interface InactiveRow {
  /** Row id as declared in the composition. */
  id: string
  /** Why the row is not active: absent / disabled / fiber missing / fiber state. */
  reason: string
}

/**
 * Collect the required rows that are not ACTIVE.
 *
 * 缺席与 inactve 分开报告：前者通常意味着 composition 里行 id 被改名/被丢弃，
 * 后者意味着模块加载或 apply 失败 —— 两者的排障方向完全不同。
 * @param entries - Loader entries in the settled tree.
 * @param required - required row ids.
 * @returns one record per required row that is not active (empty when all are).
 */
export function inactiveRequiredRows(
  entries: Iterable<LoaderEntryLike>,
  required: readonly string[] = REQUIRED_DESKTOP_ROWS,
): InactiveRow[] {
  const byId = new Map<string, LoaderEntryLike>()
  for (const entry of entries) {
    const id = entry.options?.id
    if (typeof id === 'string') byId.set(id, entry)
  }
  const problems: InactiveRow[] = []
  for (const id of required) {
    const entry = byId.get(id)
    if (entry === undefined) {
      problems.push({ id, reason: 'absent from the Loader tree (row id renamed or dropped?)' })
      continue
    }
    if (entry.disabled === true) {
      problems.push({ id, reason: 'disabled in the composition' })
      continue
    }
    const state = entry.fiber?.state
    if (state === undefined) {
      problems.push({ id, reason: 'no fiber (module failed to import)' })
      continue
    }
    if (state !== FIBER_ACTIVE) problems.push({ id, reason: `fiber state ${String(state)} (expected ${String(FIBER_ACTIVE)} = ACTIVE)` })
  }
  return problems
}

/** Minimal context surface the assertion reads. */
export interface StartupAuditContext {
  loader?: { entries(): Iterable<LoaderEntryLike> }
}

/**
 * Throw when any required row failed to activate.
 *
 * 抛错（而不是 warn）是刻意的：`auditStartupEntries` 已经替上游警告过一遍，
 * 再警告一次就是我们要修的那个静默形态。上游没有 stderr 的平台上，
 * 这里抛出的错误会走桌面自己的致命路径（`electronLogger.errorCause` + 恢复对话框）。
 * @param ctx - settled Cordis root context.
 * @param required - required row ids (defaults to this shell's list).
 */
export function assertRequiredRowsActive(
  ctx: StartupAuditContext,
  required: readonly string[] = REQUIRED_DESKTOP_ROWS,
): void {
  const entries = ctx.loader?.entries()
  if (entries === undefined) {
    throw new Error('dsh-plugin-desktop: ctx.loader is unavailable, cannot audit required rows')
  }
  const problems = inactiveRequiredRows(entries, required)
  if (problems.length === 0) return
  const detail = problems.map(problem => `  - ${problem.id}: ${problem.reason}`).join('\n')
  throw new Error(
    `dsh-plugin-desktop: ${String(problems.length)} required row(s) did not activate.\n${detail}\n`
    + '这些行不在上游的 requiredStartupEntryIds 里，所以上游只会 warn、启动会照常成功；'
    + '此处按失败处理，避免"界面少了功能但没有任何错误"的静默形态。',
  )
}
