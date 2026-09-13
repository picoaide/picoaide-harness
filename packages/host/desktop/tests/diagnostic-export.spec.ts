import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import {
  exportDesktopDiagnostics,
  exportDiagnosticsZip,
  waitForDiagnosticExportWorker,
} from '../src/diagnostic-export.ts'
import {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  applyInstallDshHome,
  channelDshHomeDir,
} from '../src/desktop-home.ts'

const APP_VERSION = '2.0.1-test'

describe('exportDiagnosticsZip', () => {
  it('terminates a diagnostic Worker that does not respond before its deadline', async () => {
    const worker = new Worker('setInterval(() => {}, 1_000)', { eval: true })
    const exited = once(worker, 'exit')

    try {
      await expect(waitForDiagnosticExportWorker(worker, 25))
        .rejects.toThrow('diagnostic export worker timed out after 25ms')
      await expect(exited).resolves.toEqual(expect.any(Array))
    } finally {
      await worker.terminate()
    }
  })

  it('produces a zip containing the log files and system info', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dx-'))
    writeFileSync(join(dir, 'dsh-2026-08-16.log'), 'hello\n')
    const out = await exportDiagnosticsZip(dir, dir, { appVersion: APP_VERSION })
    expect(existsSync(out)).toBe(true)
    expect(out.endsWith('.zip')).toBe(true)

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName)
    expect(names).toContain('dsh-2026-08-16.log')
    expect(names).toContain('system-info.txt')
    expect(zip.readAsText('dsh-2026-08-16.log')).toBe('hello\n')
    expect(zip.readAsText('system-info.txt')).toContain('platform:')
    expect(zip.readAsText('system-info.txt')).toContain(`desktop-version: ${APP_VERSION}`)
  })

  it('exports recovery evidence even when the application never created a log directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-recovery-'))
    const crashEvidence = join(root, 'crash-evidence')
    mkdirSync(crashEvidence)
    writeFileSync(join(crashEvidence, 'active-run.json'), '{"version":"2.0.1"}\n')

    const out = await exportDesktopDiagnostics(root, {
      appVersion: APP_VERSION,
      // Explicit root keeps the test off the developer's real <DSH_HOME>/sessions.
      sessionsDir: join(root, 'sessions'),
    })

    const zip = new AdmZip(out)
    expect(zip.readAsText('crash-evidence/active-run.json')).toBe('{"version":"2.0.1"}\n')
    expect(zip.readAsText('system-info.txt')).toContain('included-active-run-marker: true')
    expect(existsSync(join(root, 'logs'))).toBe(true)
  })

  it('adds session generation metadata without exporting the session logs themselves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-sessions-'))
    const logs = join(root, 'logs')
    const sessions = join(root, 'sessions')
    const session = join(sessions, '--data-repo--', 'session-migrated')
    mkdirSync(logs)
    mkdirSync(session, { recursive: true })
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'owned\n')
    writeFileSync(join(session, 'session.jsonl.zstd'), 'private-v0-session-body')
    writeFileSync(join(session, 'session.v3.jsonl.zstd'), 'private-v3-session-body')
    writeFileSync(join(session, 'session.lock'), '')

    const out = await exportDiagnosticsZip(logs, root, {
      appVersion: APP_VERSION,
      sessionsDir: sessions,
    })

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName)
    expect(names).toContain('session-inventory.json')
    expect(names).not.toContain('session.jsonl.zstd')
    expect(names.some(name => name.includes('session.jsonl'))).toBe(false)
    const inventory = JSON.parse(zip.readAsText('session-inventory.json')) as {
      schemaVersion: number
      available: boolean
      sessions: Array<{ project: string, id: string, lockPresent: boolean, files: Array<{ name: string }> }>
      truncated: boolean
    }
    expect(inventory.schemaVersion).toBe(1)
    expect(inventory.available).toBe(true)
    expect(inventory.truncated).toBe(false)
    expect(inventory.sessions).toHaveLength(1)
    expect(inventory.sessions[0]).toMatchObject({ project: '--data-repo--', id: 'session-migrated', lockPresent: true })
    expect(inventory.sessions[0]?.files.map(file => file.name))
      .toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    const info = zip.readAsText('system-info.txt')
    expect(info).toContain('included-session-inventory: true')
    expect(info).toContain('session-inventory-sessions: 1')
    expect(info).toContain('session-inventory-files: 2')
    expect(info).toContain('session-inventory-truncated: false')
    expect(zip.readAsText('session-inventory.json')).not.toContain('private-v0-session-body')
    expect(zip.readAsText('session-inventory.json')).not.toContain('private-v3-session-body')
  })

  it('inventories only this installation\'s sessions for the channel --export-diagnostics path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dx-install-'))
    const channelRoot = join(home, '.acme-harness')
    // 同机两套安装:官方根与渠道根各有自己的会话。
    const officialSession = join(home, PRODUCT_DSH_HOME_DIR, 'sessions', 'official-project', 'sess-official-1')
    const channelSession = join(channelRoot, 'sessions', 'channel-project', 'sess-channel-1')
    mkdirSync(officialSession, { recursive: true })
    mkdirSync(channelSession, { recursive: true })
    writeFileSync(join(officialSession, 'session.jsonl'), '{"type":"message"}\n')
    writeFileSync(join(channelSession, 'session.jsonl'), '{"type":"message"}\n')

    // 早退分支与 start() 同一口径:按渠道包的 desktop.home_dir 解析本安装的数据根。
    const env: Record<string, string | undefined> = {}
    expect(applyInstallDshHome({
      productDir: channelDshHomeDir('acme', { slug: 'Acme-Harness' }),
      env,
      home,
    })).toBe(channelRoot)
    expect(env[DSH_HOME_ENV]).toBe(channelRoot)

    // 导出时进程环境里没有 DSH_HOME(渠道客户端正常启动前就是这样,start() 还没
    // 写回):修复前导出器会回落到官方根,把另一套安装的会话列进支持包。
    const previousHome = process.env.HOME
    const previousDshHome = process.env.DSH_HOME
    process.env.HOME = home
    delete process.env.DSH_HOME
    try {
      const userData = join(home, 'config', 'Acme Harness (acme)')
      const archive = await exportDesktopDiagnostics(userData, {
        appVersion: APP_VERSION,
        crashDumpsDir: join(userData, 'Crashpad'),
        installHomeDir: channelRoot,
      })
      const inventory = JSON.parse(new AdmZip(archive).readAsText('session-inventory.json')) as {
        available: boolean
        sessions: Array<{ id: string }>
      }
      expect(inventory.available).toBe(true)
      expect(inventory.sessions.map(session => session.id)).toEqual(['sess-channel-1'])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
    }
  })

  it('keeps the diagnostics archive and its directories owner-only (0600/0700) under a permissive umask', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-mode-'))
    // 宽松 umask 是默认环境:归档权限不能跟着 umask 走(adm-zip 会显式 chmod)。
    const previousUmask = process.umask(0o022)
    try {
      const userData = join(root, 'never-launched', 'PicoAide Harness')
      const archive = await exportDesktopDiagnostics(userData, {
        appVersion: APP_VERSION,
        sessionsDir: join(root, 'sessions'),
      })
      expect(existsSync(archive)).toBe(true)
      expect(statSync(archive).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(archive)).mode & 0o777).toBe(0o700)
      // 导出路径自己创建的 userData/logs 同样必须是私有目录。
      expect(statSync(join(userData, 'logs')).mode & 0o777).toBe(0o700)
      expect(statSync(userData).mode & 0o777).toBe(0o700)
    } finally {
      process.umask(previousUmask)
    }
  })

  it('includes local Crashpad minidumps but excludes unrelated crash files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-dump-'))
    const logs = join(root, 'logs')
    const crashes = join(root, 'Crashpad')
    const reports = join(crashes, 'reports')
    mkdirSync(logs)
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'before crash\n')
    writeFileSync(join(reports, 'crash-id.dmp'), 'minidump')
    writeFileSync(join(reports, 'metadata.json'), '{"secret":"ignored"}')

    const out = await exportDiagnosticsZip(logs, root, {
      appVersion: APP_VERSION,
      crashDumpsDir: crashes,
    })

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName).sort()
    expect(names).toContain('crash-dumps/reports/crash-id.dmp')
    expect(names).not.toContain('crash-dumps/reports/metadata.json')
    expect(zip.readAsText('crash-dumps/reports/crash-id.dmp')).toBe('minidump')
  })

  it('applies one archive byte limit across crash dumps and logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-dump-limit-'))
    const logs = join(root, 'logs')
    const crashes = join(root, 'Crashpad')
    mkdirSync(logs)
    mkdirSync(crashes)
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'sixsix')
    writeFileSync(join(crashes, 'latest.dmp'), 'eight888')

    const out = await exportDiagnosticsZip(logs, root, {
      appVersion: APP_VERSION,
      crashDumpsDir: crashes,
      maxEvidenceBytes: 10,
    })

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName)
    expect(names).toContain('crash-dumps/latest.dmp')
    expect(names).not.toContain('dsh-2026-08-16.log')
    expect(zip.readAsText('system-info.txt')).toContain('omitted-log-files: 1')
  })

  it('rejects a linked crash dump directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-dump-link-'))
    const logs = join(root, 'logs')
    const target = join(root, 'target')
    const crashes = join(root, 'Crashpad')
    mkdirSync(logs)
    mkdirSync(target)
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'owned\n')
    writeFileSync(join(target, 'crash.dmp'), 'minidump')
    symlinkSync(target, crashes, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(exportDiagnosticsZip(logs, root, {
      appVersion: APP_VERSION,
      crashDumpsDir: crashes,
    }))
      .rejects.toThrow(/linked crash dump directory/u)
  })

  it('archives only owned regular log files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dx-'))
    writeFileSync(join(dir, 'dsh-2026-08-16.error.log'), 'owned\n')
    writeFileSync(join(dir, 'notes.txt'), 'foreign\n')
    mkdirSync(join(dir, 'dsh-2020-01-01.log'))

    const out = await exportDiagnosticsZip(dir, dir, { appVersion: APP_VERSION })

    const names = new AdmZip(out).getEntries().map(entry => entry.entryName).sort()
    expect(names).toEqual(['dsh-2026-08-16.error.log', 'system-info.txt'])
  })

  it('rejects a linked diagnostics output directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-link-'))
    const logs = join(root, 'logs')
    const target = join(root, 'target')
    mkdirSync(logs)
    mkdirSync(target)
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'owned\n')
    symlinkSync(target, join(root, 'diagnostics'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(exportDiagnosticsZip(logs, root, { appVersion: APP_VERSION }))
      .rejects.toThrow(/linked diagnostics directory/u)
  })

  it('rejects a linked log directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-logs-link-'))
    const target = join(root, 'target')
    const logs = join(root, 'logs')
    mkdirSync(target)
    writeFileSync(join(target, 'dsh-2026-08-16.log'), 'owned\n')
    symlinkSync(target, logs, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(exportDiagnosticsZip(logs, root, { appVersion: APP_VERSION }))
      .rejects.toThrow(/linked log directory/u)
  })

  it('retains only the three newest diagnostics archives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-retain-'))
    const logs = join(root, 'logs')
    const diagnostics = join(root, 'diagnostics')
    mkdirSync(logs)
    mkdirSync(diagnostics)
    writeFileSync(join(logs, 'dsh-2026-08-16.log'), 'owned\n')
    for (let index = 1; index <= 3; index += 1) {
      const path = join(diagnostics, `diagnostics-${String(index)}.zip`)
      writeFileSync(path, `old ${String(index)}`)
      const modified = new Date(`2020-01-0${String(index)}T00:00:00Z`)
      utimesSync(path, modified, modified)
    }

    await exportDiagnosticsZip(logs, root, { appVersion: APP_VERSION })

    const archives = readdirSync(diagnostics).filter(name => name.endsWith('.zip')).sort()
    expect(archives).toHaveLength(3)
    expect(archives).not.toContain('diagnostics-1.zip')
  })

  it('includes only the newest logs that fit within the archive byte limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dx-limit-'))
    const logs = join(root, 'logs')
    mkdirSync(logs)
    const oldest = join(logs, 'dsh-2026-08-14.log')
    const middle = join(logs, 'dsh-2026-08-15.log')
    const newest = join(logs, 'dsh-2026-08-16.log')
    writeFileSync(oldest, 'oldest')
    writeFileSync(middle, 'middle')
    writeFileSync(newest, 'newest')
    utimesSync(oldest, new Date('2026-08-14T00:00:00Z'), new Date('2026-08-14T00:00:00Z'))
    utimesSync(middle, new Date('2026-08-15T00:00:00Z'), new Date('2026-08-15T00:00:00Z'))
    utimesSync(newest, new Date('2026-08-16T00:00:00Z'), new Date('2026-08-16T00:00:00Z'))

    const out = await exportDiagnosticsZip(logs, root, {
      appVersion: APP_VERSION,
      maxEvidenceBytes: 11,
    })

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName).sort()
    expect(names).toContain('dsh-2026-08-16.log')
    expect(names).not.toContain('dsh-2026-08-15.log')
    expect(names).not.toContain('dsh-2026-08-14.log')
    expect(zip.readAsText('system-info.txt')).toContain('omitted-log-files: 2')
  })
})
