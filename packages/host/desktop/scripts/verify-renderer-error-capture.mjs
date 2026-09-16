#!/usr/bin/env node
/**
 * verify-renderer-error-capture.mjs — 渲染进程未捕获错误的**行为级**门禁（F-11）。
 *
 * 为什么需要它（2026-09-16 审计/复核结论）：修复前 `contextIsolation: true`
 * （生产值）下 preload 的 `window.addEventListener('error'|'unhandledrejection')`
 * 装在**隔离世界**，页面主世界的真实错误一条都到不了主进程；而当时全绿的
 * 52 个单测 + 打包清单的"存在性断言"**一个都没发现** —— 门禁与功能正交。
 *
 * 本脚本用真机 Electron + **产品自己的**窗口配置/preload/IPC 收口建一个窗口，
 * 让页面在**主世界**真的抛一个未捕获错误与一个未处理 rejection，然后断言主进程
 * sink 收到它们。判据是"事件真的到达"，不是"文件存在"或"监听器被注册"。
 *
 * 用法：
 *   node scripts/verify-renderer-error-capture.mjs                # 产品 preload（默认）
 *   node scripts/verify-renderer-error-capture.mjs --json         # 机器可读输出
 *   RENDERER_CAPTURE_SMOKE_PRELOAD=/path/to/other.cjs \
 *     node scripts/verify-renderer-error-capture.mjs --expect-hits 0   # 负向对照
 *
 * 退出码：0 = 通过（仅当显式设置 RENDERER_CAPTURE_SMOKE_ALLOW_SKIP=1 时才允许
 *              "无显示环境"的跳过 —— 见下）；
 *         1 = 断言失败（页面错误没有到达主进程）；2 = 环境/前置条件不满足。
 *
 * 为什么不静默跳过（2026-09-16 主控复核）：无 DISPLAY 且无 xvfb-run 时旧实现
 * `exit(0)` + `ok:true` 会让门禁在没有任何断言的情况下"变绿"——这与本轮要修的
 * 缺陷（E2E 上报链路假绿）是同一类。仓库既有约定是**显式**处理图形环境
 * （e2e-client.mjs 直接假定 DISPLAY 并在起不来时失败）。故此处默认**失败**，
 * 只有运维显式声明"这台机器跑不了图形门禁"时才用环境变量跳过一次。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const args = process.argv.slice(2)
const asJson = args.includes('--json')
function numericFlag(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) ? value : fallback
}
const EXPECT_HITS = numericFlag('--expect-hits', 2)

const HARNESS = join(PACKAGE_ROOT, 'scripts', 'fixtures', 'renderer-error-capture-main.mjs')
const PRELOAD = join(PACKAGE_ROOT, 'lib', 'preload', 'renderer-error.cjs')

function fail(message, code = 2) {
  if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`)
  else process.stderr.write(`✗ ${message}\n`)
  process.exit(code)
}

if (!existsSync(HARNESS)) fail(`harness missing: ${HARNESS}`)
if (!existsSync(PRELOAD)) {
  fail(`built preload missing: ${PRELOAD}\n  run \`yarn workspace dsh-plugin-desktop build\` first`)
}

let electronBinary
try {
  // `require('electron')` 在普通 Node 进程里返回二进制路径。
  electronBinary = require('electron')
} catch (error) {
  fail(`cannot resolve the electron binary: ${String(error?.message ?? error)}`)
}
if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
  fail(`electron binary not found at ${String(electronBinary)}`)
}

/** Linux 无 DISPLAY 时自起 Xvfb；起不来就明确跳过（不静默变绿）。 */
function launchCommand() {
  const base = [electronBinary, '--no-sandbox', HARNESS]
  if (process.platform !== 'linux' || process.env.DISPLAY) return { command: base[0], args: base.slice(1) }
  const probe = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' })
  if (probe.status !== 0) return null
  return { command: 'xvfb-run', args: ['-a', ...base] }
}

