/**
 * 目录可发现性与三种空态的**纯判据**（§19 Q1/Q2）。
 *
 * 为什么这些用例必须独立于 React：三种"什么都没有"的区分是**产品口径**（"没有应用"
 * 与"筛选后没有结果"是两句话，说错了用户就去找管理员了），而它们完全由一个纯函数
 * 决定。把它钉在这里，面板只负责把 `catalogEmptyState` 的结果翻成文案。
 *
 * ---- 变异验证 ----
 *   - `filterCatalog` 去掉 `ownedOnly` 那一项 ⇒「我发布的」两条红；
 *   - `matchesQuery` 只留 `title`（少搜一句话/负责人）⇒「按一句话/负责人搜」红；
 *   - `catalogEmptyState` 里直接 `return 'no-apps'`（不区分筛选）⇒「筛选后没有结果」红；
 *   - `isFilterActive` 恒 false ⇒ 同上红；
 *   - `paginateCatalog` 不再 `slice`（一次全渲染）⇒「>20 条分批」红。
 */
import { describe, expect, it } from 'vitest'
import type { AppCenterItem } from './AppCenterPanel.tsx'
import {
  CATALOG_PAGE_SIZE,
  EMPTY_FILTER,
  catalogEmptyState,
  filterCatalog,
  isFilterActive,
  paginateCatalog,
} from './catalog-filter.ts'

/** 一条目录条目（只给筛选关心的字段；其余给最小合法值）。 */
function item(over: Partial<AppCenterItem> & { appId: string }): AppCenterItem {
  return { title: over.appId, description: '', responsible: '', access: 'login', enabled: true, currentVersion: '', isOwner: false, ...over }
}

const ITEMS: AppCenterItem[] = [
  item({ appId: 'shift-notes', title: '值班便签', description: '值班记录与交接', responsible: 'alice', isOwner: true }),
  item({ appId: 'roster', title: '值班表', description: '排班', responsible: 'bob' }),
  item({ appId: 'invoice', title: '发票助手', description: 'OCR 与校验', responsible: '陈晨' }),
]

describe('搜索：名称 / 一句话 / 负责人（只有这三个字段）', () => {
  it('空白搜索词不过滤，顺序保持服务端下发的顺序', () => {
    expect(filterCatalog(ITEMS, EMPTY_FILTER).map(i => i.appId)).toEqual(['shift-notes', 'roster', 'invoice'])
    expect(filterCatalog(ITEMS, { query: '   ', ownedOnly: false })).toHaveLength(3)
  })

  it('按名称 / 一句话 / 负责人命中，大小写不敏感', () => {
    expect(filterCatalog(ITEMS, { query: '值班', ownedOnly: false }).map(i => i.appId)).toEqual(['shift-notes', 'roster'])
    expect(filterCatalog(ITEMS, { query: 'OCR', ownedOnly: false }).map(i => i.appId)).toEqual(['invoice'])
    expect(filterCatalog(ITEMS, { query: 'ALICE', ownedOnly: false }).map(i => i.appId)).toEqual(['shift-notes'])
    expect(filterCatalog(ITEMS, { query: '陈', ownedOnly: false }).map(i => i.appId)).toEqual(['invoice'])
  })

  it('不搜 app_id 与访问级别（多一个字段就是多一条产品承诺）', () => {
    expect(filterCatalog(ITEMS, { query: 'shift-notes', ownedOnly: false })).toEqual([])
    expect(filterCatalog(ITEMS, { query: 'login', ownedOnly: false })).toEqual([])
  })
})

describe('「我发布的」筛选与搜索是**与**关系', () => {
  it('只看 is_owner=true 的行', () => {
    expect(filterCatalog(ITEMS, { query: '', ownedOnly: true }).map(i => i.appId)).toEqual(['shift-notes'])
  })

  it('两个条件同时生效', () => {
    expect(filterCatalog(ITEMS, { query: '值班', ownedOnly: true }).map(i => i.appId)).toEqual(['shift-notes'])
    expect(filterCatalog(ITEMS, { query: '发票', ownedOnly: true })).toEqual([])
  })
})

