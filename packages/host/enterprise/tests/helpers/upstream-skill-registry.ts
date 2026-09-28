/**
 * 测试专用：**真跑 pinned 上游技能注册表**（`@deepseek-ai/dsh-skill-filesystem`）。
 *
 * 为什么必须有它：本仓反复出现的缺陷形态是「企业侧集合 ≠ 运行时集合」与
 * 「判据各钉自己的字面量」。只读我们自己的判据去断言，永远发现不了"界面上已安装/
 * 已卸载、而模型侧照旧加载/不加载"这一类（R13-B P1-1、P1-2 都是这么漏过去的）。
 * 所以凡是要断言"运行时到底加载了什么"，都必须用**上游自己的注册表**取得判据。
 *
 * 解析顺序：先桌面包的 `node_modules`（`nmHoistingLimits: workspaces` 下只有它
 * 装着上游包的**完整依赖闭包**），再退到本包的 `node_modules`。两份都不可 import
 * 时 **fail-loud**（不是 skip）——判据失去输入必须红。
 *
 * ## `ctx.fs` 必须一起装上（R23-W2-01，2026-09-26）
 *
 * 本 harness 原先只挂注册表、**不挂 `ctx.fs`**，于是上游 `readSkillText` 走
 * `optionalFileSystem(ctx) === undefined` 那条回落：`node:fs` 的
 * `readFile(…, 'utf8')` —— 它**永不抛错**（非法字节变 U+FFFD）。而生产形态下桌面
 * 一定装配了 `ctx.fs`（`cordis.patch.yml` 把 `fs-sandbox` 换成继承
 * `LocalFileSystem` 的 `asar-file-system`），上游因此走
 * `readSkillTextFromFileSystem` → `fs.readText` → `readWholeText`，对采样窗口里的
 * `NUL` 与整份非法 UTF-8 抛 `FS_NOT_TEXT` 并**整份丢弃**。
 *
 * 结论：不装 `ctx.fs` 的读数是**harness 的人造形态**，它让"我们接受集合 == 上游
 * 加载集合"这条双向对拍在**解码层**上整片失明（实测：同一份含 NUL 的 SKILL.md，
 * `noFs=["alpha"]` vs `withFs=[]`，而安装器/面板都读作已安装）。所以缺省就是**生产
 * 形态**（装 `dsh-fs-local`）；`fs: false` 只在需要复现"没有 fs 的宿主"这一诊断
 * 场景下使用，任何用它得出的读数都不得当作"运行时判据"。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..')

/** 上游包产物的候选根（按可用性取第一个能 import 的）。 */
const NODE_MODULE_ROOTS = [
  join(REPO_ROOT, 'packages', 'host', 'desktop', 'node_modules', '@deepseek-ai'),
  join(HERE, '..', '..', 'node_modules', '@deepseek-ai'),
]

/** 上游 `@deepseek-ai/dsh-skill-filesystem` 的 SKILL.md 候选路径（读源码用）。 */
export const UPSTREAM_SKILL_FILESYSTEM_LIBS = NODE_MODULE_ROOTS.map(root => join(root, 'dsh-skill-filesystem', 'lib', 'index.js'))

/** pinned 上游 submodule 源码（gate/本地有，server-only 检出没有）。 */
export const UPSTREAM_SKILL_FILESYSTEM_SOURCE = join(REPO_ROOT, 'deepseek-harness', 'packages', 'skill', 'skill-filesystem', 'src', 'index.ts')

/** pinned `fs-local` 源码（解码判据的真源；读源码对拍用）。 */
export const UPSTREAM_FS_LOCAL_SOURCE = join(REPO_ROOT, 'deepseek-harness', 'packages', 'fs', 'fs-local', 'src', 'fsio.ts')

export interface UpstreamSkill {
  name: string
  description?: string
  path?: string
}

interface UpstreamContext {
  plugin: (plugin: unknown, config?: unknown) => Promise<void>
  skills: { list: (options?: { cwd?: string }) => Promise<UpstreamSkill[]> }
  get: (name: string) => unknown
}

/** 生产形态要装的上游行：注册表 + `ctx.fs`（`dsh-fs-local`）。 */
const UPSTREAM_PACKAGES = ['cordis', 'dsh-skill', 'dsh-skill-filesystem', 'dsh-fs-local'] as const

let cached: {
  cordis: { Context: new () => UpstreamContext },
  registry: unknown,
  provider: unknown,
  fileSystem: unknown,
} | undefined

