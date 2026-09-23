/**
 * tests/coi-skills-sync-dirty-baseline.test.js — 独立复审 N1（2026-09-23）的回归：
 * **随包 `plugin` 渠道技能结构性不在「用户是否改过」的判据内**。
 *
 * 缺陷（复审探针 zz-verify-plugin-dirty.spec.ts 实测）：
 *   - 同步侧写溯源时刻意不写 `archiveChecksum`（`writePluginProvenance` 的旧口径
 *     "跨包 import 禁止 ⇒ 宁缺勿错"）；
 *   - 企业侧 `isInstalledSkillDirty` 没有基准就返回 `false`（"宁可少判脏"）。
 *   两者互为因果 ⇒ 用户改了随包技能后，**开机自动同步**（无需任何用户动作）照旧
 *   整树换入，用户文件与用户改动一起消失，全程零提示；面板也不会显示「已本地修改」。
 *
 * 修复（两条都在本文件的判据里）：
 *   1. 同步侧在**每次自己写内容**之后（首次安装 / 随包升版 / 内容同一性采纳）写一份
 *      `archiveChecksum`，取值 = {@link skillContentChecksum} —— 与企业侧
 *      `computeSkillContentHash` **逐字节同源**的整树哈希（排除顶层 `.picoaide/`，
 *      含 `.install-version`）；两实现的等价性由 enterprise 的
 *      `tests/skill-channel-parity.spec.ts` 用真实 fixture 对拍（跨包 import 禁止，
 *      所以是"各自实现 + 机器对拍"而不是共享模块）。
 *   2. 整树换入之前比对基准：目标已被本地修改 ⇒ **如实拒收**（`action: 'refused'`
 *      + `code: SKILL_LOCAL_CONTENT`），一个字节都不动。未改过 ⇒ 照旧 `synced`
 *      （随包技能的主要用途不得退化）。
 *
 * 兼容边界（**认账项，不是本文件的判据**）：本修复之前落下的目录没有基准。它们
 * 在**内容与随包技能逐字相同**时会被补上基准（§legacy 用例 1）；内容已经不同、
 * 又没有基准时无法证明"是不是用户改的"，只能照旧整树换入（§legacy 用例 2，如实
 * 打日志）。该窗口只存在于"升级前装的那一份"，一次同步之后即闭合。
 *
 * ---- 变异验证（实跑见 temp/round5-2026-09-23/fix-n1-bundled-dirty.md）----
 *   ① 拆掉基准写入（`writePluginProvenance` 不写 `archiveChecksum`）⇒ §升版 用例 2、
 *      §采纳、§legacy 用例 1 红；
 *   ② 拆掉"跳过/保留"分支（换入前不比对基准）⇒ §升版 用例 2 红（用户内容被覆盖）；
 *   ③ 反向对照：未修改的随包技能升版必须照旧 `synced` ⇒ §升版 用例 1 不许红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinSkills, skillContentChecksum } from '../lib/coi/skills-sync.js'
import { normalizeSkillManifestBytes, toggleDisableFlag } from '../lib/skill-manifest.js'

const NAME = 'memory-consolidate'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-dirty-'))
}

/** 造插件源技能（`x-version` 决定"是否比已装的新"）。 */
function seedPluginSkill(pluginSkills, { xVersion, extra } = {}) {
  mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
  const lines = [`---`, `name: ${NAME}`, `description: bundled`]
  if (xVersion !== undefined) lines.push(`x-version: ${xVersion}`)
  lines.push(`---`, `# BUNDLED v${String(xVersion)}`, '')
  writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), lines.join('\n'))
  writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), `// HELPER v${String(xVersion)}\n`)
  if (extra !== undefined) writeFileSync(join(pluginSkills, NAME, extra.rel), extra.body)
}

/** 本轮同步里该技能的条目。 */
function entryFor(results) {
  return results.find((r) => r.name === NAME)
}

