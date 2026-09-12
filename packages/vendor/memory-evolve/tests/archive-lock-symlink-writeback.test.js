/**
 * tests/archive-lock-symlink-writeback.test.js — FIX-22 第四轮（2026-09-13）：
 * 归档轨（ArchiveStore）与记忆锁（`.memory.lock`）的**真机回归**。
 *
 * 缺陷（第三轮对抗复核 M-2 确认，`temp/r3-verify-bm/R3-BM-VERDICT.md` §5）：
 *   1) `ArchiveStore`（append / remove / removeExact，读侧 entriesOf）是**唯一**
 *      没接 `hasSymlinkComponent` / `resolveSafeRepoTarget` 断言的心忆写回路径。
 *      攻击者在共享分支推一个 `KEY-archive.md` = 120000（指向仓库外文件）→
 *      受害端 checkout 得到真符号链接 → 归档一次就：读侧跟随链接把仓库外内容
 *      读进来、写侧 tmp+rename 把链接**静默替换**成普通文件，内容 = 仓库外文件
 *      内容，随后 push 把仓库外内容搬上共享分支（端到端已复现）。
 *   2) `.memory.lock` 是符号链接时（同样是 120000 条目的产物）`withLock` 空转
 *      5s 后抛 `timed out waiting for the memory lock`：持久 DoS + 文案完全不提
 *      符号链接（误导），且 stale 分支的 `rmSync` 会把仓库里被跟踪的那条 120000
 *      条目从工作树悄悄删掉。
 *
 * 本文件的断言纪律（用户要求"真机测试"，与 sync-symlink-writeback.test.js 同款）：
 *   - 每个"设备"是**独立 Node 子进程**（tests/fixtures/sync-device-child.mjs），
 *     各自 import 本包、各自跑 ArchiveStore/MemoryStore/withLock——不是同进程调用；
 *   - fixture 是**真 git 裸仓远端**（真 commit/push/fetch/checkout）；
 *   - 符号链接是**真符号链接**：一条由远端 120000 条目经真 checkout 落地
 *     （`git ls-tree` = `120000 blob`，B 侧 `lstatSync().isSymbolicLink() === true`），
 *     其余为 `symlinkSync` 直接摆放的等价形态；
 *   - 判据是**仓库外文件的实际字节** + 原链接是否完好 + 共享分支上的实际内容：
 *     修复前用例失败并回显"仓库外内容已进仓库/已上共享分支"，修复后被拒且
 *     仓库外文件逐字节未变、链接完好、`ok:false`。
 *
 * 「改前失败」证据（同一份用例，对改前快照副本跑）：
 *   cp -a packages/vendor/memory-evolve /tmp/me-prefix-r4      # 改前源码
 *   cp tests/archive-lock-symlink-writeback.test.js /tmp/me-prefix-r4/tests/
 *   cp tests/fixtures/sync-device-child.mjs       /tmp/me-prefix-r4/tests/fixtures/
 *   cd /tmp/me-prefix-r4 && HOME=… node --test tests/archive-lock-symlink-writeback.test.js
 *   → 归档用例失败（仓库内文件被写成 OUTSIDE-SECRET…、仓库外内容上共享分支），
 *     锁用例失败（耗时 ≥5000ms 且文案是"等锁超时"）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'sync-device-child.mjs')
const RB = 'dsh-shared/archive-symlink-probe'
const PROJ_ID = 'archprobe0001'
const BASE_KEY = '[2026-01-01] KEY-BASE\n'
const BASE_ARCH = '[2026-01-01] ARCH-BASE\n'
/** 仓库外 victim 的正文标记（必须**不出现在**仓库/共享分支上）。 */
const OUTSIDE_SECRET = 'OUTSIDE-SECRET-4f2a91\n'

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
  return mkdtempSync(join(tmpdir(), 'dsh-archive-symlink-'))
}

