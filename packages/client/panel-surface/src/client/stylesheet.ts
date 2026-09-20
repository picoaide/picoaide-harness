/**
 * 面板表面的样式表（每个面板各注入一份，id 嵌在选择器里）。
 *
 * ## 两条硬规则（都是踩过的坑）
 *
 * 1. **容器默认隐藏必须写在样式表里，不能写行内 `style="display:none"`**：
 *    行内样式的优先级高于任何非 `!important` 的样式表规则，写了行内就再也显示不出来
 *    （定时任务最早的真实 bug）。
 * 2. **会话区让位要逐个列出真实存在的中列容器**，且必须带 `!important` —— 上游中列
 *    自己带 `display:contents` 之类的行内样式，不加 `!important` 压不住。这里的选择器
 *    与 `CONVERSATION_COLUMN_SELECTOR` 是**成对的**，改一个必须改另一个。
 *
 * ## 颜色与几何的分工
 *
 * 样式表负责**颜色**（含 `:hover` / `:focus-visible` / `:active` 反馈，这些只能写在
 * 样式表里），内联样式负责**几何**（尺寸/间距/圆角）。反过来做就会被行内样式压死：
 * 内联 `background: transparent` 会让 `:hover` 的背景永远不生效。
 *
 * @module @picoaide/dsh-panel-surface/client/stylesheet
 */

import { CONVERSATION_COLUMN_SELECTOR, PANEL_ACTIVE_ATTR, PANEL_SURFACE_ATTR } from '../index.ts'

/** 注入的样式表元素标记（重复注入时用它去重）。 */
export const PANEL_STYLE_ATTR = 'data-dsh-panel-style'

/**
 * 共享视觉语言（四个面板同一套）。
 *
 * 只放**颜色与交互反馈**：几何留给内联样式，颜色留在这里 —— `:hover`
 * 这类状态没有内联表达方式，一旦颜色写进行内联就再也做不出悬停反馈。
 */
/** 会话区让位规则：每个真实存在的中列容器各一条（成对选择器见 {@link CONVERSATION_COLUMN_SELECTOR}）。 */
const YIELD_SELECTORS = CONVERSATION_COLUMN_SELECTOR
  .split(',')
  .map(part => part.trim())
  .filter(part => part !== '')
  .map(part => `html[${PANEL_ACTIVE_ATTR}] ${part} > :not([${PANEL_SURFACE_ATTR}])`)
  .join(',\n')

