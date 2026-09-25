/**
 * R14 C-01（P1）判据：**根上散落的 `.install-*.md` 影子绝不能让安装器删掉整个技能库**。
 *
 * 缺陷形态（真跑产品 API 复现，修复前）：
 *
 *	[3] shadows for "alpha": .install-alpha-1700000000000.md -> dir=<SKILLS DIR ITSELF>
 *	[4] sweep returned: [ '<skills>/.install-alpha-1700000000000.md' ]
 *	[5] skills root still exists? false remaining: (gone)
 *	[6] uninstallSkill => removed <skills>/alpha          ← 返回成功
 *	[7] after uninstall, skills root exists? false         ← 而 alpha、beta 与整个库一起消失
 *
 * 三条判据各看一半，拼起来就删根：
 *  ①`discoverRuntimeSkills` 忠实镜像上游 `discoverRoot`：技能库**根上散落的 `*.md`
 *    文件**也是候选技能，而它的 `dir` 就是**技能库根本身**（那里正是它的 SKILL.md）；
 *  ②`isInstallerOwnedSkillEntry` 只按名字前缀判"安装器所有"（`.install-` 开头即真）；
 *  ③老的 `sweepInstallerOwnedShadowSkills` 直接 `rm(shadow.dir, {recursive:true})`。
 *
 * 判据（本文件）：
 *  - ①`uninstallSkill` 走完产品 API 后，**技能库根与其它技能必须仍在**，被卸载的那个
 *    技能不再被运行时发现；散落文件本身被清掉（那是安装器的旧形态，该清）；
 *  - ②直接调 sweep：只删散落文件，根不动；
 *  - ③**阳性对照**：旧 staging「目录」形态（`.install-<name>-<ts>/SKILL.md`）仍必须被
 *    递归清掉 —— 否则"把删除面整个关掉"也能让①②变绿（假绿）；
 *  - ④只清目标名字的影子：别的技能的散落文件不动（删除面不许顺手扩大）。
 *
 * 变异验证（拆掉根守卫即红）：把 `removeInstallerOwnedShadow` 换回
 * `rm(shadow.dir, {recursive:true, force:true})` ⇒ ①②红（库根消失、`beta` 一起没了），
 * ③④仍绿。故意把守卫改成"什么都不删" ⇒ ③红。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverRuntimeSkills,
  sweepInstallerOwnedShadowSkills,
  uninstallSkill,
} from '../src/skill-install.ts'

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: probe skill ${name} (${marker})\n---\n\nbody ${marker}\n`
}

/** 造一个技能库根：`<root>/skills` 下两个真技能 + 一个散落 `.install-*.md` 影子。 */
async function seedLibrary(looseFor = 'alpha'): Promise<{ home: string, skillsDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'r14c01-root-guard-'))
  const skillsDir = join(home, 'skills')
  await mkdir(skillsDir, { recursive: true })
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, 'SKILL.md'), skillMd(name, 'canonical'))
  }
  await writeFile(join(skillsDir, `.install-${looseFor}-1700000000000.md`), skillMd(looseFor, 'loose'))
  return { home, skillsDir }
}

/**
 * 库里还剩哪些直接子条目（排序，便于断言）。
 *
 * 过滤掉 `.skill-locks`：per-name 文件锁目录由 `uninstallSkill` 建立（它是技能库根的
 * 合法子目录），不属于"技能/影子"的判据面。
 */
async function entriesOf(skillsDir: string): Promise<string[]> {
  return (await readdir(skillsDir)).filter(name => name !== '.skill-locks').sort((a, b) => a.localeCompare(b))
}

describe('R14 C-01：技能库根的删除守卫（散落 .install-*.md 影子）', () => {
  it('①uninstallSkill 之后：库根与其它技能仍在，散落影子被清掉', async () => {
    const { home, skillsDir } = await seedLibrary()
    try {
      // 前提：这个散落文件**真的**被判成安装器所有、且它的 dir 就是技能库根。
      const discovered = await discoverRuntimeSkills(skillsDir)
      const shadow = discovered.find(row => row.entryName.startsWith('.install-'))
      expect(shadow, '前提不成立：散落 .md 没被运行时当成候选技能').toBeDefined()
      expect(shadow?.dir).toBe(skillsDir)
      expect(shadow?.installerOwned).toBe(true)

      // 产品 API：这个技能确实是"已安装"的（真目录在），卸载返回成功。
      await expect(
        uninstallSkill(skillsDir, 'alpha', { overwrite: true, runtimeRoots: [] }),
      ).resolves.toBe(join(skillsDir, 'alpha'))

      // 判据：库根必须还在，且 `beta` 一点没动（修复前：`existsSync` 为 false）。
      expect(existsSync(skillsDir), '技能库根被整体删掉了').toBe(true)
      expect(await entriesOf(skillsDir)).toEqual(['beta'])
      expect(existsSync(join(skillsDir, 'beta', 'SKILL.md'))).toBe(true)
      // 散落影子（安装器的旧形态）该清：清掉它才是"卸载了真的不再加载"。
      expect(existsSync(join(skillsDir, '.install-alpha-1700000000000.md'))).toBe(false)
      // 运行时视角：alpha 不再被加载，beta 照旧。
      expect((await discoverRuntimeSkills(skillsDir)).map(row => row.name)).toEqual(['beta'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('②直接 sweep：只删散落文件本身，库根与其它条目不动', async () => {
    const { home, skillsDir } = await seedLibrary()
    try {
      const removed = await sweepInstallerOwnedShadowSkills(skillsDir, 'alpha')
      expect(removed).toEqual([join(skillsDir, '.install-alpha-1700000000000.md')])
      expect(existsSync(skillsDir)).toBe(true)
      expect(await entriesOf(skillsDir)).toEqual(['alpha', 'beta'])
      expect(existsSync(join(skillsDir, 'alpha', 'SKILL.md'))).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('③阳性对照：旧 staging「目录」形态仍必须被递归清掉（守卫不是"把删除关掉"）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'r14c01-staging-dir-'))
    const skillsDir = join(home, 'skills')
    try {
      await mkdir(join(skillsDir, 'alpha'), { recursive: true })
      await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), skillMd('alpha', 'canonical'))
      // ≤2.8.1 的旧 staging：**目录** `.install-<name>-XXXXXX`，根上就有 SKILL.md。
      const staging = join(skillsDir, '.install-alpha-1700000000000')
      await mkdir(staging, { recursive: true })
      await writeFile(join(staging, 'SKILL.md'), skillMd('alpha', 'staged'))

      const removed = await sweepInstallerOwnedShadowSkills(skillsDir, 'alpha')
      expect(removed).toEqual([join(staging, 'SKILL.md')])
      expect(existsSync(staging), '旧 staging 目录没被清掉 ⇒ 运行时仍会加载它').toBe(false)
      expect(existsSync(skillsDir)).toBe(true)
      expect(await entriesOf(skillsDir)).toEqual(['alpha'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('④只清目标名字的影子：别的技能的散落文件不动', async () => {
    const { home, skillsDir } = await seedLibrary('beta')
    try {
      expect(await sweepInstallerOwnedShadowSkills(skillsDir, 'alpha')).toEqual([])
      expect(existsSync(join(skillsDir, '.install-beta-1700000000000.md'))).toBe(true)
      expect(await entriesOf(skillsDir)).toEqual(['.install-beta-1700000000000.md', 'alpha', 'beta'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
