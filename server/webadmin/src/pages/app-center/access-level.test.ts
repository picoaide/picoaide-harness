import { describe, expect, it } from 'vitest'
import {
  ACCESS_FILTER_ALL,
  ACCESS_FILTERS,
  ACCESS_LEGACY_PUBLIC,
  ACCESS_LEVEL_LABELS,
  ACCESS_LOGIN,
  ACCESS_WHITELIST,
  LEGACY_ACCESS_EXPLAIN,
  LEGACY_ACCESS_LABEL,
  WRITABLE_ACCESS_LEVELS,
  accessLevelRejectionMessage,
  accessMeta,
  isAccessFilterValue,
  isWritableAccessLevel,
  matchesAccessFilter,
} from './access-level'

// ---------------------------------------------------------------------------
// 访问级别口径（2026-09-19 契约 §4.4 / 不变量 I6 / §19 Q13，台账 UX-11）：
//   ① 可写值只有两值（public 退役）；
//   ② 历史 public **必须可见**且渲染成「已退役（历史值）」，带"按 login 执行"的解释；
//   ③ 筛选器只有两值（+全部），但 login 必须命中历史 public（否则存量行筛不出来）。
//
// 每条都写明**变异点**：把哪一行改掉，这条就会红。这是"去掉判据即红"的登记处。
// ---------------------------------------------------------------------------

describe('访问级别 · 可写值只剩两值（I6）', () => {
  it('WRITABLE_ACCESS_LEVELS 恰好是 login | whitelist', () => {
    // 变异验证：往数组里加回 'public'（或任何第三值）⇒ 本用例必红。
    expect(WRITABLE_ACCESS_LEVELS).toEqual([ACCESS_LOGIN, ACCESS_WHITELIST])
    expect(WRITABLE_ACCESS_LEVELS).toHaveLength(2)
  })

  it('isWritableAccessLevel：public 明确不是可写值，未知值也不是', () => {
    expect(isWritableAccessLevel(ACCESS_LOGIN)).toBe(true)
    expect(isWritableAccessLevel(ACCESS_WHITELIST)).toBe(true)
    // 变异验证：把 isWritableAccessLevel 改成 includes(ACCESS_LEGACY_PUBLIC) ⇒ 红。
    expect(isWritableAccessLevel(ACCESS_LEGACY_PUBLIC)).toBe(false)
    expect(isWritableAccessLevel('anonymous')).toBe(false)
  })

  it('两值的标签是中文可读文案（页面/公告/校验消息共用）', () => {
    expect(ACCESS_LEVEL_LABELS[ACCESS_LOGIN]).toBe('登录后全员')
    expect(ACCESS_LEVEL_LABELS[ACCESS_WHITELIST]).toBe('白名单')
    expect(ACCESS_LEVEL_LABELS[ACCESS_LEGACY_PUBLIC]).toBeUndefined()
  })
})

describe('访问级别 · 历史 public 的展示口径', () => {
  it('渲染「已退役（历史值）」：不是裸值、不是「公开」、也不是当前语义', () => {
    const meta = accessMeta(ACCESS_LEGACY_PUBLIC)
    // 变异验证：改回「登录（历史 public）」或「公开」⇒ 红。
    expect(meta.label).toBe(LEGACY_ACCESS_LABEL)
    expect(meta.label).toBe('已退役（历史值）')
    expect(meta.legacy).toBe(true)
    expect(meta.writable).toBe(false)
    // **不得隐藏**：文案非空、且带解释（"服务端按 login 执行"）——
    // 只给一个裸标签会让管理员不知道这些应用现在到底谁能用。
    expect(meta.title).toBe(LEGACY_ACCESS_EXPLAIN)
    expect(meta.title).toContain('按「登录后全员」执行')
    expect(meta.title).toContain('不能再作为访问级别选择')
  })

  it('两值行不是 legacy，未知值原样回显且不可写（不静默吞掉新枚举）', () => {
    for (const v of [ACCESS_LOGIN, ACCESS_WHITELIST]) {
      const meta = accessMeta(v)
      expect(meta.legacy).toBe(false)
      expect(meta.writable).toBe(true)
      expect(meta.title).toBeUndefined()
    }
    const unknown = accessMeta('future-mode')
    expect(unknown.label).toBe('future-mode')
    expect(unknown.writable).toBe(false)
    expect(unknown.legacy).toBe(false)
  })
})

