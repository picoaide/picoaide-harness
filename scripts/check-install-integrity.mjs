#!/usr/bin/env node
/**
 * 门禁**判据执行体**的 install 期完整性前置校验（第十二轮红队 R12-D-01 的 P0 收口）。
 *
 * ## 它防的是什么（现场，不是设想）
 *
 * `.yarnrc.yml` 的 `plugins:` 指向一个**可提交**的插件文件（`.gitignore` 的 `!.yarn/plugins`
 * 放行了它），插件的**顶层模块代码**在任何一次 `yarn` 调用时执行 —— 连 `yarn --version`
 * 都会（真 yarn 4.18.0 实测）。CI 的顺序是 `yarn install --immutable` → 判据步骤，于是：
 *
 *   1. PR 只提交两个文件：`.yarnrc.yml`（加 `plugins:`）与 `.yarn/plugins/<x>.cjs`；
 *   2. `install` 步加载插件 ⇒ 工作树里的 `scripts/check-*.mjs` 被**改写**成
 *      「打印通过凭据 + `process.exit(0)`」；
 *   3. `ci.yml` **一字未改**的三个判定块全部 `EXIT=0`（"17/17 通过"、"32/32 通过"、
 *      "锚定严格"），而**一条判据都没跑**。
 *
 * 同族的第二条通道是**工作区包**的 install 期生命周期钩子：`enableScripts: false` 只挡
 * 依赖的构建脚本，工作区自己的 `postinstall` 照样执行（真 yarn 实测），而当时的登记制
 * 只读根 manifest。
 *
 * ## 为什么必须是"第一个执行体"+ 独立实现
 *
 * 判据的判决只有在"判据本体还没被动过"时才可信。所以本脚本被设计成 CI 里
 * **任何 yarn/corepack 命令之前**的第一个执行体，且**不 import 仓内任何脚本**
 * （`check-workspaces.mjs` / `check-guard-parser-integrity.mjs` 本身就在"可能已被改写"
 * 的集合里）—— 只用 `node:*` 内置模块 + `git`，判据输入全部来自 **git 对象**
 * （`git show HEAD:<path>`），不是工作树里那份可以被 install 期改写的副本。
 *
 * ## 判据（全部 fail-closed；读不出输入 ⇒ 退出码 2，绝不静默通过）
 *
 *   ① **判据执行体逐字节等于 HEAD**：`scripts/check-*.mjs` 全部（HEAD 侧与工作树侧取并集，
 *      检出后才新建的文件也算问题）+ `.yarnrc.yml` + `.gitignore` + 根 `package.json`
 *      + **根与每一个 workspace 包的 `package.json`**；
 *   ② 根 `.yarnrc.yml` 里**禁键** `yarnPath` / `plugins` 缺席、`enableScripts: false` 与
 *      `nodeLinker: node-modules` 在位，且必须是常规文件（符号链接 = 内容来自仓外）；
 *   ③ `.yarn/plugins` 与 `.yarn/releases`（"可提交 + 会被 yarn 当代码读"）**工作树与
 *      HEAD 两侧都为空**；
 *   ④ 根与**每一个 workspace manifest** 都没有**未登记**的 install 期生命周期钩子
 *      （登记表 `INSTALL_INTEGRITY_REGISTERED_HOOKS` 当前为空 = 禁新增）。
 *
 * ## 用法与退出码
 *
 * ```bash
 * # CI：第一执行体（此后才允许出现 yarn/corepack 命令）
 * node scripts/check-install-integrity.mjs
 * # 判据步骤：探针从 git 对象取出后执行（工作树里那份不可信），先比对、再按 HEAD 恢复
 * git show HEAD:scripts/check-install-integrity.mjs > "$RUNNER_TEMP/probe.mjs"
 * node "$RUNNER_TEMP/probe.mjs" --root "$PWD" --restore
 * ```
 *
 * `--root <dir>`（缺省：cwd 的 git 顶层）、`--restore`（比对后把执行体按 HEAD 重写，
 * 关掉"比对通过→判据启动"之间的改写窗口）、`--json <path>`（落一份摘要封印，供留痕）。
 * 退出码：0 = 全部通过；1 = 有未通过项；2 = 判据自身读不到输入（不在检出里 / HEAD 缺失 /
 * 必需的判据执行体不在 HEAD 里 / 参数不合法）。
 *
 * ## 诚实边界（认账）
 *
 *   · **已提交**的改动（把改写后的判据连同登记值一起提交）不在本判据的区分面上 ——
 *     它与"正当改动"在字节上不可区分，唯一的区分机制是**评审**（登记值进 diff）+ 别的
 *     判据（`check-guard-parser-integrity.mjs` 的摘要对拍锚到 git 对象）。本判据收口的是
 *     **install 期改写**这条"ci.yml 一字未改也能全绿"的隐形通道。
 *   · `--restore` 会按 HEAD 重写工作树里的执行体（CI 上是无副作用的：检出树本就等于 HEAD）。
 *     **本地脏树不要不带 `--restore` 就期待它绿** —— 那说明你正在改判据，属正常现象。
 *   · 本脚本只依赖 `node:*` 与 `git`；它**不进** `check-workspaces.mjs` 的 GUARDS 表
 *     （那张表要改不是本泳道的文件），因此 `yarn check` 不会自动跑它 —— 它的调用点写在
 *     `ci.yml`（两个 job 的第一个执行体 + 每个判据步骤前的探针），并由
 *     `check-workflows.mjs` 的静态策略钉住"必须在任何 yarn 调用之前"。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 禁止出现在根 `.yarnrc.yml` **顶层**的键（出现即问题）。
 *
 * 与 `check-guard-parser-integrity.mjs` 的 `REGISTERED_YARN_CONFIGURATION.forbiddenKeys`
 * 同源（那边是"登记制"，这边是"install 之前就必须为空"的另一道网）——两侧清单由
 * `check-guard-parser-integrity.mjs` 的交叉判据逐条对拍，漂移即红。
 */
