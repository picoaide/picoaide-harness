/**
 * R18A-SK-01 / 02 / 03（2026-09-25 第十八轮审计 · 泳道 A，修复泳道 P18 收口）：
 *
 *  - **SK-01 [P1]**：第十七轮新增的换入自愈（`recoverInterruptedSkillSwaps`）对
 *    `.skill-tmp/<entry>`（乃至 `<entry>/backup`）直接 `rm(recursive)` / `rename`，而路径
 *    **穿过符号链接父目录** ⇒ **递归删除库外目录** / **把库外目录搬进技能库**，两个真入口
 *    （`installSkillArchive` / `uninstallSkill`）都 `err=undefined` 静默成功 —— 与
 *    R17B-01 自己的不变量"链接只 unlink、库外一字不动"正面矛盾。
 *  - **SK-02 [P1]**：同一 `settle` 的判据分裂（`existsSync` 跟随链接 vs `rename` 不跟随末段）：
 *    落点是**断链**时判"缺失"→ `rename` 报错被吞 → 仍 `return true` ⇒ 调用方把 staging
 *    整棵删掉，**连带销毁旧内容的最后一份副本**（静默数据丢失）。
 *  - **SK-03 [P2]**：`provenance.server` 缺失（老标记）时 `isForeignServerProvenance` 返回
 *    false ⇒ 换服务端后安装**静默整树替换**、卸载**静默删除**、面板 `needsConfirm=false`。
 *
 * 修法：所有自愈/清扫的路径先过 `realDirectoryUnderLibrary` 的**逐段真实目录断言**（唯一实现，
 * 锚定在库根 realpath 上），落点形态一律 `lstat` 判（真实目录 + 真实 `SKILL.md` 才算"已就位"），
 * 任何一条不成立就**一个字都不动**并留痕；`settle` 只在真的动过时返回 true（调用方据此决定
 * 能不能销毁 staging）。来源面新增 `provenanceServerVerdict` 三档判定（`unknown` 也按"不是
 * 当前服务端的"处理，文案点名"没有记录来源服务端"）。
 *
 * 变异（逐条实跑见 temp/r18/P/REPORT.md）：
 *  - 去掉 `realDirectoryUnderLibrary` 的逐段断言（改回 `join`）⇒ SK-01 全组变红；
 *  - `settle` 的落点判据改回 `existsSync` / 失败也返回 true ⇒ SK-02 组变红；
 *  - `provenanceServerVerdict` 的 `unknown` 分支改回 `'same'` ⇒ SK-03 组变红。
 */
import { existsSync } from 'node:fs'
import { lstat, lutimes, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  classifyInstalledSkill,
  installSkillArchive,
  isForeignServerProvenance,
  isStoreProvenance,
  provenanceServerVerdict,
  recoverInterruptedSkillSwaps,
  sweepStaleSkillTemps,
  uninstallSkill,
  writeProvenance,
  type SkillProvenance,
} from '../src/skill-install.ts'
import { fakeReq, fakeRes, harness, stubGateway } from './helpers/auth-gate-harness.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: probe ${name} (${marker})\n---\n\nbody ${marker}\n`
}

function zipOf(name: string, marker: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(skillMd(name, marker)))
  return zip.toBuffer()
}

/**
 * 一台"库 + 库外金库"的场景：`<root>/skills/.skill-tmp` 已建好，
 * `<root>/vault/hollow/backup/` 里放着库外的唯一副本与兄弟文件。
 */
async function scene(): Promise<{ root: string, skills: string, vault: string, hollow: string }> {
  const root = await mkdtemp(join(tmpdir(), 'r18ask-scene-'))
  roots.push(root)
  const skills = join(root, 'skills')
  const vault = join(root, 'vault')
  const hollow = join(vault, 'hollow')
  await mkdir(join(skills, '.skill-tmp'), { recursive: true })
  await mkdir(join(hollow, 'backup'), { recursive: true })
  await writeFile(join(vault, 'precious.txt'), 'PRECIOUS\n')
  await writeFile(join(hollow, 'backup', 'SKILL.md'), skillMd('victim', 'LEGACY'))
  await writeFile(join(hollow, 'backup', 'only-copy.txt'), 'ONLY-COPY-OF-USER-DATA\n')
  await writeFile(join(hollow, 'sibling.txt'), 'SIBLING\n')
  return { root, skills, vault, hollow }
}

