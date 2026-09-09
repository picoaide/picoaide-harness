/**
 * BrowserStore (v4 §8): per-user local durability for bookmarks, history,
 * downloads and the group ledger. Append-only JSONL files + in-memory index
 * (rebuilt on load with tail-truncation recovery); bounded retention; URLs
 * stripped of sensitive query parameters before any write; the store is
 * LOCAL (never synced) and shared across sessions with actor/group tags.
 * @module @picoaide/dsh-browser
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

/** Persisted tab ledger (v4.2 single pool): registry metadata + active tab.
 * Views are re-materialized by the runtime on restore. */
export interface BrowserLedger {
  version: 1
  activeTabId: number | undefined
  tabs: Array<{ tabId: number; url: string; title: string }>
  savedAt: number
}

/** Actor of a record. `restore` = a tab re-materialized from the persisted
 * ledger at boot/session switch (neither a fresh AI action nor a user click;
 * it must not surface the window or claim the agent's attribution). */
export type RecordActor = 'ai' | 'user' | 'restore'

export interface HistoryEntry {
  seq: number
  time: number
  url: string
  title: string
  actor: RecordActor
  group: string
}

export interface BookmarkEntry {
  id: number
  url: string
  title: string
  createdAt: number
  actor: RecordActor
  group: string
}

export interface DownloadEntry {
  id: number
  url: string
  fileName: string
  path: string
  size: number
  status: 'in-progress' | 'done' | 'cancelled' | 'rejected'
  createdAt: number
  actor: RecordActor
  group: string
}

export interface StoreOptions {
  /** Root directory for this user's browser store (userData/browser-store/<user>). */
  dir: string
  /** History retention: max entries (default 5000). */
  historyLimit?: number
  /** Bookmark cap (default 500). */
  bookmarkLimit?: number
  /** Download record cap (default 200). */
  downloadLimit?: number
  /** History retention window (ms, default 90 days). */
  historyWindowMs?: number
  /** In-memory index (tests can share across instances via reload). */
  load?: boolean
}

const DEFAULTS = {
  historyLimit: 5000,
  bookmarkLimit: 500,
  downloadLimit: 200,
  historyWindowMs: 90 * 24 * 60 * 60 * 1000,
} as const

/** Sensitive query params stripped before persistence (mirrors runtime mask). */
const SENSITIVE_QUERY_KEY = /(?:auth|code|credential|key|password|secret|signature|token)/iu

/** Strip sensitive query parameters from a URL (never throws). */
export function stripSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw)
    for (const name of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(name)) url.searchParams.set(name, '****')
    }
    return url.href
  } catch {
    return raw
  }
}

/** BrowserStore (see module doc). */
export class BrowserStore {
  private readonly history: HistoryEntry[] = []
  private readonly bookmarks: BookmarkEntry[] = []
  private readonly downloads: DownloadEntry[] = []
  private ledger: BrowserLedger | undefined
  private historySeq = 0
  private bookmarkSeq = 0
  private downloadSeq = 0
  readonly options: StoreOptions & Required<Pick<StoreOptions, 'historyLimit' | 'bookmarkLimit' | 'downloadLimit' | 'historyWindowMs'>>
  private loaded = false

  constructor(options: StoreOptions) {
    this.options = { ...DEFAULTS, ...options }
    if (options.load !== false) this.load()
  }

  // ------------------------------------------------------------------ files

  private filePath(name: string): string {
    return join(this.options.dir, `${name}.jsonl`)
  }

