// @vitest-environment jsdom
/**
 * 应用中心面板的**真挂载**测试（FIX-42 + FIX-38）。
 *
 * 为什么必须真挂载：实现者原有的面板用例全部走 `react-dom/server` 的
 * `renderToStaticMarkup` —— **不跑 `useEffect`**，所以"面板挂载 → 取数 → 解析 → 渲染"
 * 这条链路在测试里从未被执行过。审计员用真机探针也证明不了它（他们的探针在页面主世界
 * 替换了 `window.fetch`，把目录数据换成自造数据）。本文件把两半接起来跑：
 *
 *   真 `AppCenterPanel`（createRoot + act ⇒ `useEffect` 真的执行）
 *     → 真的 fetch 调用（断言 URL 是 `/api/pico/apps/wasm`）
 *     → 真 `parseCatalog`
 *     → 真 DOM（断言条目文本出现在容器里）
 *
 * 另外覆盖发布入口（FIX-38）：真点击 → 表单出现 → 填表 → 提交 → 断言页面发出的
 * `POST /api/pico/apps/wasm/publish` 请求体，以及成功/失败两种结果的 DOM。
 *
 * ---- 变异验证 ----
 *   - 删掉 `AppCenterPanel` 里 `useEffect(() => { void load() }, [load])` ⇒
 *     「挂载后真的取数」「加载失败显示错误」「目录展示全部应用」三条红；
 *   - 把 fetch 的 URL 改成别的路径 ⇒ 「请求的是 /api/pico/apps/wasm」红；
 *   - `parseCatalog` 里按 `visible` / `access` / `enabled` 加一条 continue ⇒
 *     「目录展示全部应用」与「已下架标状态」红；
 *   - 访问级别选择器改回「visible 勾选 + login_required 勾选」⇒
 *     「缺省是 login」「三个选项都是真实单选框」红；
 *   - 提交时把 `access` 换回 `login_required`/`visible` ⇒ 「请求体」那条红；
 *   - 摘掉 whitelist 空名单预校验 ⇒ 「空名单被就地拦下」红；
 *   - 面板里加一行额度字段（或在发布视图里显示额度）⇒ 「无额度词」红；
 *   - 失败块只显示"失败"（丢掉 code/details/hints）⇒ 「结构化错误逐字段显示」红；
 *   - 非 2xx 时丢掉响应体、只拼 `加载失败 (HTTP 502)`（P1-5 前的实现）⇒
 *     「加载失败时逐字段显示服务端错误信封」红；
 *   - `parseCatalog` 对解析不出的行静默 `continue` 且面板仍走空态（P2-10 前的实现）⇒
 *     「行都在但没有一行认得出来」红；
 *   - 发布表单的 `access` 初值改回硬编码 `DEFAULT_ACCESS`、`data_sensitivity` 改回
 *     `'internal'`（P1-3 前的实现）⇒ 预填/留空两组用例红；
 *   - 去掉"访问范围改动需确认"的闸 ⇒ 「改动访问范围」那条红；
 *   - 选文件时不判 `size`（P1-10 前的实现）⇒ 「33 MiB 不读字节」红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppCenterPanel } from './AppCenterPanel.tsx'
import { PublishForm } from './PublishForm.tsx'
import { PUBLISH_PATH, type PublishTarget } from './publish-app.ts'
import { setActiveLocale } from './locales.ts'

// React 18.3 在非测试构建下要求这个全局标记才认 `act()`。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 额度/用量词表（R36：这一页一个都不许有，两个视图一起查）。 */
const QUOTA_PATTERN = /quota|balance|budget|usage|credit|额度|用量|余额|计费/iu

/**
 * 宿主 `/api/pico/apps/wasm` 的**真实输出形状**（由 enterprise 侧的
 * `wasm-apps.spec.ts` 在另一端钉住：相对 `entry_url` 已被绝对化、未知字段不增删）。
 * 这里复用它，是为了让"路由输出 → 面板渲染"这条跨包链路在两侧各钉一半，
 * 任一侧漂移都会被看见。
 *
 * `access` / `enabled` 是本次新契约的字段；第二行刻意只带旧的
 * `login_required`/`whitelist`（模拟服务端尚未下发 `access`），用来钉住过渡兼容。
 */
const CATALOG_FROM_ROUTE = {
  apps: [
    { app_id: 'hidden-tool', title: '隐藏工具', description: '曾经 visible=false，现在照样列出', responsible: 'carol', entry_url: 'https://harness.example/apps/hidden-tool/', access: 'whitelist', enabled: true, current_version: '3.1.0', is_owner: true, purpose: '值班排班', whitelist: ['carol', 'dave'] },
    { app_id: 'shared-notes', title: '共享便签', description: '值班记录', responsible: 'alice', entry_url: 'https://shared-notes.apps.example.com/', access: 'public', enabled: true, current_version: '1.4.2', is_owner: false },
    { app_id: 'gone-tool', title: '已下线的工具', description: '', responsible: 'dave', entry_url: 'https://gone.apps.example.com/', access: 'login', enabled: false, current_version: '', is_owner: true },
  ],
}

interface Call { url: string, init: RequestInit }

const RELEASE_OK = {
  app: { app_id: 'shift-notes', title: '值班便签', entry_url: 'https://shift-notes.apps.example.com/', version: '1.0.0' },
  release: { id: 1, version: '1.0.0', status: 'approved', current: true, checksum: 'abc', size: 8 },
  review_required: false,
}

let container: HTMLDivElement
let root: Root
let calls: Call[]
let closeCount: number

/** 装一个受控的全局 fetch；`respond` 拿到 (url, init) 返回 Response。 */
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const options = init ?? {}
    calls.push({ url, init: options })
    return await respond(url, options)
  }))
}

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<AppCenterPanel onClose={() => { closeCount += 1 }} />)
  })
}

/** 点一个按钮（真 DOM 事件，React 的合成事件系统会收到）。 */
async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  await act(async () => { element.click() })
}

/** 给受控输入写值（走原生 setter + input 事件，React 才认这是用户输入）。 */
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

/**
 * 选一个文件。
 *
 * jsdom 25 没有 `Blob.prototype.arrayBuffer`（产品代码用 `File.arrayBuffer()` 读字节），
 * 因此这里给一个只实现 `name` + `size` + `arrayBuffer()` 的 File 替身 —— 被替换掉的只有
 * "浏览器读盘"这一步，其后的 `encodeBase64` 与请求体拼装跑的都是产品代码。
 *
 * `size` 缺省取 `bytes.byteLength`（真实 File 的语义）；P1-10 的用例显式传一个
 * 超限的 `size`，用来断言**体积闸门在 arrayBuffer 之前**就拦下了。
 * `onRead` 用来断言"文件根本没被读"。
 */
