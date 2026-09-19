/**
 * 版本历史（`app-releases.ts`）的**纯逻辑**用例 —— R1-pm-3 的客户端半边。
 *
 * 界面级行为（点开"版本历史"→ 真取数 → 渲染理由与出路）在 `app-center-mount.spec.tsx`；
 * 这里只钉四条**契约**，因为它们各自都能被"看起来对"的实现骗过去：
 *
 *  1. **路径**：app_id 走 `encodeURIComponent`（它是路径段，不是可信输入），后缀
 *     `releases` 与宿主只读代理白名单、服务端 `GET …/:app_id/releases` 逐字一致；
 *  2. **被拒理由必须被读出来**：`reason` 是这次修复的全部意义 —— 解析里漏掉它，
 *     界面就会显示"管理员没有填写理由"（把"我们没读"说成"服务端没给"）；
 *  3. **形状漂移不回落空清单**：`releases` 缺席/类型不对/行全无 version ⇒ 结构化失败。
 *     回落空清单就是把"我们解析坏了"说成"你没有版本"（与目录页 P2-10 同族）；
 *  4. **未知状态原样保留**：服务端将来新增状态时，客户端不得把它翻译成一个已知状态。
 *
 * ---- 变异验证 ----
 *   - `releasesPath` 去掉 `encodeURIComponent` ⇒ 「app_id 是路径段」红；
 *   - `parseMyReleasesOutcome` 不读 `row.reason` ⇒ 「被拒理由」那条红；
 *   - `releases` 非数组时回落 `[]` ⇒ 「形状漂移」那条红（ok 变 true）；
 */
import { describe, expect, it } from 'vitest'
import {
  RELEASE_STATUSES,
  fetchMyReleases,
  parseMyReleasesOutcome,
  releasesPath,
} from './app-releases.ts'
import { setActiveLocale } from './locales.ts'

/** 服务端员工面 `GET …/:app_id/releases` 的真实形状（server/internal/wasmapp/api/read.go）。 */
const RELEASES_PAYLOAD = {
  app_id: 'roster',
  current_version: '1.0.0',
  review_required: true,
  releases: [
    { version: '1.0.0', status: 'approved', reason: '', created_at: '2026-09-18T10:00:00Z', current: true, checksum: 'aa', size: 8 },
    { version: '1.1.0', status: 'rejected', reason: '数据范围超出用途所需', created_at: '2026-09-19T10:00:00Z', current: false, checksum: '', size: 0 },
  ],
}

describe('本机路径：app_id 是路径段（必须编码），后缀与宿主/服务端逐字一致', () => {
  it('后缀是 releases（宿主只读代理白名单里有它，否则请求到不了服务端）', () => {
    expect(releasesPath('roster')).toBe('/api/pico/apps/wasm/roster/releases')
  })

  it('app_id 里的非安全字符被编码（不制造第二个路径段）', () => {
    const path = releasesPath('a/b?c#d')
    expect(path).toBe('/api/pico/apps/wasm/a%2Fb%3Fc%23d/releases')
    expect(path.split('/').at(-1)).toBe('releases')
  })
})

