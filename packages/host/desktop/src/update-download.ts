/** Headless, confirmation-gated downloads for PicoAide Harness installers. */

// 更新源 = **用户登录的那台服务端**(见 ./desktop-release.ts);客户端到任何
// 分发面的直连路径已于 2026-09-10 移除。安装包地址与 SHA-256 均来自服务端
// 下发的版本清单(GET /api/client/v2/updates/manifest),
// 不再有 GitHub 的资产名匹配与独立 SHA256SUMS 旁路。

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
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

// Single authority: manifest URL assembly + parsing come from ./desktop-release.ts.
export { serverManifestURL } from './desktop-release.ts'

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
   * 服务端版本清单的绝对地址（`serverManifestURL(session.serverURL)`）。
   * 下载与检查共用同一份清单,所以地址由调用方从已登录会话推导。
   */
  readonly manifestURL: string
  /**
   * 期望的渠道 id：由**服务端自己声明**（`GET /api/client/v2/channel`）。
   * 给了就要求清单的 `channel_id` 与它精确相等,否则拒绝下载。
   */
  readonly expectedChannel?: string
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
  readonly downloadUrl: string
  readonly checksum: string
  readonly completedFilename: string
}

/**
 * Download one installer after its caller has obtained user confirmation.
 *
 * 先取服务端版本清单(`/api/client/v2/updates/manifest`)定位本平台安装包的
 * 下载地址与 SHA-256,再流式下载、按清单哈希校验、按平台魔数校验,
 * 最后原子重命名就位。
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
  // 本地目标先校验、再联网:畸形/符号链接的 user-data 路径必须在发出任何
  // 请求之前就被拒(否则会先建立网络连接再报"参数非法",也给了探测面)。
  await assertRealUserDataDirectory(userDataPath)
  throwIfAborted(options.signal)

  // 清单先取:落地文件名由清单里的下载地址决定(渠道化打包下每个渠道的
  // 安装包名跟随该渠道的产品名,写死模板会既泄露厂商品牌又与产物不符)。
  const manifest = await resolveDownloadManifest(
    platform,
    version,
    options.request,
    options.signal,
    options.manifestURL,
    options.expectedChannel,
  )
  throwIfAborted(options.signal)

  const paths = await prepareDownloadPaths(userDataPath, version, manifest.completedFilename)
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

async function assertRealUserDataDirectory(userDataPath: string): Promise<void> {
  const userDataStat = await lstat(userDataPath)
  if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be a real directory.')
  }
}

async function prepareDownloadPaths(
  userDataPath: string,
  version: string,
  filename: string,
): Promise<DownloadPaths> {
  const updatesDirectory = join(userDataPath, 'updates')
  const directory = join(updatesDirectory, version)
  if (resolve(directory) !== directory) {
    throw new UpdateDownloadError('invalid-options', 'The update destination escaped the user-data directory.')
  }
  await preparePrivateDirectory(updatesDirectory)
  await preparePrivateDirectory(directory)

  const completed = join(directory, filename)
  // 文件名来自清单(远端输入):必须仍然是目标目录内的单段普通文件。
  if (resolve(completed) !== completed || dirname(completed) !== directory) {
    throw new UpdateDownloadError('invalid-options', 'The update file name escaped the destination directory.')
  }
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
 * 从服务端版本清单里取出本平台安装包的下载地址与 SHA-256。
 *
 * 清单是唯一权威:地址与哈希都来自它,不再有 GitHub 的资产名模板匹配,
 * 也不再需要单独下载 SHA256SUMS.txt(GitHub 没有可查哈希,才需要那个旁路)。
 * @param platform - selected installer family.
 * @param version - release version the manifest must report.
 * @param request - network boundary.
 * @param signal - caller-owned cancellation.
 * @param manifestURL - 服务端清单的绝对地址。
 * @param expectedChannel - 服务端自报的渠道 id;给了就要求清单与它一致。
 * @returns resolved download manifest for the matched artifact.
 * @throws {UpdateDownloadError} 清单不可达、版本不符、或该平台未发布安装包。
 */
async function resolveDownloadManifest(
  platform: DesktopDownloadPlatform,
  version: string,
  request: UpdateArtifactRequest,
  signal: AbortSignal | undefined,
  manifestURL: string,
  expectedChannel: string | undefined,
): Promise<DownloadManifest> {
  let manifest
  try {
    manifest = await fetchReleaseManifest({
      request,
      manifestURL,
      ...(signal === undefined ? {} : { signal }),
      ...(expectedChannel === undefined ? {} : { expectedChannel }),
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
  // (清单内容随发布更新,理论上两次请求之间可能刚好发布新版本)。
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

  return {
    downloadUrl: asset.url,
    checksum: asset.sha256,
    completedFilename: installerFileName(asset.url, normalizedVersion, platform),
  }
}

/**
 * 从清单里的下载地址推导落地文件名。
 *
 * 不能用固定模板:渠道化打包下每个渠道的安装包名跟随该渠道的产品名,
 * 写死模板既会把厂商品牌留在用户看到的文件名上,也会与实际产物名不符。
 * 清单里的 URL 是权威来源 —— 服务端下发的就是它自己镜像里那个文件。
 * @param downloadURL - 清单里的绝对下载地址(解析器已保证是绝对 https)。
 * @param version - 规范版本号(回退命名用)。
 * @param platform - 目标平台(回退命名用)。
 * @returns 安全的单段文件名。
 */
function installerFileName(
  downloadURL: string,
  version: string,
  platform: DesktopDownloadPlatform,
): string {
  const extension = platform === 'darwin' ? 'dmg' : platform === 'win32' ? 'exe' : 'AppImage'
  let candidate = ''
  try {
    const pathname = new URL(downloadURL).pathname
    candidate = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1))
  } catch {
    candidate = ''
  }
  // 只接受单段、非隐藏、无路径分隔符、无上跳的文件名;否则回退到中性名。
  if (candidate === ''
    || candidate.length > 128
    || candidate.startsWith('.')
    || candidate.includes('/')
    || candidate.includes('\\')
    || candidate.includes('..')) {
    return `update-${version}-${platform}.${extension}`
  }
  return candidate
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
