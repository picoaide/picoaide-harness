/**
 * C2-3（2026-10 审计）：`describeArchiveFailure` 的**分类顺序**与**文本出口**。
 *
 * 缺陷形态（审计探针 `probe/failure-classification.probe.spec.ts`，跑 HEAD 真实模块）：
 *   ```
 *   {"status":502,"refusal":false,"message":"EACCES: permission denied"}                ← 无 hint 词（既有回归）
 *   {"status":422,"refusal":true,"message":"EROFS: … open '/home/u/.picoaide-harness/skills/.skill-tmp/install-AbC123/archive.tar.gz'"}
 *   {"status":422,"refusal":true,"message":"EACCES: … same staging path …"}
 *   {"status":422,"refusal":true,"message":"ENOTEMPTY: … rename '/home/u/.picoaide-harness/skills/archive'"}
 *   ```
 * 判据当时是"**原文里有没有 hint 词**"，而安装器自己的 tar 通道就把归档写在
 * `<staging>/archive.tar.gz`（技能名本身也可以是 `archive`）⇒ 任何系统级失败只要提到
 * 那个路径就命中 `archive`，被判成"你的归档有问题"（422，且**该分支不脱敏**）：
 * ①状态码把"这台机器写不进去"说成"请求有问题"（用户会去改一个改不动的东西）；
 * ②本机家目录/用户名/staging 结构原样回给 UI（A12 建立的脱敏只在 502 支上跑过）。
 *
 * 判据（都是行为，输入是**真实的临时目录路径**，不是写死的假串）：
 *  ① 系统级错误（errno **两种形态**：文案前缀 / 错误对象上的 `code`）⇒ 状态码不是 422，
 *     且回给 UI 的文本里**不含**任何本机路径片段；
 *  ② 非系统级、但命中关键词兜底的原文（`archive-util` 的拒绝）⇒ 仍是 422，但同样过了
 *     脱敏（"所有回给 UI 的文本只有一条出口"）；
 *  ③ 反向对照：**我们自己写的**拒绝文案（`ArchiveInstallRefusal`，含 RESIDUE 那几条
 *     **有意点名用户自己的文件**的）逐字透出、状态码与 code 不变 —— 防止"一刀切脱敏"
 *     把可操作信息抹掉（那会把 `skill-project-root-shadow.spec.ts` 钉住的产品行为改坏）。
 *
 * 变异（逐条实跑见 `temp/audit-v282/fixes/C2-P2-batch.md`）：
 *  - 去掉 `systemErrorCode` 那一支（回到"只判关键词"）⇒ ① 全线红；
 *  - 把 `message` 改回 `raw`（不脱敏）⇒ ①② 红；
 *  - 把 `authored` 去掉（连我们自己的文案也脱敏）⇒ ③ 红。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArchiveInstallRefusal, SkillLockedError, describeArchiveFailure } from '../src/skill-install.ts'

/** 真的本机绝对路径（不是写死的假串）——"不含本机路径"必须用真实片段断言。 */
let root = ''
let stagingArchive = ''
/** 路径里那些**一旦回给 UI 就是泄漏**的片段（basename 允许留下：`…/archive.tar.gz`）。 */
let leakFragments: string[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pico-c23-'))
  // 与安装器 staging 落点同形：<root>/skills/.skill-tmp/install-XXXX/archive.tar.gz
  stagingArchive = join(root, 'skills', '.skill-tmp', 'install-AbC123', 'archive.tar.gz')
  leakFragments = [root, join(root, 'skills'), '.skill-tmp', 'install-AbC123']
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function expectNoLocalPath(message: string): void {
  for (const fragment of leakFragments) {
    expect(message, `本机路径片段泄漏到 UI 文案里：${fragment}`).not.toContain(fragment)
  }
  // 家目录本身也是"本机身份"，逐字断言一次（路径构造里没有它，但泄漏形态常来自 $HOME）。
  if (process.env.HOME !== undefined && process.env.HOME !== '') {
    expect(message, '家目录不得出现在 UI 文案里').not.toContain(process.env.HOME)
  }
}

describe('C2-3 ①：系统级 errno 不得被判成 422，且文案必须脱敏', () => {
  it('文案前缀形态（探针的四例，路径含安装器自己的 archive.tar.gz）', () => {
    const cases = [
      `EROFS: read-only file system, open '${stagingArchive}'`,
      `EACCES: permission denied, open '${stagingArchive}'`,
      `ENOSPC: no space left on device, write '${stagingArchive}'`,
      `ENOTEMPTY: directory not empty, rename '${join(root, 'skills', 'archive')}'`,
      // 不在 ERRNO_HINT 表里的 errno：走通用路径掩码，同样不许留本机路径。
      `EIO: i/o error, open '${stagingArchive}'`,
    ]
    for (const raw of cases) {
      const described = describeArchiveFailure(new Error(raw))
      expect(described.status, `${raw} 被当成了客户端拒绝`).not.toBe(422)
      expect(described.status).toBe(502)
      expect(described.refusal).toBe(false)
      // 成因必须还看得见（不是被抹成一句空话）——保留 errno 前缀。
      expect(described.message).toMatch(/^E[A-Z]+:/u)
      expectNoLocalPath(described.message)
    }
  })

  it('错误对象上的 `code` 形态（文案里**没有** errno 前缀，但带着真实 fs 错误的 code）', () => {
    // 同族补集：真实 fs 错误的两种形状（`code` + 以 code 开头的 message）。这一例
    // 刻意让文案不带 `EROFS:` 前缀 —— 只判前缀的实现会漏掉它。
    const cause = Object.assign(new Error(`write failed for '${stagingArchive}'`), { code: 'EROFS' })
    const described = describeArchiveFailure(cause)
    expect(described.status).toBe(502)
    expect(described.refusal).toBe(false)
    expectNoLocalPath(described.message)
  })

  it('Node 内部错误码（`ERR_*`）同样不是"请求有问题"', () => {
    const cause = Object.assign(new Error(`bad value while unpacking '${stagingArchive}'`), { code: 'ERR_INVALID_ARG_TYPE' })
    const described = describeArchiveFailure(cause)
    expect(described.status).toBe(502)
    expect(described.refusal).toBe(false)
    expectNoLocalPath(described.message)
  })
})

describe('C2-3 ②：命中关键词兜底的**非**系统级原文也必须过同一份脱敏', () => {
  it('archive-util 的拒绝：仍报 422，但不带回本机路径', () => {
    const described = describeArchiveFailure(new Error(`archive entry name mismatch near '${stagingArchive}'`))
    expect(described.status, '归档确实有问题 ⇒ 仍是客户端拒绝').toBe(422)
    expect(described.refusal).toBe(true)
    expectNoLocalPath(described.message)
  })
})

describe('C2-3 ③ 反向对照：我们自己写的拒绝文案逐字透出（不得一刀切脱敏）', () => {
  it('RESIDUE：文案里有用户自己的文件路径（产品行为要求点名），必须原样', () => {
    // 与 `skill-project-root-shadow.spec.ts` 钉住的行为同源：RESIDUE 要用户去改那个
    // 文件，脱敏会把可操作信息抹成 `…/SKILL.md`。
    const own = join(root, 'project', '.dsh', 'skills', 'alpha', 'SKILL.md')
    const refusal = new ArchiveInstallRefusal('RESIDUE', `skill "alpha" is still loaded from '${own}' — rename it`)
    const described = describeArchiveFailure(refusal)
    expect(described).toMatchObject({ status: 422, code: 'RESIDUE', refusal: true })
    expect(described.message).toBe(refusal.message)
    expect(described.message).toContain(own)
  })

  it('typed 分支的状态码/code 逐个不变', () => {
    expect(describeArchiveFailure(new ArchiveInstallRefusal('NOT_INSTALLED', 'x'))).toMatchObject({ status: 404, code: 'NOT_INSTALLED' })
    expect(describeArchiveFailure(new ArchiveInstallRefusal('LOCAL_CONTENT', 'x'))).toMatchObject({ status: 409, code: 'LOCAL_CONTENT' })
    expect(describeArchiveFailure(new ArchiveInstallRefusal('ARCHIVE_TOO_LARGE', 'x'))).toMatchObject({ status: 413, code: 'ARCHIVE_TOO_LARGE' })
    expect(describeArchiveFailure(new ArchiveInstallRefusal('CHECKSUM_MISMATCH', 'archive checksum mismatch; refused')))
      .toMatchObject({ status: 422, code: 'CHECKSUM_MISMATCH', refusal: true })
  })

  it('锁竞争（SkillLockedError）仍是 503 + 原样文案', () => {
    const locked = new SkillLockedError('another writer holds the "alpha" lock (.skill-locks/alpha.lock); retry shortly')
    const described = describeArchiveFailure(locked)
    expect(described).toMatchObject({ status: 503, code: 'SKILL_LOCKED', refusal: true })
    expect(described.message).toBe(locked.message)
  })
})

describe('C2-3 相邻面：非拒绝的普通错误仍然 502 且不带路径（A12 回归）', () => {
  it('无关键词、无 errno 的原文：502 + 脱敏', () => {
    // 路径刻意**不含**任何 hint 词（`archive` 这类词本身就是安装器 staging 文件名的一部分，
    // 用它当路径会命中关键词兜底 —— 那正是 C2-3 的现场）。
    const described = describeArchiveFailure(new Error(`boom at '${join(root, 'staging', 'blob.bin')}'`))
    expect(described).toMatchObject({ status: 502, refusal: false })
    expectNoLocalPath(described.message)
  })

  it('非 Error 抛出物（字符串）也走同一条出口', () => {
    const described = describeArchiveFailure(`EROFS: read-only file system, open '${stagingArchive}'`)
    expect(described.status).toBe(502)
    expectNoLocalPath(described.message)
  })

  it('basename 允许留下（脱敏的语义是"去掉本机路径"，不是"抹掉一切"）', () => {
    const described = describeArchiveFailure(new Error(`EIO: i/o error, open '${stagingArchive}'`))
    expect(described.message).toContain(basename(stagingArchive))
  })
})
