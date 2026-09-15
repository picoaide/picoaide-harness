/**
 * 2026-09-15 全量审计：BrowserStore 的**落盘安全**回归。
 *
 * 覆盖两条审计结论：
 *
 * - **P1 读失败被当成"首次运行"**（原 `readCollection` 的 `catch { return }` +
 *   `load()` 的单向 `loaded` 守卫）：EACCES/EIO/EDQUOT/杀软锁文件与 ENOENT 被混为
 *   一谈，随后 `addHistory`/`addBookmark` 会 appendFileSync 新建小文件、`prune*`
 *   还会整文件重写 ⇒ 一次瞬时 I/O 错误后整批历史/书签静默消失。
 *   现在：只有 ENOENT 当空集合；其它错误 → 该集合只读降级（拒绝 append/rewrite）
 *   + 告警 + `loaded = false`（`load()` 即重试入口，恢复后补落盘）。
 * - **P2 非原子写 + 坏文件静默丢弃**：`writeFileSync` 直写目标（先截断后写）、
 *   `JSON.parse` 失败静默返回 undefined。现在：`.tmp` + `renameSync` 原子替换；
 *   坏账本改名备份 `*.corrupt-<ts>` 并告警；JSONL 的坏行不再静默丢弃。
 *
 * 读失败的模拟方式：`vi.mock('node:fs')` 只让**指定后缀**的 `readFileSync` 抛
 * EACCES（真实 fs 上跑测试的用户是 root，`chmod 000` 拦不住 root，所以用可注入的
 * 错误而不是权限位）。写入路径仍然是真实 fs —— 这正是要证明的：
 * "读不到"时**能不能**把磁盘上的旧数据写坏。另有一条不依赖 mock 的 EISDIR 用例
 * （把 `history.jsonl` 做成目录）覆盖真实 errno 路径。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserStore } from '../src/store.ts'

interface IoState {
  /** 这些后缀的路径在 readFileSync 时抛 EACCES。 */
  failReadSuffixes: string[]
  /** 这些后缀的 renameSync 目标抛 EPERM（模拟杀软/句柄占用）。 */
  failRenameSuffixes: string[]
  /** fs 调用轨迹（断言原子写顺序用）。 */
  calls: string[]
  /** 真实实现，供测试自己读盘断言（绕开 mock 的失败开关）。 */
  realReadFileSync: ((path: string, encoding: string) => string) | undefined
}

