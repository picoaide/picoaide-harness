/**
 * tests/skill-staging-invisibility.spec.ts — 第四轮审计 **R4-B-2** 的回归判据。
 *
 * ## 被测的真实契约（不是我们的目录名规则）
 *
 * 随包插件（`dsh-memory-evolve`）整树换入内置技能时，会先把新内容写进一个临时目录
 * 再 `rename` 就位。第一版修复（A16）把这个临时目录改成"前导点 + 技能名"
 * （`.staging-<name>-<pid>-<ts>`），注释与回归用例都声称**上游发现器看不见点号目录**
 * —— **与 pinned 上游不符**：`@deepseek-ai/dsh-skill-filesystem` 的 `discoverRoot`
 * 遍历技能库的**全部直接子目录**、只跳过 `skipSystem && name === '.system'`，技能名
 * 取自 **frontmatter**（`isSkillName`）；同文件还按
 * `entries.sort((a, b) => a.name.localeCompare(b.name))` 排序，而
 * `'.staging-x'.localeCompare('x') < 0` ⇒ 根上的点号临时目录排在真目录**之前**、
 * 在"同名先到先得"里**赢下注册表**（随后同一轮同步删掉它 ⇒ 本次会话里该技能的
 * `path` / `resourceBase` 指向不存在的目录）。
 *
 * 因此第四轮把临时副本挪进**第二层**私有目录 `<skills>/.skill-tmp/`（与安装器的
 * `.skill-tmp/install-*` 同形）：真契约是"**只有技能库的直接子目录会被发现**"（层数），
 * 不是"目录名以点开头"。
 *
 * ## 判据为什么这样写
 *
 * 本文件**真跑 pinned 上游注册表**（`SkillRegistry` + `SkillFileSystem`，与交付态
 * 同一份已安装代码），而不是钉我们自己的目录名正则：
 *   - 反向对照（`根上形态 ⇒ 幽灵胜出`）证明这条判据**有判别力**且上游契约没变
 *     —— 上游一旦改成递归发现、或开始排除点号目录，这一条就会红（那是"契约变了、
 *     要重新判断落点"的信号，不是"我们写错了"）；
 *   - 正例（`第二层形态 ⇒ 真目录胜出`）就是 R4-B-2 的验收点。
 *
 * ## 上游包的来源（为什么是绝对路径）
 *
 * `@deepseek-ai/dsh-skill-filesystem` 在运行时 import 了它**没有声明**的
 * `@deepseek-ai/dsh-home-paths`（靠宿主包的提升解析）。企业包自身没有这个包，
 * 而 `packages/host/desktop/node_modules` 里是**同一版本**的已安装 pinned 上游副本
 * （`dsh` 运行时真正加载的那一份）—— 因此这里按绝对路径 `import()` 它，并用
 * "已安装副本的版本 === 本包 package.json 里声明的版本"作为防漂移守卫：两者一旦
 * 分叉，本用例直接报"夹具过期"，而不是静默测了别的版本。
 *
 * ---- 变异验证 ----
 *   - 把 `skills-sync.js` 的 `SKILL_TEMP_DIR` 改成 `''`（临时副本回到技能库根）
 *     ⇒ 第三条红（幽灵胜出）；
 *   - 上游升级成"递归发现"（或开始跳过点号目录）⇒ 第二条红（反向对照失效）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listInstalledSkills } from '../src/skill-install.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 宿主机（dsh-plugin-desktop）安装的 pinned 上游包目录。 */
const DESKTOP_UPSTREAM = join(HERE, '..', '..', 'desktop', 'node_modules', '@deepseek-ai')
const ENTERPRISE_PACKAGE = join(HERE, '..', 'package.json')
/** 随包同步器的真源（vendored 包；跨包 import 禁止 ⇒ 本用例**读它的源码文本**取落点）。 */
const SYNC_SOURCE = join(HERE, '..', '..', '..', 'vendor', 'memory-evolve', 'lib', 'coi', 'skills-sync.js')

const NAME = 'ghost-demo'

/**
 * 取同步器**实际会用的**换入落点（R4-B-2 的关键：本用例的夹具必须跟着真源走，
 * 否则"落点被改回技能库根"时这里仍然把幽灵摆在第二层、判据永远绿 —— 第一版就是
 * 这么写的，变异验证当场抓到）。
 *
 * 解析 `const SKILL_TEMP_DIR = '…'` 与 `const STAGING_INFIX = '…'`；找不到即 throw
 * （与 `skill-channel-parity.spec.ts` 的跨端对拍同一约定：契约改名必须让判据红，
 * 不能静默退化成"空字符串"）。
 * @returns 相对技能库根的私有临时区（可为空串 = 退回技能库根）。
 */
function stagingDirFromSyncSource(): string {
  const src = readFileSync(SYNC_SOURCE, 'utf8')
  const match = /const SKILL_TEMP_DIR = '([^']*)'/u.exec(src)
  if (match === null || match[1] === undefined) {
    throw new Error(`跨端对拍失败：在 ${SYNC_SOURCE} 里找不到 SKILL_TEMP_DIR（改契约必须同步改本用例）`)
  }
  return match[1]
}

/** 换入临时副本的名字（同样取自同步器真源）。 */
function stagingNameFromSyncSource(): string {
  const src = readFileSync(SYNC_SOURCE, 'utf8')
  const match = /const STAGING_INFIX = '([^']*)'/u.exec(src)
  if (match === null || match[1] === undefined) {
    throw new Error(`跨端对拍失败：在 ${SYNC_SOURCE} 里找不到 STAGING_INFIX（改契约必须同步改本用例）`)
  }
  return `${match[1]}${NAME}-4242-1700000000000`
}

