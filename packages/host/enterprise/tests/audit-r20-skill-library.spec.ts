/**
 * tests/audit-r20-skill-library.spec.ts — 第二十轮对抗审计（R20A-K）技能库面的**仓内回归判据**。
 *
 * 来源：`temp/r20/A/S-skills.md`（§2.1 K-01 / §2.2 K-02 / §2.6 K-06）与第十九轮交接项
 * R19B-09（`temp/r19/B/REPORT.md`、`temp/r19/T/REPORT.md` §五）。审计方的探针在
 * `temp/r20/A/sk-probe/`（真并发攻击进程 / 真 `unshare -m` + tmpfs 盖 `/proc`）——
 * 本文件是它的**仓内可复跑**形态：不依赖 `temp/` 下的任何夹具，也不要求 CAP_SYS_ADMIN
 * （需要特权的 bind mount 用例按既有惯例**如实跳过**并打印原因）。
 *
 * 三条判据的共同点：**"派生自锚定路径的字符串"不等于"用之前还是那个目录"**。
 *
 *  - **K-01**：`.skill-tmp` 只在入口锚定一次，而两次 `rename` + 一次 `rm` 用的是同一条
 *    字符串路径，中间隔着**整段解包**（窗口 ∝ 归档大小）。解包期把 `.skill-tmp` 换成
 *    指向库外的符号链接 ⇒ 安装**返回成功**、库内旧技能目录被搬到库外。
 *    修法：每个破坏性动作**紧邻执行前**重锚（`assertTempRootStillAnchored`），不一致即
 *    fail-closed 抛 `LIBRARY_TEMP_UNSAFE`（绝不返回成功），清理/回滚同样过闸。
 *  - **K-02**：`/proc/self/mountinfo` 读不到时旧实现 `return undefined` ⇒ **判据静默缺席**
 *    （`mountPoints?.has(…) === true` 恒假），同设备 bind mount 的**删除方向**直接删掉库外
 *    唯一副本。修法：挂载表是**三态**（available / not-applicable / unreadable），
 *    `unreadable` ⇒ 拒收并如实报原因（fail-closed）。
 *  - **K-06**：`recoverInterruptedSkillSwaps` 顶层锚定失败时不消费拒绝原因 —— 真实成因是
 *    挂载点/跨设备时，日志统一写成"是符号链接或非目录"（兄弟路径 `settle` 却带原因）。
 *    修法：`describeAnchorRefusal(tempRootRefusal)`，与兄弟路径同一口径。
 *  - **R19B-09**：`RESIDUE` 拒绝文案纯英文硬编码 ⇒ 中文界面原样透出英文整句。
 *    修法：`hostCopy(locale, zh, en)` + 按调用传 `locale`（缺省回落中文），
 *    **不在模块级冻结语言表**。
 *
 * 变异（拆掉修复必红，红/绿对照见 `temp/r20/fix-C-skills.md`）：
 *   - K-01：删掉那三处 `assertTempRootStillAnchored` / 复检 ⇒ 用例 1 红（安装成功 +
 *     库外出现 `backup-*` + 落点旧内容消失）；
 *   - K-02：把 `readMountPointTable` 的 `unreadable` 分支改回"返回 undefined（缺席）"⇒
 *     用例 3/4 红；
 *   - K-06：把顶层那句写回笼统文案 ⇒ 用例 5 的"成因必须逐案点名"红；
 *   - R19B-09：把 `hostCopy` 换回英文硬编码 ⇒ 用例 6/7 红。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  installSkillArchive,
  recoverInterruptedSkillSwaps,
  uninstallSkill,
  writeProvenance,
  type SkillInstallLog,
} from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

/**
 * 两个注入点（`vi.mock` 的工厂在 import 期求值，所以状态必须 `vi.hoisted`）。
 *
 *  - `swap`：K-01 的**确定性**攻击（与审计方 `attacker-swap.mjs` 的攻击形态逐条对应，
 *    只是**不靠抢时序**）—— 把 `<库>/.skill-tmp` 改名旁置、在原位放一个指向库外 vault
 *    的符号链接。触发点由 `stage` 决定，**三处破坏性 syscall 各有一个**：
 *      · `stage = 1`：tar 归档刚落到 staging（第一次 `rename` 之前 ⇒ 覆盖守卫 1）；
 *      · `stage = 2`：`rename(落点 → backup)` 之后（第二次 `rename` 之前 ⇒ 覆盖守卫 2 与回滚）；
 *      · `stage = 3`：`rename(staging → 落点)` 之后（`rm(backup)` 之前 ⇒ 覆盖守卫 3）。
 *    后两档还会在 vault 里按**同一个名字**放一份真实诱饵目录（`DECOY-OUTSIDE.txt`），
 *    于是"安装器有没有删到库外"是可判定的（修法失效时那份诱饵会消失）。
 *  - `hideMountTable`：K-02 的"Linux 上读不到挂载表"。审计方用真 `unshare -m` + tmpfs 盖
 *    `/proc`；仓内不能要求 CAP_SYS_ADMIN，所以挂钩 `readFile('/proc/self/mountinfo')`
 *    让它 ENOENT —— **判据读的就是这个文件**，所以这是同一条代码路径，不是"跳过判据"。
 */
