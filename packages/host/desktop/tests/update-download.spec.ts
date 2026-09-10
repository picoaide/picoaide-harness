import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  serverManifestURL,
  MAX_UPDATE_DOWNLOAD_BYTES,
  UpdateDownloadError,
  downloadDesktopUpdate,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
} from '../src/update-download.ts'

// 下载器只从**登录的那台服务端**取清单(2026-09-10 定案)。
const SERVER = 'https://server.test'
const MANIFEST_URL = serverManifestURL(SERVER)

const temporaryRoots: string[] = []

async function temporaryUserData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-download-'))
  temporaryRoots.push(root)
  return root
}

function dmgArtifact(): Uint8Array {
  const artifact = Buffer.alloc(1024, 0x5a)
  artifact.write('koly', artifact.byteLength - 512, 'ascii')
  return artifact
}

function windowsArtifact(): Uint8Array {
  const artifact = Buffer.alloc(512, 0)
  artifact.write('MZ', 0, 'ascii')
  artifact.writeUInt32LE(0x80, 0x3c)
  artifact.set([0x50, 0x45, 0x00, 0x00], 0x80)
  return artifact
}

function appImageArtifact(): Uint8Array {
  // ELF magic + AppImage signature (0x41 0x49 0x02 at offset 8).
  const artifact = Buffer.alloc(512, 0)
  artifact.set([0x7f, 0x45, 0x4c, 0x46], 0)
  artifact.set([0x41, 0x49, 0x02], 8)
  return artifact
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function chunkedResponse(chunks: readonly Uint8Array[], headers: HeadersInit = {}): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }), { status: 200, headers })
}

/** 渠道版本清单:`client.assets` 的键与服务端下发的一致。 */
function manifestResponse(
  version: string,
  assets: Readonly<Record<string, unknown>>,
): Response {
  return Response.json({
    schema: 1,
    channel_id: 'official',
    server: { version, image_tag: `v${version}` },
    client: { version, assets },
  })
}

const ASSET_KEYS: Readonly<Record<DesktopDownloadPlatform, string>> = {
  darwin: 'mac-universal',
  win32: 'win-x64',
  linux: 'linux-x64',
}

/** 只声明本次测试所用平台安装包的清单(其余平台视为未发布)。 */
function platformManifest(
  version: string,
  platform: DesktopDownloadPlatform,
  artifactURL: string,
  digest: string,
): Response {
  return manifestResponse(version, {
    [ASSET_KEYS[platform]]: { url: artifactURL, sha256: digest, size: 0 },
  })
}

/**
 * 下载完成后的安装器路径(与源码的私有目录布局一致)。
 *
 * 文件名由源码从**清单里的下载地址**推导(渠道化打包下每个渠道的产物名不同,
 * 写死模板既会泄露厂商品牌也会与实际产物不符),所以这里同样按 URL 末段推导。
 */
function completedPath(userDataPath: string, version: string, artifactURL: string): string {
  return join(userDataPath, 'updates', version, artifactURL.slice(artifactURL.lastIndexOf('/') + 1))
}

async function updateDirectoryEntries(userDataPath: string, version: string): Promise<string[]> {
  // 清单拉取失败时不会创建版本目录(本地目标只在拿到清单后才准备),
  // 这里把"目录不存在"与"目录为空"一视同仁:两者都表示没有残留文件。
  try {
    return await readdir(join(userDataPath, 'updates', version))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}

async function expectFailure(
  promise: Promise<unknown>,
  code: UpdateDownloadError['code'],
): Promise<UpdateDownloadError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateDownloadError)
    expect(error).toMatchObject({ code })
    return error as UpdateDownloadError
  }
  throw new Error('Expected update download to fail.')
}

