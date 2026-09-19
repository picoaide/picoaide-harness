// @vitest-environment jsdom
/**
 * 第四轮客户端面的**真挂载**判据（§19 Q1/Q2/Q6/Q11/Q15 + §21 前端桥）。
 *
 * 覆盖：搜索与「我发布的」筛选、三种空态（无结果 / 无应用 / 未登录）、一次性引导卡、
 * 分享深链（fail-closed）、F16 打开次数、详情页与应用 AI 面板（授权 / SSE 流式 / 取消）。
 *
 * ---- 变异验证 ----
 *   - `CatalogToolbar` 不把 query 交给 `filterCatalog`（只在 UI 里存着）⇒「搜索真的过滤」红；
 *   - `catalogEmptyState` 的筛选分支删掉 ⇒「无结果空态」红（会渲染成"还没有可用的应用"）；
 *   - 面板把 401 也放进 `kind:'error'` ⇒「未登录是独立空态」红；
 *   - 引导卡不看存储（恒显示）或关闭不写存储 ⇒ 引导卡两条红；
 *   - 分享按钮不看渠道 scheme（恒渲染）⇒「未拿到渠道参数 ⇒ 不渲染分享入口」红；
 *   - `AppDetailView` 恒渲染 `counts`（或读别处的数字）⇒「没有计数就不渲染」红；
 *   - `AppAiPanel` 跳过授权闸门直接给输入框 ⇒ 授权两条红；
 *   - 卸载不 abort ⇒「取消」红。
 */
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppCenterPanel } from './AppCenterPanel.tsx'
import { setAppChannel, type AppChannel } from './channel-seam.ts'
import { APP_AI_CHAT_PATH, APP_AI_CONSENT_PATH } from './app-ai.ts'
import type { OnboardingStore } from './onboarding.ts'
import { setAppShareScheme } from './deep-link.ts'
import type { AppAiConsentStore } from './app-ai.ts'
import { OPEN_INTENT_STORAGE_KEY, type OpenIntentStore } from './open-intent.ts'
import { HOST_PROOF_PATH, setHostProofToken } from './host-proof.ts'
import { loadAppChannel } from './channel-seam.ts'
import { setActiveLocale } from './locales.ts'

// React 18.3 在非测试构建下要求这个全局标记才认 `act()`。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const APP_SCHEME = 'picoaide-app'
const CHANNEL: AppChannel = { appOriginScheme: APP_SCHEME, deepLinkScheme: 'picoaide', productName: 'PicoAide' }
const appURL = (appId: string, path = '/'): string => `${APP_SCHEME}://${appId}${path}`

/** 额度/用量词表（R36：这一页一个都不许有，详情视图与 AI 面板一起查）。 */
const QUOTA_PATTERN = /quota|balance|budget|usage|credit|额度|用量|余额|计费/iu

const ONE_NO_WINDOW = { apps: [{ app_id: 'roster', title: '值班表', access: 'login', enabled: true }] }

const CATALOG = {
  apps: [
    { app_id: 'shift-notes', title: '值班便签', description: '值班记录与交接', responsible: 'alice', access: 'login', enabled: true, current_version: '1.2.0', is_owner: true },
    { app_id: 'roster', title: '值班表', description: '排班与调班', responsible: 'bob', access: 'login', enabled: true, current_version: '2.0.0', is_owner: false },
    { app_id: 'invoice', title: '发票助手', description: 'OCR 识别与校验', responsible: 'carol', access: 'whitelist', enabled: true, current_version: '0.9.0', is_owner: false },
  ],
}

interface Call { url: string, init: RequestInit }

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/** 内存引导卡存储。 */
function memoryOnboarding(seed: Record<string, string> = {}): OnboardingStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed))
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

/** 内存 AI 授权存储。 */
function memoryConsent(): { getItem: (k: string) => string | null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void, values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

let container: HTMLDivElement
let root: Root
let calls: Call[]
let aiCalls: Array<{ url: string, init: RequestInit }>
let copied: string[]
let closing: number

/**
 * 一个只答目录的本机 fetch（渠道/身份由面板注入的 loader 提供）。
 *
 * **持有性证明的引导端点默认答掉**（§22.2 R2）：`open` 与 `channel` 都要带
 * `X-Pico-Host-Proof`，没有令牌时客户端**不发业务请求**。用例仍可用 `reply` 覆盖它。
 */
function stubCatalog(reply: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const options = init ?? {}
    calls.push({ url, init: options })
    if (url === HOST_PROOF_PATH) {
      return jsonResponse(200, { proof: 'host-proof-test', expires_at: Date.now() + 5 * 60_000 })
    }
    return await reply(url, options)
  }))
}

