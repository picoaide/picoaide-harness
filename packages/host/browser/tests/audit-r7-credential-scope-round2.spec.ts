/**
 * R7 **round-2** regression lock (browser): the regressions the round-1
 * credential-scope patch introduced, found by the adversarial re-check
 * (`multiagent-bug-audit-r3/RECHECK-F4F5.md` §2 F-2..F-5).
 *
 * Every case below fails on the round-1 tree and passes after the round-2 fix;
 * the corresponding round-1 behaviour (origin-scoped value set + window,
 * redact-before-truncate) is re-asserted in `audit-r7-credential-scope.spec.ts`
 * and must stay green.
 *
 * - **F-2** the R7 tail backstop (`maskTruncatedSecretTail`) matched "text ends
 *   with a prefix of an injected value" **without requiring that the text was
 *   truncated at all**. A password starting with a common word (`Security123!`)
 *   rewrote `Privacy and Security` into `Privacy and ****` and — worse — the
 *   *persisted* history URL / op-log summary / tab address of
 *   `https://app.example/help/Security` into `/help/****` for the whole session.
 *   The rule is gone; the caps redact BEFORE they cut.
 * - **F-3** the origin window was session-permanent: an unrelated new tab on the
 *   same origin could never `browser_eval` / `browser_screenshot` again. The
 *   window now has a deadline; the INJECTING tab stays refused until its own
 *   document navigates (R-4), so "cannot read the value back right away" holds.
 * - **F-4** one `OriginCredentialRecord` (holding the cleartext password) was
 *   kept per origin visited, forever. It is released as soon as the origin has
 *   no live tab any more.
 * - **F-5** `eval-policy.ts` sliced the value at 4 KB (and the serialized result
 *   at 8 KB) **before** the value-level redaction ran, so a password straddling
 *   the cut came back as a plaintext head fragment. The projection now runs
 *   before the caps.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRuntime, CREDENTIAL_WINDOW_EVAL_REFUSAL } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import type { BrowserToolOptions } from '../src/types.ts'

const PASSWORD = 'Security123!'
const LONG_SECRET = 'S3cr3t-Passw0rd!'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ mocks

class MockTransport {
  attached = false
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  private listeners: Array<(event: unknown, method: string, params: unknown) => void> = []
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return await this.handler(method, params)
  }
  on(event: string, listener: (event: unknown, method: string, params: unknown) => void): unknown {
    if (event === 'message') this.listeners.push(listener)
    return this
  }
  removeListener(event: string, listener: (event: unknown, method: string, params: unknown) => void): unknown {
    if (event === 'message') this.listeners = this.listeners.filter((entry) => entry !== listener)
    return this
  }
  emitNotification(method: string, params: unknown): void {
    for (const listener of [...this.listeners]) listener(undefined, method, params)
  }
}

class MockSession {
  partition = 'persist:r7b-verify'
  clearStorageData = async (): Promise<void> => {}
  clearCache = async (): Promise<void> => {}
  setPermissionRequestHandler = (): void => {}
  setPermissionCheckHandler = (): void => {}
  on(): void {}
  removeListener(): void {}
}

class MockView {
  transport = new MockTransport()
  session = new MockSession()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  url = ''
  title = ''
  destroyed = false
  captureCalls = 0
  loadURL = async (target: string): Promise<void> => { this.url = target; this.emit('did-stop-loading') }
  downloadURL = (): void => {}
  goBack = (): void => { this.emit('did-finish-load') }
  goForward = (): void => { this.emit('did-finish-load') }
  reload = (): void => { this.emit('did-finish-load') }
  capturePage = async (): Promise<unknown> => {
    this.captureCalls++
    return { getSize: () => ({ width: 8, height: 8 }), resize: () => ({}), toJPEG: () => Buffer.from('JPEG') }
  }
  setWindowOpenHandler = (): void => {}
  attach(): void {}
  setBounds(): void {}
  setVisible(): void {}
  detach(): void {}
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
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener))
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter {
  views: MockView[] = []
  masks: MockView[] = []
  partitionSession = new MockSession()
  showSaveDialog = async (): Promise<{ canceled: boolean }> => ({ canceled: true })
  openPath = async (): Promise<Record<string, unknown>> => ({})
  createView(): never { const view = new MockView(); this.views.push(view); return view as never }
  createMaskView(): never { const view = new MockView(); this.masks.push(view); return view as never }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {}, show: () => {}, hide: () => {}, focus: () => {}, isVisible: () => false,
      isDestroyed: () => false, close: () => {}, setTitle: () => {}, getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {}, onClosed: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(): never { return this.partitionSession as never }
  lastView(): MockView { return this.views.at(-1)! }
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  dir: string
  origins: Map<string, { secrets: string[] }>
  call: (name: string, args?: Record<string, unknown>) => Promise<never>
}

const exec = { signal: new AbortController().signal, agent: undefined }

function makeHarness(
  credentials: (id: string) => Promise<{ username?: string; password?: string } | null>,
  options: BrowserToolOptions = {},
): Harness {
  const adapter = new MockAdapter()
  const dir = mkdtempSync(join(tmpdir(), 'r7b-browser-'))
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(
    adapter as never,
    { downloadDir: join(dir, 'downloads'), ...options },
    credentials as never,
    undefined,
    { store },
  )
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  applyBrowserTools({
    tools: { register: (definition: { name: string }) => { tools.set(definition.name, definition as never); return () => {} } },
    systemPrompt: { section: () => () => {} },
    attachments: { saveImages: async () => [] },
  } as never, runtime)
  return {
    runtime,
    adapter,
    dir,
    origins: (runtime as unknown as { credentialOrigins: Map<string, { secrets: string[] }> }).credentialOrigins,
    call: async (name, args = {}) => await tools.get(name)!.execute(args, exec) as never,
  }
}

const live: Harness[] = []
function track(h: Harness): Harness {
  live.push(h)
  return h
}
afterEach(() => {
  for (const h of live.splice(0)) {
    h.runtime.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

/** `fillCredentials` CDP stub: the page has a login form with both fields. */
function stubLoginForm(view: MockView, extra?: (method: string, params?: Record<string, unknown>) => unknown): void {
  view.transport.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.['expression'] ?? '')
    if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
    return extra === undefined ? { result: { value: '' } } : extra(method, params)
  }
}