async function pickFile(selector: string, name: string, bytes: Uint8Array, options: { size?: number, onRead?: () => void } = {}): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector)
  if (input === null) throw new Error(`missing element: ${selector}`)
  const file = {
    name,
    size: options.size ?? bytes.byteLength,
    arrayBuffer: async () => { options.onRead?.(); return bytes.buffer },
  } as unknown as File
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

async function typeIntoPublishForm(values: {
  appId?: string, version?: string, title?: string, changelog?: string, access?: 'public' | 'login' | 'whitelist',
  whitelist?: string, purpose?: string, owner?: string, sensitivity?: string,
}): Promise<void> {
  if (values.appId !== undefined) await type('.pico-app-center-app-id', values.appId)
  if (values.version !== undefined) await type('.pico-app-center-version', values.version)
  if (values.title !== undefined) await type('.pico-app-center-title', values.title)
  if (values.changelog !== undefined) await type('.pico-app-center-changelog', values.changelog)
  // 访问级别先选：名单输入只在 whitelist 模式下存在，顺序不能反。
  if (values.access !== undefined) await click(`.pico-app-center-access-${values.access}`)
  if (values.whitelist !== undefined) await type('.pico-app-center-whitelist', values.whitelist)
  if (values.purpose !== undefined) await type('.pico-app-center-purpose', values.purpose)
  if (values.sensitivity !== undefined) await type('.pico-app-center-data-sensitivity', values.sensitivity)
  if (values.owner !== undefined) await type('.pico-app-center-owner', values.owner)
}

/**
 * 模板：除访问级别外都填好的最小合法输入（首版四条声明字段都给上）。
 *
 * `sensitivity` 必须**显式**给出（P1-3 第二条）：平台没有 `data_sensitivity` 的
 * 默认值，表单也不再替作者填一个 —— 不写它就会被首版必填校验拦下。
 */
const FILLED = { appId: 'shift-notes', version: '1.0.0', title: '值班便签', purpose: '值班交接', owner: 'alice', sensitivity: 'internal' } as const

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  closeCount = 0
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FIX-42：面板挂载后真的取数（useEffect 真的跑）', () => {
  it('挂载即 GET /api/pico/apps/wasm，并渲染出解析后的条目', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_FROM_ROUTE))
    await mount()
    // ① 真的调用了宿主取数路由（不是注入的假数据）。
    expect(calls.map(call => call.url)).toEqual(['/api/pico/apps/wasm'])
    // ② 解析出的条目真的进了 DOM。
    expect(container.textContent).toContain('共享便签')
    expect(container.textContent).toContain('值班记录')
    expect(container.textContent).toContain('负责人: alice')
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(3)
  })

  it('目录展示全部应用：白名单应用与已下架的条目都由这条取数链路渲染出来', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_FROM_ROUTE))
    await mount()
    // 白名单应用不再被藏起来。
    expect(container.textContent).toContain('隐藏工具')
    // 下架的条目也在，并标出状态。
    expect(container.textContent).toContain('已下线的工具')
    expect(container.querySelectorAll('.pico-app-center-card')).toHaveLength(3)
    expect(container.querySelector('[data-role="app-disabled"]')).not.toBeNull()
  })

  it('每条目标出服务端下发的访问级别（三种都有对应徽标）', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_FROM_ROUTE))
    await mount()
    const badges = [...container.querySelectorAll('[data-role="access-level"]')]
    expect(badges.map(b => b.getAttribute('data-access'))).toEqual(['whitelist', 'public', 'login'])
    expect(badges[0]!.textContent).toBe('仅白名单')
    expect(badges[1]!.textContent).toBe('公开')
    expect(badges[2]!.textContent).toBe('登录后使用')
  })

  /**
   * P1-5：非 2xx 时**必须解析服务端/宿主的错误信封**。
   *
   * 旧实现丢掉响应体、只拼一句 `加载失败 (HTTP 502)` —— 而宿主给的正是可执行的
   * `{error:{code,message,details,hints}}`（`wasm-apps.ts` 的 gatewayFailure：
   * `GATEWAY_UNAVAILABLE` + "检查网络与服务端地址 …"）。变异验证：把
   * `AppCenterPanel.load` 改回"只看 status 拼字符串" ⇒ 本用例红（message 与 hint
   * 两处断言都不会命中）。
   */
  it('加载失败时逐字段显示服务端错误信封（code + message + hints），而不是只显示状态码', async () => {
    stubFetch(() => jsonResponse(502, {
      error: {
        code: 'GATEWAY_UNAVAILABLE',
        message: 'gateway error: fetch failed',
        hints: ['检查网络与服务端地址；网络恢复后重发同一条 publish —— 分片续传会从 received[] 之后接着传'],
      },
    }))
    await mount()
    expect(calls).toHaveLength(1)
    const block = container.querySelector('[data-role="catalog-error"]')
    expect(block).not.toBeNull()
    // ① 服务端 code 出现（旧实现只显示 HTTP 状态码，没有 code）。
    expect(block!.querySelector('[data-role="error-code"]')!.textContent).toContain('GATEWAY_UNAVAILABLE')
    // ② 服务端 message **原文**出现（旧实现会把它换成"加载失败 (HTTP 502)"）。
    expect(block!.querySelector('[data-role="error-message"]')!.textContent).toContain('gateway error: fetch failed')
    // ③ hints 出现（可自修的信息，第一消费者是 AI，也是给员工看的）。
    const hints = block!.querySelector('[data-role="error-hints"]')!.textContent ?? ''
    expect(hints).toContain('检查网络与服务端地址')
    // 错误态不得退化成空态（空列表会被读成"没有应用"）。
    expect(container.textContent).not.toContain('还没有可用的应用')
    // 重试按钮存在（错误态是可恢复的，不是死胡同）。
    expect(container.textContent).toContain('重试')
  })

  it('未登录（401）走可读的登录提示，不是崩溃也不是空列表', async () => {
    stubFetch(() => jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'not logged in' } }))
    await mount()
    expect(container.textContent).toContain('登录后可以查看应用中心')
    expect(container.textContent).not.toContain('还没有可用的应用')
  })

  it('网络层异常同样落到错误态（不抛穿渲染树）', async () => {
    stubFetch(() => { throw new TypeError('fetch failed') })
    await mount()
    expect(container.textContent).toContain('fetch failed')
  })

  it('取数只在挂载时发生一次（渲染不会重复请求）', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    await mount()
    expect(calls).toHaveLength(1)
  })

  it('错误态的"重试"按钮真的再取一次（不是装饰）', async () => {
    let attempt = 0
    stubFetch(() => {
      attempt += 1
      return attempt === 1 ? jsonResponse(500, { error: { code: 'INTERNAL', message: 'boom' } }) : jsonResponse(200, CATALOG_FROM_ROUTE)
    })
    await mount()
    expect(container.querySelector('[data-role="catalog-error"]')!.textContent).toContain('boom')
    await click('.pico-app-center-retry')
    expect(calls).toHaveLength(2)
    expect(container.textContent).toContain('共享便签')
  })

  /**
   * P2-10：服务端**下发了行**却一行都解析不出来 = 契约漂移，必须报错。
   *
   * 旧实现 `parseCatalog` 对没有合法 `app_id` 的行直接 `continue`，全部跳过时面板
   * 显示空态"还没有可用的应用" —— 把"字段改名了"说成"你没有应用"。变异验证：把
   * `AppCenterPanel.load` 里的 `rows > 0 && items === 0` 分支删掉 ⇒ 本用例红
   * （会渲染空态）。
   */
  it('行都在但没有一行认得出来 ⇒ 契约漂移错误态 + 原始行样本（不是空态）', async () => {
    stubFetch(() => jsonResponse(200, {
      apps: [
        { appId: 'renamed-one', title: '字段被改名了' },
        { appId: 'renamed-two', title: '第二行' },
      ],
    }))
    await mount()
    const block = container.querySelector('[data-role="catalog-error"]')
    expect(block).not.toBeNull()
    expect(block!.querySelector('[data-role="error-code"]')!.textContent).toContain('CATALOG_SHAPE_MISMATCH')
    // 关键：**不许**显示空态。
    expect(container.textContent).not.toContain('还没有可用的应用')
    // 原始行样本进 details（维护者据此直接看到服务端下发的是什么）。
    const details = block!.querySelector('[data-role="error-details"]')!.textContent ?? ''
    expect(details).toContain('renamed-one')
  })

  it('正常空目录仍然是空态（"没有应用"与"解析不出来"必须能区分）', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    await mount()
    expect(container.textContent).toContain('还没有可用的应用')
    expect(container.querySelector('[data-role="catalog-error"]')).toBeNull()
  })
})

