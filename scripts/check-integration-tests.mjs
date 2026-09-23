#!/usr/bin/env node
/**
 * `integration-tests/**` 的可执行守卫（2026-09-23 二轮审计 W3-02/W3-03/W3-04 后新增）。
 *
 * 为什么需要它：这两个集成测试脚本打的是**真实 IdP + 真实服务端**，需要 Docker +
 * Xvfb，因此**整跑不在 CI**（`integration-tests/README.md`：端到端跑需 Docker，可静态
 * 执行的那部分 2026-09-23 起进门禁 —— 就是这个守卫）。
 * 后果是它们长期脱离门禁，腐烂到"**永远不可能通过**"也没人发现：
 *   · `dex-sso-test.py` 的深链断言结构上不可达（urllib 无法跟随自定义 scheme）⇒
 *     全流程正常也 `RESULT: FAIL`；
 *   · `ldap-rbac-brand-test.py` 断言 2026-09-10 已被渠道配置取代的旧 `brand` 契约
 *     （`enabled` / `Acme AI`）⇒ 必然走 else 分支判失败；另一条"auditor 写面被拒
 *     (非 200)"用伪造 cookie ⇒ 恒 401 ⇒ `st != 200` 恒真（零判别力）。
 *
 * 本守卫把**可静态执行的那部分**接进门禁（不需要 Docker / PG / 显示器）：
 *   1. 语法：`integration-tests/**\/*.py` 逐个 `ast.parse`（等价 py_compile，不落 __pycache__）；
 *   2. 判据自检：每个用例脚本的 `--self-test` 必须通过，且"判据夹具"条数达标 ——
 *      自检里每条判据都配了**负例**，负例不被拒就是判据退化（恒真）；
 *   3. **端到端存活**（假网关，本进程内起 http server，端口取 0）：
 *      · `good`：假网关按真契约应答 ⇒ 两个脚本必须 exit 0（证明"正常时应通过"）；
 *      · `skip`：provider 未配置 ⇒ 两个脚本必须 exit 77 且**不得**打印 PASS
 *        （证明 SKIP 与 PASS 可区分，不是"一律报错"也不是"静默通过"）；
 *      · `dex-http-deeplink`：回调 302 到 http 地址而不是深链 ⇒ dex 必须 exit 1
 *        （这正是旧脚本咬不到的那条契约）；
 *      · `ldap-legacy-channel`：`/channel` 回旧 brand 契约 ⇒ ldap 必须 exit 1；
 *      · `ldap-rbac-fall-open`：auditor 的写请求被放行(200) ⇒ ldap 必须 exit 1
 *        （旧脚本那条恒真断言在这里是绿的 —— 变异验证的靶子）。
 *
 * 找不到 python3 时**判失败**（不是跳过）：本仓 CI runner（ubuntu-24.04）自带 python3，
 * "工具不在 ⇒ 静默不查"正是本守卫要根除的形态。
 *
 * 用法：`node scripts/check-integration-tests.mjs`；exit 0 通过、1 有失败。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []
const fail = message => failures.push(message)

/** 契约用例脚本（带 --self-test 与真实断言的那两个）。 */
const CONTRACT_TESTS = [
  { id: 'dex', path: 'integration-tests/dex/dex-sso-test.py', minCases: 15 },
  { id: 'ldap', path: 'integration-tests/openldap/ldap-rbac-brand-test.py', minCases: 15 },
]

/**
 * 用例脚本的绝对路径。
 *
 * 测试缝（**CI 不得设置**）：`CHECK_IT_DEX_SCRIPT` / `CHECK_IT_LDAP_SCRIPT` 可把某个 id
 * 指向别处的副本 —— 用来做"修复前副本 / 变异体"的对照取证（`temp/` 下的探针靠它复用
 * 本文件里的假网关），默认永远是仓库里的真脚本。
 * @param {{ id: string, path: string }} test - 用例条目。
 * @returns {string} 脚本绝对路径。
 */
function scriptPathFor(test) {
  const override = process.env[`CHECK_IT_${test.id.toUpperCase()}_SCRIPT`]
  return override === undefined || override === '' ? join(ROOT, test.path) : resolve(ROOT, override)
}

