/// <reference types="node" />
/**
 * 应用响应的**安全头并集**对拍（R4-D-5 / 审计 R4-B-18）。
 *
 * ## 为什么要这条用例
 *
 * 应用资源的响应安全头有**两个来源**，而它们谁都不是"全集"：
 *
 *  - **平台**：`server/internal/wasmapp/edge/primitives.go` 的 `ApplyHostSecurityHeaders`
 *    （取值为 `limits.AppContentSecurityPolicy` / `HostReferrerPolicy`），由
 *    `appserver/respond.go` 与 `edge/gate.go` 在**所有响应**（含 4xx/5xx）上写；
 *  - **宿主**：`packages/host/wasm-apps-host/src/cache.ts` 的 `securityHeaders()`，只在本机
 *    缓存的 **304** 与**缓存命中**两条路径上叠加 —— 对文档/接口是**死代码**，真正的兜底
 *    是平台那一份。
 *
 * 于是"关键头有没有被覆盖"这个问题**只能对并集提问**：单看任一份都会得出错误结论
 * （单看宿主 ⇒ 以为 4 项都在；单看平台 ⇒ 以为 `Cache-Control` 之外没有别的差异）。
 * 本用例读**两端真源**，断言：
 *
 *  1. 登记的关键头在**并集**里齐备，且每一项的来源（平台 / 宿主 / 两者）与登记表逐项相同
 *     —— 并集必须**真的**是非冗余的（存在只在单侧出现的头，例如 `Cache-Control` 只在平台侧）；
 *  2. 两侧的取值口径逐项核对：`X-Content-Type-Options`/`X-Frame-Options` 同值；CSP 两份都
 *     必须锚定 `default-src` 与 `frame-ancestors 'none'`；`Referrer-Policy` 是**登记在案的
 *     有意分叉**（平台 `same-origin`、宿主 `no-referrer`），并钉住"平台那份绝不能是
 *     `no-referrer`"（2026-09-19 线上 P0：会让应用内同源写请求的 `Origin` 变成 `null` ⇒ 全部 403）；
 *  3. 两端的**应用点计数**与登记表逐字相等 ⇒ "宿主只在缓存路径叠加"是**被机器钉住的事实**，
 *     而不是注释里的说法：任何一侧新增/删除应用点都会红，逼着同步这张登记表（与结论）。
 *
 * **只读**：本用例不改任何生产行为，也不断言"应该怎样"（例如不要求宿主补齐文档路径 ——
 * 那是产品决策）；它把**当前事实**变成可判定、可复现的判据。
 *
 * ## 变异验证（拆掉任一侧必红）
 *  - 删掉平台 `ApplyHostSecurityHeaders` 的 `h.Set("X-Frame-Options", ...)` ⇒ 「并集覆盖」红；
 *  - 删掉宿主 `securityHeaders()` 的 `'X-Frame-Options': 'DENY'` ⇒ 同上；
 *  - 把平台 `HostReferrerPolicy` 改成 `no-referrer` ⇒ 「平台 referrer 策略」红；
 *  - 在宿主 `handler.ts` 里给文档路径加一处 `securityHeaders()` ⇒ 「应用点登记表」红；
 *  - 把平台 CSP 的 `frame-ancestors 'none'` 删掉 ⇒ 「CSP 锚定」红。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上五级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/**
 * 读仓库内文件；**缺失即 throw**（不 skip —— 静默跳过等于把判据关掉）。
 * @param relative - 仓库相对路径。
 * @returns 文件正文。
 */
function readRepo(relative: string): string {
  try {
    return readFileSync(resolve(REPO_ROOT, relative), 'utf8')
  } catch (error) {
    throw new Error(`对拍真源缺失：${relative}（缺失是失败，不是跳过；${String(error)}）`)
  }
}

const PLATFORM_EDGE_PATH = 'server/internal/wasmapp/edge/primitives.go'
const PLATFORM_LIMITS_PATH = 'server/internal/wasmapp/limits/limits.go'
const HOST_CACHE_PATH = 'packages/host/wasm-apps-host/src/cache.ts'
const HOST_HANDLER_PATH = 'packages/host/wasm-apps-host/src/handler.ts'

