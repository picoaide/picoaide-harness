/**
 * 应用 AI 的**首次授权记录**（设计总纲 §21.1 第 9 条 / §21.6 判据 2、3）。
 *
 * ## 授权维度（2026-09-26 口径变更，第二十一轮审计 B2-R21-01）
 *
 * 键 = **用户 ⊕ 服务端 ⊕ 应用**（`user\0server\0app`；{@link aiConsentKey} 是唯一实现，
 * 读面与写面都只经它构造键）。变更前只有两段（`user\0app`），于是同一台机器上把客户端
 * 指向**另一个服务端部署**（= 换租户，本仓测试/正式并存 + 同机第二栈是常态）之后，
 * 同名用户**一次授权动作都不做**就能继续花这个账号的 token —— 而同一个包的隐藏会话 id
 * 早就按 `user@serverHash` 分域（`ai-chat.ts` 模块头理由②），"两个租户同名 = 两个人"
 * 在本包是既定事实：**会话分域、授权不分域**。兄弟闸门
 * `packages/host/enterprise/src/wasm-apps-ai-rows-consent.ts`（AI 读应用行数据）在
 * 第十九轮（R19B-03）已按"用户 ⊕ 服务端 ⊕ 应用"改过，本模块现在与它**同一份语义**。
 *
 * 三条推论：
 *  - **任一段缺失即不匹配**：拿不到用户名 / 服务端地址 / app_id ⇒ 读面 `false`、写面
 *    **拒绝**（{@link AiConsentScopeError}；本机路由据此回 401 `AUTH_REQUIRED`）。
 *    绝不落一条"谁都不是"的记录 —— 下一个人可能正好撞上它。**拿不到服务端身份不得
 *    当成"无服务端"**（那等于把服务端维度整个删掉，正是本条要修的形态）。
 *  - 落盘形状升 **`version: 2`**（`grants: [{user, server, app}]`）。**未知版本一律当作
 *    未授权**：v1 的 `{version: 1, grants: [{user, app}]}` 没有服务端段，把它的内容读成
 *    "已授权"正是本条要修的方向。升级后第一次授权会把文件就地改写为 v2。
 *  - 授权/撤销只影响**当前这一段作用域**：别的账号/服务端的记录留在文件里（它们回来仍在），
 *    当前作用域看不到它们。
 *
 * ## 三条纪律
 *
 *  1. **fail-closed**：文件读不出来 / 形状不符 / 作用域拿不到 ⇒ 一律当作**未授权**
 *     （`isGranted` 为 false）。反过来（读失败当成已授权）等于"把磁盘故障变成静默放行"。
 *  2. **写失败要报**：`grant`/`revoke` 写不进去时抛给调用方 —— 静默吞掉会让用户看到
 *     "已允许"但闸门仍然拒绝（或反过来"已撤销"但仍然放行），两者都是安全语义错误。
 *     读失败（除 ENOENT）同样归入这一条：**读不动的文件绝不能被下一次写整份覆盖**
 *     （见 {@link AiConsentReadError}）。
 *  3. **判据顺序**：闸门（`handleAiChat`）先查 `isGranted` 再碰模型 ⇒ 未授权时**零 token**。
 *
 * @module @picoaide/dsh-wasm-apps-host/ai-authorization
 */

import { readFile } from 'node:fs/promises'
// 原子替换走上游 `@deepseek-ai/dsh-atomic-write`（2026-09-20 W6/W7 切换，见设计总纲 §16.1）：
// 包内本地助手已删除，权限位由调用点逐处声明。
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AiChatAuthorization, AiChatScope } from './ai-chat.ts'

/** 授权状态文件名（落在 `config.userDataDir` 下；宿主私有目录）。 */
export const AI_CONSENT_FILE_NAME = 'wasm-apps-ai-consent.json'

/**
 * 文件格式版本（形状变更时递增；未知版本 ⇒ 当作空记录，fail-closed）。
 *
 * v1 = `{version: 1, grants: [{user, app}]}`（用户级，– 2026-09-26）；
 * v2 = `{version: 2, grants: [{user, server, app}]}`（B2-R21-01 起）。
 * **v1 文件不会被读成"已授权"**，见模块头。
 */
export const AI_CONSENT_FORMAT_VERSION = 2

/** 一个用户在一台服务端上对一个应用的授权条目（各段都是原文，落盘时按行 JSON 编码）。 */
interface ConsentEntry {
  readonly user: string
  readonly server: string
  readonly app: string
}

