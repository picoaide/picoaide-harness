/**
 * R18B-04（2026-09-25 第十八轮审计 · 泳道 B）：**安装器的清理 / 自愈记录必须经
 * 可注入的日志出口**（生产 = `ctx.logger` → `<userData>/logs`），而不是 `console.warn`。
 *
 * 缺陷形态（修前）：`src/skill-install.ts` 有 8 处 `console.warn`、0 处 `ctx.logger`。
 * 而桌面**唯一**会写 `<userData>/logs` 的通道是 `hostCtx.logger.exporter(fileExporter)`
 * （`packages/host/desktop/src/main.ts`），诊断包只收 `<userData>/logs`；本仓自己的注释
 * 就是判据：「我方 19 个行失败只 warn（**Windows GUI 无 stderr ⇒ 彻底静默**）」。
 * 于是 R17B-02 承诺的"删除必须留痕"（`SkillCleanupRecord` + `[skill-install] removed …`）
 * 在生产**无处可去** —— "这个技能/这个目录为什么不见了"不可追溯，而本地 `yarn test`
 * 的 stderr 看得见（典型"本地绿、生产盲"）。
 *
 * 修法：`SkillInstallLog` 出口（缺省 `console`）由 `installSkillArchive` / `uninstallSkill`
 * 透传到 `sweepStaleSkillTemps` / `recoverInterruptedSkillSwaps` /
 * `sweepInstallerOwnedShadowSkills`；`auth-gate` 的 6 个本机写面调用点注入
 * `message => ctx.logger?.warn?.(message)`。
 *
 * 判据分两层，都要求**记录真的走到了注入的出口**：
 *   ① 函数面：陈旧 staging 清扫 / 换入中断自愈的记录进注入出口，且 `console.warn` **没有**被调用；
 *   ② 路由面：POST 安装（真 auth-gate handler）触发同一批清理 ⇒ `ctx.logger.warn` 收到
 *      那条记录、`console.warn` 仍然一次都没有 —— 这一条同时钉住"接线存在"（去掉
 *      route 里的 `log:` 参数即红）。
 *
 * 变异（逐条实跑见 temp/r18/P/REPORT.md）：把任一处的 `log.warn` 改回 `console.warn` ⇒
 * 对应用例的"注入出口收到记录"断言变红；把 auth-gate 的 `log: skillInstallLogForHost(ctx)`
 * 删掉 ⇒ ② 变红。
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverInterruptedSkillSwaps, sweepStaleSkillTemps, type SkillInstallLog } from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'
import { fakeReq, fakeRes, harness, stubGateway } from './helpers/auth-gate-harness.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

beforeEach(isolateRuntimeSkillRoots)

const DAY_MS = 24 * 60 * 60 * 1000

/** 记录所有日志行的假出口（判据面：**注入**的出口收到了什么）。 */
function recordingLog(): { log: SkillInstallLog, lines: string[] } {
  const lines: string[] = []
  return { log: { warn: (message: string) => { lines.push(message) } }, lines }
}

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'r18b4-log-'))
}

/** 造一个"陈旧 staging"目录（`<skills>/.skill-tmp/install-*`，mtime 拨回两天前）。 */
async function seedStaleStaging(skillsDir: string, entry = 'install-stale-r18b4'): Promise<string> {
  const path = join(skillsDir, '.skill-tmp', entry)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), '---\nname: stale\ndescription: stale\n---\n\nbody\n')
  const old = new Date(Date.now() - 2 * DAY_MS)
  await utimes(path, old, old)
  return path
}

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function skillArchive(name: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'r18b4-archive-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), skillMd(name, 'FROM-HUB'), 'utf8')
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

describe('R18B-04 ①：清理 / 自愈记录进**注入的**日志出口，console 不再被写', () => {
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(() => { consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { consoleWarn.mockRestore() })

  it('sweepStaleSkillTemps：陈旧 staging 被删时，记录进注入出口且 console.warn 零调用', async () => {
    const root = await tempRoot()
    try {
      const skillsDir = join(root, 'skills')
      await mkdir(skillsDir, { recursive: true })
      await seedStaleStaging(skillsDir)
      const { log, lines } = recordingLog()

      const removed = await sweepStaleSkillTemps(skillsDir, DAY_MS, undefined, log)
      console.log('[①/sweep] 注入出口收到 =', JSON.stringify(lines))
      expect(removed).toBe(1)
      expect(lines).toHaveLength(1)
      // 记录必须点名条目 + 为什么（R17B-02 的 SkillCleanupRecord 同一份数据）。
      expect(lines[0]).toContain('[skill-install] removed "install-stale-r18b4"')
      expect(lines[0]).toContain('.skill-tmp')
      expect(consoleWarn, '注入出口之后 console.warn 不得再被写（生产那是彻底静默的一条路）').not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recoverInterruptedSkillSwaps：换入中断的旧内容放回落点时，记录进注入出口', async () => {
    const root = await tempRoot()
    try {
      const skillsDir = join(root, 'skills')
      const backup = join(skillsDir, '.skill-tmp', `backup-notes-${Date.now()}`)
      await mkdir(backup, { recursive: true })
      await writeFile(join(backup, 'SKILL.md'), skillMd('notes', 'OLD-CONTENT'))
      const { log, lines } = recordingLog()

      const recovered = await recoverInterruptedSkillSwaps(skillsDir, { onlyName: 'notes', log })
      console.log('[①/recover] 注入出口收到 =', JSON.stringify(lines))
      expect(recovered.map(row => row.action)).toEqual(['restored'])
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('[skill-install] restored "notes"')
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('R18B-04 ②：路由面（真 auth-gate）——清理记录走 ctx.logger，不走 console', () => {
  const SESSION: Session = {
    serverURL: 'https://harness.example',
    username: 'alice',
    token: 'USER-TOKEN-abc',
    role: 'employee',
  }
  let home: string
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r18b4-route-'))
    await mkdir(join(home, 'skills'), { recursive: true })
    vi.stubEnv('DSH_HOME', home)
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    consoleWarn.mockRestore()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('POST /api/pico/skills/:name/install 触发陈旧 staging 清扫 ⇒ ctx.logger.warn 收到那条记录', async () => {
    await seedStaleStaging(join(home, 'skills'))
    const h = harness(SESSION)
    stubGateway(h, await skillArchive('alpha'))

    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/install'), res)
    console.log('[②] HTTP =', read().code, '｜ logger.warn =', JSON.stringify(h.loggerWarn.mock.calls.map(c => c[0])))

    expect(read().code, '清扫是 best-effort，不影响安装本身').toBe(200)
    const lines = h.loggerWarn.mock.calls.map(call => String(call[0]))
    expect(
      lines.some(line => line.includes('[skill-install] removed "install-stale-r18b4"')),
      '安装器的清理记录必须经 ctx.logger 出口（生产唯一写 <userData>/logs 的通道）',
    ).toBe(true)
    expect(consoleWarn, 'console.warn 在生产是彻底静默的一条路，不得再作为记录出口').not.toHaveBeenCalled()
    // 陈旧 staging 真的被清掉了（记录与实际动作同源）。
    expect(await readdir(join(home, 'skills', '.skill-tmp')).catch(() => [])).not.toContain('install-stale-r18b4')
  })
})
