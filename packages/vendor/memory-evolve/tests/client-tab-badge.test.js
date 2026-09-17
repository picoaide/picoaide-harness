/**
 * ME-1（2026-09-17 二审 P2）：Tab 红点计数变化**不得重注册** conversation.view
 * 条目。
 *
 * 缺陷形态：计数变化时 `dispose + 重新 register`。上游 ui-renderer 的列表槽
 * 按**条目对象身份**做 React key（scoped-slots.tsx 的 entryKeyOf 是 WeakMap
 * 序号），重注册 = 换 key ⇒ 当前激活的那棵视图整棵重挂：敲到一半的任务
 * prompt、选中的任务与日志面板、搜索词/页码、刚打开的浮层全部归零（
 * `renderSlot('conversation.view', …, { only: active.id })` 只渲染激活 Tab）。
 *
 * 本文件钉两件事：
 *   1. src 侧 createBadgeTab 的行为（计数变化只 poke，条目身份不变；
 *      label thunk 现读计数，所以不重注册也能显示新数字）；
 *   2. 入库产物 lib/client.js 必须与 src 同构（产物才是真正发货的那份）——
 *      五个红点 Tab 的注册点都走 setCount/poke，旧的 dispose+register 标志
 *      必须消失。
 *
 * 判别力：把 tab-badge.js 的 setCount 改回「dispose + 重新 register」，或把
 * poke 去掉，第一组用例必红；把 lib/client.js 里的 setCount 改回
 * registerXxxTab()，第二组必红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBadgeTab } from '../src/client/tab-badge.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(PACKAGE_ROOT, 'lib', 'client.js')
const INDEX_SRC = join(PACKAGE_ROOT, 'src', 'client', 'index.ts')

test('ME-1: 计数变化只 poke 刷新 label，绝不重注册条目', () => {
  const registrations = []
  const pokes = []
  const tab = createBadgeTab(
    (getCount) => {
      // 与 index.ts 的注册点同构：label thunk 里现读 getCount()。
      const label = () => (getCount() > 0 ? `🔴 Tab (${getCount()})` : 'Tab')
      registrations.push(label)
      return () => { /* disposer */ }
    },
    () => { pokes.push(tab.count()) },
  )

  tab.mount()
  tab.mount() // 幂等
  assert.equal(registrations.length, 1, '挂载只注册一次')
  assert.equal(registrations[0](), 'Tab')

  // 计数 0 → 2：label 立刻读到新值，但条目对象/注册次数不变。
  tab.setCount(2)
  assert.equal(pokes.length, 1, '计数变化要 poke 一次（否则上游不会重读 label）')
  assert.equal(registrations.length, 1, '计数变化不得重注册条目（重注册 = React key 变化 = 视图重挂）')
  assert.equal(registrations[0](), '🔴 Tab (2)', 'label thunk 现读计数')
  assert.equal(tab.count(), 2)

  // 同值不 poke；归零后 label 回落到无红点变体。
  tab.setCount(2)
  assert.equal(pokes.length, 1)
  tab.setCount(0)
  assert.equal(pokes.length, 2)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0](), 'Tab')

  // 未注册时的计数只记录，不 poke（没有条目可刷新）。
  tab.dispose()
  assert.equal(tab.mounted(), false)
  tab.setCount(5)
  assert.equal(pokes.length, 2)
  tab.mount()
  assert.equal(registrations[1](), '🔴 Tab (5)')
})

test('ME-1: poke 只写一个「同同步块内立即释放」的空条目（不换真实条目的身份）', () => {
  // 复刻 index.ts 的 pokeTabLabels + 上游账本的最小语义：注册 → 通知 → 释放。
  const ledger = []
  const notifications = []
  const slots = {
    register(options, component) {
      const entry = { options, component }
      ledger.push(entry)
      notifications.push(ledger.map((e) => e.options.id))
      return () => {
        const index = ledger.indexOf(entry)
        if (index !== -1) ledger.splice(index, 1)
      }
    },
  }
  const poke = () => {
    let dispose
    try {
      dispose = slots.register({ name: 'conversation.view', id: 'memory-evolve-label-refresh', order: 999 }, () => null)
    } catch {
      return
    }
    dispose()
  }
  const tab = createBadgeTab(() => () => {}, poke)
  tab.mount()
  // 真实条目（模拟）：身份对象在整个过程里必须是同一个。
  const real = { options: { id: 'memory-files' }, component: () => null }
  ledger.push(real)
  const identity = real

  tab.setCount(1)
  // 通知发生在注册与释放之间，但同步块结束后账本回到原状：空条目不留痕，
  // 真实条目的对象身份（React key 的来源）自始至终不变。
  assert.deepEqual(notifications, [['memory-files', 'memory-evolve-label-refresh']])
  assert.deepEqual(ledger, [identity], '空条目已在同一同步块内释放，账本只剩真实条目')
  assert.equal(ledger[0], identity)
})

