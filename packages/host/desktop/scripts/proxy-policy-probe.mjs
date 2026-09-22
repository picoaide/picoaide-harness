/**
 * 出口策略真机探针（**构建产物级**，不进 `yarn check` —— 需要显示器）。
 *
 * 判据（"判据必须能被打坏"）：把构建出的 `lib/network-policy.js` 装进真实 Electron，
 * 在"宿主机到处都配了代理"的环境里启动（`--proxy-server` + `http_proxy`/`https_proxy`/
 * `all_proxy` + `NODE_USE_ENV_PROXY=1`），目标指向**不可解析域名**：
 *   · 走了代理 ⇒ 本机记录型代理收到 absolute-form GET / CONNECT（判据失败）
 *   · 直连     ⇒ `ERR_NAME_NOT_RESOLVED`（判据通过）
 * 同一脚本还跑一个**反向对照**（跳过 `applySystemProxyPolicy`）：它**必须**看到代理命中 ——
 * 否则说明探针本身测不出问题（假绿）。
 *
 * 用法（必须有 DISPLAY；无头机器用 xvfb-run）：
 *   cd packages/host/desktop && yarn build && xvfb-run -a node scripts/proxy-policy-probe.mjs
 * 退出码：0 = 全部符合预期，1 = 有判据不符。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const HERE = import.meta.dirname
const APP_PROBE = join(HERE, 'proxy-policy-probe-app.mjs')

/** 记录型代理（loopback，不解析任何域名）。 */
function startProxy(logPath) {
  const hits = []
  const record = (entry) => {
    hits.push(entry)
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
  }
  const proxy = createServer((req, res) => {
    record({ kind: 'proxy-request', url: req.url })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('via-proxy')
  })
  proxy.on('connect', (req, socket) => {
    record({ kind: 'proxy-connect', url: req.url })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.destroy()
  })
  return { proxy, hits }
}

function listen(server) {
  return new Promise(resolvePort => server.listen(0, '127.0.0.1', () => {
    resolvePort(server.address().port)
  }))
}

function runElectron(env, extraArgs = []) {
  return new Promise((resolveRun) => {
    const child = spawn(electronPath, ['--no-sandbox', '--disable-gpu', ...extraArgs, APP_PROBE], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    // 不设界就会在真出问题时永久挂住（探针本身也要 fail-fast）。
    const killer = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => { clearTimeout(killer); resolveRun({ code, stdout, stderr }) })
  })
}

function parseResult(stdout) {
  const line = stdout.split('\n').find(candidate => candidate.startsWith('PROBE_RESULT '))
  return line === undefined ? undefined : JSON.parse(line.slice('PROBE_RESULT '.length))
}

const dir = mkdtempSync(join(tmpdir(), 'proxy-policy-probe-'))
const { proxy, hits } = startProxy(join(dir, 'hits.log'))
const proxyPort = await listen(proxy)
const env = {
  http_proxy: `http://127.0.0.1:${proxyPort}`,
  https_proxy: `http://127.0.0.1:${proxyPort}`,
  all_proxy: `http://127.0.0.1:${proxyPort}`,
  no_proxy: '',
  NODE_USE_ENV_PROXY: '1',
}

const failures = []
function check(label, ok, detail) {
  if (ok) { process.stdout.write(`  ok   ${label}\n`); return }
  failures.push(label)
  process.stdout.write(`  FAIL ${label} — ${detail}\n`)
}

process.stdout.write('== 正向：策略生效（宿主机到处配了代理） ==\n')
const before = hits.length
const applied = await runElectron(env, [`--proxy-server=127.0.0.1:${String(proxyPort)}`])
const appliedResult = parseResult(applied.stdout)
if (appliedResult === undefined) {
  process.stdout.write(applied.stderr.slice(-2000))
  throw new Error('Electron 探针没有产出 PROBE_RESULT')
}
check('resolveProxy(defaultSession) === DIRECT', appliedResult.resolveDefault === 'DIRECT', appliedResult.resolveDefault)
check('resolveProxy(partition) === DIRECT', appliedResult.resolvePartition === 'DIRECT', appliedResult.resolvePartition)
check('http 直连（域名不可解析）', String(appliedResult.http?.error ?? '').includes('ERR_NAME_NOT_RESOLVED'), JSON.stringify(appliedResult.http))
check('partition 直连', String(appliedResult.partition?.error ?? '').includes('ERR_NAME_NOT_RESOLVED'), JSON.stringify(appliedResult.partition))
check('Node fetch 直连（NODE_USE_ENV_PROXY 被撤销）', appliedResult.nodeFetch?.cause === 'ENOTFOUND', JSON.stringify(appliedResult.nodeFetch))
check('代理记录器零命中', hits.slice(before).length === 0, JSON.stringify(hits.slice(before)))
check('NODE_USE_ENV_PROXY 已清', appliedResult.cleared?.includes('NODE_USE_ENV_PROXY') === true, JSON.stringify(appliedResult.cleared))

process.stdout.write('== 反向对照：跳过 Chromium 开关（必须看到代理命中） ==\n')
const beforeControl = hits.length
// 对照显式给 `--proxy-server`：不依赖平台是否读代理环境变量（macOS/Windows 不读）。
const control = await runElectron(
  { ...env, PROBE_SKIP_SWITCH: '1' },
  [`--proxy-server=127.0.0.1:${String(proxyPort)}`],
)
const controlResult = parseResult(control.stdout)
if (controlResult === undefined) throw new Error('反向对照没有产出 PROBE_RESULT')
const controlHits = hits.slice(beforeControl)
check('对照 resolveProxy 是 PROXY', controlResult.resolveDefault !== 'DIRECT', controlResult.resolveDefault)
check('对照请求真的到了代理', controlHits.some(hit => hit.kind === 'proxy-request'), JSON.stringify(controlHits))

proxy.close()
process.stdout.write(failures.length === 0
  ? '\n全部符合预期（正向 7 + 对照 2）。\n'
  : `\n失败 ${String(failures.length)} 项：${failures.join('、')}\n`)
process.exitCode = failures.length === 0 ? 0 : 1
