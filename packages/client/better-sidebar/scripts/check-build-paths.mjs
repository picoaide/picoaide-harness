#!/usr/bin/env node
/**
 * Build-output portability guard (audit 2026-09-08 P3).
 *
 * The shipped client bundles must never embed the build machine's absolute
 * checkout path. rolldown emits `//#region <module id>` comments, so a virtual
 * CSS module id built from an absolute filename leaked
 * `\0dsh-css:/data/picoaide-harness/...` into `lib/client.js` of the published
 * package. This script fails the package gate when any built JS/map file
 * contains an absolute path to the repository root.
 *
 * Run AFTER `build` (the check reads lib/).
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '..', '..', '..')
const LIB = join(PACKAGE_ROOT, 'lib')

const needles = [REPOSITORY_ROOT, REPOSITORY_ROOT.replaceAll('\\', '/'), REPOSITORY_ROOT.replaceAll('/', '\\')]

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collect(path, out)
    else if (/\.(?:js|mjs|cjs|map)$/u.test(entry.name)) out.push(path)
  }
  return out
}

const files = await collect(LIB).catch(() => [])
if (files.length === 0) {
  console.error('[check-build-paths] FAIL: no built JS under lib/ — run the build first.')
  process.exit(1)
}

const offenders = []
for (const file of files) {
  const text = await readFile(file, 'utf8')
  for (const needle of needles) {
    if (needle !== '' && text.includes(needle)) {
      offenders.push(`${relative(PACKAGE_ROOT, file)} contains ${needle}`)
      break
    }
  }
}

if (offenders.length > 0) {
  console.error('[check-build-paths] FAIL: build machine paths leaked into the package:')
  for (const line of offenders) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`[check-build-paths] OK: ${files.length} built file(s) carry no build-machine absolute path.`)