/**
 * 应用 AI 的假 fetch（面板注入的 `aiDeps.fetch`）。
 *
 * 它同时承载三条本机路径（§21.1 Q9 / §22.2 R2）：持有性证明引导、授权路由（"允许/撤销"
 * 必须落到宿主，否则界面已允许而闸门仍然 403）、以及应用页的保留路径。**只有保留路径
 * 计入 {@link aiCalls}**（授权与引导不是"聊天调用"，用例的条数断言按聊天算）。
 */
function stubAi(reply: (init: RequestInit) => Response | Promise<Response>): void {
  aiCalls = []
  aiScript = async (_input: unknown, init?: RequestInit) => await reply(init ?? {})
}

/** 聊天路径的脚本（缺省：没有调用就该发生的用例会拿到一条可辨的错误）。 */
let aiScript: (input: unknown, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error('no app AI chat was expected in this case')
}

/** 授权路由收到的请求体（断言"允许/撤销真的写了宿主"）。 */
let consentCalls: Array<{ app_id: string, granted: boolean }>

/** 授权路由的回答（缺省成功；用例可覆盖成失败）。 */
let consentReply: (body: { app_id: string, granted: boolean }) => Response =
  body => jsonResponse(200, { app_id: body.app_id, granted: body.granted })

/** 面板注入的取数实现：先答本机引导/授权，再把保留路径交给脚本。 */
async function aiReply(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (url === HOST_PROOF_PATH) {
    return jsonResponse(200, { proof: 'host-proof-test', expires_at: Date.now() + 5 * 60_000 })
  }
  if (url === APP_AI_CONSENT_PATH) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { app_id: string, granted: boolean }
    consentCalls.push(body)
    return consentReply(body)
  }
  aiCalls.push({ url, init: init ?? {} })
  return await aiScript(url, init)
}

/** SSE 响应体。 */
function sse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status, headers: { 'content-type': 'text/event-stream' } })
}

async function mount(options: {
  channel?: AppChannel | null
  onboarding?: OnboardingStore
  consent?: AppAiConsentStore
  clipboard?: (text: string) => Promise<void>
  channelResult?: Awaited<ReturnType<typeof loadAppChannel>>
  intent?: OpenIntentStore
  loginState?: () => Promise<boolean>
  loginPollMs?: number
  now?: () => number
} = {}): Promise<void> {
  const channel = options.channel === undefined ? CHANNEL : options.channel
  consentCalls = []
  consentReply = body => jsonResponse(200, { app_id: body.app_id, granted: body.granted })
  await act(async () => {
    root.render(
      <AppCenterPanel
        onClose={() => { closing += 1 }}
        onboardingStore={options.onboarding ?? null}
        channelLoader={async () => channel}
        identityLoader={async () => 'alice@harness.example'}
        writeClipboard={options.clipboard ?? (async (text: string) => { copied.push(text) })}
        aiDeps={{ fetch: (async (input: unknown, init?: RequestInit) => await aiReply(input, init)) as unknown as typeof fetch }}
        aiConsentStore={options.consent ?? memoryConsent()}
        {...(options.channelResult === undefined ? {} : { channelResultLoader: async () => options.channelResult! })}
        {...(options.intent === undefined ? {} : { intentStore: options.intent })}
        {...(options.loginState === undefined ? {} : { loginStateLoader: options.loginState })}
        {...(options.loginPollMs === undefined ? {} : { loginPollMs: options.loginPollMs })}
        {...(options.now === undefined ? {} : { now: options.now })}
      />,
    )
  })
}

/** 内存 intent 存储。 */
function memoryIntent(seed: Record<string, string> = {}): OpenIntentStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

/**
 * 冲一次宏任务：授权同步是 **async** 的（面板要等宿主写完才放行输入框），
 * `act()` 只冲微任务，单靠它读到的是中间态。
 */
async function settle(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  }
}

/** 点「允许」并等宿主确认（§21.1 Q9：授权是宿主侧的，不是渲染层的一次性开关）。 */
async function allowAi(): Promise<void> {
  await click('.pico-app-ai-allow')
  await settle()
}

/** 点一个元素（真 DOM 事件）。 */
async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  await act(async () => { element.click() })
}

