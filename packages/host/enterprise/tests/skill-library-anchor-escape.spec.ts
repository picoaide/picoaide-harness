/**
 * tests/skill-library-anchor-escape.spec.ts — 第十九轮审计 A 泳道（R19A-S2-01/02/03）的
 * 回归判据：**技能库内路径的"间接层"与"断言—操作窗口"**。
 *
 * ## 三条缺陷（修前形态，探针 `temp/r19/A/sk/.../tests/r19a/*.spec.ts` 实测）
 *
 * 1. **R19A-S2-01（TOCTOU）**：`realDirectoryUnderLibrary` 的断言与 `rm`/`rename`
 *    之间把 `.skill-tmp` 换成符号链接 ⇒ `rename` 把**库外**目录搬进技能库、库外唯一
 *    副本消失（确定性插桩；并发翻转 22680 次未命中只说明窗口窄）。
 * 2. **R19A-S2-02（staging 未过闸）**：`installSkillArchive` 自己建 staging 的三行
 *    没走那道闸 ⇒ `.skill-tmp` 是库外链接时，staging 与解包内容（每份最多 64MiB）
 *    落在**库外**。
 * 3. **R19A-S2-03（目录形态的间接层）**：`lstat().isDirectory()` 只回答"不是符号链接"。
 *    **bind mount**（Linux，本文件用真实 `mount --bind` 实证）在 `lstat` 下就是真实
 *    目录，`realpath` 也原样返回 ⇒ 闸门放行、路径操作落到库外（库外唯一副本被删）。
 *    同族的 Windows **junction** 由 `realpath` 判据覆盖（本机无法实证，见报告边界）。
 *
 * ## 修法与判据
 *
 * 路径断言收口到 `anchorLibraryPath`（五条：realpath 锚 / 逐段真实目录 / `realpath`
 * 自等 / 挂载表 / 同设备），并在 syscall 前后用**逐段身份（dev:ino）**复检；staging
 * 的落点由 `ensureLibraryTempRoot` 过闸。本文件的判据全部是**真实 fs 结果**：
 * 库外那份文件还在不在、库外目录有没有被搬走、是否有一个字节写到库外。
 *
 * ## 变异（拆掉修复必红，逐条实跑见 temp/r19/V/REPORT.md）
 *   - 去掉 `settle` 里 rename 之前那次 `anchoredLibraryPathStillHolds` ⇒ 用例 1 红；
 *   - 去掉 `ensureLibraryTempRoot` 的锚定（回到字符串拼路径）⇒ 用例 2 红；
 *   - 去掉 `anchorLibraryPath` 里的挂载点判据 ⇒ 用例 3 红（有 `mount` 权限时）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  installSkillArchive,
  recoverInterruptedSkillSwaps,
  sweepStaleSkillTemps,
  type SkillCleanupRecord,
  type SkillInstallLog,
} from '../src/skill-install.ts'

/**
 * TOCTOU 插桩的控制器（`vi.mock` 的工厂在 import 期求值，所以状态必须 `vi.hoisted`）。
 * `swapOn` 非空时：安装器 `lstat` 这个路径的那一刻，把 `<库>/.skill-tmp` 改名旁置、
 * 在原位放一个指向金库的符号链接 —— 这正是修前打穿的那个窗口。
 */
const swapCtl = vi.hoisted(() => ({
  swapOn: '',
  swapped: 0,
  plan: { skills: '', parked: '', vault: '' },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    lstat: async (path: never, ...rest: never[]) => {
      if (swapCtl.swapOn !== '' && String(path) === swapCtl.swapOn && swapCtl.swapped === 0) {
        swapCtl.swapped++
        const fs = await import('node:fs')
        const nodePath = await import('node:path')
        fs.renameSync(nodePath.join(swapCtl.plan.skills, '.skill-tmp'), swapCtl.plan.parked)
        fs.symlinkSync(swapCtl.plan.vault, nodePath.join(swapCtl.plan.skills, '.skill-tmp'), 'dir')
      }
      return await (actual.lstat as never as (p: never, ...r: never[]) => Promise<unknown>)(path, ...rest)
    },
  }
})