/** 落盘形状。 */
interface ConsentDocument {
  readonly version: number
  readonly grants: readonly ConsentEntry[]
}

/**
 * NUL 会不会出现在这一段里（{@link aiConsentKey} 的分隔符）。
 *
 * 分隔符出现在**段内**会让一个键被切成更多段 ⇒ 序列化期要么失去这条记录（写面报成功、
 * 读面 false：面板显示"已允许"而闸门仍拒绝），要么把它读成另一个 (user, server, app)
 * 组合。两种都不能接受，所以在**构造期**就拒绝（fail-closed），不靠序列化期兜底。
 * @param value - 候选段。
 * @returns true = 含 NUL（该段不可用于键）。
 */
const hasNul = (value: string): boolean => value.includes('\u0000')

/**
 * 授权键（**唯一实现**）：三段都必须参与，任一段缺失/非法 ⇒ `null`（= 不匹配）。
 *
 * 用 NUL 分隔而不是可见字符：用户名/服务端地址/应用 id 都可能含可见分隔符，而 NUL
 * 不可能出现在任一维度的合法取值里（`isValidAppId` 只放行小写字母/数字/连字符，
 * 用户名与服务端地址来自平台）。三段各做一次 `trim()` 后判空 —— 纯空白不算"有值"。
 * @param scope - 当前账号 + 服务端地址；`null`/`undefined` = 拿不到（未登录 / 缺字段）。
 * @param appId - 应用标识。
 * @returns 记录键；任一段缺失或含 NUL ⇒ `null`。
 */
export function aiConsentKey(scope: AiChatScope | null | undefined, appId: string): string | null {
  if (scope === null || scope === undefined) return null
  const user = typeof scope.userId === 'string' ? scope.userId.trim() : ''
  const server = typeof scope.serverURL === 'string' ? scope.serverURL.trim() : ''
  const app = typeof appId === 'string' ? appId.trim() : ''
  if (user === '' || server === '' || app === '') return null
  if (hasNul(user) || hasNul(server) || hasNul(app)) return null
  return `${user}\u0000${server}\u0000${app}`
}

/**
 * 写面在**拿不到作用域**时的拒绝（`grant`/`revoke`）。
 *
 * 为什么是一个专门类型而不是普通 `Error`：本机路由要把它**原样**映射成 401
 * `AUTH_REQUIRED`，而"磁盘写失败"必须继续是 500 `CONSENT_NOT_PERSISTED`。两者混在
 * 一个 `Error` 里就只能靠字符串判因 —— 那正是本仓登记过的"靠错误消息分支"缺陷形态。
 * @param message - 诊断文案（面向上游日志，不是用户文案）。
 */
export class AiConsentScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiConsentScopeError'
  }
}

/**
 * 这个错误是不是"拿不到作用域"（见 {@link AiConsentScopeError}）。
 * @param cause - 任意捕获到的值。
 * @returns true = 调用方应回 401 `AUTH_REQUIRED`。
 */
export function isAiConsentScopeError(cause: unknown): cause is AiConsentScopeError {
  return cause instanceof AiConsentScopeError
}

/**
 * 授权文件**读不动**（存在、但不是 ENOENT 的读失败）时的写面拒绝。
 *
 * 为什么必须单独存在：`load()` 的 fail-closed 是"读不出来 ⇒ 当作未授权"，但**写面**
 * 不能沿用这个空集合 —— 记录文件可能被另一个 uid 拥有 / EIO / 杀软锁住，而它所在的
 * **目录仍可写**（`rename(2)` 只需要目录写权限）。此时一次 `grant` 就会把文件里其余
 * 账号/应用的授权**整份覆盖掉**，而调用方收到的是成功。只有 `ENOENT`（从来没人授权过）
 * 才允许建文件；其余 errno 一律拒绝写并如实报错。
 * @param message - 诊断文案（面向上游日志，不是用户文案）。
 */
export class AiConsentReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiConsentReadError'
  }
}

/**
 * 这个错误是不是"授权文件读不动"（见 {@link AiConsentReadError}）。
 * @param cause - 任意捕获到的值。
 * @returns true = 调用方应把它报成"授权未能保存"（500），而不是作用域拒绝。
 */
export function isAiConsentReadError(cause: unknown): cause is AiConsentReadError {
  return cause instanceof AiConsentReadError
}

