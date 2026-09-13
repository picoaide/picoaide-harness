/**
 * tests/state-file-symlink-landing-policy.test.js — NF-3 收敛（R7 复核 F6-F8 §2）。
 *
 * 症状（第一轮 FIX-27 收紧过头）：`writeFileAtomicSafeAt` 把「状态文件**本身**
 * 是符号链接」一律判成故障 —— 而 stow/chezmoi 一类「把单个文件软链到位」的
 * 合法布局正是这个形态；`NotificationStore.add` 还会把它升级成**未处理的
 * Promise 拒绝**（`await webStore.add(...)` 的调用方只看 `added.ok`）。
 *
 * 判据与危害同构（本文件钉住的三条）：
 *   1) 写的是链接指向的那个**已存在的普通文件** → 放行（保留链接、写真实目标）；
 *   2) 悬空链接 / 目录目标 / 父链越界 = 「能写到仓外或写到新位置」→ 仍 fail-loud；
 *   3) **技能内容**不是状态文件（见 coi-skill-landing-unasserted-write.test.js）：
 *      预置链接一律拒收；`lib/sync/filesets.js` 的 me-1/me-2 防护（预置
 *      `<file>.tmp.<pid>` 同名链接）与仓库内写回（`writeFileAtomicSafe`）不变。
 *
 * 「改前失败」证据：改前（`git stash` 前的 FIX-27 版本）本条 1) 的四个存储
 * 全部 `throws writeTargetRefusedError`，NotificationStore 另产生
 * `unhandledRejection`；复核探针 `rv-probes/f8-mesymlink-falsepositive.mjs` 的
 * 原始输出见报告。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AliasStore } from '../lib/aliases.js'
import { NotificationStore } from '../lib/notify-web.js'
import { TaskStore } from '../lib/coi/tasks-store.js'
import { writeState } from '../lib/update.js'
import { writeFileAtomicSafe } from '../lib/sync/filesets.js'

const OUTSIDE_TEXT = 'ORIGINAL-OUTSIDE-CONTENT\n'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-state-symlink-'))
}

/** `<dir>/<name>` 是符号链接 → `<realDir>/<name>`（已存在的普通文件）。 */
function linkLanding(dir, realDir, name, seed) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, name), seed)
  symlinkSync(join(realDir, name), join(dir, name))
}