/** 读落点里的安装器溯源（不存在返回 null）。 */
function readProv(userSkills) {
  const file = join(userSkills, NAME, '.picoaide', 'release.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

/* ---------------------------------------- 1) 基准的建立与"未改过"的正常升版 */

test('首次安装：写下的 archiveChecksum 必须等于落点内容树的哈希（排除 .picoaide，含 .install-version）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })

    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'synced')
    const info = readProv(userSkills)
    assert.match(String(info.archiveChecksum), /^[0-9a-f]{64}$/u, '同步侧必须写一份可比的基准哈希')

    const installed = join(userSkills, NAME)
    assert.equal(
      info.archiveChecksum,
      skillContentChecksum(installed),
      '基准必须等于"落盘后"的内容树哈希（写溯源本身不得让这份内容变脏：顶层 .picoaide 被排除）',
    )
    // `.install-version` 是内容树的一部分（企业侧只排除顶层 .picoaide）⇒ 它必须在
    // 算基准之前就位，否则基准与盘上内容差一个文件 ⇒ 下一次比对恒"脏"。
    assert.equal(readFileSync(join(installed, '.install-version'), 'utf8'), '1')
    assert.equal(skillContentChecksum(installed), info.archiveChecksum, '写完 .install-version 之后基准仍须成立')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未修改的随包技能升版：照旧 synced（反向对照，不许被本修复弄红）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'synced', '没改过 ⇒ 必须照常升版')
    assert.equal(readProv(userSkills).version, '2', '版本必须推进到新的 x-version')
    assert.equal(readFileSync(join(installed, 'scripts', 'helper.mjs'), 'utf8'), '// HELPER v2\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('升版换入之后：基准跟着新内容刷新（下一次改动才判得出来）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    const before = readProv(userSkills).archiveChecksum

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const after = readProv(userSkills)
    assert.notEqual(after.archiveChecksum, before, '基准必须跟着新内容走')
    assert.equal(after.archiveChecksum, skillContentChecksum(installed), '新基准必须等于新内容的哈希')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------ 2) 用户改过的随包技能：自动同步不得覆盖 */

test('用户改过正文与文件后升版：refused + SKILL_LOCAL_CONTENT + 一个字节都不动', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    const provBefore = readFileSync(join(installed, '.picoaide', 'release.json'), 'utf8')

    // 用户改正文 + 加自己的文件。
    writeFileSync(join(installed, 'SKILL.md'), `---\nname: ${NAME}\ndescription: mine\nx-version: 1\n---\n# USER EDITED\n`)
    writeFileSync(join(installed, 'MY-NOTES.md'), '我的笔记\n')

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))

    assert.equal(entry.action, 'refused', '自动路径没有 UI ⇒ 只能如实拒收，绝不静默整树换入')
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.equal(existsSync(join(installed, 'MY-NOTES.md')), true, '用户自己的文件必须原样保留')
    assert.match(readFileSync(join(installed, 'SKILL.md'), 'utf8'), /USER EDITED/, '用户改过的正文必须原样保留')
    assert.equal(readFileSync(join(installed, 'scripts', 'helper.mjs'), 'utf8'), '// HELPER v1\n', '整树都不动')
    assert.equal(readFileSync(join(installed, '.picoaide', 'release.json'), 'utf8'), provBefore, '溯源一字不动')
    assert.equal(readFileSync(join(installed, '.install-version'), 'utf8'), '1', '版本标记也不推进（内容没换，版本就不能动）')
    assert.match(String(entry.message), /本地修改/u, '日志/面板要能看出"你改过的东西我们没动"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('拒收是终态而不是一次性的：下一次开机同步仍然拒收（用户改动一直在）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    writeFileSync(join(installed, 'MY-NOTES.md'), '我的笔记\n')

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'refused')
    const second = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(second.action, 'refused', '第二次开机同步同样拒收（不是"拒一次就忘"）')
    assert.equal(existsSync(join(installed, 'MY-NOTES.md')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只是加了一个文件、正文没改：同样判脏（条目集合变化也算改动）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    writeFileSync(join(userSkills, NAME, 'scratch.md'), 'x\n')

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).code, 'SKILL_LOCAL_CONTENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('用户把改动撤回到与随包一致：升版重新放行（判据是内容事实，不是"曾经改过"的记号）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    writeFileSync(join(installed, 'MY-NOTES.md'), '我的笔记\n')
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'refused')

    // 用户自己删掉私加的文件 ⇒ 内容回到基准 ⇒ 下一次升版照常。
    rmSync(join(installed, 'MY-NOTES.md'))
    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'synced')
    assert.equal(readFileSync(join(installed, 'scripts', 'helper.mjs'), 'utf8'), '// HELPER v2\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------- 3) 兼容路径（采纳）也要建立基准 */

test('内容同一性采纳：补写溯源时同时写基准，此后用户改动同样被拒收', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    // A9 之前落下的历史副本：内容与随包逐字相同、但完全没有溯源。
    mkdirSync(join(userSkills, NAME, 'scripts'), { recursive: true })
    writeFileSync(join(userSkills, NAME, 'SKILL.md'), readFileSync(join(pluginSkills, NAME, 'SKILL.md')))
    writeFileSync(join(userSkills, NAME, 'scripts', 'helper.mjs'), readFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs')))

    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'adopted', '同一性成立 ⇒ 采纳（补写溯源）')
    const installed = join(userSkills, NAME)
    assert.equal(readProv(userSkills).archiveChecksum, skillContentChecksum(installed), '采纳路径同样必须建立基准')

    writeFileSync(join(installed, 'MY-NOTES.md'), '我的笔记\n')
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).code, 'SKILL_LOCAL_CONTENT')
    assert.equal(existsSync(join(installed, 'MY-NOTES.md')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------------------------------------- 4) 修复前落下的旧目录 */

test('legacy 用例 1：有 plugin 溯源但缺基准、内容与随包逐字相同 ⇒ 补上基准（此后改动可判）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    // 模拟旧版本写下的溯源：有 plugin 渠道、没有 archiveChecksum。
    const prov = readProv(userSkills)
    delete prov.archiveChecksum
    writeFileSync(join(installed, '.picoaide', 'release.json'), `${JSON.stringify(prov, null, 2)}\n`)

    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'unchanged', '版本没变 ⇒ 不换入')
    assert.equal(readProv(userSkills).archiveChecksum, skillContentChecksum(installed), '内容与随包逐字一致 ⇒ 补上基准')

    writeFileSync(join(installed, 'SKILL.md'), '# USER EDITED\n')
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).code, 'SKILL_LOCAL_CONTENT', '补上基准之后，改动必须可判')
    assert.match(readFileSync(join(installed, 'SKILL.md'), 'utf8'), /USER EDITED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy 用例 2：缺基准且内容已不是随包那一份 ⇒ 不拦（无法证明）、如实打日志，换入后立即建立基准', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    const prov = readProv(userSkills)
    delete prov.archiveChecksum
    writeFileSync(join(installed, '.picoaide', 'release.json'), `${JSON.stringify(prov, null, 2)}\n`)
    writeFileSync(join(installed, 'SKILL.md'), '# SOMETHING ELSE\n') // 无基准 ⇒ 无从判定是谁写的

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'synced', '没有基准就没有证据 ⇒ 不误拦（随包升版不退化）；该窗口只存在于升级前装的那一份')
    assert.equal(readProv(userSkills).archiveChecksum, skillContentChecksum(installed), '换入后必须立即建立基准')

    writeFileSync(join(installed, 'MY-NOTES.md'), '我的笔记\n')
    seedPluginSkill(pluginSkills, { xVersion: 3 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).code, 'SKILL_LOCAL_CONTENT', '窗口自此闭合')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------ 5) N1b（复审 R5-B-4）：禁用标记 */

