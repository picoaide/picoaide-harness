/**
 * `tests/exact-route-proof-inventory.spec.ts` — **仓库级** exact 路由的持有性证明
 * 豁免表（FIX-42② 后半；AB1-04 指出的结构性根因）。
 *
 * ## 为什么需要它（扫描根决定了判据能看见什么）
 *
 * FIX-36 建的 `EXACT_ROUTE_POLICY`（见 `tests/audit-r27-loopnotify-consuming-get.spec.ts`）
 * 是**行为级**的：它真跑 desktop 的 `apply()`、收集 `register()` 收到的路由、再用
 * 伪造请求打一遍 —— 这是最强的一档判据，但它的**取值域只有一个包**。而
 * "exact 优先于 `/api` prefix、cookie 围栏只装在 prefix 通道上"这条绕过链是
 * **全仓形态**（下面的计数由发现器本体给出；`grep -rn "kind: 'exact'" packages`
 * 在 `src/` 下是 33 处 / 6 个包）：
 *
 * ```
 *   packages/client/account-card/src/index.ts        1
 *   packages/host/browser/src/index.ts               9
 *   packages/host/connectors/src/index.ts            1
 *   packages/host/cron/src/host-routes.ts            4
 *   packages/host/desktop/src/index.ts               9
 *   packages/host/enterprise/src/auth-gate.ts        9
 * ```
 *
 * AB1-04 就落在 desktop 的扫描根之外的那个包上（account-card 的 `?refresh=1`），
 * 而 FIX-36 的判据**结构上不可能**看见它。本文件把**分类面**扩到全仓：每个 exact
 * 路由都必须在这一行表里二选一 —— 挂证明，或写明为什么不必（纯读）。新增一个
 * 未登记的 exact 路由 ⇒ 红；删掉/改名一个 ⇒ 表里的死条目也红（双向陈旧检测）。
 *
 * ## 这条判据**能**证明什么、**不能**证明什么
 *
 * - **能**：`proof` 行的**闸门调用点**必须真实存在（声明的文件里必须真的出现
 *   `acceptWriteProof(` / `requireWriteProof(` / … 的调用），且那个文件必须接在
 *   某份 `write-proof.ts` 或规范实现 `@picoaide/dsh-host-locale/loopback` 上；
 *   接不上的（三处历史遗留的本地闭包）必须逐条写明 `localGate` 理由。
 * - **不能**：静态判据证明不了"伪造请求真的会被拒" —— 那要按包起各自的 ctx 才能跑，
 *   见下面的 `BEHAVIOUR_COVERAGE`：**已经行为验证的包**写 `verifiedBy`（判据断言那份
 *   spec 真的存在），**还没有的**必须写 `gap` 说明为什么。绝不把"没验证"写成像
 *   "验证过了"。
 *
 * 判据自身有自检：把**发现器 → 对账**这段拆成纯函数，用合成输入把"漏登记"与
 * "死条目"两个方向都打红一次（分析器恒真 / 恒红两个方向都不成立才算过）。
 */
import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** 仓库根（`packages/host/desktop/tests` 上溯四级）。 */
const REPO_ROOT = join(__dirname, '../../../..')

/** 仓库相对路径（`/` 分隔，跨平台一致）。 */
function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/')
}

/**
 * 一行路由的证明口径。
 *
 * - `all`：这一发请求无论走哪个分支都要证明（写面）。
 * - `consuming-only`：**同一条路由上两种语义并存** —— 写/消费分支挂证明，只读分支
 *   不挂（`reason` 必须写清哪一半是读、哪一半是写）。
 * - `none`：纯读（`reason` 必须写清为什么它没有状态变更）。
 */
type ProofVerdict = 'all' | 'consuming-only' | 'none'

interface ExactRouteRow {
  /** 证明口径。 */
  readonly proof: ProofVerdict
  /** `none` / `consuming-only` 必填：为什么这一半不必挂证明。 */
  readonly reason?: string
  /**
   * `all` / `consuming-only` 必填：**闸门调用点** = `<仓库相对文件>#<符号>`。
   * 判据断言那个文件里真的出现 `<符号>(`，且该文件接在某份 `write-proof.ts` 或
   * `@picoaide/dsh-host-locale/loopback` 上。
   */
  readonly gate?: string
  /**
   * 闸门是**写在该文件里的局部闭包**（历史遗留，尚未收敛到规范实现）时必填：
   * 写清它为什么还不能换、以及它凭什么等价。
   */
  readonly localGate?: string
  /** 只在特定条件（平台 / 素材存在）下注册：缺席不算陈旧。 */
  readonly conditional?: boolean
}

