/**
 * `cron_set_enabled` 行为回归（2026-09-23 独立审计 CR-3，报告
 * `temp/audit-2026-09-23/D-browser-wasm-host.md` §4.8 / 子报告 CR-3）。
 *
 * 缺陷：这个工具缺 `listVisibleJobs()` 预检（另外两个目标动作工具都有）：
 *   1. 不存在的 id 一路走到账本，mutation 是静默 no-op，工具却回答
 *      `{enabled:true}` = **假成功**（transcript 还会渲染「已启用定时任务 no-such-job」）；
 *   2. 别人的 id 抛账本内部串 `dsh-cron: job <id> belongs to another account`
 *      = 跨账号**存在性预言机**（另外两个工具对"不存在"和"别人的"回答完全一致）。
 *
 * 修法：与 `cron_run`/`cron_remove` 同口径——先过 owner 过滤，看不见就按不存在报错；
 * 已经是目标状态时如实回报"已在该状态"，不谎报一次变更。
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
  const home = mkdtempSync(join(tmpdir(), 'pico-cron-enabled-'))
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
const setEnabled = (h: Harness, args: { jobId: string, enabled: boolean }): Promise<unknown> =>
  h.tools.get('cron_set_enabled')!.execute(args, EXEC)

async function createJob(h: Harness, name = 'probe'): Promise<string> {
  const created = await h.tools.get('cron_create')!.execute(
    { name, cron: '0 9 * * *', prompt: 'p' },
    EXEC,
  ) as { id: string }
  return created.id
}

describe('cron_set_enabled', () => {
  it('启用/停用真正生效，并如实回报状态', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const id = await createJob(h)
      expect(h.service.ledger.state().jobs[0]!.enabled).toBe(false)
      expect(await setEnabled(h, { jobId: id, enabled: true })).toEqual({ jobId: id, enabled: true })
      expect(h.service.ledger.state().jobs[0]!.enabled).toBe(true)
      expect(await setEnabled(h, { jobId: id, enabled: false })).toEqual({ jobId: id, enabled: false })
      expect(h.service.ledger.state().jobs[0]!.enabled).toBe(false)
    } finally {
      h.dispose()
    }
  })

  it('不存在的任务按「不存在」报错，且账本修订号不变（不再假成功）', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const before = h.service.ledger.state().revision
      await expect(setEnabled(h, { jobId: 'no-such-job', enabled: true }))
        .rejects.toThrow('定时任务不存在: no-such-job')
      expect(h.service.ledger.state().revision).toBe(before)
      h.setLocale('en')
      await expect(setEnabled(h, { jobId: 'no-such-job', enabled: true }))
        .rejects.toThrow('Scheduled job not found: no-such-job')
    } finally {
      h.dispose()
    }
  })

  it('别人的任务：与「不存在」同一条本地化错误，不泄露内部串、不暴露存在性', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const id = await createJob(h, 'alice-job')
      const before = h.service.ledger.state().revision

      h.setUser('bob')
      // The localized "not found" answer, not the ledger's raw
      // "belongs to another account" string (existence oracle).
      await expect(setEnabled(h, { jobId: id, enabled: true }))
        .rejects.toThrow('定时任务不存在')
      await expect(setEnabled(h, { jobId: id, enabled: true }))
        .rejects.not.toThrow(/another account/)
      expect(h.service.ledger.state().revision).toBe(before)
      // The victim's job is untouched.
      expect(h.service.ledger.state().jobs[0]!.enabled).toBe(false)
      expect(h.service.ledger.state().jobs[0]!.owner).toBe('alice')
    } finally {
      h.dispose()
    }
  })

  it('已经是目标状态时不谎报变更（修订号不动）', async () => {
    const h = harness()
    try {
      h.setUser('alice')
      const id = await createJob(h)
      // Create left the job disabled: asking for "disabled" changes nothing.
      const before = h.service.ledger.state().revision
      expect(await setEnabled(h, { jobId: id, enabled: false })).toEqual({ jobId: id, enabled: false })
      expect(h.service.ledger.state().revision).toBe(before)
    } finally {
      h.dispose()
    }
  })
})
