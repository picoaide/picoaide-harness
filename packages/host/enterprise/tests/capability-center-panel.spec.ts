import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applySectionRows,
  avatarColor,
  capabilitySourceBadgeKey,
  compareVersions,
  hasUpdateFor,
  installEndpoint,
  installNeedsConfirm,
  installRequestUrl,
  itemsForTab,
  latestApprovedVersionByName,
  localRemoveEndpoint,
  mergeItems,
  nameTakenError,
  needsOverwriteConfirm,
  planCardAction,
  planSectionCards,
  uninstallEndpoint,
  versionInstallSupported,
  withOverwrite,
  type CapabilityItem,
  type SectionCard,
} from '../src/client/CapabilityCenterPanel.tsx'
import { builtinCardsForTab, planBuiltinCards } from '../src/client/BuiltinSkillsStrip.tsx'
import { setActiveLocale } from '../src/client/locales.ts'

afterEach(() => { setActiveLocale('zh') })

describe('compareVersions', () => {
  it('compares numerically (1.9.0 < 1.10.0)', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })
  it('treats a trailing alphabetic run as prerelease (rc < release)', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBe(1)
  })
  it('handles equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v2', 'v2')).toBe(0)
  })
  it('falls back to byte order for non-semver inputs', () => {
    expect(compareVersions('abc!', 'abcd')).toBe(-1)
    expect(compareVersions('', '1.0')).toBe(-1)
  })
})

describe('latestApprovedVersionByName', () => {
  const rows: CapabilityItem[] = [
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.2.0', description: '', author: 'a', status: 'approved', versions: ['1.2.0'] },
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '2.0.0-rc1', description: '', author: 'a', status: 'pending', versions: [] },
  ]
  it('returns the numerically-highest approved version; ignores pending', () => {
    expect(latestApprovedVersionByName(rows, 'skill', 'codeql')).toBe('1.2.0')
  })
  it('returns undefined when no approved rows', () => {
    expect(latestApprovedVersionByName(rows, 'skill', 'missing')).toBeUndefined()
  })
})

describe('hasUpdateFor', () => {
  it('true when approved latest > installed version', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.0.0', '1.2.0'], installed: true, installedVersion: '1.0.0' }
    expect(hasUpdateFor(item)).toBe(true)
  })
  it('false when installed version is the latest', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.2.0'], installed: true, installedVersion: '1.2.0' }
    expect(hasUpdateFor(item)).toBe(false)
  })
  it('false when not installed', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.2.0'], installed: false }
    expect(hasUpdateFor(item)).toBe(false)
  })
})

describe('installEndpoint / uninstallEndpoint (来源路由 bug 回归)', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'], installed: false }

  it('market skill installs via /api/pico/skills (gateway marketplace), NOT shared-skills', () => {
    const market = { ...base, source: 'market' as const }
    expect(installEndpoint(market, '1.0.0')).toBe('/api/pico/skills/codeql/install')
    // 回归:57aeffecbb 曾把所有技能路由到 shared-skills → 网关 404 gateway error。
    expect(installEndpoint(market, '1.0.0')).not.toContain('shared-skills')
  })

  it('org shared skill installs via /api/pico/shared-skills with version', () => {
    expect(installEndpoint(base, '1.2.0')).toBe('/api/pico/shared-skills/codeql/1.2.0/install')
  })

  it('market skill uninstalls via /api/pico/skills (matched install route)', () => {
    const market = { ...base, source: 'market' as const }
    expect(uninstallEndpoint(market, '1.0.0')).toBe('/api/pico/skills/codeql/uninstall')
    expect(uninstallEndpoint(base, '1.0.0')).toBe('/api/pico/shared-skills/codeql/1.0.0/uninstall')
  })

  it('agent install/uninstall route via /api/pico/agent-presets', () => {
    const agent: CapabilityItem = { ...base, kind: 'agent', name: 'creative-writer', source: 'org' }
    expect(installEndpoint(agent, '1.0.0')).toBe('/api/pico/agent-presets/creative-writer/install')
    expect(uninstallEndpoint(agent, '1.0.0')).toBe('/api/pico/agent-presets/creative-writer/uninstall')
  })

  it('安装端点不带 query：宿主不读 ?force=1（R2-SK-5），覆盖确认是纯客户端交互', () => {
    // 曾经的形态：确认后把 `?force=1` 拼进 URL —— 而宿主按 pathname 分发（auth-gate），
    // 谁都没读它。变异：把 `?force=1` 加回端点 ⇒ 本断言必红。
    expect(installEndpoint(base, '1.0.0')).toBe('/api/pico/shared-skills/codeql/1.0.0/install')
    expect(installEndpoint(base, '1.0.0')).not.toContain('?')
    const market: CapabilityItem = { ...base, source: 'market' }
    expect(installEndpoint(market, '1.0.0')).toBe('/api/pico/skills/codeql/install')
    expect(installEndpoint(market, '1.0.0')).not.toContain('?')
  })
})

