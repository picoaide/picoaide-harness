#!/usr/bin/env node
/**
 * Reproduce the packaged-ASAR filesystem gate (issue #130) against a real package,
 * optionally with a *different* Electron binary.
 *
 * The afterPack gate (`smokePackagedAsarBigintSemantics`) always uses the
 * launcher of the package it inspects, which is the right thing for a gate but
 * useless for proving the gate can fail: to show the tooth you must be able to
 * run the very same assertions against a package that cannot do the work. This
 * probe injects the launcher seam to do exactly that.
 *
 * ```
 * # the shipped package, with its own Electron (expected: OK)
 * node scripts/asar-bigint-probe.mjs
 *
 * # the same assertions under an older engine (43.4.0 used to fail here; with
 * # patches/dsh-fs-local in place it now passes, because the patch normalizes the
 * # Number Stats that shim returns — the tooth today is an *unpatched* package,
 * # e.g. build one from a tree with the resolution removed)
 * node scripts/asar-bigint-probe.mjs --engine /path/to/older/electron
 * ```
 *
 * v2.8.0 shipped Electron 43.4.0, whose app.asar fs shim ignores
 * `{ bigint: true }` and synthesizes a Number `Stats`; `@deepseek-ai/dsh-fs-local`
 * then threw `Cannot mix BigInt and other types` on every asar path, the whole
 * filesystem skill provider was skipped, and cordis sessions lost every
 * filesystem skill. Two independent things hold that capability today: the
 * engine's shim (Electron >= 44.4.3 answers with BigIntStats; the pinned 44.0.0
 * does not) and `patches/dsh-fs-local@0.2.0-rc.2.patch`, which accepts either
 * shape. The gate judges the capability, not the engine's shape.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { smokePackagedAsarBigintSemantics } from './verify-packaged-runtime.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

const appOutDir = option('--app-out', join(here, '..', 'dist', 'linux-unpacked'))
const engine = option('--engine', undefined)
const asarPath = join(appOutDir, 'resources', 'app.asar')
if (!existsSync(asarPath)) {
  console.error(`asar-bigint-probe: no app.asar at ${asarPath} — build one first (node scripts/package-dir.mjs)`)
  process.exit(2)
}

const context = {
  appOutDir,
  electronPlatformName: 'linux',
  arch: 1,
  packager: {
    appInfo: { productFilename: 'PicoAide Harness' },
    executableName: 'dsh-plugin-desktop',
  },
}

const launch = engine === undefined
  ? undefined
  : (executable, argv, env) => {
    const result = spawnSync(engine, [...argv], { env, encoding: 'utf8' })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error === undefined ? {} : { error: { code: result.error.code, message: result.error.message } }),
    }
  }

console.log(`asar-bigint-probe: ${appOutDir}`)
console.log(`asar-bigint-probe: engine = ${engine ?? '(the packaged launcher)'}`)
try {
  smokePackagedAsarBigintSemantics(context, launch)
  console.log('asar-bigint-probe: OK — the packaged client stat/lists/reads the preset skills through app.asar')
} catch (error) {
  console.error(`asar-bigint-probe: FAILED\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