const io = vi.hoisted((): IoState => ({
  failReadSuffixes: [],
  failRenameSuffixes: [],
  calls: [],
  realReadFileSync: undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  io.realReadFileSync = actual.readFileSync as unknown as (path: string, encoding: string) => string
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && io.failReadSuffixes.some((suffix) => path.endsWith(suffix))) {
        const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return (actual.readFileSync as unknown as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.readFileSync,
    writeFileSync: ((path: unknown, data: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string') io.calls.push(`write:${path}`)
      return (actual.writeFileSync as unknown as (...args: unknown[]) => unknown)(path, data, ...rest)
    }) as typeof actual.writeFileSync,
    renameSync: ((from: unknown, to: unknown) => {
      if (typeof from === 'string' && typeof to === 'string') io.calls.push(`rename:${from}->${to}`)
      if (typeof to === 'string' && io.failRenameSuffixes.some((suffix) => to.endsWith(suffix))) {
        const error = new Error(`EPERM: operation not permitted, rename '${to}'`) as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return (actual.renameSync as unknown as (a: unknown, b: unknown) => void)(from, to)
    }) as typeof actual.renameSync,
  }
})

/** 真实读盘（不受 failReadSuffixes 影响）。 */
function readReal(path: string): string {
  return io.realReadFileSync!(path, 'utf8')
}

/** 每个用例一个独立目录（`.rt-store-*` 前缀已被 tests/.gitignore 忽略）。 */
function freshDir(): string {
  return mkdtempSync(join(process.cwd(), 'tests/.rt-store-io-'))
}

interface HistoryRecord {
  seq: number
  time: number
  url: string
  title: string
  actor: 'ai' | 'user' | 'restore'
  group: string
}

function historyLine(seq: number, title: string): string {
  // time 必须落在 90 天保留窗口内：epoch 附近的时间戳会被 pruneHistory 当场裁掉。
  const record: HistoryRecord = { seq, time: Date.now() - (100 - seq), url: `https://disk.example/${seq}`, title, actor: 'ai', group: '' }
  return JSON.stringify(record)
}

const dirs: string[] = []

function makeDir(): string {
  const dir = freshDir()
  dirs.push(dir)
  return dir
}

afterEach(() => {
  io.failReadSuffixes.length = 0
  io.failRenameSuffixes.length = 0
  io.calls.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- P1：读失败

describe('2026-09-15 审计 P1：读失败不再被当成"首次运行"', () => {
  it('非 ENOENT 读失败 → 只读降级 + 告警，append/rewrite 都拒绝（磁盘一个字节不动）', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    const disk = `${historyLine(1, 'disk-1')}\n${historyLine(2, 'disk-2')}\n`
    writeFileSync(historyPath, disk)

    io.failReadSuffixes.push('history.jsonl')
    const warnings: string[] = []
    // historyLimit=1：第二次 addHistory 会触发 prune → rewrite（修复前会整文件重写）
    const store = new BrowserStore({ dir, historyLimit: 1, warn: (message) => warnings.push(message) })

    // 行为优先断言：读不到磁盘内容（内存里没有旧记录），但写入必须被拒绝
    expect(warnings.some((message) => message.includes('history'))).toBe(true)
    expect(store.counts().history).toBe(0)
    store.addHistory({ time: Date.now() - 9, url: 'https://new.example/a', title: 'new-a', actor: 'ai', group: '' })
    store.addHistory({ time: Date.now() - 10, url: 'https://new.example/b', title: 'new-b', actor: 'ai', group: '' })
    expect(readReal(historyPath)).toBe(disk)
    expect(store.degradedCollections()).toContain('history')

    // download/bookmark 同理：append 与 rewrite 都不能碰磁盘
    writeFileSync(join(dir, 'bookmarks.jsonl'), `${JSON.stringify({ id: 1, url: 'https://disk.example/b', title: 'disk-b', createdAt: 1, actor: 'ai', group: '' })}\n`)
    const bookmarksDisk = readReal(join(dir, 'bookmarks.jsonl'))
    io.failReadSuffixes.push('bookmarks.jsonl')
    const store2 = new BrowserStore({ dir, bookmarkLimit: 1, warn: () => {} })
    store2.addBookmark({ url: 'https://new.example/b1', title: 'b1', actor: 'ai', group: '' })
    store2.addBookmark({ url: 'https://new.example/b2', title: 'b2', actor: 'ai', group: '' })
    expect(readReal(join(dir, 'bookmarks.jsonl'))).toBe(bookmarksDisk)
  })

  it('I/O 恢复后 load() 是重试入口：磁盘旧记录 + 降级期新记录都在（且 seq 不撞号）', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    const disk = `${historyLine(1, 'disk-1')}\n${historyLine(2, 'disk-2')}\n`
    writeFileSync(historyPath, disk)

    io.failReadSuffixes.push('history.jsonl')
    const store = new BrowserStore({ dir, warn: () => {} })
    const added = store.addHistory({ time: Date.now() - 9, url: 'https://new.example/a', title: 'new-a', actor: 'ai', group: '' })
    expect(added.seq).toBe(1) // 内存里没有磁盘内容，计数器从 0 起

    io.failReadSuffixes.length = 0
    store.load() // 重试（修复前 loaded=true ⇒ 这里什么都不做）

    expect(store.degradedCollections()).not.toContain('history')
    expect(store.queryHistory({ limit: 10 }).map((entry) => entry.title)).toEqual(['new-a', 'disk-2', 'disk-1'])

    const onDisk = readReal(historyPath).trim().split('\n').map((line) => JSON.parse(line) as HistoryRecord)
    expect(onDisk.map((entry) => entry.title)).toEqual(['disk-1', 'disk-2', 'new-a'])
    expect(new Set(onDisk.map((entry) => entry.seq)).size).toBe(onDisk.length)
    // 重试后继续追加的 seq 续接
    expect(store.addHistory({ time: Date.now() - 11, url: 'https://new.example/c', title: 'new-c', actor: 'ai', group: '' }).seq).toBe(4)
  })

  it('降级期 pending 队列有界（不会随会话时长无限增长）', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'history.jsonl'), `${historyLine(1, 'disk-1')}\n`)
    io.failReadSuffixes.push('history.jsonl')
    const store = new BrowserStore({ dir, historyLimit: 2, warn: () => {} })
    for (let i = 0; i < 50; i++) {
      store.addHistory({ time: Date.now() - i, url: `https://new.example/${i}`, title: `n${i}`, actor: 'ai', group: '' })
    }
    io.failReadSuffixes.length = 0
    store.load()
    // 有界：pending 队列上限 = historyLimit（2），磁盘 1 条 + 补落盘 ≤2 条；下一次
    // addHistory 的 prune 再把内存压回 limit。
    expect(readReal(join(dir, 'history.jsonl')).trim().split('\n').length).toBeLessThanOrEqual(3)
    expect(store.counts().history).toBeLessThanOrEqual(3)
    store.addHistory({ time: Date.now(), url: 'https://new.example/last', title: 'last', actor: 'ai', group: '' })
    expect(store.counts().history).toBe(2)
  })

  it('真实 errno 路径（history.jsonl 是目录 → EISDIR）同样降级，换回真文件后 load() 恢复', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    mkdirSync(historyPath) // 读它 → EISDIR（真实、非 ENOENT）

    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(warnings.join(' ')).toContain('history')
    expect(store.degradedCollections()).toContain('history')
    store.addHistory({ time: Date.now() - 9, url: 'https://new.example/a', title: 'new-a', actor: 'ai', group: '' })

    rmSync(historyPath, { recursive: true, force: true })
    writeFileSync(historyPath, `${historyLine(7, 'disk-7')}\n`)
    store.load()
    expect(store.queryHistory({ limit: 10 }).map((entry) => entry.title)).toEqual(['new-a', 'disk-7'])
    expect(store.degradedCollections()).not.toContain('history')
  })

  it('store 目录本身不可用（路径是个文件）时不抛错：全线只读降级 + 告警', () => {
    const parent = makeDir()
    const notADir = join(parent, 'not-a-directory')
    writeFileSync(notADir, 'x')
    const warnings: string[] = []
    const store = new BrowserStore({ dir: notADir, warn: (message) => warnings.push(message) })
    expect(warnings.join(' ')).toContain('创建 store 目录失败')
    expect(store.degradedCollections().sort()).toEqual(['bookmarks', 'downloads', 'groups', 'history'])
    expect(() => store.addHistory({ time: Date.now(), url: 'https://a/', title: 'a', actor: 'ai', group: '' })).not.toThrow()
  })

  it('ENOENT 仍是"首次运行"：不降级、不告警、照常落盘', () => {
    const dir = makeDir()
    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(store.degradedCollections()).toEqual([])
    expect(warnings).toEqual([])
    store.addHistory({ time: Date.now(), url: 'https://a/', title: 'a', actor: 'ai', group: '' })
    expect(readReal(join(dir, 'history.jsonl'))).toContain('https://a/')
  })
})

