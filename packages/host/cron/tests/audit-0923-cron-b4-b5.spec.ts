/**
 * R3-B3 F3 / B-4 与 F2 / B-5 回归 —— 2026-09-23 第三轮审计（报告
 * `temp/round3-2026-09-23/R3-B3-cron.md` §2 F2/F3，编号另见
 * `R3-B-client-host.md` 的 B-4/B-5）。
 *
 * **B-4（P3）**：`cron_create` 只 trim 不校验名称，`"   "` 被落盘成 `name: ""`
 * ——工具的参数契约自称「非空」、GUI/协议面拒绝 `''`，两个面各写一份"什么算空"
 * 的判断。判据分三层：
 *   1. 工具面对空名/纯空白**必须报错**（点名参数）且**不落盘任何任务**；
 *   2. 两个面必须走**同一处真源**（`jobs.ts` 的 `isUsableJobName`），结构上钉死
 *      protocol.ts / tools.ts 不再各写 `=== ''` / `trim() === ''`；
 *   3. 反向：正常名称照常创建（且仍按原样 trim），非空名称在协议面照常接受。
 *
 * **B-5（P2/P3）**：`cron.ts` 头注释声称"前拨缺口内的分钟 forward 归一、仍会
 * 触发"，实测该 occurrence **零触发**（`30 2 * * *` 在 2026-03-08 一次都不跑），
 * 且默认 `catchUpMissed=false` ⇒ 静默丢一次触发。拍板=**如实跳过 + 改注释 + 让
 * 跳过可观测**（不补跑，`catchUpMissed=false` 是已文档化的默认语义）。判据：
 *   1. 固定 TZ（`America/New_York`）+ 固定日期（2026-03-08）：该 occurrence 被
 *      跳过 —— 子进程跑真实 ledger，`nextRunAt` 从 03-07 02:30 直接滚到
 *      03-09 02:30；
 *   2. **可观测**：同一 roll 必须留下痕迹（scheduler 状态里的
 *      `skippedOccurrences` + Host 日志一行），并且跨重启仍在；
 *   3. 注释必须与实现一致（不再出现"normalize forward"这类反向声称）；
 *   4. 反向（防过度修复）：**同一天仍然存在的时刻照常触发**（09:00 在
 *      2026-03-08 存在 ⇒ 正常执行、不记录任何跳过），回拨重复小时不算缺口，
 *      普通日子的滚动不产生任何记录。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronService } from '../src/host-service.ts'
import { registerCronTools } from '../src/tools.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import { nextRunAtMs, nextRunAtMsWithGaps } from '../src/cron.ts'
import { rollNextRunWithGaps, type JobRecord } from '../src/jobs.ts'
import { DST_NOTICE_WINDOW_MS, latestDstSkip } from '../src/client/dst-notice.ts'
import { en, zh } from '../src/client/locales.ts'

const GAP_PROBE = fileURLToPath(new URL('./helpers/dst-gap-probe.mjs', import.meta.url))
const NO_GAP_PROBE = fileURLToPath(new URL('./helpers/dst-nongap-probe.mjs', import.meta.url))

/** Fixed clock: no fixture may depend on the wall clock. */
const T0 = new Date(2026, 8, 23, 9, 0, 0).getTime()

const EXEC = {} as never

let dir: string
const probeDirs: string[] = []
/** One report per probe file: a second run would reuse the ledger home. */
const probeCache = new Map<string, Record<string, any>>()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-b4-b5-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  for (const probeDir of probeDirs) rmSync(probeDir, { recursive: true, force: true })
})

/** One wall clock as `YYYY-MM-DD HH:MM` in the current zone. */
function stamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Run one child probe under a fixed `TZ` and return its JSON report.
 * @param probe - probe file to run.
 * @param tz - timezone the child must boot with (V8 caches the zone, so a fresh
 *   process is the only reliable way to pin it — same discipline as cron.spec.ts).
 * @returns the parsed report line.
 */
function probeReport(probe: string, tz: string): Record<string, any> {
  const cached = probeCache.get(probe)
  if (cached !== undefined) return cached
  const base = mkdtempSync(join(tmpdir(), 'dsh-cron-dst-probes-'))
  probeDirs.push(base)
  const result = spawnSync(process.execPath, [probe, base], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 60_000,
  })
  // A regression in the scan can hang or throw inside the child: without this
  // assertion the spec would report a JSON parse error instead of the cause.
  expect(result.status, `probe failed: ${result.stderr || result.stdout}`).toBe(0)
  const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? ''
  const report = JSON.parse(line) as Record<string, any>
  probeCache.set(probe, report)
  return report
}

