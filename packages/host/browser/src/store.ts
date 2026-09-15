/**
 * BrowserStore (v4 §8): per-user local durability for bookmarks, history,
 * downloads and the group ledger. Append-only JSONL files + in-memory index
 * (rebuilt on load with tail-truncation recovery); bounded retention; URLs
 * stripped of sensitive query parameters before any write; the store is
 * LOCAL (never synced) and shared across sessions with actor/group tags.
 *
 * 2026-09-15 审计（P1/P2）后的落盘契约，改这块前先读：
 *
 * 1. **只有 `ENOENT` 算首次运行**。EACCES/EIO/EDQUOT/杀软锁文件都意味着"磁盘上可能
 *    还有数据，只是我读不到"：该集合进入**只读降级**（拒绝 append/rewrite + 告警），
 *    并保持 `loaded = false`，让下一次 `load()` 成为重试入口；降级期间被接受的记录
 *    留在内存与 pending 队列里，读恢复后补落盘。这是用户数据（书签/历史/下载/账本），
 *    任何可能丢数据的路径一律往"拒绝覆盖 + 告警"方向修。
 * 2. **整文件重写一律原子替换**（`.tmp` + `renameSync`）：直接 `writeFileSync` 先截断
 *    再写，崩溃/写满会留下半个文件。坏账本改名备份成 `*.corrupt-<ts>` 后以空账本启动，
 *    绝不静默丢弃。
 * 3. **脱敏分档**（见 sensitive.ts）：`url` 字段与 URL/查询串形态的文本保持键名级强度；
 *    标题/摘要的**散文**段只对强凭据键打码——此前 `搜索 “key=value” 的含义` 会被写成
 *    `搜索 “key=**** 的含义`，落盘即不可逆。
 * @module @picoaide/dsh-browser
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  isExactProseSensitiveKey,
  isExactSensitiveKey,
  isExactUrlShapedTextKey,
  PROSE_SENSITIVE_KEY_PATTERN,
  SENSITIVE_KEY_PATTERN,
  URL_SHAPED_TEXT_KEY_PATTERN,
} from './sensitive.ts'

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
  /**
   * 告警出口（2026-09-15 审计 P1/P2）：读失败降级、坏文件隔离、写失败都从这里出。
   * 缺省 `console.error`；注入回调便于测试断言"确实告警了、且说的是哪一类"。
   */
  warn?: (message: string) => void
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
const VALUE_STOP = new Set([' ', '\t', '\n', '\r', '"', "'", '<', '>', '&', ';', '#', ')', ']', '}', ',', '(', '{', '|', '\\', '?'])
/** Opening delimiters skipped between `=` and the value (`code="T"`). */
const VALUE_OPEN = new Set(['"', "'", '(', '[', '{'])

/**
 * Separator spellings the scanner accepts at a position (R-5, 2026-09-13):
 *
 * - `=`, and the full-width `＝` (U+FF1D) a CJK page/IME produces;
 * - the HTML entity forms `&#61;` / `&#061;` / `&#x3d;` / `&equals;`, which is
 *   what a title or an op-log summary carries when the page wrote the pair into
 *   markup instead of a text node;
 * - `:` for object/JSON pairs (`{"code":"T14"}`). The colon is gated by
 *   {@link isExactSensitiveKey} (or a quoted key) so ordinary prose
 *   (`encoded: 0`, `decoder: x`) is not rewritten.
 */
const SEPARATOR_AT = /^(?:=|＝|&#0*61;|&#[xX]0*3d;|&equals;|:)/
/** Whitespace allowed between a key and its separator, and between the
 * separator and the value (`token = T12`). */
const SEPARATOR_SPACE = new Set([' ', '\t'])

/** True when the pair at `keyStart` sits inside an absolute URL, so a following
 * `/` starts a path segment rather than continuing the value
 * (`https://x/token=T12/next` — the old rule swallowed `/next` whole). */
function insideAbsoluteUrl(text: string, keyStart: number): boolean {
  let i = keyStart
  while (i > 0) {
    const ch = text[i - 1]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '"' || ch === "'" || ch === '<' || ch === '`') break
    i--
  }
  return text.slice(i, keyStart).includes('://')
}

