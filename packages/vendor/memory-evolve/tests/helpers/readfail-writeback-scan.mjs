/**
 * `lib/**` 的"读失败 ⇒ 空基线 ⇒ 回写"形态扫描器（FIX-47① 的仓库级判据的量具）。
 *
 * ## 为什么需要它
 *
 * 这是本仓**第四次**出现"同族只收口一条"：第二十七轮、第三十轮 FIX-45③（收口 6 处）、
 * 第三十一轮 AD1（又找出 2 处，其中 `session-overrides.json` **上一轮已逐字登记却漏派**）。
 * 根因不是眼力，而是**没有可复算的量具**：散文式的"已登记点位"不进判据面就等于没登记。
 *
 * FIX-42③ 在 `skills-manager.js` 上给过一次同形的解法（`tests/anchor-dir-invariant.test.js`
 * 的 C 块）：**角色取面 + 逐条登记 + 双向对账**。本模块把同一套做法搬到本缺陷族上。
 *
 * ## 形态定义（机械可复算，且明确写出取值域）
 *
 * **候选**：一个 `try { … } catch { … }` 同时满足三条 ——
 *  1. **try 体里有一次 RMW 读**：{@link READ_CALLS} 的目标表达式与**同模块**某个
 *     {@link WRITE_CALLS} 的目标表达式**共享至少一个标识符或字符串字面量**
 *     （这正是"以读到的值为基线回写"的语法必要条件）；
 *  2. **catch 吞掉错误**：块内没有 `throw`；
 *  3. **catch 留下空基线**：块内出现显式空基线返回（`return {}`、`return ''`、
 *     `return null`、`return undefined`、`return []`、`new Map()`、`0`、`false`）
 *     —— 形态①；**或**块体（去注释后）为空、不返回也不抛，调用方继续用初始的
 *     空基线 —— 形态②。
 *
 * **非候选（已修形态）**：catch 内（或紧邻其后 12 行）出现"记失败标记 / 写前闸门"
 * 调用（{@link GATE_MARKERS}）—— 那是 FIX-45③ / FIX-47① 的**目标形态**：读面可以
 * 降级（不阻断评审/面板），但写路径必须被闸门拒掉。刻意**不**把这批登记进豁免表：
 * 它们的正确性由"闸门标记必须存在"这个前向条件守住（拆掉闸门即从已修掉回候选 ⇒ 红）。
 *
 * ## 取值域为什么收在"try 里读了 RMW 路径"这一条
 *
 * 第三十一轮 AD1 记录过：把形态②（裸 catch）按数量判危险是错的 —— 本插件里
 * 忽略清理失败的裸 catch 占绝大多数（实测 180 处）。加上"该 try 真的读了一次
 * **会被回写**的路径"之后，取值域落到真正可能把读失败固化成写入的那一批
 * （本轮实测 5 处，逐条见 `tests/read-failure-write-gate.test.js` 的登记表）。
 * 这条同时是**前向**的：新写一个"读 RMW 路径 + 裸 catch + 回写"的点位会被自动
 * 纳入并因未登记而红。
 *
 * ## 已知取值域边界（照实写出来，不假装完备）
 *
 * - 只扫 `lib/**` 的 `.js`（本插件入库源码；`src/**` 只是客户端构建输入）。
 * - "共享标识符"是**语法层**的必要条件，不是跨函数数据流证明：它可能把
 *   "同名字段其实指向不同文件"的点位收进面内 ⇒ 只会**多**要求登记一条，不会漏。
 *   反向的漏（真 RMW 但读写两侧的路径表达式毫无共同标识符）在本插件的写法下不存在
 *   （读写都走同一个 `xxxFile` / `rel` 变量或同一段字面量）。
 * - `load(...)` / `persist(...)` 这类**自定义**读写方法名不在 {@link READ_CALLS} /
 *   {@link WRITE_CALLS} 里（模块私有、名字无法穷举）。这类点位靠**同模块内的
 *   `readFileSync` / `writeFileAtomicSafeAt` 适配器**落进面内（本插件的注入式读写
 *   都是这个形状），本轮清单已逐条核对过。
 *
 * @module tests/helpers/readfail-writeback-scan
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 写调用（目标表达式 = 第一个实参）。 */
export const WRITE_CALLS = [
  'writeFileSync', 'writeFile', 'writeFileAtomicSafeAt', 'writeFileAtomicSafeAtAsync',
  'appendFileSafeAt', 'appendFileSync', 'atomicWrite', 'saveState', 'renameSync',
]

