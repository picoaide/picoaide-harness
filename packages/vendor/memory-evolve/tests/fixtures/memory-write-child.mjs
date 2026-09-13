/**
 * tests/fixtures/memory-write-child.mjs — **真进程**写/锁执行器（FIX-26 回归用）
 *
 * 一个动作一个进程：本脚本在自己的 Node 进程里 import 目标包（`payload.pkg`）
 * 的 lib/store.js / lib/todo.js，做一次真实写操作、真取锁，或扮演"翻转祖先
 * 目录"的攻击者。把结果作为**单行 JSON** 打到 stdout。
 *
 * 为什么不用 in-process 调用：`<目标>.tmp.<pid>` 这一族的缺陷要靠"攻击者按
 * **受害者进程的真实 pid** 预置同名符号链接"才能复现（pid 来自 spawn 的
 * `child.pid`），锁的 check→use 窗口也只有真两个进程同 uid 并发才有意义。
 *
 * 用法：node memory-write-child.mjs '<JSON payload>'
 *
 * payload:
 *   pkg        目标包根目录（含 lib/）——可指向本包，也可指向改前快照副本
 *   op         write | lock-hold | flip
 *   dir        记忆根目录（写操作）/ 取锁目录（lock-hold）/ 被翻转目录（flip）
 *   projectDir 项目记忆目录（key 归档 / key 主轨 / 项目待办用）
 *   cwd        会话工作目录（key 轨需要）
 *   mode       write 的落点族：store | archive | todo
 *   target     store: key/memory/user；archive: key/memory/user；todo: work/life/daily/project
 *   content    写入内容
 *   flag       给了就做文件握手：先写 `<flag>.ready`，等 `<flag>.go` 出现再动手
 *   holdMs     lock-hold 的持锁自旋毫秒
 *   parked/outside/durationMs  flip 的挪走目录 / 仓库外目标目录 / 翻转时长
 */
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const p = JSON.parse(process.argv[2])
const store = await import(pathToFileURL(join(p.pkg, 'lib', 'store.js')).href)
const { setLocale } = await import(pathToFileURL(join(p.pkg, 'lib', 'i18n.js')).href)
setLocale('zh')

const out = { pid: process.pid, op: p.op, ok: false, result: null, error: null, elapsedMs: 0, file: null, flips: null }

if (p.op === 'flip') {
  // 攻击者：把 dir 在「真目录」与「指向 outside 的真符号链接」之间反复翻转，
  // 拉宽受害者 check→use 的窗口（与 temp/r5-verify-server 的 4c 等价，真进程）。
  const { renameSync, symlinkSync, unlinkSync, rmSync, mkdirSync } = await import('node:fs')
  let n = 0
  const until = Date.now() + (p.durationMs ?? 3000)
  while (Date.now() < until) {
    try {
      rmSync(p.dir, { recursive: true, force: true })
      rmSync(p.parked, { recursive: true, force: true })
      mkdirSync(p.dir, { recursive: true })
      renameSync(p.dir, p.parked) // 真目录挪走（此刻起路径不存在）
      symlinkSync(p.outside, p.dir) // 同路径放真符号链接
      const t0 = process.hrtime.bigint()
      while (Number(process.hrtime.bigint() - t0) < 200000) { /* ~200us 停留 */ }
      unlinkSync(p.dir)
      renameSync(p.parked, p.dir) // 复原
      n += 1
    } catch {
      try { rmSync(p.parked, { recursive: true, force: true }) } catch { /* 竞态中忽略 */ }
    }
  }
  out.ok = true
  out.flips = n
  process.stdout.write(`${JSON.stringify(out)}\n`)
} else {
  if (p.flag) {
    writeFileSync(`${p.flag}.ready`, String(process.pid))
    while (!existsSync(`${p.flag}.go`)) await sleep(5)
  }
  const agent = p.cwd ? { session: { header: { cwd: p.cwd } } } : undefined
  const started = Date.now()
  try {
    if (p.op === 'lock-hold') {
      out.result = {
        value: store.withLock(p.dir, () => {
          const until = Date.now() + (p.holdMs ?? 0)
          while (Date.now() < until) { /* 真占锁自旋 */ }
          return `HELD-BY-${process.pid}`
        }),
      }
      out.ok = true
    } else if (p.mode === 'archive') {
      const arc = new store.ArchiveStore(p.dir, p.projectDir ? { projectDirResolver: () => p.projectDir } : {})
      out.result = arc.append(p.target ?? 'key', p.content, p.cwd)
      out.file = arc.fileOf(p.target ?? 'key', p.cwd)
      out.ok = out.result.ok === true
    } else if (p.mode === 'todo') {
      const todo = await import(pathToFileURL(join(p.pkg, 'lib', 'todo.js')).href)
      const ts = new todo.TodoStore(p.dir, p.projectDir ? () => p.projectDir : null)
      out.result = ts.addTodo(p.target ?? 'work', p.content, {}, p.cwd)
      out.file = ts.fileOf(p.target ?? 'work', p.cwd)
      out.ok = out.result.ok === true
    } else {
      const ms = new store.MemoryStore(p.dir, p.projectDir ? { projectDirResolver: () => p.projectDir } : {})
      out.result = ms.add(p.target ?? 'key', p.content, agent)
      out.file = ms.pathOf(p.target ?? 'key', agent)
      out.ok = out.result.ok === true
    }
  } catch (err) {
    out.error = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
  }
  out.elapsedMs = Date.now() - started
  process.stdout.write(`${JSON.stringify(out)}\n`)
}
