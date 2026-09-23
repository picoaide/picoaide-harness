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
 *        `channel` / `installedAt` / `archiveChecksum`），`version` 取 SKILL.md 的
 *        `x-version`（无则 `''`）。`archiveChecksum` 是独立复审 N1 追加的内容基准
 *        （见 `tests/coi-skills-sync-dirty-baseline.test.js` 与 enterprise
 *        `tests/skill-channel-parity.spec.ts` 的同源对拍）。
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
 *   第一版修复（A16）把它改成前导点形态 `.staging-<name>-<pid>-<ts>`，理由写的是
 *   "上游发现器看不见点号目录" —— **与 pinned 上游不符**：`discoverRoot` 遍历技能库
 *   的全部直接子目录、按 frontmatter 认技能名，还按 `localeCompare` 排序
 *   （`'.staging-x'.localeCompare('x') < 0` ⇒ 点号形态排在真目录**之前**、赢下注册表）。
 *   第四轮 R4-B-2 把它挪进**第二层**私有目录 `<skills>/.skill-tmp/`（与安装器的
 *   `.skill-tmp/install-*` 同形）：真契约是"只有直接子目录会被发现"（层数），不是
 *   目录名。变异性：把落点退回技能库根（或把 `SKILL_TEMP_DIR` 改成 '' ）→ 本文件
 *   最后一条用例红。**上游那一半**的判据不在本文件：它在
 *   `packages/host/enterprise/tests/skill-staging-invisibility.spec.ts`（真跑 pinned
 *   上游 `SkillRegistry` + `SkillFileSystem`，含"根上就是幽灵"的反向对照）。
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
 * 的**本地副本**：能力中心的 `listInstalledSkills` 用它筛目录名。
 *
 * ⚠️ **它不是上游的判据**（R4-B-2 的勘误）：`skill-filesystem` 的 `discoverRoot`
 * 只看**直接子目录里有没有 SKILL.md**、技能名取自 frontmatter，根本不过目录名正则
 * —— 所以"临时目录名不命中这条正则"**证明不了**上游看不见它。这里只保留它作为
 * "能力中心列表不会把它当已装技能"的判据；上游那一半由
 * `packages/host/enterprise/tests/skill-staging-invisibility.spec.ts` 真跑上游注册表来判。
 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/**
 * 换入临时副本（`.staging-*` / `.old-*`）在技能库里的残留路径。
 *
 * 两处都要扫（R4-B-2）：新落点是**第二层**私有目录 `.skill-tmp/`（运行时只认直接
 * 子目录），旧落点是技能库根（升级前写下的形态）。只扫根会把"残留藏在私有目录里"
 * 当成"没有残留"（假绿），返回的路径以 `.skill-tmp/` 前缀区分落点。
 * @param {string} userSkills - 技能库目录。
 * @returns {string[]} 相对技能库根的残留路径。
 */
function swapLeftovers(userSkills) {
  const root = existsSync(userSkills)
    ? readdirSync(userSkills).filter((n) => n.includes('.staging-') || n.includes('.old-'))
    : []
  const tempDir = join(userSkills, '.skill-tmp')
  const temp = existsSync(tempDir)
    ? readdirSync(tempDir).filter((n) => n.includes('.staging-') || n.includes('.old-')).map((n) => `.skill-tmp/${n}`)
    : []
  return [...root, ...temp]
}

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

