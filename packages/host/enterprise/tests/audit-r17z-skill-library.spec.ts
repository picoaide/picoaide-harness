/**
 * R17 泳道 Z（客户端技能库）：五条 finding 的回归判据（R17B-01…R17B-05）。
 *
 * 判据一律取自**运行时自己的注册表**（`tests/helpers/upstream-skill-registry.ts` 真跑
 * pinned `@deepseek-ai/dsh-skill-filesystem`）或**产品入口的行为**（`installSkillArchive`
 * / `uninstallSkill` / `sweepStaleSkillTemps` / `recoverInterruptedSkillSwaps`），不钉
 * 我们自己的字面量。每条都标了变异验证的形态（拆掉修复即红）。
 *
 * 覆盖：
 *  - R17B-01（P1）符号链接条目的发现面分叉：4 形态对拍 + 卸载/安装面如实报残留 + 删除只 unlink；
 *  - R17B-02（P2）"安装器所有"删除面的可诊断性：每次删除都有记录 + 可检索日志（误删面如实登记）；
 *  - R17B-03（P2）换入崩溃窗口：旧内容副本移出清扫面 + 下次安装/卸载自愈；
 *  - R17B-04（P2）`provenance.server` 并入商店归属判据（换服务端 ⇒ 要确认 + 面板带 originServer）；
 *  - R17B-05（P2）Windows 保留设备名在**写侧**拒绝（运行时判据不动，已存在的那一份仍可列出/卸载）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config as AuthGateConfig } from '../src/auth-gate.ts'
import { assertArchiveSafe } from '../src/archive-util.ts'
import { precheckSkillPackage, PrecheckCode } from '../src/manifest-precheck.ts'
import type { Session } from '../src/server-connector/config.ts'
import {
  assertInstallableSkillName,
  classifyInstalledSkill,
  computeSkillContentHash,
  discoverRuntimeSkills,
  installSkillArchive,
  isForeignServerProvenance,
  isInstallerOwnedSkillEntry,
  isLoadableSkillName,
  isStoreProvenance,
  listInstalledSkills,
  listLocalSkills,
  listShadowingSkills,
  recoverInterruptedSkillSwaps,
  sweepInstallerOwnedShadowSkills,
  sweepStaleSkillTemps,
  uninstallSkill,
  writeProvenance,
  type SkillCleanupRecord,
} from '../src/skill-install.ts'
import { isWindowsReservedDeviceNameSegment, reservedDeviceNameInArchivePath } from '../src/skill-name-rules.ts'
import { isDelistedItem, mergeItems, needsOverwriteConfirm, planCardAction, type CapabilityItem } from '../src/client/CapabilityCenterPanel.tsx'
import { listRuntimeSkills } from './helpers/upstream-skill-registry.ts'

/** 一份合规技能（frontmatter 名可指定，与目录名解耦）。 */
function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: probe skill ${name} (${marker})\n---\n\nbody ${marker}\n`
}

/** zip 归档（安装入口的公共通道）。 */
function zipOf(name: string, marker: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(skillMd(name, marker)))
  return zip.toBuffer()
}

/** 把 mtime 拨老 n 小时（清扫阈值 24h）。 */
async function age(path: string, hoursCount: number): Promise<void> {
  const t = new Date(Date.now() - hoursCount * 3600_000)
  await utimes(path, t, t)
}

/** 造一棵技能库（`<home>/skills`）与一个库外目录。 */
async function fixture(prefix: string): Promise<{ home: string, skillsDir: string, outside: string }> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const skillsDir = join(home, 'skills')
  const outside = join(home, 'outside')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(outside, { recursive: true })
  return { home, skillsDir, outside }
}

/** 卸载/安装判定用的最小根表（不碰真实 `~/.agents`）。 */
const NO_FOREIGN_ROOTS: readonly never[] = []

// --------------------------------------------------------------------- R17B-01

describe('R17B-01：符号链接条目（运行时加载 / 企业侧镜像必须一致）', () => {
  let home: string
  let skillsDir: string
  let outside: string

  beforeEach(async () => {
    ({ home, skillsDir, outside } = await fixture('r17z-link-'))
  })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('四形态对拍：目录链接 / 散落 *.md 链接 / 断链 / 库内互链 —— 企业侧集合 == 运行时集合', async () => {
    // 1) 真实目录（对照）
    await mkdir(join(skillsDir, 'alpha'), { recursive: true })
    await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), skillMd('alpha', 'REAL'))
    // 2) 符号链接目录（指向库外）
    await mkdir(join(outside, 'ghost-skill'), { recursive: true })
    await writeFile(join(outside, 'ghost-skill', 'SKILL.md'), skillMd('ghost', 'OUTSIDE'))
    await symlink(join(outside, 'ghost-skill'), join(skillsDir, 'zlink'), 'dir')
    // 3) 根上散落 *.md 的符号链接（指向库外文件）
    await writeFile(join(outside, 'loose.md'), skillMd('loosey', 'OUTSIDE-LOOSE'))
    await symlink(join(outside, 'loose.md'), join(skillsDir, 'loosey.md'), 'file')
    // 4) 断链（悬空）
    await symlink(join(outside, 'does-not-exist'), join(skillsDir, 'dangling'), 'dir')
    // 5) 库内互链（指向同一个根里的真目录）
    await symlink(join(skillsDir, 'alpha'), join(skillsDir, 'alias-alpha'), 'dir')

    const runtime = (await listRuntimeSkills(skillsDir)).map(row => row.name).sort()
    const installed = await listInstalledSkills(skillsDir)
    console.log('[R17Z-01] runtime =', JSON.stringify(runtime), ' enterprise =', JSON.stringify(installed))
    // 判据一：集合逐项相等（这就是文件里那两条不动量的定义）
    expect(installed, '企业侧"已安装集合"必须等于运行时注册表').toEqual(runtime)
    // 断链两侧都不加载（上游 `nodeEntryKind` stat 失败即忽略）
    expect(runtime).not.toContain('dangling')
    // 判据二：链接形态必须被标出来（面板据它把「上传」换成"符号链接（只读）"）
    const rows = await discoverRuntimeSkills(skillsDir)
    const byEntry = new Map(rows.map(row => [row.entryName, row]))
    expect(byEntry.get('zlink')?.symlink).toBe(true)
    expect(byEntry.get('loosey.md')?.symlink).toBe(true)
    expect(byEntry.get('alias-alpha')?.symlink).toBe(true)
    expect(byEntry.get('alpha')?.symlink).toBe(false)
    // 判据三：链接一律**不是安装器所有**（删它 = 删用户内容）
    expect(byEntry.get('zlink')?.installerOwned).toBe(false)
    expect(byEntry.get('loosey.md')?.installerOwned).toBe(false)
    // 面板行带 symlink 标记，且库外那份的内容确实是被加载的那一份
    expect((await listLocalSkills(skillsDir)).find(row => row.name === 'ghost')?.symlink).toBe(true)
    expect((await listRuntimeSkills(skillsDir)).find(row => row.name === 'ghost')?.path)
      .toBe(join(outside, 'ghost-skill', 'SKILL.md'))
  })

  it('卸载面：库外链接影子让"卸载成功"变成 RESIDUE（不再返回成功却照旧加载）', async () => {
    await mkdir(join(outside, 'ghost-skill'), { recursive: true })
    await writeFile(join(outside, 'ghost-skill', 'SKILL.md'), skillMd('ghost', 'OUTSIDE'))
    await symlink(join(outside, 'ghost-skill'), join(skillsDir, 'alink'), 'dir')
    // 能力中心装过 ghost（规范落点 + 商店溯源）
    const dir = join(skillsDir, 'ghost')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skillMd('ghost', 'HUB'))
    await writeProvenance(dir, {
      appId: 'ghost', version: '1.0.0', channel: 'market',
      archiveChecksum: await computeSkillContentHash(dir), installedAt: '2026-09-20T00:00:00Z',
    })

    // 修复前：`listShadowingSkills` 看不见链接 ⇒ 残留为空 ⇒ 返回成功
    const residue = await listShadowingSkills(skillsDir, 'ghost')
    expect(residue.map(row => row.entryName), '链接影子必须被如实列出').toEqual(['alink'])
    // 卸载：删掉落点之后运行时会加载 alink 指向的那一份 ⇒ 必须报 RESIDUE，绝不返回成功
    await expect(uninstallSkill(skillsDir, 'ghost', { overwrite: true, runtimeRoots: NO_FOREIGN_ROOTS }))
      .rejects.toThrow(/still make the runtime load "ghost".*"alink"/su)
    // 用户的链接与库外内容一字未动
    expect(existsSync(join(skillsDir, 'alink'))).toBe(true)
    expect(existsSync(join(outside, 'ghost-skill', 'SKILL.md'))).toBe(true)
  })

  it('安装面：用户自建/链接影子赢下注册表时，安装如实报 RESIDUE（不给"已安装"的假象）', async () => {
    await mkdir(join(outside, 'ghost-skill'), { recursive: true })
    await writeFile(join(outside, 'ghost-skill', 'SKILL.md'), skillMd('ghost', 'OUTSIDE'))
    // `alink` < `ghost`（localeCompare）⇒ 链接在"同名先到先得"里赢
    await symlink(join(outside, 'ghost-skill'), join(skillsDir, 'alink'), 'dir')

    await expect(installSkillArchive({ name: 'ghost', archive: zipOf('ghost', 'HUB'), skillsDir, channel: 'market' }))
      .rejects.toThrow(/runtime still loads "alink".*symbolic link/su)
    // 内容确实写进了落点（如实说明"写了但模型读不到"），链接与库外内容仍在
    expect(await readFile(join(skillsDir, 'ghost', 'SKILL.md'), 'utf8')).toContain('HUB')
    expect(existsSync(join(skillsDir, 'alink'))).toBe(true)
    // 反向对照：影子排序在规范落点**之后**时不误报（运行时确实会加载刚装的那一份）
    await rm(join(skillsDir, 'alink'), { force: true })
    await symlink(join(outside, 'ghost-skill'), join(skillsDir, 'zlink'), 'dir')
    await expect(installSkillArchive({ name: 'ghost', archive: zipOf('ghost', 'HUB2'), skillsDir, channel: 'market', overwrite: true }))
      .resolves.toMatchObject({ name: 'ghost' })
    expect((await listRuntimeSkills(skillsDir)).find(row => row.name === 'ghost')?.description).toContain('HUB2')
  })

  it('链接伪装成安装器旧布局（`.install-*` 链接）时不删除：那是用户内容', async () => {
    await mkdir(join(outside, 'ghost-skill'), { recursive: true })
    await writeFile(join(outside, 'ghost-skill', 'SKILL.md'), skillMd('ghost', 'OUTSIDE'))
    const link = join(skillsDir, '.install-ghost-abc123')
    await symlink(join(outside, 'ghost-skill'), link, 'dir')

    expect((await discoverRuntimeSkills(skillsDir)).find(row => row.entryName === '.install-ghost-abc123')?.installerOwned)
      .toBe(false)
    expect(await sweepInstallerOwnedShadowSkills(skillsDir, 'ghost'), '链接不是安装器形态 ⇒ 不清').toEqual([])
    expect(existsSync(link)).toBe(true)
    expect(existsSync(join(outside, 'ghost-skill', 'SKILL.md'))).toBe(true)
  })

  it('删除面只 unlink：规范落点本身是链接时，库外目标目录与内容一字未动', async () => {
    const target = join(outside, 'work-copy')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), skillMd('ghost', 'WORK-COPY'))
    await writeFile(join(target, 'precious.txt'), 'KEEP')
    await symlink(target, join(skillsDir, 'ghost'), 'dir')

    // 覆盖安装：链接被换成真实目录，库外目标不动（既有行为，R17B-01 的"不写穿"要求）。
    await installSkillArchive({
      name: 'ghost', archive: zipOf('ghost', 'HUB'), skillsDir, channel: 'market', overwrite: true,
    })
    expect(await readFile(join(target, 'precious.txt'), 'utf8')).toBe('KEEP')

    // 再把落点换回链接并卸载：只 unlink 链接本身。
    await rm(join(skillsDir, 'ghost'), { recursive: true, force: true })
    await symlink(target, join(skillsDir, 'ghost'), 'dir')
    await expect(uninstallSkill(skillsDir, 'ghost', { overwrite: true, runtimeRoots: NO_FOREIGN_ROOTS }))
      .resolves.toBe(join(skillsDir, 'ghost'))
    expect(existsSync(join(skillsDir, 'ghost')), '链接本身被 unlink').toBe(false)
    expect(await readFile(join(target, 'precious.txt'), 'utf8'), '库外内容一字未动').toBe('KEEP')
  })
})

// --------------------------------------------------------------------- R17B-02

describe('R17B-02：安装器清理的可诊断性（记录 + 可检索日志 + 计数）', () => {
  let home: string
  let skillsDir: string

  beforeEach(async () => { ({ home, skillsDir } = await fixture('r17z-clean-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('24h 清扫：每条删除都有结构化记录与可检索日志（谁被删、为什么）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stale = join(skillsDir, '.skill-tmp', 'install-stale')
      await mkdir(stale, { recursive: true })
      await writeFile(join(stale, 'SKILL.md'), skillMd('x', 'STALE'))
      await age(stale, 25)
      const records: SkillCleanupRecord[] = []
      const removed = await sweepStaleSkillTemps(skillsDir, 24 * 3600_000, record => records.push(record))

      expect(removed).toBe(1)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ entryName: 'install-stale', layout: 'stale-temp', thresholdMs: 24 * 3600_000 })
      expect(records[0]?.ageMs).toBeGreaterThanOrEqual(24 * 3600_000)
      expect(records[0]?.reason, '理由里必须点名是哪种陈旧形态').toContain('.skill-tmp')
      const logged = warn.mock.calls.map(args => String(args[0])).join('\n')
      expect(logged, '删除必须留下可 grep 的一行（含条目名）').toContain('removed "install-stale"')
      expect(logged).toContain('[skill-install]')
    } finally {
      warn.mockRestore()
    }
  })

  it('同名影子清扫：日志点名条目与技能名，且返回值就是被删条目', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const legacy = join(skillsDir, '.ghost.backup-4242-1700000000000')
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, 'SKILL.md'), skillMd('ghost', 'BACKUP'))
      const removed = await sweepInstallerOwnedShadowSkills(skillsDir, 'ghost')
      expect(removed).toEqual([join(legacy, 'SKILL.md')])
      const logged = warn.mock.calls.map(args => String(args[0])).join('\n')
      expect(logged).toContain('removed installer-owned shadow ".ghost.backup-4242-1700000000000" of skill "ghost"')
    } finally {
      warn.mockRestore()
    }
  })

  it('认账（登记在案的残留）：`.install-*` 是**纯名字**判据 —— 用户自建的那种目录仍被判为安装器所有', async () => {
    // 这条**故意断言残余行为**（R17B-02 的误删面）：收窄到"能证明是安装器写的"会与
    // R14 C-01 的既有契约冲突（`skill-sweep-root-guard.spec.ts` 要求散落
    // `.install-*.md`、目录形态 `.install-<name>-<ts>/SKILL.md` 都被清掉，
    // 否则"卸载后仍加载"复发）。本轮只补可诊断性，因此把这条残留钉在测试里：
    // 谁要收窄判据，必须同时改这里、改 R14 的契约与报告 §R17B-02。
    expect(isInstallerOwnedSkillEntry('.install-notes')).toBe(true)
    expect(isInstallerOwnedSkillEntry('.install-delta-abc123')).toBe(true)
    expect(isInstallerOwnedSkillEntry('.ghost.backup-1-2')).toBe(true)
    expect(isInstallerOwnedSkillEntry('notes')).toBe(false)
  })
})

// --------------------------------------------------------------------- R17B-03

describe('R17B-03：换入崩溃窗口（旧内容副本移出清扫面 + 自愈）', () => {
  let home: string
  let skillsDir: string
  const TS = 1_700_000_000_000

  beforeEach(async () => { ({ home, skillsDir } = await fixture('r17z-crash-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('崩溃形态（backup-<name>-<ts> + 落点缺失）：清扫器不删，下一次安装自愈并留日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const backup = join(skillsDir, '.skill-tmp', `backup-notes-${TS}`)
      await mkdir(backup, { recursive: true })
      await writeFile(join(backup, 'SKILL.md'), skillMd('notes', 'ONLY-COPY'))
      await writeFile(join(backup, 'precious.txt'), 'IRREPLACEABLE')
      await age(backup, 25) // 旧实现下这一份会被 24h 清扫连它的祖先 `install-*` 一起删掉

      // 任何一次无关安装都会走恢复 + 清扫
      await installSkillArchive({ name: 'other', archive: zipOf('other', 'X'), skillsDir, channel: 'market' })

      expect(existsSync(backup), '恢复副本不得被清扫').toBe(false)
      expect(await readFile(join(skillsDir, 'notes', 'SKILL.md'), 'utf8'), '旧内容逐字回到落点').toContain('ONLY-COPY')
      expect(await readFile(join(skillsDir, 'notes', 'precious.txt'), 'utf8')).toBe('IRREPLACEABLE')
      expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('restored "notes" from an interrupted skill swap')
      // 运行时视角：恢复出来的技能照旧可加载
      expect((await listRuntimeSkills(skillsDir)).map(row => row.name)).toContain('notes')
    } finally {
      warn.mockRestore()
    }
  })

  it('落点已存在时副本作废删除（换入其实已完成），并如实记录 discarded', async () => {
    const dir = join(skillsDir, 'notes')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skillMd('notes', 'NEW'))
    const backup = join(skillsDir, '.skill-tmp', `backup-notes-${TS}`)
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'SKILL.md'), skillMd('notes', 'OLD'))

    const recovered = await recoverInterruptedSkillSwaps(skillsDir, { onlyName: 'notes' })
    expect(recovered.map(row => row.action)).toEqual(['discarded'])
    expect(existsSync(backup)).toBe(false)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8'), '落点不被旧副本覆盖').toContain('NEW')
  })

  it('升级前的旧形态（install-*/backup/）：落点缺失时同样自愈（名字从 frontmatter 认）', async () => {
    const staging = join(skillsDir, '.skill-tmp', 'install-abc123')
    await mkdir(join(staging, 'backup'), { recursive: true })
    await writeFile(join(staging, 'backup', 'SKILL.md'), skillMd('notes', 'LEGACY-ONLY-COPY'))
    await age(staging, 25)
    await installSkillArchive({ name: 'other', archive: zipOf('other', 'X'), skillsDir, channel: 'market' })
    expect(await readFile(join(skillsDir, 'notes', 'SKILL.md'), 'utf8')).toContain('LEGACY-ONLY-COPY')
    expect(existsSync(staging), '残留 staging 照旧被清扫').toBe(false)
  })

  it('orphan- 契约不变：落点缺失才放回，落点存在时永不清理', async () => {
    const orphan = join(skillsDir, '.skill-tmp', `orphan-${TS}-notes`)
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'SKILL.md'), skillMd('notes', 'ORPHAN'))
    // 落点缺失 ⇒ 放回（自愈）
    expect((await recoverInterruptedSkillSwaps(skillsDir, { onlyName: 'notes' })).map(row => row.action)).toEqual(['restored'])
    expect(existsSync(orphan)).toBe(false)
    // 再来一份 orphan，落点已存在 ⇒ 保持原样（"永不清理"）
    const orphan2 = join(skillsDir, '.skill-tmp', `orphan-${TS + 1}-notes`)
    await mkdir(orphan2, { recursive: true })
    await writeFile(join(orphan2, 'SKILL.md'), skillMd('notes', 'ORPHAN-2'))
    expect(await recoverInterruptedSkillSwaps(skillsDir, { onlyName: 'notes' })).toEqual([])
    expect(existsSync(orphan2)).toBe(true)
  })

  it('全量自愈有年龄闸门：**新鲜**的别名字副本不动（不与正在跑的换入抢）', async () => {
    // 反面判据（变异验证：把 `minAgeMs` 闸门去掉 ⇒ 这条红）：一次正常安装的换入窗口
    // 与"崩溃遗留"在盘上同形（落点暂时缺失 + 备份存在），所以全量扫描必须只碰够旧的副本。
    const fresh = join(skillsDir, '.skill-tmp', `backup-other-${Date.now()}`)
    await mkdir(fresh, { recursive: true })
    await writeFile(join(fresh, 'SKILL.md'), skillMd('other', 'LIVE-SWAP'))
    expect(await recoverInterruptedSkillSwaps(skillsDir, { minAgeMs: 10 * 60_000 })).toEqual([])
    expect(existsSync(fresh), '新鲜的副本必须原样留着（可能是另一个进程正在换入）').toBe(true)
    expect(existsSync(join(skillsDir, 'other'))).toBe(false)
    // 超过闸门之后才允许动它
    await age(fresh, 1)
    expect((await recoverInterruptedSkillSwaps(skillsDir, { minAgeMs: 10 * 60_000 })).map(row => row.action))
      .toEqual(['restored'])
    expect(await readFile(join(skillsDir, 'other', 'SKILL.md'), 'utf8')).toContain('LIVE-SWAP')
  })

  it('卸载入口同样自愈：崩溃后落点为空时不再报"未安装"', async () => {
    const backup = join(skillsDir, '.skill-tmp', `backup-notes-${TS}`)
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'SKILL.md'), skillMd('notes', 'ONLY-COPY'))
    await expect(uninstallSkill(skillsDir, 'notes', { overwrite: true, runtimeRoots: NO_FOREIGN_ROOTS }))
      .resolves.toBe(join(skillsDir, 'notes'))
    expect(existsSync(join(skillsDir, 'notes'))).toBe(false)
  })
})

// --------------------------------------------------------------------- R17B-04

describe('R17B-04：溯源的服务端维度（provenance.server 的唯一消费点）', () => {
  const MARKER = { appId: 'ghost', version: '1.0.0', channel: 'market' as const }

  it('判据矩阵：同服务端 / 换服务端 / 老标记缺 server / 尾斜杠归一 / 未传当前服务端', () => {
    const prov = { ...MARKER, server: 'https://a.example/', installedAt: '' }
    expect(isStoreProvenance(prov, 'ghost', 'https://a.example')).toBe(true)
    expect(isStoreProvenance(prov, 'ghost', 'https://b.example')).toBe(false)
    expect(isForeignServerProvenance(prov, 'https://b.example')).toBe(true)
    // 老标记（没有 server）与未传 currentServer：fail-open，保持老行为
    const legacy = { ...MARKER, installedAt: '' }
    expect(isStoreProvenance(legacy, 'ghost', 'https://b.example')).toBe(true)
    expect(isForeignServerProvenance(legacy, 'https://b.example')).toBe(false)
    expect(isStoreProvenance(prov, 'ghost')).toBe(true)
    // appId/渠道仍然是必要条件
    expect(isStoreProvenance({ ...prov, appId: 'other' }, 'ghost', 'https://a.example')).toBe(false)
    expect(isStoreProvenance({ ...prov, channel: 'user-made' as never }, 'ghost', 'https://a.example')).toBe(false)
  })

  it('覆盖安装：目标来自另一台服务端 ⇒ 409 LOCAL_CONTENT（点名那台服务端），确认后才覆盖', async () => {
    const { home, skillsDir } = await fixture('r17z-server-')
    try {
      const dir = join(skillsDir, 'ghost')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), skillMd('ghost', 'FROM-OLD-SERVER'))
      await writeProvenance(dir, {
        appId: 'ghost', version: '1.0.0', channel: 'market', server: 'https://old.example',
        archiveChecksum: await computeSkillContentHash(dir), installedAt: '2026-09-20T00:00:00Z',
      })
      expect(await classifyInstalledSkill(dir, 'ghost', 'https://new.example')).toBe('local')
      await expect(installSkillArchive({
        name: 'ghost', archive: zipOf('ghost', 'NEW'), skillsDir, channel: 'market', server: 'https://new.example',
      })).rejects.toThrow(/installed from another server \(https:\/\/old\.example.*confirm the overwrite/su)
      // 同一台服务端 ⇒ 老行为（直接更新，不多问）
      await expect(installSkillArchive({
        name: 'ghost', archive: zipOf('ghost', 'SAME'), skillsDir, channel: 'market', server: 'https://old.example',
      })).resolves.toMatchObject({ name: 'ghost' })
      // 显式确认 ⇒ 覆盖成功
      await expect(installSkillArchive({
        name: 'ghost', archive: zipOf('ghost', 'OVERWRITTEN'), skillsDir, channel: 'market',
        server: 'https://new.example', overwrite: true,
      })).resolves.toMatchObject({ name: 'ghost' })
      expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('OVERWRITTEN')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('卸载：另一台服务端装的那一份要确认（不带 serverURL 时保持老行为）', async () => {
    const { home, skillsDir } = await fixture('r17z-remove-')
    try {
      const dir = join(skillsDir, 'ghost')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), skillMd('ghost', 'FROM-OLD-SERVER'))
      await writeProvenance(dir, {
        appId: 'ghost', version: '1.0.0', channel: 'market', server: 'https://old.example',
        archiveChecksum: await computeSkillContentHash(dir), installedAt: '2026-09-20T00:00:00Z',
      })
      await expect(uninstallSkill(skillsDir, 'ghost', { runtimeRoots: NO_FOREIGN_ROOTS, serverURL: 'https://new.example' }))
        .rejects.toThrow(/deleting it removes that copy/su)
      await expect(uninstallSkill(skillsDir, 'ghost', { runtimeRoots: NO_FOREIGN_ROOTS, serverURL: 'https://old.example' }))
        .resolves.toBe(dir)
      expect(existsSync(dir)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

// --------------------------------------------------------------------- R17B-05

describe('R17B-05：Windows 保留设备名（写侧拒绝，运行时判据不动）', () => {
  it('判定矩阵：保留名各种写法命中，近似名不误杀', () => {
    for (const name of ['con', 'CON', 'Con', 'con.txt', 'nul', 'nul.md', 'aux', 'prn', 'com1', 'COM9', 'lpt1', 'LPT9', 'con.']) {
      expect(isWindowsReservedDeviceNameSegment(name), name).toBe(true)
    }
    for (const name of ['com0', 'com10', 'lpt0', 'console', 'xcon', 'con-skill', 'auxiliary', 'null']) {
      expect(isWindowsReservedDeviceNameSegment(name), name).toBe(false)
    }
    expect(reservedDeviceNameInArchivePath('assets/aux.txt')).toBe('aux.txt')
    expect(reservedDeviceNameInArchivePath('nul/SKILL.md')).toBe('nul')
    expect(reservedDeviceNameInArchivePath('assets/notes.txt')).toBeUndefined()
  })

  it('安装侧拒绝（NAME_INVALID），预检也拒绝（INVALID_APP_ID，与 Go 同码）', async () => {
    for (const name of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt1']) {
      expect(isLoadableSkillName(name), '运行时判据必须继续放行（Linux/macOS 上确实会加载）').toBe(true)
      expect(() => assertInstallableSkillName(name)).toThrow(/reserved device name on Windows/u)
    }
    const md = [
      '---',
      'name: con',
      'title: Con Skill',
      'version: 1.0.0',
      'description: A skill whose only purpose is to prove the reserved-name gate.',
      'author: someone',
      'category: tooling',
      '---',
      '',
      'This body is intentionally longer than fifty characters so the precheck body rule passes cleanly.',
      '',
    ].join('\n')
    const issues = precheckSkillPackage(md, 'con', ['SKILL.md'], 'en')
    expect(issues.map(issue => issue.code)).toEqual([PrecheckCode.InvalidAppID])
    expect(issues[0]?.message).toContain('reserved device name on Windows')

    const { home, skillsDir } = await fixture('r17z-reserved-')
    try {
      await expect(installSkillArchive({ name: 'con', archive: zipOf('con', 'X'), skillsDir }))
        .rejects.toMatchObject({ code: 'NAME_INVALID' })
      expect(existsSync(join(skillsDir, 'con'))).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('写侧 only：盘上已有的 `con` 技能仍能列出、仍能卸载（不给"看得见删不掉"）', async () => {
    const { home, skillsDir } = await fixture('r17z-reserved-remove-')
    try {
      const dir = join(skillsDir, 'con')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), skillMd('con', 'PRE-EXISTING'))
      expect(await listInstalledSkills(skillsDir)).toEqual(['con'])
      await expect(uninstallSkill(skillsDir, 'con', { overwrite: true, runtimeRoots: NO_FOREIGN_ROOTS }))
        .resolves.toBe(dir)
      expect(existsSync(dir)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('归档条目面：两条通道都拒（Windows 上解包必失败的名字）', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from(skillMd('ghost', 'X')))
    zip.addFile('assets/aux.txt', Buffer.from('boom'))
    await expect(assertArchiveSafe(zip.toBuffer())).rejects.toThrow(/reserved device name in archive entry "aux\.txt"/u)

    // tar 通道：同一判据（`assertSafeEntryPath`）
    const tarGz = (() => {
      const entry = (name: string, content: string): Buffer => {
        const header = Buffer.alloc(512)
        header.write(name, 0, 100, 'utf8')
        header.write('0000644', 100, 8, 'utf8')
        header.write('0000000', 108, 8, 'utf8')
        header.write('0000000', 116, 8, 'utf8')
        header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
        header.write('00000000000 ', 136, 12, 'utf8')
        header.write('        ', 148, 8, 'utf8')
        header.write('0', 156, 1, 'utf8')
        header.write('ustar\0', 257, 6, 'utf8')
        header.write('00', 263, 2, 'utf8')
        const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
        const body = Buffer.alloc(Math.ceil(content.length / 512) * 512)
        body.write(content, 0, 'utf8')
        return Buffer.concat([header, body])
      }
      return gzipSync(Buffer.concat([entry('SKILL.md', 'x'), entry('nul', 'y'), Buffer.alloc(1024)]))
    })()
    await expect(assertArchiveSafe(tarGz)).rejects.toThrow(/reserved device name in archive entry "nul"/u)
  })
})

// ------------------------------------------------------- R17B-04 宿主投影（真路由）

const SKILL = 'finance-report'
const SKILL_BODY = `---
name: ${SKILL}
title: 财务月报
version: 1.0.0
description: 上一台服务端装的技能(R17B-04):换服务端后它不再算"我的商店内容"。
author: someone
category: finance
---
这份技能的正文只用于回归测试,内容本身没有实际用途,长度也刻意写到足以通过发布前预检的
正文长度下限,以免夹具本身成为失败原因。
`

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'bob',
  token: 'BOB-TOKEN',
  role: 'employee',
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, host = '127.0.0.1:3080'): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      origin: `http://${host}`,
      host,
      'sec-fetch-site': 'same-origin',
      cookie: `dsh-auth-${host}=v1.signature`,
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

