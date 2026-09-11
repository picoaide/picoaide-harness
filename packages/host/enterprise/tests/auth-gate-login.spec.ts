import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply, type Config } from '../src/auth-gate.ts'
import { brandMarkSvg } from '../src/channel-geometry.ts'

// 回归测试(2026-09):LOGIN_HTML 是 TS 模板字符串,内联 <script> 里的正则
// `\/` 会被模板转义(cooked)成 `/`(输出 `//$` = 空正则+行注释)导致浏览器
// SyntaxError,登录页整个 JS 不执行(点「下一步」触发原生表单提交 → 页面刷新、
// 输入框被清空)。此测试从源码提取 LOGIN_HTML,**按模板字面量真实求值**后
// 再验证: 1) script 可作为 JS 解析(捕获所有 cooked 转义毁坏); 2) 不含
// 会退化成行注释的 `/\/` 转义序列(即禁止带反斜杠的正则出现在模板里)。

/** 从 auth-gate.ts 提取 LOGIN_HTML 的模板原始文本并求值(模拟浏览器收到的
 * HTML)。用 Function 构造真实模板字面量,而不是手工字符串替换——手工替换
 * 曾漏掉模板 cooked 转义(`\/` → `/`),让 `\/+$` 静默退化成 `//+$`。
 */
function renderedLoginHTML(): string {
  const src = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
  const m = src.match(/const LOGIN_HTML = `([\s\S]*?)`\n\nexport interface Config/)
  expect(m, 'LOGIN_HTML template must be findable').not.toBeNull()
  const raw = m![1]!
  // LOGIN_HTML 至今不含 ${...} / \` / \$ / \\ 序列;若未来出现,这里会抛错,
  // 提示按真实模板语义处理(与编译产物 tsdown 保持模板原样一致)。
  // 模板现在插值 ${brandMarkSvg('#FFFFFF')}(P2-39:几何单一来源),求值需注入。
  const fn = new Function('brandMarkSvg', `return \`${raw}\``) // eslint-disable-line no-new-func
  return fn(brandMarkSvg)
}

/** 从求值后的 HTML 提取首个内联 <script> 内容。 */
function loginScript(): string {
  const html = renderedLoginHTML()
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i)
  expect(scriptMatch, 'login page must contain an inline script').not.toBeNull()
  return scriptMatch![1]!
}

