import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

/**
 * Structural tests for the cron model-facing tools: they must be registered
 * with the exact names the system-prompt announcement cites, carry no
 * command/shell/executable fields, and route through the Host service.
 */
describe('cron tools surface', () => {
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')

  it('registers cron_create / cron_list / cron_set_enabled / cron_run', () => {
    expect(source).toContain("name: 'cron_create'")
    expect(source).toContain("name: 'cron_list'")
    expect(source).toContain("name: 'cron_set_enabled'")
    expect(source).toContain("name: 'cron_run'")
  })

  it('has no command/shell/executable parameter fields', () => {
    // The words appear only in prose comments; the schema/parameters must
    // not carry such field names.
    expect(source).not.toMatch(/['"]command['"]/)
    expect(source).not.toMatch(/['"]executable['"]/)
    expect(source).not.toMatch(/['"]shell['"]/)
  })

  it('validates the cron expression and requires a prompt in execute', () => {
    expect(source).toContain('isValidCron(args.cron)')
    expect(source).toContain(`prompt.trim() === ''`)
    // 2026-09-16 i18n：文案搬进了 host-copy 字典（transcript 与错误随宿主语言），
    // 这里钉住「execute 仍然通过字典抛出必填错误」而不是钉某个语言的字面量；
    // 中文原文本身由 tests/host-copy.spec.ts 逐字断言。
    expect(source).toContain("copy('tool.promptRequired')")
    const copy = readFileSync(new URL('../src/host-copy.ts', import.meta.url), 'utf8')
    expect(copy).toContain("'tool.promptRequired': '必须提供 prompt（执行时发送给智能体会话的提示词）'")
  })

  it('routes through the Host service', () => {
    expect(source).toContain('service.registerJob(')
    expect(source).toContain('service.apply(')
    // Reads go through the owner-filtered surface (multi-user isolation).
    expect(source).toContain('service.listVisibleJobs()')
  })
})
