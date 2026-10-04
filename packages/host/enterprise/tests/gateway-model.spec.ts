import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config as GatewayLlmConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { GATEWAY_LLM_ROW_ID } from '../src/gateway-contract.ts'
import { apply, TOKEN_ENV } from '../src/gateway-model.ts'
import { SESSION_CHANGED_EVENT } from '../src/session-service.ts'
import type { Session } from '../src/server-connector/config.ts'

const SESSION: Session = {
  serverURL: 'https://gateway.example/',
  username: 'tester',
  token: 'tok-1',
}

function ctxFixture() {
  const set = vi.fn(async () => {})
  const unset = vi.fn(async () => {})
  const update = vi.fn(async () => {})
  const replace = vi.fn(async () => {})
  const listeners = new Set<(session: Session | null) => void>()
  const ctx = {
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    on: (event: string, listener: (session: Session | null) => void) => {
      expect(event).toBe(SESSION_CHANGED_EVENT)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    credentials: { set, unset },
    settings: {
      update,
      replace,
    },
  } as unknown as Context
  return {
    ctx,
    set,
    unset,
    update,
    replace,
    emit: (session: Session | null) => { for (const l of [...listeners]) l(session) },
  }
}

describe('gateway-model', () => {
  it('exposes the stable env/token contract', () => {
    expect(TOKEN_ENV).toBe('PICOAI_GATEWAY_TOKEN')
  })

  it('writes the session token and points the gateway provider row at the server', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit(SESSION)
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.set).toHaveBeenCalledWith(expect.anything(), 'tok-1'), { timeout: 10_000 })
    expect(f.unset).not.toHaveBeenCalled()
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(GATEWAY_LLM_ROW_ID, {
      baseURL: 'https://gateway.example/v1',
    }), { timeout: 10_000 })
  })

  it('syncs an already-restored session on apply (startup race)', async () => {
    // SessionService.restore() can finish before this plugin's apply(); the
    // first session-changed event is then already gone. apply() must sample
    // the restored session itself.
    const f = ctxFixture()
    ;(f.ctx as unknown as { picoSession: unknown }).picoSession = {
      isRestored: () => true,
      getSession: () => SESSION,
    }
    apply(f.ctx)
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.set).toHaveBeenCalledWith(expect.anything(), 'tok-1'), { timeout: 10_000 })
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(GATEWAY_LLM_ROW_ID, {
      baseURL: 'https://gateway.example/v1',
    }), { timeout: 10_000 })
  })

  it('strips trailing slashes from the server URL', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit({ ...SESSION, serverURL: 'https://gateway.example///' })
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(GATEWAY_LLM_ROW_ID, {
      baseURL: 'https://gateway.example/v1',
    }), { timeout: 10_000 })
  })

  it('clears the credential and resets the section on logout', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit(null)
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.unset).toHaveBeenCalledWith(expect.anything()), { timeout: 10_000 })
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.replace).toHaveBeenCalledWith(expect.anything(), {}), { timeout: 10_000 })
    expect(f.set).not.toHaveBeenCalled()
  })

  it('logs (instead of throwing) when the credential write fails', async () => {
    const f = ctxFixture()
    f.set.mockRejectedValueOnce(new Error('denied'))
    apply(f.ctx)
    f.emit(SESSION)
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.ctx.logger.error).toHaveBeenCalled(), { timeout: 10_000 })
  })

  // 2026-09-28（DSH 0.1.7-rc.2 引入、**0.2.0-rc.2 复核仍成立**）：0.1.6 那条
  // 「组装期钉死 protocol: chat-completions」的
  // 修法整体作废 —— 上游把这个键**删掉了**，配了直接抛错；鉴权搬到 provider 注册面
  // （`gateway-llm.ts` 的 `resolveAuth` 发 `Authorization: Bearer`）。
  // 这条判据驱动的是**上游真实 schema + 解析一步**（不是字符串 grep）：写进网关行的键
  // 必须全部能被那一行自己的 Config 吃下，而 0.1.6 的两个键现在一个抛错、一个不存在。
  it('写入网关行的段必须能被 provider 行自己的 schema 吃下（0.1.7 起已无 protocol/apiKeyEnv）', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit(SESSION)
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => expect(f.update).toHaveBeenCalled(), { timeout: 10_000 })
    const [ns, payload] = f.update.mock.calls.at(-1) as [string, Record<string, unknown>]
    // 命名空间 = profile 条目 id（`SettingsForms` 按条目 id 找表单），也就是组装期那一行的 id。
    expect(ns).toBe(GATEWAY_LLM_ROW_ID)
    expect(() => resolveAdapterOptions(plainOptions(GatewayLlmConfig(payload)))).not.toThrow()
    // 0.1.6 的 `protocol` 现在让整行抛错 —— 这正是它必须消失的原因（保留它 = 登录后模型面全灭）。
    expect(() => resolveAdapterOptions(plainOptions(GatewayLlmConfig({ ...payload, protocol: 'chat-completions' }))))
      .toThrow('protocol is not configurable')
    // 0.1.6 的 `apiKeyEnv` 不在本行的 schema 里（它只属于上游 `llm-deepseek-api-key` 的
    // 私有 Config）⇒ `SettingsForms.write` 会以 `Config field "apiKeyEnv" is not volatile` 抛错。
    expect(Object.hasOwn(GatewayLlmConfig({}), 'apiKeyEnv')).toBe(false)

    // 上游产物通过桌面包（部署根，声明了 llm-deepseek）解析，而不是从本包 —
    // 本包不声明该依赖，直接从测试文件解析会 Cannot find module。
    const desktopManifest = createRequire(import.meta.url).resolve('dsh-plugin-desktop/package.json')
    const pkgDir = dirname(createRequire(desktopManifest).resolve('@deepseek-ai/dsh-llm-deepseek/package.json'))
    const upstreamConfig = readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')
    // 适配器只剩 Messages 一条路径（端点固定 `<baseURL>/messages`）：这条探测提醒复核
    // `gateway-model.ts` 写入的 baseURL 是否仍是"网关根 + /v1"。
    if (!/\/messages/.test(upstreamConfig)) {
      console.warn('[gateway-model] 上游 llm-deepseek 的 Messages 端点不见了 —— 复核网关 baseURL 口径')
    }
  })

  // 组装期 YAML ↔ 代码常量：桌面组合消费的就是这个文件，而行 id 就是设置命名空间。
  // 这条在**企业包内**判（不需要 enterprise/lib 已构建，也不依赖桌面包），与桌面包那条
  // 「组合结果里那一行」判据合起来才闭环：YAML 的 id == 常量，组合里的 id == YAML 的 id。
  it('组装补丁那一行 id 与常量逐字一致，上游 x-api-key 行被禁用、任何行都不带 protocol', () => {
    const entries = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<{
      id?: unknown
      disabled?: unknown
      config?: unknown
      insert?: unknown
    }>
    const inserted = entries
      .flatMap(entry => Array.isArray(entry.insert) ? entry.insert : []) as Array<{ id?: unknown, name?: unknown }>
    const gateway = inserted.filter(entry => entry.name === '@picoaide/dsh-enterprise/gateway-llm')
    expect(gateway, '补丁必须恰插入一条网关 provider 行').toHaveLength(1)
    expect(gateway[0]?.id).toBe(GATEWAY_LLM_ROW_ID)
    // 上游那一行必须被禁用（留着 = 两个适配器抢同一个 provider 路由）。
    expect(entries.find(entry => entry.id === 'llm-deepseek')?.disabled).toBe(true)
    // 任何一行 config 都不得带 0.1.7 已删除的 `protocol`（配了整行激活即抛错）。
    for (const entry of [...entries, ...inserted]) {
      expect(Object.hasOwn((entry.config ?? {}) as object, 'protocol')).toBe(false)
    }
  })
})

