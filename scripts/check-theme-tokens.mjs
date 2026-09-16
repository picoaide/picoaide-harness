/**
 * 根守卫：客户端主题 token 的存在性（2026-09-16）。
 *
 * 背景（真机事故）：客户端主题由 `body[data-ds-dark-theme]` 切换 CSS 变量，变量的
 * 权威定义在上游 `ui-theme` 的样式里。我们自己插件里写错 token 名时，CSS 不会报错 ——
 * `var(--dsw-alias-fg-primary, #000000)` 会安静地走 fallback，于是那个颜色**永远不随
 * 主题变化**。真机表现就是"暗色模式下一片看不清"：
 *   - 版本号胶囊用了不存在的 `--dsw-alias-fg-primary` ⇒ 底色恒为 #000000，而文字用
 *     `--dsw-alias-bg-base`（暗色变成近黑）⇒ 黑底黑字；
 *   - `--dsw-alias-border-l` 不存在 ⇒ `1px solid <空>` 直接不画线（连 fallback 都没有）。
 *
 * 判定规则（对我们的包，见 {@link OUR_ROOTS}）：
 *   - **失败**：token 未定义，且它的 fallback 链最终落到字面量（或压根没有 fallback）
 *     ⇒ 渲染值恒定，主题切换无效；
 *   - **警告**：token 未定义，但 fallback 链落到了另一个**有效** token ⇒ 行为正确，
 *     只是白写了一层（把死名字删掉即可）；
 *   - 有效 token = 上游样式里的定义（亮色基准块 + 暗色覆盖块）∪ 我们仓库里自己的定义。
 *
 * 例外：`packages/vendor/**` 是随包分发的**第三方** vendored 插件（memory-evolve），
 * 它的旧版命名债单独记账，不拦本守卫 —— 恢复上游同步比逐行改名更重要。
 *
 * 自证：`--self-test` 用内存夹具跑正/反用例（每次 check 都会跑一遍，毫秒级）。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 上游主题样式的权威目录（pinned submodule）。 */
const THEME_ROOT = join(ROOT, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src')

/** 我们自己的源码根（相对仓库根）；vendored 第三方不在此列。 */
const OUR_ROOTS = ['packages/host', 'packages/client', 'brands', 'site/src']

/** 扫描时跳过的目录名（构建产物 / 依赖）。 */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', 'build', 'coverage', '.astro'])

/** 扫描的源码扩展名。 */
const SOURCE_PATTERN = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$/u

/**
 * 去掉注释，避免"解释性注释里提到的坏 token"被误判。
 *
 * 行注释只在 `//` 前不是 `:` 时才算（保住 `https://…` 里的协议斜杠）。
 * @param {string} text - 源文件文本。
 * @returns {string} 去掉注释的文本。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gmu, '$1')
}

/**
 * 解析一个 CSS 文件：按行级大括号深度取出 `选择器 -> token 定义集合`。
 * @param {string} text - 样式文本。
 * @returns {{ selector: string, tokens: Set<string> }[]} 块列表。
 */
export function parseTokenBlocks(text) {
  const blocks = []
  let depth = 0
  let current
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\*[\s\S]*?\*\//gu, '')
    if (depth === 0 && line.includes('{')) {
      current = { selector: line.slice(0, line.indexOf('{')).trim(), tokens: new Set() }
      blocks.push(current)
    }
    if (current !== undefined) {
      for (const match of line.matchAll(/(--[a-z0-9-]+)\s*:/gu)) current.tokens.add(match[1])
    }
    depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
    if (depth <= 0) {
      depth = 0
      current = undefined
    }
  }
  return blocks
}

/**
 * 把一个 `var(...)` 调用拆成 token 名与 fallback 原文（支持嵌套括号）。
 * @param {string} args - `var(` 之后的原始参数串。
 * @returns {{ token: string, fallback: string | undefined }} token 与 fallback。
 */
function splitVarArgs(args) {
  let depth = 0
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      return { token: args.slice(0, i).trim(), fallback: args.slice(i + 1).trim() }
    }
  }
  return { token: args.trim(), fallback: undefined }
}

/**
 * 判定一条 `var()` 引用的状态。
 * @param {string} args - `var(` 之后的参数串（可含嵌套 var）。
 * @param {ReadonlySet<string>} defined - 有效 token 集合。
 * @returns {'ok' | 'dead' | 'broken'} ok=首个 token 有效；dead=首个未定义但 fallback 链有效；
 * broken=fallback 链最终落到字面量（或压根没有 fallback）⇒ 渲染值恒定。
 */
