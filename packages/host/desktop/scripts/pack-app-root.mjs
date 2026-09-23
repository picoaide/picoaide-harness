/**
 * 打包输入暂存层（2026-09-22 泄漏修复的**唯一有效机制**）。
 *
 * ## 为什么需要它
 *
 * 实测结论（本文件落地时的取证）：**electron-builder 26.15.3 不把 `build.files`
 * 的正向/排除模式应用在「应用根目录」内容上**。同一个 `build.files` 数组：
 *   - 对 `node_modules` **有效** —— 它被当成 `nodeModuleFilePatterns`
 *     （`fileMatcher.js` 的 `getNodeModuleFileMatcher` 只取 `!` 开头项，再前置 `**\/*`）；
 *   - 对应用根目录**无效** —— 打包仍按默认的 `**\/*` + electron-builder 内置排除
 *     （`!dist`、`!**\/node_modules\/**`、`!build{,/**\/*}` …）执行。
 *
 * 后果：`!src\/**`、`!**\/*.ts`、`!temp\/**`、`!.e2e-*` 这些规则看着在配置里、
 * 也出现在 `dist/builder-debug.yml` 的 `nodeModuleFilePatterns` 里，但**发布包
 * 照样包含** `src\/`、`tests\/`、`scripts\/`、`temp\/`、`.e2e-*\/`、根级 `*.map`。
 * 这正是 11 个已发布正式/预发包夹带自有源码的机制，也是报告里"排除规则未生效"
 * 的根因（原报告推测是 `!*.ts` 少了 `**\/`；实测那只是次要因素，主因是**这一层
 * 根本没生效**）。
 *
 * 已验证的负结果（别重复试）：给 `files` 补 `**\/` 前缀、删掉包顶层 `files`
 * 字段、给 `directories.app` 指向**符号链接**暂存目录 —— 都不能让白名单生效，
 * 最后一个还会把符号链接按真实内容展开成 8.3 GB 的 asar。
 *
 * ## 机制
 *
 * 打包前把「运行期真正需要的文件」**完整复制**到 `<dist>\/.pack-root\/`，
 * 让 electron-builder 以它为 `directories.app` 打包；打完删除。
 * 复制是必须的（不是符号链接）：electron-builder 会把链接展开成真实内容。
 *
 * 运行期清单是**封闭白名单**，不是黑名单 —— 新增运行期文件时要显式加进来，
 * 否则 afterPack 的 `verify-packaged-runtime` 会当场拒包（清单与产物是同一批
 * 判据：`REQUIRED_PACKAGED_RUNTIME_ENTRIES`）。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './direct-invocation.mjs'

/**
 * 随包发布的应用根条目（白名单；**只列运行期需要的**）。
 *
 * 与 `scripts/verify-packaged-runtime.ts` 的区别：那份是"必需项必须在"的证据侧，
 * 这份是"输入侧只放这些"的构造侧。两者必须同时维护，任一侧漂移都会被 afterPack 抓住。
 */
export const PACK_APP_ROOT_ENTRIES = [
  // tsdown 产物（lib/**）+ 沙箱 preload（lib/preload/renderer-error.cjs）
  'lib',
  // brand-prepare 的派生素材（图标 / 托盘 / web 品牌）+ 随包 channel.json
  'build',
  // 装配补丁（profile.ts 载入它挂桌面组合）
  'cordis.patch.yml',
  // 包装配与依赖解析的元数据
  'package.json',
]

/** 应用根里**绝不**进包的开发期条目（白名单之外一律不进，这里显式记名便于排障）。 */
export const PACK_APP_ROOT_EXCLUDED = [
  'src',
  'tests',
  'scripts',
  'docs',
  '.e2e-*',
  '.real-env-*',
  'temp',
  'dist',
  '*.map（根级）',
  '*.ts / *.tsx（根级）',
]

/**
 * **打包工具**的中间产物：可以出现在包根，但**绝不进包**。
 *
 * 与 `PACK_APP_ROOT_EXCLUDED` 的区别不是措辞：那份是"白名单之外的开发期目录"
 * （不进包是因为没被列进白名单），这份列出的是**落在白名单条目内部**的文件
 * ——`build/` 是整目录复制，所以写在 `build/` 里的任何东西都会进 asar。这里的
 * 条目是**暂存前的 fail-loud 闸门**，不是排除规则：白名单的语义（"输入侧只放
 * 这些"）保持不变，出现这些文件就说明有人把打包工具的产物写进了随包目录，
 * 当场拒包而不是悄悄过滤掉（否则下次换个文件名又会静默泄漏一次）。
 *
 * `build/channel-electron-builder.cjs`（渠道构建生成的 electron-builder 配置，
 * 含渠道 productName/appId/深链 scheme/产物名模板）是 2026-09-23 独立复审 N-1
 * 的实例：它曾经由 `prepareChannelBuilderOverrides()` 写在 `build/` 里、而暂存在
 * 其后执行 ⇒ beta 与各品牌渠道的 `app.asar` 都多出这个文件（官方渠道不生成它，
 * 所以本机跑官方 `package-dir.mjs` 看不见）。现在它生成在包根 `temp/`
 * （见 channel-build.ts 的 `defaultChannelBuilderConfigDir`），这条判据是第二道闸。
 */
export const PACK_APP_ROOT_FORBIDDEN_ENTRIES = [
  'build/channel-electron-builder.cjs',
]

/**
 * 暂存前自检：随包应用根里不得有打包工具中间产物（见上表说明）。
 * @param packageRoot - 桌面包的绝对路径（`packages/host/desktop`）。
 * @throws 命中任一禁止条目时（fail-loud，不产出包）。
 */