/** 库外的唯一副本还完整吗（SK-01 的统一判据）。 */
async function outsideIntact(hollow: string): Promise<boolean> {
  return await readFile(join(hollow, 'backup', 'only-copy.txt'), 'utf8')
    .then(text => text === 'ONLY-COPY-OF-USER-DATA\n')
    .catch(() => false)
}

describe('R18A-SK-01：自愈/清扫绝不穿过库内符号链接（库外一字不动）', () => {
  it('① 落点已存在 + `.skill-tmp/install-*` 是库外链接 ⇒ 库外目录不被递归删除', async () => {
    const s = await scene()
    await mkdir(join(s.skills, 'victim'), { recursive: true })
    await writeFile(join(s.skills, 'victim', 'SKILL.md'), skillMd('victim', 'CANON'))
    const link = join(s.skills, '.skill-tmp', 'install-legacy')
    await symlink(s.hollow, link, 'dir')

    const out = await recoverInterruptedSkillSwaps(s.skills, {})
    console.log('[SK-01①] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(await outsideIntact(s.hollow), '库外唯一副本必须还在（修前被 rm -r 删掉）').toBe(true)
    expect(existsSync(join(s.hollow, 'sibling.txt')), '库外兄弟文件必须还在').toBe(true)
    expect(existsSync(join(s.vault, 'precious.txt'))).toBe(true)
    // 链接本身也不动（那是别人放的东西）。
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('② 落点缺失 + 库外链接 ⇒ 库外目录不被搬进技能库', async () => {
    const s = await scene()
    await symlink(s.hollow, join(s.skills, '.skill-tmp', 'install-legacy'), 'dir')

    const out = await recoverInterruptedSkillSwaps(s.skills, {})
    console.log('[SK-01②] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(await outsideIntact(s.hollow), '库外唯一副本必须还在（修前被 rename 搬走）').toBe(true)
    await expect(lstat(join(s.skills, 'victim'))).rejects.toThrow()
  })

  it('③ 真安装入口（**年龄闸门放行**）触发同一路径 ⇒ 库外唯一副本仍在', async () => {
    isolateRuntimeSkillRoots()
    const s = await scene()
    await mkdir(join(s.skills, 'victim'), { recursive: true })
    await writeFile(join(s.skills, 'victim', 'SKILL.md'), skillMd('victim', 'CANON'))
    const link = join(s.skills, '.skill-tmp', 'install-legacy')
    await symlink(s.hollow, link, 'dir')
    // 安装入口的**全量**扫描带 10 分钟年龄闸门（只处理足够旧的遗留）⇒ 不拨老就测不到那条路
    // （审计的 A1b-3 正是这么"绿"的；A1b-9 拨老后才是真判据）。
    const old = new Date(Date.now() - 48 * 3600_000)
    await lutimes(link, old, old).catch(() => utimes(link, old, old))

    await installSkillArchive({
      name: 'unrelated', archive: zipOf('unrelated', 'X'), skillsDir: s.skills, version: '1.0.0', channel: 'market',
    })
    expect(await outsideIntact(s.hollow)).toBe(true)
    expect(existsSync(join(s.hollow, 'sibling.txt'))).toBe(true)
  })

  it('④ 真卸载入口（onlyName）触发同一路径 ⇒ 库外唯一副本仍在', async () => {
    isolateRuntimeSkillRoots()
    const s = await scene()
    await mkdir(join(s.skills, 'victim'), { recursive: true })
    await writeFile(join(s.skills, 'victim', 'SKILL.md'), skillMd('victim', 'CANON'))
    await symlink(s.hollow, join(s.skills, '.skill-tmp', 'install-legacy'), 'dir')

    await uninstallSkill(s.skills, 'victim', { overwrite: true })
    expect(await outsideIntact(s.hollow)).toBe(true)
  })

  it('⑤ `.skill-tmp` 本身是库外链接 ⇒ 整块自愈放弃，库外 install-*/backup 完好', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r18ask-tmplink-'))
    roots.push(root)
    const skills = join(root, 'skills')
    const vault = join(root, 'vault')
    await mkdir(skills, { recursive: true })
    await mkdir(join(vault, 'install-legacy', 'backup'), { recursive: true })
    await writeFile(join(vault, 'install-legacy', 'backup', 'SKILL.md'), skillMd('victim', 'X'))
    await writeFile(join(vault, 'install-legacy', 'backup', 'only-copy.txt'), 'ONLY-COPY\n')
    await symlink(vault, join(skills, '.skill-tmp'), 'dir')
    await mkdir(join(skills, 'victim'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'CANON'))

    await recoverInterruptedSkillSwaps(skills, {})
    expect(existsSync(join(vault, 'install-legacy', 'backup', 'only-copy.txt')), '库外副本必须还在').toBe(true)
    expect((await lstat(join(skills, '.skill-tmp'))).isSymbolicLink(), '链接本身不动').toBe(true)
  })

  it('⑥ 同族的清扫面：`.skill-tmp` 是库外链接时，陈旧 staging 清扫不越界', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r18ask-sweeplink-'))
    roots.push(root)
    const skills = join(root, 'skills')
    const vault = join(root, 'vault')
    await mkdir(skills, { recursive: true })
    await mkdir(join(vault, 'install-stale'), { recursive: true })
    await writeFile(join(vault, 'install-stale', 'SKILL.md'), skillMd('stale', 'X'))
    await writeFile(join(vault, 'install-stale', 'user-notes.txt'), 'USER-NOTES\n')
    await symlink(vault, join(skills, '.skill-tmp'), 'dir')
    const old = new Date(Date.now() - 48 * 3600_000)
    await utimes(join(vault, 'install-stale'), old, old)

    const removed = await sweepStaleSkillTemps(skills, 24 * 3600_000)
    console.log('[SK-01⑥] removed =', removed)
    expect(await readFile(join(vault, 'install-stale', 'user-notes.txt'), 'utf8'), '库外目录必须还在').toBe('USER-NOTES\n')
    expect(removed, '越界的一律不计入清理数').toBe(0)
  })

  it('⑦ 反向对照：真实的崩溃形态仍能被正确自愈（修复没有把功能关掉）', async () => {
    const s = await scene()
    const backup = join(s.skills, '.skill-tmp', `backup-victim-${Date.now()}`)
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'SKILL.md'), skillMd('victim', 'REAL-BACKUP'))
    await writeFile(join(backup, 'extra.txt'), 'EXTRA\n')

    const out = await recoverInterruptedSkillSwaps(s.skills, { onlyName: 'victim' })
    console.log('[SK-01⑦] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(out.map(row => row.action)).toEqual(['restored'])
    expect((await readdir(join(s.skills, 'victim'))).sort()).toEqual(['SKILL.md', 'extra.txt'])
  })

  it('⑧ 反向对照：副本是**符号链接**时拒收（不把链接提升为落点，库里不出现指向库外的技能）', async () => {
    const s = await scene()
    const stolen = join(s.vault, 'stolen')
    await mkdir(stolen, { recursive: true })
    await writeFile(join(stolen, 'SKILL.md'), skillMd('victim', 'STOLEN'))
    await writeFile(join(stolen, 'user-data.txt'), 'USER-DATA-OUTSIDE\n')
    await symlink(stolen, join(s.skills, '.skill-tmp', `backup-victim-${Date.now()}`), 'dir')

    const out = await recoverInterruptedSkillSwaps(s.skills, { onlyName: 'victim' })
    console.log('[SK-01⑧] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(out, '链接形态的副本不参与自愈').toEqual([])
    await expect(lstat(join(s.skills, 'victim')), '库里不出现指向库外的技能').rejects.toThrow()
    expect(await readFile(join(stolen, 'user-data.txt'), 'utf8')).toBe('USER-DATA-OUTSIDE\n')
  })
})

describe('R18A-SK-02：落点是断链时不得销毁旧内容的最后一份副本', () => {
  it('① 断链落点 + `backup-<name>-<ts>` 唯一副本 ⇒ 副本保留（修前被判 restored 后 staging 一起删）', async () => {
    const s = await scene()
    const backup = join(s.skills, '.skill-tmp', `backup-victim-${Date.now()}`)
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'SKILL.md'), skillMd('victim', 'ONLY-COPY'))
    // 落点是**断链**（existsSync=false，rename 会 ENOTDIR/EEXIST）
    await symlink(join(s.root, 'nowhere'), join(s.skills, 'victim'), 'dir')

    const out = await recoverInterruptedSkillSwaps(s.skills, { onlyName: 'victim' })
    console.log('[SK-02①] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(out, '没有真的恢复成功就不许报成 restored').toEqual([])
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8'), '唯一副本必须原样保留').toContain('ONLY-COPY')
  })

  it('② 断链落点 + 旧布局 `install-*/backup` ⇒ staging 残骸不被销毁（副本仍在）', async () => {
    const s = await scene()
    const staging = join(s.skills, '.skill-tmp', 'install-crashed')
    await mkdir(join(staging, 'backup'), { recursive: true })
    await writeFile(join(staging, 'backup', 'SKILL.md'), skillMd('victim', 'ONLY-COPY'))
    await writeFile(join(staging, 'backup', 'only-copy.txt'), 'LAST-COPY\n')
    await symlink(join(s.root, 'nowhere'), join(s.skills, 'victim'), 'dir')

    const out = await recoverInterruptedSkillSwaps(s.skills, { onlyName: 'victim' })
    console.log('[SK-02②] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(out).toEqual([])
    expect(await readFile(join(staging, 'backup', 'only-copy.txt'), 'utf8'), 'staging 不得被 rm -r').toBe('LAST-COPY\n')
  })

  it('④ 落点是**普通目录但没有 SKILL.md**（占位目录）⇒ 旧内容副本不得被当作废品删掉', async () => {
    const s = await scene()
    // 落点是个真实目录，但里面没有 SKILL.md（不是一份可用的技能）。
    await mkdir(join(s.skills, 'victim'), { recursive: true })
    await writeFile(join(s.skills, 'victim', 'NOTES.md'), 'user notes\n')
    const backup = join(s.skills, '.skill-tmp', `backup-victim-${Date.now()}`)
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'SKILL.md'), skillMd('victim', 'ONLY-COPY'))
    await writeFile(join(backup, 'only-copy.txt'), 'LAST-COPY\n')

    const out = await recoverInterruptedSkillSwaps(s.skills, { onlyName: 'victim' })
    console.log('[SK-02④] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(out, '没就位的落点不许把副本判成废品').toEqual([])
    expect(await readFile(join(backup, 'only-copy.txt'), 'utf8'), '唯一副本必须保留').toBe('LAST-COPY\n')
    expect(await readFile(join(s.skills, 'victim', 'NOTES.md'), 'utf8'), '落点里的用户笔记一字不动').toBe('user notes\n')
  })

  it('③ 反向对照：落点是**已就位的技能目录**（真目录 + 真 SKILL.md）⇒ 副本作废删除', async () => {
    const s = await scene()
    await mkdir(join(s.skills, 'victim'), { recursive: true })
    await writeFile(join(s.skills, 'victim', 'SKILL.md'), skillMd('victim', 'INSTALLED'))
    const backup = join(s.skills, '.skill-tmp', `backup-victim-${Date.now()}`)
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'SKILL.md'), skillMd('victim', 'STALE-COPY'))

    const out = await recoverInterruptedSkillSwaps(s.skills, { onlyName: 'victim' })
    console.log('[SK-02③] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    expect(out.map(row => row.action)).toEqual(['discarded'])
    await expect(lstat(backup)).rejects.toThrow()
    expect(await readFile(join(s.skills, 'victim', 'SKILL.md'), 'utf8')).toContain('INSTALLED')
  })
})

