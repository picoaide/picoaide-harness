/**
 * tests/sync-symlink-writeback.test.js — FIX-22 残留出口（runSync 三路合并
 * 写回）的**真机回归**：真 git 仓库 fixture + 真符号链接 + 真两进程同步。
 *
 * 缺陷（复核确认，2026-09-13 修）：
 *   `resolveConflict` 的落点已按 FIX-22 加固（逐层 lstat 拒符号链接 +
 *   realpath 包含性断言），但 `runSync` 的三路合并写回
 *   （worker.js `for (const [path, entries] of Object.entries(result.files))`
 *   → `join(dir, path)`）走的是**远端树路径**，完全绕开那套断言。仓库工作树里
 *   `logs` 是符号链接（= 共享分支里一个 120000 条目 checkout 的结果）时，合并
 *   结果会穿透链接写进**仓库外**目录。
 *
 * 本文件的断言纪律（用户要求"真机测试，不要猜测"）：
 *   - 每个"设备"是**独立 Node 子进程**（tests/fixtures/sync-device-child.mjs），
 *     各自 import 本包、各自跑 runSync —— 不是同进程函数调用；
 *   - fixture 是**真 git 仓库**（裸仓库做远端，真 commit/push/fetch/checkout）；
 *   - 符号链接是**真符号链接**（symlinkSync，仓库内 `logs -> <仓库外目录>`），
 *     并另有用例证明这种链接确实能由共享分支的 120000 条目经真 checkout 落地；
 *   - 判据是**仓库外文件的实际字节**：修复前攻击内容落盘（用例失败并回显实际
 *     内容），修复后被拒且仓库外文件逐字节未变。
 *
 * 「改前失败」证据（同一份用例，对改前快照副本跑）：
 *   cp -a packages/vendor/memory-evolve /tmp/me-prefix   # 改前源码
 *   cd /tmp/me-prefix && cp <本文件> tests/ && cp <child fixture> tests/fixtures/
 *   HOME=… node --test tests/sync-symlink-writeback.test.js
 *   → 「合并写回零写穿」用例失败，且失败信息里能看到仓库外文件被写成了
 *     `[id:xxxx] [2026-01-01] ATTACKER-CONTENT`（真实落盘，不是 mock）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'sync-device-child.mjs')
const RB = 'dsh-shared/symlink-probe'
const BASE = '[2026-01-01] BASE-CONTENT\n'
const ATTACK = '[2026-01-01] ATTACKER-CONTENT\n'

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

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return String(r.stdout ?? '').trim()
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-symlink-wb-'))
}

/**
 * 在**独立进程**里跑一次设备操作（真两进程同步）。返回 child 打印的 JSON。
 * @param {object} payload - 见 tests/fixtures/sync-device-child.mjs。
 * @returns {{op: string, ok: boolean, result: object|null, extra: object, error: string|null}}
 */
function device(payload) {
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ pkg: PKG, ...payload })], {
    encoding: 'utf8', timeout: 120000, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = String(r.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '').pop()
  assert.ok(line, `子进程无输出（status=${r.status}）：${r.stderr}`)
  const parsed = JSON.parse(line)
  assert.equal(parsed.error, null, `设备进程抛错：${parsed.error}`)
  return parsed
}

