#!/usr/bin/env node
/**
 * 根门禁编排器(2026-09-10):把 `yarn check` 从「10 个包串行 &&」改成
 * 「受依赖约束的两阶段并行」。
 *
 * 动因(实测 4 核):串行门禁 165s,其中大量时间只有一个包在跑,其余核空闲;
 * 且 desktop 的 lib/types 是 enterprise/account-card/branding 的 tsc 输入,
 * 必须先于它们产出——原来靠"在 check 链里排第一个"隐式保证,现在显式建模。
 *
 * 阶段划分:
 *   阶段 1  desktop check(= 产出全仓共用的 lib/types) ∥ 三个根守卫脚本
 *   阶段 2  其余 9 个 workspace 包 check,并发 4
 * 语义与串行版完全一致:跑的仍是每个包自己的 `check`(build+typecheck+test+verify),
 * 只是顺序与并发变了;CI 的 `yarn check` 用的是同一个入口。
 *
 * 用法:
 *   node scripts/check-workspaces.mjs                 # = yarn check
 *   node scripts/check-workspaces.mjs --changed       # 只跑本次改动影响的包(= yarn check:fast)
 *   node scripts/check-workspaces.mjs --changed origin/master
 *   node scripts/check-workspaces.mjs --only dsh-plugin-desktop,@picoaide/dsh-cron
 *   node scripts/check-workspaces.mjs --list          # 只打印将执行的任务
 * 环境变量:CHECK_CONCURRENCY 覆盖并发数(默认 min(4, CPU 数))。
 */

import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 根守卫脚本(与构建产物无关,可与阶段 1 并行)。 */
const GUARDS = [
  { name: 'check:layout', args: ['run', 'check:layout'], path: 'package.json / .agents/notes 布局' },
  { name: 'check:workflows', args: ['run', 'check:workflows'], path: '.github/workflows' },
  { name: 'check:ci-scripts', args: ['run', 'check:ci-scripts'], path: 'CI 脚本' },
  // 2026-09-12 二次审查的清单类不变量(P1-4/P1-6/P2-9):
  // 补丁 resolution 键成对完备、补丁在仓库外对 pristine tarball 干净应用、
  // platform-modules 与 CI 归档清单等手工清单互相对拍。
  { name: 'check:patch-resolutions', args: ['run', 'check:patch-resolutions'], path: 'resolutions ↔ patches/' },
  { name: 'check:patches', args: ['run', 'check:patches'], path: 'patches/*.patch 仓库外 dry-run' },
  { name: 'check:inventories', args: ['run', 'check:inventories'], path: '平台模块表 / CI 归档 / 包表' },
]

/**
 * workspace 包门禁。`needs` 表达"构建期真实依赖":依赖包的 tsdown 会先清空自己的
 * lib/(enterprise clean:true),并发读取其声明文件的包会在那个窗口里报
 * TS7016「Could not find a declaration file」——所以构建依赖必须串起来,不能
 * 只按"能不能同时跑"来排。
 *
 * 依赖来源(2026-09-10 用 git/grep 实测):
 *   enterprise / connectors / cron 的 tsc 读 desktop 的 lib/types;
 *   account-card 读 enterprise 的 lib/types;browser 读 connectors 的 lib/types;
 *   branding / community-fabric 无本地构建依赖。
 * desktop 之外的 devDeps 边(desktop → 六个插件包)是**运行时/profile 依赖**,
 * 由 verify:profile 内部的 prebuild 保证,不作为调度边——否则 desktop ↔ enterprise
 * 成环,且会让 desktop 的 profile 冒烟与那些包的构建互相踩。
 */
const PACKAGES = [
  { name: 'dsh-plugin-desktop', dir: 'packages/host/desktop', needs: [] },
  { name: '@picoaide/dsh-enterprise', dir: 'packages/host/enterprise', needs: ['dsh-plugin-desktop'] },
  { name: '@picoaide/dsh-connectors', dir: 'packages/host/connectors', needs: ['dsh-plugin-desktop'] },
  { name: '@picoaide/dsh-cron', dir: 'packages/host/cron', needs: ['dsh-plugin-desktop'] },
  { name: '@picoaide/dsh-branding', dir: 'packages/client/branding', needs: [] },
  { name: 'dsh-community-fabric', dir: 'community/fabric', needs: [] },
  { name: '@picoaide/dsh-account-card', dir: 'packages/client/account-card', needs: ['@picoaide/dsh-enterprise'] },
  { name: '@picoaide/dsh-browser', dir: 'packages/host/browser', needs: ['@picoaide/dsh-connectors'] },
]
// 注:packages/vendor/memory-evolve 有 test 脚本但不在原 `yarn check` 链里,
// 这里保持原样(不擅自扩大门禁范围),其测试缺口另行报告。

