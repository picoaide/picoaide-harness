/**
 * 「**允许 AI 读取此应用的数据**」的宿主侧授权状态（2026-09-21 用户拍板：
 * **默认关 + 显式授权卡**）。
 *
 * ## 为什么需要它
 *
 * `wasm_app_rows`（AI 读应用库行数据）此前是**默认开**的：工具一注册，模型就能读
 * 脱敏后的行，而"作者本人从未做过任何授权动作"这件事没有任何记录。规划
 * `docs/planning/2026-09-21-wasm-platform-gap-audit-and-plan.md` §5.9 第 2 点推荐的是
 * "默认关 + 显式授权卡"，本模块就是那条推荐的落地：**没有授权 = 工具结构化拒绝且零出站**。
 *
 * ## 两侧共用一个真源
 *
 * 授权动作由**人在客户端面板**里做（渲染进程），而闸门在**宿主工具**里（主进程）。
 * 两边靠这一份状态连通，路径与既有写法一致（`server-connector/tls.ts` 的指纹库）：
 * **`$DSH_HOME/wasm-apps-ai-rows-consent.json`**（0600，原子写）。选它而不是
 * `ctx.settings`：设置域是"用户可编辑的产品配置"，而这一份是**授权记录**
 * （与 `wasm-apps-host` 的 `wasm-apps-ai-consent.json` 同一族），且 `bootstrap.ts`
 * 在退出登录时会 `ctx.settings.replace(...)` 清掉自己的命名空间 —— 把授权放进设置域
 * 会让"重启/重登后授权消失"。
 *
 * ## 授权维度（2026-09-25 口径变更，第十九轮审计 R19B-03）
 *
 * 键 = **用户 ⊕ 服务端 ⊕ 应用**（`user\0server\0app`；{@link aiRowsConsentKey} 是唯一
 * 实现，读面与写面都只经它构造键）。
 *
 * 变更前只按 `app_id`（**机器级**）：同一台机器换账号、或把客户端指到另一个服务端
 * （= 换租户）之后，下一个人**原样继承**上一个人的授权 —— 被绕过的正是"默认关 +
 * 显式授权"这条产品拍板本身。兄弟闸门 `packages/host/wasm-apps-host/src/ai-authorization.ts`
 * 的模块头早就把口径写死："换账号（或换服务端地址 ⇒ 不同 username）**不得**继承上一个人
 * 的授权"；本模块现在与它对齐，并且把服务端地址**显式**并入键（同一个用户名在两台
 * 服务端上是两个人，靠"username 恰好不同"来区分租户是巧合而不是判据）。
 *
 * 三条推论：
 *  - **任一段缺失即不匹配**：拿不到用户名 / 服务端地址 / app_id ⇒ 读面 `false`、写面
 *    **拒绝**（{@link AiRowsConsentScopeError}；本机路由据此回 401 `AUTH_REQUIRED`，
 *    与兄弟闸门"拿不到用户名 ⇒ 401"同形）。绝不落一条"谁都不是"的记录 —— 下一个人
 *    可能正好撞上它。
 *  - 落盘形状升 **`version: 2`**（`grants: [{user, server, app}]`）。**未知版本一律当作
 *    全未授权**：v1 的 `{version: 1, apps: [...]}` 是机器级记录，把它的内容读成"已授权"
 *    正是本条要修的方向。升级后第一次授权会把文件就地改写为 v2（v1 记录就此作废）。
 *  - 授权/撤销只影响**当前这一段作用域**：A 的记录留在文件里（A 回来仍在），B 看不到它。
 *
 * ## 三条纪律（与 `wasm-apps-host/src/ai-authorization.ts` 同款）
 *
 *  1. **fail-closed**：文件读不出来 / 形状不符 / 作用域拿不到 ⇒ 一律当作**没有任何应用
 *     被授权**。反过来（读失败当成已授权）等于"把磁盘故障变成静默放行"。
 *  2. **写失败要报**：`setEnabled` 写不进去时抛给调用方 —— 静默吞掉会让用户看到
 *     "已允许"而闸门仍然拒绝。
 *  3. **每次调用都重新读文件、重新解析作用域**：这是"用户点授权 → 下一次工具调用立刻
 *     生效"与"换了账号立刻失效"这两条判据的唯一实现（缓存会让撤销/换账号延迟到重启）。
 *     文件很小（一条 ≈ 80 字节）。
 *
 * @module @picoaide/dsh-enterprise/wasm-apps-ai-rows-consent
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'

/** 授权状态文件名（落在数据根 `$DSH_HOME` 下；0600）。 */
export const AI_ROWS_CONSENT_FILE_NAME = 'wasm-apps-ai-rows-consent.json'

