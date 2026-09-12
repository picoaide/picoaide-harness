/**
 * tests/sync-conflict-pathescape.test.js — 冲突侧车 `file` 字段路径逃逸
 * （审计 P1-9）
 *
 * 缺陷：`isMemoryFile` 的 logs/ 分支是 `startsWith('logs/') && endsWith('.md')`
 * ——`logs/../../victim/MEMORY.md` 判为**合法同步文件**；`resolveConflict`
 * 用 `join(dir, file)` 落盘并整文件重写，于是侧车里一个构造出来的 `file`
 * 就能写到记忆仓库之外（侧车随共享分支分发，可来自远端）。
 *
 * 修复：logs/ 白名单锚定为单层文件名（`^logs/[^/\\]+\.md$`），落盘前再用
 * `resolve()` 复核落点是否在仓库内（第二层，见 worker.resolveConflict）。
 *
 * 「改前失败」证据：还原 filesets.js:82 的旧布尔表达式（并移除 worker.js
 * 的落点包含性断言）后，本文件第 1、3、4 条用例失败——第 3 条是真实落盘
 * 链路：仓库外的 victim 文件被攻击内容改写，resolveConflict 之后才在 git
 * 步骤报错（"目标条目已写回"）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMemoryFile } from '../lib/sync/filesets.js'
import { renderConflicts, resolveConflict } from '../lib/sync/worker.js'

// 本套断言 pin 中文错误文案（i18n.test.js 覆盖英文）。
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-pathescape-'))
}

test('[P1-9] isMemoryFile：logs/ 白名单只接受单层文件名（.. 逃逸被拒）', () => {
  // 合法路径（resolveFilesetFiles 只从 logs/ 目录直接枚举出这种形状）
  assert.equal(isMemoryFile('logs/2026-09-12.md'), true)
  assert.equal(isMemoryFile('logs/2026-08-11.md', 'project'), true)
  // 逃逸与穿透形态全部拒绝
  assert.equal(isMemoryFile('logs/../../victim/MEMORY.md'), false, '.. 逃逸必须被拒（P1-9）')
  assert.equal(isMemoryFile('logs/../../victim/KEY.md'), false)
  assert.equal(isMemoryFile('logs/sub/dir/x.md'), false)
  assert.equal(isMemoryFile('logs/..\\..\\x.md'), false)
  assert.equal(isMemoryFile('../logs/x.md'), false)
  assert.equal(isMemoryFile('/etc/passwd.md'), false)
  assert.equal(isMemoryFile('logs/./x.md'), false)
  // 其它 fileset 的既有行为不受影响（logs 只属于 project）
  assert.equal(isMemoryFile('MEMORY.md', 'memory-global'), true)
  assert.equal(isMemoryFile('daily/2026-09-12.md', 'daily-global'), true)
  assert.equal(isMemoryFile('logs/2026-09-12.md', 'memory-global'), false)
})

test('[P1-9] resolveConflict：logs/ 内的合法目标照常落盘', async () => {
  const root = tempRoot()
  const dir = join(root, 'repo')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CONFLICTS.md'), renderConflicts([{
      entryKey: 'aaaa0000',
      file: 'logs/2026-09-12.md',
      reason: '内容双侧不同',
      base: '[2026-09-11] 日志',
      ours: '[2026-09-12] 本地日志',
      theirs: '[2026-09-12] 远端日志',
    }]))
    // 目标文件不需要预先存在（worker 会建目录）；git 步骤在无仓库时失败，
    // 但**写回已经发生**——本用例只断言写回这一半（白名单放行）。
    const outcome = await resolveConflict({ dir, index: 1, choice: 'ours' })
    const written = readFileSync(join(dir, 'logs', '2026-09-12.md'), 'utf8')
    assert.ok(written.includes('[2026-09-12] 本地日志'), `合法目标应写入，实际 outcome=${JSON.stringify(outcome)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('[P1-9] resolveConflict：逃逸的 file 被拒且仓库外文件零改动（真实落盘链路）', async () => {
  const root = tempRoot()
  const dir = join(root, 'repo')
  const victim = join(root, 'victim', 'MEMORY.md')
  try {
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(root, 'victim'), { recursive: true })
    const original = '[2026-01-01] 受害者文件原内容\n'
    writeFileSync(victim, original)
    writeFileSync(join(dir, 'CONFLICTS.md'), renderConflicts([{
      entryKey: 'aaaa0000',
      file: 'logs/../../victim/MEMORY.md', // 逃逸：resolve 后落在仓库外
      reason: '构造的恶意侧车条目',
      base: null,
      ours: '[2026-09-12] 攻击者写入的内容',
      theirs: null,
    }]))
    const outcome = await resolveConflict({ dir, index: 1, choice: 'ours' })
    // 先断言「仓库外文件零改动」——这是修复前最直接的失败点（旧实现真的
    // 把攻击内容写进了仓库外的 victim 文件，之后才在 git 步骤报错）。
    assert.equal(readFileSync(victim, 'utf8'), original, '仓库外的受害者文件绝不能被改写')
    assert.equal(outcome.ok, false, '逃逸目标必须被拒（P1-9）')
    assert.match(outcome.message, /白名单/)
    // 侧车保留（resolve 失败不消费冲突），且没有意外落盘
    assert.equal(existsSync(join(dir, 'CONFLICTS.md')), true)
    assert.equal(existsSync(join(root, 'victim', 'logs')), false)
    assert.equal(existsSync(join(root, 'MEMORY.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('[P1-9] resolveConflict：子目录穿透（logs/sub/x.md）同样被拒', async () => {
  const root = tempRoot()
  const dir = join(root, 'repo')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CONFLICTS.md'), renderConflicts([{
      entryKey: 'bbbb1111',
      file: 'logs/sub/x.md',
      reason: '子目录穿透',
      base: null,
      ours: 'x',
      theirs: null,
    }]))
    const outcome = await resolveConflict({ dir, index: 1, choice: 'ours' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /白名单/)
    assert.equal(existsSync(join(dir, 'logs')), false, '被拒的路径不应创建任何目录')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
