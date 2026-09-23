/**
 * tests/skills-landing-adopt-hardening.test.js — 独立审计 2026-09-23
 * `A-skill-management.md` 的 A4 / A5 / A10 回归。
 *
 * 三条缺陷都在 `lib/skills.js`（技能库的写入/采纳落点）：
 *
 *  A4（P1）`skill_manage create/patch` **写穿技能库并报成功**：落点解析走了
 *     `writeFileAtomicSafeAt` 不带 `anchorDir` 的兜底档，断言基准退化成"落点父
 *     目录"——`<skills>/evil` 是符号链接时 `realpath(父)` 自己变成包含性根、判定
 *     恒真，SKILL.md 落到库外，工具仍回 `{ok:true}`。对照组：`approvePendingSkill`
 *     同形态如实拒收。
 *  变异性：去掉 `anchorDir`（或把 `resolveSkillLanding` 退回只 `resolveSafeRepoTarget`
 *     落点父目录）→ 本文件的三条 A4 用例全红（`ok:true` + 库外出现 SKILL.md）。
 *
 *  A5（P1）`cpSync` 回落遇"目标同路径处是普通文件"把**宿主进程 abort**：
 *     libstdc++ 在 `std::filesystem::create_directory` 冲突时抛未捕获的 C++ 异常，
 *     Node 侧 `try/catch` 抓不住 —— 实测 `terminate called … cannot create
 *     directory: File exists` + exit 134。修复＝逐文件安全拷贝 + 目标类型预检。
 *  变异性：把 `copySkillTreeSafe` 换回 `cpSync(from, to, {recursive:true})` →
 *     子进程以 134（SIGABRT）退出，`child exit 0` 断言立刻红。
 *
 *  A10（P2）半成品目录 ⇒ 永久"已存在于技能库"：拷贝中途失败时 `SKILL.md` 已落地，
 *     而"已安装"的唯一判据就是它 ⇒ 之后每次采纳都被同一句话拒绝。
 *     修复＝`SKILL.md` **最后写**，中途失败不落地 ⇒ 下一次采纳仍可成功。
 *  变异性：把 `SKILL.md` 排到拷贝顺序最前面（或失败时不回收已写文件）→
 *     "第一次失败后 SKILL.md 不得存在"与"第二次采纳成功"两条断言变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvePendingSkill, resolveSkillLanding, skillManageTool } from '../lib/skills.js'

// 本文件断言中文文案（i18n.test.js 覆盖英文列）。
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'child-approve-adopt.mjs')
const REGISTER_WRITE_FAULT = join(HERE, 'fixtures', 'register-write-fault.mjs')
const REGISTER_RENAME_FAULT = join(HERE, 'fixtures', 'register.mjs')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-skill-landing-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

const BODY = (name, description, tail = '') => `---
name: ${name}
description: ${description}
---
# ${name}
${tail}`

function toolFor(skillDir, memoryDir, reviewEnabled) {
  return skillManageTool(
    { get: () => undefined, logger: { warn: () => {}, info: () => {} } },
    { skillDir, memoryDir, skillReviewEnabled: reviewEnabled, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 },
  )
}

/* --------------------------------------------------------------- A4：写穿 */

test('A4 直写：预置 `<skills>/<name>` 符号链接时 create 如实拒收，库外零写入且不删链接', async () => {
  const dir = tempDir()
  try {
    const skillDir = join(dir, 'skills')
    const memoryDir = join(dir, 'memories')
    const outside = join(dir, 'outside')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(skillDir, 'evil'))

    const tool = toolFor(skillDir, memoryDir, true)
    const res = await tool.execute(
      { action: 'create', name: 'evil', description: '探针', body: BODY('evil', '探针', 'x'.repeat(60)) },
      { agent: undefined, callId: 'c1', signal: new AbortController().signal },
    )

    assert.equal(res.ok, false, '落点被拒却报成功（A4 的核心症状）')
    assert.match(String(res.message), /拒绝|refused/i)
    assert.equal(existsSync(join(outside, 'SKILL.md')), false, 'SKILL.md 被写到技能库之外')
    assert.equal(existsSync(join(skillDir, 'evil')), true, '预置的链接本身不得被删改')

    // 反向对照：同一工具在干净的技能库里照常创建（防"一律拒绝"的假修）。
    const ok = await tool.execute(
      { action: 'create', name: 'good-skill', description: '正常', body: BODY('good-skill', '正常') },
      { agent: undefined, callId: 'c2', signal: new AbortController().signal },
    )
    assert.equal(ok.ok, true, `正常创建不得被误伤：${JSON.stringify(ok)}`)
    assert.ok(readFileSync(join(skillDir, 'good-skill', 'SKILL.md'), 'utf8').includes('good-skill'))
  } finally {
    clean(dir)
  }
})