/** 裸仓库远端 + A/B 两个设备目录。 */
function fixture(root) {
  const bare = join(root, 'remote.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  const A = { dir: join(root, 'A', 'memory'), memoryDir: join(root, 'A', 'memory'), cwd: join(root, 'projA') }
  const B = { dir: join(root, 'B', 'memory'), cwd: join(root, 'projB') }
  mkdirSync(A.cwd, { recursive: true })
  mkdirSync(B.cwd, { recursive: true })
  return { bare, A, B }
}

/** 设备 A 引导：真 git 仓库 + `logs/2026-01-01.md` = BASE + 真 push（独立进程）。 */
function bootstrapA(fx, projectId = 'probe-proj') {
  return device({
    op: 'bootstrap',
    dir: fx.A.dir, memoryDir: fx.A.memoryDir, cwd: fx.A.cwd,
    projectId, displayName: 'devA', remoteUrl: fx.bare, remoteBranch: RB,
    write: { 'logs/2026-01-01.md': BASE },
    push: true,
  })
}

/** 设备 B 接入（独立进程，真 fetch + checkout）。 */
function connectB(fx, projectId = 'probe-proj') {
  return device({
    op: 'connect', dir: fx.B.dir, remoteUrl: fx.bare, remoteBranch: RB,
    expectedProjectId: projectId,
  })
}

/* ------------------------------------------------------------------ */
/* 1. 主缺陷：runSync 三路合并写回穿透仓库内符号链接                      */
/* ------------------------------------------------------------------ */

test('[FIX-22] runSync 合并写回：真两进程 + 仓库内 logs 符号链接 → 零写穿且拒绝', { skip }, () => {
  const root = tempRoot()
  try {
    const fx = fixture(root)
    const outside = join(root, 'OUTSIDE')
    mkdirSync(outside, { recursive: true })
    const victim = join(outside, '2026-01-01.md')
    writeFileSync(victim, BASE)

    // A（进程 1）：初始化 + 推送 base 版本
    const boot = bootstrapA(fx)
    assert.equal(boot.ok, true, `A bootstrap 失败：${JSON.stringify(boot)}`)
    assert.equal(boot.result.ok, true, `A 首推失败：${JSON.stringify(boot.result)}`)

    // B（进程 2）：接入共享分支
    const conn = connectB(fx)
    assert.equal(conn.result.mode, 'adopt', `B 接入失败：${JSON.stringify(conn.result)}`)

    // 攻击前置：B 的工作树里 logs 是符号链接（= 共享分支 120000 条目 checkout
    // 的等价形态；用例 2 证明该形态确实能由真 checkout 落地），链接目标里放一
    // 份与 base 相同的副本（B 侧"未改动"，避免被判删除）
    rmSync(join(fx.B.dir, 'logs'), { recursive: true, force: true })
    symlinkSync(outside, join(fx.B.dir, 'logs'))
    assert.equal(lstatSync(join(fx.B.dir, 'logs')).isSymbolicLink(), true, '前置：B 侧 logs 必须是真符号链接')
    assert.equal(readlinkSync(join(fx.B.dir, 'logs')), outside)

    // A（进程 3）：把日志改成攻击者内容并推送（单侧修改 → B 侧应采用 theirs）
    const push = device({
      op: 'sync', dir: fx.A.dir, remoteBranch: RB, push: true,
      write: { 'logs/2026-01-01.md': ATTACK },
    })
    assert.equal(push.result.ok, true, `A 推送攻击内容失败：${JSON.stringify(push.result)}`)

    // B（进程 4）：真 runSync —— 这里是缺陷出口
    const sync = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB })
    const res = sync.result

    // ── 判据 1：仓库外文件的实际字节（修复前这里是 ATTACKER-CONTENT）──
    const after = readFileSync(victim, 'utf8')
    assert.equal(
      after, BASE,
      `仓库外文件被符号链接写穿：期望 ${JSON.stringify(BASE)}，实际 ${JSON.stringify(after)}（runSync=${JSON.stringify(res)}）`,
    )
    // ── 判据 2：明确拒绝 + 错误文案 ──
    assert.equal(res.ok, false, `符号链接落点必须被拒绝，实际 ${JSON.stringify(res)}`)
    assert.match(res.message, /符号链接/, `错误信息应说明符号链接，实际：${res.message}`)
    assert.equal(res.committed, false, '被拒的同步不得提交')
    // ── 判据 3：攻击面零残留（仓库外目录只有原文件，没有 .tmp.<pid> 半成品）──
    assert.deepEqual(readdirSync(outside).sort(), ['2026-01-01.md'], `仓库外目录出现残留：${readdirSync(outside).join(',')}`)
    // ── 判据 4：原符号链接与仓库外原文件完好（不是"删掉链接了事"）──
    assert.equal(lstatSync(join(fx.B.dir, 'logs')).isSymbolicLink(), true, '被拒后不得擅自删改仓库内符号链接')
    assert.equal(readFileSync(victim, 'utf8'), BASE, '仓库外原文件必须逐字节完好')

    // ── 对照（证"不是把同步修死了"）：删掉符号链接、恢复真目录后同一次同步成功 ──
    unlinkSync(join(fx.B.dir, 'logs'))
    mkdirSync(join(fx.B.dir, 'logs'), { recursive: true })
    writeFileSync(join(fx.B.dir, 'logs', '2026-01-01.md'), BASE)
    const retry = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB })
    assert.equal(retry.result.ok, true, `去掉符号链接后同步必须恢复正常：${JSON.stringify(retry.result)}`)
    assert.match(readFileSync(join(fx.B.dir, 'logs', '2026-01-01.md'), 'utf8'), /ATTACKER-CONTENT/, '正常路径下应采用远端修改')
    // 仓库外目录始终只有原文件（真目录这次写的是仓库内）
    assert.equal(readFileSync(victim, 'utf8'), BASE, '恢复正常后仓库外文件仍不得被碰')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 2. 缺陷前置的现实性：共享分支的 120000 条目 → 真 checkout → 真符号链接 */
