// @vitest-environment jsdom
/**
 * R16B-03：「未登录时记住这次打开 ⇒ **登录成功后自动继续**」的**消费点**判据。
 *
 * ## 这条缺陷的形态是"绿本身就是缺陷"
 *
 * 修复前的同一份探针（`temp/r16/B/probes/open-intent-consumer.spec.tsx` 的旧形态）是**绿**的：
 * 它断言"挂载但未激活 ⇒ 0 次 open、意图仍在存储；**激活后** ⇒ 1 次 open"。而那个绿
 * 恰恰就是缺陷本身 —— 只有面板的挂载 effect 读意图，可面板在**非激活**态被渲染成
 * `null`（`@picoaide/dsh-panel-surface`），客户端登录又是**整文档导航**
 * （`auth-gate` 登录成功后 `location.replace('/')`）⇒"登录成功"那一刻没有任何代码在
 * 读那个意图。它于是活到用户**下一次**打开应用中心才被兑现：用户当初点的"登录后自动
 * 打开"没发生，而一次**与它无关**地打开应用中心会自己弹出一个应用窗口。
 *
 * 所以本文件的判据方向是**反转**的（修复后才成立）：页面加载（＝装载器装载、面板尚未
 * 激活）那一跳就必须把意图兑现掉，而不是等激活。
 *
 * ## 判据必须跑在真装载器上
 *
 * 走 `mountAppCenterPanel`（= `index.ts` 的 `ctx.effect` 同一个调用），意图存储是真的
 * 存储实现，打开动作走**真的** `openAppEntry`（真的宿主证明引导 + 真的本机路由 POST，
 * 只把 `fetch` 换成记录调用的假实现）—— 不退化成"断言某个 mock 被调用过"。
 *
 * ---- 变异验证（每条单独实跑过一次，见 temp/r16/U/open-intent/FINDINGS.md）----
 *   - 把 `mountAppCenterPanel` 里的 `resumeOpenIntent(...)` 摘掉（回到旧形态）
 *     ⇒ 判据① 红（挂载后 0 次 open、意图还在），②③ 仍绿；
 *   - 把认领改成"先开后清"（请求发出时意图还在存储里）⇒ 判据① 的**顺序**断言红；
 *   - 让未登录分支也开窗（去掉 `if (!loggedIn) return`）⇒ 判据② 红（未登录也发 open、
 *     意图被清掉）；
 *   - 把 `resumeOpenIntent` 里的原子认领改回"读到就清、清完就开"⇒ 竞态用例（四个
 *     消费者同时看到同一条意图）红（两次开窗）。
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_ACTIVE_ATTR } from '@picoaide/dsh-panel-surface'
import { mountAppCenterPanel, openAppCenterPanel } from './app-center-surface.tsx'
import { setAppChannel, type AppChannel } from './channel-seam.ts'
import { HOST_PROOF_PATH } from './host-proof.ts'
import { OPEN_INTENT_STORAGE_KEY, type OpenIntentStore } from './open-intent.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const APP_SCHEME = 'probe-app'
const CHANNEL: AppChannel = { appOriginScheme: APP_SCHEME, deepLinkScheme: 'probe', productName: 'Probe' }
const CATALOG = { apps: [{ app_id: 'roster', title: '值班表', access: 'login', enabled: true }] }

/** 一次被记录下来的请求。 */
interface Call { url: string, init: RequestInit }

/** 内存意图存储（同一个对象 = 同一份存储：跨页面加载留存的那一份）。 */
type MemoryIntent = OpenIntentStore & { values: Map<string, string> }

let calls: Call[]
/** 每一次 open 请求**发出那一刻**，意图是否仍在存储里（"先清后开"的顺序判据）。 */
let intentPresentAtOpen: boolean[]
let activeIntent: MemoryIntent | null
let handles: Array<() => void> = []

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/**
 * 造一份内存存储。
 * @param seed - 起始键值（缺省空）。
 * @returns 存储实现（带 `values` 便于断言）。
 */
