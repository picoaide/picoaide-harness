/**
 * `requestOpen` 的**会话代际守卫**判据（第三十三轮 FIX-49 ④ / AD1-02）。
 *
 * # 被修的形态
 *
 * `requestOpen` 的形状是「入口读一次会话 → `await` 一次平台往返 → 落地」，而落地面是
 * **模块级**状态（`knownVersions` / `knownTitles` / `cache.clearApp` / `windows.close`）。
 * 上一代（A）的平台答复如果在**换代之后**才回来，它就会：
 *   ① 写进新账号（B）的版本表 ⇒ B 下次打开的 `current_version` 是 A 那一代的值；
 *   ② `cache.clearApp()` 按 B 的作用域清；
 *   ③ `windows.close()` 关掉 **B 刚打开的那个窗口**。
 * 修前这台真机探针三格实跑（本包外，`temp/r32/AE2/probe/wasm-host-late.mjs`）：
 * ① 出站 `current_version="9.9.9"`（A 的值）、② `closeAppWindow(1)`（B 的窗口）。
 *
 * # 判据为什么必须打成确定性
 *
 * 这条竞态靠 sleep 去撞是**概率**判据。这里把"平台往返"与"会话换代"都做成由用例显式
 * 放行的闸门：先让某次 open 卡在出站上，再按顺序释放"换代"与"答复"，最后断言**表里
 * 是什么 / 谁被关掉**。三个用例覆盖三个落地点，第 4 例是**反向对照**（同代不换代 ⇒
 * 迟到 404 必须关掉自己那一代的窗口）—— 没有它，"② 没有关窗"可能只是"判据看不见关窗"。
 *
 * # 变异（去掉守卫必红）
 *
 * 把 `index.ts` 里任何一处 `if (!sessionEpochs.isCurrent(generation)) return …` 删掉，
 * 对应用例立刻变红（实跑证据见 temp/r21/fix-49/logs/verdict-mutant-noguard.log 的三格探针）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  apply,
  WASM_APP_OPEN_ROUTE,
  WASM_APPS_HOST_ADAPTER_SERVICE,
  WASM_APPS_LOCAL_PREFIX,
  WASM_APPS_WINDOW_ADAPTER_SERVICE,
} from './index.ts'

/** 两个**不同作用域**的会话（服务端地址 + 用户名都不同 ⇒ 分区/版本表/缓存全不同代）。 */
const ALICE = { serverURL: 'https://harness-a.example.com', token: 'tok-a', username: 'alice' }
const BOB = { serverURL: 'https://harness-b.example.com', token: 'tok-b', username: 'bob' }
const APP = 'my-notes'

/**
 * 到"当前这一轮异步链跑完"：先排空微任务（判据里的换代就排在微任务上，必须排在
 * `cache.clearApp` 的真 IO **之前**），再让出**一个宏任务**给 fs / 定时器（本机路由的
 * 应答链要经过真实 IO 才落地 —— 只排微任务会永远看不到回包）。
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 可手动放行的闸门。 */
function gate<T>(): { release: (value: T) => void, wait: Promise<T> } {
  let release: (value: T) => void = () => {}
  const wait = new Promise<T>((resolve) => { release = resolve })
  return { release: value => { release(value) }, wait }
}

const answer = (version: string, changed = true) =>
  new Response(JSON.stringify({ version, changed }), { status: 200 })
const notFound = () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 })

/** 本机路由 handler 的最小面（用例只调这一条路由）。 */
type RouteHandler = (request: unknown, reply: unknown) => unknown

/**
 * 起一个被测插件实例。
 *
 * 平台出站（`/open`）走 `onOpen`（可挂闸门），其余一律 200 `{}`；出站请求体被记下来
 * —— `current_version` 就是"版本表里当前是什么"的**唯一外部观测**。
 */
function boot(onOpen: (index: number) => Promise<Response>) {
  const bodies: Array<Record<string, unknown> | undefined> = []
  const opened: Array<{ partition?: string }> = []
  const closed: number[] = []
  const routes = new Map<string, { path: string, handler: RouteHandler }>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let current: typeof ALICE | typeof BOB = ALICE
  const services = new Map<string, unknown>([
    [WASM_APPS_HOST_ADAPTER_SERVICE, {
      handleAppScheme: () => {},
      handleInSession: () => {},
      fetch: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/open')) {
          bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined)
          return onOpen(bodies.length - 1)
        }
        return new Response('{}', { status: 200 })
      },
    }],
    [WASM_APPS_WINDOW_ADAPTER_SERVICE, {
      createAppWindow: (options: { partition?: string }) => { opened.push(options); return { id: opened.length } },
      focusAppWindow: () => {},
      closeAppWindow: (handle: { id: number }) => { closed.push(handle.id) },
      setAspectRatio: () => {},
      webContentsId: (handle: { id: number }) => handle.id,
      webContents: (handle: { id: number }) => ({ wc: handle.id }),
      workArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    }],
    ['picoSession', { getSession: () => current, isRestored: () => true, clear: () => {} }],
    ['desktopRuntime', { locale: 'zh' }],
    ['connection', { requestRejection: () => undefined }],
  ])
  const ctx = {
    get: (name: string) => services.get(name),
    inject: () => () => {},
    on: (event: string, handler: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => set.delete(handler)
    },
    emit: (event: string, payload: unknown) => { for (const handler of listeners.get(event) ?? []) handler(payload) },
    effect: (callback: () => void) => { callback() },
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      port: 41999,
      register: (route: { path: string, handler?: (req: unknown, reply: unknown) => unknown }) => {
        routes.set(route.path, { path: route.path, handler: route.handler as RouteHandler })
        return () => {}
      },
    },
  }
  apply(ctx as never, { userDataDir: mkdtempSync(join(tmpdir(), 'epoch-guard-')), appOriginScheme: 'example-a-app' })

  const route = [...routes.values()][0]!
  const call = (method: string, body?: string, headers: Record<string, string> = {}, url = WASM_APP_OPEN_ROUTE) => {
    const state = { status: 0, body: '' }
    const request = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
    }
    const reply = {
      writeHead(status: number) { state.status = status; return reply },
      setHeader() {},
      end(chunk?: string | Uint8Array) {
        state.body = typeof chunk === 'string' ? chunk : (chunk === undefined ? '' : Buffer.from(chunk).toString('utf8'))
      },
    }
    void route.handler(request, reply)
    return state
  }
  const waitStatus = async (state: { status: number }, label: string): Promise<void> => {
    for (let i = 0; i < 400 && state.status === 0; i++) await flush()
    expect(state.status, `${label} 没有回包`).not.toBe(0)
  }
  return {
    bodies,
    opened,
    closed,
    /** 取一次本机持有性证明（打开路由是 `proof: 'required'`）。 */
    async proof(): Promise<string> {
      const state = call('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`)
      await waitStatus(state, 'host-proof')
      return (JSON.parse(state.body) as { proof: string }).proof
    },
    /** 发一次打开请求（不等待回包 —— 调用方自己决定何时 await）。 */
    open(token: string) {
      const state = call('POST', JSON.stringify({ app_id: APP }), { 'x-pico-host-proof': token })
      return { state, done: waitStatus(state, `open ${APP}`) }
    },
    /** 换代：改会话 + 广播事件（与 `subscribeSessionChanges` 的真实形态一致）。 */
    switchTo(next: typeof ALICE | typeof BOB): void {
      current = next
      for (const handler of listeners.get('pico/session-changed') ?? []) handler(next)
    },
  }
}

