#!/usr/bin/env node
/**
 * One-command upstream pin upgrade for the DSH Desktop workspace.
 *
 * Replaces the manual rc.x dance: fetch tag -> checkout submodule -> rewrite
 * upstream.json -> bump every @deepseek-ai/dsh* dependency family -> migrate
 * desktop patch keys -> reinstall -> repair loop (missing type deps, missing
 * runtime peers, stale patches) -> full gate.
 *
 * Usage:
 *   node scripts/upgrade-upstream.mjs [--to <tag|commit>] [--dry-run]
 *
 * Default target: the newest remote `dsh-v0.1.0-rc.*` tag. With `--to`, the
 * given tag (or commit) is used; it must exist in the upstream remote.
 *
 * Exit codes: 0 upgraded/up-to-date, 1 error, 2 target already current.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstreamDir = join(root, 'deepseek-harness')
const args = process.argv.slice(2)
const toFlag = args.includes('--to') ? args[args.indexOf('--to') + 1] : undefined
const dryRun = args.includes('--dry-run')

const run = (command, args_, cwd = root) => execFileSync(command, args_, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const fail = message => { throw new Error(message) }
const log = message => process.stdout.write(`[upgrade] ${message}\n`)

/** Read a JSON manifest. */
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))

/** Writable yarn cache home? The sandbox keeps ~/.yarn/berry read-only. */
function yarnEnv() {
  const probe = join(homedir(), '.yarn', 'berry', 'cache', `.probe-${process.pid}`)
  try {
    writeFileSync(probe, 'ok')
    renameSync(probe, probe + '.done')
    return {}
  } catch {
    const home = join(root, '.yarn-home')
    return { HOME: home }
  }
}

/** Workspace package names (root workspaces plus the root itself). */
function workspaceNames(workspace) {
  return [
    ...(workspace.workspaces ?? []).map(p => readJson(`${p}/package.json`).name),
    workspace.name,
  ].filter(Boolean)
}

/**
 * Expand a workspace glob with single `*` segments into concrete package
 * dirs (only simple star segments; no `**` or character classes).
 */
function expandWorkspacePattern(pattern) {
  if (!pattern.includes('*')) return [pattern]
  const segments = pattern.split('/')
  const seeds = ['']
  for (const segment of segments) {
    const next = []
    for (const seed of seeds) {
      if (segment === '*') {
        const base = resolve(root, seed || '.')
        if (!existsSync(base)) continue
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(seed ? `${seed}/${entry.name}` : entry.name)
        }
      } else {
        next.push(seed ? `${seed}/${segment}` : segment)
      }
    }
    seeds.splice(0, seeds.length, ...next)
  }
  return seeds.filter(Boolean)
}

/** Collect every manifest under the root workspaces (skip node_modules etc). */
function manifests(workspace) {
  const paths = ['package.json', ...(workspace.workspaces ?? []).flatMap(expandWorkspacePattern).map(p => `${p}/package.json`)]
  return paths.filter(p => existsSync(resolve(root, p))).map(p => ({ path: p, json: readJson(p) }))
}

/** Bump one dependency family value (`0.1.0-rc.N` / `^0.1.0-rc.N`). */
function bumpRange(range, from, to) {
  if (typeof range !== 'string') return range
  return range.replace(new RegExp(`(\\^?)${from.replace(/\./g, '\\.')}$`), `$1${to}`)
}

/** Rewrite one manifest's @deepseek-ai/dsh* family fields. Returns changed count. */
function bumpManifest(manifest, from, to) {
  let changed = 0
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions']) {
    const deps = manifest.json[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, range] of Object.entries(deps)) {
      let next = bumpRange(range, from, to)
      // Patch resolutions embed the version twice: the URL-encoded npm
      // descriptor and the patch file name (`dsh-x@VERSION.patch`).
      if (field === 'resolutions' && typeof range === 'string' && name.startsWith('@deepseek-ai/dsh-')) {
        const patched = range
          .replaceAll(`npm%3A${from}`, `npm%3A${to}`)
          .replaceAll(`@${from}.patch`, `@${to}.patch`)
        if (patched !== range) next = patched
      }
      if (next !== range) { deps[name] = next; changed += 1 }
      // Patch resolutions carry the version in the key too (`@npm:V`,
      // possibly caret-prefixed, e.g. `@npm:^0.1.0-rc.8`).
      if (field === 'resolutions' && name.includes(`@npm:${from}`)) {
        const nextKey = name
          .replace(`@npm:^${from}`, `@npm:^${to}`)
          .replace(`@npm:${from}`, `@npm:${to}`)
        if (nextKey !== name) {
          deps[nextKey] = deps[name]
          delete deps[name]
          changed += 1
        }
      }
    }
  }
  return changed
}

