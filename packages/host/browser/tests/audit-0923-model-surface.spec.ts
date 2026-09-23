/**
 * 2026-09-23 独立审计 D（浏览器）—— CP-1 / SN-1 / EV-1 的回归用例。
 *
 * 三条都是"模型面出口"缺陷：CP-1 render 与 JSON 不同构（应用窗口在模型眼里是空白
 * 行）、SN-1 选择器与判定器不同口径（明列的可交互元素既不列也不计数）、EV-1 脱敏
 * 过宽（普通正文只要"提到"敏感词就整串 `****`，与 `browser_get_text` 自相矛盾）。
 *
 * 变异验证（改回旧行为必红）：
 *  · CP-1：把 `formatTabs` 的行模板改回 `${t.id}: ${t.title || t.url}` ⇒ 第一组红
 *    （JSON 里每个 tab 的 kind / app 行的 app_id 在 render 里找不到）；
 *  · SN-1：把 `kindOf` 末尾的 `return 'other'` 删回 `return null` ⇒ 第二组红
 *    （tabindex/role=menuitem/无 href 的 a 既不在结果里，也不进 total）；
 *  · EV-1：把 `maskString` 的片段级判定改回 `SECRET_VALUE.test(value) ⇒ MASK` ⇒
 *    第三组红（普通散文变 `****`）。
 */
import { describe, expect, it } from 'vitest'
import { applyBrowserTools } from '../src/tools.ts'
import { extractSnapshotWithMeta } from '../src/snapshot.ts'
import { serializeEvalResult } from '../src/eval-policy.ts'
import type { BrowserRuntime } from '../src/runtime.ts'
import type { BrowserSnapshotElement } from '../src/types.ts'

type RegisteredTool = Parameters<typeof applyBrowserTools>[0]['tools']['register'] extends (definition: infer T) => unknown ? T : never
/** 工具执行上下文（模型面用例只需要 `signal`/`agent` 两项，其余用显式断言补齐）。 */
type ToolExec = Parameters<RegisteredTool['execute']>[1]

function render(tool: RegisteredTool, value: unknown): string {
  // `render` 产出的是 ContentBlock 联合（文本/图片…）：只取文本块，别把图片块当成
  // 文本读（`part.text` 在联合上不存在，2026-09-23 门禁回归时被严格类型检查抓到）。
  return tool.output.render({}, value as never)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
}

const exec = { signal: new AbortController().signal } as unknown as ToolExec

