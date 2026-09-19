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
  // 2026-09-16 真机事故(暗色模式看不清)后的守卫:我们插件里的颜色引用必须是上游
  // **真实存在**的主题 token,否则 CSS 会安静地走 fallback、永远不随主题变化。
  { name: 'check:theme-tokens', args: ['run', 'check:theme-tokens'], path: '客户端主题 token 引用' },
  // 2026-09-17 审计 S15-2/5/7/9:GlitchTip 运维核查脚本是**对着生产跑**的只读工具,
  // fail-open(查不出来却 exit 0)/崩溃(exit 1 与"发现缺陷"同码)/远程命令注入/cookie 越域
  // 都只能在本地用假 keys API + 假 ssh 复现 —— 不进门禁就只能等在现场踩。
  { name: 'check:glitchtip', args: ['run', 'check:glitchtip'], path: 'GlitchTip 运维核查脚本' },
  // 2026-09-17 审计复核 S15-1/S15-3/S15-4：编排器自身的"假绿"（算不出改动当没有改动、
  // --only 打错包名筛出空集）与 .gitignore 的 .glitchtip-recon/ 规则此前**没有任何回归网**
  // —— 一次静默回退就能让 check:fast 重新变成 0 任务 + exit 0。用真脚本副本在合成 git
  // 仓库里跑（corepack 走桩），不联网、不跑真实包。
  { name: 'check:check-workspaces', args: ['run', 'check:check-workspaces'], path: '门禁编排器自身(--changed/--only/.gitignore)' },
  // WASM「客户端专属」改造的验收门禁（docs/planning/2026-09-19-wasm-client-only-design.md §13）：
  // 这里只接**便携子集**（静态守卫 / 三方对拍 / 旧模型零残留 / 渠道约束 / HEAD 绑定）——
  // 需要真 PG 的 go test 与需要显示器的协议探针归 server job 与 W6 三平台（§16 W6）。
  //
  // **已转阻塞 @ 2026-09-20**：W4 删除波次落地、零残留扫描在**修好量具后**达到
  // A=0（B=34 ≤ 预算、ANN=65 ≤ 预算；量具修复=词边界假红 R1-L4-2 / 注释单列 ANN
  // R1-L4-3 / B 扩到 appcfg 包 R1-L4-4）。此前它是 advisory（W1–W5 施工期零残留断言
  // 按设计会如实报出存量命中，只告警不拦门禁）—— 那段历史留在 git 历史里，不再回退。
  // 判据：本 guard 失败 ⇒ `yarn check` 整体失败（本地 `yarn check` 与 CI gate job 同义）。
  // 2026-09-20 真实事故：`git add -A` 把某泳道**正在飞的变异体**提交进了基线
  // （`return '0' // A2-L6 变异 M-D` ⇒ 提交是红的）。本仓把变异验证当一等实践，
  // 所以"变异体残留"是结构性风险 —— 只能靠这条守卫，不能靠人眼。
  { name: 'check:no-leftover-mutants', args: ['run', 'check:no-leftover-mutants'], path: '变异体残留（变异验证必须在临时副本或 trap 还原）' },
  // 2026-09-20 实测漂移：`server/docs/06-database.md` / `08-development.md` 写着「迁移 0001–0060」
  // 而实际已到 0076。文档里的迁移区间此前**没有任何守卫**，只能靠人记得改 —— 这条把它变成判据。
  { name: 'check:migration-range', args: ['run', 'check:migration-range'], path: '文档里的迁移区间 ↔ 实际迁移编号' },
  {
    name: 'check:wasm-client-only',
    args: ['run', 'check:wasm-client-only', '--portable'],
    path: 'WASM 客户端专属（残留/对拍/渠道/W5 文档/HEAD 绑定）；PG 与探针见 §16 W6',
  },
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
  // WASM 应用平台的客户端半边（应用中心 + 发布编排入口）：读 enterprise 的 lib/types。
  { name: '@picoaide/dsh-wasm-apps', dir: 'packages/client/wasm-apps', needs: [] },
  { name: '@picoaide/dsh-browser', dir: 'packages/host/browser', needs: ['@picoaide/dsh-connectors'] },
  // 客户端专属 WASM 应用 origin（`picoaide-app://` 协议 handler + 本机打开路由）：
  // 2026-09-19 起它经 **browser 包导出的 surface seam**（`@picoaide/dsh-browser/surface`）
  // 取得视图/分区/CDP 能力（设计总纲 §16.1 的 surface 抽象：工具实现只写一份、按 surface
  // 分派）⇒ 构建期依赖 browser 的 lib/types，必须先于它产出。
  { name: '@picoaide/dsh-wasm-apps-host', dir: 'packages/host/wasm-apps-host', needs: ['@picoaide/dsh-browser'] },
  // 2026-09-16:vendored 第三方插件(随三平台安装包分发)的测试此前**不在任何门禁
  // 链里**(verify-inventories 的 CHECK_CHAIN_EXEMPTIONS 显式豁免),本地加固
  // (同源守卫/符号链接写落点断言/失败软着陆)只有"手工跑"这一条保证 —— 升级
  // 上游时一次静默回归就能进产物。这里以 `script: 'test'` 接进来:该包没有
  // build 步骤(lib/ 入库,构建依赖 ~/.dsh/source 的 esbuild),也无构建期依赖,
  // 故 firstWave(与 desktop check、根守卫并发)且不被任何包依赖。
  {
    name: 'dsh-memory-evolve',
    dir: 'packages/vendor/memory-evolve',
    needs: [],
    script: 'test',
    firstWave: true,
  },
]

