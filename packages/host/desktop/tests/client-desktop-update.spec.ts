import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  desktopUpdateBadgeView,
  fetchDesktopUpdateState,
  readDesktopUpdate,
  refreshDesktopUpdate,
  resetDesktopUpdateStoreForTests,
  subscribeDesktopUpdate,
  triggerDesktopUpdateAction,
  triggerDesktopUpdateCheck,
  updateActionFor,
} from '../src/client/desktop-update.tsx'
import { setActiveLocale } from '../src/client/locales.ts'
import { WAIT_BUDGETS } from './wait-budgets.ts'

// The badge copy is locale-aware; every case below states the locale it asserts
// in, and the reset keeps a failing English case from leaking into the next one.
afterEach(() => setActiveLocale('zh'))

describe('desktop update badge client', () => {
  it('parses a valid snapshot and rejects malformed bodies', async () => {
    const request = vi.fn(async () => Response.json({
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
      downloadingVersion: undefined,
    }))
    const state = await fetchDesktopUpdateState(request)
    expect(state).toMatchObject({
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
    })

    const invalid = vi.fn(async () => Response.json({ nope: true }))
    await expect(fetchDesktopUpdateState(invalid)).resolves.toBeNull()

    const failing = vi.fn(async () => { throw new Error('offline') })
    await expect(fetchDesktopUpdateState(failing)).resolves.toBeNull()
  })

  it('returns null on non-200 responses', async () => {
    const request = vi.fn(async () => new Response('', { status: 500 }))
    await expect(fetchDesktopUpdateState(request)).resolves.toBeNull()
  })

  it('triggers the Host check with the fixed POST endpoint', async () => {
    const request = vi.fn(async () => new Response('', { status: 202 }))
    await expect(triggerDesktopUpdateCheck(request)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(
      '/api/pico/desktop/update/check',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('reports a failed trigger without throwing', async () => {
    const request = vi.fn(async () => new Response('', { status: 500 }))
    await expect(triggerDesktopUpdateCheck(request)).resolves.toBe(false)
  })
})

describe('desktop update shared client store', () => {
  const healthy = {
    isPackaged: true,
    canDownload: true,
    currentVersion: '2.2.0',
    availableVersion: undefined,
    downloadingVersion: undefined,
    downloadProgress: undefined,
    readyVersion: undefined,
    readyPath: undefined,
    retryAttempt: 0,
    retryMaxAttempts: 5,
    retryDelayMs: 0,
    lastError: undefined,
  }

  afterEach(() => {
    resetDesktopUpdateStoreForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('polls once for every subscriber and stops when the last one leaves', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => Response.json({ ...healthy, availableVersion: '2.3.0' }))
    // 轮询走模块内的默认 request(= 窗口 fetch):把它换成替身才能数请求次数。
    vi.stubGlobal('fetch', request)
    const first = vi.fn()
    const second = vi.fn()

    const unsubscribeFirst = subscribeDesktopUpdate(first)
    const unsubscribeSecond = subscribeDesktopUpdate(second)
    // 现象：首个订阅者触发一次轮询（假计时器 + fetch 替身）。
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })

    // 一个窗口一条轮询:第二个订阅者不再开一个定时器。
    await vi.advanceTimersByTimeAsync(5_000)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(request).toHaveBeenCalledTimes(3)

    // 两个订阅者读到同一份快照。
    expect(readDesktopUpdate()).toMatchObject({ availableVersion: '2.3.0' })

    unsubscribeFirst()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(request).toHaveBeenCalledTimes(4)
    unsubscribeSecond()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('notifies subscribers only when the snapshot actually changes', async () => {
    const request = vi.fn(async () => Response.json({ ...healthy, availableVersion: '2.3.0' }))
    vi.stubGlobal('fetch', request)
    const listener = vi.fn()
    const unsubscribe = subscribeDesktopUpdate(listener)
    // 现象：首个快照落地并通知订阅者。
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledTimes(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })

    // 快照没变就不再通知(5 秒一次的轮询不该让三个面反复重渲染)。
    await refreshDesktopUpdate(request)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('keeps the previous snapshot when the route is unavailable', async () => {
    const ok = vi.fn(async () => Response.json({ ...healthy, availableVersion: '2.3.0' }))
    vi.stubGlobal('fetch', ok)
    const unsubscribe = subscribeDesktopUpdate(() => {})
    await refreshDesktopUpdate(ok)
    expect(readDesktopUpdate()).toMatchObject({ availableVersion: '2.3.0' })

    // 兼容模式/路由缺失:不得把好数据清成空。
    await refreshDesktopUpdate(vi.fn(async () => new Response('', { status: 404 })))
    expect(readDesktopUpdate()).toMatchObject({ availableVersion: '2.3.0' })
    unsubscribe()
  })

  it('refreshes immediately when the window comes back to the foreground', async () => {
    // 主窗口没有关后台节流:窗口切到后台时 5 秒轮询会被 Chromium 压到 ≥1 次/分钟,
    // 所以"回到前台"必须补取一次,否则进度/状态停在几十秒前的旧值。
    // 本包用例跑在 node 环境,这里给一个最小事件目标替身(不引入 jsdom 依赖);
    // 每次响应换一个版本号,用来判断"这一轮真的落地了"(同刻只允许一条在飞请求,
    // 光看调用次数会被去重规则绊住)。
    const documentStub = Object.assign(new EventTarget(), { visibilityState: 'visible' as string })
    vi.stubGlobal('document', documentStub)
    vi.stubGlobal('window', new EventTarget())
    let served = 0
    const request = vi.fn(async () => {
      served += 1
      return Response.json({ ...healthy, availableVersion: `2.3.${String(served)}` })
    })
    vi.stubGlobal('fetch', request)

    const unsubscribe = subscribeDesktopUpdate(() => {})
    // 现象：首个快照落地（版本 2.3.1）。
    await vi.waitFor(() => { expect(readDesktopUpdate()?.availableVersion).toBe('2.3.1') }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })

    documentStub.dispatchEvent(new Event('visibilitychange'))
    // 现象：visibilitychange 后补取（版本 2.3.2）。
    await vi.waitFor(() => { expect(readDesktopUpdate()?.availableVersion).toBe('2.3.2') }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })

    ;(globalThis.window as unknown as EventTarget).dispatchEvent(new Event('focus'))
    // 现象：window focus 后补取（版本 2.3.3）。
    await vi.waitFor(() => { expect(readDesktopUpdate()?.availableVersion).toBe('2.3.3') }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })
    expect(request).toHaveBeenCalledTimes(3)

    // 窗口仍然隐藏时不必补取(切走那一刻本来就不需要新数据)。
    documentStub.visibilityState = 'hidden'
    documentStub.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(3)

    // 退订后监听器必须一起摘掉(否则最后一个订阅者离开后仍会打接口)。
    documentStub.visibilityState = 'visible'
    unsubscribe()
    documentStub.dispatchEvent(new Event('visibilitychange'))
    ;(globalThis.window as unknown as EventTarget).dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('installs a downloaded installer and checks otherwise', async () => {
    const posts: string[] = []
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/pico/desktop/update') return Response.json(healthy)
      posts.push(url)
      return new Response('', { status: 202 })
    })
    vi.stubGlobal('fetch', request)
    const unsubscribe = subscribeDesktopUpdate(() => {})
    await refreshDesktopUpdate(request)

    await triggerDesktopUpdateAction(undefined, request)
    expect(posts).toEqual(['/api/pico/desktop/update/check'])

    // 已下载好:同一个动作入口必须改点"安装"路由(而不是再检查一次)。
    const ready = { ...healthy, availableVersion: '2.3.0', readyVersion: '2.3.0', readyPath: '/tmp/i' }
    await refreshDesktopUpdate(vi.fn(async () => Response.json(ready)))
    expect(updateActionFor(readDesktopUpdate())).toBe('install')
    await triggerDesktopUpdateAction(undefined, request)
    expect(posts).toEqual(['/api/pico/desktop/update/check', '/api/pico/desktop/update/install'])
    unsubscribe()
  })
})

describe('desktop update badge view', () => {
  const base = {
    isPackaged: true,
    canDownload: true,
    currentVersion: '2.2.0',
    availableVersion: '2.3.0',
    downloadingVersion: undefined,
    downloadProgress: undefined,
    readyVersion: undefined,
    readyPath: undefined,
    retryAttempt: 0,
    retryMaxAttempts: 5,
    retryDelayMs: 0,
    lastError: undefined,
  }

  it('renders nothing without a pending update', () => {
    expect(desktopUpdateBadgeView(null)).toBeNull()
    expect(desktopUpdateBadgeView({ ...base, availableVersion: undefined })).toBeNull()
    expect(desktopUpdateBadgeView({ ...base, canDownload: false })).toBeNull()
  })

  it('shows the ready installer as an install action', () => {
    expect(desktopUpdateBadgeView({ ...base, readyVersion: '2.3.0', readyPath: '/tmp/i' })).toMatchObject({
      state: 'ready',
      label: '安装 2.3.0',
    })
  })

  it('follows the active locale instead of mixing languages in one badge', () => {
    // 2026-09-16 i18n 回归：此前 `label` 恒为中文（`安装 2.3.0`）而同一对象的
    // `title` 恒为英文 —— 任何语言下都有一半是错的。回退成任一硬编码即红。
    setActiveLocale('en')
    expect(desktopUpdateBadgeView({ ...base, readyVersion: '2.3.0', readyPath: '/tmp/i' })).toMatchObject({
      state: 'ready',
      label: 'Install 2.3.0',
      title: 'Version 2.3.0 is downloaded — click to install',
    })
    setActiveLocale('zh')
    expect(desktopUpdateBadgeView({ ...base, readyVersion: '2.3.0', readyPath: '/tmp/i' })).toMatchObject({
      state: 'ready',
      label: '安装 2.3.0',
      title: '版本 2.3.0 已下载 — 点击安装',
    })
  })

  it('shows download progress and the retry attempt', () => {
    expect(desktopUpdateBadgeView({
      ...base,
      downloadingVersion: '2.3.0',
      downloadProgress: { receivedBytes: 50, totalBytes: 100 },
      retryAttempt: 2,
      retryDelayMs: 4_000,
    })).toMatchObject({
      state: 'downloading',
      label: '2.3.0 50%',
      title: '正在重试下载（第 2/5 次），4 秒后继续…',
    })
  })

  it('translates the retry hover text too', () => {
    setActiveLocale('en')
    expect(desktopUpdateBadgeView({
      ...base,
      downloadingVersion: '2.3.0',
      retryAttempt: 2,
      retryDelayMs: 4_000,
    })).toMatchObject({ title: 'Retrying download (attempt 2/5) in 4s…' })
    expect(desktopUpdateBadgeView({
      ...base,
      downloadingVersion: '2.3.0',
      retryAttempt: 2,
      retryDelayMs: 0,
    })).toMatchObject({ title: 'Downloading (attempt 2/5)…' })
  })

  it('falls back to the available label while the download has not started', () => {
    expect(desktopUpdateBadgeView(base)).toMatchObject({ state: 'available', label: '2.3.0' })
    setActiveLocale('en')
    expect(desktopUpdateBadgeView(base)).toMatchObject({
      title: 'Version 2.3.0 available — click to check',
    })
  })
})
