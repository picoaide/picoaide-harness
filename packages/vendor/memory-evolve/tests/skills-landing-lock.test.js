/**
 * R18B-03（2026-09-25 第十八轮审计 · 泳道 B）：**per-name 锁的第三个写者**。
 *
 * 协议（`lib/coi/skills-sync.js` 的 SKILL_LOCK_DIR 注释 + 企业侧
 * `src/skill-install.ts` 的同名常量）：「同一个技能名的落点，
 * `<技能库>/.skill-locks/<name>.lock`」。参与者此前只有两个 —— 能力中心安装器
 * （`installSkillArchive`/`uninstallSkill`）与随包同步器（`syncBuiltinSkills`）。
 *
 * 缺陷形态（探针 `temp/r18/probe/skill-lock-third-writer.spec.ts` 实测）：
 * 外部真进程持锁时 `installSkillArchive` → `SkillLockedError`，而**同一时刻**
 * 模型面工具 `skill_manage create` 返回 `{"ok":true}` 并写进同一落点。并发窗口
 * 落进安装器的两处 `rename` 之间时，活落点只剩模型写的那份 `SKILL.md`。
 *
 * 修法：`lib/skills.js` 的三条活落点写入（`skill_manage` 的 create 直写 / patch、
 * 以及 `approvePendingSkill` 的采纳）都走 `coi/skills-sync.js` 的
 * `acquireSkillDirLock`（**同一份实现**，不再复制常量与判据），拿不到就有界
 * fail-loud、一个字都不写。
 *
 * 判据（确定性，不靠 sleep 撞窗口）：持锁期间三条写入都必须 `ok:false` 且落点/
 * 待确认队列**零变化**；正常路径写完必须**不留锁残留**（下一轮同步/安装拿得到锁）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvePendingSkill, skillManageTool } from '../lib/skills.js'

/** 技能库根 + 待确认队列根（同一棵临时树）。 */
function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-lock-'))
  const skills = join(dir, 'skills')
  const pending = join(dir, 'memories', 'pending-skills')
  mkdirSync(skills, { recursive: true })
  mkdirSync(pending, { recursive: true })
  return { dir, skills, pending, memoryDir: join(dir, 'memories') }
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 模型面工具（真实现，无替身）。 */
function skillTool(skillsDir, memoryDir) {
  return skillManageTool({ get: () => undefined }, {
    skillDir: skillsDir,
    memoryDir,
    skillMaxBytes: 65536,
    skillReviewEnabled: true, // 直写模式（用户可开；关闭时走 pending 队列）
    skillManageToolName: 'skill_manage',
  })
}

const BODY = name => `---\nname: ${name}\ndescription: model copy\n---\n\nmodel body\n`

/**
 * 按协议自造一把"活着的"锁：持锁 pid 是**本进程**（`kill(pid,0)` 必然成功 ⇒
 * 任何参与者都判"仍被持有"）。跨**进程**的同一形态由企业侧探针
 * （`temp/r18/P/probe` 用真子进程）与 `coi-skills-sync-name-lock` 覆盖；
 * 这里判的是"第三个写者是否参与协议"，与持锁者在哪个进程无关。
 * @param {string} skillsDir - 技能库根。
 * @param {string} name - 技能名。
 * @returns {string} 锁文件路径。
 */
function holdLock(skillsDir, name) {
  const lockDir = join(skillsDir, '.skill-locks')
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, `${name}.lock`)
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
  return lockPath
}

/** read-before-write 需要的会话留痕（`skill_manage action=read <name>`）。 */
function agentWithRead(name) {
  return {
    session: {
      ownEvents: () => [{
        type: 'tool/call',
        data: { name: 'skill_manage', arguments: JSON.stringify({ action: 'read', name }) },
      }],
    },
  }
}

