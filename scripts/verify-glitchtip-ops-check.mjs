#!/usr/bin/env node
/**
 * `scripts/glitchtip-ops-check.mjs` 的回归门禁。
 *
 * 为什么值得单独测：这个脚本是**对着生产环境**跑的只读核查工具，它的输出被
 * 人（或包装脚本）当作"合不合格"的判据。四类错误都不会有声：
 *
 *   1. fail-open（S15-2）：keys API 返回了行但 DSN 解析不出来时，既不设 verdict
 *      也不设 exitCode ⇒ 打印"无缺陷"、exit 0，恰好在 API 形态变了的时候变假绿；
 *   2. 未捕获异常（S15-5）：DSN userinfo 里一个坏字节（`http://ab%zz@host/1`）
 *      就让工具抛 URIError 崩掉，exit 1 与"发现缺陷"同码，且 --json 输出整段丢失；
 *   3. 远程命令注入（S15-7）：容器名未加引号地插进 ssh 命令串，远端登录 shell 会
 *      执行其中的 `;`/`$(…)`/反引号 —— 与文件头"只读 ssh 命令，绝不修改任何东西"矛盾；
 *   4. cookie 越域（S15-9）：jar 只按过期时间过滤，别的域名/仅限 https 的 cookie
 *      会被发给 --base-url 指到的主机。
 *
 * 测法：起一个本地假 keys API（http）+ 把假 `ssh` 放进 PATH —— 全程不碰真实环境。
 * 变异验证（把修复回退后本文件必红）见 S15-2/5/7/9 四条用例的断言。
 *
 * 用法:node scripts/verify-glitchtip-ops-check.mjs
 * 退出码:0 全部通过;1 有断言失败。
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkScript = join(root, 'scripts', 'glitchtip-ops-check.mjs')
const failures = []
const scratch = []

function fail(message) {
  failures.push(message)
  process.stderr.write(`verify-glitchtip-ops-check: ${message}\n`)
}

function check(condition, message) {
  if (!condition) fail(message)
  return condition
}

/** 造一个临时目录(进程退出时清理)。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** 去掉环境里可能存在的 GLITCHTIP_* —— 门禁不能受调用者环境变量影响。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GLITCHTIP_')) delete env[key]
  return { ...env, ...extra }
}

/**
 * 跑一次核查脚本。
 *
 * 必须**异步** spawn：本文件的假 keys API 跑在同一个事件循环里，用 spawnSync 会把
 * 父进程的事件循环一起挡住 —— 子进程的 HTTP 请求永远等不到应答（12s 后 abort），
 * 于是所有"UNKNOWN + exit 2"的用例都会**假绿**（这正是第一版踩到的坑）。
 */
function runCheck(args, options = {}) {
  return new Promise(resolve_ => {
    const child = spawn(process.execPath, [checkScript, ...args], {
      env: cleanEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve_({ status, signal, stdout, stderr })
    })
  })
}

/**
 * 起一个假 keys API，返回固定 rows（以及收到的请求头，供 cookie 断言用）。
 * @param {unknown} rows - keys API 的 JSON 响应体。
 */
async function startKeysApi(rows) {
  const state = { requests: [] }
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, cookie: req.headers.cookie ?? null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rows))
  })
  await new Promise(resolve_ => server.listen(0, '127.0.0.1', resolve_))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, state, close: () => new Promise(r => server.close(r)) }
}

