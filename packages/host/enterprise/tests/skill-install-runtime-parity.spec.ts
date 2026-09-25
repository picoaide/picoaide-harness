/**
 * R13-B P1-2 的结构性收口：**企业侧「已安装技能」集合 == 运行时真正加载的集合**。
 *
 * 旧判据（`listInstalledSkills`）只认「非点号目录 + 目录名 kebab + 有 SKILL.md」，
 * 而 pinned 上游 `discoverRoot` 按 **frontmatter 名** 认**全部直接子条目**。差集里：
 *   - `.<name>.backup-<pid>-<ts>`（≤v2.8.1 安装器写下的备份形态，根上就有完整技能）
 *     在上游**赢下注册表**（点号按 `localeCompare` 排在同名真目录之前）⇒ 模型读到旧备份
 *     内容、界面却按真目录的 `.install-version` 说"已是最新"；
 *   - `<skills>/My_Skill/`（目录名非 kebab、frontmatter 名合法）上游认、企业侧不认。
 * 后果：`uninstallSkill` 返回成功、能力中心显示未安装，**而上游仍能加载该技能**。
 *
 * 判据全部来自**真跑 pinned 上游注册表**（`tests/helpers/upstream-skill-registry.ts`），
 * 不用我们自己的规则复述；卸载那条更是逐字照 R13-B 的要求：安装 → 卸载 →
 * **再列一次运行时注册表**，断言该技能消失（不是只断言目录被删）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverRuntimeSkills,
  listInstalledSkills,
  listShadowingSkills,
  sweepInstallerOwnedShadowSkills,
  uninstallSkill,
} from '../src/skill-install.ts'
import { listRuntimeSkills } from './helpers/upstream-skill-registry.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

// R13-GH3（H2 跨根）：卸载的"成功"覆盖运行时**全部已知根**（`<dshHome>/skills` +
// `<agentsHome>/skills` + bundled），而 `<agentsHome>` 默认指向**真实 `~/.agents`** ⇒ 不隔离时
// 本文件的用例会变成"开发机上装了哪些技能"的函数（命中同名就正确地报 422 RESIDUE）。
// 隔离实现与实测形态见 tests/helpers/runtime-skill-roots.ts。
beforeEach(isolateRuntimeSkillRoots)

/** 一份合规的 SKILL.md（frontmatter 名可指定，与目录名解耦）。 */
function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function seed(dir: string, name: string, marker: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMd(name, marker))
}

