/**
 * tests/skill-lock-removal-window.spec.ts — R23-W2-02 的仓内回归判据。
 *
 * ## 缺口原形态（第二十三轮独立复审 W2-02，P2）
 *
 * `acquireSkillDirLock` 一轮循环里有**三条按路径的 `rm(lockPath)`**：
 *
 * | # | 用途 | 紧邻锚定复检 | `dev/ino` 守卫 |
 * |---|---|---|---|
 * | ① | 写锁失败后的收尾（`handle.writeFile` 抛错 ⇒ `rm`） | ✗ | ✗ |
 * | ② | **释放**闭包（正常归还锁） | ✗ | ✓（`:563-569`） |
 * | ③ | **陈旧抢占**（`isSkillLockStale` ⇒ `rm`） | ✗ | ✗ |
 *
 * 同一不变量（"按路径的破坏性 syscall 之前必须能证明'要删的就是那一份'"）只收口了
 * 三条里的一条。③ 的窗口比 ① 那个更宽：与循环顶部那次紧邻复检之间隔着 `open` 与
 * `isSkillLockStale` 两次 IO。确定性注入实测（本轮之前）：库内 `.skill-locks` 被换成
 * 指向库外的链接时，**库外那份"看起来陈旧"的同名文件被删掉了** —— 危害类别是
 * "删了别人的文件"，比"在库外写了自己的文件"更重。② 保持原样（见
 * `removeGuardedSkillLock` 的注释：它在热路径上，且再加一次重锚会在"证明不了身份"
 * 的文件系统上把锁永久留在盘上，比误删更难恢复）。
 *
 * ## 三个形态各杀死哪一条（确定性注入，不抢时序）
 *
 *  | 形态 | 注入点 | 修复前 | 杀死哪条变异 |
 *  |---|---|---|---|
 *  | A `stale-symlink` | `open(lockPath)` 委托**之前**把 `.skill-locks` 换成库外链接 | 库外陈旧诱饵被 ③ 删掉 | 去掉 `recheckAnchoredLibraryPath` |
 *  | B `replace-lock` | `readFile(lockPath)` 委托**之后**把锁文件**原子替换**成另一份（新 inode，仍在线） | 别人的新锁被 ③ 删掉 | 去掉 `dev/ino` 复验 |
 *  | C `write-fail` | `open` 成功**之后**换目录 + 让 `handle.writeFile` 抛错 | 库外诱饵被 ① 删掉 | 去掉两条守卫中的任一条（① 走同一条实现） |
 *
 * 形态 B 的替换用 `writeFile(<锁>.fresh)` + `rename` —— 新 inode 在旧 inode **还活着**
 * 时分配，所以两次 `stat` 的 `ino` 必然不同（不是"期望文件系统不复用 inode"的赌）。
 * 每个形态都先断言注入真的命中（`swaps === 1`），再断言**库外/别人的文件一字不动**
 * 与**拒绝可见**（`refused …` 日志或下一轮复检的稳定码）。每个形态另配正向对照：
 * 没有注入时陈旧锁照常被抢占、安装照常成功（修复不得把锁的可用性弄坏）。
 *
 * ## 变异验证（把修复拆掉 ⇒ 本文件红）
 *
 *  - 陈旧抢占改回 `readStaleSkillLock` + 裸 `rm` ⇒ A、B 红；
 *  - `removeGuardedSkillLock` 去掉 `dev/ino` 那一段 ⇒ B、C 红；
 *  - 去掉 `recheckAnchoredLibraryPath` 那一段 ⇒ A 红；
 *  - 写锁失败那条改回裸 `rm` ⇒ C 红。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  installSkillArchive,
  SKILL_LOCK_DIR,
  SkillLockedError,
  uninstallSkill,
  type SkillInstallLog,
} from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

/** 死 pid（Linux 的 pid_max 上限附近，`kill(pid, 0)` 必 ESRCH）。 */
const DEAD_PID = 2_147_483_646

