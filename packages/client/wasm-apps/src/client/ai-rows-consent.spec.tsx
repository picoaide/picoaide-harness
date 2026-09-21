// @vitest-environment jsdom
/// <reference types="node" />
/**
 * 「**允许 AI 读取此应用的数据**」授权卡（`DataBrowserPanel.tsx` 的 `AiRowsConsentCard`）
 * 的行为判据 —— 2026-09-21 用户拍板："默认关 + 显式授权卡"。
 *
 * 为什么这些用例必须在**真挂载**上跑：这张卡的整个风险面在"状态从哪来、点下去之后
 * 界面信谁"上 ——
 *  - **宿主是真源**（授权落在 `$DSH_HOME/wasm-apps-ai-rows-consent.json`），面板若拿
 *    渲染层 `localStorage` 当真相，重开客户端后的开关就会与宿主实际闸门不一致；
 *  - **成功才切换**：宿主写失败时界面必须停在"未授权"，否则用户以为闸门开了，而
 *    `wasm_app_rows` 下一次调用仍然回 `AI_ROWS_NOT_AUTHORIZED`；
 *  - **只有发布者本人**看得到这张卡（`isOwner` 必填 prop）。
 *
 * 跨端契约（宿主 `wasm-apps.ts` ↔ 客户端 `app-lifecycle.ts`）由**读对方源码**的那条
 * 用例钉住：两处各写一份后缀字面量时，"面板 POST 的路径"与"宿主分发的路径"会静默错开，
 * 而两端的单测全绿（本仓已记录的同族失效模式）。
 *
 * ---- 变异验证（拆掉哪一处，哪条用例必红）----
 *   - 面板改回用 `localStorage` 当真相（不 GET 宿主）⇒「授权状态以宿主为准」两条红；
 *   - 写失败也把界面置为已允许（乐观更新）⇒「写失败不许假装已允许」红；
 *   - 卡片去掉 `isOwner` 判据 ⇒「非发布者看不到授权卡」红；
 *   - 客户端后缀改成别的字面量 ⇒「后缀与宿主逐字一致」红；
 *   - 收起状态也开始请求 ⇒「收起时零请求」红。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiRowsConsentPath, AI_ROWS_CONSENT_SUFFIX } from './app-lifecycle.ts'
import { DataBrowserPanel } from './DataBrowserPanel.tsx'
import { setActiveLocale, zh } from './locales.ts'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走五级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

const HOST_WASM_APPS_TS = 'packages/host/enterprise/src/wasm-apps.ts'

/** 一次被 stub 的 fetch 调用。 */
interface Call { url: string, method: string, body: string }

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let calls: Call[]

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const SCHEMA_OK = {
  schema: {
    app_id: 'roster',
    db: 'apps/roster/app.db',
    size_bytes: 4096,
    max_bytes: 104857600,
    table_count: 1,
    usage_percent: 0.1,
    tables: [{ name: 'notes', rows: 1, columns: [{ name: 'title', type: 'TEXT', pk: false }] }],
  },
}

const ROWS_OK = {
  rows: {
    app_id: 'roster',
    table: 'notes',
    columns: [{ name: 'title', type: 'TEXT', sensitive: false }],
    rows: [['hello']],
    limit: 50,
    offset: 0,
    returned: 1,
    total_rows: 1,
    has_more: false,
    truncated: false,
    truncated_values: 0,
    unmasked: false,
    masked_columns: [],
    value_max_bytes: 4096,
  },
}

/** 假传输层：授权路由由 `consent` 处理，其余（schema/rows）给固定成功响应。 */
function stubFetch(consent: (call: Call) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call: Call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' }
    calls.push(call)
    if (url.includes('/ai-rows-consent')) return consent(call)
    return url.endsWith('/schema') ? jsonResponse(200, SCHEMA_OK) : jsonResponse(200, ROWS_OK)
  }))
}

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(isOwner = true): Promise<void> {
  await act(async () => {
    root.render(<DataBrowserPanel appId="roster" isOwner={isOwner} />)
  })
}