describe('三种空态的唯一判据（未登录那一种是面板状态，不走这里）', () => {
  it('目录为空 ⇒ no-apps（不管有没有筛选条件）', () => {
    expect(catalogEmptyState([], [], EMPTY_FILTER)).toBe('no-apps')
    expect(catalogEmptyState([], [], { query: 'x', ownedOnly: true })).toBe('no-apps')
  })

  it('有应用 + 筛选命中 ⇒ 不空（null）', () => {
    const filtered = filterCatalog(ITEMS, { query: '值班', ownedOnly: false })
    expect(catalogEmptyState(ITEMS, filtered, { query: '值班', ownedOnly: false })).toBeNull()
  })

  it('有应用 + 筛选一个都没命中 ⇒ no-results（**不是** no-apps）', () => {
    const filter = { query: '不存在的关键词', ownedOnly: false }
    expect(catalogEmptyState(ITEMS, filterCatalog(ITEMS, filter), filter)).toBe('no-results')
    const owned = { query: '', ownedOnly: true }
    const ownedItems = ITEMS.filter(i => !i.isOwner)
    expect(catalogEmptyState(ownedItems, filterCatalog(ownedItems, owned), owned)).toBe('no-results')
  })

  it('有应用但一条都没命中且**没有**筛选条件 ⇒ 仍按 no-apps（防御：不该发生）', () => {
    expect(catalogEmptyState(ITEMS, [], EMPTY_FILTER)).toBe('no-apps')
  })

  it('isFilterActive 只看真正收窄结果的条件', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false)
    expect(isFilterActive({ query: '  ', ownedOnly: false })).toBe(false)
    expect(isFilterActive({ query: 'a', ownedOnly: false })).toBe(true)
    expect(isFilterActive({ query: '', ownedOnly: true })).toBe(true)
  })
})

describe('空态 ③「全部下架」（§19 Q2 第二档：说明原因 + 联系负责人）', () => {
  const offline = (appId: string): AppCenterItem => item({ appId, enabled: false })

  it('列表非空但每一行都是下架 ⇒ all-disabled（**不是** no-apps）', () => {
    const rows = [offline('gone-a'), offline('gone-b')]
    expect(catalogEmptyState(rows, rows, EMPTY_FILTER)).toBe('all-disabled')
  })

  it('只要有一行在架 ⇒ 正常渲染（null），不显示"全部下架"', () => {
    const rows = [item({ appId: 'alive' }), offline('gone-a'), offline('gone-b'), offline('gone-c')]
    expect(catalogEmptyState(rows, rows, EMPTY_FILTER)).toBeNull()
  })

  it('判定在**过滤后**的集合上：筛出来的都下架 ⇒ all-disabled；筛出来还有在架 ⇒ null', () => {
    const rows = [item({ appId: 'alive', isOwner: false }), offline('gone-mine')]
    const owned = { query: '', ownedOnly: false }
    const filtered = filterCatalog(rows, owned)
    expect(filtered).toHaveLength(2)
    expect(catalogEmptyState(rows, filtered, owned)).toBeNull()
    // 只看「我发布的」⇒ 只剩那一条下架的。
    const mine = { query: '', ownedOnly: true }
    const mineRows = [item({ appId: 'alive', isOwner: false }), offline('gone-mine')]
    // 让下架那条成为唯一命中：给它 owner=isOwner=true
    mineRows[1] = { ...mineRows[1]!, isOwner: true }
    const mineFiltered = filterCatalog(mineRows, mine)
    expect(mineFiltered).toHaveLength(1)
    expect(catalogEmptyState(mineRows, mineFiltered, mine)).toBe('all-disabled')
  })

  it('空列表仍是 no-apps（"一个都没有"与"全部下架"不塌缩）', () => {
    expect(catalogEmptyState([], [], EMPTY_FILTER)).toBe('no-apps')
  })
})

describe('>20 条分批显示（§19 Q1）', () => {
  it('一次最多显示 CATALOG_PAGE_SIZE 条，并给出剩余条数', () => {
    const many = Array.from({ length: 25 }, (_unused, index) => item({ appId: `app-${String(index)}` }))
    const first = paginateCatalog(many, CATALOG_PAGE_SIZE)
    expect(first.page).toHaveLength(CATALOG_PAGE_SIZE)
    expect(first.remaining).toBe(25 - CATALOG_PAGE_SIZE)
    const all = paginateCatalog(many, 100)
    expect(all.page).toHaveLength(25)
    expect(all.remaining).toBe(0)
  })

  it('可见上限小于页长时按页长兜底（"显示更多"必须真的能长出来）', () => {
    const many = Array.from({ length: 30 }, (_unused, index) => item({ appId: `app-${String(index)}` }))
    expect(paginateCatalog(many, 1).page).toHaveLength(CATALOG_PAGE_SIZE)
  })
})
