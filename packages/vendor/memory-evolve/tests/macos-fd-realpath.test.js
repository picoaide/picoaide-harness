/**
 * macOS `/dev/fd` 陷阱回归（2026-09-16 客户现场，阻塞级）。
 *
 * **现场症状**：macOS 客户端上**一切记忆写入失败**（读取正常），面板报
 * 「Failed: 仓库内 .memory.lock 是符号链接（或越出仓库边界）——已拒绝写入」，
 * 但用户实测目录树里**一个符号链接都没有**、`.memory.lock` 都是 0 字节普通
 * 文件，而且"写入尝试后会重新生成"、越积越多。
 *
 * **根因**：`fdRealPath()` 用 `/proc/self/fd/N` → `/dev/fd/N` 反查 fd 真实路径。
 * macOS 上 `/proc/self/fd` 不存在，而 `realpathSync('/dev/fd/N')` **不解析**、
 * 原样返回 `/dev/fd/N`（且不抛错）。于是：
 *   包含性检查 `isInsideRoot(realRoot, '/dev/fd/20')` → false
 *   → `openExclusiveSafe` 返回 `unsafe`
 *   → `withLock` 抛误导性的"符号链接/越界"文案（`.memory.lock` 其实完好）；
 *   清理用的 `unlinkSync('/dev/fd/N')` 又什么也删不掉 ⇒ 0 字节残留锁堆积。
 *
 * CI 跑在 Linux 上（`/proc/self/fd` 正常解析），所以这里用**loader 钩子把
 * `node:fs` 换成 macOS 形态**（`/dev/fd/*` 原样返回、`/proc/self/fd` ENOENT）
 * 来复现——实测：回退修复后，本条用例会抛出与客户**逐字相同**的那句话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fdRealPath } from '../lib/sync/filesets.js'
import { MemoryStore, withLock } from '../lib/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = join(HERE, 'fixtures', 'register-macos.mjs')
const CHILD = join(HERE, 'fixtures', 'macos-write-child.mjs')

test('macOS 形态（/dev/fd 不解析）：写入闭环必须成立、且不留残留锁', () => {
  const result = spawnSync(process.execPath, ['--import', REGISTER, CHILD], { encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `macOS 形态下记忆写入失败（客户现场复现）：\n${result.stderr}`,
  )
  const out = JSON.parse(result.stdout.trim())
  assert.equal(out.fdRealPathIsNull, true, 'fdRealPath 不得把 /dev/fd/N 当真实路径返回')
  assert.equal(out.fdRealPathReturnedDevFd, false)
  assert.equal(out.lockOpen, 'ok', '锁落点必须能 O_EXCL 打开（现场在这里被判 unsafe）')
  assert.equal(out.memoryFile, true, '记忆文件必须真的落盘')
  assert.match(out.memoryContent, /macOS shim 写入回归/)
  assert.deepEqual(out.leftoverLocks, [], '不得留下 0 字节残留锁')
  assert.equal(out.withLock, true, 'withLock 必须能取到锁')
})

test('本机平台：有 /proc/self/fd 就必须真解析出与 fd 同一 inode 的真实路径', (t) => {
  // TQ-1（2026-09-17 审计）：原先这里 `if (resolved === null) return`——把
  // 「解析循环被删/回归」和「平台没有 fd 入口」混成同一结果，于是在有 /proc 的
  // Linux/CI 上删掉 lib/sync/filesets.js fdRealPath() 的整个解析循环，本用例
  // （它是 fdRealPath 的**唯一**覆盖）照样绿。
  // 现在闸门只看 /proc/self/fd（fdRealPath 的**第一候选**）：有它就必须解析成功，
  // 且先用 realpathSync 正面证明这一跳在本机是活的；只有 macOS 这类没有 /proc、
  // 且 /dev/fd 按设计**不解析**的平台才 skip（那条分支由本文件第一条 shim 用例覆盖）。
  if (!existsSync('/proc/self/fd')) {
    return t.skip('本机无 /proc/self/fd（macOS 的 /dev/fd 不解析）：fdRealPath 合法的返回值就是 null')
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fdreal-'))
  try {
    const file = join(dir, 'x.txt')
    writeFileSync(file, 'x')
    const fd = openSync(file, 'r')
    const viaFd = statSync(file)
    // 正向控制：先证明「/proc/self/fd/N → 真实路径」这一跳在本机成立
    // （= fdRealPath 的候选顺序里第一条真的走过），再要求它照此返回。
    const viaProc = realpathSync(`/proc/self/fd/${fd}`)
    const resolved = fdRealPath(fd)
    closeSync(fd)
    assert.equal(viaProc, realpathSync(file), '/proc/self/fd/N 在本机必须解析成真实路径（前置事实变了）')
    assert.notEqual(
      resolved,
      null,
      '本机 /proc/self/fd 可用却解析不出真实路径——fdRealPath 的反查循环被删/坏了'
        + '（这正是 macOS shim 用例之外唯一的本机正向证明）',
    )
    const viaPath = statSync(resolved)
    assert.equal(viaPath.dev, viaFd.dev, 'fdRealPath 必须返回真实路径（dev 对不上）')
    assert.equal(viaPath.ino, viaFd.ino, 'fdRealPath 必须返回真实路径（ino 对不上）')
    assert.equal(resolved, realpathSync(file), '必须解析成真实路径，而不是 fd 入口自身')
    assert.ok(!resolved.startsWith('/dev/fd/'), '不得返回 /dev/fd 入口自身')
    assert.ok(!resolved.startsWith('/proc/self/fd/'), '不得返回 /proc/self/fd 入口自身')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实 macOS（本机就是 darwin 时）：现场行为必须仍然成立', (t) => {
  // 模拟器用的是"文档化的 macOS 行为"，但只有真机才能证明这个文档是对的。
  // 本机是 darwin 时额外钉一遍真实行为：`realpathSync('/dev/fd/N')` 若在某个
  // macOS 版本上开始正常解析，fdRealPath 会返回真实路径（也不该出错），
  // 本用例不会误报；真正要防的是"不解析且被当成真实路径返回"。
  if (process.platform !== 'darwin') return t.skip('非 darwin 平台（CI 用 shim 覆盖）')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-macos-real-'))
  try {
    const file = join(dir, 'x.txt')
    writeFileSync(file, 'x')
    const fd = openSync(file, 'r')
    const resolved = fdRealPath(fd)
    closeSync(fd)
    if (resolved !== null) {
      // 真机解析成功 → 必须指向同一个 inode（且不是 /dev/fd 入口自身）
      const viaFd = statSync(file)
      const viaPath = statSync(resolved)
      assert.equal(viaPath.ino, viaFd.ino)
      assert.ok(!resolved.startsWith('/dev/fd/'))
    }
    // 无论解析与否，写入闭环都必须成立
    const store = new MemoryStore(join(dir, 'store'))
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    store.add('memory', 'macOS 真机写入回归', agent)
    assert.match(readFileSync(join(dir, 'store', 'MEMORY.md'), 'utf8'), /macOS 真机写入回归/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('本机平台：正常取锁链路仍然成立（防修过头；withLock 自己 mkdir）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fdwrite-'))
  try {
    const lockDir = join(dir, 'memories')
    let ran = false
    withLock(lockDir, () => { ran = true }, dir)
    assert.equal(ran, true, '正常路径必须能取到锁并执行临界区')
    // 锁在临界区结束后被释放（不再残留）
    assert.equal(existsSync(join(lockDir, '.memory.lock')), false, '临界区结束后锁应已释放')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