describe('FIX-38：面板里的发布入口可达并真的发出发布请求', () => {
  it('目录视图有发布入口（真实 button），点击后出现发布表单', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    await mount()
    const entry = container.querySelector<HTMLButtonElement>('.pico-app-center-publish')
    expect(entry).not.toBeNull()
    expect(entry!.tagName).toBe('BUTTON')
    expect(entry!.textContent).toBe('发布')
    await click('.pico-app-center-publish')
    expect(container.querySelector('.pico-app-center-publish-form')).not.toBeNull()
    expect(container.textContent).toContain('发布应用')
  })

  it('填表提交 ⇒ POST /api/pico/apps/wasm/publish，请求体含产物与五个配置字段（access 而非 visible/login_required）', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'shift-notes.wasm', new Uint8Array([0, 97, 115, 109]))
    await typeIntoPublishForm({
      ...FILLED, changelog: '首版', access: 'whitelist', whitelist: 'alice, bob', sensitivity: 'internal',
    })
    await click('.pico-app-center-submit')

    const publish = calls.filter(call => call.url === PUBLISH_PATH)
    expect(publish).toHaveLength(1)
    expect(publish[0]!.init.method).toBe('POST')
    const raw = String(publish[0]!.init.body)
    const body = JSON.parse(raw) as Record<string, unknown>
    expect(body.app_id).toBe('shift-notes')
    expect(body.version).toBe('1.0.0')
    expect(body.title).toBe('值班便签')
    expect(body.changelog).toBe('首版')
    // wasm 魔数 `\0asm` 的标准 base64（已知向量，不用实现算实现）。
    expect(body.wasm_base64).toBe('AGFzbQ==')
    expect(body.config).toEqual({
      access: 'whitelist',
      whitelist: ['alice', 'bob'],
      purpose: '值班交接',
      data_sensitivity: 'internal',
      owner: 'alice',
    })
    // 面板这一侧真的不再发旧字段（服务端字段集合封闭，多发即拒）。
    expect(raw).not.toContain('login_required')
    expect(raw).not.toContain('"visible"')
  })

  it('访问级别缺省是 login（"登录后使用"），三个选项都是真实单选框', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    await mount()
    await click('.pico-app-center-publish')
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][data-field="access"]')]
    expect(radios.map(r => r.getAttribute('data-access'))).toEqual(['public', 'login', 'whitelist'])
    expect(radios.map(r => r.checked)).toEqual([false, true, false])
    // 默认不显示名单输入（只有选了"仅白名单用户"才需要它）。
    expect(container.querySelector('.pico-app-center-whitelist')).toBeNull()
  })

  it('选中 whitelist ⇒ 名单输入出现且标为必填；空名单提交被就地拦下（不发请求）', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'x.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ ...FILLED, access: 'whitelist' })

    const whitelist = container.querySelector<HTMLInputElement>('.pico-app-center-whitelist')
    expect(whitelist).not.toBeNull()
    expect(whitelist!.required).toBe(true)
    expect(whitelist!.getAttribute('aria-required')).toBe('true')
    // 名单旁的"必填"标记真的渲染出来（用户看得到为什么被拦）。
    expect(container.textContent).toContain('选中「仅白名单用户」时必填')

    await click('.pico-app-center-submit')
    const local = container.querySelector('[data-role="local-error"]')
    expect(local).not.toBeNull()
    expect(local!.textContent).toContain('必须填至少一个账号')
    expect(local!.querySelector('[data-field="whitelist"]')).not.toBeNull()
    // 关键：没发请求（预校验就地拦下，不让用户白等一次 90 s 往返）。
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)

    // 填上名单后同一个表单可以正常提交（拦截不是死胡同）。
    await typeIntoPublishForm({ whitelist: 'alice' })
    await click('.pico-app-center-submit')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(1)
  })

  it('访问级别每个选项都有帮助文字，whitelist 的写明"平台不比对名单、由应用自己判"', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    await mount()
    await click('.pico-app-center-publish')
    expect(container.querySelector('[data-role="access-hint-public"]')!.textContent).toContain('匿名也能打开')
    expect(container.querySelector('[data-role="access-hint-login"]')!.textContent).toContain('登录后全员可用（默认）')
    const whitelistHint = container.querySelector('[data-role="access-hint-whitelist"]')!.textContent ?? ''
    expect(whitelistHint).toContain('平台')
    expect(whitelistHint).toContain('不比对名单')
    expect(whitelistHint).toContain('应用')
  })

  it('本地预校验：app_id 形态 / version 形态 / 首版声明字段都在发请求之前拦下', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'x.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ appId: 'Demo--App', version: '1.0', title: '', purpose: 'p' })
    await click('.pico-app-center-submit')
    const local = container.querySelector('[data-role="local-error"]')!
    const codes = [...local.querySelectorAll('li')].map(li => li.getAttribute('data-code'))
    expect(codes).toContain('app_id_shape')
    expect(codes).toContain('version_shape')
    expect(codes).toContain('title_required')
    expect(codes).toContain('owner_required')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)
  })

  it('成功 ⇒ 显示版本、已生效与入口链接，并刷新目录', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'shift-notes.wasm', new Uint8Array([0, 97, 115, 109]))
    await typeIntoPublishForm(FILLED)
    await click('.pico-app-center-submit')

    const success = container.querySelector('[data-role="publish-success"]')
    expect(success).not.toBeNull()
    expect(success!.textContent).toContain('发布成功')
    expect(success!.textContent).toContain('1.0.0')
    expect(success!.textContent).toContain('已生效')
    expect(success!.textContent).toContain('https://shift-notes.apps.example.com/')
    // 发布成功后重新拉一次目录（结果立即可见）。
    expect(calls.filter(call => call.url === '/api/pico/apps/wasm').length).toBeGreaterThanOrEqual(2)
  })

  it('待审 ⇒ 明说"线上仍是旧版本"（不假装已生效，R17）', async () => {
    stubFetch((url) => (url === PUBLISH_PATH
      ? jsonResponse(201, { ...RELEASE_OK, release: { ...RELEASE_OK.release, status: 'pending', current: false }, review_required: true })
      : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'x.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ ...FILLED, appId: 'x', version: '2.0.0' })
    await click('.pico-app-center-submit')
    const success = container.querySelector('[data-role="publish-success"]')!
    expect(success.textContent).toContain('待审核')
    expect(success.textContent).not.toContain('已生效')
  })

  it('失败 ⇒ code / message / details / hints 逐字段显示（不许只说"失败"）', async () => {
    stubFetch((url) => (url === PUBLISH_PATH
      ? jsonResponse(422, {
          error: {
            code: 'APP_CONFIG_INVALID',
            message: 'access=whitelist 但没有配置白名单',
            details: { field: 'whitelist', reason: 'empty_whitelist' },
            hints: ['把 access 改成 login（登录后全员可用）', '或在 whitelist 里填入允许使用的账号'],
          },
        })
      : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'x.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ ...FILLED, appId: 'x', access: 'whitelist', whitelist: 'alice' })
    await click('.pico-app-center-submit')

    const block = container.querySelector('[data-role="publish-error"]')
    expect(block).not.toBeNull()
    expect(block!.querySelector('[data-role="error-code"]')!.textContent).toContain('APP_CONFIG_INVALID')
    expect(block!.querySelector('[data-role="error-message"]')!.textContent).toContain('access=whitelist 但没有配置白名单')
    expect(block!.querySelector('[data-role="error-details"]')!.textContent).toContain('"reason": "empty_whitelist"')
    const hints = block!.querySelector('[data-role="error-hints"]')!.textContent ?? ''
    expect(hints).toContain('把 access 改成 login（登录后全员可用）')
    expect(hints).toContain('或在 whitelist 里填入允许使用的账号')
  })

  it('本地校验：没选文件就提交 ⇒ 就地提示，且不发请求', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    await mount()
    await click('.pico-app-center-publish')
    await typeIntoPublishForm(FILLED)
    await click('.pico-app-center-submit')
    expect(container.querySelector('[data-role="local-error"]')!.textContent).toContain('请先选择 .wasm 文件')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)
  })

  it('在途有真实状态与取消：提交中显示"上传中/编译中"，取消回到空闲态', async () => {
    let release: (() => void) | null = null
    stubFetch((url, init) => {
      if (url !== PUBLISH_PATH) return jsonResponse(200, { apps: [] })
      return new Promise<Response>((_resolve, reject) => {
        release = () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
        init.signal?.addEventListener('abort', () => { release?.() })
      })
    })
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'x.wasm', new Uint8Array([1]))
    await typeIntoPublishForm(FILLED)
    await click('.pico-app-center-submit')

    expect(container.querySelector('[data-role="phase"]')!.textContent).toContain('上传中 / 编译中')
    expect(container.querySelector<HTMLButtonElement>('.pico-app-center-submit')!.disabled).toBe(true)

    await click('.pico-app-center-cancel')
    expect(container.querySelector('[data-role="phase"]')).toBeNull()
    expect(container.querySelector('[data-role="publish-error"]')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.pico-app-center-submit')!.disabled).toBe(false)
  })

  it('R36：目录视图与发布视图都不含额度/用量词', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_FROM_ROUTE))
    await mount()
    expect(QUOTA_PATTERN.test(container.textContent ?? '')).toBe(false)
    await click('.pico-app-center-publish')
    expect(QUOTA_PATTERN.test(container.textContent ?? '')).toBe(false)
  })
})