describe('requestOpen 的会话代际守卫（FIX-49 ④ / AD1-02）', () => {
  it('用例1（换代在平台往返期间）：迟到答复不得写进新账号的版本表', async () => {
    const first = gate<Response>()
    const host = boot(index => (index === 0 ? first.wait : Promise.resolve(answer('2.0.0'))))
    const token = await host.proof()

    const a = host.open(token)
    for (let i = 0; i < 400 && host.bodies.length < 1; i++) await flush()
    expect(host.bodies.length, 'A 的第一次出站已发出').toBe(1)

    // 换代**先于**答复到达：A 的这一次在检查点②就该被丢弃。
    host.switchTo(BOB)
    const b = host.open(token)
    await b.done
    expect(b.state.status, 'B 这一次是正常打开').toBe(200)

    first.release(answer('9.9.9')) // A 的迟到答复（版本 9.9.9）
    await a.done

    const c = host.open(token)
    await c.done
    const last = host.bodies[host.bodies.length - 1]
    expect(
      last?.current_version,
      'B 下一次打开时版本表里必须是 B 自己的值（"9.9.9" = A 那一代的迟到答复写进来了）',
    ).toBe('2.0.0')
  })

  it('用例2（换代在清缓存期间，检查点③）：迟到的 `changed` 不得把旧版本写进新账号的表', async () => {
    const first = gate<Response>()
    const host = boot(index => (index === 0 ? first.wait : Promise.resolve(answer('2.0.0'))))
    const token = await host.proof()

    const a = host.open(token)
    for (let i = 0; i < 400 && host.bodies.length < 1; i++) await flush()

    // 先放行**答复**、再排一个换代微任务：`requestOpen` 的续体先跑（通过检查点②），
    // 随后卡在 `await cache.clearApp(...)` 上让出控制权 ⇒ 换代落在清缓存期间，
    // 只有检查点③能拦住它。
    first.release(answer('9.9.9'))
    queueMicrotask(() => { host.switchTo(BOB) })
    await a.done
    expect(a.state.status, '这一次的结论属于上一代 ⇒ 不回给调用方').toBe(503)
    await flush()

    const b = host.open(token)
    await b.done
    const last = host.bodies[host.bodies.length - 1]
    expect(
      last?.current_version,
      '换代清空版本表之后，上一代的 `changed` 答复不得再 `set`（"9.9.9" = 检查点③ 失效）',
    ).toBe('')
  })

  it('用例3（反向对照：同代不换代）：迟到 404 必须关掉自己那一代的窗口', async () => {
    const second = gate<Response>()
    const host = boot(index => (index === 0 ? Promise.resolve(answer('1.0.0')) : second.wait))
    const token = await host.proof()

    const a = host.open(token)
    await a.done
    expect(host.opened.length, '第一次打开建了一个窗口').toBe(1)

    const late = host.open(token)
    for (let i = 0; i < 400 && host.bodies.length < 2; i++) await flush()
    second.release(notFound())
    await late.done

    expect(
      host.closed,
      '同代的迟到 404 关掉的必须是 alice 自己那一代的窗口（这条同时证明判据能观察到"关窗"）',
    ).toEqual([1])
  })

  it('用例4（换代在平台往返期间 + 迟到 404）：不得关掉新账号刚开的窗口', async () => {
    const first = gate<Response>()
    const host = boot(index => (index === 0 ? first.wait : Promise.resolve(answer('2.0.0'))))
    const token = await host.proof()

    const a = host.open(token)
    for (let i = 0; i < 400 && host.bodies.length < 1; i++) await flush()
    host.switchTo(BOB)
    const b = host.open(token)
    await b.done
    const bobWindow = host.opened.length

    first.release(notFound())
    await a.done
    await flush()

    expect(
      host.closed.includes(bobWindow),
      `closeAppWindow(${bobWindow}) = B 刚打开的窗口被上一代的迟到 404 关掉（跨代副作用）`,
    ).toBe(false)
  })
})
