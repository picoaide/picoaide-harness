/**
 * 作者生命周期编排的**纯逻辑**用例（`app-lifecycle.ts`）。
 *
 * 行为级用例在 `app-center-mount.spec.tsx`（真挂载 + 真 fetch 假响应）；这里只钉三件
 * 纯函数层的事，因为它们各自是一条**契约**，而不是某个界面的细节：
 *
 *  1. **路径**：app_id 走 `encodeURIComponent`（它是路径段，不是可信输入），后缀与宿主
 *     路由逐字一致（宿主：`packages/host/enterprise/src/wasm-apps.ts` 的 prefix handler；
 *     服务端：`server/internal/wasmapp/api/release.go` 的 `publishTarget` **以后缀为准**）；
 *  2. **只有服务端说了才算**：`app.enabled` / `app.deleted` 缺席或类型不对 ⇒ 结构化失败，
 *     **绝不**回落成"我请求的那个值"（那就是乐观更新，本模块存在的理由就是防它）；
 *  3. **失败不抛**：传输层/信封/非 JSON 一律回落成 `PublishFailure`。
 *
 * ---- 变异验证 ----
 *   - `parseSetPublishedOutcome` 里 `enabled` 缺席时回落成 `true`（或直接返回请求值）⇒
 *     「缺席即形状错误」红；
 *   - `parseDeleteOutcome` 不查 `deleted` ⇒ 「未确认 deleted 即失败」红；
 *   - `setPublishedPath` 去掉 `encodeURIComponent` ⇒ 路径编码那条红。
 */
import { describe, expect, it } from 'vitest'
import {
  deleteApp,
  deletePath,
  diagnosticsPath,
  fetchDiagnostics,
  parseDeleteOutcome,
  parseDiagnosticsOutcome,
  parseSetPublishedOutcome,
  setAppPublished,
  setPublishedPath,
} from './app-lifecycle.ts'

describe('本机路径：app_id 是路径段（必须编码），后缀与服务端判据一致', () => {
  it('上下架路径的后缀是 publish / unpublish（服务端 publishTarget 只认后缀）', () => {
    expect(setPublishedPath('roster', true)).toBe('/api/pico/apps/wasm/roster/publish')
    expect(setPublishedPath('roster', false)).toBe('/api/pico/apps/wasm/roster/unpublish')
    expect(deletePath('roster')).toBe('/api/pico/apps/wasm/roster')
    expect(diagnosticsPath('roster')).toBe('/api/pico/apps/wasm/roster/diagnostics')
  })

  it('app_id 里的非安全字符被编码（不制造第二个路径段）', () => {
    // 服务端的 app_id 形态本就只允许 [a-z0-9-]，但客户端不能依赖这一点：
    // 一个含 `/` 或 `?` 的值必须变成一个路径段，而不是改变路由。
    const path = setPublishedPath('a/b?c#d', false)
    expect(path).toBe('/api/pico/apps/wasm/a%2Fb%3Fc%23d/unpublish')
    expect(path.split('/').at(-1)).toBe('unpublish')
  })
})

