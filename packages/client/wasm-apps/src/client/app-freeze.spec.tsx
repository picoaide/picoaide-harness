// @vitest-environment jsdom
/**
 * R5-B-7：冻结在员工侧**可见 + 可解冻**，且文案与可达路径一致（2026-09-23 修复）。
 *
 * 修复前的现场（只读审计 R5-B-7）：服务端**对发布者开着**
 * `POST /api/client/v2/apps/wasm/:app_id/freeze`，宿主也早就原样转发 body，但客户端
 * 既没有 `setFrozen*` 生命周期函数、也没有任何面板入口 —— 而字典里一条 hint 承诺
 * "发布者本人可以解冻（同一端点带 {"frozen":false}）"，另一条又说"联系平台管理员"。
 * 承诺有端点、有授权、没有路，就是这条 finding。
 *
 * 本文件钉三件事（每一件都能被变异打坏，见每节的注释）：
 *  1. **纯逻辑**：路径/请求体/解析（`frozen` 缺席 ⇒ 形状错误，**不**回落成请求值）；
 *  2. **真挂载**：冻结行渲染「已冻结」+ 说明 + 「解冻」按钮、打开按钮禁用；点解冻真的
 *     发 `POST …/freeze {"frozen":false}` 并按**服务端回包**更新行；
 *  3. **文案对齐**：两条 hint 给同一个答案（发布者 → 应用中心；其他人 → 管理员），
 *     且不再出现"同一端点带 {"frozen":false}"这种员工无法执行的接口契约句。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppCenterPanel } from './AppCenterPanel.tsx'
import {
  SET_FROZEN_SUFFIX,
  parseSetFrozenOutcome,
  setAppFrozen,
  setFrozenPath,
} from './app-lifecycle.ts'
import { APP_CHANNEL_PATH, type AppChannel } from './channel-seam.ts'
import { APP_AI_IDENTITY_PATH } from './app-ai.ts'
import { HOST_PROOF_PATH, setHostProofToken } from './host-proof.ts'
import { en, setActiveLocale, zh } from './locales.ts'

const APP_SCHEME = 'picoaide-app'
const OFFICIAL_CHANNEL: AppChannel = { appOriginScheme: APP_SCHEME, deepLinkScheme: 'picoaide', productName: 'PicoAide' }

interface Call { url: string, init: RequestInit }
let container: HTMLDivElement
let root: Root
let calls: Call[]

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const INFRA_PATHS: readonly string[] = [HOST_PROOF_PATH, APP_CHANNEL_PATH, APP_AI_IDENTITY_PATH]
const businessCalls = (): Call[] => calls.filter(call => !INFRA_PATHS.includes(call.url))

function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const init_ = init ?? {}
    calls.push({ url, init: init_ })
    if (url === HOST_PROOF_PATH) return jsonResponse(200, { proof: 'host-proof-test', expires_at: Date.now() + 5 * 60_000 })
    if (url === APP_CHANNEL_PATH) return jsonResponse(200, OFFICIAL_CHANNEL)
    if (url === APP_AI_IDENTITY_PATH) return jsonResponse(200, { loggedIn: true, username: 'alice', serverURL: 'https://harness.example' })
    return await respond(url, init_)
  }))
}

async function mount(): Promise<void> {
  await act(async () => { root.render(<AppCenterPanel onClose={() => {}} />) })
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  await act(async () => { element.click() })
}

/** 目录：一条冻结（本人发布）+ 一条正常。 */
const CATALOG = {
  apps: [
    {
      app_id: 'frozen-tool', title: '被冻结的工具', description: '值班排班', responsible: 'alice',
      access: 'login', enabled: false, frozen: true, current_version: '1.0.0', is_owner: true,
    },
    {
      app_id: 'live-tool', title: '正常工具', description: '', responsible: 'alice',
      access: 'login', enabled: true, frozen: false, current_version: '2.0.0', is_owner: true,
    },
  ],
}

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  setHostProofToken(null)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('R5-B-7 纯逻辑：冻结点位与解析（只认服务端的 frozen）', () => {
  it('路径与宿主路由逐字一致，两个方向共用同一个端点（后缀是 freeze）', () => {
    expect(SET_FROZEN_SUFFIX).toBe('freeze')
    expect(setFrozenPath('roster')).toBe('/api/pico/apps/wasm/roster/freeze')
    // app_id 是路径段：必须编码（与上下架同一条口径）。
    expect(setFrozenPath('a/b?c')).toBe('/api/pico/apps/wasm/a%2Fb%3Fc/freeze')
  })

  it('读服务端返回值（frozen / enabled / note），不回落成"我请求的那个值"', () => {
    const outcome = parseSetFrozenOutcome('frozen-tool', {
      app: { app_id: 'frozen-tool', frozen: false, changed: true, enabled: false, note: '解冻不会自动上架：请显式调用 publish' },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // 解冻成功**不等于**恢复服务：服务端的 enabled=false 必须原样带回来（R5-B-7 的
    // 文案与状态都靠它，客户端不复述"解冻后还要上架"之外的任何语义）。
    expect(outcome.frozen).toBe(false)
    expect(outcome.enabled).toBe(false)
    expect(outcome.changed).toBe(true)
    // 服务端原话逐字带回来（客户端不复述、也不替它承诺）。
    expect(outcome.note).toContain('不会自动上架')
    expect(Object.keys(outcome).sort()).toEqual(['appId', 'changed', 'enabled', 'frozen', 'note', 'ok'])
  })

  it('`app.frozen` 缺席 / 类型不对 / 回显串了 ⇒ 形状错误', () => {
    for (const payload of [{ app: { app_id: 'frozen-tool', changed: true } }, { app: { app_id: 'frozen-tool', frozen: 'true' } }, {}]) {
      const outcome = parseSetFrozenOutcome('frozen-tool', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
    expect(parseSetFrozenOutcome('frozen-tool', { app: { app_id: 'other', frozen: true } }).ok).toBe(false)
  })

  it('请求体恒为 {"frozen":<bool>}（服务端以 body 为准；空 body 等于冻结）', async () => {
    const seen: Array<{ url: string, init: RequestInit }> = []
    const fake = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} })
      return jsonResponse(200, { app: { app_id: 'frozen-tool', frozen: false, changed: true, enabled: false } })
    }) as unknown as typeof fetch
    const result = await setAppFrozen('frozen-tool', false, { fetch: fake })
    expect(result.ok).toBe(true)
    expect(seen[0]!.url).toBe('/api/pico/apps/wasm/frozen-tool/freeze')
    expect(seen[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ frozen: false })
  })

  it('传输失败被收成结构化失败（永不抛）', async () => {
    const result = await setAppFrozen('frozen-tool', true, {
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NETWORK_ERROR')
  })
})

describe('R5-B-7 面板：冻结态可见，解冻入口可达', () => {
  it('冻结行渲染「已冻结」+ 说明 + 解冻按钮，打开按钮禁用', async () => {
    stubFetch(() => jsonResponse(200, CATALOG))
    await mount()
    const frozen = container.querySelector('[data-role="app-frozen"]')
    expect(frozen, '冻结行必须有「已冻结」徽章').not.toBeNull()
    expect(frozen!.textContent).toBe('已冻结')
    // 说明要能回答"为什么打不开、下一步做什么"。
    expect(container.querySelector('[data-role="app-frozen-reason"]')?.textContent).toContain('解冻')
    // 冻结 = 停止服务：打开按钮必须禁用（点它只会得到一次注定失败的请求）。
    const open = container.querySelector<HTMLButtonElement>('.pico-app-center-open')
    expect(open?.disabled).toBe(true)
    // 发布者本人看得到解冻入口；正常行不是「解冻」而是「冻结」。
    expect(container.querySelector('[data-action="unfreeze"]')).not.toBeNull()
    expect(container.querySelector('[data-action="freeze"]')).not.toBeNull()
  })

  it('点「解冻」真的发 POST …/freeze {"frozen":false}，并按服务端回包更新行', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm/frozen-tool/freeze') {
        return jsonResponse(200, { app: { app_id: 'frozen-tool', frozen: false, changed: true, enabled: false, note: '解冻不会自动上架：请显式调用 publish' } })
      }
      return jsonResponse(200, CATALOG)
    })
    await mount()
    await click('[data-action="unfreeze"]')
    const posts = businessCalls().filter(call => call.url === '/api/pico/apps/wasm/frozen-tool/freeze')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ frozen: false })
    // 徽章跟着服务端的 frozen=false 消失（不是乐观更新：值来自响应体）。
    expect(container.querySelector('[data-role="app-frozen"]')).toBeNull()
    // 服务端的 note 原样进通知（"解冻不会自动上架"这条边界由服务端说）。
    const notice = container.querySelector('[data-role="catalog-notice"]')
    expect(notice?.textContent).toContain('应用已解冻')
    expect(notice?.querySelector('[data-role="notice-note"]')?.textContent).toContain('不会自动上架')
  })

  it('冻结是停服动作：先出确认块（此刻 0 请求），确认后才发 POST {"frozen":true}', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm/live-tool/freeze') {
        return jsonResponse(200, { app: { app_id: 'live-tool', frozen: true, changed: true, enabled: false } })
      }
      return jsonResponse(200, CATALOG)
    })
    await mount()
    await click('.pico-app-center-freeze')
    const strip = container.querySelector('[data-role="confirm-freeze"]')
    expect(strip, '冻结前必须有确认块（它会停服并顺带下架）').not.toBeNull()
    expect(strip!.textContent).toContain('停止服务')
    expect(businessCalls().filter(call => call.url.endsWith('/freeze'))).toHaveLength(0)
    await click('.pico-app-center-confirm-freeze')
    const posts = businessCalls().filter(call => call.url === '/api/pico/apps/wasm/live-tool/freeze')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ frozen: true })
    // 行**不消失**：冻结可逆，而唯一能解开它的是发布者本人（把行抹掉就收回了入口）。
    expect(container.textContent).toContain('正常工具')
    expect(container.querySelector('[data-role="catalog-notice"]')?.textContent).toContain('应用已冻结')
  })

  it('服务端说没冻结（changed:false）时行也不假装冻结 —— 只认回包', async () => {
    stubFetch((url) => {
      if (url === '/api/pico/apps/wasm/live-tool/freeze') {
        return jsonResponse(200, { app: { app_id: 'live-tool', frozen: false, changed: false, enabled: true } })
      }
      return jsonResponse(200, CATALOG)
    })
    await mount()
    await click('.pico-app-center-freeze')
    await click('.pico-app-center-confirm-freeze')
    expect(container.querySelectorAll('[data-role="app-frozen"]')).toHaveLength(1) // 只有目录里那条
  })
})

