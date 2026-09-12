/**
 * tests/memory-tab-read-symlink.test.js — FIX-26 第六轮（2026-09-13）：
 * 归档/主轨**读侧第二个入口**（记忆 Tab 数据路由）的真机回归。
 *
 * 缺陷（第五轮对抗复核 P1，`temp/r5-verify-server/memory/FINDINGS.md` §1）：
 *   `lib/memory-tab.js` 的 `buildMemoryFiles()` 对 `MEMORY/USER/KEY[-archive].md`
 *   裸 `readFileSync`，唯一调用点是真实路由 `GET /memory-evolve/api/memory-files`
 *   （客户端 MemoryTabView 在用）。同一进程、同一批符号链接：
 *   `ArchiveStore.entriesOf`（第四轮接的断言）正确拒绝，而这条路由此前以
 *   **200 把仓库外文件内容原样下发给 GUI**（实测 `OUTSIDE-ARCHIVE-SECRET…`）。
 *   即"归档读侧断言不覆盖全部入口"。
 *
 * 本文件的断言纪律（用户要求"真机测试"）：
 *   - 符号链接是**真符号链接**：由真裸仓的 `120000` 条目经**真 git clone/checkout**
 *     落地（`git ls-tree` = `120000 blob`，受害侧 `lstatSync().isSymbolicLink()`）；
 *   - 受害侧是**独立 Node 子进程**（tests/fixtures/sync-device-child.mjs），
 *     子进程里起**真 HTTP 服务**（installApi 的真实 handler）并 `fetch` 该路由；
 *   - 判据是"路由状态码 + 响应体里有没有仓库外正文 + 仓库外文件逐字节未变"。
 *
 * 「改前失败」证据（同一份用例对改前快照副本跑）：
 *   cp -a packages/vendor/memory-evolve /tmp/me-prefix-r6
 *   cp tests/memory-tab-read-symlink.test.js tests/fixtures/sync-device-child.mjs /tmp/me-prefix-r6/tests/…
 *   cd /tmp/me-prefix-r6 && node --test tests/memory-tab-read-symlink.test.js
 *   → 失败并回显 `status=200` + 仓库外正文（修复后 400 + 明确错误）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectHash, todayStamp } from '../lib/store.js'
import { resolveProjectDir } from '../lib/sync/identity.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'sync-device-child.mjs')
/** 仓库外 victim 的正文标记（必须**不出现在**任何 HTTP 响应里）。 */
const OUTSIDE_SECRET = 'OUTSIDE-ARCHIVE-SECRET-R6\n'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}
const skip = !gitAvailable()

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'init.defaultBranch',
  GIT_CONFIG_VALUE_0: 'main',
  GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.com',
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return String(r.stdout ?? '').trim()
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-tab-symlink-'))
}

/** 真子进程：起真 HTTP 服务并请求 `/memory-evolve/api/memory-files`。 */
function memoryTabChild({ memoryDir, cwd, projectDir, dshHome }) {
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify({
    pkg: PKG, op: 'memory-tab', dir: memoryDir, cwd, projectDir, sessionId: 's1',
  })], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...GIT_ENV, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = String(r.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '').pop()
  assert.ok(line, `子进程无输出（status=${r.status}）：${r.stderr}`)
  const parsed = JSON.parse(line)
  assert.equal(parsed.error, null, `子进程抛错：${parsed.error}`)
  return parsed.extra
}

/** 路由响应里是否出现了仓库外正文（含任意行的原样内容）。 */
function leaked(extra) {
  if (String(extra.raw ?? '').includes('OUTSIDE-ARCHIVE-SECRET')) return true
  return (extra.files ?? []).some((f) => String(f.content ?? '').includes('OUTSIDE-ARCHIVE-SECRET'))
}

/* ------------------------------------------------------------------ */
/* 1. 主缺陷：真 120000 checkout 出的符号链接 → 路由不得返回仓库外内容     */
/* ------------------------------------------------------------------ */

