# 暗色模式适配审计：token 幻影引用与对比度（2026-09-16）

状态：已实施（本仓自己的插件已修；vendored 第三方插件的适配层**待拍板**）

## 触发（用户 2026-09-16 反馈）

1. macOS 菜单栏图标只剩一个方块 → 已单独定案（见
   `docs/decisions/2026-09-16-macos-tray-template-glyph.md`）。
2. **左上角版本号在暗色下看不清**："没有变成白色框黑色字"。

## 根因（一类，不是两处）

客户端主题由 `body[data-ds-dark-theme]` 切换 CSS 变量，变量权威定义在上游
`deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css`
（`body {}` = 亮色基准，`body[data-ds-dark-theme] {}` = 暗色覆盖）。

**我们代码里写了上游根本不存在的 token 名**，CSS 不会报错：`var(--x, 字面量)` 会安静
地走 fallback，于是那个颜色**永远不随主题变化**。版本号胶囊就是典型 —— 它用的是
`--dsw-alias-fg-primary`（上游 0 定义）：

| 主题 | 胶囊底色 | 胶囊文字 | 结果 |
| --- | --- | --- | --- |
| 亮色 | fallback `#000000` | `--dsw-alias-bg-base` = `rgb(255,255,255)` | 黑底白字（看着正常） |
| 暗色 | fallback `#000000` | `--dsw-alias-bg-base` = `rgb(21,21,23)` | **黑底近黑字** |

正确的一对是 `--dsw-alias-label-primary`（亮近黑/暗近白）+ `--dsw-alias-label-primary-inverted`
（亮近白/暗深灰）⇒ 亮色黑底白字、暗色白底黑字，正是用户期待的样子。

同一类还有更脏的变体：**token 未定义且没有 fallback** ⇒ 整条声明失效
（`1px solid var(--dsw-alias-border-l)` 连边框都不画）。

## 已修（我们自己的包）

| 位置 | 原状 | 改成 | 暗色后果 |
| --- | --- | --- | --- |
| `enterprise/src/client/Channel.tsx` 品牌方块 + 版本胶囊 + 右上徽章 | `fg-primary` / `bg-base` / `fg-secondary` | `label-primary` / `label-primary-inverted` / `label-secondary` | 方块与胶囊在暗色下"黑底黑 mark / 黑底黑字"，几乎不可见 |
| `client/branding/src/client/Brand.tsx`（web 形态同款拷贝） | 同上 | 同上（与 enterprise 逐值一致） | 同上 |
| `enterprise/src/client/UpdateIndicator.tsx` | `fg-primary`；状态点写死 `#16a34a/#f59e0b/#3b82f6` | `label-primary`；`state-success-primary`/`state-warn-primary`/`state-business-primary` + 1px 描边 | 暗色下文字不可读；亮色下琥珀点只有 2.06:1 |
| `enterprise/src/client/AccountSection.tsx` | `state-info-primary` / `border-primary` / `bg-elevated` / `text-primary` | `state-business-primary` / `border-l2` / `bg-layer-1` / `label-primary` | 输入框在暗色下仍是白底深字 |
| `enterprise/src/client/CapabilityCenterPanel.tsx` | `border-l`（无 fallback，边框不画）/ `label-inverted` / 紫色 `#7C3AED` 徽章 / 两层死名字的头像色 | `border-l2` / `label-primary-foreground` / `label-tertiary` / 四个 alias token | 分隔线消失；主按钮文字色漂移；紫徽章在暗底 2.45:1 |
| `desktop/src/client/styles.ts` 更新徽标 | `bg-elevated` / `fg-1` / 写死的焦点环与状态点 / ready 态深绿字 | `bg-layer-2` / `label-primary` / 品牌与 state token | 胶囊在暗色下仍是白底；ready 深绿字在暗底 2.78:1 |
| `desktop/src/electron-runtime.ts` 崩溃兜底页（`data:text/html` 独立文档） | 整页写死亮色 | 补 `@media (prefers-color-scheme: dark)` + `color-scheme` | 暗色下闪一整页刺眼白 |
| `connectors/src/client/ConnectorsSection.tsx` | `#2563eb`/`#fff` 写死；拒绝/断开/停止按钮用实心 state 色 + 白字 | 成对 token（`button-primary-fill` + `label-primary-foreground`）；破坏性动作用**描边式**（`state-error-primary` / `state-warn-label`） | 暗色下白字压红/琥珀只有 3.29:1 / 2.15:1 |
| `browser/src/shell-pages.ts`（两页） | 胶囊按钮 `color:#fff` 配会翻转的 `--warning`/`--accent`；无 `color-scheme`；死变量 `--accent-soft` | 新增 `--on-warning` / `--on-accent`（亮/暗成对）并在 JS 切底色时同步切字色；补 `color-scheme: light dark`；删死变量 | "我来操作 / 交给 AI"唯一入口按钮暗色下 2.14:1 |
| `enterprise/src/auth-gate.ts` | 登录按钮/方式选择器 `#fff` 配暗色浅蓝（3.68:1）；品牌兜底方块 `#0f1115` 与暗色页面底色 1.00:1；改密页/恢复中页整页写死亮色无暗色分支 | 新增 `--accent-fg` / `--brand-tile-bg` / `--brand-tile-fg`（mark 改 `currentColor`）；两页补 `:root` 变量 + 暗色媒体查询 + `color-scheme` | 暗色下按钮字对比不足、品牌方块轮廓消失、整屏白闪 |

