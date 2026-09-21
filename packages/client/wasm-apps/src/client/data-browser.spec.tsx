// @vitest-environment jsdom
/**
 * 作者数据面板（`DataBrowserPanel.tsx`）的行为判据。
 *
 * 为什么真挂载：面板的全部风险都在"取数与状态机"上（展开才取数、失败不回落成空表、
 * 脱敏要重新请求服务端而不是本地替换），而这些只有让 `useEffect` 真的跑起来才验得到。
 * 取数走**注入的 fetch**（与生产同一条 `app-lifecycle` 编排，只是换掉传输层）。
 *
 * ---- 变异验证（实跑过） ----
 *   - 去掉"展开才取数"的条件（挂载即请求）⇒ 第一条用例红；
 *   - schema 失败分支渲染成 `dataEmpty` ⇒ 「失败不回落成空表」红；
 *   - 脱敏改成客户端把值替换成 `***`（不再请求 unmask=1）⇒ 「unmask 真的重新请求」红；
 *   - `hasMore`/`offset` 不接线 ⇒ 翻页用例红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataBrowserPanel } from './DataBrowserPanel.tsx'
import { setActiveLocale } from './locales.ts'

/** 一次被 stub 的 fetch 调用（URL + 方法，便于断言"发的是哪条路由"）。 */
interface Call { url: string, method: string }

// `act(...)` 需要这个全局标志（与同目录另外三个挂载用例一致）：没有它 React 会打印
// "The current testing environment is not configured to support act(...)"，而且状态更新
// 不会被同步刷新 —— 断言会变成"看运气"。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let calls: Call[]

/** 构造一个 JSON 响应（面板只读 `status` + JSON 体）。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 按 URL 分派的假传输层：schema 与 rows 各自给一份响应。 */
function stubFetch(handler: (url: string) => Response): void {
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, method: init?.method ?? 'GET' })
    // 「AI 读取数据」的授权状态默认答"未授权"：本文件的用例全是**数据面**的行为
    //（展开才取数、脱敏、失败不回落），授权卡自己的行为判据在 `ai-rows-consent.spec.tsx`。
    // 不答这一条会让面板渲染一块"拿不到授权状态"的错误 —— 那会污染这里的所有断言。
    if (url.endsWith('/ai-rows-consent')) return jsonResponse(200, { app_id: 'roster', enabled: false })
    return handler(url)
  })
  vi.stubGlobal('fetch', fake)
}

const SCHEMA_OK = {
  schema: {
    app_id: 'roster',
    db: 'apps/roster/app.db',
    size_bytes: 4096,
    max_bytes: 104857600,
    table_count: 2,
    usage_percent: 0.1,
    tables: [
      { name: 'notes', rows: 3, columns: [{ name: 'title', type: 'TEXT', pk: false }] },
      { name: 'tags', rows: 0, columns: [{ name: 'label', type: 'TEXT', pk: false }] },
    ],
  },
}

const ROWS_MASKED = {
  rows: {
    app_id: 'roster',
    table: 'notes',
    columns: [
      { name: 'title', type: 'TEXT', sensitive: false },
      { name: 'api_token', type: 'TEXT', sensitive: true },
    ],
    rows: [['hello', '***'], ['world', '***']],
    limit: 50,
    offset: 0,
    returned: 2,
    total_rows: 3,
    has_more: true,
    truncated: false,
    truncated_values: 0,
    unmasked: false,
    masked_columns: ['api_token'],
    value_max_bytes: 4096,
  },
}

const ROWS_UNMASKED = {
  rows: {
    ...ROWS_MASKED.rows,
    rows: [['hello', 'secret-a'], ['world', 'secret-b']],
    unmasked: true,
    masked_columns: [],
  },
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

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<DataBrowserPanel appId="roster" isOwner />)
  })
}

