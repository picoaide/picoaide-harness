import { describe, expect, it } from 'vitest'
import {
  BRAND_NAME_ROW_STYLE,
  BRAND_NAME_TEXT_STYLE,
  resolveClientShortName,
} from '../src/client/Channel.tsx'

/**
 * 侧边栏品牌名（`sidebar.brand.name` 槽）的**取值与折行契约**。
 *
 * 现场（2026-09-11）：白标上线后左上角变成两行 —— 大号品牌字折行，侧边栏头部
 * 从 24px 撑到 48px。两个原因叠在一起：
 *  1. 显示的是**显示名**（"PicoAide Harness"）而不是短名（"PicoAide"）：
 *     `client.short_name` 是**随包品牌独有**的字段，服务端从不下发，一旦没人把
 *     随包品牌叠上去它就整条丢失。重构前的实现是硬编码
 *     `name === 'PicoAide Harness' ? 'PicoAide' : name`，重构后改靠 short_name —— 于是
 *     "服务端可达"这条最常见的路径丢了短名。
 *  2. 名字再长也**不截断**：上游槽位是 18px/24px 的定高行，折行会把行撑高。
 *
 * 这里钉住两条不变量：短名优先、永远单行。渲染实例由
 * `tests/auth-gate-channel-endpoint.spec.ts` 从"端点必须把短名叠回来"这一侧覆盖。
 */

describe('resolveClientShortName', () => {
  it('prefers the channel short name over the display name', () => {
    expect(resolveClientShortName({
      client: { display_name: 'PicoAide Harness', short_name: 'PicoAide', tagline: '' },
    })).toBe('PicoAide')
  })

  it('keeps a brand channel short name as-is', () => {
    expect(resolveClientShortName({
      client: { display_name: 'Acme 企业智能体平台', short_name: 'Acme', tagline: '' },
    })).toBe('Acme')
  })

  it('falls back to the display name when the channel has no short name', () => {
    // 渠道只配了显示名:宁可显示长名字(界面会截断),也不显示厂商短名。
    expect(resolveClientShortName({ client: { display_name: 'Zephyr AI', tagline: '' } }))
      .toBe('Zephyr AI')
  })

  it('falls back to the built-in official short name with no channel content', () => {
    expect(resolveClientShortName(null)).toBe('PicoAide')
    expect(resolveClientShortName({})).toBe('PicoAide')
  })

  it('treats a whitespace-only short name as absent', () => {
    expect(resolveClientShortName({ client: { display_name: 'Zephyr AI', short_name: '   ', tagline: '' } }))
      .toBe('Zephyr AI')
  })
})

describe('sidebar brand name layout', () => {
  it('never wraps the name', () => {
    // 折行 = 上游 24px 定高行被撑到 48px(截图实测),必须截断。
    expect(BRAND_NAME_TEXT_STYLE.whiteSpace).toBe('nowrap')
    expect(BRAND_NAME_TEXT_STYLE.overflow).toBe('hidden')
    expect(BRAND_NAME_TEXT_STYLE.textOverflow).toBe('ellipsis')
  })

  it('lets the row shrink so the ellipsis can kick in', () => {
    // flex 项默认 min-width:auto 不肯收缩 —— 少了它,内层 ellipsis 永远不会生效。
    expect(BRAND_NAME_ROW_STYLE.minWidth).toBe(0)
    expect(BRAND_NAME_ROW_STYLE.display).toBe('inline-flex')
  })
})
