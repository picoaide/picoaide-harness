/**
 * 打开应用入口链接（`<app_id>.<基域>`）。
 *
 * 走哪条路 —— **内置浏览器优先，系统浏览器兜底**，理由（"既有能力"逐条对过）：
 *
 *  1. **内置浏览器是本产品自己的、用户面的能力**：`POST /api/pico/browser/open`
 *     的第三个参数就是 `user=true`（"Shell `+`：USER's surface —— bypasses the
 *     agent mutex"，见 `packages/host/browser/src/index.ts` 的 `case 'open'`），
 *     即这个端点本来就是为"用户自己点开的标签"准备的；`/show` 把窗口带到前台。
 *  2. **端到端可断言**：标签真的存在于浏览器标签表里（`/api/pico/browser/state`），
 *     因此"点了入口真的打开了这个应用"可以被自动化证明，而不是只验证一句
 *     `window.open` 被调用过（存在性断言＝假绿的另一种形态）。
 *  3. **留在产品内**，且打开后 AI 可以在同一个浏览器里继续操作它（员工说
 *     "帮我登录进去填一下"时不用换上下文）。
 *  4. **兜底不堵**：内置浏览器是可选插件行，缺席时 `/api/pico/browser/open`
 *     会 404 —— 那时把链接交给 `window.open`，由桌面壳既有的
 *     `setWindowOpenHandler` → `shell.openExternal` 送到系统浏览器
 *     （`electron-runtime.ts`：http/https/mailto 之外的 scheme 一律 deny）。
 *
 * ⚠️ 与打开方式无关的前提：应用子域首次访问需要**主站员工会话**才能换票
 * （§4.7 一次性换票）。用户自己的浏览器里通常已有；内置浏览器是独立分区，
 * 首次会落到主站登录页 —— 这是票务流程的设计，不是本模块的缺陷。
 *
 * @module @picoaide/dsh-wasm-apps/client/open-app
 */

/** 打开方式（返回给调用方用于提示/测试断言）。 */
export type OpenVia = 'built-in' | 'system' | 'none'

/** {@link openAppEntry} 的结果。 */
export interface OpenResult {
  ok: boolean
  via: OpenVia
  /** 失败原因（仅 `via === 'none'` 时有意义）。 */
  error?: string
}

/** 可注入的副作用（测试用；生产缺省为真实 fetch / window.open）。 */
export interface OpenAppDeps {
  fetch: typeof fetch
  /** `window.open`；返回 null 表示被壳拦下并已转交系统浏览器。 */
  open: (url: string) => unknown
}

function defaultDeps(): OpenAppDeps {
  return {
    fetch: (...args) => fetch(...args),
    open: (url: string) => window.open(url, '_blank', 'noopener,noreferrer'),
  }
}

/**
 * 只接受 http(s)：应用入口永远是这两种（服务端 `appOrigin()` 拼
 * `scheme://<app_id>.<基域>`），`javascript:`/`data:` 这类不能进浏览器。
 * @param raw - 服务端下发的 `entry_url`。
 * @returns 规范化后的 URL，或 null（不可打开）。
 */
export function safeEntryURL(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * 打开一个应用入口：内置浏览器 → 系统浏览器。
 * @param rawURL - 服务端下发的 `entry_url`。
 * @param deps - 副作用注入点（缺省 fetch + window.open）。
 * @returns 实际走通的路径；两条都不通时 `{ok:false, via:'none'}`。
 */
export async function openAppEntry(rawURL: unknown, deps: OpenAppDeps = defaultDeps()): Promise<OpenResult> {
  const url = safeEntryURL(rawURL)
  if (url === null) return { ok: false, via: 'none', error: 'entry_url is not an http(s) URL' }

  // 1) 内置浏览器（用户面标签）。两步都要：open 建标签，show 把窗口带到前台。
  try {
    const opened = await deps.fetch('/api/pico/browser/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (opened.ok) {
      // show 失败不影响"标签已开"这一事实，因此单独 try 且不改变结果。
      try {
        await deps.fetch('/api/pico/browser/show', { method: 'POST' })
      } catch { /* window stays where it is; the tab is already open */ }
      return { ok: true, via: 'built-in' }
    }
  } catch { /* 插件缺席 / 宿主不可达 ⇒ 走系统浏览器 */ }

  // 2) 系统浏览器：桌面壳把 http(s) 的 window.open 交给 shell.openExternal。
  //    壳会 deny 并返回 null（不是失败），所以返回值不参与判定。
  try {
    deps.open(url)
    return { ok: true, via: 'system' }
  } catch (cause) {
    return { ok: false, via: 'none', error: cause instanceof Error ? cause.message : String(cause) }
  }
}
