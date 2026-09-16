/**
 * i18n regression: the injected browser chrome must be served in the host
 * locale, per REQUEST.
 *
 * Two layers, because either alone is a false green:
 *
 *  1. RENDERING — `browserShellHtml(locale)` / `browserOverlayHtml(locale)`
 *     carry the full English copy and drop the Chinese markers (and the other
 *     way round for zh), including the copy the inline script uses at runtime
 *     (the `COPY` table embedded in the page, which is what the toolbar, the
 *     activity timeline, the ⋮ menu and the viewers actually render).
 *  2. RESOLUTION — the real `apply()` + the real `/browser-shell` and
 *     `/browser-overlay` handlers. The locale is resolved when the request is
 *     served, NOT when the plugin is applied: the same plugin instance must
 *     answer `zh` before and `en` after the probed `desktopRuntime.locale`
 *     changes (the frozen-module-constant bug class documented in
 *     `packages/host/connectors/src/client/status-label.ts`).
 *
 * Precedence is pinned too: the in-app runtime choice beats `Accept-Language`,
 * and `Accept-Language` is what a host without `desktopRuntime` falls back to.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserOverlayHtml, browserShellHtml, emptyHtml } from '../src/shell-pages.ts'
import { apply } from '../src/index.ts'

/**
 * Han characters + CJK punctuation. Full-width forms (`＋`, U+FF0B) are NOT
 * included on purpose: `＋` is the toolbar glyph the empty state points at, and
 * it is the same button in both locales.
 */
const HAN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff]/u

/** Strip what is NOT rendered copy: HTML/CSS comments and JS line comments. */
function renderedSurface(page: string): string {
  return page
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|\s)\/\/[^\n]*/gu, '$1')
}

/** Every marker must be absent from the RENDERED copy (comments are not copy). */
function expectAbsent(page: string, markers: readonly string[]): void {
  const surface = renderedSurface(page)
  for (const marker of markers) expect(surface, marker).not.toContain(marker)
}

/** The `const COPY = {…}` table the page's inline script reads at runtime. */
function pageCopy(page: string): Record<string, unknown> {
  const match = /const COPY = (\{.*\})\n/u.exec(page)
  if (match?.[1] === undefined) throw new Error('the page embeds no COPY table')
  // JSON.parse also proves the embed is valid JS/JSON after the `<` escaping.
  return JSON.parse(match[1]) as Record<string, unknown>
}

const SHELL_ZH_MARKERS = [
  '<title>AI 浏览器</title>',
  'title="新建标签页 (Ctrl+T)"',
  'title="后退 (Alt+←)"',
  'title="前进 (Alt+→)"',
  'title="刷新 (Ctrl+R)"',
  'title="收藏到书签"',
  'title="更多"',
  'aria-label="地址栏"',
  'placeholder="输入网址，回车访问（例如 https://example.com）"',
  '打开浏览器，AI 会在需要时自动打开网页。',
  '关闭标签',
]

const SHELL_EN_MARKERS = [
  '<title>AI Browser</title>',
  'title="New tab (Ctrl+T)"',
  'title="Back (Alt+←)"',
  'title="Forward (Alt+→)"',
  'title="Reload (Ctrl+R)"',
  'title="Bookmark this page"',
  'title="More"',
  'aria-label="Address bar"',
  'placeholder="Enter a URL and press Enter (for example https://example.com)"',
  'Open the browser: the AI opens pages here automatically when it needs to.',
  'Close tab',
]

const OVERLAY_ZH_MARKERS = [
  'title="点击查看 AI 活动"',
  'id="ai-take">我来操作<',
  'id="pill-take" type="button">我来操作<',
  '<h2>AI 活动 <',
  '>隐藏窗口<',
  'placeholder="搜索…"',
  '清除数据…',
  '清除全部浏览数据（含登录状态）？',
  '正在接管…',
  '正在交还…',
  '暂无操作记录',
  '加载失败，请重试',
  '"browser_screenshot":"截图"',
  '"menuHistory":"浏览历史"',
]

const OVERLAY_EN_MARKERS = [
  'title="Click to view AI activity"',
  'id="ai-take">Take over<',
  'id="pill-take" type="button">Take over<',
  '<h2>AI activity <',
  '>Hide window<',
  'placeholder="Search…"',
  'Clear browsing data…',
  'Clear all browsing data (including sign-in state)?',
  'Taking over…',
  'Handing back…',
  'No activity yet',
  'Failed to load, please retry',
  '"browser_screenshot":"Screenshot"',
  '"menuHistory":"History"',
]

