/**
 * `cron_remove` 行为回归（2026-09-17）。
 *
 * 真机自检报告（Windows 客户端 2.7.5-beta.4，会话 session-77720e3e）指出：模型
 * 可以 cron_create 建任务，却没有任何工具能删任务，自检遗留的占位任务只能让用户
 * 去 GUI 面板手动清理。这里钉住删除工具的四条契约：
 *
 *  1. 真正跑通 create → remove，任务从账本消失（走与 GUI 相同的 `delete` 动作）；
 *  2. 看不见的任务（不存在 / 属于别的账号）按「不存在」报错，且不落删除；
 *  3. 正在执行的任务拒删（`delete` 不会取消在跑的会话，删了只会让执行记录凭空消失）；
 *  4. transcript 文案与错误随宿主语言（沿用 host-copy 的按调用解析纪律）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronService } from '../src/host-service.ts'
import { registerCronTools } from '../src/tools.ts'

interface Harness {
  tools: Map<string, ToolDefinition>
  service: HostCronService
  setUser: (username: string | null) => void
  setLocale: (locale: 'zh' | 'en') => void
  dispose: () => void
}

/** Real tool registration over a fake cordis context with a mutable account and locale. */
function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'pico-cron-remove-'))
  let locale: 'zh' | 'en' = 'zh'
  const tools = new Map<string, ToolDefinition>()
  const disposers: Array<() => void> = []
  const ctx = {
    get: (name: string) => (name === 'desktopRuntime' ? { get locale() { return locale } } : undefined),
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        const dispose = (): void => { tools.delete(definition.name) }
        disposers.push(dispose)
        return dispose
      },
    },
  } as unknown as Context
  const service = new HostCronService({} as unknown as ApiProxy, {
    ledger: new HostCronLedger({ dshHomeDir: home, owner: () => service.currentUsername() }),
    now: () => 1_800_000_000_000,
  })
  registerCronTools(ctx, service, { permissions: () => ['read', 'write'] })
  return {
    tools,
    service,
    setUser: (username) => { service.setUsername(username) },
    setLocale: (next) => { locale = next },
    dispose: () => {
      for (const dispose of disposers) dispose()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const EXEC = {} as never

async function createJob(h: Harness, name = 'probe'): Promise<string> {
  const created = await h.tools.get('cron_create')!.execute(
    { name, cron: '0 9 * * *', prompt: 'p' },
    EXEC,
  ) as { id: string }
  return created.id
}

describe('cron_remove', () => {
  it('删除已存在的任务并把它从账本移除', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const id = await createJob(h)
      expect(h.service.listVisibleJobs().map(job => job.id)).toEqual([id])

      const value = await h.tools.get('cron_remove')!.execute({ jobId: id }, EXEC)
      expect(value).toEqual({ jobId: id, removed: true })
      expect(h.service.ledger.state().jobs).toHaveLength(0)
      expect(h.service.listVisibleJobs()).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })

  it('删除不存在的任务按「不存在」报错', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      await expect(h.tools.get('cron_remove')!.execute({ jobId: 'missing' }, EXEC))
        .rejects.toThrow('定时任务不存在: missing')
      h.setLocale('en')
      await expect(h.tools.get('cron_remove')!.execute({ jobId: 'missing' }, EXEC))
        .rejects.toThrow('Scheduled job not found: missing')
    } finally {
      h.dispose()
    }
  })

  it('看不到别的账号的任务：按不存在报错，且任务仍在', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const id = await createJob(h, 'alice-job')
      h.setUser('bob')
      await expect(h.tools.get('cron_remove')!.execute({ jobId: id }, EXEC))
        .rejects.toThrow('定时任务不存在')
      h.setUser('alice')
      expect(h.service.ledger.state().jobs.map(job => job.id)).toEqual([id])
    } finally {
      h.dispose()
    }
  })

  it('正在执行的任务拒删，任务保留', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const id = await createJob(h)
      // 直接开一条未结束的执行记录（不经过 service.apply，避免真的去起会话）。
      h.service.ledger.applyRequest('open-run', { kind: 'run', jobId: id })
      expect(h.service.ledger.state().jobs[0]!.executions.some(e => e.endedAt === undefined)).toBe(true)

      await expect(h.tools.get('cron_remove')!.execute({ jobId: id }, EXEC))
        .rejects.toThrow('已在运行')
      expect(h.service.ledger.state().jobs.map(job => job.id)).toEqual([id])

      h.setLocale('en')
      await expect(h.tools.get('cron_remove')!.execute({ jobId: id }, EXEC))
        .rejects.toThrow('is already running')
    } finally {
      h.dispose()
    }
  })

  it('transcript 文案随语言', async () => {
    const h = harness()
    try {
      const remove = h.tools.get('cron_remove')!
      const blocks = remove.output.render({ jobId: 'job-1' } as never, { jobId: 'job-1', removed: true } as never)
      expect((blocks[0] as { text?: string }).text).toBe('已删除定时任务 job-1')
      h.setLocale('en')
      const english = remove.output.render({ jobId: 'job-1' } as never, { jobId: 'job-1', removed: true } as never)
      expect((english[0] as { text?: string }).text).toBe('Deleted scheduled job job-1')
    } finally {
      h.dispose()
    }
  })
})
