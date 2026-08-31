/** Headless, confirmation-gated downloads for PicoAide Harness GitHub release installers. */

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseSemVer } from './update-checker.ts'

/** Desktop platforms with a fixed GitHub release asset convention. */
export type DesktopDownloadPlatform = 'darwin' | 'win32' | 'linux'

/** Progress of one confirmed update download (bytes). */
export interface UpdateDownloadProgress {
  /** Bytes received so far. */
  readonly receivedBytes: number
  /** Total expected bytes (content-length), or undefined when unknown. */
  readonly totalBytes: number | undefined
}

/** GitHub repository owning public client releases. */
export const DESKTOP_RELEASE_REPOSITORY = 'picoaide/picoaide-harness'

/** Public endpoint returning the latest stable PicoAide Harness release metadata. */
export const DESKTOP_RELEASE_API_URL =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`

/** Release asset carrying SHA-256 digests for every installer artifact. */
export const RELEASE_CHECKSUM_ASSET_NAME = 'SHA256SUMS.txt'

/** Maximum accepted installer size, in bytes. */
export const MAX_UPDATE_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** Maximum accepted release metadata response bytes. */
export const MAX_RELEASE_METADATA_BYTES = 256 * 1024

/** Maximum accepted checksum manifest bytes. */
export const MAX_CHECKSUM_MANIFEST_BYTES = 64 * 1024

/** Failure categories exposed to the update coordinator. */
export type UpdateDownloadErrorCode =
  | 'aborted'
  | 'checksum-mismatch'
  | 'checksum-missing'
  | 'empty-body'
  | 'http-status'
  | 'invalid-artifact'
  | 'invalid-options'
  | 'network'
  | 'release-missing'
  | 'response-too-large'

/** Fetch-compatible request boundary supplied by the Electron adapter or a test. */
export type UpdateArtifactRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one user-confirmed installer download. */
export interface DownloadDesktopUpdateOptions {
  /** Host platform selecting the fixed asset convention. */
  readonly platform: DesktopDownloadPlatform
  /** Stable release version matched against the release tag and asset name. */
  readonly version: string
  /** Absolute Electron user-data directory that owns update artifacts. */
  readonly userDataPath: string
  /** Request implementation, normally backed by Electron `net.fetch`. */
  readonly request: UpdateArtifactRequest
  /** Optional cancellation signal owned by the update coordinator. */
  readonly signal?: AbortSignal
  /** Optional progress callback (bytes received / declared total). */
  readonly onProgress?: (progress: UpdateDownloadProgress) => void
}

/** Typed failure from installer request, validation, or cancellation. */
export class UpdateDownloadError extends Error {
  /** Stable programmatic failure category. */
  readonly code: UpdateDownloadErrorCode
  /** HTTP status for an unsuccessful response, otherwise undefined. */
  readonly status: number | undefined

  /**
   * Create one safe update-download failure.
   * @param code - Stable failure category.
   * @param message - Diagnostic text without response content.
   * @param options - Optional HTTP status and underlying failure.
   */
  constructor(
    code: UpdateDownloadErrorCode,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UpdateDownloadError'
    this.code = code
    this.status = options.status
  }
}

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const DECIMAL_BYTES = /^(0|[1-9][0-9]*)$/u
const SHA256_PATTERN = /^[0-9a-f]{64}[ \t]+[^\r\n]+$/u
const DMG_TRAILER_BYTES = 512
const DMG_TRAILER_MAGIC = Buffer.from('koly', 'ascii')
const DOS_HEADER_BYTES = 64
const PE_OFFSET_POSITION = 0x3c
const PE_MAGIC = Buffer.from([0x50, 0x45, 0x00, 0x00])
/** AppImage magic: 0x41 0x49 0x02 (ELF magic + AppImage type). */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const APPIMAGE_MAGIC_INDEX = 8
const APPIMAGE_MAGIC = Buffer.from('AI\x02', 'ascii')

interface ReleaseAsset {
  readonly name: string
  readonly browser_download_url: string
}

interface DownloadPaths {
  readonly directory: string
  readonly completed: string
  readonly temporary: string
}

interface DownloadManifest {
  readonly assetName: string
  readonly downloadUrl: string
  readonly checksum: string
  readonly extension: string
  readonly completedFilename: string
}

/**
 * Download one installer after its caller has obtained user confirmation.
 *
 * The release metadata endpoint is queried first to locate the platform
 * installer asset and its SHA-256 digest from the companion checksum asset.
 * The artifact is then streamed, verified against the digest, validated for
 * the platform, and atomically renamed into place.
 * @param options - Fixed platform, release version, private storage, request, and cancellation inputs.
 * @returns Absolute path to the completely written and validated installer.
 * @throws {UpdateDownloadError} For invalid inputs, transport failures, rejected responses,
 *   missing releases, missing digests, digest mismatches, cancellation, and invalid installers.
 */
export async function downloadDesktopUpdate(options: DownloadDesktopUpdateOptions): Promise<string> {
  const platform = validatedPlatform(options.platform)
  const version = validatedVersion(options.version)
  const userDataPath = validatedUserDataPath(options.userDataPath)
  const paths = await prepareDownloadPaths(userDataPath, platform, version)
  throwIfAborted(options.signal)

  const manifest = await resolveDownloadManifest(platform, version, options.request, options.signal)
  throwIfAborted(options.signal)

  let response: Response
  try {
    response = await options.request(manifest.downloadUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) throw aborted(cause)
    throw new UpdateDownloadError('network', 'The update installer could not be downloaded.', { cause })
  }

  if (response.status !== 200) {
    throw new UpdateDownloadError(
      'http-status',
      `The update download service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }
  if (response.body === null) {
    throw new UpdateDownloadError('empty-body', 'The update download service returned an empty body.')
  }
  assertDeclaredSize(response)

  let failure: unknown
  try {
    const declaredTotal = Number(response.headers.get('content-length') ?? '')
    await writeResponseBody(
      paths.temporary,
      response.body,
      options.signal,
      manifest.checksum,
      options.onProgress,
      Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : undefined,
    )
    throwIfAborted(options.signal)
    await validateArtifact(paths.temporary, platform)
    throwIfAborted(options.signal)
    await rename(paths.temporary, paths.completed)
    return paths.completed
  } catch (cause) {
    failure = options.signal?.aborted === true || isAbortFailure(cause) ? aborted(cause) : cause
    throw failure
  } finally {
    try {
      await unlinkIfPresent(paths.temporary)
    } catch (cleanupCause) {
      if (failure === undefined) throw cleanupCause
      throw new AggregateError([failure, cleanupCause], 'Failed to download and clean up the update installer.')
    }
  }
}