describe('解析：被拒理由必须一路读到界面', () => {
  it('读出每版的 version/status/reason/created_at/current/checksum/size 与头部字段', () => {
    const outcome = parseMyReleasesOutcome('roster', RELEASES_PAYLOAD)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.appId).toBe('roster')
    expect(outcome.currentVersion).toBe('1.0.0')
    expect(outcome.reviewRequired).toBe(true)
    expect(outcome.releases.map(row => row.version)).toEqual(['1.0.0', '1.1.0'])
    const rejected = outcome.releases[1]!
    expect(rejected.status).toBe('rejected')
    // **这条就是 R1-pm-3 的判据**：理由必须从响应体落到结构化结果里。
    expect(rejected.reason).toBe('数据范围超出用途所需')
    expect(rejected.current).toBe(false)
    expect(rejected.createdAt).toBe('2026-09-19T10:00:00Z')
    expect(outcome.releases[0]!.current).toBe(true)
    expect(outcome.releases[0]!.reason).toBe('')
  })

  it('未知状态原样保留（不翻译成已知状态）', () => {
    const outcome = parseMyReleasesOutcome('roster', {
      app_id: 'roster', current_version: '', review_required: false,
      releases: [{ version: '2.0.0', status: 'superseded', reason: '', created_at: '', current: false }],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.releases[0]!.status).toBe('superseded')
    expect(RELEASE_STATUSES).toEqual(['pending', 'approved', 'rejected'])
  })

  it('缺席字段回落成空/0，而不是编造（reason 例外：它是审核结论，见下一条）', () => {
    const outcome = parseMyReleasesOutcome('roster', { releases: [{ version: '1.0.0', reason: '' }] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.currentVersion).toBe('')
    expect(outcome.reviewRequired).toBe(false)
    expect(outcome.releases[0]).toEqual({ version: '1.0.0', status: '', reason: '', createdAt: '', current: false, checksum: '', size: 0 })
  })

  // F6（审计第二轮 A2-F6）：`reason` 键缺席/非字符串此前被 `asString()` 静默降级成空串，
  // 界面于是显示"管理员没有填写理由" —— 把"我们没读到"说成服务端的事实（模块头
  // 第二条纪律明令禁止）。这条钉住"缺席 reason ⇒ 形状错误"。
  it('reason 键缺席 / 非字符串 ⇒ 形状错误（绝不显示成"管理员没有填写理由"）', () => {
    for (const payload of [
      { releases: [{ version: '1.0.0', status: 'rejected' }] },
      { releases: [{ version: '1.0.0', status: 'rejected', reason: null }] },
      { releases: [{ version: '1.0.0', status: 'rejected', reason: 42 }] },
    ]) {
      const outcome = parseMyReleasesOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
    // 空串是**合法值**（rejected 且管理员真没写理由）—— 不能被上面那条误伤。
    const empty = parseMyReleasesOutcome('roster', { releases: [{ version: '1.0.0', status: 'rejected', reason: '' }] })
    expect(empty.ok).toBe(true)
  })
})

describe('形状漂移：不许把"解析不出来"显示成"你没有版本"', () => {
  it('releases 缺席 / 非数组 / 行里没有 version ⇒ 结构化失败（不是空清单）', () => {
    for (const payload of [
      {},
      { app_id: 'roster' },
      { releases: null },
      { releases: 'nope' },
      { releases: [{ status: 'rejected', reason: 'x' }] },
    ]) {
      const outcome = parseMyReleasesOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('**真正的空清单仍是成功**（"没有版本"与"解析不出来"必须能区分）', () => {
    const outcome = parseMyReleasesOutcome('roster', { app_id: 'roster', current_version: '', releases: [] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.releases).toEqual([])
  })

  // 审计第三轮 B 区 CONFIRMED（temp/audit-round3/B/cl-probe.log）：非对象元素此前被
  // `.filter()` 静默丢掉 ⇒ `releases:[null]` 与 `releases:[]` 同形（ok:true + 空清单），
  // 界面于是说"你没有版本"。逐元素形状门必须与 `reason` 键缺席同一口径。
  it('行元素不是对象（null/number/string/array）⇒ 形状错误，不得回落成空清单', () => {
    for (const payload of [
      { releases: [null], app_id: 'roster' },
      { releases: [1] },
      { releases: ['1.0.0'] },
      { releases: [['1.0.0']] },
      { releases: [{ version: '1.0.0', reason: '' }, null] },
    ]) {
      const outcome = parseMyReleasesOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code, JSON.stringify(payload)).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('行对象缺必需字段（version 不是字符串）⇒ 形状错误（不是"空行"）', () => {
    for (const payload of [
      { releases: [{}] },
      { releases: [{ reason: '' }] },
      { releases: [{ version: 1, reason: '' }] },
      { releases: [{ version: null, reason: '' }] },
    ]) {
      const outcome = parseMyReleasesOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code, JSON.stringify(payload)).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('对照组：形状正确的行（可选字段缺席）仍然成功 —— 门不许误伤', () => {
    const outcome = parseMyReleasesOutcome('roster', {
      app_id: 'roster',
      releases: [{ version: '1.0.0', reason: '', status: 'pending' }],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.releases).toHaveLength(1)
    expect(outcome.releases[0]!.version).toBe('1.0.0')
  })

  it('回显的 app_id 与请求不一致 ⇒ 形状错误（防止把别的应用的版本画到这一行）', () => {
    const outcome = parseMyReleasesOutcome('roster', { app_id: 'other', releases: [] })
    expect(outcome.ok).toBe(false)
  })
})

describe('请求：GET 一次，失败永不抛', () => {
  it('打本机路由且是 GET（只读面不制造写请求）', async () => {
    const seen: Array<{ url: string, init: RequestInit }> = []
    const result = await fetchMyReleases('roster', {
      fetch: (async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify(RELEASES_PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(seen[0]!.url).toBe('/api/pico/apps/wasm/roster/releases')
    expect(seen[0]!.init.method).toBe('GET')
    expect(seen[0]!.init.body).toBeUndefined()
  })

  it('传输层失败收成 NETWORK_ERROR（不抛穿调用方）', async () => {
    const result = await fetchMyReleases('roster', {
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NETWORK_ERROR')
    expect(result.transport).toBe(true)
  })

  it('404 原样透传服务端信封（非发布者只能看到"应用不存在"）', async () => {
    const result = await fetchMyReleases('roster', {
      fetch: (async () => new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: '应用不存在' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(404)
    expect(result.code).toBe('NOT_FOUND')
    expect(result.message).toBe('应用不存在')
  })
})

describe('i18n：形状错误文案跟随语言（不写死中文）', () => {
  it('en 下取英文字典', () => {
    setActiveLocale('en')
    try {
      const outcome = parseMyReleasesOutcome('roster', {})
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.message).not.toMatch(/[\u4E00-\u9FFF]/u)
      expect(outcome.message).toContain('version history')
    } finally {
      setActiveLocale('zh')
    }
  })
})