/** 路径前缀 → 包名(用于 --changed 的改动归属判定,最长前缀优先)。 */
const PATH_OWNERS = [
  ['packages/host/desktop/', 'dsh-plugin-desktop'],
  ['packages/host/enterprise/', '@picoaide/dsh-enterprise'],
  ['packages/client/account-card/', '@picoaide/dsh-account-card'],
  ['packages/client/wasm-apps/', '@picoaide/dsh-wasm-apps'],
  ['packages/client/branding/', '@picoaide/dsh-branding'],
  ['packages/host/connectors/', '@picoaide/dsh-connectors'],
  ['packages/host/browser/', '@picoaide/dsh-browser'],
  ['packages/host/wasm-apps-host/', '@picoaide/dsh-wasm-apps-host'],
  ['packages/host/cron/', '@picoaide/dsh-cron'],
  ['packages/vendor/memory-evolve/', 'dsh-memory-evolve'],
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
  // upstream.json is an input of check:layout (submodule URL/commit/version):
  // without it a pin-only change selected zero packages and the early exit
  // skipped every root guard — a false-green fast gate.
  'upstream.json',
]

function parseArgs(argv) {
  const options = { changed: null, only: null, list: false, concurrency: null, guards: true, help: false, fullOutput: false }
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
      // 与 --changed 同款:下一个 token 以 `--` 开头说明值缺失,报用法错误
      // 而不是把 `--no-guards` 当成包名(2026-09-17 审计 S15-4 附带)。
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        console.error('check-workspaces: --only 需要一个包名列表(逗号分隔)')
        process.exitCode = 2
        return null
      }
      options.only = next.split(',').map(s => s.trim()).filter(Boolean)
      i += 1
    } else if (arg === '--concurrency') {
      // A non-numeric value used to reach `Math.min(NaN, …)` → zero workers, so
      // the first wave (every root guard + the desktop check) silently ran
      // NOTHING and the gate still exited 0 — a false green (2026-09-16 R9
      // audit). Reject it like any other bad argument.
      const value = Number(argv[i + 1])
      if (!Number.isSafeInteger(value) || value <= 0) {
        console.error(`check-workspaces: --concurrency 需要正整数,收到 ${JSON.stringify(argv[i + 1])}`)
        process.exitCode = 2
        return null
      }
      options.concurrency = value
      i += 1
    } else if (arg === '--list') options.list = true
    else if (arg === '--no-guards') options.guards = false
    else if (arg === '--full-output') options.fullOutput = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error(`check-workspaces: 未知参数 ${arg}`)
      process.exitCode = 2
      return null
    }
  }
  return options
}

