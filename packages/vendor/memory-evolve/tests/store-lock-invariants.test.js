/**
 * tests/store-lock-invariants.test.js — 跨进程锁域不变量（审计 P1-8 / P1-10）
 *
 * P1-8 `ArchiveStore` 三处写操作锁域不一致 → key 轨「归档」与「删除归档
 *      条目」用两把不同的锁（append/remove 锁项目目录、removeExact 锁
 *      记忆根），真双进程并发读-改-写互相覆盖，两个进程都返回 ok:true。
 * P1-10 `isStaleLock` 把 `process.kill` 的 EPERM 当「持有者已死」→ 抢占
 *      活锁（跨 uid / 容器 / NFS 共享同一记忆目录时互斥被打破）。
 *
 * 两条都用**真双进程**验证：子进程按目标锁域持锁，父进程发起操作，
 * 断言父进程确实在等同一把锁（而不是另一把"永远空闲"的锁）。
 *
 * 「改前失败」证据：把 `removeExact` 的 `withLock(this.archiveLockDir(...))`
 * 还原成 `withLock(this.dir)`、把 `isStaleLock` 的 catch 还原成裸 `return
 * true`，本文件 4 条里 3 条失败（前两条 P1-10 断言 + P1-8 的跨进程等待
 * 断言，见 FIX-memory.md 的改前输出）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ArchiveStore, isStaleLock, withLock } from '../lib/store.js'

const STORE_URL = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'store.js')).href
const FAKE_PID = 2147483646 // 不可能存在的 pid，仅用于填充锁文件

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-lock-invariant-'))
}

/**
 * 起一个子进程：用 withLock 持有 `dir` 的锁 `holdMs` 毫秒，持锁期间写
 * 一个 ready 标记文件（父进程据此确认「锁已被别人持有」再开始计时）。
 * @param {string} dir - 要持锁的目录。
 * @param {number} holdMs - 持锁时长。
 * @returns {{readyPath: string, child: import('node:child_process').ChildProcess, waitReady: () => Promise<void>}}
 */