describe('injected chrome copy is per locale', () => {
  it('the shell page renders the English toolbar and no Chinese marker', () => {
    const page = browserShellHtml('en')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true)
    for (const marker of SHELL_EN_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, SHELL_ZH_MARKERS)
    // Nothing user-visible is left in Chinese: comments (HTML/CSS/JS) are not copy.
    expect(renderedSurface(page).match(HAN)).toBeNull()
  })

  it('the shell page renders the Chinese toolbar and no English marker', () => {
    const page = browserShellHtml('zh')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true)
    for (const marker of SHELL_ZH_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, SHELL_EN_MARKERS)
  })

  it('the overlay page renders the English control/panel/menu/viewer copy', () => {
    const page = browserOverlayHtml('en')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true)
    for (const marker of OVERLAY_EN_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, OVERLAY_ZH_MARKERS)
    expect(renderedSurface(page).match(HAN)).toBeNull()
  })

  it('the overlay page renders the Chinese control/panel/menu/viewer copy', () => {
    const page = browserOverlayHtml('zh')
    expect(page.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true)
    for (const marker of OVERLAY_ZH_MARKERS) expect(page, marker).toContain(marker)
    expectAbsent(page, OVERLAY_EN_MARKERS)
  })

  it('the inline-script copy table (what the timeline/menu render) follows the locale', () => {
    const zh = pageCopy(browserOverlayHtml('zh'))
    const en = pageCopy(browserOverlayHtml('en'))
    expect(zh.takeOver).toBe('我来操作')
    expect(zh.handBack).toBe('交给 AI')
    expect(en.takeOver).toBe('Take over')
    expect(en.handBack).toBe('Hand back to AI')
    expect((zh.toolLabels as Record<string, string>).browser_click).toBe('点击')
    expect((en.toolLabels as Record<string, string>).browser_click).toBe('Click')
    // Every dynamic string must be locale-consistent: no zh value survives in
    // the English table (this is the table the page reads, not the markup).
    expect(JSON.stringify(en).match(HAN)).toBeNull()
    expect(zh.aiBusyPrefix).toBe('AI 正在操作 · ')
    expect(en.aiBusyPrefix).toBe('AI is working · ')
    expect(en.timeLocale).toBe('en-US')
    // Both pages embed the SAME failure mapper copy (a page missing a field
    // renders `undefined…` in its toast — that regression happened once here).
    const shellZh = pageCopy(browserShellHtml('zh'))
    const shellEn = pageCopy(browserShellHtml('en'))
    for (const table of [zh, shellZh]) {
      expect(table.failCredentials).toBe('操作失败：浏览器会话凭据尚未就绪，请重试')
      expect(table.failPrefix).toBe('操作失败：')
    }
    for (const table of [en, shellEn]) {
      expect(String(table.failCredentials)).toContain('Action failed')
      expect(table.failPrefix).toBe('Action failed: ')
    }
    // The empty state is DATA: the renderer escapes each line and adds the
    // `<br/>` itself, so a translation (the one field a translator rewrites)
    // can neither inject markup nor close the surrounding <script>.
    expect(emptyHtml('a</script><script>window.__pwned=1</script><br/>b'))
      .toBe('a&lt;/script&gt;&lt;script&gt;window.__pwned=1&lt;/script&gt;&lt;br/&gt;b')
    expect(emptyHtml('one\ntwo')).toBe('one<br/>two')
    const shell = browserShellHtml('zh')
    expect(shell).toContain('打开浏览器，AI 会在需要时自动打开网页。<br/>你也可以点右上角 ＋ 先自己逛起来。')
    // …and the escaping is why the served page has exactly ONE </script> (its own).
    expect(shell.match(/<\/script>/gu)).toHaveLength(1)
    expect(browserOverlayHtml('en').match(/<\/script>/gu)).toHaveLength(1)
  })

  it('keeps the empty-state copy markup-free (the renderer owns the <br/>)', () => {
    // 渲染层断言无法区分"字典里带 <br/>"与"渲染器插 <br/>"（两者产出的 HTML 逐字节
    // 相同），所以 2026-09-16 R2 复核实测：把 C1 完整回退后上一组断言仍然全绿。
    // 这条直接钉字典是数据 —— 文案里出现 `<`/`>` 即红。
    const source = readFileSync(new URL('../src/shell-pages.ts', import.meta.url), 'utf8')
    const values = [...source.matchAll(/\n\s*empty: '((?:[^'\\]|\\.)*)'/gu)].map((match) => match[1]!)
    expect(values).toHaveLength(2)
    for (const value of values) {
      expect(value, value).not.toMatch(/[<>]/u)
      expect(value, value).toContain('\\n')
    }
  })
})

/* ------------------------------------------------------------------ *
 * Model-facing surface: ONE language (English), pinned here
 * ------------------------------------------------------------------ */

/**
 * Tool descriptions and the system-prompt band are registered ONCE at
 * plugin-apply time, so they cannot follow the request locale. Mixing the
 * languages (the pre-i18n state: English bodies with Chinese `[导航]` tags and
 * hard-coded Chinese button names) is the worst of both worlds, and naming a
 * localized control in a fixed language is wrong for one of the two UIs. This
 * guard keeps the chosen policy — English only, controls named by function —
 * from silently drifting back.
 */
