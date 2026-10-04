/**
 * 2026-10-04 P1：内置浏览器「控制权交还入口消失」三条修复的回归判据。
 *
 * 用户报告（原话）：「我用浏览器打开内容，然后用 AI 打开那个浏览器、操作浏览器、
 * 进入网页，然后我的控制浏览器按钮就会不见。」
 *
 * 定位（主控已完成视觉量测，本文件把它钉成判据）：
 *  ① 交权的那一刻蒙版被撤下、overlay 视图缩成右下角一小块，整个窗口里只剩一个 24px
 *     高的「交给 AI」按钮 —— 这就是"按钮不见了"；
 *  ② 聊天窗口那一侧只认 `awaitingRelease`（"某次 agent 调用真的被闸门拒过"）⇒ AI 交权后
 *     **直接停下等人**（引导式登录的常规走法）时 `awaitingRelease` 还是 false，零提示；
 *  ③ `browser_takeover` 的工具结果只有一句 `Control handed to the user.`（作者注：
 *     2026-10-04 核验订正 —— `output.render` 是**模型面**内容，不是用户文案，
 *     所以本文件钉的是"英文、有信息量、零 CJK、零本地化控件名"，用户可见的
 *     本地化指引钉在浏览器窗口胶囊与侧边栏条目那两条上）。
 *
 * 三条修复的判据分布（同一份修复的其它面不重复钉）：
 *  - ① 宿主矩形 / 页面 CSS 的逐像素对齐 + 提示矩形合成 → 本文件（runtime + 页面产物）；
 *    页面行为（jsdom 真渲染出的可见文案与按钮）→ `shell-pages.behavior.spec.ts`；
 *  - ② 纯投影三档 → 本文件；「更多」条目行为（attention / 标题 / 可操作 tooltip）
 *    → `client-foot-entry.spec.ts`；行级可访问名 → `packages/client/foot-menu/tests`；
 *  - ③ 模型面结果文案（英文 + 零 CJK）+ 用户可见指引仍在本地化面上 → 本文件。
 *
 * ---- 变异验证（逐条实跑，证据见 temp/audit-v282/fixes/P1.md）----
 *   - 胶囊退回 172×34（或只改宿主不改 `.s-capsule` 的高度）⇒「胶囊矩形」与
 *     「CSS 逐像素对齐」两条红；
 *   - `showsControlHint` / 条目 attention 退回只看 `awaitingRelease` ⇒
 *     「controlled 即提示」红；
 *   - takeover 文案改回中文（字面量）⇒ 本文件的「零中文」+ 文件级守卫
 *     `shell-pages-locale.spec.ts` 同时红；
 *   - 只在英文句里插一个中文字符 ⇒ 同一对判据同样红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostLocale } from '@picoaide/dsh-host-locale'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import { browserOverlayHtml } from '../src/shell-pages.ts'
import {
  controlHintLevel,
  NO_CONTROL_HINT,
  readControlHint,
  showsControlHint,
  showsWaitingHint,
} from '../src/client/control-hint.ts'
import type { NativeBounds, NativeSession } from '../src/electron-adapter.ts'

const CONTENT = { width: 1100, height: 780 }
/** 胶囊/提示矩形共用的右下角边距（宿主矩形与页面 CSS 都按它锚定）。 */
const CAPSULE_MARGIN = 16

// ------------------------------------------------------------------ mocks

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-handback'
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
}

class MockView {
  session = new MockSession()
  attached = false
  visible = false
  destroyed = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  focus = vi.fn()
  attach(_win: unknown, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds }
  setBounds(bounds: NativeBounds): void { this.bounds = bounds }
  setVisible(visible: boolean): void { this.visible = visible }
  detach(): void { this.attached = false }
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  get webContents(): never {
    return {
      cdp: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}), on: () => {}, removeListener: () => {} },
      loadURL: async () => {},
      getURL: () => 'about:blank',
      getTitle: () => 'mock',
      isLoading: () => false,
      on: () => {},
      removeListener: () => {},
      session: this.session,
      setWindowOpenHandler: () => {},
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
      stop: () => {},
      focus: () => {},
      capturePage: async () => { throw new Error('unused') },
    } as never
  }
}

