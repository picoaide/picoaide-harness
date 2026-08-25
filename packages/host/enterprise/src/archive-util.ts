/**
 * Shared archive helpers: entry-path safety validation and size bounds used
 * by both the skill installer and the agent-preset installer. Every archive
 * that is unpacked by this package goes through these checks first.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'

/** Upper bound on a raw gzipped tar archive (bytes). */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

/** Upper bound on the unpacked tree (bytes). */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

/** Tar entry types we refuse: symbolic links and hard links. */
export const LINK_TYPES = new Set(['SymbolicLink', 'Link'])

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

/** Posix-style normalize (tar paths are always posix). */
export function posixNormalize(raw: string): string {
  const parts: string[] = []
  for (const segment of raw.replace(/\\/gu, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.push('..')
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Refuse an archive whose entries are unsafe: absolute paths, `..` traversal,
 * empty paths, symbolic/hard links, or an unpacked tree over the bound. The
 * archive is written to a temp file because node-tar's listing reader needs a
 * file handle.
 * @param archive - the gzipped tar bytes.
 * @throws Error naming the first violation.
 */
export async function assertArchiveSafe(archive: Buffer): Promise<void> {
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
