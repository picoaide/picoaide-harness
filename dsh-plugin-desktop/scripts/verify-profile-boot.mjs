/** Headless smoke for the complete published DSH Web profile and renderer manifest. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { DESKTOP_MODE_ENDPOINT, DESKTOP_SETTINGS_NAMESPACE } from '../lib/index.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

const BIN_NAME = 'dsh-plugin-desktop-profile-smoke'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
let ctx
let releasePackageResolver
let mountedSpec

try {
  writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n')
  const prepared = prepareDesktopProfile('1', home, 'win32')
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = {
    platform: 'win32',
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
    },
    show() {},
    async requestRestart() {},
    prepareToQuit() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    prepared.patches,
    (host) => {
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
  const desktopSettings = ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE)
  if (desktopSettings?.mode !== 'advanced') {
    throw new Error('assembled Host settings are missing the advanced dsh-desktop mode')
  }
  const response = await fetch(expectedUrl)
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  const bootMatch = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    throw new Error('assembled Web root is missing window.__DSH_BOOT__')
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  for (const id of [
    'dsh-plugin-desktop',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  ]) {
    if (!ids.has(id)) throw new Error(`assembled advanced Web graph is missing ${id}`)
  }
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
  ]) {
    if (ids.has(id)) throw new Error(`assembled advanced Web graph unexpectedly includes ${id}`)
  }
  const origin = new URL(expectedUrl).origin
  const modeResponse = await fetch(`${origin}${DESKTOP_MODE_ENDPOINT}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'advanced' }),
  })
  if (modeResponse.status !== 204) {
    throw new Error(`assembled desktop mode endpoint returned HTTP ${String(modeResponse.status)}`)
  }
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  rmSync(home, { recursive: true, force: true })
}
