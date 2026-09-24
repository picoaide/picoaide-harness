#!/usr/bin/env node
/**
 * `scripts/check-workspaces.mjs`（= `yarn check` / `check:fast` / 根门禁编排器）的回归门禁。
 *
 * 为什么值得单独测：这个文件决定"到底跑了什么"，而它的失效**全都不会出声** ——
 *
 *   1. S15-1：`--changed <打错的 ref>` 算不出改动时被当成"没有改动" ⇒ 0 个包、0 个任务、
 *      exit 0（假绿的 check:fast，CI 只在 push 之后才发现）；
 *   2. S15-4：`--only <打错的包名>` 筛出空集 ⇒ 同样 0 个任务、exit 0；`--only --no-guards`
 *      这种"取值被下一个 flag 吃掉"的形态也一样；
 *   3. S15-3：`.gitignore` 里的 `.glitchtip-recon/` 规则 —— 少了它，GlitchTip 核查工具
 *      默认的 cookie jar 位置（管理员凭据）会被 `git add -A` 收进版本库。
 *
 * 测法（全 hermetic：不联网、不跑任何真实包、不写仓库）：
 *   - 编排器用**自身路径**推导 ROOT，所以要测"另一棵树"必须把它原样复制进合成树；
 *     合成树是 mkdtemp 出来的真 git 仓库（未跟踪文件也要能被 --changed 看见）；
 *   - `corepack` 换成只记录 argv 的 shell 桩 ⇒ "真的跑了那个包"由 argv 证明，
 *     既不启动 yarn 也不需要 node_modules；
 *   - `.gitignore` 规则用真实仓库的 `git check-ignore` 断言（读的就是工作区那份文件）。
 *
 * 变异验证（回退后本文件必红）：去掉 changedFiles 的 rev-parse 探测、去掉 main 里的
 * --only 校验、删掉 `.gitignore` 的那条规则 —— 三种回退都有对应断言。
 *
 * ## 本文件自己的自检（2026-09-23 第四轮审计 R4-A-6）
 *
 * 旧实现收尾只判 `failures.length > 0` ⇒ 把 `fail()` 掏空（`void message`）后，本文件
 * 会**打印与健康时逐字相同的 OK 长句并 EXIT=0**，回归网被掏空而无人发现。对照
 * `scripts/check-workflows.mjs` 早有的范式（`SELFTEST_MIN_SAMPLES` /
 * `SELFTEST_EXPECTED_POLICIES` / `SELFTEST_FATAL_PATH_ASSERTIONS`），这里补三条**互相
 * 独立**的自检，任一不成立即 EXIT=1 —— 而且它们的失败**不经过 `fail()`**（否则掏空
 * `fail()` 会把自检一起吞掉）：
 *   ① `check()` 执行条数 ≥ `SELFTEST_MIN_CHECKS`（防"断言表被清空"）；
 *   ② 合成树场景数 ≥ `SELFTEST_MIN_SCENARIOS`（防"样本数骤降"）；
 *   ③ **失败路径可达性**：in-process 探针（`fail()` 必须真的记录 + 真的写 stderr），
 *      外加端到端红色副本（把一条断言注入成恒假、跑一份自己的副本 ⇒ 必须 EXIT=1 且
 *      点名那条注入的失败）。
 *
 * 用法:node scripts/verify-check-workspaces.mjs
 * 退出码:0 全部通过;1 有断言失败或自检失败。
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const subject = join(root, 'scripts', 'check-workspaces.mjs')
const failures = []
const scratch = []

/**
 * 自检下限（实测值见下方 banner；只允许被"变多"越过，变少 = 回归网被掏空）。
 *
 * 2026-09-24 第十轮审计 C-09/C-10/C-12/C-13/C-15/C-16 补了一批判据之后，
 * 实测 409 条断言 / 26 个合成树场景 ⇒ 下限同步抬高（删掉那批判据就会撞下限）。
 */
const SELFTEST_MIN_CHECKS = 380
const SELFTEST_MIN_SCENARIOS = 24
/**
 * 自检自身的**登记表**（2026-09-23 第五轮审计 R4-A N3）。
 *
 * 现场:自检只有"一层" —— 把 `selfCheckFail()` 改成 no-op(甚至把整段自检删掉)之后,
 * 本文件仍然 EXIT=0,而且 banner 照旧宣称"自检 3 条:条数下限、样本下限、失败路径可达性"
 * (banner 是**写死的字符串**,与真实自检条数不同源)。掏空 `fail()` 会被自检③-a 抓住,
 * 但"掏空自检通道"没有任何第二来源(`check-root-guards.mjs` 只解析编排器的 GUARDS 表)。
 *
 * 处置(两条,缺一不可):
 *   ① 自检**登记表 + 双向对拍**:每条自检都有 id,跑完必须"登记的 == 跑到的"
 *      (少了 = 自检没跑;多了 = 有人塞了未登记的自检)。banner 里的条数与清单**取自
 *      这张表与实跑结果**,不再是写死的字符串。
 *   ② 自检失败通道的**端到端探针**:在副本里注入一条 `selfCheckFail(...)`(?见
 *      `SELFCHECK_PROBE_CHILD_ARG`),副本必须 EXIT=1 且把那句话打到 stderr ——
 *      把 `selfCheckFail()` 掏成 no-op 之后副本会 EXIT=0 ⇒ 本文件必红。
 */
const SELF_CHECKS = [
  { id: 'checks-floor', label: 'check() 执行条数下限' },
  { id: 'scenarios-floor', label: '合成树场景数下限' },
  { id: 'fail-channel', label: 'fail() 失败通道可达(记录 + stderr)' },
  { id: 'assert-path-e2e', label: '失败路径端到端可达(注入必假断言 ⇒ 副本 EXIT=1)' },
  { id: 'selfcheck-channel', label: '自检失败通道可达(记录 + 进退出码)' },
  { id: 'selfcheck-path-e2e', label: '自检失败路径端到端可达(注入自检失败 ⇒ 副本 EXIT=1)' },
  { id: 'registry-reconciled', label: '自检登记表双向对拍(跑到的 == 登记的)' },
  { id: 'domain-root-anchor', label: '域名守卫的扫描根断言可被 --selftest 打坏(R4-A N4)' },
  { id: 'channel-events', label: '检测通道与计票通道一致(数组长度 == 事件计数)' },
  { id: 'exit-channel', label: '任一通道有失败事件 ⇒ 退出码必须为 1(检测 ≠ 退出)' },
]
/** 自检条数下限（棘轮:删登记项必须同时改这个常量并进 diff）。 */
const SELFTEST_MIN_SELF_CHECKS = SELF_CHECKS.length
/** 红色副本的子进程标记：副本只做"必假断言"这一件事，不再递归生成副本。 */
const RED_PROBE_CHILD_ARG = '--selfcheck-red-probe-child'
/** 注入给红色副本的恒假断言文本（探针按它断言"具名失败"确实到达 stderr）。 */
const RED_PROBE_MESSAGE = 'SELFCHECK-RED-PROBE: 注入的必假断言（证明"断言失败 ⇒ exit 1"这条路径真的通）'
/** 自检失败副本的子进程标记与注入文本（R4-A N3：自检通道自己也要能被打坏）。 */
const SELFCHECK_PROBE_CHILD_ARG = '--selfcheck-channel-probe-child'
const SELFCHECK_PROBE_MESSAGE = 'SELFCHECK-CHANNEL-PROBE: 注入的自检失败（证明"自检失败 ⇒ exit 1"这条路径真的通）'
const redProbeChild = process.argv.includes(RED_PROBE_CHILD_ARG)
const selfCheckProbeChild = process.argv.includes(SELFCHECK_PROBE_CHILD_ARG)

/** 自检失败通道：**故意不经过 `fail()`** —— `fail()` 被掏空时它仍必须让本文件变红。 */
const selfCheckFailures = []
/** 跑到的自检 id → 'ok' | 'failed'（与 `SELF_CHECKS` 双向对拍,banner 也取自这里）。 */
const selfCheckObserved = new Map()
function selfCheckFail(id, message) {
  // **失败优先**：先登记的 'ok' 不得把后来的失败盖掉（否则 banner 会显示 ok）。
  selfCheckObserved.set(id, 'failed')
  selfCheckFailures.push(message)
  // **计票通道（独立于数组本身）**：R5-D-21 的现场是"只改收尾判据的那一项" ——
  // 数组里记着失败、stderr 也报了，退出码却仍是 0。事件计数与数组长度是两条独立来源，
  // 收尾会对拍它们（`channel-events`）并把"有事件却没进退出码"当失败报出来。
  failureEvents.selfCheck += 1
  process.stderr.write(`verify-check-workspaces: [self-check] ${message}\n`)
}
/**
 * 两条通道的**事件计数**（数组之外的第二个来源）：
 *   · `assertions` —— `fail()` 被调用的次数（断言的检测通道）；
 *   · `selfCheck`  —— `selfCheckFail()` 被调用的次数（自检的检测通道）。
 * 收尾同时看"数组非空"与"计数非零"，任一通道有事件都必须让退出码为 1。
 */
const failureEvents = { assertions: 0, selfCheck: 0 }
/** 一条自检**跑完且没发现问题**时登记（缺了它就会落到"登记了却没跑到"）。 */
function selfCheckPass(id) {
  if (selfCheckObserved.get(id) !== 'failed') selfCheckObserved.set(id, 'ok')
}

/** 执行过的断言条数（自检①）与合成树场景数（自检②）。 */
let checksRun = 0
let scenariosRun = 0

function fail(message) {
  failures.push(message)
  failureEvents.assertions += 1
  process.stderr.write(`verify-check-workspaces: ${message}\n`)
}

function check(condition, message) {
  checksRun += 1
  if (!condition) fail(message)
  return condition
}

/**
 * **退出判据的唯一实现**（R5-D-21：检测 ≠ 计票 ≠ 退出）。
 *
 * 为什么是一个函数、并且定义在文件这么靠前的地方：两个端到端探针（③-b / ③-d）要
 * 在**自己的副本**里注入一条失败，然后立刻走**真实的**退出判据 —— 若退出判据留在
 * 文件末尾，副本就得把整套回归网跑完才能得出结论（实测 >120s，spawnSync 直接 ETIMEDOUT，
 * 探针退化成"环境超时"而不是"判据有没有咬住"）。
 *
 * `mode`:
 *   · `'final'` —— 正常收尾：先做自检登记表双向对拍，再判退出；
 *   · `'early'` —— 探针副本用：**只**做"两通道一致性 + 任一通道有事件必须红"，
 *     不做登记表对拍（早期退出时大部分自检当然还没跑，"缺 4 条"会把探针要证的
 *     那条链掩掉）。
 * @param mode - `'final'`（缺省）或 `'early'`。
 */
function finalizeExit(mode = 'final') {
  if (mode === 'final') {
    // 本函数自己就是这三条自检的实现 —— 先登记，再对拍（否则它们永远"没跑到"）。
    for (const id of ['registry-reconciled', 'channel-events', 'exit-channel']) selfCheckPass(id)
    const registered = new Set(SELF_CHECKS.map(entry => entry.id))
    const missing = SELF_CHECKS.filter(entry => !selfCheckObserved.has(entry.id))
    const unknown = [...selfCheckObserved.keys()].filter(id => !registered.has(id))
    if (SELF_CHECKS.length < SELFTEST_MIN_SELF_CHECKS) {
      selfCheckFail('registry-reconciled',
        `自检登记表只剩 ${SELF_CHECKS.length} 条（下限 ${SELFTEST_MIN_SELF_CHECKS}）—— 自检被删到没有判别力`)
    } else if (missing.length > 0) {
      selfCheckFail('registry-reconciled', `自检登记表里有 ${missing.length} 条**没跑到**：`
        + missing.map(entry => `${entry.id}(${entry.label})`).join(', ')
        + ' —— 自检被短路/删除，而 banner 的条数取自这张表（不同源就会撒谎）')
    } else if (unknown.length > 0) {
      selfCheckFail('registry-reconciled', `跑了 ${unknown.length} 条**未登记**的自检：${unknown.join(', ')}`
        + ' —— 未登记的自检不进 banner 也不受下限约束，必须登记进 SELF_CHECKS')
    } else {
      selfCheckPass('registry-reconciled')
    }
  }
  // 检测（数组）≠ 计票（事件计数）：只改其中一侧（`failures.push` → 无操作、
  // 计数 `+= 0`）都会在这里对不上。
  if (failureEvents.assertions !== failures.length) {
    selfCheckFail('channel-events', `断言通道的计票（${failureEvents.assertions}）与检测记录`
      + `（${failures.length} 条）不一致 —— 检测与计票被拆开了（只改一侧即可静默）`)
  } else if (failureEvents.selfCheck !== selfCheckFailures.length) {
    selfCheckFail('channel-events', `自检通道的计票（${failureEvents.selfCheck}）与检测记录`
      + `（${selfCheckFailures.length} 条）不一致 —— 检测与计票被拆开了（只改一侧即可静默）`)
  } else {
    selfCheckPass('channel-events')
  }
  const decisionRed = failures.length > 0 || selfCheckFailures.length > 0
  if ((failureEvents.assertions > 0 || failureEvents.selfCheck > 0) && !decisionRed) {
    // 任一通道**发生过**失败事件 ⇒ 退出判据必须为红。走到这里说明退出判据漏掉了
    // 某个通道（R5-D-21 的现场形态：stderr 已经报红，banner 仍是 OK + EXIT=0）。
    selfCheckFail('exit-channel', '有失败事件（断言 '
      + `${failureEvents.assertions} / 自检 ${failureEvents.selfCheck}）但退出判据给出 0 —— `
      + '退出码漏掉了某一通道，检测到了却仍是绿的')
  } else {
    selfCheckPass('exit-channel')
  }
  if (failures.length > 0 || selfCheckFailures.length > 0) {
    process.stderr.write(`\nverify-check-workspaces: ${failures.length} 项断言失败`
      + `${selfCheckFailures.length > 0 ? ` / ${selfCheckFailures.length} 项自检失败` : ''}\n`)
    process.exit(1)
  }
  // 探针副本用 `early`：判据**就是结论** —— 判绿也必须当场退出。否则副本会继续把
  // 整套回归网跑完，"探针副本的退出码"就不再等于"这条判据的结论"（实测会把变异
  // 掩盖掉：副本后来因别的原因红了，父进程误以为探针通过）。
  if (mode === 'early') process.exit(0)
}

/** 造一个临时目录(进程退出时清理)。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/**
 * 环境里残留的 GIT_DIR/GIT_WORK_TREE 等会让合成树里的 git 操作打到**别的仓库**去
 * （断言会以看不懂的方式失败），这里统一剔除。
 */
function cleanGitEnv() {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  ]) {
    delete env[key]
  }
  return env
}

/** 在指定仓库里跑 git(固定身份/签名，避免受调用者配置影响)。 */
function gitIn(cwd, ...args) {
  return spawnSync('git', [
    '-c', 'user.email=verify@example.com',
    '-c', 'user.name=verify',
    '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main',
    ...args,
  ], { cwd, encoding: 'utf8', env: cleanGitEnv() })
}

/**
 * 造一棵合成门禁树：编排器副本 + corepack 桩 + 一个初始提交的 git 仓库。
 *
 * @param options - 可选：`mutate(source)` 对编排器源码做替换（注入调度表缺陷等）；
 *   `stubExtra` 追加到 corepack 桩里的 shell（用来让某个任务打印"软降级"行）。
 * @returns {{ tree: string, log: string }} 树根与 corepack 桩的 argv 记录文件。
 */