/* ------------------------------------------------------------------ */

test('[FIX-22] 前置现实性：共享分支里的 120000 条目经真 checkout 落地为真符号链接', { skip }, () => {
  const root = tempRoot()
  try {
    // 对端设备直接用 git 造分支（模拟"另一台设备/被篡改的分支"——攻击者
    // 不必使用本插件代码）：先推真目录版本，再推一个把 logs 换成符号链接的提交
    const bare = join(root, 'remote.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const peer = join(root, 'peer')
    mkdirSync(peer, { recursive: true })
    git(peer, ['init', '-q', '-b', 'main'])
    git(peer, ['remote', 'add', 'origin', bare])
    writeFileSync(join(peer, 'PROVENANCE'), `${JSON.stringify({ projectId: 'link-proj', displayName: 'peer', version: 1, remoteBranch: RB, enabled: true, tracks: { project: true } })}\n`)
    mkdirSync(join(peer, 'logs'), { recursive: true })
    writeFileSync(join(peer, 'logs', '2026-01-01.md'), BASE)
    git(peer, ['add', '-f', '-A'])
    git(peer, ['commit', '-q', '-m', 'peer: base'])
    git(peer, ['push', '-q', 'origin', `main:${RB}`])

    const outside = join(root, 'OUTSIDE')
    mkdirSync(outside, { recursive: true })
    rmSync(join(peer, 'logs'), { recursive: true, force: true })
    symlinkSync(outside, join(peer, 'logs'))
    git(peer, ['add', '-f', '-A'])
    git(peer, ['commit', '-q', '-m', 'peer: logs -> 仓库外（120000）'])
    git(peer, ['push', '-q', 'origin', `main:${RB}`])
    assert.match(git(peer, ['ls-tree', 'HEAD', 'logs']), /^120000 blob/, '远端分支里的 logs 必须是 120000 符号链接条目')

    // 设备 B 真接入（独立进程）：checkout 把 120000 实体化成真符号链接
    const B = { dir: join(root, 'B', 'memory'), cwd: join(root, 'projB') }
    mkdirSync(B.cwd, { recursive: true })
    const conn = device({ op: 'connect', dir: B.dir, remoteUrl: bare, remoteBranch: RB, expectedProjectId: 'link-proj' })
    assert.equal(conn.result.mode, 'adopt', `接入失败：${JSON.stringify(conn.result)}`)
    assert.equal(conn.extra.worktree.logs.kind, 'symlink', `checkout 应把 120000 实体化成真符号链接，实际 ${JSON.stringify(conn.extra.worktree)}`)
    assert.equal(conn.extra.worktree.logs.target, outside)
    assert.equal(lstatSync(join(B.dir, 'logs')).isSymbolicLink(), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 3. 第二个出口：CONFLICTS.md 侧车是符号链接时同样拒收                   */
/* ------------------------------------------------------------------ */

test('[FIX-22] runSync 冲突侧车：CONFLICTS.md 为符号链接 → 拒收且仓库外文件零改动', { skip }, () => {
  const root = tempRoot()
  try {
    const fx = fixture(root)
    const outsideVictim = join(root, 'outside-conflicts.md')
    writeFileSync(outsideVictim, 'OUTSIDE-ORIGINAL\n')

    const boot = bootstrapA(fx)
    assert.equal(boot.ok, true)
    const conn = connectB(fx)
    assert.equal(conn.result.mode, 'adopt')

    // B 侧把 CONFLICTS.md 换成符号链接（共享分支里 120000 条目的等价形态）
    symlinkSync(outsideVictim, join(fx.B.dir, 'CONFLICTS.md'))
    // B 与 A 改**同一条**（保留行首身份证，让合并判为双侧修改 → 真冲突 →
    // runSync 必须写冲突侧车），A 另外新增一个文件（用来验证"被拒时零写盘"：
    // 该新增文件本来会在合并写回里落到 B 的工作树）
    const bLog = join(fx.B.dir, 'logs', '2026-01-01.md')
    writeFileSync(bLog, readFileSync(bLog, 'utf8').replace('BASE-CONTENT', 'B-LOCAL-EDIT'))
    const aLog = join(fx.A.dir, 'logs', '2026-01-01.md')
    writeFileSync(aLog, readFileSync(aLog, 'utf8').replace('BASE-CONTENT', 'A-REMOTE-EDIT'))
    const push = device({
      op: 'sync', dir: fx.A.dir, remoteBranch: RB, push: true,
      write: { 'logs/2026-01-02.md': '[2026-01-02] A-NEW-FILE\n' },
    })
    assert.equal(push.result.ok, true, `A 推送失败：${JSON.stringify(push.result)}`)

    const sync = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB })
    const victimAfter = readFileSync(outsideVictim, 'utf8')
    assert.equal(
      victimAfter, 'OUTSIDE-ORIGINAL\n',
      `仓库外的 CONFLICTS.md 符号链接目标被改写：实际 ${JSON.stringify(victimAfter)}（runSync=${JSON.stringify(sync.result)}）`,
    )
    assert.equal(sync.result.ok, false, `符号链接侧车必须拒收：${JSON.stringify(sync.result)}`)
    assert.match(sync.result.message, /符号链接/)
    assert.equal(lstatSync(join(fx.B.dir, 'CONFLICTS.md')).isSymbolicLink(), true, '被拒后符号链接应原样保留')
    // 零写盘：被拒的同步不得留下任何合并写回痕迹（B 本地内容原样、远端新增未落盘）
    assert.match(readFileSync(bLog, 'utf8'), /B-LOCAL-EDIT/, '被拒的同步不得改动本地文件')
    assert.equal(existsSync(join(fx.B.dir, 'logs', '2026-01-02.md')), false, '被拒的同步不得部分写回（半成品工作树）')
    assert.equal(existsSync(join(fx.B.dir, 'CONFLICTS.md.tmp.' + process.pid)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 5. 同族第三/第四出口：初始化期的固定名元数据与 entryId 补发              */
/* ------------------------------------------------------------------ */

test('[FIX-22] 同族出口：.gitignore 为符号链接时初始化拒绝，仓库外文件零改动', { skip }, () => {
  const root = tempRoot()
  try {
    const victim = join(root, 'outside-gitignore')
    writeFileSync(victim, 'OUTSIDE-ORIGINAL\n')
    const dir = join(root, 'repo')
    const cwd = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    // .gitignore 是被跟踪的固定名文件：共享分支里一个 120000 条目就能让
    // checkout 在本机把它变成符号链接，随后初始化写 .gitignore 时穿透写穿
    symlinkSync(victim, join(dir, '.gitignore'))

    const boot = device({
      op: 'bootstrap', dir, memoryDir: dir, cwd,
      projectId: 'meta-proj', displayName: 'meta', remoteUrl: join(root, 'remote.git'), remoteBranch: RB,
    })
    const after = readFileSync(victim, 'utf8')
    assert.equal(after, 'OUTSIDE-ORIGINAL\n', `仓库外的 .gitignore 目标被写穿：实际 ${JSON.stringify(after)}`)
    const report = boot.extra.bootstrap
    assert.equal(report.ok, false, `固定名元数据为符号链接时必须拒绝：${JSON.stringify(report)}`)
    assert.match(report.message, /符号链接/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('[FIX-22] 同族出口：entryId 补发不穿透 logs 符号链接改写仓库外文件', { skip }, () => {
  const root = tempRoot()
  try {
    const outside = join(root, 'OUTSIDE')
    mkdirSync(outside, { recursive: true })
    const victim = join(outside, '2026-01-01.md')
    const original = '[2026-01-01] NO-ID-ENTRY\n'
    writeFileSync(victim, original)
    const dir = join(root, 'repo')
    const cwd = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    symlinkSync(outside, join(dir, 'logs'))

    // ensureMemoryRepo → backfillEntryIds 会按 fileset 枚举并整文件重写；
    // 修复前它 statSync 跟随符号链接，把仓库外的文件补上身份证（写穿）
    device({
      op: 'bootstrap', dir, memoryDir: dir, cwd,
      projectId: 'backfill-proj', displayName: 'bf', remoteUrl: join(root, 'remote.git'), remoteBranch: RB,
    })
    const after = readFileSync(victim, 'utf8')
    assert.equal(after, original, `仓库外文件被 entryId 补发写穿：实际 ${JSON.stringify(after)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 6. 同族第五出口（本地写族）：daily/ 目录符号链接下的 store / todo 写    */
/* ------------------------------------------------------------------ */

test('[FIX-22] 同族出口（本地写族）：daily 目录为符号链接时 store/todo 拒写且仓库外零改动', { skip }, async () => {
  const { MemoryStore } = await import('../lib/store.js')
  const { resolveConfig } = await import('../lib/index.js')
  const { TodoStore } = await import('../lib/todo.js')
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    const outside = join(root, 'OUTSIDE')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    // 共享记忆分支里 daily/ 是一个 120000 条目 → checkout 后本机是真符号链接
    symlinkSync(outside, join(memoryDir, 'daily'))

    const config = resolveConfig({ memoryDir })
    const store = new MemoryStore(config.memoryDir, config)
    assert.throws(
      () => store.add('daily', '[10:00] [probe] STORE-DAILY-WRITE'),
      /symlink|符号链接/,
      'store 写入符号链接目录必须拒收（fail closed）',
    )
    const todoStore = new TodoStore(config.memoryDir)
    assert.throws(
      () => todoStore.addTodo('daily', '探针待办'),
      /symlink|符号链接/,
      'todo 写入符号链接目录必须拒收（fail closed）',
    )
    assert.deepEqual(readdirSync(outside), [], `仓库外目录必须零残留，实际：${readdirSync(outside).join(',')}`)

    // 对照：把 daily 换成真目录后，本地写恢复正常（未被修死）
    unlinkSync(join(memoryDir, 'daily'))
    mkdirSync(join(memoryDir, 'daily'), { recursive: true })
    const okStore = store.add('daily', '[10:00] [probe] STORE-DAILY-WRITE')
    assert.equal(okStore.ok, true, `去掉符号链接后 store 写入应恢复：${JSON.stringify(okStore)}`)
    const okTodo = todoStore.addTodo('daily', '探针待办')
    assert.equal(okTodo.ok, true, `去掉符号链接后 todo 写入应恢复：${JSON.stringify(okTodo)}`)
    assert.ok(readdirSync(join(memoryDir, 'daily')).length >= 2, '真目录里应落下 store 与 todo 两个文件')
    assert.deepEqual(readdirSync(outside), [], '仓库外目录始终零残留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 7. 正常同步未被修死：干净仓库（无符号链接）真两进程双向合并             */
/* ------------------------------------------------------------------ */

test('[FIX-22] 干净仓库（无符号链接）真两进程同步仍成功合并（未被修死）', { skip }, () => {
  const root = tempRoot()
  try {
    const fx = fixture(root)
    const boot = bootstrapA(fx)
    assert.equal(boot.ok, true)
    assert.equal(boot.result.ok, true)
    const conn = connectB(fx)
    assert.equal(conn.result.mode, 'adopt')

    // B 首次同步：拿到 A 的 base
    const b0 = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB })
    assert.equal(b0.result.ok, true, `B 首次同步失败：${JSON.stringify(b0.result)}`)
    // 注意：内容比对一律用 includes —— ensureMemoryRepo 会给条目补行首身份证
    // （`[id:xxxxxxxx] `），逐字节相等不是本用例的判据
    assert.match(readFileSync(join(fx.B.dir, 'logs', '2026-01-01.md'), 'utf8'), /BASE-CONTENT/)

    // A 改内容；B 本地新增另一个日志文件 → B 合并（并集）+ 推送
    const a1 = device({
      op: 'sync', dir: fx.A.dir, remoteBranch: RB, push: true,
      write: { 'logs/2026-01-01.md': '[2026-01-01] A-UPDATED\n' },
    })
    assert.equal(a1.result.ok, true, `A 同步失败：${JSON.stringify(a1.result)}`)
    const b1 = device({
      op: 'sync', dir: fx.B.dir, remoteBranch: RB, push: true,
      write: { 'logs/2026-01-02.md': '[2026-01-02] B-ADDED\n' },
    })
    assert.equal(b1.result.ok, true, `B 合并失败：${JSON.stringify(b1.result)}`)
    assert.match(readFileSync(join(fx.B.dir, 'logs', '2026-01-01.md'), 'utf8'), /A-UPDATED/, 'B 应采纳 A 的单侧修改')
    assert.match(readFileSync(join(fx.B.dir, 'logs', '2026-01-02.md'), 'utf8'), /B-ADDED/)

    // A 再同步：拿到 B 的新增（收敛一致）
    const a2 = device({ op: 'sync', dir: fx.A.dir, remoteBranch: RB })
    assert.equal(a2.result.ok, true, `A 回同步失败：${JSON.stringify(a2.result)}`)
    assert.match(readFileSync(join(fx.A.dir, 'logs', '2026-01-02.md'), 'utf8'), /B-ADDED/, 'A 应拿到 B 新增')
    assert.match(readFileSync(join(fx.A.dir, 'logs', '2026-01-01.md'), 'utf8'), /A-UPDATED/)
    // 两侧工作树都是真目录（同步全程没有创建/替换任何符号链接）
    assert.equal(lstatSync(join(fx.A.dir, 'logs')).isSymbolicLink(), false)
    assert.equal(lstatSync(join(fx.B.dir, 'logs')).isSymbolicLink(), false)
    assert.equal(existsSync(join(fx.B.dir, 'CONFLICTS.md')), false, '无冲突不应留下侧车')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
