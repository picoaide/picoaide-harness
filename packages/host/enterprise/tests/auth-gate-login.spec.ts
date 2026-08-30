import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 回归测试(2026-09):LOGIN_HTML 是 TS 模板字符串,内联 <script> 里的正则
// `\/` 会被模板转义成 `/`(输出 `//$` = 空正则+注释)导致浏览器 SyntaxError,
// 登录页整个 JS 不执行(app 永不登录)。此测试从源码提取 LOGIN_HTML 并
// 验证: 1) 不含会被模板转义破坏的正则片段; 2) 内联 script 本身可解析。
describe('auth-gate LOGIN_HTML inline script', () => {
  it('login page inline script parses as valid JavaScript', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
    const m = src.match(/const LOGIN_HTML = `([\s\S]*?)`\n\nexport interface Config/)
    expect(m).not.toBeNull()
    const html = m![1]!
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i)
    expect(scriptMatch).not.toBeNull()
    const script = scriptMatch![1]!
    // 模板字符串中不得出现会被转义成注释的 `//` 空正则(即 `\` 后直接 `/`)
    expect(script).not.toMatch(/\/\/\$/)
    expect(script).not.toMatch(/replace\(\/\/\$/)
    // 必须可解析
    expect(() => { new Function(script) }).not.toThrow()
  })

  it('login page uses no TS-template-unsafe backslash regex', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
    // 提取 HTML 的 script 段,不允许出现 `\/` 在正则字面量里(会被模板转义)
    const m = src.match(/const LOGIN_HTML = `([\s\S]*?)`\n\nexport interface Config/)
    const html = m![1]!
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i)
    const script = scriptMatch![1]!
    // 禁止 `\/` 在正则中: 出现则说明把转义序列写进了模板(应改用字符串切片等)
    expect(script).not.toMatch(/\.replace\([^)]*\\\\\/[^)]*\)/)
  })
})
