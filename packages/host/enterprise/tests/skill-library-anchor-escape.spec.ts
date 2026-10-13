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
 *
 * ## 概率性 → 确定性：S2-03 反向对照的年龄边界（本轮修复）
 *
 * 反向对照（"同形状的真目录照常被清扫"）用 `sweepStaleSkillTemps(skills, 0, …)`，
 * 把年龄判据正压在 0 上。而 `staleAge` 用 `Date.now()`（**整毫秒**、向下取整）减
 * `st.mtimeMs`（**亚毫秒**）：同一个整毫秒内写下的目录会算出**负年龄**，被读成
 * "不陈旧"并**静默**跳过（`removed = 0`、日志为空 `[]`）—— 判据本身没错，结论却被
 * 时钟粒度翻转。同族的 `skill-remove-window.spec.ts` 早就被迫用 `-60_000` 绕开这一档
 * （那里注释写着"用 0 会被年龄闸门静默跳过（判据失去输入）"）。
 *
 * 机制是**确定性**的（不靠负载碰运气）：把采样时钟钉在整毫秒 T、`utimes` 把条目
 * mtime 设为 T + 0.5ms ⇒ 旧实现恒 `age = -0.5ms`、恒静默跳过。
 *
 * 修法在实现侧：年龄不可能为负，截断只可能**低估**年龄 ⇒ 负值按 0ms 龄计
 * （`Math.max(0, now - st.mtimeMs)`）。**没有删除或放宽任何判据**；反向对照一字未动，
 * 另加两条把该边界**两半**分别显式构造出来的判据：
 *   · 阈值 0（"全都陈旧"）下同一毫秒内的亚毫秒 mtime 必须**照常清扫**；
 *   · 缺省 24h 下**未来**时间戳必须**照旧不清扫**（钳位只归一化误差，不反转方向）。
 * 两条都自带"构造真的落地"的见证（前者另有一次 mtime **粒度自校准**）：构造没落地、
 * 判据失去咬合力时当场红，不得静默变成空转。
 *
 * ### 证据边界（2026-10-13 独立审计 P2-4，必读）
 *
 * 上面这段说的是**机制**，不是"那次 CI 红就是它"。**"这次 CI 红 = 负年龄"没有被证实**：
 *   · 前一条提交信息（`c30721c1e3`）写的"满载 600 次里 115 次返回 0（19.2%）/ 另一轮
 *     7.0%（28/400）"**复现不出来** —— 独立复刻取 age 的时序，空载与 8 burners/4 vCPU
 *     满载各 300 次，负年龄 0 次（min gap ≈ 2.9ms、p50 ≈ 4.9ms，够不着"<1ms 且跨整毫秒"
 *     那个窗口）；把钳位还原成旧实现 + 满载跑反向对照 40 次，40/40 全绿；
 *   · 也没有那次红的 CI 日志原件（作者自述 7 份日志里该判据的失败签名 0 命中）。
 * 所以本轮的准确定位是：**修掉一处真实存在、但在两种环境下都未被观测到的潜在不确定性**
 * （上限是"让该判据不再可能被时钟粒度翻转"），**不是**"修复了那次 CI 红"。
 * 那次红的真实成因仍未定，见 `docs/decisions/2026-10-13-env-gated-mount-criteria.md` §4。
 * 判据本身是确定性的、可复现的（去钳位后边界用例确定性红、`removed = 0`、日志 `[]`），
 * 这一点不依赖上面那条归因是否成立。
 *
 * ## 环境受限判据（G1/G2 的 bind mount）与它们的登记
 *
 * G1/G2 需要 `mount --bind`（Linux + `CAP_SYS_ADMIN`）。无特权环境里它们**自跳**，
 * 而自跳与通过同为绿 —— 这正是 2026-10-13 独立审计记下的形态：门禁里这两条一次都
 * 没咬到，"CI 全绿"被读成"挂载点判据通过"。现在自跳是**登记在案**的：
 * `tests/helpers/env-gated-criteria.ts` 写明前置条件 / 为什么不能换成夹具 / 有权限时的
 * 跑法，`tests/env-gated-criteria.spec.ts` **全扫整棵 `tests/`** 逐项对账（用例名还在、
 * 每个 spec 的闸门与消费点调用数、真实原因取自 stderr）；缺能力时本文件经
 * `consumeMountGate` 打印的 `[env-gated:mount/SKIP]` 就是 CI 日志里的**覆盖声明**
 * （含真实原因与"有权限时怎么真跑"）。有权限的环境带上 `PICOAI_MOUNT_TESTS=required`
 * 跑同一套时，缺能力**不再是自跳而是硬红**。
 *
 * **诚实边界（审计 P2-3）**：本仓 CI（GitHub 托管 runner，非 root）上 G1/G2 与
 * `audit-r20-skill-library.spec.ts` 的 K-08 **一次都不执行**，登记表能保证的只是"自跳
 * 不会被误读成通过"。未覆盖是显式认账项，见
 * `docs/decisions/2026-10-13-env-gated-mount-criteria.md`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, symlinkSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
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
} from '../../capability-center/src/host/skill-install.ts'
import { consumeMountGate, judgeMountGate } from './helpers/env-gated-criteria.ts'

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

