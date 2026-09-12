import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings slot contract (settings.section) and the
// slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: merges the layout-owned `sidebar` row into SlotMap (the sidebar
// contract types resolve through it).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: declares the sidebar brand slots (`sidebar.brand.mark` /
// `sidebar.brand.name`) and the foot action slot.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: declares the conversation hero brand-mark slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ChannelConfig } from '../channel-content.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/channel-changed'(channel: ChannelConfig | null): void
  }
}
import { AccountSection } from './AccountSection.tsx'
import { BraceMark, BrandName, BrandBadge } from './Channel.tsx'
import { applyUpdateSection } from './UpdateSection.tsx'
import { buildChannelCSSVars } from './channel-vars.ts'
import { installFavicon } from './favicon.ts'
import { channelTitle } from '../channel-content.ts'
import { startChannelStore, readChannelSync, subscribeChannel } from './channel-store.ts'
import { CapabilityCenterTrigger } from './CapabilityCenterTrigger.tsx'
import { en, type EnterpriseKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Enterprise client surface copy. */
    enterprise: EnterpriseKey
  }
}

/** Stable Cordis plugin name for the enterprise client half. */
export const name = 'picoaide-enterprise-client'

/** Locale namespace owning the enterprise client copy. */
const LOCALE_NS = 'enterprise'

/** Services required: the slot registry for settings pages. */
export const inject = ['slots', 'locale']

/**
 * Enterprise brand chrome: layout-only overrides for surfaces the upstream
 * slots do not cover. The sidebar foot action container is a flex row, so it
 * is pinned to column to let stacked actions (skill center, cordis panel)
 * sit one per row above Settings instead of overflowing side by side; the
 * skill center trigger matches the Settings trigger hover. The hero headline
 * and preview badge stay upstream-owned text (`hero.headline` /
 * `hero.preview` in the `conversation` dictionary); the upstream locale
 * service registers each (namespace, locale) exactly once, so this client
 * cannot override them — give the upstream ui-conversation a configurable
 * headline and delete the two `headlineText`/`previewBadge` rules below.
 */
const BRAND_CSS = `
/* Sidebar foot actions stack vertically above Settings (upstream container is a row). */
[class$="_footerActions"] { flex-direction: column; align-items: stretch; }

/* Hero headline + preview badge text (upstream locale not overridable).
 *
 * 0.1.5-rc.2 把首屏标题的 CSS 类从 \`headlineText\` 改名为 \`titleGroup\`，并在其中
 * 包了两层：\`<span class="_titleGroup_…"><span>{headline}</span><span class="_previewBadge_…">\`。
 * 只改类名不够 —— 必须命中的是**第一个内层 span**，否则 \`font-size: 0\` 会把
 * 「企业版」徽标一起吃掉（2026-09-12 打包版真机复现：规则空匹配时首屏显示上游
 * 文案「探索未至之境」，而 \`--pico-hero-headline\` 明明有值）。
 * 兼容旧类名：两个选择器并存，任一版本升级都不会静默失效。 */
[class$="_headlineText"], [class$="_titleGroup"] > span:first-child { font-size: 0; }
[class$="_headlineText"]::after, [class$="_titleGroup"] > span:first-child::after { content: var(--pico-hero-headline, "PicoAide Harness"); font-size: 26px; line-height: 32px; font-weight: 500; }
[class$="_previewBadge"] { font-size: 0; }
[class$="_previewBadge"]::after { content: var(--pico-hero-tagline, "企业版"); font-size: 12px; line-height: 18px; font-weight: 500; font-family: var(--ds-font-family-code); }

/* Skill center trigger hover feedback, matching the Settings trigger. */
.pico-skill-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* Skill center card grid: hover lift + focus ring (inline-styled card, CSS-only affordances). */
.pico-skill-card {
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.pico-skill-card:hover {
  border-color: var(--dsw-alias-brand-primary) !important;
  box-shadow: 0 2px 8px var(--dsw-shadow-lv1, rgba(0, 0, 0, 0.08));
}
.pico-skill-card:focus-within {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
`

