/**
 * tests/skill-remove-window.spec.ts — R21-A1-05 的仓内回归判据（判据面缺口）。
 *
 * ## 缺口原形态
 *
 * `removeAnchoredLibraryEntry`（`skill-install.ts`）是**删除面**唯一的"断言 → syscall"
 * 收口点：它在 `rm` 之前**紧邻复检**一次逐段身份（`recheckAnchoredLibraryPath`），
 * 服务两条路径（陈旧 staging 清扫、换入自愈的副本作废）。审计实测：把这两行掏空
 * （保留锚定、只去掉紧邻复检）后，13 个 skill spec **全绿** —— "锚定之后、`rm` 之前
 * 被换掉"这一窗口没有任何判据能杀。
 *
 * ## 这份用例怎么做到确定性（不靠抢时序）
 *
 * 注入口是 `staleAge()` 读到的那个 `lstat`：它由**调用方**（`sweepStaleSkillTemps`）
 * 发出，位置在"条目锚定成功之后、`removeAnchoredLibraryEntry` 之前"，**修复版与
 * 掏空版都有这一步**。挂钩在那个 `lstat` 上把 `<库>/.skill-tmp` 换成指向库外 vault 的
 * 符号链接：
 *
 *  - 修复版：`removeAnchoredLibraryEntry` 的紧邻复检看见 `.skill-tmp` 不再是真实目录
 *    ⇒ 拒收，**一个字都不动**；
 *  - 掏空版（变异）：`rm(<库>/.skill-tmp/install-x)` 顺着链接删掉 **vault 里的同名
 *    诱饵目录** ⇒ 库外被删。
 *
 * 判据因此落在"库外诱饵还在不在"，而注入点对两个版本都必然触发（不会出现"变异体没
 * 被注入到 ⇒ 假绿"）。前置断言（诱饵确实存在 + 链接确实换上了）挡住"注入没生效"。
 *
 * ## 变异验证
 *
 * 把 `removeAnchoredLibraryEntry` 的 `if (!verdict.holds)` 改成 `if (false)`
 * ⇒ 本文件红（库外 `DECOY-OUTSIDE.txt` 消失）；恢复即绿。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_TEMP_DIR, sweepStaleSkillTemps, type SkillInstallLog } from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

/**
 * 注入控制器。`stage = 2`：**第二次** `lstat(<库>/.skill-tmp/install-x)` 时换掉
 * `.skill-tmp`（第一次是条目锚定的逐段 lstat，第二次是调用方的 `staleAge`）。
 */
