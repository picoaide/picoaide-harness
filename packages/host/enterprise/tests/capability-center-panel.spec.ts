import { afterEach, describe, expect, it } from 'vitest'
import {
  avatarColor,
  compareVersions,
  hasUpdateFor,
  installEndpoint,
  itemsForTab,
  latestApprovedVersionByName,
  mergeItems,
  nameTakenError,
  planSectionCards,
  uninstallEndpoint,
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