function buildTree(options = {}) {
  const { mutate = null, stubExtra = '' } = options
  scenariosRun += 1
  const tree = tempDir('check-workspaces-')
  mkdirSync(join(tree, 'scripts'))
  const source = readFileSync(subject, 'utf8')
  writeFileSync(join(tree, 'scripts', 'check-workspaces.mjs'), mutate === null ? source : mutate(source))
  writeFileSync(
    join(tree, 'package.json'),
    `${JSON.stringify({ name: 'synthetic-gate', private: true, workspaces: ['packages/*/*', 'community/*'] }, null, 2)}\n`,
  )
  mkdirSync(join(tree, 'bin'))
  // argv 记录文件放在**树外**：它是在初始提交之后才产生的，留在树里会变成第二个
  // 未跟踪文件，把 `--changed HEAD` 正例的"1 个改动文件"断言搅浑。
  const log = join(tempDir('check-workspaces-log-'), 'corepack-argv.log')
  const stub = join(tree, 'bin', 'corepack')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${stubExtra}exit 0\n`)
  chmodSync(stub, 0o755)
  writeFileSync(join(tree, 'README.md'), 'synthetic gate tree\n')
  const init = gitIn(tree, 'init', '-q')
  check(init.status === 0, `合成树 git init 失败(接线问题):${init.stderr}`)
  const add = gitIn(tree, 'add', '-A')
  check(add.status === 0, `合成树 git add 失败(接线问题):${add.stderr}`)
  const commit = gitIn(tree, 'commit', '-q', '-m', 'init')
  check(commit.status === 0, `合成树 git commit 失败(接线问题):${commit.stderr}`)
  const head = gitIn(tree, 'rev-parse', '--verify', 'HEAD')
  check(head.status === 0, `合成树没有 HEAD(接线问题):${head.stderr}`)
  return { tree, log }
}

/** 在合成树里跑一次编排器副本（corepack 走桩）。 */
function runSynthetic(tree, args) {
  const result = spawnSync(process.execPath, [join('scripts', 'check-workspaces.mjs'), ...args], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), PATH: `${join(tree, 'bin')}:${process.env.PATH}`, FORCE_COLOR: '0' },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error,
  }
}

const { tree, log } = buildTree()

// ---------------------------------------------------------------------------
// S15-1：算不出改动 = 硬错误（exit 2），绝不当成"没有改动"
// ---------------------------------------------------------------------------

for (const ref of ['refs/heads/definitely-missing', '', 'scripts/check-workspaces.mjs']) {
  const result = runSynthetic(tree, ['--changed', ref, '--no-guards'])
  const label = JSON.stringify(ref)
  check(result.spawnError === undefined, `S15-1(${label}): 子进程未能启动:${result.spawnError}`)
  check(
    result.status === 2,
    `S15-1(${label}): 无法解析的 --changed 必须 exit 2(实际 ${result.status})，stdout=${result.stdout.slice(0, 200)}`,
  )
  check(
    (result.stderr + result.stdout).includes('ref 无法解析'),
    `S15-1(${label}): 必须给出"ref 无法解析"的明确原因，实际 stderr=${JSON.stringify(result.stderr.slice(0, 200))}`,
  )
  // 同一个假绿的另一半：绝不能打印"0 个改动文件 → 0 个任务"后当作通过。
  check(
    !result.stdout.includes('0 个任务'),
    `S15-1(${label}): 不得在算不出改动时以"0 个任务"收场，实际 stdout=${result.stdout.slice(0, 200)}`,
  )
}

// ---------------------------------------------------------------------------
// S15-1 正例：能算出改动时，改动真的映射到包并真的跑起来
// ---------------------------------------------------------------------------

{
  writeFileSync(log, '')
  mkdirSync(join(tree, 'packages', 'host', 'desktop', 'src'), { recursive: true })
  writeFileSync(join(tree, 'packages', 'host', 'desktop', 'src', 'probe.ts'), 'export const probe = 1\n')
  const result = runSynthetic(tree, ['--changed', 'HEAD', '--no-guards'])
  check(result.status === 0, `S15-1(正例): 干净的改动集应 exit 0(实际 ${result.status}: ${result.stderr.slice(0, 200)})`)
  check(
    result.stdout.includes('1 个改动文件'),
    `S15-1(正例): 应报出 1 个改动文件，实际 stdout=${result.stdout.slice(0, 200)}`,
  )
  const invoked = readFileSync(log, 'utf8')
  check(
    invoked.includes('workspace dsh-plugin-desktop run check'),
    `S15-1(正例): 改动必须真的映射到 dsh-plugin-desktop 并执行它，实际 corepack argv=${JSON.stringify(invoked)}`,
  )
}

// ---------------------------------------------------------------------------
// S15-4：--only 必须兑现（未知/空/被 flag 吃掉都是用法错误），点名有效则真的跑
// ---------------------------------------------------------------------------

for (const args of [
  ['--only', 'definitely-nope', '--no-guards'],
  ['--only', '', '--no-guards'],
  ['--only'],
  ['--only', '--no-guards'],
]) {
  const result = runSynthetic(tree, args)
  check(
    result.status === 2,
    `S15-4(${JSON.stringify(args)}): 必须 exit 2(实际 ${result.status})，stdout=${result.stdout.slice(0, 200)}`,
  )
  check(
    !result.stdout.includes('0 个任务'),
    `S15-4(${JSON.stringify(args)}): 不得以"0 个任务"收场，实际 stdout=${result.stdout.slice(0, 200)}`,
  )
}

{
  writeFileSync(log, '')
  const result = runSynthetic(tree, ['--only', 'dsh-plugin-desktop'])
  check(result.status === 0, `S15-4(正例): 有效的 --only 应 exit 0(实际 ${result.status}: ${result.stderr.slice(0, 200)})`)
  const invoked = readFileSync(log, 'utf8')
  check(
    invoked.includes('workspace dsh-plugin-desktop run check'),
    `S15-4(正例): 点名的包必须真的执行，实际 corepack argv=${JSON.stringify(invoked)}`,
  )
  check(
    !invoked.includes('workspace @picoaide/dsh-cron run check'),
    `S15-4(正例): 只应跑点名的包，实际 corepack argv=${JSON.stringify(invoked)}`,
  )
}

// ---------------------------------------------------------------------------
// S15-3：`.glitchtip-recon/`（核查工具的默认 cookie jar 位置）必须被忽略
// ---------------------------------------------------------------------------

for (const probe of ['.glitchtip-recon/c.txt', '.glitchtip-recon/nested/other.txt']) {
  const ignored = spawnSync('git', ['check-ignore', '-v', probe], { cwd: root, encoding: 'utf8', env: cleanGitEnv() })
  check(
    ignored.status === 0,
    `S15-3: ${probe} 必须被 .gitignore 忽略(git check-ignore 退出码 ${ignored.status}) —— `
    + '否则管理员 cookie jar 会被 git add -A 收进版本库',
  )
  check(
    ignored.stdout.includes('.glitchtip-recon'),
    `S15-3: 命中的规则必须点名 .glitchtip-recon，实际 ${JSON.stringify(ignored.stdout)}`,
  )
}

// ---------------------------------------------------------------------------
// 变异体残留守卫（2026-09-20 事故后的新守卫）：合成正/负例 + 接线
//
// 为什么用合成树而不是仓库本身：仓库此刻**必须**是零残留（否则这条断言会与真实
// 工作区状态耦合，别人一改就红）；而"守卫会不会真的抓"只能靠**已知坏的输入**证明。
// 三个夹具各自钉一种形态：①代码行尾挂变异注释（必须红）；②纯注释变异块（必须绿）；
// ③字符串字面量里描述变异（必须绿）。另外断言"夹具内容确实含标记"——
// 否则夹具写错（比如关键词敲错）会让负例**永远通过**，变成假绿。
// ---------------------------------------------------------------------------

{
  const guard = join(root, 'scripts', 'check-no-leftover-mutants.mjs')
  const tree = tempDir('mutant-guard-tree-')
  mkdirSync(join(tree, 'src'), { recursive: true })
  const badBody = "export function pageSize() {\n  return '0' // XX 变异 M-1：改回 0\n}\n"
  writeFileSync(join(tree, 'src', 'mutant.ts'), badBody)
  writeFileSync(join(tree, 'src', 'doc.ts'), '// 变异验证：下面这行曾被改成 0，跑完已还原\nexport const size = 20\n')
  writeFileSync(join(tree, 'src', 'str.ts'), "export const note = '`|| true` 变异无任何静态守卫'\n")
  writeFileSync(join(tree, 'src', 'regex.mjs'), 'const KEYWORD = /变异|MUTANT/gu\nexport default KEYWORD\n')

  // 防假绿：夹具本身必须真的含标记（写错了就会让负例恒通过）。
  check(badBody.includes('变异'), '变异守卫自检：坏夹具必须真的含「变异」标记（否则负例是假绿）')

  const bad = spawnSync(process.execPath, [guard, '--root', tree], { cwd: root, encoding: 'utf8' })
  check(bad.status === 1, `变异守卫：代码行尾挂变异注释必须红（实际 exit=${bad.status}）`)
  check(bad.stderr.includes('mutant.ts'), `变异守卫：命中必须点名文件（实际 ${JSON.stringify(bad.stderr.slice(0, 200))}）`)

  const good = spawnSync(process.execPath, [guard, '--root', tempDir('mutant-guard-ok-')], { cwd: root, encoding: 'utf8' })
  // C-9 / 六处形态②（2026-09-23 三轮审计）：空树旧实现打印 `零残留 ✅` 并 exit 0，
  // 与"判据跑了且没问题"无法区分 ⇒ 现在必须红。
  check(good.status === 1, `变异守卫：空树（扫描面 0）必须红而不是"零残留 ✅"（实际 exit=${good.status}）`)
  check(good.stderr.includes('扫描面为'), `变异守卫：空扫描面必须说明原因（实际 ${JSON.stringify(good.stderr.slice(0, 200))}）`)
  check(!good.stdout.includes('零残留'), '变异守卫：扫描面为 0 时不得打印 `零残留 ✅`')

  // 六处形态②：`--root` 不存在 ⇒ 用法错误 exit 2（旧实现 EXIT=0 + 零残留 ✅）。
  const missingRoot = spawnSync(process.execPath, [guard, '--root', join(tempDir('mutant-guard-missing-'), 'nope')], {
    cwd: root,
    encoding: 'utf8',
  })
  check(missingRoot.status === 2, `变异守卫：--root 不存在必须 exit 2（实际 ${missingRoot.status}）`)
  check(!missingRoot.stdout.includes('零残留'), '变异守卫：--root 不存在时不得打印 `零残留 ✅`')

  // 把两个"必须绿"的形态单独放一棵树里（与坏夹具隔离，失败信息才指得准）。
  const goodTree = tempDir('mutant-guard-good-')
  mkdirSync(join(goodTree, 'src'), { recursive: true })
  writeFileSync(join(goodTree, 'src', 'doc.ts'), '// 变异验证：下面这行曾被改成 0，跑完已还原\nexport const size = 20\n')
  writeFileSync(join(goodTree, 'src', 'str.ts'), "export const note = '`|| true` 变异无任何静态守卫'\n")
  writeFileSync(join(goodTree, 'src', 'regex.mjs'), 'const KEYWORD = /变异|MUTANT/gu\nexport default KEYWORD\n')
  const goodReal = spawnSync(process.execPath, [guard, '--root', goodTree], { cwd: root, encoding: 'utf8' })
  check(
    goodReal.status === 0,
    `变异守卫：纯注释块 / 字符串字面量 / 正则字面量里的标记必须绿（实际 exit=${goodReal.status}：${goodReal.stderr.slice(0, 200)}）`,
  )

  // C-9 的豁免粒度：**每个命中点各自判**，不是"整行豁免"。
  // 同一个文件里先放"标记只在字符串里"（必须绿），再放"同行还有一个裸标记"（必须红）。
  //
  // ⚠️ 本文件自己也在 `check-no-leftover-mutants` 的扫描面里（`scripts/**`），所以标记一律
  // **运行时拼接**构造：在源码里直接写裸标记，会被那条守卫（正确地）判成"代码行上挂着变异标记"。
  const mark = ['变', '异'].join('')
  const perHitTree = tempDir('mutant-guard-perhit-')
  mkdirSync(join(perHitTree, 'src'), { recursive: true })
  const quotedOnly = `export const note = '${mark} M-D 已还原'\n`
  writeFileSync(join(perHitTree, 'src', 'probe.ts'), quotedOnly)
  check(quotedOnly.includes(mark), '变异守卫自检：per-hit 正例夹具必须真的含标记')
  const quotedOnlyRun = spawnSync(process.execPath, [guard, '--root', perHitTree], { cwd: root, encoding: 'utf8' })
  check(quotedOnlyRun.status === 0, `变异守卫：标记只在字符串里必须绿（实际 exit=${quotedOnlyRun.status}）`)

  const mixedLine = `export const note = '${mark} M-D 已还原' + ${mark}\n`
  writeFileSync(join(perHitTree, 'src', 'probe.ts'), mixedLine)
  check(mixedLine.includes(`'${mark}`) && mixedLine.includes(`+ ${mark}`),
    '变异守卫自检：per-hit 负例夹具必须同时含"引号内标记"与"裸标记"')
  const mixedRun = spawnSync(process.execPath, [guard, '--root', perHitTree], { cwd: root, encoding: 'utf8' })
  check(mixedRun.status === 1,
    `变异守卫：同一行里只要还有一个裸标记就必须红（豁免必须是 per-hit 而不是整行）（实际 exit=${mixedRun.status}）`)
  check(mixedRun.stderr.includes('probe.ts'), `变异守卫：per-hit 命中必须点名文件（实际 ${JSON.stringify(mixedRun.stderr.slice(0, 200))}）`)
}

// ---------------------------------------------------------------------------
// 迁移区间守卫（2026-09-20 漂移事故后的新守卫）：合成正/负例 + 接线
//
// 夹具刻意做"两处都动"：假迁移目录到 0007，假 docs 一处写 0001–0007（必须绿）、
// 一处写 0001–0003（必须红）。并断言坏夹具真的含那句区间声明 ——
// 否则夹具写错会让负例**永远通过**（假绿）。
// ---------------------------------------------------------------------------

{
  const guard = join(root, 'scripts', 'check-migration-range.mjs')
  const tree = tempDir('migration-range-tree-')
  mkdirSync(join(tree, 'server', 'internal', 'serverstore', 'migrations-pg'), { recursive: true })
  for (const name of ['0001_init.sql', '0002_tokens.sql', '0007_latest.sql']) {
    writeFileSync(join(tree, 'server', 'internal', 'serverstore', 'migrations-pg', name), '-- migration\n')
  }
  mkdirSync(join(tree, 'server', 'docs'), { recursive: true })
  const staleLine = '服务端迁移编号 0001-0003 已过时\n'
  writeFileSync(join(tree, 'server', 'docs', 'stale.md'), `# DB\n\n${staleLine}`)
  writeFileSync(join(tree, 'server', 'AGENTS.md'), '# agents\n\n- DB: 迁移 `internal/serverstore/migrations-pg/` 0001–0007\n')
  check(staleLine.includes('0001-0003'), '迁移区间守卫自检：坏夹具必须真的含落后区间（否则负例是假绿）')

  const bad = spawnSync(process.execPath, [guard, '--root', tree], { cwd: root, encoding: 'utf8' })
  check(bad.status === 1, `迁移区间守卫：区间落后必须红（实际 exit=${bad.status}）`)
  check(bad.stderr.includes('stale.md') && bad.stderr.includes('0007'),
    `迁移区间守卫：命中必须点名文件与实际 MAX（实际 ${JSON.stringify(bad.stderr.slice(0, 200))}）`)

  // 修好那句之后必须复绿（同一棵树 ⇒ 证明是"那句区间"在判红，不是别的噪声）。
  writeFileSync(join(tree, 'server', 'docs', 'stale.md'), '# DB\n\n服务端迁移编号 0001-0007\n')
  const good = spawnSync(process.execPath, [guard, '--root', tree], { cwd: root, encoding: 'utf8' })
  check(good.status === 0, `迁移区间守卫：区间正确必须绿（实际 exit=${good.status}：${good.stderr.slice(0, 200)}）`)
}

// ---------------------------------------------------------------------------
// 文档数字守卫（2026-09-23 二轮审计 D-4/D-5 后的新守卫）：合成正/负例 + 接线
//
// 夹具同样"两处都动"：真源写 0.1.6-alpha.2 / 2 项模块，官网先写落后 pin + 漏项列表
// （必须红，且必须同时点名两处），改对后同一棵树必须绿。
// ---------------------------------------------------------------------------

{
  const guard = join(root, 'scripts', 'check-doc-claims.mjs')
  const tree = tempDir('doc-claims-tree-')
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'site', 'src', 'content', 'docs', 'en'), { recursive: true })
  writeFileSync(join(tree, 'upstream.json'), JSON.stringify({ commit: 'a'.repeat(40), sourceVersion: '0.1.6-alpha.2' }))
  writeFileSync(
    join(tree, 'scripts', 'platform-modules.mjs'),
    "export const PLATFORM_MODULES = [\n  'react',\n  'react-dom',\n]\n",
  )
  const stalePinLine = '当前 pin `dsh-v0.1.5-rc.2` 构建。\n'
  const staleModulesLine = '平台模块表（`PLATFORM_MODULES`，共 9 项：`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-dockkit`）。\n'
  writeFileSync(join(tree, 'site', 'src', 'content', 'docs', 'faq.md'), `# FAQ\n\n${stalePinLine}`)
  writeFileSync(join(tree, 'site', 'src', 'content', 'docs', 'plugin-development.md'), `# Plugins\n\n${staleModulesLine}`)
  writeFileSync(join(tree, 'site', 'src', 'content', 'docs', 'en', 'plugin-development.md'), `# Plugins\n\n${staleModulesLine}`)
  check(
    stalePinLine.includes('dsh-v0.1.5-rc.2') && staleModulesLine.includes('dsh-client-ui-dockkit'),
    '文档数字守卫自检：坏夹具必须真的含落后 pin 与多出的模块项（否则负例是假绿）',
  )

  const bad = spawnSync(process.execPath, [guard, '--root', tree], { cwd: root, encoding: 'utf8' })
  check(bad.status === 1, `文档数字守卫：落后 pin / 模块表不一致必须红（实际 exit=${bad.status}）`)
  check(
    bad.stderr.includes('faq.md') && bad.stderr.includes('dsh-v0.1.6-alpha.2'),
    `文档数字守卫：pin 漂移必须点名文件与真源值（实际 ${JSON.stringify(bad.stderr.slice(0, 300))}）`,
  )
  check(
    bad.stderr.includes('plugin-development.md') && bad.stderr.includes('dsh-client-ui-dockkit'),
    `文档数字守卫：模块表漂移必须点名文件与多出的项（实际 ${JSON.stringify(bad.stderr.slice(0, 300))}）`,
  )

  // 改对之后同一棵树必须绿（证明判红来自这两行，不是别的噪声）。
  writeFileSync(join(tree, 'site', 'src', 'content', 'docs', 'faq.md'), '# FAQ\n\n当前 pin `dsh-v0.1.6-alpha.2` 构建。\n')
  const goodModulesLine = '平台模块表（`PLATFORM_MODULES`，共 2 项：`react`、`react-dom`）。\n'
  for (const file of ['plugin-development.md', join('en', 'plugin-development.md')]) {
    writeFileSync(join(tree, 'site', 'src', 'content', 'docs', file), `# Plugins\n\n${goodModulesLine}`)
  }
  const good = spawnSync(process.execPath, [guard, '--root', tree], { cwd: root, encoding: 'utf8' })
  check(good.status === 0, `文档数字守卫：改对后必须绿（实际 exit=${good.status}：${good.stderr.slice(0, 300)}）`)

  // 扫描面失效（一条 pin 断言都扫不到）必须红 —— 空扫描不是通过。
  writeFileSync(join(tree, 'site', 'src', 'content', 'docs', 'faq.md'), '# FAQ\n\n没有 pin 断言。\n')
  const empty = spawnSync(process.execPath, [guard, '--root', tree], { cwd: root, encoding: 'utf8' })
  check(empty.status === 1, `文档数字守卫：零 pin 断言必须红而不是静默通过（实际 exit=${empty.status}）`)
}

// ---------------------------------------------------------------------------
// 调度/归属表自检（2026-09-23 三轮审计 R3-C C-1/C-2）：合成正/负例 + 运行时断言
//
// 为什么值得单列：这三张表（PACKAGES.needs / PATH_OWNERS / DEPENDENTS）是手写的，
// 而名字打错时**每一条失败形态都是静默的** —— `needs` 里不存在的名字被
// `filter(selectedSet.has)` 当成"没被选中"丢掉；成环的包永远停在 pending，
// 旧实现在 `running.size === 0 && !progressed` 处直接 break（那些包既不跑也不进
// skipped，摘要按实际结果倒算 ⇒ 打印「N 通过、0 失败、0 跳过」并 EXIT=0）；
// PATH_OWNERS 前缀/包名打错让 `check:fast` 判 0 个包。
//
// 注入一律**从脚本源码里现读名字**（不写死任何包名）⇒ 新增包自动被覆盖。
// ---------------------------------------------------------------------------

/** 从编排器源码里现读单行 PACKAGES 条目（多行条目无法单点替换，排除）。 */
function readSchedulerTables(source) {
  const pkgBlock = source.slice(source.indexOf('const PACKAGES = ['), source.indexOf('const PATH_OWNERS = ['))
  const entries = [...pkgBlock.matchAll(/\{\s*name: '([^']+)',\s*dir: '([^']+)',\s*needs: (\[[^\]]*\])/gu)]
    .map(match => ({ name: match[1], dir: match[2], needs: match[3] }))
    .filter(entry => source.includes(`{ name: '${entry.name}', dir: '${entry.dir}', needs: ${entry.needs} }`))
  const ownerBlock = source.slice(source.indexOf('const PATH_OWNERS = ['), source.indexOf('const DEPENDENTS = {'))
  const owners = [...ownerBlock.matchAll(/\['([^']+)', '([^']+)'\]/gu)].map(match => ({ prefix: match[1], name: match[2] }))
  const depBlock = source.slice(source.indexOf('const DEPENDENTS = {'), source.indexOf('const GLOBAL_PREFIXES'))
  const depKeys = [...depBlock.matchAll(/^  '([^']+)': \[/gmu)].map(match => match[1])
  return { entries, owners, depKeys, dependents: parseDependents(depBlock) }
}

/**
 * 解析 `DEPENDENTS` 的键 → 值列表（2026-09-24 第十轮审计 C-11：`needs ↔ DEPENDENTS`
 * 的双向一致判据需要读**值**，旧解析只读键）。
 *
 * 逐行解析（不是一条大正则）：条目形态既有单行也有多行数组，值里只会出现
 * `'包名'` 这一种 token ⇒ `^  '<key>': [` 起一行，遇到 `]` 结束。
 * @param depBlock - `const DEPENDENTS = {` 到 `const GLOBAL_PREFIXES` 之间的源码片段。
 * @returns `[{ key, values }]`。
 */
function parseDependents(depBlock) {
  const dependents = []
  let current = null
  for (const line of depBlock.split('\n')) {
    const keyMatch = /^ {2}'([^']+)': \[(.*)$/u.exec(line)
    let rest = line
    if (keyMatch !== null) {
      current = { key: keyMatch[1], values: [] }
      dependents.push(current)
      rest = keyMatch[2]
    }
    if (current === null) continue
    for (const value of rest.matchAll(/'([^']+)'/gu)) current.values.push(value[1])
    if (rest.includes(']')) current = null
  }
  return dependents
}