  /** Load all collection files (idempotent; call again to reload). */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    mkdirSync(this.options.dir, { recursive: true })
    this.history.length = 0
    this.bookmarks.length = 0
    this.downloads.length = 0
    this.historySeq = 0
    this.bookmarkSeq = 0
    this.downloadSeq = 0
    this.readCollection<HistoryEntry>('history', (entry) => {
      if (entry.seq > this.historySeq) this.historySeq = entry.seq
      this.history.push(entry)
    })
    this.readCollection<BookmarkEntry>('bookmarks', (entry) => {
      if (entry.id > this.bookmarkSeq) this.bookmarkSeq = entry.id
      this.bookmarks.push(entry)
    })
    this.readCollection<DownloadEntry>('downloads', (entry) => {
      if (entry.id > this.downloadSeq) this.downloadSeq = entry.id
      this.downloads.push(entry)
    })
    this.ledger = this.readLedger()
  }

  private readCollection<T>(name: string, accept: (entry: T) => void): void {
    const path = this.filePath(name)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      return // first run: no file yet
    }
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      try {
        accept(JSON.parse(line) as T)
      } catch {
        // Corrupt tail line: stop reading (treated as truncated file).
        break
      }
    }
  }

  private append(name: string, entry: unknown): void {
    try {
      appendFileSync(this.filePath(name), `${JSON.stringify(entry)}\n`)
    } catch {
      // Storage failures must never break browser actions.
    }
  }

  private readLedger(): BrowserLedger | undefined {
    const path = this.filePath('groups')
    try {
      const raw = readFileSync(path, 'utf8').trim()
      return raw === '' ? undefined : JSON.parse(raw) as BrowserLedger
    } catch {
      return undefined
    }
  }

  private writeLedger(ledger: BrowserLedger): void {
    try {
      writeFileSync(this.filePath('groups'), JSON.stringify(ledger))
    } catch {
      // Best effort.
    }
  }

  // ----------------------------------------------------------------- history

  addHistory(entry: Omit<HistoryEntry, 'seq'>): HistoryEntry {
    const record: HistoryEntry = { ...entry, seq: ++this.historySeq, url: stripSensitiveUrl(entry.url) }
    this.history.push(record)
    this.append('history', record)
    this.pruneHistory()
    return record
  }

  /** Search history (newest first; filters: text/url substring, group, actor,
   * time window). */
  queryHistory(filter: { q?: string | undefined; group?: string | undefined; actor?: RecordActor | undefined; since?: number | undefined; until?: number | undefined; limit?: number | undefined } = {}): HistoryEntry[] {
    const limit = filter.limit ?? 100
    const q = filter.q?.toLowerCase()
    const out: HistoryEntry[] = []
    for (let i = this.history.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.history[i]!
      if (filter.group !== undefined && entry.group !== filter.group) continue
      if (filter.actor !== undefined && entry.actor !== filter.actor) continue
      if (filter.since !== undefined && entry.time < filter.since) continue
      if (filter.until !== undefined && entry.time > filter.until) continue
      if (q !== undefined && q !== '') {
        const hay = `${entry.url} ${entry.title}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      out.push(entry)
    }
    return out
  }

  private pruneHistory(): void {
    const cutoff = Date.now() - this.options.historyWindowMs
    let removed = 0
    while (this.history.length > this.options.historyLimit || (this.history[0] !== undefined && this.history[0].time < cutoff)) {
      if (this.history.length <= this.options.historyLimit && this.history[0]!.time >= cutoff) break
      this.history.shift()
      removed++
      if (removed > this.options.historyLimit * 2) break
    }
    if (removed > 0) this.rewrite('history', this.history)
  }

  // --------------------------------------------------------------- bookmarks

  addBookmark(entry: Omit<BookmarkEntry, 'id' | 'createdAt'>): BookmarkEntry {
    // Idempotent: same URL re-bookmark updates the stamp. Compare the
    // SANITIZED url (the stored form) — a raw URL with sensitive params must
    // not re-add a duplicate whose stored url differs only by masking.
    const url = stripSensitiveUrl(entry.url)
    const existing = this.bookmarks.find((b) => b.url === url)
    if (existing !== undefined) {
      existing.title = entry.title
      existing.actor = entry.actor
      existing.group = entry.group
      existing.createdAt = Date.now()
      // Idempotent hits must reach disk too (P2-27): the in-memory record was
      // updated but the file kept the old title/actor, so a restart reverted
      // the bookmark to its first stamp.
      this.rewrite('bookmarks', this.bookmarks)
      return existing
    }
    const record: BookmarkEntry = { ...entry, id: ++this.bookmarkSeq, createdAt: Date.now(), url }
    this.bookmarks.push(record)
    this.append('bookmarks', record)
    this.pruneBookmarks()
    return record
  }

  queryBookmarks(filter: { q?: string | undefined; limit?: number | undefined } = {}): BookmarkEntry[] {
    const limit = filter.limit ?? 200
    const q = filter.q?.toLowerCase()
    const out: BookmarkEntry[] = []
    for (let i = this.bookmarks.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.bookmarks[i]!
      if (q !== undefined && q !== '') {
        const hay = `${entry.url} ${entry.title}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      out.push(entry)
    }
    return out
  }

  removeBookmark(id: number): boolean {
    const idx = this.bookmarks.findIndex((b) => b.id === id)
    if (idx < 0) return false
    this.bookmarks.splice(idx, 1)
    this.rewrite('bookmarks', this.bookmarks)
    return true
  }

  private pruneBookmarks(): void {
    if (this.bookmarks.length > this.options.bookmarkLimit) {
      while (this.bookmarks.length > this.options.bookmarkLimit) this.bookmarks.shift()
      this.rewrite('bookmarks', this.bookmarks)
    }
  }

  // --------------------------------------------------------------- downloads

  addDownload(entry: Omit<DownloadEntry, 'id' | 'createdAt' | 'status'> & { status?: DownloadEntry['status'] }): DownloadEntry {
    const { status: statusOverride, ...rest } = entry
    const record: DownloadEntry = {
      ...rest,
      id: ++this.downloadSeq,
      createdAt: Date.now(),
      status: statusOverride ?? 'done',
      url: stripSensitiveUrl(entry.url),
    }
    this.downloads.push(record)
    this.append('downloads', record)
    this.pruneDownloads()
    return record
  }

  updateDownload(id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>): void {
    const entry = this.downloads.find((d) => d.id === id)
    if (entry === undefined) return
    Object.assign(entry, patch)
    this.rewrite('downloads', this.downloads)
  }

  queryDownloads(filter: { status?: DownloadEntry['status'] | undefined; limit?: number | undefined } = {}): DownloadEntry[] {
    const limit = filter.limit ?? 100
    const out: DownloadEntry[] = []
    for (let i = this.downloads.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.downloads[i]!
      if (filter.status !== undefined && entry.status !== filter.status) continue
      out.push(entry)
    }
    return out
  }

  removeDownload(id: number): boolean {
    const idx = this.downloads.findIndex((d) => d.id === id)
    if (idx < 0) return false
    this.downloads.splice(idx, 1)
    this.rewrite('downloads', this.downloads)
    return true
  }

  private pruneDownloads(): void {
    if (this.downloads.length > this.options.downloadLimit) {
      while (this.downloads.length > this.options.downloadLimit) this.downloads.shift()
      this.rewrite('downloads', this.downloads)
    }
  }

  // ------------------------------------------------------------------ ledger

  getGroupLedger(): BrowserLedger | undefined {
    return this.ledger
  }

  saveGroupLedger(ledger: BrowserLedger): void {
    this.ledger = ledger
    this.writeLedger(ledger)
  }

  // ---------------------------------------------------------------- internals

  private rewrite(name: string, entries: unknown[]): void {
    try {
      writeFileSync(this.filePath(name), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''))
    } catch {
      // Best effort.
    }
  }

  /** Directory stat for tests/diagnostics. */
  pathOf(name: string): string {
    return this.filePath(name)
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true })
  }

  get dir(): string {
    return this.options.dir
  }

  /** Counts (tests). */
  counts(): { history: number; bookmarks: number; downloads: number } {
    return { history: this.history.length, bookmarks: this.bookmarks.length, downloads: this.downloads.length }
  }

  /** Existing file byte size (tests). */
  fileSize(name: string): number {
    try {
      return statSync(this.filePath(name)).size
    } catch {
      return 0
    }
  }

}
