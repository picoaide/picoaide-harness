/**
 * 第二十七轮 FIX-34（第 1 条）：凭据**读失败**的跨包收口（2026-09-27）。
 *
 * 前因（`docs/AUDIT-2026-09-23-FULL.md` §7.63 登记的两条待办之一）：第二十六轮
 * FIX-31 把 `ConnectorStore.readCredential` 的语义改成「只有 ENOENT 返回 `null`，
 * 其余读失败抛 `CredentialReadError`」。`packages/host/browser/src/index.ts` 的
 * `createCredentialResolver` 里三个解析面当时都没跟上：
 *
 *   · `resolveCredentials`（**没有** try/catch）把原始的、非 `browserError` 的异常
 *     漏给 `runtime.fillCredentials`（runtime.ts:3626）→ `browser_fill_credentials`
 *     的工具层：模型拿到一个没有分类、没有 `browser:` 前缀的裸错；
 *   · `.list` 的 `catch { return [] }` 把读故障降级成"没有凭据" ⇒
 *     `browser_credentials_list` 说一句**假话**（"No stored credentials."）；
 *   · `.originOf` 的 `catch { return null }` 把读故障降级成"这条记录没有可用站点
 *     URL" ⇒ 工具在**读不到**的时候报告一个与事实无关的原因。
 *
 * 判据分四组，各自独立承重：
 *   ① **故障面**：三种真实读故障（malformed / too-large / unreadable）下，工具必须
 *      拿到**带分类、可操作、不含路径**的 `BrowserError`；列表**不得**返回空列表；
 *   ② **正向对照（逐字不变）**：真无凭据（ENOENT）时两条路径的文案/返回值与修前
 *      逐字相同，正常读取（含列表渲染）逐字相同，站点闸门的 policy 拒绝不受影响；
 *   ③ **第二个读**：站点闸门读到作用域 A、注入读作用域 B（真实竞态窗口）时，
 *      `resolveCredentials` 那条路径同样收敛成同一类错误；
 *   ④ **模型可见契约**：两条凭据工具的描述必须说明"读失败 ≠ 没有凭据"。
 *
 * 故障注入**全部走真文件系统 + 真 store 代码**（没有 mock、没有替身错误类）：
 *   · malformed：把 `<scope>/<id>.json` 换成一个**目录**（`lstat` 非普通文件）；
 *   · too-large：写一份超过 64 KiB 读上限的真文件；
 *   · unreadable：把**凭据目录**换成一个普通文件 ⇒ `lstat(<dir>/<id>.json)` 拿
 *     `ENOTDIR`（不是 ENOENT，所以必须是"读失败"而不是"没有凭据"）。
 *
 * 目录**枚举**阶段的故障一并收口（`store.credentialIds()` → `listCredentialIds` 把
 * readdir 的 errno 吞成 `[]`）：空列表要再验一次存在性（ENOENT = 真没有；其余 =
 * 读失败），判据见「list：凭据目录整体读不出来」。
 * 变异证据（拆掉收口即红）在 `temp/r21/fix-34/probe/` 与其日志里；三种故障的
 * errno/分类由 connectors 包真实构造，本文件不复制它的错误类（跨包不 import，
 * 与 src 的同一口径：`instanceof Error` + 结构化字段判定）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserError } from '../src/errors.ts'
import { createCredentialResolver } from '../src/index.ts'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import { ConnectorStore } from '@picoaide/dsh-connectors/store'
import { connectorScopePath } from '@picoaide/dsh-connectors/user-scope'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...params === undefined ? {} : { params } })
    return this.handler(method, params)
  }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-cred-fault'
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
}

class MockView implements NativeView {
  transport = new MockTransport()
  session = new MockSession()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  attached = false
  visible = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  url = ''
  title = ''
  destroyed = false
  partition = 'persist:agent-browser-cred-fault'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 10, height: 10 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }))
  setWindowOpenHandler = vi.fn()
  attach(_win: unknown, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
  get webContents(): never {
    return {
      cdp: this.transport,
      loadURL: this.loadURL,
      downloadURL: this.downloadURL,
      goBack: this.goBack,
      goForward: this.goForward,
      reload: this.reload,
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => false,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((x) => x !== listener))
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  overlays: MockView[] = []
  windows: Array<{ visible: boolean; destroyed: boolean }> = []
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { const view = new MockView(); this.overlays.push(view); return view }
  createBrowserWindow(): never {
    const window = { visible: false, destroyed: false }
    this.windows.push(window)
    return {
      loadURL: async () => {},
      show: () => { window.visible = true },
      hide: () => { window.visible = false },
      focus: () => {},
      isVisible: () => window.visible,
      isDestroyed: () => window.destroyed,
      close: () => { window.destroyed = true },
      setTitle: () => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {},
      onClosed: () => () => {},
      focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return this.partitionSession }
  lastView(): MockView { return this.views.at(-1)! }
}

interface ToolDefinition {
  name: string
  description: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> }
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  dir: string
  tools: Map<string, ToolDefinition>
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  render: (name: string, value: unknown) => string
  dispose: () => void
}

function makeHarness(credentials: unknown): Harness {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.crf-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const runtime = new BrowserRuntime(adapter as never, {}, credentials as never, undefined, { store: new BrowserStore({ dir }) })
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const disposeTools = applyBrowserTools(ctx, runtime)
  return {
    runtime,
    adapter,
    dir,
    tools,
    call: async (name, args = {}) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool not registered: ${name}`)
      return await tool.execute(args, { agent: undefined, signal: new AbortController().signal })
    },
    render: (name, value) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool not registered: ${name}`)
      return tool.output.render({}, value).map((block) => block.text ?? '').join('\n')
    },
    dispose: () => { disposeTools(); runtime.dispose() },
  }
}

const opened: Harness[] = []
function track(harness: Harness): Harness {
  opened.push(harness)
  return harness
}

/** The tool must fail — and it must fail with a classified `BrowserError`. */
async function rejection(promise: Promise<unknown>): Promise<BrowserError> {
  try {
    await promise
  } catch (error) {
    expect(error, '凭据读失败必须以 BrowserError 到达工具层（裸 Error = 未收口）').toBeInstanceOf(BrowserError)
    return error as BrowserError
  }
  throw new Error('expected the call to fail')
}