async function click(selector: string): Promise<void> {
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`找不到元素 ${selector}`)
  await act(async () => { (el as HTMLElement).click() })
}

/** 展开数据面板（授权卡就在展开区里）。 */
async function open(): Promise<void> {
  await click('.pico-app-data-toggle')
}

const consentCalls = (): Call[] => calls.filter(call => call.url.includes('/ai-rows-consent'))

describe('授权卡只给发布者本人（默认关的能力不允许挂在"忘了传就可见"的开关上）', () => {
  it('非发布者：不渲染授权卡，也**不发**授权请求', async () => {
    stubFetch(() => jsonResponse(200, { app_id: 'roster', enabled: true }))
    await mount(false)
    await open()
    expect(container.querySelector('[data-role="ai-rows-consent"]')).toBeNull()
    expect(consentCalls()).toHaveLength(0)
    // 数据面本身照常工作（发布者以外的人在生产里看不到这个面板；这条只是证明
    // "卡片缺席"不是整块挂载失败）。
    expect(container.querySelector('[data-role="data-rows"]')).not.toBeNull()
  })

  it('发布者：展开后拿到宿主状态，未授权时给出**说清后果**的允许按钮', async () => {
    stubFetch(() => jsonResponse(200, { app_id: 'roster', enabled: false }))
    await mount()
    // 收起状态零请求（详情页是高频入口）。
    expect(calls).toHaveLength(0)
    await open()
    const card = container.querySelector('[data-role="ai-rows-consent"]')
    expect(card).not.toBeNull()
    expect(card?.getAttribute('data-enabled')).toBe('false')
    const allow = container.querySelector('.pico-app-data-ai-allow')
    expect(allow).not.toBeNull()
    // **逐字**要求：允许 = 同意"仅脱敏列 + 每次调用写审计"这一组后果。
    expect(allow?.textContent).toBe('允许 AI 读取此应用的数据（仅脱敏列，每次调用写审计）')
    expect(allow?.textContent).toBe(zh['appCenter.aiRowsAllow'])
    // 撤销按钮在未授权状态下不该出现（没有可撤销的东西）。
    expect(container.querySelector('.pico-app-data-ai-revoke')).toBeNull()
  })
})

