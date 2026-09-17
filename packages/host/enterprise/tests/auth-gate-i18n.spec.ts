/**
 * 认证前页面（登录 / 强制改密 / 会话恢复）的双语文案回归（2026-09-16 i18n）。
 *
 * 缺陷背景：这三页此前是四个**模块级 HTML 常量**，`lang="zh-CN"` 与全部文案都
 * 写死在模板里，且没有任何语言输入 —— 英文用户看到的第一屏（也是唯一一屏）
 * 100% 是中文。修法是把页面变成 `renderXxxPage(locale)` 的函数，语言由**每次
 * 请求/每次渲染**解析（`desktopRuntime.locale` → `Accept-Language` → zh）。
 *
 * 本文件钉住三件事：
 *   1. 两种语言各自的文案与 `<html lang>` 正确，且对方语言的标记一个都不出现；
 *   2. 语言是**按请求/按渲染**取的 —— 同一个已 apply 的实例，两次请求可以给出
 *      不同语言；实例化之后改 `desktopRuntime.locale` 也能立刻生效。
 *      （把语言捕获在模块常量或 apply 闭包里，这两条都会红 —— 那正是这次要防
 *      的 bug 类型，见 `packages/host/connectors/src/client/status-label.ts`。）
 *   3. 中文文案与历史逐字一致（翻译是**新增**的一侧，不许顺手动中文）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  apply,
  renderChangePasswordPage,
  renderLoginPage,
  renderRestoringPage,
  type Config,
} from '../src/auth-gate.ts'

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u

/** 英文页里**不许出现**的中文标记（覆盖登录页 29 条用户可见文案的要点）。 */
const ZH_MARKERS = [
  '连接服务端',
  '输入服务端地址以确认登录方式',
  '>下一步<',
  // 短词必须带上下文:脚本里的中文注释也含「账号密码」（注释不渲染，不算文案）。
  'placeholder="账号"',
  'placeholder="密码"',
  '使用浏览器登录',
  '请在弹出的浏览器窗口中完成授权',
  '请填写服务端地址',
  '连接中…',
  '无法连接服务端，请检查地址与网络',
  '本地账号',
  '该方式未配置',
  'LDAP 账号',
  '浏览器授权未完成或已取消，请重试',
  '请先填写服务端地址',
  '无法登记浏览器登录，请重试',
  '登录中…',
  '登录失败 (',
  '审计账号不可登录客户端，请使用管理后台',
  '打开管理后台 ↗',
  '网络错误，请检查服务端地址后重试',
  '账号或密码错误',
  '登录尝试过于频繁，请稍后再试',
  '账号已被禁用，请联系管理员',
] as const

/** 中文页里**不许出现**的英文标记。 */
const EN_MARKERS = [
  'Connect to the server',
  'Enter the server address to load the available sign-in methods',
  '>Next<',
  'Sign in with browser',
  'Complete the authorization in the browser window',
  'Cannot reach the server',
  'Local account',
  'This method is not configured',
  'LDAP username',
  'Incorrect username or password',
  'Too many sign-in attempts',
  'This account has been disabled',
] as const

/**
 * 按标签名剔除成对块（`<script>…</script>` / `<style>…</style>`），大小写不敏感。
 *
 * 2026-09-17：从正则 `.replace()` 改成**逐段扫描**。原因有二：
 * 1) CodeQL `js/incomplete-multi-character-sanitization` 会（正确地）指出
 *    "用一条正则删 `<script>…</script>` 可被嵌套/畸形标签绕过" —— 这个助手
 *    本身不是安全边界，但它没必要长成被拦的形态；
 * 2) 扫描版对"未闭合块"的语义是显式的（其后全部视为块内），比非贪婪正则好读。
 * @param html - 完整页面 HTML。
 * @param tag - 标签名（不含尖括号，如 `script`）。
 * @returns 剔除该块后的字符串。
 */
