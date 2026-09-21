/**
 * 控制权提示 store 的行为断言（2026-09-21 底部并道改造把轮询从组件里搬出来）。
 *
 * 为什么单独钉一份：这段轮询原来住在 `BrowserTrigger` 的 `useControlHint()` 里 ——
 * 那时它随组件挂载。搬进插件级 store 之后，"失败保留上一次结果"与"停止后不再续排"
 * 这两条语义没有任何组件再替它兜底了；出错的表现是**提示消失**（用户以为 AI 不等了），
 * 比多一次请求严重得多。
 *
 * ---- 变异验证 ----
 *   - 失败分支把 hint 重置成 `NO_CONTROL_HINT` ⇒「失败保留上一次结果」红；
 *   - 取值不变也通知订阅者 ⇒「取值不变不重复发布」红；
 *   - `dispose()` 不清定时器 / 不置 stopped ⇒「dispose 后不再轮询」红；
 *   - `start()` 不立即读一次 ⇒「start 立刻读一次」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_POLL_MS, NO_CONTROL_HINT, type ControlHint } from '../src/client/control-hint.ts'

/** 每条用例都用一份**全新的**模块实例（store 是模块级状态）。 */
async function freshStore(): Promise<typeof import('../src/client/control-hint-store.ts')> {
  vi.resetModules()
  return import('../src/client/control-hint-store.ts')
}

/** `/api/pico/browser/state` 的一个成功响应。 */
function stateResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 让已排队的 promise 链跑完（store 的读取是异步的）。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('浏览器控制权提示 store', () => {
  it('未启动时是"无提示"（不凭空报警）', async () => {
    const store = await freshStore()
    expect(store.current()).toEqual(NO_CONTROL_HINT)
  })

  it('start() 立刻读一次，把载荷投影后发布给订阅者', async () => {
    const store = await freshStore()
    const fetchMock = vi.fn(async () => stateResponse({ controlled: true, awaitingRelease: true }))
    vi.stubGlobal('fetch', fetchMock)
    const seen: ControlHint[] = []
    store.subscribe(() => { seen.push(store.current()) })
    store.start()
    await settle()
    expect(fetchMock).toHaveBeenCalledWith('/api/pico/browser/state')
    expect(store.current()).toEqual({ controlled: true, awaiting: true })
    expect(seen).toEqual([{ controlled: true, awaiting: true }])
    store.dispose()
  })

  it('取值不变时不重复发布（避免每 5s 白推一次 touch）', async () => {
    const store = await freshStore()
    const fetchMock = vi.fn(async () => stateResponse({ controlled: true, awaitingRelease: true }))
    vi.stubGlobal('fetch', fetchMock)
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.start()
    await settle()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(calls).toBe(1)
    store.dispose()
  })

  it('取值变化时发布（"AI 在等你"出现/消失都算）', async () => {
    const store = await freshStore()
    let awaiting = true
    vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ controlled: true, awaitingRelease: awaiting })))
    const seen: boolean[] = []
    store.subscribe(() => { seen.push(store.current().awaiting) })
    store.start()
    await settle()
    // 首轮：初值是无提示，读到 awaiting=true ⇒ 发布一次。
    expect(seen).toEqual([true])
    awaiting = false
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(seen).toEqual([true, false])
    awaiting = true
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(seen).toEqual([true, false, true])
    store.dispose()
  })

  it('读取失败保留上一次结果（宿主暂时不可用时提示不许闪回"没有等待"）', async () => {
    const store = await freshStore()
    const fetchMock = vi.fn(async () => stateResponse({ controlled: true, awaitingRelease: true }))
    vi.stubGlobal('fetch', fetchMock)
    store.start()
    await settle()
    expect(store.current().awaiting).toBe(true)
    fetchMock.mockImplementation(async () => { throw new Error('host down') })
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(store.current().awaiting).toBe(true)
    // 非 2xx 同理（读面被拒 ≠ 没有等待）。
    fetchMock.mockImplementation(async () => new Response('nope', { status: 503 }))
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(store.current().awaiting).toBe(true)
    store.dispose()
  })

  it('dispose() 停止轮询：不再发请求、也不留定时器', async () => {
    const store = await freshStore()
    const fetchMock = vi.fn(async () => stateResponse({ controlled: false, awaitingRelease: false }))
    vi.stubGlobal('fetch', fetchMock)
    store.start()
    await settle()
    const afterStart = fetchMock.mock.calls.length
    store.dispose()
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS * 3)
    expect(fetchMock.mock.calls.length).toBe(afterStart)
  })

  it('dispose() 后重新 start() 能再跑起来（插件重载）', async () => {
    const store = await freshStore()
    const fetchMock = vi.fn(async () => stateResponse({ controlled: false, awaitingRelease: true }))
    vi.stubGlobal('fetch', fetchMock)
    store.start()
    await settle()
    store.dispose()
    store.start()
    await settle()
    expect(store.current().awaiting).toBe(true)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    store.dispose()
  })

  it('dispose() 落在在途读取上：那一轮作废、不再续排（不留"孤儿"定时器）', async () => {
    const store = await freshStore()
    let release: ((value: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    store.start()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 读取还在飞的时候卸载。
    store.dispose()
    release?.(stateResponse({ controlled: true, awaitingRelease: true }))
    await settle()
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS * 3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 作废的那一轮连状态都不许写（否则界面会显示一个已经没人订阅的提示）。
    expect(store.current().awaiting).toBe(false)
  })

  it('dispose 后立刻 start：旧链不许续排（否则同一个端点两条轮询链）', async () => {
    const store = await freshStore()
    let call = 0
    let failFirst: ((cause: Error) => void) | undefined
    // 第一轮**失败**（宿主不可达）：它不走"读到结果"那条早退分支，而是从 catch 直接
    // 落到"排下一轮"那一步 —— 正是世代号要拦下的那条路径。用成功响应做夹具时，
    // 早退分支会替世代号把关，把守卫删掉也照样绿（变异验证实测）。
    const fetchMock = vi.fn(() => {
      call += 1
      if (call === 1) return new Promise<Response>((_resolve, reject) => { failFirst = reject })
      return Promise.resolve(stateResponse({ controlled: false, awaitingRelease: false }))
    })
    vi.stubGlobal('fetch', fetchMock)
    store.start() // 链 A：在途
    store.dispose()
    store.start() // 链 B
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    failFirst?.(new Error('host down'))
    await settle()
    // 链 B 的第一次读取已排下一轮；链 A 的失败轮次不许再排一轮。
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await settle()
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    store.dispose()
  })
})
