/**
 * R23（第二十三轮复审 W1）三条 P2 的判据：`browser_eval` 出口脱敏的"同族只修一半"。
 *
 * - **N1** `<敏感关键词> <纯字母不透明串>` 凭据明文出窗
 *   （`token ABCDEFGHIJKLMNOPQRSTUVWX`）。根因 = 片段判据要求"≥12 且**同时**含数字与
 *   字母"，而关键词分支没有"声明即敏感"这条**独立于形状**的判据 —— 认证头分支在
 *   R22 V6 F2 已经有（`Authorization: Basic YWFhYWFhYWE=` 靠方案名擦掉）。
 * - **N2** URL **userinfo** 明文出窗（`https://alice:pw@host/`），而同产品的
 *   `store.stripSensitiveUrl` 明确把 username/password 置 `****`；`browser_get_text`
 *   也不擦 —— 同一份数据三个出口两种口径。
 * - **N3** `k=v; k2=v2` **普通正文被整串抹成 `****`**（`width=100; height=200`），
 *   连键名一起消失 —— 正是 EV-1 要修的形态，且 `browser_get_text` 对同一段文本逐字
 *   可读（两个工具自相矛盾）。
 *
 * 每条都分正反两面：缺正向 = 擦漏了，缺反向 = 擦多了（把普通正文改坏同样不可接受）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore, maskCredentialUrlsInText, stripSensitiveUrl } from '../src/store.ts'
import { serializeEvalResult } from '../src/eval-policy.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

/** 纯字母（无数字）的不透明串：N1 的缺陷形态，base64 长度 ≥12 时无数字概率 ≈8.5%。 */
const LETTERS24 = 'ABCDEFGHIJKLMNOPQRSTUVWX'
/** 纯小写 hex 形态的长句柄（无数字）。 */
const LETTERS16 = 'deadbeefcafebabe'
/** 三段式 JWT。 */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123'
/** 假口令（公开仓纪律：一律用明显的假值）。 */
const PW = 'hunter2xyz'
/** URL 里的用户名。 */
const USER = 'alice'

// ------------------------------------------------------------------ 测试替身

class MockTransport implements CdpTransport {
  attached = false
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> { return this.handler(method, params) }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-test'
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
  partition = 'persist:agent-browser-test'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 100, height: 100 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }))
  setWindowOpenHandler = vi.fn()
  attach(_win: unknown, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args)
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
      on: (e: string, l: (...a: unknown[]) => void) => {
        this.listeners.set(e, [...(this.listeners.get(e) ?? []), l])
      },
      removeListener: (e: string, l: (...a: unknown[]) => void) => {
        this.listeners.set(e, (this.listeners.get(e) ?? []).filter((x) => x !== l))
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
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const v = new MockView(); this.views.push(v); return v }
  createMaskView(): NativeView { const v = new MockView(); this.overlays.push(v); return v }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {},
      show: () => {},
      hide: () => {},
      focus: () => {},
      isVisible: () => false,
      isDestroyed: () => false,
      close: () => {},
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

const opened: Array<{ runtime: BrowserRuntime; dir: string }> = []
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

/** `browser_get_text` 的判据要跑真 runtime（出口投影就在 `textWithMeta` 里）。 */
async function makeRuntime(): Promise<{ runtime: BrowserRuntime; adapter: MockAdapter }> {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.r23-mask-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store })
  opened.push({ runtime, dir })
  await runtime.open('https://page.example')
  return { runtime, adapter }
}

/** `browser_get_text` 拿到的页面正文（假 CDP：`Runtime.evaluate` 直接回这段文本）。 */
async function getTextOf(pageText: string): Promise<string> {
  const { runtime, adapter } = await makeRuntime()
  adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: pageText } } : {})
  return await runtime.text(1, undefined)
}

// ==================================================================== N1

describe('R23 N1：关键词声明的凭据（纯字母不透明串）不再明文出窗', () => {
  it.each([
    ['token', `token ${LETTERS24}`],
    ['secret', `secret ${LETTERS24}`],
    ['password', `password ${LETTERS24}`],
    ['api_key', `api_key ${LETTERS24}`],
    ['credential', `credential ${LETTERS24}`],
    ['session_id', `session_id ${LETTERS24}`],
    ['access_key', `access_key ${LETTERS24}`],
    ['refresh_token', `refresh_token ${LETTERS24}`],
    ['x-api-key（连字符形态）', `x-api-key: ${LETTERS24}`],
    ['api-key=（等号形态）', `api-key=${LETTERS24}`],
    ['token=（等号形态）', `token=${LETTERS24}`],
    ['token:<无空格>', `token:${LETTERS24}`],
    ['Bearer（方案名形态）', `Bearer ${LETTERS24}`],
    ['纯小写长句柄（16 个字母）', `token ${LETTERS16}`],
    ['关键词 + JWT', `token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123`],
  ])('%s：凭据不出窗', (_label, text) => {
    const out = serializeEvalResult(text)
    expect(out).not.toContain(LETTERS24)
    expect(out).not.toContain(LETTERS16)
    expect(out).toContain('****')
  })

  it.each([
    ['Token', `Authorization: Token ${LETTERS24}`],
    ['OAuth', `Authorization: OAuth ${LETTERS24}`],
    ['OAuth2', `Authorization: OAuth2 ${LETTERS24}`],
    ['SAML', `Authorization: SAML ${LETTERS24}`],
    ['小写 + 等号', `authorization=token ${LETTERS24}`],
  ])('认证方案名 %s 也是声明（与 AUTH_HEADER_VALUE 同一份判据）', (_label, text) => {
    const out = serializeEvalResult(text)
    expect(out).not.toContain(LETTERS24)
  })

  it('关键词 + 空格的等号/冒号形态逐条覆盖（不因改窄而回退）', () => {
    expect(serializeEvalResult(`session_id ${LETTERS24}`)).toBe('"session_id ****"')
    expect(serializeEvalResult(`refresh_token ${LETTERS24}`)).toBe('"refresh_token ****"')
    expect(serializeEvalResult(`api_key ${LETTERS24}`)).toBe('"api_key ****"')
    expect(serializeEvalResult(`token ${LETTERS24}`)).toBe('"token ****"')
  })
})

