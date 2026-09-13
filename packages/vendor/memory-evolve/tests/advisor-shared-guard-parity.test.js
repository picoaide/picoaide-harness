/**
 * tests/advisor-shared-guard-parity.test.js — me-3 回归（P3，R7 审计）。
 *
 * 缺陷：`lib/advisor/api.js` 保留了**第 10 份**手写同源守卫副本（模块头注释
 * 自己写着"模式复制自 lib/api.js"），与共享实现 `lib/http-guard.js` 的
 * `guardRequest` **不等价**：
 *   - 副本对 GET 完全没有读侧策略 —— 共享实现对浏览器明确标注的跨站请求
 *     (`Sec-Fetch-Site: cross-site`) 返回 403，副本照常 200；
 *   - 副本按"方法是否 POST/PATCH"猜有没有体，声明了 `Content-Type: text/plain`
 *     的无体写请求被放行到路由层；共享实现按 content-length/transfer-encoding
 *     判定有体，声明了非 JSON 的 content-type 一律拒。
 * 结果是同一份策略在两处漂移：加固共享守卫不会传导到 advisor，下一轮必然
 * 漏改。
 *
 * 修复口径：删掉副本，handler 接共享守卫（把守卫的 reason 映射回 advisor
 * 自己的 400/403/415/413 错误契约）。本文件同时锁定**行为等价**（同一请求
 * 打两份实现，拒绝/放行一致）与**结构**（不得再有本地副本）。
 *
 * 「改前失败」证据（改前代码跑本文件）：GET + `Sec-Fetch-Site: cross-site`
 * 用例 advisor 返回 200（断言 403 红）；结构性用例匹配到本地
 * `function sameOriginGuard`（断言不存在红）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAdvisorApi } from '../lib/advisor/api.js'
import { guardRequest } from '../lib/http-guard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADVISOR_API = join(HERE, '..', 'lib', 'advisor', 'api.js')
const HOST = '127.0.0.1:3456'

/** 极简 res 桩：只收集 status 与 body。 */
function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) { out.status = status },
    end(text) { out.body = String(text ?? '') },
  }
}

/** 用安装出来的 advisor handler 打一个请求（有体时用真 Readable 流）。 */
async function callAdvisor(handler, { method, url, headers, body }) {
  const res = fakeRes()
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  }
  if (body !== undefined) {
    const buf = Buffer.from(body)
    req.headers = { ...headers, 'content-length': String(buf.length) }
    // 让 req 自身可异步迭代（真实 node http 请求的形状）
    const stream = Readable.from([buf])
    req[Symbol.asyncIterator] = () => stream[Symbol.asyncIterator]()
  }
  await handler(req, res)
  return { status: res.out.status, json: res.out.body === '' ? null : JSON.parse(res.out.body) }
}

function advisorRig() {
  let captured = null
  const ctx = { webServer: { register(route) { captured = route; return () => {} } } }
  const ctrl = {
    configSnapshot: () => ({ advisorMaxMessages: 20 }),
    sessionExists: () => true,
    status: () => ({ enabled: true }),
    queryEvents: () => ({ events: [], seq: 0 }),
    queryRecords: () => ({ records: [] }),
    instructionsOf: () => [],
    scopesOf: () => ({}),
    setSessionOverride: () => ({ enabled: true }),
  }
  installAdvisorApi(ctx, ctrl)
  assert.ok(captured !== null, 'advisor 路由未注册')
  return captured.handler
}

/* ---------------- 读侧策略（me-3 的决定性差异） ---------------- */

