/**
 * tests/skill-install-lock.spec.ts — 独立复审 r3 **F3** 的回归（安装器侧 + 跨端）：
 * 「随包同步」与「能力中心安装器」必须**互斥**，否则并发下会落到
 *
 *   内容是插件版 + `.picoaide` 是市场版 + 市场内容被删
 *
 * 这个终态（复审 temp/verify-skill-r3 实测 5/5、真实体量 20 轮 15 轮），而且此后
 * 插件侧永久 `SKILL_CHANNEL_CONFLICT` 拒收该目录 ⇒ **不会自愈**。
 *
 * 修复：两端共用同一把 **per-name 文件锁**（跨包不能 import，故两端各自实现同一
 * 协议；协议要点写在本文件 `SKILL_LOCK_DIR` 的注释与 `skills-sync.js` 的同名常量处，
 * 由 `skill-channel-parity.spec.ts` 对拍钉住）：
 *   - 落点 `<skillsDir>/.skill-locks/<name>.lock`（以点开头 ⇒ 既不是技能目录，
 *     也不会被 `listInstalledSkills` / 上游发现器看见）；
 *   - 内容 `{"pid":<number>,"at":<ms>}`（陈旧判定用）；
 *   - `O_CREAT|O_EXCL` 创建（预置的符号链接/文件一律 EEXIST，绝不跟随）；
 *   - 陈旧 = 持锁 pid **确定已死**（ESRCH），或没有可用 pid 且 mtime 超时；
 *   - 安装器侧**有界等待**（`lockWaitMs`，缺省 5s，等待期间让出事件循环）；
 *     同步侧零等待（它跑在启动路径上，忙等会饿死同进程的异步持锁者）。
 *
 * 用例是**确定性**的：不靠 sleep 撞窗口 —— 「持锁」这件事由 `withSkillLock` 的
 * 临界区直接表达（本文件第 2 例在持锁区内调用**真** `syncBuiltinSkills`）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import {
  describeArchiveFailure,
  installSkillArchive,
  listInstalledSkills,
  readProvenance,
  SKILL_LOCK_DIR,
  withSkillLock,
} from '../src/skill-install.ts'
// 跨端判据必须打**真**同步器（不是测试里另写一份"也会看一眼锁文件"的替身）：
// 互斥的意义就在于这两份实现互相看得见对方的锁。
import { syncBuiltinSkills } from '../../../vendor/memory-evolve/lib/coi/skills-sync.js'

const NAME = 'kimi-cli-calling'
const MARKER = 'memory-consolidate'
const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix = 'skill-lock-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/** gzipped tar 归档（相对路径，与现有 skill-install.spec.ts 同一手法）。 */
async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const dir = await tempDir('skill-lock-archive-')
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

function marketArchive(): Promise<Buffer> {
  return makeArchive({
    'SKILL.md': `---\nname: ${NAME}\ndescription: market\n---\n# MARKET-V3\n`,
  })
}

/** 按协议种一把锁（内容与两端写下的同形）。 */
async function plantLock(skillsDir: string, name: string, body: string, oldMs?: number): Promise<string> {
  await mkdir(join(skillsDir, SKILL_LOCK_DIR), { recursive: true })
  const lockPath = join(skillsDir, SKILL_LOCK_DIR, `${name}.lock`)
  await writeFile(lockPath, body)
  if (oldMs !== undefined) {
    const when = new Date(Date.now() - oldMs)
    utimesSync(lockPath, when, when)
  }
  return lockPath
}

/** 已死进程的 pid（子进程跑完即回收）。 */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid ?? 0
}

