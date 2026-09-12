/**
 * tests/write-target-symlink-toctou.test.js — FIX-26 第六轮（2026-09-13）：
 * `<目标>.tmp.<pid>` 落点未断言 与 `withLock` open→write 竞态的**真机回归**。
 *
 * 缺陷（第五轮对抗复核 P2，`temp/r5-verify-server/memory/FINDINGS.md` §4a/4b/4c）：
 *   4a 写回是 `tmp = <目标>.tmp.<pid>` + rename，断言只覆盖 `<目标>`，**从不覆盖
 *      临时路径**。攻击者按可见 pid 预置同名真 `ln -s` → `writeFileSync(tmp)`
 *      跟随链接写穿仓库外，rename 再把链接搬到目标文件名上（实测 `ok:true`）。
 *      同一写法在 MemoryStore.write / todo.js / sync/repo.js / ArchiveStore 四处。
 *   4b/4c `withLock` 在 `openSync(lockPath,'wx')` 之后用**按路径**的
 *      `writeFileSync(lockPath, …)`：攻击者把祖先目录在"真目录/指向仓库外的
 *      符号链接"之间翻转时，锁 JSON 落到仓库外（404,785 次 append 里 2,028 次）。
 *
 * 本文件的断言纪律（用户要求"真机测试"：真文件系统 + 真符号链接 + 真多进程）：
 *   - 每个写操作是**独立 Node 子进程**（tests/fixtures/memory-write-child.mjs），
 *     攻击者用子进程**真实 pid** 预置真符号链接（父子两进程握手：ready/go）；
 *   - 竞态测试里的攻击者是**真独立进程**，反复翻转祖先目录；
 *   - 判据 = 仓库外文件的实际字节 + 目标文件形态 + 仓库外目录内容。
 *
 * 「改前失败」证据（同一份用例对改前快照副本跑）：
 *   cp -a packages/vendor/memory-evolve /tmp/me-prefix-r6
 *   # 用 git show HEAD:… 回滚 5 个 lib 文件，再拷本文件与 fixtures
 *   cd /tmp/me-prefix-r6 && node --test tests/write-target-symlink-toctou.test.js
 *   → 4a 三族全部失败（`ok:true` + victim 被写穿 + 目标变成指向仓库外的链接），
 *     4c 失败（仓库外目录出现 .memory.lock）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'memory-write-child.mjs')
/** 记忆 Tab 数据路由的执行器（同一个设备 fixture 的 memory-tab op）。 */
const TAB_CHILD = join(HERE, 'fixtures', 'sync-device-child.mjs')
/** 仓库外 victim 的正文（必须**逐字节不变**）。 */
const VICTIM_TEXT = 'VICTIM-MUST-NOT-CHANGE-R6\n'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}
const skipGit = !gitAvailable()

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'init.defaultBranch',
  GIT_CONFIG_VALUE_0: 'main',
  GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.com',
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-tmp-target-'))
}

/** 起一个真子进程做一次写/锁动作（可选 ready/go 握手），返回 { child, done }。 */
function spawnChild(payload) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ pkg: PKG, ...payload })], {
    stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const done = new Promise((resolve) => child.on('close', (code) => {
    const line = stdout.trim().split('\n').filter((l) => l.trim() !== '').pop()
    resolve(line ? { ...JSON.parse(line), code } : { code, error: `NO-OUTPUT ${stderr.slice(0, 300)}` })
  }))
  return { child, done }
}

async function waitFor(p, what) {
  for (let i = 0; i < 400; i += 1) {
    if (existsSync(p)) return
    await sleep(5)
  }
  throw new Error(`等待 ${what} 超时：${p}`)
}