/**
 * Real tool registration over a fake cordis context with a mutable host locale,
 * a real ledger, and the real service (same shape as `host-copy.spec.ts`).
 */
function toolHarness(): {
  tools: Map<string, ToolDefinition>
  service: HostCronService
  setLocale: (locale: 'zh' | 'en') => void
  dispose: () => void
} {
  const home = mkdtempSync(join(tmpdir(), 'pico-cron-b4-'))
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
  const service = new HostCronService({} as never, {
    ledger: new HostCronLedger({ dshHomeDir: home }),
    now: () => T0,
  })
  registerCronTools(ctx, service, { permissions: () => ['read'] })
  return {
    tools,
    service,
    setLocale: (next) => { locale = next },
    dispose: () => {
      service.dispose()
      for (const dispose of disposers) dispose()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function createEnvelope(name: unknown): unknown {
  return {
    requestId: 'req-b4',
    action: {
      kind: 'create',
      id: 'job-b4',
      input: { name, cron: '0 9 * * *', action: { kind: 'agent', prompt: 'do the thing' } },
    },
  }
}

describe('R3-B3 B-4 空白任务名（工具面必须与协议面同源）', () => {
  it('cron_create 拒绝纯空白名，报错点名参数，且一个任务都不落盘', async () => {
    const harness = toolHarness()
    try {
      const create = harness.tools.get('cron_create')!
      for (const blank of ['', '   ', '\t\n']) {
        await expect(create.execute({ name: blank, cron: '0 9 * * *', prompt: 'p' }, EXEC))
          .rejects.toThrow('必须提供任务名称（不能为空或只有空白字符）')
      }
      // Fail-loud must not leave a half-created job behind (the pre-fix code
      // stored `name: ""` and answered "created").
      expect(harness.service.listVisibleJobs()).toHaveLength(0)
      // The name check comes BEFORE the prompt check, so a blank name is
      // reported as a name problem even when the prompt is fine.
      await expect(create.execute({ name: 'x', cron: '0 9 * * *', prompt: '' }, EXEC))
        .rejects.toThrow('必须提供 prompt（执行时发送给智能体会话的提示词）')
    } finally {
      harness.dispose()
    }
  }, 20_000)

  it('英文宿主语言下同一条错误走英文镜像（两张字典都有该键）', async () => {
    const harness = toolHarness()
    try {
      harness.setLocale('en')
      await expect(harness.tools.get('cron_create')!.execute({ name: '  ', cron: '0 9 * * *', prompt: 'p' }, EXEC))
        .rejects.toThrow('A job name is required (it must not be empty or only whitespace)')
      expect(harness.service.listVisibleJobs()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  }, 20_000)

  it('反向：正常名称照常创建，并保留原有的 trim 行为', async () => {
    const harness = toolHarness()
    try {
      const created = await harness.tools.get('cron_create')!
        .execute({ name: '  Nightly report  ', cron: '0 9 * * *', prompt: '  p  ' }, EXEC) as { id: string }
      const jobs = harness.service.listVisibleJobs()
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.id).toBe(created.id)
      expect(jobs[0]!.name).toBe('Nightly report')
      expect(jobs[0]!.action.prompt).toBe('p')
      expect(jobs[0]!.enabled).toBe(false)
    } finally {
      harness.dispose()
    }
  }, 20_000)

  it('协议面用同一条判据：创建与改名都拒绝空白名，正常名照常通过', () => {
    expect(parseActionEnvelope(createEnvelope(''))).toBeUndefined()
    expect(parseActionEnvelope(createEnvelope('   '))).toBeUndefined()
    expect(parseActionEnvelope(createEnvelope('\t'))).toBeUndefined()
    expect(parseActionEnvelope(createEnvelope('Nightly'))).toBeDefined()

    const patch = (name: unknown): unknown => ({ requestId: 'req-p', action: { kind: 'update', jobId: 'job-1', patch: { name } } })
    expect(parseActionEnvelope(patch(''))).toBeUndefined()
    expect(parseActionEnvelope(patch('   '))).toBeUndefined()
    expect(parseActionEnvelope(patch('Nightly'))).toBeDefined()
  })

  it('两个面共用 jobs.ts 的 isUsableJobName（不再各写一份 trim/空串判断）', () => {
    const jobsSource = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8')
    const protocolSource = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8')
    const toolsSource = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
    expect(jobsSource).toContain('export function isUsableJobName(')
    expect(protocolSource).toContain('isUsableJobName(input.name)')
    expect(protocolSource).toContain('isUsableJobName(patch.name)')
    expect(protocolSource).not.toContain("input.name === ''")
    expect(toolsSource).toContain('isUsableJobName(args.name)')
    expect(toolsSource).toContain("copy('tool.nameRequired')")
  })
})

describe('R3-B3 B-5 DST 缺口：如实跳过 + 可观测（TZ=America/New_York，2026-03-08）', () => {
  it('前拨缺口内的 occurrence 不触发：03-07 02:30 的下一次直接是 03-09 02:30', () => {
    const report = probeReport(GAP_PROBE, 'America/New_York')
    // Guard the fixture itself: if the TZ had not been applied the rest of this
    // suite would be meaningless (V8 caches the zone per process).
    expect(report.timeZone).toBe('America/New_York')
    const day = report.gapDay as Record<string, unknown>
    expect(day.seededWallClock).toBe('2026-03-07 02:30')
    expect(day.opened).toBe(true)
    expect(day.nextWallClock).toBe('2026-03-09 02:30')
  }, 60_000)

  it('跳过留下可观测痕迹：scheduler 状态 + Host 日志，且跨重启仍在', () => {
    const report = probeReport(GAP_PROBE, 'America/New_York')
    const day = report.gapDay as {
      skips: Array<Record<string, unknown>>
      detectedWallClock: string | null
      persistedSkips: Array<Record<string, unknown>>
      logs: string[]
    }
    expect(day.skips).toHaveLength(1)
    expect(day.skips[0]).toMatchObject({
      jobId: 'job-a',
      name: 'Nightly',
      wallClock: '2026-03-08 02:30',
      timeZone: 'America/New_York',
    })
    // `detectedAt` is the roll's own clock, not "now": the record is what the
    // panel and `GET /api/cron/state` read (the wall clock comes from the probe,
    // which is the only process in the America/New_York zone).
    expect(day.detectedWallClock).toBe('2026-03-07 02:30')
    // A restart must not erase "your 02:30 run was skipped today".
    expect(day.persistedSkips).toEqual(day.skips)
    expect(day.logs).toHaveLength(1)
    expect(day.logs[0]).toContain('DST gap')
    expect(day.logs[0]).toContain('2026-03-08 02:30')
    expect(day.logs[0]).toContain('job-a')
  }, 60_000)

  it('纯扫描：命中时刻不变，缺口作为记录返回（回拨重复小时不算缺口）', () => {
    const report = probeReport(GAP_PROBE, 'America/New_York')
    expect(report.scan).toMatchObject({
      atWallClock: '2026-03-09 02:30',
      gaps: ['2026-03-08 02:30'],
      normalizedToWallClock: '2026-03-08 03:30',
    })
    // Fall-back (2026-11-01 01:00–01:59 repeats): the wall clock exists, so the
    // first pass is a normal match and nothing is reported as a gap.
    expect(report.fallBack).toMatchObject({ atWallClock: '2026-11-01 01:30', gaps: [] })
  }, 60_000)

  it('反向：缺口日仍然存在的时刻照常触发（修复没有压制正常触发）', () => {
    const report = probeReport(NO_GAP_PROBE, 'America/New_York')
    expect(report.timeZone).toBe('America/New_York')
    expect(report.sameDay).toMatchObject({
      seededWallClock: '2026-03-08 09:00',
      dueExists: true,
      opened: true,
      triggeredWallClock: '2026-03-08 09:00',
      nextWallClock: '2026-03-09 09:00',
      result: 'succeeded',
      skips: [],
    })
  }, 60_000)

  it('注释与实现一致：头注释不得再声称缺口内的分钟会 forward 归一', () => {
    const source = readFileSync(new URL('../src/cron.ts', import.meta.url), 'utf8')
    // Comment leaders and line wrapping are normalised away: the pre-fix
    // sentence was wrapped across two source lines, so a line-oriented match
    // would let the old claim slip back in unnoticed.
    const prose = source.replace(/\s*\*\s*/gu, ' ').replace(/\s+/gu, ' ')
    expect(prose).not.toContain('nonexistent spring minutes normalize forward')
    expect(prose).toContain('skipped, never fired')
    expect(prose).toContain('FIRST pass')
  })
})

describe('R3-B3 B-5 反向：普通日子的滚动不受影响', () => {
  it('没有 DST 跳变时滚动不产生任何跳过记录', () => {
    const job: JobRecord = {
      id: 'job-plain',
      name: 'Plain',
      cron: '0 9 * * *',
      action: { kind: 'agent', prompt: 'p' },
      enabled: true,
      executions: [],
      createdAt: 0,
      updatedAt: 0,
    }
    const from = new Date(2026, 8, 20, 10, 0, 0).getTime()
    const roll = rollNextRunWithGaps(job, from)
    expect(roll.gaps).toEqual([])
    // The narrow answer and the reporting scan must agree (the ledger's
    // validation/UI paths keep using `nextRunAtMs`).
    expect(roll.at).toBe(nextRunAtMs('0 9 * * *', from))
    expect(nextRunAtMsWithGaps('0 9 * * *', from).at).toBe(roll.at)
  })

  it('新账本没有跳过记录（该字段不制造噪音）', () => {
    const host = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    host.applyRequest('r1', {
      kind: 'create',
      id: 'job-1',
      input: { name: 'Daily', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true },
    })
    expect(host.state().scheduler.skippedOccurrences).toBeUndefined()
    host.dispose()
  })

  it('正常触发路径不受影响：到点开启执行、结算成功、滚到下一次', () => {
    const host = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    host.applyRequest('r1', {
      kind: 'create',
      id: 'job-1',
      input: { name: 'Daily', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true },
    })
    const due = host.state().jobs[0]!.nextRunAt!
    const opened = host.openScheduled('job-1', 'sched-1', due)
    expect(opened).toBeDefined()
    host.settle('job-1', 'sched-1', 'succeeded')
    const job = host.state().jobs[0]!
    expect(job.executions[0]!.result).toBe('succeeded')
    expect(job.nextRunAt).toBeGreaterThan(due)
    expect(host.state().scheduler.skippedOccurrences).toBeUndefined()
    host.dispose()
  })
})

describe('R3-B3 B-5 面板提示：只提示新鲜的跳过', () => {
  const record = (detectedAt: number): { jobId: string, name: string, wallClock: string, timeZone: string, normalizedTo: number, detectedAt: number } =>
    ({ jobId: 'job-a', name: 'Nightly', wallClock: '2026-03-08 02:30', timeZone: 'America/New_York', normalizedTo: 0, detectedAt })

  it('窗口内的最新一条会被提示，且取的是最新一条', () => {
    const now = T0
    expect(latestDstSkip({ skippedOccurrences: [record(now - 5_000), record(now - 1_000)] }, now))
      .toEqual(record(now - 1_000))
  })

  it('超过窗口的历史记录不再占用面板', () => {
    const now = T0
    expect(latestDstSkip({ skippedOccurrences: [record(now - DST_NOTICE_WINDOW_MS - 1)] }, now)).toBeUndefined()
    expect(latestDstSkip({ skippedOccurrences: [record(now - DST_NOTICE_WINDOW_MS)] }, now)).toBeDefined()
  })

  it('没有记录时不给提示（缺省状态静默）', () => {
    expect(latestDstSkip({}, T0)).toBeUndefined()
    expect(latestDstSkip({ skippedOccurrences: [] }, T0)).toBeUndefined()
  })

  it('面板确实渲染这条提示（文案键 + 组件接线）', () => {
    const tabSource = readFileSync(new URL('../src/client/CronJobTab.tsx', import.meta.url), 'utf8')
    expect(tabSource).toContain('latestDstSkip(snapshot.scheduler')
    expect(tabSource).toContain("t('settings.dstSkipped'")
    // Both dictionaries carry the key with the same parameter names (`en` is a
    // Record<CronKey, string>, so this also pins the zh source key).
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]!).sort()
    expect(placeholders(zh['settings.dstSkipped'])).toEqual(['name', 'timeZone', 'wallClock'])
    expect(placeholders(en['settings.dstSkipped'])).toEqual(placeholders(zh['settings.dstSkipped']))
  })
})