describe('auth-gate LOGIN_HTML inline script', () => {
  it('rendered login page script parses as valid JavaScript', () => {
    const script = loginScript()
    // 模板求值后的脚本必须是合法 JS(捕获 `/\/` → `//` 类转义破坏)。
    expect(() => { new Function(script) }).not.toThrow()
  })

  it('never starts a statement line with a left paren (ASI hazard)', () => {
    const script = loginScript()
    // 本脚本是无分号(ASI)风格:紧跟在一个调用语句之后的左圆括号不会触发自动
    // 分号插入,解析器会把上一行读成"调用那个函数的返回值"。2026-09-10 实测:
    // 一个行首为 `(async function autoConnect(){...})()` 的 IIFE 让 `#f2` 登录
    // 表单的提交处理**从未注册**,点「登录」只是原生提交并刷新回 Step1 ——
    // 客户端 E2E 从 13/13 掉到 5/13。它语法合法,所以 new Function 解析测试与
    // tsc 都抓不到,只能在这里静态拦住。
    // 只在与**上一行构成两个语句**时才危险:如果上一行本身以运算符结尾
    // (+, &&, =, 逗号 …),那个 '(' 只是同一个表达式的续行,合法且常见。
    const lines = script.split('\n').map(line => line.trim())
    const offenders = []
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith('(')) continue
      let previous = index - 1
      while (previous >= 0 && (lines[previous] === '' || lines[previous].startsWith('//'))) previous -= 1
      if (previous < 0) continue
      const tail = lines[previous].slice(-1)
      if ('+,-=*/%&|?:<>!('.includes(tail)) continue
      offenders.push({ line: lines[index], number: index + 1, after: lines[previous] })
    }
    expect(offenders, `行首左括号会让上一行被解析成函数调用: ${JSON.stringify(offenders)}`).toEqual([])
  })

  it('rendered login page keeps the server-URL slash stripping valid', () => {
    const script = loginScript()
    // trimServer 必须以纯字符串实现(无 `\/` 正则):若实现退化回正则转义,
    // 求值后会出现 `//` 起注释,上面的 parse 断言会先红;这里再明示用途。
    expect(script).toContain('function trimServer(s)')
    expect(script).not.toMatch(/replace\(\/\+/)
  })

  it('served defaultServer placeholder is inserted at runtime, not in the template', () => {
    // 模板里保留占位符,由 apply() 在开局替换(带斜杠的默认地址由 trimServer 兜底)。
    const html = renderedLoginHTML()
    expect(html).toContain('__DEFAULT_SERVER__')
  })

  it('reads channel content from the login-page channel proxy (brand config retired)', () => {
    const script = loginScript()
    // 数据来源是渠道配置(服务端 /api/client/v2/channel, 经本地 /api/pico/channel 代理)。
    expect(script).toContain("fetch('/api/pico/channel?server='")
    expect(script).not.toContain('/api/pico/brand')
    expect(script).toContain('renderChannel(currentChannel)')
    // 渠道内容总是生效: 不再有 enabled 开关判定。
    expect(script).not.toMatch(/\.enabled/u)
  })

  it('escapes gateway-controlled method names and labels (P1-7)', () => {
    const script = loginScript()
    // m.name 来自网关 /auth/methods 响应(可被恶意/被劫持的网关控制),
    // 必须经 esc() 才能拼进属性/文案;不得再出现裸拼写法。
    expect(script).toContain('data-method="\' + name + \'"')
    expect(script).toContain("'>' + esc(label) + '</button>'")
    expect(script).not.toContain('data-method="\' + m.name + \'"')
    expect(script).not.toContain("+ '>' + label + '</button>'")
    // esc 本体必须转义属性注入所需字符(& < > ")。
    const escSrc = script.match(/function esc\(s\) \{[\s\S]*?\n  \}/)
    expect(escSrc, 'esc() must be findable').not.toBeNull()
    const esc = new Function(`${escSrc![0]}; return esc`)() as (v: unknown) => string
    expect(esc('"><img src=x onerror=alert(1)>')).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
  })

  it('skips the server-address step when the channel package preconfigured a domain', () => {
    const script = loginScript()
    // 渠道包预置域名 → 直接进登录,员工第一眼就是账号密码(或一次点击的浏览器
    // SSO),而不是"请输入你公司的地址"。
    expect(script).toContain('function connect(server)')
    expect(script).toContain('autoConnect')
    // 判据必须是**服务端写的标记**,不是"输入框有值":浏览器 reload 会恢复表单值,
    // 用"有值"判断会让未渠道化的构建在登录后重新触发自动连接、把页面拽回登录流程
    // (2026-09-10 实测:客户端 E2E 从 13/13 掉到 5/13 的根因)。
    expect(script).toContain("getAttribute('data-default-server') !== '1'")
    // 自动连接必须走"函数声明 + void 调用",不能把 IIFE 写在行首:
    // 本脚本是无分号风格,行首左圆括号会被解析成"调用上一行的返回值",
    // 一执行就抛错并让后面所有语句(含 #f2 登录处理)不再注册。
    expect(script).toContain('async function autoConnect()')
    expect(script).toContain('void autoConnect()')
    expect(script).not.toMatch(/^\s*\(async function autoConnect/m)
    // 提交与自动连接必须走同一条探测路径,不能各写一份。
    expect(script).toContain("f1.addEventListener('submit'")
  })

  it('escapes the channel-provided default domain before inlining it into the attribute', () => {
    // 预置域名由 apply() 在服务端替换进 value="…":必须经属性转义,
    // 否则一个带引号的地址就能从属性里逃逸(登录页是认证前唯一的 HTML 面)。
    const src = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
    expect(src).toContain('escapeHtmlAttribute(configuredServer)')
    expect(src).toContain("(config.defaultServer ?? '').trim()")
    expect(src).not.toContain("replaceAll('__DEFAULT_SERVER__', config.defaultServer ?? '')")
    const fn = src.match(/function escapeHtmlAttribute\(value: string\): string \{[\s\S]*?\n\}/)
    expect(fn, 'escapeHtmlAttribute must be findable').not.toBeNull()
    const escape = new Function(
      `${fn![0].replace(/: string/g, '')}; return escapeHtmlAttribute`,
    )() as (v: string) => string
    expect(escape('https://a.test"><img src=x>')).toBe('https://a.test&quot;&gt;&lt;img src=x&gt;')
  })
})

