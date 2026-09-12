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
import { SENSITIVE_KEY_PATTERN } from './sensitive.ts'

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

/** Mask secret-shaped `k=v` pairs inside a URL fragment. OAuth implicit flows
 * carry `#access_token=…`/`#code=…` there, and a query-only scrub left them in
 * cleartext on disk. Non-sensitive pairs and plain route fragments are kept
 * byte-identical (the `?`/`/` prefixes are not part of the key pattern).
 * Exported so the runtime op-log mask (`runtime.ts maskBrowserSummary`) reuses
 * this single implementation instead of keeping a second one (P1-5). */
export function maskSensitiveFragment(fragment: string): string {
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (body === '' || !body.includes('=')) return fragment
  // 线性扫描替换(CodeQL js/polynomial-redos):原正则 /([^&#=?]+)=([^&]*)/gu
  // 在大量重复字符的 fragment 上会多项式回溯。逐 & 段解析,语义与原正则对齐:
  //   - key = 本段最后一个 ?/# 之后到第一个 = 之前(原正则不允许 key 含 & # = ?);
  //   - value = 段内剩余部分(可含 '='),命中敏感 key 时整段 value 打码;
  //   - key 为空/无 '=' 的段原样保留。
  const parts = body.split('&')
  let changed = false
  const maskedParts = parts.map((part) => {
    const eq = part.indexOf('=')
    if (eq < 0) return part
    const keyStart = Math.max(part.lastIndexOf('?', eq - 1), part.lastIndexOf('#', eq - 1)) + 1
    const rawKey = part.slice(keyStart, eq)
    if (rawKey === '') return part
    let key = rawKey
    try { key = decodeURIComponent(rawKey) } catch { /* keep the raw key */ }
    if (!SENSITIVE_KEY_PATTERN.test(key)) return part
    changed = true
    return `${part.slice(0, keyStart)}${rawKey}=****`
  })
  return changed ? `#${maskedParts.join('&')}` : fragment
}

/** Strip sensitive URL parts before persistence (never throws): credential
 * query parameters, userinfo (`user:pass@host`) and secret-shaped fragment
 * pairs. Mirrors the runtime op-log masking (runtime maskBrowserSummary).
 *
 * A URL that needs no masking is returned **byte-identical** (R-1, 2026-09-13):
 * `new URL().href` canonicalizes (`https://example.com` → `https://example.com/`,
 * adds `/` before `?`), and this function is now also the projection applied to
 * every tab state the runtime hands out — canonicalizing there would rewrite
 * ordinary URLs for no security gain.
 *
 * R-4 (2026-09-13) adds a second pass, {@link maskSensitiveKeyValueText}, over
 * the structurally masked result. The URL parser only knows `&`/`?` pairs and
 * decodes a key ONCE, so `?%2573id=T` (double-encoded `sid`) and
 * `?a=1;token=T` (semicolon-separated) survived it; the text-level `key=value`
 * scanner sees both. A clean URL is untouched by either pass. */
export function stripSensitiveUrl(raw: string): string {
  let structurally = raw
  try {
    const url = new URL(raw)
    let changed = false
    if (url.username !== '') { url.username = '****'; changed = true }
    if (url.password !== '') { url.password = '****'; changed = true }
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(name)) { url.searchParams.set(name, '****'); changed = true }
    }
    if (url.hash !== '') {
      const masked = maskSensitiveFragment(url.hash)
      if (masked !== url.hash) { url.hash = masked; changed = true }
    }
    if (changed) structurally = url.href
  } catch {
    // Not a URL: the text-level scanner below still gets a chance.
  }
  return maskSensitiveKeyValueText(structurally)
}

/** Key characters of a `key=value` pair: URL/JSON-ish token characters plus
 * `%`, so a percent-encoded key (`%2573id`) stays ONE token and can be decoded
 * before the vocabulary test. */
const KEY_CHAR = /[A-Za-z0-9_.\-[\]%]/u
/** Characters that end a value. */
const VALUE_STOP = new Set([' ', '\t', '\n', '\r', '"', "'", '<', '>', '&', ';', '#', ')', ']', '}', ',', '(', '{', '|', '\\'])
/** Opening delimiters skipped between `=` and the value (`code="T"`). */
const VALUE_OPEN = new Set(['"', "'", '(', '[', '{'])

/** Decode a key repeatedly so `%2573id` → `%73id` → `sid` matches the
 * vocabulary. Bounded (3 rounds) and best-effort: a malformed escape keeps the
 * text it had. */
function decodeKeyForMatch(raw: string): string {
  let key = raw
  for (let round = 0; round < 3 && key.includes('%'); round++) {
    try {
      const next = decodeURIComponent(key)
      if (next === key) break
      key = next
    } catch {
      break
    }
  }
  return key
}

