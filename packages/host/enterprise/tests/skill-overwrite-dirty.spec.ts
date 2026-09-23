/**
 * tests/skill-overwrite-dirty.spec.ts — 第四轮审计 **R4-B-3**（`dirty` 不参与任何写面
 * 闸门）与 **R4-B-4**（卸载随包技能不持久）的回归判据。真实 fs + 真实安装器 +
 * 真实的 vendored 同步器（`packages/vendor/memory-evolve/lib/coi/skills-sync.js`）。
 *
 * ## R4-B-3（P2）一次「更新」整树覆盖用户改动
 *
 * 技能从商店装好后，用户往目录里加了自己的文件（或改了正文）：面板会渲染
 * 「已本地修改」徽章，但 `requiresOverwriteConfirmation` 只看"来源"与"渠道"，
 * 不看内容是否被改过 ⇒ 「更新到 vX」单击直达、宿主整树 `rename` 换新、旧目录 `rm`，
 * 用户文件消失。判据两条：
 *   - 宿主：`dirty` 的商店技能没有 `overwrite` 一律 409 `LOCAL_CONTENT`，且文案
 *     必须点明"你改过的东西会丢"（不是那句笼统的"已存在同名内容"）；
 *   - 面板：`needsOverwriteConfirm` / `installNeedsConfirm` 在同一份 `dirty` 事实上
 *     给 true（同一份判据，不是第二套规则）。面板那一半在
 *     `capability-center-panel.spec.ts` 的 R4-B-3 组里钉住。
 *
 * ## R4-B-4（P2）卸载随包技能后下次开机又被装回来
 *
 * 能力中心对 `originChannel === 'plugin'` 的本机行给了「卸载」（纯本地删目录），
 * 而随包插件的开机同步看到落点不存在就走"首次安装"路径原样装回。修法：卸载成功
 * 之后落一个**墓碑**（`<skills>/.skill-removed/<name>.json`），同步侧读它并跳过。
 *
 * ---- 变异验证 ----
 *   - 把 `requiresOverwriteConfirmation` 的 `requiresRemoveConfirmation(...)` 那一行
 *     去掉（dirty 不参与判据）⇒ 第 1、3 条红；
 *   - 去掉 `uninstallSkill` 里的 `writeSkillTombstone` 调用 ⇒ 第 4 条红；
 *   - 去掉 `syncBuiltinSkills` 的墓碑闸门 ⇒ 第 4 条红（技能被装回来）；
 *   - 把墓碑判据放宽成"文件存在即算"⇒ 第 6 条红（坏 JSON / 别的渠道也会停掉同步）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
// @ts-expect-error vendored plain JS (no types)
import { syncBuiltinSkills, BUILTIN_SKILLS } from '../../../vendor/memory-evolve/lib/coi/skills-sync.js'
import {
  ArchiveInstallRefusal,
  clearSkillTombstone,
  computeSkillContentHash,
  installSkillArchive,
  isInstalledSkillDirty,
  readProvenance,
  requiresOverwriteConfirmation,
  requiresRemoveConfirmation,
  SKILL_REMOVED_DIR,
  uninstallSkill,
  writeProvenance,
} from '../src/skill-install.ts'

const NAME = 'zeta'
const BUNDLED = BUILTIN_SKILLS[0] as string

let root = ''
let skillsDir = ''
let pluginSkills = ''

/** 打一个最小合法归档（含 SKILL.md frontmatter + 一个受控文件）。 */
function zipOf(name: string, version: string, files: Record<string, string> = {}): Buffer {
  const zip = new AdmZip()
  for (const [rel, body] of Object.entries(files)) zip.addFile(rel, Buffer.from(body))
  zip.addFile('SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: probe ${name}\nversion: ${version}\n---\n\nbody ${version}\n`))
  return zip.toBuffer()
}

/**
 * 造一份"随包插件同步落下"的技能目录（channel: plugin），与真实同步器的落点同形。
 * @param name - 技能名。
 * @param xVersion - SKILL.md 的 x-version。
 */
async function seedPluginSkill(name: string, xVersion: number): Promise<void> {
  await mkdir(join(pluginSkills, name), { recursive: true })
  await writeFile(join(pluginSkills, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: bundled\nx-version: ${xVersion}\n---\n\nbundled body\n`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'r4b-overwrite-'))
  skillsDir = join(root, 'skills')
  pluginSkills = join(root, 'plugin-skills')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(pluginSkills, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('R4-B-3 判据本身（与面板同一份事实）', () => {
  it('商店来源 + 内容被改过 ⇒ 覆盖与删除都必须先确认；未改过则不动用户', () => {
    expect(requiresOverwriteConfirmation('store', 'market', 'market', false), '未改过的同渠道商店内容 = 正常更新').toBe(false)
    expect(requiresOverwriteConfirmation('store', 'market', 'market', true), '改过的商店内容必须先确认（R4-B-3）').toBe(true)
    expect(requiresOverwriteConfirmation('local', undefined, 'market', false)).toBe(true)
    expect(requiresOverwriteConfirmation('store', 'market', 'org', false), '换渠道仍要先确认（W4 P1-2）').toBe(true)
    expect(requiresOverwriteConfirmation(undefined, undefined, 'market', true), '目标不存在 ⇒ 不涉及覆盖').toBe(false)
    // 删除与覆盖共用"用户内容"那一半判据（不是第二套口径）。
    expect(requiresRemoveConfirmation('store', true)).toBe(true)
    expect(requiresRemoveConfirmation('store', false)).toBe(false)
    expect(requiresRemoveConfirmation('local', false)).toBe(true)
  })
})

describe('R4-B-3 宿主闸门：dirty 的商店技能不能被静默整树覆盖/删除', () => {
  const install = (version: string, opts: { overwrite?: boolean } = {}) =>
    installSkillArchive({ name: NAME, archive: zipOf(NAME, version), skillsDir, version, channel: 'market', ...opts })

  it('用户改过之后：无确认 ⇒ 409 LOCAL_CONTENT + 点名"本地修改"，文件一字未动', async () => {
    await install('1.0.0')
    const dir = join(skillsDir, NAME)
    await writeFile(join(dir, 'my-notes.md'), 'user notes\n')
    await writeFile(join(dir, 'notes.txt'), 'edited by user\n') // 归档里没有这个文件

    const prov = await readProvenance(dir)
    expect(await isInstalledSkillDirty(dir, prov), '内容哈希与安装时不一致 ⇒ dirty').toBe(true)

    const err = await install('2.0.0').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ArchiveInstallRefusal)
    expect((err as ArchiveInstallRefusal).code).toBe('LOCAL_CONTENT')
    expect(
      (err as ArchiveInstallRefusal).message,
      '文案必须点明"你改过的内容会丢"，否则用户看到徽章也猜不出后果',
    ).toMatch(/local modifications/i)
    expect(existsSync(join(dir, 'my-notes.md')), '未确认时不得动用户文件').toBe(true)
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('edited by user\n')
    expect((await readProvenance(dir))?.version, '未确认时版本不得前进').toBe('1.0.0')
  })

  it('用户确认（overwrite）⇒ 与既有语义一致：整树替换（含用户文件）', async () => {
    await install('1.0.0')
    const dir = join(skillsDir, NAME)
    await writeFile(join(dir, 'my-notes.md'), 'user notes\n')

    await install('2.0.0', { overwrite: true })

    expect(existsSync(join(dir, 'my-notes.md')), '确认后按整树替换语义，用户文件消失').toBe(false)
    expect((await readProvenance(dir))?.version).toBe('2.0.0')
    expect(await isInstalledSkillDirty(dir, await readProvenance(dir)), '覆盖后 dirty 翻假（新基准）').toBe(false)
  })

  it('未改过的商店技能照旧不打扰（同渠道更新仍然一次点击直达）', async () => {
    await install('1.0.0')
    await install('2.0.0')
    expect((await readProvenance(join(skillsDir, NAME)))?.version).toBe('2.0.0')
  })

  it('删除同理：dirty 的商店技能无确认 ⇒ 409，且文案说的是"改动会丢"', async () => {
    await install('1.0.0')
    const dir = join(skillsDir, NAME)
    await writeFile(join(dir, 'my-notes.md'), 'user notes\n')

    const refused = await uninstallSkill(skillsDir, NAME).catch((e: unknown) => e)
    expect((refused as ArchiveInstallRefusal).code).toBe('LOCAL_CONTENT')
    expect((refused as ArchiveInstallRefusal).message).toMatch(/local modifications/i)
    expect(existsSync(dir), '未确认时目录必须还在').toBe(true)

    await uninstallSkill(skillsDir, NAME, { overwrite: true })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('R4-B-4 卸载随包技能是持久终态（墓碑 + 同步侧跳过）', () => {
  /** 造一份"随包插件先前同步落下"的已装副本（含 plugin 溯源），再走真实卸载。 */
  async function installBundledThenUninstall(): Promise<string> {
    await seedPluginSkill(BUNDLED, 1)
    const res = syncBuiltinSkills(pluginSkills, skillsDir)
    expect(res.find((r: { name: string }) => r.name === BUNDLED).action).toBe('synced')
    expect((await readProvenance(join(skillsDir, BUNDLED)))?.channel).toBe('plugin')
    // 面板对 plugin 行的「卸载」= POST /api/pico/skills/:name/uninstall → uninstallSkill。
    await uninstallSkill(skillsDir, BUNDLED)
    return join(skillsDir, SKILL_REMOVED_DIR, `${BUNDLED}.json`)
  }

  it('卸载 ⇒ 墓碑落下（数据根内、与溯源同源）⇒ 下一次开机同步不再装回', async () => {
    const tombstone = await installBundledThenUninstall()
    expect(existsSync(join(skillsDir, BUNDLED)), '卸载后目录必须消失').toBe(false)
    expect(existsSync(tombstone), `墓碑必须落在技能库私有区：${SKILL_REMOVED_DIR}/${BUNDLED}.json`).toBe(true)
    const info = JSON.parse(await readFile(tombstone, 'utf8')) as { appId: string, channel: string }
    expect(info.appId).toBe(BUNDLED)
    expect(info.channel).toBe('plugin')

    // 下一次启动（同一份随包内容、同一个落点）。
    const second = syncBuiltinSkills(pluginSkills, skillsDir).find((r: { name: string }) => r.name === BUNDLED)
    expect(second.action, `有墓碑时必须如实报 skipped：${JSON.stringify(second)}`).toBe('skipped')
    expect(second.code).toBe('SKILL_USER_REMOVED')
    expect(existsSync(join(skillsDir, BUNDLED)), '卸载过的随包技能不得被开机同步装回（R4-B-4）').toBe(false)
  })

  it('反向对照：用户没卸载过的既有路径一字不变（照常同步、照常更新）', async () => {
    await seedPluginSkill(BUNDLED, 1)
    expect(syncBuiltinSkills(pluginSkills, skillsDir).find((r: { name: string }) => r.name === BUNDLED).action).toBe('synced')
    // 随包升版 ⇒ 照常整树换入（既有行为）。
    await seedPluginSkill(BUNDLED, 2)
    expect(syncBuiltinSkills(pluginSkills, skillsDir).find((r: { name: string }) => r.name === BUNDLED).action).toBe('synced')
    expect(await readFile(join(skillsDir, BUNDLED, 'SKILL.md'), 'utf8')).toContain('x-version: 2')
    // 没卸载过 ⇒ 没有墓碑。
    expect(existsSync(join(skillsDir, SKILL_REMOVED_DIR, `${BUNDLED}.json`))).toBe(false)
  })

  it('只有 plugin 渠道的卸载落墓碑：卸载商店（market）技能不留永久记录', async () => {
    await installSkillArchive({ name: NAME, archive: zipOf(NAME, '1.0.0'), skillsDir, version: '1.0.0', channel: 'market' })
    await uninstallSkill(skillsDir, NAME)
    expect(existsSync(join(skillsDir, SKILL_REMOVED_DIR, `${NAME}.json`))).toBe(false)
  })

  it('重新安装会清掉墓碑（用户的选择到此为止，不留下永久死锁）', async () => {
    const tombstone = await installBundledThenUninstall()
    expect(existsSync(tombstone)).toBe(true)
    // 用户重新安装同名技能（任何合法渠道：这里用市场那份，与真实端点同路径）。
    await installSkillArchive({ name: BUNDLED, archive: zipOf(BUNDLED, '1.0.0'), skillsDir, version: '1.0.0', channel: 'market' })
    expect(existsSync(tombstone), '安装成功后必须清掉墓碑，否则同步会永远跳过它').toBe(false)
    // 内容仍是市场版 ⇒ 同步按渠道互斥如实拒收（既有语义，不因为清墓碑就回抢）。
    const entry = syncBuiltinSkills(pluginSkills, skillsDir).find((r: { name: string }) => r.name === BUNDLED)
    expect(entry.code).toBe('SKILL_CHANNEL_CONFLICT')
    expect((await readProvenance(join(skillsDir, BUNDLED)))?.channel).toBe('market')
    // 直接清墓碑的公开入口同样幂等（面板/运维可用）。
    expect(await clearSkillTombstone(skillsDir, BUNDLED)).toBeDefined()
    expect(await clearSkillTombstone(skillsDir, BUNDLED)).toBeDefined()
  })

  it('墓碑判据从严：坏 JSON / appId 不符 / 渠道不是 plugin 一律按"没有墓碑"处理', async () => {
    await seedPluginSkill(BUNDLED, 1)
    const dir = join(skillsDir, SKILL_REMOVED_DIR)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${BUNDLED}.json`)
    const cases: Array<[string, string]> = [
      ['坏 JSON', '{ not json'],
      ['appId 不符', JSON.stringify({ appId: 'someone-else', channel: 'plugin' })],
      ['渠道不是 plugin', JSON.stringify({ appId: BUNDLED, channel: 'market' })],
    ]
    for (const [label, body] of cases) {
      await writeFile(file, body)
      const entry = syncBuiltinSkills(pluginSkills, skillsDir).find((r: { name: string }) => r.name === BUNDLED)
      expect(entry.action, `${label} 的墓碑不该生效（读不出意图 ⇒ 回到升级前行为）`).toBe('synced')
      await rm(join(skillsDir, BUNDLED), { recursive: true, force: true })
    }
    // 清理干净：墓碑目录本身不是技能目录，不会出现在已装列表里。
    expect((await readdir(skillsDir)).filter(n => !n.startsWith('.'))).toEqual([])
  })
})
