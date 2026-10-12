/** Worker-owned diagnostic archive construction and retention. */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import AdmZip from 'adm-zip'
import { isDesktopLogFileName } from './log-files.ts'
import { collectSessionInventory, type SessionInventory } from './session-inventory.ts'

const DIAGNOSTIC_ARCHIVE = /^diagnostics-\d+(?:-[0-9a-f-]+)?\.zip$/u
const MAX_DIAGNOSTIC_ARCHIVES = 3
/**
 * macOS 原地更新现场（`<userData>/updates/macos/`）的**单文件**上限。
 *
 * 帮手脚本往 `apply-update.log` 里反复追加（见 `macos-update-install.ts`），所以那份
 * 日志没有天然上界，而诊断包是给厂商的支持件：留**尾部**（最近几次尝试）就够定位。
 * 1 MiB ≈ 上万行 shell 日志；三个现场文件合计最多占掉 50 MB 总预算的 3 MiB。
 */
const MACOS_UPDATE_EVIDENCE_FILE_BYTES = 1024 * 1024
/**
 * 截断标记行的字节上界：64 位长度最多 19 位十进制，标记行实际最长约 90 字节。
 * 预算是**硬**的 —— 截断后的条目（标记行 + 尾部）不会超过单文件上限。
 */
const TRUNCATION_MARKER_RESERVE_BYTES = 128
/**
 * 诊断包是桌面产物里最敏感的一份（日志 + Crashpad 内存转储），权限必须与
 * 本包其它私有状态（0600/0700）一致：`adm-zip` 的 `writeZip` 会显式
 * `chmod(path, attr || 0o666)` —— 不传 `perm` 就是 0666，且**绕过 umask**。
 */
const DIAGNOSTIC_DIRECTORY_MODE = 0o700
const DIAGNOSTIC_FILE_MODE = 0o600
const SKIPPABLE_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'ELOOP', 'ENOENT', 'ENOTDIR', 'EPERM'])

interface DiagnosticExportWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly appVersion: string
  readonly maxEvidenceBytes: number
  readonly crashDumpsDir?: string
  readonly runStatePath?: string
  /** Session root whose generation metadata is inventoried; omitted → no inventory entry. */
  readonly sessionsDir?: string
  /** macOS 原地更新的现场文件；缺省（或文件不存在）→ 不收集，也不报错。 */
  readonly macosUpdateEvidence?: MacosUpdateEvidencePaths
}

/**
 * macOS 原地更新的现场文件（`<userData>/updates/macos/`）在磁盘上的位置。
 *
 * 路径由宿主用 `macos-update-install.ts` 的 `macosUpdatePaths()` 解析后传进来 ——
 * 与 `crashDumpsDir`/`runStatePath`/`sessionsDir` 同一口径：worker 不自己推导
 * userData 相对布局（也就不会把那个模块的依赖与模块级常量拉进独立线程）。
 */
export interface MacosUpdateEvidencePaths {
  /** `last-apply.txt`：上一次尝试的结果（`key=value`，失败弹窗读的就是它）。 */
  readonly resultPath: string
  /** `apply-update.log`：帮手脚本的日志（追加型，可能很大）。 */
  readonly logPath: string
  /** `booted.txt`：新版起来后写的启动标记。 */
  readonly bootMarkerPath: string
  /**
   * `failures.txt`：同一版本原地安装失败了几次（审计 A15 的账本）。
   *
   * 写进支持包是为了让"这个版本在这台机器上反复装不上"这件事在支持面可见 ——
   * 否则它只存在于更新目录里，用户不翻就没人知道。
   */
  readonly failuresPath: string
}

export type DiagnosticExportWorkerResult =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly error: string }

interface LogEntry {
  readonly name: string
  readonly path: string
  readonly stats: Stats
}

/** 一个有界证据项：进包的内容（可能含截断标记）+ 被丢掉的字节数（0 = 整份都在）。 */
interface BoundedEvidence {
  readonly content: Buffer
  readonly truncatedBytes: number
}

function skippableFileError(cause: unknown): boolean {
  return cause instanceof Error
    && 'code' in cause
    && typeof cause.code === 'string'
    && SKIPPABLE_FILE_ERRORS.has(cause.code)
}

function regularLogEntry(logsDir: string, name: string): LogEntry | undefined {
  if (!isDesktopLogFileName(name)) return undefined
  const path = join(logsDir, name)
  try {
    const stats = lstatSync(path)
    return !stats.isSymbolicLink() && stats.isFile() ? { name, path, stats } : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  }
}

function regularEvidenceEntry(path: string, name: string): LogEntry | undefined {
  try {
    const stats = lstatSync(path)
    return !stats.isSymbolicLink() && stats.isFile() ? { name, path, stats } : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  }
}

