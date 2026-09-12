/** Headless, resumable, integrity-checked downloads for PicoAide Harness installers. */

// 更新源 = **用户登录的那台服务端**(见 ./desktop-release.ts);客户端到任何
// 分发面的直连路径已于 2026-09-10 移除。安装包地址与 SHA-256 均来自服务端
// 下发的版本清单(GET /api/client/v2/updates/manifest),
// 不再有 GitHub 的资产名匹配与独立 SHA256SUMS 旁路。
//
// 2026-09-12 健壮化:一次传输失败不再等于放弃 —— 未完成的字节留在
// `<name>.partial`(带 `<name>.partial.json` 记来源、总长与校验器),重试时用
// Range 续传;完整且校验通过的安装包在下一次检查时直接复用(不再重下)。
// 服务端 `/updates/client/*` 走 `http.ServeFile`,本身自带 Range 支持。

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  releaseAssetFor,
  type DesktopReleaseManifest,
  type DesktopReleasePlatform,
} from './desktop-release.ts'
import { fetchReleaseManifest, isAbortFailure as isStandardAbort, parseSemVer } from './update-checker.ts'

/** Desktop platforms with a fixed release asset convention. */
export type DesktopDownloadPlatform = DesktopReleasePlatform

/** Progress of one confirmed update download (bytes). */
export interface UpdateDownloadProgress {
  /** Bytes received so far, counting bytes kept from an earlier attempt. */
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
  /**
   * The coordinator already resolved this version's manifest for the current
   * session. Passing it removes one redundant manifest request from the
   * download path and keeps both from disagreeing on the asset.
   */
  readonly manifest?: DesktopReleaseManifest
}

/** Inputs for one resumable installer transfer. */
export interface FetchUpdateInstallerOptions {
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
  /** Absolute manifest URL; required unless `installed` is provided. */
  readonly manifestURL?: string
  /**
   * 期望的渠道 id：由**服务端自己声明**（`GET /api/client/v2/channel`）。
   * 给了就要求清单的 `channel_id` 与它精确相等,否则拒绝下载。
   */
  readonly expectedChannel?: string
  /** The version's manifest, already fetched by the caller. */
  readonly manifest?: DesktopReleaseManifest
  /**
   * A previous {@link resolveUpdateInstaller} answer. Reusing it keeps the
   * resume offset and the completed-file decision from being computed twice.
   */
  readonly installed?: InstalledUpdate
}

/** Where one version's installer lives, and whether it is already complete. */
export interface InstalledUpdate {
  /** Canonical version the installer belongs to. */
  readonly version: string
  /** Absolute path of the completed installer. */
  readonly path: string
  /** Absolute path of the resumable partial transfer. */
  readonly partialPath: string
  /** Absolute URL the installer is downloaded from. */
  readonly downloadURL: string
  /** SHA-256 the manifest publishes for this installer. */
  readonly sha256: string
  /** Declared size, or 0 when the manifest omits it. */
  readonly size: number
  /** Completed bytes of an earlier interrupted attempt (0 when none are usable). */
  readonly resumeBytes: number
  /** Whether {@link path} already holds this exact verified installer. */
  readonly complete: boolean
}

/** Typed failure from installer request, validation, or cancellation. */
export class UpdateDownloadError extends Error {
  /** Stable programmatic failure category. */
  readonly code: UpdateDownloadErrorCode
  /** HTTP status for an unsuccessful response, otherwise undefined. */
  readonly status: number | undefined
  /**
   * Whether repeating the same transfer can plausibly succeed.
   *
   * Transport failures, 5xx responses, an empty or oversized body, and a digest
   * mismatch (the transfer was cut short, and its partial file is kept) are
   * retriable; a 4xx response, a release without this platform's asset,
   * malformed options, and a structurally invalid artifact are not.
   */
  readonly retriable: boolean

