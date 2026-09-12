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
function platformArtifact(platform: DesktopDownloadPlatform): Uint8Array {
  if (platform === 'darwin') {
    const dmg = Buffer.alloc(64 * 1024, 0x5a)
    dmg.write('koly', dmg.byteLength - 512, 'ascii')
    return dmg
  }
  if (platform === 'win32') {
    const pe = Buffer.alloc(64 * 1024, 0)
    pe.write('MZ', 0, 'ascii')
    pe.writeUInt32LE(0x80, 0x3c)
    pe.set([0x50, 0x45, 0x00, 0x00], 0x80)
    return pe
  }
  const appImage = Buffer.alloc(64 * 1024, 0)
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

/**
 * 起一台真实 HTTP 服务器:第一次取安装包时**写一半就扯断连接**,之后按
 * `Range` 正常续传。
 * @param artifact - full installer bytes.
 * @param digest - its SHA-256.
 * @returns base URL, artifact request counter, request adapter, and shutdown.
 */
async function fixtureServer(artifact: Uint8Array, digest: string): Promise<FixtureServer> {
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
            'mac-universal': { url: ARTIFACT_URL, sha256: digest, size: total },
            'win-x64': { url: ARTIFACT_URL, sha256: digest, size: total },
            'linux-x64': { url: ARTIFACT_URL, sha256: digest, size: total },
          },
        },
      }))
      return
    }
    state.artifactRequests += 1
    const headers = { etag: '"release-3.0.0"', 'content-type': 'application/octet-stream' }
    if (state.artifactRequests === 1) {
      // 声明完整长度,只写一半,然后硬断连接(模拟网络抖动/中间设备掐流)。
      res.writeHead(200, { ...headers, 'content-length': String(total) })
      res.write(Buffer.from(artifact.subarray(0, half)), () => { res.socket?.destroy() })
      return
    }
    const range = req.headers.range
    const start = typeof range === 'string' ? Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0) : 0
    if (start > 0) {
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${String(start)}-${String(total - 1)}/${String(total)}`,
        'content-length': String(total - start),
      })
      res.end(Buffer.from(artifact.subarray(start)))
      return
    }
    res.writeHead(200, { ...headers, 'content-length': String(total) })
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
      expect(await readFile(completed)).toEqual(Buffer.from(artifact))
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
})