// ---- 0057 强制改密页模板(CHANGE_PASSWORD_HTML) ----
function renderedChangePasswordHTML(): string {
  const src = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
  const m = src.match(/const CHANGE_PASSWORD_HTML = `([\s\S]*?)`\n\n\/\/ P1-11/)
  expect(m, 'CHANGE_PASSWORD_HTML template must be findable').not.toBeNull()
  const raw = m![1]!
  const fn = new Function(`return \`${raw}\``) // eslint-disable-line no-new-func
  return fn()
}

describe('auth-gate CHANGE_PASSWORD_HTML inline script', () => {
  it('rendered change-password page script parses as valid JavaScript', () => {
    const html = renderedChangePasswordHTML()
    const script = html.match(/<script>([\s\S]*?)<\/script>/i)![1]!
    expect(() => { new Function(script) }).not.toThrow()
  })

  it('submits old_password + new_password to the local API and returns to login on success', () => {
    const html = renderedChangePasswordHTML()
    expect(html).toContain('/api/pico/auth/password')
    expect(html).toContain('old_password: oldpw')
    expect(html).toContain("location.replace('/login'")
  })
})

/**
 * 内置服务端地址时不提供"返回修改服务端地址"。
 *
 * 渠道包把地址写死之后，员工不该被要求、也不该被诱导去改它；界面留一个"改地址"
 * 的入口既是多余的步骤，也给"把凭据发到别的地址"留了路。
 * 这里按**服务端实际吐出的 HTML** 断言（模板 + apply() 的替换一起测），
 * 而不是只看模板源码。
 */
function servedLoginPage(config: Config): string {
  let index: ((html: string) => string) | undefined
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    picoSession: { isRestored: () => true, isLoggedIn: () => false, getSession: () => null },
    webServer: {
      tapIndex: (cb: (html: string) => string) => { index = cb; return () => {} },
      register: () => () => {},
    },
  }
  apply(ctx as never, config)
  expect(index, 'auth-gate must tap the index route').toBeDefined()
  return index!('<!DOCTYPE html><html><head></head><body></body></html>')
}

describe('auth-gate login page: 内置地址后不再提供"修改服务端地址"', () => {
  it('渠道包内置了地址 → 页面上没有返回入口，但仍带自动连接标记', () => {
    const html = servedLoginPage({ defaultServer: 'https://harness.mokahr.vip' })
    expect(html).toContain('data-default-server="1"')
    expect(html).toContain('value="https://harness.mokahr.vip"')
    // 断言的是**标记**：脚本里始终有 `getElementById('back-btn')`（判空守卫），
    // 所以这里查的是按钮元素与它的可见文案。
    expect(html).not.toContain('id="back-btn"')
    expect(html).not.toContain('修改服务端地址')
  })

  it('没有内置地址（官方/本地构建）→ 返回入口照旧', () => {
    const html = servedLoginPage({})
    expect(html).toContain('id="back-btn"')
    expect(html).toContain('修改服务端地址')
    expect(html).not.toContain('data-default-server="1"')
  })

  it('脚本对"按钮不存在"是安全的（否则后面的登录处理全都注册不上）', () => {
    // 按钮缺失时若直接 getElementById(...).addEventListener 会在这一行抛
    // TypeError，后续语句（含 #f2 登录表单提交）全部不注册 —— 症状是
    // "点登录只是页面刷新"，与 2026-09-10 那次 ASI 事故同类。
    const script = loginScript()
    const guard = script.match(/var backBtn = document\.getElementById\('back-btn'\)\n\s*if \(backBtn\) backBtn\.addEventListener/)
    expect(guard, 'back-btn 的监听必须先判空').not.toBeNull()
    expect(script).not.toMatch(/^\s*document\.getElementById\('back-btn'\)\.addEventListener/m)
  })
})