/**
 * 文件格式版本（形状变更时递增；未知版本 ⇒ 当作空记录，fail-closed）。
 *
 * v1 = `{version: 1, apps: [app_id]}`（机器级，2026-09-21 – 2026-09-25）；
 * v2 = `{version: 2, grants: [{user, server, app}]}`（R19B-03 起）。
 * **v1 文件不会被读成"已授权"**，见模块头。
 */
export const AI_ROWS_CONSENT_FORMAT_VERSION = 2

/** 一段授权的作用域：谁（用户名）、在哪台服务端上（服务端地址）。 */
export interface AiRowsConsentScope {
  /** 当前员工标识（`Session.username`）。 */
  readonly user: string
  /** 当前服务端地址（`Session.serverURL`；不同地址 = 不同租户）。 */
  readonly server: string
}

/** 一段授权记录（落盘形状的一条）。 */
interface ConsentGrant {
  readonly user: string
  readonly server: string
  readonly app: string
}

/** 落盘形状。 */
interface ConsentDocument {
  readonly version: number
  readonly grants: readonly ConsentGrant[]
}

/**
 * 授权键（**唯一实现**）：三段都必须参与，任一段缺失 ⇒ `null`（= 不匹配）。
 *
 * 用 NUL 分隔而不是可见字符：用户名/服务端地址/应用 id 都可能含可见分隔符，而 NUL
 * 不可能出现在任一维度的合法取值里（`isValidAppId` 只放行小写字母/数字/连字符，
 * 用户名与服务端地址来自平台）。三段各做一次 `trim()` 后判空 —— 纯空白不算"有值"。
 * @param scope - 当前作用域；`null`/`undefined` = 拿不到（未登录 / 会话缺字段）。
 * @param appId - 应用标识。
 * @returns 记录键；任一段缺失 ⇒ `null`。
 */
export function aiRowsConsentKey(scope: AiRowsConsentScope | null | undefined, appId: string): string | null {
  if (scope === null || scope === undefined) return null
  const user = typeof scope.user === 'string' ? scope.user.trim() : ''
  const server = typeof scope.server === 'string' ? scope.server.trim() : ''
  const app = typeof appId === 'string' ? appId.trim() : ''
  if (user === '' || server === '' || app === '') return null
  return `${user}\u0000${server}\u0000${app}`
}

/**
 * 写面在**拿不到作用域**时的拒绝（`setEnabled`）。
 *
 * 为什么是一个专门类型而不是普通 `Error`：本机路由要把它**原样**映射成 401
 * `AUTH_REQUIRED`（与兄弟闸门同形），而"磁盘写失败"必须继续是 500
 * `AI_ROWS_CONSENT_NOT_PERSISTED`。两者混在一个 `Error` 里就只能靠字符串判因 ——
 * 那正是本仓登记过的"靠错误消息分支"缺陷形态。
 */
export class AiRowsConsentScopeError extends Error {
  /** @param message - 诊断文案（面向上游日志，不是用户文案）。 */
  constructor(message: string) {
    super(message)
    this.name = 'AiRowsConsentScopeError'
  }
}

/**
 * 这个错误是不是"拿不到作用域"（见 {@link AiRowsConsentScopeError}）。
 * @param cause - 任意捕获到的值。
 * @returns true = 调用方应回 401 `AUTH_REQUIRED`。
 */
export function isAiRowsConsentScopeError(cause: unknown): cause is AiRowsConsentScopeError {
  return cause instanceof AiRowsConsentScopeError
}

/**
 * 默认落盘位置：`$DSH_HOME/wasm-apps-ai-rows-consent.json`。
 *
 * 数据根随渠道（`dshHomeSafe()` 是唯一权威，见 `dsh-plugin-desktop/desktop-home`），
 * 因此渠道客户端之间的授权互不可见（换渠道 = 换数据根 = 重新授权，方向安全）。
 * @param env - 环境变量（测试注入用）。
 * @returns 绝对路径。
 */
export function defaultAiRowsConsentPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHomeSafe({ env }), AI_ROWS_CONSENT_FILE_NAME)
}

