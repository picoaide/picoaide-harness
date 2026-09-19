/**
 * 深链待打开队列（设计总纲 §7.6「待打开目标队列」，冻结）。
 *
 * 深链可以在客户端启动早期、甚至在宿主装配完成之前到达；也可以在一个**未登录**的
 * 客户端里到达（用户点别人发来的应用链接）。这两种情况下都不能丢链接，也不能弹
 * 错误 —— 正确行为是入队、等闸门放行后按序打开。
 *
 * 冻结口径（写错就是缺陷）：
 *  1. **有界**：≤ {@link DEEP_LINK_QUEUE_MAX} 条（第 9 条挤掉最旧的，并记 warn）；
 *  2. **TTL**：{@link DEEP_LINK_QUEUE_TTL_MS}（5 min）——过期项直接丢弃并记一条 warn，
 *     **不弹错误**（用户可能早就忘了这次点击）；
 *  3. **去重**：按 `app_id + path`（同一个链接点两次只打开一次，但路径不同的两条
 *     各算一条）；
 *  4. **FIFO 消费**：登录成功后按入队顺序消费，消费一条弹一条；登录闸门未通过时
 *     保留队首（`peek()` 不弹出）。
 *
 * 本模块是**纯状态机**（注入时钟），不碰 Electron / 网络：宿主只在"会话变为已登录"
 * 与"宿主就绪"两个时刻调用 `drain()`。
 *
 * @module @picoaide/dsh-wasm-apps-host/deep-link-queue
 */

/** 队列上限（§7.6 冻结：8 条）。 */
export const DEEP_LINK_QUEUE_MAX = 8

/** 条目寿命（§7.6 冻结：5 min）。 */
export const DEEP_LINK_QUEUE_TTL_MS = 5 * 60_000

/** 一条待打开目标。 */
export interface PendingDeepLink {
  readonly appId: string
  /** 应用内相对路径（已净化；缺省 `/`）。 */
  readonly path: string
  /** 入队时刻（毫秒）。 */
  readonly enqueuedAt: number
}

/** 入队结论（调用方据此决定是否记日志：`ttl`/`capacity` 都只是 warn，不是错误）。 */
export type EnqueueOutcome =
  | { ok: true, replaced: boolean }
  | { ok: false, reason: 'stale-input' }

/** 深链队列的构造参数。 */
export interface DeepLinkQueueOptions {
  max?: number | undefined
  ttlMs?: number | undefined
  now?: (() => number) | undefined
  warn?: ((message: string) => void) | undefined
}

/** 有界、带 TTL 的 FIFO 待打开队列。 */
export interface DeepLinkQueue {
  /** 入队（同 `app_id + path` 已在队列里 ⇒ 只刷新时间，不算新条目）。 */
  enqueue(appId: string, path?: string): EnqueueOutcome
  /** 队首（**不弹出**；过期项在这里被清掉）。 */
  peek(): PendingDeepLink | undefined
  /** 弹出队首（调用方已成功打开它）。 */
  shift(): PendingDeepLink | undefined
  /** 当前有效条目（按入队序；已清理过期项）。 */
  list(): readonly PendingDeepLink[]
  /** 清空（登出/切换账号：上一个用户的待打开目标不得在新用户下打开）。 */
  clear(): void
  /** 当前条数（诊断/单测）。 */
  size(): number
}

/** 路径净化（§23.2 N8/RED-3）：拒绝协议相对形态与任何穿越。 */
export function sanitizeAppPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '/'
  if (raw.length > 2048) return '/'
  if (!raw.startsWith('/')) return '/'
  // `//host`、`/\host`、`/%2e%2e`、`/@host` 都是"协议相对 / 用户信息"形态的外衣：
  // 它们会让后续拼 URL 的人拼出另一个 origin。一律拒绝（丢弃 path 参数，不拒整条链接）。
  if (/^\/[/\\]/u.test(raw)) return '/'
  const decoded = (() => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  })()
  if (decoded.includes('\\') || decoded.includes('..') || decoded.includes('@')) return '/'
  if (/[\u0000-\u001F\u007F]/u.test(decoded)) return '/'
  if (decoded.startsWith('//')) return '/'
  return raw
}

/**
 * 构造深链队列。
 * @param options - 上限/TTL/时钟/诊断。
 * @returns 队列状态机。
 */
export function createDeepLinkQueue(options: DeepLinkQueueOptions = {}): DeepLinkQueue {
  const max = options.max ?? DEEP_LINK_QUEUE_MAX
  const ttlMs = options.ttlMs ?? DEEP_LINK_QUEUE_TTL_MS
  const now = options.now ?? ((): number => Date.now())
  const warn = options.warn ?? ((): void => {})
  let items: PendingDeepLink[] = []

  /** 清理过期项（丢弃 + warn，绝不弹错误）。 */
  const prune = (instant: number): void => {
    const kept: PendingDeepLink[] = []
    for (const item of items) {
      if (instant - item.enqueuedAt >= ttlMs) {
        warn(`pico-wasm-apps-host: dropping an expired pending app link (${item.appId})`)
        continue
      }
      kept.push(item)
    }
    items = kept
  }

  return {
    enqueue(appId, path = '/') {
      const instant = now()
      prune(instant)
      const clean = sanitizeAppPath(path)
      const existing = items.find(item => item.appId === appId && item.path === clean)
      if (existing !== undefined) {
        // 同一条链接再点一次：只把它挪到队尾（刷新"最近一次意图"），不重复打开。
        items = items.filter(item => item !== existing)
        items.push({ appId, path: clean, enqueuedAt: instant })
        return { ok: true, replaced: true }
      }
      items.push({ appId, path: clean, enqueuedAt: instant })
      while (items.length > max) {
        const dropped = items.shift()
        if (dropped === undefined) break
        warn(`pico-wasm-apps-host: the pending app link queue is full (${String(max)}); dropping ${dropped.appId}`)
      }
      return { ok: true, replaced: false }
    },
    peek() {
      prune(now())
      return items[0]
    },
    shift() {
      prune(now())
      return items.shift()
    },
    list() {
      prune(now())
      return [...items]
    },
    clear() {
      items = []
    },
    size() {
      prune(now())
      return items.length
    },
  }
}
