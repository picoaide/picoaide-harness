/**
 * CR-1（P0）回归 —— 2026-09-23 独立审计（报告
 * `temp/audit-2026-09-23/D-browser-wasm-host.md` §4.1 / 子报告 `probes/host/subcron.md` CR-1）。
 *
 * 缺陷：`load()` 的 `catch {}` 把**任何** errno 都当成"首次运行"，返回一个无标记的
 * 空账本；随后任意一次 `persist()`（tmp + `renameSync`）覆盖那份**读不到**的原文件
 * ⇒ 全部定时任务（含 prompt）无声消失，且没有 `.corrupt-*` 备份。同仓
 * `packages/host/browser/src/store.ts:8-14` 早已写死正确口径：**只有 ENOENT 算首次
 * 运行**，其余只读降级 + 告警。
 *
 * 判据刻意使用**真实 errno**（不 mock 抛错字符串）：
 *   1. ENOENT —— 唯一合法的空账本，带"首次运行"标记，写入照常；
 *   2. EISDIR —— `ledger.json` 是指向目录的符号链接：任何 uid 都能复现，而且
 *      `renameSync(tmp, ledger.json)` 会替换该符号链接本身，正是"文件读不到但
 *      目录可写"的致命链；
 *   3. EACCES —— 按审计口径把 `ledger.json` 改成 000 后 drop 到 uid 65534（root
 *      下）或直接用当前非 root 用户跑子进程，断言只读降级、写入被拒、原文件
 *      逐字节未变、日志点名文件与 errno；
 *   4. 解析失败 —— 只有把原字节真正另存为 `.corrupt-<ts>` 之后才允许落盘；隔离
 *      本身失败时同样只读（否则下一次 persist 覆盖唯一副本）。
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostCronLedger } from '../src/host-ledger.ts'

const PROBE = fileURLToPath(new URL('./helpers/ledger-read-probe.mjs', import.meta.url))

/**
 * Can this process produce a **real** `EACCES` on a `chmod 000` file?
 *
 * As root the DAC check is bypassed by `CAP_DAC_OVERRIDE`/`CAP_DAC_READ_SEARCH`,
 * so those two capabilities are dropped with `setpriv` (util-linux — the very
 * tool the audit used for its `--reuid=65534` reproduction, minus the uid change
 * that would also need a world-traversable node binary). A non-root user needs
 * no help: `chmod 000` already denies its own read.
 */
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const SETPRIV = '/usr/bin/setpriv'
const CAN_FORCE_EACCES = !ROOT || existsSync(SETPRIV)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-readfail-'))
})

afterEach(() => {
  vi.useRealTimers()
  // The EACCES case clears the read bit: restore it so rmSync can clean up.
  try { chmodSync(join(dir, 'cron', 'ledger.json'), 0o600) } catch { /* absent */ }
  try { chmodSync(join(dir, 'cron'), 0o700) } catch { /* absent */ }
  rmSync(dir, { recursive: true, force: true })
})

function ledger(): HostCronLedger {
  return new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice' })
}

const CREATE = {
  kind: 'create' as const,
  id: 'job-new',
  input: {
    name: 'New',
    cron: '0 9 * * *',
    action: { kind: 'agent' as const, prompt: 'do the thing' },
    enabled: true,
  },
}

const ledgerPath = (): string => join(dir, 'cron', 'ledger.json')

/** A persisted document holding one job that must survive every failure path. */
function writeValidLedger(): Buffer {
  const document = {
    schemaVersion: 2,
    revision: 7,
    jobs: [{
      id: 'job-keepme',
      name: 'keep me',
      cron: '0 9 * * *',
      action: { kind: 'agent', prompt: 'precious prompt' },
      enabled: true,
      owner: 'alice',
      executions: [],
      createdAt: 1,
      updatedAt: 1,
    }],
    scheduler: { timeZone: 'UTC' },
    recentRequests: [],
  }
  mkdirSync(join(dir, 'cron'), { recursive: true })
  writeFileSync(ledgerPath(), JSON.stringify(document), 'utf8')
  return readFileSync(ledgerPath())
}

