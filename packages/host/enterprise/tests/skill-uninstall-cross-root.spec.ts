/**
 * R13-GH3 · H2「跨根」判据：**卸载返回成功 ⇒ 运行时再列一次必须看不到该技能**。
 *
 * 上一轮（R13-B P1-2）把**同一技能库根内**的差集闭合了，但运行时发现面是**多根合并**的
 * （pinned 上游 `skill-filesystem` 的 `roots()`：`<dshHome>/skills` rank 400 →
 * `<agentsHome>/skills` rank 500 → bundled rank 600），而企业侧只拥有其中一个根。
 * V13-B 的边界探针实测到的形态（本次要闭掉的那条）：
 *
 *	[边界探针] 卸载后 runtime = [["alpha","FROM-AGENTS-ROOT"]]
 *	[边界探针] 卸载后 installed = []
 *	[边界探针] 结论：卸载返回成功 = true ｜运行时是否仍加载 alpha = true
 *
 * 判据全部来自**真跑 pinned 上游注册表**（`tests/helpers/upstream-skill-registry.ts`）：
 * 不看我们自己的规则复述，只看运行时到底加载了什么。
 *
 * 变异（拆掉跨根检查即红）：`uninstallSkill` 去掉
 * `listCrossRootSkillResidues(roots, skillsDir, name)` 那一段 ⇒ 用例 ①/②/③ 变红
 * （返回值是"成功"，而运行时注册表照旧列出 alpha）。
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveInstallRefusal, uninstallSkill } from '../src/skill-install.ts'
import { runtimeSkillRoots } from '../src/skill-runtime-roots.ts'
import { listRuntimeSkills } from './helpers/upstream-skill-registry.ts'

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function seed(root: string, entry: string, name: string, marker: string): Promise<string> {
  await mkdir(join(root, entry), { recursive: true })
  await writeFile(join(root, entry, 'SKILL.md'), skillMd(name, marker))
  return join(root, entry)
}

/** 造一棵临时 home，并把 `DSH_AGENTS_HOME`/`DSH_BUNDLED_SKILL_DIR` 指到临时目录。 */
async function withHome(
  run: (home: string, env: { agentsHome: string, bundledDir: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'r13gh3-cross-root-'))
  const agentsHome = join(home, '.agents')
  const bundledDir = join(home, 'bundled-skills')
  const savedAgents = process.env.DSH_AGENTS_HOME
  const savedBundled = process.env.DSH_BUNDLED_SKILL_DIR
  process.env.DSH_AGENTS_HOME = agentsHome
  process.env.DSH_BUNDLED_SKILL_DIR = bundledDir
  try {
    await run(home, { agentsHome, bundledDir })
  } finally {
    if (savedAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = savedAgents
    if (savedBundled === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
    else process.env.DSH_BUNDLED_SKILL_DIR = savedBundled
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * 跑一个"必须被拒绝"的调用并把拒绝原因取回来（类型安全地，不用 `catch(e => e as Error)`
 * —— 那在 `Promise<string>` 上会推出 `string | Error`，而本包没有针对 tests 的 tsc 面）。
 */
async function captureRefusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the call to be refused, but it resolved')
}

async function runtimeNames(skillsDir: string, agentsHome: string, bundledDir?: string): Promise<string[]> {
  return (await listRuntimeSkills(skillsDir, {
    agentsHome,
    ...bundledDir === undefined ? {} : { bundledDir },
  })).map(s => s.name).sort()
}

describe('R13-GH3 H2：卸载的"成功"必须覆盖全部运行时根', () => {
  it('① agent 根里有同名 ⇒ 抛 RESIDUE（点名根 + 条目），且运行时确实仍加载它', async () => {
    await withHome(async (home, { agentsHome }) => {
      const skillsDir = join(home, 'skills')
      await seed(skillsDir, 'alpha', 'alpha', 'FROM-SKILL-LIBRARY')
      const foreign = await seed(join(agentsHome, 'skills'), 'alpha', 'alpha', 'FROM-AGENTS-ROOT')
      const foreignMd = await readFile(join(foreign, 'SKILL.md'), 'utf8')

      expect(await runtimeNames(skillsDir, agentsHome)).toEqual(['alpha'])

      // 拒绝的**类型**与**文案**都要对（路由按 code 映射 HTTP 信封）。
      const failure = await captureRefusal(() => uninstallSkill(skillsDir, 'alpha', { overwrite: true }))
      console.log('[跨根①] 拒绝文案 =', failure.message)
      expect(failure).toBeInstanceOf(ArchiveInstallRefusal)
      expect((failure as ArchiveInstallRefusal).code).toBe('RESIDUE')
      // 报错必须可行动：点名条目名 + 根的路径与来源。
      expect(failure.message).toContain('"alpha" in')
      expect(failure.message).toContain(join(agentsHome, 'skills'))
      expect(failure.message).toContain('user-agents')

      // 我们的落点已按用户确认删掉，但**别的根一个字都不动**（那是别人的内容）。
      expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe(foreignMd)
      // 关键：运行时注册表**仍然**列出 alpha ⇒ 拒绝返回成功是正确的（不是假报警）。
      expect(await runtimeNames(skillsDir, agentsHome), '运行时仍加载 ⇒ 绝不能报成功').toEqual(['alpha'])
    })
  })

  it('② 别的根清掉之后，卸载成功且**运行时再列一次看不到它**（跨根同样成立的闭环）', async () => {
    await withHome(async (home, { agentsHome }) => {
      const skillsDir = join(home, 'skills')
      await seed(skillsDir, 'alpha', 'alpha', 'FROM-SKILL-LIBRARY')
      await seed(join(agentsHome, 'skills'), 'alpha', 'alpha', 'FROM-AGENTS-ROOT')

      // ① 先被拒
      await expect(uninstallSkill(skillsDir, 'alpha', { overwrite: true })).rejects.toThrow(/RESIDUE|still loads it/su)
      // 用户在 agent 根里删掉那一份（产品不替用户删），再重装 + 卸载一次
      await rm(join(agentsHome, 'skills', 'alpha'), { recursive: true, force: true })
      await seed(skillsDir, 'alpha', 'alpha', 'FROM-SKILL-LIBRARY')
      const removed = await uninstallSkill(skillsDir, 'alpha', { overwrite: true })
      console.log('[跨根②] removed =', removed)

      expect(await runtimeNames(skillsDir, agentsHome), '卸载返回成功 ⇒ 运行时再列一次必须看不到它').toEqual([])
    })
  })

  it('③ bundled 根（`$DSH_BUNDLED_SKILL_DIR`）也在面内 ⇒ 同样拒绝裸成功', async () => {
    await withHome(async (home, { agentsHome, bundledDir }) => {
      const skillsDir = join(home, 'skills')
      await seed(skillsDir, 'gamma', 'gamma', 'FROM-SKILL-LIBRARY')
      await seed(bundledDir, 'gamma', 'gamma', 'FROM-BUNDLED-ROOT')

      const failure = await captureRefusal(() => uninstallSkill(skillsDir, 'gamma', { overwrite: true }))
      console.log('[跨根③] 拒绝文案 =', failure.message)
      expect(failure.message).toContain(bundledDir)
      expect(failure.message).toContain('bundled')
      expect(await runtimeNames(skillsDir, agentsHome, bundledDir)).toEqual(['gamma'])
    })
  })

  it('④ 没有跨根残留时不得误报（根表里没有同名 ⇒ 成功）', async () => {
    await withHome(async (home, { agentsHome }) => {
      const skillsDir = join(home, 'skills')
      await seed(skillsDir, 'delta', 'delta', 'ONLY-HERE')
      await seed(join(agentsHome, 'skills'), 'other', 'other', 'UNRELATED')
      const removed = await uninstallSkill(skillsDir, 'delta', { overwrite: true })
      expect(removed).toBe(join(skillsDir, 'delta'))
      expect(await runtimeNames(skillsDir, agentsHome)).toEqual(['other'])
    })
  })

  it('⑤ 根表本身：`runtimeSkillRoots` 把 agent/bundled 根都算进"已知根"（不是手写的一根）', async () => {
    await withHome(async (home, { agentsHome, bundledDir }) => {
      const skillsDir = join(home, 'skills')
      const roots = runtimeSkillRoots({ skillsDir })
      console.log('[根表⑤] =', JSON.stringify(roots.map(r => [r.source, r.path, r.managed])))
      expect(roots.map(r => r.source)).toEqual(['user-dsh', 'user-agents', 'bundled'])
      expect(roots.filter(r => r.managed).map(r => r.path)).toEqual([skillsDir])
      expect(roots.find(r => r.source === 'user-agents')?.path).toBe(join(agentsHome, 'skills'))
      expect(roots.find(r => r.source === 'bundled')?.path).toBe(bundledDir)
    })
  })
})