export function classifyVar(args, defined) {
  const { token, fallback } = splitVarArgs(args)
  const name = token.startsWith('--') ? token : `--${token}`
  if (defined.has(name)) return 'ok'
  if (fallback === undefined || fallback === '') return 'broken'
  return classifyFallback(fallback, defined) === 'broken' ? 'broken' : 'dead'
}

/**
 * 判定 fallback 原文的可用性。
 * @param {string} fallback - `var()` 第二个参数起的原文。
 * @param {ReadonlySet<string>} defined - 有效 token 集合。
 * @returns {'ok' | 'dead' | 'broken'} 同 {@link classifyVar}。
 */
function classifyFallback(fallback, defined) {
  const nested = /^var\(([\s\S]*)\)$/u.exec(fallback.trim())
  // 不是 `var(...)` ⇒ 字面量（颜色、长度、任意值）⇒ 恒定值。
  if (nested === null) return 'broken'
  return classifyVar(nested[1], defined)
}

/** 收集上游样式里定义的全部 token（亮色基准 + 暗色覆盖都算"存在"）。 */
function upstreamTokens() {
  if (!existsSync(THEME_ROOT)) {
    throw new Error(
      `check-theme-tokens: 找不到上游主题样式目录 ${relative(ROOT, THEME_ROOT)}；`
      + '先初始化 submodule（git submodule update --init --recursive）',
    )
  }
  const defined = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(?:css|ts)$/u.test(entry)) {
        for (const block of parseTokenBlocks(readFileSync(path, 'utf8'))) {
          for (const token of block.tokens) if (token.startsWith('--dsw-')) defined.add(token)
        }
      }
    }
  }
  walk(THEME_ROOT)
  return defined
}

/** 递归列出我们的源码文件。 */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (SOURCE_PATTERN.test(entry)) yield path
  }
}

/**
 * 扫出文本里所有 `var(...)` 调用的参数串（**配对括号**扫描，支持嵌套 var）。
 * @param {string} text - 文本（可跨行）。
 * @returns {{ args: string, index: number }[]} 参数串与起始下标。
 */
export function varCalls(text) {
  const calls = []
  for (let i = 0; i < text.length; i += 1) {
    if (!text.startsWith('var(', i)) continue
    let depth = 1
    let j = i + 4
    for (; j < text.length && depth > 0; j += 1) {
      if (text[j] === '(') depth += 1
      else if (text[j] === ')') depth -= 1
    }
    if (depth !== 0) break
    calls.push({ args: text.slice(i + 4, j - 1), index: i })
    i = j - 1
  }
  return calls
}

/**
 * 扫描单个文件里所有 `var(--dsw-…)` 引用。
 * @param {string} file - 绝对路径。
 * @param {ReadonlySet<string>} defined - 有效 token 集合（会被就地扩充我们自己的定义）。
 * @returns {{ line: number, token: string, status: 'dead' | 'broken', snippet: string }[]} 问题列表。
 */
export function scanFile(file, defined) {
  const text = stripComments(readFileSync(file, 'utf8'))
  const lines = text.split('\n')
  const found = []
  for (const call of varCalls(text)) {
    const { token } = splitVarArgs(call.args)
    if (!token.startsWith('--dsw-')) continue
    const status = classifyVar(call.args, defined)
    if (status === 'ok') continue
    const line = text.slice(0, call.index).split('\n').length
    found.push({ line, token, status, snippet: (lines[line - 1] ?? '').trim() })
  }
  // 我们自己的样式里定义的 token 也算有效（先收集，供后续文件使用）。
  for (const block of parseTokenBlocks(text)) {
    for (const token of block.tokens) if (token.startsWith('--dsw-')) defined.add(token)
  }
  return found
}

/** 编辑距离（用于"你是不是想写"候选）。 */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return rows[a.length][b.length]
}

/**
 * 给一个未定义 token 找几个"长得像"的候选，帮改的人一次改对。
 * 同前缀优先，再按编辑距离兜底（`--dsw-alias-fg-primary` → `--dsw-alias-label-primary`）。
 * @param {string} token - 未定义的 token 名。
 * @param {ReadonlySet<string>} defined - 有效 token 集合。
 * @returns {string[]} 最多 4 个候选。
 */
