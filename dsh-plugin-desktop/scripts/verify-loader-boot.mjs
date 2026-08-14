/** Headless artifact smoke for profile-local and launcher-owned Cordis plugins. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

const BIN_NAME = 'dsh-plugin-desktop-loader-smoke'
const THIRD_PARTY_NAME = 'dsh-desktop-loader-smoke-plugin'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-loader-'))
let ctx
let mounted
let mountedSpec
let releasePackageResolver

try {
  const prepared = prepareDesktopProfile(undefined, home)
  const thirdPartyDir = join(prepared.profile.dir, 'node_modules', THIRD_PARTY_NAME)
  mkdirSync(thirdPartyDir, { recursive: true })
  writeFileSync(join(thirdPartyDir, 'package.json'), JSON.stringify({
    name: THIRD_PARTY_NAME,
    version: '0.0.0',
    type: 'module',
    exports: './index.js',
  }) + '\n')
  writeFileSync(join(thirdPartyDir, 'index.js'), 'export function apply() {}\n')
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
    mountAfter(ready, resolveSpec) {
      mounted = ready.then(() => { mountedSpec = resolveSpec() })
      return async () => { await mounted }
    },
    whenMounted() {
      if (mounted === undefined) return Promise.reject(new Error('desktop shell was not scheduled'))
      return mounted
    },
    show() {},
    prepareToQuit() {},
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
      host.provide('desktopRuntime', runtime)
      host.provide('webServer', { port: 43120 })
      host.provide('webRuntime', {})
      host.provide('appExit', () => {})
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.whenMounted()

  const desktopEntry = ctx.loader.resolve('include:desktop-shell')
  const thirdPartyEntry = ctx.loader.resolve('include:third-party-smoke')
  if (desktopEntry?.options.name !== 'dsh-plugin-desktop') {
    throw new Error('launcher-owned desktop plugin did not activate through its bare package name')
  }
  if (thirdPartyEntry?.options.name !== THIRD_PARTY_NAME) {
    throw new Error('profile-local third-party plugin did not activate')
  }
  if (mountedSpec?.mode !== 'compatibility') {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (mountedSpec?.url !== 'http://127.0.0.1:43120/') {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  rmSync(home, { recursive: true, force: true })
}
