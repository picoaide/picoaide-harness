/**
 * Agent-preset archive installation for the shared-agent store: upload-side
 * packing of a locally authored preset directory (what the 创造模式 creates
 * under `<dshHome>/.agent-presets/<id>`), and download-side verification and
 * safe unpacking back into that same root so the upstream
 * `@deepseek-ai/dsh-agent-presets` roster discovers it as a `user` preset.
 *
 * Security posture mirrors the skill installer:
 * - directory and archive bytes are bounded before any work;
 * - every tar entry path must stay inside the pack/staging dir: absolute
 *   paths, `..` segments, and symbolic/hard links are rejected;
 * - the archive must carry a top-level `agent.cordis.yml`;
 * - the staged tree is moved into place with a same-filesystem rename, and
 *   an existing target directory is never overwritten.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import * as tar from 'tar'
import AdmZip from 'adm-zip'
import { parse as parseYaml } from 'yaml'
import { assertArchiveSafe, archiveFormat, extractZip, MAX_ARCHIVE_BYTES } from './archive-util.ts'
import {
  ArchiveInstallRefusal,
  computeSkillContentHash,
  isStoreProvenance,
  PROVENANCE_DIR,
  readProvenance,
  writeProvenance,
} from './skill-install.ts'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'

/** Agent preset ids mirror the upstream PRESET_ID: lower-case id, directory name. */
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** The composition file that makes a directory a preset (upstream constant). */
const COMPOSITION_FILE = 'agent.cordis.yml'

/** Optional display-metadata file beside the composition (upstream constant). */
const METADATA_FILE = 'preset.yml'

/** Bound on display metadata: the gateway refuses descriptions over 500 chars. */
const MAX_PRESET_META_LEN = 500

/** Display metadata read from `preset.yml` (name/description only). */
interface PresetMeta {
  name?: string | undefined
  description?: string | undefined
}

/** Validate a preset id for use as a single directory segment. */
export function validatePresetId(id: string): string {
  if (!PRESET_ID_PATTERN.test(id)) {
    throw new Error(`invalid preset id ${JSON.stringify(id)}`)
  }
  return id
}

/**
 * Resolve the local preset root: `$DSH_HOME/.agent-presets`（缺省=产品数据根）。
 *
 * 2026-09-11:缺省值走共享的 `dshHomeSafe()`(数据目录唯一权威) —— 数据根随渠道,
 * 自己抄一份 `~/.picoaide-harness` 会在改渠道目录时漏掉。
 */
export function resolvePresetsDir(env: NodeJS.ProcessEnv = process.env): string {
  // 审计 2026-08-25 P2-3:DSH_HOME 不得指向系统关键目录(同机注入面)。
  return join(dshHomeSafe({ env }), '.agent-presets')
}

/**
 * Read one preset directory's display metadata (name/description), tolerating
 * a missing or unparsable `preset.yml` (falls back to the id).
 * @param dir - the preset directory.
 * @returns the metadata, possibly empty.
 */
