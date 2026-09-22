/**
 * 真实 HTTP 的续传/复用集成测试。
 *
 * 单测里所有响应都是 mock 的 `Response`:它能钉住"逻辑对不对",但钉不住
 * "真跑在 socket 上还成不成立" —— 中途断流、`Range`/`If-Range` 请求头、206 与
 * `Content-Range` 的往返只有真服务器能证明(2026-09-12 加,配合更新健壮化)。
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UpdateDownloadError,
  downloadDesktopUpdate,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
} from '../src/update-download.ts'

/** 假域名:清单解析只接受绝对 https,真实连接由 request 替身改写到本机服务器。 */
const MANIFEST_URL = 'https://artifacts.test/api/client/v2/updates/manifest'
const ARTIFACT_URL = 'https://artifacts.test/updates/client/3.0.0/installer'
const VERSION = '3.0.0'

/** 本平台的一份最小合法安装包容器(DMG/PE/AppImage 各按魔数)。 */
function platformArtifact(platform: DesktopDownloadPlatform, size = 2 * 1024 * 1024): Uint8Array {
  if (platform === 'darwin') {
    const dmg = Buffer.alloc(size, 0x5a)
    dmg.write('koly', dmg.byteLength - 512, 'ascii')
    return dmg
  }
  if (platform === 'win32') {
    const pe = Buffer.alloc(size, 0)
    pe.write('MZ', 0, 'ascii')
    pe.writeUInt32LE(0x80, 0x3c)
    pe.set([0x50, 0x45, 0x00, 0x00], 0x80)
    return pe
  }
  const appImage = Buffer.alloc(size, 0)
  appImage.set([0x7f, 0x45, 0x4c, 0x46], 0)
  appImage.set([0x41, 0x49, 0x02], 8)
  return appImage
}

const platform: DesktopDownloadPlatform = process.platform === 'darwin'
  ? 'darwin'
  : process.platform === 'win32' ? 'win32' : 'linux'

/**
 * 一份**不可压缩**的安装包字节(真安装包内部已压缩:DMG/AppImage 用 gzip 只会
 * 变长 0.03%)。
 *
 * 平台魔数位逐字节保留,其余填确定性伪随机字节 —— 高熵是必要的:可压缩内容
 * (全零)的 gzip 长度**小于**原长,那样触发的是"分母偏小 ⇒ 进度恒 100%",
 * 而不是"分母偏大 ⇒ 完整文件被判截断"这条更致命的路径。
 * @param platform - target platform selecting the container magic.
 * @param size - artifact bytes.
 * @returns installer bytes that gzip cannot shrink.
 */
function incompressibleArtifact(platform: DesktopDownloadPlatform, size = 256 * 1024): Uint8Array {
  const magic = platformArtifact(platform, size)
  const bytes = Buffer.alloc(size)
  let state = 0x2545f491
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    bytes[index] = (state >>> 24) & 0xff
  }
  for (let index = 0; index < size; index += 1) {
    const byte = magic[index]
    if (byte !== undefined && byte !== 0) bytes[index] = byte
  }
  return bytes
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface FixtureServer {
  readonly base: string
  readonly artifactRequests: number
  readonly request: UpdateArtifactRequest
  close(): Promise<void>
}

/** 假服务器发的**续传验证器**;生产形态见 `productionValidators`。 */
interface FixtureValidators {
  readonly etag?: string
  readonly lastModified?: string
}

/**
 * 生产服务端形态的验证器。
 *
 * `/updates/client/*` 由 Go 的 `http.ServeFile` 提供(server/internal/clientrelease),
 * 它**只发 `Last-Modified`、不发 `ETag`**,而 `Last-Modified` 的值
 * (`Tue, 22 Sep 2026 18:06:04 GMT`)自带冒号 —— 续传校验器一旦按"元素个数"
 * 而不是"第一个冒号"切分,值就会被截断,206 被丢弃后整份重下。
 */
const productionValidators: FixtureValidators = { lastModified: 'Tue, 22 Sep 2026 18:06:04 GMT' }