/**
 * P1-3：**对已有应用发新版**必须预填当前配置，且改动访问范围要显式确认。
 *
 * 现场缺陷：`access` 初值硬编码 `DEFAULT_ACCESS`（login）、`data_sensitivity` 硬填
 * `internal`，而提交**无条件**发送全部 5 个配置字段 ⇒ 作者不动单选框，一个
 * `access=public` 的应用发新版后就变成 `login`（访问范围被静默改写，服务端还会因此
 * 写一条 `wasm_app_access_change` 审计）；所有应用的合规声明则被界面统一抹平成
 * `internal`。
 *
 * ---- 变异验证 ----
 *   - 把 `PublishForm` 的 `access` 初值改回 `DEFAULT_ACCESS`（不看 target）⇒
 *     「单选为当前值 public」红；
 *   - 把 `data_sensitivity` 初值改回 `'internal'` ⇒ 「留空 + 标注无默认值」红；
 *   - 去掉 `accessChanged` 的确认闸（`access_change_unconfirmed` 那条 issue）⇒
 *     「改动访问范围未确认时提交被拦下」红；
 *   - `initialFormState` 不预填 whitelist/purpose/owner ⇒ 对应用例红；
 *   - 目录行的"发新版"按钮不传 item（`setPublishTarget(undefined)`）⇒ 预填全空，红。
 */