// ------------------------------------------------------------------- F-2

describe('F-2: no tail-prefix matching on text that was never truncated', () => {
  it('keeps ordinary prose whose last word equals the password head (get_text + snapshot)', async () => {
    const pageText = 'Privacy and Security'
    const h = track(makeHarness(async () => ({ username: 'alice', password: PASSWORD })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')

    h.adapter.lastView().transport.handler = (method) =>
      method === 'Runtime.evaluate' ? { result: { value: pageText } } : {}
    const text = await h.call('browser_get_text', { tab: 1 }) as { text: string }
    // Round-1 regression: 'Privacy and ****'.
    expect(text.text).toBe(pageText)

    h.adapter.lastView().transport.handler = (method) => method === 'Runtime.evaluate'
      ? { result: { value: [{ kind: 'link', text: pageText, selector: '#security', visible: true, disabled: false }] } }
      : {}
    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { elements: Array<{ text: string }> }
    expect(snapshot.elements[0]!.text).toBe(pageText)
  })

  it('keeps the persisted history URL, op-log summary and tab address intact', async () => {
    const url = 'https://app.example/help/Security'
    const h = track(makeHarness(async () => ({ username: 'alice', password: PASSWORD })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')

    await h.runtime.navigate(1, url, 'domcontentloaded')

    // Round-1 regression: every one of these read 'https://app.example/help/****'.
    const history = h.runtime.history({ limit: 5 }) as unknown as Array<{ url: string }>
    expect(history.map((entry) => entry.url)).toContain(url)
    // 2026-09-21（壳层缺陷 #5c）：navigate 的 op summary 走 hostCopy（中英按调用求值）。
    // 这里钉**精确等值**（而不是 `summary.includes(url)`）：默认 locale 是 zh，前缀固定；
    // 等值断言比子串强（能抓到前缀漂移/多拼接），而且子串形态会触发 CodeQL
    // js/incomplete-url-substring-sanitization 高危告警（PR #118 上的 #105 —— 测试里的
    // "URL 子串判定"与真实消毒逻辑同形，本仓惯例是改断言形态而不是 dismiss）。
    const navSummary = h.runtime.opLog.find((op) => op.tool === 'browser_navigate')?.summary ?? ''
    expect(navSummary).toBe(`打开网页：${url}`)
    expect(h.runtime.listTabs().map((tab) => tab.url)).toContain(url)
  })

  it('still masks a credential that straddles the model-facing snapshot cap (redact before cut)', async () => {
    const head = 'Audit note: '.padEnd(70, '.')
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    await h.runtime.open('https://login.example/form')
    stubLoginForm(h.adapter.lastView(), (method, params) => {
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('kindOf')) {
        return { result: { value: [{ kind: 'input', text: head + LONG_SECRET, selector: '#plain', visible: true, disabled: false }] } }
      }
      return { result: { value: '' } }
    })
    await h.runtime.fillCredentials(1, 'connector-x')

    const snapshot = await h.call('browser_get_snapshot', {}) as { elements: Array<{ text: string }> }
    expect(snapshot.elements[0]!.text).not.toContain(LONG_SECRET.slice(0, 10))
    expect(snapshot.elements[0]!.text).toContain('****')
    expect(snapshot.elements[0]!.text.length).toBeLessThanOrEqual(80)
  })

  it('caps the op-log navigate summary AFTER the value redaction, not before', async () => {
    // The op log keeps the navigate summary (label + `<url>`) and caps it at 210
    // characters. When the cap ran at the call site (round 1) the credential was
    // cut first, so a password straddling character 200 survived as a plaintext
    // head fragment — the R7 tail heuristic missed it because the fragment was 5
    // characters. (2026-09-21: the label is localized via hostCopy; the cap is
    // unchanged, so the URL room only grows in zh.)
    const token = 'T0ken-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789'
    const url = `https://app.example/${'a'.repeat(175)}${token}tail`
    const h = track(makeHarness(async () => ({ username: 'alice', password: token })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')

    await h.runtime.navigate(1, url, 'domcontentloaded')

    const summary = h.runtime.opLog.find((op) => op.tool === 'browser_navigate')!.summary
    expect(summary.length).toBeLessThanOrEqual(210)
    // Round-1 regression: 5 cleartext characters of the password, no `****`.
    expect(summary).not.toContain(token.slice(0, 5))
    expect(summary).toContain('****')
  })
})

// ------------------------------------------------------------------- F-3

describe('F-3: the origin credential window is bounded, the injecting document is not', () => {
  it('still refuses eval and screenshot on a fresh sibling tab (r7c-3 no-regression)', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')

    const sibling = await h.runtime.open('https://app.example/docs')
    expect(h.runtime.credentialWindowOpen(sibling.id)).toBe(true)
    const refused = await h.runtime.eval(sibling.id, 'document.title').catch((cause: unknown) => cause as { code?: string })
    expect((refused as { code?: string }).code).toBe('policy')
    expect((refused as { message?: string }).message).toBe(CREDENTIAL_WINDOW_EVAL_REFUSAL)
    await expect(h.runtime.screenshot(sibling.id)).rejects.toMatchObject({ code: 'policy' })
    expect(h.adapter.views[1]!.captureCalls).toBe(0)
  })

  it('allows eval and screenshot on an unrelated same-origin tab once the window TTL expires', async () => {
    const h = track(makeHarness(
      async () => ({ username: 'alice', password: LONG_SECRET }),
      { credentialWindowTtlMs: 60 },
    ))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')

    const sibling = await h.runtime.open('https://app.example/pricing')
    expect(h.runtime.credentialWindowOpen(sibling.id)).toBe(true)
    await sleep(140)
    // Round-1 regression: the window was session-permanent, so this stayed true.
    expect(h.runtime.credentialWindowOpen(sibling.id)).toBe(false)

    h.adapter.views[1]!.transport.handler = () => ({ result: { value: '4' } })
    await expect(h.runtime.eval(sibling.id, '2 + 2')).resolves.toBeTypeOf('string')
    await expect(h.runtime.screenshot(sibling.id)).resolves.toBeTypeOf('string')
    expect(h.adapter.views[1]!.captureCalls).toBe(1)

    // The value set is NOT part of the window contract: the exit keeps scrubbing.
    h.adapter.views[1]!.transport.handler = (method) =>
      method === 'Runtime.evaluate' ? { result: { value: `stored: ${LONG_SECRET}` } } : {}
    const text = await h.call('browser_get_text', { tab: sibling.id }) as { text: string }
    expect(text.text).toBe('stored: ****')
  })

  it('keeps the injecting tab refused after the TTL (its own document still holds the value)', async () => {
    const h = track(makeHarness(
      async () => ({ username: 'alice', password: LONG_SECRET }),
      { credentialWindowTtlMs: 60 },
    ))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')

    await sleep(140)
    expect(h.runtime.credentialWindowOpen(1)).toBe(true)
    const refused = await h.runtime.eval(1, 'document.querySelector("#pw").value').catch((cause: unknown) => cause as { code?: string })
    expect((refused as { code?: string }).code).toBe('policy')
  })
})

// ------------------------------------------------------------------- F-4

describe('F-4: retained origin credential accounting is bounded', () => {
  it('bounds the retained origin records with an LRU cap (no session-long growth)', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    for (let i = 0; i < 80; i += 1) {
      await h.runtime.open(`https://origin-${i}.example/login`)
      const tabId = h.runtime.currentTabId()!
      stubLoginForm(h.adapter.lastView())
      await h.runtime.fillCredentials(tabId, 'corp')
      await h.runtime.closeTab(tabId)
    }
    // Round-1 regression: one record per origin visited, forever (80 here).
    expect(h.origins.size).toBeLessThanOrEqual(32)
    expect(h.runtime.listTabs()).toHaveLength(0)
  })

  it('never evicts an origin a live tab is still showing', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    await h.runtime.open('https://keep.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')
    for (let i = 0; i < 60; i += 1) {
      await h.runtime.open(`https://noise-${i}.example/login`)
      const tabId = h.runtime.currentTabId()!
      stubLoginForm(h.adapter.lastView())
      await h.runtime.fillCredentials(tabId, 'corp')
      await h.runtime.closeTab(tabId)
    }
    expect(h.origins.size).toBeLessThanOrEqual(32)
    // The live origin survived the eviction pass and still hands its value set
    // to a tab arriving later (r7c-3 must not be weakened by the cap).
    expect(h.origins.has('https://keep.example')).toBe(true)
    const later = await h.runtime.open('https://keep.example/docs')
    expect(h.runtime.tab(later.id).filledSecrets).toEqual([LONG_SECRET])
  })

  it('keeps the round-1 fail-closed retention for an origin whose tabs are gone', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')
    await h.runtime.closeTab(1)
    expect(h.runtime.listTabs()).toHaveLength(0)

    // Round-1 property, deliberately NOT reverted: the value set outlives the
    // tab (localStorage/cookies are origin-scoped, a later tab can read it).
    await h.runtime.open('https://app.example/free')
    expect(h.runtime.tab(2).filledSecrets).toEqual([LONG_SECRET])
    stubLoginForm(h.adapter.views[1]!, (method) =>
      method === 'Runtime.evaluate' ? { result: { value: `stored: ${LONG_SECRET}` } } : {})
    const text = await h.call('browser_get_text', { tab: 2 }) as { text: string }
    expect(text.text).toBe('stored: ****')
    // Another origin inherits nothing (the accounting is per origin).
    await h.runtime.open('https://elsewhere.example/free')
    expect(h.runtime.tab(3).filledSecrets).toEqual([])
  })
})

// ------------------------------------------------------------------- F-5

describe('F-5: browser_eval caps must run after the value-level redaction', () => {
  it('masks a password straddling the 4096-char per-value cap', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')
    // Close the credential window the way the product does (main-frame
    // navigation); the value set stays with the tab.
    h.adapter.lastView().emit('did-navigate')
    expect(h.runtime.credentialWindowOpen(1)).toBe(false)

    // Align the 4096 cut so the first 15 of the 16 password characters survive
    // inside the kept prefix and only the last one is cut away.
    const value = `${'x'.repeat(4096 - 15)}${LONG_SECRET}TAIL`
    h.adapter.lastView().transport.handler = (method) =>
      method === 'Runtime.evaluate' ? { result: { value } } : {}
    const out = await h.call('browser_eval', { tab: 1, expression: 'document.body.innerText' }) as unknown as { result: string }

    // Round-1 regression: 15 of 16 password characters came back in clear.
    expect(out.result).not.toContain(LONG_SECRET.slice(0, 15))
    expect(out.result).toContain('****')
  })

  it('masks a password sitting across the serialized eval-result size cap', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    stubLoginForm(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'corp')
    h.adapter.lastView().emit('did-navigate')

    // A page-chosen object KEY long enough that the 8 KiB serialized cut lands
    // in the middle of the password (the key is not covered by any length cap).
    const key = `${'k'.repeat(8_180)}${LONG_SECRET}tail`
    const value: Record<string, number> = { [key]: 1 }
    h.adapter.lastView().transport.handler = (method) =>
      method === 'Runtime.evaluate' ? { result: { value } } : {}
    const out = await h.call('browser_eval', { tab: 1, expression: 'document.body.innerText' }) as unknown as { result: string }

    expect(out.result).not.toContain(LONG_SECRET.slice(0, 10))
  })
})
