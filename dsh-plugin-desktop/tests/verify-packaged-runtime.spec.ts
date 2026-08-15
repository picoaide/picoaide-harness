import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedUnpackedRoot,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackagedRuntimeContext,
} from '../scripts/verify-packaged-runtime.ts'

function context(appOutDir: string, electronPlatformName: string): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return REQUIRED_PACKAGED_RUNTIME_ENTRIES.map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

describe('packaged desktop runtime verification', () => {
  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))

    const exists = vi.fn<FileProbe>(() => true)

    verifyPackagedRuntime(context('/build', platform), list, exists)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(`${expectedPath}.unpacked`)
    expect(exists).toHaveBeenCalledTimes(REQUIRED_UNPACKED_RUNTIME_ENTRIES.length)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('fails loud when a required runtime entry is absent', () => {
    const missing = 'lib/client.js'
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it('fails loud when the physical CLI runtime is absent from app.asar.unpacked', () => {
    const missing = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

    expect(() => verifyPackagedRuntime(
      context('/build', 'win32'),
      () => completeArchiveEntries(),
      filename => !filename.endsWith(missing),
    )).toThrow(`missing required physical entries: ${missing}`)
  })
})