describe('mergeItems', () => {
  it('collapses same kind+name into one card with highest approved version', () => {
    const rows: CapabilityItem[] = [
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.10.0', description: '', author: 'a', status: 'approved', versions: ['1.10.0'] },
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.version).toBe('1.10.0')
    expect(merged[0]!.versions).toEqual(['1.0.0', '1.10.0'])
  })
  it('keeps skill and agent separate when names collide', () => {
    const rows: CapabilityItem[] = [
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
      { kind: 'agent', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(2)
    expect(merged.map(m => m.kind).sort()).toEqual(['agent', 'skill'])
  })
})

describe('avatarColor', () => {
  it('returns a stable color token for any non-empty name', () => {
    // 必须是**会随主题翻转**的 alias token（2026-09-16 审计）：此前钉的是
    // `var(--dsw-static-…` 开头，而那一族名字在上游并不存在（静态色板是三位刻度），
    // 实际生效的始终是内层 alias —— 断言外层名字等于把"永远走 fallback"钉成预期。
    const color = avatarColor('code-review')
    expect(color).toMatch(/^var\(--dsw-alias-/u)
    expect(avatarColor('code-review')).toBe(avatarColor('code-review'))
  })
  it('handles the empty name (fallback first color)', () => {
    expect(avatarColor('')).toBe('var(--dsw-alias-brand-primary)')
  })
})

describe('mergeItems cross-source merge (market/org 合并 bug 修复)', () => {
  it('keeps market as the display source when the same name exists in org', () => {
    const items = [
      { kind: 'skill', source: 'market', name: 'code-review', version: '1.0.0', status: 'approved', versions: ['1.0.0'], displayName: 'code-review', description: '代码审查' },
      { kind: 'skill', source: 'org', name: 'code-review', version: '2.0.0', status: 'approved', versions: ['2.0.0'], displayName: '代码审查', description: '组织版代码审查' },
    ] as never
    const merged = mergeItems(items)
    expect(merged.length).toBe(1)
    const row = merged[0]
    expect(row.source).toBe('market') // 市场优先
    expect(row.version).toBe('2.0.0') // approved 最高版本
    expect(row.displayName).toBe('代码审查') // 非空标题保留(不被 market 同名值覆盖)
    expect(row.description).toBe('组织版代码审查') // 非空描述保留(较新)
    expect(row.versions).toEqual(['1.0.0', '2.0.0'])
  })

  it('preserves org-only rows untouched', () => {
    const items = [
      { kind: 'agent', source: 'org', name: 'creative-writer', version: '1.0.0', status: 'pending', versions: [], displayName: '妙笔文案', description: '' },
    ] as never
    const merged = mergeItems(items)
    expect(merged.length).toBe(1)
    expect(merged[0].source).toBe('org')
    expect(merged[0].displayName).toBe('妙笔文案')
  })

  it('does not let a market-only same-name row shadow the org title when market has none', () => {
    const items = [
      { kind: 'skill', source: 'org', name: 'x', version: '1.0.0', status: 'approved', versions: ['1.0.0'], displayName: '中文标题', description: '描述' },
      { kind: 'skill', source: 'org', name: 'x', version: '1.1.0', status: 'approved', versions: ['1.1.0'], displayName: '', description: '' },
    ] as never
    const merged = mergeItems(items)
    expect(merged[0].displayName).toBe('中文标题')
    expect(merged[0].version).toBe('1.1.0')
  })
})

describe('0059 official & score fields', () => {
  const base: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'official-skill', displayName: '', version: '1.0.0',
    description: '', author: '', status: 'approved', versions: ['1.0.0'], installed: false,
  }
  it('types permit official/downloads/calls/score', () => {
    const item: CapabilityItem = { ...base, official: true, downloads: 10, calls: 5, score: 25 }
    expect(item.official).toBe(true)
    expect(item.score).toBe(25)
  })
  it('quality no longer permits official value (retired to official attr)', () => {
    // 编译期保证: quality 只接受 '' | 'featured'
    const item: CapabilityItem = { ...base, quality: 'featured' }
    expect(item.quality).toBe('featured')
  })
})

describe('itemsForTab（卡片唯一位置，2026-08-25 定案 / 2026-09-15 抽成纯函数）', () => {
  const rows = [
    { kind: 'skill' as const, name: 'local-draft', source: 'local', installed: false },
    { kind: 'skill' as const, name: 'org-shared', source: 'org', installed: false },
    { kind: 'skill' as const, name: 'org-installed', source: 'org', installed: true },
    { kind: 'skill' as const, name: 'market-skill', source: 'market', installed: false },
  ]

  it('「市场」只放来源条目（本地创作不重复出现）', () => {
    expect(itemsForTab(rows, 'market').map(i => i.name)).toEqual(['org-shared', 'org-installed', 'market-skill'])
  })

  it('「我的」放本地创作 + 已安装的来源条目（本地卡只管上传，安装动作在来源卡）', () => {
    expect(itemsForTab(rows, 'mine').map(i => i.name)).toEqual(['local-draft', 'org-installed'])
  })
})

describe('nameTakenError（上传预检撞同名，2026-09-16 i18n）', () => {
  // 此前这句是组件里的**硬编码中文**——同文件已用 t() 74 次，只有它漏网，
  // 英文界面下整句是中文。渲染测试抓不到（组件根本没渲染这句），所以这里
  // 断言"切语言后文案跟着变"。
  it('zh：占用名出现在文案里，且是中文原文', () => {
    expect(nameTakenError('妙笔文案'))
      .toBe('名称已被占用:「妙笔文案」已存在于能力中心,请更换名称或联系管理员')
  })

  it('en：同一句走英文，且不含中文', () => {
    setActiveLocale('en')
    const message = nameTakenError('Acme Writer')
    expect(message).toContain('Acme Writer')
    expect(message).toBe('Name already taken: "Acme Writer" already exists in the Capability Hub. Choose another name or contact your administrator.')
    expect(message).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  it('每次调用都取当前语言（不是模块级常量）', () => {
    expect(nameTakenError('x')).toContain('名称已被占用')
    setActiveLocale('en')
    expect(nameTakenError('x')).toContain('Name already taken')
    setActiveLocale('zh')
    expect(nameTakenError('x')).toContain('名称已被占用')
  })
})

// ---------------------------------------------------------------------------
// R2-SK-6：「我的」里同一个技能只能出一张卡（内置更新卡 vs 本机同名普通卡）
// ---------------------------------------------------------------------------
//
// 现场：R1-pm-8 修好"已装 + 清单有新版 ⇒ 出更新卡"之后，本机技能库里那张同名普通卡
// （provenance=builtin 的本地卡）仍在 rows 里，而面板直接 `[...builtinCards, ...rows]`
// 拼接 ⇒ 同一个技能显示两张卡：一张 `[更新到 v1.1.0]`，另一张页脚是误导性的 `[上传]`。
//
// 判据是**数量**（同名卡恰好 1 张），不是"存在某种卡"。变异验证：去掉
// planSectionCards 里的过滤（回到两数组直接拼接）⇒ 前两条必红。

describe('R2-SK-6 内置卡与本机卡去重（数量断言）', () => {
  const localSkill = (name: string, version: string, originChannel?: string): CapabilityItem => ({
    kind: 'skill', source: 'local', name, displayName: name, version, description: '',
    author: 'PicoAide', versions: [version], installed: true, installedVersion: version,
    ...(originChannel === undefined ? {} : { originChannel }),
  })
  /** 与面板真实输入同形：清单 1.1.0 + 本机 1.0.0 ⇒ 出「更新到 v1.1.0」卡。 */
describe('内置技能的分区归属（2026-09-20 用户口径）', () => {
  const card = (name: string, action: 'install' | 'update') => ({
    skill: { name, version: '2.0.0' },
    action,
    endpoint: `/api/pico/skills/builtin/${name}/install`,
    installed: action === 'update',
    state: 'action' as const,
    failure: null,
  })

  it('未装的进「市场」，已装待更新的进「我的」', () => {
    const cards = [card('app-builder', 'install'), card('other-skill', 'update')]
    expect(builtinCardsForTab(cards, 'market').map(c => c.skill.name)).toEqual(['app-builder'])
    expect(builtinCardsForTab(cards, 'mine').map(c => c.skill.name)).toEqual(['other-skill'])
  })

  it('未装的内置技能**不得**出现在「我的」（用户报的现象：默认没装却在「我的」里）', () => {
    const cards = [card('app-builder', 'install')]
    expect(builtinCardsForTab(cards, 'mine')).toEqual([])
  })

  it('两个分区合起来恰好是全部卡片（不重不漏 —— 分流写成两个独立判断就会漏卡）', () => {
    const cards = [card('a', 'install'), card('b', 'update'), card('c', 'install')]
    const union = [...builtinCardsForTab(cards, 'mine'), ...builtinCardsForTab(cards, 'market')]
    expect(union.map(c => c.skill.name).sort()).toEqual(['a', 'b', 'c'])
  })
})

  const updateCards = () => planBuiltinCards({
    rows: [{ name: 'app-builder', version: '1.1.0' }],
    installedNames: new Set(['app-builder']),
    installedVersions: { 'app-builder': '1.0.0' },
    query: '',
    kindFilter: 'all',
  })
  const nameOf = (c: SectionCard): string => (c.type === 'builtin' ? c.card.skill.name : c.item.name)

  it('可更新时：内置更新卡吞掉同名本机卡，同名卡恰好 1 张', () => {
    const rows = mergeItems(itemsForTab([
      localSkill('app-builder', '1.0.0', 'builtin'),
      localSkill('codeql', '1.0.0'),
    ], 'mine'))
    const cards = planSectionCards({ rows, builtinCards: updateCards() })
    // 数量断言：两张本机卡 + 一张内置更新卡 ⇒ 去重后恰好 2 张（app-builder 只留内置那张）。
    expect(cards).toHaveLength(2)
    expect(cards.filter(c => nameOf(c) === 'app-builder')).toHaveLength(1)
    const appBuilder = cards.find(c => nameOf(c) === 'app-builder')
    expect(appBuilder?.type).toBe('builtin')
    expect(appBuilder?.type === 'builtin' ? appBuilder.card.action : '').toBe('update')
    // 其它技能不受影响。
    expect(cards.filter(c => nameOf(c) === 'codeql')).toHaveLength(1)
  })

  it('没有内置卡时，本机卡照常渲染（去重不得吃掉唯一那张）', () => {
    const rows = mergeItems(itemsForTab([localSkill('app-builder', '1.0.0', 'builtin')], 'mine'))
    const cards = planSectionCards({ rows, builtinCards: [] })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.type).toBe('item')
  })

  it('只吞同名**技能**：同名智能体不受影响（复合键语义，技能与 agent 允许同名）', () => {
    const agent: CapabilityItem = { ...localSkill('app-builder', '1.0.0'), kind: 'agent' }
    const cards = planSectionCards({ rows: [agent], builtinCards: updateCards() })
    expect(cards).toHaveLength(2)
    expect(cards.filter(c => c.type === 'item')).toHaveLength(1)
  })
})


/**
 * 独立复审 2026-09-23 **A6（PARTIAL）** + **N1（P2）**：「我的」卡片的来源字段
 * 与卡片形态必须只取决于**已合并后的单一数据源**，不取决于两次并发取数的到达顺序。
 *
 * 现场（审计 §5.18 实测）：
 *  - 面板 mount 时并发发 `/api/pico/capabilities?source=market` 与 `?source=local`
 *    （后者内部还要打 3 次上游 + 扫盘），谁先回来不定；
 *  - **market-first**：同名商店行先入 Map ⇒ `mergeItems` 用它打底 ⇒ 本机行独有的
 *    `originChannel` 被吞 ⇒ **「随客户端内置」徽章与本机卸载入口都渲染不出来**（A6）；
 *  - **mine-first**：本机行打底但 `installed` 被商店行的 `source` 覆写、`installed`
 *    本身没被带上 ⇒ 已装技能渲染成「安装」。
 *
 * 用例直接驱动**真实的归约函数**（applySectionRows → itemsForTab → mergeItems →
 * capabilitySourceBadgeKey / planCardAction），两种到达顺序各跑一遍：
 *  - 变异验证：把 mergeItems 退回"先到的行说了算"⇒ 第 1 条（逐字相等）必红；
 *    只丢"本机行的 originChannel/installedOrigin 优先"⇒ 第 2 条必红；
 *    只丢"存在本机行即 installed"⇒ 第 3 条必红。
 */
describe('A6/N1 本机行与同名商店行的归并（只依赖合并结果，不依赖到达顺序）', () => {
  /** `?source=market` 的目录行：host 已按磁盘状态补 installed/installedOrigin/installedVersion。 */
  const catalogRow = (name: string, version: string, installedVersion: string): CapabilityItem => ({
    kind: 'skill', source: 'market', name, displayName: name, version, description: '目录说明',
    author: 'someone', status: 'approved', versions: [version], installed: true,
    installedVersion, installedOrigin: 'store', official: false, downloads: 3, calls: 1, score: 10,
    isOwner: false,
  })
  /** `?source=local` 的本机行（扫盘得到）：**不带 installed**，来源字段来自磁盘 provenance。 */
  const localRow = (name: string, version: string, originChannel?: string): CapabilityItem => ({
    kind: 'skill', source: 'local', name, displayName: name, runtimeName: name, version,
    description: '本机说明', author: '', versions: [], isLocal: true, installedOrigin: 'store',
    ...originChannel === undefined ? {} : { originChannel, originAppId: name, dirty: false },
  })

  /** 两次取数的载荷（同一份服务端目录行会同时出现在两个分支里）。 */
  const MARKET: CapabilityItem[] = [catalogRow('app-builder', '1.0.0', '1.0.0'), catalogRow('codeql', '1.2.0', '1.0.0')]
  const LOCAL: CapabilityItem[] = [
    catalogRow('app-builder', '1.0.0', '1.0.0'),
    catalogRow('codeql', '1.2.0', '1.0.0'),
    localRow('app-builder', '1.0.0', 'plugin'),
    localRow('my-draft', '1.0.0'),
  ]
  const EMPTY: CapabilityItem[] = []

  /** market 先到（常见）：mine 的归约会把商店行留着，本机行追加在后。 */
  const marketFirst = (): CapabilityItem[] =>
    mergeItems(itemsForTab(applySectionRows(applySectionRows(EMPTY, 'market', MARKET), 'mine', LOCAL), 'mine'))
  /** mine 先到：market 的归约会先清掉非本机行，商店行由 market 那一发补上。 */
  const mineFirst = (): CapabilityItem[] =>
    mergeItems(itemsForTab(applySectionRows(applySectionRows(EMPTY, 'mine', LOCAL), 'market', MARKET), 'mine'))

  const pick = (rows: CapabilityItem[], name: string): CapabilityItem => {
    const found = rows.find(row => row.name === name)
    expect(found, `${name} 必须出现在「我的」`).toBeDefined()
    return found!
  }

  it('两种到达顺序给出逐字相同的卡片数据（N1 的根因面）', () => {
    expect(mineFirst()).toEqual(marketFirst())
    // 三种卡（内置技能 / 商店已装 / 本机创作）都在，且各只有一张。
    expect(marketFirst().map(row => row.name).sort()).toEqual(['app-builder', 'codeql', 'my-draft'])
  })

  it('同名商店行存在时仍带 provenance ⇒ 「随客户端内置」徽章 + 卸载按钮都渲染得出（A6 验收点）', () => {
    for (const merged of [marketFirst(), mineFirst()]) {
      const item = pick(merged, 'app-builder')
      expect(item.installed).toBe(true)
      expect(item.originChannel).toBe('plugin')
      expect(capabilitySourceBadgeKey(item, 'mine')).toBe('capability.sourcePlugin')
      expect(planCardAction(item)).toEqual({
        kind: 'uninstall',
        endpoint: '/api/pico/skills/app-builder/uninstall',
        localContent: false,
      })
      // 卸载端点也不是市场那一条（market 分支会拼 /api/pico/skills/:name/uninstall，
      // 恰好同路径；这里钉的是 localRemoveEndpoint 认得它 —— 徽章与入口同源）。
      expect(localRemoveEndpoint(item)).toBe('/api/pico/skills/app-builder/uninstall')
    }
  })

  it('已装的商店行不再随到达顺序退化成「安装」（N1 的第二形态）', () => {
    for (const merged of [marketFirst(), mineFirst()]) {
      const item = pick(merged, 'codeql')
      expect(item.installed).toBe(true)
      expect(item.installedVersion).toBe('1.0.0')
      expect(planCardAction(item)).toEqual({ kind: 'update', version: '1.2.0' })
    }
  })

  it('本机创作（无同名商店行）照常出「上传」，不被归并改写成商店卡', () => {
    for (const merged of [marketFirst(), mineFirst()]) {
      const item = pick(merged, 'my-draft')
      expect(item.source).toBe('local')
      expect(capabilitySourceBadgeKey(item, 'mine')).toBe('capability.sourceLocal')
      expect(planCardAction(item)).toEqual({ kind: 'upload' })
    }
  })

  it('归并结果与输入顺序无关：同一组行正序/倒序归并逐字相同', () => {
    const rows = [...MARKET, ...LOCAL]
    expect(mergeItems([...rows].reverse())).toEqual(mergeItems(rows))
  })
})

// ---------------------------------------------------------------------------
// 独立审计 2026-09-23 A2/A3/A6/A11/A15 —— 覆盖确认与"按版本安装"的纯判据
// ---------------------------------------------------------------------------

describe('A15 覆盖确认判据（needsOverwriteConfirm）', () => {
  const base: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0',
    description: '', author: '', versions: ['1.2.0'], installed: true,
  }

  it('商店来源（store）⇒ 直接更新/重装，不打扰用户', () => {
    expect(needsOverwriteConfirm({ ...base, installedOrigin: 'store' })).toBe(false)
  })

  it('本机自制 / 来源不明（缺 installedOrigin 的历史载荷）⇒ 必须确认', () => {
    expect(needsOverwriteConfirm({ ...base, installedOrigin: 'local' })).toBe(true)
    expect(needsOverwriteConfirm(base)).toBe(true)
  })

  it('未安装 ⇒ 不涉及覆盖', () => {
    expect(needsOverwriteConfirm({ ...base, installed: false, installedOrigin: undefined })).toBe(false)
  })
})

describe('覆盖标记只由"用户已确认"产生（withOverwrite，A2/A3 两端契约）', () => {
  it('installRequestUrl 是唯一的 URL 拼装入口：确认前不带、确认后才带 overwrite', () => {
    const store: CapabilityItem = { kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0', description: '', author: '', versions: ['1.2.0'], installed: true, installedOrigin: 'store' }
    const local: CapabilityItem = { ...store, installedOrigin: 'local' }
    // 商店来源的正常更新：不需要确认 ⇒ 不带标记。
    expect(installRequestUrl(store)).toBe('/api/pico/skills/foo/install')
    // 本机自制同名：未确认不带、确认后才带（面板与宿主两端契约）。
    expect(installRequestUrl(local)).toBe('/api/pico/skills/foo/install')
    expect(installRequestUrl(local, { overwrite: true })).toBe('/api/pico/skills/foo/install?overwrite=1')
    // 用户在详情弹层点选的版本必须跟着走（A11：确认后重放的是同一发）。
    expect(installRequestUrl({ ...local, kind: 'skill', source: 'org' }, { overwrite: true, version: '1.0.0' }))
      .toBe('/api/pico/shared-skills/foo/1.0.0/install?overwrite=1')
  })

  it('installNeedsConfirm 是"确认条可达"的唯一判定入口（A15）', () => {
    const base: CapabilityItem = { kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0', description: '', author: '', versions: ['1.2.0'], installed: true }
    expect(installNeedsConfirm({ ...base, installedOrigin: 'store' })).toBe(false)
    expect(installNeedsConfirm({ ...base, installedOrigin: 'local' })).toBe(true)
    // 用户在确认条上点过之后就不再要确认（否则会自锁成死循环）。
    expect(installNeedsConfirm({ ...base, installedOrigin: 'local' }, { overwrite: true })).toBe(false)
  })

  it('未确认时端点保持无 query（历史死参数 ?force=1 不得回来）', () => {
    const url = installEndpoint({ kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.0.0', description: '', author: '', versions: [], installed: false }, '1.0.0')
    expect(withOverwrite(url, false)).toBe('/api/pico/skills/foo/install')
    expect(withOverwrite(url, false)).not.toContain('?')
  })

  it('确认后带上宿主真的会读的 ?overwrite=1', () => {
    expect(withOverwrite('/api/pico/skills/foo/install', true)).toBe('/api/pico/skills/foo/install?overwrite=1')
    expect(withOverwrite('/api/pico/skills/foo/uninstall', true)).toBe('/api/pico/skills/foo/uninstall?overwrite=1')
    expect(withOverwrite('/api/pico/shared-skills/foo/1.0.0/install', true)).toContain('overwrite=1')
  })

  it('N2：智能体（agent-presets）走同一个标记 —— 宿主侧路由真的读它', () => {
    const agent: CapabilityItem = {
      kind: 'agent', source: 'org', name: 'creative-writer', displayName: '', version: '2.0.0',
      description: '', author: '', versions: ['1.0.0', '2.0.0'], installed: true,
      installedVersion: '1.0.0', installedOrigin: 'store',
    }
    // 商店来源：面板「更新智能体」直接发请求（不带标记）；宿主允许商店来源覆盖。
    expect(planCardAction(agent)).toEqual({ kind: 'update', version: '2.0.0' })
    expect(installNeedsConfirm(agent)).toBe(false)
    expect(installRequestUrl(agent)).toBe('/api/pico/agent-presets/creative-writer/install')
    // 本机自制同名：先出确认条，确认后才把标记交给宿主（否则宿主 409 LOCAL_CONTENT）。
    const local: CapabilityItem = { ...agent, installedOrigin: 'local' }
    expect(installNeedsConfirm(local)).toBe(true)
    expect(installRequestUrl(local)).toBe('/api/pico/agent-presets/creative-writer/install')
    expect(installRequestUrl(local, { overwrite: true })).toBe('/api/pico/agent-presets/creative-writer/install?overwrite=1')
  })
})

describe('A11 「按版本安装」只在端点真的接受版本时出现', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: '', versions: ['1.0.0', '1.2.0'], installed: false }

  it('组织共享技能（端点带版本）⇒ 支持', () => {
    expect(versionInstallSupported(base)).toBe(true)
  })

  it('市场技能（归档端点只按最高 approved 取）⇒ 不支持按版本安装', () => {
    expect(versionInstallSupported({ ...base, source: 'market' })).toBe(false)
  })

  it('智能体（端点不带版本）⇒ 不支持', () => {
    expect(versionInstallSupported({ ...base, kind: 'agent' })).toBe(false)
  })
})

describe('A6 + 跨泳道契约 S2 本机内置技能的卸载端点', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'local', name: 'app-builder', displayName: '', version: '2.5.0', description: '', author: '', versions: [], isLocal: true, installedOrigin: 'store' }

  it('builtin ⇒ 新增的内置技能卸载路由', () => {
    const item = { ...base, originChannel: 'builtin' }
    expect(localRemoveEndpoint(item)).toBe('/api/pico/skills/builtin/app-builder/uninstall')
    expect(uninstallEndpoint(item, '2.5.0')).toBe('/api/pico/skills/builtin/app-builder/uninstall')
  })

  it('plugin（随客户端内置）⇒ 纯本地删除端点，绝不走市场端点', () => {
    const item = { ...base, originChannel: 'plugin' }
    expect(localRemoveEndpoint(item)).toBe('/api/pico/skills/app-builder/uninstall')
    expect(uninstallEndpoint(item, '2.5.0')).toBe('/api/pico/skills/app-builder/uninstall')
  })

  it('自制 / 市场 / 组织来源 ⇒ 不给本机内置的卸载入口（沿用既有规则）', () => {
    expect(localRemoveEndpoint(base)).toBeUndefined()
    expect(localRemoveEndpoint({ ...base, originChannel: 'market' })).toBeUndefined()
    expect(localRemoveEndpoint({ ...base, kind: 'agent', originChannel: 'plugin' })).toBeUndefined()
  })
})


/**
 * 接线判据（渲染层无法当纯函数测的四条链路）。
 *
 * 本仓既有先例：渲染层里"某个回调传了什么"只能靠读源码钉住（`wasm-app-open-route-parity`
 * 读 main.ts、`sandbox-acl-grant-hint` 读产物）。这里钉的正是审计 A2/A3/A11/A15 的
 * 现场 —— 旧实现里"更新按钮硬编码 force"这一行是死代码的来源，而它不会被任何
 * 纯函数用例抓到。
 */
describe('A2/A3/A11/A15 接线判据（源码级）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

  it('更新按钮不再硬编码覆盖确认（确认条才是唯一的覆盖来源）', () => {
    // 旧实现把「更新」的 onClick 写成 `install(item, { overwrite: true })`（硬编码 force）
    // ⇒ 确认条永远是死代码。「该不该出更新」现在由 planCardAction 判（纯判据），
    // 「要不要先确认」由 install() 自己问 installNeedsConfirm（A15 那组用例钉住）。
    const installed: CapabilityItem = {
      kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0',
      description: '', author: '', versions: ['1.1.0', '1.2.0'], installed: true,
      installedVersion: '1.1.0', installedOrigin: 'local',
    }
    expect(planCardAction(installed)).toEqual({ kind: 'update', version: '1.2.0' })
    const update = /plan\.kind === 'update' \? \(([\s\S]*?): plan\.kind === 'reupload'/u.exec(source)
    expect(update, '更新按钮的渲染分支必须存在').not.toBeNull()
    // 更新路径必须走 install() 自己的来源判定：**不传任何选项**（旧实现传了 force）。
    expect(update![1]).toContain('onClick={() => { void install(item) }}')
    expect(update![1]).not.toMatch(/install\(item, \{/u)
    // 页脚只认 planCardAction 给的 kind，不再自己写 `needUpdate ? … : …` 的分支。
    expect(source).not.toContain('const needUpdate = hasUpdateFor(item)')
  })

  it('确认条是唯一的"用户已确认"出口，重放的是同一发安装', () => {
    const strip = /\{installConfirm !== null && \(([\s\S]*?)\n        \)\}/u.exec(source)
    expect(strip, '确认条必须存在').not.toBeNull()
    // 唯一的放行点：点「覆盖安装 / 仍要覆盖」才 run(true)（= 才带 ?overwrite=1）。
    expect(strip![1]).toContain('void pending.run(true)')
    expect(strip![1]).toContain('installConfirm.localConflict')
    // 真正发请求的 performInstall 经 installRequestUrl（唯一 URL 拼装入口）。
    const perform = /const performInstall = async \([\s\S]*?\n  \}/u.exec(source)
    expect(perform, 'performInstall 必须存在').not.toBeNull()
    expect(perform![0]).toContain('const url = installRequestUrl(item, opts)')
    // 闸门：install() 先问 installNeedsConfirm，再交给 performInstall。
    const installBody = /const install = async \([\s\S]*?\n  \}/u.exec(source)
    expect(installBody![0]).toContain('if (installNeedsConfirm(item, opts))')
    expect(installBody![0]).toContain('await performInstall(item, opts)')
    // 409（宿主说目标是本机内容）必须回到确认条，而不是当成失败。
    expect(perform![0]).toContain('localConflict: true')
  })

  it('A11：安装成功后按响应里的真实版本记账，拿不到就留空并重载', () => {
    expect(source).toContain('const appliedVersion = typeof data.version === \'string\' && data.version !== \'\' ? data.version : undefined')
    expect(source).toContain('installedVersion: appliedVersion')
    expect(source).toContain('if (appliedVersion === undefined) loadAll()')
  })

  it('A3：卸载的第二段（用户已确认）才带 overwrite', () => {
    expect(source).toContain('withOverwrite(base, true)')
  })

  it('内置技能入口卡的安装/更新也走同一条确认条（否则「更新到 vX」绕过确认被宿主 409）', () => {
    expect(source).toContain('const activateBuiltinCard = (card: BuiltinCard): void => {')
    expect(source).toContain('await builtin.install(card.skill, overwrite)')
    // 两处按钮都必须经 activateBuiltinCard，不得直接调 builtin.install(skill)。
    expect(source).not.toContain('builtin.install(skill)')
    // 确认条只有一处调用 run(true)。
    expect(source).toContain('void pending.run(true)')
  })
})

/**
 * 审计 C-03（P2）：详情弹层的按版本按钮必须接**站级闸**。
 *
 * 缺陷：`install()` 第一行对"有动作在飞"是静默 `return`，而弹层里的按版本按钮只收到
 * own-key 的 `busy` ⇒ A 卡安装在飞时打开 B 卡详情，按钮是启用态，点下去不发请求、
 * 不改状态、不报错（死按钮）。修法＝把 `inFlight` 传进弹层并置灰 + 说明原因。
 *
 * **为什么是源码级守卫**：本包的测试环境是 node（没有 jsdom / react-dom），跑不了
 * 真实挂载；行为级复现与验证由审计探针
 * `temp/audit-2026-09-23/probes/client/version-button-silent-swallow.spec.tsx` 承担
 * （jsdom + react，修前红 / 修后绿）。本守卫只钉"接线没被拆掉"，与同文件其它
 * 源码级用例（A3/A11/内置卡入口）同一形态。
 *
 * ---- 变异验证 ----
 *   - 弹层按钮改回 `disabled={busy}` ⇒ 第一条红；
 *   - 调用点去掉 `blocked={inFlight}` ⇒ 第二条红；
 *   - 去掉 `title` 说明 ⇒ 第三条红。
 */
describe('C-03：详情弹层的动作按钮必须与 install() 的站级闸同源', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

  it('弹层里的按版本按钮同时吃 own-key busy 与站级 blocked', () => {
    expect(source).toContain('disabled={busy || blocked}')
  })

  it('调用点把站级 inFlight 传进弹层', () => {
    expect(source).toContain('blocked={inFlight}')
    // 弹层的 props 里必须有这一项（否则传了也不生效）。
    expect(source).toContain('blocked: boolean')
  })

  it('禁用时给出原因文案（不能是"点了没反应"）', () => {
    expect(source).toContain("title={blocked && !busy ? t('capability.busyHint') : undefined}")
    // 文案必须走字典（locales-hygiene 会同时钉 zh/en 与引用点）。
    const locales = readFileSync(fileURLToPath(new URL('../src/client/locales.ts', import.meta.url)), 'utf8')
    expect(locales).toContain("'capability.busyHint'")
  })
})