/** 断流夹具每块发送的字节数:足够小,保证客户端在 RST 之前真的收下并落盘若干块。 */
const CUT_CHUNK_BYTES = 64 * 1024

/**
 * 安装包字节的逐字节比对。
 *
 * 夹具是 MiB 级的:`expect(actual).toEqual(Buffer.from(expected))` 会走元素级
 * 深比较,一次 2 MiB 的断言实测要 5.5 秒(超过 vitest 的用例预算)。
 * @param actual - bytes read back from disk.
 * @param expected - fixture bytes.
 */
function expectSameBytes(actual: Buffer, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength)
  expect(Buffer.compare(actual, Buffer.from(expected))).toBe(0)
}

/**
 * 起一台真实 HTTP 服务器:第一次取安装包时**写一半就扯断连接**,之后按
 * `Range` 正常续传。
 * @param artifact - full installer bytes.
 * @param digest - its SHA-256.
 * @param options - 响应携带的续传验证器(缺省 ETag,即旧夹具形态)、清单声明的
 *   安装包长度(缺省与真实字节一致;偏小即为现场那条"清单 size 撒谎"的形态)与
 *   是否在第一次传输中途断流(缺省断流;"不断流"用于只测长度口径的用例)与是否
 *   省略 `content-length`(缺省带上;省略即 chunked,客户端只能拿清单 size 当分母)。
 * @returns base URL, artifact request counter, request adapter, and shutdown.
 */
