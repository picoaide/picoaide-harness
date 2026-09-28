/**
 * R24 N2（P2）判据：URL 脱敏接进**内容出口**时引入的过度掩码。
 *
 * 缺陷（X2 审计实跑 `4b3aa112ca^` vs HEAD 对拍）：上一轮把 store 的 URL 那一趟
 * （`maskCredentialUrlsInText` → `stripSensitiveUrl`）接进 `redactSecretsText` 之后，
 * `browser_get_text` / `browser_get_snapshot` 开始用 URL 面的**子串**词表
 * （{@link SENSITIVE_TERMS} 含 `key`/`code`/`sid`/`auth`）判页面正文里的普通查询键：
 *
 *   `?keyword=` / `?zipcode=` / `?barcode=` / `?monkey=` / `?country_code=` / `?key=`
 *
 * 的值全变成 `****`（A5 读数：`4b3aa112ca^` 6 行 → HEAD 12 行，新增的 6 行全在
 * get_text 侧）。这正是 R23 N3 刚修掉的"普通正文被改坏"，只是从 `k=v; k2=v2` 换到了
 * "正文里的普通 URL"；`browser_eval` 侧早在改动前就有这条误伤。
 *
 * 修复：内容出口的 URL 键判定改为**整键**（`isContentUrlSensitiveKey`，`content` 档），
 * 落盘面（`stripSensitiveText`/`stripSensitiveUrl` 的默认 `url` 档）逐字节不变。
 *
 * 判据四块：① 六个复发形态在**两条出口**逐字节保留；② 真敏感键仍被掩码；
 * ③ 64 例语料双出口逐字节对拍（差异清单必须为空；`sid`/`session`/`auth` 三例按
 * "整串 cookie 形状"登记为有意差异）；④ 落盘面跨版本金标逐字节不变。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore, maskSensitiveKeyValueText, stripSensitiveText, stripSensitiveUrl } from '../src/store.ts'
import { serializeEvalResult } from '../src/eval-policy.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

/** 假口令/假令牌（公开仓纪律：一律用明显的假值）。 */
const PW = 'hunter2xyz'
const TOK = 'abc123def456'
const HOST = 'harness.example.com'

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

/** `browser_get_text` 的判据必须跑真 runtime（出口投影就在 `textWithMeta` 里）。 */
async function makeRuntime(): Promise<{ runtime: BrowserRuntime; adapter: MockAdapter }> {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.r24-url-grade-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store })
  opened.push({ runtime, dir })
  await runtime.open('https://page.example')
  return { runtime, adapter }
}

/** `browser_get_text` 出口拿到的页面正文（假 CDP：`Runtime.evaluate` 直接回这段文本）。 */
async function getTextOf(pageText: string): Promise<string> {
  const { runtime, adapter } = await makeRuntime()
  adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: pageText } } : {})
  return await runtime.text(1, undefined)
}

/** `browser_eval` 出口（值级漏斗）。 */
function evalOf(text: string): string {
  return JSON.parse(serializeEvalResult(text)) as string
}

/** 两条内容出口的读数。 */
async function bothExits(text: string): Promise<{ eval: string; text: string }> {
  return { eval: evalOf(text), text: await getTextOf(text) }
}

// ------------------------------------------------------ ① 六个复发形态

/** X2 审计 A5 语料里被误伤的六个普通查询键形态（HEAD 上 get_text 侧新增的 6 行）。 */
const RECURRING_ORDINARY_URLS: readonly string[] = [
  `https://${HOST}/?keyword=hello`,
  `https://${HOST}/?zipcode=10001`,
  `https://${HOST}/?barcode=987654`,
  `https://${HOST}/?monkey=1`,
  `https://${HOST}/?country_code=US`,
  `https://${HOST}/items?sort=price&key=sku`,
]

describe('R24 N2 ① 六个复发形态在两条出口逐字节保留', () => {
  it.each(RECURRING_ORDINARY_URLS)('逐字节保留（eval 与 get_text 两出口）：%s', async (text) => {
    const out = await bothExits(text)
    expect(out.eval).toBe(text)
    expect(out.text).toBe(text)
  })

  it('同一批形态内嵌在正文里同样逐字节保留', async () => {
    for (const text of [
      `see https://${HOST}/?keyword=hello for details`,
      `searching https://${HOST}/?zipcode=10001.`,
      `next: https://${HOST}/items?sort=price&key=sku, then done`,
    ]) {
      const out = await bothExits(text)
      expect(out.eval).toBe(text)
      expect(out.text).toBe(text)
    }
  })
})

