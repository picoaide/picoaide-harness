/**
 * tests/api-same-origin-guard.test.js — `/memory-evolve/*` 统一前置守卫
 * （审计 P1-11：28 端点只有 1 个挂同源守卫）
 *
 * 缺陷：`sameOriginGuard` 只在 `POST /api/update` 一个端点上调用（本文件
 * 注册的 handler 共 45 条路由分支 = 46 个 方法+路径 组合：13 个 GET 路径 /
 * 31 个 POST 路径 / aliases 的 PUT+DELETE）。其余端点上：
 *   - 恶意 Origin 的 POST（`text/plain` 或无 Origin）**到达业务逻辑**；
 *   - 9 条只按 path 匹配的路由（memory-sync/*）连方法都不校验——GET 就能
 *     驱动 `setGlobalRemote` / `globalSync` 等写操作。
 *
 * 修复：`guardRequest` 提升为 handler 的统一前置守卫（先于路由分发）：
 *   - 非 GET/HEAD：Origin 必须与 Host 同源；有体时必须是 application/json
 *     的 JSON 对象（无体的写请求——如浏览器发的别名 DELETE——允许不带
 *     Content-Type，但仍必须带 Origin）；
 *   - GET/HEAD：放行（含设计上公开的 /api/badge），只拒绝浏览器明确标注的
 *     `Sec-Fetch-Site: cross-site`（GET 可能没有 Origin，不能用 Origin 判定）；
 *   - 路由分支补齐方法判定，GET 不再能命中写处理器。
 *
 * 「改前失败」证据：把 lib/api.js 还原（移除 guardRequest 调用、还原 10 条
 * 路由的方法判定）后，本文件 test 1 / test 4 / test 6 / test 7 失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { installApi } from '../lib/api.js'

// 本套断言 pin 中文文案（i18n.test.js 覆盖英文）。
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

/** 极简 API 服务器（真实 store + mock syncOps/models/updateOps）。 */
async function bootApi() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-guard-'))
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { reviewEnabled: true, todoEnabled: true }
  /** 写操作调用记录：守卫必须让这些**一次都不发生**。 */
  const calls = { setup: 0, sync: 0, off: 0, setGlobalRemote: 0, globalSync: 0, setGlobalTrack: 0, reveal: 0, removeExact: 0 }
  const syncOps = {
    setup: async () => { calls.setup += 1; return { kind: 'success', text: 'setup' } },
    sync: async () => { calls.sync += 1; return { kind: 'success', text: 'sync' } },
    off: async () => { calls.off += 1; return { kind: 'success', text: 'off' } },
    setProjectEnabled: async () => ({ kind: 'success', text: 'enabled' }),
    setTrack: async () => ({ kind: 'success', text: 'track' }),
    resolve: async () => { calls.sync += 1; return { kind: 'success', text: 'resolved', remaining: 0 } },
    conflicts: () => [],
    migrate: () => null,
    globalStatus: () => ({ initialized: false, url: '', tracks: {}, uncommitted: 0 }),
    setGlobalTrack: () => { calls.setGlobalTrack += 1; return { kind: 'success', text: 'gt' } },
    globalSync: async () => { calls.globalSync += 1; return { kind: 'success', text: 'gs' } },
    setGlobalRemote: () => { calls.setGlobalRemote += 1; return { kind: 'success', text: 'gr' } },
  }
  const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
  installApi(ctx, {
    store,
    archive,
    queue,
    todoStore,
    getRuntime: () => ({ ...state }),
    updateRuntime: (patch) => { Object.assign(state, patch); return { ...state } },
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    resolveCwd: (sessionId) => (sessionId === 'session-1' ? '/work/proj' : undefined),
    resolveRevealTarget: (target) => (target === 'memoryDir' ? dir : undefined),
    revealPath: () => { calls.reveal += 1 },
    syncStatus: () => ({ enabled: true, initialized: true, uncommitted: 0, behind: 0, conflicts: 0, remoteBranch: 'dsh-shared/x' }),
    syncOps,
    modelsStore: { update: () => null },
    buildModelsSnapshot: async () => ({ providers: [] }),
    updateOps: { status: async () => ({ status: 'up-to-date' }), badgeUpdate: async () => 0, update: async () => ({ ok: false, code: 'unsupported', error: 'x' }) },
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  /**
   * 完全可控的请求：headers 由调用方给（浏览器形状 = origin + json）。
   * @returns {Promise<{status: number, data: object}>}
   */
  const request = async (method, path, options = {}) => {
    const { body, headers = {} } = options
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { base, dir, store, archive, queue, calls, state, request, close: () => new Promise((r) => server.close(r)) }
}

/** 真实 Web UI 的形状：同源 Origin + JSON Content-Type。 */
const gui = (base, body) => ({ body, headers: { 'content-type': 'application/json', origin: base } })

/**
 * 全部**非 GET** 端点（33 条 方法+路径 分支）。守卫必须一条不漏。
 * 这是审计「28 个端点」的实际清点（按 lib/api.js 的路由分支逐条列出）。
 */
const WRITE_ENDPOINTS = [
  ['POST', '/memory-evolve/api/update', { expectedTag: 'v9.9.9' }],
  ['POST', '/memory-evolve/api/config', { patch: { reviewEnabled: false } }],
  ['POST', '/memory-evolve/api/suggestions/approve', { indices: [1] }],
  ['POST', '/memory-evolve/api/suggestions/reject', { indices: [1] }],
  ['POST', '/memory-evolve/api/suggestions/archive', { indices: [1] }],
  ['POST', '/memory-evolve/api/suggestions/approve-all', undefined],
  ['POST', '/memory-evolve/api/suggestions/reject-all', undefined],
  ['POST', '/memory-evolve/api/archive/promote', { target: 'memory', match: 'x' }],
  ['POST', '/memory-evolve/api/archive/delete', { target: 'memory', match: 'x' }],
  ['POST', '/memory-evolve/api/reveal', { target: 'memoryDir' }],
  ['POST', '/memory-evolve/api/key/scope', { sessionId: 'session-1', match: 'x' }],
  ['POST', '/memory-evolve/api/memory/memory', { content: '守卫测试' }],
  ['POST', '/memory-evolve/api/memory/user', { content: '守卫测试' }],
  ['POST', '/memory-evolve/api/memory/key', { sessionId: 'session-1', content: '守卫测试' }],
  ['POST', '/memory-evolve/api/memory/delete', { target: 'memory', match: 'x' }],
  ['POST', '/memory-evolve/api/memory/update', { target: 'memory', match: 'x', content: 'y' }],
  ['POST', '/memory-evolve/api/memory/dsh-only', { target: 'memory', match: 'x' }],
  ['POST', '/memory-evolve/api/memory/archive', { target: 'memory', match: 'x' }],
  ['POST', '/memory-evolve/api/todo', { action: 'add', content: '守卫测试' }],
  ['POST', '/memory-evolve/api/pending-skills/approve', { name: 'x' }],
  ['POST', '/memory-evolve/api/pending-skills/reject', { name: 'x' }],
  ['POST', '/memory-evolve/api/models/update', { provider: 'p', model: 'm' }],
  ['POST', '/memory-evolve/memory-sync/setup', { sessionId: 'session-1' }],
  ['POST', '/memory-evolve/memory-sync/sync', { sessionId: 'session-1' }],
  ['POST', '/memory-evolve/memory-sync/off', { sessionId: 'session-1' }],
  ['POST', '/memory-evolve/memory-sync/project-enabled', { sessionId: 'session-1', enabled: true }],
  ['POST', '/memory-evolve/memory-sync/track', { sessionId: 'session-1', on: true }],
  ['POST', '/memory-evolve/memory-sync/resolve', { sessionId: 'session-1', index: 1, choice: 'ours' }],
  ['POST', '/memory-evolve/memory-sync/global-track', { track: 'memory', on: true }],
  ['POST', '/memory-evolve/memory-sync/global-sync', { push: false }],
  ['POST', '/memory-evolve/memory-sync/global-remote', { url: '', enabled: true }],
  ['PUT', '/memory-evolve/api/aliases/sessA', { name: '小明' }],
  ['DELETE', '/memory-evolve/api/aliases/sessA', undefined],
]

/** 全部**只读**端点（13 个 GET 路径）：设计上可匿名读取，不能被守卫改坏。 */
const READ_ENDPOINTS = [
  '/memory-evolve/api/aliases',
  '/memory-evolve/api/badge',
  '/memory-evolve/api/update/status',
  '/memory-evolve/api/suggestions',
  '/memory-evolve/api/config',
  '/memory-evolve/api/archive',
  '/memory-evolve/memory-sync/status',
  '/memory-evolve/memory-sync/conflicts',
  '/memory-evolve/memory-sync/global-status',
  '/memory-evolve/api/memory-files',
  '/memory-evolve/api/todo',
  '/memory-evolve/api/pending-skills',
  '/memory-evolve/api/models',
]

test('[P1-11] 非 GET 端点全表：跨站 Origin 一律 400 bad-request，业务逻辑零执行', async () => {
  const api = await bootApi()
  try {
    assert.equal(WRITE_ENDPOINTS.length, 33, '非 GET 端点数量变化时请同步更新本表')
    for (const [method, path, body] of WRITE_ENDPOINTS) {
      const res = await api.request(method, path, {
        body,
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      })
      assert.equal(res.status, 400, `${method} ${path} 的跨站请求必须被拒，实际 ${res.status}`)
      assert.equal(res.data.code, 'bad-request', `${method} ${path} 应返回 bad-request`)
    }
    // 写操作一次都没发生（守卫先于路由分发，不是"先执行再报错"）。
    assert.deepEqual(api.calls, { setup: 0, sync: 0, off: 0, setGlobalRemote: 0, globalSync: 0, setGlobalTrack: 0, reveal: 0, removeExact: 0 })
    assert.equal(api.queue.read().length, 0)
    assert.equal(api.store.entriesOf('memory').length, 0)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] 无 Origin 的跨站形态（form / text-plain / 裸 POST）同样被拒', async () => {
  const api = await bootApi()
  try {
    // 复核员在活实例上的探针形态：Content-Type: text/plain + 恶意 Origin。
    // 断言 code=bad-request：守卫的拒绝，而不是"读到业务层才报的参数错"。
    const probe = await api.request('POST', '/memory-evolve/api/memory/delete', {
      body: '{"target":"memory","match":"x"}',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    })
    assert.equal(probe.status, 400)
    assert.equal(probe.data.code, 'bad-request')
    // 老式跨站表单：urlencoded 且无 Origin。
    const form = await api.request('POST', '/memory-evolve/api/memory/delete', {
      body: 'target=memory&match=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.equal(form.status, 400)
    assert.equal(form.data.code, 'bad-request')
    // 无任何头（fetch 会自动加 text/plain;charset=UTF-8）→ 仍被拒。
    const bare = await api.request('POST', '/memory-evolve/api/memory/delete', { body: { target: 'memory', match: 'x' } })
    assert.equal(bare.status, 400)
    assert.equal(bare.data.code, 'bad-request')
    // 极端：text/plain 且带"看起来合法"的 body，也不能过。
    const spoof = await api.request('POST', '/memory-evolve/api/memory/update', {
      body: { target: 'memory', match: 'x', content: 'y' },
      headers: { 'content-type': 'text/plain;charset=json' },
    })
    assert.equal(spoof.status, 400)
    assert.equal(spoof.data.code, 'bad-request')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] GET 端点设计上公开：同源/匿名均 200（GUI 轮询不被改坏）', async () => {
  const api = await bootApi()
  try {
    for (const path of READ_ENDPOINTS) {
      const sameOrigin = await api.request('GET', path, { headers: { 'sec-fetch-site': 'same-origin' } })
      assert.equal(sameOrigin.status, 200, `GET ${path} 同源读取应 200，实际 ${sameOrigin.status}`)
      // 匿名（无 Origin / 无 Sec-Fetch-Site，如 curl、内部服务）同样放行。
      const anonymous = await api.request('GET', path)
      assert.equal(anonymous.status, 200, `GET ${path} 匿名读取应 200，实际 ${anonymous.status}`)
    }
    // badge 是设计上公开的端点（GUI 红点轮询 + Tab 注册探测）。
    const badge = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge.status, 200)
    assert.equal(typeof badge.data.count, 'number')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] GET：浏览器标注的跨站请求被 403（sec-fetch-site 而非 Origin）', async () => {
  const api = await bootApi()
  try {
    for (const path of ['/memory-evolve/api/badge', '/memory-evolve/api/archive', '/memory-evolve/memory-sync/global-status']) {
      const res = await api.request('GET', path, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(res.status, 403, `GET ${path} 跨站应 403，实际 ${res.status}`)
      assert.equal(res.data.code, 'cross-site')
    }
    // same-site / none（地址栏直达、书签）不误伤。
    for (const site of ['same-site', 'none']) {
      const res = await api.request('GET', '/memory-evolve/api/badge', { headers: { 'sec-fetch-site': site } })
      assert.equal(res.status, 200, `sec-fetch-site: ${site} 不应被拒`)
    }
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] 同源写请求照常工作（含浏览器发的无体 DELETE / 无体 POST）', async () => {
  const api = await bootApi()
  try {
    // PUT 别名：浏览器形状（Origin + JSON）
    const put = await api.request('PUT', '/memory-evolve/api/aliases/sessA', gui(api.base, { name: '小明' }))
    assert.equal(put.status, 200)
    // DELETE 别名：浏览器 DELETE 不带 Content-Type、不带体，只带 Origin
    // —— 这是 GUI「清除别名」的真实形状，必须放行（不能一刀切成需认证）。
    const del = await api.request('DELETE', '/memory-evolve/api/aliases/sessA', { headers: { origin: api.base } })
    assert.equal(del.status, 200, `无体 DELETE 应放行，实际 ${JSON.stringify(del.data)}`)
    // 无体 POST（approve-all / reject-all 这类）同样只靠 Origin 守卫。
    const all = await api.request('POST', '/memory-evolve/api/suggestions/approve-all', { headers: { origin: api.base } })
    assert.equal(all.status, 200)
    // 常规 JSON 写请求
    const cfg = await api.request('POST', '/memory-evolve/api/config', gui(api.base, { patch: { reviewEnabled: false } }))
    assert.equal(cfg.status, 200)
    assert.equal(cfg.data.config.reviewEnabled, false)
    const write = await api.request('POST', '/memory-evolve/api/memory/memory', gui(api.base, { content: '同源写入' }))
    assert.equal(write.status, 200)
    assert.equal(api.store.entriesOf('memory').length, 1)
    // 但**无体写请求缺 Origin** 仍被拒（跨站 fetch/simple request 形态）。
    const noOrigin = await api.request('POST', '/memory-evolve/api/suggestions/approve-all')
    assert.equal(noOrigin.status, 400)
    assert.equal(noOrigin.data.code, 'bad-request')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] 只按 path 匹配的路由补齐方法判定：GET 不能驱动写操作', async () => {
  const api = await bootApi()
  try {
    // 改前：GET /memory-sync/global-remote 会调 setGlobalRemote('', true)
    //（无 sessionId，一次普通 GET/链接/预取就能改设备级配置）
    const remote = await api.request('GET', '/memory-evolve/memory-sync/global-remote')
    assert.equal(remote.status, 404, `GET 不应命中写路由，实际 ${remote.status}`)
    // 改前：GET /memory-sync/global-sync 会触发一次真实同步（网络 fetch）
    const gsync = await api.request('GET', '/memory-evolve/memory-sync/global-sync')
    assert.equal(gsync.status, 404)
    // 改前：GET /memory-sync/global-track 会改全局轨开关
    const gtrack = await api.request('GET', '/memory-evolve/memory-sync/global-track')
    assert.equal(gtrack.status, 404)
    assert.equal(api.calls.setGlobalRemote, 0)
    assert.equal(api.calls.globalSync, 0)
    assert.equal(api.calls.setGlobalTrack, 0)
    // 其余只按 path 匹配的写路由同样只接受 POST（改前这些 GET 会带着空
    // 会话上下文走到业务层：400/200 都是"命中了写处理器"）。
    for (const p of ['setup', 'sync', 'off', 'project-enabled', 'track', 'resolve']) {
      const res = await api.request('GET', `/memory-evolve/memory-sync/${p}?sessionId=session-1`)
      assert.equal(res.status, 404, `GET /memory-sync/${p} 不应命中写路由，实际 ${res.status}`)
    }
    assert.equal(api.calls.setup + api.calls.sync + api.calls.off, 0)
    // 只读的 conflicts 保持 GET 可达
    const conflicts = await api.request('GET', '/memory-evolve/memory-sync/conflicts?sessionId=session-1')
    assert.equal(conflicts.status, 200)
    // 正确的方法照常工作（POST + 同源）
    const ok = await api.request('POST', '/memory-evolve/memory-sync/setup', gui(api.base, { sessionId: 'session-1' }))
    assert.equal(ok.status, 200)
    assert.equal(api.calls.setup, 1)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] 守卫先于业务开关与路由：todoEnabled=false 时跨站请求仍是 400（不是 503）', async () => {
  const api = await bootApi()
  try {
    api.state.todoEnabled = false
    const evil = await api.request('POST', '/memory-evolve/api/todo', {
      body: { action: 'add', content: 'x' },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    })
    assert.equal(evil.status, 400)
    // 同源请求才走到业务开关（503 TODO_DISABLED）
    const same = await api.request('POST', '/memory-evolve/api/todo', gui(api.base, { action: 'add', content: 'x' }))
    assert.equal(same.status, 503)
    assert.equal(same.data.code, 'TODO_DISABLED')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] 同源 + JSON 的写请求体仍然必须解析成功（守卫不吞 body）', async () => {
  const api = await bootApi()
  try {
    // 有体但非法 JSON → 400（守卫读体并如实报错，不是静默变成空对象）。
    const bad = await api.request('POST', '/memory-evolve/api/memory/memory', {
      body: '{"content":',
      headers: { 'content-type': 'application/json', origin: api.base },
    })
    assert.equal(bad.status, 400)
    // 顶层数组不是合法对象体（与旧 /api/update 守卫契约一致）。
    const arr = await api.request('POST', '/memory-evolve/api/memory/memory', {
      body: [1, 2],
      headers: { 'content-type': 'application/json', origin: api.base },
    })
    assert.equal(arr.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('[P1-11] 跨站写入零落盘：MEMORY.md 保持原样（记忆注入面不可被跨站污染）', async () => {
  const api = await bootApi()
  try {
    mkdirSync(api.dir, { recursive: true })
    writeFileSync(join(api.dir, 'MEMORY-archive.md'), '')
    // 这条端点在无守卫时**会成功**（同源请求 200 且真的追加一条记忆，
    // 而记忆会注入每个会话的 systemPrompt）——所以用它的"跨站版本"验证。
    const res = await api.request('POST', '/memory-evolve/api/memory/memory', {
      body: { content: '[2026-09-12] 跨站注入的记忆' },
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    })
    assert.equal(res.status, 400)
    assert.equal(res.data.code, 'bad-request')
    assert.equal(api.store.entriesOf('memory').length, 0, '跨站请求绝不能写入记忆')
    assert.equal(api.archive.entriesOf('memory').length, 0)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})
