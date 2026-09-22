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
  } = {},
): Promise<FixtureServer> {
  const validators = options.validators ?? { etag: '"release-3.0.0"' }
  const manifestSize = options.manifestSize ?? artifact.byteLength
  const cut = options.cut ?? true
  const omitContentLength = options.omitContentLength ?? false
  const total = artifact.byteLength
  const half = Math.floor(total / 2)
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
    const headers = {
      ...(validators.etag === undefined ? {} : { etag: validators.etag }),
      ...(validators.lastModified === undefined ? {} : { 'last-modified': validators.lastModified }),
      'content-type': 'application/octet-stream',
    }
    if (cut && state.artifactRequests === 1) {
      // 声明完整长度,分块慢发到一半再硬断连接(模拟网络抖动/中间设备掐流)。
      // 一次性 write 后立刻 destroy 会让 RST 抢在客户端读之前到达:客户端一个
      // 字节都留不下,"续传"这条路径根本不会被触发 —— 夹具必须与真实掐流同形。
      res.writeHead(200, { ...headers, 'content-length': String(total) })
      let written = 0
      const pump = (): void => {
        if (written >= half) { res.socket?.destroy(); return }
        const end = Math.min(written + CUT_CHUNK_BYTES, half)
        res.write(Buffer.from(artifact.subarray(written, end)), () => {
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
    if (start > 0) {
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${String(start)}-${String(total - 1)}/${String(total)}`,
        ...declared(total - start),
      })
      res.end(Buffer.from(artifact.subarray(start)))
      return
    }
    res.writeHead(200, { ...headers, ...declared(total) })
    res.end(Buffer.from(artifact))
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
})