describe('授权状态以**宿主**为准（面板不持真相）', () => {
  it('宿主说已允许 ⇒ 卡片显示已允许并给撤销按钮；请求打到宿主路由', async () => {
    stubFetch(() => jsonResponse(200, { app_id: 'roster', enabled: true }))
    await mount()
    await open()
    const card = container.querySelector('[data-role="ai-rows-consent"]')
    expect(card?.getAttribute('data-enabled')).toBe('true')
    expect(container.querySelector('[data-role="ai-rows-consent-copy"]')?.textContent)
      .toBe(zh['appCenter.aiRowsEnabled'])
    expect(container.querySelector('.pico-app-data-ai-revoke')).not.toBeNull()
    expect(container.querySelector('.pico-app-data-ai-allow')).toBeNull()
    expect(consentCalls()[0]?.url).toBe(`/api/pico/apps/wasm/roster/${AI_ROWS_CONSENT_SUFFIX}`)
    expect(consentCalls()[0]?.method).toBe('GET')
  })

  it('点「允许」⇒ POST {"enabled":true}，并以宿主回报的状态渲染', async () => {
    stubFetch(call => call.method === 'POST'
      ? jsonResponse(200, { app_id: 'roster', enabled: true })
      : jsonResponse(200, { app_id: 'roster', enabled: false }))
    await mount()
    await open()
    await click('.pico-app-data-ai-allow')
    const post = consentCalls().find(call => call.method === 'POST')
    expect(post?.url).toBe(aiRowsConsentPath('roster'))
    expect(JSON.parse(post!.body)).toEqual({ enabled: true })
    expect(container.querySelector('[data-role="ai-rows-consent"]')?.getAttribute('data-enabled')).toBe('true')
    // 授权卡的开关**不碰**数据面请求（它只改闸门，不该顺便再读一次库）。
    expect(calls.filter(call => call.url.includes('/rows'))).toHaveLength(1)
  })

  it('点「撤销」⇒ POST {"enabled":false}，卡片回到默认（未授权）', async () => {
    let enabled = true
    stubFetch(call => {
      if (call.method === 'POST') enabled = (JSON.parse(call.body) as { enabled: boolean }).enabled
      return jsonResponse(200, { app_id: 'roster', enabled })
    })
    await mount()
    await open()
    expect(container.querySelector('[data-role="ai-rows-consent"]')?.getAttribute('data-enabled')).toBe('true')
    await click('.pico-app-data-ai-revoke')
    const post = consentCalls().find(call => call.method === 'POST')
    expect(JSON.parse(post!.body)).toEqual({ enabled: false })
    expect(container.querySelector('[data-role="ai-rows-consent"]')?.getAttribute('data-enabled')).toBe('false')
    expect(container.querySelector('.pico-app-data-ai-allow')).not.toBeNull()
  })

  it('写失败 ⇒ **不许**假装已允许：状态停在未授权，并如实说明"没有保存成功"', async () => {
    stubFetch(call => call.method === 'POST'
      ? jsonResponse(500, { error: { code: 'AI_ROWS_CONSENT_NOT_PERSISTED', message: '授权未能保存' } })
      : jsonResponse(200, { app_id: 'roster', enabled: false }))
    await mount()
    await open()
    await click('.pico-app-data-ai-allow')
    expect(container.querySelector('[data-role="ai-rows-consent"]')?.getAttribute('data-enabled')).toBe('false')
    const error = container.querySelector('[data-role="ai-rows-consent-save-error"]')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('AI_ROWS_CONSENT_NOT_PERSISTED')
    // 允许按钮还在（用户可以重试），撤销按钮**不**出现（什么都没被允许）。
    expect(container.querySelector('.pico-app-data-ai-allow')).not.toBeNull()
    expect(container.querySelector('.pico-app-data-ai-revoke')).toBeNull()
  })

  it('读状态失败 ⇒ 不把"不知道"画成"未授权"：给出错误块与重试，且不声称任何状态', async () => {
    stubFetch(() => jsonResponse(503, { error: { code: 'PROOF_REQUIRED', message: '需要持有性证明' } }))
    await mount()
    await open()
    expect(container.querySelector('[data-role="ai-rows-consent-error"]')).not.toBeNull()
    expect(container.querySelector('[data-role="ai-rows-consent-error"]')?.textContent).toContain('PROOF_REQUIRED')
    // 读不到状态时**没有任何**状态声明：既不说"已允许"，也不发一条盲写。
    expect(container.querySelector('[data-role="ai-rows-consent"]')?.getAttribute('data-enabled')).toBe('false')
    expect(container.querySelector('.pico-app-data-ai-revoke')).toBeNull()
    expect(container.querySelector('.pico-app-data-ai-allow')).toBeNull()
    expect(container.querySelector('.pico-app-data-ai-retry')).not.toBeNull()
    expect(consentCalls().filter(call => call.method === 'POST')).toHaveLength(0)
  })
})

describe('跨端契约：客户端后缀 ↔ 宿主路由（读对方源码对拍）', () => {
  it('客户端 AI_ROWS_CONSENT_SUFFIX 与宿主 wasm-apps.ts 的字面量逐字一致', () => {
    // 两端各有一份字面量（客户端不 import 宿主包）：只改一边会让面板 POST 一条
    // 宿主不认识的路径（404），而两边各自的用例都绿。判据 = 读宿主源码取值比较。
    const host = readFileSync(join(REPO_ROOT, HOST_WASM_APPS_TS), 'utf8')
    const match = /export const AI_ROWS_CONSENT_SUFFIX\s*=\s*'([^']*)'/u.exec(host)
    expect(match, `${HOST_WASM_APPS_TS} 里找不到 AI_ROWS_CONSENT_SUFFIX（改名或删掉都会让本判据失效）`).not.toBeNull()
    expect(AI_ROWS_CONSENT_SUFFIX).toBe(match![1])
    expect(AI_ROWS_CONSENT_SUFFIX).toBe('ai-rows-consent')
  })
})