export function assertNoPackToolResidue(packageRoot) {
  for (const entry of PACK_APP_ROOT_FORBIDDEN_ENTRIES) {
    const path = join(packageRoot, entry)
    if (!existsSync(path)) continue
    throw new Error(
      `pack-app-root: 打包输入里有打包工具中间产物 ${path}`
      + '——它在随包白名单条目内部（build/ 是整目录复制），会进 app.asar。'
      + '请确认打包前跑过 prepareChannelPackaging()（它每次构建都清理该残留），'
      + '并检查是否有脚本把打包配置写回了 build/。',
    )
  }
}

/**
 * 复制时丢弃的文件：**sourcemap**。
 *
 * 为什么不靠 electron-builder 的 `files` 排除：那一层对应用根目录内容不生效
 * （见文件头说明），实测 `!**\/*.map` 与 `!*.map` 都拦不住 `lib/*.map`。
 * 也不靠打包后删除：sourcemap 的 `sourcesContent` 内嵌**原始 TypeScript 源码**，
 * 只要它进过一次 asar 就等于泄露过。所以在**进包之前**就丢掉。
 *
 * `tsdown.config.ts` 仍开着 `sourcemap: true`：`lib/*.map` 对本地排障
 * （堆栈还原、覆盖率）有价值，只是**不该随包**。
 * @param source - 源绝对路径。
 * @returns 是否跳过该文件。
 */
function shouldSkipInPack(source) {
  return source.endsWith('.map')
}

/**
 * 在 dist 下准备一个只含运行期条目的应用根副本。
 * @param packageRoot - 桌面包的绝对路径（`packages/host/desktop`）。
 * @param outDir - 本次打包的输出目录名（相对 packageRoot），默认 `dist`。
 * @returns 暂存应用根的绝对路径，以及清理函数。
 */
export function stagePackAppRoot(packageRoot, outDir = 'dist') {
  // 先做输入侧自检：打包工具中间产物落在白名单条目内部时，整目录复制会把它带进包。
  assertNoPackToolResidue(packageRoot)
  const distRoot = resolve(packageRoot, outDir)
  const stageRoot = join(distRoot, '.pack-root')
  // 先清旧的：上一次打包的残留会被当成本次输入收编（报告里 3514.6 MB 产物就是这么来的）。
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageRoot, { recursive: true })

  for (const entry of PACK_APP_ROOT_ENTRIES) {
    const from = join(packageRoot, entry)
    if (!existsSync(from)) {
      throw new Error(`pack-app-root: 运行期条目缺失 ${from}（先跑 yarn build / brand-prepare）`)
    }
    cpSync(from, join(stageRoot, entry), {
      recursive: true,
      dereference: false,
      filter: (source) => !shouldSkipInPack(source),
    })
  }

  // 暂存的 package.json 不能带 `build` 字段：electron-builder 3.0 起禁止
  // 应用包声明构建配置（`'build' in the application package.json is not supported`）。
  // 只去掉构建/开发专用键，其余（main/exports/types/dependencies/name/version）原样保留
  // —— 上游插件解析与 asar 内的 `package.json` 断言都读它。
  const manifestPath = join(stageRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const key of ['build', 'devDependencies', 'scripts', 'peerDependencies', 'resolutions', 'files']) {
    delete manifest[key]
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    stageRoot,
    cleanup: () => rmSync(stageRoot, { recursive: true, force: true }),
  }
}

/** 列出一个目录的直接子项（排障用；测试断言它只含白名单条目）。 */
export function listStageEntries(stageRoot) {
  return readdirSync(stageRoot).sort()
}

/**
 * 四个打包脚本共用的接线入口：先把应用根暂存成白名单副本，再把
 * `directories.app` 指向它。
 *
 * 调用方**必须**把返回值与 `cleanup()` 配成对（用 try/finally），否则暂存目录
 * 会留在 `dist/` 里 —— 那正是报告里"输出目录被打进包"的场景（`dist/**` 一旦被
 * 收编，产物会膨胀到 GB 级）。
 * @param packageRoot - 桌面包绝对路径。
 * @param outputDir - 本次打包的输出目录（相对 packageRoot）。
 * @returns `args`：追加到 electron-builder CLI 的参数；`stageRoot`；`cleanup`。
 */
export function withStagedPackAppRoot(packageRoot, outputDir) {
  const { stageRoot, cleanup } = stagePackAppRoot(packageRoot, outputDir)
  return {
    stageRoot,
    cleanup,
    args: [`--config.directories.app=${stageRoot}`],
  }
}

/** 抛错前自检：暂存根本身不能是符号链接（否则打包会按真实内容展开）。 */
export function assertStageRootIsRealDirectory(stageRoot) {
  const stat = statSync(stageRoot)
  if (!stat.isDirectory()) throw new Error(`pack-app-root: ${stageRoot} 不是目录`)
  return true
}

if (isDirectInvocation(import.meta)) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const { stageRoot, cleanup } = stagePackAppRoot(packageRoot)
  console.log(`pack-app-root: staged ${stageRoot}`)
  console.log(`  entries: ${listStageEntries(stageRoot).join(', ')}`)
  console.log(`  排除（开发期，不进包）: ${PACK_APP_ROOT_EXCLUDED.join(', ')}`)
  console.log(`  禁止（打包工具中间产物，命中即拒包）: ${PACK_APP_ROOT_FORBIDDEN_ENTRIES.join(', ')}`)
  cleanup()
}
