import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_PACKAGE_NAME,
  desktopShellModeFromSettings,
  desktopStartupSettingsFromSettings,
  desktopBundleList,
  ensureDesktopProfile,
  prepareDesktopProfile,
  readDesktopShellMode,
  shippedPresetRoot,
} from '../src/profile.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  homes.push(home)
  return home
}

function installWebClient(
  home: string,
  packageName: string,
  manifest: Record<string, unknown> = {},
): string {
  const webDir = join(home, 'profiles', 'web')
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) throw new Error('test requires the shipped Web template')
  initProfile(webDir, template.bundles)
  const packageDir = join(webDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    dsh: { client: { platform: 'web' } },
    ...manifest,
  }) + '\n')
  writeFileSync(join(packageDir, 'index.js'), 'export default {}\n')
  return webDir
}

function installBundle(home: string, packageName: string, patch: string): void {
  const bundleDir = join(home, 'profiles', 'desktop', 'node_modules', packageName)
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: packageName,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), patch)
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profile composition', {
  timeout: process.platform === 'win32' ? 10_000 : 5_000,
}, () => {
  it('reads packaged Cordis skills from the physical unpacked preset root', async () => {
    const home = temporaryHome()
    const resources = join(home, 'resources')
    const archivedDsh = join(resources, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh')
    // Preset root lives with the dsh package inside the archive; ship the
    // skill at the same (non-unpacked) path used by the resolver.
    const archivedSkillPath = join(
      archivedDsh,
      'config',
      'agent-presets',
      'cordis',
      'skills',
      'cordis-plugin-development',
      'SKILL.md',
    )
    mkdirSync(join(resources, 'app.asar', 'lib'), { recursive: true })
    mkdirSync(archivedDsh, { recursive: true })
    mkdirSync(dirname(archivedSkillPath), { recursive: true })
    writeFileSync(join(archivedDsh, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      exports: { './package.json': './package.json' },
    }) + '\n')
    writeFileSync(archivedSkillPath, '# Cordis plugin development\n')

    const moduleUrl = pathToFileURL(join(resources, 'app.asar', 'lib', 'profile.js')).href
    const resolvedRoot = shippedPresetRoot(moduleUrl)

    // Preset root resolves through the module graph (physical in dev, inside
    // app.asar when packaged) — never rewritten to the unpacked physical tree.
    expect(resolvedRoot).not.toContain('app.asar.unpacked')
    expect(readFileSync(join(
      resolvedRoot,
      'cordis',
      'skills',
      'cordis-plugin-development',
      'SKILL.md',
    ), 'utf8')).toBe('# Cordis plugin development\n')
  })

  it('adds the Web surface before third-party bundles and removes the launcher bundle duplicate', async () => {
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

  it('repairs a base-only CLI profile without replacing dependencies', async () => {
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

  it('migrates the obsolete Desktop bundle before loading a historical profile', async () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            '@deepseek-ai/dsh-desktop-app',
          ],
        },
      },
    }, undefined, 2) + '\n')

    await expect(prepareDesktopProfile(undefined, home, 'win32')).resolves.toBeDefined()
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
  })

  it('rejects malformed persistent bundle metadata', async () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'not-an-array' } } }) + '\n')
    expect(() => ensureDesktopProfile(home)).toThrow('dsh.profile.bundles must be an array')
  })

  it('assembles the Host shell with the fixed advanced client shell', async () => {
    const home = temporaryHome()
    const prepared = await prepareDesktopProfile(undefined, home, 'darwin')
    const patches = prepared.patches as Array<Record<string, unknown>>
    const inserted = patches.flatMap((patch) => {
      const rows = patch.insert
      return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      name: DESKTOP_PACKAGE_NAME,
      config: { mode: 'advanced' },
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
    expect(prepared.homeDir).toBe(home)
    expect(fileURLToPath(prepared.bareModuleBaseUrl)).toBe(join(prepared.profile.dir, 'package.json'))
    expect(prepared.mode).toBe('advanced')

    const rows = composeEntries([prepared.patches])
    for (const [id, name] of [
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ] as const) {
      const matching = rows.filter(row => row.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toEqual(expect.objectContaining({ name }))
      if (id === 'ui-layout') expect(matching[0]?.disabled).toBe(true)
      else expect(matching[0]?.disabled).not.toBe(true)
    }
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    }))
    expect(rows.find(row => row.id === 'directory-picker')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-host')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-surface')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'agent-presets')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-presets',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-agent-presets')
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
    expect(rows.find(row => row.id === 'desktop-updates')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/updates',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-terminal')
    expect(rows.map(row => row.id)).not.toContain('desktop-pnpm')
    expect(rows.map(row => row.id)).not.toContain('desktop-profiles')
  })

  it('boots the fixed desktop profile with advanced shell rows', async () => {
    const home = temporaryHome()
    const desktopDir = ensureDesktopProfile(home)
    const bundles = PROFILE_TEMPLATES.web
    if (bundles === undefined) throw new Error('test requires the shipped Web template')
    void bundles
    writeFileSync(join(desktopDir, 'cordis.patch.yml'), [
      '- id: ui-layout',
      "  name: '@deepseek-ai/dsh-client-ui-layout'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-layout',
      "      name: 'third-party-layout'",
      '',
    ].join('\n'))

    const prepared = await prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.profile.name).toBe('desktop')
    expect(prepared.mode).toBe('advanced')
    expect(rows.find(row => row.id === 'ui-layout')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'third-party-layout')).toEqual({
      id: 'third-party-layout',
      name: 'third-party-layout',
    })
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop',
      config: expect.objectContaining({ mode: 'advanced' }),
    }))
  })

  it('projects YAML startup settings into the Host, Web server, and client Loader rows', async () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n  port: 43189\n')

    const prepared = await prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('advanced')
    expect(prepared.port).toBe(43_189)
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      disabled: false,
      config: expect.objectContaining({ mode: 'advanced', port: 43_189 }),
    }))
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      config: { host: '127.0.0.1', port: 43_189 },
    }))
    expect(rows.find(row => row.id === 'settings')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ dshHome: home }),
    }))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'ui-conversation')?.disabled).toBe(false)
  })

  it('reads JSON settings and defaults an absent desktop namespace to advanced', async () => {
    const home = temporaryHome()
    const path = join(home, 'desktop-settings.json')
    writeFileSync(path, JSON.stringify({ 'dsh-desktop': { mode: 'advanced' } }))

    expect(readDesktopShellMode({ path })).toBe('advanced')
    expect(desktopStartupSettingsFromSettings({ 'dsh-desktop': { mode: 'advanced', port: 43_189 } })).toEqual({
      mode: 'advanced',
      port: 43_189,
    })
    expect(desktopStartupSettingsFromSettings({ 'dsh-desktop': { mode: 'advanced' } })).toEqual({
      mode: 'advanced',
      port: 0,
    })
    expect(desktopShellModeFromSettings({ unrelated: { enabled: true } })).toBe('advanced')
  })

  it('rejects invalid settings roots, sections, modes, and YAML', async () => {
    expect(() => desktopShellModeFromSettings([])).toThrow('must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': true })).toThrow('settings must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': { mode: 'glass' } })).toThrow(
      'must be "compatibility" or "advanced"',
    )
    for (const port of [-1, 1.5, 65_536, '43189']) {
      expect(() => desktopStartupSettingsFromSettings({ 'dsh-desktop': { port } })).toThrow(
        'port must be an integer from 0 through 65535',
      )
    }

    const home = temporaryHome()
    const path = join(home, 'invalid.yaml')
    writeFileSync(path, 'dsh-desktop: [\n')
    expect(() => readDesktopShellMode({ path })).toThrow('invalid settings document')
  })

  it('keeps the Windows browse panel and desktop pwsh provider without replacing process boundaries', async () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  config:',
      "    cwd: 'C:\\workspace'",
      '',
    ].join('\n'))

    const prepared = await prepareDesktopProfile(undefined, home, 'win32')
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
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'agent-presets')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-presets',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'desktop-windows-agent-presets')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/windows-agent-presets',
    }))
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-windows-pwsh-sandbox',
      name: 'dsh-plugin-desktop/windows-pwsh-sandbox',
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { cwd: 'C:\\workspace' },
    }))
  })

  it('rejects a bundle and user patch that register the same loader entry id', async () => {
    const home = temporaryHome()
    const packageName = 'dsh-usage-stats'
    const bundlePatch = [
      '- insert:',
      '    - id: usage-stats',
      `      name: '${packageName}'`,
      '',
    ].join('\n')
    installBundle(home, packageName, bundlePatch)
    const profileDir = join(home, 'profiles', 'desktop')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName] } },
    }) + '\n')
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: usage-stats',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    await expect(prepareDesktopProfile(undefined, home, 'win32')).rejects.toThrow(
      'duplicate loader entry id "usage-stats" in the composed profile',
    )
  })

  it('keeps a Web Client in its owning profile and omits it from desktop', async () => {
    const home = temporaryHome()
    const packageName = '@linxin666/dsh-client-ui-skin-whale-song'
    installWebClient(home, packageName, { exports: { '.': { import: './index.js' } } })
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: missing-skin',
      `      name: '${packageName}'`,
      '    - id: third-party-host',
      "      name: 'third-party-host-plugin'",
      '',
    ].join('\n'))

    const desktop = await prepareDesktopProfile(undefined, home, 'darwin')
    const desktopRows = composeEntries([desktop.patches])

    expect(desktopRows.map(row => row.id)).not.toContain('missing-skin')
    expect(desktopRows).toContainEqual({
      id: 'third-party-host',
      name: 'third-party-host-plugin',
    })
    expect(desktop.skippedOptionalEntries).toEqual([{
      id: 'missing-skin',
      name: packageName,
    }])
  })

  it('keeps unresolved non-UI package entries fail-loud', async () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: optional-theme',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    const desktop = await prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([desktop.patches])).toContainEqual({ id: 'optional-theme', name: packageName })
    expect(desktop.skippedOptionalEntries).toEqual([])
  })

  it('does not treat ordinary array config as nested Loader entries', async () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    installWebClient(home, packageName)
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: config-holder',
      "      name: 'third-party-host-plugin'",
      '      config:',
      `        - name: '${packageName}'`,
      '          enabled: true',
      '',
    ].join('\n'))

    const prepared = await prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'config-holder',
      name: 'third-party-host-plugin',
      config: [{ name: packageName, enabled: true }],
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('leaves non-package Loader specifiers unchanged', async () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: builtin-plugin',
      "      name: 'cordis:example'",
      '',
    ].join('\n'))

    const prepared = await prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'builtin-plugin',
      name: 'cordis:example',
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('preserves an explicitly disabled upstream pwsh provider and a third-party replacement', async () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-pwsh-sandbox',
      "      name: 'third-party-pwsh-sandbox'",
      '',
    ].join('\n'))

    const prepared = await prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])

    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'third-party-pwsh-sandbox',
      name: 'third-party-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
  })
})
