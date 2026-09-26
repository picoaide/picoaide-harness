/**
 * 会话作用域清理链的判据（第二十八轮 FIX-40 ③）。
 *
 * 被修的形态（`KNOWN_UNGUARDED_ENTRIES` 里那条）：会话作用域变化时 `index.ts` 是
 * `void windows?.closeAll()` + `void cache?.clearAll()` —— **即发即忘**。`closeAll()` 内部
 * 没有 await（调用即同步关完），但 `clearAll()` 是真异步（`rm -rf` 整个缓存根 + 重建根），
 * 于是"上一代的 `rm` 落在新账号刚写下的缓存**之后**"是一条真实时序：新账号的应用页加载
 * （消费待打开队列的深链 / 本机路由的 open）刚把条目写进缓存根，就被上一代那次 `rm -rf`
 * 连根删掉。
 *
 * # 判据为什么必须打成确定性
 *
 * 这条竞态靠 sleep 去撞是**概率**判据（本仓已登记"判据结论不可复现"这一类假绿）。这里把
 * `clearCache` 换成一个**由用例控制何时落地**的 promise：清理在飞时推进"新作用域的动作"，
 * 再让清理落地，最后断言新作用域写下的内容仍在。确定性、与机器负载无关。
 *
 * # 每个用例都能被打坏
 *
 *  · 用例 2/7：把 `settled()` 换成"立刻返回"（= 修前的即发即忘）⇒ 红；
 *  · 用例 1：把两步并发起来（不串在链上）⇒ 红；
 *  · 用例 5：把 try/catch 去掉 ⇒ 链永久挂住，用例红（这条钉的是"偶发 IO 失败不得升级成
 *    不可自愈的卡死"）；
 *  · 用例 6：把 `leaving === null` 的判据改成"永远清"⇒ 红（§7.6：未登录入队、登录后打开，
 *    未登录→登录不许清掉缓存）；
 *  · 用例 8：把 `index.ts` 的接线改回即发即忘 ⇒ 红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createScopeReset } from './scope-reset.ts'

/** 可控的"清理在飞"闸门：返回落地函数。 */
function gate(): { landed: () => void, wait: Promise<void> } {
  let landed: () => void = () => {}
  const wait = new Promise<void>((resolve) => { landed = resolve })
  return { landed: () => { landed() }, wait }
}

