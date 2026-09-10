/** Headless, confirmation-gated downloads for PicoAide Harness installers. */

// 更新源 = 我方更新服务器(见 ./desktop-release.ts);GitHub Releases 通道已于
// 2026-09-10 移除。安装包地址与 SHA-256 均来自版本清单 `latest.json`,
// 不再有 GitHub 的资产名匹配与独立 SHA256SUMS 旁路。

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  DESKTOP_UPDATE_BASE_URL,
  releaseAssetFor,
  type DesktopReleasePlatform,
} from './desktop-release.ts'
import { fetchReleaseManifest, isAbortFailure as isStandardAbort, parseSemVer } from './update-checker.ts'

/** Desktop platforms with a fixed release asset convention. */
export type DesktopDownloadPlatform = DesktopReleasePlatform

/** Progress of one confirmed update download (bytes). */
export interface UpdateDownloadProgress {
  /** Bytes received so far. */
  readonly receivedBytes: number
  /** Total expected bytes (content-length), or undefined when unknown. */
  readonly totalBytes: number | undefined
}

// Single authority: base URL + manifest parsing come from ./desktop-release.ts.
export { DESKTOP_UPDATE_BASE_URL }

/** Maximum accepted installer size, in bytes. */
export const MAX_UPDATE_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** Failure categories exposed to the update coordinator. */
export type UpdateDownloadErrorCode =
  | 'aborted'
  | 'checksum-mismatch'
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
  /** Canonical release version the manifest must report. */
  readonly version: string
  /** Absolute Electron user-data directory that owns update artifacts. */
  readonly userDataPath: string
  /** Request implementation, normally backed by Electron `net.fetch`. */
  readonly request: UpdateArtifactRequest
  /** Optional cancellation signal owned by the update coordinator. */
  readonly signal?: AbortSignal
  /** Optional progress callback (bytes received / declared total). */
  readonly onProgress?: (progress: UpdateDownloadProgress) => void
  /**
   * 渠道更新面 base（末尾斜杠容错）。缺省按 `channel` 推导。
   */
  readonly baseURL?: string
  /**
   * 本安装所属渠道，**必填**：清单的 `channel_id` 必须与它精确相等，
   * 否则拒绝下载（跨渠道升级 = 品牌被洗掉 / 装到别人的定制版）。
   */
  readonly channel: string
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
const DMG_TRAILER_BYTES = 512
const DMG_TRAILER_MAGIC = Buffer.from('koly', 'ascii')
const DOS_HEADER_BYTES = 64
const PE_OFFSET_POSITION = 0x3c
const PE_MAGIC = Buffer.from([0x50, 0x45, 0x00, 0x00])
/** AppImage magic: 0x41 0x49 0x02 (ELF magic + AppImage type). */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const APPIMAGE_MAGIC_INDEX = 8
const APPIMAGE_MAGIC = Buffer.from('AI\x02', 'ascii')

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
 * 先取版本清单(`<baseURL>/latest.json`)定位本平台安装包的下载地址与 SHA-256,
 * 再流式下载、按清单哈希校验、按平台魔数校验,最后原子重命名就位。
 * @param options - Fixed platform, release version, private storage, request, and cancellation inputs.
 * @returns Absolute path to the completely written and validated installer.
 * @throws {UpdateDownloadError} For invalid inputs, transport failures, rejected responses,
 *   missing releases/platform assets, version mismatches, digest mismatches, cancellation,
 *   and invalid installers.
 */
export async function downloadDesktopUpdate(options: DownloadDesktopUpdateOptions): Promise<string> {
  const platform = validatedPlatform(options.platform)
  const version = validatedVersion(options.version)
  const userDataPath = validatedUserDataPath(options.userDataPath)
  const paths = await prepareDownloadPaths(userDataPath, platform, version)
  throwIfAborted(options.signal)

  const manifest = await resolveDownloadManifest(
    platform,
    version,
    options.request,
    options.signal,
    options.baseURL,
    options.channel,
  )
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
  if (parsed === null || parsed.version !== version) {
    throw new UpdateDownloadError('invalid-options', 'The update version must be strict Semantic Versioning.')
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
 * 从渠道版本清单里取出本平台安装包的下载地址与 SHA-256。
 *
 * 清单是唯一权威:地址与哈希都来自它,不再有 GitHub 的资产名模板匹配,
 * 也不再需要单独下载 SHA256SUMS.txt(GitHub 没有可查哈希,才需要那个旁路)。
 * @param platform - selected installer family.
 * @param version - release version the manifest must report.
 * @param request - network boundary.
 * @param signal - caller-owned cancellation.
 * @param baseURL - 渠道更新面 base(缺省按 channel 推导)。
 * @param channel - 本安装所属渠道;清单 channel_id 必须与它相等。
 * @returns resolved download manifest for the matched artifact.
 * @throws {UpdateDownloadError} 清单不可达、版本不符、或该平台未发布安装包。
 */
async function resolveDownloadManifest(
  platform: DesktopDownloadPlatform,
  version: string,
  request: UpdateArtifactRequest,
  signal: AbortSignal | undefined,
  baseURL: string | undefined,
  channel: string,
): Promise<DownloadManifest> {
  let manifest
  try {
    manifest = await fetchReleaseManifest({
      request,
      channel,
      ...(signal === undefined ? {} : { signal }),
      ...(baseURL === undefined ? {} : { baseURL }),
    })
  } catch (cause) {
    // 取消 → 'aborted'(调用方需能区分"用户取消"与"网络故障")
    if (signal?.aborted === true || isAbortFailure(cause)) {
      throw new UpdateDownloadError('aborted', 'The update manifest request was aborted.', { cause })
    }
    throw new UpdateDownloadError('network', 'The update manifest could not be fetched.', { cause })
  }
  if (manifest === null) {
    throw new UpdateDownloadError('network', 'The update manifest could not be fetched.')
  }

  // 清单版本必须与请求版本一致:否则会把"检查到的新版本"换成另一个版本下载
  // (清单是固定 URL 的可覆盖对象,理论上两次请求之间可能刚好发布新版本)。
  const normalizedVersion = version.replace(/^v/u, '')
  if (manifest.clientVersion.replace(/^v/u, '') !== normalizedVersion) {
    throw new UpdateDownloadError(
      'release-missing',
      `The update manifest reports ${manifest.clientVersion}, expected ${normalizedVersion}.`,
    )
  }

  const asset = releaseAssetFor(manifest, platform)
  if (asset === undefined) {
    throw new UpdateDownloadError(
      'release-missing',
      `The manifest has no installer for platform ${platform}.`,
    )
  }

  const extension = platform === 'darwin' ? 'dmg' : platform === 'win32' ? 'exe' : 'AppImage'
  const assetBase = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'x64-Setup' : 'x86_64'
  return {
    assetName: `PicoAide-Harness-${normalizedVersion}-${assetBase}.${extension}`,
    downloadUrl: asset.url,
    checksum: asset.sha256,
    extension,
    completedFilename: `PicoAide-Harness-${normalizedVersion}-${assetBase}.${extension}`,
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

/**
 * 取消类失败的判定:标准 AbortError(update-checker 的判定)或下载层已归一的
 * `aborted` 错误。两者都要认,否则"用户取消"会被后续 catch 重新归类成网络错误。
 * @param value - 捕获到的异常值。
 * @returns 是取消类失败时为 true。
 */
function isAbortFailure(value: unknown): boolean {
  if (value instanceof UpdateDownloadError && value.code === 'aborted') return true
  return isStandardAbort(value)
}

async function unlinkIfPresent(filename: string): Promise<void> {
  try {
    await unlink(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}