function harness(session: Session): { call: (url: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => true,
      getSession: () => session,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as AuthGateConfig)
  const handler = routes.find(route => route.kind === 'prefix' && route.path === '/api/pico/capabilities')?.handler
  if (handler === undefined) throw new Error('capabilities route not registered')
  return {
    call: async (url: string) => {
      const { res, read } = fakeRes()
      await handler(fakeReq(url), res)
      return read()
    },
  }
}

describe('R17B-04：能力中心投影（真 auth-gate 路由 → 真面板归并）', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r17z-projection-'))
    // `resolveSkillsDir()` = `<DSH_HOME>/skills`：不隔离就会去扫开发机真实的技能库。
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  async function seed(server: string): Promise<void> {
    const dir = join(home, 'skills', SKILL)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), SKILL_BODY, 'utf8')
    await writeProvenance(dir, {
      appId: SKILL, version: '1.0.0', channel: 'market', server,
      archiveChecksum: await computeSkillContentHash(dir), installedAt: '2026-09-20T00:00:00Z',
    })
  }

  it('换服务端后：本机行带 originServer + installedOrigin=local + 需要覆盖确认', async () => {
    await seed('https://old.example')
    const res = await harness(SESSION).call('/api/pico/capabilities?source=local')
    expect(res.code).toBe(200)
    const rows = (res.body.items ?? []) as Array<Record<string, unknown>>
    const local = rows.find(row => row.source === 'local' && row.name === SKILL)
    expect(local, '本机行必须在（扫盘得到）').toBeDefined()
    expect(local?.originServer).toBe('https://old.example')
    expect(local?.installedOrigin).toBe('local')
    const item = mergeItems([local as unknown as CapabilityItem])[0]!
    expect(item.originServer).toBe('https://old.example')
    expect(item.installedOrigin).toBe('local')
    // 面板据此出确认条（不给"直接更新"）：模型读的是上一台服务端的内容。
    expect(needsOverwriteConfirm(item), '换服务端后必须走覆盖确认条').toBe(true)
    expect(isDelistedItem(item), '不得把"另一台服务端装的"读成"已下架"').toBe(false)
  })

  it('同一台服务端（尾斜杠差异）：不带 originServer、照旧算商店内容', async () => {
    await seed('https://harness.example/')
    const res = await harness(SESSION).call('/api/pico/capabilities?source=local')
    const rows = (res.body.items ?? []) as Array<Record<string, unknown>>
    const local = rows.find(row => row.source === 'local' && row.name === SKILL)
    expect(local?.originServer).toBeUndefined()
    expect(local?.installedOrigin).toBe('store')
  })
})