class MockWindow {
  visible = false
  destroyed = false
  children: unknown[] = []
  focusPage = vi.fn()
  loadURL = vi.fn(async () => {})
  show(): void { this.visible = true }
  hide(): void { this.visible = false }
  close(): void { this.destroyed = true }
  isVisible(): boolean { return this.visible }
  isMinimized(): boolean { return false }
  isFocused(): boolean { return true }
  isDestroyed(): boolean { return this.destroyed }
  setTitle(): void {}
  getContentSize(): { width: number; height: number } { return { ...CONTENT } }
  onResize(): () => void { return () => {} }
  onClosed(): () => void { return () => {} }
  onFocus(): () => void { return () => {} }
  contentView = {
    addChildView: (view: unknown): void => { this.children.push(view) },
    removeChildView: (view: unknown): void => {
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    },
    get children(): readonly unknown[] { return this.children },
  }
}

class MockAdapter {
  views: MockView[] = []
  overlays: MockView[] = []
  windows: MockWindow[] = []
  partitionSession = new MockSession()
  createView(): never { const view = new MockView(); this.views.push(view); return view as never }
  createMaskView(): never { const view = new MockView(); this.overlays.push(view); return view as never }
  createBrowserWindow(): never { const win = new MockWindow(); this.windows.push(win); return win as never }
  getSession(): NativeSession { return this.partitionSession }
}

const storeDirs: string[] = []

afterEach(() => {
  for (const dir of storeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRuntime(locale?: () => HostLocale): { runtime: BrowserRuntime; adapter: MockAdapter } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.handback-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  storeDirs.push(dir)
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, {
    store: new BrowserStore({ dir }),
    ...(locale === undefined ? {} : { locale }),
  })
  return { runtime, adapter }
}

/** 页面产物里 `.s-capsule` 基础规则（必须锚行首，否则会命中 display 规则）。 */
function capsuleRule(locale: HostLocale = 'zh'): string {
  return /^[ \t]*\.s-capsule \{([^}]*)\}/mu.exec(browserOverlayHtml(locale))?.[1] ?? ''
}

/** 页面产物里 `.s-capsule .take` 规则（交还按钮本体）。 */
function takeRule(locale: HostLocale = 'zh'): string {
  return /^[ \t]*\.s-capsule \.take \{([^}]*)\}/mu.exec(browserOverlayHtml(locale))?.[1] ?? ''
}

// ---------------------------------------------------------- ① 交还入口显眼

