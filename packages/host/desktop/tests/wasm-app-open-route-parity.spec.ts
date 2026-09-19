/**
 * 跨包路由对拍（R2-P0-1；5 路审计独立发现的同一个 P0）。
 *
 * **为什么必须有这条用例**：客户端的 `OPEN_APP_PATH` 与宿主注册的路由曾各写一份且不一致
 * （客户端 `/api/pico/wasm-apps/open`、宿主 `/api/pico/apps/wasm/app/open`），两端各自的
 * 单测还把**各自**的字面量钉成期望 ⇒ 双绿假象，而"点打开"必然 404。
 *
 * **为什么是源码级三方对拍**（而不是 import 常量）：客户端常量位于 client bundle 入口内，
 * 宿主包不应依赖客户端包的内部模块；而这条契约的失效形态就是"两个文件里的字面量漂移"，
 * 源码级断言恰好直接覆盖它，且不依赖任何构建产物（本仓既有同类源码级守护）。
 *
 * 三方 = 客户端源码 / 宿主源码 / 设计总纲 §5.2 的冻结路径。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

/** 客户端打的本机打开路径。 */
function clientOpenPath(): string {
  const source = read('packages/client/wasm-apps/src/client/open-app.ts')
  const match = /export const OPEN_APP_PATH = '([^']+)'/u.exec(source)
  expect(match, 'open-app.ts 里没有 OPEN_APP_PATH 字面量（契约已变？）').not.toBeNull()
  return match?.[1] ?? ''
}

/** 宿主注册的前缀与打开路径（open 由 `${PREFIX}/open` 合成）。 */
function hostRoutes(): { prefix: string; open: string } {
  const source = read('packages/host/wasm-apps-host/src/index.ts')
  const prefix = /export const WASM_APPS_LOCAL_PREFIX = '([^']+)'/u.exec(source)?.[1]
  const suffix = /export const WASM_APP_OPEN_ROUTE = `\$\{WASM_APPS_LOCAL_PREFIX\}([^`]+)`/u.exec(source)?.[1]
  expect(prefix, 'index.ts 里没有 WASM_APPS_LOCAL_PREFIX').toBeTruthy()
  expect(suffix, 'index.ts 里没有 WASM_APP_OPEN_ROUTE（应为 ${WASM_APPS_LOCAL_PREFIX} 合成）').toBeTruthy()
  return { prefix: prefix ?? '', open: `${prefix ?? ''}${suffix ?? ''}` }
}

describe('wasm 应用本机打开路由：跨包一致性', () => {
  it('客户端 OPEN_APP_PATH === 宿主 WASM_APP_OPEN_ROUTE（逐字）', () => {
    expect(clientOpenPath()).toBe(hostRoutes().open)
  })

  it('宿主路由挂在前缀之下（前缀注册 + handler 内按 pathname 分发）', () => {
    const { prefix, open } = hostRoutes()
    expect(prefix.startsWith('/api/pico/')).toBe(true)
    expect(open.startsWith(`${prefix}/`)).toBe(true)
    const source = read('packages/host/wasm-apps-host/src/index.ts')
    // R1 冻结（§22.2）：**所有**本机路由经唯一 seam 注册；`ctx.webServer` 只允许出现在
    // seam 模块里 —— 这条断言把"未来某人又在 index.ts 里直接注册一条路由"变成红灯。
    expect(source).toContain('createHostRequestSurface(ctx, {')
    expect(source).toContain('prefix: WASM_APPS_LOCAL_PREFIX')
    expect(source).not.toContain('ctx.webServer')
    const seam = read('packages/host/wasm-apps-host/src/host-request.ts')
    // 前缀注册在 seam 内：用 prefix 常量而不是 open 路径（否则未知子路径无处分发）。
    expect(seam).toMatch(/kind: 'prefix',\s*\n\s*path: options\.prefix/u)
  })

  it('设计总纲 §5.2 冻结的路径与两端一致（文档也是真源之一）', () => {
    const doc = read('docs/planning/2026-09-19-wasm-client-only-design.md')
    expect(doc).toContain(`POST ${clientOpenPath()}`)
  })
})

/**
 * 渠道 scheme 参数化的三终点对拍（R2S-9 / CHN-3 / UX-2 / R2I-15；主控 2026-09-19 要求）。
 *
 * 应用源 scheme（`<scheme>://<app_id>`）有**三个消费终点**，任何一处写死官方值 = 渠道
 * 客户端的应用打不开或跨渠道串味：
 *   ① `main.ts` 的**启动期特权注册**（必须在 `app.whenReady()` 之前，取值来自渠道包）；
 *   ② profile 行注入的 `config.appOriginScheme`（插件运行期用它合成 Origin/URL）；
 *   ③ 本机只读路由 `GET /api/pico/wasm-apps/channel` 返回给渲染层的 `appOriginScheme`。
 *
 * 这三条在这里做**源码级**对拍（运行期断言见 `packages/host/wasm-apps-host/src/index.spec.ts`
 * 的 channel 路由用例与桌面 `profile.spec.ts` 的注入用例）。
 */