/**
 * 从编排器源码里现读 **PACKAGES 的完整条目**（含多行条目：`script` / `firstWave`）。
 *
 * 与 {@link readSchedulerTables} 的分工：那一份只读**单行**条目（注入用锚点必须能单点替换），
 * 这一份读全部条目（C-12/F5 的语义对拍：包目录、`package.json` 的 name、`script` 字段）。
 * 条目体是 `{ … }` 且体内没有嵌套花括号 ⇒ 用 `\{([^{}]*)\}` 即可，注释里的花括号会被
 * `name`/`dir` 双缺过滤掉。
 * @param source - 编排器源码。
 * @returns `[{ name, dir, script, needs }]`。
 */
function readPackageEntries(source) {
  const block = source.slice(source.indexOf('const PACKAGES = ['), source.indexOf('const PATH_OWNERS = ['))
  return [...block.matchAll(/\{([^{}]*)\}/gu)]
    .map(match => {
      const body = match[1]
      const needsBlock = /needs:\s*\[([^\]]*)\]/u.exec(body)?.[1] ?? ''
      return {
        name: /name:\s*'([^']+)'/u.exec(body)?.[1] ?? null,
        dir: /dir:\s*'([^']+)'/u.exec(body)?.[1] ?? null,
        script: /script:\s*'([^']+)'/u.exec(body)?.[1] ?? 'check',
        needs: [...needsBlock.matchAll(/'([^']+)'/gu)].map(need => need[1]),
      }
    })
    .filter(entry => entry.name !== null && entry.dir !== null)
}

/**
 * 展开 root `package.json` 的 workspaces 通配（本仓只用「一层星号」与「两层星号」两种形态，
 * 例如 `community/<star>` 与 `packages/<star>/<star>` —— 星号在这里刻意不写成字面量，
 * 免得块注释被 `*` + `/` 的序列提前闭合，那是本项目踩过三次的坑）。
 */
function expandWorkspaceGlobs(treeRoot, patterns) {
  const found = new Set()
  for (const pattern of patterns) {
    let dirs = [treeRoot]
    for (const segment of pattern.split('/')) {
      const next = []
      for (const dir of dirs) {
        if (segment === '*') {
          if (!existsSync(dir)) continue
          for (const name of readdirSync(dir)) {
            const full = join(dir, name)
            try {
              if (statSync(full).isDirectory()) next.push(full)
            } catch {
              // 读不到的条目不是 workspace 包，跳过
            }
          }
        } else {
          const full = join(dir, segment)
          if (existsSync(full)) next.push(full)
        }
      }
      dirs = next
    }
    for (const dir of dirs) {
      if (existsSync(join(dir, 'package.json'))) found.add(resolve(dir))
    }
  }
  return [...found]
}

/**
 * 「`PACKAGES` 表 ↔ 磁盘上的 workspace 包」的**语义**对拍（2026-09-24 第十轮审计 C-12/F5）。
 *
 * 现场：回归门禁的合成树里 `corepack` 是桩、**没有任何真实包** ⇒ 「把 `@picoaide/dsh-cron`
 * 从表里整条删掉」「把某包的 `script` 字段换掉」这类破坏**零新增失败**（子泳道差分实测
 * 0 行）。合成树证明的是"编排器把 argv 发出去了"，证明不了"那个包真的存在/真的该在此时跑"。
 * 所以这里对**真实树**（或任何给定树）做三条语义判据：
 *   ① 每条 `PACKAGES` 的 `dir` 必须存在，且其 `package.json` 的 `name` 与表内的 `name` 一致；
 *   ② 它的 `scripts[script ?? 'check']` 必须真的存在（`--full-output` 之外的**另一种**
 *      `yarn workspace … run <script>` 静默失效形态：脚本名写错 ⇒ yarn 报用法错误，
 *      而"表里少一个包"连错误都没有）；
 *   ③ **双向**：磁盘上每个 workspace 包都必须在表里（删掉一个包 = 整包静默退出门禁）。
 * @param source - 编排器源码。
 * @param treeRoot - 要检查的树根。
 * @returns 问题描述列表（空 = 通过）。
 */
function packageTableProblems(source, treeRoot) {
  const problems = []
  const entries = readPackageEntries(source)
  if (entries.length === 0) return ['PACKAGES 表解析不出任何条目（解析锚点失效 ⇒ 这条判据会静默通过）']
  const declared = new Map()
  for (const entry of entries) {
    declared.set(resolve(treeRoot, entry.dir), entry)
    const dir = join(treeRoot, entry.dir)
    if (!existsSync(dir)) {
      problems.push(`${entry.name}: PACKAGES 的 dir ${JSON.stringify(entry.dir)} 在磁盘上不存在`)
      continue
    }
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) {
      problems.push(`${entry.name}: ${entry.dir}/package.json 不存在`)
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch (error) {
      problems.push(`${entry.name}: ${entry.dir}/package.json 解析失败：${error.message}`)
      continue
    }
    if (pkg.name !== entry.name) {
      problems.push(`PACKAGES 表里的 name ${JSON.stringify(entry.name)} 与 ${entry.dir}/package.json 的 `
        + `${JSON.stringify(pkg.name)} 不一致（表里的是名字的第二个真源，漂移 ⇒ 跑错包）`)
    }
    if (typeof pkg.scripts?.[entry.script] !== 'string' || pkg.scripts[entry.script].trim() === '') {
      problems.push(`${entry.name}: ${entry.dir}/package.json 里没有 \`scripts.${entry.script}\` `
        + `（PACKAGES 的 script 字段 = ${JSON.stringify(entry.script)}；门禁会以 yarn 用法错误收场，`
        + '而"表里少一个包"连错误都没有）')
    }
  }
  // ③ 双向：磁盘上的 workspace 包必须都在表里。
  let workspaces = []
  try {
    workspaces = JSON.parse(readFileSync(join(treeRoot, 'package.json'), 'utf8')).workspaces ?? []
  } catch (error) {
    problems.push(`读不到 ${treeRoot}/package.json 的 workspaces：${error.message}`)
    return problems
  }
  for (const dir of expandWorkspaceGlobs(treeRoot, workspaces)) {
    if (!declared.has(resolve(dir))) {
      problems.push(`磁盘上的 workspace 包 ${relative(treeRoot, dir)} 不在 PACKAGES 表里`
        + ' ⇒ 它永远不会被门禁跑到（整包静默退出门禁）')
    }
  }
  return problems
}