// ------------------------------------------------- P2：原子写 + 坏文件处理

describe('2026-09-15 审计 P2：整文件重写是原子替换', () => {
  it('rewrite 先写 .tmp 再 rename（不再直接截断目标文件）', () => {
    const dir = makeDir()
    const store = new BrowserStore({ dir })
    const bookmark = store.addBookmark({ url: 'https://a/1', title: 'one', actor: 'ai', group: '' })
    io.calls.length = 0
    store.removeBookmark(bookmark.id) // 走 rewrite

    const target = join(dir, 'bookmarks.jsonl')
    expect(io.calls).toContain(`write:${target}.tmp`)
    expect(io.calls).toContain(`rename:${target}.tmp->${target}`)
    // 目标文件本身不能出现在 write 调用里（那是"先截断后写"的旧行为）
    expect(io.calls).not.toContain(`write:${target}`)
  })

  it('rename 失败时目标文件保持旧内容（不留半个文件）+ 告警 + 只读降级', () => {
    const dir = makeDir()
    const bookmarksPath = join(dir, 'bookmarks.jsonl')
    const seed = new BrowserStore({ dir })
    seed.addBookmark({ url: 'https://a/1', title: 'one', actor: 'ai', group: '' })
    const before = readReal(bookmarksPath)

    io.failRenameSuffixes.push('bookmarks.jsonl')
    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    store.addBookmark({ url: 'https://a/1', title: 'renamed', actor: 'user', group: '' }) // 幂等分支 → rewrite
    expect(readReal(bookmarksPath)).toBe(before)
    expect(store.degradedCollections()).toContain('bookmarks')
    expect(warnings.join(' ')).toContain('bookmarks')
  })

  it('账本写入同样是原子替换', () => {
    const dir = makeDir()
    const store = new BrowserStore({ dir })
    io.calls.length = 0
    store.saveGroupLedger({ version: 1, activeTabId: undefined, tabs: [], savedAt: 1 })
    const target = join(dir, 'groups.jsonl')
    expect(io.calls).toContain(`write:${target}.tmp`)
    expect(io.calls).toContain(`rename:${target}.tmp->${target}`)
    expect(io.calls).not.toContain(`write:${target}`)
  })
})

