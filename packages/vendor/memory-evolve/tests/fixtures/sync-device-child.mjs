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
 *   op            bootstrap | connect | sync | resolve | archive | store | lock
 *   dir           记忆仓库目录
 *   memoryDir     （bootstrap）记忆根目录
 *   cwd           （bootstrap）项目工作目录
 *   projectId/displayName/remoteUrl/remoteBranch/expectedProjectId
 *   push          （sync/bootstrap）是否显式推送
 *   write         { "<仓库相对路径>": "<文本>" } —— 操作前写工作树文件
 *   writeAbs      { "<绝对路径>": "<文本>" } —— 操作前写任意文件（造 victim）
 *   index/choice/fileset/localBranch  （resolve）
 *   archive       { target, action, content?, match? } + projectDir?（ArchiveStore）
 *   store         { target, action, content?, match? } + projectDir?（MemoryStore）
 *   lock          mode: 'store' | 'lock'（锁路径断言回归）
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
  } else if (payload.op === 'archive') {
    // 归档轨（ArchiveStore）设备操作（FIX-22 第四轮回归用）：
    // payload { dir, target, cwd, projectDir?, action: 'append'|'remove'|'removeExact'|'read',
    //           content?, match? }。异常也当**数据**回报（红/绿对照要看到抛错文案）。
    const store = await import(pathToFileURL(join(pkg, 'lib', 'store.js')).href)
    const archive = new store.ArchiveStore(
      payload.dir,
      payload.projectDir ? { projectDirResolver: () => payload.projectDir } : {},
    )
    const started = Date.now()
    try {
      if (payload.action === 'read') {
        const entries = archive.entriesOf(payload.target, payload.cwd)
        out.result = { ok: true, count: entries.length }
        out.extra.entries = entries
      } else if (payload.action === 'remove') {
        out.result = archive.remove(payload.target, payload.match, payload.cwd)
      } else if (payload.action === 'removeExact') {
        out.result = archive.removeExact(payload.target, payload.content, payload.cwd)
      } else {
        out.result = archive.append(payload.target, payload.content, payload.cwd)
      }
      out.ok = out.result.ok === true
    } catch (err) {
      out.extra.threw = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
      out.result = { ok: false, threw: out.extra.threw }
    }
    out.extra.elapsedMs = Date.now() - started
    out.extra.file = archive.fileOf(payload.target, payload.cwd)
    out.extra.fileKind = (() => {
      try {
        const st = lstatSync(out.extra.file)
        return st.isSymbolicLink() ? `symlink->${readlinkSync(out.extra.file)}` : 'file'
      } catch { return 'absent' }
    })()
    out.extra.repoText = (() => {
      try { return readFileSync(out.extra.file, 'utf8').slice(0, 400) } catch (e) { return `ERR ${e.code}` }
    })()
  } else if (payload.op === 'store') {
    // 记忆主轨（MemoryStore）读/写设备操作：读侧泄漏与写侧穿透的红/绿对照。
    // payload { dir, target, cwd, projectDir?, action: 'entries'|'chars'|'add'|'replace'|'remove', content? }
    const store = await import(pathToFileURL(join(pkg, 'lib', 'store.js')).href)
    const ms = new store.MemoryStore(payload.dir, payload.projectDir ? { projectDirResolver: () => payload.projectDir } : {})
    const agent = payload.cwd ? { session: { header: { cwd: payload.cwd } } } : undefined
    try {
      if (payload.action === 'entries') {
        out.extra.entries = ms.entriesOf(payload.target, agent)
        out.result = { ok: true, count: out.extra.entries.length }
      } else if (payload.action === 'chars') {
        out.result = { ok: true, chars: ms.charsOf(payload.target, agent) }
      } else if (payload.action === 'replace') {
        out.result = ms.replace(payload.target, payload.match, payload.content, agent)
      } else if (payload.action === 'remove') {
        out.result = ms.remove(payload.target, payload.match, agent)
      } else {
        out.result = ms.add(payload.target, payload.content, agent)
      }
      out.ok = out.result.ok === true
    } catch (err) {
      out.extra.threw = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
      out.result = { ok: false, threw: out.extra.threw }
    }
  } else if (payload.op === 'todo') {
    // 待办轨（TodoStore）读/写：读侧不跟随符号链接的红/绿对照。
    const todo = await import(pathToFileURL(join(pkg, 'lib', 'todo.js')).href)
    const ts = new todo.TodoStore(payload.dir, payload.projectDir ? () => payload.projectDir : null)
    try {
      if (payload.action === 'list') {
        out.extra.items = ts.itemsOf(payload.target, payload.cwd, payload.date).map((item) => item.raw ?? item)
        out.result = { ok: true, count: out.extra.items.length }
      } else {
        out.result = ts.addTodo(payload.target, payload.content, {}, payload.cwd)
      }
      out.ok = out.result.ok === true
    } catch (err) {
      out.extra.threw = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
      out.result = { ok: false, threw: out.extra.threw }
    }
  } else if (payload.op === 'lock') {
    // 锁路径断言设备操作（P2 假死回归）：真取锁（可选走 MemoryStore.add 生产路径），
    // 回报耗时与异常文案——"立即 fail-loud"与"空转 5s 超时"靠 elapsedMs 区分。
    // 取锁抛错也当**数据**回报（红/绿对照要看抛错文案本身）。
    const store = await import(pathToFileURL(join(pkg, 'lib', 'store.js')).href)
    const started = Date.now()
    const report = { ok: false, threw: null, value: null, result: null }
    try {
      if (payload.mode === 'store') {
        const ms = new store.MemoryStore(payload.dir)
        report.result = ms.add('memory', payload.content ?? '[2026-01-01] LOCK-PROBE')
        report.ok = report.result.ok === true
      } else {
        report.value = store.withLock(payload.dir, () => 'LOCKED')
        report.ok = true
      }
    } catch (err) {
      report.threw = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
    }
    out.extra.elapsedMs = Date.now() - started
    out.extra.threw = report.threw
    out.result = report.result ?? { ok: report.ok === true, message: report.threw ?? undefined, value: report.value }
    out.ok = report.ok === true
  } else {
    throw new Error(`未知 op: ${payload.op}`)
  }
} catch (err) {
  out.error = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
}
process.stdout.write(`${JSON.stringify(out)}\n`)
