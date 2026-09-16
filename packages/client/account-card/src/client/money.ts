/**
 * 金额格式化（界面语言决定写法）。
 *
 * 独立成模块的原因：`AccountCard.tsx` 会 import React 组件库，测试环境解析不了
 * 那套 client 依赖；而"金额跟随界面语言"这条回归（2026-09-15 审计 BUG-07）需要
 * 一个能直接在 node 里断言的入口。
 */
import { activeLocaleTag } from './locales.ts'

/** Format a money amount using the active UI locale (currency is CNY). */
export function formatMoney(value: number): string {
  try {
    // 2026-09-15 审计 BUG-07：以前传 undefined = 跟随系统 locale，界面语言与系统
    // 语言不一致时会显示成另一种货币写法（系统 en + 界面 zh ⇒ CN¥）。
    return new Intl.NumberFormat(activeLocaleTag(), {
      style: 'currency',
      currency: 'CNY',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `¥${value.toFixed(2)}`
  }
}
