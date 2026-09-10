// Channel → CSS 变量映射(纯函数, 供客户端 index.ts applyVars 与单测共用)。
//
// 坑(2026-09 实测): BRAND_CSS 用 `content: var(--pico-hero-headline, "…")`
// 渲染 hero 标题, 而 CSS content 只接受字符串字面量 —— 变量值必须以
// `JSON.stringify` 写入(带引号的 token 流), 若直接写裸词流(如
// `PicoAide Harness`)整条声明非法, content 计算值为 none, hero 标题与
// 徽章文字事实上永远不可见。
import type { ChannelConfig } from '../channel-sync.ts'

/** hero headline / tagline 默认值(渠道未配置该项时)。 */
export const DEFAULT_HERO_HEADLINE = 'PicoAide Harness'
export const DEFAULT_HERO_TAGLINE = '企业版'

/**
 * 由渠道配置推导 CSS 变量覆盖: 值已按 setProperty 语义序列化
 * (字符串含引号)。只含需要覆盖的键。渠道内容总是生效(无 enabled 开关:
 * 有值即用), 渠道色(accent)已下线(2026-09 决策)。
 * @param channel - 服务端渠道配置(null=未同步, 等同未配置)。
 * @returns 变量键 → 值。
 */
export function buildChannelCSSVars(channel: ChannelConfig | null): Record<string, string> {
  const name = channel?.client?.display_name ? channel.client.display_name : ''
  const tagline = channel?.client?.tagline ? channel.client.tagline : ''
  return {
    '--pico-hero-headline': JSON.stringify(name || DEFAULT_HERO_HEADLINE),
    '--pico-hero-tagline': JSON.stringify(tagline || DEFAULT_HERO_TAGLINE),
  }
}
