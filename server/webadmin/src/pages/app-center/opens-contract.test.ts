import { describe, expect, it } from 'vitest'
import {
  AI_ATTRIBUTION_NOTE,
  OPENS_DETAIL_RETENTION_DAYS,
  OPENS_PRIVACY_NOTE,
  OPENS_RETENTION_NOTE,
  OPENS_SUMMARY_PATH,
  aiUsageIsEmpty,
  aiUsagePath,
  classifyEndpointFailure,
  countText,
  daySeries,
  detailTotals,
  opensDetailPath,
  rankTopApps,
  requireAiUsage,
  requireOpensDetail,
  requireOpensSummary,
  shapeDrift,
  sumOpenPv,
  summarizeWindow,
  tokensText,
  trendValues,
  windowUv,
  type OpensPoint,
} from './opens-contract'

// ---------------------------------------------------------------------------
// F16 / §21.4 的**聚合与降级口径**（2026-09-19，L6）。
//
// 这组用例是三条硬要求的机器判据：
//   ① PV **不去重**：每次打开 +1 ⇒ 逐日相加就是窗口总次数（去重即红）；
//   ② UV **按用户去重**：只能信服务端按窗口去重的值，逐日相加会把同一个人
//      重复计数 ⇒ 本地求和即红；
//   ③ **缺后端不得显示 0**：404 / 形状漂移必须分类成"接口尚不可用"并显示 `—`。
// 每条用例的变异点写在注释里。
// ---------------------------------------------------------------------------

/** 逐日点：PV 之和 6，UV 之和 5 —— 两个数刻意不同，让"相加 vs 去重"无法混淆。 */
const POINTS: OpensPoint[] = [
  { day: '2026-09-17', pv: 1, uv: 1 },
  { day: '2026-09-18', pv: 2, uv: 2 },
  { day: '2026-09-19', pv: 3, uv: 2 },
]

describe('打开次数 · PV 不去重', () => {
  it('sumOpenPv 把每次打开相加（不去重、不取最大、不数天数）', () => {
    // 变异验证：改成 points.length（=3）或 max(pv)（=3）⇒ 本用例必红。
    expect(sumOpenPv(POINTS)).toBe(6)
    // 同一天内同一个人的多次打开会各占一次 PV（这正是"不去重"的含义）。
    expect(sumOpenPv([{ day: '2026-09-19', pv: 5, uv: 1 }])).toBe(5)
    // 空窗口 = 确实没有打开（0 是真值）；**没有数组** = 读不到（null ⇒ 界面 —）。
    expect(sumOpenPv([])).toBe(0)
    expect(sumOpenPv(null)).toBeNull()
  })

  it('sumOpenPv：任一点缺 pv ⇒ null（不把缺字段当 0 少算，CTL-11）', () => {
    // 变异验证：把 `const pv = numOrNull(p?.pv); if (pv === null) return null`
    // 改回 `num(p?.pv)`（缺失当 0）⇒ 本用例必红（会得到 2 而不是 null）。
    // 语义：服务端 200 却少下发字段 = 形状漂移，必须显示 — 让管理员看见，
    // 而不是悄悄少算成一个看起来正常的数字。
    expect(sumOpenPv([{ pv: 2, uv: 1 }, { pv: Number.NaN, uv: 0 }])).toBeNull()
    expect(sumOpenPv([{ pv: 2, uv: 1 }, {} as never])).toBeNull()
    // 全部有值时才是数字。
    expect(sumOpenPv([{ pv: 2, uv: 1 }, { pv: 1, uv: 1 }])).toBe(3)
  })

  it('summarizeWindow：服务端给了 totals 就用它，缺 totals 时 PV 仍可按日累加', () => {
    const withTotals = summarizeWindow({ totals: { pv: 9, uv: 4 }, trend: POINTS })
    expect(withTotals.pv).toBe(9)
    const noTotals = summarizeWindow({ trend: POINTS })
    // PV 不去重 ⇒ 逐日相加是合法回退（6）。
    expect(noTotals.pv).toBe(6)
  })
})