const SHARED_CSS = `
/* ---- 面板表面容器与激活态 ---- */
[${PANEL_SURFACE_ATTR}] { display: none; height: 100%; width: 100%; min-width: 0; }
${YIELD_SELECTORS} { display: none !important; }

/* ---- 滚动条（默认的粗灰条在整页面板里很扎眼） ---- */
.pico-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l3) transparent; }
.pico-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.pico-scroll::-webkit-scrollbar-track { background: transparent; }
.pico-scroll::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l3); border-radius: 999px;
  border: 3px solid transparent; background-clip: content-box;
}
.pico-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-tertiary); background-clip: content-box; }

/* ---- 按钮：颜色在这里，几何在内联样式 ---- */
.pico-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; font-family: inherit; white-space: nowrap; border: 1px solid transparent;
  background: transparent; color: var(--dsw-alias-label-primary);
  transition: background-color .14s ease, border-color .14s ease, color .14s ease,
    box-shadow .14s ease, opacity .14s ease, transform .1s ease;
}
.pico-btn:disabled { opacity: .45; cursor: default; }
.pico-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.pico-btn:active:not(:disabled) { transform: translateY(1px); }
.pico-btn--primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent;
}
.pico-btn--primary:hover:not(:disabled) {
  box-shadow: 0 4px 14px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);
  filter: brightness(1.06);
}
.pico-btn--secondary { border-color: var(--dsw-alias-border-l2); }
.pico-btn--secondary:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent));
  border-color: var(--dsw-alias-border-l3);
}
.pico-btn--ghost { color: var(--dsw-alias-label-secondary); }
.pico-btn--ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent));
  color: var(--dsw-alias-label-primary);
}
.pico-btn--danger { color: var(--dsw-alias-state-error-primary); }
.pico-btn--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, currentColor 10%, transparent));
}

/* ---- 卡片 ---- */
.pico-card {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1, transparent);
  transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease, background-color .16s ease;
}
.pico-card:hover { border-color: var(--dsw-alias-border-l3); box-shadow: 0 6px 22px rgb(0 0 0 / 7%); }
.pico-card[data-interactive="true"]:hover { transform: translateY(-1px); }
.pico-card[data-interactive="true"]:active { transform: translateY(0); }
.pico-card[data-muted="true"] { opacity: .72; }
.pico-card[data-muted="true"]:hover { opacity: 1; }

/* ---- 分段切换（整页面板里代替"标签页"的那一条） ---- */
.pico-seg {
  display: inline-flex; align-items: center; gap: 2px; padding: 3px;
  border-radius: 11px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-3, color-mix(in srgb, currentColor 6%, transparent));
}
.pico-seg > button {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  border-radius: 8px; padding: 5px 12px; margin: 0; font: inherit; font-size: 13px;
  line-height: 18px; cursor: pointer; white-space: nowrap;
  transition: background-color .14s ease, color .14s ease, box-shadow .14s ease;
}
.pico-seg > button:hover { color: var(--dsw-alias-label-primary); }
.pico-seg > button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pico-seg > button[data-active="true"] {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 3px rgb(0 0 0 / 12%);
}

/* ---- 可点的筛选片（与徽章同形，但可交互；颜色会随 data-active 翻转） ---- */
.pico-chipbtn {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); font-family: inherit; cursor: pointer;
  transition: border-color .14s ease, color .14s ease, background-color .14s ease;
}
.pico-chipbtn:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.pico-chipbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.pico-chipbtn[data-active="true"] {
  border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}

/* ---- 徽章（底色跟着 color 走，调用方只给文字色） ---- */
.pico-chip {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
  border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 18px;
  white-space: nowrap; border: 1px solid transparent;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.pico-chip[data-plain="true"] { background: transparent; border-color: var(--dsw-alias-border-l2); }

/* ---- 图标块 / 头像块 ---- */
.pico-tile { display: flex; align-items: center; justify-content: center; flex: none; font-weight: 600; line-height: 1; }

/* ---- 勾选式筛选片（真实 checkbox 包在 chip 外观里：语义不变、键盘可达） ---- */
.pico-checkchip {
  display: inline-flex; align-items: center; gap: 7px; flex: none; height: 30px;
  padding: 0 11px; border-radius: 9px; box-sizing: border-box; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
  font-size: 12.5px; line-height: 18px;
  transition: border-color .14s ease, color .14s ease, background-color .14s ease;
}
.pico-checkchip:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.pico-checkchip:has(input:checked) {
  border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}
.pico-checkchip > input {
  margin: 0; flex: none; width: 13px; height: 13px; cursor: pointer;
  accent-color: var(--dsw-alias-brand-primary);
}
.pico-checkchip > input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.pico-checkchip:has(input:disabled) { opacity: .5; cursor: default; }

/* ---- 开关（把原生 checkbox 画成开关，保持真实 input 语义） ---- */
.pico-switch { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.pico-switch > input {
  appearance: none; -webkit-appearance: none; margin: 0; flex: none;
  width: 32px; height: 18px; border-radius: 999px; position: relative; cursor: pointer;
  background: var(--dsw-alias-border-l3);
  transition: background-color .16s ease;
}
.pico-switch > input::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 28%);
  transition: transform .16s ease;
}
.pico-switch > input:checked { background: var(--dsw-alias-state-success-primary); }
.pico-switch > input:checked::after { transform: translateX(14px); }
.pico-switch > input:disabled { opacity: .45; cursor: default; }
.pico-switch > input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

/* ---- 文本截断 ---- */
.pico-clamp-1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pico-clamp-2, .pico-clamp-3 {
  display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;
}
.pico-clamp-2 { -webkit-line-clamp: 2; }
.pico-clamp-3 { -webkit-line-clamp: 3; }

/* ---- 进场面板的轻微上浮（尊重"减少动态效果"） ---- */
@keyframes pico-surface-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
html[${PANEL_ACTIVE_ATTR}] [${PANEL_SURFACE_ATTR}] { animation: pico-surface-in .18s ease-out; }
@media (prefers-reduced-motion: reduce) {
  html[${PANEL_ACTIVE_ATTR}] [${PANEL_SURFACE_ATTR}] { animation: none; }
  .pico-btn, .pico-card, .pico-seg > button, .pico-switch > input { transition: none; }
}
`

/**
 * 某个面板专属的样式表文本。
 * @param id - 面板 id（嵌进激活选择器）。
 * @returns 可直接赋给 `<style>` 的 CSS 文本。
 */
export function panelStylesheet(id: string): string {
  const escaped = id.replace(/["\\]/g, '')
  return [
    `html[${PANEL_ACTIVE_ATTR}="${escaped}"] [${PANEL_SURFACE_ATTR}="${escaped}"] { display: block; }`,
    SHARED_CSS,
  ].join('\n')
}