/** 给输入框/文本域写值（原生 setter + input 事件）。 */
async function type(selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  aiCalls = []
  copied = []
  closing = 0
  // 渠道参数是**模块级**注入点（一次安装一份）：用例之间必须复位，否则"未拿到渠道参数"
  // 那条会被前一条用例的注入救活（假绿）。
  setAppChannel(null)
  setAppShareScheme(null)
  setHostProofToken(null)
  // 授权存储缺省走 `localStorage`：每个用例都注入新的内存存储，这里再清一次兜底。
  try { window.localStorage.clear() } catch { /* jsdom 一定有，防御而已 */ }
  // 默认：AI 未配置（用例自己覆盖）。注意只换**聊天路径**的脚本 —— 引导与授权路由
  // 由 `aiReply` 固定答掉（重写整个 `aiReply` 会让面板拿不到宿主证明）。
  aiScript = async () => jsonResponse(404, { error: { code: 'app_ai_unavailable' } })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('可发现性：搜索与「我发布的」（§19 Q1）', () => {
  it('搜索按名称/一句话/负责人过滤目录，并保持命中顺序', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(3)
    await type('.pico-app-center-search', 'OCR')
    const remaining = [...container.querySelectorAll('.pico-app-center-card')]
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.textContent).toContain('发票助手')
    await type('.pico-app-center-search', '值班')
    expect([...container.querySelectorAll('.pico-app-center-card')].map(card => card.textContent)).toHaveLength(2)
    void closing
  })

  it('「我发布的」只留 is_owner=true 的行', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-owned-only')
    const cards = [...container.querySelectorAll('.pico-app-center-card')]
    expect(cards).toHaveLength(1)
    expect(cards[0]!.textContent).toContain('值班便签')
  })

  it('>20 条时分批显示，「显示更多」把剩余条目放出来', async () => {
    const many = { apps: Array.from({ length: 25 }, (_unused, index) => ({ app_id: `app-${String(index)}`, title: `应用 ${String(index)}`, access: 'login', enabled: true })) }
    stubCatalog(() => jsonResponse(200, many))
    await mount()
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(20)
    await click('.pico-app-center-show-more')
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(25)
    expect(container.querySelector('.pico-app-center-show-more')).toBeNull()
  })
})

describe('三种空态各自可辨（§19 Q2/Q4）', () => {
  it('无结果：有应用但筛选没命中 ⇒ 专属文案 + 清空筛选出口', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await type('.pico-app-center-search', '没有这个应用')
    const block = container.querySelector('[data-role="catalog-no-results"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('没有匹配的应用')
    // **不得**退化成"没有应用"。
    expect(container.textContent).not.toContain('还没有可用的应用')
    // 清空筛选后目录回来。
    await click('.pico-app-center-clear-filters')
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(3)
  })

  it('无应用：服务端空目录 ⇒ 引导让 AI 做一个', async () => {
    stubCatalog(() => jsonResponse(200, { apps: [] }))
    await mount()
    const block = container.querySelector('[data-role="catalog-empty"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('还没有可用的应用')
    expect(block!.textContent).toContain('AI 会帮你做出来并发布到这里')
    expect(container.querySelector('[data-role="catalog-no-results"]')).toBeNull()
    expect(container.querySelector('[data-role="catalog-signed-out"]')).toBeNull()
  })

  it('未登录（401）⇒ 独立空态（不是错误块，也不是"没有应用"）', async () => {
    stubCatalog(() => jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'not logged in' } }))
    await mount()
    const block = container.querySelector('[data-role="catalog-signed-out"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('登录后可以查看应用中心')
    expect(block!.textContent).toContain('请先登录')
    expect(container.querySelector('[data-role="catalog-error"]')).toBeNull()
    expect(container.textContent).not.toContain('还没有可用的应用')
  })
})