// ------------------------------------------------------------------ fixture

const USER = 'user-a'
const SERVER_A = 'https://harness-a.example.com'
const SERVER_B = 'https://harness-b.example.com'
const SITE = 'https://login.example'
const SECRET = 'hunter2-xyz9-quartz'

let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-browser-cred-fault-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
  for (const harness of opened.splice(0)) {
    try { harness.dispose() } catch { /* already disposed */ }
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

/** 真实作用域里的真实凭据文件路径（布局唯一真源 = connectors 的 user-scope）。 */
function credentialFile(serverURL: string, id: string): string {
  return join(connectorScopePath(USER, serverURL, process.env), `${id}.json`)
}

/** 用真 store 写一份真凭据（没有替身）。 */
async function seed(serverURL: string, id: string, fields: Record<string, string>): Promise<void> {
  await new ConnectorStore({ username: USER, serverURL }).writeCredential(id, { updatedAt: Date.now(), fields })
}

/** malformed：凭据路径被一个**目录**占住。 */
function breakMalformed(serverURL: string, id: string): void {
  const file = credentialFile(serverURL, id)
  rmSync(file, { recursive: true, force: true })
  mkdirSync(file, { recursive: true })
}

/** too-large：真写一份超过 64 KiB 读上限的文件。 */
function breakTooLarge(serverURL: string, id: string): void {
  writeFileSync(credentialFile(serverURL, id), `{"updatedAt":1,"padding":"${'x'.repeat(70 * 1024)}"}\n`)
}

/**
 * unreadable：凭据目录变成**自指符号链接** ⇒ `lstat(<dir>/<id>.json)` 得 ELOOP
 * （真实 errno；root 下 `chmod 000` 造不出 EACCES，ELOOP 造得出）。
 */
function breakUnreadable(serverURL: string): void {
  const dir = connectorScopePath(USER, serverURL, process.env)
  rmSync(dir, { recursive: true, force: true })
  symlinkSync('connectors', dir)
}

/** 枚举阶段故障：凭据目录被一个普通文件占住 ⇒ `readdir` 得 ENOTDIR。 */
function breakDirAsFile(serverURL: string): void {
  const dir = connectorScopePath(USER, serverURL, process.env)
  rmSync(dir, { recursive: true, force: true })
  writeFileSync(dir, 'not a directory\n')
}

function resolverOn(
  serverURL: string | (() => string),
  credentialSites?: Record<string, string>,
): NonNullable<ReturnType<typeof createCredentialResolver>> {
  return createCredentialResolver({
    currentUser: () => USER,
    currentServer: typeof serverURL === 'function' ? serverURL : () => serverURL,
    ...credentialSites === undefined ? {} : { credentialSites },
  })!
}

/** 页内表单填充脚本的应答（只有走到注入才会出现）。 */
const fillHandler = (method: string, params?: Record<string, unknown>): unknown => {
  if (method !== 'Runtime.evaluate') return {}
  return String(params?.['expression'] ?? '').includes('passField') ? { result: { value: { filled: 2, username: true, password: true } } } : {}
}

/** 工具面读失败的共同断言：分类 + 可操作 + **不含路径**（三种故障统一口径）。 */
function expectReadFailure(error: BrowserError, connectorId?: string): void {
  expect(error.code).toBe('not-found')
  expect(error.name).toBe('BrowserError')
  expect(error.message).toMatch(/could not be read/u)
  if (connectorId !== undefined) expect(error.message).toContain(JSON.stringify(connectorId))
  // 不是"没有凭据"，也不是"没有站点 URL"：读故障必须说成读故障。
  expect(error.message).not.toMatch(/no stored credentials/iu)
  expect(error.message).not.toMatch(/no usable http\(s\) site URL/u)
  // 不含路径（也不含数据根、文件名、作用域布局段）。
  expect(error.message).not.toContain(home)
  expect(error.message).not.toContain('.json')
  expect(error.message).not.toContain('servers')
  expect(error.message).not.toMatch(/[/\\]/u)
  // 密钥字节不得出现在错误里。
  expect(error.message).not.toContain(SECRET)
}

// ------------------------------------------- ① 读故障（真文件系统）

describe('① 凭据读失败：工具面拿到带分类/可操作/不含路径的 browserError', () => {
  it('fill：凭据文档不可读 ⇒ not-found 读错误，一个字节都没注入', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
    breakMalformed(SERVER_A, 'corp')
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    await harness.runtime.open(`${SITE}/login`)
    const view = harness.adapter.lastView()
    view.transport.handler = fillHandler

    const error = await rejection(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expectReadFailure(error, 'corp')
    expect(error.message).toMatch(/browser_type/u)
    expect(view.transport.commands.some((command) => String(command.params?.['expression'] ?? '').includes('passField'))).toBe(false)
  })

  it('fill：三种真实故障各自分类（malformed / too-large / unreadable）', async () => {
    const cases = [
      { label: 'malformed', expected: /not a valid credential document/u },
      { label: 'too-large', expected: /larger than/iu },
      { label: 'unreadable', expected: /refused the read/u },
    ]
    for (const { label, expected } of cases) {
      // 每个用例一份干净的真实数据根（上一条的破坏不带到下一条）。
      const server = `https://harness-${label}.example.com`
      await seed(server, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
      if (label === 'malformed') breakMalformed(server, 'corp')
      else if (label === 'too-large') breakTooLarge(server, 'corp')
      else breakUnreadable(server)
      const harness = track(makeHarness(resolverOn(server)))
      await harness.runtime.open(`${SITE}/login`)
      harness.adapter.lastView().transport.handler = fillHandler

      const error = await rejection(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
      expectReadFailure(error, 'corp')
      // 分类必须**真的分**：三种故障给的是三条不同的处理建议，而不是一句笼统文案。
      expect(error.message, `${label}: 处理建议必须与故障分类一致`).toMatch(expected)
    }
  })

  it('list：一条记录读不出来 ⇒ 拒绝调用，绝不返回"没有凭据"', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
    await seed(SERVER_A, 'other', { username: 'bob', password: 'pw-bob-2' })
    breakMalformed(SERVER_A, 'corp')
    const harness = track(makeHarness(resolverOn(SERVER_A)))

    const error = await rejection(harness.call('browser_credentials_list'))
    expectReadFailure(error, 'corp')
    // 如实报错：必须说清"列表不完整/被拒"，而不是让模型以为用户没有凭据。
    expect(error.message).toMatch(/incomplete/iu)
  })

  it('list：另一条记录读不出来时同样拒绝（不是只认第一条）', async () => {
    await seed(SERVER_A, 'aaa', { username: 'alice', password: SECRET })
    await seed(SERVER_A, 'zzz', { username: 'bob', password: 'pw-bob-2' })
    breakTooLarge(SERVER_A, 'zzz')
    const harness = track(makeHarness(resolverOn(SERVER_A)))

    const error = await rejection(harness.call('browser_credentials_list'))
    expectReadFailure(error, 'zzz')
  })

  it('list：凭据目录整体读不出来（枚举阶段）同样不得变成空列表', async () => {
    // `credentialIds()` 内部把 readdir 的 errno 吞成 `[]` —— 空列表必须再验一次存在性，
    // 否则"目录读不出来"会被列表工具说成"没有凭据"。两种真实形态各来一次。
    for (const breakScope of [breakUnreadable, breakDirAsFile]) {
      const server = `https://harness-enum-${Math.random().toString(36).slice(2)}.example.com`
      await seed(server, 'corp', { username: 'alice', password: SECRET })
      breakScope(server)
      const harness = track(makeHarness(resolverOn(server)))

      const error = await rejection(harness.call('browser_credentials_list'))
      // 目录级故障没有"哪一条"可报，所以只钉分类/可操作性/不含路径。
      expectReadFailure(error)
      expect(error.message).toMatch(/credential list/u)
      // 目录级故障同样要说清是哪一类（errno 短码），别退化成笼统一句。
      expect(error.message).toMatch(/refused the read \((ENOTDIR|ELOOP)\)/u)
    }
  })

  it('resolveCredentials 本身（runtime.ts:3626 的那条路径）不得漏出裸 Error', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
    breakMalformed(SERVER_A, 'corp')
    const resolver = resolverOn(SERVER_A)

    // 这条断言就是审计登记的那条：修前是 `CredentialReadError`（非 browserError）原样抛出。
    const error = await rejection(resolver('corp'))
    expectReadFailure(error, 'corp')
  })
})

// ------------------------------------------- ② 正向对照：逐字不变

describe('② 正向对照：ENOENT 与正常读取与修前逐字相同', () => {
  it('list：真无凭据 ⇒ 空列表 + 逐字 "No stored credentials."', async () => {
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    const value = await harness.call('browser_credentials_list')
    expect(value).toEqual({ credentials: [] })
    expect(harness.render('browser_credentials_list', value)).toBe('No stored credentials.')
  })

  it('list：目录存在但为空 ⇒ 仍是空列表 + 逐字 "No stored credentials."（存在性复核不得把"真没有"判成故障）', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET })
    rmSync(credentialFile(SERVER_A, 'corp'), { force: true })
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    const value = await harness.call('browser_credentials_list')
    expect(value).toEqual({ credentials: [] })
    expect(harness.render('browser_credentials_list', value)).toBe('No stored credentials.')
  })

  it('list：正常凭据 ⇒ 条目与渲染逐字不变', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET })
    await seed(SERVER_A, 'plain', { password: 'no-username' })
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    const value = await harness.call('browser_credentials_list')
    expect(value).toEqual({ credentials: [{ id: 'corp', username: 'alice' }, { id: 'plain' }] })
    expect(harness.render('browser_credentials_list', value)).toBe('corp (alice)\nplain')
  })

  it('fill：真无凭据（站点由部署声明）⇒ 逐字 not-found 文案（与"读失败"可区分）', async () => {
    // 站点绑定由部署显式声明，于是闸门不需要凭据字段 ⇒ 工具真的走到
    // `runtime.fillCredentials` 的 ENOENT 分支（这是"没有凭据"那条正向路径）。
    const harness = track(makeHarness(resolverOn(SERVER_A, { corp: `${SITE}/login` })))
    await harness.runtime.open(`${SITE}/login`)
    harness.adapter.lastView().transport.handler = fillHandler

    const error = await rejection(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expect(error.code).toBe('not-found')
    expect(error.message).toBe('browser: no stored credentials for connector "corp"')
  })

  it('fill：凭据读不出来但站点由部署声明 ⇒ 报"读失败"，不是"没有凭据"', async () => {
    // 与上一条只差一个真实读故障：同样的声明式站点绑定下，ENOENT 与读失败必须
    // 给出**不同**的结论（否则模型会把"读不出来"当成"用户没授权"）。
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET })
    breakMalformed(SERVER_A, 'corp')
    const harness = track(makeHarness(resolverOn(SERVER_A, { corp: `${SITE}/login` })))
    await harness.runtime.open(`${SITE}/login`)
    harness.adapter.lastView().transport.handler = fillHandler

    const error = await rejection(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expectReadFailure(error, 'corp')
  })

  it('fill：正常凭据 ⇒ 照常注入（不误杀）', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    await harness.runtime.open(`${SITE}/login`)
    harness.adapter.lastView().transport.handler = fillHandler
    await expect(harness.call('browser_fill_credentials', { connectorId: 'corp' })).resolves.toEqual({ username: true, password: true })
  })

  it('fill：正常凭据但站点不符 ⇒ 仍是 policy 拒绝（站点闸门没被读失败收口改坏）', async () => {
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    await harness.runtime.open('https://lookalike.example/login')
    harness.adapter.lastView().transport.handler = fillHandler

    const error = await rejection(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expect(error.code).toBe('policy')
    expect(error.message).toMatch(/is not on the site/u)
  })
})