describe('P1-3：对已有应用发新版（预填当前配置 + 访问范围改动确认）', () => {
  const CATALOG_OWNED = {
    apps: [
      { app_id: 'hidden-tool', title: '隐藏工具', description: '值班排班', responsible: 'carol', entry_url: 'https://harness.example/apps/hidden-tool/', access: 'public', enabled: true, current_version: '3.1.0', is_owner: true, purpose: '值班排班', whitelist: ['carol', 'dave'] },
      { app_id: 'shared-notes', title: '共享便签', description: '', responsible: 'alice', entry_url: 'https://shared-notes.apps.example.com/', access: 'login', enabled: true, current_version: '1.0.0', is_owner: false },
    ],
  }

  /** 从目录进入"发新版"（第一行是发布者本人的应用）。 */
  async function openPublishNewVersion(): Promise<void> {
    const button = container.querySelector<HTMLButtonElement>('.pico-app-center-card .pico-app-center-publish-new')
    if (button === null) throw new Error('missing element: .pico-app-center-publish-new')
    await act(async () => { button.click() })
  }

  const access = (): string | null =>
    container.querySelector<HTMLInputElement>('input[type="radio"][data-field="access"]:checked')?.getAttribute('data-access') ?? null

  it('目录行给出"发新版"入口，且只给发布者本人（非发布者的发布必然 404）', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_OWNED))
    await mount()
    const buttons = [...container.querySelectorAll('.pico-app-center-publish-new')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-label')).toContain('隐藏工具')
    // 第二行（is_owner=false）没有这个入口。
    expect(container.textContent).toContain('共享便签')
  })

  it('进入发新版：access / whitelist / purpose / owner / title 全部预填为当前值', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_OWNED))
    await mount()
    await openPublishNewVersion()

    // ① 单选为**当前值** public（旧实现是 login，这就是"静默改写访问范围"的根因）。
    expect(access()).toBe('public')
    // 不能只靠 type=radio 的 checked 断言（React 受控组件要真的选中）。
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-access-public')!.checked).toBe(true)
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-access-login')!.checked).toBe(false)
    // ② 其余字段逐项预填。
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-app-id')!.value).toBe('hidden-tool')
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-title')!.value).toBe('隐藏工具')
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-owner')!.value).toBe('carol')
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-purpose')!.value).toBe('值班排班')
    // whitelist 只在选中白名单模式时才渲染 —— 先切过去看预填值（发布是整体替换配置，
    // 名单拿不回来就只能凭空重填，而空名单会被服务端一律拒）。
    await click('.pico-app-center-access-whitelist')
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-whitelist')!.value).toBe('carol, dave')
    // ③ 上下文条：当前版本可见（新版本号必须严格大于它）。
    expect(container.querySelector('[data-role="publish-target"]')!.textContent).toContain('3.1.0')
    expect(container.querySelector('[data-role="current-access"]')!.textContent).toContain('公开')
  })

  it('data_sensitivity 留空并标注"平台无默认值"，不是硬填 internal', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_OWNED))
    await mount()
    await openPublishNewVersion()
    const input = container.querySelector<HTMLInputElement>('.pico-app-center-data-sensitivity')!
    expect(input.value).toBe('')
    expect(container.querySelector('[data-role="data-sensitivity-note"]')!.textContent).toContain('没有平台默认值')
  })

  it('data_sensitivity 未声明时提交被本地拦下（不把抹平后的值发出去）', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, CATALOG_OWNED)))
    await mount()
    await openPublishNewVersion()
    await pickFile('.pico-app-center-file', 'hidden-tool.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ version: '3.2.0' })
    await click('.pico-app-center-submit')

    const local = container.querySelector('[data-role="local-error"]')!
    expect([...local.querySelectorAll('li')].map(li => li.getAttribute('data-code'))).toContain('data_sensitivity_required')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)
  })

  it('改动访问范围：出现"当前 X → 提交后 Y"确认，未勾选不许提交，勾选后按新值提交', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, CATALOG_OWNED)))
    await mount()
    await openPublishNewVersion()
    await pickFile('.pico-app-center-file', 'hidden-tool.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ version: '3.2.0', sensitivity: 'internal' })

    // 没改访问范围 ⇒ 没有确认框（不给正常发版加无谓的摩擦）。
    expect(container.querySelector('[data-role="access-change"]')).toBeNull()

    await click('.pico-app-center-access-login')
    const confirm = container.querySelector('[data-role="access-change"]')
    expect(confirm).not.toBeNull()
    expect(confirm!.querySelector('[data-role="access-change-detail"]')!.textContent).toContain('公开')
    expect(confirm!.querySelector('[data-role="access-change-detail"]')!.textContent).toContain('登录后使用')

    // 未勾选 ⇒ 就地拦下（不发请求）。
    await click('.pico-app-center-submit')
    const local = container.querySelector('[data-role="local-error"]')!
    expect([...local.querySelectorAll('li')].map(li => li.getAttribute('data-code'))).toContain('access_change_unconfirmed')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)

    // 换了取值 ⇒ 上一次的确认作废（确认的是"公开 → 登录后使用"这一对具体取值，
    // 不是"随便改点什么"）。
    const checkbox = container.querySelector<HTMLInputElement>('.pico-app-center-access-confirm')!
    await act(async () => {
      checkbox.click()
    })
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-access-confirm')!.checked).toBe(true)
    await click('.pico-app-center-access-whitelist')
    expect(container.querySelector<HTMLInputElement>('.pico-app-center-access-confirm')!.checked).toBe(false)
    await click('.pico-app-center-access-login')
    await click('.pico-app-center-submit')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)

    // 重新勾选确认后可以提交，且提交的是**新值**。
    await act(async () => {
      container.querySelector<HTMLInputElement>('.pico-app-center-access-confirm')!.click()
    })
    await click('.pico-app-center-submit')
    const publish = calls.filter(call => call.url === PUBLISH_PATH)
    expect(publish).toHaveLength(1)
    const body = JSON.parse(String(publish[0]!.init.body)) as { config: Record<string, unknown> }
    expect(body.config.access).toBe('login')
    // 预填值一路带到出站载荷（不是只显示在界面上）。
    expect(body.config.owner).toBe('carol')
    expect(body.config.purpose).toBe('值班排班')
    expect(body.config.whitelist).toEqual(['carol', 'dave'])
  })

  it('不改访问范围时提交无需确认，成功块回显访问范围', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, CATALOG_OWNED)))
    await mount()
    await openPublishNewVersion()
    await pickFile('.pico-app-center-file', 'hidden-tool.wasm', new Uint8Array([1]))
    await typeIntoPublishForm({ version: '3.2.0', sensitivity: 'internal' })
    await click('.pico-app-center-submit')

    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(1)
    const success = container.querySelector('[data-role="publish-success"]')!
    const echoed = success.querySelector('[data-role="published-access"]')!
    expect(echoed.getAttribute('data-access')).toBe('public')
    expect(echoed.textContent).toContain('公开')
  })

  it('P1-4：目录行显示服务端下发的当前版本', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_OWNED))
    await mount()
    const versions = [...container.querySelectorAll('[data-role="current-version"]')].map(node => node.textContent)
    expect(versions).toContain('当前版本: 3.1.0')
  })
})

/**
 * P1-10：**选文件时的体积闸门**。
 *
 * 旧实现选文件即 `file.arrayBuffer()` 读全量，再 base64、再 `JSON.stringify`
 * —— 超限文件（>32 MiB）会让渲染进程主线程持 3–4 倍峰值内存，界面先冻一次，
 * 最后才拿到宿主的 `UPLOAD_TOO_LARGE`。
 *
 * ---- 变异验证 ----
 *   - 删掉 `pickFile` 里的 `selected.size > WASM_MAX_BYTES` 分支 ⇒ 本组第 1 条红；
 *   - 把 `WASM_MAX_BYTES` 改成 48 MiB（或直接不判 size）⇒ 同上红（33 MiB 会被读）。
 */