async function fixtureServer(
  artifact: Uint8Array,
  digest: string,
  options: {
    readonly validators?: FixtureValidators
    readonly manifestSize?: number
    readonly cut?: boolean
    readonly omitContentLength?: boolean
    /**
     * 断流点(占安装包字节的比例,缺省一半)。
     *
     * "清单偏小 + 残留大于清单"的形态必须让残留落在清单 size **之上**才测得到
     * sidecar 的 `totalBytes`:留在清单之下时"清单 size 是不是分母"根本不参与判定。
     */
    readonly cutAfterFraction?: number
    /**
     * 用 gzip 编码响应体(生产形态:Electron `net.fetch` 主动发
     * `Accept-Encoding: gzip, deflate, br, zstd`,反代/CDN 对安装包启压缩时就会
     * 走到这条路径)。`content-length` 与 206 的 `Content-Range` 都是**压缩后**
     * 的长度,而客户端拿到的是解码后的字节。
     */
    readonly contentEncoding?: 'gzip'
  } = {},
): Promise<FixtureServer> {
  const validators = options.validators ?? { etag: '"release-3.0.0"' }
  const manifestSize = options.manifestSize ?? artifact.byteLength
  const cut = options.cut ?? true
  const omitContentLength = options.omitContentLength ?? false
  const contentEncoding = options.contentEncoding
  const cutAfterFraction = options.cutAfterFraction ?? 0.5
  const total = artifact.byteLength
  /** 线上字节:启用内容编码时是压缩后的表示。 */
  const onWire = (bytes: Uint8Array): Buffer => {
    const payload = Buffer.from(bytes)
    return contentEncoding === 'gzip' ? gzipSync(payload) : payload
  }
  const state = { artifactRequests: 0 }
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/client/v2/updates/manifest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        schema: 1,
        channel_id: 'official',
        server: { version: VERSION },
        client: {
          version: VERSION,
          assets: {
            'mac-universal': { url: ARTIFACT_URL, sha256: digest, size: manifestSize },
            'win-x64': { url: ARTIFACT_URL, sha256: digest, size: manifestSize },
            'linux-x64': { url: ARTIFACT_URL, sha256: digest, size: manifestSize },
          },
        },
      }))
      return
    }
    state.artifactRequests += 1
    const headers: Record<string, string> = {
      ...(validators.etag === undefined ? {} : { etag: validators.etag }),
      ...(validators.lastModified === undefined ? {} : { 'last-modified': validators.lastModified }),
      'content-type': 'application/octet-stream',
      ...(contentEncoding === undefined ? {} : { 'content-encoding': contentEncoding }),
    }
    if (cut && state.artifactRequests === 1) {
      // 声明完整长度,分块慢发到一半再硬断连接(模拟网络抖动/中间设备掐流)。
      // 一次性 write 后立刻 destroy 会让 RST 抢在客户端读之前到达:客户端一个
      // 字节都留不下,"续传"这条路径根本不会被触发 —— 夹具必须与真实掐流同形。
      // 内容编码开时"一半"是**线上**的一半(真实掐流掐的是线上字节)。
      const wire = onWire(artifact)
      const stop = Math.floor(wire.byteLength * cutAfterFraction)
      res.writeHead(200, { ...headers, 'content-length': String(wire.byteLength) })
      let written = 0
      const pump = (): void => {
        if (written >= stop) { res.socket?.destroy(); return }
        const end = Math.min(written + CUT_CHUNK_BYTES, stop)
        res.write(wire.subarray(written, end), () => {
          written = end
          setTimeout(pump, 1)
        })
      }
      pump()
      return
    }
    const range = req.headers.range
    const start = typeof range === 'string' ? Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0) : 0
    // 省略 content-length 时 Node 走 chunked:此时客户端**只能**拿清单 size 当分母。
    const declared = (bytes: number): Record<string, string> =>
      omitContentLength ? {} : { 'content-length': String(bytes) }
    // 夹具把 Range 当**解码后**的字节处理(与客户端 Range 的语义一致),再把这一段
    // 重新压缩上线:`content-length` 因此是压缩长度,`Content-Range` 的 total 是解码
    // 后的总长 —— 正是"线上长度 ≠ 落盘字节"的真实形态。
    const body = onWire(artifact.subarray(start))
    if (start > 0) {
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${String(start)}-${String(total - 1)}/${String(total)}`,
        ...declared(body.byteLength),
      })
      res.end(body)
      return
    }
    res.writeHead(200, { ...headers, ...declared(body.byteLength) })
    res.end(body)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  const base = `http://127.0.0.1:${String(address.port)}`
  return {
    base,
    get artifactRequests() { return state.artifactRequests },
    // 只把假域名改写到本机;其余(流、Range、断流)全走真实网络栈。
    request: (url, init) => fetch(url.replace('https://artifacts.test', base), init),
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

describe('desktop update download over real HTTP', () => {
  it('resumes a transfer that was cut mid-stream, then reuses the completed installer', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = platformArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    const server = await fixtureServer(artifact, digest)
    try {
      const options = {
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
      }

      // 第一次:服务器写一半就断。必须报"传输失败"且留下可续传的残留。
      const failure = await downloadDesktopUpdate(options).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(UpdateDownloadError)
      expect((failure as UpdateDownloadError).retriable).toBe(true)
      const partials = await readdir(join(userDataPath, 'updates', VERSION))
      expect(partials.some(entry => entry.endsWith('.partial'))).toBe(true)
      expect(partials.some(entry => entry.endsWith('.partial.json'))).toBe(true)

      // 第二次:带 Range 续传(真实 206),按清单哈希校验后落地。
      const completed = await downloadDesktopUpdate(options)
      expectSameBytes(await readFile(completed), artifact)
      expect(server.artifactRequests).toBe(2)
      const settled = await readdir(join(userDataPath, 'updates', VERSION))
      expect(settled.filter(entry => entry.endsWith('.partial'))).toEqual([])

      // 第三次:完成件已在盘上且哈希一致 → 只重新取清单,不再碰安装包。
      const again = await downloadDesktopUpdate(options)
      expect(again).toBe(completed)
      expect(server.artifactRequests).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('accepts a resume whose only validator is Last-Modified (production shape)', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = platformArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    // 夹具与生产同形:**只发 Last-Modified**,值里含冒号(见 productionValidators)。
    const server = await fixtureServer(artifact, digest, { validators: productionValidators })
    const received: number[] = []
    try {
      const options = {
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (progress: { receivedBytes: number }) => { received.push(progress.receivedBytes) },
      }

      const failure = await downloadDesktopUpdate(options).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(UpdateDownloadError)
      expect((failure as UpdateDownloadError).retriable).toBe(true)
      expect(received.at(-1)).toBeGreaterThan(0)
      // 第二次传输的第一个事件(续传起点)在整条序列里的下标。
      const resumeIndex = received.length

      const completed = await downloadDesktopUpdate(options)
      expectSameBytes(await readFile(completed), artifact)
      // 服务端总共只该看到两次安装包请求:断流的那次 + 被接受的 206。
      // 校验器值被截断时,客户端会丢弃这个 206 并整份重下(第 3 次请求)。
      expect(server.artifactRequests).toBe(2)
      // 进度只增不减:丢弃 206 会让已下字节作废,进度从半份掉回几百字节。
      expect(received).toEqual([...received].sort((left, right) => left - right))
      // 续传确实从断点接上(而不是从头重下),否则"只增不减"也能靠整份重下满足。
      expect(received[resumeIndex]).toBeGreaterThan(artifact.byteLength / 4)
    } finally {
      await server.close()
    }
  })

  it('accepts more bytes than the manifest declares when the response omits its length', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = platformArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    const understated = Math.floor(artifact.byteLength * 0.8)
    // chunked 响应 + 偏小的清单 size:客户端没有"连接声明的长度"可依赖,只能
    // 相信清单 —— 收到比清单更多的字节时必须按"完整性由 SHA-256 定论"处理,
    // 而不是判成截断并重下(那正是把更新器钉死在重试循环里的旧行为)。
    const server = await fixtureServer(artifact, digest, {
      manifestSize: understated,
      cut: false,
      omitContentLength: true,
    })
    const progress: Array<{ receivedBytes: number, totalBytes: number | undefined }> = []
    try {
      const completed = await downloadDesktopUpdate({
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (value: { receivedBytes: number, totalBytes: number | undefined }) => { progress.push(value) },
      })
      expectSameBytes(await readFile(completed), artifact)
      expect(server.artifactRequests).toBe(1)
      expect(progress.at(-1)).toEqual({ receivedBytes: artifact.byteLength, totalBytes: understated })
    } finally {
      await server.close()
    }
  })

  it('downloads to completion when the manifest size understates the installer', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = platformArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    // 现场形态:清单 `size` 只有真实字节的 80%(发布面数字与产物不一致)。
    const understated = Math.floor(artifact.byteLength * 0.8)
    const server = await fixtureServer(artifact, digest, { manifestSize: understated, cut: false })
    const progress: Array<{ receivedBytes: number, totalBytes: number | undefined }> = []
    try {
      const completed = await downloadDesktopUpdate({
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (value: { receivedBytes: number, totalBytes: number | undefined }) => { progress.push(value) },
      })
      // 一次就成功:分母跟着响应声明走,错的清单长度不再把传输判成"截断"。
      expectSameBytes(await readFile(completed), artifact)
      expect(server.artifactRequests).toBe(1)
      // 分母 = 本次响应声明的真实长度(不是清单那个错的 size),所以显示面在收满
      // 之前不会被顶到 99% 封顶,最后一帧才跨过清单长度并到达真实总长。
      expect(progress.at(-1)).toEqual({ receivedBytes: artifact.byteLength, totalBytes: artifact.byteLength })
      // 每一帧的分母都是真实长度(而不是清单那个小 20% 的数字):显示面因此
      // 在真实进度 80% 处不会被顶到 99%。
      expect(progress.length).toBeGreaterThan(0)
      expect(progress.every(entry => entry.totalBytes === artifact.byteLength)).toBe(true)
      expect(progress.some(entry => entry.receivedBytes < understated)).toBe(true)

      // 第二次检查:完成件必须被复用(长度不再否决复用),不再产生安装包请求。
      const again = await downloadDesktopUpdate({
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
      })
      expect(again).toBe(completed)
      expect(server.artifactRequests).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('completes when a chunked response delivers fewer bytes than the manifest declares', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = platformArtifact(platform, 512 * 1024)
    const digest = createHash('sha256').update(artifact).digest('hex')
    // 发布面数字偏大 20% + 响应没有 `content-length`(chunked):分母只剩清单 size,
    // 但字节与清单哈希逐字节相同 ⇒ **长度不足不能越权否决 SHA-256**。
    // (旧行为是 `else if` 链:长度先判 ⇒ 完整且哈希正确的文件永久失败。)
    const overstated = Math.ceil(artifact.byteLength * 1.2)
    const server = await fixtureServer(artifact, digest, { cut: false, omitContentLength: true, manifestSize: overstated })
    const progress: Array<{ receivedBytes: number, totalBytes: number | undefined }> = []
    try {
      const completed = await downloadDesktopUpdate({
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (value: { receivedBytes: number, totalBytes: number | undefined }) => { progress.push(value) },
      })
      expectSameBytes(await readFile(completed), artifact)
      expect(server.artifactRequests).toBe(1)
      // 分母仍是清单声明(chunked 没有更好的口径),但判定必须落在 SHA-256 上。
      expect(progress.at(-1)).toEqual({ receivedBytes: artifact.byteLength, totalBytes: overstated })
    } finally {
      await server.close()
    }
  })

  it('resumes a partial that is larger than the manifest size (sidecar beats the manifest)', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = platformArtifact(platform, 512 * 1024)
    const digest = createHash('sha256').update(artifact).digest('hex')
    // 清单偏小 40% + 断流点 85%:残留**比清单 size 大**。只有 sidecar 里记的连接
    // 声明长度能证明这份残留还没下满 —— 拿清单 size 当"已知总长"会把它当成下满的
    // (哈希不符 → 残留被删),或者干脆判成"不可续传" ⇒ 已下字节全部作废。
    const understated = Math.floor(artifact.byteLength * 0.6)
    const server = await fixtureServer(artifact, digest, {
      manifestSize: understated,
      cutAfterFraction: 0.85,
    })
    const received: number[] = []
    try {
      const options = {
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (progress: { receivedBytes: number }) => { received.push(progress.receivedBytes) },
      }
      const failure = await downloadDesktopUpdate(options).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(UpdateDownloadError)
      expect((failure as UpdateDownloadError).retriable).toBe(true)

      const resumeIndex = received.length
      const completed = await downloadDesktopUpdate(options)
      expectSameBytes(await readFile(completed), artifact)
      // 断流那次 + 被接受的 206:真的从 85% 续上,而不是整份重下。
      expect(server.artifactRequests).toBe(2)
      // 续传起点比清单 size 还大 —— 这个起点只有 sidecar 口径解释得通。
      expect(received[resumeIndex]).toBeGreaterThan(understated)
      expect(received[resumeIndex]).toBeLessThan(artifact.byteLength)
    } finally {
      await server.close()
    }
  })

  /**
   * 非 identity `Content-Encoding` 的三条判据(2026-09 P1 的根因)。
   *
   * 生产请求边界(Electron `net.fetch`)会主动广告 `Accept-Encoding: gzip, deflate,
   * br, zstd`;任何对安装包启压缩的反代/CDN 都会让响应带上 `content-encoding`,
   * 此时 `content-length`(以及 206 的 `Content-Range` total)是**线上**长度,
   * 而客户端拿到的是**解码后**的字节。用线上长度当分母/长度校验口径:
   * ①不可压缩包(真安装包形态)会被判成截断,重试到彻底失败 —— 一个完整且
   *   SHA-256 正确的包永远装不上;②可压缩包自第一帧起恒显 100%;
   * ③sidecar 记下压缩长度 ⇒ 残留被判成"比已知总长还大" ⇒ 续传失效。
   */
  it('downloads a gzip-encoded incompressible installer instead of judging it truncated', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = incompressibleArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    // 判据不能恒真:确认这份字节经 gzip 后**确实变长**(线上长度 > 落盘字节)。
    const wireBytes = gzipSync(Buffer.from(artifact)).byteLength
    expect(wireBytes).toBeGreaterThan(artifact.byteLength)
    const server = await fixtureServer(artifact, digest, { cut: false, contentEncoding: 'gzip' })
    const progress: Array<{ receivedBytes: number, totalBytes: number | undefined }> = []
    try {
      const completed = await downloadDesktopUpdate({
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (value: { receivedBytes: number, totalBytes: number | undefined }) => { progress.push(value) },
      })
      expectSameBytes(await readFile(completed), artifact)
      expect(server.artifactRequests).toBe(1)
      // 分母不采信线上长度(它比真实字节还大):回落清单 size ⇒ 收到完整文件后
      // 不会被"ended after N of M bytes"判成截断。
      expect(progress.at(-1)).toEqual({ receivedBytes: artifact.byteLength, totalBytes: artifact.byteLength })
    } finally {
      await server.close()
    }
  })

  it('never shows a gzip-declared length as the progress denominator', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    // 可压缩内容(全零 + 平台魔数):gzip 后只有几百字节。
    const artifact = platformArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    const wireBytes = gzipSync(Buffer.from(artifact)).byteLength
    // 判据不能恒真:线上长度必须**远小于**真实字节,否则这条用例测不到东西。
    expect(wireBytes).toBeLessThan(artifact.byteLength / 100)
    const server = await fixtureServer(artifact, digest, { cut: false, contentEncoding: 'gzip' })
    const progress: Array<{ receivedBytes: number, totalBytes: number | undefined }> = []
    try {
      const completed = await downloadDesktopUpdate({
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (value: { receivedBytes: number, totalBytes: number | undefined }) => { progress.push(value) },
      })
      expectSameBytes(await readFile(completed), artifact)
      expect(server.artifactRequests).toBe(1)
      // 每一帧的分母都是真实字节数(而不是压缩长度):否则从第一帧起
      // `received >= total` ⇒ 整段下载恒显 100%。
      expect(progress.length).toBeGreaterThan(0)
      expect(progress.every(entry => entry.totalBytes === artifact.byteLength)).toBe(true)
      expect(progress.some(entry => entry.receivedBytes < artifact.byteLength)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('resumes a gzip-encoded transfer and never stores the compressed length', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-update-integration-'))
    temporaryRoots.push(userDataPath)
    const artifact = incompressibleArtifact(platform)
    const digest = createHash('sha256').update(artifact).digest('hex')
    const wireBytes = gzipSync(Buffer.from(artifact)).byteLength
    expect(wireBytes).toBeGreaterThan(artifact.byteLength)
    // 生产形态:只发 Last-Modified(值里含冒号),断流后按 Range 续传。
    const server = await fixtureServer(artifact, digest, { validators: productionValidators, contentEncoding: 'gzip' })
    const received: number[] = []
    try {
      const options = {
        manifestURL: MANIFEST_URL,
        platform,
        version: VERSION,
        userDataPath,
        request: server.request,
        onProgress: (progress: { receivedBytes: number }) => { received.push(progress.receivedBytes) },
      }
      const failure = await downloadDesktopUpdate(options).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(UpdateDownloadError)
      expect((failure as UpdateDownloadError).retriable).toBe(true)

      // sidecar 记的是**落盘**字节的口径:压缩长度写进去会让残留被
      // `stat.size > knownTotal` 判成不可续传(续传能力被自己的 sidecar 摧毁)。
      const partial = await readdir(join(userDataPath, 'updates', VERSION))
      const sidecarName = partial.find(entry => entry.endsWith('.partial.json'))
      expect(sidecarName).toBeDefined()
      const sidecar = JSON.parse(
        await readFile(join(userDataPath, 'updates', VERSION, sidecarName as string), 'utf8'),
      ) as { totalBytes?: number, receivedBytes: number }
      expect(sidecar.totalBytes).toBe(artifact.byteLength)
      expect(sidecar.totalBytes).not.toBe(wireBytes)

      const resumeIndex = received.length
      const completed = await downloadDesktopUpdate(options)
      expectSameBytes(await readFile(completed), artifact)
      // 断流那次 + 被接受的 206:`requests === 2` 就等价于"206 被接受" ——
      // 校验器不符/起点错位时客户端会丢掉 206 再整份重下(第 3 次请求)。
      expect(server.artifactRequests).toBe(2)
      // 续传从断点接上(>0),而不是从 0 重下。
      expect(received[resumeIndex]).toBeGreaterThan(0)
      expect(received[resumeIndex]).toBeLessThan(artifact.byteLength)
    } finally {
      await server.close()
    }
  })
})
