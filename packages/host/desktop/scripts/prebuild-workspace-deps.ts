/**
 * 打包/冒烟前预构建 workspace 依赖包(跨平台,被 package-win.ts / package-mac.ts /
 * release-mac.ts / verify-profile-boot.mjs 的真实 CLI 入口调用)。
 *
 * 背景:enterprise/account-card/branding 的 lib/ 未入库(fresh checkout 缺失),
 * 而 desktop 安装包运行时读取这些包的 lib/client.js(品牌 logo/版本标签等)。
 * 此前 dist:win/mac 未构建它们 → 安装包携带缺失/旧 bundle(品牌在但版本号不
 * 显示)。dist:linux 因前置 `yarn run build` 才碰巧完整。
 *
 * 顺序:desktop 自身 build 最先(产出 lib/types,enterprise 的 tsc 引用
 * dsh-plugin-desktop/desktop-home 的类型);随后 enterprise/account-card/
 * branding(它们 tsc 需 desktop 类型)。desktop build 不依赖 enterprise lib
 * (已验证),故无循环。
 *
 * 2026-09-10 增量化:每个包构建前先判定「产物是否已是最新」——产物 mtime 不早于
 * 全部输入(src/ 递归 + package.json/tsconfig/tsdown 配置 + 依赖包产物)即跳过。
 * 动因:`yarn check` 里 desktop 的 verify:profile 会再跑一遍本函数,而此刻
 * 8 个包刚刚在本轮 check 中构建完毕 → 纯重复劳动实测 40s(check 总时长的
 * 1/4)。判定只会在"源文件比产物新"或"产物缺失"时放行重建,方向始终偏保守;
 * CI/fresh checkout 下 lib/ 缺失 → 全量构建,行为与之前完全一致。
 * 需要强制全量重建时设 DSH_PREBUILD=force(或 CLI 传 --force)。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 构建产物目录(相对包根):lib/ 是各包 tsdown/tsc 的 outDir;desktop 另有 build/(brand-prepare)。 */
const OUTPUT_DIRS = ['lib', 'build']

/** 各包构建时读取、但不属于 src/ 的额外输入(相对仓库根)。 */
const EXTRA_INPUTS: Record<string, readonly string[]> = {
  // desktop build 先跑 brand-prepare.mjs 从 brands/official 派生图标与品牌资源
  'dsh-plugin-desktop': ['brands', 'assets'],
}

/** 构建输入判定时忽略的目录名(递归剪枝)。 */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'lib', 'build', 'dist'])

interface WorkspacePackage {
  /** yarn workspace 名;null 表示"当前包"(用 `yarn run build` 而非 `yarn workspace`)。 */
  readonly workspace: string | null
  /** 包根相对仓库根。 */
  readonly dir: string
  /** 该包构建读取的其它 workspace 包(其产物更新则本包也需重建)。 */
  readonly deps?: readonly string[]
}

const WORKSPACE_PACKAGES: readonly WorkspacePackage[] = [
  { workspace: null, dir: 'packages/host/desktop' },
  { workspace: '@picoaide/dsh-enterprise', dir: 'packages/host/enterprise', deps: ['packages/host/desktop'] },
  { workspace: '@picoaide/dsh-account-card', dir: 'packages/client/account-card', deps: ['packages/host/desktop'] },
  { workspace: '@picoaide/dsh-branding', dir: 'packages/client/branding', deps: ['packages/host/desktop'] },
  { workspace: '@picoaide/dsh-cron', dir: 'packages/host/cron' },
  { workspace: '@picoaide/dsh-connectors', dir: 'packages/host/connectors' },
  { workspace: '@picoaide/dsh-browser', dir: 'packages/host/browser' },
  { workspace: 'dsh-better-sidebar', dir: 'packages/client/better-sidebar' },
]

/** 执行一个 yarn 命令,失败即抛错。 */
function run(args: readonly string[], cwd: string, label: string): void {
  // corepack yarn:仓库约定(包管理器经 corepack);shell: true 让 Windows
  // 也能解析 corepack 的可执行 shim(否则 spawnSync 找不到未入 PATH 的包装)。
  const result = spawnSync('corepack', ['yarn', ...args], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`prebuildWorkspaceDeps: ${label} failed (status ${String(result.status)})`)
  }
}

/** 递归收集文件路径(不跟随符号链接,剪枝 node_modules/lib/build 等)。 */
function collectFiles(root: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      collectFiles(join(root, entry.name), out)
    } else if (entry.isFile()) {
      out.push(join(root, entry.name))
    }
  }
  return out
}

