/**
 * 孤儿写锁回收（`src/document-lock-recovery.ts`）的行为判据。
 *
 * 现场事故（2026-09-22，客户机）：数据根里一个 0 字节的 `settings.yaml.lock` 让
 * settings 的**每一次**写入都等 2s 后超时失败（被插件的 `.catch` 吞掉），于是
 * `llm-deepseek.protocol: chat-completions` 永远写不进去，客户端升级到 0.1.6 后
 * 每个模型请求都 401「缺少认证令牌」。
 *
 * 这个模块的第一原则是**只删有证据的孤儿**：宁可让一个可疑锁继续挡路（有日志可查），
 * 也不删可能属于活写入者的锁。每条用例对应模块头注释里的一条判据；放宽任何一条
 * （例如"读不出来就删""0 字节立刻删""PID 超界就删""不复查 identity 就删"）都会让
 * 对应用例变红。
 */
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyOwnerProbeError,
  documentLockRecoveryLogLines,
  LOCK_CONTENT_MAX_BYTES,
  NO_OWNER_LOCK_MIN_AGE_MS,
  reclaimOrphanedDocumentLocks,
  type DocumentLockRecoveryReport,
} from '../src/document-lock-recovery.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-document-lock-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** 写一个锁文件（内容原样，含空内容）。 */
function writeLock(home: string, document: string, content: string): string {
  const path = join(home, `${document}.lock`)
  writeFileSync(path, content)
  return path
}

/**
 * 该目录所在文件系统能否构造"身份不变的换锁"——**直接做一遍**判据要做的那个动作：
 * 建一个与锁同长的普通文件 → `rm` → 建一个目标串等长的符号链接，比较四项 stat。
 *
 * 不猜文件系统性质（inode 是否复用、时间戳步进多粗都随文件系统与内核而异，CI runner 与
 * 本机就不一样）：探针命中说明这种形态**确实构造得出来**，那条用例才要求"必须咬到"；
 * 探针打不中（tmpfs、纳秒时间戳、不回收 inode 的 overlayfs…）就只断言行为，不因环境变红。
 */
function identityPreservingSwapSupported(dir: string): boolean {
  writeFileSync(join(dir, 'other'), '4242\n')
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const lock = join(dir, `swap-probe-${String(attempt)}`)
    writeFileSync(lock, '4242\n')
    const before = statSync(lock)
    rmSync(lock, { force: true })
    symlinkSync('other', lock)
    const after = lstatSync(lock)
    rmSync(lock, { force: true })
    if (after.dev === before.dev && after.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs) {
      return true
    }
  }
  return false
}

/** 把锁文件的门槛年龄拨老：`ageMs` 之前。 */
function ageLock(path: string, ageMs: number): void {
  const seconds = (Date.now() - ageMs) / 1000
  utimesSync(path, seconds, seconds)
}

const AGED = NO_OWNER_LOCK_MIN_AGE_MS + 5_000
const CLEAN: DocumentLockRecoveryReport = { reclaimed: [], held: [], kept: [] }

describe('owner-liveness probing maps raw errno to a verdict', () => {
  // 这条映射是"绝不替人删活锁"的最后一道。单测只能用注入替身覆盖**消费端**，映射本身
  // 得单独钉：真 `EPERM` 要求非特权进程去探测别人的进程（本仓沙箱常以 root 跑，跳过式
  // 用例等于没有判据）。下面每个期望值都是字面量。
  it('treats only ESRCH as proof that the owner is gone', () => {
    expect(classifyOwnerProbeError('ESRCH')).toBe('gone')
  })

  it('treats EPERM as a live owner (no signal permission, not a dead process)', () => {
    expect(classifyOwnerProbeError('EPERM')).toBe('alive')
  })

  it('treats every other errno (and a missing code) as unknown, never as gone', () => {
    for (const code of ['ERR_OUT_OF_RANGE', 'ERR_INVALID_ARG_TYPE', 'EACCES', 'EBUSY', 'EINVAL', 'UNKNOWN', '']) {
      expect([code, classifyOwnerProbeError(code)]).toEqual([code, 'unknown'])
    }
    expect(classifyOwnerProbeError(undefined)).toBe('unknown')
    // 大小写不同不是同一个错误码：宁可"未知"（保留）也不要误判成 gone。
    expect(classifyOwnerProbeError('esrch')).toBe('unknown')
  })
})