describe('2026-09-15 审计 P2：坏账本改名备份而不是静默丢弃', () => {
  it('JSON 语法坏：备份为 *.corrupt-<ts> + 告警，启动照常，之后能写新账本', () => {
    const dir = makeDir()
    const groupsPath = join(dir, 'groups.jsonl')
    const corrupt = '{"version":1,"tabs":['
    writeFileSync(groupsPath, corrupt)

    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(store.getGroupLedger()).toBeUndefined()
    expect(warnings.join(' ')).toContain('groups.jsonl')

    const backups = readdirSync(dir).filter((name) => name.startsWith('groups.jsonl.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readReal(join(dir, backups[0]!))).toBe(corrupt)

    // "恢复失败的 ledger 不影响启动"：后续保存能正常落一份新账本
    store.saveGroupLedger({ version: 1, activeTabId: 3, tabs: [], savedAt: 42 })
    const reloaded = new BrowserStore({ dir })
    expect(reloaded.getGroupLedger()?.savedAt).toBe(42)
    expect(readdirSync(dir).filter((name) => name.startsWith('groups.jsonl.corrupt-'))).toHaveLength(1)
  })

  it('合法 JSON 但不是对象（`123`）同样按坏文件处理，不会让 getGroupLedger 返回数字', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'groups.jsonl'), '123')
    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(store.getGroupLedger()).toBeUndefined()
    expect(readdirSync(dir).some((name) => name.startsWith('groups.jsonl.corrupt-'))).toBe(true)
    expect(warnings.join(' ')).toContain('groups.jsonl')
  })

  it('账本读失败（EACCES）→ 拒绝覆盖磁盘旧账本，恢复后补写降级期保存的那份', () => {
    const dir = makeDir()
    const groupsPath = join(dir, 'groups.jsonl')
    const diskLedger = { version: 1, activeTabId: 1, tabs: [], savedAt: 1 }
    writeFileSync(groupsPath, JSON.stringify(diskLedger))

    io.failReadSuffixes.push('groups.jsonl')
    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(store.degradedCollections()).toContain('groups')
    expect(warnings.join(' ')).toContain('groups')

    const fresh = { version: 1, activeTabId: 9, tabs: [], savedAt: 99 } as const
    store.saveGroupLedger(fresh)
    expect(store.getGroupLedger()?.savedAt).toBe(99) // 内存里看得见
    expect(readReal(groupsPath)).toBe(JSON.stringify(diskLedger)) // 磁盘旧账本没被覆盖

    io.failReadSuffixes.length = 0
    store.load()
    expect(store.degradedCollections()).not.toContain('groups')
    expect(JSON.parse(readReal(groupsPath))).toEqual(fresh) // 恢复后补写
  })
})

