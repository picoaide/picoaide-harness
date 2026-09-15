/**
 * 行为回归测试：把 `shell-pages.ts` 的两个页面真的跑起来（jsdom 执行内联脚本 +
 * stub fetch/EventSource），断言"用户看得见的结果"。
 *
 * 为什么必须有这一层（2026-09-15 客户现场 P0）：客户 v2.7.4-beta.3 点「我来操作」
 * 整轮没反应，主机日志里只有 `refused a local write without browser proof (401)`，
 * 而页面把 403/503/网络错误**全部吞掉**——打包版用户看不到 console，现场零证据。
 * 同目录的 `shell-pages.spec.ts` 只有 5 条"源码字符串包含"断言：字符串都在，行为
 * 却是坏的，那种断言抓不到静默失败。所以这里一律按行为断言（含反向对照价值：
 * 把修复改回旧行为，本文件的用例会变红）。
 *
 * jsdom 说明：本包已把 jsdom 声明成自己的 devDependency（2026-09-15 补测时加），
 * 正常路径就是从本包解析。解析仍按候选目录写并 **fail-loud**：换包管理器或提升
 * 策略时宁可红，也绝不静默跳过——"跳过 = 假绿"正是本轮要消灭的东西。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_OVERLAY_HTML, BROWSER_SHELL_HTML } from '../src/shell-pages.ts'

/* ------------------------------------------------------------------ *
 * jsdom：按候选目录解析（本包【已声明】→ cron → webadmin），失败即 fail-loud
 * ------------------------------------------------------------------ */

type JSDOMCtor = new (html: string, options: Record<string, unknown>) => { window: any }

const HERE = dirname(fileURLToPath(import.meta.url))
const JSDOM_CANDIDATES = [
  join(HERE, '..'), // packages/host/browser（本包 devDependency，正常路径）
  join(HERE, '..', '..', 'cron'), // packages/host/cron
  join(HERE, '..', '..', '..', '..', 'server', 'webadmin'),
]

function loadJsdom(): JSDOMCtor {
  for (const base of JSDOM_CANDIDATES) {
    if (!existsSync(base)) continue
    try {
      const requireFrom = createRequire(join(base, '__shell_pages_behavior__.cjs'))
      const mod = requireFrom('jsdom') as { JSDOM?: JSDOMCtor }
      if (typeof mod.JSDOM === 'function') return mod.JSDOM
    } catch { /* 换下一个候选目录 */ }
  }
  throw new Error(`shell-pages 行为测试需要 jsdom；已尝试：${JSDOM_CANDIDATES.join(', ')}`)
}

const JSDOM = loadJsdom()

/* ------------------------------------------------------------------ *
 * 页面加载器：stub fetch / EventSource / 计时面，暴露可断言的句柄
 * ------------------------------------------------------------------ */

/** 服务端应答；`raw` 用来模拟"非 JSON"（代理异常返回一整页 HTML）。 */
interface Reply {
  status?: number
  json?: unknown
  raw?: string
}

interface Call {
  path: string
  method: string
  body: any
  index: number
}

type Handler = (call: Call) => Reply | Promise<Reply> | undefined

interface FakeStream {
  url: string
  /** 真的推一条事件（页面据此刷新 lastSseAt）。 */
  emit: (type: string) => void
  /** EventSource 连接建立（旧实现就是靠这个把 sseOk 置 true 的）。 */
  open: () => void
  fail: () => void
}

interface PageHandle {
  win: any
  doc: any
  calls: Call[]
  /** 最近创建的 EventSource。 */
  stream: () => FakeStream
  /** 按 id / 选择器取元素。 */
  $: (selector: string) => any
  /** 像真实点击一样派发（disabled 的按钮 `.click()` 在 jsdom 里不派发，见防连点用例）。 */
  fire: (el: any, type: string) => void
  /** 排空页面里的 microtask（fetch stub 都是已决 promise）。 */
  settle: () => Promise<void>
  /** 推进假计时器并排空 microtask。 */
  tick: (ms: number) => Promise<void>
}

/** 每个用例打开的页面，afterEach 统一 close，避免定时器/事件串台。 */
const livePages: { window: any }[] = []

function makeResponse(reply: Reply): any {
  const status = reply.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      // raw = 非 JSON 响应体：真实环境里 r.json() 在这里抛 SyntaxError
      // （2026-09-15 审计 P1：代理异常回 HTML 时 renderViewer 就是这样炸的）。
      if (reply.raw !== undefined) return JSON.parse(reply.raw)
      return reply.json
    },
    text: async () => reply.raw ?? JSON.stringify(reply.json ?? null),
  }
}

