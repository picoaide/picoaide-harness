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
 *  1. **try 体里有一次 RMW 读**：{@link READ_CALLS}（或名字落在
 *     {@link READ_CALL_NAME} 这一族、且首个实参命中回写路径的调用 —— 见下）的目标
 *     表达式与**本模块**某个 {@link WRITE_CALLS} 的目标表达式**共享至少一个标识符
 *     或字符串字面量**（这正是"以读到的值为基线回写"的语法必要条件）；
 *  2. **catch 吞掉错误**：块内没有 `throw` **语句**（字符串/注释里的 "throw"
 *     三个字母不算 —— 第三十二轮 AE1 的 F2b 形态就是靠这个逃逸的）；
 *  3. **catch 留下空基线**（三种形态）——
 *     · 形态① `return-empty`：显式空基线返回（`return {}`、`return ''`、`return null`、
 *       `return undefined`、`return []`、`new Map()`、`0`、`false`）；
 *     · 形态② `bare`：块体（去注释后）为空、不返回也不抛，调用方继续用初始的空基线；
 *     · 形态③ `assign-empty`（第三十三轮 FIX-48① 新增）：把**进回写路径的标识符**
 *       （读目标 / 写目标 / 写实参里的标识符）**赋值**成空基线表达式 ——
 *       `data = DEFAULTS`、`this.items = []` 都算；`DEFAULTS` 允许是模块级
 *       `const`（对象/数组字面量或另一个空基线常量）。AE1 实测：**赋值式**原先
 *       完全不在面内，用本仓自己的写原语 + 赋值空基线能让整包 `1183/1182/0/1`
 *       EXIT=0（与不注入时逐字相同）。
 *
 * **非候选（已修形态）**：catch 内出现"记失败标记 / 写前闸门"的**调用/赋值**
 * （{@link GATE_MARKERS}）—— 那是 FIX-45③ / FIX-47① / FIX-48② 的**目标形态**：
 * 读面可以降级（不阻断评审/面板），但写路径必须被闸门拒掉。刻意**不**把这批登记进
 * 豁免表：它们的正确性由"闸门标记必须存在"这个前向条件守住（拆掉闸门即从已修掉回
 * 候选 ⇒ 红）。
 *
 * 判据绑<strong>结构</strong>而不是"字符串在场"：闸门标记一律要求是**调用点/赋值**
 * （`noteLoadFailure(` / `loadErrors.set(` / `assert*Writable(` / `stateLoadError =` /
 * `quarantineState(`）。第三十二轮 AE1 的 F2/F2b 形态证明：`catch` 里写一句含
 * `refuse` 的**日志文案**、或字符串里带 `throw` 三个字母，原先都被误判成"已修"。
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
 * - 只扫 `lib/**` 的 `.js` / `.mjs` / `.cjs`（本插件入库源码；`src/**` 只是客户端
 *   构建输入）。第三十二轮 AE1 的 F4 形态：只把同一份源码的扩展名改成 `.mjs`
 *   原先就整条逃逸（一行修复）。
 * - "共享标识符"是**语法层**的必要条件，不是跨函数数据流证明：它可能把
 *   "同名字段其实指向不同文件"的点位收进面内 ⇒ 只会**多**要求登记一条，不会漏。
 *   反向的漏（真 RMW 但读写两侧的路径表达式毫无共同标识符）在本插件的写法下不存在
 *   （读写都走同一个 `xxxFile` / `rel` 变量或同一段字面量）。
 * - `load(...)` / `persist(...)` 这类**自定义**读写方法名不在 {@link READ_CALLS} /
 *   {@link WRITE_CALLS} 里（模块私有、名字无法穷举）。这类点位靠三条通道落进面内：
 *   ①**同模块内**的 `readFileSync` / `writeFileAtomicSafeAt` 适配器（本插件的注入式
 *   读写都是这个形状）；②**跨模块**的具名导入闭包（{@link moduleReadHelpers} +
 *   {@link staticImports}：`import { readJsonFile } from './state-io.js'` 后
 *   `readJsonFile(file)` 算一次读）；③名字落在 {@link READ_CALL_NAME}
 *   （`read*` / `load*` / `adopt*`）且**首个实参命中回写路径**的调用点。
 * - 跨模块闭包只认**相对路径的具名导入**（`import { x } from './y.js'`）与
 *   `export default function name(){}`；命名空间导入（`import * as ns`）、
 *   包名导入、经 `export { x } from './y.js'` 转发的再导出**不在面内** ——
 *   这三类要逃逸需要刻意构造，且它们逃逸的只是"识别读"，不是"回写"本身。
 * - 形态③（赋值空基线）的取值域：右侧必须是**空字面量**（`{}`/`[]`/`''`/`null`/
 *   `undefined`/`new Map()`/`0`/`false`）**或一个模块级 `const` 常量**（对象/数组
 *   字面量，或指向另一个这样的常量）。`data = makeDefaults()` 这类**调用式**默认值
 *   不在面内（无法静态判定它是否为空基线）。
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
 * "读调用"的**名字族**兜底通道（第三十三轮 FIX-48①）：`read*` / `load*` / `adopt*`
 * 的调用点，只要**首个实参命中回写路径**就算一次 RMW 读。
 *
 * 为什么需要：`READ_CALLS` 是显式枚举，跨模块/自定义读函数（`readJsonFile(file)`、
 * `loadSidecar(file)`）原先整类落空；而"名字以 read/load/adopt 开头 + 参数就是那条
 * 会被回写的路径"这两条同时成立时，误报面极小（真正决定取值域的是 {@link rmwHit}
 * 的 token 交集，不是名字本身）。
 */
