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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 *
 * @param options - 可选：`mutate(source)` 对编排器源码做替换（注入调度表缺陷等）；
 *   `stubExtra` 追加到 corepack 桩里的 shell（用来让某个任务打印"软降级"行）。
 * @returns {{ tree: string, log: string }} 树根与 corepack 桩的 argv 记录文件。
 */
function buildTree(options = {}) {
  const { mutate = null, stubExtra = '' } = options
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
  return { entries, owners, depKeys }
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

  /** 五种注入：每条都给"必须点名的关键词"与一句人话标签。 */
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
      id: 'dependents-unknown',
      label: 'DEPENDENTS 键打错',
      must: /DEPENDENTS 的键/u,
      mutate: source => {
        const { depKeys } = readSchedulerTables(source)
        const out = replaceOnce(source, `  '${depKeys[0]}': [`, `  '${depKeys[0]}zzz': [`)
        return { source: out, names: [`${depKeys[0]}zzz`] }
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
  copyFileSync(join(root, 'scripts', 'verify-patches.mjs'), join(patchesTree, 'scripts', 'verify-patches.mjs'))
  copyFileSync(join(root, 'scripts', 'patch-targets.mjs'), join(patchesTree, 'scripts', 'patch-targets.mjs'))
  writeFileSync(join(patchesTree, 'package.json'), `${JSON.stringify({ name: 'synthetic', version: '0.0.0', resolutions: {} }, null, 2)}\n`)
  const patchesRun = spawnSync(process.execPath, [join('scripts', 'verify-patches.mjs')], { cwd: patchesTree, encoding: 'utf8' })
  const patchesOutput = `${patchesRun.stdout}${patchesRun.stderr}`
  check(patchesRun.status === 1, `形态④: 依赖目标缺失必须 exit 1（退出码保持不变，实际 ${patchesRun.status}）`)
  check(patchesOutput.includes('缺少解压 yarn cache 的依赖目标'),
    `形态④: 必须给出具名原因，实际 ${JSON.stringify(patchesOutput.slice(0, 300))}`)
  check(!/^\s+at .*\(node:/mu.test(patchesOutput), `形态④: 不得以未捕获异常栈收尾，实际 ${JSON.stringify(patchesOutput.slice(0, 300))}`)
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
  // 2026-09-23：文档数字守卫（D-4 上游 pin / D-5 平台模块表）同样双重登记。
  check(
    pkg.scripts?.['check:doc-claims'] === 'node scripts/check-doc-claims.mjs',
    `接线: package.json 的 check:doc-claims 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:doc-claims'])}`,
  )
  check(
    guards.includes('check:doc-claims'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:doc-claims，实际 ${JSON.stringify(guards)}`,
  )
  // 2026-09-23 三轮审计 C-5 / 六处形态③⑤⑥：域名守卫、集成测试守卫同样必须双重登记
  // —— "写了用例但没人执行"等同于没有覆盖（本仓已记录过的缺陷类）。
  check(
    pkg.scripts?.['check:no-real-domains'] === 'node scripts/check-no-real-domains.mjs',
    `接线: package.json 的 check:no-real-domains 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:no-real-domains'])}`,
  )
  check(
    guards.includes('check:no-real-domains'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:no-real-domains（含 --others 扫描面与空扫描面判据），实际 ${JSON.stringify(guards)}`,
  )
  check(
    pkg.scripts?.['check:integration-tests'] === 'node scripts/check-integration-tests.mjs',
    `接线: package.json 的 check:integration-tests 必须指向守卫脚本，实际 ${JSON.stringify(pkg.scripts?.['check:integration-tests'])}`,
  )
  check(
    guards.includes('check:integration-tests'),
    `接线: check-workspaces 的 GUARDS 表必须包含 check:integration-tests（electron-shots 的接线/SKIP 判据挂在它上面），实际 ${JSON.stringify(guards)}`,
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
  + '迁移区间守卫与文档数字守卫的合成正/负例、'
  + '调度/归属表自检 6 类注入（成环 / needs 打错 / PATH_OWNERS 前缀与包名打错 / 少条目 / DEPENDENTS 打错）逐条必红、'
  + '成环时的运行时 pending 断言（列名 + 计划≠实跑 + exit 1）、'
  + 'C-8 通过的守卫的降级行必须进摘要（含"无降级行则不打 [DEGRADED]"的负例）、'
  + '六处形态①④（verify-licenses 空依赖树 / verify-patches 依赖目标缺失）的具名判据、'
  + '本门禁与相关守卫都已接入 package.json 与 GUARDS\n',
)