test('me-3：跨站 GET 必须与共享守卫同判（403，不再是 200）', async () => {
  const handler = advisorRig()
  for (const headers of [
    { host: HOST, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    { host: HOST, 'sec-fetch-site': 'cross-site' },
  ]) {
    const advisor = await callAdvisor(handler, { method: 'GET', url: '/memory-evolve/api/advisor/config', headers })
    const shared = await guardRequest({ method: 'GET', url: '/memory-evolve/api/advisor/config', headers })
    assert.equal(shared.status, 403, '共享守卫基线不再是 403：本用例前提失效')
    assert.equal(advisor.status, 403, `跨站 GET 未被拒（advisor=${advisor.status}）：${JSON.stringify(headers)}`)
    assert.equal(advisor.json.ok, false)
  }
})

test('me-3：非跨站 GET（同源/无 Fetch Metadata 头）照常放行', async () => {
  const handler = advisorRig()
  for (const headers of [{ host: HOST }, { host: HOST, 'sec-fetch-site': 'same-origin' }]) {
    const advisor = await callAdvisor(handler, { method: 'GET', url: '/memory-evolve/api/advisor/config', headers })
    const shared = await guardRequest({ method: 'GET', url: '/memory-evolve/api/advisor/config', headers })
    assert.equal(shared, null, '共享守卫基线不再放行：本用例前提失效')
    assert.equal(advisor.status, 200, `正常读侧被误拒：${JSON.stringify(advisor.json)}`)
    assert.equal(advisor.json.ok, true)
  }
})

/* ---------------- 写侧契约（advisor 自己的 400/403/415） ---------------- */

test('me-3：无体写请求声明非 JSON content-type → 415（共享守卫的无体规则）', async () => {
  const handler = advisorRig()
  const advisor = await callAdvisor(handler, {
    method: 'PUT',
    url: '/memory-evolve/api/advisor/scopes',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'text/plain', 'content-length': '0' },
  })
  assert.equal(advisor.status, 415, `无体 + text/plain 未被 content-type 规则拦下：${JSON.stringify(advisor.json)}`)
  assert.equal(advisor.json.code, 'UNSUPPORTED_MEDIA_TYPE')
})

test('me-3：写请求缺 / 跨站 Origin 仍按 advisor 契约 403 FORBIDDEN', async () => {
  const handler = advisorRig()
  const body = JSON.stringify({ sessionId: 'session-1', enabled: true })
  const jsonHeaders = { host: HOST, 'content-type': 'application/json' }

  const noOrigin = await callAdvisor(handler, {
    method: 'POST', url: '/memory-evolve/api/advisor/toggle', headers: jsonHeaders, body,
  })
  assert.equal(noOrigin.status, 403, `缺 Origin 的写请求未被拒：${JSON.stringify(noOrigin.json)}`)
  assert.equal(noOrigin.json.code, 'FORBIDDEN')

  const cross = await callAdvisor(handler, {
    method: 'POST',
    url: '/memory-evolve/api/advisor/toggle',
    headers: { ...jsonHeaders, origin: 'http://evil.example.com' },
    body,
  })
  assert.equal(cross.status, 403, `跨站 Origin 的写请求未被拒：${JSON.stringify(cross.json)}`)
  assert.equal(cross.json.code, 'FORBIDDEN')

  const ok = await callAdvisor(handler, {
    method: 'POST',
    url: '/memory-evolve/api/advisor/toggle',
    headers: { ...jsonHeaders, origin: `http://${HOST}` },
    body,
  })
  assert.equal(ok.status, 200, `同源写请求被误拒：${JSON.stringify(ok.json)}`)
})

/* ---------------- 结构性：副本必须消失 ---------------- */

test('me-3：advisor 不得再保留本地同源守卫副本', () => {
  const src = readFileSync(ADVISOR_API, 'utf8')
  assert.doesNotMatch(src, /function\s+sameOriginGuard\s*\(/, 'advisor 又长出了本地守卫副本（策略漂移会再次发生）')
  assert.match(src, /from\s+'\.\.\/http-guard\.js'/, 'advisor 必须 import 共享守卫模块')
  assert.match(src, /\bguardRequestReasoned\s*\(/, 'advisor 必须调用共享守卫（带 reason 以便映射自有契约）')
})
