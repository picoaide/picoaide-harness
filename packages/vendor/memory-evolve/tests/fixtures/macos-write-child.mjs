/** 在"macOS 形态"的 node:fs shim 下跑记忆写入（回归 2026-09-16 客户现场）。
 *
 * 用 `--import ./register-macos.mjs` 启动，再把 `node:fs` 换成 macOS 形态
 * （见 fs-macos-hook.mjs）。断言三件事：
 *   1. `fdRealPath(fd)` 必须返回 **null**（不能把 `/dev/fd/N` 当真实路径）；
 *   2. `openExclusiveSafe(root, lockPath, 'lock')` 必须成功（现场是 unsafe）；
 *   3. 真实走一遍 `withLock` + MemoryStore.add，写入必须落盘、且**不留残留锁**。
 * 退出码 0 = 通过；stdout 是 JSON 结果，失败信息在 stderr。 */
// shim 从 globalThis.__realFs 取真实实现。**顺序很重要**：静态 import 会被提升到
// 模块体之前执行，所以真实 fs 必须由 `--import ./register-macos.mjs` 那个
// bootstrap 先装好（见 register-macos.mjs），不能写在这里。
import { mkdtempSync, mkdirSync, openSync, closeSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fdRealPath, openExclusiveSafe } from '../../lib/sync/filesets.js'
import { MemoryStore, withLock } from '../../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-macos-shim-'))
const out = { platform: process.platform }
try {
  // 1) fd 反查不得返回 /dev/fd/N
  const probe = join(dir, 'probe.txt')
  writeFileSync(probe, 'x')
  const fd = openSync(probe, 'r')
  out.fdRealPath = fdRealPath(fd)
  closeSync(fd)
  out.fdRealPathIsNull = out.fdRealPath === null
  out.fdRealPathReturnedDevFd = typeof out.fdRealPath === 'string' && out.fdRealPath.startsWith('/dev/fd/')

  // 2) 锁落点 O_EXCL 打开必须成功（现场在这里被判 unsafe）
  const lockDir = join(dir, 'memories')
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, '.memory.lock')
  const opened = openExclusiveSafe(lockDir, lockPath, 'lock')
  out.lockOpen = opened.ok === true ? 'ok' : opened.reason
  if (opened.ok === true) {
    closeSync(opened.fd)
    rmSync(lockPath, { force: true })
  }

  // 3) 真实写入闭环 + 不留残留锁
  const store = new MemoryStore(join(dir, 'store'))
  const agent = { id: 'a', session: { header: { cwd: dir } } }
  const written = store.add('memory', 'macOS shim 写入回归', agent)
  out.writeOk = written === true || written === undefined || written !== false
  out.memoryFile = existsSync(join(dir, 'store', 'MEMORY.md'))
  out.memoryContent = out.memoryFile ? readFileSync(join(dir, 'store', 'MEMORY.md'), 'utf8') : ''
  // 残留锁 = 现场症状之一
  out.leftoverLocks = []
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === '.memory.lock') out.leftoverLocks.push(p)
    }
  }
  walk(dir)

  // 4) withLock 直连也必须能取到锁
  let locked = false
  withLock(join(dir, 'lockprobe'), () => { locked = true }, dir)
  out.withLock = locked

  process.stdout.write(JSON.stringify(out))
  rmSync(dir, { recursive: true, force: true })
} catch (error) {
  process.stderr.write(`child failed: ${error?.stack ?? String(error)}\n`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