/** 更新现场的收集结论：条目 + 目录不可信时的留痕（不是致命错误）。 */
interface MacosUpdateEvidence {
  readonly entries: readonly LogEntry[]
  readonly error?: string
}

/**
 * 收集 macOS 原地更新的现场文件（结果文件 → 帮手日志 → 启动标记，按信息密度排序）。
 *
 * 三项在磁盘上同属一个目录（见 `macosUpdatePaths()`），所以目录判据只做一次：
 * - 目录不存在 ⇒ 这台机器没跑过原地更新：既不是错误，也不产生条目（空条目是噪音）；
 * - 目录是链接或不是目录 ⇒ 整套跳过，并把原因写进 `system-info.txt`（读别处的
 *   "现场"没有意义）—— 与崩溃转储目录同一条判据，但降级而不是让导出失败。
 *
 * 包内落点镜像磁盘布局（`updates/macos/<文件名>`），文件名取真实路径的 `basename`：
 * 路径唯一真源仍然是 `macosUpdatePaths()`，worker 里不另抄一份文件名清单。
 */
function collectMacosUpdateEvidence(paths: MacosUpdateEvidencePaths | undefined): MacosUpdateEvidence {
  if (paths === undefined) return { entries: [] }
  const ordered = [paths.resultPath, paths.failuresPath, paths.logPath, paths.bootMarkerPath]
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  if (ordered.length === 0) return { entries: [] }
  const directory = dirname(ordered[0]!)
  try {
    const rootStats = lstatSync(directory)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return { entries: [], error: 'refusing linked update evidence directory' }
    }
  } catch (cause) {
    if (skippableFileError(cause)) return { entries: [] }
    throw cause
  }
  const entries: LogEntry[] = []
  for (const path of ordered) {
    const name = basename(path)
    if (name.length === 0) continue
    const entry = regularEvidenceEntry(path, `updates/macos/${name}`)
    if (entry !== undefined) entries.push(entry)
  }
  return { entries }
}

function crashDumpEntries(crashDumpsDir: string | undefined): LogEntry[] {
  if (crashDumpsDir === undefined) return []
  let rootStats: Stats
  try {
    rootStats = lstatSync(crashDumpsDir)
  } catch (cause) {
    if (skippableFileError(cause)) return []
    throw cause
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked crash dump directory')
  }
  const entries: LogEntry[] = []
  const pending = [{ path: crashDumpsDir, relativePath: '' }]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let names: string[]
    try {
      names = readdirSync(directory.path)
    } catch (cause) {
      if (skippableFileError(cause)) continue
      throw cause
    }
    for (const name of names) {
      const path = join(directory.path, name)
      const relativePath = directory.relativePath === '' ? name : `${directory.relativePath}/${name}`
      try {
        const stats = lstatSync(path)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) {
          pending.push({ path, relativePath })
        } else if (stats.isFile() && name.toLowerCase().endsWith('.dmp')) {
          entries.push({ name: `crash-dumps/${relativePath}`, path, stats })
        }
      } catch (cause) {
        if (!skippableFileError(cause)) throw cause
      }
    }
  }
  return entries
}

function readStableLog(entry: LogEntry, remainingBytes: number): Buffer | undefined {
  if (entry.stats.size > remainingBytes) return undefined
  let descriptor: number | undefined
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    descriptor = openSync(entry.path, constants.O_RDONLY | noFollow)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== entry.stats.dev || opened.ino !== entry.stats.ino) return undefined
    if (opened.size > remainingBytes) return undefined
    const data = readFileSync(descriptor)
    return data.byteLength <= remainingBytes ? data : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** 从文件尾部读 `length` 字节（追加型日志里"新内容在末尾"）。 */
function readTailBytes(descriptor: number, size: number, length: number): Buffer | undefined {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const read = readSync(descriptor, buffer, filled, length - filled, size - length + filled)
    if (read <= 0) break
    filled += read
  }
  return filled === 0 ? undefined : buffer.subarray(0, filled)
}

/** 截断标记行。留痕在**内容里**（支持工程师打开包就能看见），不只是元数据。 */
function truncationMarker(keptBytes: number, totalBytes: number): string {
  return `[dsh-plugin-desktop: truncated update evidence, kept last ${String(keptBytes)} of ${String(totalBytes)} bytes]\n`
}

/**
 * 读一个更新现场文件，**至多** `limitBytes` 字节，且绝不越界。
 *
 * - 放得下 ⇒ 整份给（`truncatedBytes` 为 0）；
 * - 放不下 ⇒ 只给尾部并**在内容顶部留一行截断标记**：截断必须留痕，不能静默丢，
 *   也不能把标记挤出预算（标记行先占位，剩下的才是尾部内容的预算）。
 *
 * 与 `readStableLog` 同一条稳定性判据（`O_NOFOLLOW` + `dev`/`ino` 对拍）：文件在
 * 枚举之后被换掉就放弃这一项，交给 `omitted-*` 记账。
 */