/** 已知的闸门入口符号（封闭集）：新增第四种必须先收敛，不许各写一份判定。 */
const GATE_SYMBOLS = new Set(['acceptWriteProof', 'requireWriteProof', 'acceptConsumingProof', 'proofOfPossession'])

/**
 * 全仓 exact 路由的唯一分类表。键 = `<仓库相对文件>#<`path:` 的源码文本>`。
 *
 * 为什么键里带 path 的**源码文本**而不是解析后的 URL：路径在三处是常量/模板
 * （`DESKTOP_LOOP_NOTIFY_SESSION_PATH`、`` `${CRON_API_PREFIX}/state` ``、
 * `BRAND_FAVICON_PATH`），跨包解析它们要跟着各包的导出面走；文本键把"发现器看见
 * 什么"与"表里登记什么"钉成同一个东西，改名/搬文件都会红。
 */
const REPO_EXACT_ROUTE_POLICY: ReadonlyMap<string, ExactRouteRow> = new Map<string, ExactRouteRow>([
  // ── desktop（行为级判据见 tests/audit-r27-loopnotify-consuming-get.spec.ts）──
  ['packages/host/desktop/src/index.ts#DESKTOP_LOOP_NOTIFY_SESSION_PATH', {
    proof: 'consuming-only',
    reason: '纯读分支不挂：轮询只在返回待跳转项时消费（read-then-clear）；消费那一支走证明（FIX-36）。',
    gate: 'packages/host/desktop/src/loop-notify-route.ts#acceptConsumingProof',
  }],
  ['packages/host/desktop/src/index.ts#DESKTOP_UPDATE_PATH', {
    proof: 'none',
    reason: '纯读：回吐更新徽章快照（内存里的状态投影），不驱动任何动作、不落盘。',
  }],
  ['packages/host/desktop/src/index.ts#DESKTOP_UPDATE_CHECK_PATH', {
    proof: 'all',
    gate: 'packages/host/desktop/src/write-proof.ts#acceptWriteProof',
  }],
  ['packages/host/desktop/src/index.ts#DESKTOP_UPDATE_INSTALL_PATH', {
    proof: 'all',
    gate: 'packages/host/desktop/src/write-proof.ts#acceptWriteProof',
  }],
  ['packages/host/desktop/src/index.ts#RENDERER_BOOT_REPORT_PATH', {
    proof: 'all',
    gate: 'packages/host/desktop/src/write-proof.ts#acceptWriteProof',
  }],
  ['packages/host/desktop/src/index.ts#DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH', {
    proof: 'all',
    gate: 'packages/host/desktop/src/write-proof.ts#acceptWriteProof',
  }],
  ['packages/host/desktop/src/index.ts#BRAND_FAVICON_PATH', {
    proof: 'none',
    reason: '纯读：随包静态资源的字节（no-store），无状态变更。',
    conditional: true,
  }],
  ['packages/host/desktop/src/index.ts#BRAND_MANIFEST_PATH', {
    proof: 'none',
    reason: '纯读：随包静态资源的字节（no-store），无状态变更。',
  }],
  // 麦克风系统授权（2026-09-30）：状态只读；"申请"会弹系统对话框 ⇒ 过写面证明。
  ['packages/host/desktop/src/index.ts#VOICE_MIC_STATUS_PATH', {
    proof: 'none',
    reason: '纯读：回吐一枚枚举值（平台 + TCC 状态），无状态变更、无用户可见动作。',
  }],
  ['packages/host/desktop/src/index.ts#VOICE_MIC_REQUEST_PATH', {
    proof: 'all',
    gate: 'packages/host/desktop/src/write-proof.ts#acceptWriteProof',
  }],
  ['packages/host/desktop/src/index.ts#DESKTOP_DIRECTORY_PICKER_PATH', {
    proof: 'all',
    gate: 'packages/host/desktop/src/write-proof.ts#acceptWriteProof',
    conditional: true,
  }],

  // ── account-card（FIX-42②；行为级判据见 tests/audit-r28-consumption-proof.spec.ts）──
  ['packages/client/account-card/src/index.ts#\'/api/pico/account/usage\'', {
    proof: 'consuming-only',
    reason: '纯读分支不挂：不带 `?refresh` 时只交付缓存快照、不触网关；`?refresh=1`（往返网关）与 `authExpired`（清会话）两支是写 ⇒ 走证明。',
    // 规范实现在零依赖叶子包里：account-card 不可能 import desktop 那份
    // （`dsh-plugin-desktop` 的 needs 里含 `@picoaide/dsh-account-card` ⇒ 反向成环），
    // 而 `@picoaide/dsh-enterprise/loopback` 是它**既有**的依赖与子路径。
    gate: 'packages/host/host-locale/src/loopback.ts#acceptWriteProof',
  }],

  // ── browser ──
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/state\'', {
    proof: 'none',
    reason: '纯读：只回吐 shell 状态快照（GET），无状态变更。',
  }],
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/ops\'', {
    proof: 'none',
    reason: '纯读：只回吐动作时间线（GET），无状态变更。',
  }],
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/stream\'', {
    proof: 'none',
    reason: '纯读：SSE 信号流（GET，只推事件、不落状态；客户端收到后自己回拉 /state）。',
  }],
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/bookmarks\'', {
    proof: 'consuming-only',
    reason: '纯读分支不挂：GET 只列书签；POST/DELETE 改书签库 ⇒ 走证明。',
    gate: 'packages/host/browser/src/index.ts#requireWriteProof',
    localGate: '该 `requireWriteProof` 是本文件内的局部闭包（第三轮写的同形实现），尚未收敛到 `@picoaide/dsh-host-locale/loopback`；它逐字等价（403/503 + 同一份 hint + fence 缺席 fail-closed）。收敛属独立改动。',
  }],
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/history\'', {
    proof: 'none',
    reason: '纯读：只查询浏览历史（GET，带 q/limit 过滤），无状态变更。',
  }],
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/downloads\'', {
    proof: 'consuming-only',
    reason: '纯读分支不挂：GET 只列下载记录；DELETE 删记录 ⇒ 走证明。',
    gate: 'packages/host/browser/src/index.ts#requireWriteProof',
    localGate: '该 `requireWriteProof` 是本文件内的局部闭包（第三轮写的同形实现），尚未收敛到 '
      + '`@picoaide/dsh-host-locale/loopback`；它逐字等价（403/503 + 同一份 hint + fence 缺席 fail-closed）。收敛属独立改动。',
  }],
  ['packages/host/browser/src/index.ts#\'/api/pico/browser/downloads/open\'', {
    proof: 'all',
    gate: 'packages/host/browser/src/index.ts#requireWriteProof',
    localGate: '该 `requireWriteProof` 是本文件内的局部闭包（第三轮写的同形实现），尚未收敛到 '
      + '`@picoaide/dsh-host-locale/loopback`；它逐字等价（403/503 + 同一份 hint + fence 缺席 fail-closed）。收敛属独立改动。',
  }],
  ['packages/host/browser/src/index.ts#\'/browser-shell\'', {
    proof: 'none',
    reason: '纯读：本插件自己的 HTML 页面字节（no-store），无状态变更。',
  }],
  ['packages/host/browser/src/index.ts#\'/browser-overlay\'', {
    proof: 'none',
    reason: '纯读：本插件自己的 HTML 页面字节（no-store），无状态变更。',
  }],

  // ── connectors（exact 只服务列表；写动作全在 prefix 路由上挂证明）──
  ['packages/host/connectors/src/index.ts#\'/api/pico/connectors\'', {
    proof: 'none',
    reason: '纯读：exact 这一条只列连接器（GET）；connect/approve/refresh 等**写动作**全部走同路径的 prefix 路由，那里挂 `requireWriteProof`。',
  }],

  // ── cron ──
  ['packages/host/cron/src/host-routes.ts#`${CRON_API_PREFIX}/state`', {
    proof: 'none',
    reason: '纯读：回吐任务快照（GET），无状态变更。',
  }],
  ['packages/host/cron/src/host-routes.ts#`${CRON_API_PREFIX}/action`', {
    proof: 'all',
    gate: 'packages/host/cron/src/write-proof.ts#requireWriteProof',
  }],
  ['packages/host/cron/src/host-routes.ts#`${CRON_API_PREFIX}/permissions`', {
    proof: 'none',
    reason: '纯读：回吐组合出来的权限预设名（GET），无状态变更。',
  }],
  ['packages/host/cron/src/host-routes.ts#`${CRON_API_PREFIX}/events`', {
    proof: 'none',
    reason: '纯读：SSE 事件流（GET），只推任务变化、不落状态。',
  }],

  // ── enterprise auth-gate ──
  ['packages/host/enterprise/src/auth-gate.ts#\'/login\'', {
    proof: 'none',
    reason: '纯读：登录页 HTML（预认证面，无会话可证明）。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/change-password\'', {
    proof: 'none',
    reason: '纯读：改密页 HTML（页面本身不改状态，提交走 /api/pico/auth/password 那条挂证明的路由）。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/auth/login\'', {
    proof: 'all',
    gate: 'packages/host/enterprise/src/auth-gate.ts#proofOfPossession',
    localGate: '该 `proofOfPossession` 是 `apply()` 内的局部闭包（第三轮写的同形实现），尚未收敛到 `@picoaide/dsh-host-locale/loopback`；它多一个 `level` 参数（`required`/`best-effort`），本路由用 `required`（fence 缺席 fail-closed 503）。收敛属独立改动。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/auth/password\'', {
    proof: 'all',
    gate: 'packages/host/enterprise/src/auth-gate.ts#proofOfPossession',
    localGate: '同上：`proofOfPossession` 是 `apply()` 内的局部闭包，尚未收敛到规范实现；本路由用 `best-effort` 档 —— 改密必须先交出旧密码，本机伪造 Origin 的进程拿不出凭据。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/auth/state\'', {
    proof: 'none',
    reason: '纯读：单次读取会话快照（GET），无状态变更。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/auth/logout\'', {
    proof: 'all',
    gate: 'packages/host/enterprise/src/auth-gate.ts#proofOfPossession',
    localGate: '同上：`proofOfPossession` 是 `apply()` 内的局部闭包（第三轮写的同形实现），尚未收敛到 `@picoaide/dsh-host-locale/loopback`；本路由用 `required` 档（fence 缺席 fail-closed 503）。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/auth/methods\'', {
    proof: 'none',
    reason: '纯读：查询服务端启用的登录方式（GET，服务端该端点本就是公开端），无状态变更。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/auth/browser-login\'', {
    proof: 'all',
    gate: 'packages/host/enterprise/src/auth-gate.ts#proofOfPossession',
    localGate: '同上：`proofOfPossession` 是 `apply()` 内的局部闭包（第三轮写的同形实现），尚未收敛到 `@picoaide/dsh-host-locale/loopback`；本路由用 `required` 档（fence 缺席 fail-closed 503）。',
  }],
  ['packages/host/enterprise/src/auth-gate.ts#\'/api/pico/channel\'', {
    proof: 'none',
    reason: '纯读：回吐渠道内容（GET，登录页未登录时也要用），无状态变更。',
  }],
])

/**
 * **行为验证**面的对账（按包）。
 *
 * 静态分类只能证明"闸门调用点存在"，证明不了"伪造请求真的被拒"。所以每个出现在
 * 表里的文件都必须在这里二选一：`verifiedBy`（真的跑起来打过伪造请求的那份 spec，
 * 判据断言它存在）或 `gap`（还没做到，写清为什么）。**不许留空** —— 这就是把
 * "未验证面"从隐性变成显性。
 */
const BEHAVIOUR_COVERAGE: Readonly<Record<string, { readonly verifiedBy?: string, readonly gap?: string }>> = {
  'packages/host/desktop/src/index.ts': {
    verifiedBy: 'packages/host/desktop/tests/audit-r27-loopnotify-consuming-get.spec.ts',
  },
  'packages/client/account-card/src/index.ts': {
    verifiedBy: 'packages/client/account-card/tests/audit-r28-consumption-proof.spec.ts',
  },
  'packages/host/browser/src/index.ts': {
    verifiedBy: 'packages/host/browser/tests/audit-r7-write-proof.spec.ts',
  },
  'packages/host/cron/src/host-routes.ts': {
    verifiedBy: 'packages/host/cron/tests/audit-r4-write-proof.spec.ts',
  },
  'packages/host/connectors/src/index.ts': {
    verifiedBy: 'packages/host/connectors/tests/audit-r7-write-proof.spec.ts',
  },
  'packages/host/enterprise/src/auth-gate.ts': {
    verifiedBy: 'packages/host/enterprise/tests/auth-gate-local-write-proof.spec.ts',
  },
}

/* ------------------------------------------------------------------ *
 * 发现器（AST，仓库级）
 * ------------------------------------------------------------------ */

interface DiscoveredRoute {
  /** 表键：`<仓库相对文件>#<`path:` 源码文本>`。 */
  readonly key: string
  /** 行号（诊断用）。 */
  readonly line: number
  /** `path:` 的源码文本。 */
  readonly pathText: string
}

/** 只扫源码：`packages/<pkg>/src/` 子树（与 `session-epoch-wiring.spec.ts` 同一取值域）。 */
function collectSources(): string[] {
  const files: string[] = []
  const walk = (dir: string, inSource: boolean): void => {
    // 显式 `Dirent[]`：`ReturnType<typeof readdirSync>` 会命中 Buffer 那个重载（TS 报串）。
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, inSource || entry.name === 'src')
        continue
      }
      if (inSource && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(absolute)
    }
  }
  walk(join(REPO_ROOT, 'packages'), false)
  return files.sort()
}

/**
 * 仓库级发现器：每一个 `kind: 'exact'` 的注册（**含简写属性与对象展开**）。
 *
 * R29-AC1-04 之前只认字面量形式（`{ kind: 'exact', path: …, handler: … }`），于是两种
 * 写法**完全失明**（合成树里新包注册 3 条 exact 路由 ⇒ 发现 0 条）：
 *   - 工厂函数 + 简写属性：`return { kind: 'exact', path, handler }`，路径只出现在调用点
 *     （`exactRoute('/api/pico/x', handler)`）；
 *   - 对象展开：`const base = { kind: 'exact', path: '/a', handler }; register({ ...base, path: '/b' })`。
 * 现在两种都进面 —— "发现器看不见"正是这条判据要消灭的东西。
 *
 * 边界（如实登记）：展开对象只在**同一个文件内**解析（模块级 `const`）。跨文件 import
 * 进来的 base 解析不出 `kind`，因此不会被当成 exact 路由 —— 这种写法的文件里通常仍有
 * `exact` 这个词（`kind: EXACT` / `'exact'`），会被预筛收进来但没有可判定的 kind。真出现
 * "跨文件 base + 只在这里写 path" 的注册形态时，这条注释与本函数要一起改。
 *
 * @returns 按表键排序的发现结果。
 */
function discoverExactRoutes(): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = []
  for (const file of collectSources()) {
    const text = readFileSync(file, 'utf8')
    // 预筛只看 `exact` 这个词（**不再**只看带引号的 `'exact'`）：简写/展开形态里 kind
    // 可能是标识符，带引号的字面量只出现在 base 那一处。
    if (!/\bexact\b/iu.test(text)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const vars = collectLiteralVars(source)
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const shape = resolveExactLiteral(node, source, vars)
        if (shape.kindExpr !== undefined && isExactKind(shape.kindExpr, source, vars) && shape.pathExpr !== undefined) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          for (const pathText of resolveRoutePaths(node, shape, source, vars)) {
            found.push({ key: `${repoPath(file)}#${pathText}`, line, pathText })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found.sort((a, b) => a.key.localeCompare(b.key))
}

/** 一个对象字面量的 `kind` / `path` 解析结果（值保留 AST，便于继续解析标识符/展开）。 */
interface ExactLiteralShape {
  // 注意：三个字段都是**非可选 + 显式 `undefined`**（`exactOptionalPropertyTypes: true`
  // 下可选属性不能直接赋 `undefined`；vitest 不做类型检查，只有 `yarn check` 会红）。
  readonly kindExpr: ts.Expression | undefined
  readonly pathExpr: ts.Expression | undefined
  /** `path` 是**简写属性**（`{ kind: 'exact', path, handler }`）时为 true。 */
  readonly pathIsShorthand: boolean
}

/** 收集文件里模块级 `const X = <表达式>` 的浅绑定（只用于解析展开与常量路径）。 */
function collectLiteralVars(source: ts.SourceFile): Map<string, ts.Expression> {
  const vars = new Map<string, ts.Expression>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        vars.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  return vars
}

/**
 * 浅解析一个对象字面量的 `kind` / `path`：显式属性优先，其次从**同文件**的对象展开里取
 * （可多层，带深度上限防环）。
 */
function resolveExactLiteral(
  node: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  vars: Map<string, ts.Expression>,
  depth = 0,
): ExactLiteralShape {
  let kindExpr: ts.Expression | undefined
  let pathExpr: ts.Expression | undefined
  let pathIsShorthand = false
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      if (property.name.text === 'kind') kindExpr = property.initializer
      if (property.name.text === 'path') {
        pathExpr = property.initializer
        pathIsShorthand = false
      }
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === 'kind') kindExpr = property.name
      if (property.name.text === 'path') {
        pathExpr = property.name
        pathIsShorthand = true
      }
      continue
    }
    if (ts.isSpreadAssignment(property) && depth < 4) {
      const base = spreadBaseLiteral(property.expression, vars)
      if (base === undefined) continue
      const inner = resolveExactLiteral(base, source, vars, depth + 1)
      if (kindExpr === undefined) kindExpr = inner.kindExpr
      if (pathExpr === undefined) {
        pathExpr = inner.pathExpr
        pathIsShorthand = inner.pathIsShorthand
      }
    }
  }
  return { kindExpr, pathExpr, pathIsShorthand }
}

/** 展开源（`...base`）解析成同文件里的对象字面量（解析不出返回 undefined）。 */
function spreadBaseLiteral(expr: ts.Expression, vars: Map<string, ts.Expression>): ts.ObjectLiteralExpression | undefined {
  if (ts.isParenthesizedExpression(expr)) return spreadBaseLiteral(expr.expression, vars)
  if (ts.isObjectLiteralExpression(expr)) return expr
  if (ts.isIdentifier(expr)) {
    const bound = vars.get(expr.text)
    if (bound !== undefined && ts.isObjectLiteralExpression(bound)) return bound
  }
  return undefined
}

/** `kind` 表达式的值是不是 `'exact'`（剥掉 `as const` / `satisfies` / 括号 / 同文件常量）。 */
function isExactKind(expr: ts.Expression, source: ts.SourceFile, vars: Map<string, ts.Expression>, depth = 0): boolean {
  if (depth > 4) return false
  const unwrapped = unwrapKindExpression(expr)
  if (unwrapped !== expr) return isExactKind(unwrapped, source, vars, depth + 1)
  if (ts.isStringLiteralLike(expr)) return expr.text === 'exact'
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'exact') return true
    const bound = vars.get(expr.text)
    return bound !== undefined ? isExactKind(bound, source, vars, depth + 1) : false
  }
  return false
}