const PLATFORM_EDGE = readRepo(PLATFORM_EDGE_PATH)
const PLATFORM_LIMITS = readRepo(PLATFORM_LIMITS_PATH)
const HOST_CACHE = readRepo(HOST_CACHE_PATH)
const HOST_HANDLER = readRepo(HOST_HANDLER_PATH)

/**
 * 取 Go 函数的函数体（花括号配对；找不到函数即 throw）。
 * @param src - 源文件正文。
 * @param signature - 函数签名前缀（含 `func `）。
 * @returns 函数体（不含最外层花括号）。
 */
function goFuncBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  if (at < 0) throw new Error(`源码里找不到 ${signature}（改名了？对拍真源必须更新）`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`${signature} 的花括号不闭合`)
}

/** 平台侧某个 Go 函数里 `h.Set("<头名>", …)` 的头名 → 取值表达式。 */
function platformHeaderSets(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of body.matchAll(/h\.Set\(\s*"([^"]+)"\s*,\s*([^\n]+?)\)\s*$/gmu)) {
    out.set(m[1]!, m[2]!.trim())
  }
  if (out.size === 0) throw new Error('平台 ApplyHostSecurityHeaders 里解析不到任何 h.Set（形态变了？对拍必须 fail-loud）')
  return out
}

/** 平台 CSP 取值（`AppContentSecurityPolicy` 的返回串，逐段拼接）。 */
function platformCSP(): string {
  const body = goFuncBody(PLATFORM_LIMITS, 'func AppContentSecurityPolicy(')
  const parts = [...body.matchAll(/"([^"]*)"/gu)].map((m) => m[1]!)
  if (parts.length === 0) throw new Error('limits.go 的 AppContentSecurityPolicy 里解析不到字符串字面量')
  return parts.join('')
}

/** 平台 referrer 策略常量（`const HostReferrerPolicy = "…"`）。 */
function platformReferrerPolicy(): string {
  const m = /const\s+HostReferrerPolicy\s*=\s*"([^"]+)"/u.exec(PLATFORM_EDGE)
  if (m === null) throw new Error(`${PLATFORM_EDGE_PATH} 里找不到 HostReferrerPolicy 常量`)
  return m[1]!
}

/** 宿主 `securityHeaders()` 返回对象的头名 → 取值（CSP 由数组 `join('; ')` 还原）。 */
function hostSecurityHeaders(): Map<string, string> {
  const body = goFuncBody(HOST_CACHE, 'export function securityHeaders(): Record<string, string>')
  const out = new Map<string, string>()
  // CSP：数组字面量 → 逐段 join('; ')
  const csp = /'Content-Security-Policy':\s*\[([\s\S]*?)\]\.join\(';\s*'\)/u.exec(body)
  if (csp === null) throw new Error('宿主 securityHeaders() 里找不到 CSP 数组字面量（形态变了？对拍必须 fail-loud）')
  out.set(
    'Content-Security-Policy',
    [...csp[1]!.matchAll(/"([^"]*)"/gu)].map((m) => m[1]!).join('; '),
  )
  // 其余：单行 `'Name': 'value',`
  for (const m of body.matchAll(/'([A-Za-z-]+)':\s*'([^']*)'/gu)) {
    if (m[1] === 'Content-Security-Policy') continue
    out.set(m[1]!, m[2]!)
  }
  if (out.size < 2) throw new Error('宿主 securityHeaders() 里解析到的头太少了（形态变了？对拍必须 fail-loud）')
  return out
}

/** 平台侧写安全头的头名 → 取值表达式。 */
const PLATFORM_HEADERS = platformHeaderSets(
  goFuncBody(PLATFORM_EDGE, 'func ApplyHostSecurityHeaders(h http.Header, selfOrigin string)'),
)
/** 宿主侧写安全头的头名 → 取值。 */
const HOST_HEADERS = hostSecurityHeaders()

/**
 * **登记的关键头**：并集（平台 ∪ 宿主）必须覆盖这几项，且**来源必须与登记一致**。
 *
 * `platform` / `host` 两列是"这份源里有没有写这个头"的期望值 —— 与"哪一份更严"无关：
 * 记录的是**当前实现事实**，供读了本文件的人一眼看清并集是怎么拼出来的。
 */
