/** Headless artifact smoke for the Electron-backed dsh and pnpm command entries. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const packageRoot = new URL('../', import.meta.url)
const desktopCli = fileURLToPath(new URL('lib/desktop-cli.js', packageRoot))
const pnpmCli = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
const dshVersion = JSON.parse(readFileSync(new URL('node_modules/@deepseek-ai/dsh/package.json', packageRoot), 'utf8')).version
const pnpmVersion = JSON.parse(readFileSync(new URL('node_modules/pnpm/package.json', packageRoot), 'utf8')).version

function run(label, nodeArgs, entry, expectedVersion) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  const result = spawnSync(electronPath, [...nodeArgs, entry, '--version'], {
    encoding: 'utf8',
    env,
    shell: false,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} artifact smoke exited ${String(result.status)}: ${result.stderr.trim()}`)
  }
  if (result.stdout.trim() !== expectedVersion) {
    throw new Error(`${label} artifact smoke returned ${JSON.stringify(result.stdout.trim())} instead of ${JSON.stringify(expectedVersion)}`)
  }
}

run('dsh', ['--expose-internals'], desktopCli, dshVersion)
run('pnpm', [], pnpmCli, pnpmVersion)
