/**
 * tests/memory-entry-match-key.test.js — §7（上游 issue #59 的本地加固，独立审计
 * 2026-09-23 `A-skill-management.md` §7）。
 *
 * 缺陷形态：**展示层剥两个标记，匹配层只剥一个（或一个都不剥）**。
 *   - 展示：记忆 Tab / 告警快照走 `stripEntrySummary(stripEntryId(entry))`
 *     （lib/index.js 的 `:772`/`:809`/`:1072`/`:1435`/`:1513`/`:1683`/`:1764`）；
 *   - 匹配：`findExactIndex` 只剥 `[id:…]`、`peekExact` 与
 *     `ArchiveStore.removeExact` 干脆是严格整体相等。
 * 后果（用户在界面上能点、但后端说"条目不存在"）：带 `[summary:…]` 的条目无法
 * 删除/编辑/归档，归档页里带 `[id:…]` 的条目连删除也失败（探针
 * `temp/me-check/probe/probe59d.mjs` 的输出与上游 issue 逐字一致）。
 *
 * 修复：`entryMatchKey(entry) = stripEntrySummary(stripEntryId(entry))` 是**唯一**
 * 匹配键，`findExactIndex` / `peekExact` / `ArchiveStore.removeExact` 全部改用它；
 * 多条命中沿用"歧义即拒绝"的既有语义。
 *
 * 变异性：把 `entryMatchKey` 退回 `stripEntryId`（或把 `removeExact` 退回
 * `entries.indexOf(content)`）→ 本文件 2/3/4/5 条用例变红（`ok:false` +
 * "条目不存在"），而第 7 条（原文匹配对照）仍绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArchiveStore, ENTRY_DELIMITER, MemoryStore, SuggestionQueue, entryMatchKey, projectHash,
  stripEntrySummary,
} from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { installApi } from '../lib/api.js'
import { validateRuntimePatch } from '../lib/index.js'
import { stripEntryId } from '../lib/sync/entryid.js'

// 本文件断言中文文案（i18n.test.js 覆盖英文列）。
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

const KEY_BODY = '正文第一段\n第二段'
const SUMMARY_ENTRY = `[id:deadbeef] [2026-09-22] [summary:一句话摘要] ${KEY_BODY}`
const ARCHIVE_ENTRY = '[id:aaaaaaaa] [2026-09-22] 归档正文\n（归档理由：陈旧）'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-entry-match-key-'))
}

function keyFilePath(dir) {
  return join(dir, 'projects', projectHash(dir), 'KEY.md')
}

function keyArchivePath(dir) {
  return join(dir, 'projects', projectHash(dir), 'KEY-archive.md')
}

/** 界面回传给后端的那串文本（与 lib/index.js 的展示剥离同一份实现）。 */
const displayText = (raw) => stripEntrySummary(stripEntryId(raw))