/** 三族落点的 fixture（store/archive/todo 各一个目标文件 + 一个仓库外 victim）。 */
function writeFixture(root, mode, target) {
  const memoryDir = join(root, `${mode}-memory`)
  const projectDir = join(memoryDir, 'projects', 'probeProj01')
  const outside = join(root, `${mode}-OUTSIDE`)
  const cwd = join(root, `${mode}-proj`)
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const victim = join(outside, 'victim.txt')
  writeFileSync(victim, VICTIM_TEXT)
  const targetFile = mode === 'todo' ? join(memoryDir, 'TODOS-work.md') : join(projectDir, target)
  const base = mode === 'todo' ? '<!-- todos -->\n' : '[2026-01-01] BASE-ROW\n'
  writeFileSync(targetFile, base)
  return { memoryDir, projectDir, outside, cwd, victim, targetFile, base }
}

/* ------------------------------------------------------------------ */
/* 1. 4a：预置 `<目标>.tmp.<真 pid>` 真符号链接 → 拒收、零写穿             */
/* ------------------------------------------------------------------ */

test('[FIX-26-R6] 4a 临时落点：预置同名真符号链接 → 三族全部拒收且零写穿', async () => {
  const root = tempRoot()
  try {
    const cases = [
      { mode: 'store', target: 'key', expectRefusal: /(符号链接|symlink)/i },
      { mode: 'archive', target: 'key', expectRefusal: /符号链接/ },
      { mode: 'todo', target: 'work', expectRefusal: /(符号链接|symlink)/i },
    ]
    for (const c of cases) {
      const fx = writeFixture(root, c.mode, c.target === 'key' ? 'KEY.md' : 'KEY.md')
      if (c.mode === 'archive') writeFileSync(join(fx.projectDir, 'KEY-archive.md'), '[2026-01-01] ARCH-BASE\n')
      const flag = join(root, `${c.mode}-flag`)
      const { child, done } = spawnChild({
        op: 'write', mode: c.mode, target: c.target, dir: fx.memoryDir, projectDir: fx.projectDir,
        cwd: fx.cwd, flag, content: c.mode === 'todo' ? 'TOCTOU-TMP-PAYLOAD' : '[2026-01-02] TOCTOU-TMP-PAYLOAD',
      })
      await waitFor(`${flag}.ready`, `${c.mode} 子进程就绪`)
      const pid = child.pid
      const targetPath = c.mode === 'archive' ? join(fx.projectDir, 'KEY-archive.md') : fx.targetFile
      const tmpPath = `${targetPath}.tmp.${pid}`
      // 攻击者（父进程）：按**子进程真实 pid** 预置同名真符号链接
      symlinkSync(fx.victim, tmpPath)
      const beforeText = readFileSync(targetPath, 'utf8')
      writeFileSync(`${flag}.go`, 'go')
      const out = await done

      assert.equal(out.ok, false, `[${c.mode}] 预置同名临时符号链接必须被拒收（红时 ok:true），实际：${JSON.stringify(out)}`)
      const text = `${out.error ?? ''} ${out.result?.message ?? ''}`
      assert.match(text, c.expectRefusal, `[${c.mode}] 拒绝文案必须点名符号链接/symlink：${text}`)
      // 仓库外 victim 逐字节未变
      assert.equal(readFileSync(fx.victim, 'utf8'), VICTIM_TEXT, `[${c.mode}] 仓库外 victim 绝不能被写穿`)
      // 目标文件形态与内容未变（红时：被替换成指向仓库外的符号链接）
      assert.equal(lstatSync(targetPath).isSymbolicLink(), false, `[${c.mode}] 目标文件不得被换成符号链接`)
      assert.equal(readFileSync(targetPath, 'utf8'), beforeText, `[${c.mode}] 目标文件内容不得改变`)
      // 仓库内那条符号链接保持原样（不得擅自删改仓库内链接）
      assert.equal(lstatSync(tmpPath).isSymbolicLink(), true, `[${c.mode}] 预置的符号链接必须完好（不删改仓库内链接）`)
      assert.equal(readlinkSync(tmpPath), fx.victim)
      // 仓库外目录只有 victim 一个文件
      assert.deepEqual(readdirSync(fx.outside), ['victim.txt'], `[${c.mode}] 仓库外目录出现残留：${readdirSync(fx.outside).join(',')}`)

      // 对照：同样的写入、不预置临时链接 → 正常成功（没被修死）
      const flag2 = join(root, `${c.mode}-flag2`)
      const { done: done2 } = spawnChild({
        op: 'write', mode: c.mode, target: c.target, dir: fx.memoryDir, projectDir: fx.projectDir,
        cwd: fx.cwd, flag: flag2, content: c.mode === 'todo' ? 'NORMAL-PAYLOAD' : '[2026-01-03] NORMAL-PAYLOAD',
      })
      await waitFor(`${flag2}.ready`, `${c.mode} 对照子进程就绪`)
      writeFileSync(`${flag2}.go`, 'go')
      const out2 = await done2
      assert.equal(out2.ok, true, `[${c.mode}] 去掉预置链接后写入必须恢复正常：${JSON.stringify(out2)}`)
      assert.match(readFileSync(targetPath, 'utf8'), /NORMAL-PAYLOAD/, `[${c.mode}] 正常写入必须落地`)
      assert.equal(readFileSync(fx.victim, 'utf8'), VICTIM_TEXT)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 2. 4a 同族第四处：sync/repo.js entryId 补发的临时落点                   */
/* ------------------------------------------------------------------ */

test('[FIX-26-R6] 4a repo.js 补发：预置 `<KEY.md>.tmp.<本进程 pid>` 真符号链接 → 零写穿', { skip: skipGit }, async () => {
  const root = tempRoot()
  try {
    const { ensureMemoryRepo } = await import('../lib/sync/repo.js')
    const memoryDir = join(root, 'memory')
    const projectDir = join(memoryDir, 'projects', 'entryidProbe1')
    const outside = join(root, 'OUTSIDE')
    const cwd = join(root, 'proj')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, VICTIM_TEXT)
    // 无身份证的老记忆条目 → 补发会重写该文件（临时落点 = <KEY.md>.tmp.<本进程 pid>）
    writeFileSync(join(projectDir, 'KEY.md'), '[2026-01-01] OLD-ROW-NO-ID\n')

    const common = { dir: projectDir, memoryDir, cwd, projectId: 'entryidProbe1', displayName: 'probe' }

    // 对照（先跑无链接的一次）：补发确实会重写文件
    const control = await ensureMemoryRepo({ ...common })
    assert.equal(control.ok, true, `对照：ensureMemoryRepo 必须成功：${JSON.stringify(control)}`)
    assert.ok(control.backfilled >= 1, `对照：必须真的补发了身份证：${JSON.stringify(control)}`)
    assert.match(readFileSync(join(projectDir, 'KEY.md'), 'utf8'), /\[id:[0-9a-f]{8}\]/, '对照：补发必须落地')

    // 攻击者：按**本进程 pid** 预置同名临时符号链接（repo.js 用 process.pid 命名）
    writeFileSync(join(projectDir, 'KEY.md'), '[2026-01-02] OLD-ROW-NO-ID-AGAIN\n')
    const tmpLink = join(projectDir, `KEY.md.tmp.${process.pid}`)
    symlinkSync(victim, tmpLink)
    const report = await ensureMemoryRepo({ ...common })
    assert.equal(report.ok, true, `被拒的补发不应让整次 ensure 失败：${JSON.stringify(report)}`)
    assert.ok(report.skippedBackfill >= 1, `被拒的补发必须计入 skipped：${JSON.stringify(report)}`)
    assert.equal(readFileSync(victim, 'utf8'), VICTIM_TEXT, '仓库外 victim 绝不能被补发写穿')
    assert.equal(lstatSync(tmpLink).isSymbolicLink(), true, '预置的符号链接必须完好')
    assert.deepEqual(readdirSync(outside), ['victim.txt'], `仓库外目录出现残留：${readdirSync(outside).join(',')}`)
    assert.doesNotMatch(readFileSync(join(projectDir, 'KEY.md'), 'utf8'), /\[id:/, '被拒的补发不得落地')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 3. 4c：withLock 竞态 —— 逃逸路径消失 + 正常并发锁语义不变                 */
/* ------------------------------------------------------------------ */

test('[FIX-26-R6] 4c 锁竞态：真攻击者进程翻转祖先目录 → 仓库外零残留、零逃逸', async () => {
  const root = tempRoot()
  try {
    const { ArchiveStore } = await import('../lib/store.js')
    const memoryDir = join(root, 'memory')
    const projectDir = join(memoryDir, 'projects', 'raceProbe001')
    const outside = join(root, 'OUTSIDE')
    const cwd = join(root, 'proj')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(projectDir, 'KEY-archive.md'), '[2026-01-01] ARCH-BASE\n')
    const arc = new ArchiveStore(memoryDir, { projectDirResolver: () => projectDir })

    // 真攻击者进程：把 projects/<hash> 在真目录与指向仓库外的符号链接之间翻转
    const { child: attacker, done: attackerDone } = spawnChild({
      op: 'flip', dir: projectDir, parked: `${projectDir}.parked`, outside, durationMs: 3000,
    })
    let ok = 0
    let refused = 0
    let threw = 0
    const deadline = Date.now() + 2600
    let i = 0
    while (Date.now() < deadline) {
      try {
        const r = arc.append('key', `[2026-01-02] RACE-${i}`, cwd)
        if (r.ok === true) ok += 1
        else refused += 1
      } catch {
        threw += 1
      }
      i += 1
    }
    const atk = await attackerDone
    assert.equal(atk.code, 0, `攻击者进程必须正常退出：${JSON.stringify(atk)}`)

    assert.ok(i > 200, `竞态窗口内必须真的跑了足够多次 append（实际 ${i}）`)
    // 判据 1：逃逸路径消失——仓库外目录里不得出现锁文件 / 归档正文 / 临时文件
    assert.deepEqual(readdirSync(outside), [], `锁或归档正文被写到仓库外：${readdirSync(outside).join(',')}`)
    assert.equal(existsSync(join(outside, '.memory.lock')), false, '锁 JSON 绝不能被写到仓库外')
    assert.ok(ok + refused + threw === i, '每次 append 都必须有确定结果')

    // 判据 2：攻击者停手后，正常 append 必须恢复（未被修死）+ 语义正常
    const settled = arc.append('key', '[2026-01-03] AFTER-RACE', cwd)
    assert.equal(settled.ok, true, `停手后归档必须恢复：${JSON.stringify(settled)}`)
    assert.match(readFileSync(join(projectDir, 'KEY-archive.md'), 'utf8'), /AFTER-RACE/)
    assert.equal(existsSync(join(projectDir, '.memory.lock')), false, '正常路径释放锁后不留锁文件')
    assert.deepEqual(readdirSync(outside), [], `仓库外目录必须始终为空：${readdirSync(outside).join(',')}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('[FIX-26-R6] 锁语义：真两进程互斥 + 多进程并写不丢更新', async () => {
  const root = tempRoot()
  try {
    const memoryDir = join(root, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-01-01] BASE\n')

    // (a) 两进程各持锁 300ms → 串行（墙钟 ≥ 550ms），都成功
    const started = Date.now()
    const [a, b] = await Promise.all([
      spawnChild({ op: 'lock-hold', dir: memoryDir, holdMs: 300 }).done,
      spawnChild({ op: 'lock-hold', dir: memoryDir, holdMs: 300 }).done,
    ])
    const wall = Date.now() - started
    assert.equal(a.ok, true, `第一个持锁进程必须成功：${JSON.stringify(a)}`)
    assert.equal(b.ok, true, `第二个持锁进程必须成功：${JSON.stringify(b)}`)
    assert.ok(wall >= 550, `两进程必须真互斥（墙钟 ${wall}ms 应 ≥ 550ms）`)
    assert.equal(existsSync(join(memoryDir, '.memory.lock')), false, '无残留锁')

    // (b) 3 进程 × 3 条 add → 全部成功且 9 条全部落地（无丢更新）
    const writers = []
    for (let w = 0; w < 3; w += 1) {
      for (let n = 0; n < 3; n += 1) {
        writers.push(spawnChild({
          op: 'write', mode: 'store', target: 'memory', dir: memoryDir,
          content: `[2026-01-0${n + 2}] W${w}-N${n}`,
        }).done)
      }
    }
    const results = await Promise.all(writers)
    assert.equal(results.filter((r) => r.ok === true).length, 9, `9 次写必须全部成功：${JSON.stringify(results.filter((r) => r.ok !== true))}`)
    const text = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    for (let w = 0; w < 3; w += 1) {
      for (let n = 0; n < 3; n += 1) assert.match(text, new RegExp(`W${w}-N${n}`), `W${w}-N${n} 丢更新`)
    }
    assert.equal(existsSync(join(memoryDir, '.memory.lock')), false, '无残留锁')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 4. 合法布局对照：memoryDir 本身是符号链接 → 写/读不得被误杀（probe3 形态） */
/* ------------------------------------------------------------------ */

test('[FIX-26-R6] 合法布局：memoryDir 本身是符号链接 → 写/读/路由照常工作', async () => {
  const root = tempRoot()
  try {
    // 常见部署形态：记忆目录本身是软链（用户把记忆放到别的盘），根自身不是
    // 攻击面（断言只看 root **之下** 的组件）——写侧落点是 realpath 基准的，
    // 读侧落点是未解析路径，两种口径混用会在这里误杀。
    const realParent = join(root, 'real-parent')
    const memoryDir = join(root, 'memory')
    const cwd = join(root, 'proj')
    mkdirSync(join(realParent, 'memory'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    symlinkSync(join(realParent, 'memory'), memoryDir)
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-01-01] BASE-MEM\n')

    // ① MemoryStore.add（主轨写）
    const storeWrite = await spawnChild({
      op: 'write', mode: 'store', target: 'memory', dir: memoryDir, content: '[2026-01-02] VIA-SYMLINK-ROOT',
    }).done
    assert.equal(storeWrite.ok, true, `memoryDir 是软链时主轨写必须正常：${JSON.stringify(storeWrite)}`)
    assert.match(readFileSync(join(realParent, 'memory', 'MEMORY.md'), 'utf8'), /VIA-SYMLINK-ROOT/, '内容必须落在真实目录')

    // ② ArchiveStore.append（归档写；临时落点同一条路径）
    writeFileSync(join(memoryDir, 'MEMORY-archive.md'), '[2026-01-01] ARCH-BASE\n')
    const archWrite = await spawnChild({
      op: 'write', mode: 'archive', target: 'memory', dir: memoryDir, content: '[2026-01-03] ARCH-VIA-SYMLINK-ROOT',
    }).done
    assert.equal(archWrite.ok, true, `memoryDir 是软链时归档写必须正常：${JSON.stringify(archWrite)}`)
    assert.match(readFileSync(join(realParent, 'memory', 'MEMORY-archive.md'), 'utf8'), /ARCH-VIA-SYMLINK-ROOT/)

    // ③ 记忆 Tab 路由（读侧）
    const { spawnSync: spawnSyncLocal } = await import('node:child_process')
    const r = spawnSyncLocal(process.execPath, [TAB_CHILD, JSON.stringify({
      pkg: PKG, op: 'memory-tab', dir: memoryDir, cwd, sessionId: 's1',
    })], { encoding: 'utf8', timeout: 60000, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    const line = String(r.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '').pop()
    const parsed = line ? JSON.parse(line) : null
    assert.ok(parsed?.extra, `memory-tab 子进程未产出结果：stdout=${String(r.stdout).slice(0, 300)} stderr=${String(r.stderr).slice(0, 300)}`)
    const extra = parsed.extra
    assert.equal(extra.status, 200, `memoryDir 是软链时路由必须 200：${extra.status} ${String(extra.raw).slice(0, 200)}`)
    assert.match(String((extra.files ?? []).find((f) => f.key === 'memory')?.content ?? ''), /VIA-SYMLINK-ROOT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