function stripTagBlock(html: string, tag: string): string {
  const open = `<${tag}`
  const close = `</${tag}>`
  let out = ''
  let rest = html
  for (;;) {
    const start = rest.toLowerCase().indexOf(open)
    if (start < 0) return out + rest
    out += rest.slice(0, start)
    const end = rest.toLowerCase().indexOf(close, start)
    if (end < 0) return out // 未闭合：其后全部视为块内
    rest = rest.slice(end + close.length)
  }
}

/** 剔除 HTML 注释（同样是扫描，不用正则替换）。 */
function stripHtmlComments(html: string): string {
  let out = ''
  let rest = html
  for (;;) {
    const start = rest.indexOf('<!--')
    if (start < 0) return out + rest
    out += rest.slice(0, start)
    const end = rest.indexOf('-->', start)
    if (end < 0) return out
    rest = rest.slice(end + '-->'.length)
  }
}

/**
 * 去掉**不可见**内容后的正文（`<script>` / `<style>` / HTML 注释）。
 * 登录页的样式与脚本里留着中文注释（不渲染），全页 CJK 扫描会误报。
 * @param html - 完整页面 HTML。
 * @returns 只含可见标记文本的字符串。
 */
function visibleMarkup(html: string): string {
  return stripHtmlComments(stripTagBlock(stripTagBlock(html, 'script'), 'style'))
}

/** 断言一页英文文档里没有任何中文可见文案。 */
function expectNoVisibleCjk(html: string): void {
  const visible = visibleMarkup(html)
  const hit = CJK.exec(visible)
  expect(hit, `英文页面出现中文可见文案: ${JSON.stringify(visible.slice(Math.max(0, (hit?.index ?? 0) - 40), (hit?.index ?? 0) + 40))}`).toBeNull()
}

describe('认证前页面的双语文案', () => {
  it('登录页：zh 是中文文案 + lang="zh-CN"，且不含英文标记', () => {
    const html = renderLoginPage('zh')
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<title>__BRAND_NAME__ 登录</title>')
    expect(html).toContain('连接服务端')
    expect(html).toContain('下一步')
    expect(html).toContain('请在弹出的浏览器窗口中完成授权')
    expect(html).toContain('登录尝试过于频繁，请稍后再试')
    for (const marker of EN_MARKERS) expect(html, `zh 页不应出现英文文案 ${marker}`).not.toContain(marker)
  })

  it('登录页：en 是英文文案 + lang="en"，且中文标记一个都不出现', () => {
    const html = renderLoginPage('en')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>__BRAND_NAME__ Sign in</title>')
    expect(html).toContain('Connect to the server')
    expect(html).toContain('Sign in')
    expect(html).toContain('Username')
    expect(html).toContain('Incorrect username or password')
    expect(html).toContain('Sign-in failed')
    for (const marker of ZH_MARKERS) expect(html, `en 页不应出现中文文案 ${marker}`).not.toContain(marker)
    expectNoVisibleCjk(html)
  })

  it('改密页：两种语言的文案与 lang 都正确', () => {
    const zh = renderChangePasswordPage('zh')
    expect(zh).toContain('<html lang="zh-CN">')
    expect(zh).toContain('<title>修改密码</title>')
    expect(zh).toContain('你的密码已被管理员重置')
    expect(zh).toContain('当前密码(管理员设置的临时密码)')
    expect(zh).toContain('两次输入的新密码不一致')

    const en = renderChangePasswordPage('en')
    expect(en).toContain('<html lang="en">')
    expect(en).toContain('<title>Change password</title>')
    expect(en).toContain('Your password was reset by an administrator')
    expect(en).toContain('Current password (temporary password from your administrator)')
    expect(en).toContain('The two new passwords do not match')
    expect(en).not.toContain('修改密码')
    expect(en).not.toContain('两次输入的新密码不一致')
    expectNoVisibleCjk(en)
  })

  it('会话恢复页：两种语言的文案与 lang 都正确', () => {
    const zh = renderRestoringPage('zh')
    expect(zh).toContain('<html lang="zh-CN">')
    expect(zh).toContain('正在恢复登录状态…')
    expect(zh).toContain('__BRAND_NAME__')

    const en = renderRestoringPage('en')
    expect(en).toContain('<html lang="en">')
    expect(en).toContain('Restoring your session…')
    expect(en).not.toContain('正在恢复登录状态')
    expectNoVisibleCjk(en)
  })

  it('中文文案与历史逐字一致（翻译只新增 en 一侧）', () => {
    // 逐字取自改造前的模板（2026-09-16 前的 auth-gate.ts）。
    const login = renderLoginPage('zh')
    expect(login).toContain('无法连接服务端，请检查地址与网络')
    expect(login).toContain('请在弹出的浏览器窗口中完成授权，等待授权完成后此处会自动继续…')
    expect(login).toContain("err2.innerHTML = T.auditorDenied + '<br><a href=\"'")
    const change = renderChangePasswordPage('zh')
    expect(change).toContain('新密码(至少 10 位)')
    expect(change).toContain('修改失败')
    expect(renderRestoringPage('zh')).toContain('正在恢复登录状态…')
  })
})

