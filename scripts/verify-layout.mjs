import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const fail = message => { throw new Error(`verify-layout: ${message}`) }

const workspace = readJson('package.json')
const upstream = readJson('upstream.json')
const plugin = readJson('packages/host/desktop/package.json')
const enterprise = readJson('packages/host/enterprise/package.json')
const connectors = readJson('packages/host/connectors/package.json')
const browser = readJson('packages/host/browser/package.json')
const fabric = readJson('community/fabric/package.json')
const upstreamPackage = readJson('deepseek-harness/package.json')
const noteDirectory = '.agents/notes/implemented/process'
const noteName = '2026-08-15-pinned-upstream-and-isolated-yarn-workspace'
const notePaths = [`${noteDirectory}/${noteName}.md`, `${noteDirectory}/${noteName}.zh.md`]
const noteRecordPath = `${noteDirectory}/${noteName}.i18n.yaml`

if (workspace.packageManager !== 'yarn@4.18.0') {
  fail('the product workspace must pin yarn@4.18.0')
}

// Workspace topology is self-describing: the root workspaces list is the
// single source of truth. Every member must exist, be a valid package, and
// carry a name whose final segment matches its directory basename (this
// admits both flat members like `dsh-community-fabric` and scoped members
// like `plugins/dsh-enterprise` -> `@picoaide/dsh-enterprise`). The glob
// patterns `packages/*/*` and `community/*` enumerate the same members that
// the workspace glob yields, so the manifest check stays directory-driven.
if (!Array.isArray(workspace.workspaces) || workspace.workspaces.length === 0) {
  fail('the root Yarn workspace must declare a non-empty workspaces list')
}
const packageGlob = 'packages/*/*'
const communityGlob = 'community/*'
if (!workspace.workspaces.includes(packageGlob) || !workspace.workspaces.includes(communityGlob)) {
  fail('the root Yarn workspace must declare both packages/*/* and community/*')
}
// Package naming keeps the published npm name stable while the workspace
// directory is organized by role. This directory-to-name table is the single
// authoritative mapping: every workspace member directory must appear here
// with exactly the package name it owns. Member directories are allowed to
// drop the `dsh-` prefix or rename the role segment (e.g. `desktop` owns
// `dsh-plugin-desktop`), so the old "name tail equals directory basename"
// check is replaced by table membership.
const packageNameTable = new Map([
  ['packages/host/desktop', 'dsh-plugin-desktop'],
  ['packages/host/enterprise', '@picoaide/dsh-enterprise'],
  ['packages/host/connectors', '@picoaide/dsh-connectors'],
  ['packages/host/browser', '@picoaide/dsh-browser'],
  ['packages/host/cron', '@picoaide/dsh-cron'],
  ['packages/host/task', '@picoaide/dsh-task'],
  ['packages/client/account-card', '@picoaide/dsh-account-card'],
  ['packages/client/branding', '@picoaide/dsh-branding'],
  ['packages/client/better-sidebar', 'dsh-better-sidebar'],
  ['packages/vendor/memory-evolve', 'dsh-memory-evolve'],
  ['community/fabric', 'dsh-community-fabric'],
])
const nameForPath = dir => packageNameTable.get(dir)
const workspaceDirs = []
const workspaceManifests = new Map()
const collectWorkspaceMembers = (tree, depth, prefix = '') => {
  const scanRoot = resolve(root, prefix || tree)
  if (!existsSync(scanRoot)) fail(`workspace glob root ${tree} is missing`)
  let names
  try {
    names = readdirSync(scanRoot)
  } catch {
    fail(`workspace glob root ${tree} is unreadable`)
  }
  for (const name of names) {
    const dir = prefix ? `${prefix}/${name}` : `${tree}/${name}`
    const full = resolve(root, dir)
    if (!lstatSync(full).isDirectory()) continue
    if (depth === 1) {
      if (existsSync(resolve(full, 'package.json'))) {
        const manifest = readJson(`${dir}/package.json`)
        const expected = nameForPath(dir)
        if (expected !== manifest.name) {
          fail(`workspace member ${dir} must own ${expected ?? '<declared in packageNameTable>'} (got ${manifest.name ?? 'missing'})`)
        }
        workspaceManifests.set(manifest.name, manifest)
        workspaceDirs.push(dir)
      } else {
        collectWorkspaceMembers(tree, 2, dir)
      }
    } else {
      const manifestPath = resolve(root, dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readJson(`${dir}/package.json`)
      const expected = nameForPath(dir)
      if (expected !== manifest.name) {
        fail(`workspace member ${dir} must own ${expected ?? '<declared in packageNameTable>'} (got ${manifest.name ?? 'missing'})`)
      }
      workspaceManifests.set(manifest.name, manifest)
      workspaceDirs.push(dir)
    }
  }
}
collectWorkspaceMembers('packages', 1)
collectWorkspaceMembers('community', 1)
if (workspaceDirs.length === 0) {
  fail('the workspace tree must contain at least one package')
}
for (const [name, manifest] of workspaceManifests) {
  if (manifest.packageManager !== undefined) fail(`${name} must inherit the root Yarn release`)
}
const claudePath = resolve(root, 'CLAUDE.md')
const claudeStat = lstatSync(claudePath)
// Windows checkouts materialize the symlink as a regular file holding the
// target name; accept both forms so the pointer stays verified on every host.
const claudeTarget = claudeStat.isSymbolicLink()
  ? readlinkSync(claudePath)
  : readFileSync(claudePath, 'utf8').trim()
if (claudeTarget !== 'AGENTS.md') {
  fail('CLAUDE.md must link to the outer repository AGENTS.md')
}
for (const legacyFile of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/host/desktop/pnpm-lock.yaml',
  'packages/host/desktop/pnpm-workspace.yaml',
  'community/fabric/pnpm-lock.yaml',
  'community/fabric/pnpm-workspace.yaml',
]) {
  if (existsSync(resolve(root, legacyFile))) fail(`${legacyFile} must not exist`)
}
if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.deepseek-harness.path']) !== 'deepseek-harness') {
  fail('the upstream submodule path must be deepseek-harness')
}
if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.deepseek-harness.url']) !== upstream.repository) {
  fail('the upstream submodule URL differs from upstream.json')
}
if (typeof upstreamPackage.packageManager !== 'string' || !upstreamPackage.packageManager.startsWith('pnpm@')) {
  fail('the upstream checkout must retain its pnpm package manager')
}

