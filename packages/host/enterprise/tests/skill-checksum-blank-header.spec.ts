/**
 * R18B-05（2026-09-25 第十八轮审计 · 泳道 B）：**"头缺失" 与 "头为空" 必须分开记账**。
 *
 * 缺陷形态（修前）：`installSkillArchive` 只判 `checksum !== undefined`。于是
 * `X-Skill-Checksum: ""`（组织面 `routes.go` 直发存量行的 `s.Checksum`，而市场面
 * `skill_api.go` 有 `sum == ""` 现算 fallback ⇒ 两个兄弟端点口径不对称）会走
 * "现算 sha256 与空串比对"这条路 ⇒ 恒 `CHECKSUM_MISMATCH`
 * （"archive checksum mismatch; refused"）：**技能永远装不上，而文案把"服务端数据缺列"
 * 说成了"归档内容对不上"**，用户与排障都被指向错误的原因。
 *
 * 本文件钉住**客户端这一半**（可诊断性）：
 *   - 头**存在但为空** ⇒ `CHECKSUM_UNAVAILABLE`，文案点名真实原因（服务端那条行没有
 *     完整性凭据），既不静默跳过校验、也不误报 mismatch；
 *   - 头**缺失**（`undefined`）⇒ 维持既有"有就校验"的宽松口径（老服务端兼容，不改）；
 *   - 头**存在且不符** ⇒ 仍然是 `CHECKSUM_MISMATCH`（完整性判据本身不变）。
 *
 * **服务端那一半不在本泳道**：组织面 `server/internal/sharedskills/routes.go` 的
 * `c.Header("X-Skill-Checksum", s.Checksum)` 应照市场面补 `if sum == "" { sum = sha256Hex(payload) }`
 * —— 已作为交接项写进 `temp/r18/P/REPORT.md`（`server/**` 属泳道 S18）。
 *
 * 变异（逐条实跑见 temp/r18/P/REPORT.md）：把空串分支删回 `if (checksum !== undefined)`
 * 的旧写法 ⇒ ①/② 的 `CHECKSUM_UNAVAILABLE` 断言变红（实得 `CHECKSUM_MISMATCH`）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveInstallRefusal,
  describeArchiveFailure,
  installSkillArchive,
} from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'
import { fakeReq, fakeRes, harness, stubGateway } from './helpers/auth-gate-harness.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'

beforeEach(isolateRuntimeSkillRoots)

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\nbody ${marker}\n`
}

async function skillArchive(name: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'r18b5-archive-'))
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

async function captureRefusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the call to be refused, but it resolved')
}

describe('R18B-05 ①：空 checksum 与缺失 checksum 的记账口径', () => {
  let home: string
  let skillsDir: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r18b5-'))
    skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
  })

  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('头存在但为空 ⇒ CHECKSUM_UNAVAILABLE（点名服务端那条行没有凭据），不是 MISMATCH', async () => {
    const archive = await skillArchive('alpha')
    const failure = await captureRefusal(() => installSkillArchive({
      name: 'alpha', archive, checksum: '', skillsDir, version: '1.0.0', channel: 'org',
    }))
    console.log('[①/空头] 拒绝 =', (failure as ArchiveInstallRefusal).code, '｜', failure.message)
    expect((failure as ArchiveInstallRefusal).code).toBe('CHECKSUM_UNAVAILABLE')
    expect(failure.message).toContain('empty integrity checksum')
    expect(failure.message).not.toContain('mismatch')
    // HTTP 信封：仍然是"请求/内容被拒"这一类（422），并且带稳定 code。
    expect(describeArchiveFailure(failure)).toMatchObject({ status: 422, code: 'CHECKSUM_UNAVAILABLE', refusal: true })
  })

  it('反向对照：头缺失仍是既有宽松口径（老服务端兼容），头不符仍是 MISMATCH', async () => {
    const archive = await skillArchive('beta')
    // 缺失（undefined）= "有就校验"：装得上。
    const ok = await installSkillArchive({
      name: 'beta', archive, checksum: undefined, skillsDir, version: '1.0.0', channel: 'market',
    })
    expect(ok.targetDir).toBe(join(skillsDir, 'beta'))

    await rm(join(skillsDir, 'beta'), { recursive: true, force: true })
    const wrong = 'f'.repeat(64)
    const failure = await captureRefusal(() => installSkillArchive({
      name: 'beta', archive, checksum: wrong, skillsDir, version: '1.0.0', channel: 'market',
    }))
    expect((failure as ArchiveInstallRefusal).code).toBe('CHECKSUM_MISMATCH')
    expect((failure as ArchiveInstallRefusal).code).not.toBe('CHECKSUM_UNAVAILABLE')
  })
})

describe('R18B-05 ②：路由面 —— 市场通路拿到空头时同样报"没有凭据"', () => {
  const SESSION: Session = {
    serverURL: 'https://harness.example',
    username: 'alice',
    token: 'USER-TOKEN-abc',
    role: 'employee',
  }
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r18b5-route-'))
    await mkdir(join(home, 'skills'), { recursive: true })
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('X-Skill-Checksum: "" ⇒ 422 CHECKSUM_UNAVAILABLE（文案不再指向"内容对不上"）', async () => {
    const archive = await skillArchive('alpha')
    // 前置断言：这个替身真的发出了一条**空值**头（不是被 Headers 丢掉 ⇒ 假绿）。
    const probe = new Response(null, { headers: { 'x-skill-checksum': '' } })
    expect(probe.headers.get('x-skill-checksum'), 'HTTP 空值头必须能表达"头存在但为空"').toBe('')

    const h = harness(SESSION)
    stubGateway(h, archive, { 'x-skill-checksum': '' })
    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/install'), res)
    console.log('[②] HTTP =', read().code, JSON.stringify(read().body))
    expect(read().code).toBe(422)
    expect(read().body.code).toBe('CHECKSUM_UNAVAILABLE')
    expect(read().body.error).toContain('empty integrity checksum')
    expect(read().body.error).not.toContain('mismatch')
  })

  it('反向对照：正确的头照常装得上（口径收紧只针对空值）', async () => {
    const archive = await skillArchive('alpha')
    const h = harness(SESSION)
    stubGateway(h, archive, { 'x-skill-checksum': createHash('sha256').update(archive).digest('hex') })
    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(fakeReq('POST', '/api/pico/skills/alpha/install'), res)
    console.log('[②/反向] HTTP =', read().code, JSON.stringify(read().body))
    expect(read().code).toBe(200)
  })
})