describe('2026-09-15 审计 P2：JSONL 坏行不再静默丢弃', () => {
  it('尾部半行：按截断恢复 + 告警，修复后新记录仍可读（否则下一个 append 会被半行毒死）', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    writeFileSync(historyPath, `${historyLine(1, 'disk-1')}\n${historyLine(2, 'disk-2')}\n{"seq":3,"time":3,"ur`)

    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(store.counts().history).toBe(2)
    expect(warnings.join(' ')).toContain('history.jsonl')
    expect(readReal(historyPath).trim().split('\n')).toHaveLength(2)

    store.addHistory({ time: Date.now() - 4, url: 'https://new.example/4', title: 'new-4', actor: 'ai', group: '' })
    const reloaded = new BrowserStore({ dir })
    expect(reloaded.queryHistory({ limit: 10 }).map((entry) => entry.title)).toEqual(['new-4', 'disk-2', 'disk-1'])
    expect(reloaded.addHistory({ time: Date.now() - 5, url: 'https://new.example/5', title: 'new-5', actor: 'ai', group: '' }).seq).toBe(4)
  })

  it('文件中段坏行：告警 + 只读降级（原文件一个字节不动），后面能读到的记录仍然读得到', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    const raw = `${historyLine(1, 'disk-1')}\n{ this is not json\n${historyLine(3, 'disk-3')}\n`
    writeFileSync(historyPath, raw)

    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(store.degradedCollections()).toContain('history')
    expect(warnings.join(' ')).toContain('损坏')
    // 能救的救回来（修复前：break 在坏行 ⇒ 只有 1 条，且后续 append 会覆盖）
    expect(store.counts().history).toBe(2)
    expect(store.queryHistory({ limit: 10 }).map((entry) => entry.title)).toEqual(['disk-3', 'disk-1'])

    store.addHistory({ time: Date.now() - 4, url: 'https://new.example/4', title: 'new-4', actor: 'ai', group: '' })
    expect(readReal(historyPath)).toBe(raw)
  })
})

// ------------------------------------------------------ 跨用户 / 无限增长

describe('2026-09-15 审计复查：跨用户不串号 + 保留上限', () => {
  it('不同目录的两个 store 互不可见（自读缓存只属于本实例）', () => {
    const dirA = makeDir()
    const dirB = makeDir()
    const a = new BrowserStore({ dir: dirA })
    const b = new BrowserStore({ dir: dirB })
    a.addHistory({ time: Date.now(), url: 'https://a/1', title: 'a1', actor: 'ai', group: '' })
    a.addBookmark({ url: 'https://a/1', title: 'a1', actor: 'ai', group: '' })
    expect(b.counts()).toEqual({ history: 0, bookmarks: 0, downloads: 0 })
    expect(b.queryHistory({ limit: 10 })).toEqual([])
    expect(b.getGroupLedger()).toBeUndefined()
    expect(new BrowserStore({ dir: dirB }).counts().history).toBe(0)
    expect(new BrowserStore({ dir: dirA }).counts().history).toBe(1)
  })

  it('bookmarks/downloads 的保留上限在落盘与重载后都成立（无无限增长）', () => {
    const dir = makeDir()
    const store = new BrowserStore({ dir, bookmarkLimit: 3, downloadLimit: 2 })
    for (let i = 0; i < 9; i++) store.addBookmark({ url: `https://a/${i}`, title: `b${i}`, actor: 'ai', group: '' })
    for (let i = 0; i < 7; i++) {
      store.addDownload({ url: `https://a/d${i}`, fileName: `d${i}`, path: '', size: 0, actor: 'ai', group: '' })
    }
    expect(store.counts()).toEqual({ history: 0, bookmarks: 3, downloads: 2 })
    expect(readReal(join(dir, 'bookmarks.jsonl')).trim().split('\n')).toHaveLength(3)
    expect(readReal(join(dir, 'downloads.jsonl')).trim().split('\n')).toHaveLength(2)

    const reloaded = new BrowserStore({ dir, bookmarkLimit: 3, downloadLimit: 2 })
    expect(reloaded.counts()).toEqual({ history: 0, bookmarks: 3, downloads: 2 })
    expect(reloaded.queryBookmarks({ limit: 10 }).map((entry) => entry.title)).toEqual(['b8', 'b7', 'b6'])
    expect(reloaded.queryDownloads({ limit: 10 }).map((entry) => entry.fileName)).toEqual(['d6', 'd5'])
  })

  it('未注入 warn 时告警走 console.error（不静默）', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'groups.jsonl'), '{oops')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    new BrowserStore({ dir })
    expect(spy).toHaveBeenCalled()
    expect(String(spy.mock.calls[0]?.[0])).toContain('groups.jsonl')
  })
})