// ------------------------------------------------------ ② 真敏感键仍掩码

/** 真敏感键（必须继续掩码）：整键命中 + 无歧义词尾两类。 */
const SENSITIVE_URLS: ReadonlyArray<readonly [label: string, text: string, secret: string]> = [
  ['token', `https://h/cb?token=${TOK}`, TOK],
  ['api_key', `https://h/cb?api_key=sk-1234567890abcdef`, 'sk-1234567890abcdef'],
  ['access_token', `https://h/cb?access_token=${TOK}`, TOK],
  ['refresh_token', `https://h/cb?refresh_token=${TOK}`, TOK],
  ['oauth_token（词尾）', `https://h/cb?oauth_token=${TOK}`, TOK],
  ['password', `https://h/cb?password=${PW}`, PW],
  ['passwd', `https://h/cb?passwd=${PW}`, PW],
  ['secret', `https://h/cb?secret=${TOK}`, TOK],
  ['client_secret', `https://h/cb?client_secret=${TOK}`, TOK],
  ['signature', `https://h/cb?signature=${TOK}`, TOK],
  ['X-Amz-Signature', `https://h/cb?X-Amz-Signature=${TOK}`, TOK],
  ['X-Amz-Credential', `https://h/cb?X-Amz-Credential=${TOK}`, TOK],
  ['code（OAuth 授权码）', `https://h/cb?code=AUTHCODE123`, 'AUTHCODE123'],
  ['credential', `https://h/cb?credential=${TOK}`, TOK],
  ['assertion', `https://h/cb?assertion=${TOK}`, TOK],
  ['SAMLResponse', `https://h/cb?SAMLResponse=${TOK}`, TOK],
  ['ticket', `https://h/cb?ticket=${TOK}`, TOK],
  ['jwt', `https://h/cb?jwt=${TOK}`, TOK],
  ['accessToken（camelCase）', `https://h/cb?accessToken=${TOK}`, TOK],
  ['ACCESS-TOKEN（分隔符变体）', `https://h/cb?ACCESS-TOKEN=${TOK}`, TOK],
  ['fragment access_token', `https://h/cb#access_token=${TOK}`, TOK],
  ['fragment code', `https://h/cb#code=${TOK}`, TOK],
  ['userinfo 用户名/口令', `https://alice:${PW}@h/x`, PW],
  ['percent 二次编码 sid', 'https://h/cb?%2573id=T', 'T'],
]

describe('R24 N2 ② 真敏感键在两条出口仍被掩码（收窄不等于放开）', () => {
  it.each(SENSITIVE_URLS)('%s：凭据不出窗', async (_label, text, secret) => {
    const out = await bothExits(text)
    expect(out.eval, `eval 出口明文：${out.eval}`).not.toContain(secret)
    expect(out.text, `get_text 出口明文：${out.text}`).not.toContain(secret)
    expect(out.eval).toContain('****')
    expect(out.text).toContain('****')
    // 主机名仍可辨认（掩码只擦取值/凭据段）。
    expect(out.eval).toContain('h/')
  })

  it('普通 URL 逐字节不变（同族反例，含端口/query/fragment/正文内嵌）', async () => {
    for (const text of [
      `https://${HOST}/`,
      `https://${HOST}/a/b?page=2&sort=asc#top`,
      `http://${HOST}:8080/x`,
      `see https://${HOST}/docs for details`,
      `download: https://${HOST}/files/report.pdf`,
      `read https://${HOST}/docs.`,
      `https://${HOST}/user@example/a`,
      `https://${HOST}/a:b/c`,
    ]) {
      const out = await bothExits(text)
      expect(out.eval).toBe(text)
      expect(out.text).toBe(text)
    }
  })
})

// ------------------------------------------- ③ 64 例语料双出口逐字节对拍

