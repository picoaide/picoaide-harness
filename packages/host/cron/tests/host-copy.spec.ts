/**
 * 2026-09-16 i18n：cron 的 **Host 半边**文案回归。
 *
 * 被保护的不变量：
 *  1. transcript 载荷（`output.render`）与工具抛出的错误**每次构消息时**按
 *     `desktopRuntime.locale` 解析 —— 冻结在模块级/注册期即红（真机语义：用户在
 *     设置里切语言，插件进程不重启，之后每一次工具调用都该用新语言）；
 *  2. 系统提示词公告（CRON_GUIDANCE 的 section）在**每次装配**时取语言；
 *  3. 中文文案逐字节不变（翻译是加法）；
 *  4. 工具/参数 description 有意保持中文（模型面契约），不被顺手翻译。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronService } from '../src/host-service.ts'
import { cronGuidance, hostLocaleOf, hostT } from '../src/host-copy.ts'
import { CRON_GUIDANCE } from '../src/index.ts'
import { registerCronTools } from '../src/tools.ts'
import { zh as clientZh, en as clientEn } from '../src/client/locales.ts'

/** Real tool registration over a fake cordis context with a MUTABLE host locale. */
function toolHarness(): {
  tools: Map<string, ToolDefinition>
  setLocale: (locale: 'zh' | 'en') => void
  dispose: () => void
  home: string
} {
  const home = mkdtempSync(join(tmpdir(), 'pico-cron-i18n-'))
  let locale: 'zh' | 'en' = 'zh'
  const tools = new Map<string, ToolDefinition>()
  const disposers: Array<() => void> = []
  const ctx = {
    // The plugin probes `desktopRuntime` structurally (host-locale.ts).
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
    ledger: new HostCronLedger({ dshHomeDir: home }),
    now: () => 1_800_000_000_000,
  })
  registerCronTools(ctx, service, { permissions: () => ['read', 'write'] })
  return {
    tools,
    setLocale: (next) => { locale = next },
    dispose: () => {
      for (const dispose of disposers) dispose()
      rmSync(home, { recursive: true, force: true })
    },
    home,
  }
}

const EXEC = {} as never

function render(tools: Map<string, ToolDefinition>, name: string, args: unknown, value: unknown): string {
  const tool = tools.get(name)
  expect(tool, `tool ${name} registered`).toBeDefined()
  const blocks = tool!.output.render(args as never, value as never)
  const first = blocks[0] as { type: string; text?: string }
  expect(first.type).toBe('text')
  return first.text ?? ''
}

describe('cron transcript 载荷按调用解析（注册期冻结即红）', () => {
  it('cron_create 的「已创建」文案跟随语言', () => {
    const h = toolHarness()
    try {
      expect(render(h.tools, 'cron_create', {}, { id: 'job-1' })).toBe('已创建定时任务 job-1')
      h.setLocale('en')
      expect(render(h.tools, 'cron_create', {}, { id: 'job-1' })).toBe('Created scheduled job job-1')
      h.setLocale('zh')
      expect(render(h.tools, 'cron_create', {}, { id: 'job-1' })).toBe('已创建定时任务 job-1')
    } finally {
      h.dispose()
    }
  })

  it('cron_set_enabled / cron_run 的文案跟随语言', () => {
    const h = toolHarness()
    try {
      expect(render(h.tools, 'cron_set_enabled', {}, { jobId: 'job-1', enabled: true })).toBe('已启用定时任务 job-1')
      expect(render(h.tools, 'cron_set_enabled', {}, { jobId: 'job-1', enabled: false })).toBe('已停用定时任务 job-1')
      expect(render(h.tools, 'cron_run', {}, { started: true })).toBe('定时任务已触发')
      expect(render(h.tools, 'cron_run', {}, { started: false })).toBe('定时任务未能触发')
      h.setLocale('en')
      expect(render(h.tools, 'cron_set_enabled', {}, { jobId: 'job-1', enabled: true })).toBe('Enabled scheduled job job-1')
      expect(render(h.tools, 'cron_set_enabled', {}, { jobId: 'job-1', enabled: false })).toBe('Disabled scheduled job job-1')
      expect(render(h.tools, 'cron_run', {}, { started: true })).toBe('The scheduled job was triggered')
      expect(render(h.tools, 'cron_run', {}, { started: false })).toBe('The scheduled job could not be triggered')
    } finally {
      h.dispose()
    }
  })
})

