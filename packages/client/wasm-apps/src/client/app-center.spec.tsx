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
 *   - `openAppEntry` 去掉内置浏览器分支（直接 window.open）
 *     → 「内置浏览器优先」红；
 *   - `openAppEntry` 内置失败后不兜底 → 「内置缺席时回落系统浏览器」红；
 *   - `safeEntryURL` 去掉 scheme 白名单 → 「javascript: 不能被打开」红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AppCenterBody, accessBadge, entryHostLabel, parseCatalog, resolveAccess, type AppCenterItem } from './AppCenterPanel.tsx'
import { AppCenterTrigger } from './AppCenterTrigger.tsx'
import { en, setActiveLocale, t, zh } from './locales.ts'
import { openAppEntry, safeEntryURL, type OpenAppDeps } from './open-app.ts'

afterEach(() => { setActiveLocale('zh') })

/** 额度/用量词表（R36：这一页一个都不许有）。 */
const QUOTA_PATTERN = /quota|balance|budget|usage|credit|额度|用量|余额|计费/iu

const ITEMS: AppCenterItem[] = [
  { appId: 'shared-notes', title: '共享便签', description: '值班记录与交接备注', responsible: 'alice', entryURL: 'https://shared-notes.apps.example.com', access: 'public', enabled: true, currentVersion: '1.2.0', isOwner: true },
  { appId: 'roster', title: '值班表', description: '', responsible: 'bob', entryURL: 'https://roster.apps.example.com', access: 'whitelist', enabled: true, currentVersion: '2.0.0', isOwner: false },
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
      appId: 'a', title: 'A 工具', description: '一句话', responsible: 'alice', entryURL: 'https://a.apps.example.com', access: 'public', enabled: true,
      // P1-4 / P1-3：服务端没下发就**留空 / false**，不编造版本号、也不假装是发布者。
      currentVersion: '', isOwner: false,
    })
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

  it('结构不对时不抛错（返回空数组 ⇒ 面板显示空态）', () => {
    expect(parseCatalog(null)).toEqual([])
    expect(parseCatalog({})).toEqual([])
    expect(parseCatalog({ apps: 'nope' })).toEqual([])
    expect(parseCatalog({ apps: [null, 3, { title: '没有 app_id' }] })).toEqual([])
  })
})