describe('orphaned document write locks are reclaimed', () => {
  it('reclaims an aged zero-byte lock (the field shape) and reports why', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '')
    ageLock(path, AGED)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed).toHaveLength(1)
    expect(report.reclaimed[0]).toMatchObject({ document: 'settings.yaml', reason: 'no-owner-recorded' })
    // mtime 是运维取证的关键字段（锁是"什么时候"留下的）。
    expect(report.reclaimed[0]?.modifiedAt).toBeTypeOf('string')
    expect(report.held).toEqual([])
    expect(report.kept).toEqual([])
  })

  it('KEEPS a freshly created zero-byte lock (the live writer create-before-write window)', () => {
    const home = temporaryHome()
    // 上游 withFileLock 先 `wx` 建文件、再写 PID：这中间合法地存在一个 0 字节窗口。
    // 没有年龄证据就删，等于在两个写者之间制造并发临界区。
    const path = writeLock(home, 'settings.yaml', '')
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept).toHaveLength(1)
    expect(report.kept[0]).toMatchObject({ document: 'settings.yaml', path, reason: 'too-young' })
  })

  it('honors the age threshold on both sides', () => {
    const home = temporaryHome()
    const young = writeLock(home, 'settings.yaml', '')
    ageLock(young, NO_OWNER_LOCK_MIN_AGE_MS - 5_000)
    const aged = writeLock(home, '.credentials.yaml', '')
    ageLock(aged, NO_OWNER_LOCK_MIN_AGE_MS + 5_000)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(young)).toBe(true)
    expect(existsSync(aged)).toBe(false)
    expect(report.reclaimed.map(lock => lock.document)).toEqual(['.credentials.yaml'])
    expect(report.kept.map(lock => [lock.document, lock.reason])).toEqual([['settings.yaml', 'too-young']])
  })

  // 上面那条只证明门槛的**方向**（夹具用的是被测常量自身）。门槛的**量级**必须另外钉：
  // 常量被改成小时级时，"崩在几十分钟前的锁"不再自愈，而方向用例照样全绿。
  it('pins the threshold magnitude, not just its direction', () => {
    expect(NO_OWNER_LOCK_MIN_AGE_MS).toBe(45_000)
  })

  it('stays in step with the cron ledger stale-lock age (the documented same convention)', () => {
    // 模块头与决策文档都写"与 `@picoaide/dsh-cron` 的 `host-ledger.ts:STALE_LOCK_AGE_MS` 同口径"。
    // 那句话此前没有判据（第 4 轮审计 N5）：两处各自漂移没人拦。这里直接读对方源码对拍 ——
    // 顺序任一侧改值都会红，逼改动者回来同步口径。
    const cronLedger = readFileSync(
      fileURLToPath(new URL('../../cron/src/host-ledger.ts', import.meta.url)),
      'utf8',
    )
    // 先剥行注释再锚 `const`：否则注释里写个 `= 45_000` 会让真值漂移"误绿"，写别的值又"误红"
    // （第 6 轮审计实测三种形态）。要求恰好一处声明。
    const withoutComments = cronLedger
      .split('\n')
      .map(line => line.replace(/\/\/.*$/u, ''))
      .join('\n')
    const declared = [...withoutComments.matchAll(/^const STALE_LOCK_AGE_MS\s*=\s*([0-9_]+)\s*$/gmu)]
    expect(
      declared,
      `cron 的 STALE_LOCK_AGE_MS 必须恰好有一处、且写成十进制字面量（匹配到 ${String(declared.length)} 处）`
      + '：改过名字/换过写法（如 `45 * 1000`）就同步这条判据',
    ).toHaveLength(1)
    expect(Number(declared[0]?.[1]?.replaceAll('_', ''))).toBe(NO_OWNER_LOCK_MIN_AGE_MS)
  })

  it('reclaims a lock that is 61s old and keeps one that is 30s old (literal ages)', () => {
    const home = temporaryHome()
    const old = writeLock(home, 'settings.yaml', '')
    ageLock(old, 61_000)
    const recent = writeLock(home, '.credentials.yaml', '')
    ageLock(recent, 30_000)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(report.reclaimed.map(lock => [lock.document, lock.reason])).toEqual([['settings.yaml', 'no-owner-recorded']])
    expect(report.kept.map(lock => [lock.document, lock.reason])).toEqual([['.credentials.yaml', 'too-young']])
  })

  it('treats a future mtime as too young (never deletes on a negative age)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '')
    utimesSync(path, (Date.now() + 3_600_000) / 1000, (Date.now() + 3_600_000) / 1000)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(true)
    expect(report.kept[0]).toMatchObject({ reason: 'too-young' })
  })

  it('reclaims an aged whitespace-only lock and an aged PID-0 lock as "no owner recorded"', () => {
    const home = temporaryHome()
    ageLock(writeLock(home, 'settings.yaml', '  \n'), AGED)
    ageLock(writeLock(home, '.credentials.yaml', '0\n'), AGED)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(report.reclaimed.map(lock => [lock.document, lock.reason])).toEqual([
      ['settings.yaml', 'no-owner-recorded'],
      ['.credentials.yaml', 'no-owner-recorded'],
    ])
    expect(existsSync(join(home, 'settings.yaml.lock'))).toBe(false)
    expect(existsSync(join(home, '.credentials.yaml.lock'))).toBe(false)
  })

  it('reclaims a lock whose recorded owner PID is gone (probe says ESRCH)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    const probed: number[] = []
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: (pid) => { probed.push(pid); return 'gone' },
    })
    expect(probed).toEqual([4242])
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed[0]).toMatchObject({ reason: 'owner-pid-gone', pid: 4242 })
  })

  it('reclaims a lock whose owner really exited (real process.kill probe)', () => {
    const home = temporaryHome()
    // 起一个立刻退出的子进程，拿它已消失的 PID 走**真实**探测路径（不注入）。
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const deadPid = child.pid
    expect(deadPid).toBeGreaterThan(0)
    const path = writeLock(home, 'settings.yaml', `${String(deadPid)}\n`)
    const report = reclaimOrphanedDocumentLocks({ home })
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed[0]).toMatchObject({ reason: 'owner-pid-gone', pid: deadPid })
  })

  it('keeps a lock held by a live PID and reports PID + path', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '31337\n')
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: pid => (pid === 31337 ? 'alive' : 'unknown') })
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.held).toEqual([{ document: 'settings.yaml', path, pid: 31337 }])
  })

  it('keeps a lock whose owner liveness cannot be determined', () => {
    const home = temporaryHome()
    // 只有 ESRCH 是"已死"的证据：超界 PID（process.kill 抛 ERR_OUT_OF_RANGE）、
    // EACCES 等都必须按"未知"处理并保留。
    const huge = writeLock(home, 'settings.yaml', '99999999999\n')
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'unknown' })
    expect(existsSync(huge)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'owner-liveness-unknown' })
  })

  it('never short-circuits on a large PID: a live owner wins over the magnitude', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '5000000\n')
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(true)
    expect(report.held).toEqual([{ document: 'settings.yaml', path, pid: 5000000 }])
  })

  it('keeps an oversized lock without reading it into the main process', () => {
    const home = temporaryHome()
    // 1 GiB 稀疏文件：体积闸门在读之前生效（真实锁 ≤20 字节），启动路径不该把大文件
    // 整份读进主进程内存。读不出来的锁可能是别人按更严权限建的**活锁** ⇒ 保留。
    const path = join(home, 'settings.yaml.lock')
    const fd = openSync(path, 'w')
    ftruncateSync(fd, 1024 * 1024 * 1024)
    closeSync(fd)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'unreadable' })
    expect(report.kept[0]?.message).toContain(String(LOCK_CONTENT_MAX_BYTES))
  })

  it('pins the read-gate magnitude (a 4096-byte bound is the point, not any bound)', () => {
    // 闸门的**值**也是判据：注释与决策文档的理据是"真实锁 ≤20 字节、别把几十 MB 读进主进程
    // 内存"，把它放宽到 MiB 级就与那条理据冲突了（第 4 轮审计实测 4096→4MiB/64MiB 全绿）。
    expect(LOCK_CONTENT_MAX_BYTES).toBe(4096)
  })

  it('still reads a lock that is exactly at the sanity bound (the gate is an upper bound)', () => {
    const home = temporaryHome()
    // 恰好等于上限的**纯空白**锁（拨老）应当照常判定为"没有属主"⇒ 回收：证明闸门是
    // `>` 而不是 `>=`，且超限与"内容不可识别"是两件事。
    const path = writeLock(home, 'settings.yaml', ' '.repeat(LOCK_CONTENT_MAX_BYTES))
    ageLock(path, AGED)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed[0]).toMatchObject({ document: 'settings.yaml', reason: 'no-owner-recorded' })
  })

  it('reports an inspection failure instead of throwing (home is a file, not a directory)', () => {
    const home = temporaryHome()
    const notADirectory = join(home, 'regular-file')
    writeFileSync(notADirectory, 'not a home\n')
    // `<file>/settings.yaml.lock` 的 lstat 抛 ENOTDIR：既不是"不存在"也不是"能删"，
    // 必须逐条上报（两个候选各一条），且绝不抛。
    const report = reclaimOrphanedDocumentLocks({ home: notADirectory, probeOwner: () => 'gone' })
    expect(report.reclaimed).toEqual([])
    expect(report.held).toEqual([])
    expect(report.kept.map(lock => [lock.document, lock.reason])).toEqual([
      ['settings.yaml', 'inspect-failed'],
      ['.credentials.yaml', 'inspect-failed'],
    ])
  })

  it('keeps a lock whose content is not a decimal PID (unknown future format)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '{"pid":4242}\n')
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'unrecognized-content' })
  })

  it('never removes a non-regular file at the lock path', () => {
    const home = temporaryHome()
    // 目录：`unlinkSync` 会抛 EISDIR/EPERM —— 必须判在删除之前，且只上报。
    const dir = join(home, 'settings.yaml.lock')
    mkdirSync(dir)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })
    expect(existsSync(dir)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'not-a-regular-file' })
  })

  it('leaves a symlinked lock path alone instead of following or removing it', () => {
    const home = temporaryHome()
    const target = join(home, 'real-file')
    writeFileSync(target, '4242\n')
    symlinkSync(target, join(home, 'settings.yaml.lock'))
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })
    expect(readFileSync(target, 'utf8')).toBe('4242\n')
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'not-a-regular-file' })
  })

  it('keeps a lock that vanished between the identity re-check and the removal (no false failure)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    // 复检发生在 `probeOwner` 之后：这里在探测回调里直接删掉锁（不重建），于是复检的
    // `lstat` 抛 ENOENT ⇒ 走 `unchangedSinceInspection` 的 catch 分支（保留）。
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => {
        rmSync(path)
        return 'gone'
      },
    })
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
  })

  it('re-checks identity before unlinking (a lock swapped in during the window survives)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    const before = statSync(path)
    // 判定与删除之间，另一个写者删掉旧锁、建起自己那把（属主活着）。**新锁内容与旧锁等长**，
    // 且把 mtime 拨回原值 —— 这是自然形态：锁内容是 `String(pid) + '\n'`，同一数量级的 PID
    // 天然同长度，而时间戳步进（实测 4ms）粗于判定窗口、ext4 又会立即复用 inode ⇒ 三项 stat
    // 判据都可能全等，只有内容比较能认出来。（mtimeMs 用浮点秒还原才是逐位相等。）
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => {
        rmSync(path)
        writeFileSync(path, '3131\n')
        utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000)
        return 'gone'
      },
    })
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('3131\n')
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
  })

  it('short-circuits on the stat comparison before reading (the read count stays at one)', () => {
    // 早退顺序是承重的：锁在窗口里被换成 256 MiB 文件时，"先 stat 后读"只花 1ms/+2MiB，
    // 调换顺序则是 382ms/+522MiB（第 4/5 轮审计实测）。时序与内存不便当判据，这里直接数
    // **读取次数**：判定阶段读一次（拿内容），复检必须因为 size 不等而短路，不能再读。
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    const reads: string[] = []
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => {
        // 同路径换成一个巨大的稀疏文件：size 立刻不等 ⇒ 复检必须在读之前返回 false。
        rmSync(path)
        const fd = openSync(path, 'w')
        ftruncateSync(fd, 256 * 1024 * 1024)
        closeSync(fd)
        return 'gone'
      },
      readFile: (target) => {
        reads.push(target)
        return readFileSync(target, 'utf8')
      },
    })
    expect(reads, '复检在读之前就该因为 stat 不等而短路').toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
  })

  it('never reads a swapped-in symlink (the type guard also fires before the read)', () => {
    // 与上一条同源的"读之前短路"判据，用符号链接形态（identity 是否全等取决于文件系统，
    // 但**读取次数**与文件系统无关：不该读的形态下一次都不该读）。
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    writeFileSync(join(home, 'other'), '4242\n')
    const reads: string[] = []
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => {
        rmSync(path, { force: true })
        symlinkSync('other', path)
        return 'gone'
      },
      readFile: (target) => {
        reads.push(target)
        return readFileSync(target, 'utf8')
      },
    })
    expect(reads, '符号链接不该被跟随读取').toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
  })

  it('compares the re-read bytes and refuses to delete when they differ (filesystem-independent)', () => {
    // 判据与文件系统、时间戳精度、inode 复用**全部无关**：判定阶段读到 `'4242\n'`，复检时
    // 注入的读取返回 `'3131\n'` ⇒ 内容比较必须拒绝删除。它同时钉住"内容比较确实发生"与
    // "复检确实走注入的读取实现"（把内联 `readFileSync` 换回来就会变红）。
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    let reads = 0
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => 'gone',
      // 判定阶段读到 `'4242\n'`，复检阶段读到 `'3131\n'`：两次内容不同，且 stat 四项
      // 因为文件没动过而**完全相等**（这条判据要的正是"只有内容能区分"的形态）。
      readFile: () => {
        reads += 1
        return reads === 1 ? '4242\n' : '3131\n'
      },
    })
    expect(reads, '判定读一次、复检再读一次，内容比较必须真的发生').toBe(2)
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
  })

  it('never follows a non-regular entry at re-check time (a symlink swapped in survives)', () => {
    // 判定窗口里把锁换成**符号链接**：符号链接自身的 `lstat` size 是目标串长度（用 5 字符
    // 目标 `other` 与 `'4242\n'` 等长），配合"复用 inode + 同一时间戳 tick"可以让四项 stat
    // 全等。目标文件的内容**故意与锁相同**：如果复检只看内容就放行，就会把这条符号链接
    // `unlink` 掉（把别人的东西删了）；正确行为是**在读之前**先复验"仍是普通文件"并保留。
    //
    // 真实世界里这个口子的形态是"符号链接指向无写者的 FIFO"：`readFileSync` 会跟随它去
    // open，永久阻塞在窗口创建之前的启动路径上（第 5 轮审计用真实探针实测 EXIT=124）。
    // 这里不用 FIFO 做判据 —— 同步 `readFileSync` 阻塞的是事件循环，vitest 的超时定时器
    // 也起不来，变异体只会把整个套件挂死而不是干净变红；用"同内容符号链接"能让同一条
    // `!after.isFile()` 守卫以可判定的方式变红（变异体：`unlink` 掉符号链接 ⇒ 路径消失）。
    //
    // 身份全等依赖文件系统（inode 是否复用 + 时间戳步进是否粗于两次写入的间隔），所以先
    // **整场重试**、再用 `identityPreservingSwapSupported()` 判断这种形态本能否构造出来：
    // 能构造就要求必须咬到；不能（tmpfs、纳秒时间戳的 CI runner）就只断言行为，不假红。
    const strictIdentity = identityPreservingSwapSupported(temporaryHome())
    let identityForced = false
    for (let attempt = 0; attempt < 64 && !identityForced; attempt += 1) {
      const home = temporaryHome()
      const path = writeLock(home, 'settings.yaml', '4242\n')
      writeFileSync(join(home, 'other'), '4242\n')
      const before = statSync(path)
      const report = reclaimOrphanedDocumentLocks({
        home,
        probeOwner: () => {
          rmSync(path, { force: true })
          symlinkSync('other', path)
          const after = lstatSync(path)
          identityForced = after.dev === before.dev && after.ino === before.ino
            && after.size === before.size && after.mtimeMs === before.mtimeMs
          return 'gone'
        },
      })
      expect(existsSync(path), '复检跟随了符号链接并把它删掉了').toBe(true)
      expect(report.reclaimed).toEqual([])
      expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
    }
    if (strictIdentity) {
      // 该文件系统上这种形态**可以**构造出来（实测本机 ext4 + 4ms 步进：1 次尝试即全等）：
      // 那就要求它必须咬到，否则这条判据会静默退化成"没测到守卫"。
      expect(identityForced, '该文件系统本可构造"四项 stat 全等"的换锁，却没构造出来，判据会退化').toBe(true)
    }
  })

  it('re-checks content, not just stat fields (same inode, same size, same mtime)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    const before = statSync(path)
    // 原地改写内容并**把 mtime 逐位拨回原值**（浮点秒；用 Date 会丢亚毫秒）：inode/size/mtimeMs
    // 三项全等，只有字节不同 —— 三项 stat 判据在这里必然放行，内容比较是唯一能挡住它的判据
    // （与文件系统是否复用 inode 无关）。
    // 前提：`utimesSync` 能把 mtime 拨回逐位相等（实测浮点秒还原在 ext4/tmpfs 上都逐位相等；
    // 亚微秒时间戳内核上不保证）。若某天不等，本条会退化成"只测 stat"——这是有意的取舍：
    // 判据不能因为运行环境的文件系统而变红。**不依赖这个前提**的内容比较判据见下一条
    // （注入 `readFile` 返回不同的字节）；"读取次数"那两条判据钉的是"读之前短路"。
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => {
        writeFileSync(path, '3131\n')
        utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000)
        return 'gone'
      },
    })
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('3131\n')
    expect(report.reclaimed).toEqual([])
    expect(report.kept[0]).toMatchObject({ reason: 'changed-since-inspection' })
  })

  it('still reclaims an orphan whose mtime is set to an extreme value (whatever the filesystem stores)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', '4242\n')
    // 坏时间戳（归档恢复/touch/网络文件系统）只该让日志少一个字段，不该让锁永远回收不掉。
    // **判据必须与文件系统无关**：ext4 在 VFS 把秒数夹到 2446-05-10（那是个合法 `Date`），
    // tmpfs 不夹取 ⇒ 同一断言在两者上结论相反（第 5 轮审计用 ext4 上的 TMPDIR 实测）。
    // 所以先读回**实际存下来的** mtime，再决定日志字段该怎么断；"回收照常发生"是两边共有的本意。
    let storedMs: number | undefined
    try {
      utimesSync(path, 9e15, 9e15)
      storedMs = statSync(path).mtimeMs
    } catch {
      // 有的文件系统直接拒绝这种取值：那就不存在"极端时间戳"这一形态，下面按普通锁断言。
      storedMs = undefined
    }
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed[0]).toMatchObject({ reason: 'owner-pid-gone', pid: 4242 })
    if (storedMs !== undefined && Math.abs(storedMs) > 8.64e15) {
      // 落在 `Date` 值域之外：日志字段缺席（`readableIso` 的 catch），但裁决与删除照常。
      expect(report.reclaimed[0]?.modifiedAt).toBeUndefined()
    } else {
      // 被夹进值域：字段照常渲染成 ISO 串（同样不该影响裁决）。
      expect(report.reclaimed[0]?.modifiedAt).toBeTypeOf('string')
    }
  })

  it('does nothing when the home has no such locks (or does not exist)', () => {
    const home = temporaryHome()
    expect(reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })).toEqual(CLEAN)
    expect(reclaimOrphanedDocumentLocks({ home: join(home, 'not-created'), probeOwner: () => 'alive' })).toEqual(CLEAN)
  })

  it('never touches other lock files in the home (session leases stay)', () => {
    const home = temporaryHome()
    // session.lock 是会话租约、故意常驻磁盘；内容为空也不该被回收。
    const lease = writeLock(home, 'session', '')
    ageLock(lease, AGED)
    const unrelated = join(home, 'another-document.json.lock')
    writeFileSync(unrelated, '')
    ageLock(unrelated, AGED)
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })
    expect(existsSync(lease)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    expect(report).toEqual(CLEAN)
  })

  it('is idempotent: a second pass finds nothing', () => {
    const home = temporaryHome()
    ageLock(writeLock(home, 'settings.yaml', ''), AGED)
    ageLock(writeLock(home, '.credentials.yaml', '4242\n'), AGED)
    const first = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })
    expect(first.reclaimed).toHaveLength(2)
    expect(reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'gone' })).toEqual(CLEAN)
  })

  it('reclaims a lock that names this very process (PID reuse from an earlier run)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', `${String(process.pid)}\n`)
    // 回收发生在任何写入者之前 ⇒ 本进程还没写过锁，"属主是自己"只能是上一轮的
    // 同号 PID。判据是**证明**，所以连探测都不需要（真实探测会说"活着"）。
    const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
    expect(existsSync(path)).toBe(false)
    expect(report.reclaimed[0]).toMatchObject({ reason: 'owner-is-this-process', pid: process.pid })
  })

  it('keeps a lock held by another live process (real process.kill probe)', () => {
    const home = temporaryHome()
    // 不注入探测：走 process.kill(pid, 0) 的真实路径，属主用真实存活且不是本进程的
    // 父进程 PID。
    const path = writeLock(home, 'settings.yaml', `${String(process.ppid)}\n`)
    const report = reclaimOrphanedDocumentLocks({ home })
    expect(existsSync(path)).toBe(true)
    expect(report.held).toEqual([{ document: 'settings.yaml', path, pid: process.ppid }])
  })

  // 只读父目录能让 unlink 失败，但 root 绕过权限位 ⇒ 只在非 root 环境跑（CI 的
  // runner 是非 root；本仓沙箱常以 root 跑，此时跳过而不是假红）。
  const canDropDirectoryWrite = process.platform !== 'win32'
    && typeof process.getuid === 'function' && process.getuid() !== 0
  it.skipIf(!canDropDirectoryWrite)('reports a removal failure without throwing (unlink denied)', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', `${String(process.pid)}\n`)
    chmodSync(home, 0o500)
    try {
      const report = reclaimOrphanedDocumentLocks({ home, probeOwner: () => 'alive' })
      expect(report.reclaimed).toEqual([])
      expect(report.kept[0]).toMatchObject({ reason: 'remove-failed' })
      expect(existsSync(path)).toBe(true)
    } finally {
      chmodSync(home, 0o700)
    }
  })

  // 上面那条依赖非 root（本仓沙箱常以 root 跑 ⇒ 跳过 = 没判据）。删除实现可注入，
  // 于是"删不掉"与"删的时候已经没了"这两条兜底路径在任何环境都有判据：
  // 前者必须报 remove-failed 且**绝不**写进 reclaimed（否则日志会谎报"已修好，写锁已释放"）。
  it('never reports a lock as reclaimed when the removal itself failed', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', `${String(process.pid)}\n`)
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => 'alive',
      removeFile: () => {
        throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' })
      },
    })
    expect(existsSync(path)).toBe(true)
    expect(report.reclaimed).toEqual([])
    expect(report.held).toEqual([])
    expect(report.kept).toHaveLength(1)
    expect(report.kept[0]).toMatchObject({ document: 'settings.yaml', path, reason: 'remove-failed' })
  })

  it('treats a lock that disappeared under the removal call as reclaimed, with a note', () => {
    const home = temporaryHome()
    const path = writeLock(home, 'settings.yaml', `${String(process.pid)}\n`)
    const report = reclaimOrphanedDocumentLocks({
      home,
      probeOwner: () => 'alive',
      removeFile: () => {
        rmSync(path)
        throw Object.assign(new Error('ENOENT: no such file or directory, unlink'), { code: 'ENOENT' })
      },
    })
    expect(existsSync(path)).toBe(false)
    expect(report.kept).toEqual([])
    expect(report.reclaimed[0]).toMatchObject({ document: 'settings.yaml', reason: 'owner-is-this-process' })
    expect(report.reclaimed[0]?.note).toContain('disappeared')
  })
})

