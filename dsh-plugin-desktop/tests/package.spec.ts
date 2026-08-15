import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const workspaceRoot = new URL('../', packageRoot)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name?: unknown
  version?: unknown
  bin?: Record<string, unknown>
  exports?: Record<string, unknown>
  files?: unknown
  scripts?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  build?: {
    productName?: unknown
    appId?: unknown
    afterPack?: unknown
    electronFuses?: unknown
    files?: unknown
    mac?: { hardenedRuntime?: unknown; icon?: unknown; notarize?: unknown; target?: unknown }
    win?: { icon?: unknown }
    linux?: { icon?: unknown }
  }
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}
const workspaceManifest = JSON.parse(readFileSync(new URL('package.json', workspaceRoot), 'utf8')) as {
  version?: unknown
  resolutions?: Record<string, unknown>
  scripts?: Record<string, unknown>
}

describe('published package surface', () => {
  it('registers both npm launcher names', () => {
    expect(manifest.name).toBe('dsh-plugin-desktop')
    expect(manifest.bin).toEqual({
      'dsh-plugin-desktop': 'lib/bin.js',
      'dsh-desktop': 'lib/bin.js',
    })
  })

  it('exposes the Host plugin and desktop-owned client face', () => {
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./windows-pwsh-sandbox', {
      types: './lib/types/windows-pwsh-sandbox.d.ts',
      default: './lib/windows-pwsh-sandbox.js',
    })
    expect(manifest.exports).not.toHaveProperty('./windows-acl-runner')
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    })
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop')
  })

  it('builds the public Windows executor and its private runner trampoline', () => {
    const config = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')

    expect(config).toContain("'windows-pwsh-sandbox': 'src/windows-pwsh-sandbox.ts'")
    expect(config).toContain("'windows-acl-runner': 'src/windows-acl-runner.ts'")
  })

  it('fixes the installed application identity', () => {
    expect(manifest.version).toBe(workspaceManifest.version)
    expect(manifest.build?.productName).toBe('DSH Desktop')
    expect(manifest.build?.appId).toBe('ai.deepseek.dsh.desktop')
    expect(manifest.build?.electronFuses).toEqual({ runAsNode: true })
    expect(manifest.files).toEqual(expect.arrayContaining([
      'build/app-icon.png',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
    ]))
    expect(manifest.build?.files).toEqual([
      'build/app-icon.png',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'cordis.patch.yml',
      'lib/**',
      'package.json',
    ])
    expect(manifest.build?.mac?.icon).toBe('build/app-icon.png')
    expect(manifest.build?.win?.icon).toBe('build/app-icon.png')
    expect(manifest.build?.linux?.icon).toBe('build/app-icon.png')
  })

  it('separates unsigned smoke packaging from the signed macOS release', () => {
    const packageDir = readFileSync(new URL('scripts/package-dir.mjs', packageRoot), 'utf8')

    expect(manifest.scripts?.['package:dir']).toBe('yarn run build && node scripts/package-dir.mjs')
    expect(packageDir).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(manifest.scripts?.['dist:mac']).toBe('node scripts/release-mac.ts')
    expect(workspaceManifest.scripts?.['dist:mac']).toBe('yarn workspace dsh-plugin-desktop dist:mac')
    expect(manifest.build?.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
    expect(manifest.build?.mac).toEqual(expect.objectContaining({
      hardenedRuntime: true,
      notarize: true,
      target: ['dir'],
    }))
    expect(manifest.devDependencies?.['@electron/asar']).toBe('3.4.1')
  })

  it('keeps one fixed brand-blue tray source for generated native assets', () => {
    const source = readFileSync(new URL('build/tray-icon.svg', packageRoot), 'utf8')

    expect(source.match(/#4D6BFE/gu)).toHaveLength(1)
    expect(source).not.toMatch(/<style\b|prefers-color-scheme/iu)
    for (const filename of [
      'tray-iconTemplate.png',
      'tray-iconTemplate@2x.png',
      'tray-icon-blue.png',
      'tray-icon-blue@1.25x.png',
      'tray-icon-blue@1.5x.png',
      'tray-icon-blue@2x.png',
    ]) {
      expect(readFileSync(new URL(`build/${filename}`, packageRoot)).byteLength).toBeGreaterThan(0)
    }
  })

  it('ships the unmodified iOS Default application icon', () => {
    const digest = createHash('sha256')
      .update(readFileSync(new URL('build/app-icon.png', packageRoot)))
      .digest('hex')

    expect(digest).toBe('315fbc6e57ff1f34894f21f66fb7f9f26deccf78333c71fad21a6cec64e7de80')
  })

  it('keeps Electron out of production dependencies consumed by electron-builder', () => {
    expect(manifest.dependencies).not.toHaveProperty('electron')
    expect(manifest.peerDependencies?.electron).toBe('43.4.0')
    expect(manifest.devDependencies?.electron).toBe('43.4.0')
  })

  it('resolves electron-builder through the pinned app-builder-lib keychain patch', () => {
    const patchResolution = 'patch:app-builder-lib@npm%3A26.15.3#./patches/app-builder-lib@26.15.3.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL('patches/app-builder-lib@26.15.3.patch', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const electronBuilderManifest = workspaceRequire.resolve('electron-builder/package.json')
    const electronBuilderRequire = createRequire(electronBuilderManifest)
    const appBuilderManifest = electronBuilderRequire.resolve('app-builder-lib/package.json')
    const installedCodeSign = readFileSync(join(dirname(appBuilderManifest), 'out/codeSign/macCodeSign.js'), 'utf8')

    expect(workspaceManifest.resolutions).toEqual({
      'app-builder-lib@npm:26.15.3': patchResolution,
    })
    expect(lockfile).toContain('app-builder-lib@patch:app-builder-lib@npm%3A26.15.3#./patches/app-builder-lib@26.15.3.patch')
    expect(patch).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(patch).toContain('"-k", keychainPassword, keychainFile')
    expect(installedCodeSign).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(installedCodeSign).toContain('"-k", keychainPassword, keychainFile')
  })
})