/** 剥掉 `as const` / `satisfies T` / 括号 / 非空断言，拿到真正的取值表达式。 */
function unwrapKindExpression(expr: ts.Expression): ts.Expression {
  switch (expr.kind) {
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.NonNullExpression:
      return unwrapKindExpression((expr as ts.AsExpression).expression)
    default:
      return expr
  }
}

/**
 * 把 `path` 解析成"这条注册实际会用的路径文本"（可能不止一条 —— 工厂函数的每个调用点）。
 *
 *   - 显式字面量 ⇒ 它自己的源码文本（与旧口径逐字一致，登记表的键不变）；
 *   - 标识符（简写或 `path: SOME_CONST`）⇒ 优先同文件绑定；
 *   - 简写且是**工厂函数的形参** ⇒ 该工厂在**本文件里**的调用点实参（R29-AC1-04 的形态 A：
 *     路径只出现在调用点，函数体里只有一个形参名）。找不到调用点时退回标识符文本
 *     （宁可键难看，也不能"看不见"）。
 */
function resolveRoutePaths(
  node: ts.ObjectLiteralExpression,
  shape: ExactLiteralShape,
  source: ts.SourceFile,
  vars: Map<string, ts.Expression>,
): string[] {
  const pathExpr = shape.pathExpr!
  if (ts.isIdentifier(pathExpr)) {
    const bound = vars.get(pathExpr.text)
    if (bound !== undefined) return [bound.getText(source)]
    if (shape.pathIsShorthand) {
      const fromCalls = factoryCallSitePaths(node, pathExpr.text, source, vars)
      if (fromCalls.length > 0) return fromCalls
    }
    return [pathExpr.text]
  }
  return [pathExpr.getText(source)]
}

