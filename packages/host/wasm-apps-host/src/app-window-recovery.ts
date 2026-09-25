/**
 * 应用窗口的**崩溃 / 加载失败恢复**（R16B-19；形态照 shell 窗口的
 * `reloadOrShowCrashFallback`，见 `desktop/src/electron-runtime.ts`）。
 *
 * ## 修前的缺陷（第十六轮审计泳道 B，P1）
 *
 * 应用窗口此前只在建窗时挂 `page-title-updated`，唯一的加载处理是
 * `loadURL().catch(reportLoadFailure)`（落到 `<userData>/logs` 里一行）。渲染进程
 * 崩了或首次加载失败 ⇒ **永久空白窗口**：没有错误面、没有重试、没有自动重载；
 * 模型面还把 `crashed` 硬编码成 `false` ⇒ 用户与 AI 都看不到它坏了。
 *
 * ## 冻结形态（**不要**简化掉其中任何一条）
 *
 *  - **单飞**：两个事件源（`render-process-gone` / `did-fail-load`）共用
 *    {@link AppWindowRecovery.fail} 一个入口；恢复进行中到达的事件**加入同一个
 *    Promise**，不再发起第二次导航。真机上渲染进程崩溃会**同时**派发进程级与导航级
 *    两个事件，没有单飞时两次 `loadURL` 并发，错误页与 reload 谁后完成谁说了算。
 *  - **至多自动重载一次**：`idle → retrying → reloaded|failed`。第一次故障自动重载
 *    （回到用户原来所在的路径），之后一律只显示失败页。为什么不"每次故障都重载"：
 *    一个必然崩溃的应用会变成 reload↔crash 的死循环（shell 的旧实现踩过：错误页
 *    渲染完又被 `did-finish-load` 拉回应用，无限循环）。
 *  - **失败页 + 手动重试按钮**：按钮用 `location.href=<重试目标>` 显式导航（**不是**
 *    自动回跳 —— 那正是上面那个死循环的成因）。
 *  - **重试目标在重载之前捕获**：并发事件不得改变本轮的重试目标。
 *
 * ## 为什么是独立模块（而不是塞进 `electron-adapter.ts`）
 *
 * 与 `windows.ts` 同一个理由：这台状态机是**容易写错又难验证**的那一半（单飞、
 * 额度、重试目标、失败页），把它与 Electron 隔开就能在纯 Node 下逐条钉住
 * （`app-window-recovery.spec.ts`）。`electron-adapter.ts` 只负责把原生事件喂进来。
 *
 * @module @picoaide/dsh-wasm-apps-host/app-window-recovery
 */

import type { AppWindowFailureCopy } from './app-window-copy.ts'

/** 应用窗口的故障种类（两个事件源；`crashed` 与恢复路径共用同一个判据）。 */
export type AppWindowFailureKind =
  /** 渲染进程消失（`webContents` 的 `render-process-gone`）。 */
  | 'render-process-gone'
  /** 顶层文档加载失败（`did-fail-load` 且 `isMainFrame === true`、`errorCode !== -3`）。 */
  | 'did-fail-load'

/** 一次故障（诊断面与状态面共用）。 */
export interface AppWindowFailure {
  kind: AppWindowFailureKind
  /** 崩溃原因（`details.reason`）或加载错误描述（`<code>: <description>`）。 */
  reason: string
}

/**
 * 恢复状态机的相位。
 *
 * `idle` 是唯一允许自动重载的相位；一旦离开就**永不回来**（每个窗口一生一次）。
 * 这是有意的：自动重载的第二次机会只在"这是第一次故障"时有意义，而复位相位会让
 * 必然崩溃的应用陷入 reload↔crash 死循环。
 */
export type AppWindowRecoveryPhase = 'idle' | 'retrying' | 'reloaded' | 'failed'

/**
 * 恢复动作要的原生面（**故意只有这三项**：本模块不 import Electron）。
 *
 * 实现方（适配器）负责把"想要的 URL"记住：失败页显示期间 `webContents.getURL()`
 * 是 `data:` 文档，不能拿它当重试目标（否则第二次失败页的按钮会是禁用的）。
 */
