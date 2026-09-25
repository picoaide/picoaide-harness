/**
 * Shared archive helpers: entry-path safety validation and size bounds used
 * by both the skill installer and the agent-preset installer. Every archive
 * that is unpacked by this package goes through these checks first.
 *
 * Format: zip（新格式,打包/上传/下载主路径）与 gzipped tar（旧格式,服务端
 * 老行兼容）双支持——按魔数嗅探,老归档仍可安装,新归档统一走 zip。
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { reservedDeviceNameInArchivePath } from './skill-name-rules.ts'

/** Upper bound on a raw archive (bytes). */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

/** Upper bound on the unpacked tree (bytes). */
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

/** Upper bound on archive entries — 与 Go 侧 server/internal/archiveutil 的
 *  MaxEntries(10000) 对齐(2026-09-01 审计:此前仅 Go 侧有该上限,大量
 *  极小的条目在 TS 侧放行、Go 侧拒绝)。 */
const MAX_ENTRIES = 10_000

/**
 * Tar entry types we refuse: links and special files.
 *
 * 链接条目是路径穿越与覆写的载体（`../` 目标、预置同名链接）；
 * 设备/FIFO 条目在解包时会被 `mknod`/`mkfifo` 物化（或让解包器报出裸异常），
 * 而技能包里合法的只有**普通文件与目录**，所以这一类一律拒（独立审计 2026-09-18 P2-3）。
 */
const LINK_TYPES = new Set(['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO'])

/** Unix S_IFLNK extracted from a zip entry's packed attribute. */
const ZIP_MODE_TYPE = 0o170000
const ZIP_S_IFLNK = 0o120000

/**
 * 归档条目里允许落盘的权限位（**两条通道共用同一份口径**）。
 *
 * `0o7000` 是 setuid/setgid/sticky：技能包里没有任何合法用途，而"解包器会把它
 * 原样落盘"正是提权原语（客户端在部分部署里以 root/服务账号运行）。zip 通道早就
 * 掩掉了它（见 {@link extractZip}），tar 通道此前用 node-tar 默认值
 * （`preserveMode` ⇒ 归档写 0o4755 就落 0o4755）——**独立审计 2026-09-23 A8 实测
 * 两条通道行为不一致**：zip 落 755、tar 落 4755。
 */
export const ARCHIVE_MODE_MASK = 0o777

/** Sniff the archive format from its magic bytes. */
export function archiveFormat(data: Buffer): 'zip' | 'tar.gz' | null {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 3 || data[2] === 5 || data[2] === 7)) {
    return 'zip'
  }
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return 'tar.gz'
  }
  return null
}

/** Is this zip entry a symlink? (unix mode bits in the packed attr field) */
function zipEntryIsSymlink(entry: AdmZip.IZipEntry): boolean {
  const unix = entry.attr >>> 16
  return (unix & ZIP_MODE_TYPE) === ZIP_S_IFLNK
}

/** Zip entry path safety: reject absolute/`..`/empty files; directory roots OK. */
function assertSafeZipEntry(entry: AdmZip.IZipEntry): string {
  const raw = entry.entryName
  // 绝对路径必须在 normalize 前检查:posixNormalize 丢弃前导 `/`(空段),
  // normalize 后 startsWith('/') 恒 false(死代码——绝对路径被静默规范化成
  // 相对路径放行而非拒绝;2026-09-01 审计)。`C:\abs`/`C:/abs` 一并拒绝。
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(raw)) {
    throw new Error(`absolute path in archive: ${raw}`)
  }
  const normalized = posixNormalize(raw)
  if (entry.isDirectory) {
    // 根目录自引用条目(`./` 或 `/`): `zip -r skill.zip .` 类打包的常见产物,
    // 规范化后为空且不写任何文件(extractZip 对空目录条目跳过),直接放行;
    // `..` 目录条目仍拒绝(目录穿越)。与 tar 分支 assertSafeEntryPath('')→'' 对齐。
    if (normalized.split('/').includes('..')) {
      throw new Error(`unsafe path in archive: ${raw}`)
    }
    return normalized
  }
  if (normalized === '') throw new Error(`empty path in archive: ${raw}`)
  if (normalized.split('/').includes('..')) throw new Error(`parent traversal in archive: ${raw}`)
  if (zipEntryIsSymlink(entry)) throw new Error(`link entry refused in archive: ${normalized}`)
  assertNoReservedDeviceName(normalized, raw)
  return normalized
}

/**
 * Validate a path from a tar entry for use as a safe relative path or throw.
 * @param rawPath - the entry path as stored in the tar header.
 * @returns the normalized relative path ('' for the pack root).
 */