/** 工厂函数形态：`path` 是该函数形参 ⇒ 返回它在**本文件**里各调用点上的实参文本。 */
function factoryCallSitePaths(
  node: ts.ObjectLiteralExpression,
  paramName: string,
  source: ts.SourceFile,
  vars: Map<string, ts.Expression>,
): string[] {
  let enclosing: ts.FunctionDeclaration | undefined
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) {
      enclosing = parent
      break
    }
    if (ts.isFunctionExpression(parent) || ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent)) return []
  }
  if (enclosing === undefined || enclosing.name === undefined) return []
  const paramIndex = enclosing.parameters.findIndex(
    parameter => ts.isIdentifier(parameter.name) && parameter.name.text === paramName,
  )
  if (paramIndex < 0) return []
  const factoryName = enclosing.name.text
  const paths: string[] = []
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === factoryName) {
      const argument = current.arguments[paramIndex]
      if (argument !== undefined) {
        const text = ts.isIdentifier(argument) && vars.get(argument.text) !== undefined
          ? vars.get(argument.text)!.getText(source)
          : argument.getText(source)
        if (!paths.includes(text)) paths.push(text)
      }
    }
    ts.forEachChild(current, walk)
  }
  walk(source)
  return paths
}

/** 发现面 ↔ 登记表的**双向**对账（纯函数：自检直接喂合成输入）。 */
function reconcile(
  discovered: readonly string[],
  rows: ReadonlyMap<string, ExactRouteRow>,
): { readonly unregistered: readonly string[], readonly stale: readonly string[] } {
  const seen = new Set(discovered)
  return {
    unregistered: [...seen].filter(key => !rows.has(key)).sort(),
    stale: [...rows.keys()].filter(key => !seen.has(key) && rows.get(key)?.conditional !== true).sort(),
  }
}