const SERVER_A = 'https://a.example.com'
const SERVER_B = 'https://b.example.com'

function marker(over: Partial<SkillProvenance> = {}): SkillProvenance {
  return { appId: 'victim', version: '1.0.0', channel: 'market', installedAt: '2026-01-01T00:00:00Z', ...over }
}

async function library(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r18ask-prov-'))
  roots.push(root)
  const skills = join(root, 'skills')
  await mkdir(skills, { recursive: true })
  return skills
}

describe('R18A-SK-03：老标记（没有 server）按"来源未知"处理，不再 fail-open', () => {
  it('① 判据矩阵：unknown / foreign / same / not-compared / bundled 五档', () => {
    expect(provenanceServerVerdict(marker(), SERVER_B), '老标记 = 来源未知').toBe('unknown')
    expect(provenanceServerVerdict(marker({ server: '' }), SERVER_B), '空串 = 来源未知').toBe('unknown')
    expect(provenanceServerVerdict(marker({ server: `  ${SERVER_A}  ` }), SERVER_A), '空白与尾斜杠归一').toBe('same')
    expect(provenanceServerVerdict(marker({ server: SERVER_A }), SERVER_B)).toBe('foreign')
    expect(provenanceServerVerdict(marker({ server: SERVER_A }), undefined), '未传当前服务端 = 不比较').toBe('not-compared')
    expect(provenanceServerVerdict(marker({ channel: 'plugin' }), SERVER_B), '随包标记没有来源服务端概念').toBe('bundled')

    // 消费面：unknown 不再算"当前服务端的商店内容"，但 plugin 标记不受影响（不误伤随包技能）。
    expect(isStoreProvenance(marker(), 'victim', SERVER_B)).toBe(false)
    expect(isForeignServerProvenance(marker(), SERVER_B)).toBe(true)
    expect(isStoreProvenance(marker({ channel: 'plugin' }), 'victim', SERVER_B)).toBe(true)
    expect(isStoreProvenance(marker({ server: SERVER_A }), 'victim', SERVER_A)).toBe(true)
  })

  it('② 真安装入口：老标记 + 当前是另一台服务端 ⇒ 409 且文案点名"没有记录来源服务端"', async () => {
    isolateRuntimeSkillRoots()
    const skills = await library()
    await installSkillArchive({
      name: 'victim', archive: zipOf('victim', 'FROM-A'), skillsDir: skills, version: '1.0.0', channel: 'market', server: SERVER_A,
    })
    // 模拟"老客户端写的标记"：抹掉 server 字段（2026-09-01 之前的形态）。
    await writeProvenance(join(skills, 'victim'), marker({ version: '1.0.0' }))
    expect(await classifyInstalledSkill(join(skills, 'victim'), 'victim', SERVER_B)).toBe('local')

    const failure = await installSkillArchive({
      name: 'victim', archive: zipOf('victim', 'FROM-B'), skillsDir: skills, version: '2.0.0', channel: 'market', server: SERVER_B,
    }).then(() => undefined, (cause: unknown) => cause as Error)
    console.log('[SK-03②] 拒绝 =', failure?.message)
    expect((failure as ArchiveInstallRefusal | undefined)?.code).toBe('LOCAL_CONTENT')
    expect(failure?.message).toMatch(/does not record which server it came from/su)
    expect(failure?.message).not.toMatch(/your own files/su)
    // 内容一字未动（静默整树替换已不可能）。
    expect(await readFile(join(skills, 'victim', 'SKILL.md'), 'utf8')).toContain('FROM-A')
  })

  it('③ 真卸载入口：老标记 ⇒ 409（不再静默删除），显式确认后才删', async () => {
    isolateRuntimeSkillRoots()
    const skills = await library()
    await installSkillArchive({
      name: 'victim', archive: zipOf('victim', 'FROM-A'), skillsDir: skills, version: '1.0.0', channel: 'market', server: SERVER_A,
    })
    await writeProvenance(join(skills, 'victim'), marker({ version: '1.0.0' }))

    const failure = await uninstallSkill(skills, 'victim', { serverURL: SERVER_B })
      .then(() => undefined, (cause: unknown) => cause as Error)
    console.log('[SK-03③] 拒绝 =', failure?.message)
    expect((failure as ArchiveInstallRefusal | undefined)?.code).toBe('LOCAL_CONTENT')
    expect(failure?.message).toMatch(/does not record which server it came from/su)
    expect(existsSync(join(skills, 'victim', 'SKILL.md')), '拒绝时不得删除').toBe(true)
    // 显式确认 ⇒ 真的删掉。
    await expect(uninstallSkill(skills, 'victim', { serverURL: SERVER_B, overwrite: true })).resolves.toBe(join(skills, 'victim'))
  })

  it('④ 反向对照：同一台服务端不多问（修复不得造成"全量都要确认"）', async () => {
    isolateRuntimeSkillRoots()
    const skills = await library()
    await installSkillArchive({
      name: 'victim', archive: zipOf('victim', 'V1'), skillsDir: skills, version: '1.0.0', channel: 'market', server: SERVER_A,
    })
    await expect(installSkillArchive({
      name: 'victim', archive: zipOf('victim', 'V2'), skillsDir: skills, version: '2.0.0', channel: 'market', server: SERVER_A,
    })).resolves.toMatchObject({ name: 'victim' })
    await expect(uninstallSkill(skills, 'victim', { serverURL: SERVER_A })).resolves.toBe(join(skills, 'victim'))
  })

  it('⑤ 反向对照：随包（plugin）标记不带 server，但卸载/覆盖**不**因此要求确认', async () => {
    isolateRuntimeSkillRoots()
    const skills = await library()
    await mkdir(join(skills, 'victim'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'BUNDLED'))
    await writeProvenance(join(skills, 'victim'), marker({ channel: 'plugin', version: '1.0.0' }))

    expect(await classifyInstalledSkill(join(skills, 'victim'), 'victim', SERVER_B)).toBe('store')
    await expect(uninstallSkill(skills, 'victim', { serverURL: SERVER_B })).resolves.toBe(join(skills, 'victim'))
  })
})