async function expectNoPartialFiles(userDataPath: string, version: string): Promise<void> {
  const entries = await updateDirectoryEntries(userDataPath, version)
  expect(entries.filter(entry => entry.endsWith('.partial'))).toEqual([])
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop update installer download', () => {
  it('streams a macOS DMG from the manifest asset URL and atomically completes it', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      calls.push({ url, init })
      if (url === MANIFEST_URL) {
        return platformManifest('2.1.0', 'darwin', 'https://artifacts.test/mac.dmg', digest)
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([artifact.subarray(0, 333), artifact.subarray(333)])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.1.0',
      userDataPath,
      request,
    })

    expect(result).toBe(completedPath(userDataPath, '2.1.0', 'https://artifacts.test/mac.dmg'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    // 清单请求必须走官方渠道的固定入口,且禁止跳转(见 desktop-release.ts)。
    expect(calls[0]?.url).toBe(MANIFEST_URL)
    expect(calls[0]?.url).toBe('https://server.test/api/client/v2/updates/manifest')
    expect(calls[0]?.init).toEqual({
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    })
    // 安装包本身按清单给出的绝对地址直连下载。
    expect(calls[1]?.url).toBe('https://artifacts.test/mac.dmg')
    expect(calls[1]?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'follow' })
    await expectNoPartialFiles(userDataPath, '2.1.0')
  })

  it('reads the manifest from the signed-in server URL', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const calls: string[] = []
    const channelManifestURL = MANIFEST_URL
    const request: UpdateArtifactRequest = async (url) => {
      calls.push(String(url))
      if (url === channelManifestURL) {
        return platformManifest('2.1.1', 'darwin', 'https://artifacts.test/mac.dmg', sha256(artifact))
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.1.1',
      userDataPath,
      request,
    })

    expect(result).toBe(completedPath(userDataPath, '2.1.1', 'https://artifacts.test/mac.dmg'))
    expect(calls[0]).toBe(channelManifestURL)
  })

  it('accepts a Windows executable only when it has both MZ and PE signatures', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = windowsArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.2.0', 'win32', 'https://artifacts.test/setup.exe', digest)
      }
      if (url === 'https://artifacts.test/setup.exe') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'win32',
      version: '2.2.0',
      userDataPath,
      request,
    })

    expect(result).toBe(completedPath(userDataPath, '2.2.0', 'https://artifacts.test/setup.exe'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(userDataPath, '2.2.0')
  })

  it('accepts a Linux AppImage with ELF + AppImage signatures', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = appImageArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.2.1', 'linux', 'https://artifacts.test/appimage', digest)
      }
      if (url === 'https://artifacts.test/appimage') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'linux',
      version: '2.2.1',
      userDataPath,
      request,
    })

    expect(result).toBe(completedPath(userDataPath, '2.2.1', 'https://artifacts.test/appimage'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(userDataPath, '2.2.1')
  })

  it('accepts canonical stable SemVer build metadata in the private artifact path', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.8.0+build', 'darwin', 'https://artifacts.test/mac.dmg', sha256(artifact))
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([dmgArtifact()])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.8.0+build',
      userDataPath,
      request,
    })

    // 落地文件名取自清单里的下载地址(渠道化打包下不再有固定模板)。
    expect(result).toBe(completedPath(userDataPath, '2.8.0+build', 'https://artifacts.test/mac.dmg'))
  })

  it.each([
    ['darwin', new Uint8Array(1024)],
    ['win32', Object.assign(windowsArtifact(), { 0: 0 })],
    ['win32', Object.assign(windowsArtifact(), { 0x80: 0 })],
    ['linux', new Uint8Array(1024)],
    ['linux', Object.assign(appImageArtifact(), { 0: 0 })],
  ] as const)('rejects and removes an invalid %s artifact', async (platform, artifact) => {
    const userDataPath = await temporaryUserData()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.3.0', platform, 'https://artifacts.test/artifact', digest)
      }
      if (url === 'https://artifacts.test/artifact') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform,
      version: '2.3.0',
      userDataPath,
      request,
    }), 'invalid-artifact')
    await expectNoPartialFiles(userDataPath, '2.3.0')
    expect(await updateDirectoryEntries(userDataPath, '2.3.0')).toEqual([])
  })

  it.each([
    ['an unsuccessful response', async () => new Response(null, { status: 503 }), 'http-status'],
    ['a missing response body', async () => new Response(null, { status: 200 }), 'empty-body'],
    ['a zero-byte response body', async () => chunkedResponse([]), 'empty-body'],
  ] as const)('rejects %s without leaving a partial file', async (_label, artifactResponse, code) => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.4.0', 'darwin', 'https://artifacts.test/mac.dmg', digest)
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return artifactResponse()
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.4.0',
      userDataPath,
      request,
    }), code)
    await expectNoPartialFiles(userDataPath, '2.4.0')
  })

  it('rejects a declared body above the fixed 1 GiB limit before writing it', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    let artifactResponse: Response | undefined
    const onProgress = vi.fn()
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.5.0', 'darwin', 'https://artifacts.test/mac.dmg', digest)
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        artifactResponse = new Response(new ReadableStream<Uint8Array>({
          pull(stream) {
            stream.enqueue(artifact)
            stream.close()
          },
        }), { status: 200, headers: { 'content-length': String(MAX_UPDATE_DOWNLOAD_BYTES + 1) } })
        return artifactResponse
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.5.0',
      userDataPath,
      request,
      // onProgress 只在某一块真正落盘之后回调:零次调用 = 一个字节都没写。
      onProgress,
    }), 'response-too-large')
    expect(onProgress).not.toHaveBeenCalled()
    // 声明长度超限必须在读取响应体、打开目标文件之前拒绝:
    // 响应体从未被取 reader(locked 仍为 false),目标目录里也没有任何文件。
    expect(artifactResponse?.body?.locked).toBe(false)
    expect(await updateDirectoryEntries(userDataPath, '2.5.0')).toEqual([])
  })

  it('passes the caller signal and removes a partial file when aborted during streaming', async () => {
    const userDataPath = await temporaryUserData()
    const controller = new AbortController()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const signals: Array<AbortSignal | null | undefined> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      signals.push(init.signal)
      if (url === MANIFEST_URL) {
        return platformManifest('2.6.0', 'darwin', 'https://artifacts.test/mac.dmg', digest)
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return new Response(new ReadableStream<Uint8Array>({
          pull(stream) {
            stream.enqueue(artifact.subarray(0, 128))
            controller.abort(new DOMException('stop', 'AbortError'))
          },
        }))
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.6.0',
      userDataPath,
      request,
      signal: controller.signal,
    }), 'aborted')
    // 调用方 signal 必须同时透传给清单请求与安装包请求。
    expect(signals).toEqual([controller.signal, controller.signal])
    await expectNoPartialFiles(userDataPath, '2.6.0')
    expect(await updateDirectoryEntries(userDataPath, '2.6.0')).toEqual([])
  })

  it('normalizes an aborted artifact request and a transport failure without creating an artifact', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)

    const aborting: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.7.0', 'darwin', 'https://artifacts.test/mac.dmg', digest)
      }
      throw new DOMException('cancelled', 'AbortError')
    }
    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.7.0',
      userDataPath,
      request: aborting,
    }), 'aborted')
    await expectNoPartialFiles(userDataPath, '2.7.0')
    expect(await updateDirectoryEntries(userDataPath, '2.7.0')).toEqual([])

    const failing: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        return platformManifest('2.7.1', 'darwin', 'https://artifacts.test/mac.dmg', digest)
      }
      throw new TypeError('socket hang up')
    }
    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.7.1',
      userDataPath,
      request: failing,
    }), 'network')
    await expectNoPartialFiles(userDataPath, '2.7.1')
    expect(await updateDirectoryEntries(userDataPath, '2.7.1')).toEqual([])
  })

  it('fails with network when the manifest is unreachable and never touches an installer', async () => {
    const userDataPath = await temporaryUserData()
    const calls: string[] = []
    const missing: UpdateArtifactRequest = async (url) => {
      calls.push(String(url))
      return new Response('not found', { status: 404 })
    }
    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.7.2',
      userDataPath,
      request: missing,
    }), 'network')
    expect(calls).toEqual([MANIFEST_URL])

    const calls2: string[] = []
    const offline: UpdateArtifactRequest = async (url) => {
      calls2.push(String(url))
      throw new TypeError('offline')
    }
    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.7.3',
      userDataPath,
      request: offline,
    }), 'network')
    expect(calls2).toEqual([MANIFEST_URL])
    expect(await updateDirectoryEntries(userDataPath, '2.7.3')).toEqual([])
  })

  it('rejects an already-aborted caller signal before requesting', async () => {
    const userDataPath = await temporaryUserData()
    const controller = new AbortController()
    controller.abort()
    let requested = false
    const request: UpdateArtifactRequest = async () => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.7.4',
      userDataPath,
      request,
      signal: controller.signal,
    }), 'aborted')
    expect(requested).toBe(false)
    expect(await updateDirectoryEntries(userDataPath, '2.7.4')).toEqual([])
  })

  it('rejects a mismatched artifact digest before exposing the installer', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const request: UpdateArtifactRequest = async (url) => {
      if (url === MANIFEST_URL) {
        // 清单声明的哈希与真实安装包不一致(被替换/传坏)。
        return platformManifest('2.8.0', 'darwin', 'https://artifacts.test/mac.dmg', '0'.repeat(64))
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.8.0',
      userDataPath,
      request,
    }), 'checksum-mismatch')
    await expectNoPartialFiles(userDataPath, '2.8.0')
    // 校验失败必须不留任何可见产物:安装器不得暴露给调用方。
    expect(await updateDirectoryEntries(userDataPath, '2.8.0')).toEqual([])
  })

  it('downloads a prerelease (test channel) installer from its exact manifest version', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = appImageArtifact()
    const digest = sha256(artifact)
    const calls: string[] = []
    const request: UpdateArtifactRequest = async (url) => {
      calls.push(String(url))
      if (url === MANIFEST_URL) {
        return platformManifest('2.8.0-rc.1', 'linux', 'https://artifacts.test/appimage-rc', digest)
      }
      if (url === 'https://artifacts.test/appimage-rc') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'linux',
      version: '2.8.0-rc.1',
      userDataPath,
      request,
    })

    expect(result).toBe(
      completedPath(userDataPath, '2.8.0-rc.1', 'https://artifacts.test/appimage-rc'),
    )
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    // 预发布版本同样只读版本清单,不再有"latest 排除预发布"的分支。
    expect(calls[0]).toBe(MANIFEST_URL)
    expect(calls.some(call => call.includes('api.github.com'))).toBe(false)
    await expectNoPartialFiles(userDataPath, '2.8.0-rc.1')
  })

  it('rejects a manifest without an installer for the requested platform', async () => {
    const userDataPath = await temporaryUserData()
    const calls: string[] = []
    const request: UpdateArtifactRequest = async (url) => {
      calls.push(String(url))
      if (url === MANIFEST_URL) {
        const artifact = appImageArtifact()
        return platformManifest('2.9.0', 'linux', 'https://artifacts.test/appimage', sha256(artifact))
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.9.0',
      userDataPath,
      request,
    }), 'release-missing')
    expect(calls).toEqual([MANIFEST_URL])
    expect(await updateDirectoryEntries(userDataPath, '2.9.0')).toEqual([])
  })

  it('rejects a manifest whose version differs from the requested version', async () => {
    const userDataPath = await temporaryUserData()
    const calls: string[] = []
    const request: UpdateArtifactRequest = async (url) => {
      calls.push(String(url))
      if (url === MANIFEST_URL) {
        // 清单是固定 URL 的可覆盖对象:两次请求之间可能刚好发布了新版本,
        // 这时必须拒绝,而不是把用户确认的版本换成另一个版本下载。
        return platformManifest('2.9.2', 'darwin', 'https://artifacts.test/mac.dmg', sha256(dmgArtifact()))
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.9.1',
      userDataPath,
      request,
    }), 'release-missing')
    expect(calls).toEqual([MANIFEST_URL])
    expect(await updateDirectoryEntries(userDataPath, '2.9.1')).toEqual([])
  })

  it.each([
    ['windows', '2.8.0'],
    ['darwin', '../2.8.0'],
    ['win32', 'v2.8.0'],
    ['win32', '2.8.0-rc.'],
    ['win32', '2.8.0-rc..1'],
  ])('rejects platform %s and version %s before requesting', async (platform, version) => {
    const userDataPath = await temporaryUserData()
    let requested = false
    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: platform as DesktopDownloadPlatform,
      version,
      userDataPath,
      request: async () => {
        requested = true
        return chunkedResponse([dmgArtifact()])
      },
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a relative user-data path before requesting', async () => {
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.9.0',
      userDataPath: 'relative',
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a linked user-data path before requesting', async () => {
    const userDataPath = await temporaryUserData()
    const linked = `${userDataPath}-link`
    temporaryRoots.push(linked)
    await symlink(userDataPath, linked, process.platform === 'win32' ? 'junction' : 'dir')
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({ manifestURL: MANIFEST_URL,
      platform: 'darwin',
      version: '2.9.0',
      userDataPath: linked,
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})