  /**
   * Create one safe update-download failure.
   * @param code - Stable failure category.
   * @param message - Diagnostic text without response content.
   * @param options - Optional HTTP status, retriability, and underlying failure.
   */
  constructor(
    code: UpdateDownloadErrorCode,
    message: string,
    options: { readonly status?: number; readonly retriable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UpdateDownloadError'
    this.code = code
    this.status = options.status
    this.retriable = options.retriable ?? DEFAULT_RETRIABLE[code]
  }
}

/**
 * Default retriability per failure category.
 *
 * The `false` entries are answers that will not change by asking again: the
 * caller cancelled, the request was malformed, the release does not carry this
 * platform, or the bytes are not the documented installer format.
 */
const DEFAULT_RETRIABLE: Readonly<Record<UpdateDownloadErrorCode, boolean>> = {
  aborted: false,
  'checksum-mismatch': true,
  'empty-body': true,
  'http-status': false,
  'invalid-artifact': false,
  'invalid-options': false,
  network: true,
  'release-missing': false,
  'response-too-large': true,
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
/** Version of the sidecar describing one resumable partial transfer. */
const PARTIAL_STATE_VERSION = 1
/** Bytes hashed per read while finishing a kept partial transfer. */
const VERIFY_CHUNK_BYTES = 1024 * 1024

interface DownloadPaths {
  readonly directory: string
  readonly completed: string
  readonly temporary: string
  readonly temporaryState: string
}

/** Sidecar describing the bytes already written to one partial transfer. */
interface PartialTransferState {
  readonly version: number
  readonly downloadURL: string
  readonly sha256: string
  readonly receivedBytes: number
  readonly etag?: string
  readonly lastModified?: string
}

/** Outcome of one installer transfer. */
interface TransferResult {
  /** Absolute path of the completed installer. */
  readonly path: string
  /** Installer bytes. */
  readonly size: number
}

/**
 * Download one installer after its caller has obtained user confirmation.
 *
 * 先取服务端版本清单(`/api/client/v2/updates/manifest`)定位本平台安装包的
 * 下载地址与 SHA-256,复用已校验完成的安装包或续传未完成的字节,流式下载后按
 * 清单哈希校验、按平台魔数校验,最后原子重命名就位。
 * @param options - Fixed platform, release version, private storage, request, and cancellation inputs.
 * @returns Absolute path to the completely written and validated installer.
 * @throws {UpdateDownloadError} For invalid inputs, transport failures, rejected responses,
 *   missing releases/platform assets, version mismatches, digest mismatches, cancellation,
 *   and invalid installers.
 */
export async function downloadDesktopUpdate(options: DownloadDesktopUpdateOptions): Promise<string> {
  const transferred = await fetchUpdateInstaller({
    platform: options.platform,
    version: options.version,
    userDataPath: options.userDataPath,
    request: options.request,
    manifestURL: options.manifestURL,
    ...(options.expectedChannel === undefined ? {} : { expectedChannel: options.expectedChannel }),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
  return transferred.path
}

/**
 * Locate one version's installer without moving a single byte.
 *
 * Answers whether the exact installer is already on disk, how many bytes of an
 * interrupted transfer can be resumed, and which absolute paths the transfer
 * uses. The manifest request happens only when the caller does not supply one.
 * @param options - platform, version, private storage, request, and manifest inputs.
 * @returns the verified paths plus the reuse/resume decisions.
 * @throws {UpdateDownloadError} For invalid inputs, an unreachable manifest, a version
 *   mismatch, or a release without an installer for this platform.
 */
export async function resolveUpdateInstaller(
  options: FetchUpdateInstallerOptions,
): Promise<InstalledUpdate> {
  const platform = validatedPlatform(options.platform)
  const version = validatedVersion(options.version)
  const userDataPath = await validatedUserDataPath(options.userDataPath)
  // 本地目标先校验、再联网:畸形/符号链接的 user-data 路径必须在发出任何
  // 请求之前就被拒(否则会先建立网络连接再报"参数非法",也给了探测面)。
  throwIfAborted(options.signal)

  const manifest = options.manifest ?? await fetchManifestFor(options)
  throwIfAborted(options.signal)

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
  const downloadURL = asset?.url
  if (asset === undefined || downloadURL === undefined) {
    throw new UpdateDownloadError(
      'release-missing',
      `The manifest has no installer for platform ${platform}.`,
    )
  }

  const paths = await prepareDownloadPaths(
    userDataPath,
    version,
    installerFileName(downloadURL, normalizedVersion, platform),
  )
  const size = asset.size > 0 ? asset.size : 0
  const shared = {
    version,
    downloadURL,
    sha256: asset.sha256.toLowerCase(),
    size,
  } as const

  if (await isVerifiedInstaller(paths.completed, platform, size, shared.sha256)) {
    return { ...shared, path: paths.completed, partialPath: paths.temporary, resumeBytes: 0, complete: true }
  }
  return {
    ...shared,
    path: paths.completed,
    partialPath: paths.temporary,
    resumeBytes: await resumableBytes(paths, shared),
    complete: false,
  }
}

/**
 * Stream one version's installer to completion, resuming an earlier attempt.
 *
 * A returned path is always a fully validated installer (digest, size when the
 * manifest declares one, and platform container magic). Failures keep the
 * received bytes in a `.partial` file with a sidecar describing their origin,
 * so the next attempt continues instead of restarting.
 * @param options - resolved installer and transfer inputs, or the inputs to resolve it.
 * @returns the completed path and byte count; `reused` marks an installer that was
 *   already complete before this call and therefore transferred nothing.
 * @throws {UpdateDownloadError} For transport failures, rejected responses, digest or
 *   format mismatches, and cancellation.
 */
export async function fetchUpdateInstaller(
  options: FetchUpdateInstallerOptions,
): Promise<TransferResult & { readonly reused: boolean }> {
  const installed = options.installed ?? await resolveUpdateInstaller(options)
  throwIfAborted(options.signal)
  if (installed.complete) return { path: installed.path, size: installed.size, reused: true }

  const platform = validatedPlatform(options.platform)
  const version = validatedVersion(options.version)
  const userDataPath = await validatedUserDataPath(options.userDataPath)
  const paths = await prepareDownloadPaths(
    userDataPath,
    version,
    installerFileName(installed.downloadURL, version.replace(/^v/u, ''), platform),
  )
  const progress = options.onProgress
  const startBytes = installed.resumeBytes
  if (startBytes > 0) progress?.({ receivedBytes: startBytes, totalBytes: installed.size > 0 ? installed.size : undefined })

  const failure = await streamInstaller(paths, {
    request: options.request,
    downloadURL: installed.downloadURL,
    sha256: installed.sha256,
    expectedSize: installed.size,
    startBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(progress === undefined ? {} : { onProgress: progress }),
  })
  if (failure !== undefined) throw failure
  // 传输自身通过(可能整段都在本地):完成件必须先通过平台魔数校验才交出。
  // 内容与清单哈希一致、却不是本平台的安装包容器 —— 这份字节没有续传价值
  // (重试还是同一份),必须删掉,不能留在待安装位置。
  try {
    await validateArtifact(paths.completed, platform)
  } catch (cause) {
    await unlinkIfPresent(paths.completed)
    throw cause
  }
  return { path: paths.completed, size: await statSize(paths.completed), reused: false }
}

/**
 * 取回并解析某版本的清单(续传与复用都不需要它的调用方可直接给 `manifest`)。
 * @param options - request, manifest URL, expected channel, and cancellation.
 * @returns the parsed manifest.
 * @throws {UpdateDownloadError} 清单不可达(网络)或结构/渠道校验失败。
 */
async function fetchManifestFor(
  options: FetchUpdateInstallerOptions,
): Promise<DesktopReleaseManifest> {
  const manifestURL = options.manifestURL
  if (manifestURL === undefined) {
    throw new UpdateDownloadError('invalid-options', 'The update manifest URL is required.')
  }
  const signal = options.signal
  try {
    const manifest = await fetchReleaseManifest({
      request: options.request,
      manifestURL,
      ...(signal === undefined ? {} : { signal }),
      ...(options.expectedChannel === undefined ? {} : { expectedChannel: options.expectedChannel }),
    })
    if (manifest === null) {
      throw new UpdateDownloadError('network', 'The update manifest could not be fetched.')
    }
    return manifest
  } catch (cause) {
    if (cause instanceof UpdateDownloadError) throw cause
    // 取消 → 'aborted'(调用方需能区分"用户取消"与"网络故障")
    if (signal?.aborted === true || isAbortFailure(cause)) {
      throw new UpdateDownloadError('aborted', 'The update manifest request was aborted.', { cause })
    }
    throw new UpdateDownloadError('network', 'The update manifest could not be fetched.', { cause })
  }
}

/**
 * 下载已完成的安装包是否可信到可以直接复用。
 *
 * 复用不是"文件存在就算":必须是普通文件(不是符号链接),声明了长度时必须等长,
 * 内容必须与本次清单的 SHA-256 相同(ETag/Last-Modified 不参与 —— 哈希是权威)。
 * @returns 通过全部校验时为 true。
 */
async function isVerifiedInstaller(
  filename: string,
  platform: DesktopDownloadPlatform,
  expectedSize: number,
  expectedDigest: string,
): Promise<boolean> {
  let stat
  try {
    stat = await lstat(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_UPDATE_DOWNLOAD_BYTES) {
    return false
  }
  if (expectedSize > 0 && stat.size !== expectedSize) return false
  if (await sha256OfFile(filename) !== expectedDigest) return false
  try {
    await validateArtifact(filename, platform)
    return true
  } catch {
    // 内容与清单哈希一致、但不是本平台的安装包容器:按"不可复用"处理,交给重新下载。
    return false
  }
}

/**
 * 已有 `.partial` 里可以安全续传的字节数。
 *
 * 必须同时满足:sidecar 存在且结构与来源指向本次同一地址/同一哈希、长度与声明
 * 的清单长度不冲突、文件不小于 sidecar 记录的长度。任何一条不满足都从 0 开始
 * (宁可从零重下,也不拼出一份来源混杂的文件)。
 * @returns 可续传字节数;没有可用残留时为 0。
 */
async function resumableBytes(
  paths: DownloadPaths,
  expected: { readonly downloadURL: string; readonly sha256: string; readonly size: number },
): Promise<number> {
  let state: PartialTransferState
  try {
    state = parsePartialState(await readFile(paths.temporaryState, 'utf8'))
  } catch {
    // sidecar 缺失/损坏/不可信:这份残留不能证明来源,也不能证明写入完整。
    return 0
  }
  if (state.downloadURL !== expected.downloadURL || state.sha256 !== expected.sha256) return 0
  const stat = await lstatOptional(paths.temporary)
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) return 0
  if (stat.size <= 0 || stat.size > MAX_UPDATE_DOWNLOAD_BYTES) return 0
  if (expected.size > 0 && stat.size > expected.size) return 0
  // sidecar 在每块写入后刷新,但仍可能落后于实际字节(例如最后一块写完前后崩溃):
  // 以两者中较小的值为准,多出来的字节必然会被后续写入覆盖。
  return Math.min(Number(stat.size), Math.max(0, Math.trunc(state.receivedBytes)))
}

/** 解析 sidecar;任何字段不可信都抛错(调用方据此从零开始)。 */
function parsePartialState(text: string): PartialTransferState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid partial state')
  const record = value as Record<string, unknown>
  if (record.version !== PARTIAL_STATE_VERSION) throw new Error('invalid partial state version')
  if (typeof record.downloadURL !== 'string' || !record.downloadURL.startsWith('https://')) {
    throw new Error('invalid partial state url')
  }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sha256)) {
    throw new Error('invalid partial state digest')
  }
  if (typeof record.receivedBytes !== 'number' || !Number.isSafeInteger(record.receivedBytes) || record.receivedBytes < 0) {
    throw new Error('invalid partial state length')
  }
  const etag = typeof record.etag === 'string' && record.etag !== '' ? record.etag : undefined
  const lastModified = typeof record.lastModified === 'string' && record.lastModified !== ''
    ? record.lastModified
    : undefined
  return {
    version: PARTIAL_STATE_VERSION,
    downloadURL: record.downloadURL,
    sha256: record.sha256,
    receivedBytes: record.receivedBytes,
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  }
}

/**
 * 传输(或复用)一份安装包,返回首个失败;成功时文件已在 `paths.completed`。
 *
 * 三种路径:残留已满(长度与清单声明一致)→ 只做摘要校验;有可续传字节 →
 * Range 续传,服务端不认 206 就退回整份重下;否则整份下。
 * @param paths - completed/temporary targets.
 * @param transfer - request boundary, source URL, validators, and progress.
 * @returns 失败对象,或 undefined 表示完成件已就位。
 */
async function streamInstaller(
  paths: DownloadPaths,
  transfer: Transfer,
): Promise<UpdateDownloadError | undefined> {
  const expectedTotal = transfer.expectedSize > 0 ? transfer.expectedSize : undefined
  const startBytes = Math.max(0, transfer.startBytes)
  // 先取一次取消状态:经过任一 await 之后 TypeScript 会把 `signal.aborted` 收窄成
  // 字面量 false,catch 里再判就永远为假(实际运行时仍可能已被取消)。
  const abortedBeforeStreaming = transfer.signal?.aborted === true

  // 残留已经等于清单声明的长度:不花流量,直接按哈希确认;不符就整份重下。
  // `startBytes > 0` 是必要条件:没有残留时 startBytes 是 0,"0 >= 0" 会把
  // "没有文件"误判成"文件已完整"。
  if (startBytes > 0 && expectedTotal !== undefined && startBytes >= expectedTotal) {
    if (await sha256OfFile(paths.temporary) === transfer.sha256) {
      await unlinkIfPresent(paths.temporaryState)
      await rename(paths.temporary, paths.completed)
      return undefined
    }
    await removePartial(paths)
  }

  const previous = await readPartialState(paths.temporaryState)
  let offset = 0
  const resumeFrom = startBytes > 0 && previous !== undefined
    && (previous.etag !== undefined || previous.lastModified !== undefined)
    ? startBytes
    : 0
  // If-Range 让服务端在内容已变时**直接回整份**(RFC 9110),省掉我们自己
  // 发现"拼不上"再重来的一趟。验证器缺失时退回无条件 Range,由响应校验兜底。
  const ifRange = previous === undefined
    ? undefined
    : conditionalValidator(new Headers(), previous, 'HEAD', false)
  const headers: Record<string, string> = {}
  if (resumeFrom > 0) {
    headers.Range = `bytes=${String(resumeFrom)}-`
    if (ifRange !== undefined) headers['If-Range'] = ifRange.slice(ifRange.indexOf(':') + 1)
  }

  let response: Response
  try {
    response = await transfer.request(transfer.downloadURL, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      headers,
      ...(transfer.signal === undefined ? {} : { signal: transfer.signal }),
    })
  } catch (cause) {
    if (transfer.signal?.aborted === true || isAbortFailure(cause)) return aborted(cause)
    return new UpdateDownloadError('network', 'The update installer could not be downloaded.', { cause })
  }

