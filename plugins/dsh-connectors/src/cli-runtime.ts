/**
 * Download-on-demand runtime for connector CLI tools.
 *
 * Resolution order for a connector CLI command (`dws`, `beisen-cli`, ...):
 *   1. PATH lookup wins — a user-installed CLI is used as-is, nothing is
 *      downloaded and no cache is touched.
 *   2. Otherwise, if a pinned manifest exists for the command, the official
 *      platform archive is downloaded, sha256-verified against the pinned
 *      checksum, extracted into the user cache dir and the native binary is
 *      spawned directly (never the vendor's install scripts, which have
 *      invasive side effects — e.g. dws' postinstall writes skills into
 *      claude/cursor agent dirs).
 *   3. Otherwise `null` — the caller keeps the original command and the
 *      regular ENOENT flow produces the "install the CLI manually" hint.
 *
 * The cache is per command+version under the connector store dir; the binary
 * is only replaced when its marker (pinned archive checksum + extracted
 * binary size) is missing or mismatched. Downloads are deduplicated across
 * concurrent connects.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { CLI_MANIFESTS, cliPlatformKey, type CliBinaryManifest, type CliPlatform } from './cli-manifest.ts'
import { extractArchive, findEntry, readArchiveEntries } from './archive.ts'

export interface ResolvedCommand {
  /** Executable to spawn (absolute path, or the original name). */
  command: string
  args: string[]
  /** True when the executable is a Windows .cmd/.bat shim needing a shell. */
  shell?: boolean
}

/** Progress callback surfaced to the connect UI (e.g. "正在下载…"). */
export type CliProgress = (message: string) => void

export interface CliRuntimeOptions {
  /** Cache root; defaults to `<store dir>/cli` (mirrors ConnectorStore). */
  cacheDir?: string
  /** Manifests override (tests). */
  manifests?: ReadonlyMap<string, CliBinaryManifest>
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch
  downloadTimeoutMs?: number
}

/** Same per-user base as ConnectorStore (`~/.picoaide/connectors`). */
const DEFAULT_CACHE_DIR = join(homedir(), '.picoaide', 'connectors', 'cli')

const DIRECT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024
const NPM_TARBALL_MAX_BYTES = 120 * 1024 * 1024

export class CliRuntime {
  private readonly cacheDir: string
  private readonly manifests: ReadonlyMap<string, CliBinaryManifest>
  private readonly fetchImpl: typeof fetch
  private readonly downloadTimeoutMs: number
  private readonly inflight = new Map<string, Promise<string | null>>()

  constructor(options: CliRuntimeOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR
    this.manifests = options.manifests ?? CLI_MANIFESTS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000
  }

  /**
   * Resolve a CLI command to an executable, downloading the pinned binary
   * when the command is not installed. Returns null when the runtime does not
   * provide this command (caller falls back to the raw name).
   */
  async resolve(command: string, args: string[], onProgress?: CliProgress): Promise<ResolvedCommand | null> {
    const onPath = await findOnPath(command)
    if (onPath) return { command: onPath.path, args, shell: onPath.shell }
    const manifest = this.manifests.get(command)
    if (!manifest) return null
    const binary = await this.ensureBinary(manifest, onProgress)
    if (!binary) return null
    return { command: binary, args }
  }

  /**
   * Ensure the pinned native binary for `manifest` exists in the cache,
   * downloading and extracting it when needed. Returns null on platforms the
   * manifest does not cover.
   */
  async ensureBinary(manifest: CliBinaryManifest, onProgress?: CliProgress): Promise<string | null> {
    const platform = cliPlatformKey(process.platform, process.arch)
    if (!platform) return null
    const key = `${manifest.command}@${manifest.version}`
    const pending = this.inflight.get(key)
    if (pending) return pending
    const run = this.installBinary(manifest, platform, onProgress)
    this.inflight.set(key, run)
    try {
      return await run
    } finally {
      if (this.inflight.get(key) === run) this.inflight.delete(key)
    }
  }

