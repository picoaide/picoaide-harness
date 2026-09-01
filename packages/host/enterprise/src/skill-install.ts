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
import AdmZip from 'adm-zip'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { assertArchiveSafe, archiveFormat, extractZip, MAX_ARCHIVE_BYTES } from './archive-util.ts'
import { precheckSkillPackage } from './manifest-precheck.ts'
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
  /** 分发渠道(写入溯源标记;缺省 market)。 */
  channel?: 'market' | 'org' | undefined
  /** 来源服务端地址(写入溯源标记)。 */
  server?: string | undefined
}

/**
 * Verify and install one skill archive.
 *
 * @throws Error with a user-facing message on any refusal; never leaves a
 * partial install behind (the staging directory is removed on failure).
 */
export async function installSkillArchive(options: InstallSkillArchiveOptions): Promise<SkillInstallResult> {
  const { name, archive, checksum, skillsDir, version, server } = options
  const channel = options.channel ?? 'market'
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
    const format = archiveFormat(archive)
    if (format === null) throw new Error('unsupported archive format')

    // Pass 1: reject unsafe entries and bound the unpacked size without
    // extracting (zip via AdmZip in-memory scan; tar.gz via node-tar listing).
    // Violations are collected (throwing inside onentry does not terminate
    // the tar stream) and abort the offending entry; the stream still runs
    // to completion, then the first violation is thrown.
    await assertArchiveSafe(archive)

    // Pass 2: extract into the staging directory.
    const unpackRoot = join(staging, 'unpacked')
    await mkdir(unpackRoot, { recursive: true })
    if (format === 'zip') {
      await extractZip(archive, unpackRoot)
    } else {
      const archiveFile = join(staging, 'archive.tar.gz')
      await writeFile(archiveFile, archive, { mode: 0o600 })
      await tar.x({ file: archiveFile, cwd: unpackRoot })
    }

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
    // 溯源标记(决策 2026-09-01 D6):记录应用 ID/版本/渠道/来源服务端与
    // 安装时的内容哈希,客户端据此判定归属与「是否被本地修改过」。
    // 写失败不致命——溯源是展示能力,不影响技能可用性。
    await writeProvenance(targetDir, {
      appId: name,
      version: version ?? '',
      channel,
      ...server === undefined ? {} : { server },
      archiveChecksum: await computeSkillContentHash(targetDir),
      installedAt: new Date().toISOString(),
    }).catch(() => { /* 非致命 */ })

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

/** 安装器写入的溯源目录名(服务端拒绝归档自带同名目录)。 */
export const PROVENANCE_DIR = '.picoaide'

/** 安装来源溯源:客户端据此判断「这份技能是市场上的哪个应用的哪个版本」。 */
export interface SkillProvenance {
  /** 市场/组织库中的应用 ID(= 技能目录名 = frontmatter name)。 */
  appId: string
  /** 安装时的版本号。 */
  version: string
  /** 分发渠道:market=市场,org=组织共享库。 */
  channel: 'market' | 'org'
  /** 来源服务端(多环境时区分)。 */
  server?: string | undefined
  /** 安装时归档的 sha256(本地改动检测的基准)。 */
  archiveChecksum?: string | undefined
  /** 安装时间(ISO)。 */
  installedAt: string
}

/**
 * Write the provenance marker into an installed skill directory.
 * 取代旧的 `.install-version` 单值文件:除版本外还记录应用 ID、渠道、
 * 来源服务端与归档校验和,使客户端能可靠回答「装的是市场哪个技能」。
 */
export async function writeProvenance(skillDir: string, info: SkillProvenance): Promise<void> {
  const dir = join(skillDir, PROVENANCE_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'release.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
}

/** Read the provenance marker; undefined when absent or unreadable. */
export async function readProvenance(skillDir: string): Promise<SkillProvenance | undefined> {
  try {
    const raw = await readFile(join(skillDir, PROVENANCE_DIR, 'release.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SkillProvenance>
    if (typeof parsed.appId !== 'string' || typeof parsed.version !== 'string') return undefined
    const channel = parsed.channel === 'market' || parsed.channel === 'org' ? parsed.channel : 'market'
    return {
      appId: parsed.appId,
      version: parsed.version,
      channel,
      server: typeof parsed.server === 'string' ? parsed.server : undefined,
      archiveChecksum: typeof parsed.archiveChecksum === 'string' ? parsed.archiveChecksum : undefined,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Compute a stable content hash of an installed skill directory, excluding
 * the installer-owned provenance directory. 与安装时记录的归档校验和不同源,
 * 因此只用于「与上次计算相比是否变化」——首次安装时由 writeProvenance
 * 记录当时的内容哈希,之后据此判定本地是否被改动过。
 */
export async function computeSkillContentHash(skillDir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (prefix === '' && entry.name === PROVENANCE_DIR) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`)
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        hash.update(`F:${rel}:`)
        hash.update(await readFile(join(dir, entry.name)))
        hash.update('\n')
      }
    }
  }
  await walk(skillDir, '')
  return hash.digest('hex')
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
 * Pack a locally authored skill's WHOLE directory into a zip whose entries
 * are the directory's contents (the archive root IS the skill directory).
 * Symlinks are refused by the safety scan, so an archive can never smuggle a
 * reference outside the skill.
 *
 * 版本号取自包内 `SKILL.md` 的 frontmatter `version`(决策 2026-09-01
 * 「包内即真相」)。此前这里的默认值 '1.0.0' 让每次上传都声称是 1.0.0——
 * 服务端因此永远看到同一个版本号,「本地与线上版本一致就拒绝」无从判断。
 * @param skillsDir - the skill root (`<dshHome>/skills`).
 * @param name - the skill directory name.
 * @param version - 可选覆盖;缺省时用包内 frontmatter 的 version。
 * @returns the archive plus metadata, or throws with a user-facing message.
 */
export async function packSkill(skillsDir: string, name: string, version?: string): Promise<SkillPackResult> {
  validateSkillName(name)
  const dir = join(skillsDir, name)
  await stat(join(dir, 'SKILL.md')).catch(() => {
    throw new Error(`skill "${name}" has no SKILL.md`)
  })
  const meta = await readSkillFrontmatter(join(dir, 'SKILL.md'))
  const packVersion = version ?? metaString(meta.version)
  if (packVersion === undefined) {
    throw new Error(`技能 "${name}" 的 SKILL.md 缺少 version 字段:请写明版本号(如 version: 1.0.0)后再上传`)
  }

  const zip = new AdmZip()
  await addDirToZip(zip, dir, dir, '')
  const archive = zip.toBuffer()
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`skill archive too large (${archive.byteLength} bytes)`)
  }
  await assertArchiveSafe(archive)
  // 发布前本地预检(决策 §5.5):与服务端同一套规则的前 7 步,错误码一致。
  // 在这里失败就不发请求——用户不必等一次网络往返才知道包不合规。
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const entryNames = zip.getEntries().map((e) => e.entryName)
  const issues = precheckSkillPackage(raw, name, entryNames)
  if (issues.length > 0) {
    const first = issues[0]!
    throw new Error(`${first.code}: ${first.message}${issues.length > 1 ? `（另有 ${issues.length - 1} 项问题）` : ''}`)
  }
  const checksum = createHash('sha256').update(archive).digest('hex')
  const displayName = metaString(meta.name)
  const description = metaString(meta.description)
  return {
    name,
    ...displayName === undefined ? {} : { displayName },
    ...description === undefined ? {} : { description },
    version: packVersion,
    checksum,
    archive,
  }
}

/** Recursively add a directory tree into an AdmZip (relative entry names). */
async function addDirToZip(zip: AdmZip, root: string, dir: string, relPrefix: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    // 溯源目录是安装器的本地产物,不属于技能内容:必须排除,否则重新上传
    // 会被服务端以 PROVENANCE_FORBIDDEN 拒绝(伪造归属防护)。
    if (relPrefix === '' && entry.name === PROVENANCE_DIR) continue
    // 拒绝符号链接:打包时即失败(安装侧同样拒绝)。
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink refused in package: ${rel}`)
    }
    if (entry.isDirectory()) {
      zip.addFile(`${rel}/`, Buffer.alloc(0), '', 0o755)
      await addDirToZip(zip, root, abs, rel)
    } else if (entry.isFile()) {
      const data = await readFile(abs)
      const st = await stat(abs)
      zip.addFile(rel, data, '', st.mode & 0o777)
    }
  }
}

/** List installed skills: names only (compat alias). */
export async function listInstalledSkillNames(skillsDir: string): Promise<string[]> {
  return await listInstalledSkills(skillsDir)
}
