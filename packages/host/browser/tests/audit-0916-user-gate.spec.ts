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
import {
  BROWSER_TOOL_TIMEOUT_MS,
  BROWSER_WAIT_FOR_DEADLINE_MS,
  USER_GATE_RESERVE_MS,
  USER_GATE_TIMEOUT_MS,
  WAIT_FOR_MAX_MS,
} from '../src/budgets.ts'
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

/**
 * 全部浏览器工具及其**应有**的注册预算（2026-09-17 审计 S03-03）。
 *
 * 逐个列出而不是从 tools.ts 反推：这张表就是"注册面"的清单——新增工具必须在这里
 * 出现（下面的集合断言会红），改名/删工具同理。旧用例只抽样了 `browser_list_tabs`
 * 一个，把 `interactSpecs` 三个工具的 `timeoutMs` 删掉整套测试仍然全绿（变异已证）。
 */
const EXPECTED_DEADLINES: Record<string, number> = {
  browser_open: BROWSER_TOOL_TIMEOUT_MS,
  browser_navigate: BROWSER_TOOL_TIMEOUT_MS,
  browser_reload: BROWSER_TOOL_TIMEOUT_MS,
  browser_go_back: BROWSER_TOOL_TIMEOUT_MS,
  browser_go_forward: BROWSER_TOOL_TIMEOUT_MS,
  browser_list_tabs: BROWSER_TOOL_TIMEOUT_MS,
  browser_switch_tab: BROWSER_TOOL_TIMEOUT_MS,
  browser_close_tab: BROWSER_TOOL_TIMEOUT_MS,
  browser_click: BROWSER_TOOL_TIMEOUT_MS,
  browser_type: BROWSER_TOOL_TIMEOUT_MS,
  browser_select: BROWSER_TOOL_TIMEOUT_MS,
  browser_press: BROWSER_TOOL_TIMEOUT_MS,
  browser_scroll: BROWSER_TOOL_TIMEOUT_MS,
  browser_fill_form: BROWSER_TOOL_TIMEOUT_MS,
  browser_upload_file: BROWSER_TOOL_TIMEOUT_MS,
  browser_get_snapshot: BROWSER_TOOL_TIMEOUT_MS,
  browser_get_text: BROWSER_TOOL_TIMEOUT_MS,
  browser_screenshot: BROWSER_TOOL_TIMEOUT_MS,
  // 唯一的长预算：用户闸 + 条件等待上限 + 余量（budgets.ts 是唯一真源）。
  browser_wait_for: BROWSER_WAIT_FOR_DEADLINE_MS,
  browser_eval: BROWSER_TOOL_TIMEOUT_MS,
  browser_bookmarks_add: BROWSER_TOOL_TIMEOUT_MS,
  browser_bookmarks_list: BROWSER_TOOL_TIMEOUT_MS,
  browser_bookmarks_remove: BROWSER_TOOL_TIMEOUT_MS,
  browser_history_search: BROWSER_TOOL_TIMEOUT_MS,
  browser_download: BROWSER_TOOL_TIMEOUT_MS,
  browser_downloads_list: BROWSER_TOOL_TIMEOUT_MS,
  browser_downloads_remove: BROWSER_TOOL_TIMEOUT_MS,
  browser_takeover: BROWSER_TOOL_TIMEOUT_MS,
  browser_fill_credentials: BROWSER_TOOL_TIMEOUT_MS,
  browser_clear_data: BROWSER_TOOL_TIMEOUT_MS,
  browser_credentials_list: BROWSER_TOOL_TIMEOUT_MS,
}

/**
 * 注册**全部**工具。runtime 只需要一个惰性桩：工具定义（含 timeoutMs/description）
 * 在注册期求值，execute/render 里的 runtime 引用此时不会被解引用。
 */
function registerAllTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const stub: unknown = new Proxy(function () {}, {
    get: () => stub,
    apply: () => stub,
    construct: () => stub,
  })
  const ctx = {
    tools: { register: (definition: RegisteredTool) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  applyBrowserTools(ctx, stub as BrowserRuntime)
  return tools
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
    // wait_for 的预算必须覆盖 闸门 + 条件等待上限 + 余量，否则一次满额等待会被
    // timeout-policy 换成笼统超时（2026-09-16 R2-E4）。
    expect(BROWSER_WAIT_FOR_DEADLINE_MS).toBeGreaterThan(USER_GATE_TIMEOUT_MS + WAIT_FOR_MAX_MS)
  })

  it('**每一个**注册工具的预算都来自 budgets.ts（单一真源；不是抽样一个）', () => {
    const tools = registerAllTools()
    // 注册面完整性：少注册/改名都算回归（这条同时钉住"清单与实现同步"）。
    expect([...tools.keys()].sort()).toEqual(Object.keys(EXPECTED_DEADLINES).sort())
    const wrong: string[] = []
    for (const [name, expected] of Object.entries(EXPECTED_DEADLINES)) {
      const actual = tools.get(name)?.timeoutMs
      if (actual !== expected) wrong.push(`${name}: ${String(actual)} ≠ ${String(expected)}`)
    }
    // 预算缺失（undefined）也落在这里：上游 timeout-policy 会退回它自己的缺省，
    // 现场表现就是"闸门还没走完、工具先被超时换掉"。
    expect(wrong).toEqual([])
    // 兜底扫一遍：任何注册工具都不许漏掉 deadline。
    for (const [name, tool] of tools) {
      expect(tool.timeoutMs, `${name} 没有注册 timeoutMs`).toBeTypeOf('number')
    }
  })

  it('池子的默认闸门预算取自 budgets.ts（部署走的正是这个缺省）', () => {
    // 生产路径上 index.ts 不覆盖 userGateTimeoutMs，所以这个缺省值就是现场行为。
    // 回归护栏：把 300s 改回去会让上面的不等式测试变红。
    expect(new TabPool().options.userGateTimeoutMs).toBe(USER_GATE_TIMEOUT_MS)
  })

  it('配额等待预算也必须留在工具预算之内（2026-09-17 审计 S01-1）', () => {
    // 池子满了以后 reserveTab 会等到 waitTimeoutMs；它比工具 deadline 长的话，
    // 排队中的 browser_open 只会拿到 `tool call timed out after 30000ms`，
    // 池子自己的 "tab limit reached"/"timed out waiting for a tab slot" 全被吞掉。
    const pool = new TabPool()
    expect(pool.options.waitTimeoutMs).toBeLessThan(BROWSER_TOOL_TIMEOUT_MS)
    expect(pool.options.waitTimeoutMs + USER_GATE_TIMEOUT_MS).toBeLessThan(BROWSER_TOOL_TIMEOUT_MS)
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
    // 标签页信息本身不受影响。2026-09-23 审计 CP-1：render 与 JSON 出口同构，
    // 行首补上 `[kind]`（应用窗口那半边的 `app_id` 同理），所以这里跟着更新。
    expect(text).toContain('3: [browser-tab] 首页')
  })

  it('没有控制权争议时不出现任何提示（防止误报）', async () => {
    const tool = registerListTabs(
      { controlled: false, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '' },
      [{ id: 1, url: 'https://a.example', title: 'A', loading: false, visible: true }],
    )
    const text = render(tool, await tool.execute({}, exec))
    expect(text).toBe('1: [browser-tab] A (active)')
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
