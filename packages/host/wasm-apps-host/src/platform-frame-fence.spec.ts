/**
 * 「子框架放行 http(s)」这条宿主判据的**依赖对拍**（2026-09-20 审计 P2-3）。
 *
 * 背景：`windows.ts` 的 {@link classifyAppWindowNavigation} 对**子框架**放行 http(s)
 * 内容（只在 `isMainFrame === false` 时），因为"应用里嵌一个第三方 iframe"不该让整页
 * 失效；真正拦住它的是**平台侧**给每个应用文档强制的两件头：
 *
 *   `default-src 'none'`（CSP3 的回退链 `frame-src` → `child-src` → `default-src`，
 *   所以它等价于"不许嵌任何东西"）+ `frame-ancestors 'none'` / `X-Frame-Options: DENY`。
 *
 * 这条依赖是**跨包的**：宿主判据在 `packages/host/wasm-apps-host`，而强制点在
 * `server/internal/wasmapp`（Go）。只测自己那一半时，"平台哪天把 CSP 放松成
 * `default-src *`"不会有任何用例变红，而放行子框架的理由就不成立了 —— 所以这里
 * 直接对服务端源码/常量做对拍（形态与 `header-spec-parity.spec.ts` 对拍生成物一致）。
 *
 * 变异：把 `limits.go` 的 CSP 里的 `frame-ancestors 'none'` 删掉、或把
 * `primitives.go` 的 `X-Frame-Options` 去掉 ⇒ 对应用例必红。
 *
 * 另一条**认账**（P1-1 的背景，写在这里免得下次有人误以为"平台写不出 Location 所以
 * 导航闸门不用管重定向"）：平台的响应头白名单 `AppResponseHeaderAllowlist` **不含**
 * `location`，所以今天平台自己发不出 302；但那是**另一处实现**的偶然兜底 —— 客户端的
 * `responseHeadersOf` 并不丢 `location`，一旦平台为登录跳转/反代/静态回退写出它，
 * 窗口立刻可被换走。因此闸门必须自己覆盖重定向（`will-redirect`）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '../../../..')

/** 读服务端源码（**必须存在**：缺失是失败，不是跳过 —— 静默跳过等于把判据关掉）。 */
function serverSource(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8')
}

describe('子框架放行的平台侧依赖（P2-3 认账的一半）', () => {
  it('平台强制给应用文档写 CSP：default-src \'none\' + frame-ancestors \'none\'', () => {
    const source = serverSource('server/internal/wasmapp/limits/limits.go')
    const body = /func AppContentSecurityPolicy\(selfOrigin string\) string \{([\s\S]*?)\n\}/.exec(source)?.[1]
    expect(body, 'AppContentSecurityPolicy 必须还在（它没了 ⇒ 应用文档就没有 CSP 了）').toBeDefined()
    expect(body).toContain("default-src 'none'")
    // CSP3 的 worker/frame 回退链都落在 default-src 上：`default-src 'none'` 同时关掉
    // `frame-src`/`child-src` ⇒ 应用**嵌不进任何东西**（这正是宿主放行 http(s) 子框架的前提）。
    expect(body).toContain("frame-ancestors 'none'")
  })

  it('平台强制写 X-Frame-Options: DENY，并把它列为宿主独占头（应用改不了）', () => {
    const primitives = serverSource('server/internal/wasmapp/edge/primitives.go')
    expect(primitives).toMatch(/h\.Set\("X-Frame-Options", "DENY"\)/)
    // 宿主独占：应用自带的同名头会被剥掉（含 4xx/5xx），否则应用能自己把 DENY 改成 ALLOWALL。
    const respond = serverSource('server/internal/wasmapp/appserver/respond.go')
    const owned = /var hostOwnedResponseHeaders = map\[string\]struct\{\}\{([\s\S]*?)\n\}/.exec(respond)?.[1]
    expect(owned, 'hostOwnedResponseHeaders 必须还在').toBeDefined()
    expect(owned).toContain('"x-frame-options"')
    expect(owned).toContain('"content-security-policy"')
  })

  it('认账记录：平台的响应头白名单不含 location（所以今天发不出 302 —— 但闸门不能指望它）', () => {
    const limits = serverSource('server/internal/wasmapp/limits/limits.go')
    const allowlist = /var AppResponseHeaderAllowlist = \[\]string\{([\s\S]*?)\n\}/.exec(limits)?.[1]
    expect(allowlist, 'AppResponseHeaderAllowlist 必须还在').toBeDefined()
    // 不含 location 属**平台侧**的偶然兜底；宿主的 will-redirect 闸门是另一道、
    // 且是唯一与"平台将来写出 Location"无关的那道（`responseHeadersOf` 不丢 location）。
    expect(allowlist).not.toContain('"location"')
  })

  it('宿主确实没有丢 location（所以闸门必须自己覆盖重定向，不能指望响应头被剥掉）', () => {
    const protocol = readFileSync(join(__dirname, 'app-protocol.ts'), 'utf8')
    const dropped = /const HOP_BY_HOP[\s\S]{0,400}?\]/u.exec(protocol)?.[0] ?? ''
    // 逐跳头清单里不得出现 location（出现就等于"顺手把重定向抹平"—— 那会同时废掉
    // 应用自己的同 app 跳转，而 P1-1 的要求是同 app 的 302 **放行**）。
    expect(dropped).not.toContain('location')
    expect(protocol).toContain("'set-cookie'")
  })
})