// ---------------------------------------------------------------------------
// 按请求 / 按渲染解析语言（不许在模块级或 apply 级捕获）
// ---------------------------------------------------------------------------

interface Harness {
  /** index 变换（tapIndex）：签名只有 html，语言只能取 desktopRuntime。 */
  index: (html: string) => string
  /** exact 路由处理器。 */
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>
  /** 改 `desktopRuntime.locale`（用户的应用内选择，权威值）。 */
  setRuntimeLocale: (locale: string | undefined) => void
}

/** 启动一个最小的 auth-gate 宿主（未登录、已恢复）。 */
function bootHarness(config: Config = {}): Harness {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  let index: ((html: string) => string) | undefined
  const runtime: { locale?: unknown } = { locale: 'zh' }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'desktopRuntime' ? runtime : undefined),
    picoSession: { isRestored: () => true, isLoggedIn: () => false, getSession: () => null },
    webServer: {
      tapIndex: (cb: (html: string) => string) => { index = cb; return () => {} },
      register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  apply(ctx as never, config)
  expect(index, 'auth-gate must tap the index route').toBeDefined()
  return {
    index: index!,
    routes,
    setRuntimeLocale: (locale) => {
      if (locale === undefined) delete runtime.locale
      else runtime.locale = locale
    },
  }
}

/** 调用一个已注册的 exact 路由，返回响应体。 */
function call(harness: Harness, path: string, headers: Record<string, string> = {}): string {
  const handler = harness.routes.get(path)
  expect(handler, `route ${path} must be registered`).toBeDefined()
  let body = ''
  const req = { method: 'GET', headers, url: path } as unknown as IncomingMessage
  const res = {
    writeHead: () => res,
    end: (chunk?: unknown) => { body = typeof chunk === 'string' ? chunk : String(chunk ?? '') },
  } as unknown as ServerResponse
  handler!(req, res)
  return body
}