/** 64 例 URL 面语料（双出口共用同一份 `maskCredentialUrlsInText` 投影）。 */
const DUAL_EXIT_CORPUS: readonly string[] = [
  // —— 普通 URL（必须逐字节保留）——
  `https://${HOST}/`,
  `https://${HOST}/a/b?page=2&sort=asc#top`,
  `http://${HOST}:8080/x`,
  `see https://${HOST}/docs for details`,
  `download: https://${HOST}/files/report.pdf`,
  `read https://${HOST}/docs.`,
  `https://${HOST}/user@example/a`,
  `https://${HOST}/a:b/c`,
  `https://${HOST}/?keyword=hello`,
  `https://${HOST}/?zipcode=10001`,
  `https://${HOST}/?barcode=987654`,
  `https://${HOST}/?monkey=1`,
  `https://${HOST}/?country_code=US`,
  `https://${HOST}/items?sort=price&key=sku`,
  `https://${HOST}/?tokenizer=1`,
  `https://${HOST}/?tokens=2`,
  `https://${HOST}/?secrets=3`,
  `https://${HOST}/?monkeys=4`,
  `https://${HOST}/search?q=key+value`,
  `https://${HOST}/path/to/page.html?lang=zh-CN#section-2`,
  // —— 敏感查询键（必须掩码）——
  `https://h/cb?token=${TOK}`,
  `https://h/cb?api_key=sk-1234567890abcdef`,
  `https://h/cb?access_token=${TOK}`,
  `https://h/cb?refresh_token=${TOK}`,
  `https://h/cb?id_token=${TOK}`,
  `https://h/cb?oauth_token=${TOK}`,
  `https://h/cb?password=${PW}`,
  `https://h/cb?passwd=${PW}`,
  `https://h/cb?secret=${TOK}`,
  `https://h/cb?client_secret=${TOK}`,
  `https://h/cb?signature=${TOK}`,
  `https://h/cb?X-Amz-Signature=${TOK}`,
  `https://h/cb?X-Amz-Credential=${TOK}`,
  `https://h/cb?X-Amz-Security-Token=${TOK}`,
  `https://h/cb?code=AUTHCODE123`,
  `https://h/cb?credential=${TOK}`,
  `https://h/cb?assertion=${TOK}`,
  `https://h/cb?SAMLResponse=${TOK}`,
  `https://h/cb?ticket=${TOK}`,
  `https://h/cb?jwt=${TOK}`,
  `https://h/cb?bearer=${TOK}`,
  `https://h/cb?apikey=${TOK}`,
  `https://h/cb?x-api-key=${TOK}`,
  `https://h/cb?access_key=${TOK}`,
  // —— fragment / userinfo ——
  `https://h/cb#access_token=${TOK}`,
  `https://h/cb#code=${TOK}`,
  `https://alice:${PW}@h/x`,
  `https://alice@h/x`,
  `https://:${PW}@h/x`,
  `https://alice:${PW}@h:8443/a?page=1`,
  `see https://alice:${PW}@h/docs for details`,
  // —— 混合与边界形态 ——
  `https://h/cb?token=${TOK}&next=%2Fhome#frag`,
  `https://h/?keyword=hello&token=${TOK}`,
  `https://h/items?sort=price&key=sku&api_key=sk-1234567890abcdef`,
  `https://h/cb?country_code=US&access_token=${TOK}`,
  'https://h/cb?%2573id=T',
  'https://h/cb?a=1;token=abc123def456',
  `https://h/cb?code=abc&code=def`,
  `https://h/cb?TOKEN=${TOK}`,
  `https://h/cb?accessToken=${TOK}`,
  `https://h/cb?ACCESS-TOKEN=${TOK}`,
  `{"url":"https://h/cb?token=${TOK}"}`,
  `https://h/cb?token=${TOK}.`,
  `https://h/cb?token=${TOK}&`,
]