function suggestions(token, defined) {
  const parts = token.split('-').filter(part => part !== '')
  const prefix = `--${parts.slice(0, 3).join('-')}`
  const byPrefix = [...defined].filter(candidate => candidate.startsWith(`${prefix}-`))
  const byDistance = [...defined]
    .map(candidate => ({ candidate, distance: editDistance(token, candidate) }))
    .filter(entry => entry.distance <= Math.max(4, Math.round(token.length / 3)))
    .sort((left, right) => left.distance - right.distance)
    .map(entry => entry.candidate)
  return [...new Set([...byPrefix, ...byDistance])].slice(0, 4)
}

/** 内存夹具正/反用例（保证守卫不会退化成恒绿）。 */
function selfTest() {
  const defined = new Set(['--dsw-alias-label-primary', '--dsw-alias-label-primary-inverted'])
  const cases = [
    // 有效 token（有无 fallback 都算有效）
    ['--dsw-alias-label-primary', 'ok'],
    ['--dsw-alias-label-primary, #fff', 'ok'],
    // 未定义 + 字面量 / 无 fallback ⇒ 阻断（真机事故两类：颜色恒定、声明失效）
    ['--dsw-alias-nope, #000000', 'broken'],
    ['--dsw-alias-nope', 'broken'],
    ['--dsw-alias-nope, 4px', 'broken'],
    // 未定义但落到有效 token ⇒ 只提示
    ['--dsw-alias-nope, var(--dsw-alias-label-primary)', 'dead'],
    ['--dsw-alias-nope, var(--dsw-alias-label-primary, #fff)', 'dead'],
    // 嵌套链最终仍是字面量 ⇒ 阻断
    ['--dsw-alias-nope, var(--dsw-alias-other-nope, #fff)', 'broken'],
  ]
  for (const [args, expected] of cases) {
    const actual = classifyVar(args, defined)
    if (actual !== expected) {
      throw new Error(`check-theme-tokens: self-test 失败 —— var(${args}) 期望 ${expected}，实际 ${actual}`)
    }
  }
  // 嵌套括号必须被当成**一个**调用（非贪婪正则会把内层当外层）。
  const calls = varCalls('color: var(--dsw-alias-a, var(--dsw-alias-b, #fff));')
  if (calls.length !== 1 || calls[0].args !== '--dsw-alias-a, var(--dsw-alias-b, #fff)') {
    throw new Error(`check-theme-tokens: self-test 失败 —— 嵌套 var 扫描：${JSON.stringify(calls)}`)
  }
  const blocks = parseTokenBlocks('body {\n  --dsw-alias-a: 1;\n}\nbody[data-ds-dark-theme] {\n  --dsw-alias-a: 2;\n}')
  if (blocks.length !== 2 || !blocks[1].tokens.has('--dsw-alias-a')) {
    throw new Error('check-theme-tokens: self-test 失败 —— 样式块解析')
  }
}

function main() {
  selfTest()
  const defined = upstreamTokens()
  const problems = []
  let scanned = 0
  let references = 0
  for (const root of OUR_ROOTS) {
    const absolute = join(ROOT, root)
    if (!existsSync(absolute)) continue
    for (const file of sourceFiles(absolute)) {
      scanned += 1
      const hits = scanFile(file, defined)
      references += hits.length
      for (const hit of hits) problems.push({ ...hit, file: relative(ROOT, file) })
    }
  }
  const broken = problems.filter(problem => problem.status === 'broken')
  const dead = problems.filter(problem => problem.status === 'dead')
  for (const problem of dead) {
    console.log(
      `check-theme-tokens: 提示 ${problem.file}:${problem.line} 未定义 token ${problem.token}`
      + '（fallback 是有效 token，行为正确，但请删掉这层死名字）',
    )
  }
  if (broken.length > 0) {
    console.error('check-theme-tokens: 发现不会随主题变化的颜色引用（token 未定义且落到字面量）:')
    for (const problem of broken) {
      console.error(`  ${problem.file}:${problem.line}  ${problem.token}`)
      console.error(`      ${problem.snippet}`)
      const near = suggestions(problem.token, defined)
      if (near.length > 0) console.error(`      相近的可用 token: ${near.join(', ')}`)
    }
    console.error(
      '\n改法：换成上游真实存在的 token（`deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css`'
      + ' 里 `body {}` = 亮色、`body[data-ds-dark-theme] {}` = 暗色），或按需自建 token。',
    )
    process.exit(1)
  }
  console.log(
    `check-theme-tokens: OK（${scanned} 个文件、${problems.length} 条提示、0 条阻断；`
    + `上游 token ${defined.size} 个）`,
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