test('a state file that is a symlink to an existing file is written through, link preserved', () => {
  const root = tempDir()
  try {
    // 1) AliasStore（<memoryDir>/aliases.json -> 另一目录的真实文件）
    const aliasDir = join(root, 'aliases')
    const aliasReal = join(root, 'aliases-real')
    linkLanding(aliasDir, aliasReal, 'aliases.json', '{}\n')
    const alias = new AliasStore(aliasDir).set('session-1', '别名')
    assert.equal(alias.ok, true, `别名落盘被误判为故障：${alias.message}`)
    assert.match(readFileSync(join(aliasReal, 'aliases.json'), 'utf8'), /别名/, '没有写到符号链接指向的真实文件')
    assert.equal(lstatSync(join(aliasDir, 'aliases.json')).isSymbolicLink(), true, '合法布局的符号链接被 rename 顶掉了')

    // 2) coi TaskStore（tasks.json -> 同目录/另一目录的真实文件）
    const coiDir = join(root, 'coi')
    const coiReal = join(root, 'coi-real')
    linkLanding(coiDir, coiReal, 'tasks.json', '[]\n')
    const task = new TaskStore(coiDir, {}).add({ adapterId: 'kimi', prompt: 'hi', scope: 'project' })
    assert.ok(task?.id, 'TaskStore 未返回任务 id（落盘被误判为故障）')
    assert.match(readFileSync(join(coiReal, 'tasks.json'), 'utf8'), /kimi/)
    assert.equal(lstatSync(join(coiDir, 'tasks.json')).isSymbolicLink(), true)

    // 3) update.writeState（插件更新检测状态文件：gitdir / fallback 目录，不在同步仓库内）
    const stateDir = join(root, 'state')
    const stateReal = join(root, 'state-real')
    linkLanding(stateDir, stateReal, 'runtime.json', '{"advisorMaxMessages":20}\n')
    writeState(join(stateDir, 'runtime.json'), { advisorMaxMessages: 30 })
    assert.equal(JSON.parse(readFileSync(join(stateReal, 'runtime.json'), 'utf8')).advisorMaxMessages, 30)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dangling symlink at the landing spot is refused: no file is created outside', () => {
  const root = tempDir()
  try {
    const dir = join(root, 'aliases')
    mkdirSync(dir, { recursive: true })
    const missing = join(root, 'not-there', 'aliases.json')
    symlinkSync(missing, join(dir, 'aliases.json'))

    const result = new AliasStore(dir).set('session-1', '别名')
    assert.equal(result.ok, false, '悬空链接（= 在调用方意图之外创建文件）必须拒收')
    assert.equal(existsSync(missing), false, '在链接目标位置创建了文件')
    assert.equal(lstatSync(join(dir, 'aliases.json')).isSymbolicLink(), true, '拒收不得删除/改写预置链接本身')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NotificationStore.add reports a refused landing spot instead of rejecting', async () => {
  const root = tempDir()
  try {
    const base = join(root, 'notify')
    const dir = join(base, 'notifications')
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(root, 'missing', 'notifications.json'), join(dir, 'notifications.json'))

    const unhandled = []
    const onUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      const added = await new NotificationStore(base).add({ sender: 's', semantic: 'notify', subject: 'x', content: 'y' })
      assert.equal(added.ok, false, '落盘被拒却报成功')
      assert.ok(added.message, '失败原因必须可读')
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.deepEqual(unhandled, [], '落点拒绝穿透成未处理的 Promise 拒绝')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('me-1/me-2 protection intact: a pre-placed <file>.tmp.<pid> symlink is still refused', () => {
  const root = tempDir()
  try {
    const dir = join(root, 'aliases')
    mkdirSync(dir, { recursive: true })
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, OUTSIDE_TEXT)
    symlinkSync(victim, join(dir, `aliases.json.tmp.${process.pid}`))

    const result = new AliasStore(dir).set('session-1', '别名')
    assert.equal(result.ok, false, '预置的临时落点链接必须拒收')
    assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_TEXT, '沿预置 tmp 符号链接写穿了目录外')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a directory-level symlink (state dir lives elsewhere) keeps working', () => {
  const root = tempDir()
  try {
    const realDir = join(root, 'state-real')
    const linkedDir = join(root, 'state-linked')
    mkdirSync(realDir, { recursive: true })
    symlinkSync(realDir, linkedDir)

    // 目录级链接是"整个状态目录搬到另一卷"的布局（未被第一轮误伤，这里钉住）。
    const alias = new AliasStore(linkedDir).set('session-1', '别名')
    assert.equal(alias.ok, true, `目录级符号链接被误伤：${alias.message}`)
    assert.match(readFileSync(join(realDir, 'aliases.json'), 'utf8'), /别名/)

    writeState(join(linkedDir, 'state.json'), { a: 1 })
    assert.equal(JSON.parse(readFileSync(join(realDir, 'state.json'), 'utf8')).a, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inside a registered managed memory root the first-round refusal is preserved', async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const realDir = join(root, 'memories-real')
    linkLanding(memoryDir, realDir, 'aliases.json', '{}\n')

    const { registerManagedRoot, unregisterManagedRoot } = await import('../lib/sync/filesets.js')
    registerManagedRoot(memoryDir)
    try {
      // 共享记忆分支的一个 120000 条目能让 checkout 把 aliases.json 实体化成
      // 指向仓库外的链接——仓库内不跟随（第一轮判据保持）。
      const refused = new AliasStore(memoryDir).set('session-1', '别名')
      assert.equal(refused.ok, false, '受管记忆仓库内的落点符号链接必须仍然拒收')
      assert.equal(readFileSync(join(realDir, 'aliases.json'), 'utf8'), '{}\n', '仓库内状态被写到了链接目标')
    } finally {
      unregisterManagedRoot(memoryDir)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repo-internal writes still refuse a landing file that is a symlink (first-round fence)', () => {
  const root = tempDir()
  try {
    const repo = join(root, 'memory-repo')
    const outside = join(root, 'outside')
    mkdirSync(repo, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const victim = join(outside, 'KEY.md')
    writeFileSync(victim, OUTSIDE_TEXT)
    symlinkSync(victim, join(repo, 'KEY.md'))

    const written = writeFileAtomicSafe(repo, join(repo, 'KEY.md'), 'INJECTED\n')
    assert.equal(written.ok, false, '仓库内写回不得跟随落点符号链接')
    assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_TEXT, '共享记忆仓库外的文件被写穿')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill content keeps the strict rule: a symlinked SKILL.md is refused', async () => {
  const root = tempDir()
  try {
    const skillDir = join(root, 'skills')
    const outside = join(root, 'outside')
    mkdirSync(join(skillDir, 'demo-skill'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    const victim = join(outside, 'SKILL.md')
    writeFileSync(victim, OUTSIDE_TEXT)
    symlinkSync(victim, join(skillDir, 'demo-skill', 'SKILL.md'))

    const { writeFileAtomicSafeAt } = await import('../lib/sync/filesets.js')
    assert.throws(
      () => writeFileAtomicSafeAt(join(skillDir, 'demo-skill', 'SKILL.md'), '# x\n', { followFileSymlink: false }),
      /write refused/,
      '技能内容落点必须保持严格档（预置链接一律拒收）',
    )
    assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_TEXT)
    assert.equal(readlinkSync(join(skillDir, 'demo-skill', 'SKILL.md')), victim, '拒收不得删除/改写预置链接本身')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// RECHECK3 NF3-1（第三轮）：受管记忆仓库内**目录级**符号链接的整类漏网。
//
// R2 的严格档只覆盖「落点**文件**是符号链接」：`resolveSelfAnchoredTarget` 把
// 落点的父目录自己当包含性基准（`resolveSafeRepoTarget(dir, base)`），于是
// realpath(dir) 变成"根"、包含性断言恒真，在 `isInsideManagedRoot` 那一关之前
// 就 return 了。共享分支里一条 `120000` 条目（`<memoryDir>/coi` = 120000）就能
// 在每台设备 checkout 成一条**可穿越的目录链接**，让该目录下所有状态写入落到
// 仓库外（实测 NotificationStore / TaskStore / writeFileAtomicSafeAt 全部写穿）。
//
// 修法：受管仓库内的落点一律先按**登记的仓库根**做仓库级断言（逐层 lstat +
// realpath 包含性）。本组把三种目录级形态钉死：指向仓外、指向仓内、相对 `..`。
// ---------------------------------------------------------------------------

test('NF-3: a managed-root directory symlink pointing OUTSIDE the repo is refused', async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const outsideNotif = join(root, 'outside-notif')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outsideNotif, { recursive: true })
    // 共享分支的 120000 条目在 checkout 后长这样。
    symlinkSync(outsideNotif, join(memoryDir, 'notifications'))

    const { registerManagedRoot, unregisterManagedRoot, writeFileAtomicSafeAt } = await import('../lib/sync/filesets.js')
    registerManagedRoot(memoryDir)
    try {
      const added = await new NotificationStore(memoryDir).add({ sender: 's', semantic: 'notify', subject: 'x', content: 'y' })
      assert.equal(added.ok, false, '目录级链接下通知仍报成功')
      assert.equal(existsSync(join(outsideNotif, 'notifications.json')), false, '状态写穿到受管仓库外')
      assert.throws(
        () => writeFileAtomicSafeAt(join(memoryDir, 'notifications', 'attachments', 'x.json'), '{}\n'),
        /write refused/,
        '目录级链接下的原子写必须 fail-loud',
      )
    } finally {
      unregisterManagedRoot(memoryDir)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NF-3: a managed-root directory symlink pointing INSIDE the repo is refused too (containment alone is not enough)', async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const insideTarget = join(memoryDir, 'real-coi')
    mkdirSync(insideTarget, { recursive: true })
    symlinkSync(insideTarget, join(memoryDir, 'coi'))

    const { registerManagedRoot, unregisterManagedRoot, writeFileAtomicSafeAt } = await import('../lib/sync/filesets.js')
    registerManagedRoot(memoryDir)
    try {
      // 指向仓内的链接**能过** realpath 包含性；判据是"仓库内任何符号链接一律
      // 拒收"（第一轮口径，行为收紧要登记），否则攻击者可以先用仓内链接骗过
      // 检查、再在 TOCTOU 窗口里把它换成仓外目标。
      assert.throws(
        () => writeFileAtomicSafeAt(join(memoryDir, 'coi', 'tasks.json'), '[]\n'),
        /write refused/,
      )
      assert.equal(existsSync(join(insideTarget, 'tasks.json')), false)
    } finally {
      unregisterManagedRoot(memoryDir)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NF-3: a relative ../../.. directory symlink inside the managed root is refused', async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const elsewhere = join(root, 'elsewhere', 'session-orch-real')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    // 相对链接 + `..`（正是复核报告点名的形态：git 的 120000 内容就是相对路径）。
    symlinkSync('../elsewhere/session-orch-real', join(memoryDir, 'session-orch'))

    const { registerManagedRoot, unregisterManagedRoot } = await import('../lib/sync/filesets.js')
    registerManagedRoot(memoryDir)
    try {
      const alias = new AliasStore(join(memoryDir, 'session-orch')).set('session-1', '别名')
      assert.equal(alias.ok, false, '相对 ../ 目录链接下仍报成功')
      assert.equal(existsSync(join(elsewhere, 'aliases.json')), false, '状态写穿到 ../../ 目标')
    } finally {
      unregisterManagedRoot(memoryDir)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NF-3 control: a plain subdirectory inside the managed root still writes (no over-blocking)', async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    mkdirSync(join(memoryDir, 'coi'), { recursive: true })
    const { registerManagedRoot, unregisterManagedRoot } = await import('../lib/sync/filesets.js')
    registerManagedRoot(memoryDir)
    try {
      const task = new TaskStore(join(memoryDir, 'coi'), {}).add({ adapterId: 'kimi', prompt: 'hi', scope: 'project' })
      assert.ok(task?.id, '普通子目录（无链接）被误伤')
      assert.match(readFileSync(join(memoryDir, 'coi', 'tasks.json'), 'utf8'), /kimi/)
    } finally {
      unregisterManagedRoot(memoryDir)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
