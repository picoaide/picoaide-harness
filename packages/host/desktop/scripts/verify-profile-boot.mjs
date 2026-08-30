/** Headless smoke for the complete published PicoAide Harness profile and renderer manifest. */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { DESKTOP_SETTINGS_NAMESPACE } from '../lib/index.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

// 产物清理(2026-09): 依赖包 lib/ 不再入库, fresh checkout 下 profile smoke
// 需要先构建全部 workspace 依赖(better-sidebar/cron/connectors/browser 等),
// 否则临时 profile 的 node_modules 里缺 lib/index.js —— CI yarn check 失败根因。
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
prebuildWorkspaceDeps(packageRoot)

const BIN_NAME = 'dsh-plugin-desktop-profile-smoke'
const HOST_SERVICE_PLUGIN_NAME = 'dsh-desktop-host-services-smoke-plugin'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
// Isolate the product home for the whole boot: profile files live in the
// temporary home, and every plugin resolves its data dir through `$DSH_HOME`
// (`dshHome()`), so without this override the smoke would initialize real
// plugin storage (cron/task/memory) under the user's actual home.
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let ctx
let releasePackageResolver
let mountedSpec
let nativeThemeSource = 'system'
const trayItems = []

try {
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))
  const prepared = prepareDesktopProfile('1', home, 'win32')
  const hostServicePluginDir = join(
    prepared.profile.dir,
    'node_modules',
    HOST_SERVICE_PLUGIN_NAME,
  )
  mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
  cpSync(
    fileURLToPath(new URL('../tests/fixtures/desktop-host-services-smoke-plugin/', import.meta.url)),
    hostServicePluginDir,
    { recursive: true, force: false, errorOnExist: true },
  )
  const patches = [
    {
      insert: [{
        id: 'desktop-host-services-smoke-plugin',
        name: HOST_SERVICE_PLUGIN_NAME,
      }],
    },
    ...prepared.patches,
  ]
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = {
    platform: 'win32',
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('profile smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      runtime.setLocalePreference(mountedSpec.readLocalePreference())
      nativeThemeSource = mountedSpec.readThemeSource()
    },
    show() {},
    registerTrayItem(item) {
      trayItems.push(item)
      return {
        refresh() {},
        dispose() {
          const index = trayItems.indexOf(item)
          if (index >= 0) trayItems.splice(index, 1)
        },
      }
    },
    setLocalePreference(preference) { runtime.locale = preference ?? 'en' },
    setThemeSource(source) { nativeThemeSource = source },
    async requestRestart() {},
    prepareToQuit() {},
    setDeepLinkHandler() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    patches,
    async (host) => {
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopRuntime', runtime)
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()

  const agentPresets = ctx.get('agentPresets')
  if (agentPresets === undefined) {
    throw new Error('assembled Windows profile is missing the agent preset roster')
  }
  const presetIds = (await agentPresets.list()).map(preset => preset.id)
  if (presetIds.includes('minimal') || !presetIds.includes('standard')) {
    throw new Error(`assembled Windows profile exposes unexpected presets: ${presetIds.join(', ')}`)
  }
  if (agentPresets.defaultId !== 'standard') {
    throw new Error(`assembled Windows profile selected unsupported default ${agentPresets.defaultId}`)
  }
  const legacyPreset = await agentPresets.resolve('minimal')
  if (legacyPreset.id !== 'minimal') {
    throw new Error(`assembled Windows profile remapped legacy preset to ${legacyPreset.id}`)
  }

  const picker = ctx.directoryPicker.capability()
  if (picker.kind !== 'browse') {
    throw new Error(`assembled Windows profile selected ${picker.kind} directory picker`)
  }
  const listing = await picker.list(home)
  if (listing.path !== home) {
    throw new Error(`assembled Windows browse picker listed ${listing.path} instead of ${home}`)
  }

  const expectedUrl = `http://127.0.0.1:${String(ctx.webServer.port)}/?dsh-desktop-mode=advanced&dsh-desktop-platform=win32`
  if (mountedSpec?.url !== expectedUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
  if (mountedSpec?.mode !== 'advanced') {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (nativeThemeSource !== 'system') {
    throw new Error(`desktop plugin produced an unexpected native theme source: ${nativeThemeSource}`)
  }
  const desktopSettings = ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE)
  if (desktopSettings?.mode !== 'advanced') {
    throw new Error('assembled Host settings are missing the advanced dsh-desktop mode')
  }
  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }
  if (trayItems.some(item => item.label().startsWith('Profile:'))) {
    throw new Error('assembled desktop profile unexpectedly includes the profile tray submenu')
  }
  if (trayItems.some(item => item.label() === 'Open DSH Terminal')) {
    throw new Error('assembled desktop profile unexpectedly includes the terminal tray command')
  }
  // The enterprise login gate serves its own page at the Web root while logged
  // out, so authenticate before verifying the assembled Web app root.
  ctx.picoSession.setSession({
    serverURL: 'http://127.0.0.1:1',
    username: 'profile-smoke',
    token: 'profile-smoke-token',
  })
  const response = await fetch(expectedUrl)
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  // Upstream 0.1.1 wires the boot graph through the structured
  // `webserver/index-inject` table: a `global` row renders as
  // `globalThis["__DSH_BOOT__"] = {...}` (was `window.__DSH_BOOT__ = ...`).
  const bootMatch = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    throw new Error('assembled Web root is missing window.__DSH_BOOT__')
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  for (const id of [
    'dsh-plugin-desktop',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  ]) {
    if (!ids.has(id)) throw new Error(`assembled advanced Web graph is missing ${id}`)
  }
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
    // Enterprise model governance: custom model providers are disabled from
    // the composition; models come from the gateway after login only.
    '@deepseek-ai/dsh-client-ui-settings-models',
  ]) {
    if (ids.has(id)) throw new Error(`assembled advanced Web graph unexpectedly includes ${id}`)
  }
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  rmSync(home, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
}
