/**
 * vendored `dsh-memory-evolve` 的旧色板适配层（2026-09-16 暗色审计）。
 *
 * ## 为什么需要这一层
 *
 * `packages/vendor/memory-evolve`（第三方上游 `github.com/csyangwen/dsh-memory-evolve`
 * 的复制式 vendored 副本，随桌面包分发）里有 **41 个上游根本不存在的 `--dsw-*` 名字、
 * 198 处引用**：CSS 不报错，`var(--x, 字面量)` 会安静走 fallback ⇒ 那些颜色
 * **永远不随主题变化**；其中 `--dsw-alias-border-l`（36 处）与
 * `--dsw-alias-interactive-fg-default`/`--dsw-alias-text-tertiary` 等**没有 fallback**，
 * 整条声明直接失效（边框两种主题下都不画）。上游目前也修不了：实测上游 main 与
 * vendored 基线在这 41 个名字上逐字节一致（详见
 * `docs/decisions/2026-09-16-dark-mode-token-audit.md`）。
 *
 * ## 为什么用适配层而不是改 vendored 源码
 *
 * vendored 目录是**复制式**同步：改源码就要在 `VENDORED.md` 里追加补丁、且每次
 * 同步上游都要重放（现已有 9 条）。而主题服务本来就支持第三方覆盖层
 * （`ctx.get('theme').overrideTokens(source, tokens)`，见 `@deepseek-ai/dsh-client-ui-theme/client`），
 * 桌面 presenter 会把层里的 token 写成 `body` 的**内联自定义属性** ⇒ 任意名字都能有值、
 * 且 custom property 会被所有后代继承。一次覆盖 41 个名字即可同时修好：
 * 失效声明（边框回来了）、写死颜色（落回真实 token）、白字白底（成对 token）。
 *
 * ## 取值口径
 *
 * - **同义 alias 直接指真实 token**（`{light: var(--real), dark: var(--real)}`）：
 *   真实 token 自己会随主题翻转，这是我们想要的收益。
 * - **另一套 0–11 刻度色板**（vendored 来自另一套设计系统）：上游用 0–1000 刻度且
 *   **static 主题不变**，所以能同值的就映射到同值 static token（视觉零变化，只是
 *   名字不再是幻影）；没有同值的（紫/黄/deep 色阶）给显式 `{light, dark}` 一对，
 *   暗色取更亮的一档 —— 今天这些位置在暗色下就是深色字压深底。
 * - 字体族（`--dsw-font-family-mono`，上游只有 `--dsw-font-family`）给两主题同值。
 *
 * @module dsh-plugin-desktop/legacy-theme-tokens
 */

/** 一个 token 的亮/暗两套取值。 */
export interface LegacyTokenModes {
  readonly light: string
  readonly dark: string
}

/** 覆盖层标识（一个 source 一层；重复调用会替换该层）。 */
export const LEGACY_THEME_TOKEN_SOURCE = 'picoaide-vendored-legacy-tokens'

/** 两套取值都指向同一个真实 token（该 token 自己会翻转）。 */
function alias(token: string): LegacyTokenModes {
  const value = `var(${token})`
  return { light: value, dark: value }
}

/** 显式给亮/暗两套字面量（或其中之一是 var(...)）。 */
function pair(light: string, dark: string): LegacyTokenModes {
  return { light, dark }
}

/**
 * 41 个旧名字 → 亮/暗取值。
 *
 * 名字清单由 `tests/legacy-theme-tokens.spec.ts` 对 vendored 源码做**全深度扫描**
 * 后逐一对账：漏一个就红（防止下一轮上游同步带进新名字而没人发现）。
 */
