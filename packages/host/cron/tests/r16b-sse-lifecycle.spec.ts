/**
 * R16B-13 回归判据（2026-09-25，第十六轮审计泳道 B，P2）。
 *
 * ## 缺陷
 *
 * `/api/cron/events` 是一条 SSE 长连接，而 `ctx.webServer.register()` 返回的
 * disposer **只把路径从路由表里删掉** —— 已经建立的连接一无所知。于是插件卸载
 * （HMR / 组合变更 / 退出）之后：那条流仍在每 15s 收 `: ping`，且**永不 `end()`**。
 * 对端是 `EventSource`，**收不到 onerror 就不会回落到轮询** ⇒ 任务列表静默冻结
 * （停在上一次推送的样子，看起来像"没有新任务"）。
 *
 * ## 现在的契约
 *
 * `makeCronRoutes(service, { lifecycle })`：`lifecycle` abort ⇒ 所有仍然打开的
 * SSE 流被 `end()` 收尾（同时停心跳、退订、摘监听）。对端自己断开（req/res 的
 * `close`）仍然只做内部收尾，不重复 `end()`。
 *
 * ---- 变异验证（实跑过，逐条单独一次调用）----
 *   - 去掉 `lifecycle` 的 abort 监听（回到修前形态）⇒ 用例①红（流没有 end）；
 *   - abort 时只 `clearInterval` 不 `res.end()` ⇒ 用例①红（对端看不到流结束）；
 *   - abort 时不 `unsubscribe()` ⇒ 用例②红（服务端订阅泄漏）；
 *   - abort 后仍写心跳（不 clearInterval）⇒ 用例③红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCronService } from '../src/host-service.ts'
import { makeCronRoutes } from '../src/host-routes.ts'
import { CRON_API_PREFIX } from '../src/protocol.ts'

function fakeService(): {
  service: HostCronService
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(() => unsubscribe)
  const service = {
    snapshot: vi.fn(() => ({ schemaVersion: 2, revision: 1, jobs: [], scheduler: { timeZone: 'local' } })),
    apply: vi.fn(() => ({ schemaVersion: 2, revision: 2, jobs: [], scheduler: { timeZone: 'local' } })),
    eventPayload: vi.fn(() => ({ revision: 1, scheduler: { timeZone: 'local' } })),
    subscribe,
  } as unknown as HostCronService
  return { service, subscribe, unsubscribe }
}

function loopbackRequest(): IncomingMessage {
  return {
    method: 'GET',
    headers: { host: 'localhost:43120', origin: 'http://localhost:43120' },
    socket: { remoteAddress: '127.0.0.1' },
    once: vi.fn(),
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { body: string, header: Record<string, string | number> } {
  const res = {
    body: '',
    statusCode: 200,
    header: {} as Record<string, string | number>,
    writeHead: vi.fn((status: number, h: Record<string, string | number>) => {
      res.statusCode = status
      res.header = h
    }),
    write: vi.fn((chunk?: string) => { res.body += chunk ?? '' }),
    end: vi.fn((body?: string) => { res.body += body ?? '' }),
    once: vi.fn(),
  }
  return res as unknown as ServerResponse & typeof res
}

let controller: AbortController
afterEach(() => { controller?.abort() })

function eventsRoute(service: HostCronService, signal: AbortSignal) {
  const route = makeCronRoutes(service, { lifecycle: signal }).find(r => r.path === `${CRON_API_PREFIX}/events`)
  expect(route).toBeDefined()
  return route!
}

describe('R16B-13 宿主卸载必须收尾仍然打开的 SSE 流', () => {
  it('① abort 之后流被 end()、心跳停、订阅退掉', async () => {
    vi.useFakeTimers()
    try {
      controller = new AbortController()
      const { service, unsubscribe } = fakeService()
      const res = response()
      eventsRoute(service, controller.signal).handler(loopbackRequest(), res)

      // 前置条件：流是开着的（首帧已写、心跳会继续）。
      expect(res.header['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(res.body).toContain('data:')
      expect(res.end).not.toHaveBeenCalled()
      vi.advanceTimersByTime(16_000)
      const writesBefore = (res.write as ReturnType<typeof vi.fn>).mock.calls.length
      expect(writesBefore).toBeGreaterThan(1)

      // 宿主卸载 ⇒ 收尾。
      controller.abort()
      expect(res.end, 'abort 之后流没有 end ⇒ 对端收不到 onerror、不会回落轮询').toHaveBeenCalledTimes(1)
      expect(unsubscribe, 'abort 之后没有退订 ⇒ 服务端订阅泄漏').toHaveBeenCalledTimes(1)

      // 心跳必须真的停了（否则"关掉"只是对端看不见的一次 end）。
      vi.advanceTimersByTime(60_000)
      expect((res.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('② abort 是幂等的：重复 abort / 对端随后 close 都不会再 end 一次', async () => {
    vi.useFakeTimers()
    try {
      controller = new AbortController()
      const { service, unsubscribe } = fakeService()
      const res = response()
      eventsRoute(service, controller.signal).handler(loopbackRequest(), res)

      controller.abort()
      controller.abort()
      expect(res.end).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('③ 没有 lifecycle 信号时保持旧行为（不主动 end，心跳照旧）', async () => {
    vi.useFakeTimers()
    try {
      const { service } = fakeService()
      const res = response()
      const route = makeCronRoutes(service, {}).find(r => r.path === `${CRON_API_PREFIX}/events`)!
      route.handler(loopbackRequest(), res)

      const writes = (res.write as ReturnType<typeof vi.fn>).mock.calls.length
      vi.advanceTimersByTime(16_000)
      expect((res.write as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(writes)
      expect(res.end).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
