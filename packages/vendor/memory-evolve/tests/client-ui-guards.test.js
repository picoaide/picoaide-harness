/**
 * ME-9 / ME-10 / ME-11（2026-09-17 二审）行为回归。
 *
 * 三处都是「后台动作抢走用户正在看的东西」：
 *   - ME-9  日志每 2s 轮询无条件滚到底，用户上滚回读中段输出会被反复拽回；
 *   - ME-10 单一提示位的定时器不跟踪不清理，先来的定时器会清掉后到的提示；
 *   - ME-11 搜索/翻页与轮询共用无守卫的 setState，旧响应覆盖新筛选结果。
 *
 * 逻辑住在 src/client/ui-guards.js（无框架纯 JS），这里用假元素/假调度器做
 * 行为断言；同一文件末尾再钉「两个载体（src 源 + 入库产物 lib/client.js）
 * 都接上了这三个闸门」，因为真正发货的是产物。
 *
 * 判别力：把 createScrollFollow.apply 的无条件滚动改回来 / 把
 * createNoticeTimer.show 里的 cancel 去掉 / 把 createLatestOnly 的 token
 * 判定改成恒真，第一组用例必红；把 CoIView/PromptView 的接线改回旧写法，
 * 第二组必红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLatestOnly, createNoticeTimer, createScrollFollow } from '../src/client/ui-guards.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts) => readFileSync(join(PACKAGE_ROOT, ...parts), 'utf8')

/** 假滚动元素：scrollTop 可写，高度固定。 */
function fakeScroller(scrollTop, { scrollHeight = 1000, clientHeight = 200 } = {}) {
  return { scrollTop, scrollHeight, clientHeight }
}

/**
 * 取出入库产物里内联的 createScrollFollow 并**真正执行**（不是字符串匹配：
 * esbuild 的拼写与 src 不同，钉拼写的断言容易变成空转门禁）。
 * @returns {ReturnType<typeof createScrollFollow>} 产物内的那个实例。
 */
function bundleScrollFollow() {
  const bundle = read('lib', 'client.js')
  const match = /\nfunction createScrollFollow\(threshold = SCROLL_FOLLOW_THRESHOLD_PX\) \{[\s\S]*?\n\}\n/u.exec(bundle)
  assert.ok(match, 'lib/client.js 找不到 createScrollFollow 内联副本')
  const factory = new Function('SCROLL_FOLLOW_THRESHOLD_PX', `${match[0]}\nreturn createScrollFollow;`)
  return factory(24)()
}

test('ME-9：用户上滚后不再自动滚到底；滚回底部自动恢复跟随；换任务重置', () => {
  const follow = createScrollFollow(24)
  const el = fakeScroller(800) // 底部：1000-800-200 = 0 ≤ 24

  // 首屏（仍贴底）：新内容到达 → 滚到底
  assert.equal(follow.apply(el), true)
  assert.equal(el.scrollTop, 1000)

  // 用户上滚读中段 → onScroll 记录离开底部
  el.scrollTop = 300
  follow.onScroll(el)
  assert.equal(follow.following(), false)
  // 2s 轮询带来新内容（scrollHeight 变长）→ 必须**不动**滚动位置
  el.scrollHeight = 1200
  assert.equal(follow.apply(el), false)
  assert.equal(el.scrollTop, 300, '用户回读期间不得被拽回底部')

  // 用户自己滚回底部 → 自动恢复跟随
  el.scrollTop = 1000
  follow.onScroll(el)
  assert.equal(follow.following(), true)
  assert.equal(follow.apply(el), true)
  assert.equal(el.scrollTop, 1200)

  // 切任务：即使上一个任务里上滚过，也复位为跟随（新日志从底部跟起）
  el.scrollTop = 100
  follow.onScroll(el)
  follow.reset()
  assert.equal(follow.following(), true)
})

test('ME-9 残留（2026-09-17 三轮对抗复核）：弹窗关闭时喂来的 null ref 不得复位跟随状态', () => {
  // CoIView 的 onLogScroll 把两个 ref 都喂给同一个 createScrollFollow：内联面板
  // （常挂载）在前、全屏弹窗（仅弹窗打开时挂载）在后。弹窗关闭时第二次调用收到
  // null，旧实现把它当"未知元素 = 仍贴底"⇒ following 被**最后一次**调用改写成
  // true，内联面板的上滚闸门整个失效（下一轮 2s 轮询把用户拽回底部）。
  const inline = fakeScroller(300) // 用户上滚到中段
  const full = fakeScroller(1200, { scrollHeight: 1400 }) // 1400-1200-200 = 0：弹窗贴底

  // ① src helper 的行为（modal-closed 路径：第二次调用是 null）。
  const follow = createScrollFollow(24)
  follow.onScroll(inline)
  follow.onScroll(null)
  assert.equal(follow.following(), false, 'null ref 必须保持既有跟随状态（旧写法在这里变回 true）')
  inline.scrollHeight = 1400
  assert.equal(follow.apply(inline), false, '上滚期间新日志不得把用户拽回底部')
  assert.equal(inline.scrollTop, 300)
  // 弹窗打开：两个元素都喂，最后一个是真正被滚动的那个 → 仍按弹窗位置判定。
  follow.onScroll(inline)
  follow.onScroll(full)
  assert.equal(follow.following(), true, '弹窗内的底部滚动仍要恢复跟随（模态行为不变）')
  assert.equal(follow.apply(full), true)
  assert.equal(full.scrollTop, 1400)

  // ② 入库产物里的内联副本必须同行为（产物才是真正发货的那份）。
  const shipped = bundleScrollFollow()
  const bInline = fakeScroller(300)
  shipped.onScroll(bInline)
  shipped.onScroll(null)
  assert.equal(shipped.following(), false, 'lib/client.js 的内联副本未忽略 null ref（弹窗关闭路径）')
  bInline.scrollHeight = 1400
  assert.equal(shipped.apply(bInline), false)
  assert.equal(bInline.scrollTop, 300, '产物：上滚期间不得被拽回底部')
})

