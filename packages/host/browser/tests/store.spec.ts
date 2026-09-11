import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserStore, stripSensitiveUrl } from '../src/store.ts'

/**
 * Each test gets a unique throwaway directory under tests/ (created via
 * mkdtempSync so even load:false stores get a fresh, existing directory).
 */
function freshDir(): string {
  return mkdtempSync(join(process.cwd(), 'tests/.store-tmp-'))
}

describe('stripSensitiveUrl', () => {
  it('masks sensitive query parameters', () => {
    expect(stripSensitiveUrl('https://example.com/p?token=abc&id=1')).toBe('https://example.com/p?token=****&id=1')
    expect(stripSensitiveUrl('https://example.com/p?code=abc&q=x')).toBe('https://example.com/p?code=****&q=x')
    expect(stripSensitiveUrl('https://example.com/p?apiKey=abc&password=pw&name=n')).toBe(
      'https://example.com/p?apiKey=****&password=****&name=n',
    )
    expect(stripSensitiveUrl('https://example.com/p?auth_token=xyz&secret=1&n=2')).toBe(
      'https://example.com/p?auth_token=****&secret=****&n=2',
    )
  })

  it('preserves non-sensitive parameters', () => {
    expect(stripSensitiveUrl('https://example.com/p?q=hello&id=2')).toBe('https://example.com/p?q=hello&id=2')
  })

  it('masks userinfo credentials and fragment tokens (2026-09-11)', () => {
    expect(stripSensitiveUrl('https://alice:s3cret@example.com/cb')).toBe('https://****:****@example.com/cb')
    expect(stripSensitiveUrl('https://example.com/cb#access_token=eyJhbGci&state=x')).toBe(
      'https://example.com/cb#access_token=****&state=x',
    )
    expect(stripSensitiveUrl('https://example.com/cb#/route?code=abc&q=1')).toBe(
      'https://example.com/cb#/route?code=****&q=1',
    )
    // Plain route fragments carry no pairs and stay untouched.
    expect(stripSensitiveUrl('https://example.com/#/inbox/42')).toBe('https://example.com/#/inbox/42')
  })

  it('returns invalid input unchanged (never throws)', () => {
    expect(stripSensitiveUrl('not a url')).toBe('not a url')
    expect(stripSensitiveUrl('')).toBe('')
    expect(stripSensitiveUrl('http://')).toBe('http://')
    expect(stripSensitiveUrl('a b c')).toBe('a b c')
  })
})

