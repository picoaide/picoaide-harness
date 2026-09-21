/**
 * `picoFootMenu` 登记表的契约用例（冻结契约 §2.2）。
 *
 * 这是"五个插件的底部条目到底还在不在"的**第一层**证据：条目跨 bundle 只能走这个
 * 服务，登记表把"注销幂等 / 排序 / 引用稳定 / 发布"任何一条做错，界面上就是
 * "少一行"或"点了没反应"。
 *
 * ---- 变异验证 ----
 *   - `add` 返回的注销函数不做幂等（第二次调用把别家的条目也删掉）⇒「注销幂等」红；
 *   - `snapshot()` 每次新建数组 ⇒「引用稳定」红；
 *   - `touch()` 顺手重算快照 ⇒「touch 不改引用」红；
 *   - 排序用 `order` 之外的键（或丢掉 tie 保序）⇒「order 排序」「同 order 保登记序」红。
 */
import { describe, expect, it, vi } from 'vitest'
import { createFootMenuService, FOOT_MENU_SERVICE, type FootMenuEntry } from '../src/client/contract.ts'

/** 造一个最小条目（只有 id/order 参与排序断言）。 */
function entry(id: string, order: number, extra: Partial<FootMenuEntry> = {}): FootMenuEntry {
  return { id, order, title: () => id, activate: () => undefined, ...extra }
}

describe('picoFootMenu 登记表', () => {
  it('服务名常量就是注入键（消费者 inject 与 provide 同源）', () => {
    expect(FOOT_MENU_SERVICE).toBe('picoFootMenu')
  })

  it('空表快照是空数组', () => {
    expect(createFootMenuService().snapshot()).toEqual([])
  })

  it('按 order 升序（登记顺序打乱也一样）', () => {
    const service = createFootMenuService()
    service.add(entry('browser', 1))
    service.add(entry('cron', -10))
    service.add(entry('apps', 2))
    service.add(entry('connectors', 0))
    service.add(entry('capability', -1))
    expect(service.snapshot().map(item => item.id)).toEqual(['cron', 'capability', 'connectors', 'browser', 'apps'])
  })

  it('相同 order 保持登记顺序（tie 保序）', () => {
    const service = createFootMenuService()
    service.add(entry('first', 0))
    service.add(entry('second', 0))
    service.add(entry('third', 0))
    expect(service.snapshot().map(item => item.id)).toEqual(['first', 'second', 'third'])
  })

  it('注销函数幂等：第一次摘掉自己，之后再调用什么都不做（不会误删别家条目）', () => {
    const service = createFootMenuService()
    const off = service.add(entry('cron', -10))
    service.add(entry('apps', 2))
    off()
    expect(service.snapshot().map(item => item.id)).toEqual(['apps'])
    off()
    off()
    expect(service.snapshot().map(item => item.id)).toEqual(['apps'])
  })

  it('add/注销都会发布；touch 只发布（通知订阅者）', () => {
    const service = createFootMenuService()
    const seen: number[] = []
    const off = service.subscribe(() => { seen.push(service.snapshot().length) })
    const dispose = service.add(entry('cron', -10))
    service.touch()
    dispose()
    off()
    service.touch()
    expect(seen).toEqual([1, 1, 0])
  })

  it('快照引用稳定：条目集合未变时（含 touch 之后）返回同一引用', () => {
    const service = createFootMenuService()
    const dispose = service.add(entry('cron', -10))
    const first = service.snapshot()
    expect(service.snapshot()).toBe(first)
    service.touch()
    expect(service.snapshot()).toBe(first)
    dispose()
    expect(service.snapshot()).not.toBe(first)
    expect(service.snapshot()).toBe(service.snapshot())
  })

  it('退订后不再收到通知', () => {
    const service = createFootMenuService()
    let calls = 0
    const off = service.subscribe(() => { calls += 1 })
    off()
    service.add(entry('cron', -10))
    expect(calls).toBe(0)
  })

  it('一个订阅者抛错不影响其它订阅者与登记表本身', () => {
    const service = createFootMenuService()
    const seen: string[] = []
    // 这条用例**故意**让订阅者抛错：登记表会 warn（那是被测行为），把噪声收进 spy。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service.subscribe(() => { throw new Error('boom') })
    service.subscribe(() => { seen.push('second') })
    expect(() => { service.add(entry('cron', -10)) }).not.toThrow()
    expect(seen).toEqual(['second'])
    expect(service.snapshot().map(item => item.id)).toEqual(['cron'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('title()/attention() 是渲染时读取的函数，登记后可以变', () => {
    const service = createFootMenuService()
    let waiting = false
    service.add(entry('browser', 1, { title: () => (waiting ? 'AI 等待交还' : '浏览器'), attention: () => waiting }))
    const item = service.snapshot()[0]
    expect(item?.title()).toBe('浏览器')
    expect(item?.attention?.()).toBe(false)
    waiting = true
    expect(item?.title()).toBe('AI 等待交还')
    expect(item?.attention?.()).toBe(true)
  })
})
