/**
 * R13-GH3 · H2「运行时发现根」的**单一真源**判据。
 *
 * 收口口径（任务给出的 (a) 方案）要求根集合"从 pinned 上游的 `discoverRoot` 派生，
 * 别手写"。本文件用**行为探针**做这件事：在每个候选根里各放一个唯一名字的技能，
 * 然后问 pinned 上游注册表到底加载了哪些 —— 加载到的根必须**恰好**是我们根表里
 * 声明的那些（含反向对照：不在表里的目录必须不被加载）。上游增删根、改 rank 或改
 * `skipSystem` 语义 ⇒ 本用例红 ⇒ `src/skill-runtime-roots.ts` 必须跟着改。
 *
 * 与 `skill-install-runtime-parity.spec.ts` 的分工：那个文件判"同一根内的集合相等"，
 * 本文件判"根的集合本身正确"。
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeSkillRoots, RUNTIME_SKILL_ROOT_RANKS } from '../src/skill-runtime-roots.ts'
import { listRuntimeSkills } from './helpers/upstream-skill-registry.ts'

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function seed(dir: string, entry: string, name: string, marker: string): Promise<void> {
  await mkdir(join(dir, entry), { recursive: true })
  await writeFile(join(dir, entry, 'SKILL.md'), skillMd(name, marker))
}

/** 造一棵临时 home（`<home>/skills` 是能力中心管的根，`<home>/.agents/skills` 是 agent 根）。 */
async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'r13gh3-roots-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('R13-GH3 H2：运行时发现根（行为探针守住与 pinned 上游的漂移）', () => {
  it('根表 = 上游实际读取的根：每个候选根放一个唯一技能，两侧集合逐项相等', async () => {
    await withHome(async (home) => {
      const skillsDir = join(home, 'skills')
      const agentsHome = join(home, '.agents')
      const bundledDir = join(home, 'bundled-skills')
      const env = { DSH_AGENTS_HOME: agentsHome, DSH_BUNDLED_SKILL_DIR: bundledDir }
      const roots = runtimeSkillRoots({ skillsDir, env, home })

      // 每个**在表里**的根各放一个唯一技能。
      await seed(skillsDir, 'from-user-dsh', 'from-user-dsh', 'USER-DSH')
      await seed(join(agentsHome, 'skills'), 'from-user-agents', 'from-user-agents', 'USER-AGENTS')
      await seed(bundledDir, 'from-bundled', 'from-bundled', 'BUNDLED')

      // 反向对照：**不在表里**的目录（上游的 project / custom 根本次没有给出
      // projectRoot/customSkillDirs，因此必须不被加载）。
      await seed(join(home, '.dsh', 'skills'), 'from-stray-dsh', 'from-stray-dsh', 'STRAY')
      await seed(join(home, 'skills-extra'), 'from-stray-extra', 'from-stray-extra', 'STRAY')
      await seed(join(agentsHome, 'skills-extra'), 'from-stray-agents', 'from-stray-agents', 'STRAY')

      const runtime = (await listRuntimeSkills(skillsDir, { agentsHome, bundledDir }))
        .map(s => s.name).sort()
      const declared = roots.map(r => r.path)
      console.log('[根表] declared =', JSON.stringify(declared))
      console.log('[根表] runtime  =', JSON.stringify(runtime))

      expect(runtime, '上游实际加载的技能必须恰好来自根表里的三个根').toEqual(
        ['from-bundled', 'from-user-agents', 'from-user-dsh'],
      )
      expect(runtime).not.toContain('from-stray-dsh')
      expect(runtime).not.toContain('from-stray-extra')
      expect(runtime).not.toContain('from-stray-agents')

      // 表本身的形状（rank / managed / skipSystem）—— 上游同源常量。
      expect(roots.map(r => [r.source, r.rank, r.managed, r.skipSystem])).toEqual([
        ['user-dsh', RUNTIME_SKILL_ROOT_RANKS.userDsh, true, true],
        ['user-agents', RUNTIME_SKILL_ROOT_RANKS.userAgents, false, false],
        ['bundled', RUNTIME_SKILL_ROOT_RANKS.bundled, false, false],
      ])
    })
  })

  it('rank 决定同名赢家：`<dshHome>/skills`(400) 赢 `<agentsHome>/skills`(500)', async () => {
    await withHome(async (home) => {
      const skillsDir = join(home, 'skills')
      const agentsHome = join(home, '.agents')
      await seed(skillsDir, 'alpha', 'alpha', 'FROM-USER-DSH')
      await seed(join(agentsHome, 'skills'), 'alpha', 'alpha', 'FROM-AGENTS')

      const winner = (await listRuntimeSkills(skillsDir, { agentsHome })).find(s => s.name === 'alpha')
      expect(winner?.description, '同一名字以 rank 小的根为赢家（上游 roots() 的 rank 序）').toBe('FROM-USER-DSH')
      // 反向：**只**在 agent 根里有的时候，运行时确实会加载它（这正是跨根缺口的可达性前提）。
      await rm(join(skillsDir, 'alpha'), { recursive: true, force: true })
      const after = (await listRuntimeSkills(skillsDir, { agentsHome })).find(s => s.name === 'alpha')
      expect(after?.description, 'agent 根里的同名技能在真目录消失后接管（卸载必须看得见它）').toBe('FROM-AGENTS')
    })
  })

  it('`skipSystem` 逐根不同：`.system` 只在 `<dshHome>/skills` 里被跳过', async () => {
    await withHome(async (home) => {
      const skillsDir = join(home, 'skills')
      const agentsHome = join(home, '.agents')
      await seed(skillsDir, '.system', 'hidden-in-dsh', 'SYSTEM-DSH')
      await seed(join(agentsHome, 'skills'), '.system', 'visible-in-agents', 'SYSTEM-AGENTS')

      const runtime = (await listRuntimeSkills(skillsDir, { agentsHome })).map(s => s.name)
      console.log('[skipSystem] runtime =', JSON.stringify(runtime))
      expect(runtime).not.toContain('hidden-in-dsh')
      expect(runtime, 'agent 根没有 skipSystem ⇒ 它的 .system 照样是候选').toContain('visible-in-agents')
    })
  })
})