describe('CR-1 ledger load errno discrimination', () => {
  it('ENOENT is the only legitimate empty ledger and carries the first-run marker', () => {
    const host = ledger()
    // The marker the audit asked for: an empty ledger that is *known* to be a
    // first run, not an unreadable file presented as empty.
    expect(host.loadMode()).toBe('first-run')
    expect(host.readOnlyReason()).toBeUndefined()
    expect(host.state().jobs).toHaveLength(0)

    // And it is writable: a genuine first run must be able to create the file.
    host.applyRequest('r1', CREATE)
    expect(host.state().jobs.map(job => job.id)).toEqual(['job-new'])
    expect(existsSync(ledgerPath())).toBe(true)
    host.dispose()

    // A later process reads it as a normal load, not as another first run.
    const restarted = ledger()
    expect(restarted.loadMode()).toBe('loaded')
    expect(restarted.state().jobs.map(job => job.id)).toEqual(['job-new'])
    restarted.dispose()
  })

  it('EISDIR (ledger.json is a symlink to a directory) degrades to read-only instead of replacing it', () => {
    mkdirSync(join(dir, 'cron'), { recursive: true })
    // `ledger.json -> .` (its own directory): open(2) succeeds, read(2) fails
    // with EISDIR, while renameSync(tmp, ledger.json) would replace the *link*.
    symlinkSync('.', ledgerPath())
    // Control probe: the path really answers EISDIR — not ENOENT, not a mock.
    let errno: string | undefined
    try { readFileSync(ledgerPath(), 'utf8') } catch (error) { errno = (error as NodeJS.ErrnoException).code }
    expect(errno).toBe('EISDIR')

    const host = ledger()
    expect(host.loadMode()).toBe('read-only')
    expect(host.readOnlyReason()).toContain('EISDIR')
    expect(host.readOnlyReason()).toContain(ledgerPath())
    // Visible in the snapshot: the panel must not render this as "reset to empty".
    expect(host.state().scheduler.readOnly).toBe(true)
    expect(host.state().scheduler.error).toBe(host.readOnlyReason())
    expect(host.state().jobs).toHaveLength(0)

    // Every write is refused loudly, before it can reach the disk.
    expect(() => host.applyRequest('r1', CREATE)).toThrowError(/ledger is read-only/)
    expect(() => host.setScheduler({ lastTickAt: Date.now() })).toThrowError(/ledger is read-only/)
    expect(host.state().jobs).toHaveLength(0)

    // The unreadable path is still there, untouched: no rename over it.
    expect(lstatSync(ledgerPath()).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(dir, 'cron')).filter(name => name.includes('.tmp-') || name.includes('.corrupt-'))).toEqual([])
    host.dispose()
  })

  it.skipIf(!CAN_FORCE_EACCES)('a real EACCES on the ledger file degrades to read-only, refuses the write, and leaves the bytes untouched', () => {
    const before = writeValidLedger()
    // The file stays unreadable while the directory stays writable (exactly the
    // audit's reproduction): the lock file and the rename target are reachable,
    // so a broken implementation really does destroy the stored jobs.
    chmodSync(join(dir, 'cron'), 0o777)
    chmodSync(ledgerPath(), 0o000)
    const argv = ROOT
      ? [SETPRIV, '--bounding-set=-dac_override,-dac_read_search', '--inh-caps=-all', '--ambient-caps=-all', process.execPath, PROBE, dir]
      : [process.execPath, PROBE, dir]
    const child = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    expect(child.error, `spawn failed: ${String(child.error)}`).toBeUndefined()
    expect(child.status, `probe exited ${String(child.status)}: ${child.stderr}`).toBe(0)
    const report = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {
      opened?: boolean
      openError?: string
      loadMode?: string
      readOnlyReason?: string | null
      mutationThrew?: boolean
      mutationError?: string
      jobsAfter?: number
    }

    expect(report.opened).toBe(true)
    expect(report.loadMode).toBe('read-only')
    expect(report.readOnlyReason).toContain('EACCES')
    expect(report.readOnlyReason).toContain(ledgerPath())
    expect(report.mutationThrew).toBe(true)
    expect(report.mutationError).toContain('ledger is read-only')
    expect(report.jobsAfter).toBe(0)

    // console.error names the file and the errno, and the stored bytes survive.
    expect(child.stderr).toContain('EACCES')
    expect(child.stderr).toContain(ledgerPath())
    expect(readFileSync(ledgerPath())).toEqual(before)
    expect(readdirSync(join(dir, 'cron')).filter(name => name.includes('.tmp-') || name.includes('.corrupt-'))).toEqual([])
  })

  it('isolates a corrupt ledger as .corrupt-<ts> before allowing any write', () => {
    mkdirSync(join(dir, 'cron'), { recursive: true })
    writeFileSync(ledgerPath(), '{ not json', 'utf8')
    const corrupt = readFileSync(ledgerPath())

    const host = ledger()
    expect(host.loadMode()).toBe('reset-corrupt')
    expect(host.readOnlyReason()).toBeUndefined()
    expect(host.state().scheduler.readOnly).toBeUndefined()
    expect(host.state().scheduler.error).toMatch(/corrupt/)

    const backups = readdirSync(join(dir, 'cron')).filter(name => name.includes('.corrupt-'))
    expect(backups).toHaveLength(1)
    // The original bytes are the backup: nothing was silently dropped.
    expect(readFileSync(join(dir, 'cron', backups[0]!))).toEqual(corrupt)

    // Only now may the ledger be written again.
    host.applyRequest('r1', CREATE)
    expect(host.state().jobs.map(job => job.id)).toEqual(['job-new'])
    expect(existsSync(ledgerPath())).toBe(true)
    host.dispose()
  })

  it('stays read-only when the corrupt bytes cannot be isolated (never overwrites the only copy)', () => {
    mkdirSync(join(dir, 'cron'), { recursive: true })
    writeFileSync(ledgerPath(), '{ not json', 'utf8')
    const before = readFileSync(ledgerPath())
    // Freeze the clock so the `.corrupt-<ts>` name is known, and squat it with a
    // NON-EMPTY directory: rename(2) onto a non-empty directory fails with a real
    // syscall error for every uid (no mock, no root-only permission trick).
    const frozen = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(frozen)
    const squat = `${ledgerPath()}.corrupt-${frozen}`
    mkdirSync(squat)
    writeFileSync(join(squat, 'keep.txt'), 'occupied', 'utf8')

    const host = ledger()
    expect(host.loadMode()).toBe('read-only')
    expect(host.readOnlyReason()).toMatch(/cannot isolate/)
    expect(host.state().scheduler.readOnly).toBe(true)
    expect(() => host.applyRequest('r1', CREATE)).toThrowError(/ledger is read-only/)

    // The only copy of the (corrupt but recoverable) bytes is still in place.
    expect(readFileSync(ledgerPath())).toEqual(before)
    expect(lstatSync(squat).isDirectory()).toBe(true)
    expect(readdirSync(join(dir, 'cron')).filter(name => name.includes('.tmp-'))).toEqual([])
    host.dispose()
  })
})