/**
 * Mask credential-shaped `key=value` pairs in **arbitrary text** (R-4,
 * 2026-09-13).
 *
 * The pre-fix rule only ran on strings that contained `://` and only through
 * `new URL()`, so a page `<title>` — `token=T12`, `Sign in /cb?%73id=T11`,
 * `Login failed: code=T14&state=x` — reached `list_tabs`, `browser_get_snapshot`
 * and the JSONL files in cleartext; so did the double-encoded and
 * semicolon-separated URL forms. This scanner is delimiter-driven instead:
 *
 * - a **key** is the maximal run of {@link KEY_CHAR} immediately before `=`,
 *   matched against {@link SENSITIVE_KEY_PATTERN} after
 *   {@link decodeKeyForMatch} (so `%2573id=` counts as `sid=`);
 * - a **value** starts after an optional opening delimiter, ends at the first
 *   {@link VALUE_STOP} character (or the end of the text) and must be non-empty;
 *   sentence punctuation that only trails the text (`…token=T12.`) stays text;
 * - only the value is replaced; keys, delimiters and the rest of the text stay
 *   byte-identical, so a text with nothing to mask is returned unchanged.
 *
 * Deliberately fail-closed on prose that looks like an assignment (`see code=X
 * below` masks `X`): the vocabulary hit is the same judgement the URL masking
 * has always made, and a masked word is recoverable while a leaked credential
 * is not.
 */
export function maskSensitiveKeyValueText(raw: string): string {
  if (raw === '' || !raw.includes('=')) return raw
  const parts: string[] = []
  let cursor = 0
  let index = 0
  while (index < raw.length) {
    if (raw[index] !== '=') { index++; continue }
    let start = index
    while (start > 0 && KEY_CHAR.test(raw[start - 1]!)) start--
    if (start === index) { index++; continue }
    if (!SENSITIVE_KEY_PATTERN.test(decodeKeyForMatch(raw.slice(start, index)))) { index++; continue }
    let valueStart = index + 1
    if (valueStart < raw.length && VALUE_OPEN.has(raw[valueStart]!)) valueStart++
    let valueEnd = valueStart
    while (valueEnd < raw.length && !VALUE_STOP.has(raw[valueEnd]!)) valueEnd++
    // A value that runs to the end of the text may carry the sentence's full
    // stop (`see token=T12.`): the punctuation is prose, so it stays.
    let tail = valueEnd
    if (valueEnd === raw.length) {
      while (tail > valueStart + 1 && (raw[tail - 1] === '.' || raw[tail - 1] === ',' || raw[tail - 1] === '!' || raw[tail - 1] === '?')) tail--
    }
    if (tail === valueStart) { index++; continue }
    parts.push(raw.slice(cursor, valueStart), '****')
    cursor = tail
    index = tail
  }
  if (cursor === 0) return raw
  parts.push(raw.slice(cursor))
  return parts.join('')
}

/** URL embedded in free text (a title, an op-log summary). Trailing sentence
 * punctuation is peeled off by {@link stripSensitiveText} and re-appended. */