describe('打开次数 · UV 由服务端按窗口去重', () => {
  it('windowUv 优先取服务端窗口值（不等于逐日 UV 之和）', () => {
    // 逐日 UV 之和 = 5；服务端窗口去重值 = 3（同一个人三天都打开过）。
    // 变异验证：改成 Σ points.uv ⇒ 会得到 5，本用例必红。
    expect(windowUv(POINTS, 3)).toEqual({ uv: 3, note: '' })
    expect(summarizeWindow({ totals: { pv: 6, uv: 3 }, trend: POINTS }).uv).toBe(3)
  })

  it('服务端没给窗口 UV ⇒ null + 说明（**拒绝**本地求和）', () => {
    // 变异验证：把 `return { uv: null ... }` 改成返回逐日之和 ⇒ 第一条断言红。
    const r = windowUv(POINTS, undefined)
    expect(r.uv).toBeNull()
    expect(r.note).toContain('逐日 UV 相加')
    expect(summarizeWindow({ trend: POINTS }).uv).toBeNull()
    expect(summarizeWindow({ trend: POINTS }).uvNote).not.toBe('')
    // 没有点（窗口内确实没有数据）时不必附这段技术说明。
    expect(windowUv([], undefined)).toEqual({ uv: null, note: '' })
  })

  it('countText：null/NaN 显示 — （不是 0）', () => {
    expect(countText(null)).toBe('—')
    expect(countText(undefined)).toBe('—')
    expect(countText(Number.NaN)).toBe('—')
    expect(countText(0)).toBe('0')
    expect(countText(1234)).toBe('1,234')
  })
})

describe('热门应用 TOP N · 排序与截断', () => {
  const rows = [
    { app_id: 'c', title: 'C', pv: 5, uv: 1 },
    { app_id: 'a', title: 'A', pv: 9, uv: 2 },
    { app_id: 'd', title: 'D', pv: 5, uv: 4 },
    { app_id: 'b', title: 'B', pv: 9, uv: 5 },
  ]

  it('按 pv 降序 → uv 降序 → app_id 升序排名，并截断到 limit', () => {
    // 变异验证：去掉 sort（原样输出）或去掉 slice（返回 4 行）⇒ 必红。
    const top = rankTopApps(rows, 3)
    expect(top.map((r) => r.app_id)).toEqual(['b', 'a', 'd'])
    expect(top.map((r) => r.rank)).toEqual([1, 2, 3])
    expect(top).toHaveLength(3)
  })

  it('limit 非法/为 0 ⇒ 空数组；缺 title 回落 app_id；脏行被过滤', () => {
    expect(rankTopApps(rows, 0)).toEqual([])
    expect(rankTopApps(rows, Number.NaN)).toEqual([])
    expect(rankTopApps(null, 10)).toEqual([])
    const cleaned = rankTopApps(
      [{ app_id: 'x', pv: 1, uv: 1 }, { app_id: '', pv: 9, uv: 9 }, null as never],
      10,
    )
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]!.title).toBe('x')
  })
})

describe('AI 用量 · 空状态（§21.4 无归因 ≠ 0 次）', () => {
  it('全 0 且没有按日点 ⇒ 空（面板渲染空状态而不是 0 次 / ¥0.00）', () => {
    // 变异验证：把 aiUsageIsEmpty 改成恒 false ⇒ 本用例必红（面板会渲染 0）。
    expect(aiUsageIsEmpty({ calls: 0, cost: 0, total_tokens: 0, points: [] })).toBe(true)
    expect(aiUsageIsEmpty(null)).toBe(true)
    // 有按日点但统计字段缺省，也不算空（服务端给了明细就说明有归因数据）。
    expect(aiUsageIsEmpty({ points: [{ day: '2026-09-19', calls: 1, tokens: 10, cost: 0.1 }] })).toBe(false)
  })

  it('任意一项非 0 ⇒ 不是空状态', () => {
    expect(aiUsageIsEmpty({ calls: 3, cost: 0, total_tokens: 0, points: [] })).toBe(false)
    expect(aiUsageIsEmpty({ calls: 0, cost: 0.5, total_tokens: 0, points: [] })).toBe(false)
    expect(aiUsageIsEmpty({ calls: 0, cost: 0, total_tokens: 900, points: [] })).toBe(false)
  })

  it('归因说明写清"账单归使用者账号 / 老客户端无归因"', () => {
    expect(AI_ATTRIBUTION_NOTE).toContain('X-Pico-App-Id')
    expect(AI_ATTRIBUTION_NOTE).toContain('计费')
    expect(AI_ATTRIBUTION_NOTE).toContain('老客户端')
  })
})

