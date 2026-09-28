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
 * 共 19 条；`tests/startup-rows.spec.ts` 会逐条断言它们真的在组合树里且未被 disable。
 *
 * 2026-09-21（并道改造）：`picoaide-foot-menu` 入表 —— 它是**五个面板入口的唯一
 * 承载行**（更多 + 浮层）。它不在 `filterRows` 的丢弃范围内（那只丢
 * `dsh-client-ui-*`），所以入表不会造成假报警；反过来，一旦它被渠道覆盖层或
 * `$DSH_HOME/cordis.patch.yml` 禁用，底部功能区会**安静地**少掉五个入口 ——
 * 正是本模块要消灭的形态，因此按"必需行"处理（boot 后直接抛错）。
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
  // 底部「更多」行（foot-menu/cordis.patch.yml）：五个面板入口的唯一承载行
  'picoaide-foot-menu',
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
 * 客户端条目（`window.__DSH_BOOT__.entries`）里必须出现的包名。
 *
 * 为什么需要（2026-09-28，审计 §8.9.12 —— 一次**静默降级**的完整取证）：
 * 宿主下发的客户端条目列表由上游 `@deepseek-ai/dsh-client-modules` 从 Loader 树上
 * **按包名逐个解析**得到，解析不出来就**静默跳过那一条**（`locatePkgJson` 的
 * `catch { return undefined }` ⇒ `resolveMeta` 返回 null ⇒ 该行永不进 table）。
 * 实测的完整链路（真交付产物、单变量 A/B/C）：
 * `$DSH_HOME` 的祖先链上出现一个 `name` **恰等于某个插件行包名**、且声明了 `exports`
 * 的 `package.json` ⇒ 上游 `profile-resolution` 把它误判成"包自引用" ⇒ 走 Node 原生
 * 解析而不是 asar 拦截表 ⇒ `ERR_MODULE_NOT_FOUND` ⇒ 那一条从列表里消失。
 *
 * 故障形态：宿主启动**成功**、`__DSH_BOOT__.entries` 68 条（> 0 ⇒ 只看"非空"的判据照绿），
 * 缺的是 `dsh-plugin-desktop` —— 客户端 `layout` 服务的唯一提供者 ⇒ 19 条上游客户端 UI
 * 全部 `pending (waiting for service: layout)` ⇒ 员工登录后整页 `Failed to load plugins`。
 *
 * 这里断言的是**可观测结果**（条目列表），不是上游的解析规则：规则会随版本变，
 * "我自己的客户端 bundle 到底有没有进列表"不会 —— 所以这是**能力判据**，
 * 上游修好之后它自动变成一条恒真但仍有意义的不变量（而不是需要跟着改的镜像规则）。
 *
 * 只列"缺了它这个产品就不可用"的那一个。扩充时先问"缺了它是白屏还是少个面板"：
 * 白屏才入表（少面板由行断言与 E2E 覆盖），否则会把"可选面被有意精简"变成启动失败。
 */
export const REQUIRED_CLIENT_ENTRIES = ['dsh-plugin-desktop'] as const

/** Loader 之外本模块读取的第二张面：客户端条目图。 */
export interface ClientEntryGraphLike {
  graph(): { entries: readonly { id?: string }[] }
}

/** Minimal context surface the client-entry assertion reads. */
export interface ClientEntryAuditContext {
  /** Cordis 服务查找（`clientModules` 是上游 `@deepseek-ai/dsh-client-modules` 注册的）。 */
  get(name: string): unknown
}

/**
 * Collect required client entries missing from the composed boot graph.
 *
 * 返回 `undefined` 表示**这张面根本不存在**（组合里没有客户端模块系统，
 * 例如只挂宿主面的 headless 组合）—— 调用方据此决定是记录还是静默跳过，
 * 本函数不替它决定（"没有可判的面"与"判过且通过"是两件事）。
 * @param ctx - settled Cordis root context.
 * @param required - required client entry ids.
 * @returns missing ids, or undefined when the client module registry is unavailable.
 */
export function missingRequiredClientEntries(
  ctx: ClientEntryAuditContext,
  required: readonly string[] = REQUIRED_CLIENT_ENTRIES,
): string[] | undefined {
  const registry = ctx.get('clientModules') as ClientEntryGraphLike | undefined
  if (registry === undefined || typeof registry.graph !== 'function') return undefined
  const present = new Set<string>()
  for (const entry of registry.graph().entries) {
    if (typeof entry.id === 'string') present.add(entry.id)
  }
  return required.filter(id => !present.has(id))
}

/**
 * Throw when a required client entry is missing from the host's composed graph.
 *
 * 抛错（而不是 warn）与 `assertRequiredRowsActive` 同一理由：这一类的现场是
 * "启动成功 + 整页 Failed to load plugins"，只 warn 在 Windows GUI 上等于无声。
 * 抛出的错误走 `src/main.ts` 的 `reportFatalStartupFailure`（原生错误面 + 日志文件）。
 * @param ctx - settled Cordis root context.
 * @param required - required client entry ids (defaults to this shell's list).
 */
export function assertRequiredClientEntries(
  ctx: ClientEntryAuditContext,
  required: readonly string[] = REQUIRED_CLIENT_ENTRIES,
): void {
  const missing = missingRequiredClientEntries(ctx, required)
  if (missing === undefined || missing.length === 0) return
  throw new Error(
    `dsh-plugin-desktop: ${String(missing.length)} required client entry(ies) are missing from the boot graph.\n`
    + missing.map(id => `  - ${id}`).join('\n')
    + '\n客户端条目是宿主按包名逐个解析出来的，解析不出来会被上游**静默跳过**：'
    + '实测触发条件 = `$DSH_HOME` 的祖先链上有一个 `name` 恰好等于该包名、且声明了 `exports` 的 '
    + 'package.json（上游把它误判成"包自引用"）。缺 dsh-plugin-desktop 的症状是登录后整页 '
    + '"Failed to load plugins"（客户端 layout 服务没有提供者）。',
  )
}

/**
 * Throw when any required row failed to activate.
 *
 * 抛错（而不是 warn）是刻意的：`auditStartupEntries` 已经替上游警告过一遍，
 * 再警告一次就是我们要修的那个静默形态。上游没有 stderr 的平台上，
 * 这里抛出的错误会走桌面自己的致命路径 —— `src/main.ts` 的
 * `reportFatalStartupFailure`（`electronLogger.errorCause` + 原生错误面：
 * 打开日志 / 重试 / 退出，实现在 `src/fatal-boot.ts`，行为由
 * `tests/fatal-boot.spec.ts` 钉住）。2026-09-23（B-02）之前这里只写了
 * `errorCause` + 退出，注释与实现不一致了三个版本。
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
