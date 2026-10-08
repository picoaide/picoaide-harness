/**
 * 随包 agent 运行时的**解析与接线**（node / pnpm / python）。
 *
 * 形态：打包期由 `scripts/fetch-bundled-runtimes.mjs` 把三套官方预编译运行时按目标平台
 * 就位到 `build/runtimes/`，electron-builder 用 `extraResources` 带进产物
 * （`<resources>/runtimes/`，**不进 asar**：裸 `node`/`python` 二进制没有扩展名，
 * `asarUnpack` 的显式 glob 匹配不到它们，留在 asar 里就不可执行）。本模块做三件事：
 *
 *   1. {@link resolveBundledRuntimes} —— 读载荷清单并确认目标平台一致、三个入口都在；
 *   2. {@link installBundledRuntimes} —— 把 `<resources>/runtimes/bin` **前置**到
 *      `process.env.PATH`（所有子进程都继承：agent 的 shell、MCP stdio、`plugin_manager`
 *      的 pnpm……），并给随包 python 设好"别往应用包里写"的两个变量；
 *   3. {@link bundledPackageManager} —— 把 `ProfileContext.packageManager` 指到随包
 *      pnpm（node + `pnpm.mjs` 绝对路径），使 `plugin_manager` 的 `install_bundle` /
 *      `remove_bundle` 在客户端上真的能跑（此前它回落到 PATH 上的 `pnpm`，客户端不带
 *      包管理器 ⇒ 必然 `ENOENT`）。
 *
 * 两条边界（与 `speech-model-bundle.ts` 同一口径）：
 *   · **开发运行不读源树的 `build/runtimes/`**：那会让"本机碰巧拉过载荷"改变装配结果
 *     （本地绿、CI 另一套）。生产只认 `process.resourcesPath`；测试用注入接缝。
 *   · 载荷缺失/平台不符/清单坏了 ⇒ **一律当作"没有随包运行时"**（返回 undefined），
 *     不抛异常：客户端照常启动，只是没有这三套运行时（打包期的 afterPack 门禁才是
 *     "声明了就必须在"的判定点）。
 *
 * @module dsh-plugin-desktop/bundled-runtimes
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ProfilePnpmInvocation } from '@deepseek-ai/dsh-app-boot'

/** 载荷目录名（源树 `build/` 下、产物 `resources/` 下同名，与 electron-builder 配置同源）。 */
export const BUNDLED_RUNTIMES_DIR = 'runtimes'

/** 载荷清单文件名（打包期由 `fetch-bundled-runtimes.mjs` 写出）。 */
export const BUNDLED_RUNTIMES_MANIFEST = 'manifest.json'

/** shim 目录名（PATH 只前置这一个目录）。 */
export const BUNDLED_RUNTIMES_SHIM_DIR = 'bin'

/** 载荷清单形状（打包期写出的那份；字段与 `fetch-bundled-runtimes.mjs` 同源）。 */
export interface BundledRuntimesManifest {
  /** 清单 schema；不是 1 一律不认。 */
  readonly schema?: unknown
  /** 载荷的目标平台键（`linux-x64` / `darwin-arm64` / `win-x64`）。 */
  readonly target?: unknown
  /** 三个运行时的版本（只用于日志与自检）。 */
  readonly versions?: unknown
  /** 三个入口相对载荷根的路径。 */
  readonly commands?: unknown
}

/** 解析结果：三个入口的绝对路径 + shim 目录 + 版本。 */
export interface BundledRuntimes {
  /** 载荷根（`<resources>/runtimes`）。 */
  readonly root: string
  /** PATH 前置目录（`<root>/bin`，内含 node/npm/npx/pnpm/python/python3/pip3）。 */
  readonly binDir: string
  /** 随包 node 可执行文件。 */
  readonly node: string
  /** 随包 pnpm 的 JS 入口（用随包 node 执行）。 */
  readonly pnpm: string
  /** 随包 python 解释器。 */
  readonly python: string
  /** 载荷目标平台键。 */
  readonly target: string
  /** 三个运行时的版本。 */
  readonly versions: { readonly node: string, readonly pnpm: string, readonly python: string }
}