const hooks = vi.hoisted(() => ({
  armed: false,
  swaps: 0,
  plan: { tempRoot: '', entryPath: '', parked: '', vault: '', decoy: '' },
  seenEntryStats: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const swapNow = async (): Promise<void> => {
    hooks.swaps++
    const fs = await import('node:fs')
    const nodePath = await import('node:path')
    // ① `.skill-tmp` 旁置（原封不动），② 原位放一个指向库外 vault 的符号链接，
    // ③ vault 里放一份**同名**的真实目录作为诱饵（它是"库外"的可判定证据）。
    fs.renameSync(hooks.plan.tempRoot, hooks.plan.parked)
    fs.mkdirSync(hooks.plan.decoy, { recursive: true })
    fs.writeFileSync(nodePath.join(hooks.plan.decoy, 'DECOY-OUTSIDE.txt'), 'OUTSIDE-DATA\n')
    fs.symlinkSync(hooks.plan.vault, hooks.plan.tempRoot, 'dir')
  }
  return {
    ...actual,
    default: actual,
    lstat: async (path: never, ...rest: never[]) => {
      const target = String(path)
      if (hooks.armed && target === hooks.plan.entryPath) {
        hooks.seenEntryStats++
        if (hooks.seenEntryStats === 2 && hooks.swaps === 0) {
          await swapNow()
        }
      }
      return await (actual.lstat as never as (p: never, ...r: never[]) => Promise<unknown>)(path, ...rest)
    },
  }
})

const dirs: string[] = []
let warns: string[] = []

function recordingLog(): SkillInstallLog {
  return { warn: (message: string) => { warns.push(message) } }
}

beforeEach(() => {
  isolateRuntimeSkillRoots()
  hooks.armed = false
  hooks.swaps = 0
  hooks.seenEntryStats = 0
  warns = []
})

afterEach(async () => {
  hooks.armed = false
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 造一棵"库内有一个陈旧 staging 目录、库外有一份同名诱饵"的树。 */
async function fixture(): Promise<{ skillsDir: string, tempRoot: string, vault: string, decoy: string, entryPath: string, parked: string }> {
  const home = await mkdtemp(join(tmpdir(), 'r21a1-win-'))
  dirs.push(home)
  const skillsDir = join(home, 'skills')
  const vault = join(home, 'vault')
  await mkdir(join(skillsDir, SKILL_TEMP_DIR, 'install-x'), { recursive: true })
  await writeFile(join(skillsDir, SKILL_TEMP_DIR, 'install-x', 'SKILL.md'), '---\nname: x\ndescription: stale\n---\nbody\n')
  await mkdir(vault, { recursive: true })
  const tempRoot = join(skillsDir, SKILL_TEMP_DIR)
  const entryPath = join(tempRoot, 'install-x')
  const decoy = join(vault, 'install-x')
  const parked = join(home, 'parked-temp')
  const older = new Date(Date.now() - 60 * 60 * 1000)
  await utimes(join(skillsDir, SKILL_TEMP_DIR, 'install-x'), older, older)
  hooks.plan = { tempRoot, entryPath, parked, vault, decoy }
  return { skillsDir, tempRoot, vault, decoy, entryPath, parked }
}

describe('R21-A1-05 删除面窗口：锚定之后、rm 之前被换掉 ⇒ 拒收且库外一字不动', () => {
  it('陈旧 staging 清扫：`.skill-tmp` 在紧邻复检之前被换成库外链接 ⇒ 库外诱饵必须原样存在', async () => {
    const f = await fixture()
    // 前置断言：诱饵一开始并不存在（否则"还在"是假绿）。
    expect(existsSync(f.decoy), '诱饵由注入动作创建，跑之前不该存在').toBe(false)
    hooks.armed = true

    // 阈值取负：诱饵是在注入那一刻（`sweepStaleSkillTemps` 已取过 `now` 之后）建出来的，
    // 它的 `age = now - mtimeMs` 可能 ≤ 0 —— 用 0 会被年龄闸门静默跳过（判据失去输入）。
    const removed = await sweepStaleSkillTemps(f.skillsDir, -60_000, undefined, recordingLog())

    // 注入真的发生了（两条都必须成立，否则本用例什么都没证明）。
    expect(hooks.swaps, '注入必须命中删除面的窗口（没命中 ⇒ 判据无效）').toBe(1)
    expect(hooks.seenEntryStats, '注入点必须是调用方的 staleAge lstat').toBeGreaterThanOrEqual(2)
    // 库外：诱饵与它的内容一字不动。
    expect(existsSync(join(f.decoy, 'DECOY-OUTSIDE.txt')), '库外目录不得被删（掏空复检 ⇒ 这里消失）').toBe(true)
    expect(await readdir(f.decoy)).toEqual(['DECOY-OUTSIDE.txt'])
    // 库内：这次删除被如实拒收并留痕（不是"删了但没报"）。
    expect(removed, '拒收时计数必须为 0').toBe(0)
    expect(warns.join('\n'), '拒绝必须留痕').toContain('refused to remove')
    expect(warns.join('\n')).toContain('could not be re-verified before the removal')
    // 旁置的那份**库内**staging 原样保留（宁可留残骸，不越界）。
    expect(existsSync(join(f.parked, 'install-x', 'SKILL.md')), '库内那份不得被删（它已经不在原位，但也不该被我们动）').toBe(true)
  })

  it('对照：没有注入时同一棵树的清扫照常成功（判据咬的是窗口，不是"清扫本身坏了"）', async () => {
    const f = await fixture()
    hooks.armed = false
    // 阈值取负：诱饵是在注入那一刻（`sweepStaleSkillTemps` 已取过 `now` 之后）建出来的，
    // 它的 `age = now - mtimeMs` 可能 ≤ 0 —— 用 0 会被年龄闸门静默跳过（判据失去输入）。
    const removed = await sweepStaleSkillTemps(f.skillsDir, -60_000, undefined, recordingLog())
    expect(removed).toBe(1)
    expect(existsSync(join(f.skillsDir, SKILL_TEMP_DIR, 'install-x'))).toBe(false)
    expect(warns.join('\n')).toContain('removed "install-x"')
  })
})
