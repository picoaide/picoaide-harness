#!/usr/bin/env node
/**
 * 变异体残留守卫（2026-09-20 新增；起因是一次真实事故）。
 *
 * **事故**：主控跑 `git add -A` 提交交付基线时，把某泳道正在飞的**变异体**扫进了提交 ——
 * `server/webadmin/src/pages/app-center/opens-contract.ts` 里
 * `return '0' // A2-L6 变异 M-D：— 改回 0`（该变异会让 vitest 变红 ⇒ 提交是红的）。
 * 本仓把"变异验证"当一等实践，所以「变异体残留进提交」是**结构性风险**，不能靠人眼。
 *
 * 判据（只抓"**代码行尾挂变异注释**"这一种形态，避免误报成灾）：
 *   1. 扫 `*.ts *.tsx *.go *.mjs *.js *.sh`（排除 `node_modules/ lib/ dist/ build/ temp/` 等）；
 *   2. 该行含 `变异|MUTANT`；
 *   3. 把该行的**行尾注释**（`//` 或 `#` 起）剥掉后，剩余前缀 trim 后**非空**且**不以**
 *      `//`、`*`、`/*`、`#` 开头 ⇒ 命中（错误）。
 *
 * 明确**不报**的合法形态（各有理由）：
 *   - 整行注释（`// 变异验证：…` / 块注释续行 ` * …`）⇒ 由规则 3 的"前缀为空/以注释符开头"覆盖；
 *   - **字符串字面量里描述变异**（`scripts/check-workflows.mjs` 那句 `'… `|| true` 变异无任何
 *     静态守卫…'`）⇒ `变异|MUTANT` 若处于引号内则不报（字符串是在**说明**这件事，不是在改行为）。
 *
 * **豁免的粒度是"每个命中点各自判"、不是"整行豁免"**（2026-09-23 三轮审计 R3-C C-9 登记的口径）：
 * 一行里只要还有**一个**标记不在字符串/正则字面量内，这一行照样报 —— 例如
 * `const note = '变异 M-D' + 变异` 必红，而 `export const note = '变异 M-D'` 不报。
 * `verify-check-workspaces.mjs` 里有这两个形态的夹具（正/负例各一条）。
 *
 * 命中输出 `文件:行:内容` 并给出一句处置指引：**变异验证必须在临时副本上做，或在 `trap` 里
 * 保证还原**（本仓既有双证：L4 的 M1–M6c 全部在临时副本/立即还原下做）。
 *
 * **扫描面（2026-09-23 修正）**：默认只扫**能进提交的文件**（`git ls-files --cached --others
 * --exclude-standard` = 已跟踪 + 已暂存 + 未跟踪且未被忽略）。理由两条：
 *   1. 被 `.gitignore` / `.git/info/exclude` 忽略的本地产物**不可能**进提交（除非显式 `git add -f`，
 *      而那就进了索引 ⇒ 仍被 `--cached` 覆盖），扫它们只会制造误报 —— 本仓真实误报：一个
 *      **变异驱动脚本**（`audit/**` 下，本地忽略）里的"变异后代码"字符串参数被当成残留变异体，
 *      以致 `yarn check` 在干净提交态上恒红，反而掩盖真信号。
 *   2. 旧的目录遍历会扫到 `node_modules`/产物等无关文件，白白放大扫描面。
 * 显式传 `--root <dir>` 时退回目录遍历（供测试夹具与"仓库外副本"场景使用）。
 *
 * **"扫不到"不是通过**（2026-09-23 三轮审计 R3-C C-9 / 六处形态②）：`--root` 不存在（或不是
 * 目录）一律 exit 2；扫描面为 0 个文件一律 exit 1 并给出原因 —— 旧实现在这两种输入下都打印
 * `扫描 0 个文件` + `零残留 ✅` 并 EXIT=0，与"这条判据跑了且没发现问题"无法区分。
 *
 * 用法：node scripts/check-no-leftover-mutants.mjs [--root <dir>] [--json] [--all-files]
 *   `--all-files`：强制目录遍历（连被忽略的文件一起扫），排查时用。
 * 退出码：0 = 零残留；1 = 有命中**或扫描面为 0**；2 = 用法错误（含"扫描根不存在/不是目录"）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
let root = resolve(process.cwd())
let json = false
let explicitRoot = false
let allFiles = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    const value = args[index + 1]
    if (value === undefined) {
      console.error('check-no-leftover-mutants: --root 需要一个目录')
      process.exit(2)
    }
    root = resolve(value)
    explicitRoot = true
    index += 1
  } else if (args[index] === '--json') json = true
  else if (args[index] === '--all-files') allFiles = true
  else {
    console.error(`check-no-leftover-mutants: 未知参数 ${args[index]}`)
    process.exit(2)
  }
}

// 六处形态②（2026-09-23 三轮审计 R3-C C-9 同源）：`--root <不存在>` 旧实现走
// `walk()`（readdirSync 失败被 catch 吞掉）⇒ `扫描 0 个文件` + `零残留 ✅` + EXIT=0。
// "输入不存在"是用法错误，必须在读任何文件之前就停下来。
if (explicitRoot && !existsSync(root)) {
  console.error(`check-no-leftover-mutants: --root 指向的路径不存在:${root} —— `
    + '拒绝把"扫不到"当成"零残留"（旧行为是打印 `扫描 0 个文件` + `零残留 ✅` 并 exit 0）。')
  process.exit(2)
}
if (explicitRoot && !statSync(root).isDirectory()) {
  console.error(`check-no-leftover-mutants: --root 必须是目录,收到文件:${root}`)
  process.exit(2)
}

const EXTENSIONS = /\.(ts|tsx|go|mjs|cjs|js|sh)$/u
/** 目录名排除表（构建产物、依赖、以及 temp/ —— 探针/临时脚本本来就住在那儿）。 */
const EXCLUDE_DIRS = new Set([
  'node_modules', 'lib', 'dist', 'build', 'temp', '.git', '.yarn', '.astro', 'coverage', 'out', '.cache',
])
const KEYWORD = /变异|MUTANT/gu