const hooks = vi.hoisted(() => ({
  swap: { stage: 0, armed: false, swaps: 0, plan: { skills: '', parked: '', vault: '', targetDir: '' } },
  hideMountTable: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  /** 真正的攻击动作（同步，运行在安装器的 syscall 与下一次 syscall 之间）。 */
  const swapNow = async (stage: number): Promise<void> => {
    hooks.swap.swaps++
    const fs = await import('node:fs')
    const nodePath = await import('node:path')
    const tempRoot = nodePath.join(hooks.swap.plan.skills, '.skill-tmp')
    fs.renameSync(tempRoot, hooks.swap.plan.parked)
    const entries = fs.readdirSync(hooks.swap.plan.parked)
    const staged = entries.find(name => name.startsWith('install-'))
    const backup = entries.find(name => name.startsWith('backup-'))
    // staging 仍要能解析（安装器后半程还在这棵树下 I/O）。
    if (staged !== undefined) {
      fs.symlinkSync(nodePath.join(hooks.swap.plan.parked, staged), nodePath.join(hooks.swap.plan.vault, staged), 'dir')
    }
    // 删除方向的诱饵：与安装器要 `rm` 的那一份**同名**，且是**库外真实目录**。
    if (stage >= 3 && backup !== undefined) {
      fs.mkdirSync(nodePath.join(hooks.swap.plan.vault, backup), { recursive: true })
      fs.writeFileSync(nodePath.join(hooks.swap.plan.vault, backup, 'DECOY-OUTSIDE.txt'), 'OUTSIDE-DATA\n')
    }
    fs.symlinkSync(hooks.swap.plan.vault, tempRoot, 'dir')
  }
  return {
    ...actual,
    default: actual,
    readFile: async (path: never, ...rest: never[]) => {
      if (hooks.hideMountTable && String(path) === '/proc/self/mountinfo') {
        const cause = new Error("ENOENT: no such file or directory, open '/proc/self/mountinfo'") as NodeJS.ErrnoException
        cause.code = 'ENOENT'
        throw cause
      }
      return await (actual.readFile as never as (p: never, ...r: never[]) => Promise<unknown>)(path, ...rest)
    },
    writeFile: async (path: never, ...rest: never[]) => {
      const out = await (actual.writeFile as never as (p: never, ...r: never[]) => Promise<unknown>)(path, ...rest)
      // stage 1：只在"tar 归档刚落到 staging"这一刻动手（解包窗口的入口）。
      if (hooks.swap.armed && hooks.swap.stage === 1 && hooks.swap.swaps === 0 && String(path).endsWith('archive.tar.gz')) {
        await swapNow(1)
      }
      return out
    },
    rename: async (from: never, to: never) => {
      const out = await (actual.rename as never as (f: never, t: never) => Promise<unknown>)(from, to)
      if (hooks.swap.armed && hooks.swap.swaps === 0) {
        const source = String(from)
        if (hooks.swap.stage === 2 && source === hooks.swap.plan.targetDir) await swapNow(2)
        if (hooks.swap.stage === 3 && source.endsWith('/unpacked')) await swapNow(3)
      }
      return out
    },
  }
})

const roots: string[] = []
const mounts: string[] = []

beforeEach(() => {
  isolateRuntimeSkillRoots()
  hooks.swap.armed = false
  hooks.swap.stage = 0
  hooks.swap.swaps = 0
  hooks.hideMountTable = false
})

afterEach(async () => {
  for (const target of mounts.splice(0)) {
    try { execFileSync('umount', ['-l', target], { stdio: 'ignore' }) } catch { /* 已卸载 */ }
  }
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function recordingLog(): { log: SkillInstallLog, lines: string[] } {
  const lines: string[] = []
  return { log: { warn: (message: string) => { lines.push(message) } }, lines }
}

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: probe ${name} (${marker})\n---\n\nbody ${marker}\n`
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** 最小可安装归档（**tar.gz**：tar 通道才会把归档写到 staging，K-01 的窗口钩子挂在那一刻）。 */
async function skillArchive(name: string, marker: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'r20-arc-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), skillMd(name, marker), 'utf8')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const stream = tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])
      stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 库外 vault 里"有没有多出安装器写的东西"（`backup-*` / `orphan-*` / 旧内容）。 */
function vaultLeaks(vault: string): string[] {
  const leaks: string[] = []
  for (const entry of readdirSync(vault, { withFileTypes: true })) {
    if (entry.name.startsWith('backup-') || entry.name.startsWith('orphan-')) leaks.push(entry.name)
    // 跟随链接：`install-X` 那条链接指向旁置目录，里面只有 staging 构件。
    if (existsSync(join(vault, entry.name, 'keep', 'important.txt'))) leaks.push(`${entry.name}/keep/important.txt`)
  }
  return leaks
}

// ---------------------------------------------------------------------------
// K-01：安装路径的 `.skill-tmp` 后置窗口
// ---------------------------------------------------------------------------

describe('R20A-K-01：解包窗口里换掉 `.skill-tmp` ⇒ 安装拒收（不返回成功）', () => {
  it('确定性攻击：库内旧技能目录一个字都不动、库外零字节、抛 LIBRARY_TEMP_UNSAFE', async () => {
    const base = await tempRoot('r20-k01-')
    const skills = join(base, 'skills')
    const parked = join(base, 'skills-tmp-parked')
    const vault = join(base, 'vault')
    await mkdir(join(skills, 'victim', 'keep'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'OLD-INSIDE'))
    await writeFile(join(skills, 'victim', 'keep', 'important.txt'), 'KEEP-ME\n')
    await mkdir(vault, { recursive: true })

    hooks.swap.plan = { skills, parked, vault, targetDir: join(skills, 'victim') }
    hooks.swap.stage = 1
    hooks.swap.armed = true
    const { log, lines } = recordingLog()
    const refusal = await installSkillArchive({
      name: 'victim',
      archive: await skillArchive('victim', 'NEW-ARCHIVE'),
      skillsDir: skills,
      version: '2.0.0',
      channel: 'market',
      overwrite: true,
      locale: 'en',
      log,
    }).then(() => undefined, (cause: unknown) => cause as Error)
    hooks.swap.armed = false

    const landing = await readFile(join(skills, 'victim', 'SKILL.md'), 'utf8')
    const leaks = vaultLeaks(vault)
    /* eslint-disable no-console */
    console.log('[K-01] 攻击是否赢下窗口 =', hooks.swap.swaps, '| 拒绝 =', refusal?.message)
    console.log('[K-01] 库外泄漏 =', JSON.stringify(leaks), '| 落点 =', JSON.stringify(landing.slice(0, 34)))
    console.log('[K-01] 日志 =', JSON.stringify(lines))

    // 自校准：攻击必须真的发生（否则这条判据咬不到，绿也是假绿）。
    expect(hooks.swap.swaps, '注入必须真的换掉 .skill-tmp').toBe(1)
    expect(existsSync(join(skills, '.skill-tmp')) && !existsSync(join(skills, '.skill-tmp', 'SKILL.md'))).toBe(true)
    // 修前：安装返回成功、库外出现 `backup-victim-*`（里面是库内旧目录）。
    expect(refusal).toBeInstanceOf(ArchiveInstallRefusal)
    expect((refusal as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(refusal?.message).toMatch(/staging area \.skill-tmp was replaced/su)
    expect(leaks, '库外不得出现安装器写的 backup-*/orphan-* 或库内旧内容').toEqual([])
    expect(landing, '库内旧技能目录必须原样保留').toContain('OLD-INSIDE')
    expect(await readFile(join(skills, 'victim', 'keep', 'important.txt'), 'utf8')).toBe('KEEP-ME\n')
    // 拒绝要留痕，且清理也 fail-closed（残骸宁可留着，也不在库外删）。
    expect(lines.join('\n')).toMatch(/refused to .* for "victim"/su)
    expect(lines.join('\n')).toMatch(/left the staging directory/su)
  }, 60_000)

  it('反向对照：不换 ⇒ 照常安装成功、旧内容被替换、临时区被摘掉（判据不是恒拒绝）', async () => {
    const base = await tempRoot('r20-k01-ok-')
    const skills = join(base, 'skills')
    await mkdir(join(skills, 'victim'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'OLD-INSIDE'))
    const result = await installSkillArchive({
      name: 'victim',
      archive: await skillArchive('victim', 'NEW-ARCHIVE'),
      skillsDir: skills,
      version: '2.0.0',
      channel: 'market',
      overwrite: true,
    })
    expect(result.targetDir).toBe(join(skills, 'victim'))
    expect(await readFile(join(skills, 'victim', 'SKILL.md'), 'utf8')).toContain('NEW-ARCHIVE')
    expect(existsSync(join(skills, '.skill-tmp')), '本次安装没留东西 ⇒ 临时区被摘掉').toBe(false)
  }, 60_000)

  it('窗口覆盖②：换在第一处 rename 之后 ⇒ 第二处 rename 前被拒，且回滚不把库外目录搬进落点', async () => {
    const base = await tempRoot('r20-k01-stage2-')
    const skills = join(base, 'skills')
    const parked = join(base, 'skills-tmp-parked')
    const vault = join(base, 'vault')
    await mkdir(join(skills, 'victim', 'keep'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'OLD-INSIDE'))
    await writeFile(join(skills, 'victim', 'keep', 'important.txt'), 'KEEP-ME\n')
    await mkdir(vault, { recursive: true })

    hooks.swap.plan = { skills, parked, vault, targetDir: join(skills, 'victim') }
    hooks.swap.stage = 2
    hooks.swap.armed = true
    const { log, lines } = recordingLog()
    const refusal = await installSkillArchive({
      name: 'victim',
      archive: await skillArchive('victim', 'NEW-ARCHIVE'),
      skillsDir: skills,
      version: '2.0.0',
      channel: 'market',
      overwrite: true,
      locale: 'en',
      log,
    }).then(() => undefined, (cause: unknown) => cause as Error)
    hooks.swap.armed = false

    const oldCopy = (await readdirSafe(parked)).find(name => name.startsWith('backup-'))
    console.log('[K-01/stage2] swaps =', hooks.swap.swaps, '| 拒绝 =', refusal?.message)
    console.log('[K-01/stage2] 旁置目录 =', JSON.stringify(await readdirSafe(parked)), '| 日志 =', JSON.stringify(lines))

    expect(hooks.swap.swaps, '注入必须真的发生').toBe(1)
    // 修前（缺第二处复检）：`rename(staging → 落点)` 会借着库外链接把内容搬进落点、安装报成功。
    expect((refusal as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(lines.join('\n')).toMatch(/refused to move the unpacked skill into place/su)
    // 回滚同样过闸：库外目录绝不能被搬进落点 ⇒ 落点保持**空**（旧内容此刻在旁置的
    // `.skill-tmp` 之下，见下面的断言），并且日志如实说明"没能自动回滚、需人工检查"。
    expect(existsSync(join(skills, 'victim')), '落点不得被写入（回滚也不许穿链接）').toBe(false)
    expect(lines.join('\n')).toMatch(/could not roll back "victim"/su)
    expect(vaultLeaks(vault), '库外不得被写入').toEqual([])
    // 旧内容的唯一副本仍在库里（旁置的 `.skill-tmp` 之下），没有被搬到库外。
    expect(oldCopy, '第一处 rename 产出的备份必须还在').toBeDefined()
    expect(await readFile(join(parked, oldCopy as string, 'SKILL.md'), 'utf8')).toContain('OLD-INSIDE')
  }, 60_000)

  it('窗口覆盖③：换在第二处 rename 之后 ⇒ rm(backup) 前被拒，库外的同名诱饵不得被删', async () => {
    const base = await tempRoot('r20-k01-stage3-')
    const skills = join(base, 'skills')
    const parked = join(base, 'skills-tmp-parked')
    const vault = join(base, 'vault')
    await mkdir(join(skills, 'victim', 'keep'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'OLD-INSIDE'))
    await mkdir(vault, { recursive: true })

    hooks.swap.plan = { skills, parked, vault, targetDir: join(skills, 'victim') }
    hooks.swap.stage = 3
    hooks.swap.armed = true
    const { log, lines } = recordingLog()
    const result = await installSkillArchive({
      name: 'victim',
      archive: await skillArchive('victim', 'NEW-ARCHIVE'),
      skillsDir: skills,
      version: '2.0.0',
      channel: 'market',
      overwrite: true,
      locale: 'en',
      log,
    }).then(value => value, (cause: unknown) => cause as Error)
    hooks.swap.armed = false

    const decoy = (await readdirSafe(vault)).find(name => name.startsWith('backup-'))
    console.log('[K-01/stage3] swaps =', hooks.swap.swaps, '| 安装结果 =', 'targetDir' in (result as object))
    console.log('[K-01/stage3] 库外诱饵 =', JSON.stringify(decoy), '| 日志 =', JSON.stringify(lines))

    expect(hooks.swap.swaps, '注入必须真的发生').toBe(1)
    // 第三处（rm）被复检拦下：安装本身已经完成（换入成功），所以这里**返回成功**是对的 ——
    // 被拒的是"删掉一份路径已经指向库外的备份"。修前：那条 `rm` 会穿过链接删掉库外的诱饵。
    expect('targetDir' in (result as object), '换入已完成 ⇒ 返回成功').toBe(true)
    expect(lines.join('\n')).toMatch(/left the backup of "victim" in place/su)
    expect(decoy, '库外诱饵目录必须还在（安装器不得删到库外）').toBeDefined()
    expect(existsSync(join(vault, decoy as string, 'DECOY-OUTSIDE.txt')), '库外数据必须原样').toBe(true)
    expect(await readFile(join(skills, 'victim', 'SKILL.md'), 'utf8')).toContain('NEW-ARCHIVE')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// K-02 / K-06：挂载表读不到 ⇒ 判据未知 ⇒ fail-closed，且成因进日志
// ---------------------------------------------------------------------------

describe('R20A-K-02：Linux 上读不到挂载表 ⇒ 破坏性方向 fail-closed（判据不得静默缺席）', () => {
  it('换入自愈：判据未知 ⇒ 一个字都不动，日志点名"挂载表"（修前：库外唯一副本被删除）', async () => {
    const base = await tempRoot('r20-k02-')
    const skills = join(base, 'skills')
    await mkdir(join(skills, '.skill-tmp', 'backup-victim-1790300000000'), { recursive: true })
    await writeFile(join(skills, '.skill-tmp', 'backup-victim-1790300000000', 'SKILL.md'), skillMd('victim', 'ONLY-COPY'))
    await mkdir(join(skills, 'victim'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'INSTALLED'))

    hooks.hideMountTable = true
    const { log, lines } = recordingLog()
    const out = await recoverInterruptedSkillSwaps(skills, { onlyName: 'victim', log })
    hooks.hideMountTable = false

    console.log('[K-02/换入自愈] out =', JSON.stringify(out), '| 日志 =', JSON.stringify(lines))
    expect(out, '判据未知 ⇒ 拒绝搬/删').toEqual([])
    expect(existsSync(join(skills, '.skill-tmp', 'backup-victim-1790300000000', 'SKILL.md')), '副本必须还在').toBe(true)
    expect(lines.join('\n')).toMatch(/mount table \(\/proc\/self\/mountinfo\)/su)
    expect(lines.join('\n')).toMatch(/nothing was removed or moved/su)
  }, 60_000)

  it('安装：判据未知 ⇒ 拒绝安装（LIBRARY_TEMP_UNSAFE，点名挂载表），一个字节都不解包', async () => {
    const base = await tempRoot('r20-k02-install-')
    const skills = join(base, 'skills')
    await mkdir(skills, { recursive: true })
    hooks.hideMountTable = true
    const refusal = await installSkillArchive({
      name: 'alpha',
      archive: await skillArchive('alpha', 'FROM-HUB'),
      skillsDir: skills,
      version: '1.0.0',
      channel: 'market',
      locale: 'en',
    }).then(() => undefined, (cause: unknown) => cause as Error)
    hooks.hideMountTable = false

    console.log('[K-02/安装] 拒绝 =', refusal?.message)
    expect(refusal).toBeInstanceOf(ArchiveInstallRefusal)
    expect((refusal as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(refusal?.message).toMatch(/mount table \(\/proc\/self\/mountinfo\)/su)
    expect(existsSync(join(skills, 'alpha')), '不得装机').toBe(false)
    expect(await readdirSafe(join(skills, '.skill-tmp')), '不得建 staging').toEqual([])
  }, 60_000)

  it('成因逐案点名：挂载表不可读 ≠ 符号链接（K-06 的同一口径）', async () => {
    const base = await tempRoot('r20-k06-')
    const skills = join(base, 'skills')
    await mkdir(join(skills, '.skill-tmp', 'backup-victim-1790300000000'), { recursive: true })
    await writeFile(join(skills, '.skill-tmp', 'backup-victim-1790300000000', 'SKILL.md'), skillMd('victim', 'ONLY-COPY'))

    // ① 挂载表不可读：成因必须是"读不到挂载表"，不能是"是符号链接或非目录"。
    hooks.hideMountTable = true
    const hidden = recordingLog()
    await recoverInterruptedSkillSwaps(skills, { onlyName: 'victim', log: hidden.log })
    hooks.hideMountTable = false
    console.log('[K-06] 挂载表不可读 =', JSON.stringify(hidden.lines))
    expect(hidden.lines.join('\n')).toMatch(/mount table/su)
    expect(hidden.lines.join('\n'), '旧实现那句笼统文案不得再出现').not.toMatch(/symbolic link or a non-directory is in the way/su)

    // ② `.skill-tmp` 是符号链接：成因必须是"符号链接"，不能是"读不到挂载表"。
    const outside = join(base, 'outside-tmp')
    await mkdir(outside, { recursive: true })
    await rm(join(skills, '.skill-tmp'), { recursive: true, force: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside, join(skills, '.skill-tmp'), 'dir')
    const linked = recordingLog()
    await recoverInterruptedSkillSwaps(skills, { onlyName: 'victim', log: linked.log })
    console.log('[K-06] 符号链接 =', JSON.stringify(linked.lines))
    expect(linked.lines.join('\n')).toMatch(/symbolic link/su)
    expect(linked.lines.join('\n')).not.toMatch(/mount table/su)
  }, 60_000)

  it('跨设备（真 bind mount，需 CAP_SYS_ADMIN）：成因点名"另一个设备"；无权限时如实跳过', async () => {
    const base = await tempRoot('r20-k08-')
    const skills = join(base, 'skills')
    const shm = await mkdtemp(join('/dev/shm', 'r20-crossdev-'))
    roots.push(shm)
    await mkdir(join(skills, '.skill-tmp'), { recursive: true })
    let mounted = false
    try {
      execFileSync('mount', ['--bind', shm, join(skills, '.skill-tmp')], { stdio: 'ignore' })
      mounts.push(join(skills, '.skill-tmp'))
      mounted = true
    } catch { /* 无 CAP_SYS_ADMIN：如实记录 */ }
    console.log('[K-08] bind mount 可用 =', mounted)
    if (!mounted) {
      // 不假装通过：这条判据在本环境咬不到，由上面两条（无特权）覆盖同一修复面。
      const { log, lines } = recordingLog()
      const out = await recoverInterruptedSkillSwaps(skills, { log })
      console.log('[K-08] 跳过特权用例；无挂载点时 out =', JSON.stringify(out), '日志 =', JSON.stringify(lines))
      expect(mounted).toBe(false)
      return
    }
    const { log, lines } = recordingLog()
    await recoverInterruptedSkillSwaps(skills, { log })
    console.log('[K-08] 日志 =', JSON.stringify(lines))
    expect(lines.join('\n')).toMatch(/different device/su)
  }, 60_000)
})

/** `readdir` 的"不存在也算空"形态（用例只关心"有没有东西"）。 */
async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return await readdir(dir).catch(() => [])
}

// ---------------------------------------------------------------------------
// R19B-09：RESIDUE 文案按调用取语言（缺省中文，可切英文，不冻结）
// ---------------------------------------------------------------------------

describe('R19B-09：RESIDUE 拒绝文案走 hostCopy（按调用解析，缺省中文）', () => {
  /** 造一个"商店装的 + 用户自建同名影子"的技能库 ⇒ 卸载必被 RESIDUE 拒绝。 */
  async function seedShadowedSkill(skills: string): Promise<void> {
    await mkdir(join(skills, 'gamma'), { recursive: true })
    await writeFile(join(skills, 'gamma', 'SKILL.md'), skillMd('gamma', 'STORE-COPY'))
    await writeProvenance(join(skills, 'gamma'), {
      appId: 'gamma', version: '1.0.0', channel: 'builtin', installedAt: '2026-01-01T00:00:00Z',
    })
    await mkdir(join(skills, 'My_Gamma'), { recursive: true })
    await writeFile(join(skills, 'My_Gamma', 'SKILL.md'), skillMd('gamma', 'USER-OWN-COPY'))
  }

  it('卸载面：zh（显式与缺省）出中文、en 出英文；可行动信息（条目名/根路径）两种语言都在', async () => {
    const base = await tempRoot('r20-locale-uninstall-')
    const skills = join(base, 'skills')
    await seedShadowedSkill(skills)

    const zh = await uninstallSkill(skills, 'gamma', { overwrite: true, locale: 'zh' })
      .then(() => undefined, (cause: unknown) => cause as Error)
    const fallback = await uninstallSkill(skills, 'gamma', { overwrite: true })
      .then(() => undefined, (cause: unknown) => cause as Error)
    const en = await uninstallSkill(skills, 'gamma', { overwrite: true, locale: 'en' })
      .then(() => undefined, (cause: unknown) => cause as Error)
    /* eslint-disable no-console */
    console.log('[R19B-09/卸载] zh =', zh?.message)
    console.log('[R19B-09/卸载] 缺省 =', fallback?.message)
    console.log('[R19B-09/卸载] en =', en?.message)

    for (const refusal of [zh, fallback, en]) {
      expect(refusal).toBeInstanceOf(ArchiveInstallRefusal)
      expect((refusal as ArchiveInstallRefusal).code).toBe('RESIDUE')
      // 可行动信息与语言无关：点名那份残留的条目名 + "没删任何东西"的处置。
      expect(refusal?.message).toContain('"My_Gamma"')
    }
    // zh 面：中文整句，不含英文整句；缺省 == zh（回落口径与 DEFAULT_HOST_LOCALE 一致）。
    expect(zh?.message).toMatch(/仍会被运行时从技能库根目录本身加载/su)
    expect(zh?.message).not.toMatch(/still loaded by the runtime from the skill root itself/su)
    expect(fallback?.message).toBe(zh?.message)
    // en 面：英文整句，不含中文整句。
    expect(en?.message).toMatch(/still loaded by the runtime from the skill root itself/su)
    expect(en?.message).not.toMatch(/仍会被运行时从技能库根目录本身加载/su)
    // 同一进程、同一个模块实例、**无需重新 apply**：语言是按调用解析的。
    expect(zh?.message).not.toBe(en?.message)
    // 拒绝时落点一字未动（RESIDUE 是删除**之前**的判据）。
    expect(existsSync(join(skills, 'gamma', 'SKILL.md')), '拒绝时落点必须还在').toBe(true)
  }, 60_000)

  it('安装面：影子赢下注册表时报 RESIDUE，同样按 locale 取中英', async () => {
    const archive = await skillArchive('ghost', 'FROM-HUB')
    /** 每种语言用一棵**全新的**技能库：RESIDUE 是"已写入落点之后"的判据，重跑会先撞覆盖守卫。 */
    const attempt = async (locale: 'zh' | 'en'): Promise<Error | undefined> => {
      const base = await tempRoot(`r20-locale-install-${locale}-`)
      const skills = join(base, 'skills')
      await mkdir(join(skills, 'alink'), { recursive: true })
      await writeFile(join(skills, 'alink', 'SKILL.md'), skillMd('ghost', 'USER-OWN-COPY'))
      return await installSkillArchive({
        name: 'ghost', archive, skillsDir: skills, version: '1.0.0', channel: 'market', locale,
      }).then(() => undefined, (cause: unknown) => cause as Error)
    }
    const zh = await attempt('zh')
    const en = await attempt('en')
    /* eslint-disable no-console */
    console.log('[R19B-09/安装] zh =', zh?.message)
    console.log('[R19B-09/安装] en =', en?.message)

    expect((zh as ArchiveInstallRefusal).code).toBe('RESIDUE')
    expect((en as ArchiveInstallRefusal).code).toBe('RESIDUE')
    expect(zh?.message).toContain('"alink"')
    expect(zh?.message).toMatch(/模型读到的不是你刚装的那一份/su)
    expect(en?.message).toMatch(/would not read the copy just installed/su)
    expect(zh?.message).not.toMatch(/would not read the copy just installed/su)
  }, 60_000)

  it('中文文案保留可行动信息：动了什么 / 该去哪儿改 / 再试一次', async () => {
    const base = await tempRoot('r20-locale-actionable-')
    const skills = join(base, 'skills')
    await seedShadowedSkill(skills)
    const refusal = await uninstallSkill(skills, 'gamma', { overwrite: true })
      .then(() => undefined, (cause: unknown) => cause as Error)
    console.log('[R19B-09/可行动] =', refusal?.message)
    expect(refusal?.message).toMatch(/本次没有删除任何东西/su)      // 动了什么
    expect(refusal?.message).toMatch(/重命名或删除那一份/su)          // 该去哪儿改
    expect(refusal?.message).toMatch(/重新卸载 "gamma"/su)            // 再试一次
  }, 60_000)
})

// R19B-09 的**最后一跳**：文案在 skill-install 里双语化之后，路由层必须把"本次请求的
// 语言"传进去，否则英文界面照旧拿到中文整句（修了一半、现象不变）。
//
// 为什么用源码级判据而不是渲染级：RESIDUE 要从**真**运行时根/挂载点竞态里才能触发，
// 端到端渲染一条 RESIDUE 需要构造影子技能 + 真 uninstall 调用链；而这一跳唯一的失效
// 形态就是"调用点少写了 locale"（漏一个入口，那条 404/422 就退回中文）。源码级判据
// 对这一形态是**完备**的：新增/改动任何 install/uninstall 调用点都必须带 locale。
describe('R19B-09 最后一跳：auth-gate 的每个 install/uninstall 调用点都按请求传 locale', () => {
  it('每个调用点的选项对象都带 locale: hostLocale(req)', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'auth-gate.ts'), 'utf8')
    const markers = ['await installSkillArchive({', 'await uninstallSkill(']
    const sites: { marker: string, body: string }[] = []
    for (const marker of markers) {
      let from = 0
      for (;;) {
        const start = source.indexOf(marker, from)
        if (start < 0) break
        from = start + marker.length
        // 从调用点向后扫描到"括号配平"的收尾（选项对象里还有嵌套括号/对象字面量）。
        let depth = 0
        let end = -1
        for (let i = start; i < source.length; i += 1) {
          const ch = source[i]
          if (ch === '(') depth += 1
          else if (ch === ')') {
            depth -= 1
            if (depth === 0) { end = i; break }
          }
        }
        expect(end).toBeGreaterThan(start)
        sites.push({ marker, body: source.slice(start, end + 1) })
      }
    }
    // 入口清单本身也是判据：少于 6 处说明有人删了入口（那条路径的语言随之失守）。
    expect(sites.length).toBeGreaterThanOrEqual(6)
    const missing = sites.filter(site => !/locale:\s*hostLocale\(req\)/u.test(site.body))
    expect(missing.map(site => site.marker)).toEqual([])
  })
})
