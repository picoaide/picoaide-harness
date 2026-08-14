/** Headless smoke for the complete published DSH Web profile and renderer manifest. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

const BIN_NAME = 'dsh-plugin-desktop-profile-smoke'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
let ctx
let releasePackageResolver
let mountedSpec

try {
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

  const expectedUrl = `http://127.0.0.1:${String(ctx.webServer.port)}/`
  if (mountedSpec?.url !== expectedUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
  const response = await fetch(expectedUrl)
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  for (const marker of [
    'window.__DSH_BOOT__',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  ]) {
    if (!html.includes(marker)) throw new Error(`assembled Web root is missing ${marker}`)
  }
  if (html.includes('@deepseek-ai/dsh-client-ui-directory-picker-native')) {
    throw new Error('assembled Windows Web root includes the native directory picker')
  }
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  rmSync(home, { recursive: true, force: true })
}