  if (response.status === 206 && resumeFrom > 0
    && contentRangeStart(response) === resumeFrom
    && resumeValidatorMatches(response.headers, previous)) {
    offset = resumeFrom
  } else if (resumeFrom > 0) {
    // 服务端忽略了 Range(CDN 实测会把尾段请求当整份返回)或换了内容版本:
    // 关掉这一份,重新请求整份,绝不把来源不一致的字节拼在一起。
    await response.body?.cancel().catch(() => undefined)
    try {
      response = await transfer.request(transfer.downloadURL, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow',
        ...(transfer.signal === undefined ? {} : { signal: transfer.signal }),
      })
    } catch (cause) {
      if (transfer.signal?.aborted === true || isAbortFailure(cause)) return aborted(cause)
      return new UpdateDownloadError('network', 'The update installer could not be downloaded.', { cause })
    }
  }

  if (response.status !== 200 && response.status !== 206) {
    return new UpdateDownloadError(
      'http-status',
      `The update download service returned HTTP ${String(response.status)}.`,
      { status: response.status, retriable: response.status >= 500 || response.status === 408 },
    )
  }
  if (response.body === null) {
    return new UpdateDownloadError('empty-body', 'The update download service returned an empty body.')
  }
  const declared = declaredContentLength(response)
  if (declared !== undefined && declared + offset > MAX_UPDATE_DOWNLOAD_BYTES) {
    return new UpdateDownloadError(
      'response-too-large',
      `The update installer exceeds ${String(MAX_UPDATE_DOWNLOAD_BYTES)} bytes.`,
    )
  }
  if (transfer.signal?.aborted === true) return aborted(transfer.signal.reason)

  const totalBytes = expectedTotal ?? (declared === undefined ? undefined : declared + offset)
  const sidecar: PartialTransferState = {
    version: PARTIAL_STATE_VERSION,
    downloadURL: transfer.downloadURL,
    sha256: transfer.sha256,
    receivedBytes: offset,
    ...validatorFields(response.headers),
  }

  let failure: UpdateDownloadError | undefined
  let received: number = 0
  const digestStream = createHash('sha256')
  try {
    if (offset > 0) {
      await hashFileInto(digestStream, paths.temporary, offset)
    } else {
      await removePartial(paths)
    }
    received = await writeTransfer({
      filename: paths.temporary,
      stateFilename: paths.temporaryState,
      body: response.body,
      offset,
      digestStream,
      partial: sidecar,
      totalBytes,
      ...(transfer.signal === undefined ? {} : { signal: transfer.signal }),
      ...(transfer.onProgress === undefined ? {} : { onProgress: transfer.onProgress }),
    })
  } catch (cause) {
    if (abortedBeforeStreaming || isAbortFailure(cause)) return aborted(cause)
    return cause instanceof UpdateDownloadError
      ? cause
      : new UpdateDownloadError('network', 'The update installer could not be downloaded.', { cause })
  } finally {
    await response.body.cancel().catch(() => undefined)
  }

  if (received === 0) {
    failure = new UpdateDownloadError('empty-body', 'The update download service returned an empty body.')
  } else if (totalBytes !== undefined && received !== totalBytes) {
    // 连接在中途被切断:字节留在 .partial 里,下一次用 Range 续传。
    // 一个字节都没收到(服务端声明了长度却立刻关流)是"空响应",不是截断。
    failure = new UpdateDownloadError(
      received === 0 ? 'empty-body' : 'network',
      received === 0
        ? 'The update download service returned an empty body.'
        : `The update download ended after ${String(received)} of ${String(totalBytes)} bytes.`,
    )
  } else if (digestStream.digest('hex') !== transfer.sha256) {
    // 与服务端发布的哈希不符:极可能是被截断的传输 —— 保留字节以便续传,
    // 若下一次仍不符,长度校验会先失败并整份重下。
    failure = new UpdateDownloadError(
      'checksum-mismatch',
      'The downloaded installer does not match the published SHA-256 digest.',
    )
  }
  if (failure !== undefined) {
    // 一个字节都没收到:这份空 .partial 没有续传价值,留着只会让目录里多一个
    // 永远长不大的残留(而且下一次会从 0 重新开始)。
    if (received === 0) await removePartial(paths)
    return failure
  }

  await unlinkIfPresent(paths.temporaryState)
  await rename(paths.temporary, paths.completed)
  return undefined
}

