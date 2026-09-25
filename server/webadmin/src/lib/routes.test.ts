import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAV_ENTRIES } from './nav'
import { ROUTE_REGISTRY, diffRoutes, routeKey, type RouteKind } from './routes'

// 审计 R13-F F-06 / W-1：`App.tsx` 的 `<Routes>` ↔ `lib/nav.ts` 的 `NAV_ENTRIES`
// ↔ `lib/routes.ts` 的登记表，三者的**双向**对拍。判据必须真的咬得住
// 「新增一条 Route 不登记」—— 实测（变异证据）把这条加进 App.tsx：
//   <Route path="/probe-unregistered" element={<Audit />} />
// 本用例红；把它从 App.tsx 移除即恢复绿。
//
// 真源 = `App.tsx` 源码（本用例**解析源码**，不是读一份手抄清单）。解析器自带
// 自证：解析出 0 条、标签不闭合、`</Route>` 多于 `<Route>` 都直接抛（fail-loud）。

/**
 * 定位 `src/App.tsx`（路由表真源）。
 *
 * 不用 `import.meta.url`：jsdom 环境下它是 `http://localhost/...`。与 `nav.test.ts`
 * 同款——从 cwd 向上找前端源码标记；找不到必须 throw（静默跳过 = 关掉判据）。
 * @returns App.tsx 的绝对路径。
 */
function findAppTsx(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'App.tsx'))) return join(dir, 'src', 'App.tsx')
    if (existsSync(join(dir, 'webadmin', 'src', 'App.tsx'))) return join(dir, 'webadmin', 'src', 'App.tsx')
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到路由表真源 src/App.tsx（cwd=${process.cwd()}）：对拍真源必须可读`)
}

const APP_PATH = findAppTsx()
const APP_SRC = readFileSync(APP_PATH, 'utf8')

/** `NAV_ENTRIES` 的全路径集合（顶层页面路由的种类判定依据）。 */
const NAV_PATHS = new Set(NAV_ENTRIES.map((n) => n.to))

interface ParsedRoute {
  kind: RouteKind
  path: string
  /** 该 `<Route>` 标签原文（用来断言 nav 条目不是重定向、降级不是空壳）。 */
  tag: string
  line: number
}

/**
 * 把 JSX 注释（`{/* … *\/}`）与 `//` 行注释换成等长空格（保留换行与偏移）。
 * 手写扫描器而不是正则：注释里出现引号/`//` 都不会误判。
 * @param src - 源码片段。
 * @returns 等长、已注释清零的文本。
 */
function blankComments(src: string): string {
  const out = [...src]
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * 找到 `<Route` 标签的结束 `>`（跳过字符串与 `{…}` 属性表达式里的 `>`）。
 * @param text - 已注释清零的源码。
 * @param start - `<Route` 的起始下标。
 * @returns 结束 `>` 的下标。
 */
function findTagEnd(text: string, start: number): number {
  let quote: string | null = null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') { depth++; continue }
    if (ch === '}') { depth--; continue }
    if (ch === '>' && depth === 0) return i
  }
  throw new Error(`<Route 标签未闭合（offset=${start}）：路由解析器失效，对拍必须 fail-loud`)
}

/**
 * 解析 `<Routes>` 块里的全部 `<Route>`。
 *
 * 种类判定（顺序即优先级）：`index` > `*` 兜底 > `<Navigate>` 重定向 >
 * 顶层且在 `navPaths` 里 ⇒ `nav`、顶层不在 ⇒ `hidden` > 其余 ⇒ `child`。
 * @param src - App.tsx 全文（或测试夹具）。
 * @param navPaths - 侧栏条目的全路径集合（种类判定依据）。
 * @returns 解析出的路由（父在前、子在后）。
 */
export function parseRoutes(src: string, navPaths: ReadonlySet<string>): ParsedRoute[] {
  const text = blankComments(src)
  const open = text.indexOf('<Routes>')
  const close = text.indexOf('</Routes>')
  if (open < 0 || close < 0 || close < open) {
    throw new Error('<Routes> 块不完整：App.tsx 的路由表是对拍真源，解析不到必须红')
  }
  const body = text.slice(open, close)
  const offset = open
  const out: ParsedRoute[] = []
  const stack: ParsedRoute[] = []
  const tagRe = /<\/?Route\b/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(body)) !== null) {
    const start = m.index
    if (body.startsWith('</', start)) {
      if (stack.pop() === undefined) throw new Error('</Route> 多于 <Route>：路由表结构损坏')
      continue
    }
    const end = findTagEnd(body, start)
    const tag = body.slice(start, end + 1)
    const selfClosing = /\/\s*>$/.test(tag)
    const pathAttr = /\bpath\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? null
    const isIndex = /\bindex\b(?!\s*=)/.test(tag)
    const isRedirect = tag.includes('<Navigate')
    const parent = stack[stack.length - 1]
    if (isIndex && parent === undefined) throw new Error('<Route index> 没有父路由')
    if (!isIndex && pathAttr === null) throw new Error(`非 index 的 <Route> 缺 path：${tag}`)
    const path = isIndex
      ? parent!.path
      : pathAttr === '*' ? '*'
        : pathAttr!.startsWith('/') ? pathAttr! : `${parent?.path ?? ''}/${pathAttr!}`
    const kind: RouteKind = isIndex
      ? 'index'
      : pathAttr === '*' ? 'fallback'
        : isRedirect ? 'redirect'
          : parent !== undefined ? 'child'
            : navPaths.has(path) ? 'nav' : 'hidden'
    const route: ParsedRoute = {
      kind,
      path,
      tag,
      line: body.slice(0, start).split('\n').length + APP_PATH.slice(0, offset).split('\n').length,
    }
    out.push(route)
    if (!selfClosing) stack.push(route)
  }
  if (stack.length > 0) throw new Error('<Route …> 未闭合：路由表结构损坏')
  if (out.length === 0) throw new Error('解析出 0 条路由：解析器失效（零命中不许全绿）')
  return out
}