describe('① 交还入口在浏览器窗口里一眼可见（胶囊几何 / 文案 / 单一入口）', () => {
  it('用户持控制权时的胶囊矩形不再是一小块：≥260×40，右下角锚点仍是 16px', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const overlay = adapter.overlays[0]!
    runtime.setUserControl(true, 'user')

    const bounds = overlay.bounds
    // 它同时是"控制权在你手里"的唯一可见载体：旧值 172×34 里那个 24px 高的按钮
    // 就是用户报的"按钮不见了"。
    expect(bounds.width).toBeGreaterThanOrEqual(260)
    expect(bounds.height).toBeGreaterThanOrEqual(40)
    // 旧几何（2026-09-21 的紧凑胶囊）退回去必须红。
    expect({ width: bounds.width, height: bounds.height }).not.toEqual({ width: 172, height: 34 })
    // 锚点与边距不变：右/下各 16px。
    expect(bounds.x + bounds.width).toBe(CONTENT.width - CAPSULE_MARGIN)
    expect(bounds.y + bounds.height).toBe(CONTENT.height - CAPSULE_MARGIN)
    await runtime.dispose()
  })

  it('宿主矩形与页面 CSS 逐像素对齐（视图矩形就是布局）：高度必须同源', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    runtime.setUserControl(true, 'user')
    const bounds = adapter.overlays[0]!.bounds

    // 改一侧不改另一侧 = 胶囊被视图裁掉或底部悬空，所以这条对拍是硬判据。
    const rule = capsuleRule()
    expect(rule, '.s-capsule 基础规则').toContain(`height: ${bounds.height}px`)
    expect(rule).toContain('bottom: 0')
    expect(rule).toContain('left: 0')
    expect(rule).toContain('right: 0')
    expect(rule).not.toContain('height: 100%')
    // 交还按钮本体也一起加高（24px → 30px）：只放大容器、按钮还是小不点等于没修。
    const button = takeRule()
    expect(button, '.s-capsule .take 规则').toMatch(/height: (\d+)px/u)
    expect(Number(/height: (\d+)px/u.exec(button)?.[1])).toBeGreaterThanOrEqual(28)
    await runtime.dispose()
  })

  it('失败提示放大矩形与胶囊同宽同锚点（弹 toast 时胶囊不被压扁、不横跳）', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const overlay = adapter.overlays[0]!
    runtime.setUserControl(true, 'user')
    const capsule = { ...overlay.bounds }

    runtime.setOverlayNotice(true)
    const notice = { ...overlay.bounds }
    // 2026-09-21 缺陷 #7 的既有路径：提示矩形只是"胶囊 + 上方一块 toast 区域"。
    expect(notice.width).toBe(capsule.width)
    expect(notice.x).toBe(capsule.x)
    expect(notice.y + notice.height).toBe(capsule.y + capsule.height)
    expect(notice.height).toBeGreaterThan(capsule.height)

    runtime.setOverlayNotice(false)
    expect(overlay.bounds).toEqual(capsule)
    await runtime.dispose()
  })

  it('页面文案：状态说"控制权在你手里"、按钮说"交给 AI"、提示指向浏览器窗口里的这个按钮', () => {
    const zh = browserOverlayHtml('zh')
    expect(zh).toContain('控制权在你手里')
    expect(zh).toContain('交给 AI')
    expect(zh).toContain('点这里交还给 AI')
    const en = browserOverlayHtml('en')
    expect(en).toContain('You have control')
    expect(en).toContain('Hand back to AI')
  })

  it('仍然只有同一个按钮能改变控制权：页面里没有第二条交还路径', () => {
    const html = browserOverlayHtml('zh')
    // takeControl = 定义 1 处 + 两个状态各绑定 1 处（#ai-take / #pill-take）= 恰好 3。
    expect(html.match(/takeControl\(/gu)).toHaveLength(3)
    // 写面调用点恰好 1 处（唯一的那个按钮）；新增任何入口都会让计数变化。
    expect(html.match(/post\('takeover'/gu)).toHaveLength(1)
    // 蒙版空白处仍然不可点（2026-09-11 定案 A 方案）。
    expect(html).not.toContain("$('mask').addEventListener")
    // Esc 只关浮层，不交还控制权。
    expect(html).not.toContain("if (state.controlled) post('takeover'")
  })
})

// ------------------------------------------------------ ② controlled 即提示