/** 只实现 list_tabs 用到的面（模型面出口的最小面，与既有用例同形）。 */
function listTabsTool(options: {
  control: Record<string, unknown>
  tabs: unknown[]
  appSurfaces: Array<{ id: number, appId: string }>
}): RegisteredTool {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    tools: { register: (definition: RegisteredTool) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const runtime = {
    setAgentContext: () => {},
    listTabs: () => options.tabs,
    controlState: () => options.control,
    syncSurfaces: () => {},
    surfaces: { appSurfaces: () => options.appSurfaces },
  } as unknown as BrowserRuntime
  applyBrowserTools(ctx, runtime, new Set(['navigate']))
  const tool = tools.get('browser_list_tabs')
  if (tool === undefined) throw new Error('browser_list_tabs was not registered')
  return tool
}

describe('CP-1 browser_list_tabs 的 render 与 JSON 出口同构（2026-09-23 审计）', () => {
  // `listTabs()` 只含浏览器标签（应用窗口来自 surface 注册表）；行里的 active
  // 由 `t.visible` 投影而来。
  const browserTab = { id: 1, url: 'https://example.com/', title: 'Example', loading: false, visible: true, favicon: '', canGoBack: false, canGoForward: false, crashed: false }
  const appSurfaces = [{ id: 65_537, appId: 'notes' }]

  it('每一个 tab 行的 kind 都出现在模型读到的文本里，应用窗口带上 app_id（不是空白行）', async () => {
    const tool = listTabsTool({
      control: { controlled: false, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '' },
      tabs: [browserTab],
      appSurfaces,
    })
    const value = await tool.execute({}, exec) as { tabs: Array<{ id: number, kind: string, app_id: string }> }
    const text = render(tool, value)

    // 同构判据：JSON 出口里有的身份字段，render 里必须都有（防单侧漂移）。
    for (const tab of value.tabs) {
      expect(text, `kind of tab ${tab.id}`).toContain(`[${tab.kind}]`)
      if (tab.kind === 'app') expect(text, `app_id of tab ${tab.id}`).toContain(tab.app_id)
    }
    expect(text).toContain('1: [browser-tab] Example (active)')
    expect(text).toContain('65537: [app] app_id=notes')
    // 旧实现这里是 `"65537: "`（title/url 恒为空）—— 模型眼中的空白行。
    expect(text).not.toContain('65537: \n')
  })

  it('用户按住某个应用窗口时，render 也说出是哪一个（JSON 的 control.userHeldSurfaces 不只给 presenter）', async () => {
    const tool = listTabsTool({
      control: {
        controlled: false, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '',
        userHeldSurfaces: [{ id: 65_537, appId: 'notes' }],
      },
      tabs: [browserTab],
      appSurfaces,
    })
    const text = render(tool, await tool.execute({}, exec))
    expect(text).toContain('USER HOLDS CONTROL OF APPLICATION WINDOW(S)')
    expect(text).toContain('notes')
    // 池级 controlled 仍是 false ⇒ 不许谎报"整个浏览器都不能动"。
    expect(text).not.toContain('USER HOLDS CONTROL:')
  })

  it('崩溃终态在模型面可见（BR-2 的出路提示）', async () => {
    const crashedTab = { ...browserTab, crashed: true }
    const tool = listTabsTool({
      control: { controlled: false, busy: false, busyTool: '', awaitingRelease: false, awaitingReleaseTool: '' },
      tabs: [crashedTab],
      appSurfaces: [],
    })
    const text = render(tool, await tool.execute({}, exec))
    expect(text).toContain('crashed')
    expect(text).toContain('browser_reload')
  })
})

// --------------------------------------------------------------------------
// SN-1：真跑探针脚本，DOM 桩**按选择器匹配**（否则 SEL 的口径根本测不到）
// --------------------------------------------------------------------------

class FakeElement {
  nodeType = 1
  id = ''
  disabled = false
  innerText = ''
  textContent = ''
  parentElement: FakeElement | null = null
  previousElementSibling: FakeElement | null = null
  private readonly attrs: Record<string, string>
  /** DOM 属性（不是 attribute）：`kindOf` 读的是 `el.type`，只有 attribute 拿不到。 */
  type: string
  constructor(readonly tagName: string, attrs: Record<string, string> = {}) {
    this.attrs = attrs
    this.type = attrs.type ?? ''
    this.innerText = attrs.text ?? ''
    this.textContent = this.innerText
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null }
  getBoundingClientRect(): { width: number, height: number, top: number, bottom: number, left: number, right: number } {
    return { width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }
  }
}

/** 极简选择器匹配：只覆盖探针 SEL 用到的形态（标签 / [role="x"] / [tabindex]:not([-1])）。 */
function matchesSelector(element: FakeElement, selector: string): boolean {
  const clause = selector.trim()
  if (clause.startsWith('[')) {
    if (clause.startsWith('[tabindex]')) {
      const tabindex = element.getAttribute('tabindex')
      // 探针里的形态是 `[tabindex]:not([tabindex="-1"])`
      return tabindex !== null && tabindex !== '-1' && clause.includes('not(')
    }
    const match = /^\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(clause)
    return match !== null && element.getAttribute(match[1]!) === match[2]
  }
  return element.tagName.toLowerCase() === clause.toLowerCase()
}

/** Run the REAL probe script against a selector-aware fake DOM. */
async function snapshotOf(nodes: FakeElement[]): Promise<{ elements: BrowserSnapshotElement[], total: number, truncated: boolean }> {
  const root = {
    nodeType: 1,
    tagName: 'BODY',
    querySelectorAll: (selector: string) => {
      const clauses = String(selector).split(',')
      return nodes.filter((node) => clauses.some((clause) => matchesSelector(node, clause)))
    },
  }
  const send = async (_method: string, params?: Record<string, unknown>) => {
    const expression = String(params?.expression)
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', `return (${expression})`)
    const value = evaluate(
      { body: root, documentElement: root },
      () => ({ display: 'block', visibility: 'visible' }),
      1024,
      768,
    )
    return { result: { value } } as never
  }
  const out = await extractSnapshotWithMeta(send as never)
  return { elements: out.elements, total: out.meta.total, truncated: out.meta.truncated }
}

describe('SN-1 SEL 明列的可交互元素必须进入枚举与计数（2026-09-23 审计）', () => {
  it('tabindex 容器 / role=menuitem / 无 href 的 a 都要出现，且 total 反映真实命中数', async () => {
    const nodes = [
      new FakeElement('BUTTON', { text: 'Save' }),
      new FakeElement('DIV', { tabindex: '0', text: 'Card' }),
      new FakeElement('DIV', { role: 'menuitem', text: 'Export' }),
      new FakeElement('A', { text: 'Placeholder link' }),          // 无 href
      new FakeElement('DIV', { tabindex: '-1', text: 'Not tabbable' }), // 明确排除
      new FakeElement('INPUT', { type: 'hidden' }),                  // 不可交互
    ]
    const { elements, total } = await snapshotOf(nodes)
    const texts = elements.map((element) => element.text)

    expect(texts).toContain('Save')
    expect(texts).toContain('Card')
    expect(texts).toContain('Export')
    expect(texts).toContain('Placeholder link')
    expect(texts).not.toContain('Not tabbable')
    // 「盲区可见」这条承诺：明列元素不许既不列也不计数（旧实现 total 只有 1）。
    expect(total).toBe(elements.length)
    expect(total).toBe(4)
    // 判定器口径：标签→既有 kind，其余落到 'other'（宿主的 kind 契约内）。
    const byText = new Map(elements.map((element) => [element.text, element.kind]))
    expect(byText.get('Save')).toBe('button')
    // 映射表里的 ARIA 控件角色按既有 kind 报（menuitem → button），
    // 只有映射表外的（这里是 [tabindex] 容器）才落到 'other'。
    expect(byText.get('Export')).toBe('button')
    expect(byText.get('Card')).toBe('other')
    expect(byText.get('Placeholder link')).toBe('other')
  })

  it('role=button / role=link 仍然映射成既有 kind（不是一律 other）', async () => {
    const nodes = [
      new FakeElement('DIV', { role: 'button', text: 'Fake button' }),
      new FakeElement('SPAN', { role: 'link', text: 'Fake link' }),
    ]
    const { elements } = await snapshotOf(nodes)
    expect(elements.map((element) => `${element.text}:${element.kind}`)).toEqual(['Fake button:button', 'Fake link:link'])
  })
})

// --------------------------------------------------------------------------
// EV-1：browser_eval 的脱敏必须只擦敏感片段
// --------------------------------------------------------------------------

describe('EV-1 browser_eval 的结果脱敏只擦片段（2026-09-23 审计）', () => {
  it('普通正文提到 token/password/secret 时保持可读（与 browser_get_text 同口径）', () => {
    expect(serializeEvalResult('This page explains token budgets')).toBe('"This page explains token budgets"')
    expect(serializeEvalResult('password reset instructions')).toBe('"password reset instructions"')
    expect(serializeEvalResult('the secret garden')).toBe('"the secret garden"')
    expect(serializeEvalResult('The token authentication mechanism')).toBe('"The token authentication mechanism"')
  })

  it('真正的凭据仍然被打码：cookie 串、key=value、认证头、JWT、长 opaque 串', () => {
    // 整串即凭据（这些形态不许因为"改窄"而漏掉）。
    expect(serializeEvalResult('sid=abc123; theme=dark')).toBe('"****"')
    expect(serializeEvalResult('jsessionid=ABC123')).toBe('"****"')
    expect(serializeEvalResult('Bearer abc.def.ghi')).toBe('"****"')
    expect(serializeEvalResult('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop')).toBe('"****"')
    expect(serializeEvalResult('sk-1234567890abcdefghijklmn')).toBe('"****"')
    // 片段级：只有值被擦，正文留下。
    expect(serializeEvalResult('access_token=abcdef123456&page=2')).toBe('"access_token=****&page=2"')
    expect(serializeEvalResult({ token: 'abc-token-123' })).toBe('{"token":"****"}')
    expect(serializeEvalResult({ code: 'token' })).toBe('{"code":"token"}')
    // 关键词后紧跟的 opaque 串（Bearer 之外的手写形态）。
    expect(serializeEvalResult('token abc123def456')).toBe('"token ****"')
  })

  it('超长正文里的凭据仍不会以明文逃出（先掩码后截断的顺序不变）', () => {
    const longToken = `prefix ${'y'.repeat(4200)} token=super-secret-value`
    const out = serializeEvalResult(longToken)
    expect(out).not.toContain('super-secret-value')
    expect(out.endsWith('…"')).toBe(true)
  })
})
