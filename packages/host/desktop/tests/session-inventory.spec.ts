import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectSessionInventory,
  SESSION_INVENTORY_SCHEMA_VERSION,
  type SessionInventorySession,
} from '../src/session-inventory.ts'

/** Create `<root>/sessions/<project>/<id>/` and return the session directory. */
function sessionDir(root: string, project: string, id: string): string {
  const directory = join(root, 'sessions', project, id)
  mkdirSync(directory, { recursive: true })
  return directory
}

function byId(inventory: { sessions: readonly SessionInventorySession[] }, id: string): SessionInventorySession {
  const entry = inventory.sessions.find(session => session.id === id)
  if (entry === undefined) throw new Error(`session ${id} is missing from the inventory`)
  return entry
}

describe('collectSessionInventory', () => {
  it('describes every generation of a multi-generation session directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inv-'))
    const migrated = sessionDir(root, '--data-repo--', 'session-migrated')
    writeFileSync(join(migrated, 'session.jsonl.zstd'), Buffer.alloc(12, 1))
    writeFileSync(join(migrated, 'session.v3.jsonl.zstd'), Buffer.alloc(34, 2))
    writeFileSync(join(migrated, 'session.lock'), '')
    // Non-generation files must not appear in the inventory.
    writeFileSync(join(migrated, 'session.jsonl.zstd.tmp'), 'scratch')
    writeFileSync(join(migrated, 'notes.txt'), 'foreign')
    utimesSync(join(migrated, 'session.v3.jsonl.zstd'), new Date('2026-09-12T01:02:03Z'), new Date('2026-09-12T01:02:03Z'))
    const fresh = sessionDir(root, '--data-repo--', 'session-fresh')
    writeFileSync(join(fresh, 'session.v3.jsonl.zstd'), Buffer.alloc(5, 3))

    const inventory = collectSessionInventory(join(root, 'sessions'))

    expect(inventory.schemaVersion).toBe(SESSION_INVENTORY_SCHEMA_VERSION)
    expect(inventory.available).toBe(true)
    expect(inventory.truncated).toBe(false)
    expect(Number.isNaN(Date.parse(inventory.generatedAt))).toBe(false)
    expect(inventory.privacy).toContain('never')

    const migratedEntry = byId(inventory, 'session-migrated')
    expect(migratedEntry.project).toBe('--data-repo--')
    expect(migratedEntry.lockPresent).toBe(true)
    expect(migratedEntry.files.map(file => file.name)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    expect(migratedEntry.files[0]).toMatchObject({ bytes: 12 })
    expect(migratedEntry.files[0]?.generation).toBeUndefined()
    expect(migratedEntry.files[1]).toMatchObject({ bytes: 34, generation: 3 })
    expect(migratedEntry.files[1]?.modifiedAt).toBe('2026-09-12T01:02:03.000Z')

    const freshEntry = byId(inventory, 'session-fresh')
    expect(freshEntry.lockPresent).toBe(false)
    expect(freshEntry.files.map(file => file.generation)).toEqual([3])

    expect(inventory.totals).toEqual({ sessions: 2, files: 3, bytes: 51 })
  })

  it('returns an empty inventory instead of failing when the sessions directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inv-absent-'))

    const inventory = collectSessionInventory(join(root, 'sessions'))

    expect(inventory.available).toBe(false)
    expect(inventory.sessions).toEqual([])
    expect(inventory.totals).toEqual({ sessions: 0, files: 0, bytes: 0 })
    expect(inventory.truncated).toBe(false)
  })

  it('truncates and flags the inventory when a bound is reached', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inv-limit-'))
    const first = sessionDir(root, '--a--', 'session-1')
    writeFileSync(join(first, 'session.jsonl.zstd'), Buffer.alloc(10, 1))
    writeFileSync(join(first, 'session.v3.jsonl.zstd'), Buffer.alloc(10, 2))
    const second = sessionDir(root, '--b--', 'session-2')
    writeFileSync(join(second, 'session.v3.jsonl.zstd'), Buffer.alloc(10, 3))

    const bySessions = collectSessionInventory(join(root, 'sessions'), { limits: { maxSessions: 1 } })
    expect(bySessions.sessions).toHaveLength(1)
    expect(bySessions.truncated).toBe(true)

    const byFiles = collectSessionInventory(join(root, 'sessions'), { limits: { maxFilesPerSession: 1 } })
    expect(byFiles.truncated).toBe(true)
    expect(byId(byFiles, 'session-1').files).toHaveLength(1)

    const byBytes = collectSessionInventory(join(root, 'sessions'), { limits: { maxScannedBytes: 10 } })
    expect(byBytes.truncated).toBe(true)
    expect(byBytes.totals.bytes).toBeLessThanOrEqual(20)

    const unlimited = collectSessionInventory(join(root, 'sessions'))
    expect(unlimited.truncated).toBe(false)
    expect(unlimited.totals).toEqual({ sessions: 2, files: 3, bytes: 30 })
  })

  it('skips linked session directories instead of walking outside the session root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inv-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-inv-outside-'))
    writeFileSync(join(outside, 'session.v3.jsonl.zstd'), Buffer.alloc(4, 9))
    mkdirSync(join(root, 'sessions', '--data-repo--'), { recursive: true })
    symlinkSync(outside, join(root, 'sessions', '--data-repo--', 'session-linked'), 'dir')

    const inventory = collectSessionInventory(join(root, 'sessions'))

    expect(inventory.sessions).toEqual([])
    expect(inventory.totals.files).toBe(0)
  })
})