/**
 * 解析授权文件（**严格**：任何一条不符即整份作废）。
 *
 * 为什么整份作废而不是跳过坏条目：这份文件是"谁能花我的 token"的白名单，静默跳过
 * 会让一条被篡改/损坏的记录变成"其余授权仍然有效"的假象；整份作废的代价是重新授权
 * 一次，方向安全。
 * @param text - 文件原文。
 * @returns 授权键集合；形状不符 ⇒ `null`。
 */
export function parseAiConsent(text: string): Set<string> | null {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as { version?: unknown, grants?: unknown }
  // 版本必须**逐字**等于当前版本：v1（没有服务端段）以及任何未来的形状都当作"未授权"。
  if (row.version !== AI_CONSENT_FORMAT_VERSION) return null
  if (!Array.isArray(row.grants)) return null
  const keys = new Set<string>()
  for (const entry of row.grants) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const candidate = entry as { user?: unknown, server?: unknown, app?: unknown }
    if (typeof candidate.user !== 'string' || typeof candidate.server !== 'string' || typeof candidate.app !== 'string') return null
    const key = aiConsentKey({ userId: candidate.user, serverURL: candidate.server }, candidate.app)
    // 空段 / 纯空白段 / 含 NUL 的段 ⇒ 整份作废（与"任一段缺失即不匹配"同一条口径）。
    if (key === null) return null
    keys.add(key)
  }
  return keys
}

/**
 * 把键集合序列化回文件形状（稳定排序：两份内容相同的记录逐字节相同 ⇒ 便于对拍）。
 *
 * 无法解析回三段的键**抛错**而不是静默丢弃：丢弃会让 `grant` 照常 resolve，而文件里
 * 没有这条记录 ⇒ 面板显示"已允许"、闸门仍拒绝（用户看到的是"AI 坏了"）。
 * @param keys - 授权键集合。
 * @returns 文件原文（带结尾换行）。
 */