/** Boot a real HTTP server over installApi's handler（与 tests/api.test.js 同形）。 */
async function bootApi(dir) {
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { reviewEnabled: true, reviewInterval: 10, reviewMode: 'suggest', memoryTabEnabled: true }
  const ctx = {
    webServer: {
      register: ({ handler }) => { ctx.handler = handler; return () => {} },
    },
  }
  installApi(ctx, {
    store, archive, queue, todoStore,
    getRuntime: () => ({ ...state }),
    updateRuntime: (patch) => {
      for (const [key, value] of Object.entries(patch)) validateRuntimePatch(key, value)
      Object.assign(state, patch)
      return { ...state }
    },
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    // 记忆 Tab 的每个请求都带 sessionId；key/project 轨靠它解析 cwd。
    resolveCwd: () => dir,
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined
        ? { 'content-type': 'application/json', origin: base }
        : { origin: base },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { request, dir, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** 把 KEY.md 写成"渐进式披露的带摘要形态"（磁盘原文，含身份证）。 */
function seedSummaryKeyEntry(dir, raw = SUMMARY_ENTRY) {
  mkdirSync(join(dir, 'projects', projectHash(dir)), { recursive: true })
  writeFileSync(keyFilePath(dir), `${raw}\n`)
}

/* --------------------------------------------------------------- 匹配键本身 */

test('entryMatchKey：与展示层的双重剥离逐字同源，正文里的 [summary:…] 不误剥', () => {
  assert.equal(entryMatchKey(SUMMARY_ENTRY), `[2026-09-22] ${KEY_BODY}`)
  assert.equal(entryMatchKey(`[2026-09-22] ${KEY_BODY}`), `[2026-09-22] ${KEY_BODY}`)
  assert.equal(entryMatchKey(SUMMARY_ENTRY), displayText(SUMMARY_ENTRY), '匹配键必须等于界面回传的那串文本')
  // 正文里出现的 [summary:…] 不是头部标记，不剥（否则会把用户正文改坏）
  const inBody = `[2026-09-22] 正文 [foo] [summary:bar] 结尾`
  assert.equal(entryMatchKey(inBody), inBody)
})

/* -------------------------------------------------- 主轨：删除 / 编辑 / 归档 */

test('§7 删除：带 [summary:…] 的条目用界面文本可删（此前恒报"条目不存在"）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    seedSummaryKeyEntry(dir)
    const res = await api.request('POST', '/memory-evolve/api/memory/delete', {
      target: 'key', match: displayText(SUMMARY_ENTRY), sessionId: 's1',
    })
    assert.equal(res.status, 200, `删除失败：${JSON.stringify(res.data)}`)
    assert.equal(readFileSync(keyFilePath(dir), 'utf8').includes('正文第一段'), false, '磁盘上条目必须真的被删掉')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('§7 编辑：带 [summary:…] 的条目用界面文本可编辑，且身份证保留', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    seedSummaryKeyEntry(dir)
    const res = await api.request('POST', '/memory-evolve/api/memory/update', {
      target: 'key', match: displayText(SUMMARY_ENTRY), content: '改过的正文', sessionId: 's1',
    })
    assert.equal(res.status, 200, `编辑失败：${JSON.stringify(res.data)}`)
    const disk = readFileSync(keyFilePath(dir), 'utf8')
    assert.match(disk, /改过的正文/)
    assert.equal(disk.includes('正文第一段'), false, '旧正文必须被替换')
    assert.match(disk, /\[id:deadbeef\]/, '编辑不得丢掉身份证（替换不换身份）')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('§7 归档：带 [summary:…] 的条目用界面文本可归档（peekExact 是它的前置校验）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    seedSummaryKeyEntry(dir)
    const res = await api.request('POST', '/memory-evolve/api/memory/archive', {
      target: 'key', match: displayText(SUMMARY_ENTRY), sessionId: 's1',
    })
    assert.equal(res.status, 200, `归档失败：${JSON.stringify(res.data)}`)
    const archiveFile = readFileSync(keyArchivePath(dir), 'utf8')
    assert.match(archiveFile, /正文第一段/, '归档文件必须收到那条内容')
    assert.equal(readFileSync(keyFilePath(dir), 'utf8').includes('正文第一段'), false, '归档后主轨必须移除该条')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------ 归档页：删除 / 移回主记忆 */

test('§7 归档页删除：带 [id:…] 的归档条目用界面文本可删（此前 removeExact 严格 indexOf）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    seedSummaryKeyEntry(dir)
    writeFileSync(keyArchivePath(dir), `${ARCHIVE_ENTRY}\n`)
    const res = await api.request('POST', '/memory-evolve/api/memory/delete', {
      target: 'archive-key', match: displayText(ARCHIVE_ENTRY), sessionId: 's1',
    })
    assert.equal(res.status, 200, `归档条目删除失败：${JSON.stringify(res.data)}`)
    assert.equal(readFileSync(keyArchivePath(dir), 'utf8').includes('归档正文'), false, '归档文件里该条必须被删掉')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('§7 归档页移回：带 [id:…] 的归档条目用界面文本可移回主记忆', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    seedSummaryKeyEntry(dir)
    writeFileSync(keyArchivePath(dir), `${ARCHIVE_ENTRY}\n`)
    const res = await api.request('POST', '/memory-evolve/api/archive/promote', {
      target: 'key', match: displayText(ARCHIVE_ENTRY), sessionId: 's1',
    })
    assert.equal(res.status, 200, `移回失败：${JSON.stringify(res.data)}`)
    assert.match(readFileSync(keyFilePath(dir), 'utf8'), /归档正文/, '移回必须写进主轨')
    assert.equal(readFileSync(keyArchivePath(dir), 'utf8').includes('归档正文'), false, '移回后归档里不该留着')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- 防御面 */

test('§7 歧义：两条条目的匹配键相同 ⇒ 拒绝删除（绝不猜一条删掉）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    // 同一天、同一正文：一条带 [summary:…]、一条不带 ⇒ 剥掉展示标记后完全同形。
    // 两条必须用真正的条目分隔符（`\n§\n`）书写，否则会被当成同一条多行条目。
    mkdirSync(join(dir, 'projects', projectHash(dir)), { recursive: true })
    const twin = `[2026-09-22] ${KEY_BODY}`
    const before = `${SUMMARY_ENTRY}${ENTRY_DELIMITER}${twin}\n`
    writeFileSync(keyFilePath(dir), before)
    const res = await api.request('POST', '/memory-evolve/api/memory/delete', {
      target: 'key', match: displayText(SUMMARY_ENTRY), sessionId: 's1',
    })
    // `findExactIndex` 的既有契约：0 条/多条一律返回 -1，调用方按"不存在"处理
    // （§7 明确要求"在调用点保持歧义即拒绝的既有语义"，不新造文案）。
    assert.notEqual(res.status, 200, `歧义时必须拒绝：${JSON.stringify(res.data)}`)
    assert.equal(readFileSync(keyFilePath(dir), 'utf8'), before, '歧义拒绝不得改动文件')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('§7 对照：磁盘原文（含身份证/摘要标记）仍然照常匹配（旧路径不回归）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    seedSummaryKeyEntry(dir)
    const res = await api.request('POST', '/memory-evolve/api/memory/delete', {
      target: 'key', match: SUMMARY_ENTRY, sessionId: 's1',
    })
    assert.equal(res.status, 200, `原文匹配失败：${JSON.stringify(res.data)}`)
    assert.equal(readFileSync(keyFilePath(dir), 'utf8').includes('正文第一段'), false)
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