/** One installer transfer's source, validators, progress, and cancellation. */
interface Transfer {
  readonly request: UpdateArtifactRequest
  readonly downloadURL: string
  readonly sha256: string
  readonly expectedSize: number
  readonly startBytes: number
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: UpdateDownloadProgress) => void
}

/**
 * 写入响应体并同步 sidecar,返回写入的总字节数。
 * @returns 完成件 + 本次新增的字节数。
 */
async function writeTransfer(input: {
  readonly filename: string
  readonly stateFilename: string
  readonly body: ReadableStream<Uint8Array>
  readonly offset: number
  readonly digestStream: ReturnType<typeof createHash>
  readonly partial: PartialTransferState
  readonly totalBytes: number | undefined
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: UpdateDownloadProgress) => void
}): Promise<number> {
  const handle = await open(input.filename, input.offset === 0 ? 'w' : 'r+')
  const reader = input.body.getReader()
  let received = input.offset
  let reported: PartialTransferState = input.partial
  try {
    if (input.offset === 0) await handle.truncate(0)
    await writePartialState(input.stateFilename, input.partial)
    while (true) {
      throwIfAborted(input.signal)
      const chunk = await reader.read()
      throwIfAborted(input.signal)
      if (chunk.done) break
      if (chunk.value.byteLength > MAX_UPDATE_DOWNLOAD_BYTES - received) {
        throw new UpdateDownloadError(
          'response-too-large',
          `The update installer exceeds ${String(MAX_UPDATE_DOWNLOAD_BYTES)} bytes.`,
        )
      }
      await writeAll(handle, chunk.value, received)
      input.digestStream.update(chunk.value)
      received += chunk.value.byteLength
      reported = { ...reported, receivedBytes: received }
      await writePartialState(input.stateFilename, reported)
      input.onProgress?.({ receivedBytes: received, totalBytes: input.totalBytes })
    }
    await handle.sync()
    return received
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined)
    throw cause
  } finally {
    reader.releaseLock()
    await handle.close()
  }
}

