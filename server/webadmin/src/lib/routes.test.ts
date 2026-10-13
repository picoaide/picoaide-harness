import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DECLARED_NAV_ENTRIES, FEATURE_NAV_ENTRIES, NAV_ENTRIES } from './nav'
import {
  DECLARED_ROUTE_REGISTRY,
  FEATURE_ROUTE_ENTRIES,
  ROUTE_REGISTRY,
  diffRoutes,
  routeKey,
  type RouteKind,
} from './routes'
import { FEATURE_ENABLED, FEATURE_MODULES, FEATURES_VARIANT, type FeatureModule } from './features'

// 审计 R13-F F-06 / W-1：`App.tsx` 的 `<Routes>` ↔ `lib/nav.ts` 的 `NAV_ENTRIES`
// ↔ `lib/routes.ts` 的登记表，三者的**双向**对拍。判据必须真的咬得住
// 「新增一条 Route 不登记」—— 实测（变异证据）把这条加进 App.tsx：
//   <Route path="/probe-unregistered" element={<Audit />} />
// 本用例红；把它从 App.tsx 移除即恢复绿。
//
// 真源 = `App.tsx` 源码（本用例**解析源码**，不是读一份手抄清单）。解析器自带
// 自证：解析出 0 条、标签不闭合、`</Route>` 多于 `<Route>` 都直接抛（fail-loud）。
//
// ---------------------------------------------------------------------------
// P3 变体（2026-10-14）：**解析器与打包器读同一个守卫**
// ---------------------------------------------------------------------------
// 模块页（能力中心 / 应用中心 / 连接器）的 `<Route>` 被 `{__FEATURE_<MODULE>__ && ( … )}`
// 包着，关闭时**页面 chunk 根本不进 dist**（契约
// docs/decisions/2026-10-14-webadmin-feature-variant.md）。于是本判据的"真源"必须按**当前
// 变体**解析：开启的模块照旧逐条对拍（"路由 ⟺ 导航 ⟺ 权限点"必须齐全），关闭的模块
// 整块不在登记表里、也解析不出对应路由。
//
// 两侧都在（缺一即红）：
//   ① **当前变体**：`PARSED`（按开关过滤后）↔ `ROUTE_REGISTRY`（同样按开关过滤）；
//   ② **声明**：`PARSED_ALL`（不按开关过滤）↔ `DECLARED_ROUTE_REGISTRY`（含关闭模块）——
//      这一侧在**每一种变体下**都成立，因此"关闭时少对拍"不会退化成"关闭时可以少写路由"。
//
// 守卫形态只有一种（解析器**不认**别的包裹形态，见到就抛）：这样"打包器折掉的分支"
// 与"判据当成不存在的路由"是同一个判断，不会出现"判据认为没有、产物里却有"的假绿。

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

/** **这份产物**的侧栏全路径集合（顶层页面路由的种类判定依据）。 */
const NAV_PATHS = new Set(NAV_ENTRIES.map((n) => n.to))
/** **全部声明**的侧栏全路径集合（含被关闭模块）：声明侧解析的种类判定依据。 */
const DECLARED_NAV_PATHS = new Set(DECLARED_NAV_ENTRIES.map((n) => n.to))