describe('会话代际守卫（Z2-01）：登出的迟到续体不得清掉重新登录后的网关配置', () => {
  const SESSION_A: Session = { serverURL: 'https://server-a.example.com', username: 'alice', token: 'tok-a' }
  const SESSION_B: Session = { serverURL: 'https://server-b.example.com', username: 'bob', token: 'tok-b' }

  const flush = async (n = 12): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }

  it('登出续体落后于重新登录时，网关 provider 段不得被清空', async () => {
    // `credentials.unset` 慢一拍（真实实现要落盘/走 keyring）：登出那次 sync(null)
    // 的续体落在"用户已经登录到另一台服务端"之后。没有守卫时它会 replace({}) ——
    // 把新会话的 baseURL/models 整段清掉，而凭据已经是新会话的令牌。
    let releaseUnset: (() => void) | undefined
    const set = vi.fn(async () => undefined)
    const unset = vi.fn(() => new Promise<void>((resolve) => { releaseUnset = resolve }))
    const listeners = new Set<(session: Session | null) => void>()
    const writes: Array<{ ns: string; value: Record<string, unknown>; kind: 'update' | 'replace' }> = []
    const ctx = {
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      on: (event: string, listener: (session: Session | null) => void) => {
        expect(event).toBe(SESSION_CHANGED_EVENT)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      credentials: { set, unset },
      settings: {
        update: vi.fn(async (ns: string, value: Record<string, unknown>) => { writes.push({ ns: String(ns), value, kind: 'update' }) }),
        replace: vi.fn(async (ns: string, value: Record<string, unknown>) => { writes.push({ ns: String(ns), value, kind: 'replace' }) }),
      },
    } as unknown as Context
    const emit = (session: Session | null): void => { for (const l of [...listeners]) l(session) }

    apply(ctx)
    emit(SESSION_A)
    await flush()
    emit(null) // 登出：unset 挂住
    await flush()
    emit(SESSION_B) // 用户立刻登录到另一台服务端
    await flush()

    const writesBeforeLateUnset = writes.length
    const lastBefore = writes.at(-1)
    expect(lastBefore?.value.baseURL).toBe('https://server-b.example.com/v1')
    expect(set).toHaveBeenLastCalledWith(expect.anything(), 'tok-b')

    releaseUnset?.() // 登出的续体现在才继续
    await flush()

    expect(
      {
        cleared: writes.some((w) => w.ns === GATEWAY_LLM_ROW_ID && Object.keys(w.value).length === 0),
        writes: writes.length,
        before: writesBeforeLateUnset,
        finalBaseURL: writes.filter((w) => w.ns === GATEWAY_LLM_ROW_ID).at(-1)?.value.baseURL,
      },
      '登出的迟到续体在当前会话（B）之后把网关 provider 段清空了',
    ).toEqual({
      cleared: false,
      writes: writesBeforeLateUnset,
      before: writesBeforeLateUnset,
      finalBaseURL: 'https://server-b.example.com/v1',
    })
  })
})
