/**
 * tests/audit-r20-skill-identity.spec.ts — R20A-K-04：**逐段身份判据在 `ino` 恒 0 的文件系统上
 * 退化成常量**（`dev:0`），使"搬进来的不是刚校验的那一份"这条唯一的留痕静默消失。
 *
 * 审计证据（`temp/r20/A/S-skills.md` §2.4，探针 `r20a-ino-degradation.spec.ts`）：
 * 同一次确定性注入下，`ino` 正常时日志里有
 * `the copy restored as "victim" is NOT the directory that was verified`；
 * 把 `lstat`/`stat` 的 `ino` 一律改写成 0（模拟 FUSE `-o use_ino=0`、部分 NFS/SMB）后，
 * 同一次逃逸（库外目录被搬进库）**一条告警都没有** —— 因为 `${dev}:0` 与 `${dev}:0` 判等。
 *
 * 修法（本文件钉住的行为）：
 *  - `directoryIdentity` 在 `ino` 不可用时返回 `undefined`（**身份未知，不与任何东西相等**）；
 *  - 复检结论是三态（`same` / `changed` / `identity-unknown`）：未知 ⇒ 破坏性动作
 *    **fail-closed 拒收**并指名"这个文件系统不报告 inode 号"；
 *  - `ino` 正常时原有的那条留痕（"搬进来的不是刚校验的那一份"）一字不变。
 *
 * 本文件**不是**在造一个真实的 ino-0 文件系统（本环境造不出，审计报告已列构造方案：
 * FUSE `-o use_ino=0` / 某些 NFS-SMB / sshfs 组合），而是在钉"判据对 `ino` 的依赖关系"：
 * 未知**不得**被读成"没问题"。注入形态与审计探针逐条一致（同时把 `stat` 与 `lstat` 归零）。
 *
 * 变异（拆掉修复必红）：把 `directoryIdentity` 改回"恒返回 `dev:ino` 字符串"
 * ⇒ 用例 2 红（库外目录被搬进库、落点变成 VAULT-ONLY、日志里没有 inode 成因）。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverInterruptedSkillSwaps, type SkillInstallLog } from '../src/skill-install.ts'

/**
 * 注入控制器（`vi.mock` 的工厂在 import 期求值 ⇒ 状态必须 `vi.hoisted`）。
 *
 *  - `inoZero`：把所有 `lstat`/`stat` 的 `ino` 改写成 0（模拟不报告 inode 的文件系统）；
 *  - `armed`：`settle` 取完"源形态"（对源路径的第 2 次 `lstat`）之后装弹，下一次
 *    `realpath(源)` 返回时把 `.skill-tmp` 换成指向库外的符号链接 —— 这正好落在
 *    "复检之后、`rename` 之前"那个 ~µs 窗口里（确定性，不靠抢时序）。
 */
const ctl = vi.hoisted(() => ({
  inoZero: false,
  armed: false,
  swaps: 0,
  lstats: 0,
  sourcePath: '',
  plan: { lib: '', parked: '', vault: '' },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const zero = <T extends { ino: number }>(info: T): T => {
    if (!ctl.inoZero) return info
    const copy = Object.create(Object.getPrototypeOf(info)) as T
    Object.assign(copy, info)
    Object.defineProperty(copy, 'ino', { value: 0, enumerable: true, configurable: true })
    return copy
  }
  return {
    ...actual,
    default: actual,
    lstat: async (path: never, ...rest: never[]) => {
      const info = zero(await (actual.lstat as never as (p: never, ...r: never[]) => Promise<{ ino: number }>)(path, ...rest))
      // 第 1 次是 `anchored()` 的锚定；第 2 次是 `settle` 的"取源形态" ⇒ 从这里开始装弹。
      if (String(path) === ctl.sourcePath && ++ctl.lstats === 2) ctl.armed = true
      return info
    },
    stat: async (path: never, ...rest: never[]) => zero(
      await (actual.stat as never as (p: never, ...r: never[]) => Promise<{ ino: number }>)(path, ...rest),
    ),
    realpath: async (path: never, ...rest: never[]) => {
      const out = await (actual.realpath as never as (p: never, ...r: never[]) => Promise<string>)(path, ...rest)
      if (ctl.armed && String(path) === ctl.sourcePath) {
        ctl.armed = false
        ctl.swaps++
        const fs = await import('node:fs')
        const nodePath = await import('node:path')
        fs.renameSync(nodePath.join(ctl.plan.lib, '.skill-tmp'), ctl.plan.parked)
        fs.symlinkSync(ctl.plan.vault, nodePath.join(ctl.plan.lib, '.skill-tmp'), 'dir')
      }
      return out
    },
  }
})

const roots: string[] = []

beforeEach(() => {
  ctl.inoZero = false
  ctl.armed = false
  ctl.swaps = 0
  ctl.lstats = 0
  ctl.sourcePath = ''
})

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function recordingLog(): { log: SkillInstallLog, lines: string[] } {
  const lines: string[] = []
  return { log: { warn: (message: string) => { lines.push(message) } }, lines }
}

const LEGIT = '---\nname: victim\ndescription: legit staging copy\n---\n\nbody LEGIT-INSIDE\n'
const VAULT = '---\nname: victim\ndescription: vault copy\n---\n\nbody VAULT-ONLY\n'

/**
 * 造"两处 `rename` 之间崩溃"的盘上形态，并在**复检之后、rename 之前**把 `.skill-tmp`
 * 换成库外 vault 的符号链接：库内 `.skill-tmp/backup-victim-<ts>` 与库外 vault 里的
 * 同名目录内容不同（`LEGIT-INSIDE` vs `VAULT-ONLY`），因此"搬进来的是哪一份"可判定。
 * @param inoZero - 是否让所有 `lstat`/`stat` 报 `ino = 0`。
 */
async function runInjectedSwap(inoZero: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'r20-k04-'))
  roots.push(root)
  const lib = join(root, 'lib')
  const parked = join(root, 'lib-tmp-parked')
  const vault = join(root, 'VAULT-OUTSIDE')
  const entry = 'backup-victim-1790300000000'
  await mkdir(join(lib, '.skill-tmp', entry), { recursive: true, mode: 0o700 })
  await writeFile(join(lib, '.skill-tmp', entry, 'SKILL.md'), LEGIT)
  await mkdir(join(vault, entry), { recursive: true })
  await writeFile(join(vault, entry, 'SKILL.md'), VAULT)

  ctl.plan = { lib, parked, vault }
  ctl.sourcePath = join(lib, '.skill-tmp', entry)
  ctl.inoZero = inoZero
  const { log, lines } = recordingLog()
  const out = await recoverInterruptedSkillSwaps(lib, { onlyName: 'victim', log })
  ctl.inoZero = false
  const landed = existsSync(join(lib, 'victim', 'SKILL.md'))
    ? (await readFile(join(lib, 'victim', 'SKILL.md'), 'utf8'))
    : '(absent)'
  return {
    out,
    lines,
    landed,
    swaps: ctl.swaps,
    vaultCopyStillThere: existsSync(join(vault, entry, 'SKILL.md')),
  }
}

