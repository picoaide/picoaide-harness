import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { exportDiagnosticsZip } from '../src/diagnostic-export.ts'

describe('exportDiagnosticsZip', () => {
  it('produces a zip containing the log files and system info', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dx-'))
    writeFileSync(join(dir, 'dsh-2026-08-16.log'), 'hello\n')
    const out = await exportDiagnosticsZip(dir, dir)
    expect(existsSync(out)).toBe(true)
    expect(out.endsWith('.zip')).toBe(true)

    const zip = new AdmZip(out)
    const names = zip.getEntries().map(entry => entry.entryName)
    expect(names).toContain('dsh-2026-08-16.log')
    expect(names).toContain('system-info.txt')
    expect(zip.readAsText('dsh-2026-08-16.log')).toBe('hello\n')
    expect(zip.readAsText('system-info.txt')).toContain('platform:')
  })
})
