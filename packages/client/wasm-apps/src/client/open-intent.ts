/**
 * 「未登录时记住这次打开」——客户端半边（§19 Q4 / §7.6）。
 *
 * ## 为什么需要落盘（而不是 React state）
 *
 * §19 Q4 冻结的交互是"面板层拦截 → 弹客户端登录 → **登录成功后自动继续**"。而客户端
 * 登录走的是**页面重载**（`auth-gate.ts` 的会话 tripwire：`loggedIn:false` ⇒
 * `location.reload()` 进登录页，登录后整棵树重建）⇒ 组件 state 活不过这一跳。
 * 所以意图必须写进**存储**：登录页回来后，面板挂载时读到它并自动继续 —— 用户不需要
 * 再点一次「打开」。
 *
 * ## 与 L2 深链队列的分工
 *
 * 宿主侧还有一个**深链待打开队列**（§7.6 冻结：≤8 条、TTL 5 min、按 `app_id + path`
 * 去重）—— 那条走的是 OS 级深链，归 L2。这里只处理"**用户点开**但未登录"这一种，
 * TTL 与宿主同口径（5 分钟），过期直接丢弃并**不弹错误**。
 *
 * 存储键带 `v1`：形态变了就换键，读到旧形态视为不存在（不做迁移 —— 它只是一个待办）。
 *
 * @module @picoaide/dsh-wasm-apps/client/open-intent
 */

/** 存储键（值 = `JSON.stringify(OpenIntent)`）。 */
export const OPEN_INTENT_STORAGE_KEY = 'picoaide.wasm-apps.open-intent.v1'

/** 意图存活上限（与 §7.6 深链队列同口径：5 分钟）。 */
export const OPEN_INTENT_TTL_MS = 5 * 60 * 1000

/** 一次待继续的打开。 */
export interface OpenIntent {
  /** 应用标识。 */
  appId: string
  /** 目标路径（`/` 开头；缺省 = 应用根）。 */
  path?: string
  /** 记录时刻（epoch ms；用于 TTL 判定）。 */
  at: number
}

/** 读/写/删所需的存储子集（`sessionStorage` / `localStorage` 都满足）。 */
export interface OpenIntentStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * 默认存储：`sessionStorage` 优先。
 *
 * 为什么不是 `localStorage`：这条意图属于**这一次登录会话**，关掉客户端后不该在下次
 * 启动时突然打开一个窗口（那会变成"我什么都没点，它自己开了"）。`sessionStorage`
 * 恰好跨重载、不跨进程重启。
 * @returns 存储实现；宿主两者都没有 ⇒ `null`（按"没有待继续"处理）。
 */
export function defaultOpenIntentStore(): OpenIntentStore | null {
  try {
    const storage = (globalThis as { sessionStorage?: OpenIntentStore }).sessionStorage
    if (storage !== undefined && storage !== null) return storage
    return (globalThis as { localStorage?: OpenIntentStore }).localStorage ?? null
  } catch {
    return null
  }
}

/**
 * 记下一次"待登录后继续"的打开。
 * @param appId - 应用标识（空串 ⇒ 不写）。
 * @param options - 目标路径、存储与当前时间（测试注入）。
 * @returns 写下的意图；没写成 ⇒ `null`。
 */
export function saveOpenIntent(
  appId: string,
  options: { path?: string, store?: OpenIntentStore | null, now?: number } = {},
): OpenIntent | null {
  if (appId === '') return null
  const intent: OpenIntent = {
    appId,
    ...(options.path === undefined || options.path === '' ? {} : { path: options.path }),
    at: options.now ?? Date.now(),
  }
  const store = options.store === undefined ? defaultOpenIntentStore() : options.store
  if (store === null) return null
  try {
    store.setItem(OPEN_INTENT_STORAGE_KEY, JSON.stringify(intent))
    return intent
  } catch {
    return null
  }
}

/**
 * 读回待继续的打开（**过期即丢弃**：§7.6「过期项直接丢弃并记一条 warn（不弹错误）」）。
 * @param options - 存储、当前时间与 TTL（测试注入）。
 * @returns 仍有效的意图；没有 / 过期 / 形态不对 ⇒ `null`（过期的会被顺手清掉）。
 */
export function readOpenIntent(
  options: { store?: OpenIntentStore | null, now?: number, ttlMs?: number } = {},
): OpenIntent | null {
  const store = options.store === undefined ? defaultOpenIntentStore() : options.store
  if (store === null) return null
  let raw: string | null
  try {
    raw = store.getItem(OPEN_INTENT_STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearOpenIntent({ store })
    return null
  }
  if (parsed === null || typeof parsed !== 'object') {
    clearOpenIntent({ store })
    return null
  }
  const row = parsed as { appId?: unknown, path?: unknown, at?: unknown }
  const appId = typeof row.appId === 'string' ? row.appId : ''
  const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
  if (appId === '') {
    clearOpenIntent({ store })
    return null
  }
  const now = options.now ?? Date.now()
  const ttl = options.ttlMs ?? OPEN_INTENT_TTL_MS
  // `at` 在未来（时钟回拨/被篡改）也按过期处理：待办不该因为一个坏时间戳永远活着。
  if (at <= 0 || now - at > ttl || at > now) {
    clearOpenIntent({ store })
    return null
  }
  return typeof row.path === 'string' && row.path !== '' ? { appId, path: row.path, at } : { appId, at }
}

/**
 * 清掉待继续的打开（继续成功、放弃、或过期时调用）。
 * @param options - 存储（测试注入）。
 */
export function clearOpenIntent(options: { store?: OpenIntentStore | null } = {}): void {
  const store = options.store === undefined ? defaultOpenIntentStore() : options.store
  if (store === null) return
  try {
    store.removeItem(OPEN_INTENT_STORAGE_KEY)
  } catch { /* 清不掉不是错误：TTL 会让它自己过期 */ }
}
