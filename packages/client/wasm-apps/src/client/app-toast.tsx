/**
 * 主窗口**一次性 toast**（§5.3 / §19 Q5 的异渠道深链提示）。
 *
 * ## 谁的哪一半
 *
 * 深链解析在**宿主**（`packages/host/wasm-apps-host`，L2）：只有那里知道"这条链接的
 * scheme 属于另一家企业的客户端"。宿主把这件事广播出来，**文案与渲染**在本模块
 * （本包是客户端 UI 的唯一展示面）。两者之间的接缝只有一条：
 * `ctx.on(APP_FOREIGN_DEEP_LINK_EVENT, …)` —— 宿主必须用**同一个事件名**发。
 *
 * ## 为什么是一个模块级 store（而不是 React context）
 *
 * 订阅方是客户端插件（`client/index.ts`，拿得到 `ctx`），渲染方是侧边栏里的
 * `AppToastHost`（拿不到 `ctx`）。两者之间用 `useSyncExternalStore` 连起来，
 * 既不引入第二个 React root，也不让插件去碰 DOM。
 *
 * @module @picoaide/dsh-wasm-apps/client/app-toast
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { t } from './locales.ts'

// 声明宿主侧广播的事件（客户端编译面不加载宿主模块的声明）——与
// `enterprise/src/client/channel-store.ts` 对 `pico/channel-changed` 的做法一致。
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 收到一条属于**另一家企业客户端**的深链（§5.3；宿主发出）。 */
    'pico/wasm-app-deep-link-foreign'(payload?: { url?: string }): void
  }
}

/**
 * 异渠道深链的宿主广播事件（**跨端接缝**，L2 必须用同一个名字发）。
 *
 * 触发条件（§5.3）：收到一条深链，但它的 scheme **属于另一个渠道/安装**
 * （跨渠道不工作属预期，不能静默丢弃 —— 用户要知道该找谁）。
 */
export const APP_FOREIGN_DEEP_LINK_EVENT = 'pico/wasm-app-deep-link-foreign'

/** toast 的类型（目前只有一种；保留联合类型是为了以后加别的提示时不改签名）。 */
export type AppToast = { kind: 'foreign-deep-link' }

/** toast 自动消失的时间（一次性提示，不该常驻）。 */
export const APP_TOAST_TTL_MS = 8000

let current: AppToast | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/**
 * 通知所有订阅者（`useSyncExternalStore` 的快照读 `currentAppToast`）。
 */
function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * 显示一条 toast（重复调用会重置自动消失计时）。
 * @param toast - 要显示的内容。
 */
export function showAppToast(toast: AppToast): void {
  current = toast
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => { clearAppToast() }, APP_TOAST_TTL_MS)
  // Node 环境下 `setTimeout` 返回的对象带 `unref`：不要让一个 UI 提示拖住进程退出。
  ;(timer as unknown as { unref?: () => void }).unref?.()
  notify()
}

/**
 * 关掉当前 toast（关闭按钮 / 自动消失 / 切面板）。
 */
export function clearAppToast(): void {
  if (timer !== null) { clearTimeout(timer); timer = null }
  if (current === null) return
  current = null
  notify()
}

/**
 * 当前 toast（`useSyncExternalStore` 的快照）。
 * @returns toast，或 `null`。
 */
export function currentAppToast(): AppToast | null {
  return current
}

/**
 * 订阅 toast 变化。
 * @param listener - 变化回调。
 * @returns 取消订阅。
 */
export function subscribeAppToast(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** toast 文案的字典键（逐条：文案是产品契约，不能散在 JSX 里）。 */
const TOAST_TEXT_KEYS = {
  'foreign-deep-link': 'appCenter.toast.foreignDeepLink',
} as const

/**
 * 异渠道深链的提示文案（§5.3/§19 Q5 **逐字**冻结的那一句）。
 * @returns 当前语言下的文案。
 */
export function foreignDeepLinkToastText(): string {
  return t(TOAST_TEXT_KEYS['foreign-deep-link'])
}

/**
 * toast 宿主组件（主窗口底部居中；由 `AppCenterTrigger` 挂载 ⇒ 有真实消费者）。
 *
 * 它只订阅 store：宿主事件 → 插件 → `showAppToast` → 这里渲染。
 */
export function AppToastHost() {
  const toast = useSyncExternalStore(subscribeAppToast, currentAppToast, currentAppToast)
  const dismiss = useCallback(() => { clearAppToast() }, [])
  // 卸载（例如侧边栏整块收起）时不留残影：toast 属于当前 UI，UI 没了它也不该在。
  useEffect(() => () => { clearAppToast() }, [])
  if (toast === null) return null
  return (
    <div style={TOAST} role="status" className="pico-app-toast" data-role="app-toast" data-toast={toast.kind}>
      <span data-role="toast-text">{t(TOAST_TEXT_KEYS[toast.kind])}</span>
      <button
        type="button"
        className="pico-app-toast-dismiss"
        data-action="toast-dismiss"
        style={DISMISS}
        aria-label={t('appCenter.toast.dismiss')}
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  )
}

/** 底部居中的浮层（不占布局：侧边栏槽位里渲染也不会挤压导航）。 */
const TOAST: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  zIndex: 1200,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  maxWidth: 'min(560px, calc(100vw - 32px))',
  padding: '10px 14px',
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '20px',
}

/** 关闭按钮（真实 button：键盘可达）。 */
const DISMISS: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  font: 'inherit',
  padding: '0 2px',
}