describe('R23 N1 反向：散文、占位符与普通正文逐字节保留（≥12 条）', () => {
  it.each([
    'the bearer of good news',
    'This page explains token budgets',
    'the secret garden',
    'password reset instructions',
    'The token authentication mechanism',
    'the token expired before the request was sent',
    'token rotation policy for the gateway',
    'password management guidelines are published internally',
    'secret management is documented separately',
    'credential rotation happens every ninety days',
    'api_key configuration is described below',
    'session_id is assigned by the server on login',
    'refresh_token lifetime is configured by the administrator',
    'access_key terminology appears throughout this page',
    'Cookie: the browser sends cookies',
    'Cookie policy: we use cookies to improve your experience',
    'Set-Cookie is a response header',
    'Authorization is required for this endpoint',
    'send the Authorization header',
    'a bearer token must be refreshed',
  ])('普通正文逐字节保留：%s', (text) => {
    expect(serializeEvalResult(text)).toBe(JSON.stringify(text))
  })

  it.each([
    '<your-token>',
    'YOUR_TOKEN_HERE',
    'xxxx',
    'token <your-token>',
    'token xxxx',
    'api_key <API_KEY>',
  ])('占位符逐字节保留：%s', (text) => {
    expect(serializeEvalResult(text)).toBe(JSON.stringify(text))
  })

  it('文档占位符与普通取值：键名仍在，正文不吃掉', () => {
    expect(serializeEvalResult('Authorization: Bearer <your-token>')).toContain('<your-token>')
    // `Authorization: none required` 的取值 `none` 仍按既有 `key: value` 口径擦掉
    // （Authorization 是强凭据键），但**句子剩下的部分逐字保留** —— 与 R22 判据同形。
    expect(serializeEvalResult('Authorization: none required')).toContain('required')
    expect(serializeEvalResult('Authorization: Bearer of good news')).toContain('of good news')
  })
})

// ==================================================================== N2

describe('R23 N2：URL userinfo 与 store.stripSensitiveUrl 同源', () => {
  it.each([
    ['username:password', `https://${USER}:${PW}@harness.example.com/`, [USER, PW]],
    ['仅 username', `https://${USER}@harness.example.com/`, [USER]],
    ['仅 password', `https://:${PW}@harness.example.com/`, [PW]],
    ['带端口', `https://${USER}:${PW}@harness.example.com:8443/a/b`, [USER, PW]],
    ['带 query + fragment', `https://${USER}:${PW}@harness.example.com/cb?next=%2Fhome#section`, [USER, PW]],
    ['百分号编码的 userinfo', `https://${USER}%40corp:p%40ss@harness.example.com/`, [`${USER}%40corp`, 'p%40ss']],
    ['userinfo 里再含 @', `https://${USER}@corp:${PW}@harness.example.com/`, [PW]],
    ['相对位置（正文里内嵌）', `see https://${USER}:${PW}@harness.example.com/docs for details`, [PW]],
  ])('%s：凭据不出窗、主机名可见', (_label, text, secrets) => {
    const out = serializeEvalResult(text)
    for (const secret of secrets) expect(out, `明文出窗：${secret} in ${out}`).not.toContain(secret)
    expect(out).toContain('****')
    expect(out).toContain('harness.example.com')
  })

  it('普通 URL 逐字节不变（含端口、query、fragment、正文内嵌形态）', () => {
    for (const text of [
      'https://harness.example.com/',
      'https://harness.example.com/a/b?page=2&sort=asc#top',
      'http://harness.example.com:8080/x',
      'see https://harness.example.com/docs for details',
      'download: https://harness.example.com/files/report.pdf',
    ]) {
      expect(serializeEvalResult(text)).toBe(JSON.stringify(text))
    }
  })

  it('URL 的 query / fragment 既有规则不变（新那一趟只增加结构脱敏）', () => {
    expect(serializeEvalResult('https://harness.example.com/cb?token=abc123def456&next=%2Fhome'))
      .toBe('"https://harness.example.com/cb?token=****&next=%2Fhome"')
    expect(serializeEvalResult('https://harness.example.com/#access_token=abc123def456'))
      .toBe('"https://harness.example.com/#access_token=****"')
  })

  it('与 store 的实现同源：出口里的 URL run 等于 stripSensitiveUrl 的结果', () => {
    const raw = `https://${USER}:${PW}@harness.example.com/a?page=1`
    // 同一份实现（不是第二份正则）：内嵌 URL 的 run 与整串 URL 的投影一致。
    expect(maskCredentialUrlsInText(raw)).toBe(stripSensitiveUrl(raw))
    expect(maskCredentialUrlsInText(raw)).toBe(`https://****:****@harness.example.com/a?page=1`)
    expect(maskCredentialUrlsInText(raw)).not.toContain(PW)
  })

  it('browser_get_text 与 browser_eval 对同一段页面文本同口径（内容出口共性缺口）', async () => {
    const pageText = `login failed for https://${USER}:${PW}@harness.example.com/sso (retry)`
    const viaGetText = await getTextOf(pageText)
    const viaEval = serializeEvalResult(pageText)
    expect(viaGetText).not.toContain(PW)
    expect(viaEval).not.toContain(PW)
    expect(viaGetText).toContain('harness.example.com')
    // 普通 URL 在两个出口都逐字节保留。
    const plain = 'see https://harness.example.com/docs for details'
    expect(await getTextOf(plain)).toBe(plain)
    // 查询串/片段凭据同样在两个出口都擦（同一份实现）。
    const query = 'callback: https://harness.example.com/cb?token=abc123def456&next=%2Fhome'
    expect(await getTextOf(query)).not.toContain('abc123def456')
    expect(serializeEvalResult(query)).not.toContain('abc123def456')
  })
})