const roots: string[] = []
const mounts: string[] = []

/** 每条判据都用"注入的日志出口"取证据（缺省 `console` 在生产是彻底静默的一条路）。 */
function recordingLog(): { log: SkillInstallLog, lines: string[] } {
  const lines: string[] = []
  return { log: { warn: (message: string) => { lines.push(message) } }, lines }
}

function unmountAll(): void {
  for (const target of mounts.splice(0)) {
    try { execFileSync('umount', [target], { stdio: 'ignore' }) } catch { /* 已卸载 */ }
  }
}

afterEach(async () => {
  unmountAll()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: probe ${name} (${marker})\n---\n\nbody ${marker}\n`
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** 最小可安装归档（SKILL.md 在归档根）。 */
async function skillArchive(name: string, marker: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'r19v-anchor-arc-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), skillMd(name, marker), 'utf8')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const stream = tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** `mount --bind`（需要 CAP_SYS_ADMIN；不可用时用例退化成"机制不可用"的如实报告）。 */
function bind(source: string, target: string): boolean {
  try {
    execFileSync('mount', ['--bind', source, target], { stdio: 'ignore' })
    mounts.push(target)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// R19A-S2-01：断言与 rename 之间换掉 `.skill-tmp`
// ---------------------------------------------------------------------------

describe('R19A-S2-01：`.skill-tmp` 在断言之后被换成库外链接 ⇒ 拒收（库外一字不动）', () => {
  it('确定性插桩：换在"取落点形态"那一刻，rename 之前必须被复检拦住', async () => {
    const root = await tempRoot('r19v-toctou-')
    const skills = join(root, 'skills')
    const parked = join(root, 'skills-tmp-parked')
    const vault = join(root, 'vault')
    await mkdir(join(skills, '.skill-tmp', 'backup-victim-1700000000000'), { recursive: true })
    await writeFile(join(skills, '.skill-tmp', 'backup-victim-1700000000000', 'SKILL.md'), skillMd('victim', 'INSIDE'))
    await mkdir(join(vault, 'backup-victim-1700000000000'), { recursive: true })
    await writeFile(join(vault, 'backup-victim-1700000000000', 'SKILL.md'), skillMd('victim', 'VAULT'))
    await writeFile(join(vault, 'backup-victim-1700000000000', 'only-copy.txt'), 'VAULT-ONLY\n')
    swapCtl.plan = { skills, parked, vault }
    swapCtl.swapped = 0
    // 插桩点 = 安装器 `lstat(<库>/victim)` 的那一刻（settle 里的"落点形态"判据）：
    // 这正是修前探针打穿的窗口，此处之后才轮到 `rename`。
    swapCtl.swapOn = join(skills, 'victim')

    const { log, lines } = recordingLog()
    const out = await recoverInterruptedSkillSwaps(skills, { log })
    swapCtl.swapOn = ''
    console.log('[S2-01] out =', JSON.stringify(out.map(row => [row.name, row.action])), '| 插桩触发 =', swapCtl.swapped)
    console.log('[S2-01] 日志 =', JSON.stringify(lines))
    // 插桩必须真的触发（否则这条判据咬不到）。
    expect(swapCtl.swapped, '插桩必须触发').toBe(1)
    // 修前：out = [["victim","restored"]]、落点是 VAULT、库外唯一副本消失。
    expect(out, '窗口内被替换 ⇒ 一个字都不动').toEqual([])
    expect(existsSync(join(vault, 'backup-victim-1700000000000', 'only-copy.txt')), '库外唯一副本必须还在').toBe(true)
    expect(existsSync(join(skills, 'victim')), '库外目录不得被搬进技能库').toBe(false)
    expect(lines.join('\n')).toMatch(/refused to restore "victim".*replaced while it was being checked/su)
  })

  it('反向对照：不换 ⇒ 崩溃自愈照常把旧内容放回落点（判据不是恒拒绝）', async () => {
    const root = await tempRoot('r19v-toctou-ok-')
    const skills = join(root, 'skills')
    await mkdir(join(skills, '.skill-tmp', 'backup-good-1700000000000'), { recursive: true })
    await writeFile(join(skills, '.skill-tmp', 'backup-good-1700000000000', 'SKILL.md'), skillMd('good', 'ONLY-COPY'))
    const out = await recoverInterruptedSkillSwaps(skills, {})
    expect(out.map(row => [row.name, row.action])).toEqual([['good', 'restored']])
    expect(await readFile(join(skills, 'good', 'SKILL.md'), 'utf8')).toContain('ONLY-COPY')
  })
})

// ---------------------------------------------------------------------------
// R19A-S2-02：安装 staging 必须过闸
// ---------------------------------------------------------------------------

describe('R19A-S2-02：`.skill-tmp` 是库外链接 ⇒ 安装拒收，库外零字节', () => {
  it('staging 不在库内 ⇒ LIBRARY_TEMP_UNSAFE（修前：解包内容落在库外）', async () => {
    const base = await tempRoot('r19v-staging-')
    const skills = join(base, 'skills')
    const vaultTmp = join(base, 'outside', 'vault-tmp')
    await mkdir(skills, { recursive: true })
    await mkdir(vaultTmp, { recursive: true })
    symlinkSync(vaultTmp, join(skills, '.skill-tmp'), 'dir')

    const refusal = await installSkillArchive({
      name: 'alpha',
      archive: await skillArchive('alpha', 'FROM-HUB'),
      skillsDir: skills,
      version: '1.0.0',
      channel: 'market',
    }).then(() => undefined, (cause: unknown) => cause as Error)
    console.log('[S2-02] 拒绝 =', refusal?.message)
    expect(refusal).toBeInstanceOf(ArchiveInstallRefusal)
    expect((refusal as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect(refusal?.message).toMatch(/staging area \.skill-tmp is not a real directory/su)
    // 关键判据：库外**一个字节都没写**（修前 staging 与解包内容都落在链接目标下）。
    expect(await readdir(vaultTmp), '库外不得留下任何 staging 内容').toEqual([])
    expect(existsSync(join(skills, 'alpha'))).toBe(false)
  })

  it('反向对照：`.skill-tmp` 是真目录 ⇒ 照常安装（判据不是恒拒绝）', async () => {
    const base = await tempRoot('r19v-staging-ok-')
    const skills = join(base, 'skills')
    await mkdir(join(skills, '.skill-tmp'), { recursive: true })
    const result = await installSkillArchive({
      name: 'beta',
      archive: await skillArchive('beta', 'FROM-HUB'),
      skillsDir: skills,
      version: '1.0.0',
      channel: 'market',
    })
    expect(result.targetDir).toBe(join(skills, 'beta'))
    expect(await readFile(join(skills, 'beta', 'SKILL.md'), 'utf8')).toContain('FROM-HUB')
  })
})

// ---------------------------------------------------------------------------
// R19A-S2-03：目录形态的间接层（bind mount）
// ---------------------------------------------------------------------------

describe('R19A-S2-03：挂载点形态的"库内目录"⇒ 拒收（库外唯一副本不被删）', () => {
  it('G1 换入自愈：`.skill-tmp/install-x` 是库外目录的 bind mount', async () => {
    const base = await tempRoot('r19v-bind-')
    const skills = join(base, 'skills')
    const vault = join(base, 'vault')
    await mkdir(join(skills, '.skill-tmp'), { recursive: true })
    await mkdir(join(skills, 'victim'), { recursive: true })
    await writeFile(join(skills, 'victim', 'SKILL.md'), skillMd('victim', 'CANON'))
    await mkdir(join(vault, 'payload', 'backup'), { recursive: true })
    await writeFile(join(vault, 'payload', 'backup', 'SKILL.md'), skillMd('victim', 'VAULT'))
    await writeFile(join(vault, 'payload', 'backup', 'only-copy.txt'), 'ONLY-COPY\n')
    await mkdir(join(skills, '.skill-tmp', 'install-boom'), { recursive: true })
    const mounted = bind(join(vault, 'payload'), join(skills, '.skill-tmp', 'install-boom'))
    console.log('[S2-03] bind mount 可用 =', mounted)
    if (!mounted) {
      // 本环境没有 CAP_SYS_ADMIN：如实报告"这条判据在本环境咬不到"，不假装通过。
      console.log('[S2-03] 跳过：本环境无法建立 bind mount（需要 CAP_SYS_ADMIN）')
      expect(mounted).toBe(false)
      return
    }
    const { log, lines } = recordingLog()
    const out = await recoverInterruptedSkillSwaps(skills, { log })
    console.log('[S2-03] out =', JSON.stringify(out.map(row => [row.name, row.action])))
    console.log('[S2-03] 日志 =', JSON.stringify(lines))
    expect(out).toEqual([])
    expect(existsSync(join(vault, 'payload', 'backup', 'only-copy.txt')), '库外唯一副本必须还在').toBe(true)
    expect(lines.join('\n')).toMatch(/the path is a mount point/su)
  })

  it('G2 陈旧 staging 清扫：条目本身是挂载点 ⇒ 拒绝清扫且留痕', async () => {
    const base = await tempRoot('r19v-bind2-')
    const skills = join(base, 'skills')
    const vault = join(base, 'vault')
    await mkdir(join(skills, '.skill-tmp', 'install-boom'), { recursive: true })
    await mkdir(join(vault, 'payload'), { recursive: true })
    await writeFile(join(vault, 'payload', 'user-data.txt'), 'USER-DATA\n')
    const mounted = bind(join(vault, 'payload'), join(skills, '.skill-tmp', 'install-boom'))
    console.log('[S2-03/G2] bind mount 可用 =', mounted)
    if (!mounted) {
      expect(mounted).toBe(false)
      return
    }
    const { log, lines } = recordingLog()
    const removed = await sweepStaleSkillTemps(skills, 0, undefined, log)
    const records: SkillCleanupRecord[] = []
    const withRecords = await sweepStaleSkillTemps(skills, 0, record => { records.push(record) }, log)
    console.log('[S2-03/G2] removed =', removed, '| 带记录 =', withRecords, '| 日志 =', JSON.stringify(lines))
    expect(removed).toBe(0)
    expect(records).toEqual([])
    expect(existsSync(join(vault, 'payload', 'user-data.txt')), '库外内容不得被清').toBe(true)
    expect(lines.join('\n')).toMatch(/refused to sweep "install-boom".*mount point/su)
  })

  it('反向对照：同形状的真目录照常被清扫（判据不是恒拒绝）', async () => {
    const base = await tempRoot('r19v-bind-ok-')
    const skills = join(base, 'skills')
    await mkdir(join(skills, '.skill-tmp', 'install-plain'), { recursive: true })
    await writeFile(join(skills, '.skill-tmp', 'install-plain', 'x'), 'x')
    const { log, lines } = recordingLog()
    const removed = await sweepStaleSkillTemps(skills, 0, undefined, log)
    console.log('[S2-03/反向] removed =', removed, '| 日志 =', JSON.stringify(lines))
    expect(removed).toBe(1)
    expect(existsSync(join(skills, '.skill-tmp', 'install-plain'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 判据的"咬得到"自校准：本环境的 realpath 必须能认出链接
// ---------------------------------------------------------------------------

it('自校准：`realpath` 在本环境确实解析符号链接（判据不是空转）', async () => {
  const base = await tempRoot('r19v-calib-')
  const target = join(base, 'target')
  const link = join(base, 'link')
  await mkdir(target, { recursive: true })
  symlinkSync(target, link, 'dir')
  expect(await realpath(link)).toBe(await realpath(target))
  expect(await realpath(link)).not.toBe(link)
})