describe('2026-09-15 审计 P1：降级窗口的记录不会被"重试成功"吞掉', () => {
  it('中段坏行降级 → 期间新增 → 坏行被修好 → load() 后磁盘内容与降级期记录同时在（内存与磁盘）', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    writeFileSync(historyPath, `${historyLine(1, 'disk-1')}\n{ broken line\n${historyLine(3, 'disk-3')}\n`)

    const store = new BrowserStore({ dir, warn: () => {} })
    expect(store.degradedCollections()).toContain('history')
    store.addHistory({ time: Date.now() - 20, url: 'https://new.example/p1', title: 'pending-1', actor: 'ai', group: '' })
    store.addHistory({ time: Date.now() - 19, url: 'https://new.example/p2', title: 'pending-2', actor: 'ai', group: '' })
    expect(store.counts().history).toBe(4) // 两条能读到的 + 两条降级期新增

    // 关键中间步：坏行还没修好就 load() 重试（仍是不干净的读）。pending 这时**不能**
    // 被结清，否则下一次重建内存（内存 = 磁盘 + pending）会把降级期的记录整批丢掉。
    store.load()
    expect(store.degradedCollections()).toContain('history')
    expect(store.counts().history).toBe(4)

    // 坏行被外部修好（真实运维场景：人工修复后 load() 重试）
    writeFileSync(historyPath, `${historyLine(1, 'disk-1')}\n${historyLine(3, 'disk-3')}\n`)
    store.load()

    expect(store.degradedCollections()).not.toContain('history')
    expect(store.queryHistory({ limit: 10 }).map((entry) => entry.title)).toEqual([
      'pending-2', 'pending-1', 'disk-3', 'disk-1',
    ])
    const onDisk = readReal(historyPath).trim().split('\n').map((line) => JSON.parse(line) as HistoryRecord)
    expect(onDisk.map((entry) => entry.title)).toEqual(['disk-1', 'disk-3', 'pending-1', 'pending-2'])
    expect(new Set(onDisk.map((entry) => entry.seq)).size).toBe(onDisk.length)
  })
})

describe('2026-09-15 审计 P2：截断修复失败也必须降级（不能解掉自己的降级）', () => {
  it('尾部半行修不好（rename 失败）→ 告警 + 只读降级，绝不在半行后面继续 append', () => {
    const dir = makeDir()
    const historyPath = join(dir, 'history.jsonl')
    const raw = `${historyLine(1, 'disk-1')}\n{"seq":2,"time":2,"ur`
    writeFileSync(historyPath, raw)

    io.failRenameSuffixes.push('history.jsonl')
    const warnings: string[] = []
    const store = new BrowserStore({ dir, warn: (message) => warnings.push(message) })
    expect(warnings.join(' ')).toContain('history.jsonl')
    expect(store.degradedCollections()).toContain('history')

    store.addHistory({ time: Date.now(), url: 'https://new.example/a', title: 'new-a', actor: 'ai', group: '' })
    expect(readReal(historyPath)).toBe(raw) // 半行还在 ⇒ 一次 append 都不能发生

    // rename 恢复后 load() 重试：修复完成，磁盘 = 完整行 + 降级期补落盘
    io.failRenameSuffixes.length = 0
    store.load()
    expect(store.degradedCollections()).not.toContain('history')
    const onDisk = readReal(historyPath).trim().split('\n').map((line) => JSON.parse(line) as HistoryRecord)
    expect(onDisk.map((entry) => entry.title)).toEqual(['disk-1', 'new-a'])
  })
})
