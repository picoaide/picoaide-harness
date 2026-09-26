/**
 * tests/skill-tombstone-anchor.spec.ts — R21-A1-03 的仓内回归判据。
 *
 * ## 缺陷原形态（零竞态、无特权）
 *
 * 技能库里有三个**库内私有目录**（`.skill-tmp` / `.skill-removed` / `.skill-locks`），
 * 只有 `.skill-tmp` 进了"逐段锚定 + 紧邻 syscall 复检"那套判据。另两个是**多段**
 * 路径且未锚定：
 *
 *  - `<skills>/.skill-removed/<name>.json`（墓碑）：`clearSkillTombstone` 由**每一次
 *    成功安装**调用 ⇒ 库内预置一个指向库外的 `.skill-removed` 符号链接后，**每次安装
 *    都会静默删掉库外同名文件**；`writeSkillTombstone`（卸载随包技能）反过来把墓碑
 *    **写到库外**；
 *  - `<skills>/.skill-locks/<name>.lock`（per-name 锁）：锁文件会落在库外（`O_EXCL`
 *    不跟随末段，所以不会写穿，但"锁在库外"本身已是判据缺失）。
 *
 * ## 判据（每条都断言"库外一个字节都没动/没写"）
 *
 *  1. 安装路径：`.skill-removed` → 库外链接时，安装**照常成功**（墓碑是附属品），
 *     而库外 `victim.json` 必须**原样存在**，且日志如实记"refused to clear the tombstone"；
 *  2. 卸载路径：卸载 `channel === 'plugin'` 的技能时，墓碑**不得**出现在库外；
 *  3. 锁路径：`.skill-locks` → 库外链接时，安装/卸载一律 **fail-loud**
 *     （`LIBRARY_TEMP_UNSAFE`）且库外不出现任何锁文件；
 *  4. 正向对照：真实的 `.skill-removed` 目录下墓碑照常写、照常清（修复不得把功能弄坏）。
 *
 * ## 变异验证
 *
 *  - `clearSkillTombstone` 换回无条件 `rm(join(skillsDir, SKILL_REMOVED_DIR, …))` ⇒ 第 1 组红；
 *  - `writeSkillTombstone` 换回直接 `mkdir + writeFile` ⇒ 第 2 组红；
 *  - `ensureLibraryLockRoot` 换回 `mkdir(join(skillsDir, SKILL_LOCK_DIR))` ⇒ 第 3 组红。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ArchiveInstallRefusal,
  clearSkillTombstone,
  installSkillArchive,
  SKILL_LOCK_DIR,
  SKILL_REMOVED_DIR,
  uninstallSkill,
  writeSkillTombstone,
  type SkillInstallLog,
} from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

/** 一份最小的、可加载的 SKILL.md。 */
function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: anchor probe ${name}\nversion: 1.0.0\n---\n\nbody of ${name}\n`
}

function archiveOf(name: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(skillMd(name), 'utf8'), '', 0o644)
  return zip.toBuffer()
}

function recordingLog(): { log: SkillInstallLog, lines: string[] } {
  const lines: string[] = []
  return { log: { warn: (message: string) => { lines.push(message) } }, lines }
}

interface Fixture {
  home: string
  skillsDir: string
  outside: string
  log: SkillInstallLog
  lines: string[]
}

const dirs: string[] = []

async function fixture(prefix: string): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(home)
  const skillsDir = join(home, 'skills')
  const outside = join(home, 'outside')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(outside, { recursive: true })
  const { log, lines } = recordingLog()
  return { home, skillsDir, outside, log, lines }
}

beforeEach(isolateRuntimeSkillRoots)

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('R21-A1-03 `.skill-removed` 未锚定 ⇒ 安装路径静默删库外文件 / 卸载写库外', () => {
  it('`.skill-removed` 是指向库外的符号链接时：安装照常成功，但库外 victim.json 一个字都不动', async () => {
    const f = await fixture('r21a1-tomb-del-')
    const victim = join(f.outside, 'victim.json')
    await writeFile(victim, '{"appId":"victim","channel":"plugin"}\n')
    await symlink(f.outside, join(f.skillsDir, SKILL_REMOVED_DIR), 'dir')

    await installSkillArchive({ name: 'victim', archive: archiveOf('victim'), skillsDir: f.skillsDir, channel: 'market', log: f.log })

    expect(existsSync(victim), '库外的同名文件必须原样存在（旧实现：每次安装都会删掉它）').toBe(true)
    expect(await readFile(victim, 'utf8')).toContain('victim')
    expect(f.lines.join('\n'), '拒绝必须如实留痕').toContain('refused to clear the tombstone')
    expect(f.lines.join('\n')).toContain(SKILL_REMOVED_DIR)
  })

  it('卸载随包技能时墓碑**不得**写到库外（`.skill-removed` 为库外链接）', async () => {
    const f = await fixture('r21a1-tomb-write-')
    await installSkillArchive({ name: 'plug', archive: archiveOf('plug'), skillsDir: f.skillsDir, channel: 'plugin', log: f.log })
    await symlink(f.outside, join(f.skillsDir, SKILL_REMOVED_DIR), 'dir')

    await uninstallSkill(f.skillsDir, 'plug', { log: f.log })

    expect(existsSync(join(f.skillsDir, 'plug')), '卸载本身仍然成功').toBe(false)
    expect(existsSync(join(f.outside, 'plug.json')), '墓碑不得落在库外（旧实现：写到库外）').toBe(false)
    expect(f.lines.join('\n'), '拒绝必须如实留痕').toContain('refused to write a tombstone')
  })

  it('`writeSkillTombstone` / `clearSkillTombstone` 直接调用同样不越界', async () => {
    const f = await fixture('r21a1-tomb-direct-')
    await writeFile(join(f.outside, 'plug.json'), 'KEEP-ME\n')
    await symlink(f.outside, join(f.skillsDir, SKILL_REMOVED_DIR), 'dir')

    expect(await clearSkillTombstone(f.skillsDir, 'plug', f.log), '被拒时不得声称"墓碑已不在盘上"').toBeUndefined()
    expect(await readFile(join(f.outside, 'plug.json'), 'utf8')).toBe('KEEP-ME\n')
    const written = await writeSkillTombstone(f.skillsDir, 'plug', undefined, f.log)
    expect(written).toContain(SKILL_REMOVED_DIR)
    expect(existsSync(join(f.outside, 'plug.json'))).toBe(true)
    expect(await readFile(join(f.outside, 'plug.json'), 'utf8'), '被拒时不得覆盖库外文件的内容').toBe('KEEP-ME\n')
  })

  it('正向对照：真实的 .skill-removed 目录下墓碑照常写、重新安装照常清', async () => {
    const f = await fixture('r21a1-tomb-ok-')
    await installSkillArchive({ name: 'plug', archive: archiveOf('plug'), skillsDir: f.skillsDir, channel: 'plugin', log: f.log })
    await uninstallSkill(f.skillsDir, 'plug', { log: f.log })
    const tombstone = join(f.skillsDir, SKILL_REMOVED_DIR, 'plug.json')
    expect(existsSync(tombstone), '正常路径上墓碑必须落在技能库内').toBe(true)
    expect(JSON.parse(await readFile(tombstone, 'utf8'))).toMatchObject({ appId: 'plug', channel: 'plugin' })

    await installSkillArchive({ name: 'plug', archive: archiveOf('plug'), skillsDir: f.skillsDir, channel: 'market', log: f.log })
    expect(existsSync(tombstone), '安装成功后墓碑必须被清掉（修复不得把这条功能弄坏）').toBe(false)
  })
})

describe('R21-A1-03 `.skill-locks` 未锚定 ⇒ 锁落在库外（fail-loud，绝不假装锁住了）', () => {
  it('`.skill-locks` 是指向库外的符号链接时：安装被拒（LIBRARY_TEMP_UNSAFE），库外不出现锁文件', async () => {
    const f = await fixture('r21a1-lock-')
    await symlink(f.outside, join(f.skillsDir, SKILL_LOCK_DIR), 'dir')

    const refusal = await installSkillArchive({ name: 'alpha', archive: archiveOf('alpha'), skillsDir: f.skillsDir, channel: 'market', log: f.log })
      .catch((cause: unknown) => cause)
    expect(refusal, '库内私有目录不可信时必须 fail-loud').toBeInstanceOf(ArchiveInstallRefusal)
    expect((refusal as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(existsSync(join(f.skillsDir, 'alpha')), '一个字都不该动').toBe(false)
    const outsideEntries = await import('node:fs/promises').then(fs => fs.readdir(f.outside))
    expect(outsideEntries, '库外不得出现锁文件').toEqual([])
  })

  it('卸载同样先过锁闸：`.skill-locks` 为库外链接 ⇒ 拒收且技能原样保留', async () => {
    const f = await fixture('r21a1-lock-un-')
    await installSkillArchive({ name: 'alpha', archive: archiveOf('alpha'), skillsDir: f.skillsDir, channel: 'market', log: f.log })
    await rm(join(f.skillsDir, SKILL_LOCK_DIR), { recursive: true, force: true })
    await symlink(f.outside, join(f.skillsDir, SKILL_LOCK_DIR), 'dir')

    const refusal = await uninstallSkill(f.skillsDir, 'alpha', { log: f.log }).catch((cause: unknown) => cause)
    expect((refusal as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(existsSync(join(f.skillsDir, 'alpha', 'SKILL.md')), '卸载被拒 ⇒ 技能必须原样在库内').toBe(true)
    const outsideEntries = await import('node:fs/promises').then(fs => fs.readdir(f.outside))
    expect(outsideEntries).toEqual([])
  })

  it('正向对照：普通库内 `.skill-locks` 目录下锁照常取、照常释放（功能不退化）', async () => {
    const f = await fixture('r21a1-lock-ok-')
    await installSkillArchive({ name: 'alpha', archive: archiveOf('alpha'), skillsDir: f.skillsDir, channel: 'market', log: f.log })
    const lockDir = join(f.skillsDir, SKILL_LOCK_DIR)
    expect(existsSync(lockDir), '锁目录应当被建在库内').toBe(true)
    expect(await import('node:fs/promises').then(fs => fs.readdir(lockDir)), '安装完成后不得留下锁').toEqual([])
    expect(existsSync(join(f.skillsDir, 'alpha', 'SKILL.md'))).toBe(true)
  })
})