describe('BrowserStore history', () => {
  let dir: string
  let store: BrowserStore

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('assigns increasing seq numbers', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const now = Date.now()
    const e1 = store.addHistory({ time: now, url: 'https://example.com/1', title: 'one', actor: 'ai', group: 'g1' })
    const e2 = store.addHistory({ time: now + 1, url: 'https://example.com/2', title: 'two', actor: 'user', group: 'g1' })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e2.time).toBe(now + 1)
  })

  it('strips sensitive query params before storing', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const e = store.addHistory({
      time: Date.now(),
      url: 'https://example.com/s?token=abc&q=hello&code=9',
      title: 't',
      actor: 'ai',
      group: 'g',
    })
    expect(e.url).toBe('https://example.com/s?token=****&q=hello&code=****')
  })

  it('filters by q / group / actor / limit, newest first', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const now = Date.now()
    store.addHistory({ time: now - 2, url: 'https://example.com/alpha', title: 'Alpha page', actor: 'ai', group: 'g1' })
    store.addHistory({ time: now - 1, url: 'https://example.com/beta', title: 'Beta page', actor: 'user', group: 'g2' })
    store.addHistory({ time: now, url: 'https://example.com/gamma?token=t', title: 'Gamma page', actor: 'ai', group: 'g1' })

    expect(store.queryHistory({ q: 'beta' }).map((e) => e.title)).toEqual(['Beta page'])
    expect(store.queryHistory({ q: 'PAGE' }).length).toBe(3) // case-insensitive over url+title
    expect(store.queryHistory({ group: 'g1' }).map((e) => e.url)).toEqual([
      'https://example.com/gamma?token=****',
      'https://example.com/alpha',
    ])
    expect(store.queryHistory({ actor: 'user' }).map((e) => e.url)).toEqual(['https://example.com/beta'])
    expect(store.queryHistory({ limit: 2 }).length).toBe(2)
    expect(store.queryHistory({ limit: 1 })[0]?.url).toBe('https://example.com/gamma?token=****')
  })

  it('filters within a since/until time window', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const now = Date.now()
    store.addHistory({ time: now - 2000, url: 'https://example.com/a', title: 'a', actor: 'ai', group: 'g' })
    store.addHistory({ time: now - 1000, url: 'https://example.com/b', title: 'b', actor: 'ai', group: 'g' })
    expect(store.queryHistory({ since: now - 1500, until: now }).map((e) => e.url)).toEqual(['https://example.com/b'])
    expect(store.queryHistory({ since: now - 1, until: now })).toEqual([])
  })

  it('prunes history beyond historyLimit (passed via options)', () => {
    dir = freshDir()
    store = new BrowserStore({ dir, historyLimit: 5 })
    const now = Date.now()
    for (let i = 0; i < 8; i++) {
      store.addHistory({
        time: now - (8 - i) * 10,
        url: `https://example.com/${i}`,
        title: `t${i}`,
        actor: 'ai',
        group: 'g',
      })
    }
    expect(store.counts().history).toBe(5)
    expect(store.queryHistory({ limit: 100 }).map((e) => e.url)).toEqual([
      'https://example.com/7',
      'https://example.com/6',
      'https://example.com/5',
      'https://example.com/4',
      'https://example.com/3',
    ])
  })

  it('prunes history outside the retention window (historyWindowMs)', () => {
    dir = freshDir()
    store = new BrowserStore({ dir, historyWindowMs: 1000 })
    store.addHistory({ time: Date.now() - 5000, url: 'https://example.com/old', title: 'old', actor: 'ai', group: 'g' })
    store.addHistory({ time: Date.now(), url: 'https://example.com/new', title: 'new', actor: 'ai', group: 'g' })
    expect(store.counts().history).toBe(1)
    expect(store.queryHistory({ limit: 100 }).map((e) => e.url)).toEqual(['https://example.com/new'])
  })
})

describe('BrowserStore bookmarks', () => {
  let dir: string
  let store: BrowserStore

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is idempotent per URL: re-bookmark updates, never duplicates', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const first = store.addBookmark({ url: 'https://example.com/a', title: 'A', actor: 'ai', group: 'g' })
    const second = store.addBookmark({ url: 'https://example.com/a', title: 'A2', actor: 'user', group: 'g' })
    expect(store.counts().bookmarks).toBe(1)
    expect(second.id).toBe(first.id)
    expect(second.title).toBe('A2')
    expect(second.actor).toBe('user')
  })

  it('removes a bookmark by id (idempotent: unknown id → false)', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const b = store.addBookmark({ url: 'https://example.com/a', title: 'A', actor: 'ai', group: 'g' })
    expect(store.removeBookmark(b.id)).toBe(true)
    expect(store.removeBookmark(b.id)).toBe(false)
    expect(store.counts().bookmarks).toBe(0)
    expect(store.queryBookmarks({})).toEqual([])
  })

  it('queries bookmarks by text (url + title, newest first)', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    store.addBookmark({ url: 'https://example.com/one', title: 'First', actor: 'ai', group: 'g' })
    store.addBookmark({ url: 'https://example.com/two', title: 'Second', actor: 'ai', group: 'g' })
    expect(store.queryBookmarks({ q: 'first' }).map((b) => b.url)).toEqual(['https://example.com/one'])
    expect(store.queryBookmarks({ q: 'example.com' }).length).toBe(2)
    expect(store.queryBookmarks({ limit: 1 }).length).toBe(1)
  })
})