export const INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS = ['plugins', 'yarnPath']

/** 必须在根 `.yarnrc.yml` 里保持的标量取值（不只是"键存在"）。 */
export const INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS = [
  ['enableScripts', 'false'],
  ['nodeLinker', 'node-modules'],
]

/**
 * install 期生命周期钩子名（与 `check-guard-parser-integrity.mjs` 的
 * `ROOT_LIFECYCLE_HOOK_NAMES` 对拍；那边管根 manifest 的登记，这边管**全部** manifest）。
 */
export const INSTALL_INTEGRITY_LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
]

/**
 * 已登记的 install 期钩子（**空表 = 禁新增**）。键 = `<manifest 相对路径>#<hook>`。
 * 加一条 = 显式的、可评审的决定（并写清"为什么必须发生在 install 期"）。
 */
export const INSTALL_INTEGRITY_REGISTERED_HOOKS = [
  // 与 `check-guard-parser-integrity.mjs` 的 `REGISTERED_WORKSPACE_LIFECYCLE_HOOKS` **逐条相同**
  // （两侧不一致即红，见那边的 ⑥d）：本脚本在 install **之前**跑，那份在之后跑。
  'packages/host/desktop/package.json#prepack',
  'community/fabric/package.json#prepack',
]

/** 必须存在于 HEAD 的判据执行体（缺失 ⇒ 判据输入缺席 ⇒ 退出码 2）。 */
const REQUIRED_JUDGE_BODIES = [
  'scripts/check-install-integrity.mjs',
  'scripts/check-guard-parser-integrity.mjs',
  'scripts/check-root-guards.mjs',
  'scripts/check-workspaces.mjs',
  'scripts/check-workflows.mjs',
]

/** 除 `scripts/check-*.mjs` 之外还必须逐字节等于 HEAD 的执行体入口。 */
const EXTRA_EXECUTION_ENTRY_PATHS = ['.yarnrc.yml', '.gitignore', 'package.json']

/** "可提交 + 会被 yarn 只凭 `.yarnrc.yml` 的引用就当代码读"的目录：两侧都必须为空。 */
const YARN_CODE_DIRECTORIES = ['.yarn/plugins', '.yarn/releases']

/** 判据执行体的文件名形态（`scripts/check-*.mjs`）。 */
const JUDGE_BODY_PATTERN = /^scripts\/check-[^/]*\.mjs$/u

/**
 * 一段字节的 sha256（小写 hex）。
 * @param data - 文件 / 对象内容。
 * @returns 摘要。
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 在指定仓库里跑 git（同步，不抛异常）。
 * @param root - 仓库根。
 * @param args - git 参数。
 * @param encoding - `utf8`（缺省）或 `buffer`。
 * @returns `spawnSync` 的结果。
 */
