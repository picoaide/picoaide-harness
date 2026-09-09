import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserGuard,
  classifyNavigation,
  MAX_DOWNLOAD_BYTES,
  navigationDenyReason,
} from '../src/guard.ts'
import type { DownloadRecorder } from '../src/guard.ts'
import type { NativeDownloadItem, NativeSession } from '../src/electron-adapter.ts'

describe('navigation policy', () => {
  it('allows https and http', () => {
    expect(classifyNavigation('https://example.com/a?b=1')).toBe('allow')
    expect(classifyNavigation('http://example.com')).toBe('allow')
  })

  it('allows about:blank', () => {
    expect(classifyNavigation('about:blank')).toBe('allow')
  })

  it('denies dangerous schemes', () => {
    expect(classifyNavigation('javascript:alert(1)')).toBe('deny')
    expect(classifyNavigation('data:text/html,<script>1</script>')).toBe('deny')
    expect(classifyNavigation('file:///etc/passwd')).toBe('deny')
    expect(classifyNavigation('chrome://settings')).toBe('deny')
    expect(classifyNavigation('vbscript:x')).toBe('deny')
  })

  it('denies empty, non-string and oversized URLs', () => {
    expect(classifyNavigation('')).toBe('deny')
    expect(classifyNavigation(42 as unknown as string)).toBe('deny')
    expect(classifyNavigation(`https://example.com/${'a'.repeat(9000)}`)).toBe('deny')
  })

  it('allows relative URLs (the page cannot escalate origin through them)', () => {
    expect(classifyNavigation('/relative/path')).toBe('allow')
  })

  it('produces a human-readable deny reason', () => {
    expect(navigationDenyReason('javascript:alert(1)')).toContain('javascript')
    expect(navigationDenyReason('')).toContain('empty or too long')
  })
})

describe('download bound', () => {
  it('caps downloads at 100MB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe('no browser approval seam (product decision 2026-08-26)', () => {
  it('guard.ts has no askApproval / requireApproval', () => {
    const source = readFileSync(new URL('../src/guard.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('askApproval')
    expect(source).not.toContain('requireApproval')
    expect(source).not.toContain("ctx.get('approval')")
  })

  it('tools.ts has no requireApproval calls', () => {
    const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('requireApproval')
    expect(source).not.toContain('not approved by the user')
  })

  it('index.ts does not wire the approval service', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("ctx.get('approval')")
    expect(source).not.toContain('dsh-user-approval')
  })
})

describe('download guard ref counting (2026-09-08 P0-5)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function fakeSession() {
    const listeners: Array<(event: unknown, item: NativeDownloadItem) => void> = []
    return {
      listeners,
      on(_event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
        listeners.push(listener)
      },
      removeListener(_event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      },
      emit(item: NativeDownloadItem): void {
        for (const listener of [...listeners]) listener({}, item)
      },
    }
  }

  function fakeItem(): NativeDownloadItem {
    return {
      getFilename: () => 'report.txt',
      getURL: () => 'https://example.com/report.txt',
      getReceivedBytes: () => 0,
      getTotalBytes: () => 10,
      setSavePath: () => {},
      cancel: () => {},
      on: () => {},
    } as unknown as NativeDownloadItem
  }

  it('keeps the shared session listener until the LAST tab releases it', () => {
    const guard = new BrowserGuard({} as never)
    const session = fakeSession()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-downloads-'))
    dirs.push(dir)
    const added: Array<{ fileName: string, actor?: string }> = []
    const recorder: DownloadRecorder = {
      add: (entry) => { added.push(entry); return added.length },
      update: () => {},
    }
    const native = session as unknown as NativeSession
    const disposeFirst = guard.installDownloadGuard(native, () => {}, recorder, '', 'user', dir)
    const disposeSecond = guard.installDownloadGuard(native, () => {}, recorder, '', 'ai', dir)
    expect(session.listeners).toHaveLength(1)
    // Closing the first tab must NOT disable interception for the rest.
    disposeFirst()
    expect(session.listeners).toHaveLength(1)
    session.emit(fakeItem())
    expect(added).toHaveLength(1)
    // The most recent registration owns the recorder context (a download has
    // no tab identity, so first-tab-forever attribution was wrong).
    expect(added[0]?.actor).toBe('ai')
    disposeSecond()
    expect(session.listeners).toHaveLength(0)
    session.emit(fakeItem())
    expect(added).toHaveLength(1)
  })
})