/** 在源码里做唯一替换（找不到/不唯一即抛：注入没生效却当成"守卫没抓住"是最坏的假结论）。 */
function replaceOnce(source, needle, replacement) {
  const first = source.indexOf(needle)
  if (first < 0) throw new Error(`注入锚点未找到: ${needle}`)
  if (source.indexOf(needle, first + 1) >= 0) throw new Error(`注入锚点不唯一: ${needle}`)
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

check(readSchedulerTables(readFileSync(subject, 'utf8')).entries.length >= 4,
  '调度表自检(接线问题): 从编排器源码里读不出单行 PACKAGES 条目')

{
  // 正例：真仓库的表必须过（注：这条同时是"新增包自动被覆盖"的证据 ——
  // 判据只做集合对拍，不认识任何具体包名）。
  const real = spawnSync(process.execPath, [subject, '--list'], { cwd: root, encoding: 'utf8' })
  check(real.status === 0, `调度表自检(正例): 真仓库的 --list 必须 exit 0(实际 ${real.status}: ${real.stderr.slice(0, 300)})`)

  /** 七种注入（6 类打错 + 1 类前缀歧义）：每条都给"必须点名的关键词"与一句人话标签。 */
  const defects = [
    {
      id: 'cycle',
      label: 'needs 成环（C-1 的原形态）',
      must: /成环/u,
      mutate: source => {
        const { entries } = readSchedulerTables(source)
        const [a, b] = [entries[0], entries[entries.length - 1]]
        let out = replaceOnce(source, `{ name: '${a.name}', dir: '${a.dir}', needs: ${a.needs} }`,
          `{ name: '${a.name}', dir: '${a.dir}', needs: ['${b.name}'] }`)
        out = replaceOnce(out, `{ name: '${b.name}', dir: '${b.dir}', needs: ${b.needs} }`,
          `{ name: '${b.name}', dir: '${b.dir}', needs: ['${a.name}'] }`)
        return { source: out, names: [a.name, b.name] }
      },
    },
    {
      id: 'needs-typo',
      label: 'needs 打错一字符（静默删边）',
      must: /needs 里的.+不在 PACKAGES 表内/u,
      mutate: source => {
        const { entries } = readSchedulerTables(source)
        const target = entries.find(entry => entry.needs !== '[]')
        const need = /'([^']+)'/u.exec(target.needs)[1]
        const out = replaceOnce(source, `{ name: '${target.name}', dir: '${target.dir}', needs: ${target.needs} }`,
          `{ name: '${target.name}', dir: '${target.dir}', needs: ${target.needs.replace(`'${need}'`, `'${need}h'`)} }`)
        return { source: out, names: [`${need}h`] }
      },
    },
    {
      id: 'owners-prefix-typo',
      label: 'PATH_OWNERS 前缀打错（check:fast 判 0 个包）',
      must: /PATH_OWNERS 里没有|不在任何 PACKAGES 的 dir 之下/u,
      mutate: source => {
        const { owners } = readSchedulerTables(source)
        const target = owners[0]
        const out = replaceOnce(source, `['${target.prefix}', '${target.name}']`, `['${target.prefix}x', '${target.name}']`)
        return { source: out, names: [`${target.prefix}x`] }
      },
    },
    {
      id: 'owners-name-typo',
      label: 'PATH_OWNERS 包名打错',
      must: /指向不存在的包/u,
      mutate: source => {
        const { owners } = readSchedulerTables(source)
        const target = owners[0]
        const out = replaceOnce(source, `['${target.prefix}', '${target.name}']`, `['${target.prefix}', '${target.name}x']`)
        return { source: out, names: [`${target.name}x`] }
      },
    },
    {
      id: 'owners-entry-missing',
      label: 'PATH_OWNERS 少一条（该包改动归属不到）',
      must: /PATH_OWNERS 里没有/u,
      mutate: source => {
        const { owners } = readSchedulerTables(source)
        const target = owners[0]
        const out = replaceOnce(source, `  ['${target.prefix}', '${target.name}'],\n`, '')
        return { source: out, names: [target.prefix] }
      },
    },
    {
      id: 'owners-nested',
      // 2026-09-23 复审 F2：`PATH_OWNERS` 匹配语义是**先声明者胜**（`find` 取数组序首个），
      // 所以"窄前缀 + 归属另一个包"这种声明无论是死条目还是按顺序翻转归属，都必须判红。
      // 注入形态与复审的 M8 逐字一致：在宽前缀之后**追加**一条窄的、指向另一个包的前缀。
      label: 'PATH_OWNERS 嵌套前缀且归属不同包（先声明者胜 ⇒ 死条目 / 归属按顺序翻转）',
      must: /前缀歧义/u,
      mutate: source => {
        const { owners } = readSchedulerTables(source)
        const wide = owners[0]
        const other = owners.find(owner => owner.name !== wide.name)
        if (other === undefined) throw new Error('PATH_OWNERS 里找不到第二条不同包的条目')
        const narrow = `${wide.prefix}src/`
        const out = replaceOnce(source, `  ['${wide.prefix}', '${wide.name}'],\n`,
          `  ['${wide.prefix}', '${wide.name}'],\n  ['${narrow}', '${other.name}'],\n`)
        return { source: out, names: [narrow, other.name] }
      },
    },
    {
      id: 'dependents-unknown',
      label: 'DEPENDENTS 键打错',
      must: /DEPENDENTS 的键/u,
      mutate: source => {
        const { depKeys } = readSchedulerTables(source)
        const out = replaceOnce(source, `  '${depKeys[0]}': [`, `  '${depKeys[0]}zzz': [`)
        return { source: out, names: [`${depKeys[0]}zzz`] }
      },
    },
    {
      // 2026-09-24 第十轮审计 C-11/F7：两张表**语义脱钩**（单边改表）必须红。
      // 子泳道实测：删掉一条 `DEPENDENTS` 反向条目 ⇒ `--changed` 静默少跑一个包，
      // 而旧判据一行都不新增。注入形态 = 把某条 needs 边 `A → B` 的反向条目里的 `A` 删掉。
      id: 'dependents-missing-edge',
      label: 'DEPENDENTS 少一条反向边（needs 里有、反向表里没有 ⇒ check:fast 静默漏跑）',
      must: /DEPENDENTS\[|DEPENDENTS 里没有/u,
      mutate: source => {
        const { entries, dependents } = readSchedulerTables(source)
        let found = null
        for (const entry of entries) {
          for (const need of [...entry.needs.matchAll(/'([^']+)'/gu)].map(match => match[1])) {
            const dep = dependents.find(candidate => candidate.key === need)
            if (dep !== undefined && dep.values.includes(entry.name)) {
              found = { pkg: entry.name, need, dep }
              break
            }
          }
          if (found !== null) break
        }
        if (found === null) throw new Error('源码里找不到可用于注入的 needs ↔ DEPENDENTS 组合')
        const startMarker = `  '${found.need}': [`
        const start = source.indexOf(startMarker)
        const end = source.indexOf('],', start)
        if (start < 0 || end < 0) throw new Error(`找不到 DEPENDENTS 里 ${found.need} 的条目块`)
        const block = source.slice(start, end + 2)
        const remaining = found.dep.values.filter(value => value !== found.pkg).map(value => `'${value}'`).join(', ')
        return {
          source: replaceOnce(source, block, `  '${found.need}': [${remaining}],`),
          names: [found.need, found.pkg],
        }
      },
    },
  ]

  for (const defect of defects) {
    let mutated
    try {
      mutated = defect.mutate(readFileSync(subject, 'utf8'))
    } catch (error) {
      fail(`调度表自检(${defect.label}): 注入失败 —— ${error.message}`)
      continue
    }
    const { tree } = buildTree({ mutate: () => mutated.source })
    const result = runSynthetic(tree, ['--list'])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 2, `调度表自检(${defect.label}): 必须 exit 2（实际 ${result.status}）：${output.slice(0, 200)}`)
    check(defect.must.test(output), `调度表自检(${defect.label}): 报错必须点名缺陷（${defect.must}），实际 ${JSON.stringify(output.slice(0, 300))}`)
    for (const name of mutated.names) {
      check(output.includes(name), `调度表自检(${defect.label}): 报错必须带出被注入的名字 ${name}`)
    }
    // 反向断言：静态表自检必须发生在**跑任何任务之前**（否则 CI 已经在跑一批无关任务了）。
    check(!result.stdout.includes('个任务'), `调度表自检(${defect.label}): 表坏了就不该继续跑任务，实际 ${result.stdout.slice(0, 120)}`)
  }

  // F2 正例（2026-09-23 复审）：归属**同一个包**的细粒度子前缀不是歧义（两条命中结果
  // 相同）⇒ 必须放行。没有这条，"前缀不得嵌套"会退化成"不许拆细前缀"，把一种合法写法
  // 一并禁掉（而它当前不存在于表里，只能靠合成正例证明边界没有被写宽）。
  {
    const { owners } = readSchedulerTables(readFileSync(subject, 'utf8'))
    const wide = owners[0]
    const mutated = replaceOnce(readFileSync(subject, 'utf8'),
      `  ['${wide.prefix}', '${wide.name}'],\n`,
      `  ['${wide.prefix}', '${wide.name}'],\n  ['${wide.prefix}src/', '${wide.name}'],\n`)
    const { tree } = buildTree({ mutate: () => mutated })
    const result = runSynthetic(tree, ['--list'])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 0,
      `F2(正例): 同一包的细粒度子前缀必须放行（实际 exit=${result.status}）：${output.slice(0, 300)}`)
  }

  // C-1 的**运行时**断言：把静态表自检关掉（模拟"这道网不存在"）后，成环必须由
  // runScheduler 的 pending 断言兜住 —— 旧实现在这里静默 break 并 EXIT=0。
  {
    const mutated = defects[0].mutate(readFileSync(subject, 'utf8'))
    const { tree } = buildTree({
      // 关掉静态表自检（把断言结果写成空数组）⇒ 成环只能靠 runScheduler 的 pending 断言兜住。
      mutate: () => replaceOnce(mutated.source, 'const scheduleProblems = scheduleTableProblems()', 'const scheduleProblems = []'),
    })
    const result = runSynthetic(tree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-1 运行时断言: 成环且静态表自检被关掉时必须 exit 1（实际 ${result.status}）：${output.slice(-300)}`)
    for (const name of mutated.names) {
      check(output.includes(name), `C-1 运行时断言: 必须列出未运行的包 ${name}，实际 ${JSON.stringify(output.slice(-400))}`)
    }
    check(/未运行/u.test(output), `C-1 运行时断言: 必须出现"未运行"标记，实际 ${JSON.stringify(output.slice(-400))}`)
    // 摘要必须能看出"少跑了"：计划数 > 实跑数。
    const summary = /计划 (\d+) \/ 实跑 (\d+) 个任务/u.exec(output)
    check(summary !== null, `C-1 运行时断言: 摘要必须打印「计划 N / 实跑 M」，实际 ${JSON.stringify(output.slice(-200))}`)
    if (summary !== null) {
      check(Number(summary[1]) > Number(summary[2]),
        `C-1 运行时断言: 有包没跑时 计划(${summary[1]}) 必须大于 实跑(${summary[2]})`)
    }
  }

  // C-1 正例：没有注入时摘要必须显示 计划 == 实跑，且 exit 0。
  {
    const { tree } = buildTree()
    const result = runSynthetic(tree, [])
    const summary = /计划 (\d+) \/ 实跑 (\d+) 个任务/u.exec(result.stdout)
    check(result.status === 0, `C-1 正例: 无注入的合成树必须 exit 0（实际 ${result.status}）`)
    check(summary !== null && summary[1] === summary[2],
      `C-1 正例: 无注入时应 计划 == 实跑，实际 ${JSON.stringify(result.stdout.split('\n').find(line => line.startsWith('────')))}`)
  }
}

// ---------------------------------------------------------------------------
// C-8：**通过**的守卫里那些"跳过/降级"行必须进摘要（编排器不得只打 `✓ name 时间`）
//
// 用 corepack 桩模拟"某个守卫通过了、但它说它跳过了一条判据"。负例=同一个桩不打印
// 降级行 ⇒ 摘要里不得出现 `[DEGRADED]`（否则断言可能被噪声满足）。
// ---------------------------------------------------------------------------

{
  const degradedText = '· 跳过：合成守卫软跳过一条判据（probe-cw-degraded）'
  const stubExtra = `case "$*" in\n  *check:layout*) printf '%s\\n' '${degradedText}' ;;\nesac\n`
  const { tree } = buildTree({ stubExtra })
  const result = runSynthetic(tree, [])
  const output = `${result.stdout}${result.stderr}`
  check(result.status === 0, `C-8(正例): 守卫软跳过但退出码为 0 时必须 exit 0（实际 ${result.status}）：${output.slice(-200)}`)
  check(output.includes('[DEGRADED]'), `C-8(正例): 通过的守卫的降级行必须进摘要（缺 [DEGRADED] 段），实际 ${JSON.stringify(output.slice(-400))}`)
  check(output.includes(degradedText), `C-8(正例): 摘要里必须原样出现那条降级行，实际 ${JSON.stringify(output.slice(-400))}`)
  check(/\[DEGRADED\] check:layout: /u.test(output), `C-8(正例): 降级行必须带任务名，实际 ${JSON.stringify(output.slice(-400))}`)

  const clean = buildTree()
  const cleanResult = runSynthetic(clean.tree, [])
  check(!`${cleanResult.stdout}${cleanResult.stderr}`.includes('[DEGRADED]'),
    `C-8(负例): 没有任何降级行时不得打印 [DEGRADED] 段，实际 ${JSON.stringify(cleanResult.stdout.slice(-300))}`)
}

// ---------------------------------------------------------------------------
// F1（2026-09-23 复审）：`[DEGRADED]` 判据的**精度** —— 成功摘要不得被当成降级行
//
// 夹具 = 复审那次全量门禁真实收上来的 **9 行**（逐字取自原始日志
// `temp/verify-guards-final/logs/C-full-check.log` 的 `[DEGRADED]` 段，也就是复审
// 报告 §2-F1 数出来的那 9 行）：**5 行是守卫的成功摘要**被关键词误判，**4 行是真降级**
// （`提示:` / `portable … 不是静默跳过` / `显式 SKIP` / `SKIP 未提供 …`）。
//
// 三条口径说明（免得后人把夹具当"写错的行"改掉）：
//   1. 9 行里 3 行在日志里已被收集器的 200 字符上限截断。夹具**保留日志原样** ——
//      复审数的就是这 9 行，而 `collectDegraded` 存的也是 `text.slice(0, 200)`，两侧一致；
//      排除/纳入谓词只看行首与行中的形态，不依赖被截掉的尾部。
//   2. 这是**分类器的输入快照**，不是守卫文案的对拍：守卫以后改措辞不会让这条用例变红
//      （要钉的是"成功摘要不进摘要"，不是某一句具体的话）。
//   3. 判据是"计数 == 4 且 4 条真阳性逐条在、5 条假阳性逐条不在" —— 只断言"不在"会让
//      "桩没打印任何东西"也算通过（假绿），所以三条一起才有判别力。
// ---------------------------------------------------------------------------
{
  /** `kept` = 必须进 `[DEGRADED]` 段（真降级）；`dropped` = 必须**不**进（成功摘要/规范性表述）。 */
  const fixture = [
    {
      task: 'check:patch-resolutions',
      verdict: 'kept',
      line: 'verify-patch-resolutions: 提示: package.json resolutions["app-builder-lib@26.15.3"]: 只有 exact 键(已豁免:electron-builder 用精确范围 26.15.3 依赖它(yarn.lock 无 ^ 描述符));yarn.lock 里没有 "^" 请求者',
    },
    {
      task: 'check:workflows',
      verdict: 'dropped',
      line: 'docs-only 不得跳过根守卫 / 分类器规则钉死 / 发布面语义判据 / WASM 门禁接线)',
    },
    {
      task: 'check:check-workspaces',
      verdict: 'dropped',
      line: 'verify-check-workspaces: OK — --changed 算不出改动=exit 2、--only 未知/空/被 flag 吃掉=exit 2、有效 --only 真的执行该包、.glitchtip-recon/ 已被忽略、变异体残留守卫的合成正/负例、迁移区间守卫与文档数字守卫的合成正/负例、调度/归属表自检 6 类注入（成环 / needs 打错 / PATH_OWNERS',
    },
    {
      task: 'check:integration-tests',
      verdict: 'dropped',
      line: 'check-integration-tests: 聚合层：三项全 SKIP ⇒ exit 77 / RESULT: SKIP ✓',
    },
    {
      task: 'check:integration-tests',
      verdict: 'dropped',
      line: 'check-integration-tests: OK — 2 个 Python 用例语法通过、1 个 Node 用例语法通过、2 个契约脚本判据自检通过、7 个假网关场景（正例必须绿 / 变异必须红 / 环境缺失必须 SKIP 且不得报 PASS）、electron-shots 的接线与 SKIP(77) 契约、聚合层 run-all.sh 全 SKIP ⇒ 77 且不报 PASS 全部符合预期',
    },
    {
      task: 'check:wasm-client-only',
      verdict: 'kept',
      line: 'portable 模式：只跑与构建产物 / PG / 显示器无关的组。**显式**不在本模式内（不是静默跳过）：',
    },
    {
      task: 'check:wasm-client-only',
      verdict: 'kept',
      line: '== 6. 真实渠道仓 dry-run（可选；未给目录时显式 SKIP，不静默通过）',
    },
    {
      task: 'check:wasm-client-only',
      verdict: 'kept',
      line: 'SKIP 未提供 --channels-repo / WASM_CHANNELS_REPO：跳过真实渠道仓 dry-run（公开仓不持有渠道仓，也不联网）',
    },
    {
      task: 'check:wasm-client-only',
      verdict: 'dropped',
      line: 'PASS 12 ｜ FAIL 0 ｜ SKIP 0 ｜ 绑定文件 temp/wasm-client-only/HEAD-binding.txt',
    },
  ]
  const kept = fixture.filter(entry => entry.verdict === 'kept')
  const dropped = fixture.filter(entry => entry.verdict === 'dropped')
  check(fixture.length === 9 && kept.length === 4 && dropped.length === 5,
    `F1(接线问题): 夹具必须恰好是"9 行 = 4 真阳性 + 5 假阳性"，实际 ${fixture.length}/${kept.length}/${dropped.length}`)

  // 把 9 行按任务塞进 corepack 桩（`$*` = `yarn run <task>`）。单引号包住，避免 shell 展开。
  // 注意：`case` 只会走**第一个**命中的分支 ⇒ 同一任务的几行必须写在同一个分支里
  // （分成多个分支时后面那些永远不打印，"假阳性被排除"就变成了没打印造成的假绿）。
  const shellQuote = value => `'${value.replace(/'/gu, `'\\''`)}'`
  const byTask = new Map()
  for (const entry of fixture) {
    if (!byTask.has(entry.task)) byTask.set(entry.task, [])
    byTask.get(entry.task).push(entry.line)
  }
  const stubExtra = [
    'case "$*" in',
    ...[...byTask].map(([task, lines]) =>
      `  *${task}*) ${lines.map(line => `printf '%s\\n' ${shellQuote(line)}`).join('; ')} ;;`),
    'esac',
    '',
  ].join('\n')
  const { tree } = buildTree({ stubExtra })

  // 夹具自检：桩必须真的为每个任务打印出对应的行。夹具写错（关键词/任务名敲错）会让
  // "假阳性已被排除"变成假绿 —— 这一轮把桩单独跑一遍即可证伪。
  for (const entry of fixture) {
    const emitted = spawnSync('sh', [join(tree, 'bin', 'corepack'), 'yarn', 'run', entry.task], { encoding: 'utf8' })
    check((emitted.stdout ?? '').includes(entry.line),
      `F1(夹具自检): 桩没有为 ${entry.task} 打印夹具行（夹具写错 ⇒ 负例永远通过）：${JSON.stringify(entry.line.slice(0, 60))}…`)
  }

  const result = runSynthetic(tree, [])
  const output = `${result.stdout}${result.stderr}`
  const section = output.split('\n').filter(line => line.startsWith('[DEGRADED] ')).join('\n')
  check(result.status === 0, `F1: 守卫全部通过时必须 exit 0（实际 ${result.status}）：${output.slice(-200)}`)
  check(output.includes(`[DEGRADED] ${kept.length} 条`),
    `F1: 9 行里应恰好有 ${kept.length} 行进摘要（其余 5 行是成功摘要，必须被排除），`
    + `实际 ${JSON.stringify(output.split('\n').filter(line => line.startsWith('[DEGRADED]')).slice(0, 3))}`)
  for (const entry of fixture) {
    // 与 collectDegraded 的存储口径一致（`text.slice(0, 200)`）。
    const stored = entry.line.slice(0, 200)
    if (entry.verdict === 'kept') {
      check(section.includes(`[DEGRADED] ${entry.task}: ${stored}`),
        `F1(真阳性): ${entry.task} 的降级行必须保留进摘要 —— ${JSON.stringify(stored.slice(0, 80))}…；实际 ${JSON.stringify(section.slice(-400))}`)
    } else {
      check(!section.includes(stored),
        `F1(假阳性): ${entry.task} 的成功摘要行不得进摘要 —— ${JSON.stringify(stored.slice(0, 80))}…`)
    }
  }
}

// ---------------------------------------------------------------------------
// C-09 / C-10 / C-15 / C-16（2026-09-24 第十轮审计）：失败详情**必然可见**
//
// 现场（子泳道差分实测，三处变异的新增失败行数都是 **0**）：
//   · C-09 形态 B：判定行预算（150 行）被含 `×` 的**进度噪声**先到先得吃满 ⇒
//     真正的 `AssertionError` 一行不留（`[probe] progress ×N items scanned` 那种行）；
//   · C-09 形态 A：判定行不匹配关键字且落在尾窗之外 ⇒ 一行不留，且输出写着
//     「未匹配到失败标记行」，读者会以为"本来就没有判定行"；
//   · C-10：本文件对「输出截断 / `--full-output` / 失败块标题」**零覆盖** ——
//     把 `summarizeFailure` 掏空、把 `--full-output` 变成死开关，回归网一行都不新增。
//
// 这一段的判据形态是**差分法**（子泳道用的就是它）：受控 emitter 造的合成输出，
// 逐条断言"该看见的行必须出现、不该出现的噪声必须不在判定段里、EXIT / 标题必须如实"。
// 判据全部落在**真实编排器**上（合成树 + corepack 桩），不是对源码做正则。
// ---------------------------------------------------------------------------

/** 把合成树里某个任务的 corepack 桩改造成受控 emitter（只影响匹配到的 argv）。 */
function emitterStub(packageName, body, exitCode = 1) {
  return ['case "$*" in', `  *${packageName}*) ${body}; exit ${exitCode} ;;`, 'esac', ''].join('\n')
}

/** 从摘要行里读四类互斥计数（C-13 的口径判据靠它）。 */
function parseCounts(output) {
  const match = /计划 (\d+) \/ 实跑 (\d+) 个任务:(\d+) 通过、(\d+) 失败、(\d+) 跳过(?:、(\d+) 未运行)?(?:、(\d+) 告警)?/u
    .exec(output)
  if (match === null) return null
  return {
    planned: Number(match[1]),
    ran: Number(match[2]),
    passed: Number(match[3]),
    failed: Number(match[4]),
    skipped: Number(match[5]),
    dropped: Number(match[6] ?? 0),
    advisory: Number(match[7] ?? 0),
  }
}