describe('语言按请求 / 按渲染解析（不许冻结）', () => {
  it('同一个实例：两次 /login 请求按 Accept-Language 给出不同语言', () => {
    const harness = bootHarness({ defaultServer: 'https://harness.example' })
    // 没有运行时选择时，请求头说话（q 值排序也认）。
    harness.setRuntimeLocale(undefined)
    const en = call(harness, '/login', { 'accept-language': 'en-US,en;q=0.9,zh;q=0.8' })
    const zh = call(harness, '/login', { 'accept-language': 'zh-CN,zh;q=0.9' })
    expect(en).toContain('<html lang="en">')
    expect(en).toContain('Connect to the server')
    expect(zh).toContain('<html lang="zh-CN">')
    expect(zh).toContain('连接服务端')
    // 反过来再请求一次，仍是当次请求的语言（不是"第一次请求定终身"）。
    expect(call(harness, '/login', { 'accept-language': 'en' })).toContain('Connect to the server')
    expect(call(harness, '/login', { 'accept-language': 'zh' })).toContain('连接服务端')
  })

  it('运行时的应用内选择压过请求头（权威值优先）', () => {
    const harness = bootHarness({})
    harness.setRuntimeLocale('zh')
    expect(call(harness, '/login', { 'accept-language': 'en-US,en;q=0.9' })).toContain('连接服务端')
    harness.setRuntimeLocale('en')
    expect(call(harness, '/login', { 'accept-language': 'zh-CN,zh;q=0.9' })).toContain('Connect to the server')
  })

  it('索引渲染（tapIndex）按 desktopRuntime 取语言，实例化后改语言立即生效', () => {
    const harness = bootHarness({ defaultServer: 'https://harness.example' })
    harness.setRuntimeLocale('zh')
    const first = harness.index('<!DOCTYPE html><html><head></head><body></body></html>')
    expect(first).toContain('连接服务端')
    expect(first).toContain('<html lang="zh-CN">')
    // 用户在设置里切成英文：下一次索引渲染必须换语言（apply 级缓存会红）。
    harness.setRuntimeLocale('en')
    const second = harness.index('<!DOCTYPE html><html><head></head><body></body></html>')
    expect(second).toContain('Connect to the server')
    expect(second).toContain('<html lang="en">')
    expect(second).not.toContain('连接服务端')
  })

  it('/change-password 也按请求取语言（强制改密页是登录后第一屏）', () => {
    const harness = bootHarness({})
    harness.setRuntimeLocale(undefined)
    expect(call(harness, '/change-password', { 'accept-language': 'en' })).toContain('Change password')
    expect(call(harness, '/change-password', { 'accept-language': 'zh' })).toContain('修改密码')
  })

  it('未恢复会话时的过渡页也按语言渲染', () => {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
    let index: ((html: string) => string) | undefined
    const runtime: { locale?: unknown } = { locale: 'en' }
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      get: (name: string) => (name === 'desktopRuntime' ? runtime : undefined),
      picoSession: { isRestored: () => false, isLoggedIn: () => false, getSession: () => null },
      webServer: {
        tapIndex: (cb: (html: string) => string) => { index = cb; return () => {} },
        register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => {
          routes.set(route.path, route.handler)
          return () => {}
        },
      },
    }
    apply(ctx as never, {})
    const html = index!('<!DOCTYPE html><html><head></head><body></body></html>')
    expect(html).toContain('Restoring your session…')
    expect(html).toContain('<html lang="en">')
    expect(html).not.toContain('正在恢复登录状态')
  })

  it('“返回修改服务端地址”按钮随语言翻译；内置了地址时两种语言都不渲染', () => {
    const free = bootHarness({})
    free.setRuntimeLocale(undefined)
    expect(call(free, '/login', { 'accept-language': 'zh' })).toContain('← 修改服务端地址')
    expect(call(free, '/login', { 'accept-language': 'en' })).toContain('← Change server address')

    const fixed = bootHarness({ defaultServer: 'https://harness.example' })
    fixed.setRuntimeLocale(undefined)
    const en = call(fixed, '/login', { 'accept-language': 'en' })
    expect(en).not.toContain('id="back-btn"')
    expect(en).not.toContain('Change server address')
  })

  it('品牌名进 <title>：文案换语言，品牌名（渠道值）原样保留', () => {
    const harness = bootHarness({
      brand: {
        title: 'Acme 门户',
        login: { displayName: 'Acme AI', shortName: 'Acme', tagline: '企业内部 AI 平台', welcome: '' },
        client: { displayName: 'Acme AI', shortName: 'Acme', tagline: '' },
      },
    })
    harness.setRuntimeLocale(undefined)
    expect(call(harness, '/login', { 'accept-language': 'zh' })).toContain('<title>Acme 门户 登录</title>')
    expect(call(harness, '/login', { 'accept-language': 'en' })).toContain('<title>Acme 门户 Sign in</title>')
  })
})
