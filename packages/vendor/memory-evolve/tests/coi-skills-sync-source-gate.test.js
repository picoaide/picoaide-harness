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
 *   4. 没有任何 `release.json` → 拒绝（`SKILL_LOCAL_CONTENT`），**除非**内容与随包
 *      技能逐字相同 ⇒ 采纳（补写 `channel: 'plugin'` 后报 `adopted`，见 §兼容路径）；
 *   5. 有 `release.json` 但读不出可用渠道 → 同样拒绝，且**不采纳**（不覆盖看不懂的标记）。
 * 拒绝都保持既有 fail-loud 的 `action: 'refused'`（另带可区分的 `code`），
 * 并在日志里点名技能与落点；**绝不静默删用户内容**。
 *
 * §兼容路径（P1-1 追加，同轮）：写溯源的 A9 不在任何已发布版本里 ⇒ 现场存在"旧版
 * 插件同步落下、没有 `.picoaide`"的目录。它们只有在**内容同一性**成立时被采纳
 * （`isIdenticalTree`：条目集合逐项相同 + 每个文件字节相同 + 无符号链接/读取异常）。
 * 判据是"可验证的同一性"而不是启发式：多一个文件、少一个文件、任何字节差异、
 * 符号链接、读失败 ⇒ 一律照旧 `refused`。
 *
 * 变异性（已实跑，见修复报告 §追加任务的变异验证）：
 *   - 把 `classifySyncTarget` 调用去掉（或恒 `{ok:true}`）⇒ §P1-1/P1-2 的 8 例红；
 *   - 把"逐文件字节比较"降级成只看条目集合 ⇒ §兼容路径 的"一个字节不同 / 缺一个
 *     文件"用例红；
 *   - 去掉"多一个条目也算不同"（`srcEntries.length !== destEntries.length`）⇒
 *     §兼容路径 的"多一个用户文件"用例红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    seedStoreSkill(userSkills, 'plugin', { xVersion: 1 })
    writeFileSync(join(userSkills, NAME, '.install-version'), '3.0.0')

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'synced', `plugin 渠道必须能正常升级：${JSON.stringify(entry)}`)
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BUNDLED/, '内容来自插件源')
    assert.equal(existsSync(join(userSkills, NAME, 'scripts', 'helper.mjs')), true, '整目录语义：辅助文件随技能一起走')
    // A9：标记不丢（文件还在、归属不变）。R4-B-1（第四轮）：**version 必须跟到新的
    // x-version**（源是 2；旧 provenance 记 1、旧 .install-version 是 3.0.0）——
    // 停在旧值会被能力中心当"已装版本"显示、被技能调用遥测直接上报。
    const provAfter = JSON.parse(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'))
    assert.equal(provAfter.channel, 'plugin', 'A9：安装器标记不丢')
    assert.equal(provAfter.appId, NAME, 'A9：归属不变')
    assert.equal(provAfter.version, '2', 'R4-B-1：随包升版后 provenance.version 必须等于新的 x-version')
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), '2', 'R4-B-1：.install-version 与 provenance 同进同退')
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

/* ============================================================================
 * §兼容路径（P1-1 追加，同轮）：内容同一性成立的"无溯源历史副本"被采纳。
 *
 * 现场形态：A9（写溯源）不在任何已发布版本里 ⇒ 旧版插件同步落下的目录里没有
 * `.picoaide`。它们被来源闸门按用户内容拒收（今天磁盘状态与旧行为一致），但
 * **将来**插件升 x-version 时不会更新。判据＝内容同一性（逐项 + 逐字节），
 * 成立即补写 `channel: 'plugin'` 溯源（报 `adopted`），此后走正常更新路径。
 * ========================================================================== */

/** 把插件源技能**逐字复制**到技能库（= 旧版同步落下的形态：内容相同、没有溯源）。 */
function seedUnownedCopy(pluginSkills, userSkills) {
  cpSync(join(pluginSkills, NAME), join(userSkills, NAME), { recursive: true, preserveTimestamps: true })
}

