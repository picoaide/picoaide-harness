/**
 * 2026-09-16 用户闸定案回归（客户会话 session-88502514-b5ac-4e41-be91-765db8b96fc1）。
 *
 * 现场：AI 用 `browser_takeover` 把控制权交给用户去登录销售易，用户登录完只在
 * 聊天里说"我已经登录"、没有点「交给 AI」。此后 agent 的每一次浏览器调用都排在
 * 用户闸后面等，而闸门预算（300s）比工具预算（30s）长 —— 上游 timeout-policy 先
 * 把调用换成了 `tool call timed out after 30000ms`，2026-09-15 特意加的明确错误
 * 一次都没送达。13 次超时全部落在走闸门的工具上，纯读元数据的 list_tabs 反而
 * 0 秒返回。本文件盯住三条修复：预算不变量、模型面可见性、客户端提示。
 */
import { describe, expect, it } from 'vitest'
import { BROWSER_TOOL_TIMEOUT_MS, USER_GATE_RESERVE_MS, USER_GATE_TIMEOUT_MS } from '../src/budgets.ts'
import { TabPool } from '../src/pool.ts'
import { applyBrowserTools } from '../src/tools.ts'
import type { BrowserRuntime } from '../src/runtime.ts'
import { NO_CONTROL_HINT, readControlHint, showsWaitingHint } from '../src/client/control-hint.ts'

interface RegisteredTool {
  name: string
  timeoutMs?: number
  execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> }
}

/** 只实现 list_tabs 用到的那几个入口：这是模型面出口的最小面。 */
function registerListTabs(control: Record<string, unknown>, tabs: unknown[] = []): RegisteredTool {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    tools: { register: (definition: RegisteredTool) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const runtime = {
    setAgentContext: () => {},
    listTabs: () => tabs,
    controlState: () => control,
  } as unknown as BrowserRuntime
  applyBrowserTools(ctx, runtime, new Set(['navigate']))
  const tool = tools.get('browser_list_tabs')
  if (tool === undefined) throw new Error('browser_list_tabs was not registered')
  return tool
}

const exec = { signal: new AbortController().signal, agent: undefined }

function render(tool: RegisteredTool, value: unknown): string {
  return tool.output.render({}, value).map((part) => part.text ?? '').join('\n')
}

describe('浏览器预算不变量（2026-09-16）', () => {
  it('用户闸等待预算必须留在工具预算之内', () => {
    // 工具 deadline 一到，timeout-policy 会替换整条结果；闸门预算再长也没有意义，
    // 只会把"用户正拿着控制权"这件事变成一句笼统的超时。
    expect(USER_GATE_TIMEOUT_MS).toBeLessThan(BROWSER_TOOL_TIMEOUT_MS)
    // 闸门打开后还要跑完这次操作（导航/截图/回落），所以余量不能太薄。
    expect(BROWSER_TOOL_TIMEOUT_MS - USER_GATE_TIMEOUT_MS).toBe(USER_GATE_RESERVE_MS)
    expect(USER_GATE_RESERVE_MS).toBeGreaterThanOrEqual(10_000)
    expect(USER_GATE_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('每个浏览器工具注册的预算就是 BROWSER_TOOL_TIMEOUT_MS（单一真源）', () => {
    const tool = registerListTabs({ controlled: false, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '' })
    expect(tool.timeoutMs).toBe(BROWSER_TOOL_TIMEOUT_MS)
  })

  it('池子的默认闸门预算取自 budgets.ts（部署走的正是这个缺省）', () => {
    // 生产路径上 index.ts 不覆盖 userGateTimeoutMs，所以这个缺省值就是现场行为。
    // 回归护栏：把 300s 改回去会让上面的不等式测试变红。
    expect(new TabPool().options.userGateTimeoutMs).toBe(USER_GATE_TIMEOUT_MS)
  })
})

describe('browser_list_tabs 报告控制权（2026-09-16）', () => {
  it('用户持有控制权时，模型面输出直接说明要交还控制权（2026-09-16 i18n：模型面统一英文，按功能描述按钮而非写死某个语言的按钮名）', async () => {
    const tool = registerListTabs(
      { controlled: true, busy: false, busyTool: '', awaitingRelease: true, awaitingReleaseTool: 'browser_eval' },
      [{ id: 3, url: 'https://crm.example/home', title: '首页', loading: false, visible: true }],
    )
    const value = await tool.execute({}, exec)
    expect(value.control).toMatchObject({ controlled: true, awaitingRelease: true, awaitingReleaseTool: 'browser_eval' })
    const text = render(tool, value)
    expect(text).toContain('USER HOLDS CONTROL')
    expect(text).toContain('hands control back from the browser window')
    // 模型面不许再写死某个语言的按钮名（英文界面下那是错的）
    expect(text).not.toContain('交给 AI')
    expect(text).not.toContain('我来操作')
    // 已经被拒过的那次调用要被点名，模型才知道"别瞎重试"
    expect(text).toContain('browser_eval')
    // 标签页信息本身不受影响
    expect(text).toContain('3: 首页')
  })

  it('没有控制权争议时不出现任何提示（防止误报）', async () => {
    const tool = registerListTabs(
      { controlled: false, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '' },
      [{ id: 1, url: 'https://a.example', title: 'A', loading: false, visible: true }],
    )
    const text = render(tool, await tool.execute({}, exec))
    expect(text).toBe('1: A (active)')
    expect(text).not.toContain('USER HOLDS CONTROL')
  })

  it('用户接管但还没被拒（AI 空闲）时也只说"会被拒"，不谎报已经等待', async () => {
    const tool = registerListTabs(
      { controlled: true, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '' },
      [],
    )
    const text = render(tool, await tool.execute({}, exec))
    expect(text).toContain('No tabs open in this window.')
    expect(text).toContain('USER HOLDS CONTROL')
    expect(text).not.toContain('do NOT retry blindly')
  })
})

describe('侧边栏控制权提示投影（2026-09-16）', () => {
  it('只有 awaitingRelease 才算"AI 在等你交还"', () => {
    expect(showsWaitingHint(readControlHint({ controlled: true, awaitingRelease: true }))).toBe(true)
    // 用户自己在用浏览器、AI 没有动作：不报警
    expect(showsWaitingHint(readControlHint({ controlled: true, awaitingRelease: false }))).toBe(false)
    expect(showsWaitingHint(readControlHint({ controlled: false, awaitingRelease: false }))).toBe(false)
  })

  it('未知/畸形载荷一律退回"无提示"', () => {
    for (const payload of [null, undefined, 'nope', 42, [], {}, { controlled: 'yes', awaitingRelease: 1 }]) {
      expect(readControlHint(payload)).toEqual(NO_CONTROL_HINT)
    }
  })
})
