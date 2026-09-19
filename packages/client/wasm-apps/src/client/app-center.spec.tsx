/**
 * 应用中心客户端面的回归测试（R34 / R36 / R38 + 入口打开策略）。
 *
 * 三条断言口径（对应设计基线的三条硬约定）：
 *  - **R34 可达**：侧边栏入口渲染成真正的 `<button type="button">`、带可见文案与
 *    `aria-label`，且 markup 里没有任何隐藏手段（`hidden` / `display:none` /
 *    `visibility:hidden`）——"组件存在但用户点不到"是本仓有明确教训的假绿形态；
 *  - **目录展示全部应用**（2026-09-18 拍板）：面板**原样渲染**服务端给的数组 ——
 *    不按可见性过滤（`visible` 字段已删除）、不按访问级别过滤（白名单应用也列出来）、
 *    下架的条目也留着（标"已下架"）；每条目标出服务端下发的 `access`；
 *  - **R36 不显示额度**：渲染结果里不得出现额度/用量/余额字段或字样。
 *
 * ---- 变异验证（改回危险实现时哪条用例会红）----
 *
 *   - 面板里加一行 `item.quotaRemaining`（或任何额度/用量字段）
 *     → 「不得出现额度/用量字段」红；
 *   - `parseCatalog` 里加 `if (row.visible === false) continue`（按旧字段过滤）
 *     → 「目录一律展示全部应用」红；
 *   - `parseCatalog` 里加 `if (row.access !== 'public') continue`（按访问级别过滤）
 *     → 同上红；
 *   - `parseCatalog` 里加 `if (row.enabled === false) continue`（下架的直接消失）
 *     → 同上红 + 「已下架标状态」红；
 *   - `resolveAccess` 的第一段换成旧语义（只看 `login_required`）
 *     → 「服务端下发 access 时原样采用」红；
 *   - 入口按钮改成 `<div onClick>` 或加 `hidden`/`display:none`
 *     → 「入口是真实按钮」红；
 *   - `openAppEntry` 改回"先开内置浏览器标签、失败再 window.open"（2026-09-19 前的
 *     实现）→ 「打开只打本机路由」与「没有系统浏览器兜底」红；
 *   - `openAppEntry` 不校验本机返回的协议 URL（谁给什么都当成功）⇒「返回别的应用/
 *     别的 scheme ⇒ 形状错误」红；
 *   - `pageHoldsWriteProof` 放行 `picoaide-app:` / `file:` ⇒「缺证明时不发请求」红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AppCenterBody, accessBadge, parseCatalog, resolveAccess, type AppCenterItem } from './AppCenterPanel.tsx'
import { AppCenterTrigger } from './AppCenterTrigger.tsx'
import { en, setActiveLocale, t, zh } from './locales.ts'
import { ACCESS_MODES, WRITABLE_ACCESS_MODES } from './appcfg-contract.ts'
import { OPEN_APP_PATH, openAppEntry, pageHoldsWriteProof, parseAppProtocolURL, type OpenAppDeps } from './open-app.ts'
import { OFFICIAL_APP_SHARE_SCHEME, appShareLink, setAppShareScheme } from './deep-link.ts'
import { APP_CHANNEL_PATH, OFFICIAL_APP_ORIGIN_SCHEME, loadAppChannel, parseAppChannel, refreshAppChannel, setAppChannel, type AppChannel } from './channel-seam.ts'
import { HOST_PROOF_HEADER, HOST_PROOF_PATH, clearHostProofToken } from './host-proof.ts'

/**
 * 官方渠道 fixture（值来自渠道包 `channel.json` 的官方声明；**产品代码里没有**这两个
 * scheme 字面量 —— 用例需要的是"某个具体渠道"，用 fixture 常量而不是把 scheme 抄进断言）。
 */
const APP_SCHEME = 'picoaide-app'
const DEEP_LINK_SCHEME = 'picoaide'
const OFFICIAL_CHANNEL: AppChannel = { appOriginScheme: APP_SCHEME, deepLinkScheme: DEEP_LINK_SCHEME, productName: 'PicoAide' }

/** 一条应用协议 URL（scheme 从 fixture 来，不在用例里写死产品常量）。 */
const appURL = (appId: string, path = '/'): string => `${APP_SCHEME}://${appId}${path}`

afterEach(() => {
  setActiveLocale('zh')
  // 分享 scheme、渠道参数与持有性令牌都是模块级注入点：用例之间必须复位，
  // 否则一条用例的注入会污染下一条（令牌还会让"引导"这一步被跳过）。
  setAppShareScheme(null)
  setAppChannel(null)
  clearHostProofToken()
})

/** 额度/用量词表（R36：这一页一个都不许有）。 */
const QUOTA_PATTERN = /quota|balance|budget|usage|credit|额度|用量|余额|计费/iu

const ITEMS: AppCenterItem[] = [
  { appId: 'shared-notes', title: '共享便签', description: '值班记录与交接备注', responsible: 'alice', access: 'login', enabled: true, currentVersion: '1.2.0', isOwner: true },
  { appId: 'roster', title: '值班表', description: '', responsible: 'bob', access: 'whitelist', enabled: true, currentVersion: '2.0.0', isOwner: false },
]