test('R18B-03：持锁期间 skill_manage create 不再写进同一个落点', async () => {
  const { dir, skills, memoryDir } = tempTree()
  try {
    const lockPath = holdLock(skills, 'alpha')
    const tool = skillTool(skills, memoryDir)

    const created = await tool.execute({ action: 'create', name: 'alpha', description: 'model copy', body: BODY('alpha') }, {})
    console.log('[锁/create] 工具结果 =', JSON.stringify(created))
    assert.equal(created.ok, false, '持锁期间不得报 ok:true（修前这里恒真）')
    assert.match(created.message, /alpha/u)
    // 一个字都没写：落点目录不存在，锁文件原样留着（不是我们删的）。
    assert.equal(existsSync(join(skills, 'alpha')), false, '拿不到锁就绝不能写落点')
    assert.equal(existsSync(lockPath), true, '别人的锁必须原样保留')

    // 锁释放之后同一次调用成功（拒绝是"稍后重试"，不是永久失败）。
    rmSync(lockPath)
    const retried = await tool.execute({ action: 'create', name: 'alpha', description: 'model copy', body: BODY('alpha') }, {})
    console.log('[锁/create-retry] 工具结果 =', JSON.stringify(retried))
    assert.equal(retried.ok, true)
    assert.equal(readFileSync(join(skills, 'alpha', 'SKILL.md'), 'utf8'), BODY('alpha'))
    assert.deepEqual(
      readdirSync(join(skills, '.skill-locks')),
      [],
      '正常路径写完必须不留锁残留（否则下一轮同步/安装永远拿不到锁）',
    )
  } finally {
    clean(dir)
  }
})

test('R18B-03：持锁期间 skill_manage patch 同样不写', async () => {
  const { dir, skills, memoryDir } = tempTree()
  try {
    const tool = skillTool(skills, memoryDir)
    // 先正常建一份（建立 read-before-write 的前置文件）。
    const created = await tool.execute({ action: 'create', name: 'beta', description: 'model copy', body: BODY('beta') }, {})
    assert.equal(created.ok, true)
    const before = readFileSync(join(skills, 'beta', 'SKILL.md'), 'utf8')

    const lockPath = holdLock(skills, 'beta')
    const patched = await tool.execute(
      { action: 'patch', name: 'beta', body: BODY('beta').replace('model body', 'PATCHED') },
      { agent: agentWithRead('beta') },
    )
    console.log('[锁/patch] 工具结果 =', JSON.stringify(patched))
    assert.equal(patched.ok, false, 'patch 与 create 是同一个落点，必须取同一把锁')
    assert.equal(readFileSync(join(skills, 'beta', 'SKILL.md'), 'utf8'), before, '内容必须一字未改')
    assert.equal(existsSync(lockPath), true)
  } finally {
    clean(dir)
  }
})

test('R18B-03：持锁期间 approvePendingSkill 不采纳（待确认队列原样）', () => {
  const { dir, skills, pending } = tempTree()
  try {
    const staged = join(pending, 'gamma')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'SKILL.md'), BODY('gamma'))

    const lockPath = holdLock(skills, 'gamma')
    const refused = approvePendingSkill(pending, skills, 'gamma')
    console.log('[锁/approve] 结果 =', JSON.stringify(refused))
    assert.equal(refused.ok, false, '采纳写的是活落点 ⇒ 必须取同一把锁')
    assert.equal(existsSync(join(skills, 'gamma')), false, '库内零写入')
    assert.equal(existsSync(join(staged, 'SKILL.md')), true, '待确认队列那一份不得被搬走/删掉')

    // 释放后同一次采纳成功（闭环）。
    rmSync(lockPath)
    const adopted = approvePendingSkill(pending, skills, 'gamma')
    console.log('[锁/approve-retry] 结果 =', JSON.stringify(adopted))
    assert.equal(adopted.ok, true)
    assert.equal(readFileSync(join(skills, 'gamma', 'SKILL.md'), 'utf8'), BODY('gamma'))
    assert.equal(existsSync(staged), false, '采纳 = 移动（源目录消失）')
  } finally {
    clean(dir)
  }
})

test('R18B-03：锁落点是协议常量（跨包契约）——与同步侧/安装器同一份', async () => {
  const { dir, skills, memoryDir } = tempTree()
  try {
    // 预置一把**别人**的锁，再用工具创建：拒绝时的文案必须点名同一把锁的落点。
    const lockPath = holdLock(skills, 'delta')
    const tool = skillTool(skills, memoryDir)
    const created = await tool.execute({ action: 'create', name: 'delta', description: 'model copy', body: BODY('delta') }, {})
    console.log('[锁/落点] 工具结果 =', JSON.stringify(created))
    assert.equal(created.ok, false)
    assert.ok(
      created.message.includes(lockPath) || created.message.includes('.skill-locks'),
      `拒绝文案必须点名锁落点（实得：${created.message}）`,
    )
  } finally {
    clean(dir)
  }
})