/** 注入控制器（`vi.hoisted`：`vi.mock` 工厂不能引用普通顶层变量）。 */
const hooks = vi.hoisted(() => ({
  armed: false,
  mode: 'none' as 'none' | 'stale-symlink' | 'replace-lock' | 'write-fail',
  swaps: 0,
  plan: { lockDir: '', lockTarget: '', parked: '', vault: '', decoy: '' },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const pathOf = (value: unknown): string =>
    typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : String(value)

  const freshLockBody = (): string => JSON.stringify({ pid: process.pid, at: Date.now() })

  /** 形态 A：`.skill-locks` 旁置，原位换成指向库外 vault 的链接（vault 里放一份**陈旧**同名诱饵）。 */
  const swapDirForVaultLink = (): void => {
    hooks.swaps++
    renameSync(hooks.plan.lockDir, hooks.plan.parked)
    mkdirSync(hooks.plan.vault, { recursive: true })
    writeFileSync(hooks.plan.decoy, JSON.stringify({ pid: DEAD_PID, at: 1 }))
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(hooks.plan.decoy, old, old)
    symlinkSync(hooks.plan.vault, hooks.plan.lockDir, 'dir')
  }

  /** 形态 B：把锁文件**原子替换**成另一份（新 inode 在旧 inode 还活着时分配 ⇒ 必不同）。 */
  const replaceLockFile = (): void => {
    hooks.swaps++
    const tmp = `${hooks.plan.lockTarget}.fresh`
    writeFileSync(tmp, freshLockBody())
    renameSync(tmp, hooks.plan.lockTarget)
  }

  const isLockTarget = (value: unknown): boolean => hooks.plan.lockTarget !== '' && pathOf(value) === hooks.plan.lockTarget

  return {
    ...actual,
    default: actual,
    open: async (target: never, ...rest: never[]) => {
      const lock = isLockTarget(target)
      // 形态 A：在**委托之前**换 —— 等价于"循环顶部那次复检之后、open 之前"的窗口。
      if (hooks.armed && lock && hooks.mode === 'stale-symlink' && hooks.swaps === 0) swapDirForVaultLink()
      const handle = await (actual.open as never as (p: never, ...r: never[]) => Promise<unknown>)(target, ...rest)
      // 形态 C：`open` 已经成功（库内锁已建），此时换目录并让随后的写入失败。
      if (hooks.armed && lock && hooks.mode === 'write-fail' && hooks.swaps === 0) {
        swapDirForVaultLink()
        const real = handle as { stat: () => Promise<unknown>, close: () => Promise<void> }
        return {
          stat: () => real.stat(),
          close: () => real.close(),
          writeFile: () => { throw new Error('injected lock write failure') },
        }
      }
      return handle
    },
    readFile: async (target: never, ...rest: never[]) => {
      const result = await (actual.readFile as never as (p: never, ...r: never[]) => Promise<unknown>)(target, ...rest)
      // 形态 B：陈旧判定**读到内容之后**才替换 ⇒ 判定基于旧那一份、删除面对新那一份。
      if (hooks.armed && hooks.mode === 'replace-lock' && hooks.swaps === 0 && isLockTarget(target)) replaceLockFile()
      return result
    },
  }
})

const dirs: string[] = []

function recordingLog(): { log: SkillInstallLog, lines: string[] } {
  const lines: string[] = []
  return { log: { warn: (message: string) => { lines.push(message) } }, lines }
}

beforeEach(() => {
  isolateRuntimeSkillRoots()
  hooks.armed = false
  hooks.mode = 'none'
  hooks.swaps = 0
  hooks.plan = { lockDir: '', lockTarget: '', parked: '', vault: '', decoy: '' }
})

afterEach(async () => {
  hooks.armed = false
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Home {
  home: string
  skillsDir: string
  vault: string
  decoy: string
  lockDir: string
  lockTarget: string
}

async function home(prefix: string): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(root)
  const skillsDir = join(root, 'skills')
  const vault = join(root, 'vault')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(vault, { recursive: true })
  const lockDir = join(skillsDir, SKILL_LOCK_DIR)
  return { home: root, skillsDir, vault, decoy: join(vault, 'plug.lock'), lockDir, lockTarget: join(lockDir, 'plug.lock') }
}

/** 一份最小的、可加载的 SKILL.md。 */
const MD = `---\nname: plug\ndescription: lock removal window probe\nversion: 1.0.0\n---\n\nbody of plug\n`

function archiveOf(): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(MD, 'utf8'), '', 0o644)
  return zip.toBuffer()
}

/** 放一把"看起来陈旧"的锁（死 pid + 一小时前的 mtime）。 */
async function placeStaleLock(skillsDir: string): Promise<void> {
  const lockDir = join(skillsDir, SKILL_LOCK_DIR)
  await mkdir(lockDir, { recursive: true })
  const lock = join(lockDir, 'plug.lock')
  await writeFile(lock, JSON.stringify({ pid: DEAD_PID, at: 1 }))
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(lock, old, old)
}