function memoryIntent(seed: Record<string, string> = {}): MemoryIntent {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

/** 一条"登录前记下、登录后该被兑现"的意图。 */
function seededIntent(): MemoryIntent {
  return memoryIntent({ [OPEN_INTENT_STORAGE_KEY]: JSON.stringify({ appId: 'roster', at: Date.now() }) })
}

/** 中列容器：装载器按 `[class*="ConversationSurface"]` 找它（桌面壳的真实形状）。 */
function installCenterColumn(): void {
  const column = document.createElement('div')
  column.className = 'dshDesktopConversationSurface'
  document.body.appendChild(column)
}

/** 让挂载期那条异步链（登录态取数 → 认领 → 宿主证明 → 本机 POST）全部落地。 */
async function settle(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  }
}

/**
 * 用**真装载器**装载应用中心（＝插件 apply 那一跳），并把依赖注入进去。
 * @param options - 意图存储与登录态取数。
 */
async function mountPanel(options: {
  intent: MemoryIntent
  loginStateLoader?: () => Promise<boolean>
}): Promise<void> {
  activeIntent = options.intent
  let dispose: () => void = () => undefined
  // 装载本身也会渲染一次（面板还没激活 ⇒ 渲染 null）：与真装载器用例同款，包在 act 里。
  await act(async () => {
    dispose = mountAppCenterPanel({
      intentStore: options.intent,
      loginStateLoader: options.loginStateLoader ?? (async () => true),
      now: () => Date.now(),
      channelLoader: async () => CHANNEL,
      identityLoader: async () => 'alice@harness.example',
    })
    // 装载器给 body 挂了 `MutationObserver`（中列晚于插件 apply 出现），它的回调是
    // 微任务 —— 让它落在同一个 act 里，否则 React 会在 act 之外报"更新未包在 act 中"。
    await Promise.resolve()
  })
  handles.push(dispose)
  await settle()
}

/** 本机打开路由的请求（唯一判据：窗口是不是真的会被打开）。 */
const openCalls = (): Call[] => calls.filter(call => call.url === '/api/pico/wasm-apps/open')

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
  installCenterColumn()
  setAppChannel(null)
  calls = []
  intentPresentAtOpen = []
  activeIntent = null
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    if (url === HOST_PROOF_PATH) {
      return jsonResponse(200, { proof: 'probe-proof', expires_at: Date.now() + 5 * 60_000 })
    }
    if (url === '/api/pico/wasm-apps/channel') return jsonResponse(200, CHANNEL)
    if (url === '/api/pico/wasm-apps/open') {
      // 顺序判据的取样点：请求发出的**那一刻**意图还在不在存储里。
      intentPresentAtOpen.push(activeIntent !== null && activeIntent.values.has(OPEN_INTENT_STORAGE_KEY))
      return jsonResponse(200, { url: `${APP_SCHEME}://roster/`, window: 'opened' })
    }
    if (url === '/api/pico/apps/wasm') return jsonResponse(200, CATALOG)
    return jsonResponse(200, { ok: true })
  }))
})

afterEach(async () => {
  // 卸载也走 act：装载器的 `dispose()` 会 `root.unmount()`（一次 React 更新），
  // 不在 act 里会刷一屏"更新未包在 act 中"的噪音（真装载器用例同款写法）。
  const disposing = handles
  handles = []
  await act(async () => { for (const dispose of disposing) dispose() })
  vi.unstubAllGlobals()
})