test('A9 + R4-B-1 成功换入：`.picoaide/` 与 `.install-version` 不丢，且版本跟到新的 x-version', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    seedPluginInstall(userSkills)

    const results = syncBuiltinSkills(pluginSkills, userSkills)

    assert.equal(results.find((r) => r.name === NAME).action, 'synced')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BUNDLED/, '内容必须来自插件源（换入仍然生效）')
    const releasePath = join(userSkills, NAME, '.picoaide', 'release.json')
    assert.equal(existsSync(releasePath), true, '同步吃掉了安装溯源（A9）')
    const info = JSON.parse(readFileSync(releasePath, 'utf8'))
    // R4-B-1（第四轮）：整树换入新内容（x-version 2）之后，**我们自己写的**那份
    // 溯源的 version 必须跟到 2 —— 旧值 9.9.9 会被能力中心当"已装版本"显示、被
    // 技能调用遥测直接上报，界面与遥测的版本号就与内容不符。
    assert.equal(info.version, '2', '随包升版后 provenance.version 必须等于新的 x-version（R4-B-1）')
    assert.equal(info.channel, 'plugin', '渠道不变')
    assert.equal(info.appId, NAME)
    assert.equal(info.installedAt, '2026-09-01T00:00:00.000Z', '其它字段必须逐字保留（只推进 version）')
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), '2', '.install-version（遥测读的那份）必须与 provenance 同进同退')
    assert.equal(existsSync(join(userSkills, NAME, 'scripts', 'helper.mjs')), true, '整目录语义：辅助文件随技能一起更新')
    assert.deepEqual(swapLeftovers(userSkills), [], '换入后不得留下暂存/旁置目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R4-B-1 别的渠道的溯源一个字都不动（只有自己写的 plugin 那份才推进版本）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    // market 渠道的同名技能：来源闸门会拒收（SKILL_CHANNEL_CONFLICT），且**绝不**
    // 改写它的版本（否则等于替另一条渠道记了一个它没装过的版本）。
    const marketProv = seedPluginInstall(userSkills, { channel: 'market', version: '9.9.9' })

    const results = syncBuiltinSkills(pluginSkills, userSkills)

    assert.equal(results.find((r) => r.name === NAME).action, 'refused')
    assert.equal(results.find((r) => r.name === NAME).code, 'SKILL_CHANNEL_CONFLICT')
    assert.equal(readFileSync(join(userSkills, NAME, '.picoaide', 'release.json'), 'utf8'), marketProv, 'market 溯源必须逐字不变')
    assert.equal(readFileSync(join(userSkills, NAME, '.install-version'), 'utf8'), '9.9.9')
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
      ['appId', 'archiveChecksum', 'channel', 'installedAt', 'version'],
      '字段集合必须与安装器 writeProvenance 的字段一致（archiveChecksum 是独立复审 N1 追加的内容基准：'
      + '没有它，"用户是否改过这份随包技能"就无从判定，开机同步会静默整树覆盖用户改动）',
    )
    assert.match(String(info.archiveChecksum), /^[0-9a-f]{64}$/u, '基准必须是 sha256 十六进制')
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

  // 对照组：无故障 → 换入成功且溯源被保留、版本推进到新的 x-version（R4-B-1）。
  const ok = run(false)
  assert.equal(ok.entry.action, 'synced')
  assert.match(String(ok.destSkill), /NEW-SOURCE/)
  assert.match(String(ok.provenance), /"channel": "plugin"/)
  assert.match(String(ok.provenance), /"version": "2"/, '换入成功后 provenance 版本必须跟到新的 x-version（R4-B-1）')
  assert.equal(ok.installVersion, '2')

  // 故障：staging→dest 换入失败 → 回滚把旧目录改回来；此前搬进暂存目录的
  // `.picoaide/` 与 `.install-version` 必须一起搬回，**且必须还原成换入前的字节**
  // （R4-B-1：我们可能已经把它们改写成新版本号，回滚不还原就会让旧内容配上新版本号）。
  const bad = run(true)
  assert.equal(bad.entry.action, 'refused', `换入失败必须如实记 refused：${JSON.stringify(bad.entry)}`)
  assert.match(String(bad.destSkill), /OLD-INSTALLED/, '回滚后旧内容必须原封不动')
  assert.match(String(bad.provenance ?? ''), /"channel": "plugin"/, '回滚清理把安装溯源带走了（stash 之后没有搬回）')
  assert.match(String(bad.provenance ?? ''), /"version": "9\.9\.9"/, '回滚必须把 provenance 还原成换入前的版本号（否则旧内容配新版本号）')
  assert.equal(bad.installVersion, '9.9.9', '回滚必须把 .install-version 还原成换入前的字节')
  assert.deepEqual(bad.leftovers, [], '回滚成功后不得留下暂存/旁置副本')
})