/** 读一个仓库相对文件（不存在时抛错，让诊断指向文件名）。 */
function readRepoFile(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

describe('仓库级判据：每一个 exact 路由都挂了持有性证明，或写明为什么不必', () => {
  const discovered = discoverExactRoutes()

  it('发现器不是空转：全仓至少覆盖到六个注册包', () => {
    expect(discovered.length, '一个 exact 路由都没发现 ⇒ 判据会空转').toBeGreaterThanOrEqual(30)
    const files = new Set(discovered.map(route => route.key.split('#')[0]))
    expect([...files].sort()).toEqual([
      'packages/client/account-card/src/index.ts',
      'packages/host/browser/src/index.ts',
      'packages/host/connectors/src/index.ts',
      'packages/host/cron/src/host-routes.ts',
      'packages/host/desktop/src/index.ts',
      'packages/host/enterprise/src/auth-gate.ts',
    ])
  })

  it('双向对账：新增未登记的 exact 路由即红，表里的死条目也红', () => {
    const { unregistered, stale } = reconcile(discovered.map(route => route.key), REPO_EXACT_ROUTE_POLICY)
    expect(
      unregistered,
      '这些 exact 路由没有登记：请先决定它挂不挂持有性证明（挂 ⇒ 写 gate；纯读 ⇒ 写明 reason）',
    ).toEqual([])
    expect(
      stale,
      '这些登记项已经没有对应的注册点了（改名/删除/搬文件）：请删掉或改写登记（"豁免表"不许变成免检区）',
    ).toEqual([])
  })

  it('每一行口径自洽：不挂证明的必须写明理由；挂证明的闸门调用点必须真实存在', () => {
    for (const [key, row] of REPO_EXACT_ROUTE_POLICY) {
      const file = key.split('#')[0]!
      expect(BEHAVIOUR_COVERAGE[file], `${file} 没有行为验证面的登记（verifiedBy 或 gap）`).toBeDefined()

      if (row.proof === 'none') {
        expect(row.reason?.length ?? 0, `${key}：纯读行必须写明为什么不必挂证明`).toBeGreaterThan(20)
        expect(row.gate, `${key}：纯读行不该声明闸门`).toBeUndefined()
        continue
      }

      const gate = row.gate
      expect(gate, `${key}：挂证明的行必须声明闸门调用点（<文件>#<符号>）`).toBeDefined()
      const hash = gate!.indexOf('#')
      const gateFile = gate!.slice(0, hash)
      const symbol = gate!.slice(hash + 1)
      expect(GATE_SYMBOLS.has(symbol), `${key}：${symbol} 不在已知闸门符号集合里（新增第四种判定必须先收敛）`).toBe(true)

      const gateText = readRepoFile(gateFile)
      expect(
        gateText.includes(`${symbol}(`),
        `${key}：声明的闸门 ${gate} 在 ${gateFile} 里根本没有被调用`,
      ).toBe(true)
      // 闸门必须接在**某一份写面判定实现**上：各自包的 `write-proof.ts`，或规范实现
      // `@picoaide/dsh-host-locale/loopback`。接不上的（局部闭包）必须写明 localGate。
      const onImplementation = gateFile.endsWith('write-proof.ts')
        || gateText.includes('write-proof')
        || gateText.includes('host-locale/loopback')
      if (!onImplementation) {
        expect(
          row.localGate?.length ?? 0,
          `${key}：闸门 ${gate} 既不在 write-proof.ts 里、也不 import 它 —— 必须写明 localGate 理由（不许静默各写一份判定）`,
        ).toBeGreaterThan(40)
      }
      if (row.proof === 'consuming-only') {
        expect(row.reason?.length ?? 0, `${key}：同路由两种语义并存时必须写明哪一半是读、哪一半是写`).toBeGreaterThan(20)
      }
    }
  })

  it('行为验证面：verifiedBy 指向的 spec 必须真的存在，gap 必须写明为什么还没有', () => {
    for (const [file, coverage] of Object.entries(BEHAVIOUR_COVERAGE)) {
      expect(
        coverage.verifiedBy !== undefined || (coverage.gap?.length ?? 0) > 20,
        `${file} 既没有 verifiedBy、也没有写 gap（"未验证"不许静默）`,
      ).toBe(true)
      if (coverage.verifiedBy !== undefined) {
        const spec = readRepoFile(coverage.verifiedBy)
        expect(spec.length, `${file} 的 verifiedBy 指向空文件`).toBeGreaterThan(0)
      }
    }
  })

  it('判据自检：对账两个方向都能红（发现器换成"恒真/恒红"都不成立）', () => {
    const rows = new Map<string, ExactRouteRow>([
      ['a.ts#/x', { proof: 'none', reason: '纯读' }],
      ['b.ts#/y', { proof: 'all', gate: 'g.ts#acceptWriteProof' }],
      ['c.ts#/z', { proof: 'none', reason: '条件注册', conditional: true }],
    ])
    // ① 发现到一个没登记的路由 ⇒ unregistered 非空。
    expect(reconcile(['a.ts#/x', 'b.ts#/y', 'new.ts#/w'], rows).unregistered).toEqual(['new.ts#/w'])
    // ② 登记项没有对应注册点 ⇒ stale 非空；`conditional` 的那一行不算陈旧。
    expect(reconcile(['a.ts#/x', 'b.ts#/y'], rows).stale).toEqual([])
    expect(reconcile(['a.ts#/x'], rows).stale).toEqual(['b.ts#/y'])
    // ③ 完整一致时两个方向都为空（否则上面两条就是空断言）。
    expect(reconcile(['a.ts#/x', 'b.ts#/y', 'c.ts#/z'], rows)).toEqual({ unregistered: [], stale: [] })
  })
})