describe('空态 ③「全部下架」（§19 Q2 第二档，R1-L3-1）', () => {
  const OFFLINE_CATALOG = {
    apps: [
      { app_id: 'gone-a', title: '已下线 A', access: 'login', enabled: false },
      { app_id: 'gone-b', title: '已下线 B', access: 'login', enabled: false },
    ],
  }

  it('可见行全是下架 ⇒ 给专属文案（说明原因 + 联系负责人），且与"没有应用"不塌缩', async () => {
    stubCatalog(() => jsonResponse(200, OFFLINE_CATALOG))
    await mount()
    const block = container.querySelector('[data-role="catalog-all-disabled"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('这些应用都已下架')
    expect(block!.textContent).toContain('410 Gone')
    expect(block!.textContent).toContain('联系发布者或管理员')
    // 三档空态互斥：不是"没有应用"、不是"没有匹配"。
    expect(container.querySelector('[data-role="catalog-empty"]')).toBeNull()
    expect(container.querySelector('[data-role="catalog-no-results"]')).toBeNull()
    expect(container.textContent).not.toContain('还没有可用的应用')
    // 行本身照常展示（下架 ≠ 不存在）。
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(2)
  })

  it('有 1 条在架 + 3 条下架 ⇒ **不**显示"全部下架"', async () => {
    stubCatalog(() => jsonResponse(200, {
      apps: [
        { app_id: 'alive', title: '在架工具', access: 'login', enabled: true },
        { app_id: 'gone-a', title: '已下线 A', access: 'login', enabled: false },
        { app_id: 'gone-b', title: '已下线 B', access: 'login', enabled: false },
        { app_id: 'gone-c', title: '已下线 C', access: 'login', enabled: false },
      ],
    }))
    await mount()
    expect(container.querySelector('[data-role="catalog-all-disabled"]')).toBeNull()
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(4)
  })
})

describe('未登录时记住这次打开，登录后自动继续（§19 Q4 / §7.6，R1-L3-2）', () => {
  const ONE = { apps: [{ app_id: 'roster', title: '值班表', access: 'login', enabled: true }] }

  it('未登录点开 ⇒ 记下意图 + 给可见说明，且**不重复发请求**（开窗由宿主闸门负责）', async () => {
    stubCatalog(url => (url === '/api/pico/wasm-apps/open'
      ? jsonResponse(401, { error: { code: 'AUTH_REQUIRED' } })
      : jsonResponse(200, ONE)))
    const intent = memoryIntent()
    await mount({ intent, loginState: async () => false, loginPollMs: 1000 })
    await click('.pico-app-center-open')
    // 意图落盘（登录页重载后还能读到 —— 这是"自动继续"的前提）。
    const stored = JSON.parse(String(intent.values.get(OPEN_INTENT_STORAGE_KEY)))
    expect(stored.appId).toBe('roster')
    expect(typeof stored.at).toBe('number')
    // 可见说明（不是错误弹窗）。
    const hint = container.querySelector('[data-role="open-pending-login"]')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain('已记住这次打开')
    // 只发了一次打开请求（没有重试风暴）。
    expect(calls.filter(call => call.url === '/api/pico/wasm-apps/open')).toHaveLength(1)
  })

  it('页面重载回来（有存储意图 + 已登录）⇒ **不点任何东西**就自动继续', async () => {
    stubCatalog(url => (url === '/api/pico/wasm-apps/open'
      ? jsonResponse(200, { url: appURL('roster'), window: 'opened' })
      : jsonResponse(200, ONE)))
    const intent = memoryIntent({ [OPEN_INTENT_STORAGE_KEY]: JSON.stringify({ appId: 'roster', at: Date.now() }) })
    await mount({ intent, loginState: async () => true, now: () => Date.now() })
    const opens = calls.filter(call => call.url === '/api/pico/wasm-apps/open')
    expect(opens).toHaveLength(1)
    expect(JSON.parse(String(opens[0]!.init.body))).toEqual({ app_id: 'roster' })
    // 继续之后意图被清掉（不留残影，避免下次启动又开一次）。
    expect(intent.values.has(OPEN_INTENT_STORAGE_KEY)).toBe(false)
  })

  it('仍未登录 ⇒ 不发请求；登录态翻转后按轮询自动继续', async () => {
    stubCatalog(url => (url === '/api/pico/wasm-apps/open'
      ? jsonResponse(200, { url: appURL('roster'), window: 'focused' })
      : jsonResponse(200, ONE)))
    let loggedIn = false
    const intent = memoryIntent({ [OPEN_INTENT_STORAGE_KEY]: JSON.stringify({ appId: 'roster', at: Date.now() }) })
    vi.useFakeTimers()
    try {
      await mount({ intent, loginState: async () => loggedIn, loginPollMs: 1000 })
      expect(calls.filter(call => call.url === '/api/pico/wasm-apps/open')).toHaveLength(0)
      loggedIn = true
      await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
      expect(calls.filter(call => call.url === '/api/pico/wasm-apps/open')).toHaveLength(1)
      expect(container.querySelector('[data-role="open-pending-login"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('过期的意图 ⇒ 直接丢弃（不发请求，也不弹错误）', async () => {
    stubCatalog(() => jsonResponse(200, ONE))
    const stale = JSON.stringify({ appId: 'roster', at: Date.now() - 6 * 60 * 1000 })
    const intent = memoryIntent({ [OPEN_INTENT_STORAGE_KEY]: stale })
    await mount({ intent, loginState: async () => true })
    expect(calls.filter(call => call.url === '/api/pico/wasm-apps/open')).toHaveLength(0)
    expect(intent.values.has(OPEN_INTENT_STORAGE_KEY)).toBe(false)
  })
})

describe('打开反馈：正在打开 / 已打开 / 已聚焦（§5.2 的 window 字段，R1-L3-8）', () => {
  const ONE = { apps: [{ app_id: 'roster', title: '值班表', access: 'login', enabled: true }] }

  it('请求在途时按钮显示"正在打开…"', async () => {
    let release: (() => void) | null = null
    const pending = new Promise<void>(resolve => { release = resolve })
    stubCatalog(async url => {
      if (url !== '/api/pico/wasm-apps/open') return jsonResponse(200, ONE)
      await pending
      return jsonResponse(200, { url: appURL('roster'), window: 'opened' })
    })
    await mount()
    const button = container.querySelector<HTMLButtonElement>('.pico-app-center-open')!
    await act(async () => { button.click() })
    expect(button.textContent).toBe('正在打开…')
    expect(button.disabled).toBe(true)
    await act(async () => { release?.(); await Promise.resolve() })
    expect(container.querySelector('[data-role="open-outcome"]')).not.toBeNull()
  })

  it('window=opened ⇒ "已打开"；window=focused ⇒ "已聚焦"（各自可辨）', async () => {
    for (const [value, copy] of [['opened', '已打开'], ['focused', '已聚焦']] as const) {
      stubCatalog(url => (url === '/api/pico/wasm-apps/open'
        ? jsonResponse(200, { url: appURL('roster'), window: value })
        : jsonResponse(200, ONE)))
      await mount()
      await click('.pico-app-center-open')
      const outcome = container.querySelector('[data-role="open-outcome"]')
      expect(outcome, value).not.toBeNull()
      expect(outcome!.getAttribute('data-window')).toBe(value)
      expect(outcome!.textContent).toContain(copy)
      await act(async () => { root.unmount() })
      root = createRoot(container)
    }
  })

  it('服务端没回传 window ⇒ 不渲染任何打开反馈（不编造"已打开"）', async () => {
    stubCatalog(url => (url === '/api/pico/wasm-apps/open'
      ? jsonResponse(200, { url: appURL('roster') })
      : jsonResponse(200, ONE)))
    await mount()
    await click('.pico-app-center-open')
    expect(container.querySelector('[data-role="open-outcome"]')).toBeNull()
  })
})

describe('窗口声明（F3/§6，R1-L3-9）：目录消费 + 详情展示', () => {
  it('目录行带 window ⇒ 详情页显示比例与尺寸；缺省不显示、也不声称锁比例', async () => {
    stubCatalog(() => jsonResponse(200, {
      apps: [{ app_id: 'roster', title: '值班表', access: 'login', enabled: true, window: { ratio: 1.7778, width: 1280, height: 720 } }],
    }))
    await mount()
    await click('.pico-app-center-detail')
    const block = container.querySelector('[data-role="detail-window"]')
    expect(block).not.toBeNull()
    expect(block!.querySelector('[data-role="window-ratio"]')!.textContent).toContain('1.7778')
    expect(block!.querySelector('[data-role="window-size"]')!.textContent).toContain('1280×720')

    // 没有 window 的行 ⇒ 这一块整个不出现（不假装锁了比例）。
    await act(async () => { root.unmount() })
    root = createRoot(container)
    stubCatalog(() => jsonResponse(200, ONE_NO_WINDOW))
    await mount()
    await click('.pico-app-center-detail')
    expect(container.querySelector('[data-role="detail-window"]')).toBeNull()
  })
})

describe('一次性引导卡（§7.2）', () => {
  it('首次显示三条要点，关闭后消失并落盘；同一存储再次挂载不再显示', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    const store = memoryOnboarding()
    await mount({ onboarding: store })
    const card = container.querySelector('[data-role="catalog-onboarding"]')
    expect(card).not.toBeNull()
    const points = card!.querySelector('[data-role="onboarding-points"]')!.textContent ?? ''
    // 三条要点：应用是什么 / 怎么让 AI 做一个 / 怎么分享。
    expect(points).toContain('点开就用')
    expect(points).toContain('AI 会帮你做出来并发布到这里')
    expect(points).toContain('复制链接')
    await click('.pico-app-center-onboarding-dismiss')
    expect(container.querySelector('[data-role="catalog-onboarding"]')).toBeNull()
    expect(store.values.get('picoaide.wasm-apps.onboarding.v1')).toBe('1')
    // 重新挂载（同一份存储）⇒ 不再出现。
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await mount({ onboarding: store })
    expect(container.querySelector('[data-role="catalog-onboarding"]')).toBeNull()
  })
})

describe('分享/复制链接（F6 + §19 Q6 的 fail-closed）', () => {
  it('拿到渠道 scheme ⇒ 每行有「复制链接」，点击写入渠道深链并反馈', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    const buttons = container.querySelectorAll('.pico-app-center-copy-link')
    expect(buttons).toHaveLength(3)
    await click('.pico-app-center-copy-link')
    expect(copied).toEqual(['picoaide://app/shift-notes'])
    const feedback = container.querySelector('[data-role="copy-feedback"]')
    expect(feedback).not.toBeNull()
    expect(feedback!.getAttribute('data-ok')).toBe('true')
    expect(feedback!.textContent).toContain('picoaide://app/shift-notes')
  })

  /**
   * **R2-X-1 第 6 条**：分享入口不可用时要说清是**证明问题**还是**配置问题**。
   *
   * 变异验证：把面板里的 `data-reason` 两档合并成一句 ⇒ 本条两条用例中的一条红。
   */
  it('渠道取数因证明失败 ⇒ 说明"本机凭据问题（不是渠道配置）"', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount({
      channel: null,
      channelResult: { channel: null, failure: { reason: 'host-proof-rejected', status: 401, message: 'proof_required' } },
    })
    const hint = container.querySelector('[data-role="share-unavailable"]')
    expect(hint).not.toBeNull()
    expect(hint!.getAttribute('data-reason')).toBe('host-proof-rejected')
    expect(hint!.textContent).toContain('本机服务')
    expect(hint!.textContent).toContain('不是渠道配置问题')
  })

  it('渠道取数成功但没有 scheme ⇒ 说明"渠道配置问题（请联系管理员）"', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount({
      channel: null,
      channelResult: { channel: null, failure: { reason: 'scheme-not-configured', status: 200, message: 'no scheme' } },
    })
    const hint = container.querySelector('[data-role="share-unavailable"]')
    expect(hint).not.toBeNull()
    expect(hint!.getAttribute('data-reason')).toBe('scheme-not-configured')
    expect(hint!.textContent).toContain('渠道配置问题')
    expect(hint!.textContent).toContain('管理员')
  })

  it('未拿到渠道参数（只读路由失败）⇒ 分享入口一个都不渲染（不回落官方 scheme）', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount({ channel: null })
    expect(container.querySelector('.pico-app-center-copy-link')).toBeNull()
    expect(container.querySelector('[data-role="copy-feedback"]')).toBeNull()
    // 目录本身照常渲染（分享拿不到不影响看应用）。
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(3)
  })

  it('剪贴板不可用 ⇒ 明确说"复制失败：手动复制"，不假装成功', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount({ clipboard: async () => { throw new Error('clipboard blocked') } })
    await click('.pico-app-center-copy-link')
    const feedback = container.querySelector('[data-role="copy-feedback"]')
    expect(feedback).not.toBeNull()
    expect(feedback!.getAttribute('data-ok')).toBe('false')
    expect(feedback!.textContent).toContain('复制失败')
  })
})