describe('降级分类 · 缺后端不得显示 0', () => {
  it('404 ⇒ missing，说明里点名端点且写明"显示 — 而不是 0"', () => {
    const f = classifyEndpointFailure({ status: 404, code: 'NOT_FOUND', message: '请求的资源不存在' }, '打开次数', OPENS_SUMMARY_PATH)
    expect(f.kind).toBe('missing')
    expect(f.text).toContain(OPENS_SUMMARY_PATH)
    expect(f.text).toContain('尚未提供')
    expect(f.text).toContain('不是 0')
  })

  it('403/401/其它各自分类（权限与登录问题不能混成"没有数据"）', () => {
    expect(classifyEndpointFailure({ status: 403 }, '打开次数', '/x').kind).toBe('forbidden')
    expect(classifyEndpointFailure({ status: 403 }, '打开次数', '/x').text).toContain('capability:read')
    expect(classifyEndpointFailure({ status: 401 }, '打开次数', '/x').kind).toBe('unauthorized')
    const other = classifyEndpointFailure(new Error('boom'), '打开次数', '/x')
    expect(other.kind).toBe('other')
    expect(other.text).toContain('/x')
  })

  it('形状漂移与"没有数据"分开说', () => {
    const drift = shapeDrift('打开次数', '缺少数组字段 top_apps')
    expect(drift.kind).toBe('drift')
    expect(drift.text).toContain('top_apps')
    expect(drift.text).toContain('不是“没有数据”')
  })

  it('requireOpensSummary / requireOpensDetail / requireAiUsage 的必填数组', () => {
    // 变异验证：把数组校验放宽成"有就行"⇒ 缺 top_apps 的用例红。
    expect(requireOpensSummary({ trend: [], apps: [], top_apps: [] }).ok).toBe(true)
    const bad = requireOpensSummary({ trend: [], apps: [] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.detail).toContain('top_apps')
    expect(requireOpensSummary(null).ok).toBe(false)

    expect(requireOpensDetail({ points: [] }).ok).toBe(true)
    const badDetail = requireOpensDetail({ app_id: 'a' })
    expect(badDetail.ok).toBe(false)
    if (!badDetail.ok) expect(badDetail.detail).toContain('points')

    expect(requireAiUsage({ points: [] }).ok).toBe(true)
    expect(requireAiUsage({ calls: 3 }).ok).toBe(false)
  })
})

describe('契约路径与说明常量', () => {
  it('路径与设计冻结值一致（改路径 = 与 L1 契约脱钩）', () => {
    expect(OPENS_SUMMARY_PATH).toBe('/api/server/admin/wasm-apps/opens/summary')
    // §8.9 管理端出口 ④（设计已冻结）
    expect(opensDetailPath('share-note', 'from=2026-08-21&to=2026-09-19&granularity=day'))
      .toBe('/api/server/admin/wasm-apps/share-note/opens?from=2026-08-21&to=2026-09-19&granularity=day')
    expect(opensDetailPath('share-note')).toBe('/api/server/admin/wasm-apps/share-note/opens')
    // §21.4 AI 用量
    expect(aiUsagePath('share-note')).toBe('/api/server/admin/wasm-apps/share-note/ai-usage')
    expect(aiUsagePath('share-note', 'from=2026-09-01')).toBe('/api/server/admin/wasm-apps/share-note/ai-usage?from=2026-09-01')
  })

  it('明细保留期 90 天（§8.9）与隐私说明在文案里', () => {
    expect(OPENS_DETAIL_RETENTION_DAYS).toBe(90)
    expect(OPENS_RETENTION_NOTE).toContain('90')
    expect(OPENS_RETENTION_NOTE).toContain('日汇总')
    expect(OPENS_PRIVACY_NOTE).toContain('capability:read')
    expect(OPENS_PRIVACY_NOTE).toContain('user_id')
  })
})

// ---------------------------------------------------------------------------
// 明细字段的缺失语义（主控预审计 CTL-11）：`null/undefined/非有限 ⇒ —`，
// 图表上缺值**不画点**（补 0 = 画出一条"那天没人用"的假线）。
// 这组用例是"同一屏不许两套缺失语义"的机器判据。
// ---------------------------------------------------------------------------
describe('明细缺失语义 · 不把"读不到"渲染成 0（CTL-11）', () => {
  it('tokensText：缺失 ⇒ —（不是 0 / 0K）', () => {
    // 变异验证：改回 `fmtTokens(Number(x ?? 0))` ⇒ 前两条断言必红。
    expect(tokensText(undefined)).toBe('—')
    expect(tokensText(null)).toBe('—')
    expect(tokensText(Number.NaN)).toBe('—')
    expect(tokensText(0)).toBe('0')
    expect(tokensText(1500)).toBe('1.5K')
  })

  it('daySeries：同日多部门合并成一行；任一行缺字段 ⇒ 该日为 null 并计入 missingDays', () => {
    const merged = daySeries([
      { day: '2026-09-19', dept_id: 1, pv: 2, uv: 1 },
      { day: '2026-09-19', dept_id: 2, pv: 3, uv: 2 },
      { day: '2026-09-18', dept_id: 1, pv: 1, uv: 1 },
    ])
    // 变异验证：去掉按日合并（直接用原始行）⇒ 会得到 3 个点而不是 2，必红。
    expect(merged.points.map((p) => p.day)).toEqual(['2026-09-18', '2026-09-19'])
    const d19 = merged.points[1]!
    expect(d19.pv).toBe(5)   // PV 跨部门相加合法（不去重）
    expect(d19.uv).toBe(3)   // 按 (日×部门) 去重后加总（口径见 OPENS_DETAIL_UV_SUM_NOTE）
    expect(merged.multiDeptDays).toBe(true)
    expect(merged.missingDays).toBe(0)

    // 缺字段：该日整体 null（不把缺的那行当 0），并计入 missingDays。
    const drifted = daySeries([
      { day: '2026-09-19', dept_id: 1, pv: 2, uv: 1 },
      { day: '2026-09-19', dept_id: 2 } as never,
    ])
    expect(drifted.points[0]!.pv).toBeNull()
    expect(drifted.points[0]!.uv).toBeNull()
    expect(drifted.missingDays).toBe(1)
    // dept 粒度的行没有 day ⇒ 不参与按日序列（否则会出现"空日期"点）。
    expect(daySeries([{ day: '', dept_id: 1, pv: 9, uv: 9 }]).points).toEqual([])
  })

  it('trendValues：缺 pv/uv 的点**不画**，并回报跳过数量', () => {
    // 变异验证：改成 `Number(p.pv ?? 0)` 补 0 ⇒ values 会多出一个 0 点，必红。
    const out = trendValues(
      [{ label: '09-18', pv: 1, uv: 1 }, { label: '09-19', pv: null, uv: null }],
      'UV',
    )
    expect(out.values.map((v) => `${v.label}:${v.kind}:${v.value}`)).toEqual(['09-18:PV（打开次数）:1', '09-18:UV:1'])
    expect(out.skipped).toBe(2)
  })

  it('rankTopApps：缺 pv 的行不进榜（不知道 ≠ 0）；缺 uv 的行仍进榜但 UV 为 null', () => {
    const top = rankTopApps(
      [{ app_id: 'a', pv: 5, uv: 1 }, { app_id: 'b', uv: 3 } as never, { app_id: 'c', pv: 2 } as never],
      10,
    )
    expect(top.map((r) => r.app_id)).toEqual(['a', 'c'])
    expect(top[1]!.uv).toBeNull()
    expect(countText(top[1]!.uv)).toBe('—')
  })

  it('detailTotals：只认服务端 total_pv/total_uv；缺失 ⇒ null（不从按日点反推）', () => {
    expect(detailTotals({ total_pv: 6, total_uv: 3 })).toEqual({ pv: 6, uv: 3 })
    expect(detailTotals({})).toEqual({ pv: null, uv: null })
    expect(detailTotals(null)).toEqual({ pv: null, uv: null })
  })
})