function validatedPlatform(platform: DesktopDownloadPlatform): DesktopDownloadPlatform {
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new UpdateDownloadError('invalid-options', `Unsupported update download platform: ${String(platform)}`)
  }
  return platform
}

function validatedVersion(version: string): string {
  const parsed = parseSemVer(version)
  if (parsed === null || parsed.prerelease.length > 0 || parsed.version !== version) {
    throw new UpdateDownloadError('invalid-options', 'The update version must be stable Semantic Versioning.')
  }
  return version
}

function validatedUserDataPath(userDataPath: string): string {
  if (userDataPath.length === 0 || /[\0\r\n]/u.test(userDataPath) || !isAbsolute(userDataPath)) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be an absolute path.')
  }
  return resolve(userDataPath)
}

async function prepareDownloadPaths(
  userDataPath: string,
  platform: DesktopDownloadPlatform,
  version: string,
): Promise<DownloadPaths> {
  const userDataStat = await lstat(userDataPath)
  if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be a real directory.')
  }

  const updatesDirectory = join(userDataPath, 'updates')
  const directory = join(updatesDirectory, version)
  if (resolve(directory) !== directory) {
    throw new UpdateDownloadError('invalid-options', 'The update destination escaped the user-data directory.')
  }
  await preparePrivateDirectory(updatesDirectory)
  await preparePrivateDirectory(directory)

  const extension = platform === 'darwin' ? 'dmg' : platform === 'win32' ? 'exe' : 'AppImage'
  const assetBase = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'x64-Setup' : 'x86_64'
  const filename = `PicoAide-Harness-${version}-${assetBase}.${extension}`
  const completed = join(directory, filename)
  const completedStat = await lstatOptional(completed)
  if (completedStat !== undefined) {
    if (!completedStat.isFile() || completedStat.isSymbolicLink()) {
      throw new UpdateDownloadError('invalid-options', 'The completed update path is not a regular file.')
    }
    await unlink(completed)
  }

  return {
    directory,
    completed,
    temporary: join(directory, `.${filename}.${process.pid}.${randomId()}.partial`),
  }
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'An update destination component is not a real directory.')
  }
  await chmod(directory, PRIVATE_DIRECTORY_MODE)
}