describe('P1-10：超限文件在选文件时就被本地拦下（不读字节、不发请求）', () => {
  const OVERSIZE = 33 * 1024 * 1024

  it('33 MiB 的文件：报本地错误、不调用 arrayBuffer、不发 /publish', async () => {
    stubFetch(() => jsonResponse(200, { apps: [] }))
    let reads = 0
    await mount()
    await click('.pico-app-center-publish')
    await pickFile('.pico-app-center-file', 'huge.wasm', new Uint8Array([1]), { size: OVERSIZE, onRead: () => { reads += 1 } })

    const local = container.querySelector('[data-role="local-error"]')!
    expect(local.querySelector('[data-field="wasm_file"]')!.getAttribute('data-code')).toBe('wasm_file_too_large')
    expect(local.textContent).toContain('32 MiB')
    // **关键**：字节根本没被读（旧实现这里已经读完 33 MiB 并做了 base64）。
    expect(reads).toBe(0)
    // 文件状态回到"未选择"（拦下的文件不是"已选中"）。
    expect(container.querySelector('[data-role="file-state"]')!.textContent).toContain('还没有选择文件')
    expect(calls.filter(call => call.url === PUBLISH_PATH)).toHaveLength(0)
  })

  it('刚好 32 MiB 的文件仍然可提交（边界：> 而不是 >=）', async () => {
    stubFetch((url) => (url === PUBLISH_PATH ? jsonResponse(201, RELEASE_OK) : jsonResponse(200, { apps: [] })))
    await mount()
    await click('.pico-app-center-publish')
    // 用 size 声明 32 MiB 但只给 4 字节真实载荷：断言的是**闸门的边界**，
    // 不是再搬一次 32 MiB（那会让这条用例本身变成"搬大载荷"的耗时用例）。
    await pickFile('.pico-app-center-file', 'exact.wasm', new Uint8Array([0, 97, 115, 109]), { size: 32 * 1024 * 1024 })
    expect(container.querySelector('[data-role="local-error"]')).toBeNull()
    expect(container.querySelector('[data-role="file-state"]')!.textContent).toContain('exact.wasm')
  })
})

/** 找一张目录卡片（同一个选择器会命中多行，必须按标题锚定）。 */
function cardOf(title: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('.pico-app-center-card')]
    .find(node => (node.textContent ?? '').includes(title))
  if (card === undefined) throw new Error(`missing card: ${title}`)
  return card
}

