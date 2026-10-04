/**
 * tests/skill-sweep-lock.spec.ts — **C4-01**（2026-10 对抗审计）的**跨包能力级**判据：
 *
 * > 写 `<技能库>/<name>/` 的模块，必须持有**那个名字**的 per-name 锁。
 *
 * ## 被判的缺陷（审计 C4-01 的实测终态）
 *
 * `installSkillArchive` 的整库换入自愈（`runInstallSkillArchive` 里那次
 * `recoverInterruptedSkillSwaps(skillsDir, { minAgeMs })`）会写**任意名字**的落点，
 * 而调用点只持有"当前正在装的那个名字"的锁 —— 两把锁不是同一把。与随包插件
 * （memory-evolve）的整树换入窗口交错时：对方刚把旧目录旁置（落点缺失），这边的
 * 清扫把该名字的 `backup-<name>-<ts>` 搬回落点 ⇒ 对方第二次 `rename` 与回滚
 * **双双 ENOTEMPTY**（`SKILL_SWAP_RECOVERY_FAILED`），旧内容的唯一副本随后被同步器
 * 的清扫收掉，该随包技能此后永久拒收（`SKILL_LOCAL_CONTENT` /
 * `SKILL_CHANNEL_CONFLICT`）、**不会自愈**。
 *
 * ## 为什么必须是"能力级 + 跨包"，而不是再加一条文本判据
 *
 * 既有的前向网（vendored 包 `tests/coi-lock-fourth-writer.test.js`）是
 * `assert(/acquireSkillDirLock/.test(moduleSource))` —— **文本存在性**，而且扫描面
 * **只覆盖 `packages/vendor/memory-evolve/lib/`**（跨包写者结构上不在它眼里）。
 * 本文件三条一起给：
 *   ① 锁由**另一个包的真实现**持有（vendored 的 `skills-sync.js` 的
 *      `acquireSkillDirLock`，不是本包的 `withSkillLock`、也不是手写的锁文件）——
 *      两端各自实现同一协议，所以这条同时钉住"两把锁落在同一个落点上"；
 *   ② 写者走**生产入口**（`installSkillArchive` 装**另一个**技能 ⇒ 那次安装里的整库
 *      清扫），不是直接调内部函数；
 *   ③ 断言的是**文件系统事实**（落点有没有被重建、副本还在不在、别人的锁有没有被
 *      动过）+ 留痕文案。
 * ⇒ 把接线删掉（`runInstallSkillArchive` 不再传 `acquireNameLock`）或把锁取到**别的
 *   名字**上，本文件必红（变异验证两处，见审计报告）。
 *
 * ## 夹具为什么不"造假年龄"
 *
 * 生产线的保护是 `INTERRUPTED_SWAP_MIN_AGE_MS`（10 分钟）。本夹具按生产形态造副本：
 * 先给真技能目录一个"一小时前"的 mtime，再用 **`rename`** 把它旁置（安装器的第一步
 * 就是 `rename(targetDir, backupDir)`）—— `rename` **不改被移动目录的 mtime**，
 * 所以"一小时前装好、刚刚被旁置"的副本天然过闸门。前置断言把这件事钉住，避免这条
 * 判据将来靠一个"足够新所以没人看"的夹具变成恒绿。
 *
 * ## 用例是确定性的
 *
 * 不靠 sleep 撞窗口：「另一个写者持有这个名字的锁」由 vendored 侧真实现的**持锁**
 * 状态直接表达；被判方（整库清扫）在同一个进程里跑，它看得见那把锁。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, renameSync, statSync, utimesSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import {
  INTERRUPTED_SWAP_MIN_AGE_MS,
  SKILL_LOCK_DIR,
  SKILL_LOCK_SUFFIX,
  SKILL_TEMP_DIR,
  describeArchiveFailure,
  installSkillArchive,
  type SkillInstallLog,
} from '../src/skill-install.ts'
// 跨端判据必须用**另一个包的真实现**持锁（企业包与 vendored 包之间禁止 import，
// 两端各自实现同一协议 —— 这条判据就是它们的对拍面）。
// @ts-expect-error vendored plain JS (no types)
import { acquireSkillDirLock } from '../../../vendor/memory-evolve/lib/coi/skills-sync.js'

/** 被"中断的安装"留下的那个技能名（memory-evolve 的内置技能名，与审计场景逐字重合）。 */
const VICTIM = 'kimi-cli-calling'
/** 触发整库清扫的**另一个**技能（装它时，清扫会看到 VICTIM 的中断副本）。 */
const OTHER = 'sweep-lock-other'
const OTHER2 = 'sweep-lock-other-two'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * 一次性目录（用例结束统一删）。
 * @param prefix - 目录名前缀。
 * @returns 绝对路径。
 */
async function tempDir(prefix = 'skill-sweep-lock-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/**
 * gzipped tar 归档（与 `skill-install.spec.ts` / `skill-install-lock.spec.ts` 同一手法）。
 * @param files - 归档内相对路径 → 正文。
 * @returns 归档字节。
 */
async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const dir = await tempDir('skill-sweep-lock-archive-')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const stream = tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return Buffer.concat(chunks)
}

/**
 * 一个可安装的市场技能归档。
 * @param name - 技能名（frontmatter 与目录名必须一致，否则安装器按运行期同一份规则拒收）。
 * @returns 归档字节。
 */
function marketArchive(name: string): Promise<Buffer> {
  return makeArchive({
    'SKILL.md': `---\nname: ${name}\ndescription: sweep lock\n---\n# MARKET-${name}\n`,
  })
}