test('A4 pending 分支：待确认队列里的同名符号链接同样拒收（写穿与 review 开关无关）', async () => {
  const dir = tempDir()
  try {
    const skillDir = join(dir, 'skills')
    const memoryDir = join(dir, 'memories')
    const pendingDir = join(memoryDir, 'pending-skills')
    const outside = join(dir, 'outside')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(pendingDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(pendingDir, 'evil'))

    const tool = toolFor(skillDir, memoryDir, false) // skillReviewEnabled=false → 走 pending
    const res = await tool.execute(
      { action: 'create', name: 'evil', description: '探针', body: BODY('evil', '探针', 'x'.repeat(60)) },
      { agent: undefined, callId: 'c1', signal: new AbortController().signal },
    )
    assert.equal(res.ok, false, 'pending 分支同样不得写穿')
    assert.equal(existsSync(join(outside, 'SKILL.md')), false, 'pending 分支把 SKILL.md 写到了队列之外')

    // 反向对照：正常 pending 创建仍然工作，且落在队列根之下。
    const ok = await tool.execute(
      { action: 'create', name: 'good-skill', description: '正常', body: BODY('good-skill', '正常') },
      { agent: undefined, callId: 'c2', signal: new AbortController().signal },
    )
    assert.equal(ok.ok, true, `正常 pending 创建不得被误伤：${JSON.stringify(ok)}`)
    assert.ok(existsSync(join(pendingDir, 'good-skill', 'SKILL.md')))
  } finally {
    clean(dir)
  }
})

test('A4 patch：技能目录被换成符号链接后 patch 如实拒收，库外零写入', async () => {
  const dir = tempDir()
  try {
    const skillDir = join(dir, 'skills')
    const memoryDir = join(dir, 'memories')
    const outside = join(dir, 'outside')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const tool = toolFor(skillDir, memoryDir, true)

    // 先建一个真技能（patch 需要它存在），再把整个技能目录换成库外链接。
    await tool.execute(
      { action: 'create', name: 'evil', description: '合法', body: BODY('evil', '合法') },
      { agent: undefined, callId: 'c1', signal: new AbortController().signal },
    )
    rmSync(join(skillDir, 'evil'), { recursive: true, force: true })
    symlinkSync(outside, join(skillDir, 'evil'))
    // 链接目标里也放一份合法 SKILL.md：readSkill 会经链接读到它（read-before-write
    // 于是通过），patch 真的走到**写入**那一步——这才是 A4 的写穿面。没有它，
    // patch 会在"技能不存在"就返回，写穿根本不可达（用例会假绿：变异验证实测）。
    writeFileSync(join(outside, 'SKILL.md'), BODY('evil', '库外那一份', 'OUTSIDE-ORIGINAL'))
    const outsideBefore = readFileSync(join(outside, 'SKILL.md'), 'utf8')

    const readEvent = { type: 'tool/call', data: { name: 'skill_manage', arguments: JSON.stringify({ action: 'read', name: 'evil' }) } }
    const agent = { session: { ownEvents: () => [readEvent] } }
    const res = await tool.execute(
      { action: 'patch', name: 'evil', body: BODY('evil', '被篡改', 'PATCHED') },
      { agent, callId: 'c2', signal: new AbortController().signal },
    )
    assert.equal(res.ok, false, 'patch 经符号链接目录写穿并报成功')
    assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), outsideBefore, 'patch 把技能库外那一份写穿了')
  } finally {
    clean(dir)
  }
})