describe('R24 N2 ③ 64 例语料：eval 与 get_text 逐字节对拍', () => {
  it('语料规模固定为 64 例（改语料必须同步本判据）', () => {
    expect(DUAL_EXIT_CORPUS.length).toBe(64)
    expect(new Set(DUAL_EXIT_CORPUS).size).toBe(64)
  })

  it('差异清单为空', async () => {
    const diffs: string[] = []
    const rows: string[] = []
    for (const text of DUAL_EXIT_CORPUS) {
      const out = await bothExits(text)
      rows.push(`[R24 ③] ${JSON.stringify(text)}\n         eval=${JSON.stringify(out.eval)}\n         text=${JSON.stringify(out.text)}`)
      if (out.eval !== out.text) diffs.push(`eval=${JSON.stringify(out.eval)} | text=${JSON.stringify(out.text)} | ${JSON.stringify(text)}`)
    }
    console.log(rows.join('\n'))
    console.log(`\n=== R24 ③ 双出口差异 ${diffs.length} ===\n${diffs.join('\n')}`)
    expect(diffs).toEqual([])
  })

  it('登记为有意的差异：`?sid=`/`?session=`/`?auth=` 在 eval 侧整串打码（P1-18 cookie 形状）', async () => {
    // 这三例**已知且有据**：整串就是"会话 cookie 名=值"的形状，`browser_eval` 的
    // `looksLikeCookieString`（P1-18）整串打码，而 get_text 只走 URL 投影。
    // 不是本次改动引入（`eval` 侧一直如此），故登记而不改判据。
    for (const [text, expectedEval, expectedText] of [
      [`https://h/cb?sid=${TOK}`, '****', 'https://h/cb?sid=****'],
      [`https://h/cb?session=${TOK}`, '****', 'https://h/cb?session=****'],
      [`https://h/cb?auth=${TOK}`, '****', 'https://h/cb?auth=****'],
    ]) {
      expect(evalOf(text)).toBe(expectedEval)
      expect(await getTextOf(text)).toBe(expectedText)
    }
  })
})

// ------------------------------------------- ④ 落盘面跨版本逐字节不变

/**
 * `stripSensitiveUrl` / `stripSensitiveText` / `maskSensitiveKeyValueText`（默认
 * `url` 档）的金标读数，**采集自改动前的 HEAD**（`node vitest run` 打印
 * `STORE_FACE_GOLDEN=`）。这三条是既有的落盘契约（写入即不可逆），本次改动不得
 * 让它们产生任何字节差异 —— 元组是 `[raw, stripSensitiveUrl, stripSensitiveText,
 * maskSensitiveKeyValueText]`。
 */
