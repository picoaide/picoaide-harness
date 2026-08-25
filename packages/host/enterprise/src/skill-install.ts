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
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { assertSafeEntryPath, assertArchiveSafe, LINK_TYPES, MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES } from './archive-util.ts'
import { isSafeDshHome } from 'dsh-plugin-desktop/desktop-home'

/** Skill names must be a single safe directory segment. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/** Validate a skill name for use as a single directory segment. */
export function validateSkillName(name: string): string {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`invalid skill name ${JSON.stringify(name)}`)
  }
  return name
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
    // discovered — and carry the gateway-reported version so hasUpdate can
    // compare against the installed copy. Archives that already carry
    // frontmatter are untouched (installer-only archives still get a version
    // injected here only when they lacked any frontmatter; full-control
    // archives keep their own metadata).
    await synthesizeSkillFrontmatter(unpackRoot, name, version)

    // Replace an existing installation only with a fully verified tree.
    // 审计 2026-08-25 P2-4:此前直接 rm(targetDir)+rename——两步之间 crash
    // 窗口会让已装技能目录整个消失。改为「rename 旧 → backup,rename 新 →
    // target,成功后删 backup」;失败时回滚旧目录。
    const targetDir = join(skillsDir, name)
    const backupDir = join(skillsDir, `.${name}.backup-${process.pid}-${Date.now()}`)
    try {
      await rename(targetDir, backupDir).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause // 不存在 = 首次安装
      })
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    try {
      await rename(unpackRoot, targetDir)
    } catch (cause) {
      // 回滚:把旧目录还原,不留半安装状态。
      await rename(backupDir, targetDir).catch(() => { /* 尽力 */ })
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => { /* 尽力 */ })

    // 版本标记:安装在技能目录内写 .install-version(仅当版本已知),
    // host 代理读取它作为 installedVersion(hasUpdate 比较基准)。
    // 不碰 SKILL.md 内容(保留上游/用户归档原样)。
    if (version !== undefined && version !== '') {
      await writeFile(join(targetDir, '.install-version'), version, { mode: 0o600 }).catch(() => { /* 非致命 */ })
    }

    return { name, version, skillsDir, targetDir }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Ensure `SKILL.md` under `dir` carries YAML frontmatter with `name`,
 * `description`, and (when known) `version` (the upstream parser ignores
 * skills without name/description; `version` lets hasUpdate compare reliably
 * against the installed copy). Reads a sibling `metadata.yaml` (gateway
 * format: `name`/`description`/`version` keys) and prepends `---`-delimited
 * frontmatter when the file has none.
 */
export async function synthesizeSkillFrontmatter(dir: string, fallbackName: string, version?: string): Promise<void> {
  const skillMdPath = join(dir, 'SKILL.md')
  const raw = await readFile(skillMdPath, 'utf8')
  // 已有 frontmatter 一律不动(上游/用户归档的元数据保持原样;版本由
  // 安装器写入独立标记文件 .install-version,见 installSkillArchive)。
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
  const metaVersion = typeof meta.version === 'string' && meta.version !== '' ? meta.version : undefined
  const versionValue = version ?? metaVersion
  const frontmatter = stringifyYaml({
    name,
    description,
    ...versionValue === undefined ? {} : { version: versionValue },
  }).trimEnd()
  await writeFile(skillMdPath, `---\n${frontmatter}\n---\n${raw}`)
}

/** Resolve the user skill root from the environment (product home default). */
export function resolveSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim()
  if (home !== undefined && home.length > 0) {
    // 审计 2026-08-25 P2-3:DSH_HOME 不得指向系统关键目录(同机注入面)。
    const resolved = join(home, 'skills')
    if (!isSafeDshHome(home)) {
      throw new Error(`unsafe DSH_HOME: ${home} resolves into a system directory`)
    }
    return resolved
  }
  return join(process.env.HOME ?? tmpdir(), '.picoaide-harness', 'skills')
}

/**
 * List installed skills: directories under the skill root that carry a
 * SKILL.md — the exact layout `installSkillArchive` produces and the
 * upstream `@deepseek-ai/dsh-skill-filesystem` provider discovers. A missing
 * or unreadable root yields an empty list.
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @returns installed skill directory names, sorted.
 */