describe('cron 工具抛出的错误按调用解析', () => {
  it('cron_create 的校验错误跟随语言', async () => {
    const h = toolHarness()
    try {
      const create = h.tools.get('cron_create')!
      await expect(create.execute({ name: 'x', cron: 'nope', prompt: 'p' }, EXEC))
        .rejects.toThrow('cron 表达式无效: nope')
      await expect(create.execute({ name: 'x', cron: '0 9 * * *', prompt: '' }, EXEC))
        .rejects.toThrow('必须提供 prompt（执行时发送给智能体会话的提示词）')
      await expect(create.execute({ name: 'x', cron: '0 9 * * *', prompt: 'p', permission: 'nope' }, EXEC))
        .rejects.toThrow('未知的权限预设: nope（可用：read, write）')

      h.setLocale('en')
      await expect(create.execute({ name: 'x', cron: 'nope', prompt: 'p' }, EXEC))
        .rejects.toThrow('invalid cron expression: nope')
      await expect(create.execute({ name: 'x', cron: '0 9 * * *', prompt: '' }, EXEC))
        .rejects.toThrow('prompt is required (the text sent to the agent session when the job runs)')
      await expect(create.execute({ name: 'x', cron: '0 9 * * *', prompt: 'p', permission: 'nope' }, EXEC))
        .rejects.toThrow('Unknown permission preset: nope (available: read, write)')
    } finally {
      h.dispose()
    }
  }, 20_000)

  it('cron_run 的「不存在 / 已在运行」错误跟随语言', async () => {
    const h = toolHarness()
    try {
      const run = h.tools.get('cron_run')!
      await expect(run.execute({ jobId: 'missing' }, EXEC)).rejects.toThrow('定时任务不存在: missing')
      h.setLocale('en')
      await expect(run.execute({ jobId: 'missing' }, EXEC)).rejects.toThrow('Scheduled job not found: missing')
    } finally {
      h.dispose()
    }
  }, 20_000)
})

describe('系统提示词公告在每次装配时取语言', () => {
  it('CRON_GUIDANCE 仍是中文源；cronGuidance(locale) 给出英文镜像', () => {
    expect(typeof CRON_GUIDANCE).toBe('string')
    expect(CRON_GUIDANCE).toContain('本机已安装 dsh-cron 插件')
    expect(hostT('zh', 'guidance.plugin')).toBe(CRON_GUIDANCE)
    const english = cronGuidance('en')
    expect(english).toContain('dsh-cron plugin installed')
    expect(english).toContain('cron_create / cron_list / cron_set_enabled / cron_run')
    // 英文公告里保留中文触发词是**有意的**（它告诉模型"用户说到「定时任务」就是指本
    // 插件"），但正文不能再是中文字串。
    expect(english).toContain('定时任务 / cron / scheduled execution')
    expect(english).not.toContain('关闭窗口或浏览器页面后仍会执行')
  })

  it('section 注册的是 thunk（每次装配重新解析，而不是注册期快照）', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('text: () => cronGuidance(hostLocaleOf(ctx))')
    expect(source).not.toContain('text: CRON_GUIDANCE')
  })

  it('hostLocaleOf 每次读探针（缺 desktopRuntime 时回落产品默认）', () => {
    const runtime: { locale?: unknown } = { locale: 'zh' }
    const ctx = { get: (name: string) => (name === 'desktopRuntime' ? runtime : undefined) }
    expect(hostLocaleOf(ctx)).toBe('zh')
    runtime.locale = 'en'
    expect(hostLocaleOf(ctx)).toBe('en')
    expect(hostLocaleOf({ get: () => undefined })).toBe('zh')
  })
})

describe('中文文案逐字节不变 + 模型面 description 保持中文', () => {
  it('zh 值与改造前逐字相同', () => {
    expect(hostT('zh', 'tool.created', { id: 'job-9' })).toBe('已创建定时任务 job-9')
    expect(hostT('zh', 'tool.setEnabled', { state: '已启用', jobId: 'job-9' })).toBe('已启用定时任务 job-9')
    expect(hostT('zh', 'tool.promptRequired')).toBe('必须提供 prompt（执行时发送给智能体会话的提示词）')
    expect(hostT('zh', 'tool.jobRunning', { jobId: 'job-9' })).toBe('定时任务 job-9 已在运行')
  })

  it('工具与参数 description 仍是中文（模型面策略）', () => {
    const h = toolHarness()
    try {
      const create = h.tools.get('cron_create')!
      expect(create.description).toContain('创建定时任务')
      const parameters = create.parameters as { properties?: Record<string, { description?: string }> }
      expect(parameters.properties?.cron?.description).toContain('5 段 cron 表达式')
      expect(parameters.properties?.prompt?.description).toContain('执行时发送给智能体会话的提示词内容')
      // 语言切换不影响 description（它们不是用户面文案）。
      h.setLocale('en')
      expect(h.tools.get('cron_create')!.description).toContain('创建定时任务')
      expect((h.tools.get('cron_create')!.parameters as { properties?: Record<string, { description?: string }> })
        .properties?.cron?.description).toContain('5 段 cron 表达式')
    } finally {
      h.dispose()
    }
  })
})

describe('客户端排印：全角括号随语言', () => {
  it('字典两侧都有 job.parenthesized，且 JobEditor 不再硬编码全角括号', () => {
    expect(clientZh['job.parenthesized']).toBe('（{text}）')
    expect(clientEn['job.parenthesized']).toBe(' ({text})')
    const source = readFileSync(new URL('../src/client/JobEditor.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/[（）]/u)
    expect(source).toContain("t('job.parenthesized'")
  })

  it('两本字典的键集合完全一致（新增键不会只出现在一边）', () => {
    expect(Object.keys(clientEn).sort()).toEqual(Object.keys(clientZh).sort())
  })
})
