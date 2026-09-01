/**
 * Shared archive helpers: entry-path safety validation and size bounds used
 * by both the skill installer and the agent-preset installer. Every archive
 * that is unpacked by this package goes through these checks first.
 *
 * Format: zip（新格式,打包/上传/下载主路径）与 gzipped tar（旧格式,服务端
 * 老行兼容）双支持——按魔数嗅探,老归档仍可安装,新归档统一走 zip。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'

/** Upper bound on a raw archive (bytes). */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

/** Upper bound on the unpacked tree (bytes). */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

/** Tar entry types we refuse: symbolic links and hard links. */
export const LINK_TYPES = new Set(['SymbolicLink', 'Link'])

/** Unix S_IFLNK extracted from a zip entry's packed attribute. */
const ZIP_MODE_TYPE = 0o170000
const ZIP_S_IFLNK = 0o120000

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

/** Zip entry path safety: reject absolute/`..`/empty (directories are OK). */
function assertSafeZipEntry(entry: AdmZip.IZipEntry): string {
  const normalized = posixNormalize(entry.entryName)
  if (entry.isDirectory) {
    if (normalized === '' || normalized.split('/').includes('..')) {
      throw new Error(`unsafe path in archive: ${entry.entryName}`)
    }
    return normalized
  }
  if (normalized === '') throw new Error(`empty path in archive: ${entry.entryName}`)
  if (normalized.startsWith('/')) throw new Error(`absolute path in archive: ${entry.entryName}`)
  if (normalized.split('/').includes('..')) throw new Error(`parent traversal in archive: ${entry.entryName}`)
  if (zipEntryIsSymlink(entry)) throw new Error(`link entry refused in archive: ${normalized}`)
  return normalized
}

/**
 * Validate a path from a tar entry for use as a safe relative path or throw.
 * @param rawPath - the entry path as stored in the tar header.
 * @returns the normalized relative path ('' for the pack root).
 */
export function assertSafeEntryPath(rawPath: string): string {
  const normalized = posixNormalize(rawPath)
  if (normalized === '') return ''
  if (normalized.startsWith('/')) throw new Error(`absolute path in archive: ${rawPath}`)
  if (normalized.split('/').includes('..')) throw new Error(`parent traversal in archive: ${rawPath}`)
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

/** Scan a zip buffer: size bounds, path safety, link refusal. */
function scanZip(archive: Buffer): void {
  let z: AdmZip
  try {
    z = new AdmZip(archive)
  } catch {
    throw new Error('archive invalid')
  }
  let total = 0
  for (const entry of z.getEntries()) {
    assertSafeZipEntry(entry)
    if (!entry.isDirectory) {
      total += entry.header.size
      if (total > MAX_UNPACKED_BYTES) {
        throw new Error(`unpacked archive too large (${total} bytes)`)
      }
    }
  }
}

/**
 * Refuse an archive whose entries are unsafe: absolute paths, `..` traversal,
 * empty paths, symbolic/hard links, or an unpacked tree over the bound.
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
    let violation: string | null = null
    await tar.t({
      file: archiveFile,
      onentry: (entry) => {
        if (violation !== null) return
        try {
          if (entry.type === 'Directory') {
            assertSafeEntryPath(entry.path)
            return
          }
          const safePath = assertSafeEntryPath(entry.path)
          if (safePath === '') throw new Error(`empty path in archive: ${entry.path}`)
          if (LINK_TYPES.has(entry.type)) {
            throw new Error(`link entry refused in archive: ${safePath}`)
          }
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
    const unix = entry.attr >>> 16
    const mode = (unix & 0o777) === 0 ? 0o600 : unix & 0o777
    await writeFile(target, content, { mode })
  }
}