describe('R16B-03 判据：消费点站在「页面加载」那一跳', () => {
  it('① 已登录 + 有意图 ⇒ **挂载（未激活）即恰好 1 次 open**，且意图被清掉（清在开之前）', async () => {
    const intent = seededIntent()
    await mountPanel({ intent, loginStateLoader: async () => true })

    // 面板容器已建，但面板**未激活** —— 这就是"登录成功、整文档导航回来"的那一跳。
    expect(document.querySelector('[data-dsh-panel-surface="apps"]')).not.toBeNull()
    expect(document.documentElement.getAttribute(PANEL_ACTIVE_ATTR)).toBeNull()

    expect(openCalls(), '未激活也必须把意图兑现（修复前这里是 0）').toHaveLength(1)
    expect(JSON.parse(String(openCalls()[0]!.init.body))).toEqual({ app_id: 'roster' })
    // 至多一次：开窗前必须已经认领（清掉）—— 清在开之前，不是开完再清。
    expect(intentPresentAtOpen, 'open 请求发出时意图必须已经从存储里消失').toEqual([false])
    expect(intent.values.has(OPEN_INTENT_STORAGE_KEY), '兑现之后不留残影').toBe(false)

    // 用户随后才点开应用中心（激活）⇒ 不能再开第二个窗。
    await act(async () => { openAppCenterPanel() })
    await settle()
    expect(openCalls(), '激活不得重复开窗').toHaveLength(1)
  })

  it('② 未登录 + 有意图 ⇒ 挂载不发 open，且意图**仍在存储**（不丢）；取数抛错也一样', async () => {
    const intent = seededIntent()
    await mountPanel({ intent, loginStateLoader: async () => false })
    expect(openCalls(), '未登录不许开窗').toHaveLength(0)
    expect(intent.values.has(OPEN_INTENT_STORAGE_KEY), '未登录时必须原样留着，等下一次页面加载').toBe(true)

    // 登录态**取数失败**是"拿不到登录态"的另一种形态：同样不许开窗，同样不许丢意图。
    const firstRound = handles
    handles = []
    await act(async () => { for (const dispose of firstRound) dispose() })
    const afterError = seededIntent()
    await mountPanel({ intent: afterError, loginStateLoader: async () => { throw new Error('auth state unreachable') } })
    expect(openCalls(), '登录态取不到时不许开窗').toHaveLength(0)
    expect(afterError.values.has(OPEN_INTENT_STORAGE_KEY), '取数失败不得把意图丢掉').toBe(true)
  })

  it('③ 无意图 ⇒ 挂载发出 0 次 open（不能无条件开窗）', async () => {
    await mountPanel({ intent: memoryIntent(), loginStateLoader: async () => true })
    expect(openCalls(), '没有待继续的打开时，页面加载什么都不该开').toHaveLength(0)
  })
})

/**
 * 「至多一次」的**竞态**判据（附加，R16B-03 的硬要求之一）。
 *
 * 两个消费者（页面加载级 + 面板挂载兜底）完全可能都先**读到**同一条意图、再各自开窗：
 * 页面加载这一跳的登录态取数还没回来时，用户点开了应用中心。这里用一个"第一次调用挂起、
 * 第二次立刻为真"的登录态取数把那个交错**确定性地**摆出来。
 */
describe('R16B-03 附加判据：两个消费者抢同一条意图时，只开一个窗', () => {
  it('面板先认领成功 ⇒ 迟到的页面加载消费者不再开第二个窗', async () => {
    const intent = seededIntent()
    let releaseResume: (() => void) | null = null
    let call = 0
    const loginStateLoader = async (): Promise<boolean> => {
      call += 1
      // 第 1 次（页面加载级消费者）挂起：模拟"登录态取数还没回来"的窗口。
      if (call === 1) await new Promise<void>(resolve => { releaseResume = resolve })
      return true
    }
    activeIntent = intent
    let dispose: () => void = () => undefined
    await act(async () => {
      dispose = mountAppCenterPanel({
        intentStore: intent,
        loginStateLoader,
        now: () => Date.now(),
        channelLoader: async () => CHANNEL,
        identityLoader: async () => 'alice@harness.example',
      })
      await Promise.resolve()
    })
    handles.push(dispose)
    await settle()
    expect(openCalls(), '页面加载这一跳还卡在登录态取数上').toHaveLength(0)

    // 用户在这个窗口里点开了应用中心：面板的挂载兜底读到同一条意图并认领成功。
    await act(async () => { openAppCenterPanel() })
    await settle()
    expect(openCalls(), '面板兜底应把这次打开兑现').toHaveLength(1)

    // 迟到的页面加载消费者回来了：它必须发现意图已被认领并**停手**。
    await act(async () => { releaseResume?.() })
    await settle()
    expect(openCalls(), '同一个意图只许开一个窗').toHaveLength(1)
    expect(intent.values.has(OPEN_INTENT_STORAGE_KEY)).toBe(false)
  })
})
