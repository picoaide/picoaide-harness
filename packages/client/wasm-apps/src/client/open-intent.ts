/**
 * 「未登录时记住这次打开」——客户端半边（§19 Q4 / §7.6）。
 *
 * ## 为什么需要落盘（而不是 React state）
 *
 * §19 Q4 冻结的交互是"面板层拦截 → 弹客户端登录 → **登录成功后自动继续**"。而客户端
 * 登录走的是**页面重载**（`auth-gate.ts` 的会话 tripwire：`loggedIn:false` ⇒
 * `location.reload()` 进登录页，登录后整棵树重建）⇒ 组件 state 活不过这一跳。
 * 所以意图必须写进**存储**：登录页回来后，**下一个文档加载**读到它并自动继续 —— 用户
 * 不需要再点一次「打开」。读它的那一跳是**页面加载级**的（`open-intent-resume.ts`，
 * 由 `mountAppCenterPanel()` 在插件 apply 时调用），不是面板挂载时 —— 面板只在激活时
 * 才渲染，而登录成功是整文档导航，那一刻面板并不存在（R16B-03）。
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

/** {@link readOpenIntent} / {@link claimOpenIntent} 的可注入依赖。 */
export interface OpenIntentReadOptions {
  /** 存储（缺省 {@link defaultOpenIntentStore}）。 */
  store?: OpenIntentStore | null
  /** 当前时间（TTL 判定；缺省 `Date.now`）。 */
  now?: number
  /** 存活上限（缺省 {@link OPEN_INTENT_TTL_MS}）。 */
  ttlMs?: number
}

/**
 * 读回待继续的打开（**过期即丢弃**：§7.6「过期项直接丢弃并记一条 warn（不弹错误）」）。
 * @param options - 存储、当前时间与 TTL（测试注入）。
 * @returns 仍有效的意图；没有 / 过期 / 形态不对 ⇒ `null`（过期的会被顺手清掉）。
 */
export function readOpenIntent(
  options: OpenIntentReadOptions = {},
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

/**
 * **原子认领**一条待继续的打开：读 + 删在同一次同步调用里完成（中间没有 `await`）。
 *
 * ## 为什么不能"读一次、稍后再 clear"
 *
 * 这条意图的消费者不止一个：页面加载级的 `resumeOpenIntent`（见
 * `open-intent-resume.ts`）与面板激活后的 `AppCenterPanel.continuePendingOpen` 兜底。
 * 两者都可能先**读到**同一条意图、再各自去开窗 ⇒ 同一个意图开两次窗。JS 单线程，
 * 所以"读 + 删"之间只要没有 `await` 就是一个原子步骤：**认领到的那一个**才是唯一的
 * 开窗者，后到的读到 `null`（"先清后开"本身不够 —— 清只保证下次读不到，不保证
 * 两个已读到的消费者只有一个开窗）。
 *
 * 约定：任何要在开窗前清掉意图的路径都必须走这里（唯一先行清理点），认领失败即
 * **不发请求**。
 * @param options - 存储、当前时间与 TTL（测试注入）。
 * @returns 被认领的意图；没有 / 过期 / 已被别的消费者认领 ⇒ `null`。
 */
export function claimOpenIntent(options: OpenIntentReadOptions = {}): OpenIntent | null {
  const intent = readOpenIntent(options)
  if (intent === null) return null
  clearOpenIntent(options.store === undefined ? {} : { store: options.store })
  return intent
}
