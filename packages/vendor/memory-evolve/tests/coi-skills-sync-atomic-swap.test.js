/**
 * S13-3（2026-09-17 审计，P3）：内置技能整目录同步原先**先删目标目录再逐文件写**
 * （lib/coi/skills-sync.js 的 `rmSync(destDir)` 在写循环之前），循环里任何一次
 * 写失败都会把用户已装好的技能删空或写一半，而调用方只记 `refused`、继续同步
 * 其余技能——与本函数"任一文件被拒即抛错…（不静默半写）"的承诺相反，也相对
 * v2.7.4 的单文件原子写（失败保留旧文件）是回归。
 *
 * 复现方式：在**子进程**里用 loader hook 把 `node:fs` 换成"第 N 次 fd 写失败"的
 * 垫片（生产路径按 fd 写正文，夹具/初始化按路径写，见 fixtures 里的说明），N=1
 * 覆盖"第一个文件就失败"、N=2 覆盖"写到一半失败"。两条都断言用户原有目录原封
 * 不动：旧 SKILL.md 逐字保留、用户自加文件仍在、暂存目录不残留。
 *
 * 变异性（为何这些断言真的钉住修复）：把 rm-before-write 放回去 → 两条用例都红
 * （dest 目录先被清空）；只把暂存目录换入去掉 → 第二条用例红。
 *
 * S13-3 复核（2026-09-17）追加两条换入窗口的用例（同一子进程夹具、另一支
 * `renameSync` 垫片，只打在换入/回滚两次 rename 上）：
 *   - 换入 rename 失败 → 旧目录必须**先被改回来**（原封不动 + refused + 无残留）；
 *   - 换入失败且回滚也失败 → 不再含糊 refused，而是点名新旧两份副本的
 *     SKILL_SWAP_RECOVERY_FAILED（技能目录暂时缺失，但内容都在盘上可人工恢复）。
 * 外加一条不经过子进程的清扫用例：上次崩溃留下的 `<name>.staging-<pid>-<ts>`
 * 在下次同步开头被清掉，而"活 pid + 新时间戳"（并发同步）与用户自己的目录不动。
 * 三轮复核（2026-09-17）再补一条：崩溃在 `.old-*` 改名之后（真目录缺失、旁置副本
 * 是旧内容唯一副本）时，开头的清扫必须留下它，而同步把真目录装回来的**同一次**
 * 收尾清扫要立刻收掉它（不留一整个会话的幽灵技能候选）。
 *
 * A16（2026-09-23 独立审计）：换入临时目录改成**以点开头**的
 * `.staging-<name>-<pid>-<ts>` / `.old-<name>-<pid>-<ts>`（旧形态
 * `<name>.staging-…` 命中客户端 `SKILL_NAME_PATTERN`，SIGKILL 窗口期内会被
 * 能力中心报成"一个已安装技能"、被上游发现器当重复候选）。本文件的目录名夹具、
 * 恢复错误文案断言与清扫用例都按新命名重写，另加一条"旧命名残留仍要能清掉"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { syncBuiltinSkills } from '../lib/coi/skills-sync.js'

const here = dirname(fileURLToPath(import.meta.url))
const register = join(here, 'fixtures', 'register-write-fault.mjs')
const registerSwap = join(here, 'fixtures', 'register-swap-fault.mjs')
const child = join(here, 'fixtures', 'child-skills-sync-fault.mjs')
const skillsSyncModule = join(here, '..', 'lib', 'coi', 'skills-sync.js')

/** 跑一次子进程；fault=null → 不打补丁（对照组）。 */
function runSync(fault) {
  const args = fault === null
    ? [child]
    : ['--import', fault.register ?? register, child]
  const result = spawnSync(process.execPath, args, {
    env: {
      ...process.env,
      SKILLS_SYNC_MODULE: skillsSyncModule,
      ...(fault === null ? {} : { FAULT_CODE: fault.code, FAULT_ON: String(fault.on) }),
      ...(fault?.swap === undefined ? {} : { SWAP_FAULT_CODE: fault.swap }),
      ...(fault?.failRestore === undefined ? {} : { SWAP_FAIL_RESTORE: fault.failRestore ? '1' : '0' }),
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `child failed: ${result.stderr}`)
  return JSON.parse(result.stdout.trim())
}

test('S13-3 对照组：无故障时整目录照旧覆盖（上游语义不变、暂存目录不残留）', () => {
  const r = runSync(null)
  assert.equal(r.entry.action, 'synced')
  assert.match(String(r.destSkill), /NEW-SOURCE/, '新正文必须落地')
  assert.equal(r.destHelper, true, '辅助文件必须随整目录一起更新')
  assert.equal(r.notesIntact, false, '整目录覆盖语义：用户自加文件被替换（与上游一致）')
  assert.deepEqual(r.stagingLeftovers, [], '换入后不得留下暂存目录')
})

for (const [on, errno] of [[1, 'ENOSPC'], [2, 'EACCES']]) {
  test(`S13-3 第 ${on} 次落盘失败（${errno}）：refused 且用户已装技能原封不动`, () => {
    const r = runSync({ on, code: errno })
    assert.equal(r.entry.action, 'refused', `写入失败必须如实记 refused：${JSON.stringify(r.entry)}`)
    assert.equal(r.destExists, true, '失败不得把技能目录整个删掉')
    assert.match(String(r.destSkill), /OLD-INSTALLED/, '已装 SKILL.md 必须逐字保留（不被删空/半写覆盖）')
    assert.equal(r.destHelper, false, '新辅助文件不应出现（半写形态）')
    assert.equal(r.notesIntact, true, '用户自加文件必须保留')
    assert.deepEqual(r.stagingLeftovers, [], '失败路径必须清掉暂存目录，不在技能库里留垃圾')
  })
}

test('S13-3 复核 换入 rename 失败：旧目录被改回原处（原封不动 + 无残留）', () => {
  const r = runSync({ swap: 'EPERM', register: registerSwap })
  assert.equal(r.entry.action, 'refused', `换入失败必须如实记 refused：${JSON.stringify(r.entry)}`)
  assert.doesNotMatch(String(r.entry.message), /SKILL_SWAP_RECOVERY_FAILED|人工恢复/, '回滚成功时不得报成"需要人工恢复"')
  assert.equal(r.destExists, true, '换入失败后旧目录必须先被改回来，技能不能消失')
  assert.match(String(r.destSkill), /OLD-INSTALLED/, '旧 SKILL.md 必须逐字保留')
  assert.equal(r.notesIntact, true, '用户自加文件必须保留')
  assert.deepEqual(r.leftovers, [], '回滚成功后暂存/旁置副本都必须清干净')
})

test('S13-3 复核 换入失败且回滚也失败：报可恢复错误、新旧两份副本都还在盘上', () => {
  const r = runSync({ swap: 'EPERM', failRestore: true, register: registerSwap })
  assert.equal(r.entry.action, 'refused', '仍然记 refused（同步本身失败）')
  assert.equal(r.entry.code, 'SKILL_SWAP_RECOVERY_FAILED', '但必须带上可区分的恢复错误码，而不是含糊的 refused')
  assert.match(String(r.entry.message), /需人工恢复/, '错误文本必须说明需要人工恢复')
  // A16（2026-09-23）：换入临时目录改成**以点开头**的 `.old-<name>-<pid>-<ts>` /
  // `.staging-<name>-<pid>-<ts>`（旧形态前面没有点和技能名，会被能力中心当成
  // 一个"已安装技能"）。两个正则都要求前导点，旧命名在这里就会红。
  assert.match(String(r.entry.message), /[\\/]\.old-[a-z0-9-]+-\d+-\d+/, '必须点名旧内容副本路径')
  assert.match(String(r.entry.message), /[\\/]\.staging-[a-z0-9-]+-\d+-\d+/, '必须点名新内容副本路径')
  assert.equal(r.destExists, false, '这一态的形态就是"技能目录暂时缺失"（内容在盘上，可人工恢复）')
  assert.equal(r.leftovers.length, 2, `暂存与旁置两份副本都必须保留：${JSON.stringify(r.leftovers)}`)
  const skills = Object.values(r.leftoverSkills).map(String)
  assert.ok(skills.some((text) => text.includes('OLD-INSTALLED')), '旧内容副本必须还在（可恢复）')
  assert.ok(skills.some((text) => text.includes('NEW-SOURCE')), '新内容副本必须还在（内容不丢）')
})

test('S13-3 复核 崩溃残留：下次同步开头清扫陈旧暂存目录，但不碰并发同步与用户目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-sync-sweep-'))
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    const NAME = 'kimi-cli-calling'
    // A16（2026-09-23）：新命名 = 前导点 + 技能名（`.staging-<name>-<pid>-<ts>`）。
    const swapName = (infix, pid, ts) => `${infix}${NAME}-${pid}-${ts}`
    // 源存在（同步照常跑）；用户技能库只有"残留"（真目录缺失 → 本次会装上）
    mkdirSync(join(pluginSkills, NAME), { recursive: true })
    writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\nx-version: 2\n---\n# NEW-SOURCE\n`)
    mkdirSync(userSkills, { recursive: true })
    const deadPid = 2147483647 // 不存在的 pid（SIGKILL 后进程已消失的形态）
    const ancient = 1000 // 1970 年的时间戳：pid 复用兜底
    // 1) 崩溃残留（死 pid，含带真实 frontmatter name 的 SKILL.md = 幽灵技能）
    mkdirSync(join(userSkills, swapName('.staging-', deadPid, ancient)))
    writeFileSync(join(userSkills, swapName('.staging-', deadPid, ancient), 'SKILL.md'), `---\nname: ${NAME}\nx-version: 2\n---\n# GHOST\n`)
    // 2) pid 复用：进程活着但目录早已陈旧
    mkdirSync(join(userSkills, swapName('.staging-', process.pid, ancient)))
    // 3) 正在跑的并发同步（活 pid + 新时间戳）→ 不得清扫。
    //    时间戳刻意 +1s：同步自己的暂存目录命名就是 `${infix}${name}-${pid}-${Date.now()}`，用"此刻"
    //    会和它在同一毫秒内撞名，随后 staging→dest 的 rename 会把这个夹具目录整个搬走
    //    （2026-09-17 三轮复核复现：紧邻调用时 354/400 次）。+1s 不影响语义：
    //    「活 pid + 新时间戳的并发同步目录不得清理」。
    const live = swapName('.staging-', process.pid, Date.now() + 1000)
    mkdirSync(join(userSkills, live))
    // 4) 不属于本插件命名空间的目录（技能名不在内置清单）→ 不得清扫
    const foreign = swapName('.staging-', deadPid, ancient).replace(NAME, 'some-other-skill')
    mkdirSync(join(userSkills, foreign))
    // 5) 升级前留下的**旧命名**残留（无前导点）→ 仍必须被清掉（否则永久占位）
    const legacy = `${NAME}.staging-${deadPid}-${ancient}`
    mkdirSync(join(userSkills, legacy))
    writeFileSync(join(userSkills, legacy, 'SKILL.md'), `---\nname: ${NAME}\nx-version: 2\n---\n# LEGACY-GHOST\n`)

    const results = syncBuiltinSkills(pluginSkills, userSkills)

    assert.equal(results.find((r) => r.name === NAME).action, 'synced', '正常同步不受清扫影响')
    assert.equal(existsSync(join(userSkills, swapName('.staging-', deadPid, ancient))), false, '崩溃残留必须被清扫')
    assert.equal(existsSync(join(userSkills, swapName('.staging-', process.pid, ancient))), false, '超龄残留按陈旧清扫（pid 复用兜底）')
    assert.equal(existsSync(join(userSkills, live)), true, '活 pid + 新时间戳 = 并发同步，绝不能清扫')
    assert.equal(existsSync(join(userSkills, foreign)), true, '只在本插件自己的命名空间内清扫')
    assert.equal(existsSync(join(userSkills, legacy)), false, '升级前的旧命名残留仍要能清掉（A16）')
    assert.deepEqual(readdirSync(userSkills).filter((n) => n.startsWith(`.staging-${NAME}-`)), [live], '本插件命名空间内只剩并发同步那一个')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S13-3 三轮复核：真目录缺失时留下的 .old-* 在本次同步装回后立即回收（不留一整个会话的幽灵技能）', () => {
  // SIGKILL 落在「dest → .old-* 改名完成、staging → dest 尚未执行」之间的形态：
  // 真目录缺失、.old-* 是旧内容唯一副本、.staging-* 是新内容副本。
  // 开头的清扫必须在真目录缺失时保留 .old-*（不可误删唯一副本）；但同步把真目录
  // 装回来之后，收尾那一遍清扫必须立刻收掉它 —— 否则它会被 DSH 技能发现按
  // frontmatter name 记成重复候选，白挂一个会话（2026-09-17 三轮对抗复核）。
  const dir = mkdtempSync(join(tmpdir(), 'skills-sync-old-sweep-'))
  try {
    const pluginSkills = join(dir, 'plugin-skills')
    const userSkills = join(dir, 'skills')
    const NAME = 'kimi-cli-calling'
    mkdirSync(join(pluginSkills, NAME), { recursive: true })
    writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\nx-version: 2\n---\n# NEW-SOURCE\n`)
    mkdirSync(userSkills, { recursive: true })
    const deadPid = 2147483647
    const ancient = 1000
    // A16：新命名（前导点 + 技能名）
    const aside = `.old-${NAME}-${deadPid}-${ancient}`
    const staging = `.staging-${NAME}-${deadPid}-${ancient}`
    mkdirSync(join(userSkills, aside))
    writeFileSync(join(userSkills, aside, 'SKILL.md'), `---\nname: ${NAME}\nx-version: 1\n---\n# OLD-INSTALLED\n`)
    mkdirSync(join(userSkills, staging))
    writeFileSync(join(userSkills, staging, 'SKILL.md'), `---\nname: ${NAME}\nx-version: 2\n---\n# NEW-SOURCE\n`)

    const results = syncBuiltinSkills(pluginSkills, userSkills)

    assert.equal(results.find((r) => r.name === NAME).action, 'synced', '本次同步必须把真目录装回来')
    assert.match(readFileSync(join(userSkills, NAME, 'SKILL.md'), 'utf8'), /NEW-SOURCE/, '真目录内容来自插件源')
    assert.equal(existsSync(join(userSkills, aside)), false, '真目录回来后，旁置副本必须在同一次同步内回收（否则幽灵技能挂一个会话）')
    assert.equal(existsSync(join(userSkills, staging)), false, '暂存副本同样不留')
    assert.deepEqual(
      readdirSync(userSkills).filter((n) => n.startsWith('.staging-') || n.startsWith('.old-')),
      [],
      '技能库里不得再留本插件的换入残留',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