/**
 * 在**独立进程**里跑一次设备操作。返回 child 打印的 JSON。
 * @param {object} payload - 见 tests/fixtures/sync-device-child.mjs。
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

/** 真裸仓远端 + A/B 两台设备（记忆根 + 项目仓库目录 = 生产形状 projects/<id>）。 */
function fixture(root) {
  const bare = join(root, 'remote.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  const memoryDirA = join(root, 'A', 'memory')
  const memoryDirB = join(root, 'B', 'memory')
  const A = { memoryDir: memoryDirA, dir: join(memoryDirA, 'projects', PROJ_ID), cwd: join(root, 'projA') }
  const B = { memoryDir: memoryDirB, dir: join(memoryDirB, 'projects', PROJ_ID), cwd: join(root, 'projB') }
  mkdirSync(A.cwd, { recursive: true })
  mkdirSync(B.cwd, { recursive: true })
  return { bare, A, B }
}

/** 归档一次（独立进程，ArchiveStore 走生产的「项目目录解析器」形状）。 */
function archiveOp({ memoryDir, projectDir, cwd, ...rest }) {
  return device({ op: 'archive', dir: memoryDir, projectDir, target: 'key', cwd, action: 'append', ...rest })
}

/** 归档读一次（独立进程）。 */
function archiveRead({ memoryDir, projectDir, cwd }) {
  return device({ op: 'archive', dir: memoryDir, projectDir, target: 'key', cwd, action: 'read' })
}

/* ------------------------------------------------------------------ */
/* 1. 主缺陷：归档轨穿透共享分支 120000 条目 checkout 出的真符号链接       */
/* ------------------------------------------------------------------ */

test('[FIX-22-R4] 归档轨：真两进程 + 真 120000 checkout + 真符号链接 → 零写穿、零外泄', { skip }, () => {
  const root = tempRoot()
  try {
    const fx = fixture(root)
    const outside = join(root, 'OUTSIDE')
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'id_rsa-like.txt')
    writeFileSync(secret, OUTSIDE_SECRET)

    // A（进程 1）：bootstrap 基线（KEY.md + KEY-archive.md）+ 真 push
    const boot = device({
      op: 'bootstrap',
      dir: fx.A.dir, memoryDir: fx.A.memoryDir, cwd: fx.A.cwd,
      projectId: PROJ_ID, displayName: 'devA', remoteUrl: fx.bare, remoteBranch: RB,
      write: { 'KEY.md': BASE_KEY, 'KEY-archive.md': BASE_ARCH },
      push: true,
    })
    assert.equal(boot.ok, true, `A bootstrap 失败：${JSON.stringify(boot)}`)

    // 攻击者（纯 git，不经过本插件）：把 KEY-archive.md 换成 120000 指向仓库外
    rmSync(join(fx.A.dir, 'KEY-archive.md'), { force: true })
    symlinkSync(secret, join(fx.A.dir, 'KEY-archive.md'))
    git(fx.A.dir, ['add', '-f', 'KEY-archive.md'])
    git(fx.A.dir, ['commit', '-q', '-m', 'evil: KEY-archive.md -> 仓库外（120000）'])
    git(fx.A.dir, ['push', '-q', 'origin', `HEAD:refs/heads/${RB}`])
    assert.match(
      git(fx.A.dir, ['ls-tree', `refs/remotes/origin/${RB}`, 'KEY-archive.md']),
      /^120000 blob/,
      '远端分支里的 KEY-archive.md 必须是 120000 符号链接条目',
    )

    // B（进程 2）：真接入 → 真 checkout → 真符号链接
    const conn = device({ op: 'connect', dir: fx.B.dir, remoteUrl: fx.bare, remoteBranch: RB, expectedProjectId: PROJ_ID })
    assert.equal(conn.result.mode, 'adopt', `B 接入失败：${JSON.stringify(conn.result)}`)
    const linkB = join(fx.B.dir, 'KEY-archive.md')
    assert.equal(lstatSync(linkB).isSymbolicLink(), true, '前置：共享分支 120000 条目必须 checkout 成真符号链接')
    assert.equal(readlinkSync(linkB), secret)

    // B（进程 3）：归档一次 —— 缺陷出口（ArchiveStore.append）
    const arch = archiveOp({
      memoryDir: fx.B.memoryDir, projectDir: fx.B.dir, cwd: fx.B.cwd,
      content: '[id:new00001] [2026-01-02] NEW-KEY-ARCHIVE',
    })
    const res = arch.result

    // ── 判据 1：拒绝 + 文案含"符号链接"（与 sync.*symlinkRefused 同一条 i18n）──
    assert.equal(res.ok, false, `符号链接落点必须被拒绝，实际 ${JSON.stringify(arch)}`)
    assert.match(String(res.message), /符号链接/, `错误信息应说明符号链接，实际：${res.message}`)
    // ── 判据 2：仓库外文件逐字节未变（不是"改写成了别的东西"）──
    assert.equal(readFileSync(secret, 'utf8'), OUTSIDE_SECRET, '仓库外文件绝不能被归档写穿')
    // ── 判据 3：原符号链接完好（不是"删掉链接/替换成普通文件"了事）──
    assert.equal(lstatSync(linkB).isSymbolicLink(), true, '被拒后不得擅自删改仓库内符号链接')
    assert.equal(readlinkSync(linkB), secret)
    // ── 判据 4：零残留（仓库外目录只有原文件；仓库内无 .tmp 半成品）──
    assert.deepEqual(readdirSync(outside), ['id_rsa-like.txt'], `仓库外目录出现残留：${readdirSync(outside).join(',')}`)
    assert.equal(existsSync(`${linkB}.tmp.${process.pid}`), false, '被拒的归档不得留下半成品')
    assert.equal(existsSync(join(fx.B.dir, '.memory.lock')), false, '被拒的归档不得留下锁文件')

    // ── 判据 5：读侧不跟随链接（红时这里读出 OUTSIDE-SECRET…）──
    const read = archiveRead({ memoryDir: fx.B.memoryDir, projectDir: fx.B.dir, cwd: fx.B.cwd })
    const readText = JSON.stringify(read.extra.entries ?? '')
    assert.doesNotMatch(readText, /OUTSIDE-SECRET/, `归档读侧绝不能被符号链接带出仓库外内容：${readText}`)
    assert.match(String(read.extra.threw ?? ''), /符号链接/, `归档读侧被拒时必须是可诊断的 fail-loud：${JSON.stringify(read.extra)}`)

    // ── 判据 6：removeExact / remove 同一断言（不是只堵了 append）──
    const rm = device({
      op: 'archive', dir: fx.B.memoryDir, projectDir: fx.B.dir, target: 'key', cwd: fx.B.cwd,
      action: 'removeExact', content: OUTSIDE_SECRET.trim(),
    })
    assert.equal(rm.result.ok, false, `removeExact 也必须被拒：${JSON.stringify(rm.result)}`)
    assert.match(String(rm.result.message), /符号链接/)
    const rm2 = device({
      op: 'archive', dir: fx.B.memoryDir, projectDir: fx.B.dir, target: 'key', cwd: fx.B.cwd,
      action: 'remove', match: 'OUTSIDE',
    })
    assert.equal(rm2.result.ok, false, `remove 也必须被拒：${JSON.stringify(rm2.result)}`)
    assert.match(String(rm2.result.message), /符号链接/)

    // ── 判据 7：外泄链断——B 同步/推送后，共享分支上没有仓库外内容 ──
    // 被拒的形态可能是"符号链接落点"（ours 侧枚举到链接）或"远端格式异常"
    // （theirs = 120000 blob 的内容是链接目标路径，parse→serialize 不能往返）
    // ——两者都是 fail-loud 拒绝；判据是"零提交 + 共享分支上没有仓库外内容"。
    const push = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB, push: true })
    assert.equal(push.result.ok, false, `带符号链接的同步必须被拒：${JSON.stringify(push.result)}`)
    assert.equal(push.result.committed, false, '被拒的同步不得提交')
    const onRemote = git(fx.bare, ['show', `${RB}:KEY-archive.md`])
    assert.doesNotMatch(String(onRemote), /OUTSIDE-SECRET/, `仓库外内容绝不能被搬上共享分支：${onRemote}`)

    // ── 对照（证"不是把归档修死"）：删掉符号链接、对端恢复真文件后，归档与推送恢复正常 ──
    unlinkSync(join(fx.A.dir, 'KEY-archive.md'))
    writeFileSync(join(fx.A.dir, 'KEY-archive.md'), BASE_ARCH)
    git(fx.A.dir, ['add', '-f', 'KEY-archive.md'])
    git(fx.A.dir, ['commit', '-q', '-m', 'restore real KEY-archive.md'])
    git(fx.A.dir, ['push', '-q', 'origin', `HEAD:refs/heads/${RB}`])
    // B 侧把本地分支/工作树对齐到"已纠正"的远端（坏提交仍留在历史里，用户
    // 人工纠正后重新对账——控制变量：这里验证的是断言不会把归档功能修死）
    unlinkSync(linkB)
    git(fx.B.dir, ['fetch', '-q', 'origin', `${RB}:refs/remotes/origin/${RB}`])
    git(fx.B.dir, ['reset', '-q', '--hard', `refs/remotes/origin/${RB}`])
    assert.equal(lstatSync(linkB).isSymbolicLink(), false, '对照前置：恢复后必须是真文件')
    assert.match(readFileSync(linkB, 'utf8'), /ARCH-BASE/)
    const syncBack = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB })
    assert.equal(syncBack.result.ok, true, `去掉符号链接后同步必须恢复正常：${JSON.stringify(syncBack.result)}`)
    const arch2 = archiveOp({
      memoryDir: fx.B.memoryDir, projectDir: fx.B.dir, cwd: fx.B.cwd,
      content: '[id:new00002] [2026-01-03] AFTER-RESTORE',
    })
    assert.equal(arch2.result.ok, true, `去掉符号链接后归档必须恢复正常：${JSON.stringify(arch2.result)}`)
    assert.match(readFileSync(linkB, 'utf8'), /AFTER-RESTORE/)
    const push2 = device({ op: 'sync', dir: fx.B.dir, remoteBranch: RB, push: true })
    assert.equal(push2.result.ok, true, `恢复后推送必须成功：${JSON.stringify(push2.result)}`)
    assert.match(git(fx.bare, ['show', `${RB}:KEY-archive.md`]), /AFTER-RESTORE/, '正常路径下归档条目必须能上共享分支')
    // 仓库外文件全程未被碰过
    assert.equal(readFileSync(secret, 'utf8'), OUTSIDE_SECRET)
    assert.equal(existsSync(secret), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 2. 归档轨的另外两种落点形态：叶子链接（MEMORY-archive.md）+ 祖先链接     */
/* ------------------------------------------------------------------ */

test('[FIX-22-R4] 归档轨（memory 轨叶子链接 / key 轨祖先链接）：一律拒收且仓库外零改动', { skip }, () => {
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    const outside = join(root, 'OUTSIDE')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const victim = join(outside, 'MEMORY-archive.md')
    writeFileSync(victim, OUTSIDE_SECRET)

    // 形态 a：叶子就是符号链接（共享分支 120000 的等价形态）
    symlinkSync(victim, join(memoryDir, 'MEMORY-archive.md'))
    const app = device({ op: 'archive', dir: memoryDir, target: 'memory', action: 'append', content: '[id:new00010] [2026-01-05] FROM-ARCHIVE' })
    assert.equal(app.result.ok, false, `叶子符号链接必须被拒：${JSON.stringify(app.result)}`)
    assert.match(String(app.result.message), /符号链接/)
    const read = device({ op: 'archive', dir: memoryDir, target: 'memory', action: 'read' })
    assert.doesNotMatch(JSON.stringify(read.extra.entries ?? ''), /OUTSIDE-SECRET/)
    assert.match(String(read.extra.threw ?? ''), /符号链接/)
    assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_SECRET, '仓库外 victim 必须逐字节未变')
    assert.equal(lstatSync(join(memoryDir, 'MEMORY-archive.md')).isSymbolicLink(), true, '原链接必须完好')

    // 形态 b：祖先目录是符号链接（key 轨：projects/<hash>/KEY-archive.md）
    const projTarget = join(outside, 'projects-target')
    mkdirSync(projTarget, { recursive: true })
    symlinkSync(projTarget, join(memoryDir, 'projects'))
    const key = device({ op: 'archive', dir: memoryDir, target: 'key', cwd: join(root, 'projZ'), action: 'append', content: '[id:new00011] [2026-01-06] VIA-ANCESTOR' })
    assert.equal(key.result.ok, false, `祖先目录符号链接必须被拒：${JSON.stringify(key.result)}`)
    assert.match(String(key.result.message), /符号链接/)
    assert.deepEqual(readdirSync(projTarget), [], '祖先符号链接指向的仓库外目录必须零残留（连目录都不许建）')

    // 对照：把两种链接都换成真目录/真文件后恢复正常
    unlinkSync(join(memoryDir, 'MEMORY-archive.md'))
    writeFileSync(join(memoryDir, 'MEMORY-archive.md'), '[2026-01-01] ARCH-BASE\n')
    unlinkSync(join(memoryDir, 'projects'))
    mkdirSync(join(memoryDir, 'projects'), { recursive: true })
    const ok1 = device({ op: 'archive', dir: memoryDir, target: 'memory', action: 'append', content: '[id:new00012] [2026-01-07] OK-MEM' })
    assert.equal(ok1.result.ok, true, `去掉链接后 memory 轨归档应恢复：${JSON.stringify(ok1.result)}`)
    const ok2 = device({ op: 'archive', dir: memoryDir, target: 'key', cwd: join(root, 'projZ'), action: 'append', content: '[id:new00013] [2026-01-08] OK-KEY' })
    assert.equal(ok2.result.ok, true, `去掉链接后 key 轨归档应恢复：${JSON.stringify(ok2.result)}`)
    assert.match(readFileSync(join(memoryDir, 'MEMORY-archive.md'), 'utf8'), /OK-MEM/)
    assert.match(readFileSync(ok2.extra.file, 'utf8'), /OK-KEY/)
    assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_SECRET)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 3. P2：`.memory.lock` 为符号链接 → 立即 fail-loud（不是 5s 假死）        */
/* ------------------------------------------------------------------ */

test('[FIX-22-R4] 记忆锁：`.memory.lock` 为符号链接 → 立即 fail-loud（原为 5s 超时假死）', { skip }, () => {
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    const outside = join(root, 'OUTSIDE')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-01-01] BASE\n')

    // 形态 a：悬空链接（isStaleLock 判不出 stale → 旧实现必然空转到 5s 超时）
    const dangling = join(outside, 'does-not-exist.lock')
    symlinkSync(dangling, join(memoryDir, '.memory.lock'))
    const a = device({ op: 'lock', dir: memoryDir, mode: 'store', content: '[2026-01-02] LOCK-A' })
    assert.equal(a.result.ok, false, `锁是符号链接时写入必须被拒：${JSON.stringify(a.result)}`)
    assert.ok(a.extra.elapsedMs < 1500, `必须立即 fail-loud（实际 ${a.extra.elapsedMs}ms，旧实现 ≥5000ms 超时）`)
    assert.match(String(a.result.message), /符号链接/, `文案必须点名符号链接，实际：${a.result.message}`)
    assert.doesNotMatch(String(a.result.message), /timed out waiting for the memory lock/, '不得退化成"等锁超时"')
    assert.equal(lstatSync(join(memoryDir, '.memory.lock')).isSymbolicLink(), true, '被拒后不得删掉仓库内的锁符号链接')
    assert.equal(readlinkSync(join(memoryDir, '.memory.lock')), dangling)
    assert.deepEqual(readdirSync(outside), [], '仓库外零残留')

    // 形态 b：指向"看起来 stale 的活锁内容"（旧实现会 rmSync 删掉这条被跟踪的
    // 120000 条目再占锁——静默篡改仓库工作树）
    unlinkSync(join(memoryDir, '.memory.lock'))
    const staleLooking = join(outside, 'stale-looking.json')
    writeFileSync(staleLooking, JSON.stringify({ pid: 999999, at: 1 }))
    symlinkSync(staleLooking, join(memoryDir, '.memory.lock'))
    const b = device({ op: 'lock', dir: memoryDir })
    assert.equal(b.result.ok, false, `withLock 直接调用同样必须被拒：${JSON.stringify(b.result)}`)
    assert.ok(b.extra.elapsedMs < 1500, `withLock 直接调用也必须立即 fail-loud（实际 ${b.extra.elapsedMs}ms）`)
    assert.match(String(b.result.message), /符号链接/)
    const c = device({ op: 'lock', dir: memoryDir, mode: 'store', content: '[2026-01-03] LOCK-C' })
    assert.equal(c.result.ok, false, `stale 形态的锁符号链接同样必须被拒：${JSON.stringify(c.result)}`)
    assert.ok(c.extra.elapsedMs < 1500, `必须立即 fail-loud（实际 ${c.extra.elapsedMs}ms）`)
    assert.match(String(c.result.message), /符号链接/)
    assert.equal(lstatSync(join(memoryDir, '.memory.lock')).isSymbolicLink(), true, '不得 rmSync 删掉被跟踪的锁符号链接')
    assert.equal(readlinkSync(join(memoryDir, '.memory.lock')), staleLooking)
    assert.equal(readFileSync(staleLooking, 'utf8'), JSON.stringify({ pid: 999999, at: 1 }), '仓库外目标文件不得被改')
    assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), '[2026-01-01] BASE\n', '被拒的写入不得落地')

    // 对照：删掉锁符号链接后，取锁与写入恢复正常（未被修死）
    unlinkSync(join(memoryDir, '.memory.lock'))
    const ok = device({ op: 'lock', dir: memoryDir, mode: 'store', content: '[2026-01-04] LOCK-OK' })
    assert.equal(ok.result.ok, true, `去掉锁符号链接后写入应恢复：${JSON.stringify(ok.result)}`)
    assert.ok(ok.extra.elapsedMs < 3000, `正常取锁必须快（实际 ${ok.extra.elapsedMs}ms）`)
    assert.match(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), /LOCK-OK/)
    assert.equal(existsSync(join(memoryDir, '.memory.lock')), false, '正常路径释放锁后不留锁文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 4. 同族读侧：主轨 KEY.md / 待办文件是符号链接时不读、写入 fail-loud      */
/* ------------------------------------------------------------------ */

test('[FIX-22-R4] 读侧：KEY.md / TODOS 为符号链接 → 不注入仓库外内容、写入 fail-loud', { skip }, () => {
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    const projDir = join(memoryDir, 'projects', 'probe-proj')
    const outside = join(root, 'OUTSIDE')
    mkdirSync(projDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })

    // KEY.md（项目关键记忆，每轮注入上下文的那条轨）是符号链接
    const keyVictim = join(outside, 'secret-key.md')
    writeFileSync(keyVictim, '[2026-01-01] OUTSIDE-KEY-SECRET\n')
    symlinkSync(keyVictim, join(projDir, 'KEY.md'))

    const read = device({ op: 'store', dir: memoryDir, projectDir: projDir, target: 'key', cwd, action: 'entries' })
    assert.doesNotMatch(JSON.stringify(read.extra.entries ?? ''), /OUTSIDE-KEY-SECRET/, '读侧绝不能被链接带出仓库外内容（否则每轮注入上下文）')
    const add = device({ op: 'store', dir: memoryDir, projectDir: projDir, target: 'key', cwd, action: 'add', content: '[2026-01-02] NEW-KEY' })
    assert.equal(add.result.ok, false, `写入必须 fail-loud：${JSON.stringify(add.result)}`)
    assert.match(String(add.result.message), /符号链接/)
    assert.equal(readFileSync(keyVictim, 'utf8'), '[2026-01-01] OUTSIDE-KEY-SECRET\n', '仓库外 victim 必须逐字节未变')
    assert.equal(lstatSync(join(projDir, 'KEY.md')).isSymbolicLink(), true, '原链接必须完好')

    // TODOS-work.md（待办轨）是符号链接
    const todoVictim = join(outside, 'secret-todos.md')
    writeFileSync(todoVictim, '<!-- todos -->\n\n§\n[10:00] [id:aaaaaaaa] OUTSIDE-TODO-SECRET\n')
    symlinkSync(todoVictim, join(memoryDir, 'TODOS-work.md'))
    const todo = device({ op: 'todo', dir: memoryDir, action: 'list', target: 'work' })
    assert.doesNotMatch(JSON.stringify(todo.extra.items ?? ''), /OUTSIDE-TODO-SECRET/, '待办读侧不得跟随符号链接')
    assert.equal(readFileSync(todoVictim, 'utf8'), '<!-- todos -->\n\n§\n[10:00] [id:aaaaaaaa] OUTSIDE-TODO-SECRET\n')

    // 对照：换成真文件后读写恢复正常（未被修死）
    unlinkSync(join(projDir, 'KEY.md'))
    writeFileSync(join(projDir, 'KEY.md'), '[2026-01-01] REAL-KEY\n')
    const add2 = device({ op: 'store', dir: memoryDir, projectDir: projDir, target: 'key', cwd, action: 'add', content: '[2026-01-03] REAL-ADD' })
    assert.equal(add2.result.ok, true, `去掉链接后写入应恢复：${JSON.stringify(add2.result)}`)
    assert.match(readFileSync(join(projDir, 'KEY.md'), 'utf8'), /REAL-ADD/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 5. 文案同源：归档/锁/读侧的拒绝文案 = 同步层同一条 i18n 条目             */
/* ------------------------------------------------------------------ */

test('[FIX-22-R4] 拒绝文案与同步层共用同一条 i18n（不新造第二套措辞）', async () => {
  const { ArchiveStore, symlinkRefusedMessage, withLock } = await import('../lib/store.js')
  const { SYNC_DICT, translate, setLocale } = await import('../lib/i18n.js')
  setLocale('zh')
  /** 同步层（worker/repo/index）用的就是这一条 i18n 文案。 */
  const syncLayerText = (path) => translate(SYNC_DICT, 'sync.symlinkRefused', { path }, 'zh')
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    const outside = join(root, 'OUTSIDE')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const expectedArchive = syncLayerText('MEMORY-archive.md')
    const expectedLock = syncLayerText('.memory.lock')

    // ① 归档写侧（append / remove / removeExact）与读侧（entriesOf）同一条文案
    const victim = join(outside, 'v.md')
    writeFileSync(victim, 'OUTSIDE\n')
    symlinkSync(victim, join(memoryDir, 'MEMORY-archive.md'))
    const archive = new ArchiveStore(memoryDir)
    assert.equal(archive.append('memory', 'x').message, expectedArchive, '归档 append 必须复用 sync.symlinkRefused 文案')
    assert.equal(archive.remove('memory', 'x').message, expectedArchive)
    assert.equal(archive.removeExact('memory', 'x').message, expectedArchive)
    assert.throws(() => archive.entriesOf('memory'), (error) => error.message === expectedArchive, '归档读侧必须复用同一文案')
    assert.equal(symlinkRefusedMessage(memoryDir, join(memoryDir, 'MEMORY-archive.md')), expectedArchive, '统一文案函数与同步层逐字相同')
    assert.match(expectedArchive, /符号链接/)

    // ② 锁侧（withLock）同一条文案
    symlinkSync(join(outside, 'no-such-lock'), join(memoryDir, '.memory.lock'))
    assert.throws(() => withLock(memoryDir, () => {}), (error) => error.message === expectedLock, '锁落点被拒必须复用同一文案')
    assert.match(expectedLock, /符号链接/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