/** 路径前缀 → 包名(用于 --changed 的改动归属判定,最长前缀优先)。 */
const PATH_OWNERS = [
  ['packages/host/desktop/', 'dsh-plugin-desktop'],
  ['packages/host/enterprise/', '@picoaide/dsh-enterprise'],
  ['packages/client/account-card/', '@picoaide/dsh-account-card'],
  ['packages/client/branding/', '@picoaide/dsh-branding'],
  ['packages/host/connectors/', '@picoaide/dsh-connectors'],
  ['packages/host/browser/', '@picoaide/dsh-browser'],
  ['packages/host/cron/', '@picoaide/dsh-cron'],
  ['community/fabric/', 'dsh-community-fabric'],
]

/** 反向依赖:A 改动会波及 B(desktop 的类型/产物是这些包的输入)。 */
const DEPENDENTS = {
  'dsh-plugin-desktop': ['@picoaide/dsh-enterprise', '@picoaide/dsh-account-card', '@picoaide/dsh-branding'],
}

/** 影响全仓的顶层文件(改动即视为全量门禁)。 */
const GLOBAL_PREFIXES = [
  'package.json', 'yarn.lock', '.yarnrc.yml', 'patches/', 'scripts/', '.github/',
  'brands/', 'tsconfig', 'deepseek-harness', 'AGENTS.md', 'CLAUDE.md',
]

function parseArgs(argv) {
  const options = { changed: null, only: null, list: false, concurrency: null, guards: true, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--changed') {
      // 可选参数:下一个 token 不是 -- 开头就当 ref
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options.changed = next
        i += 1
      } else options.changed = 'HEAD'
    } else if (arg === '--only') {
      options.only = (argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
      i += 1
    } else if (arg === '--concurrency') {
      options.concurrency = Number(argv[i + 1])
      i += 1
    } else if (arg === '--list') options.list = true
    else if (arg === '--no-guards') options.guards = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error(`check-workspaces: 未知参数 ${arg}`)
      process.exitCode = 2
      return null
    }
  }
  return options
}

function git(args) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out))
  })
}

/** 本次工作区相对 `ref` 的改动文件列表(含未跟踪文件)。 */
async function changedFiles(ref) {
  const tracked = await git(['diff', '--name-only', ref])
  const untracked = await git(['ls-files', '--others', '--exclude-standard'])
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].map(s => s.trim()).filter(Boolean))]
}

/** 把改动文件映射为需要重跑的包 + 是否需要跑根守卫。 */
function selectByChanges(files) {
  const selected = new Set()
  let global = false
  for (const file of files) {
    const owner = PATH_OWNERS.find(([prefix]) => file.startsWith(prefix))
    if (owner !== undefined) {
      selected.add(owner[1])
      continue
    }
    if (GLOBAL_PREFIXES.some(prefix => file.startsWith(prefix))) global = true
  }
  if (global) {
    for (const pkg of PACKAGES) selected.add(pkg.name)
    return { selected: [...selected], global }
  }
  // 反向依赖:desktop 改动波及依赖其类型的包
  for (const name of [...selected]) {
    for (const dependent of DEPENDENTS[name] ?? []) selected.add(dependent)
  }
  return { selected: [...selected], global }
}

function runTask(task) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn('corepack', ['yarn', ...task.args], {
      cwd: task.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => {
      resolve({ task, ok: false, ms: Date.now() - started, output: `${output}\n${String(error)}` })
    })
    child.on('close', code => {
      resolve({ task, ok: code === 0, ms: Date.now() - started, output })
    })
  })
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

async function runPool(tasks, limit, state) {
  const queue = [...tasks]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const task = queue.shift()
      if (task === undefined) return
      const result = await runTask(task)
      state.results.push(result)
      if (!result.ok) state.failed.push(result)
      console.log(`${result.ok ? '✓' : '✗'} ${result.task.name.padEnd(28)} ${seconds(result.ms).padStart(8)}`)
    }
  })
  await Promise.all(workers)
}

/**
 * 依赖感知调度:一个包的 `needs` 全部通过后才启动;并发上限为 limit。
 * 依赖失败时,依赖它的包标记为 skipped(不跑)——它们的失败没有信息量
 * (构建产物缺失导致的一连串 TS7016 只会淹没真正的报错)。
 */