/** 一组文件的最新 mtime;空集合返回 0(调用方按"无输入"处理)。 */
function newestMtime(files: readonly string[]): number {
  let newest = 0
  for (const file of files) {
    const mtime = statSync(file).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest
}

/** 一组文件的最旧 mtime;空集合返回 Infinity(调用方按"无产物"处理)。 */
function oldestMtime(files: readonly string[]): number {
  let oldest = Infinity
  for (const file of files) {
    const mtime = statSync(file).mtimeMs
    if (mtime < oldest) oldest = mtime
  }
  return oldest
}

/** 该包构建读取的全部输入文件。 */
function inputFiles(repoRoot: string, pkg: WorkspacePackage): string[] {
  const packageRoot = join(repoRoot, pkg.dir)
  const files = collectFiles(join(packageRoot, 'src'))
  for (const name of readdirSync(packageRoot)) {
    if (/^(?:package\.json|tsconfig[^/]*\.json|tsdown\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s)$/u.test(name)) {
      const path = join(packageRoot, name)
      if (statSync(path).isFile()) files.push(path)
    }
  }
  for (const extra of EXTRA_INPUTS[workspaceKey(pkg)] ?? []) {
    const path = join(repoRoot, extra)
    if (existsSync(path)) files.push(...collectFiles(path))
  }
  return files
}

/** 该包的构建产物文件。 */
function outputFiles(repoRoot: string, pkg: WorkspacePackage): string[] {
  const packageRoot = join(repoRoot, pkg.dir)
  const files: string[] = []
  for (const dir of OUTPUT_DIRS) {
    const path = join(packageRoot, dir)
    if (existsSync(path)) files.push(...collectFiles(path))
  }
  return files
}

function workspaceKey(pkg: WorkspacePackage): string {
  return pkg.workspace ?? 'dsh-plugin-desktop'
}

/** 包名 → 包描述(用于依赖产物 mtime 查询)。 */
const PACKAGE_BY_DIR = new Map(WORKSPACE_PACKAGES.map(pkg => [pkg.dir, pkg]))

/**
 * 判定单个包是否已是最新:产物存在,且最旧产物的 mtime 不早于
 * 自身输入与依赖产物的最新 mtime。
 */
function isUpToDate(repoRoot: string, pkg: WorkspacePackage): boolean {
  const outputs = outputFiles(repoRoot, pkg)
  if (outputs.length === 0) return false
  const inputs = inputFiles(repoRoot, pkg)
  let newestInput = newestMtime(inputs)
  for (const depDir of pkg.deps ?? []) {
    const dep = PACKAGE_BY_DIR.get(depDir)
    if (dep === undefined) continue
    const depOutputs = outputFiles(repoRoot, dep)
    const depNewest = newestMtime(depOutputs)
    if (depNewest > newestInput) newestInput = depNewest
  }
  return oldestMtime(outputs) >= newestInput
}

/** 预构建 desktop 自身 + enterprise/account-card/branding/其余自研插件包。
 *
 * `desktopRoot` 是 dsh-plugin-desktop 包根(调用方一直传这个);仓库根由它上溯三级
 * 得到(yarn workspace 命令在包内任意目录都能解析,故 cwd 统一用 desktopRoot)。
 */
export function prebuildWorkspaceDeps(desktopRoot: string): void {
  const repoRoot = resolve(desktopRoot, '..', '..', '..')
  const force = process.env.DSH_PREBUILD === 'force' || process.argv.includes('--force')
  const skipped: string[] = []
  for (const pkg of WORKSPACE_PACKAGES) {
    const key = workspaceKey(pkg)
    if (!force && isUpToDate(repoRoot, pkg)) {
      skipped.push(key)
      continue
    }
    console.log(`[prebuild] ${key}: building`)
    const args = pkg.workspace === null ? ['run', 'build'] : ['workspace', pkg.workspace, 'build']
    run(args, desktopRoot, `${key} build`)
  }
  if (skipped.length > 0) {
    console.log(`[prebuild] up to date, skipped: ${skipped.join(', ')} (DSH_PREBUILD=force 可强制重建)`)
  }
  // dsh-memory-evolve 是 DSH 生态外部插件(构建依赖 ~/.dsh/source 的 esbuild,
  // 见其 scripts/build.mjs),其 lib/ 保留版本库跟踪,不走标准 prebuild。
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  try {
    prebuildWorkspaceDeps(desktopRoot)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