function git(root, args, encoding = 'utf8') {
  return spawnSync('git', ['-C', root, ...args], { encoding, maxBuffer: 256 * 1024 * 1024 })
}

/**
 * 读 HEAD 里的一个文件（blob）字节。
 * @param root - 仓库根。
 * @param path - 仓库相对路径。
 * @returns `Buffer`；不在 HEAD 里 / 读不出 ⇒ `null`。
 */
function readHeadBlob(root, path) {
  const result = git(root, ['show', `HEAD:${path}`], 'buffer')
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null
}

/**
 * HEAD 里全部 `scripts/check-*.mjs`。
 * @param root - 仓库根。
 * @returns 相对路径数组（升序）。
 */
function listHeadJudgeBodies(root) {
  const result = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'scripts'])
  if (result.status !== 0) return null
  return String(result.stdout)
    .split('\0')
    .filter(name => JUDGE_BODY_PATTERN.test(name))
    .sort()
}

/**
 * 工作树里的 `scripts/check-*.mjs`（含符号链接：符号链接本身也是问题，交给比对环节报）。
 * @param root - 仓库根。
 * @returns 相对路径数组（升序）。
 */
function listWorktreeJudgeBodies(root) {
  const directory = join(root, 'scripts')
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && JUDGE_BODY_PATTERN.test(`scripts/${entry.name}`))
    .map(entry => `scripts/${entry.name}`)
    .sort()
}

/**
 * 展开 `workspaces` 里的目录形态（只支持逐段星号，与本仓的 `packages/<scope>/<pkg>` /
 * `community/<name>` 两张 glob 一致）。
 * @param root - 仓库根。
 * @param patterns - `package.json` 的 `workspaces` 数组。
 * @returns manifest 相对路径数组（升序；只保留真的存在 `package.json` 的目录）。
 */
function expandWorkspaceManifests(root, patterns) {
  const manifests = new Set()
  const walk = (directory, segments) => {
    if (segments.length === 0) {
      if (existsSync(join(root, directory, 'package.json'))) manifests.add(`${directory}/package.json`)
      return
    }
    const [head, ...rest] = segments
    if (head !== '*') {
      walk(directory === '' ? head : `${directory}/${head}`, rest)
      return
    }
    const absolute = directory === '' ? root : join(root, directory)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      walk(directory === '' ? entry.name : `${directory}/${entry.name}`, rest)
    }
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    walk('', pattern.split('/').filter(segment => segment !== ''))
  }
  return [...manifests].sort()
}

/**
 * 根 `.yarnrc.yml` 的**顶层键**（极简扫描：顶格 `key:`、跳过注释与空行）。
 *
 * 为什么不复用别处的解析器：本脚本要在"别的脚本可能已被改写"的前提下自立 —— 而且
 * 它只需要"顶层键集合 + 两个标量取值"，多引入一个解析器只会把可信根摊大。
 * 形态不认识的输入按"读不出"处理（调用方 fail-closed）。
 * @param text - `.yarnrc.yml` 文本。
 * @returns 顶层键数组（按出现顺序，可重复）。
 */
export function yarnrcTopLevelKeys(text) {
  const keys = []
  for (const line of String(text).split('\n')) {
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue
    const match = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:/u.exec(line)
    if (match !== null) keys.push(match[1])
  }
  return keys
}

/**
 * 根 `.yarnrc.yml` 里某个标量的取值（顶格 `key: value`）。
 * @param text - `.yarnrc.yml` 文本。
 * @param key - 键名。
 * @returns 取值字符串；块形态 / 不存在 ⇒ `null`。
 */