test('A4 结构哨兵：lib/skills.js 不得再用 cpSync 整树拷贝（A5 的 abort 源头）', () => {
  const src = readFileSync(join(PKG, 'lib', 'skills.js'), 'utf8')
  assert.doesNotMatch(src, /\bcpSync\s*\(/, 'lib/skills.js 又出现了 cpSync：目标同路径处是文件时会把宿主进程 abort（exit 134）')
})

test('A4 落点解析：resolveSkillLanding 以库根为基准，同名普通文件/越界一律 null', () => {
  const dir = tempDir()
  try {
    const root = join(dir, 'skills')
    mkdirSync(root, { recursive: true })
    assert.equal(resolveSkillLanding(root, 'plain', { leaf: 'dir' }), join(root, 'plain'))
    // 同名处是普通文件 → 不是目录
    writeFileSync(join(root, 'blocked'), 'x')
    assert.equal(resolveSkillLanding(root, 'blocked', { leaf: 'dir' }), null)
    assert.equal(resolveSkillLanding(root, 'blocked/SKILL.md'), null)
    // 越界 / 非法相对路径
    assert.equal(resolveSkillLanding(root, '../escape/SKILL.md'), null)
    assert.equal(resolveSkillLanding(root, '/abs/SKILL.md'), null)
    assert.equal(resolveSkillLanding(root, 'a//b'), null)
    // 符号链接目录 → null（即使它指向库**内**，行为收紧要登记：一律拒收）
    mkdirSync(join(root, 'real'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    assert.equal(resolveSkillLanding(root, 'alias/SKILL.md'), null)
  } finally {
    clean(dir)
  }
})

/* ------------------------------------- A5 / A10：子进程夹具（abort 与半成品） */

/**
 * 跑一次子进程夹具。
 * @param {string} mode - plain | blocked-target | write-fault
 * @param {{ register?: string | null, env?: Record<string, string> }} [options]
 *   `register` = 要用 `--import` 装上的 fs 垫片（缺省不打补丁）。
 */
function runAdopt(mode, options = {}) {
  const register = options.register ?? null
  const args = register === null ? [CHILD] : ['--import', register, CHILD]
  const result = spawnSync(process.execPath, args, {
    env: {
      ...process.env,
      ADOPT_MODE: mode,
      SKILLS_MODULE: join(PKG, 'lib', 'skills.js'),
      ...(options.env ?? {}),
    },
    encoding: 'utf8',
  })
  return { ...result, json: result.stdout.trim() === '' ? null : JSON.parse(result.stdout.trim()) }
}

test('A5 目标同路径处是普通文件：可读拒收，进程存活（绝不 abort / exit 134）', () => {
  const r = runAdopt('blocked-target')
  assert.equal(r.signal, null, `子进程被信号打死：${r.signal}（cpSync 的未捕获 C++ 异常就是这一形态）`)
  assert.equal(r.status, 0, `子进程非零退出（exit 134 = abort）：${r.stderr}`)
  const j = r.json
  assert.equal(j.first.ok, false, '目标类型不对却报采纳成功')
  assert.match(String(j.first.message), /不可用|refused|拒绝/)
  assert.equal(j.firstThrew, false, '可预期"同名处不是目录"必须是返回值，不是异常')
  assert.equal(j.skillMdAfterFirst, false, '被拒之后目标目录里不得留下 SKILL.md（半成品）')
  assert.equal(j.second.ok, true, '用户处理掉同名文件后，第二次采纳必须成功（A10：不得被半成品永久锁死）')
  assert.equal(j.helperAfterSecond, true, '第二次采纳必须把整棵目录装进去')
})

test('A10 拷贝中途失败：SKILL.md 不落地、既有用户文件保留，下一次采纳成功', () => {
  const control = runAdopt('write-fault')
  assert.equal(control.status, 0, `对照组子进程失败：${control.stderr}`)
  assert.equal(control.json.first.ok, true, `对照组：无故障注入时采纳必须成功：${JSON.stringify(control.json?.first)}`)
  assert.equal(control.json.notesIntact, true, '合并语义：目标目录里用户自加文件必须保留')

  const r = runAdopt('write-fault', {
    register: REGISTER_WRITE_FAULT,
    env: { FAULT_ON: '1', FAULT_CODE: 'ENOSPC' },
  })
  assert.equal(r.signal, null, `子进程被信号打死：${r.signal}`)
  assert.equal(r.status, 0, `子进程非零退出：${r.stderr}`)
  const j = r.json
  assert.equal(j.first.ok, false, `第一次采纳必须失败（注入 ENOSPC）：${JSON.stringify(j.first)}`)
  assert.equal(j.skillMdAfterFirst, false, '半成品 SKILL.md 落地了 ⇒ 下一次采纳会被"已存在于技能库"永久拒绝（A10 未修）')
  assert.equal(j.second.ok, true, '故障消失后第二次采纳必须成功')
  assert.equal(j.skillMdAfterSecond, true, '第二次采纳必须写全')
  assert.equal(j.notesIntact, true, '合并语义：第二次采纳也不得删掉用户自加文件')
})

test('A5 更严的形态：整个文件系统的 rename 都不可用 → 如实抛错、无半成品、进程存活', () => {
  // `FAULT_ALL_RENAMES=1`（连原子写的 `<file>.tmp.<pid>` 那一步也失败）不是"采纳那
  // 一次目录搬移失败"，而是"rename(2) 整体坏了"。此时正确的行为是**响亮失败**：
  // 抛错（HTTP 层转成"采纳失败（EBUSY）"），而不是半写一个技能目录或者 abort。
  const r = runAdopt('write-fault', {
    register: REGISTER_RENAME_FAULT,
    env: { FAULT_CODE: 'EBUSY', FAULT_ALL_RENAMES: '1' },
  })
  assert.equal(r.signal, null, `子进程被信号打死：${r.signal}`)
  assert.equal(r.status, 0, `子进程非零退出：${r.stderr}`)
  const j = r.json
  assert.equal(j.firstThrew, true, 'rename 整体不可用时必须是异常（fail-loud），不能报成功')
  assert.equal(j.first.ok, false)
  assert.equal(j.skillMdAfterFirst, false, '不得留下半成品 SKILL.md')
  assert.equal(j.notesIntact, true, '用户自加文件必须原样保留')
  // 只允许留下原子写的临时落点（`…/SKILL.md.tmp.<pid>` 之类）：绝不出现任何真
  // 技能内容。rename 整体不可用时原子写原语会把 tmp 留在盘上（它只在自己的
  // `{ok:false}` 分支回收），这是本形态的已知残留，不影响"未安装"的判定
  // （"已安装"的唯一判据是 `SKILL.md` 存在）。
  assert.equal(
    j.targetEntriesAfterFirst.includes('SKILL.md'),
    false,
    `目标目录里出现了半成品 SKILL.md：${JSON.stringify(j.targetEntriesAfterFirst)}`,
  )
  assert.equal(
    j.targetEntriesAfterFirst.includes('scripts/helper.mjs'),
    false,
    `目标目录里出现了半成品辅助文件：${JSON.stringify(j.targetEntriesAfterFirst)}`,
  )
  for (const rel of j.targetEntriesAfterFirst) {
    assert.ok(
      rel === 'notes.md' || /\.tmp\.\d+$/.test(rel),
      `目标目录里出现了非临时残留：${rel}（全部：${JSON.stringify(j.targetEntriesAfterFirst)}）`,
    )
  }
})

test('A5/A10 对照：目标目录不存在时采纳走 rename（原子），不需要任何回落', () => {
  const r = runAdopt('plain')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.json.first.ok, true, '正常采纳必须成功')
  assert.equal(r.json.pendingDeleted, true, '采纳成功后待确认副本必须删除')
  assert.equal(r.json.skillMdAfterFirst, true)
})

/* ---------------------------------------------- A4/A5 共同前提：既有行为不回归 */

test('回归对照：已存在于技能库（SKILL.md 在）仍然按原语义拒收，不做覆盖', () => {
  const dir = tempDir()
  try {
    const pending = join(dir, 'pending')
    const skillDir = join(dir, 'skills')
    mkdirSync(join(pending, 'bar'), { recursive: true })
    mkdirSync(join(skillDir, 'bar'), { recursive: true })
    writeFileSync(join(pending, 'bar', 'SKILL.md'), BODY('bar', 'd', 'NEW'))
    writeFileSync(join(skillDir, 'bar', 'SKILL.md'), BODY('bar', 'd', 'INSTALLED'))
    const res = approvePendingSkill(pending, skillDir, 'bar')
    assert.equal(res.ok, false)
    assert.match(String(res.message), /已存在/)
    assert.ok(readFileSync(join(skillDir, 'bar', 'SKILL.md'), 'utf8').includes('INSTALLED'), '已装内容不得被覆盖')
    assert.equal(existsSync(join(pending, 'bar', 'SKILL.md')), true, '被拒时待确认副本必须保留')
  } finally {
    clean(dir)
  }
})