/* --------------------------------- R4-B-2：临时副本在第二层私有目录（上游/面板都看不见） */

test('R4-B-2 换入临时副本落在 `.skill-tmp/` 第二层：技能库根上不出现任何临时目录', () => {
  // 用"回滚也失败"的形态让两份副本留在盘上——这是唯一能观察到**真实创建路径**
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
  for (const rel of report.leftovers) {
    // 真契约（R4-B-2）：临时副本必须在**第二层**私有目录里。上游 `discoverRoot`
    // 只遍历技能库的**直接子目录**、按 frontmatter 认技能名（不看目录名、还会把
    // 点号目录排在真目录之前）⇒ 只有"不是直接子目录"才结构上不可见。
    // 上游那一半的判据见 enterprise 的 skill-staging-invisibility.spec.ts（真跑注册表）。
    assert.ok(
      rel.startsWith('.skill-tmp/'),
      `换入临时副本必须落在第二层私有目录 .skill-tmp/（R4-B-2）：${rel}`,
    )
    const base = rel.slice('.skill-tmp/'.length)
    assert.ok(
      base.startsWith('.staging-') || base.startsWith('.old-'),
      `私有目录里的名字仍须落在本插件命名空间内（清扫/解析按它认）：${rel}`,
    )
    // 纵深防御（不再是"上游看不见"的判据，只是万一被拿到根上也不命中技能名规则）。
    assert.equal(SKILL_NAME_PATTERN.test(base), false, `名字仍命中技能名规则：${rel}`)
  }
  // 技能库根上**一个临时目录都没有**（A16 的根上形态已被 R4-B-2 取代）。
  const rootLeftovers = report.leftovers.filter((rel) => !rel.startsWith('.skill-tmp/'))
  assert.deepEqual(rootLeftovers, [], `技能库根上不得再出现临时目录（会被上游按 frontmatter 索引）：${rootLeftovers.join(', ')}`)
})