export interface AppWindowRecoveryHost {
  /** 窗口是否已销毁（销毁后一切恢复动作都是 no-op）。 */
  isDestroyed(): boolean
  /**
   * 重试目标：当前（或最近一次请求的）**应用文档** URL。
   * @returns URL；没有任何可用目标时返回 `''`（失败页的按钮随之禁用）。
   */
  currentUrl(): string
  /**
   * 原生导航（失败即 reject）。
   *
   * **语义是"照做"，不是"应用加载成功了"**：失败页也经它加载。宿主的"窗口好了"
   * 只能经 {@link AppWindowRecovery.loaded} 报告（判据是"应用文档加载成功"，
   * 失败页那个 `data:` 文档不算）。
   */
  load(url: string): Promise<void>
}

/** {@link createAppWindowRecovery} 的构造参数。 */
export interface AppWindowRecoveryOptions {
  /** 原生面（建窗时由适配器提供）。 */
  host: AppWindowRecoveryHost
  /** 失败页文案（**按调用**求值：语言可在运行中改变）。 */
  copy: () => AppWindowFailureCopy
  /**
   * 崩溃状态变化的出口（`true` = 坏了、`false` = 好了）。模型面 `crashed` 的
   * **唯一真源**；缺席 ⇒ 只有恢复路径，没有状态上报（旧宿主）。
   */
  onCrashStateChange?: ((crashed: boolean) => void) | undefined
  /** 诊断出口（缺省丢弃）。 */
  warn?: ((message: string) => void) | undefined
}

/** 恢复状态机。 */
export interface AppWindowRecovery {
  /**
   * 报告一次故障（**两个事件源的唯一入口**）。
   * @param failure - 故障种类与原因。
   * @returns 本轮恢复结束时 settle 的 promise（并发调用返回**同一个** promise）。
   */
  fail(failure: AppWindowFailure): Promise<void>
  /**
   * 报告"一次应用文档加载成功"（建窗/聚焦导航，或用户在失败页点了重试）。
   *
   * 与 {@link AppWindowRecovery.fail} 相对：它是"窗口真的好了"的唯一判据。失败页
   * 自己加载完成**不算**（那是 `data:` 文档，不表示应用好了）。
   */
  loaded(): void
  /** 当前是否处于"坏了"的状态（模型面 `crashed` 的取值）。 */
  crashed(): boolean
  /** 当前相位（诊断/测试用）。 */
  phase(): AppWindowRecoveryPhase
  /** 最近一次故障（诊断用；没有故障过 ⇒ undefined）。 */
  lastFailure(): AppWindowFailure | undefined
}

/**
 * 构造一台恢复状态机。
 * @param options - 原生面、文案与诊断出口。
 * @returns 状态机（每个原生窗口一台）。
 */
