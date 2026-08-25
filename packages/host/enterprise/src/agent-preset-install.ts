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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { parse as parseYaml } from 'yaml'
import { assertArchiveSafe, MAX_ARCHIVE_BYTES } from './archive-util.ts'

/** Agent preset ids mirror the upstream PRESET_ID: lower-case id, directory name. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** The composition file that makes a directory a preset (upstream constant). */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** Optional display-metadata file beside the composition (upstream constant). */
export const METADATA_FILE = 'preset.yml'

/** Bound on display metadata: the gateway refuses descriptions over 500 chars. */
export const MAX_PRESET_META_LEN = 500

/** Display metadata read from `preset.yml` (name/description only). */
export interface PresetMeta {
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

/** Resolve the local preset root: `$DSH_HOME/.agent-presets`, else `~/.picoaide-harness/.agent-presets`. */
export function resolvePresetsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim()
  if (home !== undefined && home.length > 0) return join(home, '.agent-presets')
  return join(process.env.HOME ?? tmpdir(), '.picoaide-harness', '.agent-presets')
}

/**
 * Read one preset directory's display metadata (name/description), tolerating
 * a missing or unparsable `preset.yml` (falls back to the id).
 * @param dir - the preset directory.
 * @returns the metadata, possibly empty.
 */
export async function readPresetMeta(dir: string): Promise<PresetMeta> {
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
  /** The packed gzipped tar bytes. */
  archive: Buffer
}

/**
 * Pack a locally authored preset's WHOLE directory into a gzipped tar whose
 * entries are the directory's contents (the archive root IS the preset
 * directory).
 *
 * A preset is its directory, not one file: the shipped 创造模式 preset
 * references `skills/` inside its own directory
 * (`new URL('skills/', baseUrl)`), and a copy of it carries that directory —
 * a composition-only pack would install a preset whose skill root is absent.
 * Symlinks are packed as entries and then refused by the safety scan below,
 * so an archive can never smuggle a reference to a file outside the preset.
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

  const chunks: Buffer[] = []
  await new Promise<void>((resolveP, rejectP) => {
    const stream = tar.c({ gzip: true, cwd: dir, portable: true, follow: false }, ['.'])
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('error', rejectP)
    stream.on('end', () => resolveP())
  })
  const archive = Buffer.concat(chunks)
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

/** Re-exported from archive-util for backward compat. */
export { assertArchiveSafe } from './archive-util.ts'

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
  // A preset never overwrites: the upstream roster rejects a duplicate id,
  // so replacing an existing directory would silently lose the local one.
  try {
    await stat(targetDir)
    throw new Error(`preset "${name}" already exists locally`)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }

  const staging = await mkdtemp(join(presetsDir, `.install-${name}-`))
  try {
    const archiveFile = join(staging, 'archive.tar.gz')
    await writeFile(archiveFile, archive, { mode: 0o600 })

    // Pass 1: reject unsafe entries and bound the unpacked size before any
    // extraction (the same scan the packer runs on the uploading machine).
    await assertArchiveSafe(archive)

    // Pass 2: extract into the staging subdir.
    const unpackRoot = join(staging, 'unpacked')
    await mkdir(unpackRoot, { recursive: true })
    await tar.x({ file: archiveFile, cwd: unpackRoot })

    // The archive must carry a top-level composition (flat bundle).
    await stat(join(unpackRoot, COMPOSITION_FILE)).catch(() => {
      throw new Error(`archive has no ${COMPOSITION_FILE} at its root`)
    })

    await rename(unpackRoot, targetDir)
    return { name, targetDir }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
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
 * @param presetsDir - the local preset root.
 * @param name - the preset id.
 * @returns the removed directory path.
 * @throws Error when the name is invalid or the preset is not installed.
 */
export async function uninstallPreset(presetsDir: string, name: string): Promise<string> {
  validatePresetId(name)
  const target = join(presetsDir, name)
  let st
  try {
    st = await stat(target)
  } catch {
    throw new Error(`preset "${name}" is not installed`)
  }
  if (!st.isDirectory()) throw new Error(`preset "${name}" is not installed`)
  try {
    await stat(join(target, COMPOSITION_FILE))
  } catch {
    throw new Error(`preset "${name}" is not installed`)
  }
  await rm(target, { recursive: true, force: true })
  return target
}