const CRITICAL_HEADERS: Array<{ name: string; platform: boolean; host: boolean; why: string }> = [
  {
    name: 'Content-Security-Policy',
    platform: true,
    host: true,
    why: '两份都写：平台那份作用于所有响应（含 4xx/5xx），宿主那份只叠在缓存路径上（见应用点登记表）',
  },
  {
    name: 'X-Content-Type-Options',
    platform: true,
    host: true,
    why: '两份同值 nosniff；缺了它浏览器会按内容嗅探类型',
  },
  {
    name: 'X-Frame-Options',
    platform: true,
    host: true,
    why: '两份都 DENY（CSP 的 frame-ancestors 是第二道）',
  },
  {
    name: 'Referrer-Policy',
    platform: true,
    host: true,
    why:
      '**有意分叉**：平台 same-origin（no-referrer 会让应用同源写的 Origin 变 null ⇒ 全 403，2026-09-19 P0），' +
      '宿主 no-referrer（只作用于缓存命中/304 的静态子资源响应，子资源响应不改页面 referrer 策略）',
  },
  {
    name: 'Cache-Control',
    platform: true,
    host: false,
    why:
      '**只在平台侧**：宿主刻意不设（`securityHeaders()` 若自带 no-store，宿主自己的 put 会把平台响应判成 no-store 而永不缓存）' +
      ' —— 这条正是"并集"非冗余的证据',
  },
]

/** 头名大小写归一（HTTP 头名大小写不敏感）。 */
const norm = (name: string): string => name.toLowerCase()

/**
 * 应用点登记表：**跨端并集**里"谁在什么路径上真的写了这些头"。
 *
 * 计数是判据（不是注释）：宿主侧只在缓存路径出现 ⇒ 文档/接口路径的安全头**完全依赖平台**
 * （R4-B-18 的结论）。新增/删除应用点会红，逼着同步本表与结论。
 */
const PLATFORM_APPLY_SITES: Record<string, number> = {
  'server/internal/wasmapp/edge/gate.go': 1,
  'server/internal/wasmapp/appserver/static.go': 1,
  'server/internal/wasmapp/appserver/respond.go': 3,
}
const HOST_SECURITY_HEADER_SITES: Record<string, number> = {
  'packages/host/wasm-apps-host/src/cache.ts': 2, // 定义 1 处 + 缓存命中合并 1 处
  'packages/host/wasm-apps-host/src/handler.ts': 1, // 304 分支
}

/**
 * 统计某个符号**在代码行里**出现的次数（`Name(` 形态）。
 *
 * 逐行判注释（而不是全文剥注释）：本仓源码里有 `'/api/*'` 这类**含 `/*` 的字符串**，
 * 全文剥块注释会把后面的整段代码一起吞掉，计数直接变成 0（写这条时真实踩到过）。
 * @param src - 文件正文。
 * @param symbol - 符号名。
 * @returns 出现次数。
 */
const callSites = (src: string, symbol: string): number => {
  let count = 0
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    count += line.split(`${symbol}(`).length - 1
  }
  return count
}