async function runScheduler(tasks, limit, state) {
  const pending = new Map(tasks.map(task => [task.name, task]))
  const running = new Map()
  const succeeded = new Set(state.results.filter(r => r.ok).map(r => r.task.name))

  const start = task => {
    const promise = runTask(task).then(result => {
      running.delete(task.name)
      state.results.push(result)
      if (result.ok) succeeded.add(task.name)
      else state.failed.push(result)
      console.log(`${result.ok ? '✓' : '✗'} ${task.name.padEnd(28)} ${seconds(result.ms).padStart(8)}`)
    })
    running.set(task.name, promise)
  }

  while (pending.size > 0 || running.size > 0) {
    let progressed = false
    for (const task of [...pending.values()]) {
      if (running.size >= limit) break
      const blocked = task.needs.filter(name => !succeeded.has(name))
      if (blocked.length > 0) {
        // 依赖已失败(不在 pending/running 里也永远不会成功)→ 跳过
        const dead = blocked.filter(name => !pending.has(name) && !running.has(name))
        if (dead.length > 0) {
          pending.delete(task.name)
          state.skipped.push({ task, blockedBy: dead })
          console.log(`⊘ ${task.name.padEnd(28)} 跳过(依赖未通过:${dead.join(', ')})`)
          progressed = true
        }
        continue
      }
      pending.delete(task.name)
      start(task)
      progressed = true
    }
    if (running.size === 0) {
      if (!progressed) break
      continue
    }
    await Promise.race(running.values())
  }
}

const options = parseArgs(process.argv.slice(2))
if (options === null) process.exit(1)

if (options.help) {
  console.log('用法: node scripts/check-workspaces.mjs [--changed [ref]] [--only a,b] [--concurrency N] [--list] [--no-guards]')
  process.exit(0)
}

const envConcurrency = Number(process.env.CHECK_CONCURRENCY ?? '')
const defaultConcurrency = Math.max(1, Math.min(4, availableParallelism()))
const concurrency = options.concurrency ??
  (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : defaultConcurrency)

let selectedNames = null
if (options.only !== null) selectedNames = new Set(options.only)
else if (options.changed !== null) {
  const files = await changedFiles(options.changed)
  const { selected, global } = selectByChanges(files)
  console.log(`check:fast — ${files.length} 个改动文件(相对 ${options.changed})→ ${global ? '全量(顶层文件改动)' : `${selected.length} 个包`}`)
  if (selected.length === 0) {
    console.log('check:fast — 没有包需要重跑')
    process.exit(0)
  }
  selectedNames = new Set(selected)
}

const wantsGuards = options.guards
const guards = wantsGuards ? GUARDS.map(guard => ({ ...guard })) : []
const selected = PACKAGES.filter(pkg => selectedNames === null || selectedNames.has(pkg.name))
const selectedSet = new Set(selected.map(pkg => pkg.name))
const packages = selected.map(pkg => ({
  name: pkg.name,
  // 未被选中的依赖不参与本轮调度(显式指定子集时,其产物由上一次全量门禁提供)
  needs: pkg.needs.filter(name => selectedSet.has(name)),
  args: ['workspace', pkg.name, 'run', pkg.script ?? 'check'],
}))

if (options.list) {
  for (const pkg of selected) {
    console.log(`${pkg.name.padEnd(30)} needs: ${pkg.needs.join(', ') || '—'}`)
  }
  console.log(`guards: ${guards.map(guard => guard.name).join(', ') || '—'}`)
  process.exit(0)
}

const state = { results: [], failed: [], skipped: [] }
const startedAt = Date.now()
console.log(`check — 并发 ${concurrency};按构建依赖分层(desktop 必须先产出 lib/types)`)

// 阶段 1:desktop check 与根守卫并行。desktop 内部的 verify:profile 会按需构建
// 其余插件包的 lib/(增量 prebuild),此刻不跑那些包自己的 check,避免与它的
// profile 冒烟争抢同一份 lib/。
const firstWave = [...guards, ...packages.filter(task => task.name === 'dsh-plugin-desktop')]
if (firstWave.length > 0) await runPool(firstWave, concurrency, state)

// 阶段 2:依赖感知调度(依赖失败的包直接跳过,不产生级联噪音)。
const rest = packages.filter(task => task.name !== 'dsh-plugin-desktop')
if (rest.length > 0) await runScheduler(rest, concurrency, state)

const totalMs = Date.now() - startedAt
const passed = state.results.length - state.failed.length
console.log(`──── ${state.results.length} 个任务:${passed} 通过、${state.failed.length} 失败、${state.skipped.length} 跳过,总耗时 ${seconds(totalMs)}`)

if (state.failed.length > 0) {
  for (const failure of state.failed) {
    console.error(`\n===== ${failure.task.name} 失败(退出码非 0) =====`)
    console.error(failure.output.trimEnd())
  }
  process.exit(1)
}