describe('② 客户端提示：controlled 即提示（三档），awaiting 语义不退化', () => {
  it('controlled=true 且 awaitingRelease=false ⇒ holding（旧实现这里是零提示 = 用户报告的缺陷）', () => {
    const hint = readControlHint({ controlled: true, awaitingRelease: false })
    expect(controlHintLevel(hint)).toBe('holding')
    expect(showsControlHint(hint)).toBe(true)
    // AI 没被拒过就**不许**说"AI 在等你"（不谎报）。
    expect(showsWaitingHint(hint)).toBe(false)
  })

  it('awaitingRelease=true ⇒ waiting（既有报警级语义一字不改）', () => {
    const hint = readControlHint({ controlled: true, awaitingRelease: true })
    expect(controlHintLevel(hint)).toBe('waiting')
    expect(showsControlHint(hint)).toBe(true)
    expect(showsWaitingHint(hint)).toBe(true)
    // awaiting 蕴含"用户持控制权"；载荷自相矛盾时以更严重的那个为准（不静默降级）。
    expect(controlHintLevel({ controlled: false, awaiting: true })).toBe('waiting')
  })

  it('controlled=false ⇒ none：用户没在用浏览器时不许有任何提示（防噪音底线）', () => {
    expect(controlHintLevel(NO_CONTROL_HINT)).toBe('none')
    expect(showsControlHint(NO_CONTROL_HINT)).toBe(false)
    expect(showsWaitingHint(NO_CONTROL_HINT)).toBe(false)
    for (const payload of [null, undefined, 'nope', 42, [], {}, { controlled: 'yes', awaitingRelease: 1 }]) {
      expect(showsControlHint(readControlHint(payload))).toBe(false)
    }
  })
})

// ------------------------------------------- ③ takeover 的会话内可见结果（模型面）

interface RegisteredTool {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> }
}

/** 只注册 control 分组（`browser_takeover` 在这里）；ctx 只记登记表。 */
function registerControlTools(runtime: BrowserRuntime): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    tools: { register: (definition: RegisteredTool) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  applyBrowserTools(ctx, runtime, new Set(['control']))
  return tools
}

function renderText(tool: RegisteredTool): string {
  return tool.output.render({}, { ok: true }).map((part) => part.text ?? '').join('\n')
}

describe('③ browser_takeover 的结果留在会话里可读（模型面口径，2026-10-04 核验订正）', () => {
  it('结果说清控制权在谁手里 + 交还途径（英文，与 description/系统提示词同语言）', () => {
    const { runtime } = makeRuntime()
    const tool = registerControlTools(runtime).get('browser_takeover')!
    const text = renderText(tool)
    expect(typeof text).toBe('string')
    // 旧文案（"Control handed to the user."，零信息）退回去必须红。
    expect(text).not.toBe('Control handed to the user.')
    expect(text).toContain('Control is now with the user')
    // 交还途径用**功能描述**，不写任何本地化控件名（写死任一种语言对另一种语言的
    // 用户就是一条指向不存在控件的指令 —— 同 2026-09-17 S01-4 的口径）。
    expect(text).toContain('hand-back control in the browser window')
    expect(text).toContain('waits')
  })

  it('模型面**零中文**：render 结果与 description 都不含 CJK（上游 render = 模型内容）', () => {
    const { runtime } = makeRuntime()
    const tool = registerControlTools(runtime).get('browser_takeover')!
    const HAN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff]/u
    expect(renderText(tool).match(HAN)).toBeNull()
    expect(tool.description!.match(HAN)).toBeNull()
    // 本地化控件名同样不许出现（它只属于已经本地化的面：胶囊 + 侧边栏条目）。
    expect(renderText(tool)).not.toContain('交给 AI')
    expect(renderText(tool)).not.toContain('浏览器窗口')
  })

  it('本地化指引落在**用户可见**的面上：胶囊与条目文案是中文（同一份修复的另一半）', () => {
    const overlay = browserOverlayHtml('zh')
    expect(overlay).toContain('控制权在你手里')
    expect(overlay).toContain('点这里交还给 AI')
    expect(browserOverlayHtml('en')).toContain('You have control')
  })

  it('模型侧工具面一个字都没多：名字/空参数不变，browser_release 仍不存在', () => {
    const { runtime } = makeRuntime()
    const tools = registerControlTools(runtime)
    const takeover = tools.get('browser_takeover')!
    expect(takeover.name).toBe('browser_takeover')
    // 参数面仍是空的（注册期归一化后的形状也一并钉死：多一个参数就红）。
    expect(takeover.parameters).toEqual({ type: 'object', properties: {} })
    expect([...tools.keys()]).not.toContain('browser_release')
    expect(takeover.description).toContain('NO model-side counterpart')
  })
})
