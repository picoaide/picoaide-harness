/**
 * 应用 AI 的**首次授权记录**（设计总纲 §21.1 第 9 条 / §21.6 判据 2、3）。
 *
 * 授权维度是 **用户 × 应用**：换账号（或换服务端地址 ⇒ 不同 username）**不得**继承上
 * 一个人的授权。记录落在宿主私有目录里的一个文件（0600，原子写）：AI 授权是"这个员工
 * 允许这个应用花自己的 token"，不是渲染层的一次性 UI 状态 —— 落盘在宿主侧，页面刷新、
 * 换窗口、重开应用都还在，撤销也只需要一处真源。
 *
 * 三条纪律：
 *
 *  1. **fail-closed**：文件读不出来 / 形状不符 ⇒ 一律当作**未授权**（`isGranted` 为
 *     false）。反过来（读失败当成已授权）等于"把磁盘故障变成静默放行"。
 *  2. **写失败要报**：`grant`/`revoke` 写不进去时抛给调用方 —— 静默吞掉会让用户看到
 *     "已允许"但闸门仍然拒绝（或反过来"已撤销"但仍然放行），两者都是安全语义错误。
 *  3. **判据顺序**：闸门（`handleAiChat`）先查 `isGranted` 再碰模型 ⇒ 未授权时**零 token**。
 *
 * @module @picoaide/dsh-wasm-apps-host/ai-authorization
 */

import { readFile } from 'node:fs/promises'
// 原子替换走上游 `@deepseek-ai/dsh-atomic-write`（2026-09-20 W6/W7 切换，见设计总纲 §16.1）：
// 包内本地助手已删除，权限位由调用点逐处声明。
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AiChatAuthorization } from './ai-chat.ts'

/** 授权状态文件名（落在 `config.userDataDir` 下；宿主私有目录）。 */
export const AI_CONSENT_FILE_NAME = 'wasm-apps-ai-consent.json'

/** 文件格式版本（形状变更时递增；未知版本 ⇒ 当作空记录，fail-closed）。 */
export const AI_CONSENT_FORMAT_VERSION = 1

/** 一个用户对一个应用的授权条目（`user`/`app` 都是原文，落盘时按行 JSON 编码）。 */
interface ConsentEntry {
  readonly user: string
  readonly app: string
}

/** 落盘形状。 */
interface ConsentDocument {
  readonly version: number
  readonly grants: readonly ConsentEntry[]
}

/**
 * 授权键（**唯一实现**）：两个维度都必须参与。
 *
 * 用 NUL 分隔而不是可见字符：用户名/应用 id 都可能含可见分隔符，而 NUL 不可能出现在
 * 任一维度的合法取值里（`isValidAppId` 只放行小写字母/数字/连字符，用户名来自平台）。
 * @param userId - 当前员工标识。
 * @param appId - 应用标识。
 * @returns 记录键。
 */
export function aiConsentKey(userId: string, appId: string): string {
  return `${userId}\u0000${appId}`
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
  if (row.version !== AI_CONSENT_FORMAT_VERSION) return null
  if (!Array.isArray(row.grants)) return null
  const keys = new Set<string>()
  for (const entry of row.grants) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const candidate = entry as { user?: unknown, app?: unknown }
    if (typeof candidate.user !== 'string' || typeof candidate.app !== 'string') return null
    if (candidate.user === '' || candidate.app === '') return null
    keys.add(aiConsentKey(candidate.user, candidate.app))
  }
  return keys
}

/**
 * 把键集合序列化回文件形状（稳定排序：两份内容相同的记录逐字节相同 ⇒ 便于对拍）。
 * @param keys - 授权键集合。
 * @returns 文件原文（带结尾换行）。
 */
export function serializeAiConsent(keys: ReadonlySet<string>): string {
  const grants: ConsentEntry[] = []
  for (const key of keys) {
    const separator = key.indexOf('\u0000')
    if (separator === -1) continue
    grants.push({ user: key.slice(0, separator), app: key.slice(separator + 1) })
  }
  grants.sort((left, right) => (left.user === right.user ? (left.app < right.app ? -1 : 1) : (left.user < right.user ? -1 : 1)))
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
 * 构造宿主侧的授权记录（`AiChatAuthorization` 的实现）。
 *
 * 每次调用都重新读文件（这是"用户点允许 → 下一次调用立刻生效"这条判据的唯一实现；
 * 缓存会让撤销/授权延迟到重启）。文件很小（一条授权 ≈ 60 字节），代价可忽略。
 * @param options - 记录文件与诊断出口。
 * @returns 授权记录实现。
 */
export function createAiChatAuthorization(options: AiChatAuthorizationOptions = {}): AiChatAuthorization {
  const warn = options.warn ?? ((): void => {})
  /** 内存形态的当前集合（`file === undefined` 时是真源；有文件时只是写序列化缓冲）。 */
  let memory = new Set<string>()
  /** 写串行化：并发 grant/revoke 不得互相覆盖（读-改-写必须原子成一段）。 */
  let tail: Promise<void> = Promise.resolve()

  const load = async (): Promise<Set<string>> => {
    if (options.file === undefined) return new Set(memory)
    let text: string
    try {
      text = await readFile(options.file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      // 读失败（权限/EIO）⇒ fail-closed 到"无授权"，但必须留痕：静默会让"磁盘坏了"
      // 与"没人授权"长得一样。
      warn(`pico-wasm-apps-host: reading the app AI consent file failed (${cause instanceof Error ? cause.message : String(cause)}); treating every grant as absent`)
      return new Set()
    }
    const parsed = parseAiConsent(text)
    if (parsed === null) {
      warn(`pico-wasm-apps-host: the app AI consent file at ${options.file} is not a version ${String(AI_CONSENT_FORMAT_VERSION)} record; treating every grant as absent`)
      return new Set()
    }
    return parsed
  }

  const persist = (keys: Set<string>): Promise<void> => {
    memory = keys
    if (options.file === undefined) return Promise.resolve()
    return writeFileAtomic(options.file, serializeAiConsent(keys), { mode: 0o600, dirMode: 0o700 })
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
    async isGranted(userId: string, appId: string): Promise<boolean> {
      if (userId === '' || appId === '') return false
      const keys = await load()
      return keys.has(aiConsentKey(userId, appId))
    },
    grant(userId: string, appId: string): Promise<void> {
      if (userId === '' || appId === '') return Promise.reject(new Error('pico-wasm-apps-host: an app AI grant needs both a user and an app id'))
      return mutate((keys) => { keys.add(aiConsentKey(userId, appId)) })
    },
    revoke(userId: string, appId: string): Promise<void> {
      if (userId === '' || appId === '') return Promise.reject(new Error('pico-wasm-apps-host: an app AI revocation needs both a user and an app id'))
      return mutate((keys) => { keys.delete(aiConsentKey(userId, appId)) })
    },
  }
}