/** 命令该字符是否落在引号内（`'` / `"` / 反引号，取同种引号在它前面的奇偶）。 */
function insideQuotes(line, index) {
  for (const quote of ["'", '"', '`']) {
    let count = 0
    for (let i = 0; i < index; i += 1) if (line[i] === quote) count += 1
    if (count % 2 === 1) return true
  }
  return false
}

/**
 * 该位置是否落在**正则字面量**里（`/变异|MUTANT/gu` 这种）。
 *
 * 为什么需要：**检测变异标记的工具本身必须提到这个标记** —— 本文件第一行常量就是
 * `/变异|MUTANT/gu`。正则字面量与字符串字面量同族：它是在**识别**变异，不是在改行为。
 * 判定用"同一行内、紧邻的前后两个 `/` 之间没有空白"这一条（够用且不会把除法表达式
 * `a / 变异 / b` 误判成豁免）。
 */
function insideRegexLiteral(line, index) {
  const before = line.lastIndexOf('/', index)
  if (before < 0) return false
  const after = line.indexOf('/', index)
  if (after < 0) return false
  const body = line.slice(before + 1, after)
  return body.length > 0 && !/\s/u.test(body)
}

/**
 * 判定单行是否命中。
 * @returns `null`（合法）或 `{ reason }`（命中原因）。
 */