test('ME-1 残留（2026-09-17 三轮对抗复核）：poke 的空条目必须在同一同步块内释放（跑入库产物本体）', () => {
  // 旧断言只查字符串（createBadgeTab( / memory-evolve-label-refresh / setCount()），
  // 把产物里 pokeTabLabels 的 `dispose()` 删掉仍然全绿，而账本每个 poke 会泄漏一条
  // memory-evolve-label-refresh：上游第二次 register 撞重复 id（异常被 catch 吞掉）
  // 后标签刷新静默失效，还会渲染出幽灵 Tab。这里把产物里的 pokeTabLabels 取出来
  // 真的跑一遍，断言同步块结束后账本回到原状。
  const bundle = readFileSync(BUNDLE, 'utf8')
  const match = /\n  const pokeTabLabels = \(\) => \{[\s\S]*?\n  \};\n/u.exec(bundle)
  assert.ok(match, 'lib/client.js 找不到 pokeTabLabels')
  const ledger = []
  let registers = 0
  const fakeCtx = {
    slots: {
      register(options) {
        registers += 1
        const entry = { options }
        ledger.push(entry)
        return () => {
          const at = ledger.indexOf(entry)
          if (at !== -1) ledger.splice(at, 1)
        }
      },
    },
  }
  const poke = new Function('ctx', `${match[0]}\nreturn pokeTabLabels;`)(fakeCtx)

  poke()
  // 防假绿：注册通道确实被走过（否则"账本为空"只是因为根本没注册）。
  assert.equal(registers, 1, 'poke 必须经 slots.register 通知账本（否则上游不会重读 label）')
  assert.equal(ledger.length, 0, '空条目必须在同一同步块内出账（删掉 dispose() 即每条泄漏一次）')
  poke()
  assert.equal(ledger.length, 0, '连续 poke 也不得累积条目')
})

test('ME-1: lib/client.js 与 src 同构 —— 五个红点 Tab 走 setCount，旧的重注册标志消失', () => {
  const bundle = readFileSync(BUNDLE, 'utf8')
  const src = readFileSync(INDEX_SRC, 'utf8')

  // 1. 内联产物里必须有 helper（缺了就是「改了 src 没同步产物」）。
  assert.match(bundle, /function createBadgeTab\(register, poke\)/, 'lib/client.js 缺少 createBadgeTab 内联副本')
  assert.match(bundle, /function createTodoTabLifecycle\(register, poke\)/, 'lib/client.js 的 createTodoTabLifecycle 未接 poke')

  // 2. poke 通道 + 五个红点 Tab 的 setCount 调用点（两个载体都必须有）。
  for (const [name, text] of [['lib/client.js', bundle], ['src/client/index.ts', src]]) {
    assert.ok(text.includes('memory-evolve-label-refresh'), `${name}: 缺少 pokeTabLabels 的空条目 id`)
    assert.ok(text.includes('createBadgeTab('), `${name}: 缺少 createBadgeTab 使用点`)
    for (const call of [
      'memoryTab.setCount(',
      'skillsTab.setCount(',
      'settingsTab.setCount(',
      'coiTab.setCount(',
      'promptTab.setCount(',
      'todoTabLifecycle.setCount(',
    ]) {
      assert.ok(text.includes(call), `${name}: 缺少 ${call}（红点计数仍走重注册？）`)
    }
  }

  // 3. poke 必须在**同一同步块内**释放空条目（删掉 dispose() = 每次 poke 泄漏一条，
  //    第二次 register 撞重复 id 后被 catch 吞掉，标签刷新静默失效）。两个载体都钉。
  for (const [name, text] of [['lib/client.js', bundle], ['src/client/index.ts', src]]) {
    const poke = /const pokeTabLabels = [^\n]*\{[\s\S]*?\n  \}/u.exec(text)
    assert.ok(poke, `${name}: 找不到 pokeTabLabels`)
    assert.match(poke[0], /dispose\(\)/u, `${name}: pokeTabLabels 没有释放空条目（账本泄漏）`)
    // 释放必须在 try/catch 之后（同一同步块），而不是只在成功分支里。
    assert.match(poke[0], /\}\s*catch\s*\{[\s\S]*?\}\s*dispose\(\)/u, `${name}: 空条目的释放不在同一同步块内`)
  }

  // 4. 旧的「计数变化 → registerXxxTab() 重注册」标志必须彻底消失。
  for (const stale of [
    'disposeMemoryTab',
    'disposeSkillsTab',
    'disposeSettingsTab',
    'disposeCoiTab',
    'disposePromptTab',
    'memoryBadgeCount',
    'skillsBadgeCount',
    'todosBadgeCount',
    'updateBadgeCount',
    'promptBadgeCount',
    'coiRunningCount',
    'todoTabLifecycle.refresh',
  ]) {
    assert.equal(bundle.includes(stale), false, `lib/client.js 仍残留旧的计数/重注册标志：${stale}`)
    assert.equal(src.includes(stale), false, `src/client/index.ts 仍残留旧的计数/重注册标志：${stale}`)
  }
})