test('R4-B-2 清扫认两种落点：`.skill-tmp/` 里的新残留与根上的旧残留都要清掉', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    const deadPid = 999999
    const ancient = Date.now() - 24 * 60 * 60 * 1000
    // 新落点（当前版本写下的崩溃残留）。
    mkdirSync(join(userSkills, '.skill-tmp', `.staging-${NAME}-${deadPid}-${ancient}`), { recursive: true })
    writeFileSync(join(userSkills, '.skill-tmp', `.staging-${NAME}-${deadPid}-${ancient}`, 'SKILL.md'), `---\nname: ${NAME}\nx-version: 9\n---\n# GHOST-NEW\n`)
    mkdirSync(join(userSkills, '.skill-tmp', `.old-${NAME}-${deadPid}-${ancient}`), { recursive: true })
    // 旧落点（升级前直接躺在技能库根上的两种历史命名）。
    mkdirSync(join(userSkills, `.staging-${NAME}-${deadPid}-${ancient}`), { recursive: true })
    mkdirSync(join(userSkills, `${NAME}.staging-${deadPid}-${ancient}`), { recursive: true })
    // 安装器在同一个 `.skill-tmp` 里的暂存副本：**不许**被本插件清掉（不是我们的）。
    mkdirSync(join(userSkills, '.skill-tmp', 'install-abcdef'), { recursive: true })

    syncBuiltinSkills(pluginSkills, userSkills)

    assert.equal(existsSync(join(userSkills, '.skill-tmp', `.staging-${NAME}-${deadPid}-${ancient}`)), false, '新落点残留必须清掉')
    assert.equal(existsSync(join(userSkills, '.skill-tmp', `.old-${NAME}-${deadPid}-${ancient}`)), false, '新落点旁置副本必须清掉')
    assert.equal(existsSync(join(userSkills, `.staging-${NAME}-${deadPid}-${ancient}`)), false, '根上 A16 形态残留必须清掉')
    assert.equal(existsSync(join(userSkills, `${NAME}.staging-${deadPid}-${ancient}`)), false, '根上旧命名残留必须清掉')
    assert.equal(existsSync(join(userSkills, '.skill-tmp', 'install-abcdef')), true, '安装器的 install-* 不归本插件清')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------- R4-B-4：用户卸载的持久终态（墓碑） */

/** 写墓碑的夹具（形状与 enterprise `writeSkillTombstone` 一致）。 */
function seedTombstone(userSkills, { channel = 'plugin', appId = NAME } = {}) {
  mkdirSync(join(userSkills, '.skill-removed'), { recursive: true })
  writeFileSync(
    join(userSkills, '.skill-removed', `${NAME}.json`),
    `${JSON.stringify({ appId, channel, removedAt: '2026-09-23T00:00:00.000Z' }, null, 2)}\n`,
  )
}

test('R4-B-4 用户卸载过的随包技能：墓碑在 ⇒ 开机同步不装回来（卸载是持久终态）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    // 首次安装（正常路径）。
    assert.equal(syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === NAME).action, 'synced')
    assert.equal(existsSync(join(userSkills, NAME)), true)
    // 用户在能力中心点了「卸载」：目录没了 + 墓碑落下（enterprise 的 uninstallSkill）。
    rmSync(join(userSkills, NAME), { recursive: true, force: true })
    seedTombstone(userSkills)

    const second = syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === NAME)
    assert.equal(second.action, 'skipped', `有墓碑时必须如实报 skipped（不落盘）：${JSON.stringify(second)}`)
    assert.equal(second.code, 'SKILL_USER_REMOVED')
    assert.equal(existsSync(join(userSkills, NAME)), false, '卸载过的随包技能不得在下一次开机同步被装回（R4-B-4）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R4-B-4 反向对照：没有墓碑时既有路径一字不改（首次安装照样落盘）', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    assert.equal(syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === NAME).action, 'synced')
    assert.equal(existsSync(join(userSkills, NAME, 'SKILL.md')), true)
    // 墓碑目录存在但**没有这一条**（别的技能卸载过）：不影响本技能。
    mkdirSync(join(userSkills, '.skill-removed'), { recursive: true })
    writeFileSync(join(userSkills, '.skill-removed', 'some-other-skill.json'), '{}\n')
    // 随包升版：没有墓碑的技能照常更新。
    seedPluginSkill(pluginSkills, { xVersion: 2 })
    assert.equal(syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === NAME).action, 'synced')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /BUNDLED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R4-B-4 墓碑判据从严：坏 JSON / appId 不符 / 别的渠道一律按"没有墓碑"处理', () => {
  const dir = tempDir()
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    seedPluginSkill(pluginSkills, { xVersion: 1 })
    // 坏 JSON：读不出用户意图 ⇒ 回到升级前的行为（装回去），而不是永久停掉同步。
    const broken = join(dir, 'skills-broken')
    mkdirSync(join(broken, '.skill-removed'), { recursive: true })
    writeFileSync(join(broken, '.skill-removed', `${NAME}.json`), '{ not json')
    assert.equal(syncBuiltinSkills(pluginSkills, broken).find((r) => r.name === NAME).action, 'synced')
    // appId 不符 / 渠道不是 plugin：同样不算墓碑。
    for (const [label, opts] of [['appId 不符', { appId: 'someone-else' }], ['渠道不是 plugin', { channel: 'market' }]]) {
      const target = join(dir, `skills-${opts.channel ?? 'x'}`)
      mkdirSync(join(target, '.skill-removed'), { recursive: true })
      writeFileSync(join(target, '.skill-removed', `${NAME}.json`), `${JSON.stringify({ appId: NAME, channel: 'plugin', ...opts })}\n`)
      assert.equal(
        syncBuiltinSkills(pluginSkills, target).find((r) => r.name === NAME).action,
        'synced',
        `${label} 的墓碑不该生效`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