describe('应用源 scheme 参数化：三个终点同源（§10/§16.1）', () => {
  it('客户端渲染层不再硬编码应用 scheme（只有渠道注入的运行期取值）', () => {
    const source = read('packages/client/wasm-apps/src/client/open-app.ts')
    expect(source).not.toMatch(/['"`]picoaide-app:['"`]/u)
    expect(source).not.toMatch(/APP_PROTOCOL = ['"`]/u)
  })

  it('桌面壳在模块作用域取渠道值，且特权注册早于 app.whenReady()（取值时序冻结）', () => {
    const source = read('packages/host/desktop/src/main.ts')
    // ① 取值来自渠道包（渠道字段名逐字）而不是常量。
    expect(source).toContain('CHANNEL_PROFILE?.appOriginScheme')
    // 模块作用域常量（不是函数内的局部变量）：registerSchemesAsPrivileged 是启动期 API。
    expect(source).toMatch(/^const APP_ORIGIN_SCHEME = CHANNEL_PROFILE\?\.appOriginScheme/mu)
    // ② 调用点必须在 `app.whenReady(` 之前 —— 晚于 ready 会静默无效（契约 §7.2/CLI-8）。
    const registerAt = source.indexOf('registerAppScheme(APP_ORIGIN_SCHEME)')
    // 用 `await app.whenReady()`（真实调用点）：文件里的注释也会出现这个字样，
    // 拿裸 `app.whenReady(` 比位置会与注释比大小，是假判据。
    const readyAt = source.indexOf('await app.whenReady()')
    expect(registerAt, 'main.ts 必须调用 registerAppScheme(APP_ORIGIN_SCHEME)').toBeGreaterThan(-1)
    expect(readyAt, 'main.ts 必须有 await app.whenReady()').toBeGreaterThan(-1)
    expect(registerAt).toBeLessThan(readyAt)
    // ③ 不得写死官方 scheme 字面量（缺省值只允许来自 desktop-channel.ts 的常量）。
    expect(source).not.toMatch(/['"`]picoaide-app['"`]/u)
  })

  it('profile 注入的 config.appOriginScheme 与 main.ts / 渠道字段同源', () => {
    const profile = read('packages/host/desktop/src/profile.ts')
    // 同一个渠道字段、同一个缺省常量（任一处写死官方值即红）。
    expect(profile).toContain('appOriginScheme: channelProfile?.appOriginScheme ?? DEFAULT_APP_ORIGIN_SCHEME')
    const channel = read('packages/host/desktop/src/desktop-channel.ts')
    // 字段名逐字（渠道仓写的是 desktop.app_origin_scheme）。
    expect(channel).toContain('desktopRecord.app_origin_scheme')
    // 缺省值只有一个来源：DEFAULT_APP_ORIGIN_SCHEME（官方构建），且渠道包字段缺失时 fail-loud。
    expect(channel).toMatch(/export const DEFAULT_APP_ORIGIN_SCHEME = 'picoaide-app'/u)
    expect(channel).toContain('resolveAppOriginScheme')
    const host = read('packages/host/wasm-apps-host/src/index.ts')
    // 宿主只读路由把同一个 config 值回给渲染层（不是自己重新推导）。
    expect(host).toContain('appOriginScheme: scheme')
    expect(host).toContain('WASM_APP_CHANNEL_ROUTE')
    const client = read('packages/client/wasm-apps/src/client/channel-seam.ts')
    // 渲染层经该路由取值（L3 的消费面；路径字面量必须一致）。
    expect(client).toContain('/api/pico/wasm-apps/channel')
  })

  it('浏览器面按 surface 分流，且不含任何写死的渠道 scheme（CHN-3）', () => {
    for (const file of ['guard.ts', 'tools.ts', 'shell-pages.ts', 'credential-site.ts']) {
      const source = read(`packages/host/browser/src/${file}`)
      expect(source, `${file} 不得写死渠道 scheme`).not.toMatch(/picoaide-app/u)
    }
    const guard = read('packages/host/browser/src/guard.ts')
    // 浏览器标签不得导航到应用 scheme（R2-P0-2）：默认 surface 是 browser-tab。
    expect(guard).toContain("surface: NavigationSurface = { kind: 'browser-tab' }")
    expect(guard).toMatch(/const ALLOWED_SCHEMES = new Set\(\['http:', 'https:', 'about:'\]\)/u)
  })
})

/**
 * 接缝 J13：异渠道深链事件的**事件名两端逐字一致**（宿主 emit / 客户端订阅）。
 *
 * 为什么必须对拍：名字不一致时 toast 永远不出现，而两端各自的测试都不会红
 * （各自只测自己那一半）—— 本仓历史上 5 个 P0 的同一失效模式。
 */
describe('异渠道深链事件名（J13）', () => {
  it('宿主广播名 === 客户端订阅名（逐字）', () => {
    const host = read('packages/host/wasm-apps-host/src/index.ts')
    const eventName = /export const WASM_APP_DEEP_LINK_FOREIGN_EVENT = '([^']+)'/u.exec(host)?.[1]
    expect(eventName, '宿主必须导出 WASM_APP_DEEP_LINK_FOREIGN_EVENT 字面量').toBe('pico/wasm-app-deep-link-foreign')
    // 客户端半边（L3）必须订阅同一个字面量（它把它定义在 `app-toast.tsx`，
    // index.ts 引用常量 —— 两处都查，避免"定义对了但订阅了别的名字"）。
    const clientToast = read('packages/client/wasm-apps/src/client/app-toast.tsx')
    expect(clientToast).toContain(`'${eventName ?? ''}'`)
    const clientIndex = read('packages/client/wasm-apps/src/client/index.ts')
    expect(clientIndex).toContain('APP_FOREIGN_DEEP_LINK_EVENT')
    // 宿主确实 emit 了它（不是只定义）。
    expect(host).toContain('ctx.emit(WASM_APP_DEEP_LINK_FOREIGN_EVENT')
  })
})