  private async installBinary(
    manifest: CliBinaryManifest,
    platform: CliPlatform,
    onProgress?: CliProgress,
  ): Promise<string | null> {
    // Expected asset is derivable from the manifest alone (no download), so
    // an intact cache is detected before any network traffic happens.
    const expected = this.expectedAsset(manifest, platform)
    if (!expected) return null
    const dir = join(this.cacheDir, manifest.command, manifest.version)
    const binaryName = `${manifest.binaryName}${process.platform === 'win32' ? '.exe' : ''}`
    const binaryPath = join(dir, binaryName)
    const markerPath = join(dir, '.checksum')

    // Fast path: intact cache (marker pins the archive checksum and the
    // extracted binary size, so a truncated/corrupted binary self-heals).
    const cached = await readMarker(markerPath)
    if (cached?.archiveName === expected.archiveName && cached.checksum === expected.checksum) {
      const stat = await fs.stat(binaryPath).catch(() => null)
      if (stat?.isFile() && stat.size === cached.binarySize
        && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) {
        return binaryPath
      }
    }

    const fetched = await this.fetchPlatformArchive(manifest, platform, expected, onProgress)
    onProgress?.(`正在解压并安装 ${manifest.displayName}…`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    // Extract into a sibling tmp dir (same volume -> atomic rename).
    const tmp = join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}`)
    try {
      await fs.mkdir(tmp, { recursive: true, mode: 0o700 })
      const written = await extractArchive(fetched.archive, tmp)
      let extracted = join(tmp, binaryName)
      if (!written.includes(binaryName)) {
        const found = await findFileNamed(tmp, binaryName)
        if (!found) throw new Error(`压缩包内未找到 ${binaryName}`)
        extracted = found
      }
      await fs.rename(extracted, binaryPath)
      await fs.chmod(binaryPath, 0o755)
      const stat = await fs.stat(binaryPath)
      await writeMarker(markerPath, `${expected.archiveName} ${expected.checksum} ${stat.size}\n`)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
    return binaryPath
  }

  /** Derive the expected platform asset from the manifest (no network). */
  private expectedAsset(
    manifest: CliBinaryManifest,
    platform: CliPlatform,
  ): { archiveName: string; checksum: string } | null {
    const source = manifest.source
    if (source.kind === 'npm-package') {
      const asset = source.asset(platform)
      if (!asset) return null
      const checksum = source.checksums[asset]
      if (!checksum) throw new Error(`下载清单缺少 ${asset} 的校验和，请更新插件`)
      return { archiveName: asset, checksum }
    }
    const url = source.url(platform)
    if (!url) return null
    const archiveName = basename(new URL(url).pathname)
    const checksum = source.checksums[archiveName]
    if (!checksum) throw new Error(`下载清单缺少 ${archiveName} 的校验和，请更新插件`)
    return { archiveName, checksum }
  }

  /** Download the pinned platform archive (tarball inner asset or direct URL). */
  private async fetchPlatformArchive(
    manifest: CliBinaryManifest,
    platform: CliPlatform,
    expected: { archiveName: string; checksum: string },
    onProgress?: CliProgress,
  ): Promise<{ archiveName: string; checksum: string; archive: Buffer }> {
    const source = manifest.source
    if (source.kind === 'npm-package') {
      let lastError: unknown
      for (const registry of source.registries) {
        const url = `${registry.replace(/\/+$/, '')}/${source.packageName}/-/${source.packageName}-${source.packageVersion}.tgz`
        onProgress?.(`正在从 ${new URL(url).host} 下载 ${source.packageName}（仅首次连接，约 70MB）…`)
        try {
          const tarballBytes = await this.download(url, NPM_TARBALL_MAX_BYTES)
          const inner = findEntry(readArchiveEntries(tarballBytes), source.innerPath(expected.archiveName))
          if (!inner) throw new Error(`npm 包内未找到 ${source.innerPath(expected.archiveName)}`)
          verifyChecksum(expected.archiveName, inner.data, expected.checksum)
          return { archiveName: expected.archiveName, checksum: expected.checksum, archive: inner.data }
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`下载 ${source.packageName} 失败`)
    }
    const url = source.url(platform)!
    onProgress?.(`正在从 ${new URL(url).host} 下载 ${manifest.displayName}（仅首次连接）…`)
    const bytes = await this.download(url, DIRECT_DOWNLOAD_MAX_BYTES)
    verifyChecksum(expected.archiveName, bytes, expected.checksum)
    return { archiveName: expected.archiveName, checksum: expected.checksum, archive: bytes }
  }

  private async download(url: string, maxBytes: number): Promise<Buffer> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(this.downloadTimeoutMs),
        headers: { 'User-Agent': 'picoaide-connectors/0.1' },
      })
    } catch (error) {
      throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > maxBytes) throw new Error('文件超过大小上限，已拒绝')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) throw new Error('文件超过大小上限，已拒绝')
    return bytes
  }
}

function verifyChecksum(name: string, data: Buffer, expected: string): void {
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) {
    throw new Error(`校验和验证失败（${name}），下载源可能被篡改或清单过期，已中止`)
  }
}

interface CacheMarker {
  archiveName: string
  checksum: string
  binarySize: number
}

async function readMarker(path: string): Promise<CacheMarker | null> {
  try {
    const [archiveName, checksum, size] = (await fs.readFile(path, 'utf8')).trim().split(/\s+/u)
    const binarySize = Number(size)
    if (!archiveName || !checksum || !Number.isSafeInteger(binarySize)) return null
    return { archiveName, checksum, binarySize }
  } catch {
    return null
  }
}

async function writeMarker(path: string, marker: string): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, marker, { mode: 0o600 })
  await fs.rename(tmp, path)
}

async function findFileNamed(root: string, name: string): Promise<string | null> {
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) queue.push(full)
      else if (entry === name) return full
    }
  }
  return null
}

/**
 * Locate `command` on PATH (Windows: PATHEXT-aware). Returns the concrete
 * file path; `.cmd`/`.bat` shims need a shell to spawn.
 */
export async function findOnPath(command: string): Promise<{ path: string; shell: boolean } | null> {
  const isWin = process.platform === 'win32'
  const pathVar = process.env.PATH ?? ''
  const extensions = isWin
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : ['']
  const separators = isWin ? /[;:]/u : /:/u
  for (const dir of pathVar.split(separators)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      try {
        const stat = await fs.stat(candidate)
        if (!stat.isFile()) continue
        if (!isWin && (stat.mode & 0o111) === 0) continue
        return { path: candidate, shell: isWin && /\.(cmd|bat)$/iu.test(ext) }
      } catch {
        // Not in this directory; keep looking.
      }
    }
  }
  return null
}