describe('R18A-SK-03 ⑥：面板投影（真 auth-gate 路由）——老标记必须显示成"要确认"', () => {
  const SESSION = {
    serverURL: SERVER_B,
    username: 'alice',
    token: 'USER-TOKEN-abc',
    role: 'employee' as const,
  }
  let home: string

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('老标记（无 server）+ 当前是另一台服务端 ⇒ 面板行的 installedOrigin = local（needsConfirm=true）', async () => {
    isolateRuntimeSkillRoots()
    home = await mkdtemp(join(tmpdir(), 'r18ask-panel-'))
    vi.stubEnv('DSH_HOME', home)
    const skillsDir = join(home, 'skills')
    await mkdir(join(skillsDir, 'victim'), { recursive: true })
    await writeFile(join(skillsDir, 'victim', 'SKILL.md'), skillMd('victim', 'FROM-OLD-CLIENT'))
    await writeProvenance(join(skillsDir, 'victim'), marker({ version: '1.0.0' }))

    const h = harness(SESSION)
    stubGateway(h, Buffer.from(''))
    const { res, read } = fakeRes()
    await h.handler('/api/pico/capabilities')(fakeReq('GET', '/api/pico/capabilities?source=local'), res)
    const rows = (read().body.items ?? []) as Array<Record<string, unknown>>
    const local = rows.find(row => row.source === 'local' && row.name === 'victim')
    console.log('[SK-03⑥] 面板行 =', JSON.stringify(local))
    expect(read().code).toBe(200)
    expect(local?.installedOrigin, '老标记不再算"当前服务端的商店内容" ⇒ 面板要确认').toBe('local')
  })

  it('反向对照：带当前服务端的标记 ⇒ installedOrigin = store（不多问）', async () => {
    isolateRuntimeSkillRoots()
    home = await mkdtemp(join(tmpdir(), 'r18ask-panel2-'))
    vi.stubEnv('DSH_HOME', home)
    const skillsDir = join(home, 'skills')
    await mkdir(join(skillsDir, 'victim'), { recursive: true })
    await writeFile(join(skillsDir, 'victim', 'SKILL.md'), skillMd('victim', 'FROM-THIS-SERVER'))
    await writeProvenance(join(skillsDir, 'victim'), marker({ version: '1.0.0', server: SERVER_B }))

    const h = harness(SESSION)
    stubGateway(h, Buffer.from(''))
    const { res, read } = fakeRes()
    await h.handler('/api/pico/capabilities')(fakeReq('GET', '/api/pico/capabilities?source=local'), res)
    const rows = (read().body.items ?? []) as Array<Record<string, unknown>>
    const local = rows.find(row => row.source === 'local' && row.name === 'victim')
    console.log('[SK-03⑥/反向] 面板行 =', JSON.stringify(local))
    expect(local?.installedOrigin).toBe('store')
  })
})
