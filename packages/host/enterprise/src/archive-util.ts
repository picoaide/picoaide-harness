/**
 * Shared archive helpers: entry-path safety validation and size bounds used
 * by both the skill installer and the agent-preset installer. Every archive
 * that is unpacked by this package goes through these checks first.
 */

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