function readEvidenceTail(entry: LogEntry, limitBytes: number): BoundedEvidence | undefined {
  let descriptor: number | undefined
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    descriptor = openSync(entry.path, constants.O_RDONLY | noFollow)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== entry.stats.dev || opened.ino !== entry.stats.ino) return undefined
    if (opened.size <= limitBytes) {
      const data = readFileSync(descriptor)
      return data.byteLength <= limitBytes ? { content: data, truncatedBytes: 0 } : undefined
    }
    const tailBudget = limitBytes - TRUNCATION_MARKER_RESERVE_BYTES
    if (tailBudget <= 0) return undefined
    const tail = readTailBytes(descriptor, opened.size, tailBudget)
    if (tail === undefined) return undefined
    // 从行边界开始：包里第一行不该是半行。
    const newline = tail.indexOf(0x0a)
    const aligned = newline === -1 ? tail : tail.subarray(newline + 1)
    const marker = truncationMarker(aligned.byteLength, opened.size)
    if (Buffer.byteLength(marker, 'utf8') > TRUNCATION_MARKER_RESERVE_BYTES) return undefined
    return {
      content: Buffer.concat([Buffer.from(marker, 'utf8'), aligned]),
      truncatedBytes: opened.size - aligned.byteLength,
    }
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function regularArchive(path: string): { path: string, modifiedAt: number } | undefined {
  try {
    const stats = lstatSync(path)
    return !stats.isSymbolicLink() && stats.isFile() ? { path, modifiedAt: stats.mtimeMs } : undefined
  } catch (cause) {
    if (skippableFileError(cause)) return undefined
    throw cause
  }
}

