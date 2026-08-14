import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_PACKAGE_NAME,
  desktopBundleList,
  ensureDesktopProfile,
  prepareDesktopProfile,
} from '../src/profile.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profile composition', () => {
  it('adds the Web surface before third-party bundles and removes the launcher bundle duplicate', () => {
    expect(desktopBundleList([
      '@deepseek-ai/dsh-base',
      'third-party-one',
      DESKTOP_PACKAGE_NAME,
      'third-party-two',
    ])).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-one',
      'third-party-two',
    ])
  })

  it('repairs a base-only CLI profile without replacing dependencies', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dependencies: { 'third-party-plugin': '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'third-party-plugin'] } },
      custom: { preserved: true },
    }, undefined, 2) + '\n')

    ensureDesktopProfile(home)
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      custom: { preserved: boolean }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-plugin',
    ])
    expect(repaired.dependencies).toEqual({ 'third-party-plugin': '^1.2.3' })
    expect(repaired.custom.preserved).toBe(true)
  })

  it('rejects malformed persistent bundle metadata', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'not-an-array' } } }) + '\n')
    expect(() => ensureDesktopProfile(home)).toThrow('dsh.profile.bundles must be an array')
  })

  it('assembles the Host shell without replacing the upstream client shell', () => {
    const prepared = prepareDesktopProfile(undefined, temporaryHome(), 'darwin')
    const patches = prepared.patches as Array<Record<string, unknown>>
    const inserted = patches.flatMap((patch) => {
      const rows = patch.insert
      return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      name: DESKTOP_PACKAGE_NAME,
      config: { mode: 'compatibility' },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'webserver',
      config: { host: '127.0.0.1', port: 0 },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'agent-presets',
      config: expect.objectContaining({ roots: [expect.objectContaining({ trust: 'system' })] }),
    }))
    expect(readFileSync(prepared.rootConfig, 'utf8')).toBe('[]\n')
    expect(fileURLToPath(prepared.bareModuleBaseUrl)).toBe(join(prepared.profile.dir, 'package.json'))

    const rows = composeEntries([prepared.patches])
    for (const [id, name] of [
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ] as const) {
      const matching = rows.filter(row => row.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toEqual(expect.objectContaining({ name }))
      expect(matching[0]?.disabled).toBeFalsy()
    }
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    }))
    expect(rows.find(row => row.id === 'directory-picker')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-host')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-surface')
  })

  it('pins the browse directory picker on Windows without loading the native backend', () => {
    const prepared = prepareDesktopProfile(undefined, temporaryHome(), 'win32')
    const rows = composeEntries([prepared.patches])
    const picker = rows.find(row => row.id === 'directory-picker')

    expect(picker).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-browse-host',
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-browse-surface',
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    }))
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-host-directory-picker-native')
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-client-ui-directory-picker-native')
  })
})