/** 每种布局造一棵技能库；断言的期望值一律取自运行时注册表本身。 */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'r13gc-runtime-parity-'))
  try {
    await run(join(home, 'skills'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('R13-B P1-2：已安装集合 == 运行时集合（真跑 pinned 上游注册表）', () => {
  it('布局矩阵：每一种形态下两侧集合逐项相等（含点号备份、根上散落 .md、目录名≠frontmatter 名）', async () => {
    await withRoot(async (root) => {
      await seed(join(root, 'plain'), 'plain', 'PLAIN')                        // 正常
      await seed(join(root, '.plain.backup-4242-1700000000000'), 'plain', 'GHOST') // 旧备份（同名、点号、赢家）
      await seed(join(root, 'My_Skill'), 'my-skill', 'USER-DIRTY-NAME')          // 目录名非 kebab
      await seed(join(root, '.otherdot'), 'other-dot', 'OTHER-DOT')              // 其他点号目录（非备份形态）
      await seed(join(root, '.system'), 'system-hidden', 'SYSTEM')               // 上游 skipSystem：必须看不见
      await writeFile(join(root, 'loose.md'), skillMd('loose', 'LOOSE-FILE'))    // 根上散落 .md
      await seed(join(root, 'nested', 'deep'), 'deep', 'NESTED')                 // 直接子目录之外：看不见
      await mkdir(join(root, 'empty-dir'), { recursive: true })                  // 没有 SKILL.md
      await mkdir(join(root, 'no-desc'), { recursive: true })
      await writeFile(join(root, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\n\nbody\n') // 缺 description
      await mkdir(join(root, 'UPPER'), { recursive: true })
      await writeFile(join(root, 'UPPER', 'SKILL.md'), skillMd('UPPER-NAME', 'UPPER')) // frontmatter 名非法

      const runtime = (await listRuntimeSkills(root)).map(s => s.name).sort()
      const listed = await listInstalledSkills(root)
      console.log('[矩阵] runtime =', JSON.stringify(runtime), ' installed =', JSON.stringify(listed))
      expect(listed, '企业侧集合必须逐项等于运行时注册表').toEqual(runtime)

      // 反向：`discoverRuntimeSkills` 的行也必须与注册表一一对应（同一份判据的两种视图）。
      const rows = await discoverRuntimeSkills(root)
      expect([...new Set(rows.map(r => r.name))].sort()).toEqual(runtime)
      // 点号备份**在上游赢下注册表**（这正是"界面说最新、模型读旧备份"的机制）：
      expect(runtime).toContain('plain')
      expect((await listRuntimeSkills(root)).find(s => s.name === 'plain')?.description).toBe('GHOST')
      // `.system` 是上游唯一跳过的名字。
      expect(runtime).not.toContain('system-hidden')
    })
  })

  it('卸载判据：安装 → 卸载 → **再列运行时注册表**，该技能必须消失', async () => {
    await withRoot(async (root) => {
      await seed(join(root, 'alpha'), 'alpha', 'REAL-ALPHA')
      // 历史形态：≤2.8.1 的安装器在这个位置留下过完整备份，运行时会把它当 alpha 加载。
      await seed(join(root, '.alpha.backup-4242-1700000000000'), 'alpha', 'GHOST-BACKUP')

      const before = await listRuntimeSkills(root)
      expect(before.find(s => s.name === 'alpha')?.description, '幽灵在注册表里赢了真目录').toBe('GHOST-BACKUP')
      expect(await listInstalledSkills(root)).toEqual(['alpha'])

      const removed = await uninstallSkill(root, 'alpha', { overwrite: true })
      console.log('[卸载] removed =', removed)

      const after = await listRuntimeSkills(root)
      expect(after.some(s => s.name === 'alpha'), '运行时注册表里 alpha 必须消失（不再只是目录被删）').toBe(false)
      expect(await listInstalledSkills(root)).toEqual([])
      expect(await listShadowingSkills(root, 'alpha')).toEqual([])
    })
  })

  it('安装判据：同名备份还在时安装，运行时加载的必须是刚装的那一份', async () => {
    await withRoot(async (root) => {
      await seed(join(root, '.beta.backup-7-1700000000000'), 'beta', 'STALE-BACKUP')
      expect((await listRuntimeSkills(root)).find(s => s.name === 'beta')?.description).toBe('STALE-BACKUP')

      // 走安装器的公共入口（zip 通道）。
      const { installSkillArchive } = await import('../src/skill-install.ts')
      const AdmZip = (await import('adm-zip')).default
      const zip = new AdmZip()
      zip.addFile('SKILL.md', Buffer.from(skillMd('beta', 'FRESH-INSTALL')))
      await installSkillArchive({ name: 'beta', archive: zip.toBuffer(), skillsDir: root, version: '2.0.0', channel: 'builtin' })

      const after = await listRuntimeSkills(root)
      expect(after.find(s => s.name === 'beta')?.description, '安装后赢家必须是新装的那一份').toBe('FRESH-INSTALL')
      expect(await listInstalledSkills(root)).toEqual(['beta'])
    })
  })

  it('用户自建的同名影子：不删、不静默成功 —— 如实报 RESIDUE 并给出可行动指引', async () => {
    await withRoot(async (root) => {
      await seed(join(root, 'gamma'), 'gamma', 'STORE-COPY')
      await seed(join(root, 'My_Gamma'), 'gamma', 'USER-OWN-COPY') // 用户自建（目录名非 kebab）

      await expect(uninstallSkill(root, 'gamma', { overwrite: true }))
        .rejects.toThrow(/still loaded by the runtime from the skill root itself.*"My_Gamma"/su)
      // R19A-S2-09（2026-09-26）：判据前移到**删除之前** —— 规范落点必须原样保留
      // （旧实现是"报失败但落点已经删掉"的部分成功：用户既没得到技能，也没得到
      // "已卸载"）。用户自建那一份当然也一字不动。
      await expect(uninstallSkill(root, 'gamma', { overwrite: true })).rejects.toThrow(/nothing was removed/su)
      expect(await listInstalledSkills(root), '拒绝时落点必须还在').toEqual(['gamma'])
      const residue = await listShadowingSkills(root, 'gamma')
      expect(residue.map(r => r.entryName)).toEqual(['My_Gamma'])
      expect(residue[0]?.installerOwned).toBe(false)
      expect((await listRuntimeSkills(root)).some(s => s.name === 'gamma'), '自建影子仍被运行时加载 —— 所以不能报成功').toBe(true)
    })
  })

  it('sweepInstallerOwnedShadowSkills 只清安装器形态，不碰用户自建的同名目录', async () => {
    await withRoot(async (root) => {
      await seed(join(root, '.delta.backup-9-1700000000000'), 'delta', 'BACKUP')
      await seed(join(root, '.install-delta-abc123'), 'delta', 'LEGACY-STAGING')
      await seed(join(root, 'Delta_Own'), 'delta', 'USER-OWN')

      const removed = await sweepInstallerOwnedShadowSkills(root, 'delta')
      expect(removed.length, '两条安装器形态都必须被清掉').toBe(2)
      const left = await listShadowingSkills(root, 'delta')
      expect(left.map(r => r.entryName)).toEqual(['Delta_Own'])
      expect(left[0]?.installerOwned).toBe(false)
    })
  })
})
