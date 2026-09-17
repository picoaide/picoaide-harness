/**
 * ME-8（2026-09-17 二审）：版本 Tab 读 /api/update/status 时必须保留宿主的
 * 错误信封。
 *
 * 缺陷形态：`if (!res.ok) throw new Error(\`HTTP ${res.status}\`)` —— 宿主刻意
 * 用 `{ok:false, code, error}` 分级表达失败（422 unsupported=版本检测模块未
 * 装配 / 503 error=服务内部错误），只看 HTTP 状态码会把这些原因整块丢掉，
 * 用户看到「网络请求失败：HTTP 503」；同一组件对 POST /api/update 的失败路径
 * 却会读 outcome.code/outcome.error（两条路径口径不一致）。
 *
 * 断言分两层：helper 行为（假响应）+ 两个载体都接上了（src 源与入库产物
 * lib/client.js，产物才是发货的那份）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostErrorFromResponse, viewErrorOf } from '../src/client/view-error.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('ME-8：宿主信封的 code/error 必须进 ViewError，HTTP 状态只作兜底', () => {
  // 422：版本检测模块未装配（lib/api.js 的 unsupported 分支）
  const unsupported = viewErrorOf(hostErrorFromResponse(422, { ok: false, code: 'unsupported', error: '版本检测模块未装配' }))
  assert.deepEqual(unsupported, { code: 'unsupported', message: '版本检测模块未装配' })

  // 503：版本检测服务内部错误
  const internal = viewErrorOf(hostErrorFromResponse(503, { ok: false, code: 'error', error: '版本检测服务内部错误' }))
  assert.deepEqual(internal, { code: 'error', message: '版本检测服务内部错误' })

  // 无信封（网关/代理裸状态码）：回落 HTTP 文案 + network 分类
  assert.deepEqual(viewErrorOf(hostErrorFromResponse(503, null)), { code: 'network', message: 'HTTP 503' })
  // 只有 message 没有 error 的信封也认
  assert.deepEqual(viewErrorOf(hostErrorFromResponse(500, { message: 'boom' })), { code: 'network', message: 'boom' })

  // 真正的网络层异常（TypeError）仍归 network
  assert.deepEqual(viewErrorOf(new TypeError('Failed to fetch')), { code: 'network', message: 'Failed to fetch' })
})

test('ME-8：版本 Tab 的两个载体都走 hostErrorFromResponse/viewErrorOf（旧的「HTTP 状态码即全部」已消失）', () => {
  const src = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'VersionTabView.tsx'), 'utf8')
  const bundle = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  for (const [name, text] of [['src/client/VersionTabView.tsx', src], ['lib/client.js', bundle]]) {
    assert.ok(text.includes('hostErrorFromResponse('), `${name}: 未接 hostErrorFromResponse`)
    assert.ok(text.includes('viewErrorOf('), `${name}: 未接 viewErrorOf`)
    assert.equal(
      /if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\)/.test(text),
      false,
      `${name}: 仍残留「只看 HTTP 状态码」的旧写法`,
    )
  }
  // 产物必须内联同一份 helper（改了 src 没同步产物 = 线上没修）。
  assert.match(bundle, /function hostErrorFromResponse\(status, body\)/)
  assert.match(bundle, /function viewErrorOf\(err\)/)
})