export function yarnrcScalar(text, key) {
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:\\s*(.*)$`, 'mu')
  const match = pattern.exec(String(text))
  if (match === null) return null
  const value = match[1].replace(/\s+#.*$/u, '').trim().replace(/^["']|["']$/gu, '')
  return value === '' ? null : value
}

/**
 * 一份 manifest 上的未登记钩子（纯函数，便于自检 / 变异验证）。
 * @param path - manifest 的仓库相对路径（用于报错与登记键）。
 * @param manifest - 解析后的 manifest。
 * @returns 问题清单。
 */
export function lifecycleHookProblems(path, manifest) {
  const registered = new Set(INSTALL_INTEGRITY_REGISTERED_HOOKS)
  const problems = []
  for (const hook of INSTALL_INTEGRITY_LIFECYCLE_HOOKS) {
    const body = manifest?.scripts?.[hook]
    if (typeof body !== 'string') continue
    if (registered.has(`${path}#${hook}`)) continue
    problems.push(`${path} 的 \`scripts.${hook}\` 是**安装期生命周期钩子**且没有登记：${JSON.stringify(body)}`
      + '\n      ⇒ `enableScripts: false` 只挡**依赖**的构建脚本 —— 工作区自己的 postinstall'
      + '照样在 install 期执行（真 yarn 4.18.0 实测），而 CI 的 `yarn install --immutable` 排在'
      + '所有判据之前 ⇒ install 期可以改写判据执行体。'
      + `\n      ⇒ 确实需要时登记进 \`INSTALL_INTEGRITY_REGISTERED_HOOKS\`（键 \`${path}#${hook}\`）`
      + '并写清"为什么必须发生在 install 期"。')
  }
  return problems
}

/**
 * 判据主流程。
 * @param argv - 命令行参数（去掉 `node` 与脚本名）。
 * @returns 退出码。
 */