## 新增门禁（防复发）

`scripts/check-theme-tokens.mjs`（根守卫，`yarn check:theme-tokens`，已进
`scripts/check-workspaces.mjs` 的阶段 1）：

- 解析上游样式得到有效 token 集（357 个），扫描我们自己的源码（`packages/host`、
  `packages/client`、`brands`、`site/src`；**排除 `packages/vendor`**）；
- **阻断**：token 未定义且 fallback 链最终是字面量（或压根没有 fallback）；
- **提示**：token 未定义但 fallback 是有效 token（行为正确，删掉死名字即可）；
- 报错带 `file:line` + 原始行 + "相近的可用 token"（编辑距离），并内置
  `--self-test` 正反用例（每次运行都跑，防守卫退化成恒绿）。

## 待拍板 / 未修（认账）

1. **vendored `packages/vendor/memory-evolve`（随桌面包分发，第三方上游
   `github.com/csyangwen/dsh-memory-evolve`）**：12 个 CSS 里 11 个带病 ——
   **240 处 `var(--dsw-*)` 指向 49 个上游不存在的名字**（占该插件 token 引用的 18.9%），
   其中 138 处落到写死颜色、**37 处无 fallback（整条声明失效：边框在两种主题下都不画）**、
   2 处暗色 P0（`bookmark-styles.css:79` 白底 + 近白文字的菜单、`skills-browser/styles.css:248`
   白字白底主按钮）。**升级上游修不了**（上游 main 与 vendored 基线在这 49 个名字上逐字节一致）。
   **建议方案**：不动 vendored，用上游现成的 `ctx.theme.overrideTokens(source, {name:{light,dark}})`
   加一层 49 名映射适配层（本仓 `client/branding` 已有先例；桌面 presenter 把 token 写成
   body 内联变量，任意名字都生效，且值可以写 `var(--dsw-alias-border-l1)` 自动跟随主题）。
   代价：组 2/组 3 共 23 个名字上游无语义对应，需要人工定亮/暗两色并真机复核。
2. `packages/client/branding` 只服务 web 形态（不在桌面 profile 内），其中
   `brand-shell.tsx` 把 `--dsw-alias-brand-primary` 覆盖成绿色 —— 该 token 上游当
   **近黑/近白墨色**用，且被 `--dsw-alias-button-primary-fill`、Switch、输入框描边、
   焦点环复用 ⇒ 覆盖后这些控件全变绿，而 `--dsw-alias-button-primary-hover` 仍是灰色。
   属产品/品牌口径，未擅自改。
3. 低优先：favicon 无暗色变体（与托盘派生"平坦 rect"约束冲突，需单独立项）；
   `CapabilityCenterPanel` 卡片在暗色下用 `bg-layer-1` 放在 `bg-layer-2` 上 = 1.13:1
   （凹陷而非抬升，有描边兜底，待真机观感确认）；登录页输入框描边两主题都不到 3:1
   （既有取色）。
4. 本轮全部对比度为**静态计算**（token 取值 + WCAG 公式），未做真机暗色截图复核；
   建议后续真机过一遍主要面板。
