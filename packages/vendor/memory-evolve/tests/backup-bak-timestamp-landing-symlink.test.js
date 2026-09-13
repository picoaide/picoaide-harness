/**
 * tests/backup-bak-timestamp-landing-symlink.test.js — me-2 回归（P2，R7 审计）。
 *
 * 缺陷：备份落点 `<file>.bak.<Date.now()>` 由字符串拼接后直接交给
 * `writeFileSync` / `copyFileSync`（跟随符号链接），**从未过任何断言**：
 *   - `lib/store.js` reload 的两个 drift 分支（疑似多条目 / 非 canonical）；
 *   - `lib/sync/repo.js` backfillEntryIds 的非 canonical 跳过分支；
 *   - `lib/sync/worker.js` runSync 的工作树 invalid 备份分支。
 * 攻击者按可预知的毫秒时间戳预铺一小片符号链接农场（指向同一个仓外受害
 * 文件）即可在窗口内让「备份」把字节写进**仓库外**的任意文件，而用户看到
 * 的提示仍然是"已备份到 <仓库内路径>"。
 *
 * 「改前失败」证据（改前代码跑本文件）：
 *   - 仓外受害者文件内容被改写成 MEMORY.md/KEY.md 的正文（断言等于原文红）；
 *   - reload 返回 `{kind:'drift', backup:'…'}`（备份路径实际是仓外链接）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { ensureMemoryRepo } from '../lib/sync/repo.js'

const OUTSIDE_TEXT = 'ORIGINAL-OUTSIDE-CONTENT\n'
/** 漏写 § 的多条目文件：parse→serialize 往返相等，但被判为"疑似合并条目"。 */
const MERGED = '[2026-01-01] first\n[2026-01-02] second\n'
/** 非 canonical（首行多余空行）：单条目，不触发"疑似合并条目"分支。 */
const NON_CANONICAL = '\n[2026-01-01] only entry\n'

/**
 * 预铺 `<name>.bak.<ts>` 符号链接农场（覆盖 [t0, t0+spanMs] 毫秒窗口），
 * 全部指向仓外受害者文件。原子写落地要几毫秒，真实攻击者也只能靠猜/铺。
 * @returns {number} 实际铺出的链接数。
 */
function seedBackupFarm(dir, name, outside, spanMs = 5000) {
  const t0 = Date.now()
  let seeded = 0
  for (let t = t0; t <= t0 + spanMs; t += 1) {
    try {
      symlinkSync(outside, join(dir, `${name}.bak.${t}`))
      seeded += 1
    } catch { /* 同名已存在：跳过 */ }
  }
  return seeded
}

test('me-2：store.reload 的 drift 备份不得沿 .bak.<Date.now()> 预置符号链接写到仓外（非 canonical 分支）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me2-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'memories')
  mkdirSync(dir, { recursive: true })
  const outside = join(root, 'outside-victim.txt')
  writeFileSync(outside, OUTSIDE_TEXT)
  writeFileSync(join(dir, 'MEMORY.md'), NON_CANONICAL)

  const fixed = 1_760_000_000_000
  const realNow = Date.now
  Date.now = () => fixed
  let outcome
  try {
    symlinkSync(outside, join(dir, `MEMORY.md.bak.${fixed}`))
    outcome = new MemoryStore(dir).reload('memory')
  } finally {
    Date.now = realNow
  }

  assert.equal(readFileSync(outside, 'utf8'), OUTSIDE_TEXT, '备份沿符号链接写到了仓库外')
  assert.notEqual(outcome.kind, 'drift', `备份落点不安全时不得报 drift（实际 ${JSON.stringify(outcome)}）`)
  assert.equal(outcome.kind, 'refused', '备份落点被拒必须是 fail-loud（refused）')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), NON_CANONICAL, '原文件不得被破坏性重写')
  assert.equal(lstatSync(join(dir, `MEMORY.md.bak.${fixed}`)).isSymbolicLink(), true, '预置链接不应被写穿/改名')
})

test('me-2：store.reload 的 drift 备份不得沿 .bak.<Date.now()> 预置符号链接写到仓外（疑似合并条目分支）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me2-merged-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'memories')
  mkdirSync(dir, { recursive: true })
  const outside = join(root, 'outside-victim.txt')
  writeFileSync(outside, OUTSIDE_TEXT)
  writeFileSync(join(dir, 'MEMORY.md'), MERGED)

  const fixed = 1_760_000_000_000
  const realNow = Date.now
  Date.now = () => fixed
  let outcome
  try {
    symlinkSync(outside, join(dir, `MEMORY.md.bak.${fixed}`))
    outcome = new MemoryStore(dir).reload('memory')
  } finally {
    Date.now = realNow
  }

  assert.equal(readFileSync(outside, 'utf8'), OUTSIDE_TEXT, '备份沿符号链接写到了仓库外')
  assert.equal(outcome.kind, 'refused', `备份落点被拒必须是 fail-loud（实际 ${JSON.stringify(outcome)}）`)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), MERGED, '原文件不得被破坏性重写')
})

test('me-2：store.reload 无预置链接时照常备份并报 drift（对照组）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me2-ok-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'memories')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), NON_CANONICAL)

  const outcome = new MemoryStore(dir).reload('memory')

  assert.equal(outcome.kind, 'drift', `正常路径应当备份并报 drift：${JSON.stringify(outcome)}`)
  assert.equal(readFileSync(outcome.backup, 'utf8'), NON_CANONICAL, '备份内容应与原文件逐字节一致')
  assert.equal(lstatSync(outcome.backup).isSymbolicLink(), false)
})

test('me-2：ensureMemoryRepo 补发身份证时的非 canonical 备份不得写出仓外', { skip: !gitAvailable() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me2-backfill-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const memoryDir = join(root, 'memories')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  const dir = join(memoryDir, 'projects', 'c4c4c4c4c4c4')
  mkdirSync(dir, { recursive: true })
  // 非 canonical 的 KEY.md → backfillEntryIds 走"备份后跳过"分支
  writeFileSync(join(dir, 'KEY.md'), MERGED)
  const outside = join(root, 'outside-victim.txt')
  writeFileSync(outside, OUTSIDE_TEXT)
  assert.ok(seedBackupFarm(dir, 'KEY.md', outside) > 0, '农场未铺出')

  const report = await ensureMemoryRepo({
    dir,
    memoryDir,
    cwd,
    projectId: 'c4c4c4c4c4c4',
    displayName: 'probe',
    remoteUrl: join(root, 'remote.git'),
    remoteBranch: 'main',
  })

  assert.equal(report.ok, true, `迁移/初始化应当继续：${JSON.stringify(report)}`)
  assert.equal(readFileSync(outside, 'utf8'), OUTSIDE_TEXT, '备份沿符号链接农场写到了仓库外')
  assert.equal(readFileSync(join(dir, 'KEY.md'), 'utf8'), MERGED, '非 canonical 文件不得被重写')
})

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}