function openPage(html: string, handler: Handler = () => undefined): PageHandle {
  const calls: Call[] = []
  const streams: FakeStream[] = []

  class FakeEventSource {
    url: string
    listeners = new Map<string, ((ev: unknown) => void)[]>()
    onopen: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    constructor(url: string) {
      this.url = url
      streams.push(this as unknown as FakeStream)
    }
    addEventListener(type: string, fn: (ev: unknown) => void): void {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    removeEventListener(): void {}
    close(): void {}
    emit(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn({ type }) }
    open(): void { this.onopen?.({ type: 'open' }) }
    fail(): void { this.onerror?.({ type: 'error' }) }
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window: any) {
      // 页面脚本跑在 jsdom 自己的 vm realm 里：它自带的 setTimeout/Date 不受 vitest
      // 假计时器控制。把计时面接到测试 realm 的全局函数上，才能用
      // vi.advanceTimersByTime / vi.setSystemTime 精确驱动页面（含 SSE 静默判定）。
      window.setTimeout = globalThis.setTimeout.bind(globalThis)
      window.clearTimeout = globalThis.clearTimeout.bind(globalThis)
      window.setInterval = globalThis.setInterval.bind(globalThis)
      window.clearInterval = globalThis.clearInterval.bind(globalThis)
      window.Date = globalThis.Date
      window.alert = () => {}
      window.confirm = () => true
      window.EventSource = FakeEventSource
      window.fetch = (input: unknown, init: any = {}) => {
        const path = String(input).replace(/^\/api\/pico\/browser\//u, '')
        const method = String(init?.method ?? 'GET').toUpperCase()
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        const call: Call = { path, method, body, index: calls.length }
        calls.push(call)
        // handler 抛错 = 模拟网络层失败（fetch reject），页面必须同样给反馈。
        const reply = Promise.resolve().then(() => handler(call))
        return reply.then((r) => makeResponse(r ?? (method === 'GET' ? { json: {} } : { json: { ok: true } })))
      }
    },
  })

  livePages.push(dom.window)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => process.nextTick(resolve))
  }

  return {
    win: dom.window,
    doc: dom.window.document,
    calls,
    stream: () => {
      const last = streams[streams.length - 1]
      if (last === undefined) throw new Error('页面没有创建 EventSource')
      return last
    },
    $: (selector: string) => dom.window.document.querySelector(selector.startsWith('#') || selector.includes(' ') ? selector : `#${selector}`),
    fire: (el: any, type: string) => { el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true })) },
    settle,
    tick: async (ms: number) => { vi.advanceTimersByTime(ms); await settle() },
  }
}

const openShell = (handler?: Handler): PageHandle => openPage(BROWSER_SHELL_HTML, handler)
const openOverlay = (handler?: Handler): PageHandle => openPage(BROWSER_OVERLAY_HTML, handler)

const shellState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tabs: [], controlled: false, busy: false, busyTool: '', ui: { mode: 'capsule' }, ...over,
})
const overlayState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  controlled: false, busy: false, busyTool: '', ui: { mode: 'capsule' }, ...over,
})

const toasts = (page: PageHandle, id: string): string => page.$(`#${id}`).textContent

/* ------------------------------------------------------------------ */

describe('两个页面的内联脚本本身必须可解析（模板字符串事故的第一道闸）', () => {
  // 两个页面本体是 `export const ... = \`...\`` 模板字符串：内联脚本里任何未转义的
  // 反引号（连注释里的也算）、`${`、转义斜杠都会先被外层模板吃掉，页面直到运行时
  // 才炸（工具栏/蒙版整个渲染不出来，而"源码字符串包含"式断言全绿）。
  // 2026-09-15 开发本文件时踩过两次，故钉成断言。
  it.each([
    ['shell', BROWSER_SHELL_HTML],
    ['overlay', BROWSER_OVERLAY_HTML],
  ])('%s 页恰好一个 <script> 且能通过 JS 解析', (_name, html) => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    expect(scripts).toHaveLength(1)
    const body = scripts[0]?.[1] ?? ''
    expect(body.length).toBeGreaterThan(1000)
    expect(() => new Function(body)).not.toThrow()
  })
})