/** 解析时的可注入输入（测试接缝；生产只用 `resourcesPath`）。 */
export interface BundledRuntimesOptions {
  /** Electron 的应用资源目录（生产 = `process.resourcesPath`；开发/无头运行为空）。 */
  readonly resourcesPath?: string | undefined
  /** 运行时所在平台（缺省 `process.platform`）。 */
  readonly platform?: NodeJS.Platform
  /** 运行时架构（缺省 `process.arch`）。 */
  readonly arch?: string
  /** 文件探针（测试注入）。 */
  readonly exists?: (path: string) => boolean
  /** 清单读取（测试注入）。 */
  readonly readManifest?: (path: string) => unknown
}

/** 运行平台 + 架构 → 载荷目标键（与 `runtimes.json` 的 targets 同形）。 */
export function bundledRuntimeTarget(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`
}

/** 读一条字符串字段（缺/空即 undefined，不抛）。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析随包运行时。
 *
 * 只有**清单在、目标平台一致、三个入口都是文件**时才返回结果；任何一步不满足都返回
 * undefined（调用方据此当作"没有随包运行时"，而不是拿到一组指向不存在文件的路径）。
 * @param options - 注入接缝（资源目录/平台/文件探针/清单读取）。
 * @returns 解析结果，或 undefined（本次运行没有随包运行时）。
 */
export function resolveBundledRuntimes(options: BundledRuntimesOptions = {}): BundledRuntimes | undefined {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (resourcesPath === undefined || resourcesPath === '') return undefined
  const exists = options.exists ?? existsSync
  const readManifest = options.readManifest ?? ((path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown)
  const root = join(resourcesPath, BUNDLED_RUNTIMES_DIR)
  const manifestPath = join(root, BUNDLED_RUNTIMES_MANIFEST)
  if (!exists(manifestPath)) return undefined
  let manifest: BundledRuntimesManifest
  try {
    manifest = readManifest(manifestPath) as BundledRuntimesManifest
  } catch {
    // 清单坏了 = 这份载荷不可信：当作没有随包运行时（打包期门禁会挡住它进产物）。
    return undefined
  }
  if (manifest?.schema !== 1) return undefined
  const target = text(manifest.target)
  const expected = bundledRuntimeTarget(options.platform ?? process.platform, options.arch ?? process.arch)
  if (target !== expected) return undefined
  const commands = manifest.commands as { node?: unknown, pnpm?: unknown, python?: unknown } | undefined
  const node = text(commands?.node)
  const pnpm = text(commands?.pnpm)
  const python = text(commands?.python)
  if (node === undefined || pnpm === undefined || python === undefined) return undefined
  const versions = manifest.versions as { node?: unknown, pnpm?: unknown, python?: unknown } | undefined
  const absolute = { node: join(root, node), pnpm: join(root, pnpm), python: join(root, python) }
  for (const path of Object.values(absolute)) {
    if (!exists(path)) return undefined
  }
  const binDir = join(root, BUNDLED_RUNTIMES_SHIM_DIR)
  if (!exists(binDir)) return undefined
  return {
    root,
    binDir,
    target,
    ...absolute,
    versions: {
      node: text(versions?.node) ?? 'unknown',
      pnpm: text(versions?.pnpm) ?? 'unknown',
      python: text(versions?.python) ?? 'unknown',
    },
  }
}

/**
 * PATH 上要前置/追加的目录：shim 目录**前置**（`node`/`pnpm`/`python3` 一律走随包版本），
 * pip 装出来的命令行工具目录**追加**在最后（不遮蔽随包解释器与既有 PATH）。
 * @param paths - 解析结果。
 * @param home - 数据根（空 = 不追加用户脚本目录）。
 * @returns 前置与追加的目录列表。
 */
function bundledPathEntries(paths: BundledRuntimes, home: string): { prepend: string[], append: string[] } {
  const prepend = [paths.binDir]
  if (home === '') return { prepend, append: [] }
  const userBase = join(home, 'python-user')
  return { prepend, append: [process.platform === 'win32' ? join(userBase, 'Scripts') : join(userBase, 'bin')] }
}

/**
 * 把随包运行时的目录接进 PATH（幂等：先摘掉旧位置再插入，重复调用不堆积）。
 *
 * 为什么是 PATH：agent 的 shell（bash/pwsh）、MCP stdio 服务、`plugin_manager` 的 pnpm
 * 都从 `process.env.PATH` 继承（上游 `scrubbedParentEnv()` 明确保留 PATH）。这是"让 agent
 * 直接读到 node/pnpm/python"的唯一单一接缝，也是用户终端里 `which node` 能命中的原因。
 * @param env - 被改写的环境（生产 = `process.env`）。
 * @param paths - 解析结果。
 * @param home - 数据根（决定 pip 用户脚本目录）。
 * @returns 本次接进 PATH 的目录（调用方用于日志）。
 */
export function installBundledRuntimePath(
  env: NodeJS.ProcessEnv,
  paths: BundledRuntimes,
  home = '',
): string[] {
  const { prepend, append } = bundledPathEntries(paths, home)
  const wanted = new Set([...prepend, ...append])
  const current = (env.PATH ?? env.Path ?? env.path ?? '').split(delimiter).filter(part => part !== '' && !wanted.has(part))
  const next = [...prepend, ...current, ...append].join(delimiter)
  env.PATH = next
  // Windows 上环境名大小写不敏感、而 Node 读到的可能是 `Path`：三种拼写一起写掉，
  // 免得留下一个旧值继续参与子进程解析（不同消费者的读法不一致）。
  if (process.platform === 'win32') {
    for (const key of ['Path', 'path']) {
      if (env[key] !== undefined) env[key] = next
    }
  }
  return [...prepend, ...append]
}

/**
 * 随包 python 的两个"别写应用包"变量。
 *
 * 为什么必要：随包 python 位于**已签名**的应用包内（macOS 上改动包内容会破坏签名封装，
 * Windows 上安装目录可能只有管理员可写）。
 *   · `PYTHONPYCACHEPREFIX` —— `.pyc` 落到数据根，不去动包里的 `__pycache__`；
 *   · `PYTHONUSERBASE` —— `pip install` 的目标（载荷自带 `pip.conf` 的 `user = yes`
 *     把它变成默认），命令行工具因此落在 `<home>/python-user/bin`（已被接进 PATH）。
 * @param env - 被改写的环境（生产 = `process.env`）。
 * @param paths - 解析结果。
 * @param home - 数据根。
 * @returns 写入的变量（调用方用于日志）。
 */
export function applyBundledRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  paths: BundledRuntimes,
  home: string,
): Record<string, string> {
  const values = {
    PYTHONPYCACHEPREFIX: join(home, 'python-cache'),
    PYTHONUSERBASE: join(home, 'python-user'),
  }
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== value) env[key] = value
  }
  void paths
  return values
}

/**
 * 把 `ProfileContext.packageManager` 指到随包 pnpm。
 *
 * `command` = 随包 node，`args` = 随包 `pnpm.mjs`：上游 `runProfilePnpm` 把
 * `[...packageManager.args, ...pnpmArgs]` 交给 execa，`env` 与 `scrubbedParentEnv()` 合并
 * （`extendEnv: false`）—— PATH 已在 `process.env` 上，生命周期脚本里的 `node` 因此也能解析。
 * @param paths - 解析结果。
 * @returns 上游 `ProfileContext.packageManager` 的取值。
 */
export function bundledPackageManager(paths: BundledRuntimes): ProfilePnpmInvocation {
  return { command: paths.node, args: [paths.pnpm], env: {} }
}

/** 启动日志行（唯一实现：装配期与判据共用同一份格式）。 */
export function bundledRuntimesLogLine(paths: BundledRuntimes): string {
  return `bundled runtimes: node ${paths.versions.node} / pnpm ${paths.versions.pnpm} / python ${paths.versions.python} `
    + `(${paths.target}) → ${paths.binDir} prepended to PATH`
}

/**
 * 一次性接线：解析 + PATH 前置 + python 环境变量。
 * @param options - 解析接缝与环境写入。
 * @returns 解析结果（无随包运行时时 undefined），供 `desktopProfileContext` 使用。
 */
export function installBundledRuntimes(options: BundledRuntimesOptions & {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
} = {}): BundledRuntimes | undefined {
  const env = options.env ?? process.env
  const paths = resolveBundledRuntimes(options)
  if (paths === undefined) return undefined
  const home = options.home ?? env.DSH_HOME ?? ''
  installBundledRuntimePath(env, paths, home)
  applyBundledRuntimeEnvironment(env, paths, home)
  return paths
}
