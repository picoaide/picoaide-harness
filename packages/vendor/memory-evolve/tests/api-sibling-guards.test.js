/**
 * tests/api-sibling-guards.test.js — FIX-04（2026-09-12）：memory-evolve 的
 * 8 个 sibling `webServer.register` 注册点此前**零请求校验**。
 *
 * 缺陷（审计 FR-P1-1，本文件独立复现）：P1-11 只给 `lib/api.js` 装了同源
 * 守卫，同一插件里 bookmarks / prompts / coi api / canvas / notify-web /
 * coi broadcast / ui-settings / mermaid 的注册点一个没装 —— 跨站页面发出的
 * 「简单请求」（`Origin: https://evil.example` + `Content-Type: text/plain`，
 * 不触发 CORS 预检）能直接落库、发起 COI 本地 CLI 任务、打开本地文件。
 *
 * 修复：守卫提到共享模块 `lib/http-guard.js`（唯一实现点），每个 handler
 * 第一行 `applyRequestGuard`；skills-manager 的手写栅栏换成同一模块的
 * `localTrustFence`。
 *
 * 「改前失败」证据：把 8 个 handler 首行的 `applyRequestGuard` 去掉后，
 * 本文件 test 1/2/3 的跨站断言全部失败（书签 201 落库、通知已读水位被改）。
 * 结构性哨兵（test 4）在 api.js 单模块时代看不到 siblings —— 它扫的是
 * `lib/**` 全部注册点，新增注册点不接守卫会直接红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBookmarks } from '../lib/bookmarks.js'
import { NotificationStore, installNotifyWebApi } from '../lib/notify-web.js'
import { installUiSettings } from '../lib/ui-settings.js'
import { installMermaid } from '../lib/mermaid.js'

const LIB_DIR = fileURLToPath(new URL('../lib', import.meta.url))

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sibling-guard-'))
}

/** fake ctx：捕获注册项（与 ui-settings.test.js / bookmarks.test.js 同款）。 */
function makeCtx(routes) {
  const services = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
  const ctx = {
    agents: { get: () => undefined },
    webServer: services.webServer,
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (key) => services[key],
  }
  return ctx
}

/**
 * 真 node:http + 真 handler + 上游 WebServer 的最长前缀派发规则
 * （deepseek-harness/packages/host/webserver/src/index.ts:322-326）。
 */
