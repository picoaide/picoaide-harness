/**
 * tests/migration-symlink-outside-fence.test.js — me-5 回归（P1，R7 审计）。
 *
 * 缺陷：`ensureMemoryRepo` 步骤 0（legacy 迁移）的 `moveTreeInto` 用
 * `statSync(src).isDirectory()` **跟随**符号链接：旧记忆目录里一个指向
 * 仓库外的符号链接目录（用户自建，或共享分支 120000 条目 checkout 落地，
 * 正是 FIX-22 自己声明要防的场景）会被递归 readdir，然后 `renameSync` 把
 * **仓库外的文件搬进仓库**（源处删除）——数据从仓外被搬走并随后提交/同步
 * 出去，全过程返回 `ok:true`。同一函数的兄弟步骤（backfillEntryIds）早已
 * 加符号链接跳过，步骤 0 是修复不完整留下的破坏性出口。
 *
 * 「改前失败」证据（改前代码跑本文件）：
 *   - `outside/secret.txt` 与 `outside/deep/nested.txt` 在迁移后**消失**
 *     （被 rename 进新仓库，断言 `existsSync === true` 红）；
 *   - `newDir/edge/secret.txt` 出现（仓外数据被搬进仓库，断言 `=== false` 红）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMemoryRepo } from '../lib/sync/repo.js'
import { projectHash } from '../lib/store.js'

test('me-5：legacy 迁移不得沿符号链接目录把仓外文件搬进仓库（源处删除）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me5-mig-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const memoryDir = join(root, 'memories')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  const legacyId = projectHash(cwd)
  const newId = 'a2a2a2a2a2a2'
  const legacyDir = join(memoryDir, 'projects', legacyId)
  const newDir = join(memoryDir, 'projects', newId)
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'MEMORY.md'), '[id:1] legacy entry\n')

  // 用户数据在记忆仓库**之外**；legacy 目录里有一个指向它的符号链接目录。
  const outside = join(root, 'outside-user-data')
  mkdirSync(join(outside, 'deep'), { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-USER-DATA-must-not-move\n')
  writeFileSync(join(outside, 'deep', 'nested.txt'), 'NESTED-OUTSIDE-DATA\n')
  symlinkSync(outside, join(legacyDir, 'edge'))

  const report = await ensureMemoryRepo({
    dir: newDir,
    memoryDir,
    cwd,
    projectId: newId,
    displayName: 'probe',
    remoteUrl: join(root, 'remote.git'),
    remoteBranch: 'main',
  })

  assert.equal(report.ok, true, `迁移应当继续（跳过符号链接）而不是整体失败：${JSON.stringify(report)}`)
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE-USER-DATA-must-not-move\n', '仓外文件被搬走（源处删除）')
  assert.equal(existsSync(join(outside, 'deep', 'nested.txt')), true, '仓外子目录文件被搬走')
  assert.equal(existsSync(join(newDir, 'edge', 'secret.txt')), false, '仓外文件被搬进了记忆仓库')
  assert.equal(lstatSync(join(legacyDir, 'edge')).isSymbolicLink(), true, '符号链接未被原地保留')
  // 真实文件照常迁移（修复不能把迁移整个修死；entryId 补发会给它加行首身份证）
  assert.match(readFileSync(join(newDir, 'MEMORY.md'), 'utf8'), /\[id:1\] legacy entry/, '合法 legacy 文件未被迁移')
})

test('me-5：目标同名项是符号链接时同样跳过（rename 不得顺着链接落到仓库外）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me5-dst-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const memoryDir = join(root, 'memories')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  const legacyId = projectHash(cwd)
  const newDir = join(memoryDir, 'projects', 'b3b3b3b3b3b3')
  const legacyDir = join(memoryDir, 'projects', legacyId)
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'KEY.md'), 'LEGACY-KEY\n')

  // 新仓库里预先存在一个同名符号链接（共享分支 120000 条目 checkout 的结果）。
  mkdirSync(newDir, { recursive: true })
  const outsideDir = join(root, 'outside-dir')
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(join(newDir, 'logs'), { recursive: true })
  rmSync(join(newDir, 'logs'), { recursive: true, force: true })
  symlinkSync(outsideDir, join(newDir, 'logs'))
  mkdirSync(join(legacyDir, 'logs'), { recursive: true })
  writeFileSync(join(legacyDir, 'logs', '2026-01-01.md'), 'OUTSIDE-MUST-NOT-RECEIVE\n')

  const report = await ensureMemoryRepo({
    dir: newDir,
    memoryDir,
    cwd,
    projectId: 'b3b3b3b3b3b3',
    displayName: 'probe',
    remoteUrl: join(root, 'remote.git'),
    remoteBranch: 'main',
  })

  assert.equal(report.ok, true, `迁移应当继续（跳过目标侧符号链接）：${JSON.stringify(report)}`)
  assert.equal(existsSync(join(outsideDir, '2026-01-01.md')), false, '文件顺着目标侧符号链接落到了仓库外')
  assert.equal(lstatSync(join(newDir, 'logs')).isSymbolicLink(), true, '仓库内预置的符号链接不应被写穿/覆盖')
  assert.match(readFileSync(join(newDir, 'KEY.md'), 'utf8'), /LEGACY-KEY/, '普通 legacy 文件未被迁移')
})
