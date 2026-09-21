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
 * ## 三条纪律（与 `wasm-apps-host/src/ai-authorization.ts` 同款）
 *
 *  1. **fail-closed**：文件读不出来 / 形状不符 ⇒ 一律当作**没有任何应用被授权**。
 *     反过来（读失败当成已授权）等于"把磁盘故障变成静默放行"。
 *  2. **写失败要报**：`setEnabled` 写不进去时抛给调用方 —— 静默吞掉会让用户看到
 *     "已允许"而闸门仍然拒绝。
 *  3. **每次调用都重新读文件**：这是"用户点授权 → 下一次工具调用立刻生效"这条判据的
 *     唯一实现（缓存会让撤销延迟到重启）。文件很小（一条 ≈ 30 字节）。
 *
 * ## 授权维度
 *
 * **按 app_id**（用户拍板的口径）：这是"本机上这台客户端允许 AI 读这个应用的数据"。
 * 数据面真正的权限（只有发布者本人可读）仍在服务端，客户端这一层只是**额外**的闸门。
 *
 * @module @picoaide/dsh-enterprise/wasm-apps-ai-rows-consent
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'

/** 授权状态文件名（落在数据根 `$DSH_HOME` 下；0600）。 */
export const AI_ROWS_CONSENT_FILE_NAME = 'wasm-apps-ai-rows-consent.json'

/** 文件格式版本（形状变更时递增；未知版本 ⇒ 当作空记录，fail-closed）。 */
export const AI_ROWS_CONSENT_FORMAT_VERSION = 1

/** 落盘形状。 */
interface ConsentDocument {
  readonly version: number
  readonly apps: readonly string[]
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
 * @returns 已授权的 app_id 集合；形状不符 ⇒ `null`。
 */
export function parseAiRowsConsent(text: string): Set<string> | null {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as { version?: unknown, apps?: unknown }
  if (row.version !== AI_ROWS_CONSENT_FORMAT_VERSION) return null
  if (!Array.isArray(row.apps)) return null
  const apps = new Set<string>()
  for (const entry of row.apps) {
    if (typeof entry !== 'string' || entry === '') return null
    apps.add(entry)
  }
  return apps
}

/**
 * 把授权集合序列化回文件形状（稳定排序：两份内容相同的记录逐字节相同 ⇒ 便于对拍）。
 * @param apps - 已授权的 app_id 集合。
 * @returns 文件原文（带结尾换行）。
 */
export function serializeAiRowsConsent(apps: ReadonlySet<string>): string {
  const document: ConsentDocument = {
    version: AI_ROWS_CONSENT_FORMAT_VERSION,
    apps: [...apps].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * 授权状态的读写面（宿主工具读它，本机路由写它 —— **同一个实例**）。
 */
export interface AiRowsConsentStore {
  /**
   * 这个应用是否已被授权给 AI 读数据（**每次调用重新读盘**）。
   * @param appId - 应用标识。
   * @returns true = 已授权；任何读/解析失败都返回 false（fail-closed）。
   */
  isEnabled(appId: string): Promise<boolean>
  /**
   * 写入授权（人在面板上点「允许」/「撤销」）。
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
  /** 诊断出口（文件损坏 / 读失败）。 */
  warn?: ((message: string) => void) | undefined
}

/**
 * 构造授权记录。
 *
 * 并发写安全：读-改-写整段串行化（两次并发 `setEnabled` 不得互相覆盖），
 * 落盘走"同目录临时文件 + rename"（半个文件被读到不会变成一份**有效**记录 ——
 * 它要么是旧内容，要么是新内容，要么解析失败 ⇒ fail-closed 到"全未授权"）。
 * @param options - 记录文件与诊断出口。
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

  const persist = async (apps: Set<string>): Promise<void> => {
    memory = apps
    if (options.file === undefined) return
    const target = options.file
    const temporary = `${target}.${String(process.pid)}.${String((writes += 1))}.tmp`
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, serializeAiRowsConsent(apps), { mode: 0o600 })
      await rename(temporary, target)
    } catch (cause) {
      // 临时文件残留会让人以为"写了一半"；尽力清掉，再把失败报给调用方。
      await rm(temporary, { force: true }).catch(() => undefined)
      throw cause
    }
  }

  /** 读-改-写串行化（前一段失败不能让后一段永远挂在 rejected 链上）。 */
  const mutate = (change: (apps: Set<string>) => void): Promise<void> => {
    const task = tail.then(async () => {
      const apps = await load()
      change(apps)
      await persist(apps)
    })
    tail = task.catch(() => undefined)
    return task
  }

  return {
    async isEnabled(appId: string): Promise<boolean> {
      if (appId === '') return false
      const apps = await load()
      return apps.has(appId)
    },
    setEnabled(appId: string, enabled: boolean): Promise<void> {
      if (appId === '') return Promise.reject(new Error('pico-wasm-apps: an AI rows consent needs an app id'))
      return mutate((apps) => {
        if (enabled) apps.add(appId)
        else apps.delete(appId)
      })
    },
  }
}