function inspectLine(line) {
  const matches = [...line.matchAll(KEYWORD)]
  if (matches.length === 0) return null
  // 全部出现在字符串/正则字面量里 ⇒ 是在**说明或识别**变异，不是在改行为（见头注释的豁免理由）。
  if (matches.every(match => insideQuotes(line, match.index) || insideRegexLiteral(line, match.index))) return null
  // 行尾注释剥离（`//` 或 `#` 起）。
  const commentAt = line.search(/\/\/|#/u)
  const prefix = commentAt < 0 ? line : line.slice(0, commentAt)
  if (prefix.trim() === '') return null
  if (/^\s*(\/\/|\*|\/\*|#)/u.test(prefix)) return null
  return { reason: '代码行上挂着变异标记（剥掉行尾注释后仍有可执行前缀）' }
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      yield* walk(join(dir, entry.name))
    } else if (entry.isFile() && EXTENSIONS.test(entry.name)) {
      yield join(dir, entry.name)
    }
  }
}

/** 该相对路径是否落在排除目录里（git 模式下也要按同一张表收敛扫描面）。 */
function inExcludedDir(rel) {
  return rel.split('/').some(segment => EXCLUDE_DIRS.has(segment))
}

/**
 * 判定扫描面：默认 git（只扫能进提交的文件）；`--root` 显式指定或非 git 仓库时退回目录遍历。
 * @returns `{ mode, files }`
 */
function collectFiles() {
  if (allFiles || explicitRoot) return { mode: 'walk', files: [...walk(root)] }
  let top
  try {
    top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    return { mode: 'walk', files: [...walk(root)] }
  }
  // 扫描根必须就是仓库根：在子目录里跑会静默漏掉大部分文件（旧版没有这条断言）。
  if (resolve(top) !== root) {
    console.error(`check-no-leftover-mutants: 扫描根不是仓库根 —— root=${root}，仓库根=${resolve(top)}。`
      + '请在仓库根运行，或用 --root 显式指定要遍历的目录。')
    process.exit(2)
  }
  const listing = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const files = listing
    .split('\0')
    .filter(Boolean)
    .filter(rel => EXTENSIONS.test(rel) && !inExcludedDir(rel))
    .map(rel => join(root, rel))
  return { mode: 'git', files }
}

const hits = []
let scanned = 0
const { mode, files } = collectFiles()
for (const file of files) {
  let text
  try {
    if (statSync(file).size > 2 * 1024 * 1024) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const verdict = inspectLine(lines[index])
    if (verdict !== null) {
      hits.push({ file: relative(root, file), line: index + 1, text: lines[index].trim().slice(0, 200), reason: verdict.reason })
    }
  }
}

if (json) {
  console.log(JSON.stringify({ root, mode, scanned, hits, scanSurface: scanned === 0 ? 'empty' : 'checked' }, null, 2))
} else {
  console.log(`check-no-leftover-mutants: 扫描 ${scanned} 个文件（root=${root}，mode=${mode}）`)
}

// 扫描面为 0 = **判据没跑**，不是"零残留"（C-9 的第一条窄化路径：旧实现照样打印
// `零残留 ✅` 并 exit 0）。与 check-no-real-domains 的空扫描面判据同一原则。
if (scanned === 0) {
  console.error(`\ncheck-no-leftover-mutants: 扫描面为 **0 个文件**（root=${root}，mode=${mode}）—— `
    + '拒绝把"扫不到"当成"零残留"。\n'
    + '  可能原因:① 目录里没有 `*.ts/*.tsx/*.go/*.mjs/*.js/*.sh` 文件;'
    + '② 它们全在排除表里（node_modules/lib/dist/build/temp/.git/.yarn/…）;'
    + '③ git 模式下仓库里确实没有任何可扫文件。\n'
    + '  处置:确认扫描根正确;若确实要扫被忽略/被排除的位置,用 `--all-files`（目录遍历）。')
  process.exit(1)
}

if (hits.length > 0) {
  for (const hit of hits) {
    console.error(`  [MUTANT] ${hit.file}:${hit.line}: ${hit.text}`)
  }
  console.error(`\n变异体残留 ${hits.length} 处。处置：变异验证必须在**临时副本**上做，或在 \`trap\` 里保证还原；`
    + '提交前 `git diff` 自查变异标记，别让红的变异体进提交。')
  process.exit(1)
}

if (!json) console.log('check-no-leftover-mutants: 零残留 ✅')
