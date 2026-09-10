import { describe, expect, it } from 'vitest'
import { apply, type BrandConfig, type Config } from '../src/auth-gate.ts'

/**
 * 登录页品牌区（白标最容易漏的一处）。
 *
 * 登录页是**认证之前**的唯一 HTML 面：那一刻服务端地址可能正是用户要输入的
 * 东西，问不到服务端要品牌，所以文案只能来自随包配置（profile 组装期注入）。
 * 此前登录页的标题与品牌兜底是硬编码的厂商名 —— 渠道客户在登录第一屏就看到了
 * 厂商品牌，这条测试就是钉住它不再回来。
 */

/** 页面脚本里 `var BRAND = …` 的那一段（JS 字面量，不是 HTML 文本）。 */
function brandLiteral(html: string): string {
  const m = html.match(/var BRAND = (\{[\s\S]*?\})\n/)
  expect(m, 'login page must inline the brand literal').not.toBeNull()
  return m![1]!
}

/** 内存版 Cordis 上下文：只实现 auth-gate 用到的那三个面。 */
function serveLoginPage(config: Config, loggedIn = false): string {
  let index: ((html: string) => string) | undefined
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => loggedIn,
      getSession: () => null,
    },
    webServer: {
      tapIndex: (cb: (html: string) => string) => { index = cb; return () => {} },
      register: () => () => {},
    },
  }
  apply(ctx as never, config)
  expect(index, 'auth-gate must tap the index route').toBeDefined()
  return index!('<!DOCTYPE html><html><head></head><body></body></html>')
}

const ACME: BrandConfig = {
  title: 'Acme 门户',
  login: { displayName: 'Acme AI', shortName: 'Acme', tagline: '企业内部 AI 平台', welcome: '欢迎使用' },
  client: { displayName: 'Acme AI', shortName: 'Acme', tagline: '' },
}

describe('auth-gate login page brand', () => {
  it('serves the packaged channel brand instead of a vendor name', () => {
    const html = serveLoginPage({ brand: ACME })
    expect(html).toContain('<title>Acme 门户 登录</title>')
    expect(JSON.parse(brandLiteral(html))).toMatchObject({
      title: 'Acme 门户',
      login: { displayName: 'Acme AI', tagline: '企业内部 AI 平台', welcome: '欢迎使用' },
    })
    // 整页不得残留厂商品牌 —— 这是白标的验收口径。
    expect(html).not.toContain('PicoAide')
  })

  it('keeps the official brand when no channel brand is injected', () => {
    const html = serveLoginPage({})
    expect(html).toContain('<title>PicoAide 登录</title>')
    expect(JSON.parse(brandLiteral(html))).toEqual({
      title: 'PicoAide',
      login: { displayName: 'PicoAide', shortName: 'PicoAide', tagline: 'Enterprise AI Gateway', welcome: '' },
    })
  })

  it('uses a neutral name when the channel brand is empty (never the vendor name)', () => {
    // 注入链断了（渠道包存在但品牌为空）：中性占位，绝不冒充官方。
    const html = serveLoginPage({ brand: {} })
    expect(JSON.parse(brandLiteral(html)).login.displayName).toBe('Harness')
    expect(html).not.toContain('PicoAide')
  })

  it('cannot be used to break out of the inline script', () => {
    // 渠道名进的是 JS 字面量位：一个 </script> 就能改写认证前的登录页。
    const html = serveLoginPage({
      brand: { login: { displayName: '</script><script>alert(1)</script>' } },
    })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script')
    // 字面量仍可求值，且解析回来的就是原字符串（转义没改变语义）。
    expect(JSON.parse(brandLiteral(html).replace(/\\u003c/gu, '<')).login.displayName)
      .toBe('</script><script>alert(1)</script>')
  })

  it('escapes the brand name in the title element too', () => {
    // <title> 是 HTML 文本位，与脚本位是两种转义 —— 不共用同一个字符串。
    const html = serveLoginPage({ brand: { login: { displayName: '<b>&</b>' } } })
    expect(html).toContain('<title>&lt;b&gt;&amp;&lt;/b&gt; 登录</title>')
  })

  it('renders the brand fallback block in the page script', () => {
    // renderChannel(null) 走的是 BRAND 而不是硬编码名。
    const html = serveLoginPage({ brand: ACME })
    expect(html).toContain("esc(BRAND.login.displayName)")
    expect(html).not.toContain("'PicoAide'")
  })
})
