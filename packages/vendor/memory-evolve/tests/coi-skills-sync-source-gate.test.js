/**
 * tests/coi-skills-sync-source-gate.test.js — 独立审计 W4（2026-09-23）的
 * P1-1 / P1-2 回归：**随包插件开机同步是唯一没有闸门的写者**。
 *
 * 缺陷（W4 probe5 情形 1 / probe10 全链，真磁盘实测）：
 *   - `syncBuiltinSkills` 的 `needsCopy` 只看 `x-version`，整树换入（`syncSkillDirSafe`）
 *     于是会**静默**把用户手写的同名技能连同他自己的文件一起删掉，并补上
 *     `channel: 'plugin'` 的溯源 —— 能力中心此后按"商店来源"对待它；
 *   - 市场装进来的同名技能同样被换回插件正文，而 A9 的标记保留让**旧的 market
 *     provenance 活下来** ⇒ 内容是插件版、徽章是"市场 v3.0.0"、`dirty` 翻真。
 *
 * 修复（`lib/coi/skills-sync.js` 的 `classifySyncTarget` / `readStoreChannel`）：
 * 整树换入之前先按**与安装器同一份来源判据**（enterprise `isStoreProvenance`：
 * 标记可读 + 渠道是商店来源 + `appId === 目录名`）判定目标目录——
 *   1. 目录不存在 → 允许（首次安装）；
 *   2. 渠道 === `plugin` → 允许（按 `x-version` 正常更新，安装器标记由 A9 保留）；
 *   3. 渠道是**其它**商店渠道 → 拒绝（`SKILL_CHANNEL_CONFLICT`，换渠道 = 两边每次
 *      开机互相覆盖，必须由用户显式处置）；
 *   4. 没有可用的商店溯源 → 拒绝（`SKILL_LOCAL_CONTENT`，按用户自制内容处理）。
 * 两条拒绝都保持既有 fail-loud 的 `action: 'refused'`（另带可区分的 `code`），
 * 并在日志里点名技能与落点；**绝不静默删用户内容**。
 *
 * 变异性（拆掉闸门必红）：把 `classifySyncTarget` 的调用去掉（或让它恒返回
 * `{ok:true}`）⇒ 前四条用例全红（用户文件消失 / 渠道被改名 / 拒绝码丢失）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinSkills } from '../lib/coi/skills-sync.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const NAME = 'memory-consolidate'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-gate-'))
}

/** 造插件源技能（x-version 2 ⇒ 比任何"已装旧版"新，一定会触发换入判定）。 */
function seedPluginSkill(pluginSkills) {
  mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
  writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: bundled\nx-version: 2\n---\n# BUNDLED\n`)
  writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER\n')
}

/** 造一份用户手写的同名技能（无 provenance）+ 私有文件。 */
function seedUserSkill(userSkills, { xVersion } = {}) {
  mkdirSync(join(userSkills, NAME), { recursive: true })
  writeFileSync(
    join(userSkills, NAME, 'SKILL.md'),
    `---\nname: ${NAME}\ndescription: 用户手写\nversion: 9.9.9\n${xVersion === undefined ? '' : `x-version: ${xVersion}\n`}---\n我自己的正文\n`,
  )
  writeFileSync(join(userSkills, NAME, 'MY-NOTES.md'), '我的笔记\n')
}

