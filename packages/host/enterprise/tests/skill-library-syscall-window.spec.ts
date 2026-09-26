/**
 * tests/skill-library-syscall-window.spec.ts — R22-V1-N2 / R22-V1-N4 的仓内回归判据。
 *
 * ## 缺口原形态（第二十二轮独立复审 V1-N2 / V1-N4）
 *
 * 库内三个私有目录（`.skill-tmp` / `.skill-removed` / `.skill-locks`）在 R21-A1-03
 * 之后都过了逐段锚定，但只有 `.skill-tmp` 那几条路径在**紧邻破坏性 syscall 之前**
 * 复检了一次逐段身份。缺口有三处（同一模式只收口了一条）：
 *
 *  1. `<库>/.skill-removed/<name>.json` 的**写**（`writeSkillTombstone` → `writeFile`）：
 *     锚定成功之后被换成库外链接 ⇒ 墓碑**持久地**落在库外（覆盖库外同名文件），
 *     而库内看不到这次卸载记录；
 *  2. `<库>/.skill-locks/<name>.lock` 的**取锁**（`ensureLibraryLockRoot` →
 *     `open(lockPath, 'wx')`）：窗口在**每一次**安装/卸载上都会出现 ⇒ 锁文件建在
 *     库外，"持锁期间库内看不到锁" ⇒ **互斥对另一个写者不成立**（在库外假装锁住）；
 *  3. `<库>/.skill-removed/<name>.json` 的**清**（`clearSkillTombstone` → `rm`）：
 *     紧邻复检**代码在**（R21-A1-03 加的），但当时**没有任何判据能杀**它 —— 现有
 *     `skill-tombstone-anchor.spec.ts` 的四条墓碑用例全部让**锚定本身**失败
 *     （预置链接 ⇒ `anchorLibraryPath` 返回 undefined），复检那一段根本走不到。
 *
 * ## 这份用例怎么做到确定性（不抢时序）
 *
 * 三处都用**同一个**注入口：`anchorLibraryPath` 内部对本段路径的那次 `realpath`。
 * 第 1 次出现是**锚定**（固定版与掏空版都有），第 2 次出现是**紧邻复检**内部的重锚
 * （只有固定版有）。注入动作 = 把私有目录旁置、原位换成指向库外 vault 的符号链接。
 *
 *   - 固定版：复检当场看见间接层 ⇒ 拒收，**一个字都不写/不删**；
 *   - 掏空版（变异）：写/删直接顺着链接落到 vault。
 *
 * 掏空版不会出现"第 2 次 realpath"，所以每个用例还挂了一个**兜底注入点**：真正的
 * syscall（`writeFile` / `rm` / `open`）在被调用时若注入尚未发生，就先换再放行 ——
 * 于是变异体**必然**被注入、判据**必然**咬到行为（而不是只红在"注入没命中"上）。
 *
 * 每个用例都先断言注入确实命中（`swaps === 1` / `realpathMatches >= 2`），再断言
 * 两件事：**库外零写入/零创建/零删除** + **拒绝可见**（fail-loud 的错误码或日志）。
 *
 * ## 变异验证（把复检掏空 ⇒ 本文件红）
 *
 *  - `writeSkillTombstone` 去掉复检 ⇒ 第 1 组红（vault 里出现 `plug.json`）；
 *  - `acquireSkillDirLock` 去掉循环里的复检 ⇒ 第 2 组红（取锁瞬间 vault 里出现
 *    `plug.lock`；且安装**成功**而不是 `LIBRARY_TEMP_UNSAFE`）；
 *  - `clearSkillTombstone` 的 `if (!verdict.holds)` 改成 `if (false)` ⇒ 第 3 组红
 *    （vault 里的诱饵 `plug.json` 被删掉）。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  clearSkillTombstone,
  installSkillArchive,
  SKILL_LOCK_DIR,
  SKILL_REMOVED_DIR,
  writeSkillTombstone,
  type SkillInstallLog,
} from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

/** 注入控制器（`vi.hoisted`：mock 工厂不能引用普通顶层变量）。 */
const hooks = vi.hoisted(() => ({
  armed: false,
  /** 已经换过几次（每个用例必须恰好 1 次）。 */
  swaps: 0,
  /** `realpath(<库>/<私有目录>)` 被调用的次数（固定版应 ≥2：锚定 + 紧邻复检的重锚）。 */
  realpathMatches: 0,
  /** 兜底注入点：固定版用不到，掏空版靠它必然命中。 */
  fallback: 'none' as 'none' | 'writeFile' | 'rm' | 'open',
  /** 掏空版下"锁文件真的建到了库外"的瞬时证据（release 会按 dev/ino 收掉它）。 */
  outsideLockCreated: false,
  plan: { privateDir: '', parked: '', vault: '', decoyName: '', decoyBody: '', vaultFile: '' },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const pathOf = (value: unknown): string =>
    typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  /** 私有目录旁置 + 原位放一个指向库外 vault 的符号链接（vault 里可选放一份同名诱饵）。 */
  const swapNow = async (): Promise<void> => {
    hooks.swaps++
    const fs = await import('node:fs')
    const nodePath = await import('node:path')
    fs.renameSync(hooks.plan.privateDir, hooks.plan.parked)
    fs.mkdirSync(hooks.plan.vault, { recursive: true })
    if (hooks.plan.decoyName !== '') {
      fs.writeFileSync(nodePath.join(hooks.plan.vault, hooks.plan.decoyName), hooks.plan.decoyBody)
    }
    fs.symlinkSync(hooks.plan.vault, hooks.plan.privateDir, 'dir')
  }
  /** 兜底：syscall 已经进来了 ⇒ 先把目录换掉，再放行（掏空版必须被咬到）。 */
  const swapIfMissed = async (mode: string, target: string): Promise<void> => {
    if (!hooks.armed || hooks.swaps !== 0 || hooks.fallback !== mode) return
    if (hooks.plan.privateDir === '' || !target.startsWith(`${hooks.plan.privateDir}/`)) return
    await swapNow()
  }
  return {
    ...actual,
    default: actual,
    realpath: async (target: never, ...rest: never[]) => {
      const value = pathOf(target)
      if (hooks.armed && hooks.plan.privateDir !== '' && value.endsWith(`/${hooks.plan.privateDir.split('/').pop() ?? ''}`)) {
        hooks.realpathMatches++
        // 第 2 次出现 = 紧邻复检内部的重锚：**在**解析之前换掉（固定版据此看见间接层）。
        if (hooks.realpathMatches === 2 && hooks.swaps === 0) await swapNow()
      }
      return await (actual.realpath as never as (p: never, ...r: never[]) => Promise<unknown>)(target, ...rest)
    },
    writeFile: async (target: never, data: never, ...rest: never[]) => {
      await swapIfMissed('writeFile', pathOf(target))
      return await (actual.writeFile as never as (p: never, d: never, ...r: never[]) => Promise<unknown>)(target, data, ...rest)
    },
    rm: async (target: never, ...rest: never[]) => {
      await swapIfMissed('rm', pathOf(target))
      return await (actual.rm as never as (p: never, ...r: never[]) => Promise<unknown>)(target, ...rest)
    },
    open: async (target: never, ...rest: never[]) => {
      await swapIfMissed('open', pathOf(target))
      const handle = await (actual.open as never as (p: never, ...r: never[]) => Promise<unknown>)(target, ...rest)
      // 取锁瞬间的库外证据（release 之后文件可能已被按 dev/ino 收掉）。
      if (hooks.armed && hooks.plan.vaultFile !== '' && existsSync(hooks.plan.vaultFile)) hooks.outsideLockCreated = true
      return handle
    },
    mkdir: async (target: never, ...rest: never[]) => {
      // `.skill-locks` 的 mkdir 发生在**锚定之前**，不参与注入（避免把初始锚定也打掉）。
      return await (actual.mkdir as never as (p: never, ...r: never[]) => Promise<unknown>)(target, ...rest)
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
  hooks.swaps = 0
  hooks.realpathMatches = 0
  hooks.fallback = 'none'
  hooks.outsideLockCreated = false
  hooks.plan = { privateDir: '', parked: '', vault: '', decoyName: '', decoyBody: '', vaultFile: '' }
})

afterEach(async () => {
  hooks.armed = false
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function home(prefix: string): Promise<{ home: string, skillsDir: string, vault: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(root)
  const skillsDir = join(root, 'skills')
  const vault = join(root, 'vault')
  await mkdir(skillsDir, { recursive: true })
  return { home: root, skillsDir, vault }
}

/** 一份最小的、可加载的 SKILL.md。 */
function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: window probe ${name}\nversion: 1.0.0\n---\n\nbody of ${name}\n`
}

function archiveOf(name: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(skillMd(name), 'utf8'), '', 0o644)
  return zip.toBuffer()
}

/** 造一份"安装好的技能"（不做注入）。 */
async function install(f: { skillsDir: string, log: SkillInstallLog }, name: string, channel = 'plugin'): Promise<void> {
  await installSkillArchive({ name, archive: archiveOf(name), skillsDir: f.skillsDir, channel, log: f.log })
}

describe('R22-V1-N2 墓碑**写**窗口：锚定之后、writeFile 之前被换掉 ⇒ 拒收且库外零写入', () => {
  it('`.skill-removed` 在紧邻复检的重锚处被换成库外链接 ⇒ 墓碑不得出现在库外', async () => {
    const { skillsDir, vault } = await home('r22v1-tomb-write-')
    const { log, lines } = recordingLog()
    const privateDir = join(skillsDir, SKILL_REMOVED_DIR)
    hooks.plan = {
      privateDir, parked: join(skillsDir, '.parked-removed'), vault,
      decoyName: '', decoyBody: '', vaultFile: '',
    }
    hooks.fallback = 'writeFile'
    hooks.armed = true

    const written = await writeSkillTombstone(skillsDir, 'plug', { version: '1.0.0' }, log)

    expect(hooks.swaps, '注入必须命中写窗口（没命中 ⇒ 判据无效）').toBe(1)
    expect(hooks.realpathMatches, '紧邻复检必须真的重锚过一次').toBeGreaterThanOrEqual(2)
    expect(existsSync(join(vault, 'plug.json')), '库外不得出现我们写的墓碑').toBe(false)
    expect(await readdir(vault), '库外目录必须一字不动（连目录都不该被我们建出来）').toEqual([])
    // 拒绝必须可见：返回的仍是规范落点，日志点名"复检不过 + 一个字都没写"。
    expect(written).toBe(join(skillsDir, SKILL_REMOVED_DIR, 'plug.json'))
    expect(lines.join('\n')).toContain('refused to write a tombstone')
    expect(lines.join('\n')).toContain('could not be re-verified right before the write')
  })

  it('正向对照：没有注入时同一棵树上墓碑照常写进库内（修复不得把功能弄坏）', async () => {
    const { skillsDir } = await home('r22v1-tomb-write-ok-')
    const { log, lines } = recordingLog()
    hooks.armed = false
    await writeSkillTombstone(skillsDir, 'plug', undefined, log)
    const tombstone = join(skillsDir, SKILL_REMOVED_DIR, 'plug.json')
    expect(existsSync(tombstone), '正常路径上墓碑必须落在技能库内').toBe(true)
    expect(JSON.parse(await readFile(tombstone, 'utf8'))).toMatchObject({ appId: 'plug', channel: 'plugin' })
    expect(lines.join('\n'), '正常路径不该有拒绝日志').not.toContain('refused')
  })
})

describe('R22-V1-N2 取锁窗口：锚定之后、open 之前被换掉 ⇒ fail-loud 且库外零创建', () => {
  it('`.skill-locks` 在紧邻复检的重锚处被换成库外链接 ⇒ 安装被拒，库外不得出现锁文件', async () => {
    const { skillsDir, vault } = await home('r22v1-lock-window-')
    const { log } = recordingLog()
    hooks.plan = {
      privateDir: join(skillsDir, SKILL_LOCK_DIR), parked: join(skillsDir, '.parked-locks'), vault,
      decoyName: '', decoyBody: '', vaultFile: join(vault, 'plug.lock'),
    }
    hooks.fallback = 'open'
    hooks.armed = true

    const cause = await installSkillArchive({ name: 'plug', archive: archiveOf('plug'), skillsDir, channel: 'market', log })
      .then(() => undefined, (error: unknown) => error)

    expect(hooks.swaps, '注入必须命中取锁窗口').toBe(1)
    expect(hooks.realpathMatches, '紧邻复检必须真的重锚过一次').toBeGreaterThanOrEqual(2)
    expect(hooks.outsideLockCreated, '取锁瞬间库外不得出现锁文件（"在库外假装锁住"= 互斥不成立）').toBe(false)
    expect(existsSync(join(vault, 'plug.lock'))).toBe(false)
    expect(await readdir(vault)).toEqual([])
    expect(cause, '库内私有目录不可信时必须 fail-loud').toBeInstanceOf(ArchiveInstallRefusal)
    expect((cause as ArchiveInstallRefusal).code).toBe('LIBRARY_TEMP_UNSAFE')
    expect((cause as Error).message).toContain('could not be re-verified right before the lock file was created')
    expect(existsSync(join(skillsDir, 'plug')), '一个字都不该动').toBe(false)
  })

  it('正向对照：普通库内 `.skill-locks` 目录下锁照常取、照常释放（锁语义不退化）', async () => {
    const { skillsDir } = await home('r22v1-lock-ok-')
    const { log } = recordingLog()
    hooks.armed = false
    await install({ skillsDir, log }, 'plug', 'market')
    const lockDir = join(skillsDir, SKILL_LOCK_DIR)
    expect(existsSync(lockDir), '锁目录应当被建在库内').toBe(true)
    expect(await readdir(lockDir), '安装完成后不得留下锁').toEqual([])
    expect(existsSync(join(skillsDir, 'plug', 'SKILL.md'))).toBe(true)
  })
})

describe('R22-V1-N4 墓碑**清**窗口：紧邻复检被掏空后必须有判据变红', () => {
  it('`.skill-removed` 在紧邻复检的重锚处被换成库外链接 ⇒ 库外诱饵必须原样存在', async () => {
    const { skillsDir, vault } = await home('r22v1-tomb-clear-')
    const { log, lines } = recordingLog()
    await install({ skillsDir, log }, 'plug')
    await writeSkillTombstone(skillsDir, 'plug', undefined, log)
    const inLibrary = join(skillsDir, SKILL_REMOVED_DIR, 'plug.json')
    expect(existsSync(inLibrary), '前置：库内墓碑已经写好').toBe(true)

    hooks.plan = {
      privateDir: join(skillsDir, SKILL_REMOVED_DIR), parked: join(skillsDir, '.parked-removed'), vault,
      decoyName: 'plug.json', decoyBody: 'OUTSIDE-DECOY\n', vaultFile: '',
    }
    hooks.fallback = 'rm'
    hooks.armed = true

    const cleared = await clearSkillTombstone(skillsDir, 'plug', log)

    expect(hooks.swaps, '注入必须命中清墓碑窗口').toBe(1)
    expect(hooks.realpathMatches, '紧邻复检必须真的重锚过一次').toBeGreaterThanOrEqual(2)
    expect(existsSync(join(vault, 'plug.json')), '库外同名诱饵不得被删（掏空紧邻复检 ⇒ 这里消失）').toBe(true)
    expect(await readFile(join(vault, 'plug.json'), 'utf8')).toBe('OUTSIDE-DECOY\n')
    expect(cleared, '被拒时不得声称"墓碑已不在盘上"').toBeUndefined()
    expect(lines.join('\n')).toContain('refused to clear the tombstone')
    expect(lines.join('\n')).toContain('could not be re-verified before the removal')
  })

  it('正向对照：没有注入时墓碑照常清掉（幂等路径不退化）', async () => {
    const { skillsDir } = await home('r22v1-tomb-clear-ok-')
    const { log, lines } = recordingLog()
    await install({ skillsDir, log }, 'plug')
    await writeSkillTombstone(skillsDir, 'plug', undefined, log)
    hooks.armed = false
    const cleared = await clearSkillTombstone(skillsDir, 'plug', log)
    expect(cleared).toBe(join(skillsDir, SKILL_REMOVED_DIR, 'plug.json'))
    expect(existsSync(cleared as string), '正常路径上墓碑必须被清掉').toBe(false)
    expect(lines.join('\n')).not.toContain('refused')
  })
})
