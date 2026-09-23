/**
 * tests/coi-skills-sync-name-lock.test.js — 独立复审 r3 **F3** 的回归（同步侧）：
 * 「随包同步」与「能力中心安装器」**不互斥**，并发下能产出 P1-2 的归属错。
 *
 * 复审实测（temp/verify-skill-r3，真磁盘 + 神谕式安装器垫片）：目标 = 已装插件版
 * （x-version 1 < 随包 2），安装器在同步进入暂存写入后完成自己的原子换入 ⇒
 *   5/5（真实体量 20 轮中 15 轮）落到终态
 *   `{content:"plugin", provenanceChannel:"market", installVersion:"3.0.0",
 *     marketPayloadSurvived:false, installSilentlyLost:true}`
 * 即**内容是插件版、溯源是市场版**，而且此后插件侧永久 `SKILL_CHANNEL_CONFLICT`
 * 拒收该目录 ⇒ **不会自愈**。
 *
 * 根因：同步路径完全不取安装器那把 per-name 锁（`skill-install.ts` 的
 * `withSkillLock`），两者只靠 rename 语义在部分交错下侥幸 fail-safe。
 *
 * 修复：两端共用**同一把文件锁**（落点/内容/陈旧判据见 `lib/coi/skills-sync.js`
 * 里 `SKILL_LOCK_DIR` 的协议注释；跨包不能 import，故两端各自实现同一协议，
 * 由 enterprise 的对拍用例 + 交叉用例钉住）。同步侧**零等待**（它跑在同步的启动
 * 路径上；同步忙等会把同一进程里的异步持锁者饿死 ⇒ 自锁），拿不到就如实拒收。
 *
 * 判据：
 *   1. 锁被活进程持有时 ⇒ `refused` + `SKILL_LOCKED`，目标目录一字不动，
 *      **不得**删掉别人那把锁；
 *   2. 陈旧锁（持锁进程已死 / 无可用 pid 且 mtime 超时）⇒ 抢占并正常同步，
 *      同步结束后自己那把锁必须已释放；
 *   3. 反向：正常同步不留下任何锁残留，且 `.skill-locks` 不会被当成技能。
 *
 * 变异验证：去掉同步侧的取锁（回到"完全不互斥"）⇒ 第 1 例必红（复现为 `synced`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinSkills } from '../lib/coi/skills-sync.js'

const NAME = 'kimi-cli-calling'
const LOCK_DIR = '.skill-locks'
const LOCK_FILE = `${NAME}.lock`

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-lock-'))
}

/** 造随包技能（x-version 2 ⇒ 比已装的 1 新，会触发换入）。 */
function seedPluginSkill(pluginSkills) {
  mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
  writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: bundled\nx-version: 2\n---\n# BUNDLED\n`)
  writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER\n')
}

/** 造"已装的插件版"（channel: plugin，x-version 1）。 */
function seedInstalledPluginSkill(userSkills) {
  mkdirSync(join(userSkills, NAME, '.picoaide'), { recursive: true })
  writeFileSync(join(userSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: installed\nx-version: 1\n---\n# INSTALLED-OLD\n`)
  writeFileSync(
    join(userSkills, NAME, '.picoaide', 'release.json'),
    `${JSON.stringify({ appId: NAME, version: '1', channel: 'plugin', installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
  )
}

/** 按协议种一把锁（内容与安装器/同步器写下的同形：`{pid, at}`）。 */
function plantLock(userSkills, { pid, at = Date.now(), body } = {}) {
  const lockDir = join(userSkills, LOCK_DIR)
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, LOCK_FILE)
  writeFileSync(lockPath, body ?? JSON.stringify({ pid, at }))
  return lockPath
}

/** 已死进程的 pid（子进程跑完即被回收，用它构造"持锁进程已死"）。 */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

function entryFor(results) {
  return results.find((r) => r.name === NAME)
}

/* ---------------------------------------- 1) 持锁期间：同步必须让路（不得并发换入） */

test('F3 安装器持锁（活 pid）时同步 refused + SKILL_LOCKED：目标一字不动、别人的锁不删', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedInstalledPluginSkill(userSkills)
    // 本进程的 pid = 一定"活着"的持锁者（真实链路里就是同一个宿主进程里的安装器）。
    const lockPath = plantLock(userSkills, { pid: process.pid })
    const bodyBefore = readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8')

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))

    assert.equal(
      entry.action,
      'refused',
      `持锁期间不得换入（并发换入会产出"内容是插件版、溯源是市场版"，且不会自愈）：${JSON.stringify(entry)}`,
    )
    assert.equal(entry.code, 'SKILL_LOCKED', '必须是可区分的"名字被占用/持锁"码，而不是笼统 refused')
    assert.match(String(entry.message), new RegExp(NAME, 'u'), '文案要点名技能，便于排障')
    assert.equal(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), bodyBefore, '目标内容必须一字不动')
    assert.equal(existsSync(lockPath), true, '不得删掉别人（活进程）的锁')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------- 2) 陈旧锁：必须能抢占（不死锁） */

test('F3 陈旧锁（持锁进程已死）⇒ 抢占后正常同步，且同步结束后自己那把锁已释放', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedInstalledPluginSkill(userSkills)
    const pid = deadPid()
    assert.equal(Number.isInteger(pid), true, '夹具前置：需要一个已死的 pid')
    plantLock(userSkills, { pid })

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))

    assert.equal(entry.action, 'synced', `陈旧锁必须被抢占（否则崩溃残留会永久卡住同步）：${JSON.stringify(entry)}`)
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /# BUNDLED/u, '内容按 x-version 更新')
    assert.equal(
      readdirSync(join(userSkills, LOCK_DIR)).length,
      0,
      '同步结束后自己那把锁必须已释放（不留残留）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F3 无可用 pid 且 mtime 超时的锁 ⇒ 按陈旧抢占；新鲜的同形锁 ⇒ 保守拒收', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedInstalledPluginSkill(userSkills)
    // 旧格式/坏内容（没有可用 pid）——只能按 mtime 判：先做成"陈旧"。
    const lockPath = plantLock(userSkills, { body: 'not-json' })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'synced', '陈旧（mtime 超时）必须能抢占')

    // 同形的新鲜锁：不可判定是否死锁 ⇒ 保守拒收（宁可少同步一次，不可并发写）。
    rmSync(join(userSkills, NAME), { recursive: true, force: true })
    seedInstalledPluginSkill(userSkills)
    plantLock(userSkills, { body: 'not-json' })
    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused', `不可判定的锁必须保守处理：${JSON.stringify(entry)}`)
    assert.equal(entry.code, 'SKILL_LOCKED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- 3) 反向：正常路径不许退化 */

test('F3 反向：正常同步（首次安装）不留下锁残留，`.skill-locks` 不被当成技能目录', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'synced')
    // 锁目录里不残留锁文件；且它不是一个"技能目录"（没有 SKILL.md、以点开头）。
    const lockDir = join(userSkills, LOCK_DIR)
    assert.deepEqual(existsSync(lockDir) ? readdirSync(lockDir) : [], [], '正常同步不得留下锁残留')
    assert.equal(existsSync(join(lockDir, 'SKILL.md')), false, '锁目录不是技能目录')
    // 第二次同步（幂等）同样不留残留。
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'unchanged')
    assert.deepEqual(existsSync(lockDir) ? readdirSync(lockDir) : [], [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