const launch = launchCommand()
if (launch === null) {
  // 默认 fail-loud：门禁跑不了必须让人看见，而不是悄悄变绿（历史教训：
  // e2e fixture 没开 error_reporting_enabled ⇒ 上报链路从未被验证却一直"通过"）。
  const message = 'no DISPLAY and xvfb-run is unavailable (Linux headless): cannot run the renderer capture smoke'
  if (process.env.RENDERER_CAPTURE_SMOKE_ALLOW_SKIP === '1') {
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, message })}\n`)
    else process.stdout.write(`⚠ ${message} — skipped because RENDERER_CAPTURE_SMOKE_ALLOW_SKIP=1\n`)
    process.exit(0)
  }
  fail(`${message}\n  install xvfb (provides \`xvfb-run\`) or provide a DISPLAY; ` +
    'set RENDERER_CAPTURE_SMOKE_ALLOW_SKIP=1 only to deliberately skip this gate on a machine that cannot run it')
}

const home = mkdtempSync(join(tmpdir(), 'renderer-capture-smoke-'))
const child = spawn(launch.command, launch.args, {
  cwd: PACKAGE_ROOT,
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'cfg'),
    XDG_CACHE_HOME: join(home, 'cache'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

const timeout = setTimeout(() => {
  child.kill('SIGKILL')
  fail('smoke timed out after 60s', 1)
}, 60_000)

child.on('close', () => {
  clearTimeout(timeout)
  try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }

  const line = stdout.split('\n').find((entry) => entry.startsWith('RENDERER_CAPTURE_SMOKE_RESULT '))
  if (!line) {
    fail(`smoke produced no result line\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr.slice(-2000)}`, 2)
  }
  let result
  try {
    result = JSON.parse(line.slice('RENDERER_CAPTURE_SMOKE_RESULT '.length))
  } catch (error) {
    fail(`unparsable result line: ${String(error?.message ?? error)}`, 2)
  }

  const hits = Array.isArray(result.hits) ? result.hits : []
  const pageWorldSaw = Array.isArray(result.pageWorldSaw) ? result.pageWorldSaw : []
  const messages = hits.map((hit) => (hit && typeof hit.message === 'string' ? hit.message : ''))
  const types = hits.map((hit) => (hit && typeof hit.type === 'string' ? hit.type : ''))
  const sawThrow = pageWorldSaw.some((entry) => String(entry).includes('SMOKE_RENDERER_UNCAUGHT_THROW'))
  const sawRejection = pageWorldSaw.some((entry) => String(entry).includes('SMOKE_RENDERER_UNHANDLED_REJECTION'))
  const gotThrow = messages.some((message) => message.includes('SMOKE_RENDERER_UNCAUGHT_THROW')) && types.includes('error')
  const gotRejection = messages.some((message) => message.includes('SMOKE_RENDERER_UNHANDLED_REJECTION'))
    && types.includes('unhandledrejection')
  const productionWebPreferences = result.webPreferences?.contextIsolation === true
    && result.webPreferences?.nodeIntegration === false
    && result.webPreferences?.sandbox === true

  const checks = [
    ['窗口使用生产 webPreferences（contextIsolation/sandbox/nodeIntegration）', productionWebPreferences, JSON.stringify(result.webPreferences ?? null)],
    ['preload 路径来自产品 window-options（lib/preload/renderer-error.cjs）', String(result.preloadPath ?? '').endsWith('preload/renderer-error.cjs'), String(result.preloadPath ?? '')],
    ['页面主世界确实抛出了两个错误（对照）', sawThrow && sawRejection, JSON.stringify(pageWorldSaw)],
    ['主世界未捕获错误到达主进程 sink', gotThrow, `hits=${hits.length} types=${JSON.stringify(types)}`],
    ['主世界未处理 rejection 到达主进程 sink', gotRejection, `hits=${hits.length}`],
    [`到达条数 >= ${EXPECT_HITS}`, hits.length >= EXPECT_HITS, `hits=${hits.length}`],
  ]

  const failed = checks.filter(([, ok]) => !ok)
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })), hits })}\n`)
  } else {
    process.stdout.write('渲染进程错误采集行为门禁（真机 Electron）\n')
    for (const [name, ok, detail] of checks) {
      process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}  ${detail === '' ? '' : `(${detail})`}\n`)
    }
    process.stdout.write(failed.length === 0
      ? `  → PASS（${hits.length} 条到达；页面世界错误 ${pageWorldSaw.length} 条）\n`
      : `  → FAIL（${failed.length} 项不满足）\n`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
})