async function writePartialState(filename: string, state: PartialTransferState): Promise<void> {
  try {
    await writeFileAtomic(filename, `${JSON.stringify(state)}\n`, {
      mode: PRIVATE_FILE_MODE,
      dirMode: PRIVATE_DIRECTORY_MODE,
    })
  } catch {
    // sidecar 只影响"能不能续传":写不进去最多让下一次从零开始,不能因此失败。
  }
}

async function readPartialState(filename: string): Promise<PartialTransferState | undefined> {
  try {
    return parsePartialState(await readFile(filename, 'utf8'))
  } catch {
    return undefined
  }
}

function validatorFields(headers: Headers): { readonly etag?: string, readonly lastModified?: string } {
  const etag = headers.get('etag')
  const lastModified = headers.get('last-modified')
  return {
    ...(etag === null || etag === '' ? {} : { etag }),
    ...(lastModified === null || lastModified === '' ? {} : { lastModified }),
  }
}

/** 续传请求要带的验证器:优先强 ETag,其次 Last-Modified(都可能缺失)。 */
function conditionalValidator(
  headers: Headers,
  previous: PartialTransferState | undefined,
  method: 'HEAD' | 'GET',
  includeGetFallback: boolean,
): string | undefined {
  if (previous === undefined) return undefined
  if (method === 'HEAD' && previous.etag !== undefined) return `etag:${previous.etag}`
  if (previous.lastModified !== undefined) return `last-modified:${previous.lastModified}`
  if (!includeGetFallback || previous.etag === undefined) return undefined
  const etag = headers.get('etag')
  return etag === previous.etag ? `etag:${previous.etag}` : undefined
}