test('N1b：禁用（写 SKILL.md 的 disable-model-invocation）不算"本地修改" ⇒ 升版照旧 synced', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    const baseline = readProv(userSkills).archiveChecksum

    // 「技能管理」的禁用开关：与 skills-manager 共用同一份实现（skill-manifest.js）。
    const file = join(installed, 'SKILL.md')
    const next = toggleDisableFlag(readFileSync(file, 'utf8'), true)
    assert.notEqual(next, null, '夹具的 SKILL.md 必须是规范 frontmatter')
    writeFileSync(file, next)
    assert.match(readFileSync(file, 'utf8'), /^disable-model-invocation: true$/m)

    // ① 平台自己写的字段不进内容哈希：基准仍然成立（企业侧 dirty 判据吃的就是它）。
    assert.equal(skillContentChecksum(installed), baseline, '禁用开关不得让内容哈希变化（否则面板误报「已本地修改」）')

    // ② 禁用状态下升版：照旧 synced（不是 refused —— 禁用不是"用户改过内容"）。
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(entryFor(syncBuiltinSkills(pluginSkills, userSkills)).action, 'synced')
    // ③ 换入之后禁用仍然生效：标记随新内容保留（文件与插件 state 不因为一次更新而分叉）。
    assert.match(readFileSync(file, 'utf8'), /^disable-model-invocation: true$/m, '换入必须保留禁用标记')
    assert.match(readFileSync(file, 'utf8'), /# BUNDLED v2/, '内容本身必须换成新版本')
    assert.equal(skillContentChecksum(installed), readProv(userSkills).archiveChecksum, '换入后的新基准同样成立')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N1b 反向对照：用户真的改了正文 ⇒ 仍然判脏（归一化只剔除平台字段）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const installed = join(userSkills, NAME)
    const file = join(installed, 'SKILL.md')

    // 先禁用（不算改动），再改正文（算改动）。
    writeFileSync(file, toggleDisableFlag(readFileSync(file, 'utf8'), true))
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nUSER EDITED BODY\n`)

    seedPluginSkill(pluginSkills, { xVersion: 2 })
    const entry = entryFor(syncBuiltinSkills(pluginSkills, userSkills))
    assert.equal(entry.action, 'refused')
    assert.equal(entry.code, 'SKILL_LOCAL_CONTENT')
    assert.match(readFileSync(file, 'utf8'), /USER EDITED BODY/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N1b：归一化是"无字段即逐字节原样"（老基准不得被本修复打成脏）', () => {
  const dir = tempDir()
  try {
    const bytes = Buffer.from('---\nname: x\ndescription: y\n---\nBody\n')
    assert.equal(normalizeSkillManifestBytes(bytes), bytes, '没有该字段时必须返回同一个 Buffer（不做往返编解码）')
    const crlf = Buffer.from('---\r\nname: x\r\n---\r\nBody\r\n')
    assert.equal(normalizeSkillManifestBytes(crlf), crlf, 'CRLF 且无该字段同样逐字节原样')
    const nonCanonical = Buffer.from('no frontmatter at all\n')
    assert.equal(normalizeSkillManifestBytes(nonCanonical), nonCanonical)
    // 有该字段 ⇒ 剔除后再与"写之前"的文本逐字节相同（toggle 的逆运算）。
    const before = '---\nname: x\ndescription: y\n---\nBody\n'
    const after = toggleDisableFlag(before, true)
    assert.equal(normalizeSkillManifestBytes(Buffer.from(after)).toString('utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
