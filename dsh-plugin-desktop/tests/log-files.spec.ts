import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LogFileSink, logFileName } from '../src/log-files.ts'

function todaySuffix(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function sink(maxFileBytes = 10 * 1024 * 1024, maxDirectoryBytes = 200 * 1024 * 1024): { s: LogFileSink; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  return { s: new LogFileSink(dir, { maxFileBytes, maxDirectoryBytes }), dir }
}

describe('logFileName', () => {
  it('names the full and error logs by date and segment', () => {
    expect(logFileName('2026-08-16', false, 0)).toBe('dsh-2026-08-16.log')
    expect(logFileName('2026-08-16', true, 0)).toBe('dsh-2026-08-16.error.log')
    expect(logFileName('2026-08-16', false, 2)).toBe('dsh-2026-08-16.2.log')
  })
})

describe('LogFileSink', () => {
  it('writes info to the full log only, and errors to both logs', () => {
    const { s, dir } = sink()
    s.write('info', 'hello info')
    s.write('error', 'hello error')
    s.close()
    const day = todaySuffix()
    expect(readdirSync(dir).sort()).toEqual([`dsh-${day}.error.log`, `dsh-${day}.log`])
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toBe('hello info\nhello error\n')
    expect(readFileSync(join(dir, `dsh-${day}.error.log`), 'utf8')).toBe('hello error\n')
  })

  it('rotates a file when it exceeds the per-file cap', () => {
    const { s, dir } = sink(10)
    s.write('info', 'x'.repeat(8))
    s.write('info', 'y'.repeat(8))
    s.close()
    const day = todaySuffix()
    const files = readdirSync(dir).filter(f => !f.includes('.error')).sort()
    expect(files).toEqual([`dsh-${day}.1.log`, `dsh-${day}.log`])
  })

  it('clear removes all files and reopens fresh streams', () => {
    const { s, dir } = sink()
    s.write('info', 'first')
    s.clear()
    s.write('info', 'second')
    s.close()
    const day = todaySuffix()
    expect(readFileSync(join(dir, `dsh-${day}.log`), 'utf8')).toBe('second\n')
  })
})