export const LEGACY_THEME_TOKENS: Readonly<Record<string, LegacyTokenModes>> = Object.freeze({
  // ---- A. 同义 alias（真实 token 自动跟随主题）----
  '--dsw-alias-border-l': alias('--dsw-alias-border-l1'),
  '--dsw-alias-border-subtle': alias('--dsw-alias-border-l1'),
  '--dsw-alias-bg-elevated': alias('--dsw-alias-bg-layer-2'),
  '--dsw-alias-bg-l2': alias('--dsw-alias-bg-layer-2'),
  '--dsw-alias-bg-primary': alias('--dsw-alias-bg-layer-2'),
  '--dsw-alias-bg-secondary': alias('--dsw-alias-bg-layer-1'),
  '--dsw-alias-label-inverted': alias('--dsw-alias-label-primary-inverted'),
  '--dsw-alias-label-on-primary': alias('--dsw-alias-label-primary-foreground'),
  '--dsw-alias-text-tertiary': alias('--dsw-alias-label-tertiary'),
  '--dsw-alias-fill-muted': alias('--dsw-alias-label-tertiary'),
  '--dsw-alias-interactive-fg-default': alias('--dsw-alias-label-primary'),
  '--dsw-alias-state-accent-primary': alias('--dsw-alias-state-business-primary'),
  '--dsw-alias-state-business-secondary': alias('--dsw-alias-state-business-primary'),
  '--dsw-alias-state-warning-primary': alias('--dsw-alias-state-warn-primary'),
  '--dsw-alias-state-warning-fg': alias('--dsw-alias-state-warn-label'),
  '--dsw-alias-state-warning-tertiary': alias('--dsw-alias-state-warn-tertiary'),
  '--dsw-alias-state-warning-border': alias('--dsw-alias-state-warn-secondary'),
  '--dsw-alias-state-warn-border': alias('--dsw-alias-state-warn-secondary'),
  '--dsw-alias-state-danger-border': alias('--dsw-alias-state-error-secondary'),
  '--dsw-alias-state-danger-label': alias('--dsw-alias-state-error-primary'),
  '--dsw-alias-scrollbar-bg-l': alias('--dsw-alias-scrollbar-bg-l1'),
  '--dsw-alias-scrollbar-hover-l': alias('--dsw-alias-scrollbar-hover-l1'),
  '--dsw-alias-input-bg': alias('--dsw-specific-input-major'),

  // ---- B. 0–11 刻度色板 → 同值/近值 static token（两主题同值，与今天观感一致）----
  '--dsw-static-blue-5': alias('--dsw-static-blue-500'),
  '--dsw-static-blue-6': alias('--dsw-static-blue-600'),
  '--dsw-static-blue-9': alias('--dsw-static-blue-500'),
  '--dsw-static-amber-5': alias('--dsw-static-amber-500'),
  '--dsw-static-amber-6': alias('--dsw-static-amber-600'),
  '--dsw-static-red-5': alias('--dsw-static-red-500'),
  '--dsw-static-red-9': alias('--dsw-static-red-500'),
  '--dsw-static-green-5': alias('--dsw-static-green-500'),
  '--dsw-static-green-9': alias('--dsw-static-green-500'),
  '--dsw-static-neutral-5': alias('--dsw-static-neutral-bluish-500'),
  '--dsw-static-deepseek-5': alias('--dsw-static-deepseek-500'),
  '--dsw-static-yellow-9': alias('--dsw-static-amber-400'),
  '--dsw-static-yellow-10': alias('--dsw-static-amber-600'),
  // 灰度族（Tailwind 命名，上游没有 gray 家族，同值映射到 neutral-bluish）：
  // 这些名字多数只出现在**嵌套 fallback** 里（外层是真实 token），但同样对账，
  // 免得下次有人把外层删掉就露出幻影名。
  '--dsw-static-white': alias('--dsw-static-neutral-bluish-00'),
  '--dsw-static-gray-2': alias('--dsw-static-neutral-bluish-50'),
  '--dsw-static-gray-5': alias('--dsw-static-neutral-bluish-100'),
  '--dsw-static-gray-6': alias('--dsw-static-neutral-bluish-300'),
  '--dsw-static-gray-9': alias('--dsw-static-neutral-bluish-700'),
  '--dsw-static-gray-10': alias('--dsw-static-neutral-bluish-750'),
  '--dsw-static-gray-11': alias('--dsw-static-neutral-bluish-1000'),

  // ---- C. 上游没有对应族/档位：显式给亮暗一对（暗色取更亮的一档）----
  '--dsw-static-blue-11': pair('#1d4ed8', 'var(--dsw-static-blue-400)'),
  '--dsw-static-amber-7': pair('#b45309', 'var(--dsw-static-amber-400)'),
  '--dsw-static-red-11': pair('#c62a2f', 'var(--dsw-static-red-400)'),
  '--dsw-static-green-11': pair('#18794e', 'var(--dsw-static-green-400)'),
  '--dsw-static-purple-5': pair('#9333ea', '#c084fc'),

  // ---- D. 字体：上游没有 mono token，两主题同值 ----
  '--dsw-font-family-mono': pair(
    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  ),
})

/** 主题服务的最小面（避免跨包 import；运行时由 `dsh-client-ui-theme` 提供）。 */
interface ThemeOverrideFace {
  overrideTokens(source: string, tokens: Record<string, LegacyTokenModes>): () => void
}

/**
 * 把旧名字覆盖层压到当前主题上。
 * @param ctx - browser Cordis context（取 `theme` 服务）。
 * @returns 卸载该层的 disposer；主题服务缺席时返回 undefined（兼容模式/最小启动）。
 */
export function applyLegacyThemeTokens(ctx: { get: (name: string) => unknown }): (() => void) | undefined {
  const theme = ctx.get('theme') as ThemeOverrideFace | undefined
  if (theme === undefined || typeof theme.overrideTokens !== 'function') return undefined
  return theme.overrideTokens(LEGACY_THEME_TOKEN_SOURCE, { ...LEGACY_THEME_TOKENS })
}