describe('应用中心字典（zh 是 key 真源，en 必须对齐）', () => {
  it('zh/en key 集合一致，且英文术语是 App Center', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(en['appCenter.title']).toBe('App Center')
    expect(zh['appCenter.title']).toBe('应用中心')
  })

  it('两种语言下都不含额度/用量词（字典里连词都没有）', () => {
    expect(JSON.stringify(zh)).not.toMatch(QUOTA_PATTERN)
    expect(JSON.stringify(en)).not.toMatch(QUOTA_PATTERN)
  })

  /**
   * P2-9 第二条：文案里的 `**` 在普通文本节点里会**原样显示成星号**（这些串直接进
   * `{t('…')}`、没有任何 markdown 渲染）。旧字典里 `whitelist` 帮助文字与
   * `declarationsHint` 都带 `**`，用户在界面上看到的就是 `平台**不比对名单**`。
   *
   * 变异验证：把 `**` 加回任意一条文案 ⇒ 本条红。
   */
  it('字典里没有 markdown 强调标记（普通文本节点会把 ** 原样显示出来）', () => {
    for (const [locale, dict] of [['zh', zh], ['en', en]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${locale} 的 ${key} 含 ** —— 界面上会显示成星号`).not.toContain('**')
      }
    }
  })
})

describe('目录解析：只归一化，不新增筛选规则（展示全部应用）', () => {
  it('把服务端行映射成本地模型（title 缺失回落 app_id）', () => {
    const items = parseCatalog({
      apps: [
        { app_id: 'a', title: 'A 工具', description: '一句话', responsible: 'alice', entry_url: 'https://a.apps.example.com', access: 'public', enabled: true },
        { app_id: 'b', entry_url: '/b' },
      ],
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      appId: 'a', title: 'A 工具', description: '一句话', responsible: 'alice', access: 'login', enabled: true,
      // P1-4 / P1-3：服务端没下发就**留空 / false**，不编造版本号、也不假装是发布者。
      currentVersion: '', isOwner: false,
    })
    // 2026-09-19：`entry_url` 已不在契约里（冻结契约 §4.5）—— 服务端仍带着它时
    // 客户端**不认识**：既不进条目模型，也不被渲染成任何链接。
    expect(items[0]).not.toHaveProperty('entryURL')
    expect(JSON.stringify(items[0])).not.toContain('apps.example.com')
    expect(items[1]!.title).toBe('b')
    expect(items[1]!.description).toBe('')
    expect(items[1]!.responsible).toBe('')
    // `access` 缺席 ⇒ 缺省模式 login（不放大成 public）；`enabled` 缺席 ⇒ 视为上架。
    expect(items[1]!.access).toBe('login')
    expect(items[1]!.enabled).toBe(true)
  })

  it('目录一律展示全部应用：不按 visible 过滤、不按访问级别过滤、下架的也留着', () => {
    const items = parseCatalog({
      apps: [
        { app_id: 'listed', visible: true },
        // 旧字段已从契约删除：必须被**忽略**，而不是被拿来当筛选条件。
        { app_id: 'unlisted', visible: false },
        // 白名单应用照样列出来（点开由应用自己判并返回它的 403 页）。
        { app_id: 'locked', access: 'whitelist', whitelist: ['alice'] },
        // 已下架也列出来，只标状态。
        { app_id: 'gone', access: 'public', enabled: false },
      ],
    })
    expect(items.map(i => i.appId)).toEqual(['listed', 'unlisted', 'locked', 'gone'])
    expect(items.find(i => i.appId === 'gone')!.enabled).toBe(false)
  })

  it('服务端仍下发 entry_url 时也不渲染任何链接（字段已从契约删除）', () => {
    const items = parseCatalog({ apps: [{ app_id: 'legacy', title: '旧行', entry_url: 'https://legacy.apps.example.com/' }] })
    expect(items).toHaveLength(1)
    const html = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items }} onRetry={() => {}} />)
    expect(html).toContain('旧行')
    expect(html).not.toContain('legacy.apps.example.com')
    expect(html).not.toContain('pico-app-center-entry')
    expect(html).not.toContain('入口')
  })

  it('结构不对时不抛错（返回空数组 ⇒ 面板显示空态）', () => {
    expect(parseCatalog(null)).toEqual([])
    expect(parseCatalog({})).toEqual([])
    expect(parseCatalog({ apps: 'nope' })).toEqual([])
    expect(parseCatalog({ apps: [null, 3, { title: '没有 app_id' }] })).toEqual([])
  })
})

describe('访问级别：写侧二选一，历史 public 读作 login（冻结契约 §4.4）', () => {
  it('服务端下发 login / whitelist 时原样采用（大小写与空白不宽容）', () => {
    expect(resolveAccess({ access: 'login' })).toBe('login')
    expect(resolveAccess({ access: 'whitelist' })).toBe('whitelist')
    // access 优先于旧字段。
    expect(resolveAccess({ access: 'whitelist', login_required: false })).toBe('whitelist')
    expect(resolveAccess({ access: 'login', login_required: false, whitelist: ['alice'] })).toBe('login')
  })

  it('历史 public（存量行/老服务端）读作 login —— 界面不再声称"公开/匿名可用"', () => {
    // 2026-09-19（冻结契约 §4.4）：匿名面已删除，服务端读取侧把 public 收敛成 login；
    // 客户端这一侧同一口径，否则用户会以为应用可以不登录打开。
    expect(resolveAccess({ access: 'public' })).toBe('login')
    expect(resolveAccess({ access: 'public', login_required: false })).toBe('login')
    // 未知取值同样不放大权限（回落最保守的缺省）。
    expect(resolveAccess({ access: 'PUBLIC' })).toBe('login')
    expect(resolveAccess({ access: 42 })).toBe('login')
    // 独立审计 2026-09-18 P2：`access` **存在但不认识**时不得落进旧字段分支 ——
    // 那会把"服务端下发了我们还不认识的新模式"翻译成别的语义（当时是 public）。
    expect(resolveAccess({ access: 'org', login_required: false })).toBe('login')
    expect(resolveAccess({ access: 'org', login_required: false, whitelist: ['alice'] })).toBe('login')
    expect(resolveAccess({ access: '', login_required: false })).toBe('login')
  })

  it('过渡兼容：access 缺席时按旧的 login_required + whitelist 回落读取（匿名面已不存在）', () => {
    // login_required === false 是旧语义的"匿名可用" —— 那条语义已经删除 ⇒ 读作 login。
    expect(resolveAccess({ login_required: false })).toBe('login')
    expect(resolveAccess({ login_required: true })).toBe('login')
    expect(resolveAccess({ login_required: true, whitelist: ['alice'] })).toBe('whitelist')
    // login_required 缺席 + 有名单 ⇒ 白名单；都没有 ⇒ 缺省 login。
    expect(resolveAccess({ whitelist: ['alice'] })).toBe('whitelist')
    expect(resolveAccess({ whitelist: [] })).toBe('login')
    expect(resolveAccess({})).toBe('login')
  })

  it('空的/非法的 whitelist 旧字段不算名单', () => {
    expect(resolveAccess({ whitelist: 'alice' })).toBe('login')
    expect(resolveAccess({ whitelist: null })).toBe('login')
  })

  it('写侧取值集合 ⊆ 服务端取值表镜像，且不含 public', () => {
    // 服务端字段表（appcfg.json 的 access_values）仍是三值（读取侧兼容存量 public），
    // 而客户端写侧只有 login | whitelist —— 这条把两者的关系钉住。
    expect([...WRITABLE_ACCESS_MODES]).toEqual(['login', 'whitelist'])
    for (const mode of WRITABLE_ACCESS_MODES) expect([...ACCESS_MODES]).toContain(mode)
    expect([...WRITABLE_ACCESS_MODES]).not.toContain('public')
  })
})

describe('目录渲染（R34 / R36）', () => {
  it('渲染名称 / 一句话说明 / 负责人 / 当前版本，且没有任何入口链接', () => {
    const html = renderToStaticMarkup(
      <AppCenterBody state={{ kind: 'ready', items: ITEMS }} onRetry={() => {}} />,
    )
    expect(html).toContain('共享便签')
    expect(html).toContain('值班记录与交接备注')
    expect(html).toContain('负责人: alice')
    // 2026-09-19：目录行不再有入口链接（契约 §4.5；应用只在客户端内以协议打开）。
    expect(html).not.toContain('pico-app-center-entry')
    expect(html).not.toContain('apps.example.com')
    expect(html).toContain('值班表')
    // 每条目一个"打开"按钮（真实 button，不是 div）。
    expect(html.match(/<button type="button"/gu)).toHaveLength(2)
  })

  it('每条目标出访问级别（登录后使用 / 仅白名单；历史 public 渲染成登录后使用）', () => {
    const html = renderToStaticMarkup(
      <AppCenterBody state={{ kind: 'ready', items: ITEMS }} onRetry={() => {}} />,
    )
    expect(html).toContain('data-role="access-level"')
    expect(html).toContain('data-access="login"')
    expect(html).toContain('data-access="whitelist"')
    expect(html).toContain(accessBadge('login'))
    expect(html).toContain(accessBadge('whitelist'))
    // 历史 public 行（服务端仍可能下发存量取值）不得渲染出"公开"。
    const legacy = parseCatalog({ apps: [{ app_id: 'old', title: '存量应用', access: 'public' }] })
    const legacyHtml = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items: legacy }} onRetry={() => {}} />)
    expect(legacyHtml).toContain('data-access="login"')
    expect(legacyHtml).not.toContain('公开')
    expect(legacyHtml).not.toContain('data-access="public"')
    // 访问级别只说明"谁能用"，**不隐藏任何行**：两条都渲染。
    expect(html).toContain('共享便签')
    expect(html).toContain('值班表')
  })

  it('下架的条目仍然展示，标出"已下架"且打开按钮禁用（不假装不存在）', () => {
    const items: AppCenterItem[] = [
      { appId: 'gone', title: '已下线的工具', description: '', responsible: '', access: 'login', enabled: false, currentVersion: '', isOwner: false },
    ]
    const html = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items }} onRetry={() => {}} />)
    expect(html).toContain('已下线的工具')
    expect(html).toContain('data-role="app-disabled"')
    expect(html).toContain('已下架')
    // 打开按钮被禁用（disabled 是真实属性，不是只有视觉变灰）。
    expect(html).toMatch(/<button[^>]*disabled/u)
    // 上架的条目没有这个徽标。
    const listed = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items: ITEMS }} onRetry={() => {}} />)
    expect(listed).not.toContain('data-role="app-disabled"')
    expect(listed).not.toContain('已下架')
  })

  it('空态给出可照做的下一步（不是空白页）', () => {
    const html = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items: [] }} onRetry={() => {}} />)
    expect(html).toContain('还没有可用的应用')
    expect(html).toContain('AI 会帮你做出来并发布到这里')
    expect(html).not.toContain('共享便签')
  })

  it('加载中与失败态各自可读，失败态有重试', () => {
    const loading = renderToStaticMarkup(<AppCenterBody state={{ kind: 'loading' }} onRetry={() => {}} />)
    expect(loading).toContain('正在加载应用')
    const failed = renderToStaticMarkup(<AppCenterBody state={{ kind: 'error', error: { code: 'GATEWAY_UNAVAILABLE', message: '加载失败 (HTTP 502)', hints: [] } }} onRetry={() => {}} />)
    expect(failed).toContain('加载失败 (HTTP 502)')
    expect(failed).toContain('重试')
  })

  it('渲染结果里没有任何额度/用量字段或字样（R36，两种语言都查）', () => {
    for (const locale of ['zh', 'en']) {
      setActiveLocale(locale)
      const list = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items: ITEMS }} onRetry={() => {}} />)
      const empty = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items: [] }} onRetry={() => {}} />)
      const error = renderToStaticMarkup(<AppCenterBody state={{ kind: 'error', error: { code: 'INTERNAL', message: 'x', hints: [] } }} onRetry={() => {}} />)
      for (const html of [list, empty, error]) expect(html).not.toMatch(QUOTA_PATTERN)
    }
  })

  /**
   * §19 Q6 的 fail-closed：**未注入渠道 scheme ⇒ 不产出链接**。
   *
   * 变异验证：把 `appShareScheme()` 改回"未注入时回落官方 scheme"（旧实现）⇒ 本条红：
   * 品牌渠道一旦漏注入就会分享出一条在自己客户端里打不开的官方链接。
   */
  it('分享链接只在拿到渠道 scheme 时才产出（未注入 ⇒ null，不回落官方值）', () => {
    expect(appShareLink('roster')).toBeNull()
    expect(appShareLink('roster', null)).toBeNull()
    setAppShareScheme(DEEP_LINK_SCHEME)
    expect(appShareLink('roster')).toBe(`${DEEP_LINK_SCHEME}://app/roster`)
    // 换渠道 ⇒ 换 scheme（品牌渠道的链接在官方客户端里打不开）。
    setAppShareScheme('mokahr-harness')
    expect(appShareLink('roster')).toBe('mokahr-harness://app/roster')
    // 畸形 scheme 不采纳 ⇒ 回到"没有链接"（不是回落官方值）。
    setAppShareScheme('Not A Scheme://')
    expect(appShareLink('roster')).toBeNull()
    expect(appShareLink('roster/extra')).toBeNull()
    expect(appShareLink('')).toBeNull()
  })

  /**
   * **官方渠道值的跨端对拍**（R1-L3-10：此前只有一句"跨端对拍"的声称，没有用例）。
   *
   * 两处都声明了官方渠道的 scheme：桌面壳的回落常量
   * （`packages/host/desktop/src/desktop-channel.ts`，渠道包 official/beta 未显式声明时
   * 用它）与客户端这两个参照常量。它们漂移 ⇒ 官方构建里"打开/分享"用的 scheme 与
   * 渠道解析认的不是同一个。
   *
   * 变异验证：把任一常量改一个字符（或改 `desktop-channel.ts` 的默认值）⇒ 本条红。
   */
  it('官方渠道 scheme 与桌面壳的默认值逐字一致（OFFICIAL_* ↔ desktop-channel.ts）', () => {
    const source = readFileSync(new URL('../../../../host/desktop/src/desktop-channel.ts', import.meta.url), 'utf8')
    const deepLink = /export const DEFAULT_DEEP_LINK_SCHEME = '([^']+)'/u.exec(source)?.[1]
    const origin = /export const DEFAULT_APP_ORIGIN_SCHEME = '([^']+)'/u.exec(source)?.[1]
    expect(deepLink, 'desktop-channel.ts 里应有 DEFAULT_DEEP_LINK_SCHEME').toBeTruthy()
    expect(origin, 'desktop-channel.ts 里应有 DEFAULT_APP_ORIGIN_SCHEME').toBeTruthy()
    expect(OFFICIAL_APP_SHARE_SCHEME).toBe(deepLink)
    expect(OFFICIAL_APP_ORIGIN_SCHEME).toBe(origin)
    // 客户端 fixture 也必须与真源一致（fixture 漂移会让上面所有 scheme 用例失去意义）。
    expect(APP_SCHEME).toBe(origin)
    expect(DEEP_LINK_SCHEME).toBe(deepLink)
  })

  // 头名与引导路径的**跨端对拍**已移到它的归属地：`host-proof.spec.ts`
  // （「跨端对拍：头名与引导路径 vs 宿主 seam 源码」，含"宿主改一个字即红"的自证）。
  // 不在两处各留一份：两份对拍迟早给出不同答案。

  /**
   * **R2-X-1 第 6 条**：拿不到渠道参数的两种原因必须分档（证明问题 ≠ 配置问题）。
   *
   * 变异验证：把 `loadAppChannel` 的 401 分支与"200 但没有 scheme"分支合并成同一个
   * reason ⇒ 本条两条用例中的一条必红。
   */
  it('渠道路由 401 proof_* ⇒ host-proof-rejected（不是"配置问题"）', async () => {
    const result = await loadAppChannel({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === HOST_PROOF_PATH) {
          return new Response(JSON.stringify({ proof: 'p', expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        // 证明被拒（重取一次后仍然如此）。
        return new Response(JSON.stringify({ error: 'proof_required' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    expect(result.channel).toBeNull()
    expect(result.failure?.reason).toBe('host-proof-rejected')
    expect(result.failure?.status).toBe(401)
  })

  it('渠道路由 200 但没有可用 scheme ⇒ scheme-not-configured（配置问题）', async () => {
    const result = await loadAppChannel({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === HOST_PROOF_PATH) {
          return new Response(JSON.stringify({ proof: 'p', expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ appOriginScheme: '', deepLinkScheme: 'picoaide', productName: 'P' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    expect(result.channel).toBeNull()
    expect(result.failure?.reason).toBe('scheme-not-configured')
  })

  it('引导端点不可达 ⇒ host-proof-unavailable（且**没有**调渠道路由）', async () => {
    const calls: string[] = []
    const result = await loadAppChannel({
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        throw new TypeError('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(result.failure?.reason).toBe('host-proof-unavailable')
    expect(calls).toEqual([HOST_PROOF_PATH])
  })

  it('渠道参数解析：形状/保留名单/两 scheme 相同都拒（fail-closed）', () => {
    expect(parseAppChannel({ appOriginScheme: APP_SCHEME, deepLinkScheme: DEEP_LINK_SCHEME, productName: ' P ' }))
      .toEqual({ appOriginScheme: APP_SCHEME, deepLinkScheme: DEEP_LINK_SCHEME, productName: 'P' })
    // 大小写与空白归一化（两端同一口径）。
    expect(parseAppChannel({ appOriginScheme: ' PicoAide-App ', deepLinkScheme: 'PicoAide' })?.appOriginScheme).toBe(APP_SCHEME)
    // 缺字段 / 非串 / 空串 / 非法形状 / 保留 scheme / 两个 scheme 相同 ⇒ null。
    for (const bad of [
      null, {}, 'nope',
      { appOriginScheme: APP_SCHEME },
      { appOriginScheme: APP_SCHEME, deepLinkScheme: 42 },
      { appOriginScheme: '', deepLinkScheme: DEEP_LINK_SCHEME },
      { appOriginScheme: 'Has Space', deepLinkScheme: DEEP_LINK_SCHEME },
      { appOriginScheme: 'a', deepLinkScheme: DEEP_LINK_SCHEME },
      { appOriginScheme: 'https', deepLinkScheme: DEEP_LINK_SCHEME },
      { appOriginScheme: APP_SCHEME, deepLinkScheme: 'javascript' },
      { appOriginScheme: APP_SCHEME, deepLinkScheme: APP_SCHEME },
    ]) {
      expect(parseAppChannel(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('refreshAppChannel：先取本机证明、再带它取渠道；解析并同时注入分享 scheme', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const ok = await refreshAppChannel({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init: init ?? {} })
        if (url === HOST_PROOF_PATH) {
          return new Response(JSON.stringify({ proof: 'proof-xyz', expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify(OFFICIAL_CHANNEL), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    // 引导 → 渠道（顺序）且渠道请求带证明头（§22.2 R2）。
    expect(calls.map(call => call.url)).toEqual([HOST_PROOF_PATH, APP_CHANNEL_PATH])
    expect((calls[1]!.init.headers as Record<string, string>)[HOST_PROOF_HEADER]).toBe('proof-xyz')
    expect(ok).toEqual(OFFICIAL_CHANNEL)
    expect(appShareLink('roster')).toBe(`${DEEP_LINK_SCHEME}://app/roster`)
    // 失败（非 2xx）⇒ 不覆盖已有注入、也不产出新链接。
    setAppChannel(null)
    const failed = await refreshAppChannel({
      fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    })
    expect(failed).toBeNull()
    expect(appShareLink('roster')).toBeNull()
  })
})

describe('侧边栏入口：真实可达（不是"存在即通过"）', () => {
  const props = (wide: boolean): PropsRuntime<'sidebar.footer.action'> =>
    ({ wide } as unknown as PropsRuntime<'sidebar.footer.action'>)

  it('宽栏：渲染成真实按钮 + 可见文案 + aria-label，未打开时没有面板', () => {
    const html = renderToStaticMarkup(<AppCenterTrigger {...props(true)} />)
    expect(html).toMatch(/<button[^>]*type="button"/u)
    expect(html).toContain('pico-app-center-trigger')
    expect(html).toContain('应用中心')
    expect(html).toContain('aria-label="应用中心"')
    // 关键：没有任何隐藏手段（"存在但点不到"就是这些形态）。
    expect(html).not.toMatch(/display:\s*none/iu)
    expect(html).not.toMatch(/visibility:\s*hidden/iu)
    // `hidden` 是 HTML 属性（`aria-hidden` 在 svg 上是合法的、不算隐藏入口）。
    expect(html).not.toMatch(/\shidden(?=[\s=>])/u)
    expect(html).not.toContain('role="dialog"')
  })

  it('窄轨（56px rail）仍然渲染按钮，只是不显示文字标签', () => {
    const html = renderToStaticMarkup(<AppCenterTrigger {...props(false)} />)
    expect(html).toMatch(/<button[^>]*type="button"/u)
    expect(html).toContain('pico-app-center-trigger')
    expect(html).toContain('aria-label="应用中心"')
    expect(html).not.toContain('>应用中心<')
  })

  it('跟随语言：en 下入口与面板都是英文（App Center）', () => {
    setActiveLocale('en')
    const trigger = renderToStaticMarkup(<AppCenterTrigger {...props(true)} />)
    expect(trigger).toContain('App Center')
    const panelBody = renderToStaticMarkup(<AppCenterBody state={{ kind: 'ready', items: [] }} onRetry={() => {}} />)
    expect(panelBody).toContain('No apps yet')
    expect(t('appCenter.title')).toBe('App Center')
  })
})

describe('打开应用：只有本机路由这一条路（冻结契约 2026-09-19 §4.5）', () => {
  /** 记录请求的假 fetch；`reply` 决定状态码与响应体。 */
  function deps(reply: { status?: number, body?: unknown, raw?: string } = {}): { deps: OpenAppDeps, calls: Array<{ url: string, init: RequestInit }> } {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const status = reply.status ?? 200
    const body = reply.body ?? { url: appURL('demo') }
    return {
      calls,
      deps: {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          calls.push({ url, init: init ?? {} })
          // 本机持有性证明的引导端点（§22.2 R2）：`open` 之前必须先拿到令牌，
          // 否则客户端不发业务请求 —— 这条假 fetch 必须如实实现这个契约。
          if (url === HOST_PROOF_PATH) {
            return new Response(JSON.stringify({ proof: 'host-proof-test', expires_at: Date.now() + 5 * 60_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          return new Response(reply.raw ?? JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch,
        holdsWriteProof: () => true,
        // 打开链路的 scheme 来自渠道 seam（CHN-2）：用例显式注入官方渠道值。
        protocol: () => `${APP_SCHEME}:`,
      },
    }
  }

  /** 只取 open 路由的调用（引导证明那次不算业务调用）。 */
  const openCalls = (h: { calls: Array<{ url: string, init: RequestInit }> }) =>
    h.calls.filter(call => call.url === OPEN_APP_PATH)

  it('成功：POST 本机路由（带 app_id + 本机持有性证明头），并断言返回的就是这个应用的协议 URL', async () => {
    const h = deps()
    const result = await openAppEntry('demo', h.deps)
    expect(result).toEqual({ ok: true, url: appURL('demo') })
    // 业务请求只有一次：本机 open 路由，body 只有 app_id（没有入口链接、没有 URL 参数）。
    expect(openCalls(h)).toHaveLength(1)
    const call = openCalls(h)[0]!
    expect(call.url).toBe(OPEN_APP_PATH)
    expect(OPEN_APP_PATH).toBe('/api/pico/wasm-apps/open')
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(String(call.init.body))).toEqual({ app_id: 'demo' })
    expect(call.init.credentials).toBe('same-origin')
    // **本机持有性证明走请求头**（§22.2 R2）：实际发出的头里必须有它。
    const headers = call.init.headers as Record<string, string>
    expect(headers[HOST_PROOF_HEADER]).toBe('host-proof-test')
    // 引导那一步也真的发生了（先取令牌再调业务路由）。
    expect(h.calls.filter(c => c.url === HOST_PROOF_PATH)).toHaveLength(1)
  })

  it('失败按状态码分别可辨：未登录 / 应用不存在 / 协议未就绪 / 证明缺失', async () => {
    const cases: Array<[number, string]> = [
      [401, 'not-signed-in'],
      [404, 'app-not-found'],
      [503, 'protocol-not-ready'],
      [403, 'proof-required'],
      [400, 'invalid-app-id'],
    ]
    for (const [status, reason] of cases) {
      const h = deps({ status, body: { error: 'x' } })
      const result = await openAppEntry('demo', h.deps)
      expect(result.ok, String(status)).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason, String(status)).toBe(reason)
      expect(result.status).toBe(status)
      // 失败也不回落任何别的东西：只发了这一次**业务**请求。
      expect(openCalls(h)).toHaveLength(1)
    }
  })

  it('本机返回的 URL 校验：别的 scheme / 别的应用 / 非 JSON 一律形状错误（不假装打开）', async () => {
    const bad: unknown[] = [
      'https://demo.apps.example.com/',        // 旧模型的入口链接
      appURL('other'),                         // 别的应用
      `${APP_SCHEME}://`,                      // 没有 host
      '',                                       // 空
      undefined,                                // 缺字段
    ]
    for (const url of bad) {
      const h = deps({ body: { url } })
      const result = await openAppEntry('demo', h.deps)
      expect(result.ok, JSON.stringify(url)).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason, JSON.stringify(url)).toBe('unexpected-response')
    }
    const nonJSON = deps({ raw: '<html>proxy error</html>' })
    const result = await openAppEntry('demo', nonJSON.deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('unexpected-response')
  })

  it('宿主不可达（证明拿到了、业务调用挂了）⇒ host-unreachable（不是"已打开"）', async () => {
    const result = await openAppEntry('demo', {
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input) === HOST_PROOF_PATH) {
          return new Response(JSON.stringify({ proof: 'p', expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        throw new TypeError('ECONNREFUSED')
      }) as unknown as typeof fetch,
      holdsWriteProof: () => true,
      protocol: () => `${APP_SCHEME}:`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('host-unreachable')
    expect(result.error).toContain('ECONNREFUSED')
  })

  /**
   * **P0 R2-X-1 第 5 条**：令牌拿不到 ⇒ **一次业务请求都不发**，并给可辨原因。
   *
   * 变异验证：把 `ensureHostProof` 的失败分支删掉（照常发 open）⇒ 本条红（open 调用数 1
   * 且 reason 变成宿主业务面的错误）。
   */
  it('拿不到本机持有性令牌 ⇒ 不调 open，reason = host-proof-unavailable', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const result = await openAppEntry('demo', {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} })
        // 引导端点拒绝签发（403：浏览器会话证明缺失）。
        return new Response(JSON.stringify({ error: 'browser session proof required' }), { status: 403, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
      holdsWriteProof: () => true,
      protocol: () => `${APP_SCHEME}:`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('host-proof-unavailable')
    expect(result.status).toBe(403)
    expect(calls.map(call => call.url)).toEqual([HOST_PROOF_PATH])
    expect(calls.some(call => call.url === OPEN_APP_PATH)).toBe(false)
  })

  /**
   * **P0 R2-X-1 第 3 条**：401 `proof_expired` ⇒ 强制重取**恰好一次** + 重放**恰好一次**。
   *
   * 变异验证：去掉 `fetchWithHostProof` 的重试分支 ⇒ 第一条红（结果变成失败）；
   * 把"只重试一次"改成循环 ⇒ 第二条红（调用数超限）。
   */
  it('401 proof_expired ⇒ 重取令牌一次并重放一次（不是无限重试）', async () => {
    let proofIssued = 0
    const opens: Array<Record<string, string>> = []
    let attempt = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === HOST_PROOF_PATH) {
        proofIssued += 1
        return new Response(JSON.stringify({ proof: `proof-${String(proofIssued)}`, expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      opens.push((init?.headers ?? {}) as Record<string, string>)
      attempt += 1
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: 'proof_expired' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ url: `picoaide-app://demo/` }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const result = await openAppEntry('demo', { fetch: fetchImpl, holdsWriteProof: () => true, protocol: () => `${APP_SCHEME}:` })
    expect(result.ok).toBe(true)
    expect(opens).toHaveLength(2)
    expect(proofIssued).toBe(2)
    // 第一次用的是旧令牌，重放用的是新令牌。
    expect(opens[0]![HOST_PROOF_HEADER]).toBe('proof-1')
    expect(opens[1]![HOST_PROOF_HEADER]).toBe('proof-2')
  })

  it('重放后仍然 401 proof_required ⇒ 失败但**只发了两次**（不无限重试）', async () => {
    let proofIssued = 0
    let opens = 0
    const result = await openAppEntry('demo', {
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === HOST_PROOF_PATH) {
          proofIssued += 1
          return new Response(JSON.stringify({ proof: `p${String(proofIssued)}`, expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        opens += 1
        return new Response(JSON.stringify({ error: 'proof_required' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
      holdsWriteProof: () => true,
      protocol: () => `${APP_SCHEME}:`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('proof-required')
    expect(opens).toBe(2)
    expect(proofIssued).toBe(2)
  })

  it('401 AUTH_REQUIRED（未登录）**不**触发令牌重取（那是登录流程，不是证明问题）', async () => {
    let proofIssued = 0
    let opens = 0
    const result = await openAppEntry('demo', {
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === HOST_PROOF_PATH) {
          proofIssued += 1
          return new Response(JSON.stringify({ proof: 'p', expires_at: Date.now() + 300_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        opens += 1
        return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'not logged in' } }), { status: 401, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
      holdsWriteProof: () => true,
      protocol: () => `${APP_SCHEME}:`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('not-signed-in')
    expect(opens).toBe(1)
    expect(proofIssued).toBe(1)
  })

  it('还没拿到渠道 scheme 时一次请求都不发（CHN-2：scheme 猜不得）', async () => {
    const h = deps()
    // `protocol: () => null` + 补齐也拿不到 ⇒ scheme-unavailable（本地拦下）。
    const result = await openAppEntry('demo', { ...h.deps, protocol: () => null, ensureChannel: async () => null })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('scheme-unavailable')
    expect(h.calls).toEqual([])
  })

  it('scheme 缺席但补齐能拿到时照常打开（挂载期取数失败的兜底）', async () => {
    const h = deps()
    let protocol: string | null = null
    const result = await openAppEntry('demo', {
      ...h.deps,
      protocol: () => protocol,
      ensureChannel: async () => { protocol = `${APP_SCHEME}:`; return null },
    })
    expect(result).toEqual({ ok: true, url: appURL('demo') })
    expect(openCalls(h)).toHaveLength(1)
  })

  it('缺证明时一次请求都不发（页面根本不可能持有证明）', async () => {
    const h = deps()
    const result = await openAppEntry('demo', { ...h.deps, holdsWriteProof: () => false })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('proof-unavailable')
    expect(h.calls).toEqual([])
  })

  it('app_id 形态不对时本地就拒（不发请求）', async () => {
    for (const bad of ['', '  ', 'Demo', 'demo/extra', '../etc', 'a'.repeat(64), 42, null, undefined]) {
      const h = deps()
      const result = await openAppEntry(bad, h.deps)
      expect(result.ok, JSON.stringify(bad)).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason, JSON.stringify(bad)).toBe('invalid-app-id')
      expect(h.calls, JSON.stringify(bad)).toEqual([])
    }
  })

  it('pageHoldsWriteProof：只有本机宿主服务的 http(s) 页面才可能持有证明', () => {
    expect(pageHoldsWriteProof({ protocol: 'http:' })).toBe(true)
    expect(pageHoldsWriteProof({ protocol: 'https:' })).toBe(true)
    // 应用页自己与本地文档都不可能持有证明（也就不能驱动本机写面）。
    expect(pageHoldsWriteProof({ protocol: `${APP_SCHEME}:` })).toBe(false)
    expect(pageHoldsWriteProof({ protocol: 'file:' })).toBe(false)
    expect(pageHoldsWriteProof({ protocol: 'data:' })).toBe(false)
    expect(pageHoldsWriteProof(undefined)).toBe(false)
  })

  it('parseAppProtocolURL 只认"本安装的渠道 scheme + 这个 app"（scheme 是运行期值）', () => {
    const protocol = `${APP_SCHEME}:`
    expect(parseAppProtocolURL(appURL('demo'), 'demo', protocol)).toBe(appURL('demo'))
    expect(parseAppProtocolURL(appURL('demo', '/notes?x=1'), 'demo', protocol)).toBe(appURL('demo', '/notes?x=1'))
    expect(parseAppProtocolURL(appURL('other'), 'demo', protocol)).toBeNull()
    expect(parseAppProtocolURL('https://demo/', 'demo', protocol)).toBeNull()
    expect(parseAppProtocolURL(null, 'demo', protocol)).toBeNull()
    // 别的安装的 scheme（品牌渠道互相打不开）⇒ 形状错误，不是"成功"。
    expect(parseAppProtocolURL(appURL('demo'), 'demo', 'mokahr-harness-app:')).toBeNull()
    // 没拿到 scheme ⇒ 任何 URL 都不认（fail-closed）。
    expect(parseAppProtocolURL(appURL('demo'), 'demo', null)).toBeNull()
  })

  it('scheme 来自渠道 seam 的注入值（不写死 `picoaide-app`）', () => {
    setAppChannel(OFFICIAL_CHANNEL)
    expect(parseAppProtocolURL(appURL('demo'), 'demo')).toBe(appURL('demo'))
    // 换一个渠道（品牌）：同一条 URL 立即不再被认作本安装的应用。
    setAppChannel({ appOriginScheme: 'acme-harness-app', deepLinkScheme: 'acme-harness', productName: 'Acme' })
    expect(parseAppProtocolURL(appURL('demo'), 'demo')).toBeNull()
    expect(parseAppProtocolURL('acme-harness-app://demo/', 'demo')).toBe('acme-harness-app://demo/')
  })

  /**
   * 源码级判据：**客户端不拼 app-proof 头**（§20.1/§23.1：proof 只由宿主持有并携带）。
   *
   * ⚠️ 这里曾写的是 `not.toContain('X-Pico-App-Proof:')` —— 一条**形同没有**的判据：TS/JS 里
   * 最自然的拼头写法是对象字面量 `{ 'X-Pico-App-Proof': value }`，引号夹在 `Proof` 与 `:`
   * 之间，那个子串恒不命中（独立审计 R1-L3-1 的 M14 变异只让"产物不旧于源码"这条通用守卫
   * 变红，没有一条语义断言失败）。现在的写法不依赖引号形态：
   *
   *  ①**只允许声明一处**：`APP_PROOF_HEADER` 在**代码行**（整行注释不算）里出现且仅出现一次
   *    —— 任何"拼头"写法都必然再引用它一次 ⇒ 必红；
   *  ②**按头名形态扫**：覆盖不带引号、带单/双引号三种形态的 `X-Pico-App-Proof:`；
   *  ③真正发出去的本机请求 headers 里不含它（行为级，见下一条用例）。
   */
  it('源码级：open-app.ts 里没有写死的 app scheme（CHN-2），也不是客户端在拼 app-proof', () => {
    const source = readFileSync(new URL('./open-app.ts', import.meta.url), 'utf8')
    // 旧实现的常量 `APP_PROTOCOL = 'picoaide-app:'` 必须彻底消失：scheme 是渠道变量。
    expect(source).not.toContain(`'${APP_SCHEME}:'`)
    expect(source).not.toContain(APP_SCHEME)
    // 但冻结路径必须仍是**字面量**（跨包三方对拍的真源，见 desktop 的 route-parity 用例）。
    expect(source).toContain("export const OPEN_APP_PATH = '/api/pico/wasm-apps/open'")
    // 头名常量必须在（跨端契约），但**只在声明处**出现一次。
    expect(source).toContain("'X-Pico-App-Proof'")
    const code = source
      .split('\n')
      .filter(line => !/^\s*(\*|\/\/|\/\*)/u.test(line))   // 去掉整行注释（`{@link …}` 不算"使用"）
      .join('\n')
    expect(code.match(/APP_PROOF_HEADER/gu) ?? []).toHaveLength(1)
    // 三种引号形态的"拼头"都要被抓到（旧断言只覆盖不带引号的一种 ⇒ 恒不命中）。
    expect(code).not.toMatch(/X-Pico-App-Proof['"]?[ \t]*:/u)
    // 头名本体只允许出现在**声明那一行**（大小写不敏感：`headers['x-pico-app-proof']` 也算）。
    const withoutDeclaration = code
      .split('\n')
      .filter(line => !line.includes('export const APP_PROOF_HEADER'))
      .join('\n')
    expect(withoutDeclaration).not.toMatch(/x-pico-app-proof/iu)
  })

  /**
   * 行为级对照（比源码 grep 强）：真的发一次打开请求，断言**实际 headers 里没有** proof、
   * 也没有 authorization —— 客户端半边不持 bearer、不签 proof（§5.1b/§20.3）。
   *
   * 变异验证：在 `openAppEntry` 的 fetch init 里加 `{'X-Pico-App-Proof': 'x'}`
   * 或 `{Authorization: …}` ⇒ 本条必红（完全不依赖源码字符串形态）。
   */
  it('打开请求：带**本机**持有性证明头，不带平台 app-proof / authorization', async () => {
    const h = deps()
    await openAppEntry('demo', h.deps)
    const call = openCalls(h)[0]!
    const headers = (call.init.headers ?? {}) as Record<string, string>
    const names = Object.keys(headers).map(name => name.toLowerCase()).sort()
    // 平台 app-proof 与 bearer 都在宿主侧（客户端不拼不签）；本机证明**必须**在。
    expect(names).not.toContain('x-pico-app-proof')
    expect(names).not.toContain('authorization')
    expect(names).toEqual(['content-type', HOST_PROOF_HEADER.toLowerCase()].sort())
    expect(JSON.parse(String(call.init.body))).toEqual({ app_id: 'demo' })
  })

  it('源码级：open-app.ts 里没有 http(s) 入口、没有系统浏览器兜底', () => {
    const source = readFileSync(new URL('./open-app.ts', import.meta.url), 'utf8')
    // 旧实现的两条路（内置浏览器标签 + window.open 兜底）必须一个字都不剩。
    // （模块注释里提到 entry_url 只是说明"它已经不存在"，所以这里查的是代码面。）
    expect(source).not.toContain('window.open')
    expect(source).not.toContain('/api/pico/browser/open')
    expect(source).not.toContain('entryURL')
    expect(source).not.toContain('safeEntryURL')
    // 旧的返回形态 `via: 'built-in' | 'system' | 'none'` 也不在。
    expect(source).not.toContain('via')
  })
})