describe('F16 打开次数（消费 open 端点的回传）', () => {
  it('打开成功后展示"今日已被打开 N 次"与隐私说明；列表行也带上计数', async () => {
    stubCatalog(url => url === '/api/pico/wasm-apps/open'
      ? jsonResponse(200, { url: appURL('shift-notes'), opens: { today: { pv: 5, uv: 3 } } })
      : jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-open')
    const counted = container.querySelector('[data-role="open-count"]')
    expect(counted).not.toBeNull()
    expect(counted!.textContent).toContain('今日已被打开 5 次')
    // 详情页同样显示（同一次打开的回传值）。
    await click('.pico-app-center-detail')
    expect(container.querySelector('[data-role="app-detail"]')).not.toBeNull()
    expect(container.querySelector('[data-role="opens-today"]')!.textContent).toBe('今日已被打开 5 次')
    expect(container.querySelector('[data-role="opens-privacy-note"]')!.textContent).toContain('平台记录打开次数用于运营')
  })

  it('服务端没回传计数 ⇒ 一行都不渲染（不编造）', async () => {
    stubCatalog(url => url === '/api/pico/wasm-apps/open'
      ? jsonResponse(200, { url: appURL('shift-notes') })
      : jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-open')
    expect(container.querySelector('[data-role="open-count"]')).toBeNull()
    await click('.pico-app-center-detail')
    expect(container.querySelector('[data-role="detail-open-count"]')).toBeNull()
  })

  it('半块计数（只有 pv 没有 uv）⇒ 按"没有"处理', async () => {
    stubCatalog(url => url === '/api/pico/wasm-apps/open'
      ? jsonResponse(200, { url: appURL('shift-notes'), opens: { today: { pv: 5 } } })
      : jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-open')
    expect(container.querySelector('[data-role="open-count"]')).toBeNull()
  })
})

describe('详情页：信息 / 分享 / 应用 AI（§21）', () => {
  it('点标题进详情，显示访问级别、负责人与版本，并能返回列表', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-detail')
    const detail = container.querySelector('[data-role="app-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.getAttribute('data-app-id')).toBe('shift-notes')
    expect(detail!.querySelector('[data-role="detail-title"]')!.textContent).toBe('值班便签')
    expect(detail!.querySelector('[data-role="detail-access"]')!.getAttribute('data-access')).toBe('login')
    expect(detail!.querySelector('[data-role="detail-version"]')!.textContent).toContain('1.2.0')
    await click('.pico-app-center-back')
    expect(container.querySelector('[data-role="app-detail"]')).toBeNull()
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(3)
  })

  it('首次使用弹一次性授权卡：未授权时**没有**输入框；允许后出现（且允许真的写了宿主）', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-detail')
    const consent = container.querySelector('[data-role="ai-consent"]')
    expect(consent).not.toBeNull()
    expect(consent!.textContent).toContain('只发送本次对话内容')
    expect(container.querySelector('.pico-app-ai-input')).toBeNull()
    await allowAi()
    // 授权必须落到**宿主**：渲染层 localStorage 只是 UI 记忆（闸门在宿主，
    // `handleAiChat` 先查它再碰模型）。变异：allow 只写 localStorage ⇒ 这条红，
    // 且真机上表现为"允许了但每次仍然 403"。
    expect(consentCalls).toEqual([{ app_id: 'shift-notes', granted: true }])
    expect(container.querySelector('[data-role="ai-consent"]')).toBeNull()
    expect(container.querySelector('.pico-app-ai-input')).not.toBeNull()
  })

  it('宿主没记住授权（写失败）⇒ 不放行输入框，并给出可辨文案', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    // 授权路由答 500：界面**不得**表现成"已允许"（下一次调用会 403）。
    consentReply = () => jsonResponse(500, { error: { code: 'CONSENT_NOT_PERSISTED' } })
    await click('.pico-app-center-detail')
    await allowAi()
    expect(container.querySelector('.pico-app-ai-input')).toBeNull()
    expect(container.querySelector('[data-role="ai-consent-failed"]')).not.toBeNull()
  })

  it('撤销授权 ⇒ 也写宿主（granted:false），界面回到说明卡', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount({ consent: memoryConsent() })
    await click('.pico-app-center-detail')
    await allowAi()
    expect(container.querySelector('.pico-app-ai-input')).not.toBeNull()
    await click('.pico-app-ai-revoke')
    await settle()
    expect(consentCalls).toEqual([
      { app_id: 'shift-notes', granted: true },
      { app_id: 'shift-notes', granted: false },
    ])
    expect(container.querySelector('.pico-app-ai-input')).toBeNull()
    expect(container.querySelector('[data-role="ai-revoked"]')).not.toBeNull()
  })

  it('拒绝授权 ⇒ 明确说不能使用 AI，且没有输入框', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-detail')
    await click('.pico-app-ai-deny')
    expect(container.querySelector('[data-role="ai-denied"]')!.textContent).toContain('不能使用 AI')
    expect(container.querySelector('.pico-app-ai-input')).toBeNull()
    expect(aiCalls).toEqual([])
  })

  it('SSE 流式渲染：增量按序出现，done 收尾后成为一条完整回复', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    stubAi(() => sse([
      'event: delta\ndata: {"delta":"值班"}\n\n',
      'event: delta\ndata: {"delta":"便签已更新"}\n\n',
      'event: done\ndata: {}\n\n',
    ]))
    await mount()
    await click('.pico-app-center-detail')
    await allowAi()
    await type('.pico-app-ai-input', '帮我看一下')
    await click('.pico-app-ai-send')
    await settle()
    expect(aiCalls).toHaveLength(1)
    expect(aiCalls[0]!.url).toBe(APP_AI_CHAT_PATH)
    expect(JSON.parse(String(aiCalls[0]!.init.body))).toMatchObject({ stream: true })
    const messages = [...container.querySelectorAll('[data-role="ai-message"]')]
    expect(messages).toHaveLength(2)
    expect(messages[1]!.textContent).toContain('值班便签已更新')
  })

  it('错误分层：信封 code 决定文案（余额类 cookie 不误报成"被拒绝"）', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    stubAi(() => jsonResponse(403, { error: { code: 'ai_balance_insufficient', message: 'no funds' } }))
    await mount()
    await click('.pico-app-center-detail')
    await allowAi()
    await type('.pico-app-ai-input', '你好')
    await click('.pico-app-ai-send')
    await settle()
    const error = container.querySelector('[data-role="ai-error"]')
    expect(error).not.toBeNull()
    expect(error!.getAttribute('data-code')).toBe('ai_balance_insufficient')
    expect(error!.querySelector('[data-role="ai-error-message"]')!.textContent).toContain('账号当前不可用')
    expect(error!.querySelector('[data-role="ai-error-detail"]')!.textContent).toContain('no funds')
  })

  it('取消：面板卸载 ⇒ 在跑的那一轮被 abort（§21.1 第 15 条：仅前台）', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    let seen: AbortSignal | null = null
    aiScript = async (_input: unknown, init?: RequestInit) => {
      const signal = (init?.signal ?? null) as AbortSignal | null
      seen = signal
      // 请求悬着（"回复还在流式输出"），只在被 abort 时结束 —— 卸载后不应留下挂起的
      // promise（那会污染后续用例的 act 队列，本文件踩过一次）。
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }
    await mount()
    await click('.pico-app-center-detail')
    await allowAi()
    await type('.pico-app-ai-input', '长回复')
    await click('.pico-app-ai-send')
    await settle()
    expect(seen).not.toBeNull()
    expect(seen!.aborted).toBe(false)
    await act(async () => { root.unmount() })
    expect(seen!.aborted).toBe(true)
    root = createRoot(container)
  })
})