export async function listInstalledSkills(skillsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!SKILL_NAME_PATTERN.test(entry.name)) continue
    try {
      await stat(join(skillsDir, entry.name, 'SKILL.md'))
      result.push(entry.name)
    } catch {
      // Directory without a SKILL.md — not a skill (or mid-write); skip.
    }
  }
  return result.sort((a, b) => a.localeCompare(b))
}

/**
 * Uninstall one skill: remove `<skillsDir>/<name>` after verifying it really
 * is an installed skill (valid name + SKILL.md present). Everything else is
 * refused, so this API can never delete an arbitrary directory.
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @param name - the skill directory name (single safe segment).
 * @returns the removed directory path.
 * @throws Error when the name is invalid or the skill is not installed.
 */
export async function uninstallSkill(skillsDir: string, name: string): Promise<string> {
  validateSkillName(name)
  const target = join(skillsDir, name)
  try {
    await stat(join(target, 'SKILL.md'))
  } catch {
    throw new Error(`skill "${name}" is not installed`)
  }
  await rm(target, { recursive: true, force: true })
  return target
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

/** One locally authored skill row (name + display metadata from frontmatter). */
export interface LocalSkillRow {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version?: string | undefined
}

/** Extract a trimmed string from an unknown YAML value ('' → undefined). */
function metaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Enumerate locally authored skills (SKILL.md directories under the root)
 * with their frontmatter display metadata: what the upstream filesystem
 * provider discovers. Metadata is best-effort (unreadable frontmatter
 * degrades to the id — presentation, not capability).
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @returns rows sorted by name.
 */
export async function listLocalSkills(skillsDir: string): Promise<LocalSkillRow[]> {
  const names = await listInstalledSkills(skillsDir)
  const rows: LocalSkillRow[] = []
  for (const name of names) {
    const meta = await readSkillFrontmatter(join(skillsDir, name, 'SKILL.md'))
    const displayName = metaString(meta.name)
    const description = metaString(meta.description)
    const version = metaString(meta.version)
    rows.push({
      name,
      ...displayName === undefined ? {} : { displayName },
      ...description === undefined ? {} : { description },
      ...version === undefined ? {} : { version },
    })
  }
  return rows
}

/** Parse the YAML frontmatter of a SKILL.md (best-effort). */
async function readSkillFrontmatter(skillMdPath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(skillMdPath, 'utf8')
  } catch {
    return {}
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (match === null) return {}
  try {
    const parsed = parseYaml(match[1]!) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Unparsable frontmatter: degrade to id (presentation only).
  }
  return {}
}

/** Result of packing one local skill for upload. */
export interface SkillPackResult {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version: string
  checksum: string
  archive: Buffer
}

/**
 * Pack a locally authored skill's WHOLE directory into a gzipped tar whose
 * entries are the directory's contents (the archive root IS the skill
 * directory). Symlinks are packed and then refused by the safety scan, so an
 * archive can never smuggle a reference outside the skill.
 * @param skillsDir - the skill root (`<dshHome>/skills`).
 * @param name - the skill directory name.
 * @param version - upload version (caller-supplied, default 1.0.0).
 * @returns the archive plus metadata, or throws with a user-facing message.
 */
export async function packSkill(skillsDir: string, name: string, version = '1.0.0'): Promise<SkillPackResult> {
  validateSkillName(name)
  const dir = join(skillsDir, name)
  await stat(join(dir, 'SKILL.md')).catch(() => {
    throw new Error(`skill "${name}" has no SKILL.md`)
  })
  const meta = await readSkillFrontmatter(join(dir, 'SKILL.md'))

  const chunks: Buffer[] = []
  await new Promise<void>((resolveP, rejectP) => {
    const stream = tar.c({ gzip: true, cwd: dir, portable: true, follow: false }, ['.'])
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('error', rejectP)
    stream.on('end', () => resolveP())
  })
  const archive = Buffer.concat(chunks)
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`skill archive too large (${archive.byteLength} bytes)`)
  }
  await assertArchiveSafe(archive)
  const checksum = createHash('sha256').update(archive).digest('hex')
  const displayName = metaString(meta.name)
  const description = metaString(meta.description)
  return {
    name,
    ...displayName === undefined ? {} : { displayName },
    ...description === undefined ? {} : { description },
    version,
    checksum,
    archive,
  }
}

/** List installed skills: names only (compat alias). */
export async function listInstalledSkillNames(skillsDir: string): Promise<string[]> {
  return await listInstalledSkills(skillsDir)
}