{
  const pkg = 'dsh-memory-evolve'
  const longBody = [
    'i=0; while [ $i -lt 400 ]; do printf \'[probe] progress ×%s items scanned\\n\' "$i"; i=$((i+1)); done',
    'printf \'AssertionError: expected 1 to be 2\\n\'',
    'i=0; while [ $i -lt 2200 ]; do printf \'filler line %s\\n\' "$i"; i=$((i+1)); done',
  ].join('; ')
  /**
   * 形态 B（C-09 原始现场）：**含 `×` 的进度噪声在前、真断言在中段**。
   * 噪声共 400 行（> 150 行预算）、断言在第 401 行、输出共 2601 行 ⇒ 断言既不在
   * 判定预算的"先到先得"里（旧口径会被噪声吃满），也在尾窗（最后 200 行）之外。
   */
  {
    const { tree: noiseTree } = buildTree({ stubExtra: emitterStub(pkg, longBody, 1) })
    const result = runSynthetic(noiseTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-09(形态B): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    check(output.includes('(输出共'), 'C-09(形态B): 超预算输出必须有截断横幅（接线问题）')
    check(output.includes('AssertionError: expected 1 to be 2'),
      'C-09(形态B): 中段（尾窗之外）的**真判定行**必须出现在摘要里 —— 旧口径会被 150 行进度噪声吃满预算，'
      + `实际输出片段 ${JSON.stringify(output.slice(-600))}`)
    // 判定行必须在"失败相关行"段内（不能只是恰好出现在尾窗里）。
    const verdictSection = output.split('--- 失败相关行')[1]?.split('\n--- ')[0] ?? ''
    check(verdictSection.includes('AssertionError: expected 1 to be 2'),
      `C-09(形态B): 判定行必须在"失败相关行"段内（而不是碰巧落在尾窗），实际 ${JSON.stringify(verdictSection.slice(0, 300))}`)
    check(!verdictSection.includes('items scanned'),
      `C-09(②): 进度噪声不得回显在判定段里（噪声不得占用判定行预算），实际 ${JSON.stringify(verdictSection.slice(0, 300))}`)
  }

  /**
   * 锚定噪声（`× N items scanned` 行首命中）也必须被摘出去、只计数不回显 ——
   * 这是"行内匹配 ⇒ 行首锚定"这条修法的第二半：即使噪声**形态合法**，它也不是判定行。
   */
  {
    const anchoredNoise = [
      'i=0; while [ $i -lt 400 ]; do printf \'× %s items scanned\\n\' "$i"; i=$((i+1)); done',
      'printf \'AssertionError: anchored-noise probe\\n\'',
      'i=0; while [ $i -lt 2200 ]; do printf \'filler line %s\\n\' "$i"; i=$((i+1)); done',
    ].join('; ')
    const { tree: anchoredTree } = buildTree({ stubExtra: emitterStub(pkg, anchoredNoise, 1) })
    const result = runSynthetic(anchoredTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-09(锚定噪声): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    const verdictSection = output.split('--- 失败相关行')[1]?.split('\n--- ')[0] ?? ''
    check(verdictSection.includes('AssertionError: anchored-noise probe'),
      `C-09(锚定噪声): 真断言必须进判定段（噪声不参与预算竞争），实际 ${JSON.stringify(verdictSection.slice(0, 300))}`)
    check(/另有 400 条"进度\/装饰噪声"行/u.test(output),
      `C-09(锚定噪声): 必须如实报出"多少噪声行被排除在判定预算之外"，实际 ${JSON.stringify(output.slice(-500))}`)
  }

  /**
   * **锚定**这一半必须被单独钉住：这些行含 `×` 但**不是**进度计数形态（`VERDICT_NOISE`
   * 不匹配它们），所以"噪声降级"那一半救不了它们 —— 只有行首锚定才能把它们挡在判定预算之外。
   * 旧口径（`(?:^|\s)(?:…|×|…)`）会把它们当判定行：300 行在前 ⇒ 150 行预算全被吃掉 ⇒
   * 第 301 行的真断言一行不留。
   */
  {
    const proseNoise = [
      'i=0; while [ $i -lt 300 ]; do printf \'note: step ×%s done\\n\' "$i"; i=$((i+1)); done',
      'printf \'AssertionError: anchor-only probe\\n\'',
      'i=0; while [ $i -lt 300 ]; do printf \'note: step ×%s done\\n\' "$i"; i=$((i+1)); done',
    ].join('; ')
    const { tree: proseTree } = buildTree({ stubExtra: emitterStub(pkg, proseNoise, 1) })
    const result = runSynthetic(proseTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-09(锚定): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    const verdictSection = output.split('--- 失败相关行')[1]?.split('\n--- ')[0] ?? ''
    check(verdictSection.includes('AssertionError: anchor-only probe'),
      'C-09(①锚定): 行内出现 `×` 的**自由文本**不得算判定行 —— 只有行首锚定才能让第 301 行的真断言'
      + ` 不被 150 行预算吃掉，实际 ${JSON.stringify(verdictSection.slice(0, 300))}`)
    check(!verdictSection.includes('note: step ×'),
      `C-09(①锚定): 自由文本不得占用判定预算，实际 ${JSON.stringify(verdictSection.slice(0, 300))}`)
  }

  /**
   * 形态 A：一条判定行都没锚到 ⇒ **不许静默给空段**，必须 fail-loud 打印「未找到判定行」，
   * 并把未锚定的疑似错误行作为兜底回显（审计现场的那句就在这一档里）。
   */
  {
    const unmatchable = [
      'i=0; while [ $i -lt 1200 ]; do printf \'filler line %s\\n\' "$i"; i=$((i+1)); done',
    ].join('; ')
    const { tree: blankTree } = buildTree({ stubExtra: emitterStub(pkg, unmatchable, 1) })
    const result = runSynthetic(blankTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-09(形态A): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    check(output.includes('未找到判定行'),
      'C-09(形态A/④): 一条判定行都没匹配到时必须 fail-loud 打印「未找到判定行」，不得给空段或让人以为"本来就没有"')
    check(output.includes('--full-output'), 'C-09(形态A/④): 必须给出 `--full-output` 的出路')
    check(!/--- 失败相关行/u.test(output),
      'C-09(形态A/④): 没有判定行时不得打印空的「失败相关行」段（那正是"静默空段"的形态）')

    // 兜底档：未锚定的疑似错误行（审计现场原句）必须被回显出来。
    const fallbackBody = [
      'i=0; while [ $i -lt 1500 ]; do printf \'filler line %s\\n\' "$i"; i=$((i+1)); done',
      'printf \'MUST-SURVIVE-VERDICT: Error: build step aborted at emit.mjs line twelve\\n\'',
      'i=0; while [ $i -lt 1400 ]; do printf \'filler line %s\\n\' "$i"; i=$((i+1)); done',
    ].join('; ')
    const { tree: fallbackTree } = buildTree({ stubExtra: emitterStub(pkg, fallbackBody, 1) })
    const fallbackResult = runSynthetic(fallbackTree, [])
    const fallbackOutput = `${fallbackResult.stdout}${fallbackResult.stderr}`
    check(fallbackResult.status === 1, `C-09(兜底): 目标包失败时门禁必须 exit 1（实际 ${fallbackResult.status}）`)
    check(fallbackOutput.includes('未锚定的"疑似错误行"'),
      `C-09(兜底): 未锚定的疑似错误行必须作为最后一档回显（审计现场那句在第 1501 行），实际 ${JSON.stringify(fallbackOutput.slice(-400))}`)
    check(fallbackOutput.includes('MUST-SURVIVE-VERDICT: Error: build step aborted'),
      'C-09(兜底): 兜底档必须真的把那行打出来（否则形态 A 仍然"一行都没有"）')
  }

  /** `--full-output` 必须真的绕过截断（旧实现里它是个死开关也无人发现 —— C-10）。 */
  {
    const { tree: fullTree } = buildTree({ stubExtra: emitterStub(pkg, longBody, 1) })
    const result = runSynthetic(fullTree, ['--full-output'])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-10(--full-output): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    check(!output.includes('(输出共'),
      `C-10(--full-output): 必须不带截断横幅，实际 ${JSON.stringify(output.slice(0, 200))}`)
    check(output.includes('filler line 2199'),
      'C-10(--full-output): 必须真的打印到输出末尾（第 2600 行附近），否则这个开关是死的')
    check(output.split('\n').length > 1000,
      `C-10(--full-output): 输出行数必须远大于截断体（实际 ${output.split('\n').length} 行）`)
  }

  /** 短输出必须**原样**打印（不许因为加了判定行扫描而改变字节：C-10 的反向负例）。 */
  {
    const shortBody = 'printf \'× suite > case\\n\'; printf \'AssertionError: short probe\\n\'; printf \'one more line\\n\''
    const { tree: shortTree } = buildTree({ stubExtra: emitterStub(pkg, shortBody, 1) })
    const result = runSynthetic(shortTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-10(短输出): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    check(!output.includes('(输出共'), 'C-10(短输出): 短输出不得出现截断横幅/判定段（行为必须与旧版逐字一致）')
    check(output.includes('× suite > case') && output.includes('AssertionError: short probe'),
      `C-10(短输出): 短输出必须原样打印，实际 ${JSON.stringify(output.slice(-400))}`)
  }

  /** C-15：失败块标题必须带**真实**退出码 / 信号（旧文案是字面量「退出码非 0」）。 */
  {
    const { tree: codeTree } = buildTree({ stubExtra: emitterStub(pkg, 'printf \'boom\\n\'', 7) })
    const result = runSynthetic(codeTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-15(退出码): 目标包失败时门禁必须 exit 1（实际 ${result.status}）`)
    check(output.includes(`===== ${pkg} 失败(退出码 7) =====`),
      `C-15(退出码): 失败块标题必须带真实退出码 7，实际 ${JSON.stringify(output.split('\n').filter(line => line.startsWith('=====')).slice(0, 3))}`)
    check(!output.includes('失败(退出码非 0)'),
      'C-15(退出码): 不得再出现字面量「退出码非 0」（那是旧实现丢弃 code 的形态）')
  }
  {
    const { tree: signalTree } = buildTree({ stubExtra: emitterStub(pkg, 'kill -TERM $$', 0) })
    const result = runSynthetic(signalTree, [])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 1, `C-15(信号): 被信号杀死的任务必须让门禁 exit 1（实际 ${result.status}）`)
    check(output.includes(`===== ${pkg} 失败(信号 SIGTERM`),
      `C-15(信号): 信号形态必须如实打印（旧文案分不出 137 与 1），实际 ${JSON.stringify(output.split('\n').filter(line => line.startsWith('=====')).slice(0, 3))}`)
  }

  /**
   * C-13：advisory 失败**不得**被计入"通过"（旧式 `results.length - failed.length` 会让
   * 同一条任务既进"通过"又进"告警"：实测摘要写成「17 通过、0 失败、1 告警」）。
   */
  {
    let mutated
    try {
      mutated = replaceOnce(readFileSync(subject, 'utf8'),
        "{ name: 'check:layout', args: ['run', 'check:layout']",
        "{ advisory: true, name: 'check:layout', args: ['run', 'check:layout']")
      mutated = replaceOnce(mutated, 'const ADVISORY_REGISTRY = []',
        "const ADVISORY_REGISTRY = [\n  { name: 'check:layout', reason: 'C-13 计数口径副本探针',"
        + " approvedBy: 'verify-check-workspaces', expiresOn: '2099-12-31' },\n]")
    } catch (error) {
      fail(`C-13: 注入失败 —— ${error.message}`)
      mutated = null
    }
    if (mutated !== null) {
      const { tree: advisoryTree } = buildTree({
        mutate: () => mutated,
        stubExtra: ['case "$*" in', '  *check:layout*) exit 3 ;;', 'esac', ''].join('\n'),
      })
      const result = runSynthetic(advisoryTree, [])
      const output = `${result.stdout}${result.stderr}`
      check(result.status === 0, `C-13: advisory 失败不拦门禁 ⇒ 必须 exit 0（实际 ${result.status}）：${output.slice(-300)}`)
      const counts = parseCounts(output)
      check(counts !== null, `C-13: 摘要必须能被解析出四类计数，实际 ${JSON.stringify(output.split('\n').find(line => line.startsWith('────')))}`)
      if (counts !== null) {
        check(counts.advisory === 1, `C-13: 必须报出 1 个 advisory（实际 ${counts.advisory}）`)
        check(counts.passed === counts.planned - 1,
          `C-13: advisory 失败**不得**计入"通过" —— 计划 ${counts.planned} 个任务里有 1 个 advisory 失败，`
          + `通过必须为 ${counts.planned - 1}（实际 ${counts.passed}；旧式 results.length - failed.length 会给出 ${counts.planned}）`)
        check(counts.passed + counts.failed + counts.skipped + counts.dropped + counts.advisory === counts.planned,
          `C-13: 四类计数必须恰好覆盖计划数（通过 ${counts.passed} + 失败 ${counts.failed} + 跳过 ${counts.skipped}`
          + ` + 未运行 ${counts.dropped} + 告警 ${counts.advisory} ≠ 计划 ${counts.planned}）`)
      }
      check(output.includes('不算通过'),
        `C-13: 摘要必须显式写明 advisory **不算通过**（口径自洽），实际 ${JSON.stringify(output.split('\n').find(line => line.startsWith('────')))}`)
      check(output.includes('1 个 advisory 任务未通过'),
        'C-13: advisory 失败仍必须进「必须处置」段（只告警不等于静默）')
    }
  }

  /**
   * C-16：`--changed` 零包 + `--no-guards` = 「计划 0 / 实跑 0 + EXIT=0」，与"所有任务都通过"
   * 不可区分。CI 侧由 `[SK-8]` 静态策略钉住，本地面必须至少**显式告警**。
   */
  {
    const { tree: zeroTree } = buildTree()
    mkdirSync(join(zeroTree, 'docs'), { recursive: true })
    writeFileSync(join(zeroTree, 'docs', 'note.md'), '# note\n')
    const result = runSynthetic(zeroTree, ['--changed', 'HEAD', '--no-guards'])
    const output = `${result.stdout}${result.stderr}`
    check(result.status === 0, `C-16: 零包 + --no-guards 仍是 EXIT=0（本地面不改退出码，实际 ${result.status}）`)
    const counts = parseCounts(output)
    check(counts !== null && counts.planned === 0, `C-16: 这条形态必须真的是"计划 0 个任务"，实际 ${JSON.stringify(output.split('\n').find(line => line.startsWith('────')))}`)
    check(output.includes('计划 0 个任务') && output.includes('退出码 0 只说明'),
      `C-16: 零任务必须打印**显式告警**（说明"退出码 0 ≠ 门禁跑过了"），实际 ${JSON.stringify(output.slice(-500))}`)
  }
}

// ---------------------------------------------------------------------------
// C-12/F5（2026-09-24 第十轮审计）：**真实树**的包表语义对拍（合成树夹具覆盖不到的那一半）
//
// 现场：合成树里 `corepack` 是桩、没有任何真实包 ⇒ 「把 `@picoaide/dsh-cron` 从 PACKAGES
// 表里整条删除（整包静默退出门禁）」「把某包的 `script` 字段换掉」两条变异的新增失败行数
// 都是 **0**。这一段把判据从"argv 发出去了"推进到**语义**：包目录/名字/脚本必须真的存在，
// 且磁盘上的每个 workspace 包都必须在表里。
//
// 测法：判据函数 `packageTableProblems(source, treeRoot)` 是纯函数（源码 + 树根 → 问题清单）
// ⇒ ① 真实树必须**零问题**（正控）；② 一棵按真实表搭出来的**合成包树**上做注入，逐条必红。
// ---------------------------------------------------------------------------
{
  const realSource = readFileSync(subject, 'utf8')
  const realProblems = packageTableProblems(realSource, root)
  check(realProblems.length === 0,
    `C-12(正控): 真实树的 PACKAGES 表必须与磁盘一致，实际问题：${realProblems.slice(0, 4).join(' | ')}`)

  // 按真实表搭一棵"包齐全"的合成树（package.json 用真实 name + 真实 script 字段）。
  const pkgTree = tempDir('package-table-tree-')
  writeFileSync(join(pkgTree, 'package.json'),
    `${JSON.stringify({ name: 'synthetic-packages', private: true, workspaces: ['packages/*/*', 'community/*'] }, null, 2)}\n`)
  const realEntries = readPackageEntries(realSource)
  check(realEntries.length >= 10, `C-12(接线问题): 从编排器源码里只读出 ${realEntries.length} 个 PACKAGES 条目`)
  for (const entry of realEntries) {
    mkdirSync(join(pkgTree, entry.dir), { recursive: true })
    writeFileSync(join(pkgTree, entry.dir, 'package.json'),
      `${JSON.stringify({ name: entry.name, version: '0.0.0', scripts: { [entry.script]: 'node noop.mjs' } }, null, 2)}\n`)
  }
  check(packageTableProblems(realSource, pkgTree).length === 0,
    `C-12(接线问题): 按真实表搭出来的合成包树必须零问题，实际 ${packageTableProblems(realSource, pkgTree).slice(0, 3).join(' | ')}`)

  // ① 整包退出门禁（子泳道的 M3 形态）：从表里删掉一个包，磁盘上仍在。
  {
    const victim = realEntries.find(entry => entry.script === 'check') ?? realEntries[0]
    const quoted = victim.needs.map(need => `'${need}'`).join(', ')
    const singleLine = `{ name: '${victim.name}', dir: '${victim.dir}', needs: [${quoted}] }`
    let mutated = null
    try {
      mutated = replaceOnce(realSource, singleLine, '')
    } catch {
      // 多行条目（`script` / `firstWave` 那条）：按 `{` … `},` 的块整体删掉。
      const start = realSource.indexOf(`{\n    name: '${victim.name}'`)
      const end = realSource.indexOf('},', start)
      if (start >= 0 && end > start) mutated = realSource.slice(0, start) + realSource.slice(end + 2)
    }
    check(mutated !== null && mutated !== realSource, `C-12(M3 注入): 没能从 PACKAGES 里删掉 ${victim.name}（注入锚点失效）`)
    if (mutated !== null) {
      const problems = packageTableProblems(mutated, pkgTree)
      check(problems.some(problem => problem.includes(victim.dir)),
        `C-12(M3): 把一个包从 PACKAGES 里整条删掉必须判红（它在磁盘上但不在表里 = 整包静默退出门禁），`
        + `实际 ${JSON.stringify(problems.slice(0, 3))}`)
    }
  }

  // ② `script` 字段写错（子泳道的 M7 形态）：包还在表里，但那个脚本不存在。
  {
    const withScript = realEntries.find(entry => entry.script !== 'check') ?? realEntries[0]
    // 锚点必须带 `dir:` 一起（`script: 'test'` 这种短串在源码注释里也会出现 ⇒ 不唯一）。
    const needle = `dir: '${withScript.dir}',\n    needs: [],\n    script: '${withScript.script}',`
    let mutated = null
    try {
      mutated = replaceOnce(realSource, needle, needle.replace(`script: '${withScript.script}'`, "script: 'definitely-not-a-script'"))
    } catch (error) {
      fail(`C-12(M7 注入): ${error.message}`)
    }
    if (mutated !== null) {
      const problems = packageTableProblems(mutated, pkgTree)
      check(problems.some(problem => problem.includes('definitely-not-a-script')),
        `C-12(M7): 把 script 字段换成一个不存在的脚本必须判红，实际 ${JSON.stringify(problems.slice(0, 3))}`)
    }
  }

  // ③ 目录打错（子泳道的 M8 形态）：这条是既有判据（`--list` 会红），这里保住它。
  {
    const dirVictim = realEntries[0]
    let mutated = null
    try {
      mutated = replaceOnce(realSource, `dir: '${dirVictim.dir}'`, `dir: '${dirVictim.dir}-typo'`)
    } catch (error) {
      fail(`C-12(M8 注入): ${error.message}`)
    }
    if (mutated !== null) {
      const problems = packageTableProblems(mutated, pkgTree)
      check(problems.some(problem => problem.includes(`${dirVictim.dir}-typo`)),
        `C-12(M8): dir 打错必须判红（不存在 + 该包不在表里两条之一），实际 ${JSON.stringify(problems.slice(0, 3))}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 六处形态①④：跨守卫的"缺输入 / 空输入"必须有**具名**判据（合成正/负例）
//
// ① `verify-licenses`（桌面包的许可证守卫）空生产依赖树 ⇒ 旧实现打印
//    `0 production packages carry redistribution-safe licenses` + exit 0 —— 与"逐包查过
//    且全合规"无法区分。现在缺省 fail-loud，唯一豁免入口是显式 `--allow-empty`。
// ④ `verify-patches` 的依赖目标（adm-zip）缺失 ⇒ 旧实现以**未捕获异常栈**结束
//    （退出码对、文案不对）。现在给具名原因 + 处置，退出码保持 1。
//    （`verify-glitchtip-ops-check` 的那一半由它自己的用例驱动：见该文件末尾的
//     "目标缺失必须具名收尾"块。）
// ---------------------------------------------------------------------------

{
  // ① verify-licenses：合成树里放一份脚本副本（脚本按**自身位置**推导包根 ⇒ 必须复制）。
  const licenses = join(root, 'packages', 'host', 'desktop', 'scripts', 'verify-licenses.mjs')
  check(existsSync(licenses), '形态①(接线问题): 找不到 packages/host/desktop/scripts/verify-licenses.mjs')

  const emptyTree = tempDir('verify-licenses-empty-')
  mkdirSync(join(emptyTree, 'scripts'), { recursive: true })
  copyFileSync(licenses, join(emptyTree, 'scripts', 'verify-licenses.mjs'))
  writeFileSync(join(emptyTree, 'package.json'), `${JSON.stringify({ name: 'synthetic-desktop', version: '0.0.0' }, null, 2)}\n`)

  const emptyRun = spawnSync(process.execPath, [join('scripts', 'verify-licenses.mjs')], { cwd: emptyTree, encoding: 'utf8' })
  check(emptyRun.status === 1, `形态①: 空生产依赖树必须 exit 1（实际 ${emptyRun.status}）：${emptyRun.stdout.slice(0, 200)}`)
  check(/no production package was resolved/u.test(emptyRun.stderr),
    `形态①: 必须给出具名原因，实际 ${JSON.stringify(emptyRun.stderr.slice(0, 300))}`)
  check(emptyRun.stderr.includes('--allow-empty'), '形态①: 必须给出显式豁免入口（--allow-empty）')
  check(!/carry redistribution-safe licenses/u.test(emptyRun.stdout),
    '形态①: 空树不得打印"全部合规"式成功行')

  const allowRun = spawnSync(process.execPath, [join('scripts', 'verify-licenses.mjs'), '--allow-empty'], { cwd: emptyTree, encoding: 'utf8' })
  check(allowRun.status === 0, `形态①: --allow-empty 必须放行（实际 ${allowRun.status}）：${allowRun.stderr.slice(0, 200)}`)

  // 正例：一棵真的有一个 MIT 依赖的树必须绿（防"一律判红"的假修复）。
  const realTree = tempDir('verify-licenses-nonempty-')
  mkdirSync(join(realTree, 'scripts'), { recursive: true })
  mkdirSync(join(realTree, 'node_modules', 'left-pad'), { recursive: true })
  copyFileSync(licenses, join(realTree, 'scripts', 'verify-licenses.mjs'))
  writeFileSync(join(realTree, 'package.json'),
    `${JSON.stringify({ name: 'synthetic-desktop', version: '0.0.0', dependencies: { 'left-pad': '1.0.0' } }, null, 2)}\n`)
  writeFileSync(join(realTree, 'node_modules', 'left-pad', 'package.json'),
    `${JSON.stringify({ name: 'left-pad', version: '1.0.0', license: 'MIT' }, null, 2)}\n`)
  const realRun = spawnSync(process.execPath, [join('scripts', 'verify-licenses.mjs')], { cwd: realTree, encoding: 'utf8' })
  check(realRun.status === 0, `形态①(正例): 一个 MIT 依赖的树必须绿（实际 ${realRun.status}）：${realRun.stderr.slice(0, 200)}`)
  check(realRun.stdout.includes('1 production packages'), `形态①(正例): 摘要必须报出检查到的包数，实际 ${JSON.stringify(realRun.stdout.slice(0, 200))}`)

  // ④ verify-patches：依赖目标（adm-zip）解析不到时必须具名收尾。
  const patchesTree = tempDir('verify-patches-nodep-')
  mkdirSync(join(patchesTree, 'scripts'), { recursive: true })
  for (const file of ['verify-patches.mjs', 'patch-copy-scan.mjs']) {
    copyFileSync(join(root, 'scripts', file), join(patchesTree, 'scripts', file))
  }
  copyFileSync(join(root, 'scripts', 'patch-targets.mjs'), join(patchesTree, 'scripts', 'patch-targets.mjs'))
  writeFileSync(join(patchesTree, 'package.json'), `${JSON.stringify({ name: 'synthetic', version: '0.0.0', resolutions: {} }, null, 2)}\n`)
  const patchesRun = spawnSync(process.execPath, [join('scripts', 'verify-patches.mjs')], { cwd: patchesTree, encoding: 'utf8' })
  const patchesOutput = `${patchesRun.stdout}${patchesRun.stderr}`
  check(patchesRun.status === 1, `形态④: 依赖目标缺失必须 exit 1（退出码保持不变，实际 ${patchesRun.status}）`)
  check(patchesOutput.includes('缺少解压 yarn cache 的依赖目标'),
    `形态④: 必须给出具名原因，实际 ${JSON.stringify(patchesOutput.slice(0, 300))}`)
  check(!/^\s+at .*\(node:/mu.test(patchesOutput), `形态④: 不得以未捕获异常栈收尾，实际 ${JSON.stringify(patchesOutput.slice(0, 300))}`)
}

/**
 * 从 `check-root-guards.mjs` 的源码里解析 `REGISTERED_GUARD_ENTRIES`（**只读**别人的文件）。
 *
 * 契约（2026-09-24 主控协调的 F1 ↔ F2 接缝）：F1 泳道给每个条目加一个
 * `digest: '<sha256 hex>'` 字段。本函数**容忍**取值形态（可带 `sha256:` 前缀、大小写任意），
 * 但 `digest` 字段**缺失**一律 fail-loud（见下面的判据）—— 因为"没有摘要"正是 C-06 的现场：
 * 登记只到路径一级，把守卫脚本内容掏空或换成同名符号链接之后运行器照报 `✓`。
 * @param source - `scripts/check-root-guards.mjs` 的源码文本。
 * @returns `[{ name, script, digest }]`（`digest` 为 `null` 表示字段缺失）。
 */
function parseRegisteredGuardEntries(source) {
  const anchor = source.indexOf('const REGISTERED_GUARD_ENTRIES = new Map([')
  if (anchor < 0) return null
  const end = source.indexOf('\n])', anchor)
  if (end < 0) return null
  const block = source.slice(anchor, end)
  return [...block.matchAll(/\['([^']+)',\s*\{([\s\S]*?)\}\]/gu)].map(match => {
    const body = match[2]
    const digestRaw = /digest:\s*'([^']*)'/u.exec(body)?.[1] ?? null
    return {
      name: match[1],
      script: /script:\s*'([^']+)'/u.exec(body)?.[1] ?? null,
      digest: digestRaw === null ? null : digestRaw.trim().replace(/^sha256:/iu, '').toLowerCase(),
    }
  })
}

/** `node scripts/x.mjs` / `bash scripts/x.sh` → `scripts/x.mjs`（登记表里只有这两种形态）。 */
function guardScriptPath(script) {
  const match = /^(?:node|bash)\s+(\S+)$/u.exec(script ?? '')
  return match === null ? null : match[1]
}

/** 文件的 sha256（十六进制小写）；读不到返回 null。 */
function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 接线：本门禁必须在 package.json 与 GUARDS 表里都登记（否则等于没接）
// ---------------------------------------------------------------------------

{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    pkg.scripts?.['check:check-workspaces'] === 'node scripts/verify-check-workspaces.mjs',
    `接线: package.json 的 check:check-workspaces 必须指向本文件，实际 ${JSON.stringify(pkg.scripts?.['check:check-workspaces'])}`,
  )
  const list = spawnSync(process.execPath, [subject, '--list'], { cwd: root, encoding: 'utf8' })
  check(list.status === 0, `接线: check-workspaces --list 应 exit 0(实际 ${list.status}: ${list.stderr.slice(0, 200)})`)
  const listLines = (list.stdout ?? '').split('\n')
  const guardLine = listLines.find(line => line.startsWith('guards: ')) ?? ''
  const advisoryLine = listLines.find(line => line.startsWith('guards(advisory,只告警不拦门禁): ')) ?? ''
  const registryLine = listLines.find(line => line.startsWith('guards(advisory 登记制): ')) ?? ''
  const guardNames = guardLine.replace('guards: ', '').split(',').map(name => name.trim()).filter(Boolean)
  const advisoryNames = advisoryLine.replace('guards(advisory,只告警不拦门禁): ', '')
    .split(',').map(name => name.trim()).filter(Boolean)
  /**
   * 下限判据 = 守卫**在表里** 且 **不是 advisory**（2026-09-23 第六轮审计 R6-C-1）。
   *
   * 旧口径只断言"在表里"，于是给条目加一个 `advisory: true` 就能让这条下限变成
   * "它在表里、但它不拦门禁" —— 下限形同虚设（这正是被审出来的红→绿开关）。
   */
  const blockingGuard = name => guardNames.includes(name) && !advisoryNames.includes(name)
  check(
    advisoryNames.length === 0 || registryLine !== '',
    '接线: 存在 advisory 守卫时 `--list` 必须同时打印登记表那一行（登记制是 advisory 的判据面）',
  )
  check(
    blockingGuard('check:check-workspaces'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:check-workspaces **且它不得是 advisory**`
      + `（advisory=${JSON.stringify(advisoryNames)},实际 ${JSON.stringify(guardLine)}）`,
  )
  // 2026-09-20：变异体残留守卫必须同样双重登记（package.json + GUARDS）——
  // 少任何一处都等于「事故防线没接上」，而它防的正是"红的变异体进提交"。
  check(
    pkg.scripts?.['check:no-leftover-mutants'] === 'node scripts/check-no-leftover-mutants.mjs',
    `接线: package.json 的 check:no-leftover-mutants 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:no-leftover-mutants'])}`,
  )
  check(
    blockingGuard('check:no-leftover-mutants'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:no-leftover-mutants **且它不得是 advisory**，实际 ${JSON.stringify(guardLine)}`,
  )
  check(
    pkg.scripts?.['check:migration-range'] === 'node scripts/check-migration-range.mjs',
    `接线: package.json 的 check:migration-range 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:migration-range'])}`,
  )
  check(
    blockingGuard('check:migration-range'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:migration-range **且它不得是 advisory**，实际 ${JSON.stringify(guardLine)}`,
  )
  // 2026-09-23：文档数字守卫（D-4 上游 pin / D-5 平台模块表）同样双重登记。
  check(
    pkg.scripts?.['check:doc-claims'] === 'node scripts/check-doc-claims.mjs',
    `接线: package.json 的 check:doc-claims 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:doc-claims'])}`,
  )
  check(
    blockingGuard('check:doc-claims'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:doc-claims **且它不得是 advisory**，实际 ${JSON.stringify(guardLine)}`,
  )
  // 2026-09-23 三轮审计 C-5 / 六处形态③⑤⑥：域名守卫、集成测试守卫同样必须双重登记
  // —— "写了用例但没人执行"等同于没有覆盖（本仓已记录过的缺陷类）。
  check(
    pkg.scripts?.['check:no-real-domains'] === 'node scripts/check-no-real-domains.mjs',
    `接线: package.json 的 check:no-real-domains 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:no-real-domains'])}`,
  )
  check(
    blockingGuard('check:no-real-domains'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:no-real-domains（含 --others 扫描面与空扫描面判据）`
      + ` **且它不得是 advisory**（铁律 0 的第一道机器防线），实际 ${JSON.stringify(guardLine)}`,
  )
  check(
    pkg.scripts?.['check:integration-tests'] === 'node scripts/check-integration-tests.mjs',
    `接线: package.json 的 check:integration-tests 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:integration-tests'])}`,
  )
  check(
    blockingGuard('check:integration-tests'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:integration-tests（electron-shots 的接线/SKIP 判据挂在它上面）`
      + ` **且它不得是 advisory**，实际 ${JSON.stringify(guardLine)}`,
  )

  // -------------------------------------------------------------------------
  // **全部 16 条**根守卫的逐字登记（2026-09-25 第九轮审计 B 泳道 P1-5 的第二判据）。
  //
  // 现场：上面那几条只把 **6 条**守卫钉到了具体脚本文件，其余 10 条（含 `check:workflows`
  // 自己、`check:ci-scripts`、`check:inventories`、`check:patches`…）**没有第二判据** ——
  // 把 `package.json` 里任意一条的脚本体换成另一个"能通过"的守卫（名字、argv、
  // 形态三者全对），`check-root-guards.mjs` 会照报 `✓ <名字>`，而这一条门禁看不出区别。
  // 实测：正在失败的 `check:theme-tokens` 被重定向到 `node scripts/check-workflows.mjs`
  // 之后转绿，输出仍是「16 个根守卫：16 通过」。
  //
  // 这张表**刻意独立写一份**（不 import `check-root-guards.mjs` 的
  // `REGISTERED_GUARD_ENTRIES`）：第二判据的价值就是"两处同时被改才会静默"，导入等于把
  // 两个判据合并成一个。两侧还各自对拍编排器表（成员身份 + 非 advisory）。
  // -------------------------------------------------------------------------
  const REGISTERED_GUARD_SCRIPTS = new Map([
    ['check:layout', 'node scripts/verify-layout.mjs'],
    ['check:workflows', 'node scripts/check-workflows.mjs'],
    ['check:ci-scripts', 'node scripts/verify-ci-scripts.mjs'],
    ['check:patch-resolutions', 'node scripts/verify-patch-resolutions.mjs'],
    ['check:patch-pin', 'node scripts/check-patch-pin.mjs'],
    ['check:patches', 'node scripts/verify-patches.mjs'],
    ['check:inventories', 'node scripts/verify-inventories.mjs'],
    ['check:theme-tokens', 'node scripts/check-theme-tokens.mjs'],
    ['check:glitchtip', 'node scripts/verify-glitchtip-ops-check.mjs'],
    ['check:check-workspaces', 'node scripts/verify-check-workspaces.mjs'],
    ['check:no-leftover-mutants', 'node scripts/check-no-leftover-mutants.mjs'],
    ['check:migration-range', 'node scripts/check-migration-range.mjs'],
    ['check:doc-claims', 'node scripts/check-doc-claims.mjs'],
    ['check:no-real-domains', 'node scripts/check-no-real-domains.mjs'],
    ['check:wasm-client-only', 'bash scripts/verify-wasm-client-only.sh'],
    ['check:integration-tests', 'node scripts/check-integration-tests.mjs'],
    // 2026-09-24 第十轮审计 C-06（P2）：F1 泳道新增的守卫 —— 它把「守卫脚本的**内容**」
    // 也变成判据（`digest` = sha256）。本表是**第二份独立登记**（不是 import F1 的表），
    // 两处同时被改才会静默；下面还有一条独立的"复算摘要对拍"。
    ['check:guard-parser-integrity', 'node scripts/check-guard-parser-integrity.mjs'],
  ])
  const listedGuards = new Set([...guardNames, ...advisoryNames])
  for (const [name, script] of REGISTERED_GUARD_SCRIPTS) {
    check(
      pkg.scripts?.[name] === script,
      `接线: package.json 的 ${name} 必须**逐字**等于 ${JSON.stringify(script)}`
        + `（实际 ${JSON.stringify(pkg.scripts?.[name])}）—— "跑一个脚本"这个形态不够，`
        + '必须是那一个：重定向到别的守卫时名字与 argv 都不动，运行器照报 `✓` 而判据一次没跑',
    )
    check(
      blockingGuard(name),
      `接线: check-workspaces 的 GUARDS 表必须包含 ${name} **且它不得是 advisory**，实际 ${JSON.stringify(guardLine)}`,
    )
  }
  // 双向：编排器表里出现却没登记的守卫同样红（新守卫必须登记进这张表 + 根守卫运行器的表）。
  const unregisteredGuards = [...listedGuards].filter(name => !REGISTERED_GUARD_SCRIPTS.has(name))
  check(
    unregisteredGuards.length === 0,
    `接线: 编排器表里的这些守卫没有登记脚本路径：${unregisteredGuards.join(', ')}`
      + ' ⇒ 新增根守卫必须同时登记进本文件的 REGISTERED_GUARD_SCRIPTS 与 '
      + 'scripts/check-root-guards.mjs 的 REGISTERED_GUARD_ENTRIES（两张表独立对拍才有意义）',
  )

  // -------------------------------------------------------------------------
  // C-06（2026-09-24 第十轮审计 P2）：登记表止步于**路径**，脚本**内容**没有判据。
  //
  // 现场（副本实测）：把已登记的 `scripts/check-theme-tokens.mjs` 内容整体换成
  // `process.exit(0)`（或换成同名符号链接 → 另一个能通过的守卫）之后，
  // `check-root-guards.mjs` 照报「16 个根守卫：8 通过」，`✓ check:theme-tokens`；
  // 而本文件对这次替换的命中数是 **0**（两份登记表都只比 `script` 字符串）。
  //
  // 判据（**只读** F1 的文件，不改它）：读 `check-root-guards.mjs` 的
  // `REGISTERED_GUARD_ENTRIES` → 逐条拿 `script` 路径 → 复算真实脚本的 sha256 →
  // 与登记项里的 `digest` 对拍；同时断言路径不是**符号链接**（`lstatSync`）。
  //
  // ⚠️ `digest` 字段缺失 = **红**（fail-loud）：那正是"判据缺一颗牙"的形态，
  // 而不是"这条判据不适用"。真要看摘要：`node scripts/verify-check-workspaces.mjs`
  // 会打印每条守卫的 `path=… sha256=…`，把它填进 F1 的表即可（摘要进 diff 才算评审面）。
  // -------------------------------------------------------------------------
  {
    const rootGuardsSource = readFileSync(join(root, 'scripts', 'check-root-guards.mjs'), 'utf8')
    const registered = parseRegisteredGuardEntries(rootGuardsSource)
    check(registered !== null,
      'C-06(接线问题): 解析不出 check-root-guards.mjs 的 REGISTERED_GUARD_ENTRIES —— 本判据的锚点失效，'
      + '请同步 parseRegisteredGuardEntries（不要直接删掉这段）')
    if (registered !== null) {
      check(registered.length >= REGISTERED_GUARD_SCRIPTS.size,
        `C-06(接线问题): F1 的登记表只有 ${registered.length} 条，少于本文件的独立登记表 ${REGISTERED_GUARD_SCRIPTS.size} 条`)
      const registeredNames = new Set(registered.map(entry => entry.name))
      const registeredScripts = new Map(registered.map(entry => [entry.name, entry.script]))
      // 两张独立登记表必须一致（名字集合 + 脚本体逐字）。
      const missingHere = registered.filter(entry => !REGISTERED_GUARD_SCRIPTS.has(entry.name)).map(entry => entry.name)
      check(missingHere.length === 0,
        `C-06: F1 登记表里有本文件未登记的守卫：${missingHere.join(', ')} ⇒ 两处同时被改才会静默，别让它们漂移`)
      const missingThere = [...REGISTERED_GUARD_SCRIPTS.keys()].filter(name => !registeredNames.has(name))
      check(missingThere.length === 0,
        `C-06: 本文件登记了但 F1 的 REGISTERED_GUARD_ENTRIES 里没有：${missingThere.join(', ')}`)
      const scriptMismatch = [...REGISTERED_GUARD_SCRIPTS]
        .filter(([name, script]) => registeredScripts.has(name) && registeredScripts.get(name) !== script)
      check(scriptMismatch.length === 0,
        `C-06: 两份登记表的脚本体不一致：${scriptMismatch.map(([name, script]) => `${name} 本文件=${JSON.stringify(script)} F1=${JSON.stringify(registeredScripts.get(name))}`).join('；')}`)
      const digestMissing = registered.filter(entry => entry.digest === null).map(entry => entry.name)
      check(digestMissing.length === 0,
        `C-06: check-root-guards.mjs 的登记表里这些条目**没有内容摘要字段**（\`digest\`）：${digestMissing.join(', ')}`
        + ' ⇒ 登记只到路径一级：把守卫脚本内容掏空（`process.exit(0)`）或换成同名符号链接之后，'
        + '运行器照报 `✓ <名字>`，两条门禁都看不出区别（C-06 的两种实做形态）。'
        + ' 请在 F1 侧的 REGISTERED_GUARD_ENTRIES 每个条目上补 `digest`（脚本 sha256）；'
        + '本文件会打印每条守卫的 path/sha256 供填入。')
      let verified = 0
      for (const entry of registered) {
        const relativePath = guardScriptPath(entry.script)
        if (relativePath === null) {
          check(false, `C-06: ${entry.name} 的 script 形态不认得（${JSON.stringify(entry.script)}）—— 登记表只允许 \`node <file>\` / \`bash <file>\``)
          continue
        }
        const scriptPath = join(root, relativePath)
        if (!existsSync(scriptPath)) {
          check(false, `C-06: ${entry.name} 登记的脚本 ${relativePath} 不存在`)
          continue
        }
        // 符号链接形态（C-06 的 C2）：`lstat` 看的就是 inode 本身。
        check(!lstatSync(scriptPath).isSymbolicLink(),
          `C-06: ${entry.name} 的脚本 ${relativePath} 是**符号链接** —— 判据读的是名字、执行的是 inode 指向的字节；`
          + '守卫脚本必须是真的普通文件（替换成链接后运行器照报 `✓`）')
        const actual = sha256File(scriptPath)
        if (entry.digest === null) continue
        // 占位符（不是 64 位 hex）也要说清楚：F1 落盘时的中间态最容易被误读成"内容被换过"。
        const placeholder = !/^[0-9a-f]{64}$/u.test(entry.digest)
        check(actual === entry.digest,
          `C-06: ${entry.name} 的脚本内容摘要与登记值不符（${relativePath}）：`
          + `登记 ${entry.digest} / 实际 ${actual}`
          + `${placeholder ? '（登记值不是 64 位小写 hex ⇒ 看起来还是占位符，需要用真实摘要替换）' : ''}`
          + ' —— 掏空或替换守卫脚本必须进 diff（这就是本判据的意义）。'
          + ` 确认本次改动是有意的之后，把 F1 表里的 \`digest\` 更新为 ${actual}。`)
        verified += 1
        console.log(`verify-check-workspaces: C-06 摘要对拍 ${entry.name} path=${relativePath} sha256=${actual} ✓`)
      }
      check(verified === registered.length,
        `C-06: 只对拍成功 ${verified}/${registered.length} 条守卫摘要（缺 digest 的条目见上一条）`)
    }
  }

  // -------------------------------------------------------------------------
  // advisory **登记制**的第二条独立通道（2026-09-23 第六轮审计 R6-C-1）。
  //
  // 现场：`advisory: true` 曾是一个无判据的红→绿开关 —— `check-workspaces --list`、
  // `check-root-guards --list` 都照旧绿，而两条门禁路径同时不再因该守卫失败。
  //
  // 这里做**三方差集对拍**（任一侧漂移都红）：
  //   ① 编排器 `--list` 的 advisory 集合；
  //   ② `check-root-guards.mjs --list`（**它自己独立解析 `ADVISORY_REGISTRY`**）的 advisory 集合；
  //   ③ `--list` 打印的登记表行（`guards(advisory 登记制): …`）。
  // 并用**副本**证明这三条判据真的会咬：给 check:no-real-domains 加 `advisory: true`
  // ⇒ 编排器副本必须 exit 2、根守卫副本必须 exit 2（后者正是 docs-only 的 PR 唯一防线）。
  // -------------------------------------------------------------------------
  {
    const rootGuardsPath = join(root, 'scripts', 'check-root-guards.mjs')
    const rootGuardsList = spawnSync(process.execPath, [rootGuardsPath, '--list'], { cwd: root, encoding: 'utf8' })
    check(rootGuardsList.status === 0,
      `R6-C-1: check-root-guards --list 应 exit 0(实际 ${rootGuardsList.status}: ${rootGuardsList.stderr.slice(0, 300)})`)
    const rootGuardsLines = (rootGuardsList.stdout ?? '').split('\n')
    const rootGuardAdvisories = rootGuardsLines.filter(line => line.includes('（advisory）'))
      .map(line => line.trim().split(/\s+/u)[0]).filter(Boolean).sort()
    check(
      rootGuardAdvisories.join(',') === [...advisoryNames].sort().join(','),
      'R6-C-1: 编排器 `--list` 与 `check-root-guards --list` 的 advisory 集合必须一致'
        + `（编排器 ${JSON.stringify(advisoryNames)} / 根守卫 ${JSON.stringify(rootGuardAdvisories)}）`,
    )
    const registryCountLine = rootGuardsLines.find(line => line.includes('advisory 登记 ')) ?? ''
    const registryCount = Number(/advisory 登记 (\d+) 条/u.exec(registryCountLine)?.[1] ?? NaN)
    check(Number.isSafeInteger(registryCount),
      `R6-C-1: check-root-guards --list 必须报出 advisory 登记条数（诊断行缺失 ⇒ 登记表解析链路断了）：`
        + `实际 ${JSON.stringify(registryCountLine)}`)
    check(registryCount === advisoryNames.length,
      `R6-C-1: 登记的 advisory 条数（${registryCount}）必须等于实际 advisory 守卫数（${advisoryNames.length}）`
        + ' —— 未登记的 advisory 与陈旧登记都是配置错误',
    )
    check(
      registryLine !== '' && (advisoryNames.length === 0) === registryLine.includes('无（每条守卫都必须拦门禁）'),
      `R6-C-1: \`--list\` 的登记表行必须与实际 advisory 集合同源，实际 ${JSON.stringify(registryLine)}`,
    )

    // **副本红探针**：把某个真实守卫标成 advisory ⇒ 两条路径都必须红（而且必须是
    // "配置错误"那种红 —— 退出码 2，不是把它当普通失败吞掉）。
    const RED_PROBE_MUTATION = (source, guardName) => {
      const needle = `{ name: '${guardName}', args: ['run', '${guardName}']`
      if (!source.includes(needle)) return null
      return source.replace(needle, needle.replace('{ name:', "{ advisory: true, name:"))
    }
    for (const guardName of ['check:no-real-domains', 'check:migration-range']) {
      const mutatedSource = RED_PROBE_MUTATION(readFileSync(subject, 'utf8'), guardName)
      check(mutatedSource !== null,
        `R6-C-1(探针锚点): 在编排器源码里找不到 ${guardName} 的条目锚点 —— 本探针的形状变了，请同步（不要删掉这段）`)
      if (mutatedSource === null) continue
      const probeTree = tempDir('advisory-probe-')
      mkdirSync(join(probeTree, 'scripts'))
      writeFileSync(join(probeTree, 'scripts', 'check-workspaces.mjs'), mutatedSource)
      copyFileSync(rootGuardsPath, join(probeTree, 'scripts', 'check-root-guards.mjs'))
      writeFileSync(join(probeTree, 'package.json'),
        // 脚本体必须写**真实登记值**（第九轮审计 B 泳道 P1-5 之后 `check-root-guards.mjs`
        // 会把脚本体与登记值逐字对拍）：`node scripts/noop.mjs` 这种替身会让"正控必须 exit 0"
        // 被那条**与本探针无关**的判据染红，探针就测不到自己那条（假红）。
        `${JSON.stringify({
          name: 'advisory-probe',
          private: true,
          scripts: { [guardName]: pkg.scripts?.[guardName] ?? 'node scripts/noop.mjs' },
        }, null, 2)}\n`)
      const orchestratorProbe = spawnSync(process.execPath, [join(probeTree, 'scripts', 'check-workspaces.mjs'), '--list'],
        { cwd: probeTree, encoding: 'utf8' })
      check(orchestratorProbe.status === 2,
        `R6-C-1: 把 ${guardName} 标成 advisory（未登记）之后编排器**必须 exit 2**（配置错误），`
          + `实际 ${orchestratorProbe.status}：${`${orchestratorProbe.stdout ?? ''}${orchestratorProbe.stderr ?? ''}`.slice(0, 300)}`)
      check(`${orchestratorProbe.stderr ?? ''}`.includes('ADVISORY_REGISTRY'),
        `R6-C-1: 未登记 advisory 的失败信息必须点名 ADVISORY_REGISTRY，实际 ${JSON.stringify((orchestratorProbe.stderr ?? '').slice(0, 200))}`)
      const rootGuardsProbe = spawnSync(process.execPath, [join(probeTree, 'scripts', 'check-root-guards.mjs'), '--list'],
        { cwd: probeTree, encoding: 'utf8' })
      check(rootGuardsProbe.status === 2,
        `R6-C-1: 同一次变异下 check-root-guards（docs-only PR 的唯一防线）**必须 exit 2**，`
          + `实际 ${rootGuardsProbe.status}：${`${rootGuardsProbe.stdout ?? ''}${rootGuardsProbe.stderr ?? ''}`.slice(0, 300)}`)
      console.log(`verify-check-workspaces: R6-C-1 未登记 advisory（${guardName}）⇒ 编排器与根守卫均 exit 2 ✓`)
    }

    // -----------------------------------------------------------------------
    // advisory 到期日**格式**判据（第六轮独立复审 V2 边界② / C-N1）。
    //
    // 现场：`expiresOn` 只被要求"是字符串"，到期比较写成
    // `if (!Number.isNaN(Date.parse(entry.expiresOn ?? '')) && …)` ⇒ 不可解析的取值被
    // **静默跳过**。登记项写 `expiresOn: 'whenever'` + 把一个非下限守卫标成 advisory，
    // 两条通道都 EXIT=0 —— "到期即失效"这条语义被一个乱字符串绕过（判据缺一颗牙）。
    //
    // 自检样本（三个非法取值必须在**编排器**这条通道上 exit 2，且失败信息点名 `expiresOn`）：
    //   · `'whenever'`   —— 形状非法（旧实现静默跳过的那一档）；
    //   · `'2026-13-45'` —— 形状合法但越界（`Date.parse` 为 NaN）；
    //   · `''`           —— 空串（"缺字段"那一档，语义同样是"没有可用的到期日"）。
    // 再加一个**正控**（`'2099-12-31'`，编排器必须 exit 0）：没有它，"探针恒红"
    // （比如注入本身把树弄坏了）也会让上面三条断言全部通过 —— 那是假绿。
    //
    // 变异：把编排器里的格式校验去掉 ⇒ 三个非法样本不再 exit 2 ⇒ 本段必红。
    //
    // **已认账的残余（范围限制，2026-09-23）**：`check-root-guards.mjs` 按源码文本解析
    // 登记表，但**不校验字段值**（`reason`/`approvedBy`/`expiresOn` 都只判在不在），
    // 本次范围不允许改该脚本 ⇒ 乱取值在那条通道上仍是 EXIT=0。影响面有限：该通道的
    // advisory **默认照样拦门禁**（只有显式 `--allow-advisory` 才降级，docs-only 的 CI
    // 路径不传），所以"到期即失效"被绕过的实际后果集中在编排器侧，而那一侧已经堵上。
    // 补法是一行：在 `parseAdvisoryRegistry` 之后拒绝非法 `expiresOn`（与
    // `check-workspaces.mjs` 的 `isAdvisoryExpiresOn` 同源）。
    // -----------------------------------------------------------------------
    {
      /**
       * 把编排器源码改成「`check:glitchtip` 标 advisory + 登记项带指定 `expiresOn`」。
       * 到期日用**单引号**字面量（根守卫是按源码文本解析登记表的：`expiresOn:\s*'…'`），
       * 这样 `''` 样本在两条通道上看到的都是"空串"而不是"字段缺失"。
       * @param source - 编排器源码。
       * @param expiresOn - 样本取值（本段的三个非法值 + 一个正控，均不含单引号）。
       * @returns 变异后的源码；锚点不在时返回 null（fail-loud，不静默跳过）。
       */
      const EXPIRY_PROBE_MUTATION = (source, expiresOn) => {
        if (expiresOn.includes("'")) return null
        const needle = "{ name: 'check:glitchtip', args: ['run', 'check:glitchtip']"
        const registry = 'const ADVISORY_REGISTRY = []'
        if (!source.includes(needle) || !source.includes(registry)) return null
        return source
          .replace(needle, "{ advisory: true, name: 'check:glitchtip', args: ['run', 'check:glitchtip']")
          .replace(registry, 'const ADVISORY_REGISTRY = [\n'
            + '  { name: \'check:glitchtip\', reason: \'R6-C-1 到期日格式副本探针\', '
            + `approvedBy: 'verify-check-workspaces', expiresOn: '${expiresOn}' },\n`
            + ']')
      }
      const EXPIRY_SAMPLES = [
        { value: 'whenever', legal: false },
        { value: '2026-13-45', legal: false },
        { value: '', legal: false },
        { value: '2099-12-31', legal: true },
      ]
      for (const sample of EXPIRY_SAMPLES) {
        const mutatedSource = EXPIRY_PROBE_MUTATION(readFileSync(subject, 'utf8'), sample.value)
        check(mutatedSource !== null,
          'R6-C-1(到期日探针锚点): 在编排器源码里找不到 check:glitchtip 的条目锚点或 `const ADVISORY_REGISTRY = []`'
            + ' —— 本探针的形状变了，请同步（不要删掉这段）')
        if (mutatedSource === null) continue
        const probeTree = tempDir('advisory-expiry-probe-')
        mkdirSync(join(probeTree, 'scripts'))
        writeFileSync(join(probeTree, 'scripts', 'check-workspaces.mjs'), mutatedSource)
        copyFileSync(rootGuardsPath, join(probeTree, 'scripts', 'check-root-guards.mjs'))
        writeFileSync(join(probeTree, 'package.json'),
          // 根守卫还会断言"表里的守卫都必须是**这棵树**的 package.json scripts" ⇒ 合成树要把
          // 真表的守卫名全登记上，否则正控（必须 exit 0）会被那条无关判据染红。
          // 取值用**真实登记值**（同上：脚本体要逐字等于 `REGISTERED_GUARD_ENTRIES`）。
          `${JSON.stringify({
            name: 'advisory-expiry-probe',
            private: true,
            scripts: Object.fromEntries(guardNames.map(name => [name, pkg.scripts?.[name] ?? 'node scripts/noop.mjs'])),
          }, null, 2)}\n`)
        const expected = sample.legal ? 0 : 2
        const label = `expiresOn=${JSON.stringify(sample.value)}`
        const orchestratorProbe = spawnSync(process.execPath, [join(probeTree, 'scripts', 'check-workspaces.mjs'), '--list'],
          { cwd: probeTree, encoding: 'utf8' })
        check(orchestratorProbe.status === expected,
          `R6-C-1(到期日): ${label} 时编排器必须 exit ${expected}，实际 ${orchestratorProbe.status}：`
            + `${`${orchestratorProbe.stdout ?? ''}${orchestratorProbe.stderr ?? ''}`.slice(0, 300)}`)
        if (!sample.legal) {
          check(`${orchestratorProbe.stderr ?? ''}`.includes('expiresOn'),
            `R6-C-1(到期日): ${label} 的失败信息必须点名 \`expiresOn\`（否则排查者看不出是到期日写坏了），`
              + `实际 ${JSON.stringify((orchestratorProbe.stderr ?? '').slice(0, 200))}`)
        }
        const rootGuardsProbe = spawnSync(process.execPath, [join(probeTree, 'scripts', 'check-root-guards.mjs'), '--list'],
          { cwd: probeTree, encoding: 'utf8' })
        if (sample.legal) {
          // 正控：合法取值在两棵树上都必须被接受（否则说明探针自身把树弄坏了，
          // 上面那些"必须 exit 2"就全是假绿）。
          check(rootGuardsProbe.status === 0,
            `R6-C-1(到期日): 正控 ${label} 时 check-root-guards 必须 exit 0，`
              + `实际 ${rootGuardsProbe.status}：${`${rootGuardsProbe.stdout ?? ''}${rootGuardsProbe.stderr ?? ''}`.slice(0, 300)}`)
          console.log(`verify-check-workspaces: R6-C-1 到期日 ${label} ⇒ 编排器与根守卫均 exit 0 ✓（正控）`)
          continue
        }
        // 非法取值在根守卫通道上**只记录、不断言**：那条通道的字段值判据不在本次范围内
        // （见本段头部的"已认账的残余"）。把它如实打出来，不让它悄悄消失。
        console.log(`verify-check-workspaces: R6-C-1 到期日 ${label} ⇒ 编排器 exit 2 ✓；`
          + `根守卫通道 exit ${rootGuardsProbe.status}（残余：该脚本不校验字段值，未在本次范围）`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 独立来源：域名守卫的**扫描根断言**必须能被它自己的 `--selftest` 打坏（R4-A N4）
//
// 现场：根断言（默认根 = 仓库根；cwd 在子目录里 ⇒ 拒绝）是 R4-A-1 的修复本体，但
// "这条判据只在从仓库根调用时有效"这个约定**自己不在任何自证里** —— 把默认根退回
// `resolve(cwd)` 或把根断言弱化成"路径存在即可"，`check-no-real-domains.mjs --selftest`
// 仍然 EXIT=0。
//
// 这里作为**独立来源**给这条自证上锁：真跑一次 `--selftest`（必须绿），再在副本上把
// 根断言退回修前形态，要求副本的 `--selftest` **非零**。副本放在 `<仓库根>/temp/`
// （脚本按自身位置上溯推 root，放别处它读不到本仓的 git 顶层）。
// ---------------------------------------------------------------------------

if (!redProbeChild && !selfCheckProbeChild) {
  const guardPath = join(root, 'scripts', 'check-no-real-domains.mjs')
  const guardSource = readFileSync(guardPath, 'utf8')
  const baseline = spawnSync(process.execPath, [guardPath, '--selftest'], { cwd: root, encoding: 'utf8' })
  const baselineOut = `${baseline.stdout ?? ''}${baseline.stderr ?? ''}`
  check(baseline.status === 0,
    `域名守卫 --selftest 必须 exit 0（实际 ${baseline.status}）：${baselineOut.trim().slice(-300)}`)
  check(baselineOut.includes('扫描根断言三样本'),
    '域名守卫 --selftest 的输出必须点明"扫描根断言"样本已经跑过（否则根断言又回到自证覆盖之外）')
  const needle = `if (!explicitRoot) {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  root = gitToplevel(scriptDir) ?? resolve(scriptDir, '..')
}`
  const replacement = `if (!explicitRoot) {
  root = resolve(process.cwd())
}`
  const cwdNeedle = `    const cwdTop = gitToplevel(process.cwd())
    if (cwdTop !== null && resolve(process.cwd()) !== cwdTop) {
      refuseWrongRoot(resolve(process.cwd()), cwdTop, '在仓库的子目录里运行')
    }`
  const cwdReplacement = `    const cwdTop = gitToplevel(process.cwd())
    if (cwdTop === null && resolve(process.cwd()) !== root) {
      refuseWrongRoot(resolve(process.cwd()), root, '在仓库的子目录里运行')
    }`
  if (!guardSource.includes(needle) || !guardSource.includes(cwdNeedle)) {
    selfCheckFail('domain-root-anchor', '域名守卫的根断言锚点失效（默认根派生 / cwd 子目录判据的形状变了）'
      + ' —— 这条独立自证无法开展，请同步本文件的锚点，不要直接删掉它')
  } else {
    const probeDir = join(root, 'temp')
    const probeFile = join(probeDir, `check-no-real-domains-rootmut-${process.pid}-${randomUUID().slice(0, 8)}.mjs`)
    try {
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(probeFile, guardSource.replace(needle, replacement).replace(cwdNeedle, cwdReplacement))
      const mutated = spawnSync(process.execPath, [probeFile, '--selftest'], { cwd: root, encoding: 'utf8' })
      const mutatedOut = `${mutated.stdout ?? ''}${mutated.stderr ?? ''}`
      if (mutated.status === 0) {
        selfCheckFail('domain-root-anchor', '把根断言退回修前形态（默认根 = cwd + 弱化子目录判据）后，'
          + '`--selftest` 仍然 EXIT=0 ⇒ 扫描根这条判据没有自证网（R4-A N4）')
      } else if (!mutatedOut.includes('根断言负例')) {
        selfCheckFail('domain-root-anchor', '根断言副本确实红了，但不是被根断言样本咬住的'
          + `（输出里没有"根断言负例"，红了也不算这条判据有效）：${JSON.stringify(mutatedOut.trim().slice(-200))}`)
      } else {
        selfCheckPass('domain-root-anchor')
      }
    } catch (error) {
      selfCheckFail('domain-root-anchor', `根断言独立自证无法开展（写/跑副本失败：${error?.message ?? String(error)}）`)
    } finally {
      try {
        rmSync(probeFile, { force: true })
      } catch {
        // 清理失败不影响结论
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 本文件自己的自检（R4-A-6）：三条互相独立，全部**不经过 fail()**
// ---------------------------------------------------------------------------

{
  // 自检③-a：`fail()` 必须真的记录 + 真的写 stderr。探针的 stderr 输出被临时捕获，
  // 跑完把那条探针失败从 failures[] 里弹掉（否则它会污染结论）—— 捕获也顺带证明
  // "失败是 fail-loud"，而不只是"记在一个没人读的数组里"。
  const probe = 'SELFCHECK: fail() 失败通道探针（这条不进最终结论）'
  const originalWrite = process.stderr.write
  let captured = ''
  process.stderr.write = chunk => { captured += String(chunk); return true }
  const before = failures.length
  fail(probe)
  process.stderr.write = originalWrite
  const recorded = failures.length === before + 1 && failures.at(-1) === probe
  if (recorded) {
    failures.pop()
    // 计票通道同步回退（探针这条不进结论；否则"数组长度 == 事件计数"会对不上）。
    failureEvents.assertions -= 1
  }
  if (!recorded) {
    selfCheckFail('fail-channel', 'fail() 没有把失败记录进 failures[] —— 失败通道被掏空：'
      + '任何断言失败都不会再影响退出码（本文件会打印完整 OK banner 并 EXIT=0）')
  }
  if (!captured.includes(probe)) {
    selfCheckFail('fail-channel', 'fail() 没有把失败写到 stderr —— 失败不是 fail-loud（CI 日志里看不到原因）')
  }
  if (recorded && captured.includes(probe)) selfCheckPass('fail-channel')
}

// 自检③-c（2026-09-23 第五轮审计 R4-A N3）：**自检失败通道自己也要能被打坏**。
// in-process 探针：调一次 `selfCheckFail(...)`，断言它真的进了 `selfCheckFailures`
// 且真的写了 stderr；探针记在临时 id 上，跑完弹掉（它不在登记表里，留着会让
// registry-reconciled 报"跑了未登记的自检"）。
{
  const probeId = `selfcheck-channel-probe-${process.pid}`
  const originalWrite = process.stderr.write
  let captured = ''
  process.stderr.write = chunk => { captured += String(chunk); return true }
  const before = selfCheckFailures.length
  selfCheckFail(probeId, SELFCHECK_PROBE_MESSAGE)
  process.stderr.write = originalWrite
  const recorded = selfCheckFailures.length === before + 1 && selfCheckFailures.at(-1) === SELFCHECK_PROBE_MESSAGE
  if (recorded) {
    selfCheckFailures.pop()
    // 计票通道同步回退（探针这条不进结论；否则"数组长度 == 事件计数"会对不上）。
    failureEvents.selfCheck -= 1
  }
  selfCheckObserved.delete(probeId)
  if (!recorded) {
    selfCheckFail('selfcheck-channel', 'selfCheckFail() 没有把自检失败记录进 selfCheckFailures[] —— '
      + '自检通道被掏空：自检发现问题也不会再影响退出码（banner 仍照旧宣称"自检 N 条"）')
  }
  if (!captured.includes(SELFCHECK_PROBE_MESSAGE)) {
    selfCheckFail('selfcheck-channel', 'selfCheckFail() 没有把自检失败写到 stderr —— 自检不是 fail-loud')
  }
  if (recorded && captured.includes(SELFCHECK_PROBE_MESSAGE)) selfCheckPass('selfcheck-channel')
}

if (!redProbeChild) {
  // 自检③-b：失败路径**端到端**可达。把一条断言注入成恒假，跑一份自己的副本，
  // 断言它 EXIT=1 且 stderr 里出现那条具名失败。副本放在 `<仓库根>/temp/` —— 直接
  // 放在根下的子目录里，副本用"脚本位置的上溯"推出的 root 才正好是同一个仓库根
  // （放别处它读不到 package.json / .gitignore / scripts/check-workspaces.mjs）；
  // `temp/` 在 .gitignore 里（第 88 行），且副本跑完立即删除。
  // **掏空 fail() 的变异会在这里变红**：副本退出 0 而探针要求 1。
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const needle = [
    'function check(condition, message) {',
    '  checksRun += 1',
    '  if (!condition) fail(message)',
    '  return condition',
    '}',
  ].join('\n')
  if (!source.includes(needle)) {
    selfCheckFail('assert-path-e2e', '红色副本的注入锚点失效（check() 的形状变了）—— 失败路径自检无法开展，'
      + '请同步本文件里 RED_PROBE 的锚点，不要直接删掉这段自检')
  } else {
    const probeDir = join(root, 'temp')
    const probeFile = join(probeDir, `verify-check-workspaces-red-${process.pid}-${randomUUID().slice(0, 8)}.mjs`)
    try {
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(
        probeFile,
        source.replace(needle, `${needle}\n\nif (process.argv.includes(${JSON.stringify(RED_PROBE_CHILD_ARG)})) {\n`
          + `  check(false, ${JSON.stringify(RED_PROBE_MESSAGE)})\n  finalizeExit('early')\n}`),
      )
      const child = spawnSync(process.execPath, [probeFile, RED_PROBE_CHILD_ARG], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 120_000,
      })
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      const pathReachable = child.status === 1
      const namedOnStderr = output.includes('SELFCHECK-RED-PROBE')
      check(pathReachable,
        `自检③-b: 注入了必假断言的副本必须 EXIT=1（实得 ${child.status}${child.error ? `，error=${child.error.message}` : ''}）`
        + ' —— EXIT=0 = 失败路径不可达（fail() 被掏空 / 收尾判据被改）')
      check(namedOnStderr,
        `自检③-b: 副本必须把那条注入的失败具名打到 stderr（实得 ${JSON.stringify(output.slice(-300))}）`)
      // **两条通道同时记**（R5-D-21）：这条判据证的是"断言通道真的进退出码"，
      // 所以它也必须经**自检通道**留痕 —— 只把 `failures.length` 从退出判据里删掉时，
      // 下面这句 selfCheckFail 仍然会让本文件红（反之亦然：自检通道的接线由
      // ③-d 的 `check(...)` 证）。单一通道被摘掉不再等于整体静默。
      if (!pathReachable || !namedOnStderr) {
        selfCheckFail('assert-path-e2e', '失败路径端到端探针不成立：'
          + `副本 EXIT=${child.status}、具名失败${namedOnStderr ? '已' : '未'}到 stderr`
          + ' —— "断言失败 ⇒ exit 1"这条链断了（可能只改了收尾判据那一侧）')
      } else {
        selfCheckPass('assert-path-e2e')
      }
    } catch (error) {
      selfCheckFail('assert-path-e2e', `自检③-b 无法开展（写/跑红色副本失败：${error?.message ?? String(error)}）`)
    } finally {
      try {
        rmSync(probeFile, { force: true })
      } catch {
        // 清理失败不影响结论
      }
    }
  }
}

if (!selfCheckProbeChild) {
  // 自检③-d（R4-A N3）：**自检失败路径端到端可达**。把一条 `selfCheckFail(...)` 注入
  // 副本（锚点与③-b 同一个 `check()`），跑副本并要求它 EXIT=1 且把那句话打到 stderr。
  // **把 `selfCheckFail()` 改成 no-op 的变异会在这里变红**（副本退出 0 而探针要求 1）——
  // 这就是"自检通道自己也要能被打坏"的那条判据。
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const needle = [
    'function check(condition, message) {',
    '  checksRun += 1',
    '  if (!condition) fail(message)',
    '  return condition',
    '}',
  ].join('\n')
  if (!source.includes(needle)) {
    selfCheckFail('selfcheck-path-e2e', '自检失败副本的注入锚点失效（check() 的形状变了）—— '
      + '自检通道自证无法开展，请同步本文件里 SELFCHECK_PROBE 的锚点，不要直接删掉这段自检')
  } else {
    const probeDir = join(root, 'temp')
    const probeFile = join(probeDir, `verify-check-workspaces-selfcheck-${process.pid}-${randomUUID().slice(0, 8)}.mjs`)
    try {
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(
        probeFile,
        source.replace(needle, `${needle}\n\nif (process.argv.includes(${JSON.stringify(SELFCHECK_PROBE_CHILD_ARG)})) {\n`
          + `  selfCheckFail('selfcheck-path-e2e', ${JSON.stringify(SELFCHECK_PROBE_MESSAGE)})\n  finalizeExit('early')\n}`),
      )
      const child = spawnSync(process.execPath, [probeFile, SELFCHECK_PROBE_CHILD_ARG], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 120_000,
      })
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      check(child.status === 1,
        `自检③-d: 注入了自检失败的副本必须 EXIT=1（实得 ${child.status}${child.error ? `，error=${child.error.message}` : ''}）`
        + ' —— EXIT=0 = 自检失败不影响退出码（selfCheckFail() 被掏成 no-op / 收尾判据漏了 selfCheckFailures）')
      check(output.includes('SELFCHECK-CHANNEL-PROBE'),
        `自检③-d: 副本必须把那条注入的自检失败具名打到 stderr（实得 ${JSON.stringify(output.slice(-300))}）`)
      // 这条经**断言通道**留痕（它是"自检通道真的进退出码"的判据）；失败时由登记表对拍
      // （registry-reconciled ⇒ 自检通道）再报一次 —— 两条通道都不静默。
      if (child.status === 1 && output.includes('SELFCHECK-CHANNEL-PROBE')) {
        selfCheckPass('selfcheck-path-e2e')
      } else {
        check(false, `自检③-d: 自检失败路径端到端探针不成立（副本 EXIT=${child.status}）—— `
          + '"自检失败 ⇒ exit 1"这条链断了（可能只改了收尾判据里属于自检通道的那一项）')
      }
    } catch (error) {
      selfCheckFail('selfcheck-path-e2e', `自检③-d 无法开展（写/跑自检副本失败：${error?.message ?? String(error)}）`)
    } finally {
      try {
        rmSync(probeFile, { force: true })
      } catch {
        // 清理失败不影响结论
      }
    }
  }
}

// 自检① / ②：条数与样本下限。**下限只允许被"变多"越过** —— 断言表被清空、
// 场景被删掉时这两条立刻红（而它们不经过 fail()，掏空 fail() 也躲不过）。
if (checksRun < SELFTEST_MIN_CHECKS) {
  selfCheckFail('checks-floor', `只执行了 ${checksRun} 条断言（下限 ${SELFTEST_MIN_CHECKS}）—— 回归网的断言表被清空/缩水`)
} else {
  selfCheckPass('checks-floor')
}
if (scenariosRun < SELFTEST_MIN_SCENARIOS) {
  selfCheckFail('scenarios-floor', `只跑了 ${scenariosRun} 个合成树场景（下限 ${SELFTEST_MIN_SCENARIOS}）—— 样本数骤降`)
} else {
  selfCheckPass('scenarios-floor')
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

// 退出判据的唯一实现（含登记表对拍 / 两通道一致性 / "有事件必须红"）——
// 正常路径走到这里；两个探针副本用 `finalizeExit('early')` 提前调用同一个函数。
finalizeExit()
// banner 的自检条数与清单**与登记表同源**（R4-A N3：写死的 "自检 3 条" 会在自检被
// 短路/删除时继续撒谎）。`selfCheckObserved` 是与 `SELF_CHECKS` 双向对拍过的实跑结果。
const selfCheckBanner = SELF_CHECKS
  .map(entry => `${entry.id}=${selfCheckObserved.get(entry.id) ?? 'missing'}`)
  .join(' / ')
process.stdout.write(
  `verify-check-workspaces: OK（断言 ${checksRun} 条 / 合成树场景 ${scenariosRun} 个 / 自检 `
  + `${selfCheckObserved.size}/${SELF_CHECKS.length} 条【${selfCheckBanner}】`
  + '——含"注入必假断言的副本必须 EXIT=1"与"注入自检失败的副本必须 EXIT=1"两条端到端探针） — '
  + '--changed 算不出改动=exit 2、--only 未知/空/被 flag 吃掉=exit 2、'
  + '有效 --only 真的执行该包、.glitchtip-recon/ 已被忽略、变异体残留守卫的合成正/负例、'
  + '迁移区间守卫与文档数字守卫的合成正/负例、'
  + '调度/归属表自检 8 类注入（成环 / needs 打错 / PATH_OWNERS 前缀与包名打错 / 少条目 / '
  + '嵌套前缀且归属不同包（先声明者胜 ⇒ 死条目或归属按顺序翻转）/ DEPENDENTS 打错 / '
  + 'DEPENDENTS 少一条**反向边**（needs ↔ DEPENDENTS 双向一致））逐条必红、'
  + '同一包的细粒度子前缀必须放行、'
  + '成环时的运行时 pending 断言（列名 + 计划≠实跑 + exit 1）、'
  + 'C-9/C-10 失败详情必然可见（判定行**行首锚定** / 进度噪声不占判定预算 / '
  + '未锚到时 fail-loud 打印「未找到判定行」+ 兜底疑似错误行 / --full-output 真的绕过截断 / 短输出原样）、'
  + 'C-12/F5 真实树包表语义对拍（dir 存在 + package.json 的 name 一致 + script 字段存在 + '
  + '磁盘上的 workspace 包必须都在 PACKAGES 里）三向正负例、'
  + 'C-13 advisory 失败**不计入通过**（四类计数恰好覆盖计划数）、'
  + 'C-15 失败块带真实退出码 / 信号、C-16 计划 0 个任务的显式告警、'
  + 'C-6 守卫脚本 sha256 与登记表对拍（含符号链接断言）、'
  + 'C-8 通过的守卫的降级行必须进摘要（含"无降级行则不打 [DEGRADED]"的负例）、'
  + 'C-8 判据的精度（复审那 9 行里 5 条成功摘要不得进摘要、4 条真降级一条不少）、'
  + '六处形态①④（verify-licenses 空依赖树 / verify-patches 依赖目标缺失）的具名判据、'
  + '本门禁与相关守卫都已接入 package.json 与 GUARDS\n',
)