/**
 * Lines that carry a test/build verdict, across every runner this gate drives:
 * vitest (`FAIL`, `×`, `AssertionError`, `⎯ Failed Tests`, `Tests 1 failed`),
 * `node --test` (`not ok`), tsc (`error TS…`), and yarn/spawn failures
 * (`ELIFECYCLE`). Deliberately excludes vitest's `Test Files` summary line: it
 * matches on PASSING runs too (`Test Files 16 passed`) and used to consume the
 * bounded verdict budget with noise.
 */
const FAILURE_LINE = /(?:^|\s)(?:FAIL\b|not ok\b|AssertionError|ELIFECYCLE|error TS\d+|\d+\s+failed\b|×|✗|⎯)/u
/** Cap on the verdict lines printed per failed task. */
const MAX_FAILURE_LINES = 150
/** Cap on the trailing context lines printed per failed task. */
const MAX_TAIL_LINES = 200

/**
 * Bound a failed task's output to something a CI log can actually carry.
 *
 * The real-socket / real-subprocess suites print tens of thousands of lines, and
 * GitHub **truncates the middle** of a job log — so dumping the whole capture
 * pushed the verdict out of view (2026-09-16: a red Gate on
 * `@picoaide/dsh-connectors` could not be diagnosed from the CI log at all;
 * every rerun "fixed" it and every rerun hid why). Print the verdict lines
 * first, then a bounded tail for context. `--full-output` restores the raw dump.
 * @param output - the task's captured stdout+stderr.
 * @returns the bounded report.
 */
function summarizeFailure(output) {
  // A trailing newline is a separator, not a line: keeping the empty element
  // made exactly-(MAX_FAILURE_LINES + MAX_TAIL_LINES)-line output take the
  // summary branch (off-by-one).
  const body = output.endsWith('\n') ? output.slice(0, -1) : output
  const lines = body.split('\n')
  if (lines.length <= MAX_FAILURE_LINES + MAX_TAIL_LINES) return output.trimEnd()
  const tailStart = Math.max(0, lines.length - MAX_TAIL_LINES)
  const flagged = []
  for (let index = 0; index < lines.length && flagged.length < MAX_FAILURE_LINES; index += 1) {
    if (FAILURE_LINE.test(lines[index])) flagged.push({ index, line: lines[index] })
  }
  // Verdict lines already shown above are not repeated inside the tail.
  const flaggedInTail = new Set(flagged.filter(entry => entry.index >= tailStart).map(entry => entry.index))
  const tail = lines.slice(tailStart).filter((_, offset) => !flaggedInTail.has(tailStart + offset))
  const parts = [`(输出共 ${lines.length} 行;此处只打印判定行与末尾;完整输出用 --full-output 本地重跑)`]
  if (flagged.length > 0) {
    parts.push(`--- 失败相关行(最多 ${MAX_FAILURE_LINES} 行,按出现顺序) ---`, ...flagged.map(entry => entry.line))
  } else {
    parts.push('--- 未匹配到失败标记行(见下方末尾输出) ---')
  }
  parts.push(`--- 输出末尾(最后 ${tail.length} 行) ---`, ...tail)
  return parts.join('\n')
}

/**
 * Run git and report **both** its stdout and whether it succeeded.
 *
 * The old version discarded stderr and the exit code and resolved stdout
 * whatever happened, so `git diff --name-only <typo>` (exit 128, empty stdout)
 * was indistinguishable from "nothing changed": `check:fast` then ran zero
 * package checks and exited 0 — a false-green fast gate (2026-09-17 audit
 * S15-1). Callers must treat `ok === false` as a hard error.
 * @param args - git argv (without the leading `git`).
 * @returns `{ ok, out, err }`; `out`/`err` are trimmed of a trailing newline.
 */
function git(args) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => resolve({ ok: false, out: '', err: error.message }))
    child.on('close', code => resolve({ ok: code === 0, out: out.trimEnd(), err: err.trimEnd() }))
  })
}

