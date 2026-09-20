/** Headless artifact smoke for profile-local and launcher-owned Cordis plugins. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// 数值来自唯一真源 `lib/startup-rows.js`（`FiberState` 是 const enum，运行时被擦除，
// 只能钉数值；`tests/startup-rows.spec.ts` 负责与上游 `fiber.d.ts` 对拍）。
import { FIBER_ACTIVE, FIBER_FAILED } from '../lib/startup-rows.js'

const BIN_NAME = 'dsh-plugin-desktop-loader-smoke'
const THIRD_PARTY_NAME = 'dsh-desktop-loader-smoke-plugin'

/**
 * Describe one entry's activation the way a human would triage it.
 *
 * 存在性（`resolve(id)` 拿得到 options）**不等于**该行真的活着：包名写错、
 * 模块导入失败、`apply` 抛异常时条目照样在树里。2026-09-20 升级审计的 P0-9
 * 就是"门禁只断言存在 ⇒ 坏包照样通过"。这里把判据换成激活状态。
 * @param entry - resolved Loader entry, or undefined when the id is absent.
 * @returns `'active'` only when the fiber is ACTIVE; otherwise why not.
 */
function activationOf(entry) {
  if (entry === undefined) return 'absent from the Loader tree'
  if (entry.disabled === true) return 'disabled in the composition'
  const state = entry.fiber?.state
  if (state === undefined) return 'no fiber (module failed to import)'
  return state === FIBER_ACTIVE ? 'active' : `fiber state ${String(state)}`
}

/** Require ACTIVE, with the reason in the message. */
function assertActive(label, entry) {
  const activation = activationOf(entry)
  if (activation !== 'active') {
    throw new Error(`${label} is not active: ${activation}`)
  }
}

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
  const prepared = await prepareDesktopProfile(undefined, home)
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
  const connectionStubDir = join(prepared.profile.dir, 'node_modules', 'connection-stub')
  mkdirSync(join(connectionStubDir, 'lib'), { recursive: true })
  writeFileSync(join(connectionStubDir, 'package.json'), JSON.stringify({
    name: 'connection-stub',
    version: '0.0.0',
    type: 'module',
    main: 'lib/index.js',
    exports: './lib/index.js',
  }) + '\n')
  writeFileSync(join(connectionStubDir, 'lib', 'index.js'), [
    "export const name = 'connection-stub'",
    "export function apply(ctx) {",
    "  // The desktop shell needs the connection carrier's launch-token URL",
    "  // (upstream 0.1.2 index auth); the loader smoke composes no Web bundle.",
    "  ctx.provide('connection', { authenticatedUrl: (url) => url })",
    "}",
    '',
  ].join('\n'))
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
      { id: 'connection-stub', name: 'connection-stub' },
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
  // 存在 ≠ 激活：`resolve()` 拿到的是条目配置，导入失败/`apply` 抛异常时它照样返回。
  assertActive('launcher-owned desktop plugin', desktopEntry)
  assertActive('profile-local third-party plugin', thirdPartyEntry)
  // 组合树里**任何**已启用行都不该是 FAILED。这条覆盖面比上面两条大得多：
  // 我方 18 个 `desktop-*`/`picoaide-*`/`pico-*` 行不在上游的
  // requiredStartupEntryIds 里（上游只 warn、启动照常成功），而这套冒烟里
  // 没有该表，所以此前"某行 apply 抛异常"是完全不可见的。
  const failed = [...ctx.loader.entries()]
    .filter(entry => entry.fiber?.state === FIBER_FAILED)
    .map(entry => entry.options.id)
  if (failed.length > 0) {
    throw new Error(`enabled Loader rows failed to apply: ${failed.join(', ')}`)
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
