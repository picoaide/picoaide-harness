/**
 * tests/fixtures/sync-device-child.mjs — **真进程**同步设备执行器（FIX-22 回归用）
 *
 * 一个设备一个进程：本脚本在自己的 Node 进程里 import 目标包（`payload.pkg`）
 * 的 lib/sync/repo.js + worker.js，跑一次 ensureMemoryRepo / deviceBConnect /
 * runSync / resolveConflict，把结果作为**单行 JSON** 打到 stdout。
 *
 * 为什么不用 in-process 调用：runSync 的缺陷出口（三路合并写回）只在"真两个
 * store 实例、各自真进程、真文件系统"下才有意义——同进程调用会让锁、写盘
 * 缓冲、谁先谁后都失去真实性。`pkg` 可指向本包，也可指向改前快照副本，同一
 * 份用例即可对"改前/改后"两份源码跑出对照输出。
 *
 * 用法：node sync-device-child.mjs '<JSON payload>'
 *
 * payload:
 *   pkg           目标包根目录（含 lib/）
 *   op            bootstrap | connect | sync | resolve
 *   dir           记忆仓库目录
 *   memoryDir     （bootstrap）记忆根目录
 *   cwd           （bootstrap）项目工作目录
 *   projectId/displayName/remoteUrl/remoteBranch/expectedProjectId
 *   push          （sync/bootstrap）是否显式推送
 *   write         { "<仓库相对路径>": "<文本>" } —— 操作前写工作树文件
 *   writeAbs      { "<绝对路径>": "<文本>" } —— 操作前写任意文件（造 victim）
 *   index/choice/fileset/localBranch  （resolve）
 */
import { mkdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const payload = JSON.parse(process.argv[2])
const pkg = payload.pkg
const repo = await import(pathToFileURL(join(pkg, 'lib', 'sync', 'repo.js')).href)
const worker = await import(pathToFileURL(join(pkg, 'lib', 'sync', 'worker.js')).href)
const { setLocale } = await import(pathToFileURL(join(pkg, 'lib', 'i18n.js')).href)
setLocale('zh')

const out = { op: payload.op, ok: false, result: null, extra: {}, error: null }
try {
  if (payload.writeAbs) {
    for (const [p, text] of Object.entries(payload.writeAbs)) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    }
  }
  if (payload.write && payload.dir) {
    for (const [rel, text] of Object.entries(payload.write)) {
      const p = join(payload.dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    }
  }
  if (payload.op === 'bootstrap') {
    const report = await repo.ensureMemoryRepo({
      dir: payload.dir, memoryDir: payload.memoryDir, cwd: payload.cwd,
      projectId: payload.projectId, displayName: payload.displayName,
      remoteUrl: payload.remoteUrl, remoteBranch: payload.remoteBranch,
    })
    out.extra.bootstrap = report
    out.ok = report.ok === true
    if (payload.push) {
      out.result = await worker.runSync({ dir: payload.dir, remoteBranch: payload.remoteBranch, push: true })
      out.ok = out.ok && out.result.ok === true
    }
  } else if (payload.op === 'connect') {
    out.result = await repo.deviceBConnect({
      dir: payload.dir, remoteUrl: payload.remoteUrl,
      remoteBranch: payload.remoteBranch, expectedProjectId: payload.expectedProjectId,
    })
    out.ok = out.result.ok === true
    // 接入后工作树里各路径的类型（证"共享分支的 120000 条目 checkout 成了真符号链接"）
    const probe = {}
    for (const name of ['logs']) {
      const p = join(payload.dir, name)
      let kind = 'absent'
      try {
        const st = lstatSync(p)
        kind = st.isSymbolicLink() ? 'symlink' : (st.isDirectory() ? 'dir' : 'file')
      } catch { /* absent */ }
      probe[name] = { kind, target: kind === 'symlink' ? readlinkSync(p) : null }
    }
    out.extra.worktree = probe
  } else if (payload.op === 'sync') {
    out.result = await worker.runSync({
      dir: payload.dir, remoteBranch: payload.remoteBranch,
      push: payload.push === true, fileset: payload.fileset, localBranch: payload.localBranch,
    })
    out.ok = out.result.ok === true
  } else if (payload.op === 'resolve') {
    out.result = await worker.resolveConflict({
      dir: payload.dir, index: payload.index, choice: payload.choice,
      fileset: payload.fileset, localBranch: payload.localBranch,
    })
    out.ok = out.result.ok === true
  } else {
    throw new Error(`未知 op: ${payload.op}`)
  }
} catch (err) {
  out.error = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
}
process.stdout.write(`${JSON.stringify(out)}\n`)