export const READ_CALL_NAME = /^(?:read|load|adopt)[A-Za-z0-9_$]*$/u

/**
 * "这段 catch 已经把读失败变成可判定的状态"的标记 —— 出现任一即视为**已修形态**。
 *
 * 刻意用**语义命名族**而不是"必须调某个具体函数"：这些名字在 FIX-45③ / FIX-47① /
 * FIX-48② 的三处实现里同族（`noteLoadFailure(` / `loadErrors.set|delete(` /
 * `loadFailed.add|delete(` / `assertXxxWritable(` / `stateLoadError =` /
 * `quarantineState(`）。
 *
 * **必须是调用点或赋值**（第三十三轮 FIX-48① 收紧）：这里刻意**不再**收 `refuse`
 * 与 `throw` 这类裸词 —— AE1 实测在 catch 里写一句含 "refuse" 的日志文案、或字符串
 * 里带 "throw" 三个字母，就能把"裸 catch 回写"伪装成"已修形态"。`throw` 语句另有
 * {@link hasThrowStatement} 按语法层判定（它本来就让整条候选不成立，不是闸门）。
 */
export const GATE_MARKERS = /(?:noteLoadFailure\s*\(|loadErrors\s*\.\s*(?:set|delete)\s*\(|loadFailed\s*\.\s*(?:add|delete)\s*\(|assert[A-Za-z]*Writable\s*\(|stateLoadError\s*=|quarantineState\s*\()/u

/** 显式空基线的返回值形态（形态①）。 */
const EMPTY_RETURN = /return\s+(?:\{\s*\}|''|""|``|null|undefined|\[\s*\]|new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(\s*\)|0|false)\s*(?:;|\n|$)/u

/** 空基线表达式（形态③的右侧）：空字面量，或模块级常量标识符（另行判定）。 */
const EMPTY_LITERAL = /^(?:\{\s*\}|\[\s*\]|''|""|``|null\b|undefined\b|new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(\s*\)|0\b|false\b)/u

/** 形如 `x = …` / `this.x = …` 的赋值（排掉 `==` / `===` / `=>` / `+=` 等）。 */
const ASSIGNMENT = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*=(?![=>])\s*/gu

/** 模块级 `const NAME = …` 绑定（形态③的常量折叠用）。 */
const MODULE_CONST = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*/gu

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

/**
 * catch 体内是否有**真的 `throw` 语句**（第三十三轮 FIX-48①）。
 *
 * 为什么不能用 `/\bthrow\b/` 直接测原文：AE1 的 F2b 形态是
 * `console.warn('… we will not throw here (fail-soft)'); return {}` ——
 * `throw` 三个字母出现在**字符串**里，却让"catch 吞掉了错误"这条判据失效，
 * 整条候选被跳过。这里先 {@link blankStrings} 再去匹配，字符串/模板里的
 * `throw` 一律不算；注释早在 {@link blankComments} 阶段就没了。
 * @param {string} catchBody - catch 块体原文。
 * @returns {boolean} 是否存在真正的 throw 语句。
 */
function hasThrowStatement(catchBody) {
  return /(?:^\s*|[;{}:]\s*|\belse\s+|\bcase\s+[^:]*:\s*)throw\b/mu.test(blankStrings(catchBody))
}

/**
 * 模块级 `const NAME = <字面量>` 的常量表（形态③的**一层常量折叠**）。
 *
 * `data = DEFAULTS` 与 `data = {}` 在"以空基线回写"这件事上完全等价（AE1 的 F1
 * 形态就写成前者），所以赋值右侧允许是一个模块级常量标识符。取值域刻意只收
 * **对象/数组字面量**与**空字面量**：`const DEFAULTS = makeDefaults()` 这类调用式
 * 默认值无法静态判定，不在面内（边界已写在模块头）。
 * @param {string} code - 去注释后的源码。
 * @returns {Map<string, string>} 常量名 → 右侧表达式文本（截至行尾或分号）。
 */
function moduleConstBaselines(code) {
  const out = new Map()
  for (const match of code.matchAll(MODULE_CONST)) {
    const rest = code.slice(match.index + match[0].length)
    const value = (/^[^\n;]*/u.exec(rest)?.[0] ?? '').trim()
    if (value !== '') out.set(match[1], value)
  }
  return out
}

/**
 * 一个表达式文本是不是"空基线表达式"：空字面量，或指向模块级常量的标识符
 * （常量本身还要是对象/数组字面量或另一个空基线常量；最多跟 4 跳防环）。
 * @param {string} expression - 赋值右侧文本。
 * @param {Map<string, string>} consts - {@link moduleConstBaselines} 的结果。
 * @returns {boolean} 是否为空基线。
 */
function isEmptyBaselineValue(expression, consts) {
  let text = expression.trim()
  const seen = new Set()
  for (let hop = 0; hop < 4; hop += 1) {
    if (EMPTY_LITERAL.test(text)) return true
    const identifier = /^([A-Za-z_$][\w$]*)\s*$/u.exec(text)?.[1]
    if (identifier === undefined || seen.has(identifier)) return false
    seen.add(identifier)
    const next = consts.get(identifier)
    if (next === undefined) return false
    // 模块级 `const DEFAULTS = { pins: [], muted: [] }`：对象/数组字面量即"默认基线"。
    if (/^[{[]/u.test(next)) return true
    text = next
  }
  return false
}

/**
 * 形态③：catch 体内把**进回写路径的标识符**赋成空基线表达式，返回命中的标识符。
 *
 * 为什么"进回写路径"的三个来源都要收：写目标（`writeFileSync(file, …)` 的 `file`）、
 * 写实参（`JSON.stringify(data)` 里的 `data` —— 真正被序列化进文件的那份内存态）、
 * 读目标（`readFileSync(this.file)` 的 `this.file` 的 `file`）。本仓的两处真实点位
 * 分别落在前两类：`this.items = []`（notify-web#load，`items` 在写实参里）与
 * `data = DEFAULTS`（AE1 的 F1 探针，`data` 在写实参里）。
 * @param {string} catchBody - catch 块体原文。
 * @param {Set<string>} baselineIds - 进回写路径的标识符集合。
 * @param {Map<string, string>} consts - {@link moduleConstBaselines} 的结果。
 * @returns {string|null} 命中的标识符（未命中为 `null`）。
 */
function emptyBaselineAssignment(catchBody, baselineIds, consts) {
  const code = blankStrings(catchBody)
  for (const match of code.matchAll(ASSIGNMENT)) {
    const lhs = match[1].split('.').at(-1)?.trim() ?? ''
    if (lhs === '' || !baselineIds.has(lhs)) continue
    const value = (/^[^\n;]*/u.exec(code.slice(match.index + match[0].length))?.[0] ?? '').trim()
    if (isEmptyBaselineValue(value, consts)) return lhs
  }
  return null
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

/** `lib/` 下属于扫描面的源码扩展名（FIX-48①：`.mjs` / `.cjs` 与 `.js` 同面）。 */
export const LIB_SOURCE_EXT = /\.(?:js|mjs|cjs)$/u

/** 递归列出 `lib/` 下的全部源码（相对 lib 的路径，`/` 分隔）。 */
export function listLibModules(packageRoot) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      if (LIB_SOURCE_EXT.test(entry.name)) out.push(rel)
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
          if (arrowAt >= 0 && open >= 0) {
            out.push({ name, open, close: matchBrace(code, open) })
          }
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
 * `body` 里是否有一次"读 `expression`"的调用（显式 {@link READ_CALLS} ∪
 * {@link READ_CALL_NAME} 名字族，且首实参含该标识符）。
 * @param {string} body - 函数体文本。
 * @param {string} expression - 目标标识符。
 * @returns {boolean} 是否读到。
 */
function readsExpression(body, expression) {
  for (const name of READ_CALLS) {
    for (const call of callSites(body, name)) {
      if (identityTokens(firstArgument(call.argsText)).has(expression)) return true
    }
  }
  for (const call of namedReadCalls(body)) {
    if (identityTokens(firstArgument(call.argsText)).has(expression)) return true
  }
  return false
}

/**
 * `body` 里全部**名字落在 {@link READ_CALL_NAME} 这一族**的调用点（含显式表里的名字）。
 * @param {string} body - 任意代码片段。
 * @returns {Array<{line: number, argsText: string}>} 调用点。
 */
function namedReadCalls(body) {
  const out = []
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/gu
  const seen = new Set()
  let match
  while ((match = re.exec(body)) !== null) {
    const name = match[1]
    if (!READ_CALL_NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push(...callSites(body, name))
  }
  return out
}

/**
 * 本模块里"读它拿到的**第一个路径参数**"的函数名（跨模块闭包的索引侧）。
 *
 * 判据：函数第一个形参是纯标识符，且函数体内有一次读调用，其首实参含该形参名。
 * `readJsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')) }` 即命中。
 *
 * 刻意**不**复用 {@link functionRanges}：那个实现只认"行尾是 `{` 或 `=>`"的函数头
 * （单行 `function f(p) { … }` 整条落空），而它同时承担登记键的宿主函数名判定 ——
 * 动它会漂移既有登记键。这里独立按 `function NAME(` / `const NAME = (` / 无括号箭头
 * 三个头部形态 + 括号/花括号配对取体，单行与多行同面。
 * @param {string} code - 去注释后的源码。
 * @returns {{helpers: Set<string>, defaultHelper: string|null}} 命中函数名集合 + 默认导出名。
 */
export function readPathHelpers(code) {
  const helpers = new Set()
  const consider = (name, open) => {
    const close = matchParen(code, open)
    const after = /^\s*(?:=>\s*)?\{/u.exec(code.slice(close + 1))
    if (after === null) return
    const bodyOpen = close + after[0].length
    const first = code.slice(open + 1, close).split(',')[0]?.trim() ?? ''
    if (!/^[A-Za-z_$][\w$]*$/u.test(first)) return
    if (readsExpression(code.slice(bodyOpen + 1, matchBrace(code, bodyOpen)), first)) helpers.add(name)
  }
  for (const match of code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gu)) {
    consider(match[1] ?? match[2], match.index + match[0].length - 1)
  }
  for (const match of code.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>\s*\{/gu)) {
    // 无括号单参箭头：`const jsonOf = path => { … }`
    const bodyOpen = match.index + match[0].length - 1
    if (readsExpression(code.slice(bodyOpen + 1, matchBrace(code, bodyOpen)), match[2])) helpers.add(match[1])
  }
  const defaultHelper = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(code)?.[1] ?? null
  return { helpers, defaultHelper: defaultHelper !== null && helpers.has(defaultHelper) ? defaultHelper : null }
}

/** 把 `./x.js` / `../sync/filesets.js` 归一到相对 `lib/` 的路径（越界返回 `null`）。 */
function resolveLibRel(fromRel, spec) {
  const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : ''
  const parts = dir === '' ? [] : dir.split('/')
  for (const segment of spec.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') { if (parts.length === 0) return null; parts.pop(); continue }
    parts.push(segment)
  }
  const joined = parts.join('/')
  if (joined === '') return null
  return LIB_SOURCE_EXT.test(joined) ? joined : `${joined}.js`
}

/**
 * 本模块的**静态相对导入**绑定表（FIX-48① 跨模块闭包的调用侧）。
 *
 * 只认 `import { x as y } from './z.js'` 与 `import y from './z.js'`；
 * 命名空间导入、包名导入、再导出不在面内（边界写在模块头）。
 * @param {string} fromRel - 本模块相对 `lib/` 的路径。
 * @param {string} code - 去注释后的源码。
 * @returns {Map<string, {rel: string, imported: string}>} 本地名 → 目标模块与导入名。
 */
function staticImports(fromRel, code) {
  const out = new Map()
  const re = /import\s+([^'"]*?)\s+from\s*['"](\.[^'"]*)['"]/gu
  let match
  while ((match = re.exec(code)) !== null) {
    const rel = resolveLibRel(fromRel, match[2])
    if (rel === null) continue
    const clause = match[1]
    const named = /\{([^}]*)\}/u.exec(clause)
    if (named !== null) {
      for (const part of named[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/u)
        const imported = bits[0]?.trim() ?? ''
        const local = (bits[1] ?? bits[0] ?? '').trim()
        if (/^[A-Za-z_$][\w$]*$/u.test(imported) && /^[A-Za-z_$][\w$]*$/u.test(local)) {
          out.set(local, { rel, imported })
        }
      }
    }
    const rest = clause.replace(/\{[^}]*\}/u, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/u, '')
    for (const name of rest.split(',').map((s) => s.trim())) {
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) out.set(name, { rel, imported: 'default' })
    }
  }
  return out
}

/**
 * 扫整棵 `lib/` 得到的"跨模块读函数"索引：模块路径 → 它会读首参路径的函数名。
 * @param {Map<string, string>} sources - 相对路径 → 原文。
 * @returns {Map<string, {helpers: Set<string>, defaultHelper: string|null}>} 索引。
 */
function moduleReadHelpers(sources) {
  const out = new Map()
  for (const [rel, source] of sources) out.set(rel, readPathHelpers(blankComments(source)))
  return out
}

/**
 * 本模块从**其它模块**导入的"读首参路径"函数名（调用侧闭包）。
 * @param {string} fromRel - 本模块相对 `lib/` 的路径。
 * @param {string} code - 去注释后的源码。
 * @param {Map<string, {helpers: Set<string>, defaultHelper: string|null}>} index - {@link moduleReadHelpers}。
 * @returns {Set<string>} 本地绑定名集合。
 */
function crossModuleReaders(fromRel, code, index) {
  const out = new Set()
  for (const [local, binding] of staticImports(fromRel, code)) {
    const entry = index.get(binding.rel)
    if (entry === undefined) continue
    if (binding.imported === 'default') {
      if (entry.defaultHelper !== null) out.add(local)
      continue
    }
    if (entry.helpers.has(binding.imported)) out.add(local)
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
 *
 * 第三十三轮 FIX-48① 增补两条通道：**跨模块读函数**（{@link crossModuleReaders}，
 * `readJsonFile(file)` 这类具名导入）与 {@link READ_CALL_NAME} 名字族调用点。
 * @param {string} code - 去注释后的源码。
 * @param {(target: string) => object|null} rmwHit - "这次读是否命中回写路径"。
 * @param {Set<string>} crossReaders - 跨模块导入的读函数本地名。
 * @returns {Map<string, {token: string, write: object}>} 函数名 → 命中的回写路径。
 */
function localReadHelpers(code, rmwHit, crossReaders = new Set()) {
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
        for (const call of namedReadCalls(body)) {
          const found = rmwHit(firstArgument(call.argsText).trim())
          if (found !== null) { hit = found; break }
        }
      }
      if (hit === null) {
        for (const callee of crossReaders) {
          for (const call of callSites(body, callee)) {
            const found = rmwHit(firstArgument(call.argsText).trim())
            if (found !== null) { hit = found; break }
          }
          if (hit !== null) break
        }
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
 * @param {object} [options] - 可选：跨模块闭包上下文。
 * @param {Set<string>} [options.crossReaders] - 跨模块导入的"读首参路径"函数本地名。
 * @returns {{rmwPairs: Array<object>, candidates: Array<object>}} 扫描结果。
 */
export function scanModule(source, options = {}) {
  const crossReaders = options.crossReaders ?? new Set()
  const code = blankComments(source)
  const consts = moduleConstBaselines(code)
  const reads = []
  const writes = []
  for (const name of READ_CALLS) {
    for (const call of callSites(code, name)) reads.push({ line: call.line, target: firstArgument(call.argsText).trim() })
  }
  for (const name of WRITE_CALLS) {
    for (const call of callSites(code, name)) writes.push({ line: call.line, target: firstArgument(call.argsText).trim(), payload: call.argsText.slice(firstArgument(call.argsText).length) })
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

  // 形态③（赋值空基线）的"进回写路径的标识符"：读目标 ∪ 写目标 ∪ **写实参**
  // （被序列化进文件的那份内存态，如 `JSON.stringify(data)` 里的 `data`）。
  const baselineIds = new Set()
  for (const read of reads) for (const token of read.tokens) baselineIds.add(token)
  for (const write of writes) {
    for (const token of write.tokens) baselineIds.add(token)
    for (const token of identityTokens(write.payload)) baselineIds.add(token)
  }

  const rmwPairs = []
  for (const read of reads) {
    const hit = rmwHit(read.target)
    if (hit !== null) rmwPairs.push({ read: read.target, write: hit.write.target, token: hit.token })
  }

  const ranges = functionRanges(code)
  const localReaders = localReadHelpers(code, rmwHit, crossReaders)
  const candidates = []
  for (const pair of tryCatchPairs(code)) {
    // 判据 2：catch 吞掉错误 = 块内没有 **throw 语句**（字符串里的 "throw" 不算）。
    if (hasThrowStatement(pair.catchBody)) continue
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
      // 名字族（`read*` / `load*` / `adopt*`）与**跨模块导入的读函数**：两者都要求
      // 首个实参命中回写路径，所以取值域的闸门仍是 rmwHit，不是名字本身。
      for (const call of namedReadCalls(pair.tryBody)) {
        const found = rmwHit(firstArgument(call.argsText).trim())
        if (found !== null) { hit = found; break }
      }
    }
    if (hit === null) {
      for (const callee of crossReaders) {
        for (const call of callSites(pair.tryBody, callee)) {
          const found = rmwHit(firstArgument(call.argsText).trim())
          if (found !== null) { hit = found; break }
        }
        if (hit !== null) break
      }
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
    if (GATE_MARKERS.test(blankStrings(pair.catchBody))) continue
    const isEmpty = pair.catchBody.trim() === ''
    const assigned = isEmpty ? null : emptyBaselineAssignment(pair.catchBody, baselineIds, consts)
    const returns = !isEmpty && EMPTY_RETURN.test(`${pair.catchBody}\n`)
    if (!isEmpty && !returns && assigned === null) continue
    candidates.push({
      line: pair.line,
      fn: enclosingFunctionName(ranges, pair.catchStart),
      // 形态名进登记键：`bare` / `return-empty` 是本轮之前的两种（键必须稳定），
      // `assign-empty` 是 FIX-48① 新增的第三种。
      shape: isEmpty ? 'bare' : (returns ? 'return-empty' : 'assign-empty'),
      body: pair.catchBody.replace(/\s+/gu, ' ').trim().slice(0, 90),
      token: hit.token,
      writeTarget: hit.write.target,
      baselineId: assigned,
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

/** 扫整棵 `lib/`：返回每个模块的扫描结果（第三十三轮起带跨模块读函数闭包）。 */
export function scanLib(packageRoot) {
  const rels = listLibModules(packageRoot)
  const sources = new Map()
  for (const rel of rels) sources.set(rel, readFileSync(join(packageRoot, 'lib', rel), 'utf8'))
  const index = moduleReadHelpers(sources)
  const modules = []
  for (const rel of rels) {
    const code = blankComments(sources.get(rel))
    modules.push({
      rel,
      ...scanModule(sources.get(rel), { crossReaders: crossModuleReaders(rel, code, index) }),
    })
  }
  return modules
}