test('ME-10：后到的提示不会被前一条的定时器提前清掉，卸载时清理挂起定时器', () => {
  const scheduled = []
  let nextId = 1
  const timer = createNoticeTimer((value) => { applied.push(value) }, {
    delayMs: 4000,
    schedule: (fn) => {
      const handle = { id: nextId++, fn, cancelled: false }
      scheduled.push(handle)
      return handle
    },
    cancel: (handle) => { handle.cancelled = true },
  })
  const applied = []
  const fireAll = () => {
    for (const handle of scheduled.splice(0)) if (!handle.cancelled) handle.fn()
  }

  timer.show('已复制')
  assert.deepEqual(applied, ['已复制'])
  // 4s 内第二条提示：必须重置计时（旧定时器作废）
  timer.show('已停止注入')
  assert.deepEqual(applied, ['已复制', '已停止注入'])
  fireAll()
  // 旧写法在这里会把「已停止注入」一起清成 null（第二条刚出现就消失）。
  assert.deepEqual(applied, ['已复制', '已停止注入', null])

  // 卸载清理：挂起的定时器被取消，事后不再写提示位。
  timer.show('第三条')
  assert.equal(timer.pending(), true)
  timer.dispose()
  assert.equal(timer.pending(), false)
  fireAll()
  assert.deepEqual(applied, ['已复制', '已停止注入', null, '第三条'])
})

test('ME-11：并发请求只认最新一次（旧响应不得落地）', () => {
  const gate = createLatestOnly()
  const isFirst = gate.begin()
  const isSecond = gate.begin()
  // 旧请求后返回：判定为过期，调用方直接 return（不 setState）。
  assert.equal(isFirst(), false)
  assert.equal(isSecond(), true)
  // 完全相同的一次请求重复判定仍然是「最新」。
  assert.equal(isSecond(), true)

  // 卸载/换会话：作废所有在飞请求。
  gate.invalidate()
  assert.equal(isSecond(), false)
  const isThird = gate.begin()
  assert.equal(isThird(), true)
})

test('ME-9/10/11：三个闸门必须同时接在 src 源与入库产物 lib/client.js 上', () => {
  const bundle = read('lib', 'client.js')
  const coi = read('src', 'client', 'CoIView.tsx')
  const prompt = read('src', 'client', 'PromptView.tsx')

  // 产物必须内联同一份 helper（改了 src 没同步产物 = 线上没修）。
  assert.match(bundle, /function createScrollFollow\(/, 'lib/client.js 缺少 createScrollFollow 内联副本')
  assert.match(bundle, /function createNoticeTimer\(/, 'lib/client.js 缺少 createNoticeTimer 内联副本')
  assert.match(bundle, /function createLatestOnly\(/, 'lib/client.js 缺少 createLatestOnly 内联副本')

  // ME-9：日志跟随闸门 + onScroll 接线（两个载体）。
  for (const [name, text] of [['src/client/CoIView.tsx', coi], ['lib/client.js', bundle]]) {
    assert.ok(text.includes('createScrollFollow('), `${name}: 未接 createScrollFollow`)
    assert.ok(text.includes('onLogScroll'), `${name}: 日志 <pre> 未接 onScroll 回调`)
    assert.ok(/onScroll[=:]\s*\{?\s*onLogScroll/.test(text), `${name}: 日志滚动回调未挂到元素上`)
    assert.ok(text.includes('.reset()'), `${name}: 换任务未复位跟随状态`)
    // 旧写法（无条件 scrollTop = scrollHeight）必须消失。
    assert.equal(
      /if \(el !== null\) el\.scrollTop = el\.scrollHeight/.test(text),
      false,
      `${name}: 仍残留无闸门的自动滚动`,
    )
  }

  // ME-10：PromptView 走 createNoticeTimer（两个载体），旧的一次性定时器消失。
  for (const [name, text] of [['src/client/PromptView.tsx', prompt], ['lib/client.js', bundle]]) {
    assert.ok(text.includes('createNoticeTimer('), `${name}: 未接 createNoticeTimer`)
    assert.equal(
      /window\.setTimeout\(\(\) => setNotice\(null\), 4000\)/.test(text),
      false,
      `${name}: 仍残留不跟踪的提示定时器`,
    )
  }

  // ME-11：两处列表请求都过 createLatestOnly（两个载体）。
  for (const [name, text] of [['src/client/CoIView.tsx', coi], ['lib/client.js', bundle]]) {
    assert.equal(
      (text.match(/createLatestOnly\(\)/g) ?? []).length >= 2,
      true,
      `${name}: 任务列表与会话列表都应各有一个序号闸门`,
    )
    assert.ok(text.includes('isCurrent()'), `${name}: 缺少「是否仍是最新」判定`)
  }
})
