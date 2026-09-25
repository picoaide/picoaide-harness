// 路由登记表（审计 R13-F F-06 / W-1）。
//
// 背景：`App.tsx` 的 `<Routes>` 与 `lib/nav.ts` 的 `NAV_ENTRIES` 此前**没有任何对拍**。
// 实测：只加一条 `<Route path="/probe-unregistered" element={<Audit />} />` ⇒
// 全量 644 用例 `EXIT=0`（假绿）—— 新页面只有手敲 URL 才能到达，且没有任何红灯。
// 历史事故（`error-monitoring:read` 被删后该页对包括超管在内的全部角色不可见）就是
// 同一个「入口静默消失」族。
//
// 规则（判据在 `routes.test.ts`，双向）：
//   ① `App.tsx` 里出现的每一条 `<Route>` 都必须在这里登记（新增页面不登记 ⇒ 红）；
//   ② 这里登记的每一条都必须在 `App.tsx` 里真实存在（删了页面不留死登记 ⇒ 红）；
//   ③ 侧栏能到达的页面集合（`NAV_ENTRIES.map(n => n.to)`）必须**恰好**等于
//      `App.tsx` 里的顶层页面路由集合 —— 侧栏有入口而路由不存在、路由存在而侧栏
//      无入口（且没登记成 `hidden`）都红。
//
// 为什么需要「登记」而不是纯派生：隐藏页、子路由、重定向与兜底路由**不是**侧栏
// 条目，它们的存在必须是一次显式决定（写明理由），而不是顺手加一行 `<Route>`。
// 侧栏条目那份（kind='nav'）直接从 `NAV_ENTRIES` 派生，因此 label/icon/perms
// 的唯一真源仍在 `lib/nav.ts`，这里不另抄一份。
import { NAV_ENTRIES } from './nav'

/**
 * 路由的种类（判据按 `kind + ' ' + path` 做集合对拍，`path` 一律写**全路径**）：
 * - `nav`     侧栏条目（真源 `lib/nav.ts`，从 `NAV_ENTRIES` 派生）；
 * - `hidden`  顶层页面但**刻意不进侧栏**（只能手敲 URL 到达），必须写明理由；
 * - `index`   子路由的默认页（`<Route index>`），`path` 写父路由全路径；
 * - `child`   子路由（如 `/usage/reports`）；
 * - `redirect`老书签/落地页重定向（`element={<Navigate …/>}`）；
 * - `fallback`兜底路由（`path="*"`）。
 */
export type RouteKind = 'nav' | 'hidden' | 'index' | 'child' | 'redirect' | 'fallback'

export interface RouteEntry {
  /** 全路径；`index` 子路由写父路由路径，`fallback` 写 `*`。 */
  path: string
  kind: RouteKind
  /** 为什么它长这样（隐藏页/子路由/重定向/兜底都必须有理由）。 */
  reason: string
}

/** 判据用的稳定键：`kind + ' ' + path`（`/usage` 的父路由与 index 子路由由此区分）。 */
export function routeKey(entry: RouteEntry | { kind: RouteKind; path: string }): string {
  return `${entry.kind} ${entry.path}`
}

/** 侧栏能到达的页面（唯一真源 = `NAV_ENTRIES`；这里只是对账的另一半）。 */
const NAV_ROUTES: RouteEntry[] = NAV_ENTRIES.map((n) => ({
  path: n.to,
  kind: 'nav',
  reason: `侧栏「${n.label}」条目（${n.section}分区；label/icon/perms 真源在 lib/nav.ts）`,
}))

/** 不进侧栏 / 不是页面的路由：**每一条都必须显式登记**（新增即红，见 routes.test.ts）。 */
const NON_NAV_ROUTES: RouteEntry[] = [
  { path: '/', kind: 'redirect', reason: '登录落地页：`<Navigate to={landingPath}>`，目标由 lib/nav.ts 的第一个可见条目派生' },
  { path: '/usage', kind: 'index', reason: '用量中心默认子页（总览），路径与父路由同为 /usage' },
  { path: '/usage/depts', kind: 'child', reason: '用量中心「部门」子页（UsageLayout 子导航）' },
  { path: '/usage/members', kind: 'child', reason: '用量中心「成员」子页' },
  { path: '/usage/members/:username', kind: 'child', reason: '用量中心「成员详情」子页（带参数）' },
  { path: '/usage/models', kind: 'child', reason: '用量中心「模型」子页' },
  { path: '/usage/logs', kind: 'child', reason: '用量中心「请求明细」子页' },
  { path: '/usage/balance', kind: 'child', reason: '用量中心「余额」子页' },
  { path: '/usage/reports', kind: 'child', reason: '用量中心「报表订阅」子页' },
  { path: '/marketplace', kind: 'redirect', reason: '老书签：「市场 · 技能」已并入能力中心 → /capabilities?tab=market' },
  { path: '/app-center', kind: 'index', reason: '应用中心默认子页（应用列表），路径与父路由同为 /app-center' },
  { path: '/app-center/opens', kind: 'child', reason: '应用中心「运营看板」子页（打开次数 PV/UV）' },
  { path: '/app-center/limits', kind: 'child', reason: '应用中心「限制项」子页（原独立页「应用平台」并入）' },
  { path: '/app-platform', kind: 'redirect', reason: '老书签：原「应用平台」页已并入应用中心 → /app-center/limits' },
  { path: '*', kind: 'fallback', reason: '未知路径 404 提示（不静默跳回 /users，排障需要）' },
]

/** 全部路由登记（侧栏派生 + 显式登记）。 */
export const ROUTE_REGISTRY: readonly RouteEntry[] = [...NAV_ROUTES, ...NON_NAV_ROUTES]

/**
 * 双向对拍：`actual` = 从 `App.tsx` 解析出的真实路由，`declared` = {@link ROUTE_REGISTRY}。
 *
 * @param actual - 源码里真实存在的路由形状。
 * @param declared - 登记表里的路由形状。
 * @returns `unregistered` = 存在却没登记；`missing` = 登记了却不存在。
 */
export function diffRoutes(
  actual: readonly { kind: RouteKind; path: string }[],
  declared: readonly { kind: RouteKind; path: string }[],
): { unregistered: string[]; missing: string[] } {
  const declaredKeys = new Set(declared.map((r) => routeKey(r)))
  const actualKeys = new Set(actual.map((r) => routeKey(r)))
  return {
    unregistered: [...actualKeys].filter((k) => !declaredKeys.has(k)).sort(),
    missing: [...declaredKeys].filter((k) => !actualKeys.has(k)).sort(),
  }
}
