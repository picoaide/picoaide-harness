import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  readDesktopStartupSettings,
  removeStaleAsarFallbackLinks,
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
  it('ships the preset declarations from the Web bundle, not the roster package', () => {
    // 0.1.7 moved the shipped presets out of the (deleted) roster package into
    // `@deepseek-ai/dsh-web-app`'s `presets/<id>.patch.yml` files, listed in
    // that bundle's own `dsh.bundle.patch`. Two things must both hold: the
    // declarations exist, and the bundle actually lists them — a bundle that
    // still names only `./cordis.patch.yml` would compose without a single
    // preset and every session would fail to mount.
    const bundleDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json'))
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string | string[] } }
    }
    const declared = manifest.dsh?.bundle?.patch
    const patchFiles = typeof declared === 'string' ? [declared] : declared ?? []
    for (const id of ['standard', 'ptc', 'minimal', 'cordis'] as const) {
      expect(patchFiles).toContain(`./presets/${id}.patch.yml`)
      expect(existsSync(join(bundleDir, 'presets', `${id}.patch.yml`))).toBe(true)
    }
  })

  it('ships the cordis preset skills from the preset plugin, not the roster package', () => {
    // The `cordis` preset's skills moved to `@deepseek-ai/dsh-agent-preset`
    // (`skills/`, wired through the preset's `customSkillDirs` expression).
    const presetDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset/package.json'))
    const skillsRoot = join(presetDir, 'skills')
    expect(existsSync(skillsRoot)).toBe(true)
    for (const skill of ['cordis-plugin-development', 'editing-cordis-compositions'] as const) {
      expect(existsSync(join(skillsRoot, skill, 'SKILL.md'))).toBe(true)
    }
  })

  it('puts the required layers first (Web surface, then the ten launcher-owned layers) and keeps third-party bundles', async () => {
    // 2026-09-28：十个自有组装层（desktop 自己 + enterprise/account-card/wasm-apps/
    // foot-menu/wasm-apps-host/connectors/browser/memory-evolve/cron）改由 **bundle 层**
    // 承载（各自 `dsh.bundle.patch`），顺序就是下面这份清单 —— 它同时是
    // 「`readProfilePatches` 复算得出真实装配」的前提（见 `src/profile.ts` 的
    // `REQUIRED_BUNDLES` 注释）。历史 manifest 里的 `dsh-plugin-desktop` 条目仍然被丢弃
    // （它无法把自己解析成 bundle，改由 `@picoaide/dsh-enterprise` 的 patch 列表携带桌面层）。
    expect(desktopBundleList([
      '@deepseek-ai/dsh-base',
      'third-party-one',
      DESKTOP_PACKAGE_NAME,
      'third-party-two',
    ])).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@picoaide/dsh-enterprise',
      '@picoaide/dsh-account-card',
      '@picoaide/dsh-wasm-apps',
      '@picoaide/dsh-foot-menu',
      '@picoaide/dsh-wasm-apps-host',
      '@picoaide/dsh-connectors',
      '@picoaide/dsh-browser',
      'dsh-memory-evolve',
      '@picoaide/dsh-cron',
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
      '@picoaide/dsh-enterprise',
      '@picoaide/dsh-account-card',
      '@picoaide/dsh-wasm-apps',
      '@picoaide/dsh-foot-menu',
      '@picoaide/dsh-wasm-apps-host',
      '@picoaide/dsh-connectors',
      '@picoaide/dsh-browser',
      'dsh-memory-evolve',
      '@picoaide/dsh-cron',
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
      '@picoaide/dsh-enterprise',
      '@picoaide/dsh-account-card',
      '@picoaide/dsh-wasm-apps',
      '@picoaide/dsh-foot-menu',
      '@picoaide/dsh-wasm-apps-host',
      '@picoaide/dsh-connectors',
      '@picoaide/dsh-browser',
      'dsh-memory-evolve',
      '@picoaide/dsh-cron',
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
      id: 'agent-preset-registry',
      // 0.1.7: the registry takes no launcher config. It has no `roots` key at
      // all any more — the shipped presets are rows contributed by the Web
      // bundle's own patch list, so an injected `roots` would be stripped (or,
      // worse, rejected) instead of pinning anything.
      config: { default: 'standard' },
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
      // Advanced desktop owns the root frame itself: ui-layout stays disabled
      // (the desktop shell provides `layout` and declares the frame's child
      // slots — a second declaration is fatal in 0.1.2).
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
    expect(rows.find(row => row.id === 'agent-preset-registry')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-preset-registry',
    }))
    // The shipped presets are ordinary declarative rows, contributed by
    // `@deepseek-ai/dsh-web-app`'s own `dsh.bundle.patch` list
    // (`presets/<id>.patch.yml`). Their presence here is the judge for "the
    // roster still reaches the composition" — a bundle whose patch list is read
    // as a single file would silently drop all four.
    for (const id of ['standard', 'ptc', 'minimal', 'cordis'] as const) {
      expect(rows.find(row => row.id === `preset-${id}`)).toEqual(expect.objectContaining({
        name: '@deepseek-ai/dsh-agent-preset',
      }))
    }
    expect(rows.map(row => row.id)).not.toContain('agent-presets')
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-agent-preset-registry')
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
    // 客户端专属 WASM 应用 origin（2026-09-19 契约 §2）：行由随包
    // cordis.patch.yml 插入，深链 scheme 由组装期**注入**（官方构建 = 产品缺省；
    // 渠道构建 = 渠道包 desktop.deep_link_scheme）——缺这条注入，插件侧一律
    // fail-closed 丢弃深链，且只在真机上表现为"分享链接没反应"。
    expect(rows.find(row => row.id === 'pico-wasm-apps-host')).toEqual(expect.objectContaining({
      name: '@picoaide/dsh-wasm-apps-host',
    }))
    // 三个值同源注入（§10/§16.1）：官方构建 = 产品缺省；渠道构建 = 渠道包字段。
    // 插件侧与渲染层都不得自己读随包 channel.json（tsdown 内联后那条路径不成立）。
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'pico-wasm-apps-host',
      config: {
        deepLinkScheme: 'picoaide',
        appOriginScheme: 'picoaide-app',
        productName: 'PicoAide Harness',
      },
    }))
    // 浏览器面也要拿到应用源 scheme（导航闸门按 surface 分流要用它）。
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'pico-browser',
      config: expect.objectContaining({ appOriginScheme: 'picoaide-app' }),
    }))
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
    // The user patch disabling ui-layout is respected: advanced desktop owns
    // the root frame and `layout` service (ui-layout would collide on both).
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

  it('projects the composed desktop-shell port into the Host, Web server, and client Loader rows', async () => {
    const home = temporaryHome()
    // 0.1.7: the desktop's settings **are** the `desktop-shell` row config in the
    // profile patch (a profile entry id is the settings namespace), so the port a
    // user saved through the settings form arrives here as a composed row value.
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: desktop-shell',
      '  config:',
      '    port: 43189',
      '',
    ].join('\n'))

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
    // The launcher no longer injects any config into the settings row: the
    // 0.1.7 settings service is a form projection whose persistence is the
    // profile patch, and its document path comes from `profileContext`.
    expect(rows.find(row => row.id === 'settings')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-settings',
    }))
    expect(rows.find(row => row.id === 'settings')?.config).toBeUndefined()
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'ui-conversation')?.disabled).toBe(false)
  })

  it('defaults an absent desktop row to advanced and reads the composed port', async () => {
    const home = temporaryHome()

    expect(readDesktopShellMode({}, home)).toBe('advanced')
    expect(readDesktopStartupSettings({ port: 43_189 }, home)).toEqual({ mode: 'advanced', port: 43_189 })
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

    // The retired `settings.yaml` is still parsed as the one-time migration
    // fallback, so a corrupt document stays fatal instead of silently
    // defaulting a value the user wrote.
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop: [\n')
    expect(() => readDesktopShellMode({}, home)).toThrow('invalid settings document')
    // A composed row always wins over the legacy document.
    expect(readDesktopShellMode({ port: 4242 }, home)).toBe('advanced')
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
    expect(rows.find(row => row.id === 'agent-preset-registry')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-preset-registry',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'desktop-windows-agent-preset-registry')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/windows-agent-presets',
      // Same registry policy, replacement implementation: the shipped
      // `preset-*` rows register into whatever provides `agentPresets`.
      config: { default: 'standard' },
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

describe('removeStaleAsarFallbackLinks', () => {
  it('removes asar-targeting fallback symlinks and keeps real links and directories', () => {
    const home = temporaryHome()
    const modulesDir = join(home, 'profiles', 'node_modules')
    mkdirSync(join(modulesDir, '@deepseek-ai', 'real-pkg'), { recursive: true })
    // A stale asar-targeting link (the pre-physical-layout shape; the target
    // archive is gone and Electron's realpath fails on it).
    symlinkSync(
      '/srv/app/resources/app.asar/node_modules/@deepseek-ai/dsh-persona',
      join(modulesDir, '@deepseek-ai', 'dsh-persona'),
    )
    // A link into the physical tree must stay (the current layout).
    const physicalTarget = join(modulesDir, '@deepseek-ai', 'real-pkg')
    symlinkSync(physicalTarget, join(modulesDir, '@deepseek-ai', 'kept-pkg'))

    removeStaleAsarFallbackLinks(home)

    expect(() => lstatSync(join(modulesDir, '@deepseek-ai', 'dsh-persona'))).toThrow()
    expect(lstatSync(join(modulesDir, '@deepseek-ai', 'kept-pkg')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(modulesDir, '@deepseek-ai', 'real-pkg')).isDirectory()).toBe(true)
  })
})

describe('profile package resolution (upstream 0.1.7 seam change)', () => {
  it('composes without the retired shared profiles/node_modules closure', async () => {
    const home = temporaryHome()
    const prepared = await prepareDesktopProfile(undefined, home, 'linux')
    // Upstream 0.1.7 removed `healProfilesModuleFallback` (and its `materialize`
    // option) outright: `loadProfile` now only strips the profile's own
    // `.dsh-module-fallback` projection and leaf resolution goes through the
    // `PluginPackages` runtime-resolution service.
    //
    // 我们**不**依赖那套链接落盘：桌面自己的 `installProfilePackageResolver`
    // （`src/module-resolution.ts`）先按 profile 基址解析、失败后回落到桌面应用树，而
    // 后者在物理布局与 asar 布局里都成立 —— 那条共享目录只是它之外的一层冗余 belt。
    // 因此这里断言的是"组合照常产出、bundle 层解析到了真身"，而不是某种目录形态：
    // 判据若钉在 `profiles/node_modules` 上，只会把上游的一次机制替换误报成回归。
    expect(prepared.profile.layers.map(layer => layer.packageName)).toContain('@deepseek-ai/dsh-web-app')
    for (const layer of prepared.profile.layers) {
      expect(existsSync(join(layer.packageDir, 'package.json')), `${layer.packageName} 的包目录读不到`).toBe(true)
    }
    // 真判据在打包产物的 afterPack 冒烟与 `module-resolution.spec.ts`（真实 Node 解析），
    // 不是这里；这条只保证"上游把链接机制换掉"不会让组合本身失败。
  })
})