function main(argv) {
  const problems = []
  const notes = []
  const options = { root: null, restore: false, json: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--restore') { options.restore = true; continue }
    if (argument === '--root' || argument === '--json') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`check-install-integrity: \`${argument}\` 需要一个取值\n`)
        return 2
      }
      if (argument === '--root') options.root = value
      else options.json = value
      index += 1
      continue
    }
    process.stderr.write(`check-install-integrity: 未知参数 ${argument}\n`)
    return 2
  }

  // 仓库根：显式 `--root` > cwd 的 git 顶层（判据输入是 **git 对象**，没有 git 就没得判）。
  const cwd = process.cwd()
  let root = options.root === null ? null : resolve(options.root)
  if (root === null) {
    const top = git(cwd, ['rev-parse', '--show-toplevel'])
    if (top.status !== 0) {
      process.stderr.write('check-install-integrity: 当前目录不在 git 检出里（读不到仓库根）——'
        + '本判据的输入是 HEAD 对象，没有它就无从判起（拒绝把"读不到"当成"没问题"）\n')
      return 2
    }
    root = String(top.stdout).trim()
  }
  if (!existsSync(join(root, 'package.json'))) {
    process.stderr.write(`check-install-integrity: ${root} 下没有 package.json ⇒ 不是仓库根`
      + '（用 `--root <仓库根>` 指定）\n')
    return 2
  }
  const headSha = git(root, ['rev-parse', 'HEAD'])
  if (headSha.status !== 0 || !/^[0-9a-f]{40}$/u.test(String(headSha.stdout).trim())) {
    process.stderr.write('check-install-integrity: 读不到 `git rev-parse HEAD` ⇒ 判据输入缺席\n')
    return 2
  }
  const head = String(headSha.stdout).trim()

  // ① 判据执行体集合：HEAD 侧 ∪ 工作树侧（检出后才新建的脚本也必须在集合里报出来）。
  const headBodies = listHeadJudgeBodies(root)
  if (headBodies === null) {
    process.stderr.write('check-install-integrity: 读不出 HEAD 的 `scripts/` 清单\n')
    return 2
  }
  for (const required of REQUIRED_JUDGE_BODIES) {
    if (!headBodies.includes(required)) {
      process.stderr.write(`check-install-integrity: 必需的判据执行体不在 HEAD 里：${required}\n`
        + '  ⇒ 判据面残缺，拒绝在"少了几份判据"的树上判"通过"。\n')
      return 2
    }
  }
  const worktreeBodies = listWorktreeJudgeBodies(root)
  const bodyPaths = [...new Set([...headBodies, ...worktreeBodies])].sort()

  // ② 根 manifest 的 workspaces（HEAD 侧：登记面按**提交的那份**算，避免被 install 期改动带偏）。
  const headRootManifestBytes = readHeadBlob(root, 'package.json')
  if (headRootManifestBytes === null) {
    process.stderr.write('check-install-integrity: HEAD 里没有 package.json\n')
    return 2
  }
  let headRootManifest
  try {
    headRootManifest = JSON.parse(headRootManifestBytes.toString('utf8'))
  } catch (error) {
    process.stderr.write(`check-install-integrity: 解析 HEAD 的 package.json 失败：${error.message}\n`)
    return 2
  }
  const workspaceManifests = expandWorkspaceManifests(root, headRootManifest?.workspaces ?? [])
  if (workspaceManifests.length === 0) {
    process.stderr.write('check-install-integrity: 从 HEAD 的 `workspaces` 展开出 0 个 manifest ——'
      + '"一个都展开不出来"与"没有工作区"不可区分，按判据输入缺席处理\n')
    return 2
  }

  const entryPaths = [...new Set([
    ...EXTRA_EXECUTION_ENTRY_PATHS,
    ...bodyPaths,
    ...workspaceManifests,
  ])].sort()

  // ③ 逐字节对拍（两侧都读 git 对象：工作树那份**可能已被 install 期改写**）。
  const digests = {}
  const restored = []
  for (const path of entryPaths) {
    const headBytes = readHeadBlob(root, path)
    const absolute = join(root, path)
    const present = existsSync(absolute)
    const stats = present ? lstatSync(absolute) : null
    if (headBytes === null) {
      if (present) {
        problems.push(`${path} **不在 HEAD 里**（工作树里却有）—— 这正是"检出之后才被创建"的形态`
          + '（install 期的插件/钩子写入），或者是一条没进版本库的登记路径')
      }
      continue
    }
    digests[path] = sha256(headBytes)
    if (!present) {
      problems.push(`${path} 在 HEAD 里存在，工作树里**不存在**（被判据的执行体记录在案）`)
      continue
    }
    if (stats.isSymbolicLink()) {
      problems.push(`${path} 是一个**符号链接** —— 内容来自仓外（同族的投放机制）`)
      continue
    }
    if (!stats.isFile()) {
      problems.push(`${path} 不是一个常规文件`)
      continue
    }
    const worktreeBytes = readFileSync(absolute)
    if (!worktreeBytes.equals(headBytes)) {
      problems.push(`${path} 的**工作树内容与 HEAD 不一致**：\n`
        + `      HEAD    sha256：${sha256(headBytes)}\n`
        + `      工作树 sha256：${sha256(worktreeBytes)}\n`
        + '      ⇒ 判据执行体只在"没有被改写"时才可信；install 期（插件的顶层模块代码 / 工作区'
        + '生命周期钩子）正是改写它的窗口 —— 这一步必须在**任何 yarn 命令之前**跑。')
    }
    if (options.restore && !worktreeBytes.equals(headBytes)) {
      writeFileSync(absolute, headBytes)
      restored.push(path)
    }
  }

  // ④ `.yarnrc.yml` 的禁键 / 必需标量（HEAD 与工作树**两份都判**：任何一份带禁键都红）。
  {
    const path = '.yarnrc.yml'
    const headBytes = readHeadBlob(root, path)
    const absolute = join(root, path)
    const texts = []
    if (headBytes !== null) texts.push(['HEAD', headBytes.toString('utf8')])
    if (existsSync(absolute)) {
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        problems.push(`${path} 是一个**符号链接** —— 入口配置必须来自版本库里的常规文件（HEAD 那份已单独判）`)
      } else if (stats.isFile()) {
        texts.push(['工作树', readFileSync(absolute, 'utf8')])
      } else {
        problems.push(`${path} 不是一个常规文件`)
      }
    }
    for (const [side, text] of texts) {
      const keys = yarnrcTopLevelKeys(text)
      if (keys.length === 0) {
        problems.push(`${path}（${side}）读不出任何顶层键 ⇒ 解析面失效，拒绝把"读不出"当成"没有"`)
        continue
      }
      for (const forbidden of INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS) {
        if (!keys.includes(forbidden)) continue
        problems.push(`${path}（${side}）里有**禁键** \`${forbidden}\` —— 它能在 yarn **启动期**`
          + '执行仓内代码（`plugins:`）/ 换掉整个 yarn 解释器（`yarnPath:`），'
          + '而判据步骤排在 install **之后** ⇒ ci.yml 一字未改也能让全部判定块变绿')
      }
      for (const [key, expected] of INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS) {
        const actual = yarnrcScalar(text, key)
        if (actual !== expected) {
          problems.push(`${path}（${side}）的 \`${key}\` 必须是 \`${expected}\`（实际 ${JSON.stringify(actual)}）`)
        }
      }
    }
    notes.push(`${path}：禁键 ${INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS.join('/')} 缺席（HEAD 与工作树两侧）`)
  }

  // ⑤ `.yarn/plugins` / `.yarn/releases`：工作树与 HEAD 两侧都必须为空。
  for (const directory of YARN_CODE_DIRECTORIES) {
    const absolute = join(root, directory)
    const files = []
    if (existsSync(absolute)) {
      const walk = current => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name)
          if (entry.isDirectory()) walk(path)
          else files.push(relative(join(root, directory), path))
        }
      }
      walk(absolute)
    }
    const tracked = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', directory])
    const trackedFiles = tracked.status === 0
      ? String(tracked.stdout).split('\0').filter(name => name !== '')
      : []
    if (files.length > 0 || trackedFiles.length > 0) {
      problems.push(`${directory}/ 必须为空（工作树 ${files.length} 个文件、HEAD ${trackedFiles.length} 个）`
        + `：${[...trackedFiles, ...files].slice(0, 3).join('、')}`
        + '\n      ⇒ yarn **只凭 `.yarnrc.yml` 里的引用**就会读这里的文件（`plugins:` → `.cjs` 被'
        + '`require`，`yarnPath:` → `yarn.js` 被当 yarn 本体）—— 放一个文件进去就是完整载荷')
    } else {
      notes.push(`${directory}：空（工作树与 HEAD）`)
    }
  }

  // ⑥ install 期生命周期钩子：根 + **每一个** workspace manifest（读 HEAD 那份字节）。
  const manifestPaths = ['package.json', ...workspaceManifests]
  for (const path of manifestPaths) {
    const bytes = readHeadBlob(root, path)
    if (bytes === null) {
      problems.push(`${path} 不在 HEAD 里 —— 工作区 manifest 登记面残缺`)
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      problems.push(`${path} 不是合法 JSON（HEAD 那份）：${error.message}`);
      continue
    }
    problems.push(...lifecycleHookProblems(path, manifest))
  }
  notes.push(`install 期生命周期钩子：根 + ${workspaceManifests.length} 个工作区 manifest 全部无未登记钩子`)

  if (options.restore && restored.length > 0) {
    notes.push(`已按 HEAD 重写 ${restored.length} 条执行体：${restored.slice(0, 5).join('、')}${restored.length > 5 ? ' …' : ''}`)
  }

  if (options.json !== null) {
    try {
      writeFileSync(options.json, `${JSON.stringify({
        head,
        judgeBodies: bodyPaths.length,
        workspaceManifests: workspaceManifests.length,
        restored,
        digests,
      }, null, 2)}\n`)
    } catch (error) {
      problems.push(`写不出 --json ${options.json}：${error.message}`)
    }
  }

  if (problems.length > 0) {
    for (const detail of problems) process.stderr.write(`\ncheck-install-integrity: ${detail}\n`)
    process.stderr.write(`\ncheck-install-integrity: ${problems.length} 项未通过`
      + `（判据执行体 ${bodyPaths.length} 条 · manifest ${manifestPaths.length} 个 · HEAD ${head.slice(0, 12)}）\n`)
    process.stderr.write('  ⇒ 这一步是"判据本体在 install 期有没有被改写"的前置校验，'
      + '**必须在任何 yarn/corepack 命令之前**跑：它一旦红，后面的判定块无论打印什么都不作数。\n')
    return 1
  }

  process.stdout.write(`check-install-integrity: VERDICT PASS judge-bodies=${bodyPaths.length}`
    + ` manifests=${manifestPaths.length} head=${head.slice(0, 12)}\n`)
  process.stdout.write(`check-install-integrity: OK — 判据执行体 ${bodyPaths.length} 条（scripts/check-*.mjs 全部`
    + ` + .yarnrc.yml + .gitignore + package.json + ${workspaceManifests.length} 个工作区 manifest）`
    + `与 HEAD(${head.slice(0, 12)}) **逐字节一致**；${notes.join('；')}\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = main(process.argv.slice(2))
  // 与两个 runner 同一套加固：显式退出（只设 `process.exitCode` 会被 `--import` 注入的退出钩子改写）。
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(code)
}