const STORE_FACE_GOLDEN: ReadonlyArray<readonly [raw: string, url: string, text: string, kv: string]> = [
  ["https://example.com/p?code=abc&q=x", "https://example.com/p?code=****&q=x", "https://example.com/p?code=****&q=x", "https://example.com/p?code=****&q=x"],
  ["https://h/cb?code=SECRET&key=v&sid=1", "https://h/cb?code=****&key=****&sid=****", "https://h/cb?code=****&key=****&sid=****", "https://h/cb?code=****&key=****&sid=****"],
  ["https://example.com/s?token=abc&q=hello&code=9", "https://example.com/s?token=****&q=hello&code=****", "https://example.com/s?token=****&q=hello&code=****", "https://example.com/s?token=****&q=hello&code=****"],
  ["https://h/cb?session=FAKESESSION789", "https://h/cb?session=****", "https://h/cb?session=****", "https://h/cb?session=****"],
  ["https://h/cb?keyword=hello&zipcode=10001&barcode=987654&monkey=1&country_code=US&sort=price&key=sku", "https://h/cb?keyword=****&zipcode=****&barcode=****&monkey=****&country_code=****&sort=price&key=****", "https://h/cb?keyword=****&zipcode=****&barcode=****&monkey=****&country_code=****&sort=price&key=****", "https://h/cb?keyword=****&zipcode=****&barcode=****&monkey=****&country_code=****&sort=price&key=****"],
  ["https://alice:pw@idp.example/cb#sid=SECRETVALUE", "https://****:****@idp.example/cb#sid=****", "https://****:****@idp.example/cb#sid=****", "https://alice:pw@idp.example/cb#sid=****"],
  ["https://example.com/cb#access_token=eyJhbGci", "https://example.com/cb#access_token=****", "https://example.com/cb#access_token=****", "https://example.com/cb#access_token=****"],
  ["https://h/a?%2573id=T&x=1", "https://h/a?%2573id=****&x=1", "https://h/a?%2573id=****&x=1", "https://h/a?%2573id=****&x=1"],
  ["https://h/cb?token=a&token=b&session=NOPE", "https://h/cb?token=****&session=****", "https://h/cb?token=****&session=****", "https://h/cb?token=****&token=****&session=****"],
  ["https://example.com", "https://example.com", "https://example.com", "https://example.com"],
  ["https://example.com/p?q=1", "https://example.com/p?q=1", "https://example.com/p?q=1", "https://example.com/p?q=1"],
  ["not a url", "not a url", "not a url", "not a url"],
  ["see code=404 and sid=7", "see code=**** and sid=****", "see code=404 and sid=7", "see code=**** and sid=****"],
  ["see https://h/cb?session=SESS for details", "see https://h/cb?session=**** for details", "see https://h/cb?session=**** for details", "see https://h/cb?session=**** for details"],
  ["搜索 “key=value” 的含义", "搜索 “key=**** 的含义", "搜索 “key=value” 的含义", "搜索 “key=**** 的含义"],
  ["width=100; height=200", "width=100; height=200", "width=100; height=200", "width=100; height=200"],
  ["Login failed: code=T14&state=x", "Login failed: code=****&state=x", "Login failed: code=****&state=x", "Login failed: code=****&state=x"],
  ["token=T12", "token=****", "token=****", "token=****"],
  ["token=T12.", "token=****.", "token=****.", "token=****."],
  ["token = T12", "token = ****", "token = ****", "token = ****"],
  ["{\"code\":\"T14\"}", "{\"code\":\"****\"}", "{\"code\":\"****\"}", "{\"code\":\"****\"}"],
  ["see token=X below", "see token=**** below", "see token=**** below", "see token=**** below"],
  ["download: https://example.com/dl/a.zip?token=DLTOK", "download: https://example.com/dl/a.zip?token=****", "download: https://example.com/dl/a.zip?token=****", "download: https://example.com/dl/a.zip?token=****"],
  ["Sign in - https://idp.example/cb?code=OPAQUE&SAMLResponse=S1#access_token=F1", "Sign in - https://idp.example/cb?code=****&SAMLResponse=****#access_token=****", "Sign in - https://idp.example/cb?code=****&SAMLResponse=****#access_token=****", "Sign in - https://idp.example/cb?code=****&SAMLResponse=****#access_token=****"],
  ["https://h/?auth=x&assertion=y&ticket=z&jwt=j&signature=s&credential=c&saml=s", "https://h/?auth=****&assertion=****&ticket=****&jwt=****&signature=****&credential=****&saml=****", "https://h/?auth=****&assertion=****&ticket=****&jwt=****&signature=****&credential=****&saml=****", "https://h/?auth=****&assertion=****&ticket=****&jwt=****&signature=****&credential=****&saml=****"],
  ["https://h/?tokenizer=1&tokens=2&secrets=3&monkeys=4", "https://h/?tokenizer=****&tokens=****&secrets=****&monkeys=****", "https://h/?tokenizer=****&tokens=****&secrets=****&monkeys=****", "https://h/?tokenizer=****&tokens=****&secrets=****&monkeys=****"],
  ["https://h/#/route?code=abc&q=1", "https://h/#/route?code=****&q=1", "https://h/#/route?code=****&q=1", "https://h/#/route?code=****&q=1"],
  ["https://h/p?X-Amz-Signature=SIG&X-Amz-Credential=CRED", "https://h/p?X-Amz-Signature=****&X-Amz-Credential=****", "https://h/p?X-Amz-Signature=****&X-Amz-Credential=****", "https://h/p?X-Amz-Signature=****&X-Amz-Credential=****"],
  ["session=xyz; Path=/; HttpOnly", "session=****; Path=/; HttpOnly", "session=****; Path=/; HttpOnly", "session=****; Path=/; HttpOnly"],
  ["sid=abc123; theme=dark", "sid=****; theme=dark", "sid=****; theme=dark", "sid=****; theme=dark"],
]

describe('R24 N2 ④ 落盘面（url 档）逐字节不变', () => {
  it.each(STORE_FACE_GOLDEN)('金标读数一致：%s', (raw, url, text, kv) => {
    expect(stripSensitiveUrl(raw)).toBe(url)
    expect(stripSensitiveText(raw)).toBe(text)
    expect(maskSensitiveKeyValueText(raw)).toBe(kv)
  })

  it('`content` 档只是新增档位：默认档位仍是 url（`?keyword=` 在落盘面照旧掩码）', () => {
    expect(stripSensitiveUrl(`https://h/?keyword=hello`)).toBe('https://h/?keyword=****')
    expect(stripSensitiveUrl(`https://h/?keyword=hello`, 'content')).toBe('https://h/?keyword=hello')
  })
})
