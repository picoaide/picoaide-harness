/**
 * 应用中心目录的**可发现性**（§19 Q1 冻结）：搜索（名称 / 一句话 / 负责人）
 * + 「我发布的」筛选 + >20 条分批显示。
 *
 * ## 为什么是纯函数模块
 *
 * 目录的三种"什么都没有"必须能被区分：**没有应用**（引导用户让 AI 做一个）、
 * **筛选后没有结果**（换个关键词）、**未登录**（去登录）。它们的判据是
 * `items.length` 与 `filtered.length` 的**组合**，把这套判断留在 JSX 里就会变成
 * "看起来差不多"的散落条件；这里把 {@@link catalogEmptyState} 做成唯一判据，
 * 面板只负责渲染对应文案（每个空态一条用例，改坏即红）。
 *
 * 搜索字段**只有三个**（合约冻结）：`title`（名称）/ `description`（一句话）/
 * `responsible`（负责人）。刻意**不搜** `app_id` 与 `access`：多一个字段就是多一条
 * 产品承诺，而"为什么这个应用搜不到"会变成无法回答的问题。
 *
 * @module @picoaide/dsh-wasm-apps/client/catalog-filter
 */

import type { AppCenterItem } from './AppCenterPanel.tsx'

/** 目录筛选条件（面板持有；两个条件是**与**关系）。 */
export interface CatalogFilter {
  /** 搜索词（空串 = 不过滤；大小写不敏感，两侧 trim）。 */
  query: string
  /** 只看「我发布的」（服务端 `is_owner=true` 的行）。 */
  ownedOnly: boolean
}

/** 目录的默认筛选（板载 = 不过滤）。 */
export const EMPTY_FILTER: CatalogFilter = { query: '', ownedOnly: false }

/**
 * 一批显示多少个（§19 Q1："&gt;20 条分页或虚拟滚动"）。
 *
 * 取**分批显示**（"显示更多"）而不是页码：目录是短列表，页码控件要额外的
 * 上一页/下一页/当前页三处状态，而分批只有一个增量。
 */
export const CATALOG_PAGE_SIZE = 20

/**
 * 一行是否命中搜索词。
 *
 * 匹配口径：三个字段的**原文**（不归一化全角/半角，也不做拼音）做大小写不敏感子串匹配；
 * 空白搜索词命中一切。字段缺失（`undefined`）不参与匹配。
 * @param item - 目录条目。
 * @param query - 已 trim 的搜索词。
 * @returns true = 命中。
 */
function matchesQuery(item: AppCenterItem, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return [item.title, item.description, item.responsible].some(
    field => typeof field === 'string' && field.toLowerCase().includes(needle),
  )
}

/**
 * 按筛选条件过滤目录（顺序保持服务端下发的顺序：目录的排序权威在服务端）。
 * @param items - 服务端目录条目。
 * @param filter - 筛选条件。
 * @returns 过滤后的条目（新数组；原数组不动）。
 */
export function filterCatalog(items: readonly AppCenterItem[], filter: CatalogFilter): AppCenterItem[] {
  const query = filter.query.trim()
  return items.filter(item => (!filter.ownedOnly || item.isOwner) && matchesQuery(item, query))
}

/**
 * 当前筛选条件是否**收窄了**结果（用于区分"没有应用"与"筛选后没有结果"）。
 * @param filter - 筛选条件。
 * @returns true = 用户正带着搜索词或「我发布的」筛选看目录。
 */
export function isFilterActive(filter: CatalogFilter): boolean {
  return filter.query.trim() !== '' || filter.ownedOnly
}

/** 目录正文该渲染哪一种空态（`null` = 有内容可渲染）。 */
export type CatalogEmptyState =
  /** 目录里一个应用都没有（服务端空目录）⇒ 引导让 AI 做一个。 */
  | 'no-apps'
  /** 有应用，但当前筛选条件一个都没命中 ⇒ 提示换关键词 / 清筛选。 */
  | 'no-results'
  /**
   * 当前可见的行**每一行都是下架状态**（§19 Q2 的第二档）。
   *
   * 服务端把下架应用照常列在目录里（F1：下架 ≠ 不存在），所以"全部下架"不会表现为
   * 空列表 —— 必须由客户端**按行状态自行判定**，否则用户看到的是一堆"已下架"行而
   * 没有任何解释与出路（"说明原因 + 联系负责人"）。
   *
   * 判据在**过滤后**的集合上：用户带着筛选条件看时，"你现在看到的都下架了"才是实话。
   */
  | 'all-disabled'

/**
 * 目录空态的唯一判据。
 *
 * 关键区分（变异验证：把 `isFilterActive` 去掉 ⇒ 「筛选后没有结果」会退化成"没有应用"）：
 * 有应用但筛没了，**不得**说"还没有可用的应用" —— 那会让用户以为平台里没有应用，
 * 而真相是他的筛选条件太窄。
 * @param items - 服务端目录条目（未过滤）。
 * @param filtered - 过滤后的条目。
 * @param filter - 当前筛选条件。
 * @returns 要渲染的空态；`null` = 渲染 `filtered`。
 */
export function catalogEmptyState(
  items: readonly AppCenterItem[],
  filtered: readonly AppCenterItem[],
  filter: CatalogFilter,
): CatalogEmptyState | null {
  if (filtered.length > 0) {
    // 有内容可渲染 —— 除非渲染出来的**每一行**都是下架（§19 Q2 第二档）。
    return filtered.every(item => !item.enabled) ? 'all-disabled' : null
  }
  if (items.length === 0) return 'no-apps'
  return isFilterActive(filter) ? 'no-results' : 'no-apps'
}

/**
 * 分批显示：取前 `visible` 条，并给出"还有多少条没显示"。
 *
 * `visible` 至少为 {@link CATALOG_PAGE_SIZE}（否则"显示更多"永远长不出来）。
 * @param items - 过滤后的条目。
 * @param visible - 当前显示条数上限。
 * @returns 本批要渲染的条目与剩余条数。
 */
export function paginateCatalog(items: readonly AppCenterItem[], visible: number): { page: AppCenterItem[], remaining: number } {
  const limit = Math.max(CATALOG_PAGE_SIZE, visible)
  return { page: items.slice(0, limit), remaining: Math.max(0, items.length - limit) }
}