describe('发起者绑定的客户端半边（§20.2 / §22.2 R4 的另一半）', () => {
  /**
   * 只有**应用窗口**可以导航到 app scheme；客户端 UI（http 源）不得把应用协议交给浏览器。
   *
   * 本包这一侧的判据：①面板/详情页不产生任何 `<a href>`（更不会有应用 scheme 的锚点）；
   * ②这些模块里没有 `window.open` / `location.href =` 这类导航出口 —— 应用只能经本机
   * 打开路由（`openAppEntry`）打开。（浏览器标签侧的拒绝在 `packages/host/browser`，属 L2。）
   */
  it('客户端面不产生可导航到应用 scheme 的入口，也不用 window.open/location 驱动导航', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await click('.pico-app-center-detail')
    expect(container.querySelectorAll('a[href]')).toHaveLength(0)
    for (const file of ['AppCenterPanel.tsx', 'AppCenterTrigger.tsx', 'AppAiPanel.tsx', 'open-app.ts']) {
      // jsdom 环境下 `import.meta.url` 不是 file: URL（拿它拼相对路径会得到 `/src/...`），
      // 因此按包根（vitest 的 cwd = 包目录）解析；这与 `check` 的调用方式一致。
      const source = readFileSync(resolve(process.cwd(), 'src/client', file), 'utf8')
      expect(source, file).not.toContain('window.open')
      expect(source, file).not.toMatch(/location\.href\s*=/u)
    }
  })
})

