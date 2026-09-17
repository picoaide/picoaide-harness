/**
 * COI「会话」子 Tab 的查询参数名：客户端 ↔ 宿主契约回归（2026-09-17 审计 P2）。
 *
 * 缺陷形态（本区间引入的真实回归）：#77 的 i18n 迁移把所有私有文案键统一加上
 * `coi.` 前缀时，把**查询参数名**一起改了 —— 客户端发 `?coi.scope=…&coi.q=…`，
 * 而宿主 `lib/coi/api.js` 只读 `?scope` / `?q`。未知参数被静默忽略，于是范围
 * 过滤与搜索在两个方向上都失效（用户以为搜过了，其实拿到全量列表），v2.7.4
 * 本来是好的。
 *
 * 为什么既有 1013 例全绿也拦不住：字典键守的是 `t()` 的键、`dict-params-passthrough`
 * 守的是插值参数透传、宿主 `coi.test.js` 用 `?q=API` 只测另一端 —— 两端各测各的，
 * 没有任何断言把「客户端实际发出的参数名」与「宿主实际读取的参数名」对起来。
 * 本文件就是那条对拍断言，且三份载体都钉（src / 入库产物 lib/client.js / 宿主）。
 *
 * 判别力：把任意一侧的参数名改回 `coi.scope`（或把宿主改名），本文件必红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC_COI_VIEW = join(PACKAGE_ROOT, 'src', 'client', 'CoIView.tsx')
const BUNDLE = join(PACKAGE_ROOT, 'lib', 'client.js')
const HOST_API = join(PACKAGE_ROOT, 'lib', 'coi', 'api.js')

/** 宿主 `${base}/tasks` 路由实际接受的查询参数名。 */
function hostAcceptedNames() {
  const text = readFileSync(HOST_API, 'utf8')
  const start = text.indexOf('path === `${base}/tasks`')
  assert.notEqual(start, -1, 'host /tasks route not found in lib/coi/api.js')
  // 该分支直到下一个路由判断为止（同一 if 体内），足够覆盖它读取的全部参数。
  const end = text.indexOf('path === `${base}/tasks/`', start)
  const block = text.slice(start, end === -1 ? start + 4000 : end)
  const names = new Set()
  for (const m of block.matchAll(/url\.searchParams\.get\((['"])([^'"]+)\1\)/g)) names.add(m[2])
  return names
}

/** 客户端「会话」子 Tab 通过 `params.set(...)` 发出的参数名（src 版本）。 */
function clientSentNamesFromSource() {
  const text = readFileSync(SRC_COI_VIEW, 'utf8')
  const start = text.indexOf('function SessionsPane(')
  assert.notEqual(start, -1, 'SessionsPane not found in src/client/CoIView.tsx')
  const end = text.indexOf('/sessions?${params.toString()}', start)
  assert.notEqual(end, -1, 'sessions fetch not found in src/client/CoIView.tsx')
  const block = text.slice(start, end)
  const names = new Set()
  for (const m of block.matchAll(/params\.set\((['"])([^'"]+)\1/g)) names.add(m[2])
  return names
}

/** 同一段逻辑在**入库产物**里的参数名（lib/client.js 随安装包分发，必须同形）。 */
function clientSentNamesFromBundle() {
  const text = readFileSync(BUNDLE, 'utf8')
  const end = text.indexOf('/sessions?${params.toString()}')
  assert.notEqual(end, -1, 'sessions fetch not found in lib/client.js')
  const block = text.slice(Math.max(0, end - 2000), end)
  const names = new Set()
  for (const m of block.matchAll(/params\.set\((['"])([^'"]+)\1/g)) names.add(m[2])
  return names
}

test('两端参数名一致：客户端发出的每个参数宿主都读', () => {
  const accepted = hostAcceptedNames()
  const sent = clientSentNamesFromSource()
  assert.deepEqual([...sent].sort(), ['q', 'scope'], 'src 侧参数名必须是 scope/q')
  const unknown = [...sent].filter((name) => !accepted.has(name))
  assert.deepEqual(unknown, [], `客户端发了宿主不读的参数：${unknown.join(', ')}（宿主接受：${[...accepted].join(', ')}）`)
  assert.ok(accepted.has('sessionId'), '宿主必须仍接受 sessionId（visQs 依赖它）')
})

test('入库产物 lib/client.js 与 src 同参数名（只改 src 等于没修）', () => {
  const accepted = hostAcceptedNames()
  const sent = clientSentNamesFromBundle()
  assert.deepEqual([...sent].sort(), ['q', 'scope'], 'lib/client.js 侧参数名必须是 scope/q')
  const unknown = [...sent].filter((name) => !accepted.has(name))
  assert.deepEqual(unknown, [], `产物里出现了宿主不读的参数：${unknown.join(', ')}`)
})

test('回归哨兵：参数名不得再被字典前缀污染', () => {
  for (const [label, file] of [['src', SRC_COI_VIEW], ['bundle', BUNDLE]]) {
    const text = readFileSync(file, 'utf8')
    const start = file === BUNDLE ? text.indexOf('/sessions?${params.toString()}') - 2000 : 0
    const block = file === BUNDLE ? text.slice(Math.max(0, start), start + 2000) : text
    assert.ok(!/params\.set\((['"])coi\./.test(block), `${label}：查询参数名被加了 coi. 前缀（宿主只读 scope/q）`)
  }
})