/**
 * 跑一个用例脚本，返回 { status, output }。
 *
 * ⚠️ 必须**异步** spawn：假网关跑在**本进程**里，`spawnSync` 会把事件循环钉死，
 * 子进程的 HTTP 请求永远等不到应答（实测挂死到 60s 超时）。
 * @param {string} testPath - 用例脚本**绝对路径**（由 {@link scriptPathFor} 给出）。
 * @param {string} base - 假网关地址。
 * @returns {Promise<{ status: number | null, output: string }>} 退出码与合并输出。
 */
function runTest(testPath, base) {
  return new Promise(resolvePromise => {
    const child = spawn('python3', [testPath, base], { cwd: ROOT })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    // 没有 python3 / 无法执行时 spawn 会抛 'error'（而不是 close）：必须落成一条可读的
    // 失败，别让守卫以未捕获异常收尾 —— 但**仍然判失败**（"工具不在 ⇒ 不查"是禁止的）。
    child.on('error', error => {
      clearTimeout(timer)
      output += `\n[无法执行 ${testPath}] ${error.message}\n`
      resolvePromise({ status: null, output })
    })
    child.on('close', status => {
      clearTimeout(timer)
      resolvePromise({ status, output })
    })
  })
}

const SESSION_COOKIE = 'picoaide_session'
const OIDC_STATE_COOKIE = 'picoaide_oidc_state_oidc'
const DEEP_LINK_TOKEN = 't0ken-' + 'a1b2c3d4'.repeat(5)
const CHANNEL_GOOD = {
  channel_id: 'official',
  title: 'Example Harness',
  login: {
    display_name: 'Example',
    tagline: 'tagline',
    welcome: 'welcome',
    logo_url: '/api/client/v2/channel/logo',
  },
  client: { display_name: 'Example', logo_url: '/api/client/v2/channel/logo' },
  favicon_url: '/api/client/v2/channel/favicon',
}
// 门户页假响应：既含新版结构断言要的「客户端下载」一节，也含品牌名
// （旧脚本的判据是 `'下载客户端' in body or 'PicoAide' in body` —— 让"修复前"的
// 失败**只剩**渠道契约那一条，取证才没有噪音）。
const PORTAL_HTML = '<!doctype html><html><body><h1>PicoAide Harness</h1><h2>客户端下载</h2>'
  + '<a class="dl" href="/updates/client/example.AppImage">下载</a></body></html>'
const LOGIN_FORM_HTML = '<!doctype html><html><body><form method="post" action="/dex/auth/local?req=x">'
  + '<input type="text" name="login"><input type="password" name="password"></form></body></html>'
const APPROVAL_HTML = '<!doctype html><html><body><form method="post" action="/dex/approval?req=x">'
  + '<input type="hidden" name="approve" value="true"></form></body></html>'

/** 读掉请求体（不读会让 keep-alive 请求挂住）。 */
function readBody(req) {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => resolve(raw))
  })
}

/** 解析 Cookie 头。 */
function cookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

/**
 * 起一个按场景应答的假网关。
 * @param {string} scenario - good | skip | dex-http-deeplink | ldap-legacy-channel | ldap-rbac-fall-open
 * @returns {Promise<{ base: string, close: () => Promise<void> }>} 监听地址与关闭函数。
 */
