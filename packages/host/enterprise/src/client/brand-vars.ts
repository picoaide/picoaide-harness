// Brand → CSS 变量映射(纯函数, 供客户端 index.ts applyVars 与单测共用)。
//
// 坑(2026-09 实测): BRAND_CSS 用 `content: var(--pico-hero-headline, "…")`
// 渲染 hero 标题, 而 CSS content 只接受字符串字面量 —— 变量值必须以
// `JSON.stringify` 写入(带引号的 token 流), 若直接写裸词流(如
// `PicoAide Harness`)整条声明非法, content 计算值为 none, hero 标题与
// 徽章文字事实上永远不可见。颜色变量(accent)不需要引号。
import type { BrandConfig } from '../brand-sync.ts'

/** hero headline / tagline 默认值(未配置或未启用品牌时)。 */
export const DEFAULT_HERO_HEADLINE = 'PicoAide Harness'
export const DEFAULT_HERO_TAGLINE = '企业版'

/**
 * 由品牌配置推导 CSS 变量覆盖: 值已按 setProperty 语义序列化
 * (字符串含引号, 颜色为裸字面量)。只含需要覆盖的键。
 * @param brand - 服务端品牌(null=未同步, 等同未配置)。
 * @returns 变量键 → 值; `--dsw-alias-brand-primary` 仅在启用且配置 accent 时出现。
 */
export function buildBrandCSSVars(brand: BrandConfig | null): Record<string, string> {
  const name = brand?.enabled && brand.client?.display_name ? brand.client.display_name : ''
  const tagline = brand?.enabled && brand.client?.tagline ? brand.client.tagline : ''
  const accent = brand?.enabled && brand.client?.accent ? brand.client.accent : ''
  const vars: Record<string, string> = {
    '--pico-hero-headline': JSON.stringify(name || DEFAULT_HERO_HEADLINE),
    '--pico-hero-tagline': JSON.stringify(tagline || DEFAULT_HERO_TAGLINE),
  }
  if (accent) vars['--dsw-alias-brand-primary'] = accent
  return vars
}
