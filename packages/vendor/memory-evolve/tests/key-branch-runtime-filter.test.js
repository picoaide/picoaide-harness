/**
 * S13-1 / S14-2（2026-09-17 审计，P2）：keyBranchFilter 的运行时开关对
 * `memory list` / `memory expand` 是死开关。
 *
 * 根因：这个键是**运行时键**（设置面板开关 → POST /memory-evolve/api/config →
 * 落盘 plugin-state.json 覆盖层，lib/index.js 的 RUNTIME_KEYS/updateRuntime），
 * 但 `memoryTool` 的工具实例是用 **apply 期解析的静态 config** 构造的
 * （`ctx.tools.register(memoryTool(ctx, config, …))`），list/expand 两处过滤读
 * `config.keyBranchFilter` ⇒ 面板关掉后只有快照注入不再过滤，list/expand 照旧
 * 过滤；而面板提示写的是「关掉后三处都不再过滤」（诊断逃生口），于是用户拿到
 * 一个假逃生口。
 *
 * 本套件刻意**不经过** `apply(ctx, { keyBranchFilter: false })`：那是静态 cordis
 * config 路径，tests/tool-param-contract.test.js 已覆盖，也正是它让这个分裂在
 * 全套里不可见。这里走真实的两条运行时路径：
 *   1) 启动时读 plugin-state.json 覆盖层（重启后的形态）；
 *   2) 真实 POST /memory-evolve/api/config（面板保存的形态）。
 * 两条都必须让 list 与 expand 一起停止过滤，且重新打开后恢复过滤。
 *
 * S13-1 复核（2026-09-17）追加第三条：**第 4 处过滤面** `buildMemoryContext`
 * （COI / 外部执行器的记忆注入，apply 里接在 installCoi 的 memoryContext 上）。
 * 它此前硬编码过滤、不读运行时开关——面板关掉后 COI 注入仍在偷偷藏起别的分支
 * 的 key。这里不直接调用 buildMemoryContext（那只能证明函数签名，证明不了接线），
 * 而是走真实链路：`apply({coiEnabled:true})` → 真实 COI 前缀 API →
 * `POST /coi/tasks` 派一个只注入 key 轨的任务 → 读回落档的最终 prompt。断言
 * 开关关掉后 prompt 里出现仅其它分支的条目、重新打开后又消失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { projectHash } from '../lib/store.js'
import { setLocale } from '../lib/i18n.js'

// 本套件只断言 ok/entries 语义，但钉中文与其它套件一致（i18n.test.js 覆盖英文）。
setLocale('zh')

const OTHER_BRANCH = '仅供其它分支的条目 ONLY-OTHER-BRANCH'
const CURRENT_BRANCH = '当前分支也能看到的条目 ONLY-MAIN'
const OTHER_ID = 'bbbbbbbb'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-key-branch-'))
}

function once(fn) {
  let active = true
  return () => {
    if (!active) return
    active = false
    return fn?.()
  }
}

/** 最小 fake ctx：工具注册 + webServer（API 路由）+ locale 设置服务。 */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], routes: [] }
  const services = {
    tools: {
      register(def) {
        state.tools.push(def)
        return once(() => {
          const index = state.tools.indexOf(def)
          if (index >= 0) state.tools.splice(index, 1)
        })
      },
      get: () => undefined,
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: {
      register(route) {
        state.routes.push(route)
        return once(() => {
          const index = state.routes.indexOf(route)
          if (index >= 0) state.routes.splice(index, 1)
        })
      },
    },
  }
  const settingsService = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: () => () => {},
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      return { dispose: callback(ctx) ?? (() => {}) }
    },
    get: (key) => services[key] ?? (key === 'settings' ? settingsService : undefined),
    effect: (fn) => fn() ?? (() => {}),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