/** `mount --bind`（需要 CAP_SYS_ADMIN）；失败时把**真实原因**带出来（不是猜的）。 */
function bind(source: string, target: string): { ok: boolean, reason: string } {
  try {
    execFileSync('mount', ['--bind', source, target], { stdio: 'pipe' })
    mounts.push(target)
    return { ok: true, reason: '' }
  } catch (cause) {
    // 环境不具备时**必须**把原因打出来：CI 上 `mount` 以非 root 跑，失败原因
    // 是真实的（"must be superuser…"），而旧实现只印一句猜的"需要 CAP_SYS_ADMIN"，
    // 排查时拿不到任何证据。
    const stderr = (cause as { stderr?: Buffer | string }).stderr
    const text = (stderr === undefined ? '' : stderr.toString()).trim().split('\n')[0]
    return { ok: false, reason: text === undefined || text === '' ? (cause as Error).message : text }
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
      // R19B-09：拒绝文案按调用解析出的宿主语言取（缺省中文）—— 本用例钉的是**判据**
      // 与库外零字节，英文面由显式 `en` 取（中文面见 audit-r20-skill-library.spec.ts）。
      locale: 'en',
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
    const mountAttempt = bind(join(vault, 'payload'), join(skills, '.skill-tmp', 'install-boom'))
    // 判定**必须**经 `consumeMountGate` 消费 —— 登记在案的两条性质就落在它身上：
    // 声明了"必须提供"（`PICOAI_MOUNT_TESTS=required`）⇒ 抛错硬红；缺省 ⇒ 打一行含
    // 真实原因与跑法的 `[env-gated:mount/SKIP]` 覆盖声明。这两条由
    // tests/env-gated-criteria.spec.ts 的行为夹具判决，不再只钉在这两行的**文本**上
    // （审计 P2-2：删掉它们门禁照绿）。
    const gate = consumeMountGate(judgeMountGate(mountAttempt), mountAttempt, 'S2-03/G1 换入自愈')
    if (!gate.mounted) return
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
    const mountAttempt = bind(join(vault, 'payload'), join(skills, '.skill-tmp', 'install-boom'))
    const gate = consumeMountGate(judgeMountGate(mountAttempt), mountAttempt, 'S2-03/G2 陈旧 staging 清扫')
    if (!gate.mounted) return
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

  it('阈值 0 的边界：同一毫秒内的亚毫秒 mtime 不得被静默跳过（把上一条从"概率性"钉成"确定性"）', async () => {
    const base = await tempRoot('r19v-bind-ms-')
    const skills = join(base, 'skills')
    const entry = join(skills, '.skill-tmp', 'install-plain')
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'x'), 'x')
    // 上一条（反向对照）**曾经是概率性的**：`staleAge` 用 `Date.now()`（整毫秒、向下
    // 取整）减 `st.mtimeMs`（亚毫秒），同一毫秒内写下的目录会算出**负年龄**，
    // 被读成"不陈旧"并静默跳过 ⇒ `removed = 0`、日志为空。
    //
    // 这里把那个边界**显式构造**出来（不靠负载碰运气）：采样时钟钉在整毫秒 T，
    // 条目 mtime 设为 T + 0.5ms（亚毫秒、同一整毫秒）⇒ 旧实现年龄恒为 -0.5ms。
    // 阈值 0 的语义是"全都陈旧"，因此这条必须是"照常清扫"，不是"跳过"。
    const pinned = Date.now()
    await utimes(entry, pinned / 1000, (pinned + 0.5) / 1000)
    // **量具自校准**（与文件末尾 realpath 那条同族）：本判据的咬合力全部来自"亚毫秒
    // mtime 真的落了地"。若本文件系统的时间戳粒度 ≥1ms，同一个 `utimes` 会存成**恰好**
    // `pinned` ⇒ 年龄 = 0 ⇒ `0 >= 0` 在旧实现下也通过，这条判据就退化成恒绿而**不报错**。
    // 所以清扫之前先断言构造真的落地（一次 stat），落地不了就当场红并说明原因。
    const observed = (await lstat(entry)).mtimeMs
    console.log('[S2-03/边界] 量具自校准：pinned =', pinned, '| mtimeMs =', observed, '| delta =', observed - pinned)
    expect(
      observed,
      `本文件系统存不下亚毫秒 mtime（mtimeMs = ${observed}，pinned = ${pinned}）：本判据在此环境会空转`,
    ).toBeGreaterThan(pinned)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pinned)
    const { log, lines } = recordingLog()
    let removed = -1
    try {
      removed = await sweepStaleSkillTemps(skills, 0, undefined, log)
    } finally {
      clock.mockRestore()
    }
    console.log('[S2-03/边界] removed =', removed, '| 日志 =', JSON.stringify(lines))
    expect(removed, '阈值 0 = "全都陈旧"：同一毫秒内的条目必须照常清扫，不得静默跳过').toBe(1)
    expect(existsSync(entry), '条目必须真的被删掉').toBe(false)
  })

  it('缺省 24h 的 fail-safe 半边：未来时间戳不得被清扫（钳位只归一化误差，不反转方向）', async () => {
    const base = await tempRoot('r19v-future-')
    const skills = join(base, 'skills')
    const entry = join(skills, '.skill-tmp', 'install-future')
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'x'), 'x')
    // 上一条钉的是钳位的**一半**：阈值 0（"全都陈旧"）下负年龄必须照常清扫。
    // 这一条钉另一半 —— 钳位不得把方向反过来：缺省 24h 时**未来**时间戳（时钟偏斜、
    // 从别处拷来的 mtime、网络盘的客户端时钟差）必须照旧**不清扫**（fail-safe）。
    // 变异体把这一半反转的形态都是一行"看着等价"的改动：
    //   · `Math.max(0, now - st.mtimeMs)` → `Math.abs(now - st.mtimeMs)`（+1 年 ⇒ 年龄 1 年）
    //   · 或把减法反写成 `st.mtimeMs - now`（未来 ⇒ 正年龄）
    // 被删的是用户可见路径（`.skill-tmp/install-*` 与技能库根的 `.install-*`），所以
    // 这一半必须自己有一条判据，而不是靠"缺省阈值很大"这句话。
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000
    await utimes(entry, future / 1000, future / 1000)
    const observed = (await lstat(entry)).mtimeMs
    console.log('[S2-03/未来] 构造见证：mtimeMs =', observed, '| 距现在 =', (observed - Date.now()) / 86_400_000, '天')
    expect(
      observed - Date.now(),
      '构造必须真的落地：条目 mtime 必须在未来，否则本判据空转',
    ).toBeGreaterThan(364 * 24 * 60 * 60 * 1000)
    // 第二个参数传 `undefined` ⇒ 吃**生产缺省** 24h（本判据必须走缺省档，不能自己塞阈值）。
    const { log, lines } = recordingLog()
    const removed = await sweepStaleSkillTemps(skills, undefined, undefined, log)
    console.log('[S2-03/未来] removed =', removed, '| 日志 =', JSON.stringify(lines))
    expect(removed, '缺省 24h：未来时间戳不是"陈旧"，一条都不许清').toBe(0)
    expect(lines, '既没清也没拒 ⇒ 日志必须为空（本判据要的是"照旧不清扫"，不是"拒绝清扫"）').toEqual([])
    expect(existsSync(entry), '条目必须还在').toBe(true)
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