interface UpstreamSkill { name: string, description?: string, path?: string }
interface UpstreamContext {
  plugin: (plugin: unknown, config?: unknown) => Promise<void>
  skills: { list: () => Promise<UpstreamSkill[]> }
}

/**
 * 载入**已安装的** pinned 上游运行时（技能注册表 + 文件系统 provider）。
 * @returns Cordis `Context` 构造器与两个插件。
 */
async function loadUpstream(): Promise<{ Context: new () => UpstreamContext, registry: unknown, provider: unknown }> {
  const cordis = await import(pathToFileURL(join(DESKTOP_UPSTREAM, 'cordis', 'lib', 'index.js')).href) as { Context: new () => UpstreamContext }
  const registry = await import(pathToFileURL(join(DESKTOP_UPSTREAM, 'dsh-skill', 'lib', 'index.js')).href)
  const provider = await import(pathToFileURL(join(DESKTOP_UPSTREAM, 'dsh-skill-filesystem', 'lib', 'index.js')).href)
  return { Context: cordis.Context, registry: (registry as { default: unknown }).default, provider }
}

/**
 * 用真实上游注册表索引一个技能库根。
 * @param skillsDir - `<dshHome>/skills` 的绝对路径。
 * @returns 上游 `ctx.skills.list()` 的结果。
 */
async function indexSkillRoot(skillsDir: string): Promise<UpstreamSkill[]> {
  const { Context, registry, provider } = await loadUpstream()
  const home = dirname(skillsDir)
  const ctx = new Context()
  await ctx.plugin(registry)
  await ctx.plugin(provider, { dshHome: home, agentsHome: join(home, '.agents'), watch: false })
  return await ctx.skills.list()
}

/**
 * 造一份带指定 `description` 标记的技能目录（内容不同才好分辨赢家）。
 * @param dir - 技能目录。
 * @param description - frontmatter 的 description（本用例的"谁赢了"标记）。
 */
async function seedSkill(dir: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${NAME}\ndescription: ${description}\n---\n\nbody ${description}\n`)
}

describe('R4-B-2 换入临时副本对 pinned 上游发现器不可见（真跑上游注册表）', () => {
  it('夹具防漂移：已安装的上游副本版本 === 本包声明的版本', async () => {
    const installed = JSON.parse(
      await readFile(join(DESKTOP_UPSTREAM, 'dsh-skill-filesystem', 'package.json'), 'utf8'),
    ) as { version: string }
    const declared = JSON.parse(await readFile(ENTERPRISE_PACKAGE, 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(
      installed.version,
      '本用例跑的是宿主机安装的 pinned 上游副本；它与本包声明的版本分叉时判据就测的不是交付态了',
    ).toBe(declared.dependencies['@deepseek-ai/dsh-skill-filesystem'])
  })

  it('反向对照：临时副本直接躺在技能库根上时，上游会索引它、而且是它赢（A16 的前导点形态挡不住）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'r4b-ghost-root-'))
    try {
      const skills = join(home, 'skills')
      await seedSkill(join(skills, NAME), 'REAL')
      await seedSkill(join(skills, stagingNameFromSyncSource()), 'GHOST-ROOT')
      const list = await indexSkillRoot(skills)
      const hit = list.filter(s => s.name === NAME)
      expect(hit.length, '反向对照的前提：上游会按 frontmatter 把根上的临时目录认成同名技能').toBeGreaterThan(0)
      expect(
        hit.some(s => s.description === 'GHOST-ROOT'),
        'pinned 上游对根上的点号临时目录是"先到先得 + localeCompare 排序"，点号排在真目录之前 ⇒ 幽灵赢。'
        + '本条一旦不再命中，说明上游契约变了（改成递归发现 / 排除点号目录），要重新判断临时副本的落点。',
      ).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('正例（R4-B-2 的验收点）：同步器真源给的落点下，上游只看见真目录', async () => {
    const home = await mkdtemp(join(tmpdir(), 'r4b-ghost-nested-'))
    try {
      const skills = join(home, 'skills')
      await seedSkill(join(skills, NAME), 'REAL')
      // 落点**取自同步器真源**：把 `SKILL_TEMP_DIR` 改回 ''（临时副本退回技能库根）时，
      // 幽灵就落在根上 ⇒ 本条按反向对照的同一机制变红（而不是"夹具自己也改了"）。
      const tempDir = stagingDirFromSyncSource()
      await seedSkill(join(skills, tempDir, stagingNameFromSyncSource()), 'GHOST-NESTED')
      const list = await indexSkillRoot(skills)
      const hit = list.find(s => s.name === NAME)
      expect(hit, '真目录必须被索引').toBeDefined()
      expect(
        hit?.description,
        `临时副本（${join(tempDir, stagingNameFromSyncSource())}）不得赢下同名技能：真契约是"只有直接子目录会被发现"`,
      ).toBe('REAL')
      expect(
        list.some(s => s.description === 'GHOST-NESTED'),
        '临时副本根本不该出现在注册表里',
      ).toBe(false)
      // 能力中心那一侧同样看不见它（`listInstalledSkills` 只列直接子目录）。
      expect(await listInstalledSkills(skills)).toEqual([NAME])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
