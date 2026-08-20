/**
 * Skill archive installation: download-side verification and safe unpacking
 * into the user skill root (`<dshHome>/skills/<name>`), which the upstream
 * `@deepseek-ai/dsh-skill-filesystem` provider watches and auto-discovers.
 *
 * Security posture (matches the connector-store review):
 * - archive bytes are bounded (`MAX_ARCHIVE_BYTES`) before any unpacking;
 * - the unpacked tree is bounded (`MAX_UNPACKED_BYTES`) via a dry-run
 *   listing pass;
 * - every tar entry path must stay inside the staging directory: absolute
 *   paths, `..` segments, and symbolic/hard links are rejected;
 * - when the gateway supplies `x-skill-checksum` (sha256 hex), the archive
 *   must match it or installation is refused;
 * - the staged tree is moved into place with a same-filesystem rename after
 *   the SKILL.md check, and an existing target directory is replaced only
 *   after the new tree is fully verified.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Upper bound on a skill archive download (bytes). */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

/** Upper bound on the unpacked skill tree (bytes). */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

/** Skill names must be a single safe directory segment. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/** Tar entry types we refuse: symbolic links and hard links. */
const LINK_TYPES = new Set(['SymbolicLink', 'Link'])

/** Validate a skill name for use as a single directory segment. */
export function validateSkillName(name: string): string {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`invalid skill name ${JSON.stringify(name)}`)
  }
  return name
}

/** Normalize a tar entry path to a safe relative path or throw. */
function assertSafeEntryPath(rawPath: string): string {
  const normalized = posixNormalize(rawPath)
  if (normalized === '') return ''
  if (normalized.startsWith('/')) throw new Error(`absolute path in archive: ${rawPath}`)
  if (normalized.split('/').includes('..')) throw new Error(`parent traversal in archive: ${rawPath}`)
  return normalized
}

/** Posix-style normalize (tar paths are always posix). */
function posixNormalize(raw: string): string {
  const parts: string[] = []
  for (const segment of raw.replace(/\\/gu, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.push('..')
    else parts.push(segment)
  }
  return parts.join('/')
}

/** Result of a successful install. */
export interface SkillInstallResult {
  /** The skill name installed (validated, directory segment). */
  name: string
  /** Version reported by the gateway (`x-skill-version`), when supplied. */
  version?: string | undefined
  /** The user skill root the skill was installed under. */
  skillsDir: string
  /** The final installed directory. */
  targetDir: string
}

export interface InstallSkillArchiveOptions {
  /** Validated skill name. */
  name: string
  /** Raw archive bytes (gzipped tar). */
  archive: Buffer
  /** Optional sha256 hex from the gateway (`x-skill-checksum`); mismatch refuses. */
  checksum?: string | undefined
  /** The user skill root (e.g. `<dshHome>/skills`). */
  skillsDir: string
  /** Optional gateway-reported version (`x-skill-version`), passed through. */
  version?: string | undefined
}

/**
 * Verify and install one skill archive.
 *
 * @throws Error with a user-facing message on any refusal; never leaves a
 * partial install behind (the staging directory is removed on failure).
 */
export async function installSkillArchive(options: InstallSkillArchiveOptions): Promise<SkillInstallResult> {
  const { name, archive, checksum, skillsDir, version } = options
  validateSkillName(name)

  if (archive.byteLength === 0) throw new Error('empty archive')
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive too large (${archive.byteLength} bytes)`)
  }
  if (checksum !== undefined) {
    const actual = createHash('sha256').update(archive).digest('hex')
    if (actual !== checksum.toLowerCase()) {
      throw new Error('archive checksum mismatch; refused')
    }
  }

  // Stage under the skill root so the final rename stays on one filesystem.
  await mkdir(skillsDir, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(skillsDir, `.install-${name}-`))

  try {
    const archiveFile = join(staging, 'archive.tar.gz')
    await writeFile(archiveFile, archive, { mode: 0o600 })

    // Pass 1: list entries without extracting; reject unsafe entries and
    // bound the unpacked size. Directory entries (including the `./` pack
    // root) are structural, not payload: they only need a safe path.
    // Violations are collected (throwing inside onentry does not terminate
    // the tar stream) and abort the offending entry; the stream still runs
    // to completion, then the first violation is thrown.
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

    // Pass 2: extract into the staging directory (node-tar additionally
    // refuses escapes by default; entries were already validated above).
    const unpackRoot = join(staging, 'unpacked')
    await mkdir(unpackRoot, { recursive: true })
    await tar.x({ file: archiveFile, cwd: unpackRoot })

    // The archive must carry a top-level SKILL.md (directory bundle or flat).
    await stat(join(unpackRoot, 'SKILL.md')).catch(() => {
      throw new Error('archive has no SKILL.md at its root')
    })

    // The upstream skill-filesystem parser requires YAML frontmatter
    // (name + description) on SKILL.md; gateway archives keep the metadata
    // in a separate metadata.yaml instead. Synthesize the frontmatter from
    // metadata.yaml when SKILL.md lacks it, so installed skills are
    // discovered. Archives that already carry frontmatter are untouched.
    await synthesizeSkillFrontmatter(unpackRoot, name)

    // Replace an existing installation only with a fully verified tree.
    const targetDir = join(skillsDir, name)
    await rm(targetDir, { recursive: true, force: true })
    await rename(unpackRoot, targetDir)

    return { name, version, skillsDir, targetDir }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Ensure `SKILL.md` under `dir` carries YAML frontmatter with `name` and
 * `description` (the upstream parser ignores skills without them). Reads a
 * sibling `metadata.yaml` (gateway format: `name`/`description` keys) and
 * prepends `---`-delimited frontmatter when the file has none.
 */
export async function synthesizeSkillFrontmatter(dir: string, fallbackName: string): Promise<void> {
  const skillMdPath = join(dir, 'SKILL.md')
  const raw = await readFile(skillMdPath, 'utf8')
  if (raw.trimStart().startsWith('---')) return

  let meta: { name?: unknown; description?: unknown; version?: unknown } = {}
  try {
    const metaRaw = await readFile(join(dir, 'metadata.yaml'), 'utf8')
    const parsed = parseYaml(metaRaw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as { name?: unknown; description?: unknown; version?: unknown }
    }
  } catch {
    // No (or unreadable) metadata.yaml: fall back to the archive name.
  }

  const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : fallbackName
  const description = typeof meta.description === 'string' && meta.description !== ''
    ? meta.description
    : `${fallbackName} skill`
  const frontmatter = stringifyYaml({ name, description }).trimEnd()
  await writeFile(skillMdPath, `---\n${frontmatter}\n---\n${raw}`)
}

/** Resolve the user skill root from the environment (product home default). */
export function resolveSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim()
  if (home !== undefined && home.length > 0) return join(home, 'skills')
  return join(process.env.HOME ?? tmpdir(), '.picoaide-harness', 'skills')
}

/** Sanity helper used by tests: does a directory contain a SKILL.md? */
export async function hasSkillMarkdown(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, 'SKILL.md'))
    return true
  } catch {
    return false
  }
}
