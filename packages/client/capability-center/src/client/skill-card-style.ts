/**
 * 能力中心技能卡的 **CSS-only** 悬停/焦点反馈。
 *
 * 2026-10-13 逐字搬自 `@picoaide/dsh-enterprise` 的 `src/client/index.ts`（那里的
 * `brandCss()` 末尾三条 `.pico-skill-card` 规则）。**选择器与声明一字未改**，只是改由
 * 本包在 `apply()` 时装一次 —— 卡片的 `className="pico-skill-card"` 由本包的面板渲染，
 * 样式就该由本包负责；搬出后企业包不再为它人的面板注入样式。
 *
 * 时序：`apply()` 在面板装载（`mountCapabilityCenter()`）之前跑，而卡片只在用户打开
 * 面板后才渲染 ⇒ 样式一定先于任何一张卡进入文档。与企业的品牌样式表**相互独立**：
 * 两者没有同选择器冲突（品牌表改的是 `[class$="_footerActions"]` / hero 文案，
 * 本表只碰 `.pico-skill-card`）。
 *
 * @module @picoaide/dsh-capability-center/client/skill-card-style
 */

/** 技能卡样式表（卡片是内联样式，悬停抬升 + 焦点环只能靠 CSS 类）。 */
const SKILL_CARD_CSS = `
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
 * 注入技能卡样式表（每次插件启动一次）。
 * @returns 卸载函数（移除样式表元素）。
 */
export function installSkillCardStyle(): () => void {
  const style = document.createElement('style')
  style.textContent = SKILL_CARD_CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