/** 读调用（目标表达式 = 第一个实参）。 */
export const READ_CALLS = [
  'readFileSync', 'readFile', 'readJsonSync', 'readBaseline', 'readOverridesBaseline',
]

/**
 * "这段 catch 已经把读失败变成可判定的状态"的标记 —— 出现任一即视为**已修形态**。
 *
 * 刻意用**语义命名族**而不是"必须调某个具体函数"：这些名字在 FIX-45③ / FIX-47①
 * 的两处实现里同族（`noteLoadFailure` / `loadErrors` / `loadFailed` /
 * `assertBaselineWritable` / `assertOverridesWritable` / `stateLoadError`）。
 */
export const GATE_MARKERS = /(?:noteLoadFailure\s*\(|loadErrors\s*\.\s*(?:set|delete)\s*\(|loadFailed\s*\.\s*(?:add|delete)\s*\(|refuse|assert[A-Za-z]*Writable\s*\(|stateLoadError\s*=|quarantineState\s*\(|throw\b)/u

/** 显式空基线的返回值形态（形态①）。 */
const EMPTY_RETURN = /return\s+(?:\{\s*\}|''|""|``|null|undefined|\[\s*\]|new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(\s*\)|0|false)\s*(?:;|\n|$)/u

/** 不是函数头的关键字（回溯取函数名时要排掉）。 */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'with', 'try', 'finally', 'typeof',
])

/** 去注释（保留换行，行号不漂）。 */
export function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gu, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** 去字符串字面量（保留换行），用于取"代码标识符"。 */
function blankStrings(text) {
  return text
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, (m) => m.replace(/[^\n]/gu, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, (m) => m.replace(/[^\n]/gu, ' '))
    .replace(/`(?:[^`\\]|\\.)*`/gu, (m) => m.replace(/[^\n]/gu, ' '))
}

/** 取 source 里全部字符串字面量的内容（RMW 配对也可能靠字面量识别）。 */
function stringLiterals(text) {
  const out = []
  for (const m of text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/gu)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    if (value !== '') out.push(value)
  }
  return out
}

const KEYWORDS = new Set([
  'return', 'const', 'let', 'var', 'new', 'this', 'true', 'false', 'null', 'undefined',
  'function', 'async', 'await', 'if', 'else', 'for', 'while', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'in', 'of', 'do', 'switch', 'case', 'break', 'continue',
])

/** 目标表达式的"身份 token"：代码标识符 ∪ 字符串字面量内容。 */
function identityTokens(expression) {
  const tokens = new Set()
  const bare = blankStrings(expression)
  for (const m of bare.matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
    if (KEYWORDS.has(m[0])) continue
    // 排掉**被调用者**（`join(...)` / `resolve(...)` 里的函数名不是路径身份；
    // 不排掉的话，两个都调 `join` 的不同路径会被判成"共享标识符" ⇒ 假阳性）。
    if (/^\s*\(/u.test(bare.slice(m.index + m[0].length))) continue
    tokens.add(m[0])
  }
  for (const value of stringLiterals(expression)) tokens.add(value)
  return tokens
}

/** 切出 `name(` 的全部调用点（括号配对；返回行号与实参文本）。 */
function callSites(source, name) {
  const out = []
  const re = new RegExp(`\\b${name}\\s*\\(`, 'gu')
  let match
  while ((match = re.exec(source)) !== null) {
    let depth = 0
    let k = match.index + match[0].length - 1
    for (; k < source.length; k += 1) {
      if (source[k] === '(') depth += 1
      else if (source[k] === ')') { depth -= 1; if (depth === 0) break }
    }
    out.push({
      line: source.slice(0, match.index).split('\n').length,
      argsText: source.slice(match.index + match[0].length, k),
    })
  }
  return out
}

/** 第一个顶层实参（按顶层逗号切）。 */
function firstArgument(argsText) {
  let depth = 0
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return argsText.slice(0, i)
  }
  return argsText
}

/** 从 `(` 处配对切出参数表（返回闭合下标）。 */
function matchParen(source, open) {
  let depth = 0
  for (let k = open; k < source.length; k += 1) {
    if (source[k] === '(') depth += 1
    else if (source[k] === ')') { depth -= 1; if (depth === 0) return k }
  }
  return source.length - 1
}

/** 从 `{` 处配对切出块体（返回闭合下标）。 */
function matchBrace(source, open) {
  let depth = 0
  for (let k = open; k < source.length; k += 1) {
    if (source[k] === '{') depth += 1
    else if (source[k] === '}') { depth -= 1; if (depth === 0) return k }
  }
  return source.length - 1
}

/**
 * 全部 `try { … } catch { … }` 配对（含 `try { … } finally { … }` 的无 catch 形态被跳过）。
 * @param {string} source - 去注释后的源码。
 * @returns {Array<object>} `{line, tryBody, catchBody, catchClose}`。
 */
function tryCatchPairs(source) {
  const out = []
  const re = /\btry\b[^{]*\{/gu
  let match
  while ((match = re.exec(source)) !== null) {
    const tryOpen = match.index + match[0].length - 1
    const tryClose = matchBrace(source, tryOpen)
    // try 与 catch 之间只允许空白、注释（已去）与 `finally {…}` 段。
    let cursor = tryClose + 1
    let guard = 0
    while (guard < 4) {
      guard += 1
      const rest = source.slice(cursor)
      const m = /^\s*(?:(finally)\s*\{|(catch)\b[^{]*\{)/u.exec(rest)
      if (m === null) break
      const open = cursor + m[0].length - 1
      if (m[1] !== undefined) { // finally：跳过它，继续找 catch（语法上 catch 在 finally 前）
        cursor = matchBrace(source, open) + 1
        continue
      }
      const close = matchBrace(source, open)
      out.push({
        line: source.slice(0, match.index).split('\n').length,
        // `catch` 关键字的位置：{@link enclosingFunctionName} 按"包含它的最内层函数体"取名。
        catchStart: cursor + m[0].indexOf('catch'),
        tryBody: source.slice(tryOpen + 1, tryClose),
        catchBody: source.slice(open + 1, close),
        catchClose: close,
      })
      cursor = close + 1
      break
    }
    re.lastIndex = tryClose + 1
  }
  return out
}

/**
 * 包含 `index` 的**最内层**函数/方法名（取不到返回 `<anonymous>`）。
 *
 * 为什么不是"回溯最近一个函数头行"：嵌套箭头函数（`const tryCreate = () => {`）
 * 会盖住外层函数名，登记键就会指错函数（本仓 `update.js` 实测踩过）。
 * 这里按**函数体区间包含关系**取最内层，键才能指到真正的宿主函数。
 * @param {Array<{name: string, open: number, close: number}>} ranges - {@link functionRanges} 的结果。
 * @param {number} index - 目标位置。
 * @returns {string} 函数名。
 */
function enclosingFunctionName(ranges, index) {
  let best = null
  for (const range of ranges) {
    if (range.open < index && index <= range.close && (best === null || range.open > best.open)) best = range
  }
  return best === null ? '<anonymous>' : best.name
}

/** 递归列出 `lib/` 下的全部 `.js`（相对 lib 的路径，`/` 分隔）。 */
export function listLibModules(packageRoot) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      if (entry.name.endsWith('.js')) out.push(rel)
    }
  }
  walk(join(packageRoot, 'lib'), '')
  return out.sort()
}

/**
 * 一行"像函数头"的代码里的函数名。
 *
 * 规则：取**第一个 `(` 之前**的最后一个标识符 —— 这样 `function f(a) {`、
 * `async get(x) {`、`const load = () => {` 三种写法都能拿到名字；`if (…) {`
 * 这类控制流行的最后一个标识符是关键字，直接被 {@link NOT_A_FUNCTION} 排掉。
 * @param {string} line - 源码的一行。
 * @returns {string|null} 函数名；不是函数头时为 `null`。
 */
function headerNameOf(line) {
  const at = line.indexOf('(')
  if (at < 0) return null
  const ids = [...line.slice(0, at).matchAll(/[A-Za-z_$][\w$]*/gu)].map((m) => m[0])
  const last = ids.at(-1)
  if (last === undefined || NOT_A_FUNCTION.has(last)) return null
  return last
}

/**
 * 模块内的全部函数/方法体区间（行级识别函数头 + 花括号配对）。
 * @param {string} code - 去注释后的源码。
 * @returns {Array<{name: string, open: number, close: number}>} 按 `open` 升序。
 */
function functionRanges(code) {
  const out = []
  const lines = code.split('\n')
  let offset = 0
  for (const line of lines) {
    if (/(?:\{|=>)\s*$/u.test(line)) {
      const name = headerNameOf(line)
      if (name !== null) {
        // 函数体左括号 = **参数表闭合括号之后**的第一个 `{` —— 不能取行内第一个 `{`，
        // 否则 `function f(a, b = {}) {` 会把默认参数里的 `{}` 当成函数体
        // （本仓 advisor/index.js 实测：`installAdvisor` 的体被算成 1 个字符）。
        const at = line.indexOf('(')
        if (at >= 0) {
          const closeParen = matchParen(code, offset + at)
          const after = /^\s*(?:=>\s*)?\{/u.exec(code.slice(closeParen + 1))
          if (after !== null) {
            const open = closeParen + after[0].length
            out.push({ name, open, close: matchBrace(code, open) })
          }
        } else {
          // 无参数括号的箭头函数：`const f = x => {`
          const arrowAt = line.indexOf('=>')
          const open = code.indexOf('{', offset + arrowAt)
          if (arrowAt >= 0 && open >= 0) out.push({ name, open, close: matchBrace(code, open) })
        }
      }
    }
    offset += line.length + 1
  }
  return out
}

/** 名字 → 函数体文本（同名取第一个）。 */
function localFunctions(code) {
  const out = new Map()
  for (const range of functionRanges(code)) {
    if (!out.has(range.name)) out.set(range.name, code.slice(range.open + 1, range.close))
  }
  return out
}

/**
 * **一层以上的本地读函数闭包**：模块内哪些函数（直接或间接）会读一次"会被回写"的路径，
 * 以及它们各自命中的那条回写路径。
 *
 * 为什么需要它：把 `readFileSync(overridesFile, …)` 抽进 `readOverridesBaseline()`
 * 之后，候选 catch 的 try 体里只剩 `adoptOverridesBaseline()` —— 只看 try 体文本会
 * **漏掉**这个形态（FIX-47① 自己就是这么重构的）。本函数把"读"沿模块内调用链
 * 传递一层以上（不动点迭代），重构过的形态仍然落在面内；命中的 token 也沿调用链
 * 继承，登记键因此指向真正的回写路径（而不是模块里第一条 RMW 读）。
 * @param {string} code - 去注释后的源码。
 * @param {(target: string) => object|null} rmwHit - "这次读是否命中回写路径"。
 * @returns {Map<string, {token: string, write: object}>} 函数名 → 命中的回写路径。
 */
function localReadHelpers(code, rmwHit) {
  const functions = localFunctions(code)
  const hits = new Map()
  let changed = true
  while (changed) {
    changed = false
    for (const [name, body] of functions) {
      if (hits.has(name)) continue
      let hit = null
      for (const readName of READ_CALLS) {
        for (const call of callSites(body, readName)) {
          const found = rmwHit(firstArgument(call.argsText).trim())
          if (found !== null) { hit = found; break }
        }
        if (hit !== null) break
      }
      if (hit === null) {
        for (const [callee, inherited] of hits) {
          if (new RegExp(`\\b${callee}\\s*\\(`, 'u').test(body)) { hit = inherited; break }
        }
      }
      if (hit !== null) { hits.set(name, hit); changed = true }
    }
  }
  return hits
}

/**
 * 扫一个模块，返回 RMW 配对与候选 catch。
 * @param {string} source - 模块原文。
 * @returns {{rmwPairs: Array<object>, candidates: Array<object>}} 扫描结果。
 */
export function scanModule(source) {
  const code = blankComments(source)
  const reads = []
  const writes = []
  for (const name of READ_CALLS) {
    for (const call of callSites(code, name)) reads.push({ line: call.line, target: firstArgument(call.argsText).trim() })
  }
  for (const name of WRITE_CALLS) {
    for (const call of callSites(code, name)) writes.push({ line: call.line, target: firstArgument(call.argsText).trim() })
  }
  for (const read of reads) read.tokens = identityTokens(read.target)
  for (const write of writes) write.tokens = identityTokens(write.target)

  /** 一次调用是否命中"该模块某条回写路径"。 */
  const rmwHit = (targetText) => {
    const tokens = identityTokens(targetText)
    for (const write of writes) {
      for (const token of tokens) {
        if (write.tokens.has(token)) return { token, write }
      }
    }
    return null
  }

  const rmwPairs = []
  for (const read of reads) {
    const hit = rmwHit(read.target)
    if (hit !== null) rmwPairs.push({ read: read.target, write: hit.write.target, token: hit.token })
  }

  const ranges = functionRanges(code)
  const localReaders = localReadHelpers(code, rmwHit)
  const candidates = []
  for (const pair of tryCatchPairs(code)) {
    if (/\bthrow\b/u.test(pair.catchBody)) continue
    // try 体里必须真的读了一次"会被回写"的路径（否则与 RMW 无关，如 rmSync 忽略）。
    // 直接读（`readFileSync(p)`）与**经模块内读函数**（`readStateFile(p)` /
    // `adoptOverridesBaseline()`）都算 —— 后者由 localReadHelpers 的调用链闭包给出。
    let hit = null
    for (const name of READ_CALLS) {
      for (const call of callSites(pair.tryBody, name)) {
        const found = rmwHit(firstArgument(call.argsText).trim())
        if (found !== null) { hit = found; break }
      }
      if (hit !== null) break
    }
    if (hit === null) {
      for (const [callee, inherited] of localReaders) {
        if (new RegExp(`\\b${callee}\\s*\\(`, 'u').test(pair.tryBody)) { hit = inherited; break }
      }
    }
    if (hit === null) continue
    // 闸门必须写在 **catch 体内**。刻意不看 catch 之后的行：那次尝试把"同一函数里
    // 别的 `assertXxxWritable()` 调用点"也算成了闸门，于是"catch 改回裸的、闸门函数
    // 还留在文件里"被判成已修（FIX-47① 的变异 M1 实测踩过这个假绿）。代价是
    // "catch 之后才记标记"的写法会被判成候选 ⇒ 必须登记 —— 这正是 fail-closed 方向。
    if (GATE_MARKERS.test(pair.catchBody)) continue
    const isEmpty = pair.catchBody.trim() === ''
    if (!isEmpty && !EMPTY_RETURN.test(`${pair.catchBody}\n`)) continue
    candidates.push({
      line: pair.line,
      fn: enclosingFunctionName(ranges, pair.catchStart),
      shape: isEmpty ? 'bare' : 'return-empty',
      body: pair.catchBody.replace(/\s+/gu, ' ').trim().slice(0, 90),
      token: hit.token,
      writeTarget: hit.write.target,
    })
  }
  // 登记键：不用行号（行号会漂，登记表就变成噪音）。同一模块内同 (函数, 形态, 目标 token)
  // 的多次出现按出现顺序编号 —— 新增一个同形点位会让编号进位 ⇒ 未登记即红。
  const counters = new Map()
  for (const candidate of candidates) {
    const base = `${candidate.fn}#${candidate.shape}#${candidate.token}`
    const next = (counters.get(base) ?? 0) + 1
    counters.set(base, next)
    candidate.key = `${base}#${next}`
  }
  return { rmwPairs, candidates }
}

/** 扫整棵 `lib/`：返回每个模块的扫描结果。 */
export function scanLib(packageRoot) {
  const modules = []
  for (const rel of listLibModules(packageRoot)) {
    const source = readFileSync(join(packageRoot, 'lib', rel), 'utf8')
    modules.push({ rel, ...scanModule(source) })
  }
  return modules
}
