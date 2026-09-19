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
 * 用法:node scripts/verify-check-workspaces.mjs
 * 退出码:0 全部通过;1 有断言失败。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const subject = join(root, 'scripts', 'check-workspaces.mjs')
const failures = []
const scratch = []

function fail(message) {
  failures.push(message)
  process.stderr.write(`verify-check-workspaces: ${message}\n`)
}

function check(condition, message) {
  if (!condition) fail(message)
  return condition
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
 * @returns {{ tree: string, log: string }} 树根与 corepack 桩的 argv 记录文件。
 */
function buildTree() {
  const tree = tempDir('check-workspaces-')
  mkdirSync(join(tree, 'scripts'))
  copyFileSync(subject, join(tree, 'scripts', 'check-workspaces.mjs'))
  writeFileSync(
    join(tree, 'package.json'),
    `${JSON.stringify({ name: 'synthetic-gate', private: true, workspaces: ['packages/*/*', 'community/*'] }, null, 2)}\n`,
  )
  mkdirSync(join(tree, 'bin'))
  // argv 记录文件放在**树外**：它是在初始提交之后才产生的，留在树里会变成第二个
  // 未跟踪文件，把 `--changed HEAD` 正例的"1 个改动文件"断言搅浑。
  const log = join(tempDir('check-workspaces-log-'), 'corepack-argv.log')
  const stub = join(tree, 'bin', 'corepack')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`)
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
  check(good.status === 0, `变异守卫：空树必须绿（实际 exit=${good.status}）`)

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
  const guards = list.stdout.split('\n').find(line => line.startsWith('guards: ')) ?? ''
  check(
    guards.includes('check:check-workspaces'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:check-workspaces，实际 ${JSON.stringify(guards)}`,
  )
  // 2026-09-20：变异体残留守卫必须同样双重登记（package.json + GUARDS）——
  // 少任何一处都等于「事故防线没接上」，而它防的正是"红的变异体进提交"。
  check(
    pkg.scripts?.['check:no-leftover-mutants'] === 'node scripts/check-no-leftover-mutants.mjs',
    `接线: package.json 的 check:no-leftover-mutants 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:no-leftover-mutants'])}`,
  )
  check(
    guards.includes('check:no-leftover-mutants'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:no-leftover-mutants，实际 ${JSON.stringify(guards)}`,
  )
  check(
    pkg.scripts?.['check:migration-range'] === 'node scripts/check-migration-range.mjs',
    `接线: package.json 的 check:migration-range 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:migration-range'])}`,
  )
  check(
    guards.includes('check:migration-range'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:migration-range，实际 ${JSON.stringify(guards)}`,
  )
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-check-workspaces: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write(
  'verify-check-workspaces: OK — --changed 算不出改动=exit 2、--only 未知/空/被 flag 吃掉=exit 2、'
  + '有效 --only 真的执行该包、.glitchtip-recon/ 已被忽略、变异体残留守卫的合成正/负例、'
  + '迁移区间守卫的合成正/负例、本门禁与两个新守卫都已接入 package.json 与 GUARDS\n',
)
