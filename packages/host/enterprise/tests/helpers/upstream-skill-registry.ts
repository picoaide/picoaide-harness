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

export interface UpstreamSkill {
  name: string
  description?: string
  path?: string
}

interface UpstreamContext {
  plugin: (plugin: unknown, config?: unknown) => Promise<void>
  skills: { list: (options?: { cwd?: string }) => Promise<UpstreamSkill[]> }
}

let cached: { cordis: { Context: new () => UpstreamContext }, registry: unknown, provider: unknown } | undefined

async function loadUpstream(): Promise<NonNullable<typeof cached>> {
  if (cached !== undefined) return cached
  const failures: string[] = []
  for (const root of NODE_MODULE_ROOTS) {
    const entry = (pkg: string): string => join(root, pkg, 'lib', 'index.js')
    if (!['cordis', 'dsh-skill', 'dsh-skill-filesystem'].every(pkg => existsSync(entry(pkg)))) continue
    try {
      cached = {
        cordis: await import(pathToFileURL(entry('cordis')).href) as { Context: new () => UpstreamContext },
        registry: await import(pathToFileURL(entry('dsh-skill')).href),
        provider: await import(pathToFileURL(entry('dsh-skill-filesystem')).href),
      }
      return cached
    } catch (error) {
      failures.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`找不到可导入的 pinned 上游技能注册表：无法取得运行时判据\n${failures.join('\n')}`)
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
 * @param options - `agentsHome`/`bundledDir`/`cwd` 覆盖（缺省与生产同形）。
 * @returns 运行时注册表内容（同名先到先得，已是赢家）。
 */
export async function listRuntimeSkills(
  skillsDir: string,
  options: { agentsHome?: string, bundledDir?: string, cwd?: string } = {},
): Promise<UpstreamSkill[]> {
  const { cordis, registry, provider } = await loadUpstream()
  const home = dirname(skillsDir)
  const ctx = new cordis.Context()
  await ctx.plugin((registry as { default: unknown }).default)
  await ctx.plugin(provider, {
    dshHome: home,
    agentsHome: options.agentsHome ?? join(home, '.agents'),
    ...options.bundledDir === undefined ? {} : { bundledSkillDir: options.bundledDir },
    watch: false,
  })
  return await ctx.skills.list(options.cwd === undefined ? undefined : { cwd: options.cwd })
}