/** 写一个可执行的 shell 桩(内容里带 NUL 分隔的 argv 记录)。 */
function writeStub(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}`)
  chmodSync(file, 0o755)
  return file
}

/** 写一个 Netscape/curl 格式的 cookie jar。 */
function writeJar(file, rows) {
  const header = '# Netscape HTTP Cookie File\n'
  writeFileSync(file, header + rows.map(cols => cols.join('\t')).join('\n') + '\n')
  return file
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600

// ---------------------------------------------------------------------------
// S15-2 / S15-5：无法解析的 DSN 必须 UNKNOWN + exit 2（而不是"无缺陷"或崩溃）
// ---------------------------------------------------------------------------

{
  const api = await startKeysApi([{ id: 1, public: 'abc', secret: 'def', label: 'Default' }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const result = await runCheck(['--base-url', api.baseUrl, '--cookies', jar, '--json'])
  const served = api.state.requests.length
  await api.close()
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    /* 断言里报错 */
  }
  // 前置断言：请求必须真的到达假 API（否则后面的 UNKNOWN 断言可能是"连接被 abort"的假绿）。
  check(served === 1, `S15-2: 假 keys API 应收到 1 个请求，实际 ${served}`)
  check(result.status === 2, `S15-2: keys API 行没有可解析 DSN 时必须 exit 2(实际 ${result.status})，stdout=${result.stdout.slice(0, 200)}`)
  check(report !== null, 'S15-2: --json 必须输出可解析的 JSON')
  check(report?.observedDsn === null && report?.observed === null, 'S15-2: 无 DSN 时 observed 应为 null')
  check(
    Array.isArray(report?.verdict) && report.verdict.some(line => line.startsWith('UNKNOWN')),
    `S15-2: 必须显式给出 UNKNOWN verdict，实际 ${JSON.stringify(report?.verdict)}`,
  )
  check(report?.exitCode === 2, `S15-2: report.exitCode 应为 2，实际 ${report?.exitCode}`)

  // 正例（防止修复把 exit 1 也一并吞掉）：loopback DSN 仍是 FAIL + exit 1。
  const loop = await startKeysApi([{ dsn: { public: 'http://key@localhost:8000/1' } }])
  const loopJar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const loopResult = await runCheck(['--base-url', loop.baseUrl, '--cookies', loopJar, '--json'])
  const loopServed = loop.state.requests.length
  await loop.close()
  const loopReport = JSON.parse(loopResult.stdout)
  check(loopServed === 1, `S15-2: 假 keys API 应收到 1 个请求，实际 ${loopServed}`)
  check(loopResult.status === 1, `S15-2: loopback DSN 必须仍是 exit 1(FAIL 优先级，实际 ${loopResult.status})`)
  check(
    loopReport.verdict.some(line => line.startsWith('FAIL')),
    `S15-2: loopback DSN 必须给 FAIL verdict，实际 ${JSON.stringify(loopReport.verdict)}`,
  )
}

{
  // userinfo 里的坏百分号转义：修复前 parseDsn 抛 URIError → exit 1 + 无 JSON。
  const api = await startKeysApi([{ dsn: { public: 'http://ab%zz@127.0.0.1:9/1' } }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const result = await runCheck(['--base-url', api.baseUrl, '--cookies', jar, '--json'])
  const served = api.state.requests.length
  await api.close()
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    /* 断言里报错 */
  }
  check(served === 1, `S15-5: 假 keys API 应收到 1 个请求，实际 ${served}`)
  check(result.status === 2, `S15-5: 不可解码的 DSN 必须走 UNKNOWN/exit 2(实际 ${result.status})`)
  check(report !== null, `S15-5: 崩溃不得吞掉 --json 输出(实际 stdout=${result.stdout.slice(0, 200)})`)
  check(report?.observed === null, 'S15-5: 不可解码的 DSN 应视为不可解析(observed=null)')
  check(
    Array.isArray(report?.verdict) && report.verdict.some(line => line.startsWith('UNKNOWN')),
    `S15-5: 不可解码的 DSN 必须落进 UNKNOWN 分支，实际 ${JSON.stringify(report?.verdict)}`,
  )
}

// ---------------------------------------------------------------------------
// S15-2-R2：可解析但**没有 project id** 的 DSN 也是不可用 DSN ⇒ UNKNOWN + exit 2
// （修复前：parseDsn 返回非 null、projectId='' ⇒ 打印 "OK…不指向本机" 且 exit 0）
// ---------------------------------------------------------------------------

for (const shape of ['https://key@glitchtip.example.com', 'https://key@glitchtip.example.com/']) {
  const api = await startKeysApi([{ dsn: { public: shape } }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const result = await runCheck(['--base-url', api.baseUrl, '--cookies', jar, '--json'])
  const served = api.state.requests.length
  await api.close()
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    /* 断言里报错 */
  }
  check(served === 1, `S15-2-R2(${shape}): 假 keys API 应收到 1 个请求，实际 ${served}`)
  check(
    result.status === 2,
    `S15-2-R2(${shape}): 缺 project id 的 DSN 必须 exit 2(实际 ${result.status})，stdout=${result.stdout.slice(0, 200)}`,
  )
  check(report !== null, `S15-2-R2(${shape}): --json 必须输出可解析的 JSON`)
  check(report?.observed === null, `S15-2-R2(${shape}): 缺 project id 应视为不可解析(observed=null)`)
  check(
    Array.isArray(report?.verdict) && report.verdict.some(line => line.startsWith('UNKNOWN')),
    `S15-2-R2(${shape}): 缺 project id 必须走 UNKNOWN 分支，实际 ${JSON.stringify(report?.verdict)}`,
  )
  check(
    !(Array.isArray(report?.verdict) && report.verdict.some(line => line.startsWith('OK'))),
    `S15-2-R2(${shape}): 不得给出 OK verdict，实际 ${JSON.stringify(report?.verdict)}`,
  )
}

// ---------------------------------------------------------------------------
// S15-2-R2（P3）：--json 大于管道缓冲时不得被 process.exit 截断（退出码也不得仍是 0）
// ---------------------------------------------------------------------------

{
  const huge = 'a'.repeat(200_000)
  const dsn = `https://key@glitchtip.example.com/${huge}/42`
  const api = await startKeysApi([{ dsn: { public: dsn } }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const result = await runCheck(['--base-url', api.baseUrl, '--cookies', jar, '--json'])
  const served = api.state.requests.length
  await api.close()
  check(served === 1, `S15-2-R2(大 DSN): 假 keys API 应收到 1 个请求，实际 ${served}`)
  // 前置断言：输出必须真的超过管道缓冲，否则这条用例证明不了截断问题（防假绿）。
  check(
    result.stdout.length > 131_072,
    `S15-2-R2(大 DSN): --json 必须完整写出(实际只有 ${result.stdout.length} 字节 ⇒ 被截断)`,
  )
  check(result.status === 0, `S15-2-R2(大 DSN): 非 loopback DSN 应 exit 0(实际 ${result.status})`)
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    /* 断言里报错 */
  }
  check(
    report !== null,
    `S15-2-R2(大 DSN): 超过管道缓冲的 --json 必须完整可解析(实际 ${result.stdout.length} 字节，尾部=${JSON.stringify(result.stdout.slice(-80))})`,
  )
  check(
    report?.observedDsn === dsn,
    `S15-2-R2(大 DSN): 报告里的 DSN 不得被截断(实际长度 ${String(report?.observedDsn).length})`,
  )
}