describe('BrowserStore downloads', () => {
  let dir: string
  let store: BrowserStore

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds a download and updates status/path/size', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const d = store.addDownload({
      url: 'https://example.com/file.zip',
      fileName: 'file.zip',
      path: '',
      size: 12,
      actor: 'ai',
      group: 'g',
      status: 'in-progress',
    })
    expect(d.id).toBe(1)
    expect(d.status).toBe('in-progress')
    expect(d.url).toBe('https://example.com/file.zip')

    store.updateDownload(d.id, { status: 'done', path: '/tmp/file.zip', size: 42 })
    const [updated] = store.queryDownloads({ limit: 1 })
    expect(updated).toBeDefined()
    expect(updated?.status).toBe('done')
    expect(updated?.path).toBe('/tmp/file.zip')
    expect(updated?.size).toBe(42)

    // unknown id: no-op, never throws
    expect(() => store.updateDownload(999, { status: 'done' })).not.toThrow()
  })

  it('defaults to the done status when not provided', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const d = store.addDownload({ url: 'https://example.com/a', fileName: 'a', path: '', size: 0, actor: 'ai', group: 'g' })
    expect(d.status).toBe('done')
  })

  it('filters downloads by status, newest first', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    store.addDownload({ url: 'https://example.com/a', fileName: 'a', path: '', size: 0, actor: 'ai', group: 'g', status: 'done' })
    store.addDownload({ url: 'https://example.com/b', fileName: 'b', path: '', size: 0, actor: 'ai', group: 'g', status: 'in-progress' })
    store.addDownload({ url: 'https://example.com/c', fileName: 'c', path: '', size: 0, actor: 'ai', group: 'g', status: 'cancelled' })
    store.addDownload({ url: 'https://example.com/d', fileName: 'd', path: '', size: 0, actor: 'ai', group: 'g', status: 'rejected' })

    expect(store.queryDownloads({ status: 'done' }).map((d) => d.fileName)).toEqual(['a'])
    expect(store.queryDownloads({ status: 'in-progress' }).map((d) => d.fileName)).toEqual(['b'])
    expect(store.queryDownloads({ status: 'cancelled' }).map((d) => d.fileName)).toEqual(['c'])
    expect(store.queryDownloads({ status: 'rejected' }).map((d) => d.fileName)).toEqual(['d'])
    expect(store.queryDownloads({ status: 'done', limit: 1 }).length).toBe(1)
  })

  it('removes a download by id', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const d = store.addDownload({ url: 'https://example.com/a', fileName: 'a', path: '', size: 0, actor: 'ai', group: 'g' })
    expect(store.removeDownload(d.id)).toBe(true)
    expect(store.removeDownload(d.id)).toBe(false)
    expect(store.counts().downloads).toBe(0)
  })

  it('strips sensitive params from download urls', () => {
    dir = freshDir()
    store = new BrowserStore({ dir })
    const d = store.addDownload({
      url: 'https://example.com/dl?token=t&file=1',
      fileName: 'a',
      path: '',
      size: 0,
      actor: 'ai',
      group: 'g',
    })
    expect(d.url).toBe('https://example.com/dl?token=****&file=1')
  })
})