describe('recovery log lines carry the evidence', () => {
  it('renders one line per finding, with PID and mtime where known', () => {
    const lines = documentLockRecoveryLogLines({
      reclaimed: [{ document: 'settings.yaml', path: '/home/u/settings.yaml.lock', reason: 'owner-pid-gone', pid: 4242, modifiedAt: '2026-09-22T03:33:02.000Z' }],
      held: [{ document: '.credentials.yaml', path: '/home/u/.credentials.yaml.lock', pid: 31337 }],
      kept: [{ document: 'settings.yaml', path: '/home/u/settings.yaml.lock', reason: 'too-young', message: 'no owner recorded yet' }],
    })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('reclaimed an orphaned settings.yaml write lock')
    expect(lines[0]).toContain('owner-pid-gone')
    expect(lines[0]).toContain('owner pid 4242')
    expect(lines[0]).toContain('2026-09-22T03:33:02.000Z')
    // 活锁那条必须点明后果与出路（否则运维看到一条无行动项的日志）。
    expect(lines[1]).toContain('held by live pid 31337')
    expect(lines[1]).toContain('/home/u/.credentials.yaml.lock is removed')
    expect(lines[2]).toContain('left /home/u/settings.yaml.lock in place (too-young)')
  })

  it('renders nothing for a clean pass', () => {
    expect(documentLockRecoveryLogLines(CLEAN)).toEqual([])
  })

  it('renders the unreadable-lock note', () => {
    const lines = documentLockRecoveryLogLines({
      reclaimed: [],
      held: [],
      kept: [{ document: 'settings.yaml', path: '/h/settings.yaml.lock', reason: 'unreadable', message: 'lock unreadable: EACCES' }],
    })
    expect(lines[0]).toContain('lock unreadable: EACCES')
  })
})

/**
 * 接线判据：回收必须发生在**任何写入者之前**，且不能让启动因为它失败。
 * 位置顺序是这条修复的全部价值所在——放到 `boot()` 之后就等于本进程自己已经在写
 * settings，那时删锁会撞上真实写入。
 */
describe('main.ts wiring', () => {
  const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')

  it('reclaims before the profile is prepared and any writer starts', () => {
    const call = main.indexOf('reclaimOrphanedDocumentLocks(')
    const lock = main.indexOf('requestSingleInstanceLock()')
    const prepare = main.indexOf('await prepareDesktopProfile(')
    expect(call).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(-1)
    expect(prepare).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(lock)
    expect(call).toBeLessThan(prepare)
  })

  it('reports every finding and survives its own failure', () => {
    expect(main).toContain('documentLockRecoveryLogLines(')
    expect(main).toContain('document lock recovery failed')
  })
})
