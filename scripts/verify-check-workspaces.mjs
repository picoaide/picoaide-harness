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
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-check-workspaces: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write(
  'verify-check-workspaces: OK — --changed 算不出改动=exit 2、--only 未知/空/被 flag 吃掉=exit 2、'
  + '有效 --only 真的执行该包、.glitchtip-recon/ 已被忽略、本门禁已接入 package.json 与 GUARDS\n',
)
