import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_SEAT_ATTR, BRAND_SEAT_OWNER } from '../src/client/Channel.tsx'

/**
 * 品牌槽位**归属标记**的契约（2026-09-12）。
 *
 * 背景：桌面 E2E 的 `e2e:sidebar` 需要判断"单占位品牌槽是谁占的"。原先的断言写成
 * "槽位里的内联 svg 必须含 1.25× 缩放" —— 那只在**未配渠道 logo** 的构建成立；
 * 渠道包提供 logo 时槽位渲染 `<img>`，同一提交在官方构建绿、渠道构建红，直接卡住
 * 发布流水（实测两次）。渠道会越来越多，逐个枚举合法图形不可维护，所以断言改为
 * **归属**：槽位里必须有带本标记的占用者。
 *
 * 这个单测守住那条链路的锚点：标记一旦被改名/删除，E2E 的归属断言就会失效
 * （变成永远失败或永远通过），而桌面 E2E 不在 `yarn check` 里、跑一次要几分钟。
 */
const source = readFileSync(new URL('../src/client/Channel.tsx', import.meta.url), 'utf8')
const probe = readFileSync(
  new URL('../../desktop/scripts/e2e-right-sidebar.mjs', import.meta.url), 'utf8')

describe('品牌槽位归属标记', () => {
  it('标记名与取值稳定（E2E 与产品代码同一份字符串）', () => {
    expect(BRAND_SEAT_ATTR).toBe('data-brand-mark')
    expect(BRAND_SEAT_OWNER).toBe('app')
  })

  it('E2E 断言按同一标记判定归属，而不是嗅探图形', () => {
    expect(probe).toContain(`[data-brand-mark="app"]`)
    // 反面:不得再回到"必须含 1.25× 缩放"的官方几何判定(渠道 logo 走 img 路径)。
    expect(probe).not.toContain('scale(1.25)')
  })

  it('BraceMark 的两条渲染路径都带标记（内联几何 + 渠道 logo）', () => {
    // 两条分支各一次 spread `...seat`，另有定义处一次 —— 共三处出现。
    const spread = source.split('...seat').length - 1
    expect(spread).toBe(2)
    expect(source).toContain('const seat = { [BRAND_SEAT_ATTR]: BRAND_SEAT_OWNER }')
  })

  it('三个 single 品牌槽的占用者都带标记（mark / name / hero mark）', () => {
    // 2026-09-12 打包版 e2e 实测：名字槽的占用者（BrandName）当时**没有**标记，
    // 归属断言把它判成了 FOREIGN（与真实渲染无关，纯标记缺失）。这里按组件块检查，
    // 避免只覆盖 mark 槽；同时钉住 e2e 的三槽清单，少一个槽就是少一层守卫。
    const nameStart = source.indexOf('export function BrandName')
    const badgeStart = source.indexOf('export function BrandBadge')
    expect(nameStart).toBeGreaterThan(-1)
    expect(badgeStart).toBeGreaterThan(nameStart)
    expect(source.slice(nameStart, badgeStart)).toContain('[BRAND_SEAT_ATTR]: BRAND_SEAT_OWNER')
    expect(probe).toContain('sidebar.brand.mark')
    expect(probe).toContain('sidebar.brand.name')
    expect(probe).toContain('conversation.hero.brand.mark')
  })
})
