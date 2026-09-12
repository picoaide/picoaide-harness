#!/usr/bin/env node
/**
 * One-command upstream pin upgrade for the PicoAide Harness workspace.
 *
 * Replaces the manual rc.x dance: fetch tag -> checkout submodule -> rewrite
 * upstream.json -> bump every @deepseek-ai/dsh* dependency family -> migrate
 * desktop patch keys -> reinstall -> repair loop (missing type deps, missing
 * runtime peers, stale patches) -> full gate.
 *
 * Usage:
 *   node scripts/upgrade-upstream.mjs [--to <tag|commit>] [--dry-run]
 *
 * Default target: the newest remote tag on the **current subscription's**
 * version line (`0.1.5-rc.2` → `dsh-v0.1.*`, semver-ordered). With `--to`, the
 * given tag (or commit) is used; it must exist in the upstream remote.
 *
 * Exit codes: 0 upgraded/up-to-date, 1 error, 2 target already current.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstreamDir = join(root, 'deepseek-harness')
const args = process.argv.slice(2)
const toFlag = args.includes('--to') ? args[args.indexOf('--to') + 1] : undefined
const dryRun = args.includes('--dry-run')

/**
 * 升级后需要**人工逐条核对**的清单(无法低成本自动化的那几处 —— P2-9/P2-10)。
 *
 * 已自动化的部分不必再看:
 *   - `scripts/platform-modules.mjs`:本脚本第 3b 步自动从新 pin 重抽,
 *     且 `scripts/verify-inventories.mjs` 与 submodule 逐字对拍;
 *   - CI `workspace-build` 归档清单 / `prebuild-workspace-deps.ts` 包表 /
 *     `check-workspaces.mjs` 包表:`scripts/verify-inventories.mjs` 互相对拍;
 *   - `patches/*.patch` ↔ resolutions 键:`verify-patch-resolutions.mjs` /
 *     `verify-patches.mjs`(仓库外 pristine dry-run + 结果逐字节对拍)。
 */
const MANUAL_INVENTORY_CHECKLIST = [
  [
    'packages/host/desktop/scripts/mac-runtime.ts',
    'MACOS_ARM64_NATIVE_ENTRIES:上游原生包改名/升版本(sharp、libvips、koffi、ripgrep、node-addon-*)时逐条核对路径',
  ],
  [
    'packages/host/desktop/scripts/verify-packaged-runtime.ts',
    'REQUIRED_PACKAGED_RUNTIME_ENTRIES / REQUIRED_UNPACKED_RUNTIME_ENTRIES:打包态必需文件,路径必须与真实产物逐条对齐',
  ],
  [
    'packages/host/desktop/tests/package.spec.ts',
    'asarUnpack glob 必须匹配已安装的原生包家族(改名后旧 glob 会静默失配)',
  ],
  [
    'packages/host/desktop/THIRD_PARTY_NOTICES.md',
    '第三方通告清单:重生成后跑 `yarn workspace dsh-plugin-desktop verify:notices` 比对',
  ],
  [
    'docs/decisions/<date>-dsh-<version>-upgrade.md',
    '升级决策文档:patch 语义、必需清单、打包改名等结论需要人眼确认(不在自动门禁范围)',
  ],
]

/** 打印人工核对清单(自动门禁覆盖不到的部分)。 */
function printManualChecklist() {
  for (const [path, why] of MANUAL_INVENTORY_CHECKLIST) log(`  人工核对: ${path} — ${why}`)
}

/**
 * 从当前订阅版本推导 tag 版本线前缀:`0.1.5-rc.2` → `dsh-v0.1.`。
 *
 * 旧实现硬写 `dsh-v0.1.0-rc.` —— 订阅走到 0.1.2 之后这个前缀永远命中 0 个 tag,
 * 不传 `--to` 就直接失败(P2-10)。现在从**当前订阅**推导,订阅换代自动跟随。
 * @param version - `upstream.json` 的 runtimePackageVersion。
 * @returns tag 前缀;版本形状不认识时返回 undefined(调用方要求显式 --to)。
 */
function tagFamilyPrefix(version) {
  const match = /^(\d+)\.(\d+)\./u.exec(version)
  return match === null ? undefined : `dsh-v${match[1]}.${match[2]}.`
}

/**
 * 比较两个 `dsh-v…` tag 的版本序(数字段逐段比较,正式版 > 预发布版,
 * 预发布段按点分数字比较,避免 `-rc.10` 被 `-rc.2` 压过)。
 * @param a - tag A。
 * @param b - tag B。
 * @returns 负数/0/正数。
 */