describe('R20A-K-04：`ino` 恒 0 时身份判据不得退化成常量', () => {
  it('ino 正常：窗口被赢下时"搬进来的不是刚校验的那一份"照旧留痕（对照组）', async () => {
    const r = await runInjectedSwap(false)
    /* eslint-disable no-console */
    console.log('[K-04/ino 正常] swaps =', r.swaps, '| out =', JSON.stringify(r.out.map(row => [row.name, row.action])))
    console.log('[K-04/ino 正常] 落点 =', JSON.stringify(r.landed.slice(0, 60)), '| 日志 =', JSON.stringify(r.lines))

    expect(r.swaps, '注入必须真的赢下窗口').toBe(1)
    expect(r.landed).toContain('VAULT-ONLY')                       // 库外目录确实被搬了进来
    expect(r.lines.join('\n')).toMatch(/is NOT the directory that was verified/su)
  }, 60_000)

  it('ino 恒 0：同一次注入必须 fail-closed（拒收 + 指名成因），绝不静默搬库外的目录进来', async () => {
    const r = await runInjectedSwap(true)
    console.log('[K-04/ino=0] out =', JSON.stringify(r.out.map(row => [row.name, row.action])))
    console.log('[K-04/ino=0] 落点 =', JSON.stringify(r.landed.slice(0, 60)), '| 库外那份还在 =', r.vaultCopyStillThere)
    console.log('[K-04/ino=0] 日志 =', JSON.stringify(r.lines))

    // 修前：`out = [["victim","restored"]]`、落点 = VAULT-ONLY、日志里**没有任何**成因。
    expect(r.out, '身份未知 ⇒ 一个字都不动').toEqual([])
    expect(r.landed, '库外目录不得被搬进技能库').toBe('(absent)')
    expect(r.vaultCopyStillThere, '库外唯一副本必须还在').toBe(true)
    expect(r.lines.join('\n')).toMatch(/does not report inode numbers/su)
    expect(r.lines.join('\n')).toMatch(/refused to restore "victim"/su)
  }, 60_000)

  it('取舍对照：ino 恒 0 且路径**没被动过**也拒收（不报告 inode 的文件系统上不做破坏性动作）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r20-k04-ok-'))
    roots.push(root)
    const lib = join(root, 'lib')
    const entry = 'backup-victim-1790300000000'
    await mkdir(join(lib, '.skill-tmp', entry), { recursive: true })
    await writeFile(join(lib, '.skill-tmp', entry, 'SKILL.md'), LEGIT)
    // 不装弹：没有换链接，只是"文件系统不报 inode"。
    ctl.inoZero = true
    const { log, lines } = recordingLog()
    const out = await recoverInterruptedSkillSwaps(lib, { onlyName: 'victim', log })
    ctl.inoZero = false
    console.log('[K-04/取舍] out =', JSON.stringify(out.map(row => [row.name, row.action])), '| 日志 =', JSON.stringify(lines))
    // 这是本档**有意**的取舍（不是恒拒绝的 bug）：身份未知时"搬/删"无法被证明安全，宁可
    // 拒收并说清原因 + 把副本原样留着，也不在一台读不出 inode 的盘上做破坏性动作。
    // "判据不是恒拒绝"的反向对照在用例 1（ino 正常时该恢复就恢复）与既有回归面里。
    expect(out).toEqual([])
    expect(existsSync(join(lib, '.skill-tmp', entry, 'SKILL.md')), '副本必须原样留着').toBe(true)
    expect(lines.join('\n')).toMatch(/does not report inode numbers/su)
  }, 60_000)
})