/** Migrate a versioned patch file (old name -> new name) in place. */
function migratePatchFiles(from, to) {
  const dir = join(root, 'patches')
  if (!existsSync(dir)) return []
  const moved = []
  for (const file of readdirSync(dir)) {
    if (file.includes(`@0.1.0-rc.${from.split('-rc.')[1]}`) || file.includes(`@${from}`)) {
      const next = file.replace(`@${from}`, `@${to}`)
      if (next !== file && !existsSync(join(dir, next))) {
        if (!dryRun) renameSync(join(dir, file), join(dir, next))
        moved.push(`${file} -> ${next}`)
      }
    }
  }
  return moved
}

/** Run a command, returning { status, stdout } without throwing. */
function spawn(cmd, cwd = root, env = {}) {
  try {
    // Use a plain (non-login) shell: a login shell re-derives PATH from the
    // profile, which drops the nvm bin dir once HOME is overridden by
    // yarnEnv(). Inheriting process.env.PATH keeps corepack/yarn resolvable.
    const out = execFileSync('bash', ['-c', cmd], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    })
    return { status: 0, out }
  } catch (e) {
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * Re-extract the platform module table from the checked-out upstream and
 * rewrite scripts/platform-modules.mjs if it drifted. Returns whether the
 * file changed.
 */
function syncPlatformModules() {
  const src = join(upstreamDir, 'packages/client/web/src/platform.ts')
  const source = readFileSync(src, 'utf8')
  const table = source.match(/export const PLATFORM_MODULES = \[([\s\S]*?)\] as const/)
  const preload = source.match(/export const PRELOADED_CLIENT_EXTERNALS = \[([\s\S]*?)\] as const/)
  if (!table || !preload) fail(`cannot parse ${src}: PLATFORM_MODULES/PRELOADED_CLIENT_EXTERNALS not found`)
  const fmt = (body) => body.split('\n')
    .map(l => l.trim())
    .filter(l => /^'[^']*',$/u.test(l))
    .map(l => `  ${l}`)
    .join('\n')
  const generated = `/**
 * Single source of truth for the upstream platform module table.
 *
 * Mirrors \`PLATFORM_MODULES\` / \`PRELOADED_CLIENT_EXTERNALS\` from the pinned
 * upstream checkout (\`deepseek-harness/packages/client/web/src/platform.ts\`).
 * Every desktop-owned client bundle keeps these specifiers external (the
 * shell's frozen module table resolves them at runtime), so the table must
 * never drift from upstream: \`scripts/upgrade-upstream.mjs\` re-extracts this
 * file from the new pin on every upgrade and fails the gate if it differs.
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
${fmt(table[1])}
]

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
${fmt(preload[1])}
]
`
  const target = join(root, 'scripts/platform-modules.mjs')
  if (readFileSync(target, 'utf8') !== generated) {
    writeFileSync(target, generated)
    return true
  }
  return false
}

async function main() {
  const upstream = readJson('upstream.json')
  const workspace = readJson('package.json')
  const from = upstream.runtimePackageVersion
  log(`current pin: ${upstream.commit.slice(0, 12)} (${from})`)

  // 1. Determine target.
  let targetTag = toFlag
  if (!targetTag) {
    const tags = run('git', ['-C', upstreamDir, 'ls-remote', '--tags', 'origin']).split('\n')
      .map(line => line.split('\t')[1]?.replace('refs/tags/', ''))
      .filter(t => t?.startsWith('dsh-v0.1.0-rc.'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    targetTag = tags[0]
    if (!targetTag) fail('no upstream dsh-v0.1.0-rc.* tag found; pass --to <tag>')
  }
  log(`target: ${targetTag}`)

  // 2. Fetch and validate.
  if (!dryRun) run('git', ['-C', upstreamDir, 'fetch', 'origin', '--tags'])
  const targetCommit = run('git', ['-C', upstreamDir, 'rev-parse', `${targetTag}^{commit}`])
  if (targetCommit === upstream.commit) {
    log(`already at ${targetTag} (${targetCommit.slice(0, 12)}); nothing to do`)
    process.exit(2)
  }
  const to = targetTag.replace(/^dsh-v/, '')
  const remoteUrl = run('git', ['-C', upstreamDir, 'remote', 'get-url', 'origin'])
  if (remoteUrl !== upstream.repository) fail(`upstream origin ${remoteUrl} != upstream.json ${upstream.repository}`)
  log(`upgrade ${from} -> ${to} (${targetCommit.slice(0, 12)})`)

  // 3. Checkout + record.
  if (!dryRun) {
    run('git', ['-C', upstreamDir, 'checkout', '--detach', targetTag])
    writeFileSync(join(root, 'upstream.json'), JSON.stringify({
      repository: upstream.repository,
      commit: targetCommit,
      sourceVersion: to,
      runtimePackageVersion: to,
    }, null, 2) + '\n')
    log('upstream.json updated, submodule checked out')
  }

  // 3b. Re-extract the platform module table (client externals single source).
  if (!dryRun && syncPlatformModules()) {
    log('scripts/platform-modules.mjs re-extracted from the new pin')
  }

  // 4. Bump manifests.
  const changed = []
  for (const m of manifests(workspace)) {
    const n = bumpManifest(m, from, to)
    if (n > 0 && !dryRun) writeFileSync(join(root, m.path), JSON.stringify(m.json, null, 2) + '\n')
    if (n > 0) changed.push(`${m.path} (${n} ranges)`)
  }
  const moved = migratePatchFiles(from, to)
  if (changed.length) log(`bumped: ${changed.join(', ')}`)
  if (moved.length) log(`patch files migrated: ${moved.join(', ')}`)
  if (dryRun) { log('dry-run: no changes written'); return }

  // 5. Install (with writable-cache HOME fallback).
  const env = yarnEnv()
  log('yarn install…')
  let r = spawn('corepack yarn install', root, env)
  if (r.status !== 0) { process.stdout.write(r.out); fail('yarn install failed') }

  // 6. Repair loop.
  const maxRounds = 6
  for (let round = 1; round <= maxRounds; round += 1) {
    log(`gate round ${round}/${maxRounds}…`)
    r = spawn('corepack yarn check', root, env)
    if (r.status === 0) { log('full gate passed'); return }
    process.stdout.write(r.out.slice(-4000))

    // 6a. TS2307 missing @deepseek-ai modules — locate the failing workspace
    // by running its typecheck in isolation, then add missing devDeps.
    const missing = new Set()
    const missingOwner = new Map()
    for (const name of workspaceNames(workspace)) {
      const t = spawn(`corepack yarn workspace ${JSON.stringify(name)} typecheck`, root, env)
      const mods = [...t.out.matchAll(/Cannot find module '@deepseek-ai\/([^']+)'/g)].map(m => m[1])
      for (const mod of mods) { missing.add(mod); missingOwner.set(mod, name) }
    }
    if (missing.size) {
      log(`adding missing type deps: ${[...missing].join(', ')}`)
      for (const mod of missing) {
        const owner = missingOwner.get(mod)
        const m = manifests(workspace).find(x => x.json.name === owner)
        if (!m) continue
        m.json.devDependencies ??= {}
        m.json.devDependencies[`@deepseek-ai/${mod}`] = to
        writeFileSync(join(root, m.path), JSON.stringify(m.json, null, 2) + '\n')
      }
      spawn('corepack yarn install', root, env)
      continue
    }

    // 6b. verify-runtime-closure missing first-party peers.
    const peers = [...r.out.matchAll(/required first-party peers are missing from (\S+):\s*([\s\S]*?)(?=\n\n|$)/g)]
    if (peers.length) {
      for (const [, pkg, block] of peers) {
        const need = new Set([...block.matchAll(/-> @deepseek-ai\/([a-z0-9-]+)/g)].map(m => m[1]))
        log(`adding runtime peers for ${pkg}: ${[...need].join(', ')}`)
        const m = manifests(workspace).find(x => x.json.name === pkg)
        if (!m) continue
        m.json.dependencies ??= {}
        for (const mod of need) m.json.dependencies[`@deepseek-ai/${mod}`] = to
        writeFileSync(join(root, m.path), JSON.stringify(m.json, null, 2) + '\n')
      }
      spawn('corepack yarn install', root, env)
      continue
    }

    // 6c. Patch application failures — cannot auto-fix reliably.
    const patchFail = [...r.out.matchAll(/Cannot apply hunk[^\n]*|patch[^\n]*failed[^\n]*/gi)].map(m => m[0])
    if (patchFail.length) {
      fail(`patch hunk failures need manual re-recording:\n${patchFail.join('\n')}\n` +
        'Re-record: yarn patch <pkg>@<version>, apply the intent manually, then regenerate the patch file.')
    }
    fail(`gate failed in an unhandled way (round ${round}); inspect the log above`)
  }
  fail(`gate did not pass within ${maxRounds} repair rounds`)
}

main().catch(e => { process.stderr.write(`[upgrade] ${e.message}\n`); process.exit(1) })
