import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name?: unknown
  bin?: Record<string, unknown>
  exports?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown }; client?: { platform?: unknown } }
  build?: { productName?: unknown; appId?: unknown; files?: unknown }
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

  it('exposes the dual-face Cordis plugin', () => {
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh).toEqual({
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: [] },
    })
    expect(readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')).toContain('name: dsh-plugin-desktop')
  })

  it('fixes the installed application identity', () => {
    expect(manifest.build?.productName).toBe('DSH Desktop')
    expect(manifest.build?.appId).toBe('ai.deepseek.dsh.desktop')
    expect(manifest.build?.files).toEqual([
      'build/icon.png',
      'cordis.patch.yml',
      'lib/**',
      'package.json',
    ])
  })

  it('keeps Electron out of production dependencies consumed by electron-builder', () => {
    expect(manifest.dependencies).not.toHaveProperty('electron')
    expect(manifest.peerDependencies?.electron).toBe('43.4.0')
    expect(manifest.devDependencies?.electron).toBe('43.4.0')
  })
})