describe('应用响应安全头：平台 ∪ 宿主 的并集对拍（R4-D-5，只读）', () => {
  it('并集覆盖登记的关键头，且每一项的来源与登记表逐项相同', () => {
    expect(PLATFORM_HEADERS.size, '平台侧必须解析出安全头（解析不到即失败）').toBeGreaterThan(0)
    expect(HOST_HEADERS.size, '宿主侧必须解析出安全头（解析不到即失败）').toBeGreaterThan(0)

    const platform = new Set([...PLATFORM_HEADERS.keys()].map(norm))
    const host = new Set([...HOST_HEADERS.keys()].map(norm))
    const union = new Set([...platform, ...host])

    for (const entry of CRITICAL_HEADERS) {
      const name = norm(entry.name)
      expect(union.has(name), `关键头 ${entry.name} 必须在平台与宿主的并集里（${entry.why}）`).toBe(true)
      expect(platform.has(name), `平台侧是否写 ${entry.name} 与登记表不符`).toBe(entry.platform)
      expect(host.has(name), `宿主侧是否写 ${entry.name} 与登记表不符`).toBe(entry.host)
    }
    // 并集必须**真的**是非冗余的：至少要有一项只出现在单侧，否则"并集覆盖"这句话没有内容。
    expect(
      CRITICAL_HEADERS.some((e) => e.platform !== e.host),
      '登记表里至少要有 1 项只在单侧出现（当前 = Cache-Control 只在平台侧）',
    ).toBe(true)
  })

  it('取值口径：nosniff / DENY 两侧同值，CSP 两份都必须锚定 default-src 与 frame-ancestors', () => {
    expect(PLATFORM_HEADERS.get('X-Content-Type-Options')).toBe('"nosniff"')
    expect(HOST_HEADERS.get('X-Content-Type-Options')).toBe('nosniff')
    expect(PLATFORM_HEADERS.get('X-Frame-Options')).toBe('"DENY"')
    expect(HOST_HEADERS.get('X-Frame-Options')).toBe('DENY')

    const policies = [
      ['平台 AppContentSecurityPolicy', platformCSP()],
      ['宿主 securityHeaders()', HOST_HEADERS.get('Content-Security-Policy') ?? ''],
    ] as const
    for (const [label, policy] of policies) {
      expect(policy, `${label} 的 CSP 不得为空`).not.toBe('')
      expect(policy, `${label} 的 CSP 必须锚定 default-src`).toContain('default-src')
      expect(policy, `${label} 的 CSP 必须禁止被嵌帧`).toContain("frame-ancestors 'none'")
      expect(policy, `${label} 的 CSP 必须禁止 base 改写`).toContain("base-uri 'none'")
    }
  })

  it('Referrer-Policy：平台 same-origin（**绝不能** no-referrer）、宿主 no-referrer（登记在案的分叉）', () => {
    const platform = platformReferrerPolicy()
    expect(PLATFORM_HEADERS.get('Referrer-Policy'), '平台头表必须引用 HostReferrerPolicy 常量').toContain('HostReferrerPolicy')
    expect(
      platform,
      '平台 referrer 策略必须是 same-origin：no-referrer 会把应用内同源写请求的 Origin 变成 null ⇒ 应用功能 100% 不可用（2026-09-19 P0）',
    ).toBe('same-origin')
    expect(HOST_HEADERS.get('Referrer-Policy'), '宿主那份是 no-referrer（只作用于缓存路径）').toBe('no-referrer')
    expect(
      HOST_HEADERS.get('Referrer-Policy'),
      '两份必须保持一致以外的关系被显式登记：宿主不得静默改成 same-origin（那会让缓存路径与平台路径的取值口径失去可追踪的差异）',
    ).not.toBe(platform)
  })

  it('应用点登记表：宿主只在缓存路径叠加（文档/接口完全依赖平台），计数变了即红', () => {
    expect(
      PLATFORM_EDGE.includes('func ApplyHostSecurityHeaders('),
      '平台必须仍有 ApplyHostSecurityHeaders 这唯一入口',
    ).toBe(true)
    for (const [file, expected] of Object.entries(PLATFORM_APPLY_SITES)) {
      const src = readRepo(file)
      expect(callSites(src, 'ApplyHostSecurityHeaders'), `${file} 的平台应用点数量与登记表不符`).toBe(expected)
    }
    for (const [file, expected] of Object.entries(HOST_SECURITY_HEADER_SITES)) {
      const src = readRepo(file)
      expect(callSites(src, 'securityHeaders'), `${file} 的宿主安全头应用点数量与登记表不符`).toBe(expected)
    }
    // 结论本身也要可判定：宿主在 handler 里**只有 1 处**（304 分支）—— 缓存命中那处在
    // cache.get() 内部合并。若哪天给文档/接口路径补上宿主安全头，这里会红，登记表与
    // "对文档/接口是死代码、真正兜底是平台 CSP" 的结论必须一起更新。
    expect(callSites(HOST_HANDLER, 'securityHeaders'), '宿主 handler 的应用点数（文档路径是否也叠加）变了').toBe(1)
  })
})