/** 在指定卡片里点一个元素（真 DOM 事件 + act）。 */
async function clickIn(title: string, selector: string): Promise<void> {
  const element = cardOf(title).querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing ${selector} in ${title}`)
  await act(async () => { element.click() })
}

/**
 * R1-uxc-1：**已下架应用发新版**不得谎报"已生效"。
 *
 * 现场缺陷：`canPublish` 不判 `enabled`（同一行的"打开"判了）、`parsePublishOutcome`
 * 把服务端确实下发的 `app.enabled` 丢掉、成功块无条件写"已生效" —— 于是作者上传 30 s+
 * 之后看到"发布成功 · 已生效"，而应用子域仍是 410 Gone（服务端下架语义见
 * `server/internal/wasmapp/appserver/serve.go` 的 writeGone；发布响应带 `enabled`
 * 见 `server/internal/wasmapp/api/publish.go`）。
 *
 * ---- 变异验证 ----
 *   - `parsePublishOutcome` 不读 `app.enabled`（P1 前的实现）⇒ (a) 红（成功块会出现
 *     "已生效"且没有下架说明）；
 *   - `PublishSuccessBlock` 的状态行改回 `pending ? … : 已生效`（不看 enabled）⇒ (a) 红；
 *   - 目录行改回"下架就不渲染发新版按钮"（静默隐藏）⇒ 「按钮保留但禁用并写明原因」红；
 *   - `live` 改回 `current === true || !pending`（不看 enabled）⇒ publish-app.spec 的
 *     `live === false` 那条红。
 */
describe('R1-uxc-1：下架应用发新版（成功文案按服务端 enabled 分流）', () => {
  /** 直接挂发布表单：下架应用的行内入口是**禁用**的（见下一条），因此要走表单本身。 */
  async function mountForm(target?: PublishTarget): Promise<void> {
    await act(async () => {
      root.render(
        <PublishForm
          {...(target === undefined ? {} : { target })}
          onClose={() => { closeCount += 1 }}
          onPublished={() => {}}
        />,
      )
    })
  }

  const DISABLED_TARGET: PublishTarget = {
    appId: 'gone-tool', title: '已下线的工具', access: 'login', currentVersion: '1.0.0', owner: 'dave', purpose: '值班排班',
  }

  /** 服务端发布响应（`api/publish.go` 的 `{app,release,review_required}`）。 */
  const publishResponse = (enabled: boolean): Response => jsonResponse(201, {
    app: { app_id: 'gone-tool', title: '已下线的工具', enabled, entry_url: 'https://gone.apps.example.com/' },
    release: { id: 2, version: '1.1.0', status: 'approved', current: true, checksum: 'abc', size: 8 },
    review_required: false,
  })

  /** 填好必填项并提交。 */
  async function submitRelease(): Promise<void> {
    await pickFile('.pico-app-center-file', 'gone-tool.wasm', new Uint8Array([0, 97, 115, 109]))
    await typeIntoPublishForm({ version: '1.1.0', sensitivity: 'internal' })
    await click('.pico-app-center-submit')
  }

  it('(a) 服务端回 enabled=false ⇒ 成功块没有"已生效"，有下架说明 + 上架指引（并回显版本）', async () => {
    stubFetch(url => (url === PUBLISH_PATH ? publishResponse(false) : jsonResponse(200, { apps: [] })))
    await mountForm(DISABLED_TARGET)
    await submitRelease()

    const success = container.querySelector('[data-role="publish-success"]')
    expect(success).not.toBeNull()
    // 版本确实发布成功（这一点不能一起否认掉）。
    expect(success!.textContent).toContain('1.1.0')
    // ① 不得出现"已生效"（线上仍是 410 Gone，说已生效就是谎报）。
    expect(success!.textContent).not.toContain('已生效')
    expect(success!.querySelector('[data-role="published-status"]')!.getAttribute('data-enabled')).toBe('false')
    // ② 必须说清"已下架 + 访问是 410"。
    expect(success!.querySelector('[data-role="published-status"]')!.textContent).toContain('已下架')
    expect(success!.querySelector('[data-role="published-status"]')!.textContent).toContain('410')
    // ③ 必须给出下一步（先上架），否则作者只知道"没生效"而不知道怎么办。
    expect(success!.querySelector('[data-role="published-disabled-hint"]')!.textContent).toContain('上架')
  })

  it('(b) 服务端回 enabled=true ⇒ 行为不变（仍是"已生效"，没有下架提示）', async () => {
    stubFetch(url => (url === PUBLISH_PATH ? publishResponse(true) : jsonResponse(200, { apps: [] })))
    await mountForm(DISABLED_TARGET)
    await submitRelease()

    const success = container.querySelector('[data-role="publish-success"]')!
    expect(success.textContent).toContain('已生效')
    expect(success.textContent).not.toContain('已下架')
    expect(success.querySelector('[data-role="published-status"]')!.getAttribute('data-enabled')).toBe('true')
    expect(success.querySelector('[data-role="published-disabled-hint"]')).toBeNull()
  })

  it('行内：已下架应用的"发新版"保留但禁用并写明原因（不静默隐藏），上架应用不受影响', async () => {
    stubFetch(() => jsonResponse(200, CATALOG_FROM_ROUTE))
    await mount()

    const disabledRow = cardOf('已下线的工具')
    const button = disabledRow.querySelector<HTMLButtonElement>('.pico-app-center-publish-new')
    // ① 按钮还在（静默隐藏会让作者以为"这个应用不能发新版"）。
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(true)
    expect(button!.getAttribute('aria-disabled')).toBe('true')
    // ② 原因写在**可见文本**里（不靠 hover title）：已下架 + 410 + 先上架。
    const reason = disabledRow.querySelector('[data-role="publish-new-disabled-reason"]')!.textContent ?? ''
    expect(reason).toContain('已下架')
    expect(reason).toContain('410')
    expect(reason).toContain('上架')

    // ③ 上架的应用行为不变：按钮可点。
    expect(cardOf('隐藏工具').querySelector<HTMLButtonElement>('.pico-app-center-publish-new')!.disabled).toBe(false)
    expect(cardOf('隐藏工具').querySelector('[data-role="publish-new-disabled-reason"]')).toBeNull()
  })
})

/**
 * R1-pm-1：作者的生命周期出口（下架/上架、删除、诊断）。
 *
 * 宿主早已把 `POST :app_id/(publish|unpublish)`、`DELETE :app_id`、
 * `GET :app_id/diagnostics` 代理到本机面，而客户端面板此前只有"发布/发新版" ——
 * 作者发错内容无法止损，排障只能靠猜（作者指南又明写"不要用 curl"）。
 *
 * ---- 变异验证 ----
 *   - 删掉下架/删除的确认块（点按钮直接发请求）⇒ 两条"确认前 0 请求"红；
 *   - 用请求里的值更新行（`setItem({enabled})` 而不是服务端的 `result.enabled`）⇒
 *     「服务端说 unchanged 时行不跟着变」那条红（见下一条用例的服务端回包）；
 *   - 删除后不等服务端 `deleted:true` 就收行 ⇒ 「DELETE 未返回 deleted 时行不消失」红；
 *   - 诊断失败只显示"失败"（丢掉 code/message/hints）⇒ 「诊断失败时信封可见」红。
 */
describe('R1-pm-1：作者自服务（下架/上架、删除、诊断）', () => {
  const OWNED_CATALOG = {
    apps: [
      { app_id: 'roster', title: '值班表', description: '', responsible: 'carol', entry_url: 'https://roster.apps.example.com/', access: 'login', enabled: true, current_version: '2.0.0', is_owner: true, purpose: '值班', whitelist: [] },
      { app_id: 'other', title: '别人的应用', description: '', responsible: 'dave', entry_url: 'https://other.apps.example.com/', access: 'login', enabled: true, current_version: '1.0.0', is_owner: false },
    ],
  }

  const lifecycleCalls = (suffix: string): Call[] => calls.filter(call => call.url.endsWith(suffix))

  it('下架：二次确认（确认前 0 请求、确认后可键盘操作）⇒ 行按服务端 enabled 变已下架，并可再上架', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm') return jsonResponse(200, OWNED_CATALOG)
      if (url === '/api/pico/apps/wasm/roster/unpublish') {
        return jsonResponse(200, { app: { app_id: 'roster', enabled: false, changed: true } })
      }
      if (url === '/api/pico/apps/wasm/roster/publish') {
        return jsonResponse(200, { app: { app_id: 'roster', enabled: true, changed: true, entry_url: 'https://roster.apps.example.com/' } })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    await mount()

    // 非发布者一个管理按钮都没有（服务端 ownedApp 对非发布者一律 404）。
    expect(cardOf('别人的应用').querySelector('[data-role="row-actions"]')).toBeNull()

    await clickIn('值班表', '.pico-app-center-take-offline')
    const confirmBlock = cardOf('值班表').querySelector('[data-role="confirm-take-offline"]')
    expect(confirmBlock).not.toBeNull()
    // 说明里必须写清后果（所有访问者立刻 410）。
    expect(confirmBlock!.querySelector('[data-role="confirm-message"]')!.textContent).toContain('410')
    // ① **确认前不许发请求** —— 这就是"二次确认"的行为判据（去掉确认步骤即红）。
    expect(lifecycleCalls('/unpublish')).toHaveLength(0)
    // ② 键盘可达：确认按钮是真 <button>，出现后自动获得焦点。
    const confirmButton = cardOf('值班表').querySelector<HTMLButtonElement>('.pico-app-center-confirm-take-offline')
    expect(confirmButton!.tagName).toBe('BUTTON')
    expect(document.activeElement).toBe(confirmButton)

    await clickIn('值班表', '.pico-app-center-confirm-take-offline')
    const unpublish = lifecycleCalls('/unpublish')
    expect(unpublish).toHaveLength(1)
    expect(unpublish[0]!.init.method).toBe('POST')
    // ③ 行状态 = 服务端返回的 enabled（不是"我点了下架"）。
    expect(cardOf('值班表').querySelector('[data-role="app-disabled"]')).not.toBeNull()
    expect(cardOf('值班表').querySelector('.pico-app-center-bring-online')).not.toBeNull()
    expect(cardOf('值班表').querySelector('.pico-app-center-take-offline')).toBeNull()
    // 下架状态下"发新版"被禁用（发完仍是 410）。
    expect(cardOf('值班表').querySelector<HTMLButtonElement>('.pico-app-center-publish-new')!.disabled).toBe(true)

    // ④ 可再上架：服务端说 enabled=true 才回到上架态。
    await clickIn('值班表', '.pico-app-center-bring-online')
    expect(lifecycleCalls('/publish')).toHaveLength(1)
    expect(cardOf('值班表').querySelector('[data-role="app-disabled"]')).toBeNull()
    expect(cardOf('值班表').querySelector('.pico-app-center-take-offline')).not.toBeNull()
    expect(cardOf('值班表').querySelector<HTMLButtonElement>('.pico-app-center-publish-new')!.disabled).toBe(false)
  })

  it('下架：服务端返回"状态没变"（changed=false, enabled=true）时行不得跟着请求走', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm') return jsonResponse(200, OWNED_CATALOG)
      // 服务端幂等分支：状态本来就一致（api/release.go:69-73）。
      return jsonResponse(200, { app: { app_id: 'roster', enabled: true, changed: false } })
    })
    await mount()
    await clickIn('值班表', '.pico-app-center-take-offline')
    await clickIn('值班表', '.pico-app-center-confirm-take-offline')
    // 请求发出去了，但服务端说它仍然是上架的 ⇒ 行必须保持上架（乐观更新会在这里变已下架）。
    expect(lifecycleCalls('/unpublish')).toHaveLength(1)
    expect(cardOf('值班表').querySelector('[data-role="app-disabled"]')).toBeNull()
    expect(cardOf('值班表').querySelector('.pico-app-center-take-offline')).not.toBeNull()
  })

  it('删除：二次确认后才发 DELETE；服务端确认 deleted 后行消失，并显示服务端说明与保留期', async () => {
    const NOTE = 'R37 的"真删"由后台任务执行（当前未实现）：在此之前资源目录与应用库都会保留'
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm') return jsonResponse(200, OWNED_CATALOG)
      if (url === '/api/pico/apps/wasm/roster') {
        return jsonResponse(200, { app: { app_id: 'roster', deleted: true, deleted_at: '2026-09-19T00:00:00Z' }, retention_days: 90, note: NOTE })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    await mount()

    await clickIn('值班表', '.pico-app-center-delete')
    const confirm = cardOf('值班表').querySelector('[data-role="confirm-delete"]')
    expect(confirm).not.toBeNull()
    // 说明里必须写清"不可恢复"与"保留期以服务端为准"。
    const message = confirm!.querySelector('[data-role="confirm-message"]')!.textContent ?? ''
    expect(message).toContain('不可恢复')
    expect(message).toContain('保留期')
    // ① 确认前 0 请求。
    expect(lifecycleCalls('/roster')).toHaveLength(0)

    await clickIn('值班表', '.pico-app-center-confirm-delete')
    const deletes = calls.filter(call => call.url === '/api/pico/apps/wasm/roster')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.init.method).toBe('DELETE')
    // ② 行消失（按服务端确认的结果，不是本地先抹掉）。
    expect(container.textContent).not.toContain('值班表')
    // ③ 通知里是**服务端返回的**说明与保留期（客户端不复述"90 天后自动删除"）。
    const notice = container.querySelector('[data-role="catalog-notice"]')
    expect(notice).not.toBeNull()
    expect(notice!.querySelector('[data-role="notice-note"]')!.textContent).toContain('由后台任务执行（当前未实现）')
    expect(notice!.querySelector('[data-role="notice-retention"]')!.textContent).toContain('90')
    // 别人的应用没被误删。
    expect(container.textContent).toContain('别人的应用')
  })

  it('删除：服务端没确认 deleted ⇒ 行不消失，且信封可见（不假装删掉了）', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm') return jsonResponse(200, OWNED_CATALOG)
      return jsonResponse(500, { error: { code: 'INTERNAL', message: '删除失败', hints: ['稍后重试'] } })
    })
    await mount()
    await clickIn('值班表', '.pico-app-center-delete')
    await clickIn('值班表', '.pico-app-center-confirm-delete')
    // 行还在（服务端拒绝了），并显示了服务端信封。
    expect(container.textContent).toContain('值班表')
    const failure = cardOf('值班表').querySelector('[data-role="lifecycle-error"]')
    expect(failure).not.toBeNull()
    expect(failure!.querySelector('[data-role="error-code"]')!.textContent).toContain('INTERNAL')
    expect(failure!.querySelector('[data-role="error-message"]')!.textContent).toContain('删除失败')
    expect(failure!.querySelector('[data-role="error-hints"]')!.textContent).toContain('稍后重试')
  })

  it('诊断：只读展示服务端的最近失败（reason_code）与 hints，不改行状态', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm') return jsonResponse(200, OWNED_CATALOG)
      if (url === '/api/pico/apps/wasm/roster/diagnostics') {
        return jsonResponse(200, {
          diagnostics: {
            app_id: 'roster', app_enabled: true, app_frozen: false, app_deleted: false,
            since: '2026-09-18T00:00:00Z', window_minutes: 1440, retention_days: 30,
            summary: { app_id: 'roster', total: 12, ok: 9, error: 2, killed: 1, failed: 3, reasons: [], hints: [] },
            failures: [
              { created_at: '2026-09-19T01:00:00Z', outcome: 'error', reason_code: 'COMPILE_TIMEOUT', guest_exit_code: 1, stderr_tail: 'timeout', cpu_ms: 60000, peak_memory_bytes: 1024 },
            ],
            hints: ['把单次处理拆小：编译超时是 60 秒，超时会被杀'],
          },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    await mount()

    const toggle = cardOf('值班表').querySelector<HTMLButtonElement>('.pico-app-center-diagnostics-toggle')
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
    await clickIn('值班表', '.pico-app-center-diagnostics-toggle')
    // aria-expanded 与面板同步（键盘/读屏用户要知道它展开了）。
    expect(cardOf('值班表').querySelector<HTMLButtonElement>('.pico-app-center-diagnostics-toggle')!.getAttribute('aria-expanded')).toBe('true')

    const panel = cardOf('值班表').querySelector('[data-role="diagnostics"]')
    expect(panel).not.toBeNull()
    expect(panel!.querySelector('[data-role="diagnostics-summary"]')!.textContent).toContain('12')
    expect(panel!.querySelector('[data-role="diagnostics-summary"]')!.textContent).toContain('3')
    // reason_code 是排障的第一判据，必须显示。
    expect(panel!.querySelector('[data-role="diagnostics-failure"]')!.textContent).toContain('COMPILE_TIMEOUT')
    expect(panel!.querySelector('[data-role="diagnostics-hints"]')!.textContent).toContain('60 秒')
    // 只读：行状态一个字节都没变。
    expect(cardOf('值班表').querySelector('[data-role="app-disabled"]')).toBeNull()
  })

  it('诊断：服务端拒绝时错误可见（code/message/hints 逐字段，不只说"失败"）', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm') return jsonResponse(200, OWNED_CATALOG)
      return jsonResponse(404, {
        error: {
          code: 'NOT_FOUND',
          message: '应用不存在',
          hints: ['只有发布者本人（或平台管理员）能管理该应用；应用标识一经发布不能改名'],
        },
      })
    })
    await mount()
    await clickIn('值班表', '.pico-app-center-diagnostics-toggle')

    const block = cardOf('值班表').querySelector('[data-role="diagnostics-error"]')
    expect(block).not.toBeNull()
    expect(block!.querySelector('[data-role="error-code"]')!.textContent).toContain('NOT_FOUND')
    expect(block!.querySelector('[data-role="error-message"]')!.textContent).toContain('应用不存在')
    expect(block!.querySelector('[data-role="error-hints"]')!.textContent).toContain('只有发布者本人')
    // 诊断失败不得把行状态改掉，也不得退化成"没有失败记录"的假报告。
    expect(cardOf('值班表').querySelector('[data-role="diagnostics-empty"]')).toBeNull()
    expect(cardOf('值班表').querySelector('[data-role="app-disabled"]')).toBeNull()
  })
})