describe('访问级别：新字段优先，旧字段只在 access 缺席时兜底（过渡兼容）', () => {
  it('服务端下发 access 时原样采用（三种取值，含大小写/空白不宽容）', () => {
    for (const access of ['public', 'login', 'whitelist'] as const) {
      expect(resolveAccess({ access })).toBe(access)
    }
    // access 优先于旧字段：即使旧字段说 public，也以 access 为准。
    expect(resolveAccess({ access: 'whitelist', login_required: false })).toBe('whitelist')
    // 非法取值不放大权限（回落 login 而不是 public）。
    expect(resolveAccess({ access: 'PUBLIC' })).toBe('login')
    expect(resolveAccess({ access: 42 })).toBe('login')
    // 独立审计 2026-09-18 P2：`access` **存在但非法**时不得落进旧字段分支 ——
    // 那会把"服务端下发了我们还不认识的新模式"翻译成 public（`login_required: false`
    // 时），也就是把权限放大。旧字段只允许在 access **缺失**时兜底。
    expect(resolveAccess({ access: 'org', login_required: false })).toBe('login')
    expect(resolveAccess({ access: 'org', login_required: false, whitelist: ['alice'] })).toBe('login')
    expect(resolveAccess({ access: '', login_required: false })).toBe('login')
  })

  it('过渡兼容：access 缺席时按旧的 login_required + whitelist 回落读取', () => {
    // login_required === false ⇒ 旧语义的"匿名可用"。
    expect(resolveAccess({ login_required: false })).toBe('public')
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
})

describe('目录渲染（R34 / R36）', () => {
  it('渲染名称 / 一句话说明 / 负责人 / 入口链接', () => {
    const html = renderToStaticMarkup(
      <AppCenterBody state={{ kind: 'ready', items: ITEMS }} onRetry={() => {}} />,
    )
    expect(html).toContain('共享便签')
    expect(html).toContain('值班记录与交接备注')
    expect(html).toContain('负责人: alice')
    expect(html).toContain('shared-notes.apps.example.com')
    expect(html).toContain('值班表')
    expect(html).toContain('roster.apps.example.com')
    // 每条目一个"打开"按钮（真实 button，不是 div）。
    expect(html.match(/<button type="button"/gu)).toHaveLength(2)
  })

  it('每条目标出访问级别（公开 / 登录后使用 / 仅白名单）', () => {
    const html = renderToStaticMarkup(
      <AppCenterBody state={{ kind: 'ready', items: ITEMS }} onRetry={() => {}} />,
    )
    expect(html).toContain('data-role="access-level"')
    expect(html).toContain('data-access="public"')
    expect(html).toContain('data-access="whitelist"')
    expect(html).toContain(accessBadge('public'))
    expect(html).toContain(accessBadge('whitelist'))
    // 访问级别只说明"谁能用"，**不隐藏任何行**：两条都渲染。
    expect(html).toContain('共享便签')
    expect(html).toContain('值班表')
  })

  it('下架的条目仍然展示，标出"已下架"且打开按钮禁用（不假装不存在）', () => {
    const items: AppCenterItem[] = [
      { appId: 'gone', title: '已下线的工具', description: '', responsible: '', entryURL: 'https://gone.apps.example.com', access: 'public', enabled: false, currentVersion: '', isOwner: false },
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

  it('入口链接展示主机名（app_id.基域 本身就是"这是什么应用"的答案）', () => {
    expect(entryHostLabel('https://shared-notes.apps.example.com/x?y=1')).toBe('shared-notes.apps.example.com')
    expect(entryHostLabel('not-a-url')).toBe('not-a-url')
    expect(entryHostLabel('')).toBe('')
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

describe('入口打开策略：内置浏览器优先，系统浏览器兜底', () => {
  function deps(openOK: boolean | 'throw', browserOK: boolean): { deps: OpenAppDeps, calls: string[], opened: string[] } {
    const calls: string[] = []
    const opened: string[] = []
    return {
      calls,
      opened,
      deps: {
        fetch: (async (input: RequestInfo | URL) => {
          calls.push(String(input))
          if (browserOK) return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
          return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch,
        open: (url: string) => {
          if (openOK === 'throw') throw new Error('window.open unavailable')
          opened.push(url)
          return null
        },
      },
    }
  }

  it('内置浏览器可用 ⇒ 开标签 + show，不碰系统浏览器', async () => {
    const h = deps(true, true)
    const result = await openAppEntry('https://a.apps.example.com', h.deps)
    expect(result).toEqual({ ok: true, via: 'built-in' })
    expect(h.calls).toEqual(['/api/pico/browser/open', '/api/pico/browser/show'])
    expect(h.opened).toEqual([])
  })

  it('内置浏览器缺席（404）⇒ 回落系统浏览器', async () => {
    const h = deps(true, false)
    const result = await openAppEntry('https://a.apps.example.com', h.deps)
    expect(result).toEqual({ ok: true, via: 'system' })
    // URL 会先被规范化（无路径 ⇒ 补 `/`）。
    expect(h.opened).toEqual(['https://a.apps.example.com/'])
  })

  it('内置浏览器请求抛错（宿主不可达）⇒ 同样回落', async () => {
    const opened: string[] = []
    const result = await openAppEntry('https://a.apps.example.com', {
      fetch: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      open: (url: string) => { opened.push(url); return null },
    })
    expect(result).toEqual({ ok: true, via: 'system' })
    expect(opened).toHaveLength(1)
  })

  it('两条路都不通时明确失败（不假装成功）', async () => {
    const h = deps('throw', false)
    const result = await openAppEntry('https://a.apps.example.com', h.deps)
    expect(result.ok).toBe(false)
    expect(result.via).toBe('none')
    expect(result.error).toContain('window.open unavailable')
  })

  it('非 http(s) 入口一律拒绝，且不做任何副作用', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', '', 42, null]) {
      const h = deps(true, true)
      const result = await openAppEntry(bad, h.deps)
      expect(result).toEqual({ ok: false, via: 'none', error: 'entry_url is not an http(s) URL' })
      expect(h.calls).toEqual([])
      expect(h.opened).toEqual([])
    }
  })

  it('safeEntryURL 规范化并保留 query（入口可能是带参数的深链）', () => {
    expect(safeEntryURL('https://a.apps.example.com')).toBe('https://a.apps.example.com/')
    expect(safeEntryURL(' https://a.apps.example.com/x?y=1 ')).toBe('https://a.apps.example.com/x?y=1')
    expect(safeEntryURL('javascript:void(0)')).toBeNull()
    expect(safeEntryURL(undefined)).toBeNull()
  })
})
