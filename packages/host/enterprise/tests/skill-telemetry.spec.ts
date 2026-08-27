import { describe, expect, it, vi } from 'vitest'
import { apply, reportSkillCall } from '../src/skill-telemetry.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const SESSION: Session = { serverURL: 'https://gateway.example', username: 'tester', token: 'tok-1' }

/** fetchJSON 被 mock:捕获上报 payload 供断言。 */
const captured: Array<{ path: string; body: unknown }> = []
vi.mock('../src/server-connector/auth.ts', () => ({
  fetchJSON: vi.fn(async (serverURL: string, path: string, opts: { body?: unknown }) => {
    captured.push({ path, body: opts.body })
    return { ok: true }
  }),
}))

function stubCtx(): Context {
  return {
    picoSession: { getSession: () => SESSION },
    on: vi.fn(),
  } as unknown as Context
}

const EXEC: ToolExecution = {
  name: 'skill',
  arguments: { name: 'codeql' },
  callId: 'c-tools-1' as never,
  rootCallId: 'c-tools-1' as never,
  token: Symbol('t') as never,
  signal: new AbortController().signal,
}
const OK_RESULT: ToolExecutionResult = { isError: false, value: null, content: [] }

describe('skill-telemetry', () => {
  it('模型 skill 工具成功执行即上报 name(无版本)', async () => {
    await reportSkillCall(SESSION, 'codeql', undefined, 'c-report-1')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.path).toBe('/api/telemetry/skill-call')
    expect(captured[0]!.body).toEqual({ name: 'codeql', version: '' })
  })

  it('同一调用重复上报被幂等键去重', async () => {
    const before = captured.length
    const r1 = await reportSkillCall(SESSION, 'codeql', undefined, 'c-dedupe-1')
    const r2 = await reportSkillCall(SESSION, 'codeql', undefined, 'c-dedupe-1')
    expect(r1).toBe(true)
    expect(r2).toBe(false)
    expect(captured.length - before).toBe(1)
  })

  it('未登录(session=null)不发送', async () => {
    const before = captured.length
    const ok = await reportSkillCall(null, 'codeql', undefined, 'c-x')
    expect(ok).toBe(false)
    expect(captured.length - before).toBe(0)
  })

  it('非法技能名拒绝发送', async () => {
    const before = captured.length
    const ok = await reportSkillCall(SESSION, 'a/b', undefined, 'c-y')
    expect(ok).toBe(false)
    expect(captured.length - before).toBe(0)
  })

  it('apply 注册 tools/result 与 session/event 监听', () => {
    const ctx = stubCtx()
    apply(ctx)
    expect(ctx.on).toHaveBeenCalledWith('tools/result', expect.any(Function))
    expect(ctx.on).toHaveBeenCalledWith('session/event', expect.any(Function))
  })

  it('tools/result 观察者:非 skill 工具不触发上报', async () => {
    const ctx = stubCtx()
    apply(ctx)
    const handler = (ctx.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'tools/result')![1] as (e: ToolExecution, r: ToolExecutionResult) => void
    const before = captured.length
    handler({ ...EXEC, name: 'bash' }, OK_RESULT)
    await new Promise((r) => setTimeout(r, 20))
    expect(captured.length - before).toBe(0)
  })

  it('tools/result 观察者:skill 工具错误结果不触发上报', async () => {
    const ctx = stubCtx()
    apply(ctx)
    const handler = (ctx.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'tools/result')![1] as (e: ToolExecution, r: ToolExecutionResult) => void
    const before = captured.length
    handler(EXEC, { isError: true, error: { name: 'x', code: 'x' }, content: [] })
    await new Promise((r) => setTimeout(r, 20))
    expect(captured.length - before).toBe(0)
  })

  it('tools/result 观察者:skill 成功触发上报(异步等待)', async () => {
    const ctx = stubCtx()
    apply(ctx)
    const handler = (ctx.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'tools/result')![1] as (e: ToolExecution, r: ToolExecutionResult) => void
    const before = captured.length
    handler(EXEC, OK_RESULT)
    await new Promise((r) => setTimeout(r, 40))
    expect(captured.length - before).toBe(1)
    expect(captured[captured.length - 1]!.body).toEqual({ name: 'codeql', version: '' })
  })
})