test('兼容路径 完全同一（逐项 + 逐字节）：adopted + 补写 channel: plugin，随后能按 x-version 更新', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedUnownedCopy(pluginSkills, userSkills)
    assert.equal(existsSync(join(userSkills, NAME, '.picoaide')), false, '前置条件：这一份没有溯源')

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'adopted', `内容逐字相同的无溯源副本必须被采纳：${JSON.stringify(entry)}`)
    assert.equal(entry.code, undefined, '采纳不是失败，不带 code')
    // 采纳只写来源标记：正文一字未动、`.install-version` 按 x-version 补上。
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /# BUNDLED/u)
    const info = JSON.parse(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'))
    assert.equal(info.channel, 'plugin')
    assert.equal(info.appId, NAME)
    assert.equal(info.version, '2', 'version 取随包 SKILL.md 的 x-version')
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), '2')
    // 幂等：第二次同步（内容仍相同、渠道已是 plugin）不再报 adopted。
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'unchanged')

    // 采纳的**目的**：此后插件升 x-version 时这一份能正常更新。
    writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: bundled\nx-version: 3\n---\n# BUNDLED-V3\n`)
    writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER-V3\n')
    const upgraded = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(upgraded.action, 'synced', `采纳之后必须能按 x-version 更新：${JSON.stringify(upgraded)}`)
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BUNDLED-V3/u)
    assert.match(readFileSync(join(userSkills, NAME, 'scripts', 'helper.mjs'), 'utf8'), /HELPER-V3/u)
    assert.equal(
      JSON.parse(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8')).channel,
      'plugin',
      'A9：采纳写下的溯源在换入后仍在',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('兼容路径 真实随包技能目录（含 scripts/ 子目录）逐字复制 ⇒ adopted', () => {
  // 用包内真技能（`skills/memory-consolidate`：SKILL.md + scripts/scan_memory.mjs）
  // 走一遍：既覆盖多文件/子目录的条目比较，也钉住"枚举随包目录"这条路径。
  const dir = tempDir()
  try {
    const userSkills = join(dir, 'skills')
    cpSync(join(PKG, 'skills', NAME), join(userSkills, NAME), { recursive: true, preserveTimestamps: true })

    const entry = entryFor(syncBuiltinSkills(join(PKG, 'skills'), userSkills))
    assert.equal(entry.action, 'adopted', `真实随包技能的逐字副本必须被采纳：${JSON.stringify(entry)}`)
    assert.equal(existsSync(join(userSkills, NAME, 'scripts', 'scan_memory.mjs')), true, '辅助文件保持原样')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const extra of ['MY-NOTES.md', 'zz-user-notes.md']) {
  test(`兼容路径 多一个用户文件（${extra}）⇒ refused，用户文件一字不动`, () => {
    const dir = tempDir()
    try {
      const pluginSkills = join(dir, 'plugin-skills')
      const userSkills = join(dir, 'skills')
      seedPluginSkill(pluginSkills)
      seedUnownedCopy(pluginSkills, userSkills)
      writeFileSync(join(userSkills, NAME, extra), '我自己的笔记\n')

      const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
      assert.equal(entry.action, 'refused', `多一个文件就不算"逐字副本"：${JSON.stringify(entry)}`)
      assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
      assert.equal(readFileSync(join(userSkills, NAME, extra), 'utf8'), '我自己的笔记\n')
      assert.equal(existsSync(join(userSkills, NAME, '.picoaide')), false, '拒收不得补写溯源')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('兼容路径 一个字节不同 ⇒ refused（正文一字不改）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedUnownedCopy(pluginSkills, userSkills)
    const original = readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8')
    writeFileSync(join(userSkills, NAME, 'SKILL.md'), `${original}\n我加了一行\n`)

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused', `任何字节差异都不算同一性：${JSON.stringify(entry)}`)
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /我加了一行/u, '用户改过的正文不许被换掉')
    assert.equal(existsSync(join(userSkills, NAME, '.picoaide')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('兼容路径 缺一个文件 ⇒ refused', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    seedUnownedCopy(pluginSkills, userSkills)
    rmSync(join(userSkills, NAME, 'scripts', 'helper.mjs'))

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused', `少一个文件就不算同一性：${JSON.stringify(entry)}`)
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.equal(existsSync(join(userSkills, NAME, '.picoaide')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('兼容路径 目标内有符号链接条目 ⇒ refused（同一性无法证明）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    const victim = join(dir, 'victim.txt')
    seedPluginSkill(pluginSkills)
    seedUnownedCopy(pluginSkills, userSkills)
    writeFileSync(victim, 'ORIGINAL\n')
    symlinkSync(victim, join(userSkills, NAME, 'link-to-victim'))

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused', `符号链接条目必须判"不同"：${JSON.stringify(entry)}`)
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL\n', '库外 victim 不得被写穿')
    assert.equal(existsSync(join(userSkills, NAME, '.picoaide')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('兼容路径 有 release.json 但读不出可用渠道（appId 不符 / 未知渠道 / JSON 坏）⇒ refused 且不采纳', () => {
  for (const [label, body] of [
    ['appId-mismatch', JSON.stringify({ appId: 'someone-else', version: '2', channel: 'plugin', installedAt: '' })],
    ['unknown-channel', JSON.stringify({ appId: NAME, version: '2', channel: 'weird-channel', installedAt: '' })],
    ['broken-json', '{ not json'],
  ]) {
    const dir = tempDir()
    try {
      const pluginSkills = join(dir, 'plugin-skills')
      const userSkills = join(dir, 'skills')
      seedPluginSkill(pluginSkills)
      seedUnownedCopy(pluginSkills, userSkills)
      mkdirSync(join(userSkills, NAME, '.picoaide'), { recursive: true })
      writeFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), body)

      const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
      assert.equal(entry.action, 'refused', `${label}：看不懂的标记不得被采纳/覆盖：${JSON.stringify(entry)}`)
      assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
      assert.equal(
        readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'),
        body,
        `${label}：原有标记必须逐字保留`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('兼容路径 已有 plugin 溯源的同内容目录：报 unchanged/synced 而不是 adopted（落点可区分）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills)
    // 先正常装一次（写 plugin 溯源），再同步：内容相同 ⇒ unchanged（不是 adopted）。
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'synced')
    const second = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(second.action, 'unchanged', `带溯源的那一份走正常路径：${JSON.stringify(second)}`)

    // 升版本后 ⇒ synced（同样不是 adopted）。
    writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: bundled\nx-version: 3\n---\n# BUNDLED-V3\n`)
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'synced')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('兼容路径 采纳本身 fail-loud：补写溯源失败 ⇒ refused + SKILL_ADOPT_FAILED，内容与标记都不半写', () => {
  // 故障注入走既有的 fd 写垫片（`writeFileAtomicSafeAt` 的正文写就是 fd 写）：
  // 对照组无故障 ⇒ adopted；FAULT_ON=1 ⇒ 补写溯源失败 ⇒ 拒绝且不留半个标记。
  const child = join(HERE, 'fixtures', 'child-skills-sync-adopt-fault.mjs')
  const register = join(HERE, 'fixtures', 'register-write-fault.mjs')
  const run = (fault) => {
    const result = spawnSync(
      process.execPath,
      fault ? ['--import', register, child] : [child],
      {
        env: {
          ...process.env,
          SKILLS_SYNC_MODULE: join(PKG, 'lib', 'coi', 'skills-sync.js'),
          ...(fault ? { FAULT_ON: '1', FAULT_CODE: 'ENOSPC' } : {}),
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, `child failed: ${result.stderr}`)
    // 采纳成功时被测模块会往 stdout 打一行"已采纳…"日志（落点可区分的要求），
    // 所以只取最后一行 JSON。
    const json = result.stdout.trim().split('\n').filter((line) => line.trim().startsWith('{')).pop()
    return JSON.parse(json ?? '{}')
  }

  const ok = run(false)
  assert.equal(ok.entry.action, 'adopted', `对照组（无故障）必须采纳：${JSON.stringify(ok.entry)}`)
  assert.equal(JSON.parse(String(ok.provenance)).channel, 'plugin')

  const bad = run(true)
  assert.equal(bad.entry.action, 'refused', `补写溯源失败必须如实拒绝：${JSON.stringify(bad.entry)}`)
  assert.equal(bad.entry.code, 'SKILL_ADOPT_FAILED', '必须是可区分的"采纳失败"码，而不是笼统 refused')
  assert.match(String(bad.entry.message), /channel: plugin/u, '文案要说明是"补写溯源失败"')
  assert.match(String(bad.skill), /# BUNDLED/u, '内容一字未动')
  assert.equal(bad.provenance, null, '失败时绝不留下半个溯源标记')
  assert.deepEqual(bad.destEntries, ['SKILL.md', 'scripts'], '失败时目录条目与采纳前一致（没有新增标记）')
})