export function serializeAiConsent(keys: ReadonlySet<string>): string {
  const grants: ConsentEntry[] = []
  for (const key of keys) {
    const [user, server, app, ...rest] = key.split('\u0000')
    if (rest.length > 0 || user === undefined || server === undefined || app === undefined) {
      throw new Error('pico-wasm-apps-host: refusing to serialize an app AI consent key that is not <user>\\0<server>\\0<app>')
    }
    grants.push({ user, server, app })
  }
  grants.sort((left, right) => {
    if (left.user !== right.user) return left.user < right.user ? -1 : 1
    if (left.server !== right.server) return left.server < right.server ? -1 : 1
    return left.app < right.app ? -1 : 1
  })
  const document: ConsentDocument = { version: AI_CONSENT_FORMAT_VERSION, grants }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** {@link createAiChatAuthorization} 的构造参数。 */
export interface AiChatAuthorizationOptions {
  /**
   * 记录文件绝对路径；缺席 ⇒ **只在内存里**（纯 Node 宿主/单测）。
   *
   * 内存形态只用于没有私有目录的宿主：真实桌面客户端一定给路径（否则重启即忘记授权，
   * 用户每次都要重新点"允许"）。
   */
  file?: string | undefined
  /** 诊断出口（文件损坏 / 读失败）。 */
  warn?: ((message: string) => void) | undefined
}

/**
 * 一次 `load()` 的结局。
 *
 * `readable === false` = 文件存在但**读不动**（非 ENOENT）⇒ 读面按未授权处理，写面
 * 必须拒绝（{@link AiConsentReadError}）——**读到内容但形状不符**不在此列：那是可以
 * 就地改写的旧格式/坏文件（v1 → v2 的升级路径就靠它）。
 */
interface ConsentLoad {
  /** 解析出的键集合（读失败/形状不符 ⇒ 空集合）。 */
  readonly keys: Set<string>
  /** 是否可以把这次的结果写回去（只有"读不动"为 false）。 */
  readonly writable: boolean
}

/**
 * 构造宿主侧的授权记录（`AiChatAuthorization` 的实现）。
 *
 * 每次调用都重新读文件（这是"用户点允许 → 下一次调用立刻生效"这条判据的唯一实现；
 * 缓存会让撤销/授权延迟到重启）。文件很小（一条授权 ≈ 90 字节），代价可忽略。
 * @param options - 记录文件与诊断出口。
 * @returns 授权记录实现。
 */
export function createAiChatAuthorization(options: AiChatAuthorizationOptions = {}): AiChatAuthorization {
  const warn = options.warn ?? ((): void => {})
  /** 内存形态的当前集合（`file === undefined` 时是真源；有文件时只是写序列化缓冲）。 */
  let memory = new Set<string>()
  /** 写串行化：并发 grant/revoke 不得互相覆盖（读-改-写必须原子成一段）。 */
  let tail: Promise<void> = Promise.resolve()

  const load = async (): Promise<ConsentLoad> => {
    if (options.file === undefined) return { keys: new Set(memory), writable: true }
    let text: string
    try {
      text = await readFile(options.file, 'utf8')
    } catch (cause) {
      // 文件不存在 = 从来没人授权过（**不是**错误）：只有它算"首次运行"，也才允许建文件。
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { keys: new Set(), writable: true }
      // 读失败（权限/EIO）⇒ fail-closed 到"无授权"，但必须留痕：静默会让"磁盘坏了"
      // 与"没人授权"长得一样。**同时把写面也关掉**（读不动的文件不得被整份覆盖）。
      warn(`pico-wasm-apps-host: reading the app AI consent file failed (${cause instanceof Error ? cause.message : String(cause)}); treating every grant as absent and refusing writes`)
      return { keys: new Set(), writable: false }
    }
    const parsed = parseAiConsent(text)
    if (parsed === null) {
      // 文件**读到了**（只是形状不符）⇒ 允许就地改写成当前版本，否则 v1 用户永远
      // 无法重新授权。方向安全：这一份内容本来就不被当成任何授权。
      warn(`pico-wasm-apps-host: the app AI consent file at ${options.file} is not a version ${String(AI_CONSENT_FORMAT_VERSION)} record; treating every grant as absent`)
      return { keys: new Set(), writable: true }
    }
    return { keys: parsed, writable: true }
  }

  const persist = (keys: Set<string>): Promise<void> => {
    memory = keys
    if (options.file === undefined) return Promise.resolve()
    return writeFileAtomic(options.file, serializeAiConsent(keys), { mode: 0o600, dirMode: 0o700 })
  }

  /** 读-改-写串行化（前一段失败不能让后一段永远挂在 rejected 链上）。 */
  const mutate = (change: (keys: Set<string>) => void): Promise<void> => {
    const task = tail.then(async () => {
      const loaded = await load()
      if (!loaded.writable) {
        // 读不动的文件 + 可写的目录 = 下一次 rename 会静默销毁其它账号/应用的记录。
        throw new AiConsentReadError(
          `pico-wasm-apps-host: the app AI consent file at ${String(options.file)} could not be read; refusing to overwrite it`,
        )
      }
      change(loaded.keys)
      await persist(loaded.keys)
    })
    tail = task.catch(() => undefined)
    return task
  }

  /**
   * 键构造（**唯一调用点**：读面与写面都走这里 —— 各自拼键 = 判据键与记账键可能不同源）。
   * @param userId - 当前员工标识。
   * @param appId - 应用标识。
   * @param serverURL - 当前服务端地址；缺席 ⇒ `null`（= 不可匹配 / 不可写）。
   * @returns 键或 `null`。
   */
  const keyFor = (userId: string, appId: string, serverURL: string | null | undefined): string | null =>
    aiConsentKey({ userId, serverURL: serverURL ?? null }, appId)

  return {
    async isGranted(userId: string, appId: string, serverURL?: string | null): Promise<boolean> {
      const key = keyFor(userId, appId, serverURL)
      // 作用域缺失 = 不匹配（不是"匹配空作用域"）：拿不到账号/服务端的会话看不到任何授权。
      if (key === null) return false
      const loaded = await load()
      return loaded.keys.has(key)
    },
    grant(userId: string, appId: string, serverURL?: string | null): Promise<void> {
      const key = keyFor(userId, appId, serverURL)
      if (key === null) {
        // fail-closed：写一条"谁都不是"的记录比拒绝更糟（下一个账号可能正好撞上它）。
        return Promise.reject(new AiConsentScopeError(
          'pico-wasm-apps-host: an app AI grant needs the current user, server address and app id; this session does not provide all three',
        ))
      }
      return mutate((keys) => { keys.add(key) })
    },
    revoke(userId: string, appId: string, serverURL?: string | null): Promise<void> {
      const key = keyFor(userId, appId, serverURL)
      if (key === null) {
        return Promise.reject(new AiConsentScopeError(
          'pico-wasm-apps-host: an app AI revocation needs the current user, server address and app id; this session does not provide all three',
        ))
      }
      return mutate((keys) => { keys.delete(key) })
    },
  }
}
