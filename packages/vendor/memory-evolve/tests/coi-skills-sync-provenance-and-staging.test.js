/**
 * tests/coi-skills-sync-provenance-and-staging.test.js — 独立审计 2026-09-23
 * `A-skill-management.md` 的 A9 / A16 回归。
 *
 * A9（P2）随包插件开机同步**吃掉安装溯源**：`syncBuiltinSkills` 的整目录换入把
 *   目标目录里的 `.picoaide/release.json`（来源徽章 + 「是否被本地修改」判据）与
 *   `.install-version`（遥测读的已装版本）连同旧目录一起丢掉，且**同步自己不写
 *   provenance** ⇒ 同步之后该技能在能力中心退回"用户自制"（用户点一次"卸载"还能
 *   把它删掉，下次开机再装回来）。修复：
 *     1. 换入时把旧目录的 `.picoaide/` 与 `.install-version` **搬进新内容**，
 *        随同一次原子 rename 回到位（失败回滚时必须搬回，见第三条用例）；
 *     2. 目标没有 provenance 时补一份本插件自己的：`channel: 'plugin'`，
 *        字段与客户端安装器 `writeProvenance` 一致（`appId` / `version` /
 *        `channel` / `installedAt`），`version` 取 SKILL.md 的 `x-version`（无则 `''`）。
 *  变异性：把 `stashInstallerMarkers` / `writePluginProvenance` 调用去掉（或只在换入
 *   **后**写 provenance）→ 前两条用例红（目标 provenance 消失 / 新装目录没有
 *  `channel: 'plugin'`）；把回滚里的 `restoreInstallerMarkers` 去掉 → 第三条红。
 *
 *  ⚠️ 前置条件（P1-1 来源闸门，2026-09-23 W4）：整树换入只对**渠道就是 plugin**
 *   的目标生效（缺溯源 / 别的商店渠道一律拒收，见
 *   `tests/coi-skills-sync-source-gate.test.js`）——所以本文件的"已装副本"夹具
 *   必须是 plugin 溯源，否则测的就不是换入路径了。
 *
 * A16（P3）换入临时目录名会被当成"一个独立技能"：旧命名
 *   `<name>.staging-<pid>-<ts>` 命中客户端 `SKILL_NAME_PATTERN`
 *   （`^[a-z0-9][a-z0-9._-]{0,63}$`）且内部有完整 SKILL.md ⇒ SIGKILL 窗口期内
 *   `listInstalledSkills` 报它"已安装"、上游发现器也会加载它（同名重复候选）。
 *   修复：一律改以点开头（`.staging-<name>-<pid>-<ts>` / `.old-…`），解析与清扫
 *   同步更新，旧命名的残留仍能清掉。
 *  变异性：把 `STAGING_INFIX`/命名退回 `<name>.staging-…` → 第四条用例红
 *   （真实产生的临时目录名命中技能名规则）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinSkills } from '../lib/coi/skills-sync.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SKILLS_SYNC_MODULE = join(PKG, 'lib', 'coi', 'skills-sync.js')
const CHILD_MARKERS = join(HERE, 'fixtures', 'child-skills-sync-markers.mjs')
const CHILD_SWAP_FAULT = join(HERE, 'fixtures', 'child-skills-sync-fault.mjs')
const REGISTER_SWAP = join(HERE, 'fixtures', 'register-swap-fault.mjs')

/**
 * 客户端 `SKILL_NAME_PATTERN`（`packages/host/enterprise/src/skill-install.ts`）
 * 的**本地副本**：能力中心的 `listInstalledSkills` 用它筛目录名，而上游发现器的
 * 目录名契约同样是"首字符 [a-z0-9]"。跨包 import 禁止，所以这里复制这条判据
 * （它同时也是 A16 的验收口径，改动它会同时红）。
 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-builtin-provenance-'))
}

const NAME = 'memory-consolidate'

/** 造一份插件源技能（可选带 x-version）。 */
function seedPluginSkill(pluginSkills, { xVersion } = {}) {
  mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
  const front = xVersion === undefined
    ? `---\nname: ${NAME}\ndescription: bundled\n---\n`
    : `---\nname: ${NAME}\ndescription: bundled\nx-version: ${xVersion}\n---\n`
  writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `${front}# BUNDLED\n`)
  writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER\n')
}