describe('model-facing tool copy is single-language (English)', () => {
  const TOOLS_SOURCE = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const GROUP_IDS = ['navigate', 'interact', 'read', 'write', 'memory', 'artifacts', 'control']

  it('every tool description carries an English GROUP_OF tag', () => {
    const tags = [...TOOLS_SOURCE.matchAll(/description: '\[([^\]]+)\]/gu)].map((match) => match[1]!)
    expect(tags.length).toBeGreaterThanOrEqual(30)
    const unknown = tags.filter((tag) => !GROUP_IDS.includes(tag))
    expect(unknown, 'tool description tags must be the English group ids').toEqual([])
  })

  it('no CJK survives outside source comments', () => {
    const code = TOOLS_SOURCE
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|\s)\/\/[^\n]*/gu, '$1')
    expect(code.match(HAN)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Resolution: the real plugin routes, served twice by one plugin instance
 * ------------------------------------------------------------------ */

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** A request as the shell/overlay webContents sends it (same-origin, loopback). */
function fakeReq(url: string, acceptLanguage?: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      ...(acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { /* GET: no body */ },
  } as unknown as IncomingMessage
}

/** HTML response capture (the JSON helper in the other specs cannot read HTML). */
function fakeRes(): { res: ServerResponse, read: () => { code: number, body: string } } {
  let code = 0
  let body = ''
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => { body = chunk === undefined ? '' : chunk.toString() },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

let home: string
let routes: Route[]
/** Mutable probed runtime: the test flips `locale` between two requests. */
let runtimeProbe: { locale?: unknown } | undefined

function harness(withRuntime = true): void {
  routes = []
  runtimeProbe = withRuntime ? { locale: 'zh' } : undefined
  const ctx = {
    get: (name: string) => {
      if (name === 'picoSession') return { getSession: () => null }
      if (name === 'desktopRuntime') return runtimeProbe
      if (name === 'connection') return undefined
      return undefined
    },
    on: () => () => {},
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: {
      port: 3080,
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {})
}

async function get(path: string, acceptLanguage?: string): Promise<string> {
  const route = routes.find((r) => r.kind === 'exact' && r.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  const out = fakeRes()
  await route.handler(fakeReq(path, acceptLanguage), out.res)
  const { code, body } = out.read()
  expect(code, path).toBe(200)
  return body
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-browser-i18n-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('the served pages follow the locale resolved per request', () => {
  it('the SAME plugin instance serves zh, then en, with no re-apply', async () => {
    harness()
    expect(await get('/browser-shell')).toContain('<html lang="zh-CN">')
    expect(await get('/browser-overlay')).toContain('id="ai-take">我来操作<')

    // The user switches the application language while the browser window is
    // open: only the probed runtime changes, the plugin is NOT re-applied.
    runtimeProbe!.locale = 'en'

    expect(await get('/browser-shell')).toContain('<html lang="en">')
    expect(await get('/browser-overlay')).toContain('id="ai-take">Take over<')
    // …and the flip is not one-way.
    runtimeProbe!.locale = 'zh'
    expect(await get('/browser-shell')).toContain('<html lang="zh-CN">')
  })

  it('the in-app runtime choice beats Accept-Language', async () => {
    harness()
    runtimeProbe!.locale = 'zh'
    expect(await get('/browser-shell', 'en-US,en;q=0.9')).toContain('<html lang="zh-CN">')
    runtimeProbe!.locale = 'en'
    expect(await get('/browser-shell', 'zh-CN,zh;q=0.9')).toContain('<html lang="en">')
  })

  it('the runtime service itself is probed per request (a late-composed launcher is picked up)', async () => {
    harness(false)
    // No launcher yet: the request header decides.
    expect(await get('/browser-shell', 'en-US,en;q=0.9')).toContain('<html lang="en">')
    // The launcher composes later; the same plugin instance must see it without
    // a re-apply, and the runtime value must now win over the header.
    runtimeProbe = { locale: 'en' }
    expect(await get('/browser-shell', 'zh-CN,zh;q=0.9')).toContain('<html lang="en">')
  })

  it('falls back to Accept-Language, then to the product default (zh)', async () => {
    harness(false)
    expect(await get('/browser-overlay', 'en-US,en;q=0.9')).toContain('<html lang="en">')
    expect(await get('/browser-overlay', 'en-US,en;q=0.9')).toContain('id="ai-take">Take over<')
    // No header at all: the product default (same as the client dictionaries).
    expect(await get('/browser-overlay')).toContain('<html lang="zh-CN">')
    // Unsupported languages never win over the default.
    expect(await get('/browser-overlay', 'ja,zh;q=0.8')).toContain('<html lang="zh-CN">')
  })
})