async function serve(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let best
    for (const route of routes) {
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
      if (best === undefined || route.path.length > best.path.length) best = route
    }
    if (best === undefined) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"error":"not found"}')
      return
    }
    return best.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('[FIX-04] 跨站简单请求写书签：改前 201 落库，改后 400 且零副作用', async () => {
  const dir = tempDir()
  const routes = []
  const installed = installBookmarks(makeCtx(routes), { memoryDir: dir })
  const server = await serve(routes)
  try {
    // ① 跨站简单请求（无预检）：Origin evil + text/plain —— 审计的原始形态。
    const simple = await fetch(`${server.base}/memory-evolve/api/bookmarks`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ sessionId: 'victim-session', seq: 3, label: 'attacker-label' }),
    })
    assert.equal(simple.status, 400, `跨站简单请求必须被拒，实际 ${simple.status}`)
    assert.equal((await simple.json()).code, 'bad-request')
    assert.equal(installed.store.list('victim-session').length, 0, '跨站请求绝不能落库')

    // ② 跨站 fetch 的 JSON 形态（浏览器会先预检；直接发同样必须被拒）。
    const jsonForm = await fetch(`${server.base}/memory-evolve/api/bookmarks`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'victim-session', seq: 4, label: 'attacker-json' }),
    })
    assert.equal(jsonForm.status, 400)

    // ③ 跨站 DELETE（无体，仅 Origin）。
    const del = await fetch(`${server.base}/memory-evolve/api/bookmarks`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(del.status, 400)
    assert.equal(installed.store.list('victim-session').length, 0)

    // ④ 同源浏览器形状照常工作：守卫不能把 GUI 打死。
    const ok = await fetch(`${server.base}/memory-evolve/api/bookmarks`, {
      method: 'POST',
      headers: { origin: server.base, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'victim-session', seq: 3, label: '真实书签' }),
    })
    assert.equal(ok.status, 201, await ok.text())
    assert.equal(installed.store.list('victim-session').length, 1)

    // ⑤ 设计上公开的 GET 探测端点：匿名仍 200（客户端靠它决定是否注入 Tab）。
    const state = await fetch(`${server.base}/memory-evolve/api/bookmarks/state`)
    assert.equal(state.status, 200)
    assert.deepEqual(await state.json(), { enabled: true })

    // ⑥ 浏览器标注的跨站 GET 被 403（GET 无 Origin，用 Sec-Fetch-Site 判定）。
    const crossRead = await fetch(`${server.base}/memory-evolve/api/bookmarks/state`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossRead.status, 403)
    assert.equal((await crossRead.json()).code, 'cross-site')
  } finally {
    await server.close()
    installed.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[FIX-04] 跨站简单请求标记全部通知已读：改前已读水位被改，改后 400 且未读数不变', async () => {
  const dir = tempDir()
  const routes = []
  const store = new NotificationStore(dir)
  await store.add({ sender: 'sess-1', semantic: 'notify', subject: '账单', content: '本期账单已生成' })
  assert.equal(store.unreadCount(), 1)
  installNotifyWebApi(makeCtx(routes), { store, resolveSenderName: (id) => id })
  const server = await serve(routes)
  try {
    const evil = await fetch(`${server.base}/memory-evolve/api/notifications/readAll`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(evil.status, 400, `跨站 readAll 必须被拒，实际 ${evil.status}`)
    assert.equal(store.unreadCount(), 1, '跨站请求不能改动已读水位')
    // 同源浏览器形状照常工作。
    const ok = await fetch(`${server.base}/memory-evolve/api/notifications/readAll`, {
      method: 'POST',
      headers: { origin: server.base },
    })
    assert.equal(ok.status, 200, await ok.text())
    assert.equal(store.unreadCount(), 0)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[FIX-04] 只读 sibling（ui-settings / mermaid）不被一刀切成需认证', async () => {
  const routes = []
  installUiSettings(makeCtx(routes), { getRunningSnapshot: () => ({ total: 0, groups: [] }) })
  installMermaid(makeCtx(routes))
  const server = await serve(routes)
  try {
    // 匿名（GUI 探测/静态资源）照常 200。
    const state = await fetch(`${server.base}/memory-evolve/api/ui-settings/state`)
    assert.equal(state.status, 200)
    const running = await fetch(`${server.base}/memory-evolve/api/ui-settings/running`)
    assert.equal(running.status, 200)
    const vendor = await fetch(`${server.base}/memory-evolve/mermaid/mermaid.min.js`)
    assert.equal(vendor.status, 200)
    // 跨站读取（浏览器标注）被 403，动作零执行。
    for (const path of ['/memory-evolve/api/ui-settings/state', '/memory-evolve/mermaid/mermaid.min.js']) {
      const cross = await fetch(server.base + path, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(cross.status, 403, `${path} 跨站读取应 403，实际 ${cross.status}`)
    }
  } finally {
    await server.close()
  }
})

// --------------------------------------------------------------- 结构性哨兵

/** 递归收集 lib/**\/*.js。 */
function walkJs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkJs(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * 守卫调用点（共享模块的三个入口；advisor 的本地副本另计，见断言）。
 * 只匹配真正的调用（名字后跟 `(`），不匹配 import 列表或注释里的提及。
 */
const GUARD_CALL_RE = /\b(?:applyRequestGuard|guardRequest|localTrustFence)\s*\(/g
/** 注册点：`.webServer.register(`（tools/skills/slots 的 register 不算）。 */
const REGISTER_RE = /\.webServer\.register\s*\(/g

test('[FIX-04] 结构性对拍：lib/** 每个 webServer.register 注册点都接了守卫', () => {
  const sites = []
  for (const file of walkJs(LIB_DIR)) {
    const src = readFileSync(file, 'utf8')
    const registrations = (src.match(REGISTER_RE) ?? []).length
    if (registrations === 0) continue
    const guards = (src.match(GUARD_CALL_RE) ?? []).length
    sites.push({ file: relative(LIB_DIR, file).split('\\').join('/'), registrations, guards })
  }
  const total = sites.reduce((sum, site) => sum + site.registrations, 0)
  // 注册点数量变化 ⇒ 必须在本测试里重新分类（接守卫 / 登记例外），
  // 而不是让哨兵"只看被测模块"。
  assert.equal(total, 11, `webServer.register 注册点数量变化（现 ${total}）：请同步本哨兵`)
  const unguarded = sites.filter((site) => site.guards < site.registrations).map((site) => site.file)
  assert.deepEqual(
    unguarded,
    ['advisor/api.js'],
    '除 advisor（自有 sameOriginGuard 本地副本，FIX-04 范围外）外，所有注册点必须调用共享守卫',
  )
  // 例外不能悄悄腐烂：advisor 的本地副本必须仍在（否则它就成了真裸奔）。
  const advisor = readFileSync(join(LIB_DIR, 'advisor', 'api.js'), 'utf8')
  assert.match(advisor, /sameOriginGuard\s*\(/, 'advisor 的本地同源守卫被删掉了：要么接共享守卫，要么更新本例外')
})