function arm(f: Home, mode: typeof hooks.mode): void {
  hooks.plan = {
    lockDir: f.lockDir, lockTarget: f.lockTarget, parked: join(f.home, 'parked'), vault: f.vault, decoy: f.decoy,
  }
  hooks.mode = mode
  hooks.armed = true
}

function outcomeOf(error: unknown): string {
  if (error instanceof ArchiveInstallRefusal) return `refused:${error.code}`
  if (error instanceof SkillLockedError) return 'locked'
  return `throw:${String(error)}`
}

describe('R23-W2-02 陈旧抢占的 rm 窗口：库外的"看起来陈旧"的同名文件必须原样存在', () => {
  it('形态 A（.skill-locks 换成库外链接）⇒ 库外诱饵一字不动 + 拒绝可见', async () => {
    const f = await home('r23w2-lockrm-a-')
    await placeStaleLock(f.skillsDir)
    const { log, lines } = recordingLog()
    const before = statSync(f.decoy, { throwIfNoEntry: false })
    expect(before, '前置：注入会在 vault 里放一份诱饵').toBeUndefined()
    arm(f, 'stale-symlink')

    const outcome = await installSkillArchive({
      name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market', lockWaitMs: 1_000, log,
    }).then(() => 'installed', outcomeOf)

    expect(hooks.swaps, '注入必须命中窗口（没命中 ⇒ 判据无效）').toBe(1)
    expect(existsSync(f.decoy), '库外同名诱饵不得被删').toBe(true)
    expect(JSON.parse(readFileSync(f.decoy, 'utf8')), '诱饵内容不得被改写').toEqual({ pid: DEAD_PID, at: 1 })
    expect(outcome, '库内私有目录不可信 ⇒ fail-loud').toBe('refused:LIBRARY_TEMP_UNSAFE')
    expect(lines.join('\n'), '拒绝必须留痕').toContain('refused to remove the stale per-name lock')
    expect(existsSync(join(f.skillsDir, 'plug')), '安装本身 fail-closed，一个字都不写').toBe(false)
  }, 60_000)

  it('形态 B（陈旧锁被原子替换成别人的新锁）⇒ 别人的锁必须原样存在', async () => {
    const f = await home('r23w2-lockrm-b-')
    await placeStaleLock(f.skillsDir)
    const staleIno = statSync(f.lockTarget).ino
    const { log, lines } = recordingLog()
    arm(f, 'replace-lock')

    const outcome = await installSkillArchive({
      name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market', lockWaitMs: 300, log,
    }).then(() => 'installed', outcomeOf)

    expect(hooks.swaps, '注入必须命中窗口').toBe(1)
    expect(existsSync(f.lockTarget), '别人的新锁不得被我们删掉').toBe(true)
    const after = statSync(f.lockTarget)
    expect(after.ino, '语料构造：替换后确实是另一个 inode（新 inode 在旧 inode 还活着时分配）').not.toBe(staleIno)
    expect(JSON.parse(readFileSync(f.lockTarget, 'utf8')), '留下的是新锁而不是被删掉的旧锁').toEqual({ pid: process.pid, at: expect.any(Number) })
    expect(outcome, '换成"仍在线"的锁 ⇒ 有界等待后 fail-loud，绝不无锁写入').toBe('locked')
    expect(lines.join('\n'), '拒绝必须留痕').toContain('refused to remove the stale per-name lock')
    expect(lines.join('\n'), '原因要点名身份变化').toContain('device/inode changed')
    expect(existsSync(join(f.skillsDir, 'plug')), '没拿到锁 ⇒ 一个字都不写').toBe(false)
  }, 60_000)

  it('形态 C（写锁失败后的收尾 rm）⇒ 库外诱饵一字不动', async () => {
    const f = await home('r23w2-lockrm-c-')
    await mkdir(f.lockDir, { recursive: true })
    const { log, lines } = recordingLog()
    arm(f, 'write-fail')

    const outcome = await installSkillArchive({
      name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market', lockWaitMs: 300, log,
    }).then(() => 'installed', outcomeOf)

    expect(hooks.swaps, '注入必须命中窗口').toBe(1)
    expect(existsSync(f.decoy), '库外同名诱饵不得被删').toBe(true)
    expect(JSON.parse(readFileSync(f.decoy, 'utf8')), '诱饵内容不得被改写').toEqual({ pid: DEAD_PID, at: 1 })
    expect(lines.join('\n'), '收尾那条 rm 被拒时必须留痕').toMatch(/refused to remove the lock file this installer just created/u)
    expect(outcome, '写入失败本身照旧向上抛（修复不改错误传播）').toContain('injected lock write failure')
  }, 60_000)

  it('正向对照：没有注入时陈旧锁照常被抢占、安装照常成功、锁不残留', async () => {
    const f = await home('r23w2-lockrm-ok-')
    await placeStaleLock(f.skillsDir)
    const { log, lines } = recordingLog()
    hooks.armed = false
    await installSkillArchive({
      name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market', lockWaitMs: 2_000, log,
    })
    expect(existsSync(join(f.skillsDir, 'plug', 'SKILL.md')), '陈旧锁必须仍可被抢占（修复不得把锁弄坏）').toBe(true)
    expect(existsSync(f.lockTarget), '安装结束后锁不得残留').toBe(false)
    expect(lines.join('\n'), '正常路径不该有拒绝日志').not.toContain('refused')
  }, 60_000)

  it('正向对照：库内预置链接（静态形态）同样不动库外文件', async () => {
    const f = await home('r23w2-lockrm-static-')
    writeFileSync(f.decoy, 'OUTSIDE-DECOY\n')
    symlinkSync(f.vault, f.lockDir, 'dir')
    const { log } = recordingLog()
    hooks.armed = false
    const cause = await installSkillArchive({
      name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market', lockWaitMs: 300, log,
    }).then(() => undefined, (error: unknown) => error)
    expect(cause).toBeInstanceOf(ArchiveInstallRefusal)
    expect((cause as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(readFileSync(f.decoy, 'utf8'), '库外诱饵必须原样存在').toBe('OUTSIDE-DECOY\n')
    // 锚定失败是**抛**（不是日志）：拒绝必须点名"库内私有目录不可信"。
    expect((cause as Error).message, '锚定失败的文案要点名原因').toMatch(/not a real directory inside the skill library/u)
  }, 60_000)
})

describe('R23-W2-02 卸载路径接的是同一条实现（两个调用点都过守卫）', () => {
  it('卸载时注入形态 A ⇒ 库外诱饵一字不动', async () => {
    const f = await home('r23w2-lockrm-uninstall-')
    await installSkillArchive({ name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market' })
    await placeStaleLock(f.skillsDir)
    const { log, lines } = recordingLog()
    arm(f, 'stale-symlink')

    const outcome = await uninstallSkill(f.skillsDir, 'plug', { overwrite: true, log }).then(removed => `removed:${removed}`, outcomeOf)

    expect(hooks.swaps, '注入必须命中卸载路径的取锁窗口').toBe(1)
    expect(existsSync(f.decoy), '库外同名诱饵不得被删').toBe(true)
    expect(JSON.parse(readFileSync(f.decoy, 'utf8'))).toEqual({ pid: DEAD_PID, at: 1 })
    expect(outcome, '不可信即 fail-loud').toBe('refused:LIBRARY_TEMP_UNSAFE')
    expect(lines.join('\n')).toContain('refused to remove the stale per-name lock')
    expect(existsSync(join(f.skillsDir, 'plug', 'SKILL.md')), '卸载失败时不得动目标').toBe(true)
  }, 60_000)

  it('正向对照：没有注入时卸载正常完成', async () => {
    const f = await home('r23w2-lockrm-uninstall-ok-')
    await installSkillArchive({ name: 'plug', archive: archiveOf(), skillsDir: f.skillsDir, channel: 'market' })
    const { log, lines } = recordingLog()
    hooks.armed = false
    await uninstallSkill(f.skillsDir, 'plug', { overwrite: true, log })
    expect(existsSync(join(f.skillsDir, 'plug'))).toBe(false)
    expect(existsSync(f.lockTarget), '锁不得残留').toBe(false)
    expect(lines.join('\n')).not.toContain('refused')
  }, 60_000)
})

/** 兜底自检：形态 B 的替换语义（新 inode 必然不同于旧 inode）不依赖文件系统的 inode 复用策略。 */
describe('R23-W2-02 语料自检', () => {
  it('`writeFile(<锁>.fresh)` + `rename` 替换后 inode 必然变化', async () => {
    const f = await home('r23w2-lockrm-selfcheck-')
    await mkdir(f.lockDir, { recursive: true })
    await writeFile(f.lockTarget, 'A')
    const before = statSync(f.lockTarget).ino
    writeFileSync(`${f.lockTarget}.fresh`, 'B')
    renameSync(`${f.lockTarget}.fresh`, f.lockTarget)
    expect(statSync(f.lockTarget).ino, '两个同时存在的文件不可能共享 inode').not.toBe(before)
    expect(readFileSync(f.lockTarget, 'utf8')).toBe('B')
    rmSync(f.lockTarget, { force: true })
  })
})