for (const [owner, manifest] of [
  ['root', workspace],
  ['desktop', plugin],
  ['enterprise', enterprise],
  ['connectors', connectors],
  ['browser', browser],
  ['fabric', fabric],
]) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range !== 'string') continue
      if (/^(?:portal|link):/u.test(range)
        || (range.startsWith('file:') && range.includes('deepseek-harness'))) {
        fail(`${owner} ${field}.${name} bypasses the published DSH package boundary`)
      }
    }
  }
}

const [mode, object] = run('git', ['ls-files', '--stage', '--', 'deepseek-harness']).split(/\s+/u)
if (mode !== '160000') fail('deepseek-harness must be tracked as a Git submodule')
if (object !== upstream.commit) fail(`submodule index is ${object}, expected ${upstream.commit}`)

const upstreamDir = resolve(root, 'deepseek-harness')
if (run('git', ['rev-parse', 'HEAD'], upstreamDir) !== upstream.commit) {
  fail('checked-out upstream commit differs from upstream.json')
}
if (run('git', ['status', '--porcelain'], upstreamDir) !== '') {
  fail('deepseek-harness contains local changes')
}
if (run('git', ['remote', 'get-url', 'origin'], upstreamDir) !== upstream.repository) {
  fail('deepseek-harness origin differs from upstream.json')
}
if (upstreamPackage.version !== upstream.sourceVersion) {
  fail('deepseek-harness package version differs from upstream.json')
}
for (const [owner, manifest] of [['plugin', plugin], ['enterprise', enterprise], ['connectors', connectors], ['browser', browser]]) {
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) }
  for (const name of Object.keys(deps).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) {
    if (deps[name] !== upstream.runtimePackageVersion) {
      fail(`${owner} ${name} must use the recorded DSH runtime package family`)
    }
  }
}

const noteRecord = readFileSync(resolve(root, noteRecordPath), 'utf8')
for (const notePath of notePaths) {
  // Hash the committed blob, not the working tree: checkout line endings
  // differ per host, while HEAD:<path> is identical everywhere.
  const expected = run('git', ['rev-parse', `HEAD:${notePath}`])
  const recordLine = `${basename(notePath)}: ${expected}`
  if (!noteRecord.split(/\r?\n/u).includes(recordLine)) {
    fail(`${noteRecordPath} is stale for ${notePath}`)
  }
}

const readmeRecord = readFileSync(resolve(root, 'README.i18n.yaml'), 'utf8')
for (const readmeName of ['README.md', 'README.en.md']) {
  const expected = run('git', ['rev-parse', `HEAD:${readmeName}`])
  const recordLine = `${readmeName}: ${expected}`
  if (!readmeRecord.split(/\r?\n/u).includes(recordLine)) {
    fail(`README.i18n.yaml is stale for ${readmeName}`)
  }
}

process.stdout.write(`verify-layout: Yarn workspace and upstream ${upstream.commit.slice(0, 10)} are consistent\n`)
