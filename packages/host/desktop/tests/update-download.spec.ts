import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_RELEASE_API_URL,
  MAX_UPDATE_DOWNLOAD_BYTES,
  RELEASE_CHECKSUM_ASSET_NAME,
  UpdateDownloadError,
  downloadDesktopUpdate,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
} from '../src/update-download.ts'

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

function releaseMetadata(
  version: string,
  assets: ReadonlyArray<{ readonly name: string; readonly url?: string }>,
): Response {
  return Response.json({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: assets.map(asset => ({
      name: asset.name,
      browser_download_url: asset.url ?? `https://github.com/picoaide/picoaide-harness/releases/download/v${version}/${asset.name}`,
    })),
  })
}

function checksumResponse(entries: ReadonlyArray<{ readonly name: string; readonly digest: string }>): Response {
  return new Response(entries.map(entry => `${entry.digest}  ${entry.name}`).join('\n') + '\n')
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
  const entries = await readdir(join(userDataPath, 'updates', version))
  expect(entries.filter(entry => entry.endsWith('.partial'))).toEqual([])
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop update installer download', () => {
  it('streams a macOS DMG from the release asset and atomically completes it', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      calls.push({ url, init })
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.1.0', [
          { name: 'PicoAide-Harness-2.1.0-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.1.0-mac.dmg', digest }])
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([artifact.subarray(0, 333), artifact.subarray(333)])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.1.0',
      userDataPath,
      request,
    })

    expect(result).toBe(join(userDataPath, 'updates', '2.1.0', 'PicoAide-Harness-2.1.0-mac.dmg'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    const metadataCall = calls.find(call => call.url === DESKTOP_RELEASE_API_URL)
    expect(metadataCall?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' })
    await expectNoPartialFiles(userDataPath, '2.1.0')
  })

  it('accepts a Windows executable only when it has both MZ and PE signatures', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = windowsArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.2.0', [
          { name: 'PicoAide-Harness-2.2.0-x64-Setup.exe', url: 'https://artifacts.test/setup.exe' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.2.0-x64-Setup.exe', digest }])
      }
      if (url === 'https://artifacts.test/setup.exe') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.2.0',
      userDataPath,
      request,
    })

    expect(result).toBe(join(userDataPath, 'updates', '2.2.0', 'PicoAide-Harness-2.2.0-windows.exe'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(userDataPath, '2.2.0')
  })

  it('accepts canonical stable SemVer build metadata in the private artifact path', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.8.0+build', [
          { name: 'PicoAide-Harness-2.8.0+build-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.8.0+build-mac.dmg', digest }])
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([dmgArtifact()])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.8.0+build',
      userDataPath,
      request,
    })

    expect(result).toBe(join(
      userDataPath,
      'updates',
      '2.8.0+build',
      'PicoAide-Harness-2.8.0+build-mac.dmg',
    ))
  })

  it.each([
    ['darwin', new Uint8Array(1024)],
    ['win32', Object.assign(windowsArtifact(), { 0: 0 })],
    ['win32', Object.assign(windowsArtifact(), { 0x80: 0 })],
  ] as const)('rejects and removes an invalid %s artifact', async (platform, artifact) => {
    const userDataPath = await temporaryUserData()
    const digest = sha256(artifact)
    const assetName = platform === 'darwin'
      ? 'PicoAide-Harness-2.3.0-mac.dmg'
      : 'PicoAide-Harness-2.3.0-x64-Setup.exe'
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.3.0', [
          { name: assetName, url: 'https://artifacts.test/artifact' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: assetName, digest }])
      }
      if (url === 'https://artifacts.test/artifact') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({
      platform,
      version: '2.3.0',
      userDataPath,
      request,
    }), 'invalid-artifact')
    await expectNoPartialFiles(userDataPath, '2.3.0')
    expect(await readdir(join(userDataPath, 'updates', '2.3.0'))).toEqual([])
  })

  it.each([
    ['an unsuccessful response', async () => new Response(null, { status: 503 }), 'http-status'],
    ['a missing response body', async () => new Response(null, { status: 200 }), 'empty-body'],
    ['a zero-byte response body', async () => chunkedResponse([]), 'empty-body'],
  ] as const)('rejects %s without leaving a partial file', async (_label, artifactRequest, code) => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.4.0', [
          { name: 'PicoAide-Harness-2.4.0-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.4.0-mac.dmg', digest }])
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return artifactRequest()
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({
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
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.5.0', [
          { name: 'PicoAide-Harness-2.5.0-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.5.0-mac.dmg', digest }])
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse(
          [artifact],
          { 'content-length': String(MAX_UPDATE_DOWNLOAD_BYTES + 1) },
        )
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.5.0',
      userDataPath,
      request,
    }), 'response-too-large')
    await expectNoPartialFiles(userDataPath, '2.5.0')
  })

  it('passes the caller signal and removes a partial file when aborted during streaming', async () => {
    const userDataPath = await temporaryUserData()
    const controller = new AbortController()
    const artifact = dmgArtifact()
    const digest = sha256(artifact)
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.6.0', [
          { name: 'PicoAide-Harness-2.6.0-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.6.0-mac.dmg', digest }])
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

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.6.0',
      userDataPath,
      request,
      signal: controller.signal,
    }), 'aborted')
    await expectNoPartialFiles(userDataPath, '2.6.0')
  })

  it('normalizes request aborts and transport failures without creating an artifact', async () => {
    const userDataPath = await temporaryUserData()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.0',
      userDataPath,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    }), 'aborted')
    await expectNoPartialFiles(userDataPath, '2.7.0')

    const request2: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.7.1', [
          { name: 'PicoAide-Harness-2.7.1-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      throw new Error(`unexpected URL ${url}`)
    }
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.1',
      userDataPath,
      request: request2,
    }), 'network')
    await expectNoPartialFiles(userDataPath, '2.7.1')
  })

  it('rejects a mismatched artifact digest before exposing the installer', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.8.0', [
          { name: 'PicoAide-Harness-2.8.0-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      if (url === 'https://artifacts.test/SHA256SUMS.txt') {
        return checksumResponse([{ name: 'PicoAide-Harness-2.8.0-mac.dmg', digest: '0'.repeat(64) }])
      }
      if (url === 'https://artifacts.test/mac.dmg') {
        return chunkedResponse([artifact])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.8.0',
      userDataPath,
      request,
    }), 'checksum-mismatch')
    await expectNoPartialFiles(userDataPath, '2.8.0')
  })

  it('rejects a missing release asset or checksum manifest', async () => {
    const userDataPath = await temporaryUserData()
    const request: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.9.0', [
          { name: 'PicoAide-Harness-2.9.0-mac.dmg', url: 'https://artifacts.test/mac.dmg' },
        ])
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      userDataPath,
      request,
    }), 'checksum-missing')

    const request2: UpdateArtifactRequest = async (url) => {
      if (url === DESKTOP_RELEASE_API_URL) {
        return releaseMetadata('2.9.1', [
          { name: 'PicoAide-Harness-2.9.1-linux.AppImage', url: 'https://artifacts.test/appimage' },
          { name: RELEASE_CHECKSUM_ASSET_NAME, url: 'https://artifacts.test/SHA256SUMS.txt' },
        ])
      }
      throw new Error(`unexpected URL ${url}`)
    }
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.1',
      userDataPath,
      request: request2,
    }), 'release-missing')
  })

  it.each([
    ['linux', '2.8.0'],
    ['darwin', '../2.8.0'],
    ['win32', 'v2.8.0'],
    ['win32', '2.8.0-rc.1'],
  ])('rejects platform %s and version %s before requesting', async (platform, version) => {
    const userDataPath = await temporaryUserData()
    let requested = false
    await expectFailure(downloadDesktopUpdate({
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

    await expectFailure(downloadDesktopUpdate({
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

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      userDataPath: linked,
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})