describe('R5-B-7 文案：同一句承诺只能有一个答案', () => {
  it('两条冻结 hint 都指向同一个可达路径（发布者 → 应用中心；其他人 → 管理员）', () => {
    for (const [label, hint] of [
      ['availabilityFrozenHint', zh['appCenter.availabilityFrozenHint']],
      ['openAppFrozenHint', zh['appCenter.openAppFrozenHint']],
    ] as const) {
      expect(hint, label).toContain('应用中心')
      expect(hint, label).toContain('管理员')
      // 接口契约句不是给员工看的动作：它此前是"承诺没有路"的原话。
      expect(hint, label).not.toContain('{"frozen":false}')
      expect(hint, label).not.toContain('同一端点')
    }
    // en:同一答案（App Center / administrator），不得退回"只有管理员"。
    for (const [label, hint] of [
      ['availabilityFrozenHint', en['appCenter.availabilityFrozenHint']],
      ['openAppFrozenHint', en['appCenter.openAppFrozenHint']],
    ] as const) {
      expect(hint, label).toContain('App Center')
      expect(hint, label).toContain('administrator')
      expect(hint, label).not.toContain('{"frozen":false}')
    }
  })

  it('徽章/按钮/通知的文案与解冻语义一致（解冻 != 恢复访问）', () => {
    expect(zh['appCenter.frozen']).toBe('已冻结')
    expect(zh['appCenter.unfreeze']).toBe('解冻')
    expect(zh['appCenter.frozenHint']).toContain('重新上架')
    expect(zh['appCenter.freezeConfirm']).toContain('停止服务')
    expect(en['appCenter.frozen']).toBe('Frozen')
    expect(en['appCenter.frozenHint']).toContain('bring it online again')
  })
})
