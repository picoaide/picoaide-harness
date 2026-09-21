/**
 * 窗口几何的**目录兜底来源**（F3/§6 的第二条取值路径）。
 *
 * 为什么需要它（2026-09-21 审计 P0-2 的接线缺口）：作者声明的
 * `window.ratio/width/height` 此前只到客户端详情页（渲染成「窗口比例 16:9」），
 * 建窗路径一个字段都没收到 —— 首次一律 1280×720、比例不锁，界面承诺与真实窗口不一致。
 *
 * 取值来源两条，优先级从高到低：
 *  1. 本机打开路由请求体的 `window`（客户端点开行时手里的**同一份**目录数据，
 *     `packages/client/wasm-apps/src/client/AppCenterPanel.tsx` 的目录解析）——
 *     由 `index.ts` 的打开路由直接消费，**零额外请求**；
 *  2. 本模块：宿主自己拉一次平台目录 `GET /api/client/v2/apps/wasm/catalog` 兜底。
 *     客户端还没把 `window` 放进请求体时（或深链打开这种没有请求体的路径），
 *     打开行为仍然与详情页显示的值一致。
 *
 * 解析/归一化**不在这里**：形状与 `ResolvedWindow` 同判的唯一实现在
 * `windows.ts`（{@link parseDeclaredWindowGeometry} / {@link resolveDeclaredWindowSize}），
 * 本模块只负责"把目录拉下来、按 app_id 取那一行"。
 *
 * @module @picoaide/dsh-wasm-apps-host/window-catalog
 */

import { parseDeclaredWindowGeometry, type DeclaredWindowGeometry } from './windows.ts'

/**
 * 宿主侧的平台目录端点（与 `open-gate.ts` 的 {@link APP_OPEN_PATH} 同前缀）。
 *
 * 只在**打开一个新窗口**且请求体没带 `window` 时调用；`GET` + BearerAuth
 * （该路由在 `server/internal/router/router.go` 的 wasm 客户端面分组里注册，
 * **不要求** app-proof —— proof 是按 app_id 绑定的，而目录是跨应用的读）。
 */
export const APP_CATALOG_PATH = '/api/client/v2/apps/wasm/catalog'

/**
 * 目录响应体的读取上限（字符数）。
 *
 * 目录本身无服务端分页（`api/read.go` 的 `ListWasmApps` 后逐行投影），大组织下可能是
 * 几百 KB。这里只做"不许把无界的东西读进内存"的兜底：超过即放弃兜底取值并记一条 warn
 * —— **打开动作照常进行**，只回落缺省 1280×720（几何是优化，不是准入）。
 */
export const CATALOG_BODY_MAX_CHARS = 8 * 1024 * 1024

/** 目录兜底取值的出站预算（毫秒）：与打开校验同源（同一台服务端、同一个打开动作）。 */
export const CATALOG_LOOKUP_TIMEOUT_MS = 30_000

/** 失败后的重试退避（毫秒）：目录不可达时不要把每一次打开都变成一次失败请求。 */
export const CATALOG_RETRY_BACKOFF_MS = 30_000

/** 目录兜底取值的依赖（全部注入，便于单测）。 */
export interface WindowCatalogDeps {
  /** 当前员工会话（未登录 ⇒ 不调用）。 */
  session: () => { readonly token: string, readonly serverURL: string } | null
  /** 出站（桌面适配器给 `net.request` 栈）。 */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** 单次预算（毫秒）；缺省 {@link CATALOG_LOOKUP_TIMEOUT_MS}。 */
  timeoutMs?: number | undefined
  /** 可注入时钟（毫秒；退避判据用）。 */
  now?: (() => number) | undefined
  /** 诊断出口。 */
  warn?: ((message: string) => void) | undefined
}

/** 目录兜底取值器。 */
export interface WindowCatalog {
  /**
   * 取某个应用声明的窗口几何（拿不到 ⇒ `undefined`）。
   *
   * **绝不抛**：目录不可达、响应畸形、超时都只记 warn 并回落 `undefined`
   * （调用方用缺省尺寸打开）。
   * @param appId - 已校验的 app_id。
   */
  lookup(appId: string): Promise<DeclaredWindowGeometry | undefined>
  /** 会话/服务端变化 ⇒ 作废已缓存的目录（切租户不得复用上一台的目录）。 */
  invalidate(): void
}