// ---------------------------------------------------------------------------
// S15-5-R2（P3）：同步尾部里的 Promise.reject 必须落到 exit 2（而不是被 process.exit 吞掉）
//
// 注入手法：预加载一个 CJS 模块，把 process.stdout.write 包一层 —— 第一次写 stdout 时
// （--json 模式下唯一的写就是最终报告，位于最后一个 await 之后的同步尾部）构造一个
// 未处理的 rejection，随后脚本立刻收尾。修复前 process.exit(0) 抢在 unhandledRejection
// 之前 ⇒ exit 0 且错误被吞；修复后事件循环排空前必须把通知送达 failClosed ⇒ exit 2。
// ---------------------------------------------------------------------------

{
  const preload = join(tempDir('glitchtip-preload-'), 'reject-on-first-write.cjs')
  writeFileSync(preload, [
    "'use strict'",
    'const original = process.stdout.write.bind(process.stdout)',
    'let fired = false',
    'process.stdout.write = (chunk, encoding, callback) => {',
    '  const result = original(chunk, encoding, callback)',
    '  if (!fired) {',
    '    fired = true',
    "    Promise.reject(new Error('probe-unhandled-rejection'))",
    '  }',
    '  return result',
    '}',
    '',
  ].join('\n'))
  const api = await startKeysApi([{ dsn: { public: 'https://key@glitchtip.example.com/42' } }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim()
  const result = await runCheck(['--base-url', api.baseUrl, '--cookies', jar, '--json'], {
    env: { NODE_OPTIONS: nodeOptions },
  })
  const served = api.state.requests.length
  await api.close()
  check(served === 1, `S15-5-R2: 假 keys API 应收到 1 个请求，实际 ${served}`)
  check(
    result.status === 2,
    `S15-5-R2: 同步尾部里未处理的 rejection 必须 exit 2(实际 ${result.status}；exit 0 = 错误被吞)`,
  )
  check(
    result.stderr.includes('probe-unhandled-rejection'),
    `S15-5-R2: 未处理的 rejection 必须打印到 stderr(实际 ${JSON.stringify(result.stderr.slice(0, 200))})`,
  )
}

// ---------------------------------------------------------------------------
// S15-9：cookie jar 必须按 domain/path/secure 过滤
// ---------------------------------------------------------------------------

{
  const api = await startKeysApi([{ dsn: { public: 'https://key@glitchtip.example.com/42' } }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    // 目标主机 + 根路径 ⇒ 发
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
    // 目标主机 + 请求路径的前缀 ⇒ 发
    ['127.0.0.1', 'FALSE', '/api', 'FALSE', String(FUTURE), 'api_session', 'API-VALUE'],
    // 别的域名 ⇒ 不发
    ['other.example.com', 'FALSE', '/', 'FALSE', String(FUTURE), 'foreign_session', 'SECRET-FOREIGN'],
    // 父域后缀 cookie(IncludeSubdomains) ⇒ 对 127.0.0.1 不匹配,不发
    ['.example.com', 'TRUE', '/', 'FALSE', String(FUTURE), 'suffix_session', 'SECRET-SUFFIX'],
    // Secure cookie 走 http:// ⇒ 不发
    ['127.0.0.1', 'FALSE', '/', 'TRUE', String(FUTURE), 'secure_only', 'SECURE-VALUE'],
    // 路径不匹配(/other 不是 /api/0/... 的前缀) ⇒ 不发
    ['127.0.0.1', 'FALSE', '/other', 'FALSE', String(FUTURE), 'path_other', 'PATH-VALUE'],
  ])
  const result = await runCheck(['--base-url', api.baseUrl, '--cookies', jar, '--json'])
  const served = api.state.requests.length
  const cookie = api.state.requests[0]?.cookie ?? null
  await api.close()
  const report = JSON.parse(result.stdout)
  check(served === 1, `S15-9: 假 keys API 应收到 1 个请求，实际 ${served}`)
  check(result.status === 0, `S15-9: 非 loopback DSN 应 exit 0(实际 ${result.status})`)
  check(cookie !== null, 'S15-9: 匹配目标站点的 cookie 必须发出')
  check((cookie ?? '').includes('glitchtip_session=SECRET-LOCAL'), `S15-9: 目标主机根路径 cookie 必须发出，实际 ${cookie}`)
  check((cookie ?? '').includes('api_session=API-VALUE'), `S15-9: 路径前缀匹配的 cookie 必须发出，实际 ${cookie}`)
  for (const [name, value, why] of [
    ['foreign_session', 'SECRET-FOREIGN', '别的域名'],
    ['suffix_session', 'SECRET-SUFFIX', '不匹配的父域后缀'],
    ['secure_only', 'SECURE-VALUE', 'Secure cookie 走 http'],
    ['path_other', 'PATH-VALUE', '路径不匹配'],
  ]) {
    check(!(cookie ?? '').includes(`${name}=${value}`), `S15-9: ${why} 的 cookie 不得发送，实际 ${cookie}`)
  }
  check(
    Array.isArray(report.notes) && report.notes.some(note => note.includes('已跳过')),
    `S15-9: 被过滤的 cookie 必须在 notes 里说明，实际 ${JSON.stringify(report.notes)}`,
  )
}

{
  // S15-9-R2(P3)：fetch 自身抛错（网络层失败）时，调用方会重建 keys 对象 ——
  // "管理员 cookie 因域/路径/secure 不匹配被跳过"这条唯一线索不能在重建时丢掉。
  // 用死端口 127.0.0.1:1 制造连接失败（不依赖外部网络）。
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['evil.example.com', 'FALSE', '/', 'FALSE', String(FUTURE), 'foreign_session', 'SECRET-FOREIGN'],
  ])
  const result = await runCheck(['--base-url', 'http://127.0.0.1:1', '--cookies', jar, '--json'])
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    /* 断言里报错 */
  }
  check(result.status === 2, `S15-9-R2: 站点不可达必须 exit 2(实际 ${result.status})`)
  check(report !== null, `S15-9-R2: fetch 抛错也必须输出可解析的 --json(实际 ${result.stdout.slice(0, 200)})`)
  // 断言必须比"notes 里出现过某个域名子串"更强:note 的形态是确定的(见
  // glitchtip-ops-check.mjs 的 `已跳过：` + join(', ')),这里钉**整条 note**,
  // 于是"host 被截断/被换成别的域名/前缀文案走失"都会红 —— 只查子串时换域名也绿。
  // 顺带修掉 CodeQL js/incomplete-url-substring-sanitization(它把域名子串判定
  // 当成"不完整的 URL 校验",尽管此处 receiver 是 notes 数组元素而非 URL)。
  const skippedNote = 'cookie jar 里有 cookie 不属于目标 http://127.0.0.1:1'
    + '（域/路径不匹配或仅限 https），已跳过：evil.example.com'
  check(
    Array.isArray(report?.notes) && report.notes.some(note => note === skippedNote),
    `S15-9-R2: fetch 抛错时被跳过的 cookie 必须以整条 note 出现（${skippedNote}），实际 ${JSON.stringify(report?.notes)}`,
  )
  check(
    Array.isArray(report?.verdict) && report.verdict.some(line => line.startsWith('UNKNOWN')),
    `S15-9-R2: 站点不可达必须给 UNKNOWN verdict，实际 ${JSON.stringify(report?.verdict)}`,
  )
}