test('[FIX-26-R6] memory-files 路由：真 120000 checkout → 400 + 明确错误，零外泄', { skip }, () => {
  const root = tempRoot()
  try {
    const bare = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const outside = join(root, 'OUTSIDE')
    const cwd = join(root, 'proj')
    mkdirSync(bare, { recursive: true })
    mkdirSync(seed, { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(cwd, { recursive: true })

    // 仓库外 victim（真符号链接的目标，内容必须一次都不出现在响应里）
    const victims = {
      memArchive: join(outside, 'mem-archive.md'),
      memory: join(outside, 'memory.md'),
      userArchive: join(outside, 'user-archive.md'),
      keyArchive: join(outside, 'key-archive.md'),
      key: join(outside, 'key.md'),
    }
    for (const p of Object.values(victims)) writeFileSync(p, OUTSIDE_SECRET)

    // 项目目录：`projects/<hash>`（无 PROVENANCE → projectHash 回落，两侧一致）
    const projectHashDir = join('projects', projectHash(cwd))

    // 攻击者（纯 git，不经过本插件）：把记忆文件做成真符号链接并提交（120000）
    git(bare, ['init', '-q', '--bare'])
    git(seed, ['init', '-q'])
    git(seed, ['remote', 'add', 'origin', bare])
    const links = {
      'MEMORY-archive.md': victims.memArchive,
      'MEMORY.md': victims.memory,
      'USER-archive.md': victims.userArchive,
      [`${projectHashDir}/KEY-archive.md`]: victims.keyArchive,
      [`${projectHashDir}/KEY.md`]: victims.key,
    }
    for (const [rel, target] of Object.entries(links)) {
      const p = join(seed, rel)
      mkdirSync(dirname(p), { recursive: true })
      symlinkSync(target, p)
      git(seed, ['add', '-f', rel])
    }
    git(seed, ['commit', '-q', '-m', 'evil: 记忆文件 -> 仓库外（120000）'])
    git(seed, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/main'])
    for (const rel of Object.keys(links)) {
      assert.match(git(seed, ['ls-tree', 'HEAD', rel]), /^120000 blob/, `前置：${rel} 必须是 120000 符号链接条目`)
    }

    // 受害设备：真 clone → 真 checkout → 真符号链接
    const memoryDir = join(root, 'victim', 'memory')
    mkdirSync(dirname(memoryDir), { recursive: true })
    git(root, ['clone', '-q', bare, memoryDir])
    for (const rel of Object.keys(links)) {
      assert.equal(lstatSync(join(memoryDir, rel)).isSymbolicLink(), true, `前置：真 checkout 必须把 ${rel} 落地成真符号链接`)
    }

    // 受害进程：真 HTTP 路由
    const extra = memoryTabChild({ memoryDir, cwd, dshHome: join(root, 'dsh-home') })
    assert.equal(extra.status, 400, `符号链接落点必须 fail-loud（红时是 200 + 仓库外正文），实际：${extra.status} ${String(extra.raw).slice(0, 200)}`)
    assert.equal(leaked(extra), false, `路由响应里绝不能出现仓库外正文：${String(extra.raw).slice(0, 300)}`)
    assert.match(String(extra.error ?? ''), /符号链接/, `错误必须点名符号链接（与 ArchiveStore.entriesOf 同一条文案）：${extra.error}`)
    assert.doesNotMatch(String(extra.raw), /OUTSIDE-ARCHIVE-SECRET/)

    // 仓库外 victim 逐字节未变 + 仓库内链接完好（不是"删改链接了事"）
    for (const p of Object.values(victims)) assert.equal(readFileSync(p, 'utf8'), OUTSIDE_SECRET, `${p} 必须逐字节未变`)
    assert.equal(readdirSync(outside).length, 5, `仓库外目录不得出现残留：${readdirSync(outside).join(',')}`)
    for (const rel of Object.keys(links)) {
      assert.equal(lstatSync(join(memoryDir, rel)).isSymbolicLink(), true, `${rel} 的符号链接必须完好`)
    }

    // 对照（证"不是把 Tab 修死"）：删掉链接换成真文件后，同一路由恢复正常返回
    for (const rel of Object.keys(links)) {
      const p = join(memoryDir, rel)
      rmSync(p, { force: true })
      writeFileSync(p, `[2026-01-01] REAL-${basename(rel)}\n`)
    }
    const ok = memoryTabChild({ memoryDir, cwd, dshHome: join(root, 'dsh-home') })
    assert.equal(ok.status, 200, `去掉符号链接后路由必须恢复正常：${ok.status} ${String(ok.raw).slice(0, 200)}`)
    const rowOf = (key) => (ok.files ?? []).find((f) => f.key === key) ?? {}
    assert.match(String(rowOf('memory').content), /REAL-MEMORY\.md/, 'MEMORY.md 正常内容必须照常下发')
    assert.match(String(rowOf('archive-memory').content), /REAL-MEMORY-archive\.md/, 'MEMORY-archive.md 正常内容必须照常下发')
    assert.match(String(rowOf('key').content), /REAL-KEY\.md/, 'KEY.md 正常内容必须照常下发')
    assert.match(String(rowOf('archive-key').content), /REAL-KEY-archive\.md/, 'KEY-archive.md 正常内容必须照常下发')
    assert.equal(leaked(ok), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('[FIX-26-R6] memory-files 路由：正常仓库九轨照常返回（含仓库外 AGENTS.md）', () => {
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    const cwd = join(root, 'proj')
    const dshHome = join(root, 'dsh-home')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    const projectDir = resolveProjectDir(memoryDir, cwd)
    mkdirSync(join(memoryDir, 'daily'), { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-01-01] MEM-ROW\n')
    writeFileSync(join(memoryDir, 'USER.md'), '[2026-01-01] USER-ROW\n')
    writeFileSync(join(memoryDir, 'MEMORY-archive.md'), '[2026-01-01] MEM-ARCH-ROW\n')
    writeFileSync(join(memoryDir, 'USER-archive.md'), '[2026-01-01] USER-ARCH-ROW\n')
    writeFileSync(join(memoryDir, 'daily', `${todayStamp()}.md`), '[2026-01-01] DAILY-ROW\n')
    writeFileSync(join(projectDir, 'KEY.md'), '[2026-01-01] KEY-ROW\n')
    writeFileSync(join(projectDir, 'KEY-archive.md'), '[2026-01-01] KEY-ARCH-ROW\n')
    // AGENTS.md 在 DSH_HOME（记忆仓库之外）：不受仓库内断言约束，照旧返回
    writeFileSync(join(dshHome, 'AGENTS.md'), '# AGENTS-ROW\n')

    const extra = memoryTabChild({ memoryDir, cwd, dshHome })
    assert.equal(extra.status, 200, `正常仓库必须 200：${extra.status} ${String(extra.raw).slice(0, 200)}`)
    const contentOf = (key) => String((extra.files ?? []).find((f) => f.key === key)?.content ?? '')
    assert.match(contentOf('memory'), /MEM-ROW/)
    assert.match(contentOf('user'), /USER-ROW/)
    assert.match(contentOf('archive-memory'), /MEM-ARCH-ROW/)
    assert.match(contentOf('archive-user'), /USER-ARCH-ROW/)
    assert.match(contentOf('daily'), /DAILY-ROW/)
    assert.match(contentOf('key'), /KEY-ROW/)
    assert.match(contentOf('archive-key'), /KEY-ARCH-ROW/)
    assert.match(contentOf('agents'), /AGENTS-ROW/, '仓库外的 AGENTS.md 行必须照常读取（断言不得把非记忆仓库落点一起拒收）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
