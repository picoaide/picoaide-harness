/** Headless artifact smoke for profile-local and launcher-owned Cordis plugins. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

const BIN_NAME = 'dsh-plugin-desktop-loader-smoke'
const THIRD_PARTY_NAME = 'dsh-desktop-loader-smoke-plugin'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-loader-'))
// Isolate the product home for the whole boot: profile files live in the
// temporary home, and plugins resolve their data dir through `$DSH_HOME`
// (`dshHome()`), so without this override the smoke would initialize real
// plugin storage under the user's actual home.
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let ctx
let mounted
let mountedSpec
let releasePackageResolver

try {
  const launchEnvironment = createLaunchEnvironmentSnapshot([{
    source: 'process',
    values: { ...process.env },
  }])
  const prepared = prepareDesktopProfile(undefined, home)
  const thirdPartyDir = join(prepared.profile.dir, 'node_modules', THIRD_PARTY_NAME)
  mkdirSync(thirdPartyDir, { recursive: true })
  writeFileSync(join(thirdPartyDir, 'package.json'), JSON.stringify({
    name: THIRD_PARTY_NAME,
    version: '0.0.0',
    type: 'module',
    exports: './index.js',
  }) + '\n')
  writeFileSync(join(thirdPartyDir, 'index.js'), [
    "export function apply(ctx) {",
    "  const launchPath = ctx.launchEnvironment?.get('PATH')?.value",
    `  if (launchPath !== ${JSON.stringify(launchEnvironment.get('PATH')?.value)}) throw new Error('third-party plugin received a mutated launch-environment PATH snapshot')`,
    '}',
    '',
  ].join('\n'))
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const profileRequire = createRequire(prepared.bareModuleBaseUrl)
  const desktopManifest = fileURLToPath(new URL('../package.json', import.meta.url))
  if (profileRequire.resolve('dsh-plugin-desktop/package.json') !== desktopManifest) {
    throw new Error('desktop package manifest did not resolve from the installed launcher')
  }
  const profileDirectoryRequire = createRequire(new URL('.', prepared.bareModuleBaseUrl))
  if (profileDirectoryRequire.resolve('dsh-plugin-desktop/package.json') !== desktopManifest) {
    throw new Error('desktop package manifest did not resolve from the profile directory')
  }

  const runtime = {
    platform: 'darwin',
    schedule(spec) {
      mountedSpec = spec
      return async () => { await mounted }
    },
    mountScheduled() {
      if (mountedSpec === undefined) return Promise.reject(new Error('desktop shell was not registered'))
      mounted ??= Promise.resolve()
      return mounted
    },
    show() {},
    async requestRestart() {},
    prepareToQuit() {},
    setDeepLinkHandler() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    [{ insert: [
      { id: 'desktop-shell', name: 'dsh-plugin-desktop' },
      { id: 'third-party-smoke', name: THIRD_PARTY_NAME },
    ] }],
    (host) => {
      // Packaged Electron does not expose Node's internal ESM loader.
      host.loader.internal = undefined
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironment)
      host.provide('desktopRuntime', runtime)
      host.provide('webServer', {
        host: '127.0.0.1',
        port: 43120,
        register() { return () => {} },
      })
      host.provide('webRuntime', {})
      host.provide('appExit', () => {})
      host.provide('settings', {
        register() {
          return {
            get: () => ({ mode: 'advanced' }),
            watch: () => () => {},
            update: async () => {},
            replace: async () => {},
          }
        },
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()

  const desktopEntry = ctx.loader.resolve('include:desktop-shell')
  const thirdPartyEntry = ctx.loader.resolve('include:third-party-smoke')
  if (desktopEntry?.options.name !== 'dsh-plugin-desktop') {
    throw new Error('launcher-owned desktop plugin did not activate through its bare package name')
  }
  if (thirdPartyEntry?.options.name !== THIRD_PARTY_NAME) {
    throw new Error('profile-local third-party plugin did not activate')
  }
  if (mountedSpec?.url !== 'http://127.0.0.1:43120/?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin') {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
} finally {
  try {
    await ctx?.fiber.dispose()
  } finally {
    try {
      releasePackageResolver?.()
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      rmSync(home, { recursive: true, force: true })
    }
  }
}