interface ParsedRoute {
  kind: RouteKind
  path: string
  /** 该 `<Route>` 标签原文（用来断言 nav 条目不是重定向、降级不是空壳）。 */
  tag: string
  line: number
  /** 包裹它的变体守卫所属模块（`null` = 与变体无关）。 */
  module: FeatureModule | null
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
 * `<Route>` 前面那段文本是不是一个**已登记的变体守卫**（`{__FEATURE_<MODULE>__ && (`）。
 *
 * 只认这一种形态（见文件头）：认不出却以 `(` 结尾 ⇒ 抛（fail-loud），**不**静默当成
 * "没有守卫"—— 那会把一个其实被关掉的路由算成无条件路由，双向对拍当场变成假绿。
 * @param text - 已注释清零的 `<Routes>` 块文本。
 * @param start - `<Route` 的起始下标。
 * @returns 守卫所属模块；没有守卫时 `null`。
 */
function featureGuardBefore(text: string, start: number): FeatureModule | null {
  const before = text.slice(Math.max(0, start - 200), start)
  const matched = /\{\s*__FEATURE_([A-Z]+)__\s*&&\s*\(\s*$/u.exec(before)
  if (matched !== null) {
    const module = matched[1]!.toLowerCase()
    if (!(FEATURE_MODULES as readonly string[]).includes(module)) {
      throw new Error(
        `<Route> 的变体守卫引用了未知模块 __FEATURE_${matched[1]}__：`
          + `合法模块名 ${FEATURE_MODULES.join(' / ')}（与 Go 侧 -tags、渠道配置 features 逐字一致）`,
      )
    }
    return module as FeatureModule
  }
  if (/\(\s*$/u.test(before)) {
    throw new Error(
      `<Route> 被一个本判据无法识别的条件包裹（…${JSON.stringify(before.slice(-60))}）：只认 `
        + '`{__FEATURE_<MODULE>__ && (<Route … />)}`（解析器必须与打包器读同一个守卫，'
        + '否则"判据认为不存在、产物里却有"不会有任何红灯）',
    )
  }
  return null
}

/**
 * 解析 `<Routes>` 块里的全部 `<Route>`。
 *
 * 种类判定（顺序即优先级）：`index` > `*` 兜底 > `<Navigate>` 重定向 >
 * 顶层且在 `navPaths` 里 ⇒ `nav`、顶层不在 ⇒ `hidden` > 其余 ⇒ `child`。
 * @param src - App.tsx 全文（或测试夹具）。
 * @param navPaths - 侧栏条目的全路径集合（种类判定依据）。
 * @param options - `features`：当前变体的逐模块开关；给了就**丢掉被关闭模块的路由**
 *   （与打包器折叠掉的分支一致）。不给 = 返回全部声明（含被关闭模块）。
 * @returns 解析出的路由（父在前、子在后）。
 */
export function parseRoutes(
  src: string,
  navPaths: ReadonlySet<string>,
  options: { features?: Readonly<Record<FeatureModule, boolean>> } = {},
): ParsedRoute[] {
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
  /** 与 `stack` 同步的守卫栈：子路由继承父路由的变体守卫。 */
  const guardStack: Array<FeatureModule | null> = []
  const tagRe = /<\/?Route\b/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(body)) !== null) {
    const start = m.index
    if (body.startsWith('</', start)) {
      if (stack.pop() === undefined) throw new Error('</Route> 多于 <Route>：路由表结构损坏')
      guardStack.pop()
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
    const own = featureGuardBefore(body, start)
    const inherited = guardStack.length > 0 ? guardStack[guardStack.length - 1]! : null
    const guard = own ?? inherited
    const route: ParsedRoute = {
      kind,
      path,
      tag,
      line: body.slice(0, start).split('\n').length + APP_PATH.slice(0, offset).split('\n').length,
      module: guard,
    }
    // 结构记账照做（`</Route>` 还要配对），但**被关闭模块的路由不进结果**：产物里
    // 它连同页面 chunk 一起不存在（打包器折叠同一个字面量守卫）。
    if (guard === null || options.features === undefined || options.features[guard] === true) out.push(route)
    if (!selfClosing) {
      stack.push(route)
      guardStack.push(guard)
    }
  }
  if (stack.length > 0) throw new Error('<Route …> 未闭合：路由表结构损坏')
  if (out.length === 0) throw new Error('解析出 0 条路由：解析器失效（零命中不许全绿）')
  return out
}

/** **这份产物**的真实路由（按当前变体过滤）。 */
const PARSED = parseRoutes(APP_SRC, NAV_PATHS, { features: FEATURE_ENABLED })
const PARSED_KEYS = PARSED.map((r) => routeKey(r)).sort()
const REGISTRY_KEYS = ROUTE_REGISTRY.map((r) => routeKey(r)).sort()
/** **全部声明**的路由（含被关闭模块）：声明侧对拍 + 守卫解析自证用。 */
const PARSED_ALL = parseRoutes(APP_SRC, DECLARED_NAV_PATHS)
const PARSED_ALL_KEYS = PARSED_ALL.map((r) => routeKey(r)).sort()
const DECLARED_REGISTRY_KEYS = DECLARED_ROUTE_REGISTRY.map((r) => routeKey(r)).sort()

/** 当前变体下**被关闭**的模块（其余为开启）。 */
const DISABLED_MODULES = FEATURE_MODULES.filter((module) => !FEATURE_ENABLED[module])

describe('路由表 ↔ 侧栏导航 ↔ 登记表 双向对拍（R13-F F-06）', () => {
  it('解析器自证：真源可读、路由形状齐全（解析器坏掉不许"零命中=全绿"）', () => {
    expect(existsSync(APP_PATH), `路由真源不可读：${APP_PATH}`).toBe(true)
    // 下界按**声明侧**判（与变体无关）：写死"当前变体的条数"会在关掉模块时把
    // "变体生效"误报成"解析器塌了"。运行时侧只要不是塌成零命中即可（它的条数由
    // 下面「变体对拍」用例按"声明数 − 关闭模块数"精确断言）。
    expect(PARSED_ALL.length).toBeGreaterThan(20)
    expect(PARSED.length).toBeGreaterThan(10)
    // 四类"非页面"路由各至少一条，否则说明种类判定塌了（例如重定向被当普通页面）。
    // **在声明侧判**（`PARSED_ALL`）：这几条里有两条属于模块页（`/marketplace` 属 skills、
    // `/app-platform` 属 apps），用当前变体的集合判会让"关掉模块"看起来像"解析器塌了"。
    for (const key of [
      'redirect /', 'redirect /marketplace', 'redirect /app-platform',
      'fallback *', 'index /usage', 'child /usage/reports', 'nav /users', 'nav /audit',
    ]) {
      expect(PARSED_ALL_KEYS, `解析结果缺少 ${key}（路由表或解析器漂移）`).toContain(key)
    }
  })

  it('方向①：App.tsx 里每条 <Route> 都必须在登记表里（新增路由不登记即红）', () => {
    const { unregistered } = diffRoutes(PARSED, ROUTE_REGISTRY)
    expect(
      unregistered,
      `App.tsx 里有这些路由但 lib/routes.ts 没登记：${unregistered.join(', ')}\n` +
      '新增页面请同时改 lib/nav.ts（要进侧栏）或补 CORE_NON_NAV_ROUTES 条目并写明理由（隐藏页/子路由/重定向/兜底）',
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
    // **按变体给期望**（不是从登记表反推，那会变成恒真）：两条模块重定向随各自模块开关。
    const redirects = PARSED.filter((r) => r.kind === 'redirect').map((r) => r.path).sort()
    const expected = [
      '/',
      ...(FEATURE_ENABLED.skills ? ['/marketplace'] : []),
      ...(FEATURE_ENABLED.apps ? ['/app-platform'] : []),
    ].sort()
    expect(redirects).toEqual(expected)
  })

  it('登记表自身不重复、理由非空（登记不是"贴个名字就算"）', () => {
    expect(new Set(REGISTRY_KEYS).size, '登记表有重复条目').toBe(REGISTRY_KEYS.length)
    for (const entry of ROUTE_REGISTRY) {
      expect(entry.reason.trim(), `${routeKey(entry)} 缺登记理由`).not.toBe('')
      expect(entry.path.startsWith('/') || entry.path === '*', `${routeKey(entry)} 的 path 形态不对`).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // P3 变体：声明侧对拍（**每一种变体下都成立**）
  //
  // 方向①②③ 判的是"这份产物"（已按开关过滤）。关闭模块时它们不再覆盖那几条路由，
  // 所以这里补一条**与变体无关**的对拍：App.tsx 里被守卫的路由 ⟺ 声明表里的模块路由。
  // 它同时保证了"开启时必须齐全"——少写一条模块路由，在**任何**变体下都红。
  // -------------------------------------------------------------------------
  it('方向④（声明侧）：被守卫的模块路由 ⟺ FEATURE_ROUTE_ENTRIES ∪ 模块 nav 条目（两个方向）', () => {
    // 真源两侧都不手抄：左边来自 App.tsx 的守卫解析，右边来自 lib/routes.ts / lib/nav.ts
    // 的声明（`nav` 那一半从 FEATURE_NAV_ENTRIES 派生，label/icon/perms 仍只有一份真源）。
    const declaredModuleKeys = [
      ...FEATURE_NAV_ENTRIES.map((entry) => routeKey({ kind: 'nav' as const, path: entry.to })),
      ...FEATURE_ROUTE_ENTRIES.map((entry) => routeKey(entry)),
    ].sort()
    const guardedKeys = PARSED_ALL.filter((r) => r.module !== null).map((r) => routeKey(r)).sort()
    expect(
      guardedKeys,
      'App.tsx 里被 __FEATURE_*__ 守卫的路由与 lib/routes.ts / lib/nav.ts 声明的模块路由不一致\n'
        + '（少了：模块页被写成无条件路由；多了：声明表里有产物里不存在的模块路由。两侧都必须齐全）',
    ).toEqual(declaredModuleKeys)

    // 每一条模块路由的守卫必须是它**声明**归属的那个模块（错配会让"关 A 却关掉 B 的页面"）。
    const moduleOfDeclared = new Map<string, FeatureModule>([
      ...FEATURE_NAV_ENTRIES.map((entry) => [routeKey({ kind: 'nav' as const, path: entry.to }), entry.module] as const),
      ...FEATURE_ROUTE_ENTRIES.map((entry) => [routeKey(entry), entry.module] as const),
    ])
    const mismatched = PARSED_ALL
      .filter((r) => r.module !== null && moduleOfDeclared.get(routeKey(r)) !== r.module)
      .map((r) => `${routeKey(r)} 的守卫是 ${r.module}，声明归属 ${moduleOfDeclared.get(routeKey(r)) ?? '（无声明）'}`)
      .sort()
    expect(mismatched, `模块路由的变体守卫与声明归属不一致：\n${mismatched.join('\n')}`).toEqual([])

    // 非空自证：三个模块都必须有被守卫的路由（解析器把守卫全丢掉时不许全绿）。
    for (const module of FEATURE_MODULES) {
      expect(
        PARSED_ALL.filter((r) => r.module === module).length,
        `模块 ${module} 在 App.tsx 里一条被守卫的路由都没有（守卫解析塌了？声明表与产物脱节？）`,
      ).toBeGreaterThan(0)
    }
  })

  it('变体对拍：关闭的模块整块不在产物登记里，开启的模块逐条齐全', () => {
    // ① 关闭模块：它的路由既不在产物解析里、也不在这份登记表里。
    for (const module of DISABLED_MODULES) {
      const declaredKeys = PARSED_ALL.filter((r) => r.module === module).map((r) => routeKey(r))
      expect(declaredKeys.length, `${module} 被关闭却没有任何声明路由可对拍`).toBeGreaterThan(0)
      for (const key of declaredKeys) {
        expect(PARSED_KEYS, `${module} 已关闭，但 ${key} 仍出现在产物路由里`).not.toContain(key)
        expect(REGISTRY_KEYS, `${module} 已关闭，但 ${key} 仍在产物登记表里`).not.toContain(key)
      }
    }
    // ② 开启模块：声明里的每一条都必须在产物里（"开启时必须齐全"那一侧）。
    for (const module of FEATURE_MODULES.filter((m) => FEATURE_ENABLED[m])) {
      const declaredKeys = PARSED_ALL.filter((r) => r.module === module).map((r) => routeKey(r))
      expect(declaredKeys.length, `${module} 开启却没有任何声明路由`).toBeGreaterThan(0)
      for (const key of declaredKeys) expect(PARSED_KEYS, `${module} 开启，但 ${key} 不在产物路由里`).toContain(key)
    }
    // ③ 变体口径自证：产物路由数 = 声明路由数 − 关闭模块的路由数（一个数字都不许凭空消失）。
    const disabledCount = PARSED_ALL.filter((r) => r.module !== null && !FEATURE_ENABLED[r.module]).length
    expect(
      PARSED.length,
      `变体 ${FEATURES_VARIANT}：产物路由数应 = 声明路由数 − 关闭模块路由数`,
    ).toBe(PARSED_ALL.length - disabledCount)
    expect(DECLARED_ROUTE_REGISTRY.length).toBe(PARSED_ALL.length)
  })

  it('方向④（声明侧）与产物侧一致：DECLARED_ROUTE_REGISTRY 双向对拍 App.tsx 全量声明', () => {
    const { unregistered, missing } = diffRoutes(PARSED_ALL, DECLARED_ROUTE_REGISTRY)
    expect(unregistered, `App.tsx 里有这些（含关闭模块的）路由没进声明表：${unregistered.join(', ')}`).toEqual([])
    expect(missing, `声明表里有这些路由但 App.tsx 里没有：${missing.join(', ')}`).toEqual([])
    expect(DECLARED_REGISTRY_KEYS.length).toBe(PARSED_ALL_KEYS.length)
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

  // -------------------------------------------------------------------------
  // 变体守卫解析自证（夹具，不依赖真实路由表）：证明"关闭 ⇒ 整块消失"与
  // "子路由继承父守卫"两条，且不认的包裹形态**当场抛**（不静默当成无守卫）。
  // -------------------------------------------------------------------------
  it('变体守卫自证：关闭 ⇒ 该模块路由（含子路由）整块消失；开启 ⇒ 逐条在；异形包裹 ⇒ 抛', () => {
    const fixture = `
      <Routes>
        <Route path="/users" element={<Users />} />
        {__FEATURE_APPS__ && (
          <Route path="/app-center" element={<Layout />}>
            <Route index element={<Apps />} />
            <Route path="limits" element={<Limits />} />
          </Route>
        )}
        {__FEATURE_CONNECTORS__ && (
          <Route path="/connectors" element={<Connectors />} />
        )}
        <Route path="*" element={<NotFound />} />
      </Routes>`
    const navPaths = new Set(['/users', '/app-center', '/connectors'])

    // 开启（不传 features = 全量声明）：守卫被记下来，路由都在。
    const all = parseRoutes(fixture, navPaths)
    expect(all.map((r) => `${routeKey(r)}@${r.module}`).sort()).toEqual([
      'fallback *@null', 'index /app-center@apps', 'nav /app-center@apps',
      'nav /connectors@connectors', 'nav /users@null', 'child /app-center/limits@apps',
    ].sort())

    // 关闭 connectors、开着 apps：**只有 connectors 那条消失**（子路由随父一起）。
    const filtered = parseRoutes(fixture, navPaths, { features: { skills: true, apps: true, connectors: false } })
    const keys = filtered.map((r) => routeKey(r)).sort()
    expect(keys).toEqual(['fallback *', 'index /app-center', 'nav /app-center', 'nav /users', 'child /app-center/limits'].sort())
    expect(keys.join(' ')).not.toContain('/connectors')

    // 两个都关：模块路由一条不剩，无守卫的路由照旧。
    const none = parseRoutes(fixture, navPaths, { features: { skills: false, apps: false, connectors: false } })
    expect(none.map((r) => routeKey(r)).sort()).toEqual(['fallback *', 'nav /users'])

    // 异形包裹（解析器认不出）：**抛**，不静默当成"没有守卫"。
    expect(() => parseRoutes(`
      <Routes>
        <Route path="/users" element={<Users />} />
        {isEnabled('apps') && (
          <Route path="/app-center" element={<Apps />} />
        )}
      </Routes>`, navPaths)).toThrow(/无法识别的条件包裹/u)

    // 未知模块名：抛（守卫名是契约的一部分）。
    expect(() => parseRoutes(`
      <Routes>
        <Route path="/users" element={<Users />} />
        {__FEATURE_WIDGETS__ && (
          <Route path="/widgets" element={<Widgets />} />
        )}
      </Routes>`, navPaths)).toThrow(/未知模块/u)
  })
})