async function loadUpstream(): Promise<NonNullable<typeof cached>> {
  if (cached !== undefined) return cached
  const failures: string[] = []
  for (const root of NODE_MODULE_ROOTS) {
    const entry = (pkg: string): string => join(root, pkg, 'lib', 'index.js')
    if (!UPSTREAM_PACKAGES.every(pkg => existsSync(entry(pkg)))) continue
    try {
      cached = {
        cordis: await import(pathToFileURL(entry('cordis')).href) as { Context: new () => UpstreamContext },
        registry: await import(pathToFileURL(entry('dsh-skill')).href),
        provider: await import(pathToFileURL(entry('dsh-skill-filesystem')).href),
        fileSystem: (await import(pathToFileURL(entry('dsh-fs-local')).href) as { default: unknown }).default,
      }
      return cached
    } catch (error) {
      failures.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`找不到可导入的 pinned 上游技能注册表（含 ctx.fs）：无法取得运行时判据\n${failures.join('\n')}`)
}

/**
 * 用 pinned 上游注册表列出 `skillsDir` 里**运行时真正会加载**的技能。
 *
 * 与桌面运行时同形：`dshHome` = 技能库的父目录，`agentsHome` 缺省指到
 * `<home>/.agents`（与上游缺省 `join(homedir(), '.agents')` 同形，只是落在临时 home
 * 里），关掉 watcher（测试不需要文件监听）。
 *
 * R13-GH3（H2 跨根）：`agentsHome` / `bundledDir` 可显式注入 —— "运行时发现根"的
 * 行为探针要在**每个候选根**里各放一个唯一名字的技能，才能断言上游实际读了哪些根
 * （含反向对照：不在我们根表里的目录必须**不**被读取）。
 *
 * R18B-01（2026-09-25）：`cwd` 可注入 —— 上游**只在给了 cwd 时**才扫 project 根
 * （`findProjectRoot(cwd)` 向上找 `.git`），"项目根技能盖住能力中心落点"这条
 * 判定只有带 cwd 才测得出来。
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @param options - `agentsHome`/`bundledDir`/`cwd` 覆盖（缺省与生产同形）；
 *   `fs: false` = **不装** `ctx.fs`（harness 的人造形态，只用于"这个形态本来就
 *   没有 fs"的诊断对照，**不得当作运行时判据** —— 见模块头）。
 * @returns 运行时注册表内容（同名先到先得，已是赢家）。
 */
export async function listRuntimeSkills(
  skillsDir: string,
  options: { agentsHome?: string, bundledDir?: string, cwd?: string, fs?: boolean } = {},
): Promise<UpstreamSkill[]> {
  const { cordis, registry, provider, fileSystem } = await loadUpstream()
  const home = dirname(skillsDir)
  const ctx = new cordis.Context()
  await ctx.plugin((registry as { default: unknown }).default)
  // 顺序与生产装配一致：`ctx.fs` 先注册，注册表构造时 `ctx.get('fs')` 才拿得到
  // （`readSkillText` 每次读取时现取，但注册表插件也可能在加载期探测一次）。
  if (options.fs !== false) await ctx.plugin(fileSystem)
  await ctx.plugin(provider, {
    dshHome: home,
    agentsHome: options.agentsHome ?? join(home, '.agents'),
    ...options.bundledDir === undefined ? {} : { bundledSkillDir: options.bundledDir },
    watch: false,
  })
  return await ctx.skills.list(options.cwd === undefined ? undefined : { cwd: options.cwd })
}

/** {@link readViaRuntimeFileSystem} 的结论。 */
export type RuntimeFileSystemRead =
  | { readonly ok: true, readonly text: string }
  /** 读不出来：`absent` = 文件不在；`not-text` = `FS_NOT_TEXT`（运行时会整份丢弃）。 */
  | { readonly ok: false, readonly failure: 'absent' | 'not-text' | 'other', readonly message: string }

/**
 * 用**上游 `ctx.fs`**（`dsh-fs-local`）读一份文件 —— 与上游
 * `readSkillTextFromFileSystem` 里那两行**逐字同形**：
 * `fs.readText(await fs.resolve(path))`。
 *
 * 为什么单独暴露：解码层（R23-W2-01）的判据是"运行时读不读得出文本"，而这条判据
 * 只有真跑 `ctx.fs` 才取得（`readWholeText` 的两条 `FS_NOT_TEXT`）。用它可以把
 * 我们的 `decodeSkillTextBytes` 与上游实现放在**同一份语料**上逐条对拍，而不是
 * 复述"我们以为上游会怎么做"。
 * @param path - 绝对路径。
 * @returns 文本、或读不出来的成因（`FS_NOT_TEXT` 单独一档）。
 */
export async function readViaRuntimeFileSystem(path: string): Promise<RuntimeFileSystemRead> {
  const { cordis, fileSystem } = await loadUpstream()
  const ctx = new cordis.Context()
  await ctx.plugin(fileSystem)
  const fs = ctx.get('fs') as {
    resolve: (target: string) => Promise<unknown>,
    readText: (target: unknown, signal?: AbortSignal) => Promise<string>,
  } | undefined
  if (fs === undefined) throw new Error('ctx.fs 未注册：本读数不是生产形态，判据失去输入必须红')
  try {
    return { ok: true, text: await fs.readText(await fs.resolve(path)) }
  } catch (cause: unknown) {
    const code = (cause as { code?: unknown }).code
    const message = cause instanceof Error ? cause.message : String(cause)
    if (code === 'FS_NOT_TEXT') return { ok: false, failure: 'not-text', message }
    if (code === 'FS_NOT_FOUND') return { ok: false, failure: 'absent', message }
    return { ok: false, failure: 'other', message }
  }
}