const PARSED = parseRoutes(APP_SRC, NAV_PATHS)
const PARSED_KEYS = PARSED.map((r) => routeKey(r)).sort()
const REGISTRY_KEYS = ROUTE_REGISTRY.map((r) => routeKey(r)).sort()

describe('路由表 ↔ 侧栏导航 ↔ 登记表 双向对拍（R13-F F-06）', () => {
  it('解析器自证：真源可读、路由形状齐全（解析器坏掉不许"零命中=全绿"）', () => {
    expect(existsSync(APP_PATH), `路由真源不可读：${APP_PATH}`).toBe(true)
    expect(PARSED.length).toBeGreaterThan(20)
    // 四类"非页面"路由各至少一条，否则说明种类判定塌了（例如重定向被当普通页面）。
    for (const key of [
      'redirect /', 'redirect /marketplace', 'redirect /app-platform',
      'fallback *', 'index /usage', 'child /usage/reports', 'nav /users', 'nav /audit',
    ]) {
      expect(PARSED_KEYS, `解析结果缺少 ${key}（路由表或解析器漂移）`).toContain(key)
    }
  })

  it('方向①：App.tsx 里每条 <Route> 都必须在登记表里（新增路由不登记即红）', () => {
    const { unregistered } = diffRoutes(PARSED, ROUTE_REGISTRY)
    expect(
      unregistered,
      `App.tsx 里有这些路由但 lib/routes.ts 没登记：${unregistered.join(', ')}\n` +
      '新增页面请同时改 lib/nav.ts（要进侧栏）或补 NON_NAV_ROUTES 条目并写明理由（隐藏页/子路由/重定向/兜底）',
    ).toEqual([])
  })

  it('方向②：登记表里每条都必须在 App.tsx 里真实存在（删页面不留死登记）', () => {
    const { missing } = diffRoutes(PARSED, ROUTE_REGISTRY)
    expect(missing, `lib/routes.ts 登记了这些路由但 App.tsx 里没有：${missing.join(', ')}`).toEqual([])
  })

  it('方向③：侧栏条目集合 = App.tsx 顶层页面路由集合（两个方向都红）', () => {
    const navPaths = [...NAV_PATHS].sort()
    const topLevel = PARSED.filter((r) => r.kind === 'nav' || r.kind === 'hidden')
    const topLevelPaths = topLevel.map((r) => r.path).sort()
    // ① 侧栏有入口 ⇒ 必须有对应路由（否则点进去是 404）。
    expect(
      navPaths.filter((p) => !topLevelPaths.includes(p)),
      '侧栏有这些条目但 App.tsx 没有对应路由（点了就 404）',
    ).toEqual([])
    // ② 顶层页面路由 ⇒ 要么是侧栏条目（`NAV_ENTRIES`），要么被显式登记成 `hidden`
    //    （`kind='hidden'` 必须出现在登记表里，且必须写明理由 —— 见下方"登记表自身"用例）。
    //    "存在却没登记"这一方向由方向①兜底，这里给出可读证据。
    const notInNav = topLevelPaths.filter((p) => !navPaths.includes(p))
    const declaredHidden = ROUTE_REGISTRY.filter((r) => r.kind === 'hidden').map((r) => r.path).sort()
    expect(
      notInNav,
      '这些顶层页面既不在侧栏、也没登记成 hidden（新增页面必须显式决定它进不进侧栏）',
    ).toEqual(declaredHidden)
  })

  it('侧栏条目必须是真页面而不是重定向（redirect 只允许出现在显式登记里）', () => {
    for (const r of PARSED.filter((x) => x.kind === 'nav')) {
      expect(r.tag, `${r.path} 是侧栏条目，但它的 element 是 <Navigate>（入口会立刻跳走）`).not.toContain('<Navigate')
    }
    // 反向：parse 出来的重定向必须被登记成 redirect（键相等已保证，这里给出可读证据）。
    const redirects = PARSED.filter((r) => r.kind === 'redirect').map((r) => r.path).sort()
    expect(redirects).toEqual(['/', '/app-platform', '/marketplace'])
  })

  it('登记表自身不重复、理由非空（登记不是"贴个名字就算"）', () => {
    expect(new Set(REGISTRY_KEYS).size, '登记表有重复条目').toBe(REGISTRY_KEYS.length)
    for (const entry of ROUTE_REGISTRY) {
      expect(entry.reason.trim(), `${routeKey(entry)} 缺登记理由`).not.toBe('')
      expect(entry.path.startsWith('/') || entry.path === '*', `${routeKey(entry)} 的 path 形态不对`).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // 判据自证（夹具，不依赖真实路由表）：证明"新增一条 Route 不登记"必红，
  // 同时证明它**不是**一刀切禁令 —— 补上登记（含隐藏页）即绿。
  // -------------------------------------------------------------------------
  it('判据自证：夹具里新增一条未登记 Route ⇒ unregistered 命中；补登记 ⇒ 清空', () => {
    const fixture = `
      <Routes>
        <Route path="/" element={<Navigate to="/users" />} />
        <Route path="/users" element={<Users />} />
        <Route path="/usage" element={<UsageLayout />}>
          <Route index element={<Overview />} />
        </Route>
        <Route path="/probe-unregistered" element={<Audit />} />
        <Route path="*" element={<NotFound />} />
      </Routes>`
    const navPaths = new Set(['/users', '/usage'])
    const parsed = parseRoutes(fixture, navPaths)
    const keys = parsed.map((r) => routeKey(r)).sort()
    expect(keys).toEqual([
      'fallback *', 'hidden /probe-unregistered', 'index /usage',
      'nav /usage', 'nav /users', 'redirect /',
    ])

    // 只登记"原本就该有"的路由（= 新增页面前的状态）
    const before = [
      { kind: 'redirect' as const, path: '/' },
      { kind: 'nav' as const, path: '/users' },
      { kind: 'nav' as const, path: '/usage' },
      { kind: 'index' as const, path: '/usage' },
      { kind: 'fallback' as const, path: '*' },
    ]
    expect(diffRoutes(parsed, before).unregistered).toEqual(['hidden /probe-unregistered'])

    // 补上显式登记（隐藏页 + 理由）⇒ 判据放行
    const after = [...before, { kind: 'hidden' as const, path: '/probe-unregistered' }]
    expect(diffRoutes(parsed, after)).toEqual({ unregistered: [], missing: [] })

    // 反向：登记了却不存在 ⇒ 另一个方向也红
    const withStale = [...after, { kind: 'nav' as const, path: '/removed-page' }]
    expect(diffRoutes(parsed, withStale).missing).toEqual(['nav /removed-page'])
  })
})