describe('访问级别 · 校验消息（唯一一份）', () => {
  it('只提两值；点名 public 已退役并指出历史行去哪找', () => {
    const msg = accessLevelRejectionMessage(ACCESS_LEGACY_PUBLIC)
    expect(msg).toContain(ACCESS_LOGIN)
    expect(msg).toContain(ACCESS_WHITELIST)
    expect(msg).toContain('两值')
    expect(msg).toContain('已退役')
    // 不能只说"不行"：要给运营动作的下一步（用「登录后全员」筛出存量行）。
    expect(msg).toContain('筛出')
    // 消息里不许把 public 说成可选（变异：写成"请改用 public"⇒ 红）。
    expect(msg).not.toContain('接受 public')
  })

  it('未知取值也给两值口径的消息', () => {
    const msg = accessLevelRejectionMessage('anonymous')
    expect(msg).toContain('login')
    expect(msg).toContain('whitelist')
    expect(msg).toContain('「anonymous」')
  })
})

describe('访问级别 · 筛选器与匹配（§19 Q13"能筛出历史 public"）', () => {
  it('筛选选项只有两值 + 全部，且不含 public/公开', () => {
    // 变异验证：把 { value: 'public' } 加进 ACCESS_FILTERS ⇒ 本用例必红。
    expect(ACCESS_FILTERS.map((f) => f.value)).toEqual([ACCESS_FILTER_ALL, ACCESS_LOGIN, ACCESS_WHITELIST])
    expect(ACCESS_FILTERS.some((f) => f.value === ACCESS_LEGACY_PUBLIC)).toBe(false)
    expect(ACCESS_FILTERS.some((f) => f.label.includes('公开'))).toBe(false)
    // login 选项要提示"含历史已退役值"，否则管理员会以为历史行筛不出来。
    expect(ACCESS_FILTERS.find((f) => f.value === ACCESS_LOGIN)?.hint).toContain('历史')
  })

  it('isAccessFilterValue：public 不是合法筛选值（旧书签要给出拒绝消息）', () => {
    expect(isAccessFilterValue(ACCESS_FILTER_ALL)).toBe(true)
    expect(isAccessFilterValue(ACCESS_LOGIN)).toBe(true)
    expect(isAccessFilterValue(ACCESS_WHITELIST)).toBe(true)
    // 变异验证：让 public 通过 ⇒ 页面不再提示"已退役"，用例红。
    expect(isAccessFilterValue(ACCESS_LEGACY_PUBLIC)).toBe(false)
  })

  it('login 命中 login **与历史 public**；whitelist 只命中白名单', () => {
    // 变异验证：删掉 matchesAccessFilter 里 `|| access === ACCESS_LEGACY_PUBLIC`
    // ⇒ 存量行永远筛不出来（§19 Q13 要修的就是这个）⇒ 第一条断言红。
    expect(matchesAccessFilter(ACCESS_LEGACY_PUBLIC, ACCESS_LOGIN)).toBe(true)
    expect(matchesAccessFilter(ACCESS_LOGIN, ACCESS_LOGIN)).toBe(true)
    expect(matchesAccessFilter(ACCESS_WHITELIST, ACCESS_LOGIN)).toBe(false)
    expect(matchesAccessFilter(ACCESS_LEGACY_PUBLIC, ACCESS_WHITELIST)).toBe(false)
    expect(matchesAccessFilter(ACCESS_WHITELIST, ACCESS_WHITELIST)).toBe(true)
  })

  it('空/全部 = 不过滤；未知行值不会因为"看起来像"而被算进来', () => {
    expect(matchesAccessFilter('anything', ACCESS_FILTER_ALL)).toBe(true)
    expect(matchesAccessFilter('anything', '')).toBe(true)
    expect(matchesAccessFilter('future-mode', ACCESS_LOGIN)).toBe(false)
    expect(matchesAccessFilter('future-mode', ACCESS_WHITELIST)).toBe(false)
  })
})