describe('冻结文案与 R36（额度词）守卫', () => {
  it('第四轮新增文案在两种语言下都存在，且文档冻结的那几句逐字一致', async () => {
    const { zh, en } = await import('./locales.ts')
    // §19 Q1 / Q6 / Q11 / Q9 与 §5.1b 的冻结引文。
    expect(zh['appCenter.ownedOnly']).toBe('我发布的')
    expect(zh['appCenter.copyLink']).toBe('复制链接')
    expect(zh['appCenter.opensToday']).toBe('今日已被打开 {n} 次')
    expect(zh['appCenter.privacyNote']).toContain('平台记录打开次数用于运营')
    // 「已开始下载，进度见浏览器窗口」/「无法确认最新版本」**不在本字典**：审计裁定那两句
    // 归 L2 的 `app-window-copy.ts`（应用窗口 chrome 由它渲染），本包不再持有第二份。
    expect(zh).not.toHaveProperty('appCenter.notice.download')
    // en 镜像逐 key 对齐且不是空串。
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [key, value] of Object.entries(en)) expect(value, key).not.toBe('')
  })

  it('详情页与三种空态渲染结果里没有额度/用量词（R36）', async () => {
    stubCatalog(() => jsonResponse(200, CATALOG))
    await mount()
    await type('.pico-app-center-search', 'zzz')
    expect(container.textContent).not.toMatch(QUOTA_PATTERN)
    await click('.pico-app-center-clear-filters')
    await click('.pico-app-center-detail')
    expect(container.textContent).not.toMatch(QUOTA_PATTERN)
    expect(container.innerHTML).not.toMatch(QUOTA_PATTERN)
  })
})
