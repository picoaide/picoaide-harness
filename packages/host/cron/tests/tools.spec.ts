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

  it('registers cron_create / cron_list / cron_set_enabled / cron_run / cron_remove', () => {
    expect(source).toContain("name: 'cron_create'")
    expect(source).toContain("name: 'cron_list'")
    expect(source).toContain("name: 'cron_set_enabled'")
    expect(source).toContain("name: 'cron_run'")
    expect(source).toContain("name: 'cron_remove'")
  })

  it('cron_remove routes through the ledger delete action with owner-filtered existence checks', () => {
    // 2026-09-17：模型能建任务却不能删任务（真机自检报告）。删除必须走与 GUI
    // 同一个 delete 动作，并且和 cron_run 一样先过 owner 过滤（看不见的任务按
    // "不存在"处理，而不是泄露或误删）。
    expect(source).toContain("kind: 'delete', jobId: args.jobId")
    expect(source).toContain('service.listVisibleJobs()')
    // 正在执行的任务拒删：delete 不取消在跑的会话，只让它的执行记录凭空消失。
    // 2026-09-23 CR-2：判据抽到 jobs.ts 的 `jobIsRunning`（工具 / 账本 delete /
    // 面板按钮共用一处），这里钉住工具侧仍走同一个判据而不是各自内联。
    expect(source).toContain('jobIsRunning(before)')
    expect(source).not.toContain('execution.endedAt === undefined')
  })

  it('cron_set_enabled pre-checks the owner-filtered roster (CR-3)', () => {
    // 2026-09-23 CR-3：缺预检 ⇒ 不存在的 id 假成功、别人的 id 抛账本内部串
    // （跨账号存在性预言机）。三个工具必须同口径：看不见 = 按不存在报错。
    const execute = source.slice(source.indexOf("name: 'cron_set_enabled'"))
    expect(execute).toContain('service.listVisibleJobs()')
    expect(execute).toContain("copy('tool.jobMissing'")
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