/**
 * 判别"URL/查询串形态"时使用的**串**边界（2026-09-15 审计 P2）：空白 + 引号/尖括号。
 * 判别单位是"串"而不是"字段"，因为同一个 title 常常既含散文又内嵌查询串
 * （`getTitle() || tab.url`），按串切分才能让 URL 面继续按 URL 面的尺子走。
 */
const RUN_BREAK = new Set([' ', '\t', '\n', '\r', '"', "'", '<', '>', '`'])

/** 串里的 URL/查询串信号：协议、查询起始、参数分隔、分号分隔、百分号编码。 */
const URL_SHAPED_RUN = /:\/\/|[?&;%]/u

/** 键值对所在的"非空白串"是不是 URL/查询串形态（见 {@link RUN_BREAK}）。 */
function isUrlShapedRun(text: string, from: number, to: number): boolean {
  let start = from
  while (start > 0 && !RUN_BREAK.has(text[start - 1]!)) start--
  let end = to
  while (end < text.length && !RUN_BREAK.has(text[end]!)) end++
  return URL_SHAPED_RUN.test(text.slice(start, end))
}

/**
 * 值对扫描的词表档位（2026-09-15 审计 P2）。审计要求"区分字段类型"：
 * URL/查询串面保持现有强度，标题/摘要类自由文本只对强凭据键打码。
 *
 * 三档而不是两档，是因为**自由文本内部**也必须能分开：`title` 既可能是散文
 * （`搜索 “key=value” 的含义`，被改坏即不可逆），也可能是查询串形态
 * （`Login failed: code=T14&state=x`，`code` 在这里就是凭据位）。按"串"分流让
 * 两者各用各的尺子，比按"字段"一刀切更保守——URL 形态的段一点强度都不降。
 */
const PAIR_VOCABULARY = {
  /** URL 面（`maskSensitiveKeyValueText` 直接调用 / `stripSensitiveUrl` 二次扫描）：逐字节不动。 */
  url: { pattern: SENSITIVE_KEY_PATTERN, isExact: isExactSensitiveKey },
  /** 自由文本里的 URL/查询串段（含 JSON 引号键）：键名表 ∪ 散文表，覆盖度只增不减。 */
  urlShaped: { pattern: URL_SHAPED_TEXT_KEY_PATTERN, isExact: isExactUrlShapedTextKey },
  /** 自由文本里的散文段：只认强凭据键，`key`/`code`/`sid` 不再改写。 */
  prose: { pattern: PROSE_SENSITIVE_KEY_PATTERN, isExact: isExactProseSensitiveKey },
} as const

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
 * 2026-09-13; separator/JSON coverage and the URL-path boundary R-5).
 *
 * The pre-fix rule only ran on strings that contained `://` and only through
 * `new URL()`, so a page `<title>` — `token=T12`, `Sign in /cb?%73id=T11`,
 * `Login failed: code=T14&state=x` — reached `list_tabs`, `browser_get_snapshot`
 * and the JSONL files in cleartext; so did the double-encoded and
 * semicolon-separated URL forms. This scanner is delimiter-driven instead:
 *
 * - a **key** is the maximal run of {@link KEY_CHAR} immediately before a
 *   {@link SEPARATOR_AT} spelling (optionally separated by spaces), matched
 *   against {@link SENSITIVE_KEY_PATTERN} after {@link decodeKeyForMatch} (so
 *   `%2573id=` counts as `sid=`); a quoted key is accepted for the `:` form;
 * - a **value** starts after an optional opening delimiter, ends at the first
 *   {@link VALUE_STOP} character (or `/` when the pair is inside an absolute
 *   URL) and must be non-empty; sentence punctuation that only trails the text
 *   (`…token=T12.`) stays text;
 * - only the value is replaced; keys, delimiters and the rest of the text stay
 *   byte-identical, so a text with nothing to mask is returned unchanged.
 *
 * Deliberately fail-closed on prose that looks like an assignment with a
 * **strong** credential key (`see token=X below` masks `X`): the vocabulary hit
 * is the same judgement the URL masking has always made, and a masked word is
 * recoverable while a leaked credential is not. The vocabulary is no longer the
 * URL one though — see {@link maskSensitiveFreeText} for why the ambiguous terms
 * (`key`/`code`/`sid`) were dropped from free-form prose (2026-09-15 audit P2).
 */