/** 到"当前所有微任务跑完"（用例里的等待都用它，不用 sleep）。 */
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('作用域清理链（FIX-40 ③）', () => {
  it('用例1 顺序：先关窗、后清缓存；两者串行不并发', async () => {
    const events: string[] = []
    const reset = createScopeReset({
      closeWindows: () => { events.push('close') },
      clearCache: async () => { events.push('clear:start'); await flush(); events.push('clear:end') },
      warn: () => { events.push('warn') },
    })
    await reset.start('alice')
    expect(events).toEqual(['close', 'clear:start', 'clear:end'])
  })

  it('用例2 settled()：清理在飞时不落地，落地后立刻返回', async () => {
    const { landed, wait } = gate()
    const reset = createScopeReset({
      closeWindows: () => {},
      clearCache: () => wait,
      warn: () => {},
    })
    void reset.start('alice')

    let settled = false
    const waiting = reset.settled().then(() => { settled = true })
    await flush()
    expect(settled, '清理还在飞 ⇒ 新作用域的动作必须还没被放行').toBe(false)
    landed()
    await waiting
    expect(settled).toBe(true)
  })

  it('用例3 连续换代：两次清理串行（不并发抢同一个缓存根），settled() 等到最后一条', async () => {
    const first = gate()
    const events: string[] = []
    const reset = createScopeReset({
      closeWindows: () => { events.push('close') },
      clearCache: () => {
        const index = events.filter((e) => e.startsWith('clear')).length
        events.push(`clear:${index}`)
        return index === 0 ? first.wait : Promise.resolve()
      },
      warn: () => { events.push('warn') },
    })
    void reset.start('alice')
    void reset.start('bob')
    await flush()
    // 第二次的 clear 必须**等第一次落地**才开始（它是同一个缓存根）。
    expect(events, '第二条清理不得与第一条并发').toEqual(['close', 'close', 'clear:0'])
    first.landed()
    await reset.settled()
    expect(events).toEqual(['close', 'close', 'clear:0', 'clear:1'])
  })

  it('用例4 settled() 的读-比-再读：等待期间又换代 ⇒ 等新的那条', async () => {
    const first = gate()
    const second = gate()
    let count = 0
    const reset = createScopeReset({
      closeWindows: () => {},
      clearCache: () => { count += 1; return count === 1 ? first.wait : second.wait },
      warn: () => {},
    })
    void reset.start('alice')
    let settled = false
    const waiting = reset.settled().then(() => { settled = true })
    await flush()
    void reset.start('bob') // 等待期间换代
    first.landed()
    await flush()
    expect(settled, '第一条落地后仍不得放行：还有第二条在飞').toBe(false)
    second.landed()
    await waiting
    expect(settled).toBe(true)
  })

  it('用例5 fail-open：清理抛错只 warn 一次，链照常落地（不许把 IO 失败升级成卡死）', async () => {
    const warnings: string[] = []
    const reset = createScopeReset({
      closeWindows: () => {},
      clearCache: async () => { throw new Error('EIO') },
      warn: (message) => { warnings.push(message) },
    })
    await reset.start('alice')
    await reset.settled()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('EIO')
    // 后续换代照样能走（链没被卡死）。
    const warnSpy = vi.fn()
    const after = createScopeReset({ closeWindows: () => {}, clearCache: async () => {}, warn: warnSpy })
    await after.start('bob')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('用例6 未登录→登录（leaving === null）：关窗但**不清**缓存（§7.6 未登录入队、登录后打开）', async () => {
    const events: string[] = []
    const reset = createScopeReset({
      closeWindows: () => { events.push('close') },
      clearCache: () => { events.push('clear') },
      warn: () => { events.push('warn') },
    })
    await reset.start(null)
    expect(events).toEqual(['close'])
  })

  it('用例7 核心：迟到完成的清理**不得**作用于新作用域（同一断言打坏修前的即发即忘）', async () => {
    /** 假缓存：`clearAll` 会连根清空，且**何时落地由用例决定**（与真实 `rm -rf` 同形）。 */
    const entries = new Set<string>()
    const { landed, wait } = gate()
    const cache = {
      entries,
      clearAll: async () => { await wait; entries.clear() },
    }

    // ① 修后的接线：新作用域的动作经 `settled()` 排队。
    const fixed = createScopeReset({ closeWindows: () => {}, clearCache: () => cache.clearAll(), warn: () => {} })
    void fixed.start('alice')
    const newScopeWrite = async (): Promise<void> => {
      await fixed.settled()
      entries.add('bob')
    }
    const write = newScopeWrite()
    await flush()
    expect([...entries], '清理还没落地 ⇒ 新作用域还没写任何东西').toEqual([])
    landed()
    await write
    expect([...entries], '清理落地后写入的条目必须留存（修前会被那次 rm 删掉）').toEqual(['bob'])

    // ② 负向对照：修前的形状（即发即忘）—— 同一条断言必须判红。
    entries.clear()
    const second = gate()
    const legacyCache = { clearAll: async () => { await second.wait; entries.clear() } }
    void legacyCache.clearAll() // = 修前的 `void cache?.clearAll()`
    const legacyWrite = async (): Promise<void> => { entries.add('bob') }
    await legacyWrite()
    second.landed()
    await flush()
    expect([...entries], '修前形状：新账号刚写下的条目被上一代的 rm 删掉了（判据必须能看见它）').toEqual([])
  })

  it('用例8 接线：index.ts 必须经清理链调度（begin + settled），不得回到即发即忘', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    // 会话回调里的换代必须经 `begin`（关窗 + 清缓存都在链里）。
    expect(source, 'index.ts 必须用 createScopeReset').toContain('createScopeReset({')
    expect(source, '换代必须经 scopeReset.start(...)').toMatch(/scopeReset\.start\(previous\)/u)
    // 新作用域的第一个动作（消费待打开队列）必须排在清理之后。
    expect(source, 'drainPendingLinks 必须排在 settled() 之后').toMatch(/scopeReset\.settled\(\)\.then\(\(\) => \{ drainPendingLinks\(\) \}\)/u)
    // 本机路由的 open 也必须排队（它同样会建窗并写缓存）。
    expect(source, 'requestOpen 必须先 await settled()').toMatch(/await scopeReset\.settled\(\)/u)
    // 反面：即发即忘的两种写法都不许再出现。
    expect(source, '不得回到即发即忘的 closeAll').not.toContain('void windows?.closeAll()')
    expect(source, '不得回到即发即忘的 clearAll').not.toContain('void cache?.clearAll()')
  })
})