export function createAppWindowRecovery(options: AppWindowRecoveryOptions): AppWindowRecovery {
  const warn = options.warn ?? ((): void => {})
  let phase: AppWindowRecoveryPhase = 'idle'
  /** 正在跑的恢复（单飞：并发事件加入它）。 */
  let pending: Promise<void> | undefined
  let crashed = false
  let last: AppWindowFailure | undefined

  /** 状态翻转的唯一出口（去重：同值不重复上报，避免噪声与无谓的注册表写入）。 */
  const setCrashed = (value: boolean): void => {
    if (crashed === value) return
    crashed = value
    options.onCrashStateChange?.(value)
  }

  /** 一轮恢复：第一次自动重载，之后一律失败页。 */
  const recover = async (): Promise<void> => {
    try {
      if (phase === 'idle') {
        phase = 'retrying'
        // **重试目标在重载之前捕获**：并发事件（同一 tick 的第二个事件源）不得改变
        // 本轮的目标；失败页显示的也是这一个值。
        const retryTarget = options.host.currentUrl()
        if (retryTarget !== '') {
          try {
            await options.host.load(retryTarget)
            phase = 'reloaded'
            // 重载成功 ⇒ 窗口真的好了（这一次加载本身就是"应用文档加载成功"）。
            setCrashed(false)
            return
          } catch (cause) {
            warn(`pico-wasm-apps-host: the automatic reload of an application window did not complete (${cause instanceof Error ? cause.message : String(cause)})`)
          }
        } else {
          warn('pico-wasm-apps-host: an application window failed before it had a document URL; showing the failure page without a reload target')
        }
      }
      // 走到这里只有两种可能：自动重载失败，或重试额度已用尽（`phase !== 'idle'`）。
      // 两者都只给失败页 —— 且**必须在这里**置相位：放在 `if` 里的话，第二次故障
      // 会把相位留在 `reloaded`，状态机就再也走不到终态了。
      phase = 'failed'
      await showFailurePage()
    } finally {
      // 同步解除单飞（不放在 `Promise.finally` 之外的地方）：`finally` 恰好覆盖
      // "本轮已定下导航"的语义 —— 之后到达的事件属于**新的一轮**，而新的一轮因为
      // `phase !== 'idle'` 只会显示失败页。
      pending = undefined
    }
  }

  /** 加载失败页（`data:text/html` 独立文档）。 */
  const showFailurePage = async (): Promise<void> => {
    if (options.host.isDestroyed()) return
    const retryTarget = options.host.currentUrl()
    try {
      await options.host.load(renderAppWindowFailurePage({
        copy: options.copy(),
        retryTarget,
      }))
    } catch (cause) {
      // 连失败页都加载不出来：只能留一条诊断（窗口已经是空白，没有别的出口）。
      warn(`pico-wasm-apps-host: the application window failure page failed to load (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }

  return {
    async fail(failure) {
      last = failure
      // 状态先翻转：即使恢复立刻失败，模型面也必须已经知道"它坏了"。
      setCrashed(true)
      if (options.host.isDestroyed()) return
      if (pending !== undefined) {
        warn(`pico-wasm-apps-host: an application window failure arrived while recovery was in flight; joining it instead of navigating again (${failure.kind})`)
        return await pending
      }
      const settled = recover()
      pending = settled
      return await settled
    },
    loaded() {
      setCrashed(false)
    },
    crashed: () => crashed,
    phase: () => phase,
    lastFailure: () => last,
  }
}

/** {@link renderAppWindowFailurePage} 的输入。 */
export interface AppWindowFailurePageOptions {
  /** 文案（调用方已按当前语言解析）。 */
  copy: AppWindowFailureCopy
  /** 重试目标（`''` ⇒ 按钮禁用）。 */
  retryTarget: string
}

/**
 * 把 URL 嵌进内联 `<script>`：JSON 转义 + 中和 `<`，于是带 `</script>` 的页面
 * URL 也无法逃出脚本块（与 shell 的 `inlineScriptUrl` 同一口径）。
 * @param url - 重试目标。
 * @returns 可安全嵌入 JS 字面量。
 */
function inlineScriptUrl(url: string): string {
  return JSON.stringify(url).replace(/</gu, '\\u003c')
}

/** 转义进 HTML 文本位置（失败页的 `<title>`）。 */
function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/**
 * 渲染失败页（`data:text/html` 独立文档）。
 *
 * 为什么不复用 `pages.ts` 的 `page()`：那套外壳是给**协议 handler 的响应**用的
 * （带 `<main>`/hints/detail 的说明页），而这里要的是"能自己点重试"的交互页 ——
 * 唯一需要脚本的地方，脚本的安全约束也不同（见 {@link inlineScriptUrl}）。
 *
 * `color-scheme: light dark` + `prefers-color-scheme`：桌面壳设了
 * `nativeTheme.themeSource`，独立文档只能靠媒体查询跟随应用内主题（否则暗色主题下
 * 会闪一整页刺眼白，shell 的失败页踩过）。
 * @param options - 文案与重试目标。
 * @returns 完整的 `data:text/html` URL。
 */
export function renderAppWindowFailurePage(options: AppWindowFailurePageOptions): string {
  const { copy, retryTarget } = options
  const retryScript = retryTarget === ''
    ? ''
    : `<script>document.getElementById('retry').addEventListener('click',function(){location.href=${inlineScriptUrl(retryTarget)}})</script>`
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtmlText(copy.heading)}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8;color-scheme:light dark}.card{text-align:center;max-width:420px;padding:32px}h1{font-size:18px;color:#1a1d24}p{color:#616267;font-size:14px}button{margin-top:12px;padding:8px 18px;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}@media (prefers-color-scheme: dark){body{background:#151517}h1{color:#f9fafb}p{color:#9ca3af}}</style></head><body><div class="card"><h1>${escapeHtmlText(copy.heading)}</h1><p>${escapeHtmlText(copy.body)}</p><button id="retry"${retryTarget === '' ? ' disabled' : ''}>${escapeHtmlText(copy.retry)}</button></div>${retryScript}</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
