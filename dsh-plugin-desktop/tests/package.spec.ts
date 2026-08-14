import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name?: unknown
  bin?: Record<string, unknown>
  exports?: Record<string, unknown>
  files?: unknown
  dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  build?: {
    productName?: unknown
    appId?: unknown
    files?: unknown
    mac?: { icon?: unknown }
    win?: { icon?: unknown }
    linux?: { icon?: unknown }
  }
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
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
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(manifest.dsh?.client).toEqual(expect.objectContaining({
      platform: 'web',
      inject: expect.arrayContaining([
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-theme',
        '@deepseek-ai/dsh-client-ui-settings',
      ]),
    }))
    expect(manifest.dsh?.client).not.toEqual(expect.objectContaining({
      inject: expect.arrayContaining([
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-api-remotes',
      ]),
    }))
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop')
  })

  it('fixes the installed application identity', () => {
    expect(manifest.build?.productName).toBe('DSH Desktop')
    expect(manifest.build?.appId).toBe('ai.deepseek.dsh.desktop')
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
})