/**
 * 续传响应的验证器是否仍指向同一份内容。
 *
 * 只有 sidecar 记下了 ETag 或 Last-Modified 时才做这项比对 —— 都没有时,
 * 由哈希与长度两道关兜底(与 electron-updater 的取舍一致)。
 */
function resumeValidatorMatches(
  headers: Headers,
  previous: PartialTransferState | undefined,
): boolean {
  if (previous === undefined) return false
  const expected = conditionalValidator(headers, previous, 'GET', true)
  if (expected === undefined) return true
  const [kind, value] = expected.split(':', 2) as [string, string]
  const actual = kind === 'etag' ? headers.get('etag') : headers.get('last-modified')
  return actual === value
}

/** `Content-Range: bytes <start>-<end>/<total>` 的起始偏移;不符合时为 undefined。 */
function contentRangeStart(response: Response): number | undefined {
  const value = response.headers.get('content-range')
  if (value === null) return undefined
  const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(?:[0-9]+|\*)$/u.exec(value.trim())
  if (match === null) return undefined
  return Number(match[1])
}

function declaredContentLength(response: Response): number | undefined {
  const declared = response.headers.get('content-length')
  if (declared === null || !DECIMAL_BYTES.test(declared)) return undefined
  const value = Number(declared)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function hashFileInto(
  digestStream: ReturnType<typeof createHash>,
  filename: string,
  bytes: number,
): Promise<void> {
  const handle = await open(filename, 'r')
  const buffer = Buffer.allocUnsafe(Math.min(VERIFY_CHUNK_BYTES, Math.max(1, bytes)))
  let offset = 0
  try {
    while (offset < bytes) {
      const length = Math.min(buffer.byteLength, bytes - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead === 0) throw new Error('The partial update installer ended early.')
      digestStream.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally {
    await handle.close()
  }
}

async function sha256OfFile(filename: string): Promise<string> {
  const digestStream = createHash('sha256')
  // 按文件真实长度读:用无界长度循环会多读一次并在 EOF 上抛错(2026-09-12 实测,
  // 症状是"复用已下载好的安装包"永远判成不可复用)。
  const { size } = await lstat(filename)
  await hashFileInto(digestStream, filename, Number(size))
  return digestStream.digest('hex')
}

async function statSize(filename: string): Promise<number> {
  const stat = await lstat(filename)
  return stat.size
}

async function removePartial(paths: DownloadPaths): Promise<void> {
  await unlinkIfPresent(paths.temporary)
  await unlinkIfPresent(paths.temporaryState)
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

async function validatedUserDataPath(userDataPath: string): Promise<string> {
  if (userDataPath.length === 0 || /[\0\r\n]/u.test(userDataPath) || !isAbsolute(userDataPath)) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be an absolute path.')
  }
  const resolved = resolve(userDataPath)
  const userDataStat = await lstat(resolved)
  if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be a real directory.')
  }
  return resolved
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
  if (completedStat !== undefined && (!completedStat.isFile() || completedStat.isSymbolicLink())) {
    throw new UpdateDownloadError('invalid-options', 'The completed update path is not a regular file.')
  }

  return {
    directory,
    completed,
    temporary: partialPath(directory, completed),
    temporaryState: `${partialPath(directory, completed)}.json`,
  }
}

/**
 * 未完成传输的落地路径。
 *
 * 用**清单里的完成件文件名**派生而不是加 pid 后缀:续传的前提正是"上一次的
 * 残留还能被这一次认出来",带 pid 的临时名每次都不同,等于永远从零开始。
 */
function partialPath(directory: string, completed: string): string {
  const base = completed.slice(directory.length + 1)
  return join(directory, `.${base}.partial`)
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

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  offset: number,
): Promise<void> {
  let written = 0
  while (written < chunk.byteLength) {
    const result = await handle.write(chunk, written, chunk.byteLength - written, offset + written)
    if (result.bytesWritten === 0) throw new Error('The update installer write made no progress.')
    written += result.bytesWritten
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