/** 去掉尾斜杠（与 `handler.ts`/`open-gate.ts` 同口径）。 */
function normalizeServerURL(input: string): string {
  let value = input.trim()
  while (value.length > 0 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}

/**
 * 构造目录兜底取值器。
 *
 * 缓存语义：**每个"服务端地址 + 令牌"只拉一次目录**（全量缓存在内存里），单飞
 * （并发打开两个应用只发一次请求）。同一个会话里换应用不再发请求；换账号/换服务端
 * 由调用方 `invalidate()`（会话变更处）。
 *
 * 失败语义：失败不冒充"目录为空"（会记 warn 并退避 {@link CATALOG_RETRY_BACKOFF_MS}），
 * 也不阻断打开 —— 下一次打开（退避之后）会重试。
 * @param deps - 会话/出站/预算/时钟/诊断。
 * @returns 取值器。
 */
export function createWindowCatalog(deps: WindowCatalogDeps): WindowCatalog {
  const warn = deps.warn ?? ((): void => {})
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? CATALOG_LOOKUP_TIMEOUT_MS
  /** 已加载的目录（按 `<endpoint>\u0000<token>` 记：换服务端或换令牌都必须重拉）。 */
  let loadedKey: string | null = null
  let rows = new Map<string, DeclaredWindowGeometry | null>()
  /** 一次在飞的加载（并发打开共用它）。 */
  let pending: { key: string, promise: Promise<void> } | null = null
  /** 失败退避：同一个 key 失败后短时间内不再重试。 */
  let lastFailedKey: string | null = null
  let retryAfter = 0

  const load = async (endpoint: string, token: string): Promise<void> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const response = await deps.fetch(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!response.ok) {
        warn(`pico-wasm-apps-host: the platform catalog lookup failed (HTTP ${String(response.status)}); window geometry falls back to the defaults`)
        return
      }
      const text = await response.text()
      if (text.length > CATALOG_BODY_MAX_CHARS) {
        warn(`pico-wasm-apps-host: the platform catalog is ${String(text.length)} chars (> ${String(CATALOG_BODY_MAX_CHARS)}); skipping the window-geometry fallback`)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        warn('pico-wasm-apps-host: the platform catalog was not valid JSON; window geometry falls back to the defaults')
        return
      }
      const list = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        ? (parsed as { apps?: unknown }).apps
        : undefined
      if (!Array.isArray(list)) {
        warn('pico-wasm-apps-host: the platform catalog had no apps array; window geometry falls back to the defaults')
        return
      }
      const next = new Map<string, DeclaredWindowGeometry | null>()
      for (const row of list) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
        const entry = row as { app_id?: unknown, window?: unknown }
        if (typeof entry.app_id !== 'string' || entry.app_id === '') continue
        next.set(entry.app_id, parseDeclaredWindowGeometry(entry.window))
      }
      rows = next
      loadedKey = `${endpoint}\u0000${token}`
      lastFailedKey = null
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      warn(`pico-wasm-apps-host: the platform catalog lookup failed (${detail}); window geometry falls back to the defaults`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async lookup(appId) {
      const session = deps.session()
      if (session === null) return undefined
      const endpoint = `${normalizeServerURL(session.serverURL)}${APP_CATALOG_PATH}`
      const key = `${endpoint}\u0000${session.token}`
      if (loadedKey !== key) {
        if (lastFailedKey === key && now() < retryAfter) return undefined
        const inflight = pending !== null && pending.key === key ? pending.promise : null
        const promise = inflight ?? load(endpoint, session.token)
        if (inflight === null) pending = { key, promise }
        try {
          await promise
        } finally {
          if (pending !== null && pending.promise === promise) pending = null
        }
        if (loadedKey !== key) {
          lastFailedKey = key
          retryAfter = now() + CATALOG_RETRY_BACKOFF_MS
          return undefined
        }
      }
      return rows.get(appId) ?? undefined
    },
    invalidate() {
      loadedKey = null
      rows = new Map()
      pending = null
      lastFailedKey = null
      retryAfter = 0
    },
  }
}