describe('上下架：行状态只能来自服务端的 app.enabled', () => {
  it('读服务端返回值（不是请求值）', () => {
    const outcome = parseSetPublishedOutcome('roster', {
      app: { app_id: 'roster', enabled: false, changed: true },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.enabled).toBe(false)
    expect(outcome.changed).toBe(true)
  })

  it('`app.enabled` 缺席 / 类型不对 ⇒ 形状错误（不回落成"我请求的值"）', () => {
    for (const payload of [{ app: { app_id: 'roster', changed: true } }, { app: { app_id: 'roster', enabled: 'false' } }, {}]) {
      const outcome = parseSetPublishedOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('回显的 app_id 与请求不一致 ⇒ 形状错误（防止把别的应用的状态画到这一行）', () => {
    const outcome = parseSetPublishedOutcome('roster', { app: { app_id: 'other', enabled: true, changed: true } })
    expect(outcome.ok).toBe(false)
  })

  it('请求失败时抛出的异常被收成结构化失败（永不抛）', async () => {
    const result = await setAppPublished('roster', false, {
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NETWORK_ERROR')
    expect(result.transport).toBe(true)
  })

  it('请求本身不带 body（服务端以后缀判定，不给它第二条判据）', async () => {
    const seen: Array<{ url: string, init: RequestInit }> = []
    const result = await setAppPublished('roster', false, {
      fetch: (async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({ app: { app_id: 'roster', enabled: false, changed: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(seen[0]!.url).toBe('/api/pico/apps/wasm/roster/unpublish')
    expect(seen[0]!.init.method).toBe('POST')
    expect(seen[0]!.init.body).toBeUndefined()
  })
})

describe('删除：只有服务端确认 deleted 才算删掉', () => {
  it('读保留期与服务端说明（没给就是 undefined，不编造 90）', () => {
    const outcome = parseDeleteOutcome('roster', {
      app: { app_id: 'roster', deleted: true },
      retention_days: 90,
      note: '“真删”由后台任务执行（当前未实现）',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.deleted).toBe(true)
    expect(outcome.retentionDays).toBe(90)
    expect(outcome.note).toContain('后台任务')

    const bare = parseDeleteOutcome('roster', { app: { app_id: 'roster', deleted: true } })
    expect(bare.ok).toBe(true)
    if (!bare.ok) throw new Error('unreachable')
    expect(bare.retentionDays).toBeUndefined()
    expect(bare.note).toBe('')
  })

  it('没有 deleted:true ⇒ 形状错误（行不许消失）', () => {
    for (const payload of [{ app: { app_id: 'roster' } }, { app: { deleted: false } }, {}]) {
      const outcome = parseDeleteOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
    }
  })

  it('DELETE 方法走到位（服务端软删的唯一动词）', async () => {
    const seen: RequestInit[] = []
    await deleteApp('roster', {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init ?? {})
        return new Response(JSON.stringify({ app: { app_id: 'roster', deleted: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    expect(seen[0]!.method).toBe('DELETE')
  })
})

describe('诊断：只读投影（reason_code / hints / 计数）', () => {
  const REPORT = {
    diagnostics: {
      app_id: 'roster',
      app_enabled: false,
      app_frozen: false,
      app_deleted: false,
      window_minutes: 1440,
      summary: { total: 12, failed: 3 },
      failures: [
        { created_at: '2026-09-19T01:00:00Z', outcome: 'error', reason_code: 'COMPILE_TIMEOUT', guest_exit_code: 1, stderr_tail: 'x' },
        { created_at: '2026-09-19T02:00:00Z', outcome: 'killed', reason_code: 'MEMORY_LIMIT', guest_exit_code: 137 },
      ],
      hints: ['把单次处理拆小', '把单次处理拆小', ''],
    },
  }

  it('映射服务端字段（计数、reason_code、hints 去空）', () => {
    const report = parseDiagnosticsOutcome('roster', REPORT)
    expect(report.ok).toBe(true)
    if (!report.ok) throw new Error('unreachable')
    expect(report.enabled).toBe(false)
    expect(report.windowMinutes).toBe(1440)
    expect(report.total).toBe(12)
    expect(report.failed).toBe(3)
    expect(report.failures.map(row => row.reasonCode)).toEqual(['COMPILE_TIMEOUT', 'MEMORY_LIMIT'])
    expect(report.failures[0]!.guestExitCode).toBe(1)
    expect(report.hints).toEqual(['把单次处理拆小', '把单次处理拆小'])
  })

  it('缺字段回落成空/0（不编造"没有失败"以外的结论，也不抛）', () => {
    const report = parseDiagnosticsOutcome('roster', { diagnostics: { app_id: 'roster' } })
    expect(report.ok).toBe(true)
    if (!report.ok) throw new Error('unreachable')
    expect(report.failures).toEqual([])
    expect(report.hints).toEqual([])
    expect(report.total).toBe(0)
    expect(report.failed).toBe(0)
  })

  it('没有 diagnostics 信封 ⇒ 形状错误（不把 404 页面渲染成"0 失败"）', () => {
    for (const payload of [{}, { diagnostics: {} }, null]) {
      const outcome = parseDiagnosticsOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
    }
  })

  it('服务端拒绝时信封原样带出（code/message/hints 不丢）', async () => {
    const result = await fetchDiagnostics('roster', {
      fetch: (async () => new Response(JSON.stringify({
        error: { code: 'NOT_FOUND', message: '应用不存在', hints: ['只有发布者本人能管理该应用'] },
      }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NOT_FOUND')
    expect(result.message).toBe('应用不存在')
    expect(result.hints).toEqual(['只有发布者本人能管理该应用'])
  })
})