function startGateway(scenario) {
  const providerConfigured = scenario !== 'skip'
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`
    const url = new URL(req.url, origin)
    const path = url.pathname
    const json = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    const html = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    const redirect = (status, location, headers = {}) => {
      res.writeHead(status, { Location: location, ...headers })
      res.end()
    }
    const cookie = cookies(req)
    const body = await readBody(req)

    if (path === '/healthz') return json(200, { status: 'ok' })
    if (path === '/api/server/admin/auth/methods') {
      return json(200, {
        methods: [
          { name: 'local', configured: true, browser: false, hidden: false },
          { name: 'ldap', configured: providerConfigured, browser: false, hidden: false },
          { name: 'oidc', configured: providerConfigured, browser: true, hidden: false },
        ],
      })
    }

    // ---- 员工面登录（LDAP 用例）----
    if (path === '/api/client/v2/auth/login' && req.method === 'POST') {
      const payload = JSON.parse(body === '' ? '{}' : body)
      if (payload.username === 'alice' && payload.password === 'alice123') {
        return json(200, { token: 'tok-alice', user: { username: 'alice', role: 'user' } })
      }
      if (payload.username === 'audit01') {
        return json(401, { error: { code: 'AUDITOR_NOT_ALLOWED', message: '审计账号不可登录客户端' } })
      }
      return json(401, { error: { code: 'AUTH_FAILED', message: '用户名或密码错误' } })
    }

    // ---- 管理面登录（LDAP 用例）----
    if (path === '/api/server/admin/login' && req.method === 'POST') {
      const payload = JSON.parse(body === '' ? '{}' : body)
      if (payload.username === 'admin' && payload.password === 'admin123456') {
        return json(200, {
          csrf_token: 'csrf-admin',
          user: { username: 'admin', role: 'super_admin', permissions: ['auth:read', 'auth:write', 'user:write'] },
        }, { 'Set-Cookie': [`${SESSION_COOKIE}=sid-admin; Path=/; HttpOnly`] })
      }
      if (payload.username === 'audit01' && payload.password === 'audit12345') {
        return json(200, {
          csrf_token: 'csrf-auditor',
          user: { username: 'audit01', role: 'auditor', permissions: ['audit:read', 'usage:read', 'user:read'] },
        }, { 'Set-Cookie': [`${SESSION_COOKIE}=sid-auditor; Path=/; HttpOnly`] })
      }
      return json(401, { error: { code: 'AUTH_FAILED', message: '用户名或密码错误' } })
    }

    // ---- auditor 读面（audit:read）----
    if (path === '/api/server/admin/audit' && req.method === 'GET') {
      if (cookie[SESSION_COOKIE] === undefined) {
        return json(401, { error: { code: 'AUTH_REQUIRED', message: '未登录' } })
      }
      return json(200, { items: [], total: 0 })
    }

    // ---- 写面（user:write，auditor 没有）：RBAC 与 CSRF 两道闸 ----
    if (path === '/api/server/admin/users' && req.method === 'POST') {
      const session = cookie[SESSION_COOKIE]
      if (session === undefined) return json(401, { error: { code: 'AUTH_REQUIRED', message: '未登录' } })
      const csrf = String(req.headers['x-csrf-token'] ?? '')
      const expected = session === 'sid-admin' ? 'csrf-admin' : 'csrf-auditor'
      if (csrf !== expected) return json(403, { error: { code: 'CSRF_EXPIRED', message: 'CSRF 校验失败' } })
      if (session === 'sid-auditor') {
        // fall-open 场景 = 权限闸门缺失（auditor 的写请求落到 handler）。
        if (scenario === 'ldap-rbac-fall-open') return json(200, { user: { id: 1, username: '' } })
        return json(403, { error: { code: 'FORBIDDEN', message: '没有权限执行该操作' } })
      }
      return json(400, { error: { code: 'VALIDATION', message: '用户名和密码必填' } })
    }

    // ---- 渠道内容（免登录）----
    if (path === '/api/client/v2/channel' && req.method === 'GET') {
      if (scenario === 'ldap-legacy-channel') return json(200, { enabled: false })
      return json(200, CHANNEL_GOOD)
    }

    // ---- 门户首页 ----
    if (path === '/' && req.method === 'GET') return html(200, PORTAL_HTML)

    // ---- OIDC：登录发起 → IdP 登录页 → approve → 回调 → 深链 ----
    if (path === '/api/client/v2/auth/oidc/login' && req.method === 'GET') {
      const state = 'state-' + 'f'.repeat(16)
      return redirect(302, `${origin}/dex/auth/local?req=${state}&state=${state}`, {
        'Set-Cookie': [`${OIDC_STATE_COOKIE}=${state}; Path=/api/client/v2/auth/oidc; HttpOnly`],
      })
    }
    if (path === '/dex/auth/local' && req.method === 'GET') return html(200, LOGIN_FORM_HTML)
    if (path === '/dex/auth/local' && req.method === 'POST') {
      const state = url.searchParams.get('state') ?? url.searchParams.get('req') ?? ''
      return redirect(303, `${origin}/dex/approval?req=${state}&state=${state}`)
    }
    if (path === '/dex/approval' && req.method === 'GET') return html(200, APPROVAL_HTML)
    if (path === '/dex/approval' && req.method === 'POST') {
      const state = url.searchParams.get('state') ?? ''
      return redirect(303, `${origin}/api/client/v2/auth/oidc/callback?code=code-42&state=${state}`)
    }
    if (path === '/api/client/v2/auth/oidc/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? ''
      if (state === '' || cookie[OIDC_STATE_COOKIE] !== state) {
        return json(400, { error: { code: 'VALIDATION', message: 'state 与登录浏览器不匹配' } })
      }
      if (scenario === 'dex-http-deeplink') {
        // 变异：回调目标不是深链（旧脚本的恒假断言在"正常"场景下也照红，
        // 这里换成"真契约被破坏"的形态 ⇒ 新判据必须咬住）。
        return redirect(302, `${origin}/not-a-deep-link?token=${DEEP_LINK_TOKEN}`)
      }
      return redirect(302, `picoaide://auth?token=${DEEP_LINK_TOKEN}&user=admin`)
    }
    if (path === '/api/client/v2/auth/me' && req.method === 'GET') {
      const bearer = String(req.headers.authorization ?? '')
      if (bearer !== `Bearer ${DEEP_LINK_TOKEN}`) {
        return json(401, { error: { code: 'AUTH_REQUIRED', message: '未认证' } })
      }
      return json(200, { user: { username: 'admin', email: 'admin@example.com', role: 'user' } })
    }

    return json(404, { error: { code: 'NOT_FOUND', message: `未实现的假网关路由 ${req.method} ${path}` } })
  })
  return new Promise((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolvePromise({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/** 场景表：每个场景断言"谁是主角、期望退出码、输出里必须/不得出现什么"。 */
/** 主流程：语法闸门 → 判据自检 → 假网关正/反例。返回 0/1。 */
async function main() {
// ---------------------------------------------------------------------------
// 1. 语法闸门：integration-tests 下所有 .py 必须能解析
// ---------------------------------------------------------------------------
/** 递归列出目录下的 `*.py`（相对 ROOT，POSIX 分隔）。 */
function pythonFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...pythonFiles(path))
    else if (entry.endsWith('.py')) out.push(relative(ROOT, path))
  }
  return out.sort()
}

const pyFiles = existsSync(join(ROOT, 'integration-tests')) ? pythonFiles(join(ROOT, 'integration-tests')) : []
if (pyFiles.length === 0) {
  fail('integration-tests/ 下一个 .py 都没有 —— 扫描面为 0，拒绝以"无可检查"当通过')
}
for (const file of pyFiles) {
  const parsed = spawnSync('python3', [
    '-c',
    'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])',
    join(ROOT, file),
  ], { encoding: 'utf8' })
  if (parsed.error !== undefined || parsed.status !== 0) {
    fail(`${file}: Python 语法解析失败（${parsed.error?.message ?? parsed.stderr?.trim().slice(0, 200)}）`)
  }
}

// ---------------------------------------------------------------------------
// 2. 判据自检（--self-test）：每条判据的负例必须被拒
// ---------------------------------------------------------------------------
for (const test of CONTRACT_TESTS) {
  const result = spawnSync('python3', [scriptPathFor(test), '--self-test'], { cwd: ROOT, encoding: 'utf8' })
  if (result.error !== undefined) {
    fail(`${test.path}: 无法执行 --self-test（${result.error.message}）—— 没有 python3 时判失败，不静默跳过`)
    continue
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    fail(`${test.path} --self-test 失败（exit=${result.status}）：${output.trim().slice(-400)}`)
    continue
  }
  const summary = /self-test: (\d+)\/(\d+) 条判据夹具符合预期/u.exec(output)
  if (summary === null) {
    fail(`${test.path} --self-test 没有打印夹具汇总结论（判据数量不可见）：${output.trim().slice(-200)}`)
    continue
  }
  const [, ok, total] = summary.map(Number)
  if (ok !== total) fail(`${test.path} --self-test: ${ok}/${total} —— 有判据夹具不符合预期`)
  if (total < test.minCases) {
    fail(`${test.path} --self-test 只有 ${total} 条判据夹具（下限 ${test.minCases}）—— 判据被删到没有判别力`)
  }
  notes.push(`${test.id}: --self-test ${ok}/${total} 条夹具`)
}

// ---------------------------------------------------------------------------
// 3. 假网关：按真契约应答（不需要 Docker / PG / IdP）
// ---------------------------------------------------------------------------
const SCENARIOS = [
  { scenario: 'good', test: CONTRACT_TESTS[0], expect: 0, label: '按真契约应答 ⇒ dex 必须通过' },
  { scenario: 'good', test: CONTRACT_TESTS[1], expect: 0, label: '按真契约应答 ⇒ ldap 必须通过' },
  {
    scenario: 'skip', test: CONTRACT_TESTS[0], expect: 77,
    must: /SKIP/u, mustNot: /RESULT: PASS/u, label: 'provider 未配置 ⇒ dex 必须显式 SKIP(77) 且不得报 PASS',
  },
  {
    scenario: 'skip', test: CONTRACT_TESTS[1], expect: 77,
    must: /SKIP/u, mustNot: /RESULT: PASS/u, label: 'provider 未配置 ⇒ ldap 必须显式 SKIP(77) 且不得报 PASS',
  },
  {
    scenario: 'dex-http-deeplink', test: CONTRACT_TESTS[0], expect: 1,
    must: /深链|Location/u, label: '回调未下发深链 ⇒ dex 必须失败（旧脚本咬不到的那条契约）',
  },
  {
    scenario: 'ldap-legacy-channel', test: CONTRACT_TESTS[1], expect: 1,
    must: /channel/u, label: '回旧 brand 契约 ⇒ ldap 必须失败（旧断言必然红/新断言咬真契约）',
  },
  {
    scenario: 'ldap-rbac-fall-open', test: CONTRACT_TESTS[1], expect: 1,
    must: /RBAC|fall-open|403/u, label: 'auditor 写被放行 ⇒ ldap 必须失败（旧断言在这里恒真）',
  },
]

for (const item of SCENARIOS) {
  let gateway
  try {
    gateway = await startGateway(item.scenario)
  } catch (err) {
    fail(`假网关（场景 ${item.scenario}）起不来：${err?.message ?? err}`)
    continue
  }
  try {
    const { status, output } = await runTest(scriptPathFor(item.test), gateway.base)
    const detail = output.trim().split('\n').slice(-6).join(' / ')
    if (status !== item.expect) {
      fail(`[${item.scenario}] ${item.label} —— 期望 exit ${item.expect}，实际 ${status}：${detail}`)
      continue
    }
    if (item.must !== undefined && !item.must.test(output)) {
      fail(`[${item.scenario}] ${item.label} —— 输出里没有 ${item.must}：${detail}`)
      continue
    }
    if (item.mustNot !== undefined && item.mustNot.test(output)) {
      fail(`[${item.scenario}] ${item.label} —— 输出里出现了不该有的 ${item.mustNot}：${detail}`)
      continue
    }
    notes.push(`[${item.scenario}] ${item.test.id}: exit ${status} ✓`)
  } finally {
    await gateway.close()
  }
}

// ---------------------------------------------------------------------------
for (const message of notes) process.stdout.write(`check-integration-tests: ${message}\n`)
if (failures.length > 0) {
  process.stderr.write(`\ncheck-integration-tests: ${failures.length} 项断言失败\n`)
  for (const message of failures) process.stderr.write(`- ${message}\n`)
  return 1
}
process.stdout.write(
  `check-integration-tests: OK — ${pyFiles.length} 个 Python 用例语法通过、`
  + `${CONTRACT_TESTS.length} 个契约脚本判据自检通过、${SCENARIOS.length} 个假网关场景`
  + '（正例必须绿 / 变异必须红 / 环境缺失必须 SKIP 且不得报 PASS）全部符合预期\n',
)
return 0
}

export { CONTRACT_TESTS, runTest, scriptPathFor, startGateway }

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main())
}