/** 造"随包技能源" + "已装的插件版目标"（x-version 1 < 随包 2 ⇒ 会触发换入）。 */
async function seedSyncPair(root: string): Promise<{ pluginSkills: string; userSkills: string }> {
  const pluginSkills = join(root, 'plugin-skills')
  const userSkills = join(root, 'skills')
  await mkdir(join(pluginSkills, MARKER, 'scripts'), { recursive: true })
  await writeFile(join(pluginSkills, MARKER, 'SKILL.md'), `---\nname: ${MARKER}\ndescription: bundled\nx-version: 2\n---\n# BUNDLED\n`)
  await writeFile(join(pluginSkills, MARKER, 'scripts', 'helper.mjs'), '// HELPER\n')
  await mkdir(join(userSkills, MARKER, '.picoaide'), { recursive: true })
  await writeFile(join(userSkills, MARKER, 'SKILL.md'), `---\nname: ${MARKER}\ndescription: installed\nx-version: 1\n---\n# INSTALLED-OLD\n`)
  await writeFile(
    join(userSkills, MARKER, '.picoaide', 'release.json'),
    `${JSON.stringify({ appId: MARKER, version: '1', channel: 'plugin', installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
  )
  return { pluginSkills, userSkills }
}

describe('F3 per-name 文件锁：协议面', () => {
  it('持锁期间锁文件存在且内容为 {pid, at}；释放后消失（不残留）', async () => {
    const skills = await tempDir()
    const lockPath = join(skills, SKILL_LOCK_DIR, `${NAME}.lock`)
    let seen: { pid?: unknown; at?: unknown } | undefined
    let existedDuringTask = false

    await withSkillLock(skills, NAME, async () => {
      existedDuringTask = existsSync(lockPath)
      seen = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; at?: unknown }
    })

    expect(existedDuringTask, '临界区内必须持锁（锁文件存在）').toBe(true)
    expect(seen?.pid).toBe(process.pid)
    expect(typeof seen?.at).toBe('number')
    expect(existsSync(lockPath), '释放后不得残留锁文件').toBe(false)
    // 锁目录以点开头 ⇒ 永远不会被列成"已安装技能"。
    expect(await listInstalledSkills(skills)).toEqual([])
  })

  it('锁文件不属于技能：锁目录里没有任何 SKILL.md，listInstalledSkills 看不见它', async () => {
    const skills = await tempDir()
    await installSkillArchive({ name: NAME, archive: await marketArchive(), skillsDir: skills })
    expect(await listInstalledSkills(skills)).toEqual([NAME])
    expect(existsSync(join(skills, SKILL_LOCK_DIR, 'SKILL.md'))).toBe(false)
  })
})

describe('F3 跨端互斥：同步器必须看得见安装器的锁', () => {
  it('安装器持锁期间，真 syncBuiltinSkills 拒收（SKILL_LOCKED）且目标一字不动', async () => {
    const root = await tempDir()
    const { pluginSkills, userSkills } = await seedSyncPair(root)
    const target = join(userSkills, MARKER, 'SKILL.md')
    const bodyBefore = readFileSync(target, 'utf8')

    await withSkillLock(userSkills, MARKER, async () => {
      // 关键：这不是"另写一份也会看一眼锁文件"的替身 —— 是被测同步器的真实现。
      const results = syncBuiltinSkills(pluginSkills, userSkills) as Array<{ name: string; action: string; code?: string }>
      const entry = results.find((r) => r.name === MARKER)

      expect(entry?.action, `持锁期间不得换入：${JSON.stringify(entry)}`).toBe('refused')
      expect(entry?.code).toBe('SKILL_LOCKED')
    })

    expect(readFileSync(target, 'utf8'), '目标内容必须一字不动').toBe(bodyBefore)
    // 锁释放后同步能正常推进（证明刚才拒收的原因就是锁，而不是别的失败）。
    const after = syncBuiltinSkills(pluginSkills, userSkills) as Array<{ name: string; action: string }>
    expect(after.find((r) => r.name === MARKER)?.action).toBe('synced')
    expect(readFileSync(target, 'utf8')).toMatch(/# BUNDLED/u)
  })
})

describe('F3 安装器侧：拿不到锁就有界 fail-loud，绝不无锁写入', () => {
  it('外部持锁（活 pid）⇒ 有界等待后拒绝，且目标目录零写入；解锁后同一发安装能成功', async () => {
    const skills = await tempDir()
    await plantLock(skills, NAME, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const archive = await marketArchive()

    let failure: unknown
    try {
      await installSkillArchive({ name: NAME, archive, skillsDir: skills, lockWaitMs: 80 })
    } catch (cause) {
      failure = cause
    }
    expect(failure, '拿不到锁必须失败（绝不能无锁写入）').toBeDefined()
    const described = describeArchiveFailure(failure)
    expect(described.code).toBe('SKILL_LOCKED')
    expect(described.status, '锁竞争是可重试的，不能报成"请求有问题"').toBe(503)
    expect(existsSync(join(skills, NAME)), '被锁挡住时目标目录必须零写入').toBe(false)
    expect(existsSync(join(skills, SKILL_LOCK_DIR, `${NAME}.lock`)), '不得删掉活进程的锁').toBe(true)

    // 解锁 ⇒ 同一发安装必须成功（证明拒绝的成因就是那把锁）。
    await rm(join(skills, SKILL_LOCK_DIR, `${NAME}.lock`), { force: true })
    const installed = await installSkillArchive({ name: NAME, archive, skillsDir: skills })
    expect(installed.version).toBeUndefined()
    expect((await readProvenance(join(skills, NAME)))?.channel).toBe('market')
  })

  it('陈旧锁（持锁进程已死）⇒ 抢占并完成安装；陈旧锁（无 pid + mtime 超时）⇒ 同样抢占', async () => {
    const skills = await tempDir()
    const archive = await marketArchive()

    const pid = deadPid()
    expect(Number.isInteger(pid) && pid > 0, '夹具前置：需要一个已死的 pid').toBe(true)
    await plantLock(skills, NAME, JSON.stringify({ pid, at: Date.now() }))
    await installSkillArchive({ name: NAME, archive, skillsDir: skills, lockWaitMs: 2_000 })
    expect((await readProvenance(join(skills, NAME)))?.channel).toBe('market')
    expect(readdirSync(join(skills, SKILL_LOCK_DIR)), '安装完成后不得留下锁残留').toEqual([])

    await rm(join(skills, NAME), { recursive: true, force: true })
    await plantLock(skills, NAME, 'not-json', 60_000)
    await installSkillArchive({ name: NAME, archive, skillsDir: skills, lockWaitMs: 2_000 })
    expect((await readProvenance(join(skills, NAME)))?.channel).toBe('market')
    expect(readdirSync(join(skills, SKILL_LOCK_DIR))).toEqual([])
  })

  it('预置在锁落点上的符号链接：不跟随、不写穿，等不到锁就 fail-loud', async () => {
    const skills = await tempDir()
    const outside = join(await tempDir('skill-lock-outside-'), 'victim.lock')
    await writeFile(outside, 'ORIGINAL\n')
    await mkdir(join(skills, SKILL_LOCK_DIR), { recursive: true })
    symlinkSync(outside, join(skills, SKILL_LOCK_DIR, `${NAME}.lock`))

    await expect(
      installSkillArchive({ name: NAME, archive: await marketArchive(), skillsDir: skills, lockWaitMs: 80 }),
    ).rejects.toThrow()
    expect(readFileSync(outside, 'utf8'), '库外 victim 不得被写穿').toBe('ORIGINAL\n')
  })
})