/**
 * Register the enterprise surfaces: the brace brand at the upstream brand
 * slots (sidebar mark/name, hero mark), the skill center foot action above
 * the sidebar Settings trigger, the account page (username + logout) at the
 * bottom of settings, the branded document title, and the layout-only brand
 * chrome above.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // 服务端渠道配置同步(登录后拉取 /api/client/v2/channel; 登出回退默认)。
  ctx.effect(
    () => {
      // 2026-09-08 P2-18:只启动一次(此前第 99 行先启动一次并丢弃 disposer,
      // 第 112 行又启动一次 → 双订阅,首个 disposer 永不释放)。
      const offStore = startChannelStore(ctx)
      // v3b §4.2: hero CSS 变量注入(渠道配置变化时更新)。
      // 注意: --pico-hero-headline/--pico-hero-tagline 被 BRAND_CSS 的
      // `content: var(…)` 消费, content 只接受字符串字面量, 值必须带引号
      // 写入(buildChannelCSSVars 内 JSON.stringify), 否则整条声明非法、
      // hero 标题文字不可见(2026-09 实测)。渠道色已下线(2026-09 决策)。
      const applyVars = (channel: ChannelConfig | null): void => {
        const root = document.documentElement
        for (const [k, v] of Object.entries(buildChannelCSSVars(channel))) {
          root.style.setProperty(k, v)
        }
      }
      applyVars(readChannelSync())
      // 渠道变更驱动 hero 变量(与 channel-store 同事件;此处仅应用 CSS 变量)。
      const off = ctx.on('pico/channel-changed', (channel) => applyVars(channel))
      // 播种(本地)同样要驱动变量:否则 hero 标题停在回落文案上。
      const offStoreValue = subscribeChannel((channel) => applyVars(channel))
      return () => { off(); offStoreValue(); offStore() }
    },
    'enterprise: channel store',
  )

  // Enterprise client dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'enterprise: client dictionaries')

  // Upstream brand slots (single/root). The official occupant is suppressed
  // by the desktop patch on @deepseek-ai/dsh-client-ui-brand-official, so
  // these registrations are the only occupants and cannot collide.
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
      name: 'sidebar.brand.mark',
    }, BraceMark)),
    'enterprise: sidebar brand mark',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
      name: 'sidebar.brand.name',
    }, BrandName)),
    'enterprise: sidebar brand name',
  )
  // v2.5.1: 设置页「关于」区(当前版本 + 检查更新)。
  applyUpdateSection(ctx)
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
      name: 'conversation.hero.brand.mark',
    }, BraceMark)),
    'enterprise: hero brand mark',
  )

  // 右上角品牌位(v3b): 会话 header action 区, 仅服务端启用品牌时显示。
  ctx.effect(
    () => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'brand-badge',
      order: 100,
    }, BrandBadge)),
    'enterprise: header brand badge',
  )

  // 桌面 favicon: 替换上游 DeepSeek 鱼为官方花括号 mark(brands/official/logo.svg)。
  // 桌面组装不含 @picoaide/dsh-branding, 本面是 desktop 唯一 favicon 覆盖点。
  ctx.effect(() => {
    installFavicon()
    return () => { /* favicon reverts on the next navigation */ }
  }, 'enterprise: desktop favicon')

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'capability-center',
      order: -1,
    }, CapabilityCenterTrigger)),
    'enterprise: capability center foot action',
  )

  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'account',
      order: 999,
      label: '账号',
    }, AccountSection)),
    'enterprise: account section',
  )

  // v3b §4.2: document.title 跟随渠道配置(channel.title), 渠道变化时更新。
  // 2026-09-05: 上游 dsh-client-ui-renderer 的 DocumentTitle 把 productTitle
  // 硬编码为 "DeepSeek Harness", 其 React useEffect 在本面插件 apply 之后
  // 运行, 会把标题盖回来(且带会话标题投影: `<会话名> — <产品名>`)。
  // 这里在渠道标题之上加 MutationObserver 归一化: 仅替换产品名片段、
  // 保留会话标题前缀, 不做无条件重写(避免与上游会话标题投影打架)。
  ctx.effect(() => {
    const UPSTREAM_PRODUCT_TITLE = 'DeepSeek Harness'
    // 标题名与侧边栏同源(channel-content 的 channelTitle):渠道构建下不可能
    // 回落厂商名 —— 页面标题是窗口/任务栏标题的来源。
    const productTitle = (channel: ChannelConfig | null): string => channelTitle(channel)
    const current = (): string => document.title
    /**
     * 上一次**我们**写进标题的产品名。
     *
     * 归一化必须对自己写过的值也成立:渠道内容(随包品牌播种)比上游的 React
     * effect 晚到,第一遍只能按"当时已知的"产品名写(未播种时是内置官方名),
     * 播种后必须能把它**再改一次**成渠道名。只认上游字面量的话,第二遍就会
     * 因为"标题已不是 DeepSeek Harness"而放弃 —— 实测表现为:侧边栏已是渠道名,
     * 窗口/taskbar 标题还停在厂商名。
     */
    let writtenProduct: string | undefined
    const apply = (channel: ChannelConfig | null): void => {
      const product = productTitle(channel)
      const t = current()
      const known = writtenProduct === undefined
        ? [UPSTREAM_PRODUCT_TITLE]
        : [UPSTREAM_PRODUCT_TITLE, writtenProduct]
      const bare = known.find(candidate => t === candidate)
      const prefixed = known.find(candidate => t.endsWith(` — ${candidate}`))
      let next: string
      if (bare !== undefined) {
        next = product
      } else if (prefixed !== undefined) {
        next = `${t.slice(0, -(prefixed.length + 3))} — ${product}`
      } else {
        next = t
      }
      if (next !== t) {
        document.title = next
        writtenProduct = product
      }
    }
    apply(readChannelSync())
    const off = ctx.on('pico/channel-changed', (channel) => apply(channel))
    // 随包品牌的播种不经过 Host 事件,必须直接订阅 store 的值变化。
    const offStoreValue = subscribeChannel((channel) => apply(channel))
    const observer = new MutationObserver(() => apply(readChannelSync()))
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => { off(); offStoreValue(); observer.disconnect() }
  }, 'enterprise: document channel title')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = BRAND_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'enterprise: brand styles')
}