function startLockHolder(dir, holdMs) {
  const readyPath = join(dir, '..', `holder-ready-${process.pid}-${Date.now()}`)
  const code = `
import { writeFileSync, rmSync } from 'node:fs'
import { withLock } from ${JSON.stringify(STORE_URL)}
withLock(${JSON.stringify(dir)}, () => {
  writeFileSync(${JSON.stringify(readyPath)}, 'held')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs})
  rmSync(${JSON.stringify(readyPath)}, { force: true })
})
`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const waitReady = async () => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (existsSync(readyPath)) return
      if (child.exitCode !== null) throw new Error(`lock holder exited early (code ${child.exitCode}): ${stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`lock holder never became ready: ${stderr}`)
  }
  return { readyPath, child, waitReady }
}

/** 等待子进程退出（清理用，绝不悬着）。 */
function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    child.once('exit', () => resolve())
  })
}

test('[P1-8] key 归档：removeExact 与 append/remove 是同一把锁（不丢更新）', async () => {
  const memoryDir = tempDir()
  const projectDir = join(memoryDir, 'projects', 'proj-p1-8')
  const archive = new ArchiveStore(memoryDir, { projectDirResolver: () => projectDir })
  const entry = '[2026-09-12] 待删除的归档条目'
  try {
    assert.equal(archive.append('key', entry, '/work/proj').ok, true)
    // 子进程按「项目目录」锁域持锁 800ms —— 这正是 append/remove 的锁域。
    const holder = startLockHolder(projectDir, 800)
    try {
      await holder.waitReady()
      const startedAt = Date.now()
      const outcome = archive.removeExact('key', entry, '/work/proj')
      const elapsed = Date.now() - startedAt
      assert.equal(outcome.ok, true)
      // 锁域一致 → removeExact 必须等持锁者释放（≥ 数百毫秒）。
      // 锁域不一致（旧实现锁 this.dir，恰好空闲）→ 立刻进临界区（< 50ms）。
      assert.ok(
        elapsed >= 500,
        `removeExact 必须等待项目目录锁：实际 ${elapsed}ms —— 立刻返回说明它与 append/remove 用的不是同一把锁（P1-8）`,
      )
      assert.equal(existsSync(holder.readyPath), false, '返回时子进程应已释放锁')
      assert.deepEqual(archive.entriesOf('key', '/work/proj'), [])
    } finally {
      holder.child.kill('SIGKILL')
      await waitExit(holder.child)
    }
  } finally {
    rmSync(memoryDir, { recursive: true, force: true })
  }
})

test('[P1-8] 非 key 轨锁域不变（dirname(fileOf) === 记忆根）', () => {
  const memoryDir = tempDir()
  try {
    const archive = new ArchiveStore(memoryDir)
    for (const target of ['memory', 'user', 'todo-archive']) {
      assert.equal(archive.archiveLockDir(target), memoryDir, `${target} 的锁域应仍是记忆根`)
    }
    // key 轨锁项目目录（与主轨 KeyStore 的 withLock(dirname(file)) 同域），
    // 不是记忆根——这正是旧实现 removeExact 写错的地方。
    const keyLockDir = archive.archiveLockDir('key', '/work/proj')
    assert.equal(keyLockDir, dirname(archive.fileOf('key', '/work/proj')))
    assert.notEqual(keyLockDir, memoryDir)
    assert.ok(keyLockDir.startsWith(join(memoryDir, 'projects') + sep))
  } finally {
    rmSync(memoryDir, { recursive: true, force: true })
  }
})

test('[P1-10] isStaleLock：只有 ESRCH 才算「持有者已死」', () => {
  const dir = tempDir()
  const lockPath = join(dir, '.memory.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: FAKE_PID, at: Date.now() }))
  const realKill = process.kill
  const fail = (code) => () => {
    const error = new Error(`kill failed: ${code}`)
    error.code = code
    throw error
  }
  try {
    // ESRCH = 进程确定不存在 → 残留锁可清（断电/被 kill 的恢复路径）。
    process.kill = fail('ESRCH')
    assert.equal(isStaleLock(lockPath), true)
    // EPERM = 探测方无权发信号（跨 uid / 容器 / NFS）——持有者可能活着，
    // 旧实现把这里当 stale，会 rmSync 抢走活锁。
    process.kill = fail('EPERM')
    assert.equal(isStaleLock(lockPath), false, 'EPERM 不可判定 → 必须保守认为锁有效（P1-10）')
    // 其它异常码同样不可判定 → 保守。
    process.kill = fail('ERR_OUT_OF_RANGE')
    assert.equal(isStaleLock(lockPath), false)
    // 探测成功 = 持有者活着 → 锁有效。
    process.kill = () => undefined
    assert.equal(isStaleLock(lockPath), false)
  } finally {
    process.kill = realKill
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[P1-10] withLock：EPERM 探测下不抢占活锁（等持有者释放后取得）', async () => {
  const dir = tempDir()
  const realKill = process.kill
  try {
    const holder = startLockHolder(dir, 800)
    try {
      await holder.waitReady()
      let enteredAt = 0
      const startedAt = Date.now()
      // 模拟跨 uid 探测：持有者进程活着，但探测方 kill(-0) 抛 EPERM。
      process.kill = () => {
        const error = new Error('kill EPERM')
        error.code = 'EPERM'
        throw error
      }
      withLock(dir, () => { enteredAt = Date.now() })
      const elapsed = enteredAt - startedAt
      assert.ok(
        elapsed >= 500,
        `EPERM 下必须等活锁释放：实际 ${elapsed}ms —— 立刻进入说明抢占了活锁（P1-10）`,
      )
    } finally {
      process.kill = realKill
      holder.child.kill('SIGKILL')
      await waitExit(holder.child)
    }
  } finally {
    process.kill = realKill
    rmSync(dir, { recursive: true, force: true })
  }
})