describe('BrowserStore group ledger + persistence', () => {
  const ledger = {
    version: 1 as const,
    groups: [
      {
        key: 'sess-abc123',
        label: 'Main session',
        status: 'active' as const,
        createdAt: 111,
        lastActiveAt: 222,
        activeTabId: 7,
        tabs: [{ tabId: 7, url: 'https://example.com', title: 'Example' }],
      },
    ],
    savedAt: 12345,
  }

  it('round-trips the group ledger via getGroupLedger/saveGroupLedger', () => {
    const dir = freshDir()
    try {
      const store = new BrowserStore({ dir })
      expect(store.getGroupLedger()).toBeUndefined()
      store.saveGroupLedger(ledger)
      expect(store.getGroupLedger()).toEqual(ledger)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('masks token-bearing tab urls in the persisted ledger (2026-09-11)', () => {
    const dir = freshDir()
    try {
      const store = new BrowserStore({ dir })
      store.saveGroupLedger({
        version: 1,
        activeTabId: 7,
        tabs: [{ tabId: 7, url: 'https://example.com/cb?code=abc#access_token=eyJhbGci', title: 'cb' }],
        savedAt: 12345,
      })
      const expected = 'https://example.com/cb?code=****#access_token=****'
      expect(store.getGroupLedger()?.tabs[0]?.url).toBe(expected)
      const reloaded = new BrowserStore({ dir })
      expect(reloaded.getGroupLedger()?.tabs[0]?.url).toBe(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads all collections from disk on rebuild (default load=true)', () => {
    const dir = freshDir()
    try {
      const store = new BrowserStore({ dir })
      store.addHistory({ time: Date.now(), url: 'https://example.com/h1?token=abc', title: 'h1', actor: 'ai', group: 'g' })
      const b = store.addBookmark({ url: 'https://example.com/b1', title: 'b1', actor: 'ai', group: 'g' })
      const d = store.addDownload({ url: 'https://example.com/d1', fileName: 'd1', path: '/x', size: 1, actor: 'ai', group: 'g', status: 'done' })
      store.saveGroupLedger(ledger)

      const reloaded = new BrowserStore({ dir })
      expect(reloaded.counts()).toEqual({ history: 1, bookmarks: 1, downloads: 1 })
      expect(reloaded.queryHistory({})[0]?.url).toBe('https://example.com/h1?token=****')
      expect(reloaded.queryBookmarks({})[0]?.id).toBe(b.id)
      expect(reloaded.queryDownloads({})[0]?.id).toBe(d.id)
      expect(reloaded.getGroupLedger()).toEqual(ledger)

      // seq/id counters continue after reload
      const next = reloaded.addHistory({ time: Date.now(), url: 'https://example.com/h2', title: 'h2', actor: 'ai', group: 'g' })
      expect(next.seq).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honours load=false then loads on demand', () => {
    const dir = freshDir()
    try {
      const writer = new BrowserStore({ dir })
      writer.addHistory({ time: Date.now(), url: 'https://example.com/x', title: 'x', actor: 'ai', group: 'g' })

      const lazy = new BrowserStore({ dir, load: false })
      expect(lazy.counts().history).toBe(0)
      lazy.load()
      expect(lazy.counts().history).toBe(1)
      expect(lazy.queryHistory({})[0]?.url).toBe('https://example.com/x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps ledger and collections in sync with per-file persistence', () => {
    const dir = freshDir()
    try {
      const store = new BrowserStore({ dir })
      store.saveGroupLedger(ledger)
      store.addBookmark({ url: 'https://example.com/b', title: 'b', actor: 'ai', group: 'g' })
      expect(store.fileSize('groups')).toBeGreaterThan(0)
      expect(store.fileSize('bookmarks')).toBeGreaterThan(0)
      expect(store.pathOf('groups')).toContain('groups.jsonl')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('stripSensitiveUrl 线性解析（CodeQL js/polynomial-redos 回归）', () => {
  it('fragment 掩码不再依赖回溯正则:大量重复字符快速返回', () => {
    // 命中敏感 key 时的正常掩码语义保持不变
    expect(stripSensitiveUrl('https://example.com/cb#access_token=abc')).toBe('https://example.com/cb#access_token=****')
    // ?/# 前缀不属于 key,前缀原样保留(与原正则行为一致)
    expect(stripSensitiveUrl('https://example.com/cb#/route?token=abc&q=1')).toBe('https://example.com/cb#/route?token=****&q=1')
    // 非敏感 key 不改写
    const big = `https://example.com/cb#${'a'.repeat(200_000)}`
    const started = Date.now()
    expect(stripSensitiveUrl(big)).toBe(big)
    expect(Date.now() - started).toBeLessThan(500)
    // 大量重复 '"' + '=' 的恶意形态必须快速返回,而不是多项式回溯
    const evil = `https://example.com/cb#${'"'.repeat(20_000)}=${'"'.repeat(20_000)}`
    const t0 = Date.now()
    stripSensitiveUrl(evil)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