/** 本次工作区相对 `ref` 的改动文件列表(含未跟踪文件)。 */
async function changedFiles(ref) {
  // 先确认 ref 可解析:`--changed <typo>` / 浅克隆 / detached HEAD 下
  // `git diff` 会失败,失败被当成"没有改动"就是假绿,所以这里 fail loud。
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!resolved.ok) {
    return {
      error: `--changed 的 ref 无法解析:${JSON.stringify(ref)}${resolved.err ? `(${resolved.err})` : ''}` +
        ' —— 请确认它存在于本仓库(例如 origin/master)。拒绝把"算不出改动"当成"没有改动"。',
    }
  }
  const tracked = await git(['diff', '--name-only', ref])
  if (!tracked.ok) return { error: `git diff --name-only ${ref} 失败:${tracked.err || `退出码非 0`}` }
  const untracked = await git(['ls-files', '--others', '--exclude-standard'])
  if (!untracked.ok) return { error: `git ls-files --others 失败:${untracked.err || `退出码非 0`}` }
  const files = [...new Set([...tracked.out.split('\n'), ...untracked.out.split('\n')].map(s => s.trim()).filter(Boolean))]
  return { files }
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

/**
 * 记录一个失败任务的归属：`advisory` 任务只告警、不拦门禁。
 *
 * 为什么要这个开关（2026-09-19）：WASM「客户端专属」的验收门禁（§13）在 W1–W5 波次
 * 落地前**按设计就是红的** —— 它的零残留断言必须如实报出存量命中（旧应用子域/换票/
 * entry_url/access=public/服务端 ai.chat）。若直接接成阻塞，`yarn check` 会在所有泳道
 * 施工期间恒红；若把它改成"没命中才算"，那条判据就退化成了摆设。
 * 折中：脚本本身仍然 exit 1（直跑可见），编排器这里只记 advisory 并**显式打印**，
 * W6 验收前必须删掉条目上的 `advisory:true`。
 */
function classifyFailure(result, state) {
  if (result.task.advisory === true) state.advisory.push(result)
  else state.failed.push(result)
}

async function runPool(tasks, limit, state) {
  const queue = [...tasks]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const task = queue.shift()
      if (task === undefined) return
      const result = await runTask(task)
      state.results.push(result)
      if (!result.ok) classifyFailure(result, state)
      const mark = result.ok ? '✓' : result.task.advisory === true ? '!' : '✗'
      console.log(`${mark} ${result.task.name.padEnd(28)} ${seconds(result.ms).padStart(8)}`)
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
      else classifyFailure(result, state)
      const mark = result.ok ? '✓' : task.advisory === true ? '!' : '✗'
      console.log(`${mark} ${task.name.padEnd(28)} ${seconds(result.ms).padStart(8)}`)
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
// A usage error sets exitCode 2 in parseArgs; honor it instead of flattening
// every bad-argument case to 1 (2026-09-16 R9/R2 audit: the assignment was dead
// code — `process.exit(1)` overrode it).
if (options === null) process.exit(process.exitCode ?? 1)

if (options.help) {
  console.log('用法: node scripts/check-workspaces.mjs [--changed [ref]] [--only a,b] [--concurrency N] [--list] [--no-guards] [--full-output]')
  process.exit(0)
}

const envConcurrency = Number(process.env.CHECK_CONCURRENCY ?? '')
const defaultConcurrency = Math.max(1, Math.min(4, availableParallelism()))
const concurrency = options.concurrency ??
  (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : defaultConcurrency)

let selectedNames = null
if (options.only !== null) {
  // 显式点名必须兑现:名字打错时旧行为是"筛出空集 → 0 个任务 → exit 0",
  // 与"这些包都过了"无法区分(2026-09-17 审计 S15-4)。空值(--only 后面没跟
  // 东西)同样按用法错误处理。
  const known = new Set(PACKAGES.map(pkg => pkg.name))
  const unknown = options.only.filter(name => !known.has(name))
  if (options.only.length === 0) {
    console.error('check-workspaces: --only 需要包名列表(逗号分隔),收到空值')
    process.exit(2)
  }
  if (unknown.length > 0) {
    console.error(`check-workspaces: --only 里有不存在的包:${unknown.join(', ')}`)
    console.error(`可选:${[...known].join(', ')}`)
    process.exit(2)
  }
  selectedNames = new Set(options.only)
} else if (options.changed !== null) {
  const changed = await changedFiles(options.changed)
  if (changed.error !== undefined) {
    console.error(`check-workspaces: ${changed.error}`)
    process.exit(2)
  }
  const files = changed.files
  const { selected, global } = selectByChanges(files)
  console.log(`check:fast — ${files.length} 个改动文件(相对 ${options.changed})→ ${global ? '全量(顶层文件改动)' : `${selected.length} 个包`}`)
  // A zero-package selection (README / notes / .gitmodules changes) must still
  // run the root guards: they read those very files (check:layout verifies
  // README.i18n.yaml and .gitmodules against upstream.json). Exiting here was a
  // false-green fast gate — CI full runs caught it only after the push.
  if (selected.length === 0) console.log('check:fast — 没有包需要重跑;仍执行根守卫')
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
  firstWave: pkg.firstWave === true,
}))

