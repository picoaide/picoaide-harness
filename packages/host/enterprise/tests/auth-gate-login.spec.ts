import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
  const fn = new Function(`return \`${raw}\``) // eslint-disable-line no-new-func
  return fn()
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