/**
 * 解析授权文件（**严格**：任何一条不符即整份作废）。
 *
 * 为什么整份作废而不是跳过坏条目：这份文件是"AI 能读哪些应用的数据"的白名单，
 * 静默跳过会让一条被篡改/损坏的记录变成"其余授权仍然有效"的假象；整份作废的代价是
 * 重新授权一次，方向安全。
 * @param text - 文件原文。
 * @returns 已授权的记录键集合（{@link aiRowsConsentKey} 构造）；形状不符 ⇒ `null`。
 */
export function parseAiRowsConsent(text: string): Set<string> | null {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as { version?: unknown, grants?: unknown }
  // 版本必须**逐字**等于当前版本：v1（机器级）以及任何未来的形状都当作"全未授权"。
  if (row.version !== AI_ROWS_CONSENT_FORMAT_VERSION) return null
  if (!Array.isArray(row.grants)) return null
  const keys = new Set<string>()
  for (const entry of row.grants) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const candidate = entry as { user?: unknown, server?: unknown, app?: unknown }
    if (typeof candidate.user !== 'string' || typeof candidate.server !== 'string' || typeof candidate.app !== 'string') return null
    const key = aiRowsConsentKey({ user: candidate.user, server: candidate.server }, candidate.app)
    // 空段 / 纯空白段 ⇒ 整份作废（与"任一段缺失即不匹配"同一条口径）。
    if (key === null) return null
    keys.add(key)
  }
  return keys
}

/**
 * 把授权集合序列化回文件形状（稳定排序：两份内容相同的记录逐字节相同 ⇒ 便于对拍）。
 * @param keys - 授权键集合（{@link aiRowsConsentKey} 的产物）。
 * @returns 文件原文（带结尾换行）。
 */