/** 造一份带安装器溯源的已装副本（channel 可变）。 */
function seedStoreSkill(userSkills, channel, { xVersion = 1 } = {}) {
  mkdirSync(join(userSkills, NAME, '.picoaide'), { recursive: true })
  writeFileSync(join(userSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: ${channel}\nx-version: ${xVersion}\n---\n# ${channel.toUpperCase()}-INSTALLED\n`)
  writeFileSync(
    join(userSkills, NAME, '.picoaide', 'release.json'),
    `${JSON.stringify({ appId: NAME, version: '3.0.0', channel, installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
  )
  return readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8')
}

/** 本轮同步里该技能的条目。 */
function entryFor(results) {
  return results.find((r) => r.name === NAME)
}

/* --------------------------------------------- 1) 用户手写：不得整树覆盖 */

test('P1-1 用户手写同名技能：refused + 内容（含用户自己的文件）一字不动 + 溯源仍为"自制"', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedUserSkill(userSkills) // 无 provenance，无 x-version（W4 probe5 情形 1）
    const before = readdirSync(join(userSkills, NAME)).sort()

    const results = syncBuiltinSkills(pluginSkills, userSkills)
    const entry = entryFor(results)

    assert.equal(entry.action, 'refused', `用户内容必须被拒收：${JSON.stringify(entry)}`)
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT', '必须给出可区分的拒绝码（不是"落点断言"那一档）')
    assert.match(String(entry.message), new RegExp(NAME, 'u'), '拒绝信息必须点名技能/落点，便于排障')
    assert.deepEqual(readdirSync(join(userSkills, NAME)).sort(), before, '用户目录内容必须逐字不动（含 MY-NOTES.md）')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /我自己的正文/u, '用户正文不得被插件正文替换')
    assert.equal(existsSync(join(userSkills, NAME, 'MY-NOTES.md')), true, '用户自己的文件不得被静默删除')
    assert.equal(existsSync(join(userSkills, NAME, '.picoaide')), false, '不得把用户内容标成"商店来源"（channel: plugin）')
    // 其余内置技能不受影响：单个落点被拒不阻塞整轮同步（本夹具的源目录只放了一个
    // 技能，所以其余成员如实报 missing —— 关键是**只有这一个**被拒）。
    assert.deepEqual(results.filter((r) => r.action === 'refused').map((r) => r.name), [NAME])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-1 用户手写且 x-version 更高：同样 refused（不得报成 unchanged 掩盖"本机是别的东西"）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedUserSkill(userSkills, { xVersion: 99 })

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused', `x-version 高只说明"不用覆盖"，不能掩盖来源：${JSON.stringify(entry)}`)
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /我自己的正文/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------------------- 2) 别的商店渠道：渠道互斥，不得静默换渠道 */

for (const channel of ['market', 'org', 'builtin']) {
  test(`P1-2 ${channel} 渠道的同名技能：refused（渠道冲突）+ 内容与 provenance 逐字不变`, () => {
    const dir = tempDir()
    try {
      const pluginSkills = join(dir, 'plugin-skills')
      const userSkills = join(dir, 'skills')
      seedPluginSkill(pluginSkills)
      const provenanceBefore = seedStoreSkill(userSkills, channel)
      const bodyBefore = readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8')

      const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))

      assert.equal(entry.action, 'refused', `${channel} 渠道不得被静默换成 plugin：${JSON.stringify(entry)}`)
      assert.equal(entry.code, 'SKILL_CHANNEL_CONFLICT', '渠道冲突必须与"用户自制"分成两个码')
      assert.match(String(entry.message), new RegExp(channel, 'u'), '拒绝信息必须点名冲突的渠道')
      assert.equal(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), bodyBefore, '内容必须原样保留')
      assert.equal(
        readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'),
        provenanceBefore,
        'provenance 必须原样保留（内容与归属都不许被改）',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('P1-1 appId 对不上（目录被改名/被占用）：按用户内容处理，不放行', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedStoreSkill(userSkills, 'plugin')
    // 溯源里写的是别人的 appId ⇒ 与安装器同口径：不算"这份是我们装的"。
    writeFileSync(
      join(userSkills, NAME, '.picoaide', 'release.json'),
      `${JSON.stringify({ appId: 'someone-else', version: '1', channel: 'plugin', installedAt: '' }, null, 2)}\n`,
    )

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused')
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------- 3) 允许的路径不许退化 */

test('P1-1 渠道就是 plugin：按 x-version 正常更新，且安装器标记由 A9 保留', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    const provenanceBefore = seedStoreSkill(userSkills, 'plugin', { xVersion: 1 })
    writeFileSync(join(userSkills, NAME, '.install-version'), '3.0.0')

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'synced', `plugin 渠道必须能正常升级：${JSON.stringify(entry)}`)
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BUNDLED/, '内容来自插件源')
    assert.equal(existsSync(join(userSkills, NAME, 'scripts', 'helper.mjs')), true, '整目录语义：辅助文件随技能一起走')
    assert.equal(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'), provenanceBefore, 'A9：安装器标记不丢')
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), '3.0.0', 'A9：.install-version 不丢')
    assert.equal(
      readdirSync(userSkills).filter((n) => n.includes('.staging-') || n.includes('.old-')).length,
      0,
      '换入后不得留下暂存/旁置目录',
    )
    // 幂等：第二次同步（版本一致）仍是 unchanged，不会反复重写。
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'unchanged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 用户确认覆盖后（市场安装成功）插件同步不再回抢：provenance 与内容都归 market', () => {
  // 这是 probe10 链条的收口形态：市场覆盖成功（用户在确认条上点过）= 内容与溯源
  // 都是 market；下一次开机同步必须**拒收**而不是把内容换回插件版（换回就会让
  // 徽章说 market、内容说 plugin）。
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedStoreSkill(userSkills, 'market', { xVersion: 0 })
    writeFileSync(join(userSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: market\nversion: 3.0.0\n---\nBODY-market\n`)

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused')
    assert.equal(entry.code, 'SKILL_CHANNEL_CONFLICT')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BODY-market/u, '市场版内容不得被换回插件版')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-1 目录存在但没有 SKILL.md（用户自己的目录）：同样拒绝，不整树换入', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    mkdirSync(join(userSkills, NAME), { recursive: true })
    writeFileSync(join(userSkills, NAME, 'notes.txt'), '只是我的笔记\n')

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused', '存在即要判来源，"没有 SKILL.md 就直接铺"会删掉用户目录')
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.equal(readFileSync(join(userSkills, NAME, 'notes.txt'), 'utf8'), '只是我的笔记\n')
    assert.equal(existsSync(join(userSkills, NAME, 'SKILL.md')), false, '不得把内置技能正文写进用户目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-1 首次安装（目录不存在）：照常装上并写 channel: plugin 的溯源', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'synced')
    const info = JSON.parse(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'))
    assert.equal(info.channel, 'plugin')
    assert.equal(info.appId, NAME)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
