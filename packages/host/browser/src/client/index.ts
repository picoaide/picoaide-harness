import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the foot-lane registry contract (`ctx.picoFootMenu`). The single
// sidebar foot row belongs to `@picoaide/dsh-foot-menu` and reaches this bundle
// as a Cordis service — never as a module import.
import type {} from '@picoaide/dsh-foot-menu/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { showsWaitingHint } from './control-hint.ts'
import * as controlHint from './control-hint-store.ts'
import { en, setActiveLocale, t, type BrowserKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser client surface copy. */
    browser: BrowserKey
  }
}

/**
 * Browser client half: registers the foot-lane entry that wakes the dedicated
 * browser window. The window (created by the host plugin on first agent open)
 * carries its own tab strip and controls; the popover entry shows it again
 * after a user close, and carries today's "AI 在等你" signal (amber dot on the
 * `更多` row, amber text + dot on the entry).
 *
 * The control hint used to be polled inside the deleted `BrowserTrigger`
 * component; it now lives in a plugin-scope store started here, so collapsing
 * the popover never stops it (见 `control-hint-store.ts`).
 */
export const name = 'pico-browser-client'

const LOCALE_NS = 'browser'

/** Services required: locale for the entry copy. `picoFootMenu` is waited on from a child scope. */
export const inject = ['locale']

export function apply(ctx: ClientContext): void {
  // Browser client dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'browser: client dictionaries')

  // Follow the active locale so the module-level `t()` (used by the entry
  // title) renders in English when that is the user's choice, instead of always
  // reading the zh key source.
  ctx.effect(() => {
    const locale = ctx.locale as unknown as {
      getLocale?: () => { active?: unknown }
      subscribe?: (listener: () => void) => () => void
    }
    const sync = (): void => {
      try {
        const active = locale.getLocale?.()?.active
        if (typeof active === 'string') setActiveLocale(active)
      } catch { /* keep the last known locale */ }
    }
    sync()
    if (typeof locale.subscribe !== 'function') return () => {}
    return locale.subscribe(sync)
  }, 'follow active locale')

  // Control-hint store: polling lives here (not in a component) so it survives the
  // popover being closed. 轮询本身在**外层**跑（与 foot 行在不在无关），只有"把变化
  // 推给「更多」行"这一步需要服务 —— 见下面的子 fiber。
  ctx.effect(() => {
    controlHint.start()
    return () => { controlHint.dispose() }
  }, 'browser: control hint store')

  // Foot-lane entry. `id: 'browser'` is deliberately NOT a panel-surface PanelId
  // (the browser lives in its own OS window, not in the center column), so the
  // `更多` row never claims the browser is "the active panel".
  //
  // 两件事都放在**子 fiber** 里等服务到位：
  //  ① 订阅提示变化并 `touch()` 重新发布；② 登记条目。
  // 为什么 ① 也必须在这里：`picoFootMenu` 不在本插件的 `inject` 里，而 Cordis 4 对
  // **未 inject 的服务读取直接抛**（`cannot get property "picoFootMenu" without
  // inject`）—— 在订阅回调里读外层 `ctx.picoFootMenu` 会在**每一次提示变化**时抛异常
  // （被 store 的 try/catch 吞掉），于是「更多」行的琥珀色圆点永远不会实时出现：
  // `attention()` 是对的，但已经渲染好的行不会再渲染（2026-09-21 二轮对抗审计 P1，
  // 真 cordis 探针实测 touchCalls: 0）。子 scope 里读 `scope.picoFootMenu` 合法。
  // 反过来硬 inject 也不行：那一行可以被渠道覆盖层禁用，硬 inject 会让整条 fiber
  // 永久 pending（无报错），把控制权轮询一起带走（P1-7 教训）。
  ctx.inject(['picoFootMenu'], (scope: ClientContext) => {
    scope.effect(() => {
      const off = controlHint.subscribe(() => { scope.picoFootMenu.touch() })
      return () => { off() }
    }, 'browser: republish control hint')
    scope.effect(() => scope.picoFootMenu.add({
      id: 'browser',
      order: 1,
      title: () => (showsWaitingHint(controlHint.current()) ? t('panel.waitingShort') : t('panel.title')),
      activate: () => {
        // 2026-09-15 审计 F6：这是写面（需持有性证明 cookie）。失败时旧实现静默吞掉，
        // 用户看到的正是"点了按钮没反应"，而主机日志与客户端控制台都不留痕。
        void fetch('/api/pico/browser/show', { method: 'POST' }).then(
          (response) => {
            if (!response.ok) console.warn('[pico-browser] show rejected', response.status)
          },
          (cause: unknown) => { console.warn('[pico-browser] show request failed', cause) },
        )
      },
      attention: () => showsWaitingHint(controlHint.current()),
      // 警示 tooltip 的**可操作**文案（"打开浏览器窗口点「交给 AI」"）：条目自己的
      // 出口，`更多` 行与浮层条目优先用它，拿不到才退回通用的 `footMenu.attention`。
      // 2026-09-21 对抗审计：并道时这句一起丢了，用户只剩圆点与短标签、不知道下一步。
      attentionTitle: () => t('panel.waiting', { button: t('button.handBack') }),
    }), 'browser: foot menu entry')
  })
}
