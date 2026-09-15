import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserGuard,
  classifyNavigation,
  installPermissionGuard,
  MAX_DOWNLOAD_BYTES,
  navigationDenyReason,
  resolveDownloadPath,
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

describe('permission guard installs BOTH Electron handlers (2026-09-11)', () => {
  it('denies permission checks as well as permission requests', () => {
    const requestHandlers: Array<(wc: unknown, permission: string, callback: (grant: boolean) => void) => void> = []
    let check: ((wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | undefined
    const session = {
      setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (grant: boolean) => void) => void) {
        requestHandlers.push(handler)
      },
      setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) {
        check = handler
      },
    } as unknown as NativeSession

    const dispose = installPermissionGuard(session)
    expect(requestHandlers).toHaveLength(1)
    // Electron's check handler defaults to GRANTING when unset, and Chromium
    // only reaches the request handler when the check is denied — a request
    // handler alone is dead code.
    expect(check).toBeTypeOf('function')
    expect(check?.({}, 'media', 'https://evil.example', {})).toBe(false)
    expect(check?.({}, 'geolocation', 'https://evil.example', {})).toBe(false)
    let granted: boolean | undefined
    requestHandlers[0]?.({}, 'media', (value) => { granted = value })
    expect(granted).toBe(false)
    dispose()
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

describe('下载文件名净化（2026-09-15 审计 P2-6）', () => {
  it('Windows 保留设备名 / 结尾点与空格不会静默丢失或覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-dl-'))
    try {
      // Windows 会把 join(dir,'NUL') 解析成 NUL 设备：下载"成功"但盘上零字节
      expect(basename(resolveDownloadPath(dir, 'NUL'))).toBe('_NUL')
      expect(basename(resolveDownloadPath(dir, 'nul.txt'))).toBe('_nul.txt')
      expect(basename(resolveDownloadPath(dir, 'COM1.pdf'))).toBe('_COM1.pdf')
      expect(basename(resolveDownloadPath(dir, 'lpt9'))).toBe('_lpt9')
      // 结尾点/空格会被系统裁掉 ⇒ existsSync('foo.') 为假，会覆盖已存在的 foo
      expect(basename(resolveDownloadPath(dir, '报告.'))).toBe('报告')
      expect(basename(resolveDownloadPath(dir, 'name. '))).toBe('name')
      // 空名/纯符号兜底成可用名字
      expect(basename(resolveDownloadPath(dir, '..'))).toBe('download')
      expect(basename(resolveDownloadPath(dir, '  '))).toBe('download')
      // 正常名字不受影响；非法字符照旧替换
      expect(basename(resolveDownloadPath(dir, '报告.pdf'))).toBe('报告.pdf')
      expect(basename(resolveDownloadPath(dir, 'x|y?.zip'))).toBe('x_y_.zip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
})