/** 造一份"本插件先前同步落下的"已装副本（版本 1 < 源，触发整目录换入）。
 *
 * 渠道必须是 `plugin`：P1-1 的来源闸门只允许整树换入"本插件自己的内容"
 * （见 tests/coi-skills-sync-source-gate.test.js），`market` 那一份会被拒收。 */
function seedPluginInstall(userSkills, { channel = 'plugin', version = '9.9.9' } = {}) {
  mkdirSync(join(userSkills, NAME, '.picoaide'), { recursive: true })
  writeFileSync(join(userSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: installed\nx-version: 1\n---\n# OLD-INSTALLED\n`)
  writeFileSync(
    join(userSkills, NAME, '.picoaide', 'release.json'),
    `${JSON.stringify({ appId: NAME, version, channel, installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
  )
  writeFileSync(join(userSkills, NAME, '.install-version'), version)
  return readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8')
}

/* ------------------------------------------------- A9：保留安装溯源（同步成功） */

test('A9 成功换入：目标目录的 `.picoaide/` 与 `.install-version` 逐字保留，SKILL.md 换成新内容', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    const provenanceBefore = seedPluginInstall(userSkills)
    const installVersionBefore = readFileSync(join(userSkills, NAME, '.install-version'), 'utf8')

    const results = syncBuiltinSkills(pluginSkills, userSkills)

    assert.equal(results.find((r) => r.name === NAME).action, 'synced')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BUNDLED/, '内容必须来自插件源（换入仍然生效）')
    assert.equal(existsSync(join(userSkills, NAME, '.picoaide', 'release.json')), true, '同步吃掉了安装溯源（A9）')
    assert.equal(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'), provenanceBefore, 'plugin provenance 必须逐字不变')
    assert.equal(existsSync(join(userSkills, NAME, '.install-version')), true, '同步吃掉了 .install-version（A9）')
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), installVersionBefore)
    assert.equal(existsSync(join(userSkills, NAME, 'scripts', 'helper.mjs')), true, '整目录语义：辅助文件随技能一起更新')
    assert.deepEqual(
      readdirSync(userSkills).filter((n) => n.includes('.staging-') || n.includes('.old-')),
      [],
      '换入后不得留下暂存/旁置目录',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A9 补齐 provenance：全新落盘写 `channel: "plugin"`，version 取 x-version，字段与安装器一致', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 3 })

    const results = syncBuiltinSkills(pluginSkills, userSkills)
    assert.equal(results.find((r) => r.name === NAME).action, 'synced')

    const releasePath = join(userSkills, NAME, '.picoaide', 'release.json')
    assert.equal(existsSync(releasePath), true, '同步必须写自己的 provenance（否则能力中心把它当"用户自制"）')
    const info = JSON.parse(readFileSync(releasePath, 'utf8'))
    assert.deepEqual(
      Object.keys(info).sort(),
      ['appId', 'channel', 'installedAt', 'version'],
      '字段集合必须与安装器 writeProvenance 的四个必备字段一致（archiveChecksum 刻意不写：跨包无法共享同一份哈希实现）',
    )
    assert.equal(info.appId, NAME)
    assert.equal(info.channel, 'plugin', '渠道取值必须是扩展后的 plugin')
    assert.equal(info.version, '3', 'version 必须取 SKILL.md 的 x-version')
    assert.ok(!Number.isNaN(Date.parse(info.installedAt)), `installedAt 必须是可解析的 ISO 时间：${info.installedAt}`)
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), '3', '补齐 .install-version 供遥测读取')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A9 无 x-version：version 写空串，且不写 .install-version（与安装器同口径）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, {})

    syncBuiltinSkills(pluginSkills, userSkills)

    const info = JSON.parse(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'))
    assert.equal(info.version, '')
    assert.equal(info.channel, 'plugin')
    assert.equal(existsSync(join(userSkills, NAME, '.install-version')), false, '版本未知时不写 .install-version')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A9 幂等：第二次同步（版本相同 → unchanged）不得改写已写的 provenance', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    syncBuiltinSkills(pluginSkills, userSkills)
    const releasePath = join(userSkills, NAME, '.picoaide', 'release.json')
    const before = readFileSync(releasePath, 'utf8')

    const second = syncBuiltinSkills(pluginSkills, userSkills)
    assert.equal(second.find((r) => r.name === NAME).action, 'unchanged')
    assert.equal(readFileSync(releasePath, 'utf8'), before, 'unchanged 分支不得重写/刷新 provenance')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------- A9：失败回滚时安装标记必须搬回 */

test('A9 换入失败回滚：搬进暂存目录的安装器标记必须搬回目标目录（清理不得带走溯源）', () => {
  const run = (fault) => {
    const result = spawnSync(
      process.execPath,
      fault ? ['--import', REGISTER_SWAP, CHILD_MARKERS] : [CHILD_MARKERS],
      {
        env: {
          ...process.env,
          SKILLS_SYNC_MODULE,
          ...(fault ? { SWAP_FAULT_CODE: 'EPERM' } : {}),
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, `child failed: ${result.stderr}`)
    return JSON.parse(result.stdout.trim())
  }

  // 对照组：无故障 → 换入成功且溯源被保留（与上面第一条用例同一形态，这里用子进程）。
  const ok = run(false)
  assert.equal(ok.entry.action, 'synced')
  assert.match(String(ok.destSkill), /NEW-SOURCE/)
  assert.match(String(ok.provenance), /"channel": "plugin"/)
  assert.equal(ok.installVersion, '9.9.9')

  // 故障：staging→dest 换入失败 → 回滚把旧目录改回来；此前搬进暂存目录的
  // `.picoaide/` 与 `.install-version` 必须一起搬回，否则技能目录复原了但溯源没了。
  const bad = run(true)
  assert.equal(bad.entry.action, 'refused', `换入失败必须如实记 refused：${JSON.stringify(bad.entry)}`)
  assert.match(String(bad.destSkill), /OLD-INSTALLED/, '回滚后旧内容必须原封不动')
  assert.match(String(bad.provenance ?? ''), /"channel": "plugin"/, '回滚清理把安装溯源带走了（stash 之后没有搬回）')
  assert.equal(bad.installVersion, '9.9.9', '回滚清理把 .install-version 带走了')
  assert.deepEqual(bad.leftovers, [], '回滚成功后不得留下暂存/旁置副本')
})

/* --------------------------------------------------- A16：临时目录不再伪装成技能 */

test('A16 换入临时目录以点开头：真实产生的名字不命中技能名规则（能力中心/上游都看不见）', () => {
  // 用"回滚也失败"的形态让两份副本留在盘上——这是唯一能观察到**真实创建名字**
  // 的窗口（正常路径与回滚路径都会把它们删掉）。子进程夹具把 leftovers 报出来。
  const result = spawnSync(process.execPath, ['--import', REGISTER_SWAP, CHILD_SWAP_FAULT], {
    env: {
      ...process.env,
      SKILLS_SYNC_MODULE,
      SWAP_FAULT_CODE: 'EPERM',
      SWAP_FAIL_RESTORE: '1',
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `child failed: ${result.stderr}`)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.entry.code, 'SKILL_SWAP_RECOVERY_FAILED', `前置条件不成立：${JSON.stringify(report.entry)}`)
  assert.equal(report.leftovers.length, 2, `必须留下暂存与旁置两份副本：${JSON.stringify(report.leftovers)}`)
  for (const name of report.leftovers) {
    assert.ok(
      name.startsWith('.staging-') || name.startsWith('.old-'),
      `换入临时目录必须以点开头（A16）：${name}`,
    )
    assert.equal(
      SKILL_NAME_PATTERN.test(name),
      false,
      `换入临时目录仍命中技能名规则 ⇒ 窗口期内会被 listInstalledSkills 报成"已安装技能"、被上游发现器加载：${name}`,
    )
  }
})