function compareDshTags(a, b) {
  const split = (tag) => {
    const body = tag.replace(/^dsh-v/u, '')
    const dash = body.indexOf('-')
    return dash === -1
      ? { core: body, pre: '' }
      : { core: body.slice(0, dash), pre: body.slice(dash + 1) }
  }
  const parsedA = split(a)
  const parsedB = split(b)
  const coreA = parsedA.core.split('.').map(Number)
  const coreB = parsedB.core.split('.').map(Number)
  for (let index = 0; index < Math.max(coreA.length, coreB.length); index += 1) {
    const diff = (coreA[index] ?? 0) - (coreB[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (parsedA.pre === parsedB.pre) return 0
  if (parsedA.pre === '') return 1
  if (parsedB.pre === '') return -1
  const preA = parsedA.pre.split('.')
  const preB = parsedB.pre.split('.')
  for (let index = 0; index < Math.max(preA.length, preB.length); index += 1) {
    const left = preA[index]
    const right = preB[index]
    if (left === right) continue
    if (left === undefined) return -1
    if (right === undefined) return 1
    const numericLeft = Number(left)
    const numericRight = Number(right)
    const diff = Number.isNaN(numericLeft) || Number.isNaN(numericRight)
      ? left.localeCompare(right)
      : numericLeft - numericRight
    if (diff !== 0) return diff
  }
  return 0
}

/** 列出 upstream remote 的全部 tag(去重、去掉 peeled `^{}` 形态)。 */
function remoteTags() {
  const tags = run('git', ['-C', upstreamDir, 'ls-remote', '--tags', 'origin']).split('\n')
    .map(line => line.split('\t')[1]?.replace('refs/tags/', '').replace(/\^\{\}$/u, ''))
    .filter(tag => typeof tag === 'string' && tag !== '')
  return [...new Set(tags)]
}

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

/** Escape every regular-expression metacharacter (审计 2026-08-30 CodeQL
 * js/incomplete-sanitization: 原实现只转义了 '.', 反斜杠/加号等元字符
 * 仍可注入正则并导致错误替换或 ReDoS)。 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Bump one dependency family value (`0.1.0-rc.N` / `^0.1.0-rc.N`). */
function bumpRange(range, from, to) {
  if (typeof range !== 'string') return range
  return range.replace(new RegExp(`(\\^?)${escapeRegExp(from)}$`), `$1${to}`)
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
      // Patch resolutions carry the version in the key too (`@npm:V`, possibly
      // caret-prefixed, e.g. `@npm:^0.1.0-rc.8`). Both forms must be renamed:
      // the exact key covers our own pinned dependencies, the caret key covers
      // the `^V` ranges upstream packages publish for their own dependencies —
      // a caret key left behind silently stops patching transitive copies.
      if (field === 'resolutions') {
        const caretFrom = `@npm:^${from}`
        const exactFrom = `@npm:${from}`
        if (name.includes(caretFrom) || name.includes(exactFrom)) {
          const nextKey = name
            .replace(caretFrom, `@npm:^${to}`)
            .replace(exactFrom, `@npm:${to}`)
          if (nextKey !== name) {
            deps[nextKey] = deps[name]
            delete deps[name]
            changed += 1
          }
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
  // The upstream table packs several entries on one line ('react',
  // 'react/jsx-runtime', ...), so collect every string literal in the
  // array body instead of filtering single-entry lines.
  const fmt = (body) => (body.match(/'[^']+'/gu) ?? [])
    .map(entry => `  ${entry},`)
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
  log('升级会自动重抽 platform-modules 并跑完整门禁;以下清单必须人工核对:')
  printManualChecklist()

  // 1. Determine target.
  let targetTag = toFlag
  if (!targetTag) {
    const prefix = tagFamilyPrefix(from)
    const tags = remoteTags().sort((a, b) => compareDshTags(b, a))
    const candidates = prefix === undefined ? [] : tags.filter(tag => tag.startsWith(prefix))
    if (candidates.length === 0) {
      fail(
        `当前订阅 ${from} 的版本线(前缀 ${prefix ?? '无法从版本号推导'})上没有找到 tag;`
        + `请显式传 --to <tag>。近期 tag:${tags.slice(0, 8).join(', ') || '(remote 上没有 tag)'}`,
      )
    }
    targetTag = candidates[0]
    log(`版本线 ${prefix}* 上最近的 tag:${candidates.slice(0, 3).join(', ')}`)
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
    if (r.status === 0) {
      log('full gate passed')
      log('自动门禁已通过,但**以下清单仍需人工核对**(升级收尾必须逐条过一遍):')
      printManualChecklist()
      return
    }
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