// ---------------------------------------------------------------------------
// S15-7：容器名/compose 目录必须按字面量传递（远端 shell 不解释元字符）
// ---------------------------------------------------------------------------

{
  const work = tempDir('glitchtip-ssh-')
  const binDir = join(work, 'bin')
  mkdirSync(binDir)
  const record = join(work, 'ssh-argv.bin')
  writeStub(binDir, 'ssh', 'printf \'%s\\0\' "$@" > "$GLITCHTIP_TEST_SSH_RECORD"\nprintf \'GLITCHTIP_URL=https://glitchtip.example.com\\n\'')
  const marker = join(work, 'INJECTED')
  const payload = `glitchtip-web-1; touch ${marker} #`
  const api = await startKeysApi([{ dsn: { public: 'https://key@glitchtip.example.com/42' } }])
  const jar = writeJar(join(tempDir('glitchtip-jar-'), 'c.txt'), [
    ['127.0.0.1', 'FALSE', '/', 'FALSE', String(FUTURE), 'glitchtip_session', 'SECRET-LOCAL'],
  ])
  const baseArgs = ['--base-url', api.baseUrl, '--cookies', jar, '--ssh', 'ops@glitchtip-host']
  const result = await runCheck(
    [...baseArgs, '--container', payload, '--compose-dir', '/data/glitch tip', '--apply', '--yes'],
    { env: { PATH: `${binDir}:${process.env.PATH}`, GLITCHTIP_TEST_SSH_RECORD: record } },
  )
  const served = api.state.requests.length
  await api.close()
  check(served === 1, `S15-7: 假 keys API 应收到 1 个请求，实际 ${served}`)
  check(!existsSync(marker), 'S15-7: 工具自身的 ssh 调用不得执行容器名里的载荷')
  const argv = existsSync(record)
    ? readFileSync(record, 'utf8').split('\0').slice(0, -1)
    : []
  check(argv.length > 0, 'S15-7: 假 ssh 未收到参数(接线失败)')
  const remoteCommand = argv[argv.length - 1] ?? ''
  check(
    remoteCommand === `docker inspect '${payload}' --format '{{range .Config.Env}}{{println .}}{{end}}'`,
    `S15-7: 远程命令里的容器名必须加引号，实际 ${JSON.stringify(remoteCommand)}`,
  )
  // 真·判据：把这条远程命令交给 /bin/sh 解析(等价远端登录 shell)，载荷不得被拆出来执行。
  const stubBin = join(work, 'stubbin')
  mkdirSync(stubBin)
  const dockerLog = join(work, 'docker-argv.bin')
  writeStub(stubBin, 'docker', 'printf \'%s\\0\' "$@" >> "$GLITCHTIP_TEST_DOCKER_LOG"')
  const parsed = spawnSync('/bin/sh', ['-c', remoteCommand], {
    encoding: 'utf8',
    env: cleanEnv({ PATH: `${stubBin}:${process.env.PATH}`, GLITCHTIP_TEST_DOCKER_LOG: dockerLog }),
  })
  check(parsed.status === 0, `S15-7: 远程命令本身应能正常解析(实际 ${parsed.status}: ${parsed.stderr})`)
  check(!existsSync(marker), 'S15-7: 远端 shell 解析这条命令时不得执行注入的载荷')
  const dockerArgv = existsSync(dockerLog)
    ? readFileSync(dockerLog, 'utf8').split('\0').slice(0, -1)
    : []
  check(
    dockerArgv[0] === 'inspect' && dockerArgv[1] === payload,
    `S15-7: 容器名必须以单个字面量参数到达 docker，实际 ${JSON.stringify(dockerArgv)}`,
  )
  check(
    result.stdout.includes("cd '/data/glitch tip' && docker compose up -d web"),
    'S15-7: --apply 打印的 compose 目录同样必须加引号(给人复制执行的命令)',
  )
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-glitchtip-ops-check: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write(
  'verify-glitchtip-ops-check: OK — 不可解析 DSN=fail-closed(UNKNOWN/exit 2)、坏转义不崩、'
  + 'cookie 按 domain/path/secure 过滤、容器名与 compose 目录按字面量传递(注入惰性)\n',
)
