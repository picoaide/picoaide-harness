/**
 * 「未登录时记住这次打开」的存储判据（§19 Q4 / §7.6）。
 *
 * 为什么这一层要独立测：客户端登录会**重载页面**（`auth-gate.ts` 的会话 tripwire），
 * 组件 state 活不过那一跳 —— 意图必须落盘，而"落盘的东西什么时候该被丢掉"（TTL、
 * 坏数据、时钟异常）正是最容易写错、也最容易静默出错的地方。
 *
 * ---- 变异验证 ----
 *   - `readOpenIntent` 不做 TTL 判定（永远返回）⇒「过期即丢弃」红；
 *   - `saveOpenIntent` 不写 `at`（或写 0）⇒ 同上红；
 *   - `clearOpenIntent` 不删存储 ⇒「继续之后被清掉」红；
 *   - 坏 JSON 不清理（直接返回 null 但留着）⇒「坏数据被清掉」红。
 */
import { describe, expect, it } from 'vitest'
import {
  OPEN_INTENT_STORAGE_KEY,
  OPEN_INTENT_TTL_MS,
  clearOpenIntent,
  readOpenIntent,
  saveOpenIntent,
  type OpenIntentStore,
} from './open-intent.ts'

/** 内存存储 + 计数（断言"真的删了"）。 */
function memory(seed: Record<string, string> = {}): OpenIntentStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

describe('写入与读回', () => {
  it('写下 app_id + 时间戳，读回同样的意图', () => {
    const store = memory()
    const saved = saveOpenIntent('roster', { store, now: 1_000 })
    expect(saved).toEqual({ appId: 'roster', at: 1_000 })
    expect(readOpenIntent({ store, now: 1_500 })).toEqual({ appId: 'roster', at: 1_000 })
  })

  it('带目标路径（§5.3 的 `?path=`）时一并记住', () => {
    const store = memory()
    saveOpenIntent('roster', { store, now: 1_000, path: '/shifts/today' })
    expect(readOpenIntent({ store, now: 1_000 })).toEqual({ appId: 'roster', path: '/shifts/today', at: 1_000 })
  })

  it('空 app_id 不写（不给"待继续"留一个空目标）', () => {
    const store = memory()
    expect(saveOpenIntent('', { store })).toBeNull()
    expect(store.values.size).toBe(0)
  })

  it('存储不可用 ⇒ 写不进去也读不出来（不抛）', () => {
    expect(saveOpenIntent('roster', { store: null })).toBeNull()
    expect(readOpenIntent({ store: null })).toBeNull()
    expect(() => { clearOpenIntent({ store: null }) }).not.toThrow()
  })
})

describe('TTL 与坏数据（§7.6：过期项直接丢弃，不弹错误）', () => {
  it('超过 TTL ⇒ 读作没有，并顺手清掉', () => {
    const store = memory()
    saveOpenIntent('roster', { store, now: 1_000 })
    expect(readOpenIntent({ store, now: 1_000 + OPEN_INTENT_TTL_MS + 1 })).toBeNull()
    expect(store.values.has(OPEN_INTENT_STORAGE_KEY)).toBe(false)
  })

  it('正好等于 TTL ⇒ 仍然有效（边界不提前丢弃）', () => {
    const store = memory()
    saveOpenIntent('roster', { store, now: 1_000 })
    expect(readOpenIntent({ store, now: 1_000 + OPEN_INTENT_TTL_MS })).not.toBeNull()
  })

  it('时间戳在"未来"（时钟回拨/被改）⇒ 也按过期丢弃（待办不该永远活着）', () => {
    const store = memory()
    saveOpenIntent('roster', { store, now: 10_000 })
    expect(readOpenIntent({ store, now: 5_000 })).toBeNull()
  })

  it('坏 JSON / 缺 appId / 非对象 ⇒ 读作没有并清掉', () => {
    for (const raw of ['{not json', '{}', 'null', '"str"', JSON.stringify({ appId: 42, at: 1_000 })]) {
      const store = memory({ [OPEN_INTENT_STORAGE_KEY]: raw })
      expect(readOpenIntent({ store, now: 1_000 }), raw).toBeNull()
      expect(store.values.has(OPEN_INTENT_STORAGE_KEY), raw).toBe(false)
    }
  })

  it('存储读抛异常 ⇒ 读作没有（不打断面板挂载）', () => {
    const broken: OpenIntentStore = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    }
    expect(readOpenIntent({ store: broken })).toBeNull()
    expect(saveOpenIntent('roster', { store: broken })).toBeNull()
    expect(() => { clearOpenIntent({ store: broken }) }).not.toThrow()
  })
})

describe('清除（继续成功后不留残影）', () => {
  it('clear 之后读不到', () => {
    const store = memory()
    saveOpenIntent('roster', { store, now: 1_000 })
    clearOpenIntent({ store })
    expect(readOpenIntent({ store, now: 1_000 })).toBeNull()
  })
})