const TEXT_URL_RE = /(?:https?:\/\/[^\s<>"')]+)(?:[),.;]*)?/giu

/** Mask credential-shaped URLs **inside arbitrary text** (FIX-06, 2026-09-12;
 * generalized by R-4, 2026-09-13).
 *
 * `stripSensitiveUrl` only handles a string that *is* a URL. Titles and
 * summaries routinely embed one (`download: https://…`) or *are* a URL that no
 * longer parses as a whole (`getTitle() || tab.url`), and those fields were
 * persisted in cleartext while the sibling `url` field read `****` — the same
 * value, two columns, one redacted. This is the single text-level redactor:
 * the store write path (`addHistory`/`addBookmark`) and the runtime op-log
 * (`runtime.maskBrowserSummary`) both call it, so no second copy can drift.
 *
 * Two passes, in this order:
 * 1. absolute URLs, through the URL parser (`stripSensitiveUrl`), which is the
 *    only pass that can see userinfo and fragment structure and that knows to
 *    peel a sentence's trailing punctuation off the URL tail
 *    (`…?token=T.` → `…?token=****.`, the full stop is prose, not the value);
 * 2. `key=value` pairs anywhere ({@link maskSensitiveKeyValueText}) — this is
 *    what makes a bare `token=T12` title, a `%2573id=` double-encoded key and a
 *    `;`-separated pair maskable; the old `://`-only early return let all three
 *    through in cleartext (R-4, real-device evidence `bm-v3-result.json`).
 * A text with nothing to mask is returned byte-identical. */
export function stripSensitiveText(raw: string): string {
  if (raw === '') return raw
  const urls = raw.includes('://')
    ? raw.replace(TEXT_URL_RE, (match) => {
      let end = match.length
      while (end > 0 && (match[end - 1] === ')' || match[end - 1] === ',' || match[end - 1] === '.' || match[end - 1] === ';')) {
        end -= 1
      }
      return `${stripSensitiveUrl(match.slice(0, end))}${match.slice(end)}`
    })
    : raw
  return maskSensitiveKeyValueText(urls)
}

/** Percent-decode once for comparison purposes; a malformed escape returns the
 * text as it was. Used to compare a decoded download name against the raw URL
 * the browser reported (R-4). */
function decodeUrlForCompare(raw: string): string {
  try {
    return decodeURIComponent(raw)
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
    // Both fields can carry the same credential: `title` is frequently the URL
    // itself (FIX-06 — `download: ${url}`, `getTitle() || tab.url`), so it gets
    // the text-level redactor, not only the url field.
    const record: HistoryEntry = {
      ...entry,
      seq: ++this.historySeq,
      url: stripSensitiveUrl(entry.url),
      title: stripSensitiveText(entry.title),
    }
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
    const title = stripSensitiveText(entry.title)
    const existing = this.bookmarks.find((b) => b.url === url)
    if (existing !== undefined) {
      existing.title = title
      existing.actor = entry.actor
      existing.group = entry.group
      existing.createdAt = Date.now()
      // Idempotent hits must reach disk too (P2-27): the in-memory record was
      // updated but the file kept the old title/actor, so a restart reverted
      // the bookmark to its first stamp.
      this.rewrite('bookmarks', this.bookmarks)
      return existing
    }
    const record: BookmarkEntry = { ...entry, id: ++this.bookmarkSeq, createdAt: Date.now(), url, title }
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
    // R-1 (2026-09-13): `url` was the only redacted field. `fileName` comes
    // from `Content-Disposition`/the URL basename and `path` embeds that name,
    // so a signed download URL reached `browser_downloads_list` — and the disk
    // — in cleartext beside a `****` url. Same text-level redactor, at the
    // write path, so every reader (tool exit, shell panel, JSONL) agrees.
    const url = stripSensitiveUrl(entry.url)
    let fileName = stripSensitiveText(entry.fileName)
    // A name derived from a credential-bearing URL keeps the credential in a
    // *path segment* (`/dl/report-<token>.zip?token=…`), which no key-shaped
    // rule can recognize. When the name is demonstrably taken from that URL,
    // the name the model is shown is dropped.
    //
    // R-4 (2026-09-13): the comparison decodes the raw URL first. `getName()`
    // hands back the DECODED name while `getURL()` keeps the escaping, so
    // `…/report%2DDLTOK1.zip` + name `report-DLTOK1.zip` made the old
    // `entry.url.includes(fileName)` false and the credential reached
    // `browser_downloads_list` right next to a `token=****` url.
    //
    // `path` deliberately stays truthful: it is the handle `downloads_open`
    // and the file tools use to reach a real file on disk, and the same name is
    // visible by listing the downloads directory, so masking it here would
    // remove the capability without hiding the string. Recorded as a residual.
    const fileNameFromCredentialUrl = url !== entry.url && fileName !== ''
      && (entry.url.includes(fileName) || decodeUrlForCompare(entry.url).includes(fileName))
    if (fileNameFromCredentialUrl) fileName = '****'
    const record: DownloadEntry = {
      ...rest,
      id: ++this.downloadSeq,
      createdAt: Date.now(),
      status: statusOverride ?? 'done',
      url,
      fileName,
      path: stripSensitiveText(entry.path),
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
    // Tab URLs reach this file verbatim from `wc.getURL()`; an OAuth callback
    // (`?code=` / `#access_token=`) must not sit in cleartext on disk when the
    // very same URL is masked in history. A restored token-bearing tab then
    // opens the masked URL — acceptable: those URLs are single-use anyway.
    // R-1 (2026-09-13): `title` is redacted by the same rule — it is frequently
    // the URL itself (no `<title>`, Electron's title fallback) and every other
    // persisted surface (history/bookmarks) already stores the text-level
    // redaction, so the ledger was the last cleartext column on disk.
    // A ledger without tab urls is stored untouched (shape preserved).
    const ledgerTabs: BrowserLedger['tabs'] | undefined = Array.isArray(ledger.tabs) ? ledger.tabs : undefined
    const sanitized: BrowserLedger = ledgerTabs !== undefined && ledgerTabs.length > 0
      ? { ...ledger, tabs: ledgerTabs.map((tab) => ({ ...tab, url: stripSensitiveUrl(tab.url ?? ''), title: stripSensitiveText(tab.title ?? '') })) }
      : ledger
    this.ledger = sanitized
    this.writeLedger(sanitized)
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