export function maskSensitiveKeyValueText(raw: string): string {
  return scanKeyValueText(raw, 'url')
}

/**
 * 自由文本（页面标题、摘要）的 `key=value` 扫描（2026-09-15 审计 P2）。
 *
 * 与 {@link maskSensitiveKeyValueText} 共用同一个扫描器，只有**词表档位**不同：
 * 散文段用 {@link PROSE_SENSITIVE_KEY_PATTERN}（`key`/`code`/`sid` 不再命中），
 * URL/查询串形态的段与 JSON 引号键继续用键名级词表（并集）。判别规则见
 * {@link isUrlShapedRun} 与 {@link PAIR_VOCABULARY}。
 *
 * 为什么不是"按字段"再写一套标题专用实现：标题与摘要共用
 * {@link stripSensitiveText} 这一个出口（store 的 title 路径与 runtime 的
 * op-log/tab-title 路径都走它），第二份实现必然漂移——R-4 的教训。把差别放在
 * 同一个扫描器的词表档位上，行为只有一处可改。
 */
export function maskSensitiveFreeText(raw: string): string {
  return scanKeyValueText(raw, 'text')
}

function scanKeyValueText(raw: string, vocabulary: 'url' | 'text'): string {
  if (raw === '') return raw
  if (!raw.includes('=') && !raw.includes('＝') && !raw.includes(':') && !raw.includes('&')) return raw
  const parts: string[] = []
  let cursor = 0
  let index = 0
  while (index < raw.length) {
    const separator = SEPARATOR_AT.exec(raw.slice(index, index + 8))
    if (separator === null) { index++; continue }
    const spelling = separator[0]
    const colon = spelling === ':'
    // The key may be separated from its separator by spaces (`token = T12`).
    let keyEnd = index
    while (keyEnd > 0 && SEPARATOR_SPACE.has(raw[keyEnd - 1]!)) keyEnd--
    // JSON object pair: `"code": "T14"`.
    let quoted = false
    if (keyEnd > 0 && (raw[keyEnd - 1] === '"' || raw[keyEnd - 1] === "'")) { quoted = true; keyEnd-- }
    let start = keyEnd
    while (start > 0 && KEY_CHAR.test(raw[start - 1]!)) start--
    if (start === keyEnd) { index += spelling.length; continue }
    const key = decodeKeyForMatch(raw.slice(start, keyEnd))
    // 词表档位（2026-09-15 审计 P2）：URL 面固定 url 档；自由文本里，引号键的
    // JSON 形态（`"code": "T14"`，R-5 的覆盖）与 URL/查询串形态的串走 urlShaped，
    // 其余散文走 prose。注意 `"key=value"` 这种**引号 + 等号**的散文仍算散文：
    // 引号只在冒号形态下才是"结构化数据"的信号。
    const grade = vocabulary === 'url'
      ? 'url'
      : (quoted && colon) || isUrlShapedRun(raw, start, index + spelling.length)
        ? 'urlShaped'
        : 'prose'
    const terms = PAIR_VOCABULARY[grade]
    if (!terms.pattern.test(key)) { index += spelling.length; continue }
    // A colon is only a credential separator in the JSON shape (quoted key) or
    // when the key IS a credential term — `key`/`code`/`sid` are ordinary
    // English words as substrings of prose keys (`encoded:`, `decoder:`).
    if (colon && !quoted && !terms.isExact(key)) { index += spelling.length; continue }
    const urlContext = insideAbsoluteUrl(raw, start)
    let valueStart = index + spelling.length
    while (valueStart < raw.length && SEPARATOR_SPACE.has(raw[valueStart]!)) valueStart++
    if (valueStart < raw.length && VALUE_OPEN.has(raw[valueStart]!)) valueStart++
    let valueEnd = valueStart
    while (valueEnd < raw.length && !VALUE_STOP.has(raw[valueEnd]!) && !(urlContext && raw[valueEnd] === '/')) valueEnd++
    // A value that runs to the end of the text may carry the sentence's full
    // stop (`see token=T12.`): the punctuation is prose, so it stays.
    let tail = valueEnd
    if (valueEnd === raw.length) {
      while (tail > valueStart + 1 && (raw[tail - 1] === '.' || raw[tail - 1] === ',' || raw[tail - 1] === '!' || raw[tail - 1] === '?')) tail--
    }
    if (tail === valueStart) { index += spelling.length; continue }
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
 * 2. `key=value` pairs anywhere ({@link maskSensitiveFreeText}) — this is
 *    what makes a bare `token=T12` title, a `%2573id=` double-encoded key and a
 *    `;`-separated pair maskable; the old `://`-only early return let all three
 *    through in cleartext (R-4, real-device evidence `bm-v3-result.json`).
 * A text with nothing to mask is returned byte-identical.
 *
 * 2026-09-15 审计 P2：第二遍改用 {@link maskSensitiveFreeText}——散文段只对强凭据键
 * 打码。此前的全强度词表把标题 `搜索 “key=value” 的含义` 写成
 * `搜索 “key=**** 的含义`，**落盘即不可逆**；`url` 字段（{@link stripSensitiveUrl}）
 * 与文本里的 URL/查询串段仍按原强度处理，安全侧的 URL 面兜底没有被削弱。 */
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
  return maskSensitiveFreeText(urls)
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

/** 集合文件名（也是"降级/pending"的键）。groups 是快照式账本，其余是追加式 JSONL。 */
const STORE_COLLECTIONS = ['history', 'bookmarks', 'downloads', 'groups'] as const

/** 只有"文件确实不存在"才等于首次运行（2026-09-15 审计 P1）：EACCES/EIO/EDQUOT/
 * EBUSY（杀软锁文件）都意味着"磁盘上可能还有数据，只是我读不到"，绝不当空集合。 */
function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 诊断用的错误代码（不打印可能带路径的完整 message）。 */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.name : 'unknown'
}

/** 一次集合读取的结果（2026-09-15 审计 P1/P2）。 */
interface CollectionRead<T> {
  /** 磁盘内容；`undefined` = 读失败，磁盘状态未知（内存原样保留，不做任何覆盖）。 */
  entries: T[] | undefined
  /** 这次读取是否干净：坏行会让它为 false ⇒ 保持只读降级，绝不重写磁盘。 */
  clean: boolean
}

/** 一次账本读取的结果。`known=false` = 读失败（磁盘状态未知）。 */
interface LedgerRead {
  known: boolean
  ledger: BrowserLedger | undefined
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
  /**
   * 只读降级的集合（2026-09-15 审计 P1/P2）：读失败（非 ENOENT）、坏行、写失败都会
   * 落到这里。此后该集合拒绝一切 append/rewrite——内存里可能只是磁盘的残缺副本，
   * 继续写会把磁盘上还完好的旧数据整批覆盖掉，"一次瞬时 I/O 错误后历史全没"正是
   * 这条路径。
   */
  private readonly degraded = new Set<string>()
  /**
   * 降级期间被接受、但没能落盘的记录（每集合一份，保持写入顺序）。
   *
   * 不变式：内存索引 = 磁盘内容 + 这份 pending。读恢复后按序补落盘，否则"重试成功"
   * 反而会把降级窗口里记下的书签/历史丢掉（只在内存里、进程一退就没了）。
   */
  private readonly pending = new Map<string, unknown[]>()
  /** 降级期间的账本（groups 是快照式文件：最后一次保存胜出）。 */
  private pendingLedger: BrowserLedger | undefined

  constructor(options: StoreOptions) {
    this.options = { ...DEFAULTS, ...options }
    if (options.load !== false) this.load()
  }

  // ------------------------------------------------------------------ files

  private filePath(name: string): string {
    return join(this.options.dir, `${name}.jsonl`)
  }

  /**
   * Load all collection files.
   *
   * Idempotent once loaded; also the **retry entry point** after a degraded load
   * (2026-09-15 audit P1): a failed read keeps `loaded = false`, so calling
   * `load()` again re-reads the collections and, when the I/O recovers, replays
   * the records that were accepted but never persisted.
   *
   * 只有 `ENOENT` 算"首次运行"；其它错误（EACCES/EIO/EDQUOT/杀软锁文件）一律
   * 只读降级 + 告警，绝不当空集合。
   */
  load(): void {
    if (this.loaded) return
    if (this.ensureStoreDir()) {
      const history = this.readCollection<HistoryEntry>('history')
      const bookmarks = this.readCollection<BookmarkEntry>('bookmarks')
      const downloads = this.readCollection<DownloadEntry>('downloads')
      this.settle<HistoryEntry>('history', history, (disk, replay) => this.applyHistory(disk, replay))
      this.settle<BookmarkEntry>('bookmarks', bookmarks, (disk, replay) => this.applyBookmarks(disk, replay))
      this.settle<DownloadEntry>('downloads', downloads, (disk, replay) => this.applyDownloads(disk, replay))
      this.settleLedger(this.readLedger())
    }
    // 有集合处于只读降级时保持 loaded=false：下次 load() 就是重试（2026-09-15 审计 P1）。
    this.loaded = this.degraded.size === 0
  }

  /** 目录都建不出来时全线只读降级：存储坏了也不能让浏览器起不来。 */
  private ensureStoreDir(): boolean {
    try {
      mkdirSync(this.options.dir, { recursive: true })
      return true
    } catch (error) {
      this.warn(`[browser-store] 创建 store 目录失败（${errorCode(error)}）：本次会话书签/历史/下载/分组均不落盘，也不会覆盖磁盘上的旧数据`)
      for (const name of STORE_COLLECTIONS) this.degraded.add(name)
      return false
    }
  }

  /**
   * 读取一个集合文件（2026-09-15 审计 P1/P2）。
   *
   * - 文件不存在（ENOENT）⇒ 空集合，算干净；
   * - 其它读错误 ⇒ `entries: undefined`（磁盘状态未知）+ 只读降级；
   * - 尾部半行（进程被杀/写盘中断）⇒ 丢掉那半行并把完整行原子写回。留着它的话，
   *   下一次 append 会把这半行变成"文件中段"的坏行，之后的记录**全部读不到**；
   * - 文件中间的坏行 ⇒ 不静默丢弃：告警 + 只读降级（绝不重写原文件），后面的完整行
   *   照样读进来（恢复期不会被写，能救多少救多少）。
   */
  private readCollection<T>(name: string): CollectionRead<T> {
    const path = this.filePath(name)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return { entries: [], clean: true }
      this.degrade(name, `读取 ${name}.jsonl 失败（${errorCode(error)}）`)
      return { entries: undefined, clean: false }
    }
    const entries: T[] = []
    const goodLines: string[] = []
    const lines = content.split('\n')
    let lastContentLine = -1
    for (let i = 0; i < lines.length; i++) if (lines[i]!.trim() !== '') lastContentLine = i
    let clean = true
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.trim() === '') continue
      try {
        entries.push(JSON.parse(line) as T)
        goodLines.push(line)
      } catch (error) {
        if (i === lastContentLine) {
          this.warn(`[browser-store] ${name}.jsonl 末尾是半行/坏行（${errorCode(error)}）：按截断恢复到 ${goodLines.length} 条`)
          // 修不好（写 .tmp 或 rename 失败）就当"这次读取不干净"：半行还在文件里，
          // 继续 append 会把它变成中段坏行，而且 clean=true 会把刚设置的降级又解掉。
          if (!this.repairTruncated(name, path, goodLines)) clean = false
          break
        }
        clean = false
        this.degrade(name, `${name}.jsonl 第 ${i + 1} 行损坏（${errorCode(error)}）`)
      }
    }
    return { entries, clean }
  }

  /** 尾部截断修复：把完整行（逐字节）原子写回；修复不了就只读降级并返回 false。 */
  private repairTruncated(name: string, path: string, goodLines: readonly string[]): boolean {
    try {
      this.writeAtomic(path, goodLines.length > 0 ? `${goodLines.join('\n')}\n` : '')
      return true
    } catch (error) {
      this.degrade(name, `修复 ${name}.jsonl 的截断尾部失败（${errorCode(error)}）`)
      return false
    }
  }

  /**
   * 把一次读取结果落进内存（2026-09-15 审计 P1/P2）：
   * - `entries === undefined`（读失败）⇒ 内存原样（含降级期新增），只读降级继续；
   * - 不干净（坏行）⇒ 内存 = 能读到的部分 + pending，**仍保持只读降级**、不补落盘；
   * - 干净 ⇒ 内存 = 磁盘 + pending，pending 补落盘，解除降级。
   */
  private settle<T>(name: string, read: CollectionRead<T>, apply: (disk: T[], replay: T[]) => void): void {
    if (read.entries === undefined) return
    const replay = (this.pending.get(name) ?? []) as T[]
    // pending 只有在"这次读取干净、且已补落盘"之后才算结清：坏行/写失败时它必须留在
    // 队列里，否则下一次重建内存（内存 = 磁盘 + pending）会把降级窗口的记录整批丢掉。
    if (read.clean) {
      this.pending.delete(name)
      this.degraded.delete(name)
    }
    apply(read.entries, replay)
    if (read.clean) this.replayPending(name, replay)
  }

  /** pending 补落盘；中途失败就把剩下的留在 pending 里，等下次 load() 再试。 */
  private replayPending<T>(name: string, replay: readonly T[]): void {
    for (let i = 0; i < replay.length; i++) {
      if (!this.append(name, replay[i])) {
        this.pending.set(name, replay.slice(i) as unknown[])
        return
      }
    }
  }

  /** 账本落内存：磁盘状态已知才动内存，恢复后优先用降级窗口里最后一次保存的那份。 */
  private settleLedger(read: LedgerRead): void {
    if (!read.known) return
    const replay = this.pendingLedger
    this.pendingLedger = undefined
    this.degraded.delete('groups')
    this.ledger = replay ?? read.ledger
    if (replay !== undefined) this.writeLedger(replay)
  }

  /** 内存索引重建：磁盘内容在前，降级期未落盘的记录按序接在后面（seq 续接磁盘）。 */
  private applyHistory(disk: HistoryEntry[], replay: HistoryEntry[]): void {
    this.history.length = 0
    this.historySeq = 0
    for (const entry of disk) {
      if (entry.seq > this.historySeq) this.historySeq = entry.seq
      this.history.push(entry)
    }
    for (const entry of replay) {
      entry.seq = ++this.historySeq
      this.history.push(entry)
    }
  }

  private applyBookmarks(disk: BookmarkEntry[], replay: BookmarkEntry[]): void {
    this.bookmarks.length = 0
    this.bookmarkSeq = 0
    const used = new Set<number>()
    for (const entry of disk) {
      if (entry.id > this.bookmarkSeq) this.bookmarkSeq = entry.id
      used.add(entry.id)
      this.bookmarks.push(entry)
    }
    for (const entry of replay) {
      // 降级期间的 id 由"内存里的另一个计数器"发出，可能与磁盘条目撞号：撞了就换新号，
      // 宁可换号也不能丢记录（那个 id 只在降级窗口内有效）。
      if (used.has(entry.id)) entry.id = ++this.bookmarkSeq
      else if (entry.id > this.bookmarkSeq) this.bookmarkSeq = entry.id
      used.add(entry.id)
      this.bookmarks.push(entry)
    }
  }

  private applyDownloads(disk: DownloadEntry[], replay: DownloadEntry[]): void {
    this.downloads.length = 0
    this.downloadSeq = 0
    const used = new Set<number>()
    for (const entry of disk) {
      if (entry.id > this.downloadSeq) this.downloadSeq = entry.id
      used.add(entry.id)
      this.downloads.push(entry)
    }
    for (const entry of replay) {
      if (used.has(entry.id)) entry.id = ++this.downloadSeq
      else if (entry.id > this.downloadSeq) this.downloadSeq = entry.id
      used.add(entry.id)
      this.downloads.push(entry)
    }
  }

  /** 追加一条记录；返回是否真的落盘（降级/写失败一律 false 并记入 pending）。 */
  private append(name: string, entry: unknown): boolean {
    if (this.degraded.has(name)) {
      this.notePending(name, entry)
      return false
    }
    try {
      appendFileSync(this.filePath(name), `${JSON.stringify(entry)}\n`)
      return true
    } catch (error) {
      // Storage failures must never break browser actions — 但也不能当作写成功了：
      // 磁盘满/配额超限时继续 rewrite 只会把好文件写坏（2026-09-15 审计 P1）。
      this.notePending(name, entry)
      this.degrade(name, `追加 ${name}.jsonl 失败（${errorCode(error)}）`)
      return false
    }
  }

  /** 记下一条"只在内存里"的记录；上限 = 该集合的保留上限，降级期也不会无限增长。 */
  private notePending(name: string, entry: unknown): void {
    const cap = this.pendingCap(name)
    const list = this.pending.get(name) ?? []
    list.push(entry)
    while (list.length > cap) list.shift()
    this.pending.set(name, list)
  }

  private pendingCap(name: string): number {
    if (name === 'history') return Math.max(1, this.options.historyLimit)
    if (name === 'bookmarks') return Math.max(1, this.options.bookmarkLimit)
    if (name === 'downloads') return Math.max(1, this.options.downloadLimit)
    return 1 // groups：快照式，最后一次保存胜出
  }

  private readLedger(): LedgerRead {
    const path = this.filePath('groups')
    let raw: string
    try {
      raw = readFileSync(path, 'utf8').trim()
    } catch (error) {
      if (isMissingFileError(error)) return { known: true, ledger: undefined }
      this.degrade('groups', `读取 groups.jsonl 失败（${errorCode(error)}）`)
      return { known: false, ledger: undefined }
    }
    if (raw === '') return { known: true, ledger: undefined }
    try {
      const parsed = JSON.parse(raw) as unknown
      // 非对象（`null`/`123`/`"x"`）不是账本：按坏文件处理，别让 getGroupLedger() 返回数字。
      if (typeof parsed !== 'object' || parsed === null) throw new Error('ledger is not an object')
      return { known: true, ledger: parsed as BrowserLedger }
    } catch (error) {
      // 2026-09-15 审计 P2：坏账本不再静默丢弃——原文件改名隔离（`*.corrupt-<ts>`）+
      // 告警，本次以空账本启动（groups 是快照式文件，没法像 JSONL 那样只留能读的部分）。
      const backup = this.quarantine(path)
      this.warn(`[browser-store] groups.jsonl 损坏（${errorCode(error)}）${backup === undefined ? '，且备份失败' : `，原文件已备份为 ${backup}`}；本次以空账本启动`)
      return { known: true, ledger: undefined }
    }
  }

  /** 把坏文件改名隔离（备份名带时间戳）；绝不当场删除或覆盖它。 */
  private quarantine(path: string): string | undefined {
    const backup = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, backup)
      return backup
    } catch {
      return undefined
    }
  }

  private writeLedger(ledger: BrowserLedger): void {
    if (this.degraded.has('groups')) {
      this.pendingLedger = ledger
      return
    }
    try {
      this.writeAtomic(this.filePath('groups'), JSON.stringify(ledger))
    } catch (error) {
      // 账本是快照：降级期间以最后一次保存为准，恢复后补写（见 settleLedger）。
      this.pendingLedger = ledger
      this.degrade('groups', `写入 groups.jsonl 失败（${errorCode(error)}）`)
    }
  }

  // ----------------------------------------------------------------- history

  addHistory(entry: Omit<HistoryEntry, 'seq'>): HistoryEntry {
    // Both fields can carry the same credential: `title` is frequently the URL
    // itself (FIX-06 — `download: ${url}`, `getTitle() || tab.url`), so it gets
    // the text-level redactor, not only the url field.
    // 2026-09-15 审计 P2：同一个函数现在按"散文 / URL 形态"分档用词表，所以
    // `搜索 “key=value” 的含义` 这类散文标题不再被写坏，而 `code=T14&state=x`
    // 这种查询串形态照旧打码（`url` 字段的尺子则完全没动）。
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
    // 2026-09-15 审计 P2：`browser_bookmarks_add` 允许模型自带 title（runtime 只对
    // tab.title 做过投影），这里是**书签标题**的兜底脱敏点——散文段只对强凭据键打码。
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
    // 2026-09-15 审计 P2：`title` 同样走散文分档（tab title 常常就是 URL，那种情况
    // 由 URL 形态那一档兜底），`url` 字段的尺子不变。
    const ledgerTabs: BrowserLedger['tabs'] | undefined = Array.isArray(ledger.tabs) ? ledger.tabs : undefined
    const sanitized: BrowserLedger = ledgerTabs !== undefined && ledgerTabs.length > 0
      ? { ...ledger, tabs: ledgerTabs.map((tab) => ({ ...tab, url: stripSensitiveUrl(tab.url ?? ''), title: stripSensitiveText(tab.title ?? '') })) }
      : ledger
    this.ledger = sanitized
    this.writeLedger(sanitized)
  }

  // ---------------------------------------------------------------- internals

  /**
   * 整文件重写（2026-09-15 审计 P1/P2）。
   *
   * - 只读降级期间**绝不重写**：内存里可能只是磁盘的一个残缺副本，rewrite 会把磁盘上
   *   还完好的记录整批抹掉——这正是"一次瞬时 I/O 错误后整批历史/书签静默消失"的路径。
   *   降级期间的删除/更新/裁剪（rewrite 类操作）不重放，恢复后以磁盘版本为准。
   * - 干净路径改成先写 `.tmp` 再 rename（{@link writeAtomic}）。
   */
  private rewrite(name: string, entries: unknown[]): void {
    if (this.degraded.has(name)) return
    try {
      this.writeAtomic(this.filePath(name), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''))
    } catch (error) {
      this.degrade(name, `重写 ${name}.jsonl 失败（${errorCode(error)}）`)
    }
  }

  /**
   * 原子替换（2026-09-15 审计 P2）：先写同目录 `.tmp`，再 `renameSync` 覆盖目标。
   *
   * 直接 `writeFileSync(目标)` 会**先截断**目标再写：进程被杀、磁盘写满、杀软拦写都会
   * 留下一个"写了一半的 JSON"——账本文件于是整个读不出来，JSONL 则退化成截断文件。
   * rename 在同一文件系统内是原子的：目标要么是旧内容、要么是新内容。
   */
  private writeAtomic(path: string, content: string): void {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  }

  /** 告警出口：注入式（测试断言）或缺省 console.error；告警自身绝不影响浏览器动作。 */
  private warn(message: string): void {
    try {
      const sink = this.options.warn
      if (sink !== undefined) sink(message)
      else console.error(message)
    } catch {
      // 告警出口自己抛错也不能冒泡到浏览器动作上。
    }
  }

  /**
   * 把一个集合标成只读降级（2026-09-15 审计 P1/P2）：拒绝 append/rewrite，并保持
   * `loaded = false`，让下一次 `load()` 成为重试入口。首次进入时告警一次（避免刷屏）。
   */
  private degrade(name: string, reason: string): void {
    if (!this.degraded.has(name)) {
      this.warn(`[browser-store] ${reason}；${name} 进入只读降级：本次不再写入/重写该文件（避免覆盖磁盘上的旧数据），下次 load() 重试`)
    }
    this.degraded.add(name)
    this.loaded = false
  }

  /** 只读降级的集合（诊断/测试用；空数组 = 一切正常）。 */
  degradedCollections(): string[] {
    return [...this.degraded]
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