describe('浏览器本地页面：失败必须可见、状态必须真实（2026-09-15 审计回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-09-15T10:00:00Z'))
  })

  afterEach(() => {
    for (const page of livePages.splice(0)) page.window.close()
    vi.useRealTimers()
  })

  /* ---------------------------------------------------------------- *
   * 缺陷 1：写操作失败无任何反馈（现场 P0 同族）
   * ---------------------------------------------------------------- */

  describe('写操作失败在页面上可见（overlay 蒙版页）', () => {
    it('接管被 403 拒绝：出可读 toast，且绝不假装已经接管', async () => {
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'mask' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'takeover') return { status: 403, json: { error: 'browser session proof required', hint: 'reopen the application window from its launch URL' } }
        return undefined
      })
      await page.settle()

      page.fire(page.$('pill-take'), 'click')
      await page.settle()

      // 现场症状：没有这句话，用户只看到"点了没反应"（打包版没有 console）。
      expect(toasts(page, 'otoast')).toBe('操作失败：浏览器会话凭据尚未就绪，请重试')
      expect(page.$('otoast').classList.contains('show')).toBe(true)
      // 状态没变：胶囊仍是「我来操作」，而不是被本地乐观更新成「交给 AI」。
      expect(page.$('ai-take').textContent).toBe('我来操作')
      expect(page.doc.body.dataset.mode).toBe('mask')
    })

    it('接管被 503 拒绝（写证明服务缺席）：文案指到"服务未就绪"，不是笼统失败', async () => {
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'mask' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'takeover') return { status: 503, json: { error: 'browser session proof unavailable' } }
        return undefined
      })
      await page.settle()

      page.fire(page.$('pill-take'), 'click')
      await page.settle()

      expect(toasts(page, 'otoast')).toBe('操作失败：浏览器服务尚未就绪，请重试')
    })

    it('网络层失败（fetch reject）：同样有可读文案，不是静默', async () => {
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'mask' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'takeover') throw new Error('ECONNREFUSED')
        return undefined
      })
      await page.settle()

      page.fire(page.$('pill-take'), 'click')
      await page.settle()

      expect(toasts(page, 'otoast')).toBe('操作失败：无法连接到浏览器服务，请重试')
    })

    it('接管点击期间进 pending/disabled：防连点，且给"正在接管…"的反馈', async () => {
      let releaseTakeover: ((reply: Reply) => void) | undefined
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'mask' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'takeover') return new Promise<Reply>((resolve) => { releaseTakeover = resolve })
        return undefined
      })
      await page.settle()

      const take = page.$('pill-take')
      page.fire(take, 'click')
      await page.settle()

      expect(take.disabled).toBe(true)
      expect(take.textContent).toBe('正在接管…')

      // 连点：不能再发一条 takeover（jsdom 里 disabled 的 .click() 不派发事件，
      // 所以这里显式派发，真正压到页面的守卫上）。
      page.fire(take, 'click')
      await page.settle()
      expect(page.calls.filter((c) => c.path === 'takeover')).toHaveLength(1)

      releaseTakeover?.({ status: 403, json: { error: 'browser session proof required' } })
      await page.settle()
      expect(take.disabled).toBe(false)
      expect(take.textContent).toBe('我来操作')
      expect(toasts(page, 'otoast')).toContain('浏览器会话凭据尚未就绪')
    })

    it('接管成功：胶囊按服务端状态切成「交给 AI」（成功路径不被误伤）', async () => {
      let controlled = false
      const page = openOverlay((call) => {
        if (call.path === 'takeover') { controlled = call.body?.active === true; return { json: { ok: true } } }
        if (call.path === 'state') return { json: overlayState({ controlled, ui: { mode: controlled ? 'capsule' : 'mask' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        return undefined
      })
      await page.settle()
      expect(page.doc.body.dataset.mode).toBe('mask')

      page.fire(page.$('pill-take'), 'click')
      await page.settle()

      expect(page.doc.body.dataset.mode).toBe('capsule')
      expect(page.$('ai-take').textContent).toBe('交给 AI')
      expect(toasts(page, 'otoast')).toBe('')
    })

    it('「清除数据」被拒：出 toast，且不关菜单假装清完了', async () => {
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'menu' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'clear-data') return { status: 403, json: { error: 'browser session proof required' } }
        return undefined
      })
      await page.settle()

      const btn = [...page.doc.querySelectorAll('#menu .mi')].find((b: any) => b.textContent.includes('清除数据'))
      expect(btn).toBeDefined()
      page.fire(btn, 'click')
      await page.settle()

      expect(toasts(page, 'otoast')).toContain('浏览器会话凭据尚未就绪')
      // 旧行为：无论成败都再发一条 overlay 切回 capsule —— 用户以为已经清完。
      expect(page.calls.filter((c) => c.path === 'overlay')).toHaveLength(0)
    })

    it('查看器删除被拒：出 toast，且那一行不许消失（服务端状态才是真相）', async () => {
      let uiMode = 'menu'
      let writable = false
      let bookmarks = [{ id: 7, title: '文档', url: 'https://doc.example/', createdAt: '2026-09-15T09:00:00Z' }]
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: uiMode } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'overlay') { uiMode = 'viewer'; return { json: { ok: true } } }
        if (call.path.startsWith('bookmarks?') && call.method === 'GET') return { json: { bookmarks } }
        if (call.path.startsWith('bookmarks?id=') && call.method === 'DELETE') {
          if (!writable) return { status: 403, json: { error: 'browser session proof required' } }
          bookmarks = []
          return { json: { ok: true } }
        }
        return undefined
      })
      await page.settle()
      await openBookmarksViewer(page)
      expect(page.doc.querySelectorAll('#viewer-list .vrow')).toHaveLength(1)

      const rm = page.doc.querySelector('#viewer-list .vrow .rm.danger')
      page.fire(rm, 'click')
      await page.settle()

      expect(toasts(page, 'otoast')).toContain('浏览器会话凭据尚未就绪')
      expect(page.doc.querySelectorAll('#viewer-list .vrow')).toHaveLength(1)

      // 成功路径对照：服务端真的删掉了，行才消失。
      writable = true
      page.fire(rm, 'click')
      await page.settle()
      expect(page.doc.querySelectorAll('#viewer-list .vrow')).toHaveLength(0)
    })

    it('⋮ 菜单打开查看器被拒：出 toast，且不去拉一个并不存在的查看器', async () => {
      let uiMode = 'menu'
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: uiMode } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'overlay') return { status: 403, json: { error: 'browser session proof required' } }
        if (call.path.startsWith('bookmarks')) return { json: { bookmarks: [{ id: 1, title: 'A', url: 'https://a.example/' }] } }
        return undefined
      })
      await page.settle()

      await openBookmarksViewer(page)

      expect(toasts(page, 'otoast')).toContain('浏览器会话凭据尚未就绪')
      // 服务端没切模式 ⇒ 页面也不许自己演：本地 kind 必须回退，否则 1.5s 轮询会把
      // 书签列表拉到一个根本没打开的查看器上。
      expect(uiMode).toBe('menu')
      expect(page.calls.filter((c) => c.path.startsWith('bookmarks'))).toHaveLength(0)
      expect(page.$('viewer-list').textContent).toBe('')
    })

    it('下载查看器：打开按钮成功给反馈；删除被拒出 toast 且行不消失', async () => {
      let uiMode = 'menu'
      let writable = false
      const downloads = [{ id: 3, fileName: '报告.zip', path: '/tmp/报告.zip', url: 'https://a.example/r.zip', status: 'done' }]
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: uiMode } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'overlay') { uiMode = 'viewer'; return { json: { ok: true } } }
        if (call.path.startsWith('downloads?') && call.method === 'GET') return { json: { downloads } }
        if (call.path.startsWith('downloads?id=') && call.method === 'DELETE') {
          if (!writable) return { status: 403, json: { error: 'browser session proof required' } }
          downloads.splice(0, downloads.length)
          return { json: { ok: true } }
        }
        return undefined
      })
      await page.settle()
      await openViewerFromMenu(page, '下载')
      expect(page.doc.querySelectorAll('#viewer-list .vrow')).toHaveLength(1)

      page.fire([...page.doc.querySelectorAll('#viewer-list .vrow button')].find((b: any) => b.textContent === '打开'), 'click')
      await page.settle()
      expect(toasts(page, 'otoast')).toBe('已用系统默认程序打开')

      page.fire(page.doc.querySelector('#viewer-list .vrow .rm.danger'), 'click')
      await page.settle()
      expect(toasts(page, 'otoast')).toContain('浏览器会话凭据尚未就绪')
      expect(page.doc.querySelectorAll('#viewer-list .vrow')).toHaveLength(1)

      writable = true
      page.fire(page.doc.querySelector('#viewer-list .vrow .rm.danger'), 'click')
      await page.settle()
      expect(page.$('viewer-list').textContent).toContain('暂无记录')
    })

    it('服务端 400 带 error 字段：把服务端文案透出来（不只给状态码）', async () => {
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'mask' } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'takeover') return { status: 400, json: { error: 'mode must be one of capsule/panel/menu/viewer' } }
        return undefined
      })
      await page.settle()

      page.fire(page.$('pill-take'), 'click')
      await page.settle()

      expect(toasts(page, 'otoast')).toBe('操作失败：mode must be one of capsule/panel/menu/viewer')
    })
  })

  describe('写操作失败在页面上可见（shell 工具条页）', () => {
    it('新建标签页被 403 拒绝：出 toast（旧实现只在响应体恰好是 JSON 且带 error 时才说话）', async () => {
      const page = openShell((call) => {
        if (call.path === 'state') return { json: shellState() }
        if (call.path === 'open') return { status: 403, json: { error: 'browser session proof required' } }
        return undefined
      })
      await page.settle()

      page.fire(page.$('newtab'), 'click')
      await page.settle()

      expect(toasts(page, 'toast')).toBe('操作失败：浏览器会话凭据尚未就绪，请重试')
      expect(page.$('toast').classList.contains('show')).toBe(true)
    })

    it('读面返回非 JSON（代理 502 HTML）：兜底文案而不是静默', async () => {
      const page = openShell((call) => {
        if (call.path === 'state') return { json: shellState() }
        if (call.path === 'reload') return { status: 502, raw: '<!DOCTYPE html><html>502 Bad Gateway</html>' }
        return undefined
      })
      await page.settle()

      page.fire(page.$('reload'), 'click')
      await page.settle()

      expect(toasts(page, 'toast')).toBe('操作失败（HTTP 502），请重试')
    })

    it('收藏被拒：星星不亮 + 出 toast；收藏成功才给黄色反馈', async () => {
      let bookmarked = false
      const page = openShell((call) => {
        if (call.path === 'state') return { json: shellState({ tabs: [{ id: 1, visible: true, url: 'https://a.example/', title: 'A' }] }) }
        if (call.path === 'bookmarks') {
          if (!bookmarked) return { status: 403, json: { error: 'browser session proof required' } }
          return { json: { ok: true } }
        }
        return undefined
      })
      await page.settle()

      page.fire(page.$('bm'), 'click')
      await page.settle()
      expect(toasts(page, 'toast')).toContain('浏览器会话凭据尚未就绪')
      expect(page.$('bm').style.color).toBe('')

      bookmarked = true
      page.fire(page.$('bm'), 'click')
      await page.settle()
      expect(page.$('bm').style.color).toBe('var(--warning)')
    })
  })

  /* ---------------------------------------------------------------- *
   * 缺陷 2：renderViewer 无错误处理（未处理拒绝打断兜底轮询）
   * ---------------------------------------------------------------- */

  describe('查看器读面失败：就地显示「加载失败，请重试」，不抛未处理拒绝', () => {
    it.each([
      ['500 + JSON 错误体', { status: 500, json: { error: 'boom' } } as Reply],
      ['502 + 非 JSON（代理回 HTML）', { status: 502, raw: '<!DOCTYPE html><html>502 Bad Gateway</html>' } as Reply],
    ])('%s', async (_label, reply) => {
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
      process.on('unhandledRejection', onUnhandled)

      let uiMode = 'menu'
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: uiMode } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'overlay') { uiMode = 'viewer'; return { json: { ok: true } } }
        if (call.path.startsWith('bookmarks')) return reply
        return undefined
      })
      await page.settle()
      await openBookmarksViewer(page)
      // 再来一个 tick：兜底轮询里"直接调用 renderViewer"的那条路径在进入 viewer 模式
      // 后的下一个 tick 才走到（第一个 tick 只是把模式拉过来），未处理拒绝正是从那里冒出来的。
      await page.tick(1500)
      // 一次真实的宏任务：Node 到这时才可能派发 unhandledRejection。
      await new Promise<void>((resolve) => setImmediate(resolve))

      try {
        // 旧实现：r.json() 抛出的拒绝直接冒到 setInterval 的 tick 上（不 await 不 catch），
        // 表现为"查看器停在旧内容 / 删除按钮点了没反应"，而页面上一个字都没有。
        // 先断言拒绝：修复前这里就是红的（比可见文案更早暴露"兜底轮询被打断"这件事）。
        expect(rejections).toEqual([])
        expect(page.$('viewer-list').textContent).toContain('加载失败，请重试')
        // 兜底轮询还在继续（下一个 tick 会再试一次）。
        const triesBefore = page.calls.filter((c) => c.path.startsWith('bookmarks')).length
        await page.tick(1500)
        expect(page.calls.filter((c) => c.path.startsWith('bookmarks')).length).toBeGreaterThan(triesBefore)
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  })

  /* ---------------------------------------------------------------- *
   * 缺陷 5：每 1.5s 全量重建（滚动被重置、AI 时间线读不了）
   * ---------------------------------------------------------------- */

  describe('只在内容变化时重建（滚动位置与时间线可读）', () => {
    it('活动面板内容不变：一个节点都不重建', async () => {
      const ops = [{ time: '2026-09-15T10:00:00Z', tool: 'browser_click', summary: '点击「提交」', actor: 'ai' }]
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'panel' } }) }
        if (call.path === 'ops') return { json: { ops } }
        return undefined
      })
      await page.settle()

      const stream = page.$('stream')
      const first = stream.firstElementChild
      expect(first).not.toBeNull()
      first.__probe = 'same-node'

      await page.tick(1500)
      await page.tick(1500)

      // 旧实现每个 tick 都 textContent = '' 重建 ⇒ 这里是新节点、__probe 丢失。
      expect(stream.firstElementChild).toBe(first)
      expect(stream.firstElementChild.__probe).toBe('same-node')
    })

    it('活动面板：用户翻上去看历史时不被拉回底部，贴底时才自动跟随', async () => {
      let ops: unknown[] = [{ time: '2026-09-15T10:00:00Z', tool: 'browser_click', summary: '第一条', actor: 'ai' }]
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: 'panel' } }) }
        if (call.path === 'ops') return { json: { ops } }
        return undefined
      })
      await page.settle()

      const stream = page.$('stream')
      // jsdom 不做布局：手工给出可滚动高度，才能断言"跟随 / 不跟随"的选择。
      Object.defineProperty(stream, 'scrollHeight', { value: 500, configurable: true })
      Object.defineProperty(stream, 'clientHeight', { value: 100, configurable: true })

      stream.scrollTop = 0 // 用户翻到了顶部
      ops = [...ops, { time: '2026-09-15T10:00:01Z', tool: 'browser_navigate', summary: '第二条', actor: 'ai' }]
      await page.tick(1500)
      expect(stream.scrollTop).toBe(0)

      stream.scrollTop = 450 // 贴底（450 + 100 >= 500 - 4）
      ops = [...ops, { time: '2026-09-15T10:00:02Z', tool: 'browser_scroll', summary: '第三条', actor: 'ai' }]
      await page.tick(1500)
      expect(stream.scrollTop).toBe(500)
    })

    it('查看器内容不变：不重建（下载进度那种每秒刷新的面板不闪、不丢滚动）', async () => {
      let uiMode = 'menu'
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState({ ui: { mode: uiMode } }) }
        if (call.path === 'ops') return { json: { ops: [] } }
        if (call.path === 'overlay') { uiMode = 'viewer'; return { json: { ok: true } } }
        if (call.path.startsWith('bookmarks')) return { json: { bookmarks: [{ id: 1, title: 'A', url: 'https://a.example/', createdAt: '2026-09-15T09:00:00Z' }] } }
        return undefined
      })
      await page.settle()
      await openBookmarksViewer(page)

      const row = page.doc.querySelector('#viewer-list .vrow')
      expect(row).not.toBeNull()
      await page.tick(1500)
      await page.tick(1500)
      expect(page.doc.querySelector('#viewer-list .vrow')).toBe(row)
    })
  })

  /* ---------------------------------------------------------------- *
   * 缺陷 3：favicon 未校验协议
   * ---------------------------------------------------------------- */

  describe('favicon 协议白名单', () => {
    it('只允许 http(s) 与 data:image/，javascript:/file:/空串一律不写进 img.src', async () => {
      const page = openShell((call) => {
        if (call.path === 'state') {
          return {
            json: shellState({
              tabs: [
                { id: 1, visible: true, url: 'https://a.example/', title: 'JS', favicon: 'javascript:alert(document.cookie)' },
                { id: 2, visible: false, url: 'https://b.example/', title: 'HTTP', favicon: 'https://b.example/favicon.ico' },
                { id: 3, visible: false, url: 'https://c.example/', title: 'DATA', favicon: 'data:image/png;base64,AAAA' },
                { id: 4, visible: false, url: 'https://d.example/', title: 'FILE', favicon: 'file:///etc/passwd' },
                { id: 5, visible: false, url: 'https://e.example/', title: 'EMPTY', favicon: '' },
              ],
            }),
          }
        }
        return undefined
      })
      await page.settle()

      const icons = [...page.doc.querySelectorAll('#tabs .favicon')]
      expect(icons).toHaveLength(5)
      // javascript: —— 旧实现会原样写进 src（点了 tab 就执行在页面上下文里）。
      expect(icons[0].hasAttribute('src')).toBe(false)
      expect(icons[0].style.display).toBe('none')
      expect(icons[1].getAttribute('src')).toBe('https://b.example/favicon.ico')
      expect(icons[2].getAttribute('src')).toBe('data:image/png;base64,AAAA')
      expect(icons[3].hasAttribute('src')).toBe(false)
      expect(icons[4].hasAttribute('src')).toBe(false)
    })
  })

  /* ---------------------------------------------------------------- *
   * 缺陷 4：sseOk 单向标志 ⇒ 兜底轮询冻结
   * ---------------------------------------------------------------- */

  describe('SSE 静默超时后兜底轮询必须启动', () => {
    it('shell：连接已 open 但不再推事件时仍然轮询（旧实现 sseOk=true ⇒ 永不轮询）', async () => {
      const page = openShell((call) => (call.path === 'state' ? { json: shellState() } : undefined))
      await page.settle()
      const stateCalls = (): number => page.calls.filter((c) => c.path === 'state').length

      page.stream().open() // 旧实现在这里把 sseOk 置 true
      const afterOpen = stateCalls()
      await page.tick(1500)
      expect(stateCalls()).toBe(afterOpen + 1) // 没有事件 ⇒ 继续轮询

      page.stream().emit('state') // 真的推了一条
      await page.settle()
      const afterEvent = stateCalls()
      await page.tick(1500)
      expect(stateCalls()).toBe(afterEvent) // 阈值内不轮询（SSE 健康时不打服务端）

      await page.tick(5000) // 超过 SSE_STALE_MS(4000)
      expect(stateCalls()).toBeGreaterThan(afterEvent)
    })

    it('overlay：同样按"最后事件时间"判定（否则胶囊/面板状态会冻结）', async () => {
      const page = openOverlay((call) => {
        if (call.path === 'state') return { json: overlayState() }
        if (call.path === 'ops') return { json: { ops: [] } }
        return undefined
      })
      await page.settle()
      const opsCalls = (): number => page.calls.filter((c) => c.path === 'ops').length

      page.stream().open()
      const afterOpen = opsCalls()
      await page.tick(1500)
      expect(opsCalls()).toBe(afterOpen + 1)
    })
  })

  /* ---------------------------------------------------------------- *
   * 附加：读面失败不要把界面清空
   * ---------------------------------------------------------------- */

  it('shell：/state 5xx 时保留上一次的 tab 条（不要把界面清成"没有标签页"）', async () => {
    let healthy = true
    const page = openShell((call) => {
      if (call.path === 'state') {
        if (!healthy) return { status: 500, json: { error: 'boom' } }
        return { json: shellState({ tabs: [{ id: 1, visible: true, url: 'https://a.example/', title: 'A' }] }) }
      }
      return undefined
    })
    await page.settle()
    expect(page.doc.querySelectorAll('#tabs .tab')).toHaveLength(1)

    healthy = false
    await page.tick(5000)
    expect(page.doc.querySelectorAll('#tabs .tab')).toHaveLength(1)
  })
})

/** 从 ⋮ 菜单进查看器（页面真实路径：菜单项 → POST overlay → 服务端改模式 → 下一个 tick 拉到）。 */
async function openViewerFromMenu(page: PageHandle, label: string): Promise<void> {
  const btn = [...page.doc.querySelectorAll('#menu .mi')].find((b: any) => b.textContent === label)
  if (btn === undefined) throw new Error(`菜单里没有「${label}」项`)
  page.fire(btn, 'click')
  await page.settle()
  await page.tick(1500)
}

const openBookmarksViewer = (page: PageHandle): Promise<void> => openViewerFromMenu(page, '书签')