if (options.list) {
  for (const pkg of selected) {
    console.log(`${pkg.name.padEnd(30)} needs: ${pkg.needs.join(', ') || '—'}`)
  }
  console.log(`guards: ${guards.map(guard => guard.name).join(', ') || '—'}`)
  const advisories = guards.filter(guard => guard.advisory === true).map(guard => guard.name)
  if (advisories.length > 0) console.log(`guards(advisory,只告警不拦门禁): ${advisories.join(', ')}`)
  process.exit(0)
}

const state = { results: [], failed: [], skipped: [], advisory: [] }
const startedAt = Date.now()
console.log(`check — 并发 ${concurrency};按构建依赖分层(desktop 必须先产出 lib/types)`)

// 阶段 1:desktop check 与根守卫并行。desktop 内部的 verify:profile 会按需构建
// 其余插件包的 lib/(增量 prebuild),此刻不跑那些包自己的 check,避免与它的
// profile 冒烟争抢同一份 lib/。firstWave 标记的包(无构建期依赖,如 vendored
// 插件的 test)也放在这一波,把它们的耗时藏进 desktop 的长任务里。
const firstWave = [
  ...guards,
  ...packages.filter(task => task.name === 'dsh-plugin-desktop' || task.firstWave === true),
]
if (firstWave.length > 0) await runPool(firstWave, concurrency, state)

// 阶段 2:依赖感知调度(依赖失败的包直接跳过,不产生级联噪音)。
const rest = packages.filter(task => task.name !== 'dsh-plugin-desktop' && task.firstWave !== true)
if (rest.length > 0) await runScheduler(rest, concurrency, state)

const totalMs = Date.now() - startedAt
const passed = state.results.length - state.failed.length
console.log(`──── ${state.results.length} 个任务:${passed} 通过、${state.failed.length} 失败、${state.skipped.length} 跳过`
  + `${state.advisory.length > 0 ? `、${state.advisory.length} 告警(advisory)` : ''},总耗时 ${seconds(totalMs)}`)

if (state.advisory.length > 0) {
  // advisory 不等于通过：把失败原文（有界）打出来，并明确它何时必须转阻塞。
  console.error(`\n⚠ ${state.advisory.length} 个 advisory 任务未通过（不拦门禁，但必须处置）：`)
  for (const advisory of state.advisory) {
    console.error(`\n----- ${advisory.task.name}（advisory：${advisory.task.path ?? ''}）-----`)
    console.error(options.fullOutput ? advisory.output.trimEnd() : summarizeFailure(advisory.output))
  }
  console.error('\n提示：WASM 客户端专属门禁在 W1–W5 波次落地前按设计就是红的（零残留如实报出存量命中）。')
  console.error('     W6 验收前必须删掉 scripts/check-workspaces.mjs 里该条目的 advisory:true 转为阻塞。')
}

if (state.failed.length > 0) {
  for (const failure of state.failed) {
    console.error(`\n===== ${failure.task.name} 失败(退出码非 0) =====`)
    console.error(options.fullOutput ? failure.output.trimEnd() : summarizeFailure(failure.output))
  }
  process.exit(1)
}