async function readPresetMeta(dir: string): Promise<PresetMeta> {
  let raw: string
  try {
    raw = await readFile(join(dir, METADATA_FILE), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const pick = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  return {
    ...pick(record.name) === undefined ? {} : { name: pick(record.name) },
    ...pick(record.description) === undefined ? {} : { description: pick(record.description) },
  }
}

/** Result of packing one preset for upload. */
export interface PresetPackResult {
  /** Validated preset id / directory name. */
  name: string
  /** Display name from preset.yml (absent when it published none). */
  displayName?: string | undefined
  /** One-sentence description from preset.yml. */
  description?: string | undefined
  /** sha256 hex of the packed archive (reported to the gateway). */
  checksum: string
  /** The packed zip bytes. */
  archive: Buffer
}

/**
 * Pack a locally authored preset's WHOLE directory into a zip whose entries
 * are the directory's contents (the archive root IS the preset directory).
 *
 * A preset is its directory, not one file: the shipped 创造模式 preset
 * references `skills/` inside its own directory
 * (`new URL('skills/', baseUrl)`), and a copy of it carries that directory —
 * a composition-only pack would install a preset whose skill root is absent.
 * Symlinks are refused by the safety scan, so an archive can never smuggle a
 * reference to a file outside the preset.
 * @param presetsDir - the preset root (`<dshHome>/.agent-presets`).
 * @param name - the preset id.
 * @returns the archive plus metadata, or throws with a user-facing message.
 */
export async function packPreset(presetsDir: string, name: string): Promise<PresetPackResult> {
  validatePresetId(name)
  const dir = join(presetsDir, name)
  // The composition is what makes a directory a preset; refuse early with a
  // readable message rather than uploading an archive the gateway rejects.
  await stat(join(dir, COMPOSITION_FILE)).catch(() => {
    throw new Error(`preset "${name}" has no ${COMPOSITION_FILE}`)
  })
  const meta = await readPresetMeta(dir)

  const zip = new AdmZip()
  await addDirToZip(zip, dir, dir, '')
  const archive = zip.toBuffer()
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`preset archive too large (${archive.byteLength} bytes)`)
  }
  // Same rules the installer applies, enforced here too: a symlink or an
  // escaping path in the source directory must fail on the UPLOADING machine,
  // not on every machine that installs the shared preset.
  await assertArchiveSafe(archive)
  const checksum = createHash('sha256').update(archive).digest('hex')
  return {
    name,
    ...meta.name === undefined ? {} : { displayName: meta.name.slice(0, MAX_PRESET_META_LEN) },
    ...meta.description === undefined ? {} : { description: meta.description.slice(0, MAX_PRESET_META_LEN) },
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
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink refused in package: ${rel}`)
    }
    if (relPrefix === '' && entry.name === PROVENANCE_DIR) continue
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

/** Result of a successful install. */
export interface PresetInstallResult {
  /** The preset id installed. */
  name: string
  /** The final installed directory. */
  targetDir: string
}

export interface InstallPresetArchiveOptions {
  /** Validated preset id. */
  name: string
  /** Raw archive bytes (gzipped tar of the preset directory). */
  archive: Buffer
  /** Optional sha256 hex from the gateway; mismatch refuses. */
  checksum?: string | undefined
  /** The preset root (`<dshHome>/.agent-presets`). */
  presetsDir: string
  /** 安装的版本号(写入溯源标记)。 */
  version?: string | undefined
  /** 分发渠道(写入溯源标记;智能体目前只有组织库)。 */
  channel?: 'market' | 'org' | undefined
  /** 来源服务端地址(写入溯源标记)。 */
  server?: string | undefined
  /**
   * 覆盖本机内容的显式确认（审计 2026-09-23 N2，与技能侧 `installSkillArchive`
   * 同一口径）：目标目录已存在且**不是**能力中心装的（`isStoreProvenance` 为假）
   * 时，没有它一律拒收（409 `LOCAL_CONTENT`）；商店来源的那一份（= 更新智能体）
   * 不需要确认。
   */
  overwrite?: boolean | undefined
}

/** 本机那一份预设的来源：'store'（能力中心装的）或 'local'（用户自制/来源不明）。 */
export async function classifyInstalledPreset(dir: string, name: string): Promise<'store' | 'local'> {
  return isStoreProvenance(await readProvenance(dir), name) ? 'store' : 'local'
}

/**
 * Verify and install one preset archive into the local preset root.
 *
 * @throws Error with a user-facing message on any refusal; never overwrites
 * an existing preset directory and never leaves a partial install behind.
 */
export async function installPresetArchive(options: InstallPresetArchiveOptions): Promise<PresetInstallResult> {
  const { name, archive, checksum, presetsDir } = options
  validatePresetId(name)

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

  await mkdir(presetsDir, { recursive: true, mode: 0o700 })
  const targetDir = join(presetsDir, name)
  // 同名覆盖守卫（审计 2026-09-23 N2）：与技能侧同一份来源判据
  // （isStoreProvenance）。商店来源 = 面板的「更新智能体」；本机自制内容必须由
  // 用户显式确认（面板确认条才会把 `?overwrite=1` 交给宿主）。
  const exists = await stat(targetDir).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return false
      throw cause
    },
  )
  if (exists && await classifyInstalledPreset(targetDir, name) === 'local' && options.overwrite !== true) {
    throw new ArchiveInstallRefusal(
      'LOCAL_CONTENT',
      `a preset named "${name}" already exists locally but was not installed by the Capability Hub; `
      + 'installing would replace it (including your own files) — confirm the overwrite to continue',
    )
  }

  const staging = await mkdtemp(join(presetsDir, `.install-${name}-`))
  /** 回滚也失败时置位：staging 里还躺着用户原有的目录，**不能**随 finally 一起删。 */
  let keepStaging = false
  try {
    const format = archiveFormat(archive)
    if (format === null) throw new Error('unsupported archive format')

    // Pass 1: reject unsafe entries and bound the unpacked size before any
    // extraction (the same scan the packer runs on the uploading machine).
    await assertArchiveSafe(archive)

    // Pass 2: extract into the staging subdir.
    const unpackRoot = join(staging, 'unpacked')
    await mkdir(unpackRoot, { recursive: true })
    if (format === 'zip') {
      await extractZip(archive, unpackRoot)
    } else {
      const archiveFile = join(staging, 'archive.tar.gz')
      await writeFile(archiveFile, archive, { mode: 0o600 })
      await tar.x({ file: archiveFile, cwd: unpackRoot })
    }

    // The archive must carry a top-level composition (flat bundle).
    await stat(join(unpackRoot, COMPOSITION_FILE)).catch(() => {
      throw new Error(`archive has no ${COMPOSITION_FILE} at its root`)
    })

    // Replace an existing installation only with a fully verified tree
    // (与技能侧 installSkillArchive 同形)：先 rename 旧 → backup，再 rename 新 →
    // target，成功后删 backup；失败回滚旧目录 —— 两步之间 crash 也不会让已装
    // 预设目录整个消失。
    const backup = join(staging, 'backup')
    await rename(targetDir, backup).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw cause // 不存在 = 首次安装
    })
    try {
      await rename(unpackRoot, targetDir)
    } catch (cause) {
      // 回滚失败时旧内容**绝不能删**：留在 staging（点号目录 ⇒ 既不被预设花名册
      // 发现、也不被 listInstalledPresets 列出）里供人工恢复，并把 finally 的
      // 清理关掉。与技能侧 installSkillArchive 的 orphan- 处置同一意图。
      await rename(backup, targetDir).catch(() => {
        keepStaging = true
        console.warn(
          `[agent-preset-install] rollback failed for "${name}"; previous content kept in `
          + `${basename(staging)}/${basename(backup)}`,
        )
      })
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    await rm(backup, { recursive: true, force: true }).catch((cause: unknown) => {
      console.warn(`[agent-preset-install] could not remove the backup of "${name}": ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    // 溯源(D6):与技能同构——记录应用 ID/版本/渠道/来源服务端与安装时内容哈希,
    // 客户端据此判定「来自哪里、是否被本地改过」。写失败不致命。
    await writeProvenance(targetDir, {
      appId: name,
      version: options.version ?? '',
      channel: options.channel ?? 'org',
      ...options.server === undefined ? {} : { server: options.server },
      archiveChecksum: await computeSkillContentHash(targetDir),
      installedAt: new Date().toISOString(),
    }).catch(() => { /* 非致命 */ })
    return { name, targetDir }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    if (!keepStaging) await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** List locally installed presets: directories under the root with a composition file. */
export async function listInstalledPresets(presetsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(presetsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!PRESET_ID_PATTERN.test(entry.name)) continue
    try {
      await stat(join(presetsDir, entry.name, COMPOSITION_FILE))
      result.push(entry.name)
    } catch {
      // Directory without a composition — not a preset; skip.
    }
  }
  return result.sort((a, b) => a.localeCompare(b))
}

/** One local preset row (name + optional display metadata) for the panel. */
export interface LocalPresetRow {
  name: string
  displayName?: string | undefined
  description?: string | undefined
}

/**
 * Enumerate locally authored presets with their display metadata: what the
 * 创造模式 roster finds (<dshHome>/.agent-presets/<id>/agent.cordis.yml).
 * @param presetsDir - the local preset root.
 * @returns rows sorted by id, metadata best-effort (unreadable preset.yml
 * degrades to the id — presentation, not capability).
 */
export async function listLocalPresets(presetsDir: string): Promise<LocalPresetRow[]> {
  const names = await listInstalledPresets(presetsDir)
  const rows: LocalPresetRow[] = []
  for (const name of names) {
    const meta = await readPresetMeta(join(presetsDir, name))
    rows.push({
      name,
      ...meta.name === undefined ? {} : { displayName: meta.name },
      ...meta.description === undefined ? {} : { description: meta.description },
    })
  }
  return rows
}

/**
 * Map local presets against the gateway catalog: each local row carries an
 * optional upper-state (pending/approved/rejected from the caller's own
 * uploads, or none = not uploaded yet) and the rejection reason.
 * @param presetsDir - the local preset root.
 * @param gatewayRows - the gateway's visible rows (approved + own).
 * @returns rows sorted by id, status best-effort, reason when rejected.
 */
export async function mapLocalPresets(
  presetsDir: string,
  gatewayRows: readonly { name: string; status: string; reason?: string }[] = [],
): Promise<Record<string, { name: string; displayName?: string; description?: string; status?: string; reason?: string }>> {
  const local = await listLocalPresets(presetsDir)
  const out: Record<string, { name: string; displayName?: string; description?: string; status?: string; reason?: string }> = {}
  for (const row of local) {
    const gateway = gatewayRows.find(g => g.name === row.name)
    out[row.name] = gateway === undefined
      ? { name: row.name, ...row.displayName === undefined ? {} : { displayName: row.displayName }, ...row.description === undefined ? {} : { description: row.description } }
      : {
        name: row.name,
        ...row.displayName === undefined ? {} : { displayName: row.displayName },
        ...row.description === undefined ? {} : { description: row.description },
        status: gateway.status,
        ...gateway.reason === undefined || gateway.reason === '' ? {} : { reason: gateway.reason },
      }
  }
  return out
}

/**
 * Uninstall one preset: remove `<presetsDir>/<name>` after verifying it is
 * an installed preset (valid id + composition present).
 *
 * 来源感知（审计 2026-09-23 N2，与技能侧 `uninstallSkill` 同一口径）：目标目录里的
 * 那一份若不是能力中心装的（没有溯源标记 / 渠道不是商店来源 / appId 对不上），
 * 视为用户自制内容 —— 没有 `overwrite` 显式确认一律拒收（409 `LOCAL_CONTENT`）。
 * @param presetsDir - the local preset root.
 * @param name - the preset id.
 * @param options - `overwrite: true` = 用户已确认删除本机自制内容。
 * @returns the removed directory path.
 * @throws ArchiveInstallRefusal when the name is invalid, the preset is not installed, or local content needs confirmation.
 */
export async function uninstallPreset(
  presetsDir: string,
  name: string,
  options: { overwrite?: boolean | undefined } = {},
): Promise<string> {
  validatePresetId(name)
  const target = join(presetsDir, name)
  let st
  try {
    st = await stat(target)
  } catch {
    throw new ArchiveInstallRefusal('NOT_INSTALLED', `preset "${name}" is not installed`)
  }
  if (!st.isDirectory()) throw new ArchiveInstallRefusal('NOT_INSTALLED', `preset "${name}" is not installed`)
  try {
    await stat(join(target, COMPOSITION_FILE))
  } catch {
    throw new ArchiveInstallRefusal('NOT_INSTALLED', `preset "${name}" is not installed`)
  }
  if (await classifyInstalledPreset(target, name) === 'local' && options.overwrite !== true) {
    throw new ArchiveInstallRefusal(
      'LOCAL_CONTENT',
      `the preset directory "${name}" was not installed by the Capability Hub; `
      + 'deleting it removes your own files — confirm the deletion to continue',
    )
  }
  await rm(target, { recursive: true, force: true })
  return target
}