// ==================================================================== N3

describe('R23 N3：`k=v; k2=v2` 普通正文不再被整串抹掉', () => {
  it.each([
    'width=100; height=200',
    'display=flex; gap=8px',
    'name=alice; role=admin',
    'path=/api; method=get',
    'margin=0; padding=0; border=0',
    'x=1;y=2;z=3',
    'font=14px; line-height=1.5',
    'left=0; top=0; right=0; bottom=0',
    'timeout=30; retries=3',
    'status=ok; latency=12ms',
    'theme=dark; density=compact',
    'lang=zh; region=cn',
    'grid-template-columns=1fr 1fr; gap=8px',
    'user=alice; email=alice@harness.example.com',
    'host=harness.example.com; port=8443',
    'color=#fff; background=#000',
    'enabled=true; retries=3; timeout=30s',
    'a=1; b=2; c=3',
  ])('普通键值列表逐字节保留：%s', (text) => {
    expect(serializeEvalResult(text)).toBe(JSON.stringify(text))
  })

  it('普通键值列表在 browser_get_text 也逐字节可读（两个出口口径一致）', async () => {
    for (const text of ['width=100; height=200', 'display=flex; gap=8px', 'name=alice; role=admin', 'x=1;y=2;z=3']) {
      expect(await getTextOf(text)).toBe(text)
    }
  })

  it('真正的凭据对必须被抹（收窄不等于放开）', () => {
    expect(serializeEvalResult(`password=${PW}`)).not.toContain(PW)
    expect(serializeEvalResult('api_key=sk-1234567890abcdefghij')).not.toContain('sk-1234567890abcdefghij')
    expect(serializeEvalResult(`token=${JWT}`)).not.toContain(JWT)
    expect(serializeEvalResult(`password=${PW}; user=alice`)).not.toContain(PW)
    // 只抹值、不抹整串：键名与普通对仍在（模型能看出这原本是什么）。
    expect(serializeEvalResult(`password=${PW}; user=alice`)).toContain('password=****')
    expect(serializeEvalResult(`password=${PW}; user=alice`)).toContain('user=alice')
  })

  it('真 cookie 串仍整串打码（P1-18 的回归面不退化）', () => {
    expect(serializeEvalResult('sid=abc123; theme=dark')).toBe('"****"')
    expect(serializeEvalResult('jsessionid=ABC123')).toBe('"****"')
    expect(serializeEvalResult('csrftoken=abcdef')).toBe('"****"')
    // 头形态按头名整段擦取值（键名保留）：R22 V6 F2 的口径，不再整串抹掉键名。
    expect(serializeEvalResult('Cookie: a=b; c=d')).toBe('"Cookie: ****"')
    expect(serializeEvalResult('Set-Cookie: a=b; Path=/; HttpOnly')).toBe('"****"')
    expect(serializeEvalResult('session=xyz; Path=/; HttpOnly')).toBe('"****"')
    expect(serializeEvalResult({ cookie: 'a=1; b=2; c=3' })).toBe('{"cookie":"****"}')
    expect(serializeEvalResult('Cookie: a=b')).toBe('"Cookie: ****"')
  })
})
