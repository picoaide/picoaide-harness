/**
 * 「更多」菜单的**服务契约**（2026-09-21 冻结）。
 *
 * ## 为什么是服务，而不是槽位
 *
 * 改造前，五个插件各自往 `sidebar.footer.action` 注册**一整行**（各自一个按钮 + 图标 +
 * 文案 + order）。现在底部只剩**一个**占用者（「更多」行 + 向上浮层），因此槽位 list
 * 帮不上忙 —— 槽位能把多个占用者排成多行，却不能把它们合并进一行。条目要跨 bundle
 * 传递（每个插件是一个独立的客户端 bundle），而客户端 Cordis 服务是跨 bundle 的**唯一**
 * 通道：`panel-surface` 会被内联进每个 bundle，模块级单例在浏览器里根本不是同一份。
 *
 * ReactNode 不过界：条目只带**数据**（id / order / title / activate / attention），
 * 图标由本包的 glyph 表按 id 提供。
 *
 * ## 契约（消费者按此实现，勿改）
 *
 * `add` 返回幂等注销函数；`snapshot()` 按 `order` 升序、同 `order` 保登记序，
 * **未变时返回同一引用**；`touch()` 只发布（不改快照），用来把 `title()` / `attention()`
 * 这类动态取值推给已经渲染的「更多」行。
 *
 * @module @picoaide/dsh-foot-menu/client/contract
 */

// Type-only, but load-bearing: the `declare module '@deepseek-ai/cordis'` block
// below augments a module whose `Context` is a *re-export* (`export * from
// './context.ts'`). Without an import of that specifier in this file, TS treats
// the augmentation as a fresh declaration that shadows the re-export, and every
// `ctx.effect(...)` in this package's program loses its type (TS2576). Importing
// `Context` here — and using it in `installFootMenu` — keeps the merge real.
import type { Context } from '@deepseek-ai/cordis'

/** 侧边栏底部「更多」菜单的登记表（本包客户端半边 provide）。 */
export interface FootMenuEntry {
  /** 稳定 id；**打开面板的条目必须等于 panel-surface 的 PanelId**（用于判定激活态）。 */
  id: string
  /** 升序；相同 order 保持登记顺序。现有 5 项必须保持：cron -10 / capability -1 / connectors 0 / browser 1 / apps 2。 */
  order: number
  /** 当前语言下的条目文案（渲染时读取，语言切换后要能跟着变）。 */
  title: () => string
  /** 点击条目要做的事（打开面板 / 唤起浏览器窗口）。 */
  activate: () => void
  /** 需要警示时为 true（浏览器的"AI 在等你"）。 */
  attention?: (() => boolean) | undefined
  /**
   * 可选的警示文案（`attention()` 为真时优先于通用的 `footMenu.attention`）。
   *
   * 为什么要留这个口子：通用文案只说"AI 正在等你"，而不同条目的**下一步动作**不同
   * （浏览器那条要把用户指到浏览器窗口的「交给 AI」按钮）。2026-09-21 对抗审计：
   * 并道把原来的长句 tooltip 一起删掉后，用户只剩"琥珀色圆点 + 短标签"，没有任何
   * 操作指引。有这个出口，条目既能给出可操作的那句话，也不必让「更多」行认识任何
   * 具体插件。
   */
  attentionTitle?: (() => string) | undefined
}

/** 「更多」菜单的登记表服务。 */
export interface FootMenuService {
  /** 登记一个条目；返回注销函数（幂等）。 */
  add(entry: FootMenuEntry): () => void
  /** 动态状态（如 attention）变化后重新发布，驱动「更多」行重渲染。 */
  touch(): void
  /** 当前条目快照（按 order 排序，未变时返回同一引用）。 */
  snapshot(): readonly FootMenuEntry[]
  /** 订阅变化；返回退订函数。 */
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 侧边栏底部「更多」菜单的登记表（本包客户端半边 provide）。 */
    picoFootMenu: FootMenuService
  }
}

/** Cordis 服务名（唯一真源；`ctx.provide` 与消费者的 `inject` 都用它）。 */
export const FOOT_MENU_SERVICE = 'picoFootMenu'

/**
 * 建一个空的登记表。
 *
 * 快照只在**条目集合变化**（登记 / 注销）时重算 —— `touch()` 是纯发布，所以它不会让
 * `snapshot()` 换引用（消费者可以安全地按引用比较）。排序是稳定排序：`order` 相同时
 * 保持登记顺序。
 * @returns 空登记表。
 */
export function createFootMenuService(): FootMenuService {
  /** 登记序（`snapshot()` 的 tie-break 就是它）。 */
  const entries: FootMenuEntry[] = []
  const listeners = new Set<() => void>()
  let cached: readonly FootMenuEntry[] = []

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (cause) {
        // 一个订阅者抛错不能拖垮登记表本身（它可能是别的插件已卸载的组件）。
        console.warn('[pico-foot-menu] subscriber failed', cause)
      }
    }
  }

  const publish = (): void => {
    // `Array.prototype.sort` 自 ES2019 起是稳定排序 ⇒ 同 order 保登记序。
    cached = [...entries].sort((left, right) => left.order - right.order)
    notify()
  }

  return {
    add(entry: FootMenuEntry): () => void {
      entries.push(entry)
      publish()
      let live = true
      return () => {
        if (!live) return
        live = false
        const index = entries.indexOf(entry)
        if (index === -1) return
        entries.splice(index, 1)
        publish()
      }
    },
    touch(): void {
      // 条目没变 ⇒ 快照引用不变；只把「取值可能变了」这件事推给订阅者。
      notify()
    },
    snapshot(): readonly FootMenuEntry[] {
      return cached
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 当前安装的登记表实例（`FootMenuRow` 渲染时读取）。
 *
 * 为什么是模块级：本包的 `apply` 与 `FootMenuRow` 住在**同一个**客户端 bundle 里，
 * 所以这里的单例就是同一份模块实例；跨 bundle 的那一半走 Cordis 服务（见上）。
 */
let installed: FootMenuService | undefined

/**
 * 把登记表挂到上下文上（`apply` 调用一次）。
 *
 * 两件事必须一起做，而且**只能在这里做一次**：
 *  - **模块单例**：`FootMenuRow` 渲染时读它（`apply` 与组件在同一份 bundle 里）；
 *  - **Cordis 服务**：兄弟 bundle 用它登记条目（跨 bundle 唯一的通道）。
 *
 * 顺序是语义的一部分：**先 `provide` 再落地单例**。`provide` 是会抛的（服务名已被别的
 * fiber 占用、上下文已失效），先落地单例就会留下"服务不存在、组件却拿着它渲染"的半挂
 * 状态（2026-09-21 对抗审计 P2）。注销同理：只有单例仍指向本次服务的实例时才清空，
 * 免得把后来者的实例清掉。
 * @param ctx - 本包客户端半边的上下文。
 * @param service - 刚建好的登记表。
 * @returns 注销函数（清掉模块单例；服务本身随插件 fiber 下线）。
 */
export function installFootMenu(ctx: Context, service: FootMenuService): () => void {
  ctx.provide(FOOT_MENU_SERVICE, service)
  installed = service
  return () => {
    if (installed === service) installed = undefined
  }
}

/** 当前登记的登记表；插件还没 apply 时为 `undefined`（此时「更多」行不渲染）。 */
export function currentFootMenuService(): FootMenuService | undefined {
  return installed
}