async function createDiagnosticsArchive(data: DiagnosticExportWorkerData): Promise<string> {
  const logsStats = lstatSync(data.logsDir)
  if (logsStats.isSymbolicLink() || !logsStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked log directory')
  }
  const outDir = join(data.userDataDir, 'diagnostics')
  mkdirSync(outDir, { recursive: true, mode: DIAGNOSTIC_DIRECTORY_MODE })
  const outputStats = lstatSync(outDir)
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error('dsh-plugin-desktop: refusing linked diagnostics directory')
  }

  const candidates = readdirSync(data.logsDir)
    .flatMap(name => regularLogEntry(data.logsDir, name) ?? [])
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || b.name.localeCompare(a.name, 'en'))
  const crashCandidates = crashDumpEntries(data.crashDumpsDir)
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || b.name.localeCompare(a.name, 'en'))
  const runStateCandidate = data.runStatePath === undefined
    ? undefined
    : regularEvidenceEntry(data.runStatePath, 'crash-evidence/active-run.json')
  const updateEvidence = collectMacosUpdateEvidence(data.macosUpdateEvidence)
  const zip = new AdmZip()
  let includedBytes = 0
  let omittedFiles = 0
  let includedUpdateFiles = 0
  let omittedUpdateFiles = 0
  let truncatedUpdateFiles = 0
  let includedCrashDumps = 0
  let omittedCrashDumps = 0
  let includedActiveRunMarker = false
  let omittedActiveRunMarker = false
  // 恢复证据（崩溃现场标记）保持原有的**第一**优先级；macOS 原地更新的现场紧随其后
  // —— 失败弹窗指的就是这几个文件，而单文件上限把它整体压在 3 MiB 内，不会挤掉崩溃
  // 转储与日志。更新现场与其它证据共用同一个总预算（`includedBytes` 累加进 50 MB 口径）。
  if (runStateCandidate !== undefined) {
    const content = readStableLog(runStateCandidate, data.maxEvidenceBytes - includedBytes)
    if (content === undefined) {
      omittedActiveRunMarker = true
    } else {
      zip.addFile(runStateCandidate.name, content)
      includedBytes += content.byteLength
      includedActiveRunMarker = true
    }
  }
  for (const entry of updateEvidence.entries) {
    const evidence = readEvidenceTail(
      entry,
      Math.min(MACOS_UPDATE_EVIDENCE_FILE_BYTES, data.maxEvidenceBytes - includedBytes),
    )
    if (evidence === undefined) {
      omittedUpdateFiles += 1
      continue
    }
    zip.addFile(entry.name, evidence.content)
    includedBytes += evidence.content.byteLength
    includedUpdateFiles += 1
    if (evidence.truncatedBytes > 0) truncatedUpdateFiles += 1
  }
  for (const entry of [...crashCandidates, ...candidates]) {
    const content = readStableLog(entry, data.maxEvidenceBytes - includedBytes)
    if (content === undefined) {
      if (entry.name.startsWith('crash-dumps/')) omittedCrashDumps += 1
      else omittedFiles += 1
      continue
    }
    zip.addFile(entry.name, content)
    includedBytes += content.byteLength
    if (entry.name.startsWith('crash-dumps/')) includedCrashDumps += 1
  }
  // P1-12 (2026-09-12): session generation metadata for "the session is gone"
  // reports. This is a separate zip entry and never the session log itself —
  // the owned-log whitelist above is deliberately not widened.
  let sessionInventory: SessionInventory | undefined
  let sessionInventoryError: string | undefined
  if (data.sessionsDir !== undefined) {
    try {
      sessionInventory = collectSessionInventory(data.sessionsDir)
      zip.addFile('session-inventory.json', Buffer.from(`${JSON.stringify(sessionInventory, null, 2)}\n`, 'utf8'))
    } catch (cause) {
      // A forensic extra must never break the export it is attached to.
      sessionInventoryError = (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/gu, ' ')
    }
  }
  const info = [
    'app: dsh-plugin-desktop',
    `desktop-version: ${data.appVersion}`,
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    `node: ${process.version}`,
    `electron: ${process.versions.electron ?? 'unknown'}`,
    `exported: ${new Date().toISOString()}`,
    `included-log-files: ${String(candidates.length - omittedFiles)}`,
    `included-evidence-bytes: ${String(includedBytes)}`,
    `omitted-log-files: ${String(omittedFiles)}`,
    `included-crash-dumps: ${String(includedCrashDumps)}`,
    `omitted-crash-dumps: ${String(omittedCrashDumps)}`,
    `included-active-run-marker: ${String(includedActiveRunMarker)}`,
    `omitted-active-run-marker: ${String(omittedActiveRunMarker)}`,
    `included-update-files: ${String(includedUpdateFiles)}`,
    `omitted-update-files: ${String(omittedUpdateFiles)}`,
    `truncated-update-files: ${String(truncatedUpdateFiles)}`,
    `update-file-byte-limit: ${String(MACOS_UPDATE_EVIDENCE_FILE_BYTES)}`,
    ...(updateEvidence.error === undefined ? [] : [`update-evidence-error: ${updateEvidence.error}`]),
    `evidence-byte-limit: ${String(data.maxEvidenceBytes)}`,
    `included-session-inventory: ${String(sessionInventory !== undefined)}`,
    ...(sessionInventory === undefined
      ? []
      : [
          `session-inventory-sessions: ${String(sessionInventory.totals.sessions)}`,
          `session-inventory-files: ${String(sessionInventory.totals.files)}`,
          `session-inventory-truncated: ${String(sessionInventory.truncated)}`,
        ]),
    ...(sessionInventoryError === undefined ? [] : [`session-inventory-error: ${sessionInventoryError}`]),
    'privacy: logs may contain local paths, workspace IDs, and session IDs; macOS update evidence carries the '
      + 'in-place update helper log and result file (local application paths and version strings); crash dumps may '
      + 'contain process memory; session-inventory.json carries session ids, project directory names, generation '
      + 'file names, sizes and timestamps only, never session contents',
  ].join('\n')
  zip.addFile('system-info.txt', Buffer.from(`${info}\n`, 'utf8'))

  const outPath = join(outDir, `diagnostics-${Date.now()}-${randomUUID()}.zip`)
  const temporaryPath = `${outPath}.tmp`
  try {
    await zip.writeZipPromise(temporaryPath, { perm: DIAGNOSTIC_FILE_MODE })
    // `perm` 已交给 adm-zip,但它是第三方实现(且这里是"给厂商的支持包",
    // 值得兜底):落盘时按本包的私有文件口径再收紧一次。
    chmodSync(temporaryPath, DIAGNOSTIC_FILE_MODE)
    renameSync(temporaryPath, outPath)
  } catch (cause) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The write may have failed before creating its temporary archive.
    }
    throw cause
  }

  const archives = readdirSync(outDir)
    .flatMap((name) => {
      if (!DIAGNOSTIC_ARCHIVE.test(name)) return []
      return regularArchive(join(outDir, name)) ?? []
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.path.localeCompare(a.path, 'en'))
  for (const archive of archives.slice(MAX_DIAGNOSTIC_ARCHIVES)) {
    try {
      unlinkSync(archive.path)
    } catch {
      // A file manager or support upload may temporarily hold an older archive.
    }
  }
  return outPath
}

if (!isMainThread) {
  void createDiagnosticsArchive(workerData as DiagnosticExportWorkerData).then(
    path => { parentPort?.postMessage({ ok: true, path } satisfies DiagnosticExportWorkerResult) },
    (cause: unknown) => {
      const error = cause instanceof Error ? cause.message : String(cause)
      parentPort?.postMessage({ ok: false, error } satisfies DiagnosticExportWorkerResult)
    },
  )
}