/**
 * 造"上一次安装被杀在两处 `rename` 之间"的生产形态：落点缺失 + `.skill-tmp/backup-<name>-<ts>`
 * 是旧内容的唯一副本。
 *
 * 关键：用 **`rename`** 旁置一个 mtime 一小时前的真技能目录（**不** utimes 备份本身）——
 * 这正是 `skill-install.ts` 的 `rename(targetDir, backupDir)` 形态，`rename` 不改目录
 * mtime ⇒ 副本立刻就是"够旧"的（10 分钟闸门挡不住它，见文件头）。
 * @param skills - 技能库根。
 * @param name - 技能名。
 * @returns 备份目录绝对路径。
 */
async function seedInterruptedSwap(skills: string, name: string): Promise<string> {
  await mkdir(join(skills, SKILL_TEMP_DIR), { recursive: true })
  const target = join(skills, name)
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, 'SKILL.md'),
    `---\nname: ${name}\ndescription: interrupted install\nx-version: 1\n---\n# OLD-CONTENT\n`,
  )
  const when = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(target, when, when)
  const backup = join(skills, SKILL_TEMP_DIR, `backup-${name}-${Date.now()}`)
  renameSync(target, backup)
  return backup
}

describe('C4-01 整库换入自愈必须持有目标名字的 per-name 锁（跨包能力级）', () => {
  it('别人持锁（另一包的真实现）：整库清扫一个字都不动，释放后同一发安装才自愈', async () => {
    const skills = await tempDir()
    const backup = await seedInterruptedSwap(skills, VICTIM)
    const landing = join(skills, VICTIM)
    const lockPath = join(skills, SKILL_LOCK_DIR, `${VICTIM}${SKILL_LOCK_SUFFIX}`)

    // 前置事实（防恒绿）：这份副本**过得了**生产线的年龄闸门，所以"清扫没动它"只可能
    // 是因为锁，不可能是因为"它还不够旧"。
    const age = Date.now() - statSync(backup).mtimeMs
    expect(age, '夹具前置：中断副本必须比年龄闸门更旧，否则这条判据本来就是空转').toBeGreaterThan(
      INTERRUPTED_SWAP_MIN_AGE_MS,
    )
    expect(existsSync(landing), '夹具前置：换入窗口的形态 = 落点缺失').toBe(false)

    // ★跨包★ 锁由 vendored 包的真实现持有（不是本包的 withSkillLock，也不是手写锁文件）。
    const lock = acquireSkillDirLock(skills, VICTIM) as { ok: boolean, release?: () => void, message?: string }
    expect(lock.ok, `夹具前置：vendored 侧必须真的拿到锁（${lock.message ?? ''}）`).toBe(true)
    const lockBytesBefore = readFileSync(lockPath)

    try {
      // 生产入口：装**另一个**技能 ⇒ 这次安装里的整库清扫会看到 VICTIM 的中断副本。
      const lines: string[] = []
      const log: SkillInstallLog = { warn: (message) => lines.push(message) }
      await installSkillArchive({ name: OTHER, archive: await marketArchive(OTHER), skillsDir: skills, log })

      expect(existsSync(landing), '别人持锁时不得重建落点 —— 这正是 C4-01 的写穿').toBe(false)
      expect(existsSync(backup), '副本必须原样留着（`backup-*` 不在清扫面内，等取得到锁的自愈）').toBe(true)
      expect(readFileSync(lockPath).equals(lockBytesBefore), '别人的锁文件不得被改写或删除').toBe(true)
      expect(lines.join('\n'), '跳过必须留痕（不是静默降级）').toContain(
        `skipped the interrupted-swap recovery of "${VICTIM}"`,
      )
    } finally {
      lock.release?.()
    }
    expect(existsSync(lockPath), '释放后锁文件应当消失（只删自己创建的那个 inode）').toBe(false)

    // 阳性对照：锁空了以后，同一条生产路径必须真的把副本放回落点 ——
    // 证明上面"没动"的成因就是那把锁，而不是这条自愈路径本身坏了。
    await installSkillArchive({ name: OTHER2, archive: await marketArchive(OTHER2), skillsDir: skills })
    const restored = join(landing, 'SKILL.md')
    expect(existsSync(restored), '锁释放后整库清扫必须把中断副本放回落点').toBe(true)
    expect(readFileSync(restored, 'utf8')).toContain('OLD-CONTENT')
    expect(existsSync(backup), '放回之后副本不再留在 `.skill-tmp`').toBe(false)
  })

  it('同名那条路径不受影响：装同名技能时，中断副本仍在锁内被放回（onlyName）', async () => {
    const skills = await tempDir()
    const backup = await seedInterruptedSwap(skills, VICTIM)

    // 装同名技能（不给 overwrite）：`onlyName` 自愈先把副本放回落点 ⇒ 覆盖守卫随即按
    // "本机内容"拒绝（409 LOCAL_CONTENT）。这条同时钉住"修复没有把同名自愈一起关掉"。
    let failure: unknown
    try {
      await installSkillArchive({ name: VICTIM, archive: await marketArchive(VICTIM), skillsDir: skills })
    } catch (cause) {
      failure = cause
    }
    expect(describeArchiveFailure(failure).code, '副本被放回 ⇒ 覆盖守卫必须如实拒绝').toBe('LOCAL_CONTENT')
    expect(readFileSync(join(skills, VICTIM, 'SKILL.md'), 'utf8'), '落点内容 = 被放回的旧副本').toContain(
      'OLD-CONTENT',
    )
    expect(existsSync(backup), '副本被放回之后不再留在 `.skill-tmp`').toBe(false)
  })
})