/** 真实 HTTP 上的 API（同源 Origin 是统一写守卫的硬要求，与浏览器一致）。 */
async function startApi(ctx) {
  const route = ctx.state.routes.find((candidate) => candidate.path === '/memory-evolve')
  assert.ok(route, 'memory-evolve API 路由必须注册')
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, body) => {
    const response = await fetch(`${base}/memory-evolve/api/config`, {
      method,
      headers: body === undefined
        ? { origin: base }
        : { 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    config: () => request('GET'),
    patch: (patch) => request('POST', { patch }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const memoryToolOf = (ctx) => {
  const tool = ctx.state.tools.find((candidate) => candidate.name === 'memory')
  assert.ok(tool, 'memory 工具必须注册')
  return tool
}

const execCwd = (cwd) => ({ agent: { session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal })

/** 建真 git 仓库（当前分支 main）并铺两条 key 条目：一条通吃、一条仅其它分支。 */
function seedRepo(dir) {
  const init = spawnSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' })
  assert.equal(init.status, 0, 'git init 必须成功（本套件依赖真实分支名）')
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  const keyDir = join(dir, 'projects', projectHash(dir))
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), [
    '§',
    `[2026-09-17] ${CURRENT_BRANCH}`,
    '§',
    `[2026-09-17] [branch:other-branch] ${OTHER_BRANCH}`,
    '§',
    `[2026-09-17] [id:${OTHER_ID}] [branch:other-branch] ${OTHER_BRANCH}（带 id，供 expand）`,
    '',
  ].join('\n'))
}

/** 一次 list + 一次 expand 的观察结果（expand 打带 id 的那条）。 */
async function observe(tool, dir) {
  const listed = await tool.execute({ action: 'list', target: 'key' }, execCwd(dir))
  assert.equal(listed.ok, true, `list 必须成功：${listed.message}`)
  const joined = listed.entries.join('\n')
  const expanded = await tool.execute({ action: 'expand', target: 'key', id: OTHER_ID }, execCwd(dir))
  return { listed: joined, expanded }
}

test('S13-1/S14-2 persisted overlay：重启后 keyBranchFilter=false，list 与 expand 都不过滤', async () => {
  const dir = tempDir()
  try {
    seedRepo(dir)
    // 面板保存后的落盘形态（lib/index.js loadState → RUNTIME_KEYS 覆盖层）
    writeFileSync(join(dir, 'plugin-state.json'), `${JSON.stringify({ keyBranchFilter: false }, null, 2)}\n`)
    const ctx = fakeCtx()
    // 静态行 config 保持缺省：这正是用户机器上的形态（没有 config.yaml 覆盖）
    apply(ctx, { memoryDir: dir })
    const tool = memoryToolOf(ctx)
    const api = await startApi(ctx)
    try {
      const cfg = await api.config()
      assert.equal(cfg.body.config.keyBranchFilter, false, 'GET /api/config 必须回显覆盖层的 false')
      const seen = await observe(tool, dir)
      assert.match(seen.listed, /ONLY-OTHER-BRANCH/, '关掉开关后 list 必须能看到仅其它分支的条目')
      assert.equal(seen.expanded.ok, true, `关掉开关后 expand 必须能找到该条目：${seen.expanded.message}`)
    } finally {
      await api.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S13-1/S14-2 面板保存：POST /api/config 关掉后 list/expand 立即不过滤，再打开恢复过滤', async () => {
  const dir = tempDir()
  try {
    seedRepo(dir)
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = memoryToolOf(ctx)
    const api = await startApi(ctx)
    try {
      // 1) 缺省（true）：分支过滤生效——这正是修复前"关掉也没用"的对照形态
      const filtered = await observe(tool, dir)
      assert.match(filtered.listed, /ONLY-MAIN/, '无标记条目对所有分支可见')
      assert.doesNotMatch(filtered.listed, /ONLY-OTHER-BRANCH/, '缺省必须过滤掉仅其它分支的条目')
      assert.equal(filtered.expanded.ok, false, '缺省时仅其它分支的条目 expand 不出来')

      // 2) 面板关掉开关（写盘 + 运行时覆盖；不重新 apply）
      const off = await api.patch({ keyBranchFilter: false })
      assert.equal(off.status, 200)
      assert.equal(off.body.config.keyBranchFilter, false)
      const persisted = JSON.parse(readFileSync(join(dir, 'plugin-state.json'), 'utf8'))
      assert.equal(persisted.keyBranchFilter, false, '开关必须落盘到 plugin-state.json')
      const unfiltered = await observe(tool, dir)
      assert.match(unfiltered.listed, /ONLY-OTHER-BRANCH/, '关掉后同一工具实例的 list 必须立即不过滤')
      assert.equal(unfiltered.expanded.ok, true, `关掉后 expand 必须立即不过滤：${unfiltered.expanded.message}`)
      assert.match(String(unfiltered.expanded.entries?.[0] ?? ''), /ONLY-OTHER-BRANCH/, 'expand 必须返回该条正文')

      // 3) 再打开：恢复过滤（证明读的是活值，而不是"关过一次就永久放开"）
      const on = await api.patch({ keyBranchFilter: true })
      assert.equal(on.body.config.keyBranchFilter, true)
      const refiltered = await observe(tool, dir)
      assert.doesNotMatch(refiltered.listed, /ONLY-OTHER-BRANCH/, '重新打开后必须恢复过滤')
      assert.equal(refiltered.expanded.ok, false, '重新打开后该条目必须再次 expand 不出来')
    } finally {
      await api.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const COI_ROUTE = '/memory-evolve/api/coi'
const PROBE_ADAPTER = 'branch-probe'

/** COI 前缀路由（随 coiEnabled:true 装上）的真实 HTTP 调用面。 */
async function startCoiApi(ctx) {
  const route = ctx.state.routes.find((candidate) => candidate.path === COI_ROUTE)
  assert.ok(route, 'coiEnabled:true 时 COI API 路由必须注册')
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined
        ? { origin: base }
        : { 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  return { request, close: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * 派一个只注入 key 轨的 COI 任务，返回落档的最终 prompt（含注入的记忆段）。
 * 适配器指向 process.execPath（`-e 0` 立刻退出），只为把 prompt 走完整条
 * memoryContext → dispatch → 任务留档 的真实链路，不依赖任何外部 CLI。
 */
async function dispatchPrompt(coi, dir) {
  const dispatched = await coi.request('POST', `${COI_ROUTE}/tasks`, {
    adapterId: PROBE_ADAPTER,
    prompt: '分支过滤探针',
    scope: 'project',
    cwd: dir,
    injectTracks: ['key'],
  })
  assert.equal(dispatched.status, 200, `派单必须成功：${JSON.stringify(dispatched.body)}`)
  const detail = await coi.request('GET', `${COI_ROUTE}/tasks/${dispatched.body.taskId}`)
  assert.equal(detail.status, 200, `任务详情必须可读：${JSON.stringify(detail.body)}`)
  return String(detail.body.task?.prompt ?? '')
}

test('S13-1 复核 第 4 处过滤面：COI/外部执行器注入（buildMemoryContext）同样跟随运行时开关', async () => {
  const dir = tempDir()
  try {
    seedRepo(dir)
    const ctx = fakeCtx()
    // skillDir 落在临时目录：别把内置技能同步进跑测试用的 HOME
    apply(ctx, { memoryDir: dir, skillDir: join(dir, 'skills'), coiEnabled: true })
    const api = await startApi(ctx)
    const coi = await startCoiApi(ctx)
    try {
      const registered = await coi.request('POST', `${COI_ROUTE}/adapters`, {
        def: {
          id: PROBE_ADAPTER,
          name: 'Branch probe',
          useCase: '测试探针（不调用真实 CLI）',
          type: 'plain-cli',
          binary: process.execPath,
          args: ['-e', '0'],
          outputParse: 'text',
        },
      })
      assert.equal(registered.status, 200, `探针适配器必须注册成功：${JSON.stringify(registered.body)}`)

      // 1) 缺省（true）：COI 注入按当前分支过滤——修复前这里也是这个形态，
      //    所以下面第 2 步才是判别点。
      const filtered = await dispatchPrompt(coi, dir)
      assert.match(filtered, /ONLY-MAIN/, '无标记条目对所有分支可见')
      assert.doesNotMatch(filtered, /ONLY-OTHER-BRANCH/, '缺省必须过滤掉仅其它分支的条目')

      // 2) 面板关掉开关：同一个已装好的 COI 注入闭包必须立即不过滤
      const off = await api.patch({ keyBranchFilter: false })
      assert.equal(off.body.config.keyBranchFilter, false)
      const unfiltered = await dispatchPrompt(coi, dir)
      assert.match(unfiltered, /ONLY-OTHER-BRANCH/, '关掉开关后 COI 注入必须能看到仅其它分支的条目')

      // 3) 再打开：恢复过滤（读的是活值，不是一次性放开）
      await api.patch({ keyBranchFilter: true })
      const refiltered = await dispatchPrompt(coi, dir)
      assert.doesNotMatch(refiltered, /ONLY-OTHER-BRANCH/, '重新打开后 COI 注入必须恢复过滤')
    } finally {
      await coi.close()
      await api.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