// ------------------------------------------- ③ 两次读之间的作用域切换

describe('③ 站点闸门读 A、注入读 B（真实竞态窗口）', () => {
  it('第二次读撞上读故障 ⇒ 同一类 browserError，而不是裸 Error', async () => {
    // 站点闸门（`originOf`）与注入（`resolveCredentials`）各解析一次作用域 —— 这是
    // 生产上真实存在的窗口（会话/服务端身份在两次读之间可变）。故障本身是真的：
    // 作用域 B 里的凭据文件被一个目录占住，由真 store 真抛 CredentialReadError。
    await seed(SERVER_A, 'corp', { username: 'alice', password: SECRET, baseUrl: `${SITE}/login` })
    breakMalformed(SERVER_B, 'corp')
    let reads = 0
    const resolver = resolverOn(() => (reads++ === 0 ? SERVER_A : SERVER_B))
    const harness = track(makeHarness(resolver))
    await harness.runtime.open(`${SITE}/login`)
    const view = harness.adapter.lastView()
    view.transport.handler = fillHandler

    const error = await rejection(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expectReadFailure(error, 'corp')
    // 前提断言（防假绿）：站点闸门确实先读成功过一次，否则这条用例只是①的重复。
    expect(reads).toBeGreaterThan(1)
    expect(view.transport.commands.some((command) => String(command.params?.['expression'] ?? '').includes('passField'))).toBe(false)
  })
})

// ------------------------------------------- ④ 模型可见契约

describe('④ 两条凭据工具的描述与新行为一致', () => {
  it('描述里写清"读失败 ≠ 没有凭据"（列表）与"读失败会拒绝"（填充）', () => {
    const harness = track(makeHarness(resolverOn(SERVER_A)))
    const list = harness.tools.get('browser_credentials_list')!
    const fill = harness.tools.get('browser_fill_credentials')!
    expect(list.description).toMatch(/cannot be read|unreadable/iu)
    expect(list.description).toMatch(/no credentials/iu)
    expect(fill.description).toMatch(/cannot be read|unreadable/iu)
  })
})