async function lstatOptional(filename: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

/**
 * Fetch release metadata, locate the platform asset, and resolve its digest.
 * @param platform - selected installer family.
 * @param version - release version the asset name must embed.
 * @param request - network boundary.
 * @param signal - caller-owned cancellation.
 * @returns resolved download manifest for the matched artifact.
 */
async function resolveDownloadManifest(
  platform: DesktopDownloadPlatform,
  version: string,
  request: UpdateArtifactRequest,
  signal: AbortSignal | undefined,
): Promise<DownloadManifest> {
  const metadata = await fetchJson<ReleaseMetadata>(request, DESKTOP_RELEASE_API_URL, signal)
  if (metadata === null) {
    throw new UpdateDownloadError('network', 'The latest release metadata could not be fetched.')
  }
  if (!isRecord(metadata) || !Array.isArray(metadata.assets)) {
    throw new UpdateDownloadError('release-missing', 'The latest release has no asset manifest.')
  }
  const normalizedVersion = version.replace(/^v/u, '')
  const expectedName = platform === 'darwin'
    ? `PicoAide-Harness-${normalizedVersion}-mac.dmg`
    : platform === 'win32'
      ? `PicoAide-Harness-${normalizedVersion}-x64-Setup.exe`
      : `PicoAide-Harness-${normalizedVersion}-x86_64.AppImage`
  const asset = metadata.assets.find(
    (entry: unknown): entry is ReleaseAsset =>
      isRecord(entry)
      && typeof entry.name === 'string'
      && typeof entry.browser_download_url === 'string'
      && entry.name === expectedName,
  )
  if (asset === undefined) {
    throw new UpdateDownloadError(
      'release-missing',
      `The latest release has no ${expectedName} asset.`,
    )
  }

  const checksum = await resolveChecksum(request, expectedName, signal)
  const extension = platform === 'darwin' ? 'dmg' : platform === 'win32' ? 'exe' : 'AppImage'
  const assetBase = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'x64-Setup' : 'x86_64'
  return {
    assetName: expectedName,
    downloadUrl: asset.browser_download_url,
    checksum,
    extension,
    completedFilename: `PicoAide-Harness-${normalizedVersion}-${assetBase}.${extension}`,
  }
}

/**
 * Fetch the companion checksum manifest and extract the digest for one asset.
 * @param request - network boundary.
 * @param assetName - expected asset name inside the manifest.
 * @param signal - caller-owned cancellation.
 * @returns lowercase hexadecimal SHA-256 digest.
 * @throws {UpdateDownloadError} When the manifest or entry is missing or malformed.
 */
async function resolveChecksum(
  request: UpdateArtifactRequest,
  assetName: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const metadata = await fetchJson<ReleaseMetadata>(request, DESKTOP_RELEASE_API_URL, signal)
  const assets = isRecord(metadata) && Array.isArray(metadata.assets) ? metadata.assets : []
  const checksumAsset = assets.find(
    (entry: unknown): entry is ReleaseAsset =>
      isRecord(entry)
      && typeof entry.name === 'string'
      && typeof entry.browser_download_url === 'string'
      && entry.name === RELEASE_CHECKSUM_ASSET_NAME,
  )
  if (checksumAsset === undefined) {
    throw new UpdateDownloadError('checksum-missing', 'The latest release has no checksum manifest.')
  }

  let response: Response
  try {
    response = await request(checksumAsset.browser_download_url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (cause) {
    if (signal?.aborted === true || isAbortFailure(cause)) throw aborted(cause)
    throw new UpdateDownloadError('network', 'The checksum manifest could not be downloaded.', { cause })
  }
  if (response.status !== 200) {
    throw new UpdateDownloadError(
      'http-status',
      `The checksum service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }

  let text: string
  try {
    text = await readLimitedBody(response, MAX_CHECKSUM_MANIFEST_BYTES)
  } catch (cause) {
    if (cause instanceof UpdateDownloadError) throw cause
    throw new UpdateDownloadError('response-too-large', 'The checksum manifest is too large.', { cause })
  }

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = SHA256_PATTERN.exec(trimmed)
    if (match === null) continue
    const digest = trimmed.slice(0, 64).toLowerCase()
    // 发布清单文件名为 `find … | xargs sha256sum` 等工具输出,可能带 `./`
    // 前缀(如 `./PicoAide-Harness-2.2.0-x64-Setup.exe`);规范化为裸文件名后
    // 再与资产名严格匹配,否则 v2.2.0 起 CI 产出的清单会永远 checksum-missing。
    const entryName = trimmed.slice(64).trim().replace(/^\.\//u, '')
    if (entryName === assetName) return digest
  }
  throw new UpdateDownloadError('checksum-missing', `The checksum manifest has no digest for ${assetName}.`)
}

/** Fetch one bounded JSON release document from the fixed API endpoint. */
async function fetchJson<T>(
  request: UpdateArtifactRequest,
  url: string,
  signal: AbortSignal | undefined,
): Promise<T | null> {
  let response: Response
  try {
    response = await request(url, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (cause) {
    if (signal?.aborted === true || isAbortFailure(cause)) throw aborted(cause)
    return null
  }
  if (response.status !== 200) return null
  let text: string
  try {
    text = await readLimitedBody(response, MAX_RELEASE_METADATA_BYTES)
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function readLimitedBody(response: Response, limit: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(limit)) {
    throw new UpdateDownloadError('response-too-large', 'The response body is too large.')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > limit) {
        await reader.cancel().catch(() => undefined)
        throw new UpdateDownloadError('response-too-large', 'The response body is too large.')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function assertDeclaredSize(response: Response): void {
  const declared = response.headers.get('content-length')
  if (declared === null || !DECIMAL_BYTES.test(declared)) return
  if (BigInt(declared) > BigInt(MAX_UPDATE_DOWNLOAD_BYTES)) {
    throw new UpdateDownloadError(
      'response-too-large',
      `The update installer exceeds ${String(MAX_UPDATE_DOWNLOAD_BYTES)} bytes.`,
    )
  }
}

async function writeResponseBody(
  filename: string,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  expectedDigest: string,
  onProgress?: (progress: UpdateDownloadProgress) => void,
  totalBytes?: number,
): Promise<void> {
  const handle = await open(filename, 'wx', PRIVATE_FILE_MODE)
  const reader = body.getReader()
  const digestStream = createHash('sha256')
  let bytesWritten = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const chunk = await reader.read()
      throwIfAborted(signal)
      if (chunk.done) break
      if (chunk.value.byteLength > MAX_UPDATE_DOWNLOAD_BYTES - bytesWritten) {
        throw new UpdateDownloadError(
          'response-too-large',
          `The update installer exceeds ${String(MAX_UPDATE_DOWNLOAD_BYTES)} bytes.`,
        )
      }
      await writeAll(handle, chunk.value)
      digestStream.update(chunk.value)
      bytesWritten += chunk.value.byteLength
      onProgress?.({ receivedBytes: bytesWritten, totalBytes })
    }
    if (bytesWritten === 0) {
      throw new UpdateDownloadError('empty-body', 'The update download service returned an empty body.')
    }
    await handle.sync()
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined)
    throw cause
  } finally {
    reader.releaseLock()
    await handle.close()
  }

  const actualDigest = digestStream.digest('hex')
  if (actualDigest !== expectedDigest.toLowerCase()) {
    throw new UpdateDownloadError(
      'checksum-mismatch',
      'The downloaded installer does not match the published SHA-256 digest.',
    )
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null)
    if (result.bytesWritten === 0) throw new Error('The update installer write made no progress.')
    offset += result.bytesWritten
  }
}

async function validateArtifact(filename: string, platform: DesktopDownloadPlatform): Promise<void> {
  const handle = await open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UPDATE_DOWNLOAD_BYTES) {
      throw invalidArtifact(platform)
    }
    if (platform === 'darwin') {
      if (stat.size < DMG_TRAILER_BYTES) throw invalidArtifact(platform)
      const magic = Buffer.alloc(DMG_TRAILER_MAGIC.byteLength)
      const result = await handle.read(magic, 0, magic.byteLength, stat.size - DMG_TRAILER_BYTES)
      if (result.bytesRead !== magic.byteLength || !magic.equals(DMG_TRAILER_MAGIC)) {
        throw invalidArtifact(platform)
      }
      return
    }

    // Linux AppImage: ELF magic at offset 0 + AppImage signature at offset 8.
    if (platform === 'linux') {
      if (stat.size < APPIMAGE_MAGIC_INDEX + APPIMAGE_MAGIC.byteLength) throw invalidArtifact(platform)
      const elf = Buffer.alloc(ELF_MAGIC.byteLength)
      const elfResult = await handle.read(elf, 0, elf.byteLength, 0)
      if (elfResult.bytesRead !== elf.byteLength || !elf.equals(ELF_MAGIC)) {
        throw invalidArtifact(platform)
      }
      const ai = Buffer.alloc(APPIMAGE_MAGIC.byteLength)
      const aiResult = await handle.read(ai, 0, ai.byteLength, APPIMAGE_MAGIC_INDEX)
      if (aiResult.bytesRead !== ai.byteLength || !ai.equals(APPIMAGE_MAGIC)) {
        throw invalidArtifact(platform)
      }
      return
    }

    if (stat.size < DOS_HEADER_BYTES) throw invalidArtifact(platform)
    const dosHeader = Buffer.alloc(DOS_HEADER_BYTES)
    const dosResult = await handle.read(dosHeader, 0, dosHeader.byteLength, 0)
    if (dosResult.bytesRead !== dosHeader.byteLength || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw invalidArtifact(platform)
    }
    const peOffset = dosHeader.readUInt32LE(PE_OFFSET_POSITION)
    if (peOffset > stat.size - PE_MAGIC.byteLength) throw invalidArtifact(platform)
    const peMagic = Buffer.alloc(PE_MAGIC.byteLength)
    const peResult = await handle.read(peMagic, 0, peMagic.byteLength, peOffset)
    if (peResult.bytesRead !== peMagic.byteLength || !peMagic.equals(PE_MAGIC)) {
      throw invalidArtifact(platform)
    }
  } finally {
    await handle.close()
  }
}

function invalidArtifact(platform: DesktopDownloadPlatform): UpdateDownloadError {
  return new UpdateDownloadError(
    'invalid-artifact',
    platform === 'darwin'
      ? 'The downloaded file is not a UDIF disk image.'
      : platform === 'linux'
        ? 'The downloaded file is not an AppImage.'
        : 'The downloaded file is not a PE executable.',
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw aborted(signal.reason)
}

function aborted(cause: unknown): UpdateDownloadError {
  return new UpdateDownloadError('aborted', 'The update installer download was cancelled.', { cause })
}

function isAbortFailure(value: unknown): boolean {
  return value instanceof UpdateDownloadError
    ? value.code === 'aborted'
    : typeof value === 'object'
      && value !== null
      && 'name' in value
      && value.name === 'AbortError'
}

async function unlinkIfPresent(filename: string): Promise<void> {
  try {
    await unlink(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ReleaseMetadata {
  readonly assets?: readonly unknown[]
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}
