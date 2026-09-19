#!/usr/bin/env node
/**
 * 三方对拍：本机打开路由（客户端常量 / 宿主路由 / 设计总纲冻结串）。
 *
 * **为什么必须有这条判据**：R2-P0-1 / TST-5 / SEC-1 / CHN-1 / UX-1 / CLI-4 是同一个
 * P0 —— 客户端的 `OPEN_APP_PATH` 与宿主注册的路由曾各写一份且不一致，两端各自的单测
 * 还把**各自**的字面量钉成期望，双绿假象之下"点打开"必然 404。修法已落地（§5.2 冻结
 * 路径 + 宿主前缀注册 + 端点 spec 同批改），但**判据必须留在门禁里**：这条契约的失效
 * 形态就是"两个文件里的字面量漂移"，源码级三方对拍恰好直接覆盖它，且不依赖构建产物。
 *
 * 三方 = packages/client/wasm-apps/src/client/open-app.ts 的 `OPEN_APP_PATH`
 *      / packages/host/wasm-apps-host/src/index.ts 的 `WASM_APPS_LOCAL_PREFIX` 前缀
 *      / docs/planning/2026-09-19-wasm-client-only-design.md §5.2 的冻结路径。
 *
 * 用法：node scripts/wasm/check-route-parity.mjs
 * 退出码：0 = 三方逐字一致；1 = 漂移或缺实现（打印文件与行号）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REL = path => path.replace(`${ROOT}/`, '')

const CLIENT_SOURCE = join(ROOT, 'packages/client/wasm-apps/src/client/open-app.ts')
const HOST_SOURCE = join(ROOT, 'packages/host/wasm-apps-host/src/index.ts')
const CLIENT_CHANNEL_SOURCES = [
  join(ROOT, 'packages/client/wasm-apps/src/client/channel-seam.ts'),
  join(ROOT, 'packages/client/wasm-apps/src/client/open-app.ts'),
]
const DESIGN_DOC = join(ROOT, 'docs/planning/2026-09-19-wasm-client-only-design.md')

const failures = []
const pending = []

function lineOf(source, needle) {
  const index = source.split('\n').findIndex(line => line.includes(needle))
  return index < 0 ? 0 : index + 1
}

function locate(path, needle) {
  const source = readFileSync(path, 'utf8')
  return { source, line: lineOf(source, needle) }
}

function ok(message) {
  console.log(`  PASS ${message}`)
}

function bad(message) {
  failures.push(message)
  console.error(`  FAIL ${message}`)
}

console.log('== 三方对拍：本机打开路由（客户端常量 / 宿主路由 / 文档冻结串）')

// ---- 客户端常量 -----------------------------------------------------------
const client = locate(CLIENT_SOURCE, 'export const OPEN_APP_PATH')
const clientMatch = /export const OPEN_APP_PATH\s*=\s*'([^']+)'/u.exec(client.source)
if (clientMatch === null) {
  bad(`${REL(CLIENT_SOURCE)} 里找不到 export const OPEN_APP_PATH（契约已变？）`)
}
const clientPath = clientMatch?.[1] ?? ''
const clientAt = `${REL(CLIENT_SOURCE)}:${client.line}`

// ---- 宿主路由（前缀 + `${PREFIX}/open` 合成） -----------------------------
const host = locate(HOST_SOURCE, 'export const WASM_APPS_LOCAL_PREFIX')
const prefixMatch = /export const WASM_APPS_LOCAL_PREFIX\s*=\s*'([^']+)'/u.exec(host.source)
const suffixMatch = /export const WASM_APP_OPEN_ROUTE\s*=\s*`\$\{WASM_APPS_LOCAL_PREFIX\}([^`]+)`/u.exec(host.source)
if (prefixMatch === null || suffixMatch === null) {
  bad(`${REL(HOST_SOURCE)} 里找不到 WASM_APPS_LOCAL_PREFIX / WASM_APP_OPEN_ROUTE 的合成（应为模板串）`)
}
const hostPath = `${prefixMatch?.[1] ?? ''}${suffixMatch?.[1] ?? ''}`
const hostAt = `${REL(HOST_SOURCE)}:${host.line}`
// 前缀注册（不是把 `open` 路径整体注册成 exact 路由）：未知子路径才有处分发。
// 注册形态允许两种（L2 施工中调整过一次）：`kind: 'prefix', path: PREFIX` 或 `prefix: PREFIX`。
const prefixRegistered = /kind:\s*'prefix',[\s\S]{0,80}?path:\s*WASM_APPS_LOCAL_PREFIX/u.test(host.source)
  || /prefix:\s*WASM_APPS_LOCAL_PREFIX/u.test(host.source)
const prefixAt = lineOf(host.source, 'prefix: WASM_APPS_LOCAL_PREFIX') || lineOf(host.source, "kind: 'prefix'")

// ---- 文档冻结串 -----------------------------------------------------------
const doc = readFileSync(DESIGN_DOC, 'utf8')
const docFrozen = `POST ${clientPath}`
const docLine = lineOf(doc, docFrozen)
const docAt = `${REL(DESIGN_DOC)}:${docLine}`

console.log(`  客户端常量 ${JSON.stringify(clientPath)}  ← ${clientAt}`)
console.log(`  宿主路由   ${JSON.stringify(hostPath)}  ← ${hostAt}`)
console.log(`  文档冻结串 ${JSON.stringify(docFrozen)}  ← ${docLine > 0 ? docAt : '未命中'}`)

if (clientPath !== '' && clientPath === hostPath) {
  ok(`客户端 OPEN_APP_PATH === 宿主 WASM_APP_OPEN_ROUTE（${clientPath}）`)
} else {
  bad(`客户端与宿主路由漂移：客户端 ${JSON.stringify(clientPath)}（${clientAt}） ≠ 宿主 ${JSON.stringify(hostPath)}（${hostAt}）`)
}
if (docLine > 0) {
  ok(`设计总纲 §5.2 冻结路径与两端一致（${docAt}）`)
} else {
  bad(`设计总纲 §5.2 里找不到冻结串 ${JSON.stringify(docFrozen)}（§5.2 是跨端冻结契约，缺了就没有第三份真源）`)
}
if (prefixRegistered) {
  ok(`宿主按**前缀**注册（${REL(HOST_SOURCE)}:${prefixAt}），未知子路径由 handler 分发（否则 §5.2 的 404 语义无处实现）`)
} else {
  bad(`宿主没有按前缀注册 WASM_APPS_LOCAL_PREFIX（${REL(HOST_SOURCE)}；应形如 kind: 'prefix', path: WASM_APPS_LOCAL_PREFIX）`)
}

// ---- §16.1 的本机只读渠道路由（W2 施工中；两端都定义后才做对拍） --------------
// 形态：宿主 `WASM_APP_CHANNEL_ROUTE = `${WASM_APPS_LOCAL_PREFIX}/channel``（合成），
// 客户端经 channel-seam 消费（不得自己写死路径）。缺任一端 ⇒ PENDING（W2 未完成），
// 两端都有但不一致 ⇒ 真漂移，必须红。
const channelSuffix = /export const WASM_APP_CHANNEL_ROUTE\s*=\s*`\$\{WASM_APPS_LOCAL_PREFIX\}([^`]+)`/u.exec(host.source)?.[1]
const hostChannelRoute = channelSuffix === undefined ? undefined : `${prefixMatch?.[1] ?? ''}${channelSuffix}`
const channelDoc = /GET (\/api\/pico\/wasm-apps\/channel)/u.exec(doc)?.[1]
let clientChannelRoute
let clientChannelAt = ''
for (const file of CLIENT_CHANNEL_SOURCES) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const match = /'(\/api\/pico\/wasm-apps\/channel)'/u.exec(source)
  if (match !== null) {
    clientChannelRoute = match[1]
    clientChannelAt = `${REL(file)}:${lineOf(source, match[1])}`
    break
  }
}
if (hostChannelRoute === undefined || clientChannelRoute === undefined) {
  pending.push('§16.1 本机只读渠道路由 GET /api/pico/wasm-apps/channel 两端未齐（宿主 '
    + `${JSON.stringify(hostChannelRoute)} / 客户端 ${JSON.stringify(clientChannelRoute)}）—— W2 完成后本脚本自动纳入对拍`)
  console.log(`  PENDING §16.1 渠道只读路由两端未齐（宿主 ${JSON.stringify(hostChannelRoute)} / 客户端 ${JSON.stringify(clientChannelRoute)}）`)
} else if (clientChannelRoute === hostChannelRoute && channelDoc === hostChannelRoute) {
  ok(`§16.1 渠道只读路由三方一致（${clientChannelRoute} ← ${clientChannelAt}）`)
} else {
  bad(`§16.1 渠道只读路由对拍失败：客户端 ${JSON.stringify(clientChannelRoute)}（${clientChannelAt}）`
    + ` / 宿主 ${JSON.stringify(hostChannelRoute)}（${REL(HOST_SOURCE)}:${lineOf(host.source, 'WASM_APP_CHANNEL_ROUTE')}）`
    + ` / 文档 ${JSON.stringify(channelDoc ?? null)}`)
}

console.log('')
if (failures.length > 0) {
  console.error(`三方对拍失败：${failures.length} 条`)
  for (const message of failures) console.error(`- ${message}`)
  process.exit(1)
}
for (const message of pending) console.log(`待办（不计入失败）：${message}`)
console.log('三方对拍通过 ✅')
