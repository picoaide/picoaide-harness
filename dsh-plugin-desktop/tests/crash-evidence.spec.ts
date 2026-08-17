import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { beginDesktopRun } from '../src/crash-evidence.ts'

describe('desktop crash evidence', () => {
  it('reports the previous run when it did not shut down cleanly', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })

    const next = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })

    expect(next.previousRun).toEqual({
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })
  })

  it('does not report a run that marked its shutdown clean', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    const run = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:00:00.000Z',
      pid: 41,
      version: '2.0.1',
    })

    expect(() => {
      run.markClean()
      run.markClean()
    }).not.toThrow()

    const next = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })
    expect(next.previousRun).toBeUndefined()
  })

  it('reports an unreadable previous marker without blocking the next run', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-run-')), 'active-run.json')
    writeFileSync(statePath, '{partial', 'utf8')

    const run = beginDesktopRun(statePath, {
      startedAt: '2026-08-18T00:01:00.000Z',
      pid: 42,
      version: '2.0.1',
    })

    expect(run.previousRun).toEqual({ unreadable: true })
    expect(() => run.markClean()).not.toThrow()
  })
})