function assertSafeEntryPath(rawPath: string): string {
  // 绝对路径必须在 normalize 前检查(同 zip 分支):posixNormalize 丢弃前导
  // `/`/`\`(空段),normalize 后 startsWith('/') 恒 false(死代码,2026-09-01)。
  if (rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(rawPath)) {
    throw new Error(`absolute path in archive: ${rawPath}`)
  }
  const normalized = posixNormalize(rawPath)
  if (normalized === '') return ''
  if (normalized.split('/').includes('..')) throw new Error(`parent traversal in archive: ${rawPath}`)
  assertNoReservedDeviceName(normalized, rawPath)
  return normalized
}

/** Posix-style normalize (archive paths are always posix). */
function posixNormalize(raw: string): string {
  const parts: string[] = []
  for (const segment of raw.replace(/\\/gu, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.push('..')
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Refuse a duplicate archive path (P2-11). Two entries with the same path —
 * or paths that collide only by case, which overwrite each other on the
 * case-insensitive filesystems macOS/Windows use — let a "which SKILL.md
 * wins?" archive differ between the reviewer (server takes the FIRST match)
 * and the installer (last write wins). Rejecting keeps both sides aligned.
 * @param seen - lowercased path set accumulated by the caller.
 * @param path - the normalized path of the current entry.
 * @param raw - the original entry name (for the error message).
 */
function assertNoDuplicateEntry(seen: Set<string>, path: string, raw: string): void {
  const key = path.toLowerCase()
  if (seen.has(key)) throw new Error(`duplicate entry in archive: ${raw}`)
  seen.add(key)
}

/**
 * 拒绝归档条目名里的 Windows 保留设备名（R17B-05，两条通道共用）。
 *
 * 技能包在 Linux/macOS 上打得出来、也装得上，但条目名是 `aux.txt` / `nul` /
 * `con/…` 时，Windows 上解包会失败（Win32 设备名语义）—— 而失败文案是系统级的，
 * 用户看不出病根。合法技能包里不会出现这些名字 ⇒ 硬拒绝、零误杀。
 * @param path - 已 normalize 的 posix 相对路径。
 * @param raw - 原始条目名（错误文案用）。
 */
function assertNoReservedDeviceName(path: string, raw: string): void {
  const segment = reservedDeviceNameInArchivePath(path)
  if (segment !== undefined) {
    throw new Error(`reserved device name in archive entry "${segment}" (${raw}): unpacking fails on Windows`)
  }
}

/** Scan a zip buffer: size bounds, path safety, link refusal, duplicate paths. */
function scanZip(archive: Buffer): void {
  let z: AdmZip
  try {
    z = new AdmZip(archive)
  } catch {
    throw new Error('archive invalid')
  }
  let total = 0
  let entries = 0
  const seen = new Set<string>()
  for (const entry of z.getEntries()) {
    entries++
    if (entries > MAX_ENTRIES) {
      throw new Error(`archive has too many entries (${entries} > ${MAX_ENTRIES})`)
    }
    const safePath = assertSafeZipEntry(entry)
    if (!entry.isDirectory) {
      assertNoDuplicateEntry(seen, safePath, entry.entryName)
      total += entry.header.size
      if (total > MAX_UNPACKED_BYTES) {
        throw new Error(`unpacked archive too large (${total} bytes)`)
      }
    }
  }
}

/**
 * Refuse an archive whose entries are unsafe: absolute paths, `..` traversal,
 * empty paths, symbolic/hard links, duplicate (or case-colliding) paths, or
 * an unpacked tree over the bound.
 * zip 条目由 AdmZip 内存扫描;仅 tar.gz 需要落盘给 node-tar 的 listing reader。
 * @param archive - the raw archive bytes (zip or gzipped tar).
 * @throws Error naming the first violation.
 */
export async function assertArchiveSafe(archive: Buffer): Promise<void> {
  if (archiveFormat(archive) === 'zip') {
    scanZip(archive)
    return
  }
  const staging = await mkdtemp(join(tmpdir(), 'pico-archive-scan-'))
  const archiveFile = join(staging, 'archive.tar.gz')
  try {
    await writeFile(archiveFile, archive, { mode: 0o600 })
    let total = 0
    let entries = 0
    let violation: string | null = null
    const seen = new Set<string>()
    await tar.t({
      file: archiveFile,
      onentry: (entry) => {
        if (violation !== null) return
        try {
          // 条目数上限对**两种格式一视同仁**（Go 侧 archiveutil.MaxEntries 也是）。
          // 此前只有 zip 分支计数 ⇒ 10001 个小条目的 tar.gz 能一路落盘
          // （独立审计 2026-09-18 P2-2 实测 10050 条目被接受）。
          entries++
          if (entries > MAX_ENTRIES) {
            throw new Error(`archive has too many entries (${entries} > ${MAX_ENTRIES})`)
          }
          if (entry.type === 'Directory') {
            assertSafeEntryPath(entry.path)
            return
          }
          const safePath = assertSafeEntryPath(entry.path)
          if (safePath === '') throw new Error(`empty path in archive: ${entry.path}`)
          if (LINK_TYPES.has(entry.type)) {
            throw new Error(`link entry refused in archive: ${safePath}`)
          }
          // P2-11: duplicate/case-colliding paths would let the reviewer's
          // first-match view differ from the installer's last-write-wins one.
          assertNoDuplicateEntry(seen, safePath, entry.path)
          total += entry.size ?? 0
          if (total > MAX_UNPACKED_BYTES) {
            throw new Error(`unpacked archive too large (${total} bytes)`)
          }
        } catch (cause) {
          violation = cause instanceof Error ? cause.message : String(cause)
        }
      },
    })
    if (violation !== null) throw new Error(violation)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Extract a previously-validated zip archive into `destDir`. Path safety was
 * already enforced by assertArchiveSafe; this only writes files (listeners
 * get no symlinks or escapes). Directory entries are created, file modes are
 * applied best-effort.
 * @returns the number of files written.
 */
export async function extractZip(archive: Buffer, destDir: string): Promise<void> {
  const z = new AdmZip(archive)
  let writtenBytes = 0
  for (const entry of z.getEntries()) {
    const rel = posixNormalize(entry.entryName)
    if (rel === '' && entry.isDirectory) continue
    const target = join(destDir, ...rel.split('/'))
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(join(target, '..'), { recursive: true })
    const content = entry.getData()
    // `scanZip` trusts the central-directory size, which a crafted archive can
    // understate. Re-check the ACTUAL decompressed bytes before writing: the
    // previous code could OOM the host process on a zip bomb that declared a
    // small size but expanded far past MAX_UNPACKED_BYTES.
    writtenBytes += content.byteLength
    if (writtenBytes > MAX_UNPACKED_BYTES) {
      throw new Error(`unpacked archive too large (${writtenBytes} bytes)`)
    }
    const unix = entry.attr >>> 16
    const mode = (unix & ARCHIVE_MODE_MASK) === 0 ? 0o600 : unix & ARCHIVE_MODE_MASK
    await writeFile(target, content, { mode })
  }
}

/**
 * Extract a previously-validated gzipped tar into `destDir` with the **same
 * mode policy as {@link extractZip}**: every entry lands with
 * `entry.mode & 0o777`, so setuid/setgid/sticky can never reach the disk.
 *
 * 为什么不是"解开之后再剥"：node-tar 默认 `preserveMode` 会先把 0o4755 落到盘上，
 * 再 chmod 就存在"setuid 文件已存在"的窗口（本地攻击者可在这个窗口里执行它）。
 * 这里用 `noChmod: true` 让 node-tar 完全不按归档改权限（文件按 `open(0o666)`、
 * 目录按 `mkdir(mode | 0o700)` 创建），事后再按记录下来的 `mode & 0o777` 逐条
 * chmod —— **落到盘上的任何一刻都不含 0o7000 位**。
 *
 * 顺序：按路径深度**从深到浅** chmod。归档里若把父目录写成 0o500，先收紧父目录
 * 会让子项的 chmod 依赖"属主可 chmod"这一 POSIX 语义（成立，但没必要冒险）。
 * @param archiveFile - the tar.gz already written to disk.
 * @param destDir - the extraction root (already created by the caller).
 * @throws Error when the archive cannot be read (callers treat it as a refusal).
 */
export async function extractTar(archiveFile: string, destDir: string): Promise<void> {
  const modes: Array<{ path: string; mode: number }> = []
  await tar.x({
    file: archiveFile,
    cwd: destDir,
    noChmod: true,
    onentry: (entry) => {
      // 路径安全已由 assertArchiveSafe 的 listing 通过;这里再归一化一次只为
      // 防止把越界路径交给 chmod(它在 destDir 之外也会成功)。
      const safe = posixNormalize(entry.path ?? '')
      if (safe === '' || safe.split('/').includes('..')) return
      const raw = typeof entry.mode === 'number' ? entry.mode : 0o644
      modes.push({ path: safe, mode: raw & ARCHIVE_MODE_MASK })
    },
  })
  modes.sort((a, b) => b.path.split('/').length - a.path.split('/').length)
  for (const { path, mode } of modes) {
    await chmod(join(destDir, ...path.split('/')), mode === 0 ? 0o600 : mode).catch(() => { /* 权限只是尽力;条目本身已落盘 */ })
  }
}