async function click(selector: string): Promise<void> {
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`找不到元素 ${selector}`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

describe('展开才取数（详情页是高频入口，收起状态必须零请求）', () => {
  it('挂载后不请求；点「查看数据」才读授权状态 + GET schema 与首张表的 rows', async () => {
    stubFetch(url => url.endsWith('/schema') ? jsonResponse(200, SCHEMA_OK) : jsonResponse(200, ROWS_MASKED))
    await mount()
    expect(calls).toHaveLength(0)

    await click('.pico-app-data-toggle')
    // 第一条是**授权状态**（AI 读取默认关；面板必须从宿主读真相，不能拿 localStorage 当真相），
    // 然后才是 schema 与首张表的 rows。顺序由 effect 声明顺序固定（用例钉住）。
    expect(calls.map(call => new URL(call.url, 'http://x').pathname)).toEqual([
      '/api/pico/apps/wasm/roster/ai-rows-consent',
      '/api/pico/apps/wasm/roster/schema',
      '/api/pico/apps/wasm/roster/rows',
    ])
    // 首张表自动选中（作者点开就能看到数据，不需要再点一次）。
    expect(container.querySelector('[data-role="data-rows"]')).not.toBeNull()
    expect(container.textContent).toContain('notes')
    expect(container.textContent).toContain('hello')
  })
})

describe('默认脱敏：原值必须由服务端给（客户端不自己替换）', () => {
  it('敏感列显示 *** 并标注；点「显示原值」会带 unmask=1 重新请求', async () => {
    stubFetch(url => {
      if (url.endsWith('/schema')) return jsonResponse(200, SCHEMA_OK)
      return url.includes('unmask=1') ? jsonResponse(200, ROWS_UNMASKED) : jsonResponse(200, ROWS_MASKED)
    })
    await mount()
    await click('.pico-app-data-toggle')

    // ① 默认：脱敏值来自服务端，且列头标了敏感。
    expect(container.textContent).toContain('***')
    expect(container.textContent).not.toContain('secret-a')
    expect(container.querySelector('[data-column="api_token"]')?.getAttribute('data-sensitive')).toBe('true')
    expect(container.querySelector('[data-role="data-masked-note"]')).not.toBeNull()

    // ② 点「显示原值」：**确实重新请求**（不是客户端把 *** 换掉）。
    await click('.pico-app-data-unmask')
    const last = calls.at(-1)
    expect(last?.url).toContain('unmask=1')
    expect(container.textContent).toContain('secret-a')
    // ③ 恢复脱敏按钮出现（否则作者无法回到默认态）。
    expect(container.querySelector('.pico-app-data-remask')).not.toBeNull()
  })
})

describe('失败原样呈现（绝不回落成"空表/0 行"）', () => {
  it('schema 500 ⇒ 渲染错误码与建议，而不是"这个应用还没有数据库"', async () => {
    stubFetch(() => jsonResponse(500, { error: { code: 'INTERNAL', message: '应用库不可用', hints: ['稍后重试'] } }))
    await mount()
    await click('.pico-app-data-toggle')
    const block = container.querySelector('[data-role="data-schema-error"]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('INTERNAL')
    expect(block?.textContent).toContain('稍后重试')
    expect(container.querySelector('[data-role="data-empty"]')).toBeNull()
  })

  it('rows 404（表不存在）⇒ 渲染错误，而不是"这张表还是空的"', async () => {
    stubFetch(url => url.endsWith('/schema')
      ? jsonResponse(200, SCHEMA_OK)
      : jsonResponse(404, { error: { code: 'NOT_FOUND', message: '应用不存在', hints: ['检查表名'] } }))
    await mount()
    await click('.pico-app-data-toggle')
    expect(container.querySelector('[data-role="data-rows-error"]')).not.toBeNull()
    expect(container.querySelector('[data-role="data-no-rows"]')).toBeNull()
  })

  it('真的空表 ⇒ 空态文案（与服务端"表存在但 0 行"对应）', async () => {
    stubFetch(url => url.endsWith('/schema')
      ? jsonResponse(200, SCHEMA_OK)
      : jsonResponse(200, { rows: { ...ROWS_MASKED.rows, rows: [], returned: 0, total_rows: 0, has_more: false, masked_columns: [] } }))
    await mount()
    await click('.pico-app-data-toggle')
    expect(container.querySelector('[data-role="data-no-rows"]')).not.toBeNull()
  })

  it('没有表 ⇒ 说明"应用还没建过表"，而不是空白面板', async () => {
    stubFetch(() => jsonResponse(200, { schema: { ...SCHEMA_OK.schema, tables: [], table_count: 0 } }))
    await mount()
    await click('.pico-app-data-toggle')
    expect(container.querySelector('[data-role="data-empty"]')).not.toBeNull()
    // 没有表就不该发 rows 请求（查一张不存在的表只会拿 404）。
    expect(calls.filter(call => call.url.includes('/rows'))).toHaveLength(0)
  })
})

describe('分页与截断提示', () => {
  it('has_more ⇒ 下一页可用；点击后 offset 前进一页', async () => {
    stubFetch(url => {
      if (url.endsWith('/schema')) return jsonResponse(200, SCHEMA_OK)
      const offset = new URL(url, 'http://x').searchParams.get('offset')
      return jsonResponse(200, { rows: { ...ROWS_MASKED.rows, offset: Number(offset ?? '0') } })
    })
    await mount()
    await click('.pico-app-data-toggle')
    const next = container.querySelector('.pico-app-data-next') as HTMLButtonElement | null
    expect(next?.disabled).toBe(false)
    await click('.pico-app-data-next')
    expect(calls.at(-1)?.url).toContain('offset=50')
  })

  it('单值被截断时给出提示（truncated_values > 0）', async () => {
    stubFetch(url => url.endsWith('/schema')
      ? jsonResponse(200, SCHEMA_OK)
      : jsonResponse(200, { rows: { ...ROWS_MASKED.rows, truncated_values: 2 } }))
    await mount()
    await click('.pico-app-data-toggle')
    expect(container.querySelector('[data-role="data-truncated-note"]')).not.toBeNull()
  })
})

describe('迟到响应不得覆盖新状态（2026-09-21 审计 P2-3）', () => {
  it('先发后到的 rows 响应被丢弃：界面显示的始终是**最后选中**的那张表', async () => {
    // 手工控制 resolve 顺序的传输层：第 1 次 rows（notes）晚于第 2 次（tags）返回。
    const pending: Array<() => void> = []
    let rowsCalls = 0
    stubFetch(url => {
      if (url.endsWith('/schema')) return jsonResponse(200, SCHEMA_OK)
      // 授权状态不是这条用例的对象：立刻答掉，免得占住下面手工排队的队列。
      if (url.endsWith('/ai-rows-consent')) return jsonResponse(200, { app_id: 'roster', enabled: false })
      rowsCalls += 1
      return jsonResponse(200, {
        rows: {
          ...ROWS_MASKED.rows,
          table: new URL(url, 'http://x').searchParams.get('table') ?? 'notes',
          rows: [[`来自 ${new URL(url, 'http://x').searchParams.get('table') ?? ''}`, '***']],
        },
      })
    })
    // 用一层包装把"响应到达"变成可控：把假 fetch 的 promise 排队。
    const realFetch = globalThis.fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/schema') || url.endsWith('/ai-rows-consent')) return await realFetch(input, init)
      const response = await realFetch(input, init)
      await new Promise<void>(resolve => { pending.push(resolve) })
      return response
    }))

    await mount()
    await click('.pico-app-data-toggle')          // 展开 ⇒ schema 到货 + **notes 的 rows 请求在飞**（未放行）
    // 在 notes 还没回来时切到 tags（表按钮来自 schema，与 rows 状态无关 ⇒ 可点）。
    await click('.pico-app-data-table[data-table="tags"]')
    // 先放行**后发**的 tags，再放行**先发**的 notes：没有序号守卫时后者会覆盖前者。
    const last = pending.pop()
    last?.()
    await act(async () => { await Promise.resolve() })
    const first = pending.shift()
    first?.()
    await act(async () => { await Promise.resolve() })

    expect(rowsCalls).toBeGreaterThanOrEqual(2)
    expect(container.textContent).toContain('来自 tags')
    expect(container.textContent).not.toContain('来自 notes')
  })
})
