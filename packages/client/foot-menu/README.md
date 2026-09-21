# @picoaide/dsh-foot-menu

侧边栏底部的**并道行**：一个 `⋯ 更多` 行 + 向上浮层。它本身不拥有任何面板、路由或数据面，
只拥有"底部功能区的一个座位"和一张**登记表**。

```
宽栏常驻            点「更多」→ 向上浮层（portal 到 body）
┌──────────────────┐   ┌────────────────────────┐
│ ⋯ 更多 · 能力中心 │   │ ✓ ✦ 能力中心            │
│ ⚙ 设置            │   │   ⏱ 定时任务            │
│ U user · ¥89.65  │   │   ⧉ 连接器              │
└──────────────────┘   └────────────────────────┘
```

## 它替代了什么

五个面板类插件（`dsh-cron` / `dsh-enterprise` 能力中心 / `dsh-connectors` / `dsh-browser` /
`dsh-wasm-apps` 应用中心）改造前各自往 `sidebar.footer.action` 注册**一整行**，底部固定占掉
约 210px。现在它们各自只登记**一个条目**，底部只剩这一行。

## 契约

客户端半边提供 Cordis 服务 `picoFootMenu`（`ctx.provide('picoFootMenu', …)`）：

```ts
interface FootMenuEntry {
  id: string                                   // 打开面板的条目必须等于 panel-surface 的 PanelId
  order: number                                // 升序；相同 order 保登记序
  title: () => string                          // 渲染时读取（语言切换后跟着变）
  activate: () => void                         // 点击要做的事
  attention?: (() => boolean) | undefined      // true ⇒ 行上圆点 + 条目琥珀色
  attentionTitle?: (() => string) | undefined  // 警示 tooltip / aria-label（可操作的那句）
}
interface FootMenuService {
  add(entry: FootMenuEntry): () => void        // 返回**幂等**注销函数
  touch(): void                                // 动态取值（如 attention）变化后重新发布
  snapshot(): readonly FootMenuEntry[]         // 按 order 排序；未变时返回同一引用
  subscribe(listener: () => void): () => void
}
```

消费者：用 `import type {} from '@picoaide/dsh-foot-menu/client'` 取类型（**绝不**运行时
import 本包），并且**不要**把 `'picoFootMenu'` 写进自己的 `inject`：提供它的这一行可以被
渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用，硬 inject 会让整条 fiber 永久 pending
（无报错）。条目从**子 fiber** 登记，只有它等服务到位：

```ts
ctx.inject(['picoFootMenu'], (scope: ClientContext) => {
  scope.effect(() => scope.picoFootMenu.add({ id, order, title, activate, attention, attentionTitle }),
    '<pkg>: foot menu entry')
})
```

警示文案分两层：`footMenu.attention`（通用："AI 正在等待你的操作"）是兜底，
`attentionTitle()` 是条目自己给的**可操作**那句（浏览器的"打开浏览器窗口点「交给 AI」"）——
两者都进「更多」行的 tooltip 与浮层条目的 `title`/`aria-label`。

## 为什么是服务，而不是槽位

槽位 list 能把多个占用者排成**多行**，却不能把它们合并进**一行** —— 而改造的诉求正是
"一行 + 浮层"。条目还要跨 bundle 传递（每个插件是一个独立的客户端 bundle），
客户端 Cordis 服务是跨 bundle 的**唯一**通道：`@picoaide/dsh-panel-surface` 会被内联进
每个 bundle，模块级单例在浏览器里根本不是同一份。

ReactNode 不过界：条目只带数据，图标由本包的 glyph 表按 `id` 提供（未登记的 id 走兜底图形）。

## 实现要点

- **浮层 portal 到 `document.body`**：侧边栏列在收起动画里带 `overflow:hidden`，留在座位里的
  绝对定位会被裁掉。portal 出去后用 `position:fixed` 向上展开，并在 `window` resize 与锚点
  `ResizeObserver` 时重算。
- **关闭态是 `display:none` 而不是卸载**：条目背后的状态（例如浏览器插件的控制权轮询）
  不能因为浮层收起而停；`display:none` 同时保证隐藏条目不可聚焦、不进 tab 序列。
- **激活态文案**（`更多 · 能力中心`）读 `panel-surface` 的唯一激活态属性；面板关闭只删属性、
  不发事件，所以必须用 `MutationObserver`，不能只听 `PANEL_ACTIVATE_EVENT`。
- 键盘：`Esc` 关闭并把焦点还给「更多」行（浮层里已有真正的模态对话框时不抢）、
  `ArrowDown`/`ArrowUp`/`Home`/`End` 在条目间移动；外部 `pointerdown` 关闭。

## 文件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 宿主半边：no-op（本包无路由/数据面，只是客户端 bundle 载体） |
| `src/client/contract.ts` | 服务契约 + `declare module '@deepseek-ai/cordis'` + 登记表实现 |
| `src/client/FootMenuRow.tsx` | 「更多」行 + 向上浮层 |
| `src/client/glyphs.tsx` | 五个面板图标（自被替换的 trigger 逐字搬来）+ 「更多」/✓/chevron/兜底 |
| `src/client/locales.ts` | zh（key 源）+ en 镜像 |
| `src/client/index.ts` | 字典 + 提供 `picoFootMenu` + 注册唯一槽位占用者 |