export function serializeAiRowsConsent(keys: ReadonlySet<string>): string {
  const grants: ConsentGrant[] = []
  for (const key of keys) {
    const [user, server, app, ...rest] = key.split('\u0000')
    if (rest.length > 0 || user === undefined || server === undefined || app === undefined) continue
    grants.push({ user, server, app })
  }
  grants.sort((left, right) => {
    if (left.user !== right.user) return left.user < right.user ? -1 : 1
    if (left.server !== right.server) return left.server < right.server ? -1 : 1
    return left.app < right.app ? -1 : 1
  })
  const document: ConsentDocument = { version: AI_ROWS_CONSENT_FORMAT_VERSION, grants }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * 授权状态的读写面（宿主工具读它，本机路由写它 —— **同一个实例**）。
 *
 * **作用域由 store 自己解析**（构造参数 `scope`，每次调用求值）：调用方拿不到
 * "传错作用域"的机会，读面与写面也不可能用两套键构造。
 */
export interface AiRowsConsentStore {
  /**
   * 这个应用在**当前作用域**下是否已被授权给 AI 读数据（**每次调用重新读盘**）。
   * @param appId - 应用标识。
   * @returns true = 已授权；作用域缺失 / 任何读·解析失败都返回 false（fail-closed）。
   */
  isEnabled(appId: string): Promise<boolean>
  /**
   * 写入**当前作用域**下的授权（人在面板上点「允许」/「撤销」）。
   *
   * 拿不到作用域（未登录 / 缺用户名 / 缺服务端地址）⇒ 拒绝并抛
   * {@link AiRowsConsentScopeError}（调用方据此回 401，绝不落一条陌生记录）。
   * @param appId - 应用标识。
   * @param enabled - true = 允许，false = 撤销。
   */
  setEnabled(appId: string, enabled: boolean): Promise<void>
}

/** {@link createAiRowsConsentStore} 的构造参数。 */
export interface AiRowsConsentStoreOptions {
  /**
   * 记录文件绝对路径；缺席 ⇒ **只在内存里**（纯 Node 宿主/单测）。
   *
   * 内存形态只用于没有私有目录的宿主：真实桌面客户端一定给路径（否则重启即忘记授权，
   * 用户每次都要重新点「允许」）。
   */
  file?: string | undefined
  /**
   * 当前作用域（**每次调用求值**，不是构造期快照）：登录/换账号/换服务端都发生在
   * 同一个进程里，快照会让"换了账号仍旧带着上一个人的作用域"。
   *
   * 缺席 / 返回 `null` / 抛错 ⇒ 一律当作**拿不到作用域**（读面 false、写面拒绝）。
   */
  scope?: (() => AiRowsConsentScope | null | undefined) | undefined
  /** 诊断出口（文件损坏 / 读失败 / 作用域解析抛错）。 */
  warn?: ((message: string) => void) | undefined
}

/**
 * 构造授权记录。
 *
 * 并发写安全：读-改-写整段串行化（两次并发 `setEnabled` 不得互相覆盖），
 * 落盘走"同目录临时文件 + rename"（半个文件被读到不会变成一份**有效**记录 ——
 * 它要么是旧内容，要么是新内容，要么解析失败 ⇒ fail-closed 到"全未授权"）。
 * @param options - 记录文件、作用域来源与诊断出口。
 * @returns 授权记录实现。
 */
export function createAiRowsConsentStore(options: AiRowsConsentStoreOptions = {}): AiRowsConsentStore {
  const warn = options.warn ?? ((): void => {})
  /** 内存形态的当前集合（`file === undefined` 时是真源；有文件时只是写序列化缓冲）。 */
  let memory = new Set<string>()
  /** 写串行化：并发 setEnabled 不得互相覆盖（读-改-写必须原子成一段）。 */
  let tail: Promise<void> = Promise.resolve()
  /** 临时文件名去重（同进程内两次写不能撞名）。 */
  let writes = 0

  /**
   * 当前作用域（唯一解析点）：provider 抛错 = 拿不到（fail-closed + 留痕）。
   * @returns 作用域或 `null`。
   */
  const currentScope = (): AiRowsConsentScope | null => {
    if (options.scope === undefined) return null
    try {
      return options.scope() ?? null
    } catch (cause) {
      warn(`pico-wasm-apps: resolving the AI rows consent scope failed (${cause instanceof Error ? cause.message : String(cause)}); treating every app as unauthorized`)
      return null
    }
  }

  /**
   * 键构造（**唯一调用点**：读面与写面都走这里）。
   * @param appId - 应用标识。
   * @returns 键或 `null`（= 不匹配 / 不可写）。
   */
  const keyFor = (appId: string): string | null => aiRowsConsentKey(currentScope(), appId)

  const load = async (): Promise<Set<string>> => {
    if (options.file === undefined) return new Set(memory)
    let text: string
    try {
      text = await readFile(options.file, 'utf8')
    } catch (cause) {
      // 文件不存在 = 从来没人授权过（**不是**错误，也不建文件：读路径不该有副作用）。
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      // 读失败（权限/EIO）⇒ fail-closed 到"无授权"，但必须留痕：静默会让"磁盘坏了"
      // 与"没人授权"长得一样。
      warn(`pico-wasm-apps: reading the AI rows consent file failed (${cause instanceof Error ? cause.message : String(cause)}); treating every app as unauthorized`)
      return new Set()
    }
    const parsed = parseAiRowsConsent(text)
    if (parsed === null) {
      warn(`pico-wasm-apps: the AI rows consent file at ${options.file} is not a version ${String(AI_ROWS_CONSENT_FORMAT_VERSION)} record; treating every app as unauthorized`)
      return new Set()
    }
    return parsed
  }

  const persist = async (keys: Set<string>): Promise<void> => {
    memory = keys
    if (options.file === undefined) return
    const target = options.file
    const temporary = `${target}.${String(process.pid)}.${String((writes += 1))}.tmp`
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, serializeAiRowsConsent(keys), { mode: 0o600 })
      await rename(temporary, target)
    } catch (cause) {
      // 临时文件残留会让人以为"写了一半"；尽力清掉，再把失败报给调用方。
      await rm(temporary, { force: true }).catch(() => undefined)
      throw cause
    }
  }

  /** 读-改-写串行化（前一段失败不能让后一段永远挂在 rejected 链上）。 */
  const mutate = (change: (keys: Set<string>) => void): Promise<void> => {
    const task = tail.then(async () => {
      const keys = await load()
      change(keys)
      await persist(keys)
    })
    tail = task.catch(() => undefined)
    return task
  }

  return {
    async isEnabled(appId: string): Promise<boolean> {
      const key = keyFor(appId)
      // 作用域缺失 = 不匹配（不是"匹配空作用域"）：未登录 / 缺字段的用户看不到任何授权。
      if (key === null) return false
      const keys = await load()
      return keys.has(key)
    },
    setEnabled(appId: string, enabled: boolean): Promise<void> {
      const key = keyFor(appId)
      if (key === null) {
        // fail-closed：写一条"谁都不是"的记录比拒绝更糟（下一个账号可能正好撞上它）。
        return Promise.reject(new AiRowsConsentScopeError(
          'pico-wasm-apps: an AI rows consent needs the current user, server address and app id; this session does not provide all three',
        ))
      }
      return mutate((keys) => {
        if (enabled) keys.add(key)
        else keys.delete(key)
      })
    },
  }
}
