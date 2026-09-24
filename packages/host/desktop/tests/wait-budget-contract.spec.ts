/**
 * **等待预算契约**的静态判据：`tests/**` 里每一个等待型断言都必须显式给预算，
 * 且预算必须来自 `tests/wait-budgets.ts` 的集中表。
 *
 * ## 为什么需要这条判据（第十轮审计 M-1 的假红）
 *
 * 同一个 commit（`f36a9711ae`）的 master push run 红在
 * `tests/updates.spec.ts > keeps the download state and the countdown visible during
 * the backoff wait`（`assertion inside vi.waitFor`），而**同一棵树**的 tag run 全绿。
 * 机制：`vi.waitFor` 的缺省 `timeout = 1_000ms`（vitest 4.1.8），而这里要观察的是
 * "清单请求 → 状态机 → 快照 / 托盘"这条跨若干异步边界的链 —— 预算比现象小一个数量级。
 *
 * 判据必须是**代码感知**的（不照 `tests/profile-context-wiring.spec.ts` 那条同族教训）：
 * 文本包含既会被注释掉的行骗过（假绿），也会被换行/折行的等价代码误伤（假红）。
 * 所以本文件在 TypeScript AST 上找等待型调用点。
 *
 * ## 判了什么（每一条都能被打坏）
 *
 * 1. 等待型断言必须有第二个参数（options 对象）与其中的 `timeout`；
 * 2. `timeout` 必须引用 `WAIT_BUDGETS.<键>` —— 数值字面量、别的对象一律不算；
 * 3. 引用到的键必须在 `WAIT_BUDGETS` 里真实存在；
 * 4. 表里每一项都必须 ≥ `WAIT_BUDGET_FLOORS` 登记的现象下限（改小预算 ⇒ 判据红）；
 * 5. 每个调用点必须带一行 `//` 理由注释：写在上一行 / 上方（中间只允许空行），或写在
 *    调用所在行的行尾（预算的来源要逐处可读，位置口径与契约文字逐字一致，复审 N5）；
 * 6. 真实产物上逐条派生清单的用例必须显式声明 `TEST_BUDGETS.ARTIFACT_DERIVATION_MS`；
 * 7. 判据自身不空转：扫描面下限 + 扫描器自检（注释/字符串里的同名文本不得被当成调用）；
 * 8. 用例自己的预算（显式 `testTimeout` 或包缺省）必须 ≥ 它内部用到的等待预算，
 *    `it.each(…)` / `it.skipIf(…)` 这类柯里化声明同样在判据面内（第十轮复审 N5），
 *    且"内部用到的等待预算"**沿调用传播**：用例调用的本地 helper / `tests/**` 内相对
 *    导入的 helper 里的等待同样算它的（第十轮复审 N3 通道 ③）；
 * 9. 等待条件不得**钉死墙钟现算字段**的精确值（第二类假红，见
 *    `wait-budgets.ts` 的文件头）—— 判据按**取值形态**判，不按匹配器名单判。
 *
 * ## 第十轮复审：三条假绿通道（N1）与三条仍开的通道（N3）都已收口
 *
 * N1 实测：把契约改坏之后判据仍 EXIT=0 的三条通道 ——
 *
 * 1. **换匹配器**：等待条件写成 `expect(first).toStrictEqual(10_000)`（`first` 是
 *    从 `retryDelayMs` 取出的局部量）——旧判据只枚举 `toBe`/`toEqual` 与数值字面量属性；
 * 2. **非 spec 文件**：`tests/` 下非 `*.spec.ts` 的 helper 里的等待型断言完全不在扫描面；
 * 3. **元素访问拼写**：`vi['waitFor'](…)` —— AST 只认 `Identifier` 接收者，
 *    而"代码位置计数"的 needle 也是 `vi.waitFor(`，双向漏检。
 *
 * N3 又实测出三条**同一"两个见证"设计下仍开**的通道，本文件一并收口：
 *
 * 1. **裸别名**：`const w = vi.waitFor; await w(fn)` —— 别名表只认对象解构，而
 *    `w(fn)` 里也没有 `vi.waitFor(` 可数，两个见证同时失明。现在别名表覆盖"任何指向
 *    这两个 API 的常量绑定"（含 `vi['waitFor']`、`.bind(vi)` 与链式 `const b = a`）；
 * 2. **逗号表达式**：`await (0, vi.waitFor)(fn)` —— callee 被包了一层，
 *    AST 与 needle 同时看不见。现在 callee 先剥包装（括号 / 逗号 / 断言）再判定，
 *    且"代码位置计数"在调用节点上把整个 callee 归一成点访问，两个见证必然一致
 *    （覆盖率对账会把任何不一致打红）；
 * 3. **模块级 helper**：`async function until() { await vi.waitFor(…, 15s) }` +
 *    `it(…, 5_000)` 调用它 —— 旧判据只在用例语法子树内收集等待键。现在从用例体出发
 *    走调用图（本文件函数体 + `tests/**` 内相对导入，带环路保护）。
 *
 * 认账的边界：动态调用、函数值传递、以及 `tests/**` 之外的模块看不见（契约的扫描面
 * 本来就是 `tests/**`）；这些由预算表的现象下限与包级 30s 兜底罩着。
 *
 * 现在的收口：扫描面 = `tests/**` 下**所有** `*.ts` / `*.tsx`（含非 spec）；
 * 拼写面 = 点访问 + 元素访问 + 包装形态 + 解构别名 + 常量别名；
 * 钉死判据 = **取值形态**（墙钟字段/它的标量别名只要进了非比较族断言、或与字面量做等值
 * 比较、或在对象字面量里钉非零值，即红），并保留 `wait-budget-contract:allow-clock-value`
 * 的**显式豁免**（要人写下理由，不能靠换匹配器绕过）。
 *
 * @module dsh-plugin-desktop/tests/wait-budget-contract
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  TEST_BUDGETS,
  TEST_BUDGET_FLOORS,
  WAIT_BUDGETS,
  WAIT_BUDGET_FLOORS,
} from './wait-budgets.ts'

const testsRoot = dirname(fileURLToPath(import.meta.url))

/** 扫描面下限：判据不许在"什么都没扫到"的情况下变绿。 */
const MIN_CALL_SITES = 40
const MIN_FILES_WITH_CALLS = 3

/**
 * 被本契约覆盖的"等待型断言"：两者的缺省 `timeout` 都是 **1s**（vitest 4），
 * 所以同一份预算契约必须同时罩住它们（M-1 的原始口径只说 `vi.waitFor`，
 * 复核时发现同一个套件里还有 4 处 `expect.poll` 吃同一个缺省）。
 */
const WAIT_APIS = [
  { object: 'vi', method: 'waitFor', label: 'vi.waitFor' },
  { object: 'expect', method: 'poll', label: 'expect.poll' },
] as const

/** 契约覆盖的所有调用文本（掩码计数与判据消息共用同一份枚举）。 */
const WAIT_API_NEEDLES = WAIT_APIS.map(api => `${api.object}.${api.method}(`)

/**
 * 比较 / 容差族的匹配器：只有这一族可以接收墙钟现算的值。
 *
 * 口径是"**不断言精确值**"：`toBeGreaterThan(9_900)` 这类断言在墙钟漂 1ms 时仍成立，
 * 而 `toBe(10_000)` / `toStrictEqual(10_000)` / `toMatchObject({x: 10_000})` 不成立
 * 且此后单调变差 ⇒ 条件**永不可满足**（给多少预算都红）。
 */
const COMPARISON_MATCHERS = new Set([
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
  'toBeWithin',
  'toBeDefined',
  'toBeUndefined',
  'toBeTypeOf',
  'toBeNaN',
  'toBeTruthy',
  'toBeFalsy',
  'toBeInstanceOf',
])

/**
 * 显式豁免的标记：写在**判据那一行**或它的**上一行**，并且必须带理由。
 * 例：`// wait-budget-contract:allow-clock-value 冻结时钟下该值是确定性的`
 */
const CLOCK_EXEMPTION = /wait-budget-contract:\s*allow-clock-value\b\s*\S/u

/** 一个等待型调用点。 */
interface WaitForSite {
  /** 1-based line of the call, for the failure message. */
  readonly line: number
  /** 调用形态（`vi.waitFor` / `expect.poll`）。 */
  readonly api: string
  /**
   * 拼写（`dot` / `element` / `wrapped` / `alias`），用于诊断与覆盖率对账。
   *
   * `wrapped` = 直接调用，但 callee 被括号 / 逗号表达式 / 断言包了一层
   * （`(0, vi.waitFor)(fn)`）。它仍然是"代码位置上的一次直接调用"，所以两个见证都必须
   * 看见它：AST 面算它，{@link maskLiteralsAndComments} 也把 callee 归一成点访问。
   * `alias` = 经本地常量绑定（`const w = vi.waitFor`、`const { waitFor } = vi`）的调用，
   * 文本上没有 `vi.waitFor(` 可数，因此两个见证一致地把它排除在"直接调用"之外 —— 而
   * 它自己的调用点仍必须给预算（复审 N3 通道 ①）。
   */
  readonly spelling: 'dot' | 'element' | 'wrapped' | 'alias'
  /** 显式 `timeout` 的表达式文本（未给时为 undefined）。 */
  readonly timeout: string | undefined
  /** 调用点上一行（用于诊断与"理由注释在哪"）。 */
  readonly previousLine: string
  /** 这个调用点是否带理由注释（上一行、上方隔空行，或同一行行尾）。 */
  readonly reasonComment: boolean
  /** 等待条件里"钉死墙钟现算值"的形态（第二类假红，见下）。 */
  readonly clockPins: readonly string[]
}

/** 一个**未被豁免**的等待型调用点上的问题。 */
interface ContractFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/**
 * 由**墙钟现算**的字段：它们的值 = `截止时刻 - Date.now()`，置位与发布之间只隔几条
 * 语句，负载下墙钟越过 1ms 就会差一个单位，而取值此后单调变差 ⇒ 等待条件**永不可
 * 满足**（与等待预算无关）。这类字段只能用**比较**（`toBeGreaterThan`）断言。
 *
 * 实证（2026-09-24，四路并发跑 `updates.spec.ts`）：`keeps the download state and the
 * countdown visible during the backoff wait` 收到的快照序列是 `retryDelayMs` =
 * `0 0 0 0 0 9999 9000 7997 6997 …` —— 首帧是 9_999 而不是 10_000，断言红。
 */
const CLOCK_DERIVED_FIELDS = new Set(['retryDelayMs'])

/** 按扩展名选 script kind：`.tsx` 用 TSX，其余用 TS（`<T>x` 断言只在 TS 下成立）。 */
function scriptKindOf(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** 一个文件里的一条已解析拼写：本地名 → (`vi` | `expect`) + 方法名。 */
type AliasMap = Map<string, { object: string, method: string }>

/**
 * 剥掉不影响"这是哪个函数"的包装：括号、逗号表达式取右值、`as` / `!` / `<T>` 断言。
 *
 * 复审 N3 通道 ② 的形态 `(0, vi.waitFor)(fn)` 就是这么藏起来的：callee 是
 * `ParenthesizedExpression` 包着的逗号表达式，只认 `PropertyAccessExpression` 的
 * 判据看不见它，而 `vi.waitFor(` 这个文本 needle 同样不匹配（`waitFor` 后面是 `)`）。
 * 两个见证同时失明 ⇒ 判据假绿。
 * @param expression - the callee (or any candidate expression).
 * @returns the unwrapped expression and whether any wrapper was removed.
 */
function unwrapWaitCallee(expression: ts.Expression): { inner: ts.Expression, wrapped: boolean } {
  let current = expression
  let wrapped = false
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression
      wrapped = true
      continue
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right
      wrapped = true
      continue
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression
      wrapped = true
      continue
    }
    return { inner: current, wrapped }
  }
}

/**
 * 一个表达式是不是"对 `vi` / `expect` 的等待 API 的引用"（不调用，只取值）。
 *
 * 覆盖点访问与元素访问两种拼写；`vi.waitFor.bind(vi)` 也算 —— 绑定后的函数就是同一个
 * 等待 API，把它当别的函数放过去，等价于给契约开一条"换个名字"的旁路。
 * @param expression - the candidate.
 * @returns the resolved API shape, or undefined.
 */
function waitReferenceOf(expression: ts.Expression): { api: typeof WAIT_APIS[number], spelling: 'dot' | 'element' } | undefined {
  const inner = unwrapWaitCallee(expression).inner
  const match = (receiver: string, method: string, spelling: 'dot' | 'element'): { api: typeof WAIT_APIS[number], spelling: 'dot' | 'element' } | undefined => {
    const found = WAIT_APIS.find(candidate => candidate.object === receiver && candidate.method === method)
    return found === undefined ? undefined : { api: found, spelling }
  }
  // `vi.waitFor.bind(vi)`: the bound function IS the same wait API. Resolving it is
  // what keeps `const w = vi.waitFor.bind(vi)` from being a rename-shaped bypass.
  if (ts.isCallExpression(inner)) {
    const callee = unwrapWaitCallee(inner.expression).inner
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return waitReferenceOf(callee.expression)
    return undefined
  }
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
    return match(inner.expression.text, inner.name.text, 'dot')
  }
  if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
    const argument = inner.argumentExpression
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      return match(inner.expression.text, argument.text, 'element')
    }
  }
  return undefined
}

/**
 * 解析一个调用点的**拼写**：点访问、元素访问（`vi['waitFor']`）、被包装的直接调用
 * （`(0, vi.waitFor)(fn)`）或别名（`const w = vi.waitFor` / `const { waitFor } = vi`）。
 * @param node - the call expression.
 * @param aliases - names bound in this file to one of the wait APIs.
 * @param _file - the source file (kept for future diagnostics).
 * @returns the resolved call shape, or undefined for a call this contract ignores.
 */
function resolveWaitCall(
  node: ts.CallExpression,
  aliases: AliasMap,
  _file: ts.SourceFile,
): { api: typeof WAIT_APIS[number], spelling: WaitForSite['spelling'] } | undefined {
  const { inner, wrapped } = unwrapWaitCallee(node.expression)
  // Direct spellings first, on the unwrapped callee: the wrapping must not decide
  // whether the contract sees the call (复审 N3 通道 ②).
  const direct = waitReferenceOf(inner)
  if (direct !== undefined) {
    return { api: direct.api, spelling: wrapped ? 'wrapped' : direct.spelling }
  }
  // `const w = vi.waitFor; w(…)` — the alias is a real call site and must carry a
  // budget like any other (复审 N3 通道 ①).
  if (ts.isIdentifier(inner)) {
    const bound = aliases.get(inner.text)
    if (bound === undefined) return undefined
    const found = WAIT_APIS.find(candidate => candidate.object === bound.object && candidate.method === bound.method)
    return found === undefined ? undefined : { api: found, spelling: 'alias' }
  }
  return undefined
}

/**
 * Collect every local name bound to one of the wait APIs.
 *
 * Two shapes:
 *  - destructuring (`const { waitFor } = vi`, `const { poll: eventually } = expect`);
 *  - a plain constant bound to the API itself (`const w = vi.waitFor`,
 *    `const w = vi['waitFor']`, `const b = vi.waitFor.bind(vi)`, and chains such as
 *    `const w2 = w`). The second shape is 复审 N3 通道 ①: it used to be invisible to
 *    BOTH witnesses at once (`vi.waitFor(` does not appear in `w(fn)` either), which
 *    is precisely how a budgetless wait stayed green.
 *
 * Anything more exotic (a function returning the API, an object property) stays out
 * of the alias map — but a wrapper FUNCTION (`const w = (...a) => vi.waitFor(...a)`)
 * is covered by the local-call propagation instead: the wait inside its body is a
 * call site of its own and the case that invokes it inherits the budget.
 * @param file - the source file.
 * @returns local name → call shape.
 */
function collectAliases(file: ts.SourceFile): AliasMap {
  const aliases: AliasMap = new Map()
  const bindings: Array<{ name: string, initializer: ts.Expression }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const initializer = node.initializer
      const source = ts.isIdentifier(initializer)
        && (initializer.text === 'vi' || initializer.text === 'expect')
        ? initializer.text
        : undefined
      if (source !== undefined) {
        for (const element of node.name.elements) {
          const property = element.propertyName
          const key = property === undefined
            ? (ts.isIdentifier(element.name) ? element.name.text : undefined)
            : (ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined)
          if (key === undefined || !ts.isIdentifier(element.name)) continue
          aliases.set(element.name.text, { object: source, method: key })
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      bindings.push({ name: node.name.text, initializer: node.initializer })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  // Two passes so a chain (`const a = vi.waitFor; const b = a`) resolves whichever
  // order the declarations appear in.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const binding of bindings) {
      if (aliases.has(binding.name)) continue
      const reference = waitReferenceOf(binding.initializer)
      if (reference !== undefined) {
        aliases.set(binding.name, { object: reference.api.object, method: reference.api.method })
        continue
      }
      const inner = unwrapWaitCallee(binding.initializer).inner
      if (ts.isIdentifier(inner)) {
        const bound = aliases.get(inner.text)
        if (bound !== undefined) aliases.set(binding.name, bound)
      }
    }
  }
  return aliases
}

/**
 * 一个调用点是否带**理由注释**。
 *
 * 接受范围与契约文字（`wait-budgets.ts` 第 5 条）逐字一致：注释写在调用点**上一行或
 * 上方（中间只允许空行）**，或写在调用**所在行的行尾**。第十轮复审 N5 报的是摩擦：
 * 旧实现只认"紧邻上一行"这一种写法，而契约文字说的是"上方" —— 于是同一份正当的等待
 * 换个注释位置就红，判据比它自己的文字更严。现在两者对齐，且刻意**只**放宽位置：
 * 完全没有注释仍然红（这条才是契约要的东西）。
 *
 * 行尾注释用调用点的结束位置判定（`end.character` 之后的部分），所以条件里字符串
 * 字面量中的 `//`（`expect(url).toBe('http://…')`）不会被误读成注释。
 * @param lines - the source lines.
 * @param start - the call's start position.
 * @param end - the call's end position.
 * @returns true when a `//` reason comment is attached.
 */
function hasReasonComment(
  lines: readonly string[],
  start: { line: number, character: number },
  end: { line: number, character: number },
): boolean {
  const isComment = (text: string): boolean => /^\s*\/\/\s*\S/u.test(text)
  // 同一行行尾（`… }, { timeout: … }) // 现象：…`）。
  if (/\/\/\s*\S/u.test((lines[end.line] ?? '').slice(end.character))) return true
  // 上方：跳过空行，第一个非空行必须是注释行（"隔一空行"因此也算，与契约文字一致）。
  for (let line = start.line - 1; line >= 0; line -= 1) {
    const text = lines[line] ?? ''
    if (text.trim() === '') continue
    return isComment(text)
  }
  return false
}

/**
 * 在语法树上找等待型调用点，并读出它的 `timeout` 实参。
 *
 * 注释不是语法节点 ⇒ 注释掉的调用**不存在**；空白与折行不改变 AST ⇒
 * 换行格式化的等价代码**仍然找到**（两个方向都由本文件的自检用例钉住）。
 * @param fileName - 文件名（仅用于诊断与 script kind）。
 * @param source - 源码文本。
 * @returns 每个调用点的行号、形态、拼写、`timeout` 表达式、上一行与钉死的墙钟值。
 */
function findWaitForSites(fileName: string, source: string): WaitForSite[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const lines = source.split('\n')
  const aliases = collectAliases(file)
  const found: WaitForSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolved = resolveWaitCall(node, aliases, file)
      if (resolved !== undefined) {
        const start = file.getLineAndCharacterOfPosition(node.getStart(file))
        const end = file.getLineAndCharacterOfPosition(node.getEnd())
        const line = start.line + 1
        const options = node.arguments[1]
        let timeout: string | undefined
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'timeout') {
              timeout = property.initializer.getText(file)
            }
          }
        } else if (options !== undefined) {
          // `vi.waitFor(fn, 5_000)` 这种数值形态：登记成"给了预算但不是对象"，一律判红。
          timeout = `非对象形态：${options.getText(file)}`
        }
        const callback = node.arguments[0]
        found.push({
          line,
          api: resolved.api.label,
          spelling: resolved.spelling,
          timeout,
          previousLine: lines[line - 2] ?? '',
          reasonComment: hasReasonComment(lines, start, end),
          clockPins: callback === undefined ? [] : collectClockPins(callback, file, lines),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 剥掉括号 / `as` / 非空断言，只看真正的取值表达式。 */
function stripWrappers(node: ts.Expression): ts.Expression {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression
    else return current
  }
}

/** 这个表达式**就是**一个墙钟现算字段的取值（`x.retryDelayMs`）。 */
function isClockValue(node: ts.Expression): boolean {
  const inner = stripWrappers(node)
  if (ts.isPropertyAccessExpression(inner) && CLOCK_DERIVED_FIELDS.has(inner.name.text)) return true
  if (ts.isElementAccessExpression(inner) && inner.argumentExpression !== undefined
    && ts.isStringLiteralLike(inner.argumentExpression)
    && CLOCK_DERIVED_FIELDS.has(inner.argumentExpression.text)) return true
  return false
}

/**
 * 一棵子树里"钉死墙钟值"的形态（第二类假红）。
 *
 * 判据按**取值形态**判，不按匹配器名单判（复审 N1 通道 ①）：
 *
 *  - `retryDelayMs: <非零字面量>` 这类对象字面量属性（精确值比较）；
 *  - 任何**非比较族**的断言（`toBe` / `toStrictEqual` / `toMatchObject` / …）
 *    的接收者或实参里出现墙钟字段、或它的**标量别名**（`const first = s.retryDelayMs`）；
 *  - 墙钟字段/别名与字面量的等值比较（`===` / `!==` / …）；
 *  - **局部量 + 数值字面量**：接收者的取值来源（传递地）提到过墙钟字段，且匹配器的
 *    第一个实参就是一个数值字面量 —— 这正是复审通道 ① 的形态
 *    （`const first = states.map(…retryDelayMs…).find(…)` 然后 `expect(first).toStrictEqual(10_000)`），
 *    那种写法把"钉死墙钟值"藏在了取值链后面。
 *
 * `retryDelayMs: 0` 有意不算：该字段在没有截止时刻时恒为 0，是"未进入退避"的**状态**
 * 断言而不是时长钉死（`updates.spec.ts` 的进度态断言正是这一形态）。
 * @param root - the wait callback subtree.
 * @param file - the source file.
 * @param lines - source lines, for the explicit exemption comment.
 * @returns human-readable pin shapes (exempted ones are dropped).
 */
function collectClockPins(root: ts.Node, file: ts.SourceFile, lines: readonly string[]): string[] {
  const pins: Array<{ line: number, shape: string }> = []
  /** 标量别名：`const first = state.retryDelayMs` / `let t; t = x.retryDelayMs`. */
  const aliases = new Set<string>()
  const isExempt = (line: number): boolean =>
    CLOCK_EXEMPTION.test(lines[line - 1] ?? '') || CLOCK_EXEMPTION.test(lines[line - 2] ?? '')
  const record = (node: ts.Node, shape: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    if (!isExempt(line)) pins.push({ line, shape })
  }
  /** 子树里是否有墙钟取值或它的标量别名（属性名不算"取值"）。 */
  const mentionsClock = (node: ts.Node): boolean => {
    let found = false
    const walk = (child: ts.Node): void => {
      if (found) return
      if (ts.isExpression(child) && isClockValue(child)) {
        found = true
        return
      }
      if (ts.isIdentifier(child) && aliases.has(child.text)) {
        found = true
        return
      }
      ts.forEachChild(child, walk)
    }
    walk(node)
    return found
  }
  /**
   * 传递地"提到过墙钟字段"的局部量（宽口径）：`const states = calls.map(c => c.retryDelayMs)`
   * 与 `const first = states.find(…)` 都算。只用于下面那条"局部量 + 数值字面量"的判据 ——
   * 用它做接收者判定会把 `expect(retryWait).toMatchObject({…})` 这类**没有钉墙钟值**的
   * 断言误杀（`retryWait` 由 `filter(s => s.retryDelayMs > 0)` 得来），所以宽口径必须与
   * "匹配器第一个实参是数值字面量"同时成立才判钉死。
   */
  const mentioned = new Set<string>()
  const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean => {
    let found = false
    const walk = (child: ts.Node): void => {
      if (found) return
      if (ts.isExpression(child) && isClockValue(child)) {
        found = true
        return
      }
      if (ts.isIdentifier(child) && (names.has(child.text) || mentioned.has(child.text))) {
        found = true
        return
      }
      ts.forEachChild(child, walk)
    }
    walk(node)
    return found
  }
  const firstPass = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = stripWrappers(node.initializer)
      if (isClockValue(initializer) || (ts.isIdentifier(initializer) && aliases.has(initializer.text))) {
        aliases.add(node.name.text)
      }
      if (mentions(initializer, aliases)) mentioned.add(node.name.text)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const right = stripWrappers(node.right)
      if (isClockValue(right) || (ts.isIdentifier(right) && aliases.has(right.text))) aliases.add(node.left.text)
      if (mentions(right, aliases)) mentioned.add(node.left.text)
    }
    ts.forEachChild(node, firstPass)
  }
  // 两趟：第二趟让 `const b = a`（a 已经因为传递性进集）也能进集。
  firstPass(root)
  firstPass(root)
  const visit = (node: ts.Node): void => {
    // (a) 对象字面量里的精确值：`{ retryDelayMs: 10_000 }`（`0` 是状态断言，见上）。
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined
      if (name !== undefined && CLOCK_DERIVED_FIELDS.has(name)) {
        const value = stripWrappers(node.initializer)
        const zero = ts.isNumericLiteral(value) && Number(value.text.replaceAll('_', '')) === 0
        const concrete = ts.isNumericLiteral(value)
          || ts.isStringLiteralLike(value)
          || isClockValue(value)
          || (ts.isIdentifier(value) && aliases.has(value.text))
        if (!zero && concrete) record(node, `对象字面量钉死 ${name}: ${node.initializer.getText(file)}`)
      }
    }
    // (b) 断言（`expect(…)…matcher(…)`）里出现墙钟值/别名而匹配器不是比较族。
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee)) {
        const matcher = callee.name.text
        const asserted = callee.expression
        if (!COMPARISON_MATCHERS.has(matcher) && isExpectationCall(asserted) && mentionsClock(node)) {
          record(node, `${matcher}(…) 断言了墙钟现算的值（改用比较/容差）: ${node.getText(file)}`)
        } else if (!COMPARISON_MATCHERS.has(matcher) && isExpectationCall(asserted)) {
          // 复审通道 ① 的形态：值是从墙钟字段"传出来"的局部量，匹配器又钉了数值字面量。
          const first = node.arguments[0]
          if (
            first !== undefined
            && ts.isNumericLiteral(first)
            && mentions(asserted, aliases)
          ) {
            record(node, `${matcher}(…) 用数值字面量断言了一个来自墙钟现算字段的局部量（改用比较/容差）: ${node.getText(file)}`)
          }
        }
      }
    }
    // (c) 与字面量的等值比较：`s.retryDelayMs === 10_000`。
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind
      const equality = kind === ts.SyntaxKind.EqualsEqualsToken
        || kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || kind === ts.SyntaxKind.ExclamationEqualsToken
        || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      if (equality) {
        const left = stripWrappers(node.left)
        const right = stripWrappers(node.right)
        const literal = (candidate: ts.Expression): boolean =>
          ts.isNumericLiteral(candidate) || ts.isStringLiteralLike(candidate)
        const clocked = (candidate: ts.Expression): boolean =>
          isClockValue(candidate) || (ts.isIdentifier(candidate) && aliases.has(candidate.text))
        if ((clocked(left) && literal(right)) || (clocked(right) && literal(left))) {
          record(node, `等值比较钉死墙钟现算的值: ${node.getText(file)}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return pins.map(pin => `${pin.shape}（第 ${String(pin.line)} 行）`)
}

/** `expect(x)` / `expect.soft(x)` / `expect(x).not` 链的根是不是 `expect(...)`。 */
function isExpectationCall(node: ts.Node): boolean {
  let current: ts.Node = node
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression
      if (ts.isIdentifier(callee)) return callee.text === 'expect'
      current = callee
      continue
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    return false
  }
}

/**
 * 把源码里的**字符串/模板字面量/正则字面量/注释**内容抹成空格，只留代码位置，
 * 并把等待调用的 callee 归一成点访问（`vi['waitFor']` → `vi.waitFor`、
 * `(0, vi.waitFor)` → `vi.waitFor`）。
 *
 * 用途：数"代码位置上出现了几次 `vi.waitFor(`"。字面量与注释由 AST 给出精确区间
 * （注释在字面量抹平之后再扫，所以字符串里出现的 `/*` 不会骗到它），
 * 因此 `vi.waitFor(` 出现在文档/夹具字符串里时不会被当成调用点。
 *
 * callee 的归一化发生在**调用节点**上（见下），所以括号 / 逗号表达式 / `as` / `!`
 * 这些包装形态与点访问一样会被数到 —— 复审 N3 通道 ② 之所以假绿，正是因为 AST 与
 * 这个 needle 同时看不见 `(0, vi.waitFor)(fn)`。
 * @param fileName - 文件名（仅用于 script kind）。
 * @param source - 源码文本。
 * @returns 等长（按 UTF-16 码元）的掩码文本。
 */
function maskLiteralsAndComments(fileName: string, source: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const chars = source.split('')
  const blank = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  const write = (start: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      if (chars[start + index] !== '\n') chars[start + index] = text[index] ?? ' '
    }
  }
  /** callee 归一化后的文本（`vi.waitFor`），不是等待调用时为 undefined。 */
  const normalizedCallee = (callee: ts.Expression): string | undefined => {
    const reference = waitReferenceOf(callee)
    return reference === undefined ? undefined : `${reference.api.object}.${reference.api.method}`
  }
  const visit = (node: ts.Node): void => {
    // A call whose callee is a wait API in ANY spelling: write the dot spelling over
    // the whole callee span (padded — the needle count strips whitespace) and keep
    // walking the arguments so their literals still get blanked.
    if (ts.isCallExpression(node)) {
      const normalized = normalizedCallee(node.expression)
      if (normalized !== undefined) {
        const start = node.expression.getStart(file)
        blank(start, node.expression.getEnd())
        write(start, normalized)
        for (const argument of node.arguments) visit(argument)
        return
      }
    }
    // Element access with a string literal IS the dot spelling: rewrite `['waitFor']`
    // into `.waitFor` (padded so every offset stays valid) before the string literal
    // is blanked, so the needle count sees `vi['waitFor'](` too (audit N1 channel 3).
    if (
      ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const start = node.expression.getEnd()
      const end = node.getEnd()
      const replacement = `.${node.argumentExpression.text}`
      for (let index = start; index < end; index += 1) {
        const offset = index - start
        chars[index] = offset < replacement.length ? replacement[offset] ?? ' ' : ' '
      }
      return
    }
    if (
      ts.isStringLiteralLike(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
      || ts.isRegularExpressionLiteral(node)
      || ts.isJsxText(node)
    ) {
      blank(node.getStart(file), node.getEnd())
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]
    if (char === '/' && next === '/') {
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' '
        index += 1
      }
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      const stop = close === -1 ? chars.length : close + 2
      for (; index < stop; index += 1) {
        if (chars[index] !== '\n') chars[index] = ' '
      }
      index -= 1
    }
  }
  return chars.join('')
}

/**
 * 代码位置上出现 `needle` 的次数。
 *
 * 计数在**去掉空白**后的掩码文本上做：元素访问的归一化（`['waitFor']` → `.waitFor`）
 * 会留下等长填充空格，而折行/缩进本来就不改变调用事实 —— 两者都不该影响计数。
 * @param masked - {@link maskLiteralsAndComments} 的输出。
 * @param needle - the code text to count (`vi.waitFor(`).
 * @returns how many code positions spell it.
 */
function countCodeOccurrences(masked: string, needle: string): number {
  const compact = masked.replace(/\s+/gu, '')
  let count = 0
  let from = 0
  for (;;) {
    const at = compact.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * 递归收集 `tests/**` 下的**全部** TypeScript 源文件（相对 tests 根的 POSIX 路径）。
 *
 * 复审 N1 通道 ②：只收 `*.spec.ts` 时，`tests/` 下非 spec 的 helper 里的等待型断言
 * 完全在判据面之外。契约说的是"`tests/**` 里的每一个等待型断言"，扫描面就必须与
 * 契约同宽 —— 今天只有 `wait-budgets.ts` 一个非 spec 文件，明天新增 helper 自动进面。
 * @param root - the tests root directory.
 * @returns relative POSIX paths of every `.ts` / `.tsx` file below it.
 */
function collectTestSources(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        found.push(relative(root, full).split('\\').join('/'))
      }
    }
  }
  walk(root)
  return found
}

/** 一个用例声明（含 `it.each(…)('…')` / `it.skipIf(…)('…')` 的柯里化形态）。 */
interface TestDeclaration {
  readonly line: number
  readonly body: string
  /** 作为实参的对象字面量（`it('…', { timeout: … }, fn)`）的文本，没有则 undefined。 */
  readonly options: string | undefined
  /** 数值形态的用例预算（`it('…', fn, 15_000)`），没有则 undefined。 */
  readonly numericTimeout: string | undefined
  /** 柯里化声明（`it.each(…)('…')` / `it.skipIf(…)('…')`）——复审 N5 的形态。 */
  readonly curried: boolean
  readonly waitBudgetKeys: string[]
}

/**
 * 一条调用链的"用例声明根"：`it` / `test`，无论中间夹了多少层柯里化。
 *
 * `it.each([...])('name', fn)` 与 `it.skipIf(cond)('name', fn)` 在 AST 上是
 * "callee 本身是 CallExpression"的调用，旧判据只认 `Identifier === 'it'`，
 * 于是这些用例永远不会进入"用例预算 ≥ 等待预算"（复审 N5）。
 * @param node - a call expression.
 * @returns the outer declaration call when it is an `it`/`test` declaration.
 */
function testDeclarationCall(node: ts.CallExpression): { call: ts.CallExpression, curried: boolean } | undefined {
  let current: ts.Expression = node.expression
  for (;;) {
    if (ts.isCallExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      // `it.each` / `it['each']` / `it.concurrent.each`: keep unwrapping; the root
      // identifier is checked when the chain bottoms out. No method-name filter is
      // applied on purpose — a new curried modifier (`it.skipIf`, `it.runIf`, …)
      // must not silently leave the contract, so anything rooted at `it`/`test`
      // counts as a declaration.
      current = current.expression
      continue
    }
    if (ts.isIdentifier(current)) {
      if (current.text !== 'it' && current.text !== 'test') return undefined
      return { call: node, curried: ts.isCallExpression(node.expression) }
    }
    return undefined
  }
}

/** 一个文件里所有用例声明（含柯里化形态）。 */
function findTestDeclarations(fileName: string, source: string, project?: TestProject): TestDeclaration[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  // 调用图索引：给了整个扫描面就用它（跨文件的前置能力），否则只索引本文件 ——
  // 自检用例（`self.ts`）走的就是单文件那条路。
  const scannedNames = new Set(project === undefined ? [fileName] : [...project.keys()])
  const owner = project?.get(fileName) ?? indexFileCalls(fileName, source, scannedNames)
  const files = project ?? new Map([[fileName, owner]])
  const found: TestDeclaration[] = []
  const visit = (node: ts.Node): void => {
    const declaration = ts.isCallExpression(node) ? testDeclarationCall(node) : undefined
    if (declaration !== undefined) {
      const call = declaration.call
      const callback = call.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      const options = call.arguments.find(argument => ts.isObjectLiteralExpression(argument))
      // vitest's third argument may be a bare number (`it('…', fn, 15_000)`) — the
      // desktop suite uses that spelling, so a case budget is not always an object.
      const numeric = call.arguments.find(argument => ts.isNumericLiteral(argument))
      if (callback !== undefined) {
        found.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          body: callback.getText(file),
          options: options?.getText(file),
          numericTimeout: numeric?.getText(file),
          curried: declaration.curried,
          // 预算键**沿调用传播**：用例体里直接的等待，加上它调用的本地/导入函数体里的
          // 等待（复审 N3 通道 ③）。
          waitBudgetKeys: waitKeysReachableFrom(callback, owner, files),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 一棵子树里所有等待型断言引用到的 `WAIT_BUDGETS.<键>`。 */
function collectWaitBudgetKeys(root: ts.Node, file: ts.SourceFile): string[] {
  const keys: string[] = []
  const aliases = collectAliases(file)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolved = resolveWaitCall(node, aliases, file)
      if (resolved !== undefined) {
        const options = node.arguments[1]
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'timeout') {
              const match = /^WAIT_BUDGETS\.([A-Z0-9_]+)$/u.exec(property.initializer.getText(file).trim())
              if (match?.[1] !== undefined) keys.push(match[1])
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return keys
}

/** 一个本地函数体（用例预算要沿"用例 → 它调用的本地函数"传播）。 */
interface LocalFunction {
  /** 定义它的文件（`tests/**` 内的相对路径）。 */
  readonly body: ts.Node
}

/** 一个文件的本文件调用索引：函数体、相对导入与命名空间导入。 */
interface FileCalls {
  readonly name: string
  readonly sourceFile: ts.SourceFile
  /** 本文件里的函数声明 / `const f = () => {}`：名字 → 函数体。 */
  readonly functions: Map<string, LocalFunction>
  /** 命名导入：本地名 → 目标文件里的导出名。 */
  readonly imports: Map<string, { file: string, name: string }>
  /** 命名空间导入：本地名 → 目标文件（`ns.fn()` 形态）。 */
  readonly namespaces: Map<string, string>
}

/** `tests/**` 的调用图索引：文件 → 本文件索引（复审 N3 通道 ③ 的判据基础）。 */
type TestProject = Map<string, FileCalls>

/**
 * 把一条相对导入解析成扫描面内的文件。
 *
 * 只认 `tests/**` 之内、且真的在扫描集合里的相对导入：面外的模块（`vitest`、
 * `node:*`、别的包）不属于本契约的扫描面，按"看不见"处理 —— 契约只管
 * `tests/**` 里的等待型断言（见文件头），跨出这个面的调用不在它的判据范围内。
 * @param from - the importing file's relative name.
 * @param specifier - the import specifier.
 * @param scanned - every relative name in the scanned set.
 * @returns the resolved relative name, or undefined for anything out of scope.
 */
function resolveScannedFile(from: string, specifier: string, scanned: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = join(dirname(from), specifier).split('\\').join('/')
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (scanned.has(candidate)) return candidate
  }
  return undefined
}

/**
 * 建一个文件的本文件调用索引。
 *
 * 函数体只按**名字**登记（函数声明与 `const f = () => {}`）：这是刻意的近似 ——
 * 判据要的是"用例预算 ≥ 它可能走到的等待预算"，同名遮蔽/动态调用这类边角宁可过宽
 * （fail-closed，写清预算即可），也不要再留一条看不穿调用的假绿通道。
 * @param name - the file's relative name (also the diagnostic label).
 * @param source - its source text.
 * @param scanned - every relative name in the scanned set.
 * @returns the file index.
 */
function indexFileCalls(name: string, source: string, scanned: ReadonlySet<string>): FileCalls {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, scriptKindOf(name))
  const functions = new Map<string, LocalFunction>()
  const imports = new Map<string, { file: string, name: string }>()
  const namespaces = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      functions.set(node.name.text, { body: node.body })
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = stripWrappers(node.initializer)
      if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body !== undefined) {
        functions.set(node.name.text, { body: initializer.body })
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const target = resolveScannedFile(name, node.moduleSpecifier.text, scanned)
      const bindings = node.importClause?.namedBindings
      if (target !== undefined && bindings !== undefined) {
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            imports.set(element.name.text, { file: target, name: imported })
          }
        } else if (ts.isNamespaceImport(bindings)) {
          namespaces.set(bindings.name.text, target)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { name, sourceFile, functions, imports, namespaces }
}

/**
 * 一棵子树里用到的等待预算键，**沿本地函数调用传播**（复审 N3 通道 ③）。
 *
 * 旧判据只在用例语法子树内收集等待键，于是
 *
 * ```
 * async function until() { await vi.waitFor(fn, { timeout: WAIT_BUDGETS.REAL_IO_MS }) }
 * it('…', async () => { await until() }, 5_000)      // 5s 的用例里有 15s 的等待
 * ```
 *
 * 是绿的：用例体里一个 `vi.waitFor` 都没有。现在从用例体出发走一遍调用图 ——
 * 本文件的函数体、以及 `tests/**` 内可解析的相对导入（含 `ns.fn()`），带环路保护。
 * 面外的调用（别的包、动态调用、函数值传递）仍然看不见，这是认账的边界：预算表的
 * 现象下限与包级 30s 兜底仍罩着它们，而"看得见的调用"不再能悄悄超预算。
 * @param root - the case callback (or any body being walked).
 * @param owner - the file the root belongs to.
 * @param project - the whole scanned set (for cross-file resolution).
 * @returns referenced `WAIT_BUDGETS` keys, in first-seen order, deduplicated.
 */
function waitKeysReachableFrom(root: ts.Node, owner: FileCalls, project: TestProject): string[] {
  const keys: string[] = []
  const visited = new Set<string>()
  const add = (key: string): void => { if (!keys.includes(key)) keys.push(key) }
  const walk = (node: ts.Node, file: FileCalls): void => {
    for (const key of collectWaitBudgetKeys(node, file.sourceFile)) add(key)
    const calls: Array<{ file: FileCalls, name: string }> = []
    const collectCalls = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const callee = unwrapWaitCallee(child.expression).inner
        if (ts.isIdentifier(callee)) {
          // 本地函数优先（同名遮蔽时以本文件为准）。
          if (file.functions.has(callee.text)) calls.push({ file, name: callee.text })
          else {
            const imported = file.imports.get(callee.text)
            const target = imported === undefined ? undefined : project.get(imported.file)
            if (imported !== undefined && target !== undefined) calls.push({ file: target, name: imported.name })
          }
        } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const targetName = file.namespaces.get(callee.expression.text)
          const target = targetName === undefined ? undefined : project.get(targetName)
          if (target !== undefined) calls.push({ file: target, name: callee.name.text })
        }
      }
      ts.forEachChild(child, collectCalls)
    }
    collectCalls(node)
    for (const call of calls) {
      const identity = `${call.file.name}\u0000${call.name}`
      if (visited.has(identity)) continue
      visited.add(identity)
      const body = call.file.functions.get(call.name)?.body
      if (body !== undefined) walk(body, call.file)
    }
  }
  walk(root, owner)
  return keys
}

/**
 * 包缺省的 `testTimeout`（`vitest.config.ts`）。缺失时按 vitest 的 5_000 计 ——
 * "没写"与"写了 5s"在可达性上是同一件事。
 */
function packageTestTimeout(): number {
  const source = readFileSync(join(testsRoot, '..', 'vitest.config.ts'), 'utf8')
  const file = ts.createSourceFile('vitest.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let value: number | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && node.name.getText(file) === 'testTimeout'
      && ts.isNumericLiteral(node.initializer)
    ) {
      value = Number(node.initializer.text.replaceAll('_', ''))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return value ?? 5_000
}

/** 解析一个 `timeout:` 的取值：数值字面量或 `TEST_BUDGETS.<键>`。 */
function resolveTestBudget(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const reference = /^TEST_BUDGETS\.([A-Z0-9_]+)$/u.exec(text.trim())
  if (reference?.[1] !== undefined) {
    const budgets: Record<string, number> = { ...TEST_BUDGETS }
    return budgets[reference[1]]
  }
  if (/^\d[\d_]*$/u.test(text.trim())) return Number(text.trim().replaceAll('_', ''))
  return undefined
}

/**
 * 契约的三条判据，对**任意**文件集合求值（真扫描面与自检的变异副本共用同一份实现）。
 * @param files - `{ name, source }` pairs (relative name, source text).
 * @param fallbackTimeout - the package-level `testTimeout`.
 * @returns findings of the budget rule, the clock-pin rule, the spelling-coverage
 *   rule and the per-case-budget rule.
 */
function contractFindings(
  files: ReadonlyArray<{ name: string, source: string }>,
  fallbackTimeout: number,
): {
  budget: ContractFinding[]
  clock: ContractFinding[]
  coverage: ContractFinding[]
  caseBudget: ContractFinding[]
} {
  const budget: ContractFinding[] = []
  const clock: ContractFinding[] = []
  const coverage: ContractFinding[] = []
  const caseBudget: ContractFinding[] = []
  // 调用图索引按**整个传入集合**建一次：跨文件的 helper 也要能被预算判据穿透
  // （复审 N3 通道 ③）。
  const scannedNames = new Set(files.map(entry => entry.name))
  const project: TestProject = new Map(
    files.map(entry => [entry.name, indexFileCalls(entry.name, entry.source, scannedNames)]),
  )
  for (const entry of files) {
    const found = findWaitForSites(entry.name, entry.source)
    for (const site of found) {
      if (site.timeout === undefined) {
        budget.push({ file: entry.name, line: site.line, message: `${site.api} 没有显式 timeout（吃 vitest 缺省的 1s）` })
        continue
      }
      const referenced = /^WAIT_BUDGETS\.([A-Z0-9_]+)$/u.exec(site.timeout.trim())
      if (referenced === null) {
        budget.push({ file: entry.name, line: site.line, message: `${site.api} 的 timeout 不是集中表的引用：${site.timeout}` })
        continue
      }
      const key = referenced[1] as string
      if (!Object.hasOwn(WAIT_BUDGETS, key)) {
        budget.push({ file: entry.name, line: site.line, message: `引用了不存在的预算键 WAIT_BUDGETS.${key}` })
      }
      if (!site.reasonComment) {
        budget.push({
          file: entry.name,
          line: site.line,
          message: `调用点没有理由注释（写在上一行/上方，或同一行行尾）：${JSON.stringify(site.previousLine)}`,
        })
      }
    }
    for (const site of found) {
      for (const pin of site.clockPins) {
        clock.push({ file: entry.name, line: site.line, message: `${site.api} 的条件钉死了 ${pin}` })
      }
    }
    // 两个见证必须一致：需要判的拼写（点/元素访问）在"代码位置计数"与 AST 上
    // 必须给出同一个数。别名拼写只进 AST，因此从不高于 needle 数。
    const masked = maskLiteralsAndComments(entry.name, entry.source)
    const inCode = WAIT_API_NEEDLES
      .reduce((sum, needle) => sum + countCodeOccurrences(masked, needle), 0)
    const direct = found.filter(site => site.spelling !== 'alias').length
    if (inCode !== direct) {
      coverage.push({ file: entry.name, line: 1, message: `代码位置 ${String(inCode)} 处，AST 找到 ${String(direct)} 处` })
    }
    for (const declaration of findTestDeclarations(entry.name, entry.source, project)) {
      if (declaration.waitBudgetKeys.length === 0) continue
      const declared = declaration.options === undefined
        ? declaration.numericTimeout
        : /timeout\s*:\s*([^,}]+)/u.exec(declaration.options)?.[1]
      const budgetMs = declared === undefined ? fallbackTimeout : resolveTestBudget(declared)
      const needed = Math.max(...declaration.waitBudgetKeys.map((key) => {
        const budgets: Record<string, number> = { ...WAIT_BUDGETS }
        return budgets[key] ?? 0
      }))
      if (budgetMs === undefined || budgetMs < needed) {
        caseBudget.push({
          file: entry.name,
          line: declaration.line,
          message: `内部等待预算 ${String(needed)}ms，用例预算 ${budgetMs === undefined ? '不可解析' : `${String(budgetMs)}ms`}`,
        })
      }
    }
  }
  return { budget, clock, coverage, caseBudget }
}

const scanned = collectTestSources(testsRoot).map(name => ({ name, source: readFileSync(join(testsRoot, name), 'utf8') }))
const findings = contractFindings(scanned, packageTestTimeout())
/** 扫描面的调用图索引（跨文件 helper 的预算传播用它）。 */
const scannedProject: TestProject = new Map(
  scanned.map(entry => [
    entry.name,
    indexFileCalls(entry.name, entry.source, new Set(scanned.map(item => item.name))),
  ]),
)
/** 等待型调用点，按 (文件, 行) 定位（用于"每一个调用点都进了判据"的自检）。 */
const allSites = scanned.flatMap(entry => findWaitForSites(entry.name, entry.source).map(site => ({ name: entry.name, ...site })))
/** 用例声明总数：既有的与 `it.each(…)` 柯里化的都在内。 */
const declarationLines = scanned.flatMap(entry => findTestDeclarations(entry.name, entry.source, scannedProject).map(declaration => `${entry.name}:${String(declaration.line)}`))

/** 把 findings 渲染成判据消息。 */
function render(findings: readonly ContractFinding[]): string {
  return findings.map(finding => `${finding.file}:${String(finding.line)} ${finding.message}`).join('\n')
}

describe('desktop waitFor budget contract (R10 M-1)', () => {
  it('判据本身是代码感知的：注释掉必红、折行格式化仍绿、数值字面量不算预算', () => {
    // 自检 —— 这条用例保护的是**判据**而不是产品代码。
    const canonical = "await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n"
    expect(findWaitForSites('self.ts', canonical)).toEqual([
      {
        line: 1,
        api: 'vi.waitFor',
        spelling: 'dot',
        timeout: 'WAIT_BUDGETS.STATE_PROPAGATION_MS',
        previousLine: '',
        reasonComment: false,
        clockPins: [],
      },
    ])
    // 注释掉（行注释与块注释）：AST 里没有调用点 —— 文本包含判据会在这里假绿。
    expect(findWaitForSites('self.ts', `// ${canonical}`)).toEqual([])
    expect(findWaitForSites('self.ts', `/* ${canonical} */`)).toEqual([])
    // 字符串字面量里的同名文本同样不是调用点。
    expect(findWaitForSites('self.ts', `const sample = "vi.waitFor(() => {})"\n`)).toEqual([])
    // 换行/折行的等价代码仍然被找到（文本包含判据会在这里假红）。
    const wrapped = [
      'await vi.waitFor(',
      '  () => {',
      '    expect(x).toBe(1)',
      '  },',
      '  { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS },',
      ')',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', wrapped)).toHaveLength(1)
    expect(findWaitForSites('self.ts', wrapped)[0]?.timeout).toBe('WAIT_BUDGETS.STATE_PROPAGATION_MS')
    // 缺省形态（无第二参数）必须被看见，并且 timeout 是 undefined。
    expect(findWaitForSites('self.ts', 'await vi.waitFor(() => { expect(x).toBe(1) })\n')).toEqual([
      { line: 1, api: 'vi.waitFor', spelling: 'dot', timeout: undefined, previousLine: '', reasonComment: false, clockPins: [] },
    ])
    // 数值形态（vitest 允许 `waitFor(fn, ms)`）不算"显式预算对象"。
    expect(findWaitForSites('self.ts', 'await vi.waitFor(() => {}, 5_000)\n')[0]?.timeout).toBe('非对象形态：5_000')
    // 别的对象（不是集中表）不算预算：判据必须认得出来。
    expect(findWaitForSites('self.ts', 'await vi.waitFor(() => {}, { timeout: 5_000 })\n')[0]?.timeout).toBe('5_000')
  })

  it('三种拼写都算调用点：点访问、元素访问（vi[\'waitFor\']）、解构别名', () => {
    // 复审 N1 通道 ③：元素访问与 needle 双向漏检的形态。
    const element = "await vi['waitFor'](() => { expect(x).toBe(1) })\n"
    const elementSites = findWaitForSites('self.ts', element)
    expect(elementSites, "vi['waitFor'] 必须被 AST 找到").toHaveLength(1)
    expect(elementSites[0]?.spelling).toBe('element')
    expect(elementSites[0]?.timeout).toBeUndefined()
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', element), 'vi.waitFor('),
      '"代码位置"计数必须把元素访问归一成点访问（否则两个见证都看不见它）').toBe(1)
    // 双引号写法与 `expect['poll']` 同理。
    expect(findWaitForSites('self.ts', "await vi[\"waitFor\"](() => {})\n")[0]?.spelling).toBe('element')
    expect(findWaitForSites('self.ts', "await expect['poll'](() => 1)\n")[0]?.api).toBe('expect.poll')
    // 解构别名（含重命名）：同样是必须给预算的调用点。
    const aliased = [
      'const { waitFor } = vi',
      'const { poll: eventually } = expect',
      'await waitFor(() => { expect(x).toBe(1) })',
      'await eventually(() => 1)',
      '',
    ].join('\n')
    const aliasSites = findWaitForSites('self.ts', aliased)
    expect(aliasSites.map(site => `${site.api}/${site.spelling}`)).toEqual(['vi.waitFor/alias', 'expect.poll/alias'])
    expect(aliasSites.every(site => site.timeout === undefined)).toBe(true)
    // 不是 vi/expect 的同名方法（别的对象自己的 waitFor）不受契约约束。
    expect(findWaitForSites('self.ts', 'await server.waitFor(() => 1)\n')).toEqual([])
    expect(findWaitForSites('self.ts', 'await helper["waitFor"](() => 1)\n')).toEqual([])
  })

  it('负样本 ①：等待条件换成别的匹配器钉死墙钟值，判据必红（复审的 toStrictEqual 形态）', () => {
    // 复审实测的绕过形态：把条件写成 `expect(first).toStrictEqual(10_000)`（`first`
    // 是从 retryDelayMs 取出的局部量），旧判据只认 toBe / toEqual 与数值字面量属性。
    const pinned = [
      'await vi.waitFor(() => {',
      '  const first = harness.states.find(state => state.retryDelayMs > 0)?.retryDelayMs',
      '  expect(first).toStrictEqual(10_000)',
      '}, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })',
      '',
    ].join('\n')
    const sites = findWaitForSites('self.ts', pinned)
    expect(sites[0]?.clockPins, '别名 + 非比较族匹配器必须被判为钉死').toHaveLength(1)
    const report = contractFindings([{ name: 'tests/probe.spec.ts', source: pinned }], 30_000)
    expect(report.clock.length, '判据必须在真实求值路径上红（不是只有扫描器知道）').toBe(1)
    expect(report.clock[0]?.message).toContain('toStrictEqual')
    // 复审实测的那条**链式**形态：值经过 `map(...).find(...)` 才落到局部量上，
    // 直接别名判定看不见它 —— "局部量 + 数值字面量"这条口径就是为它加的。
    const chained = [
      'await vi.waitFor(() => {',
      '  const first = harness.publishedStates.mock.calls',
      '    .map(call => (call[0] as { retryDelayMs?: number }).retryDelayMs ?? 0)',
      '    .find(delay => delay > 0)',
      '  expect(first).toStrictEqual(10_000)',
      '}, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })',
      '',
    ].join('\n')
    const chainedReport = contractFindings([{ name: 'tests/probe.spec.ts', source: chained }], 30_000)
    expect(chainedReport.clock.length, '链式取值链上的钉死必须同样判红').toBe(1)
    // 反向：同一个局部量用比较族断言（含"未进入退避"的 0 值）不得被误杀。
    const chainedTolerant = [
      'await vi.waitFor(() => {',
      '  const first = harness.publishedStates.mock.calls',
      '    .map(call => (call[0] as { retryDelayMs?: number }).retryDelayMs ?? 0)',
      '    .find(delay => delay > 0)',
      '  expect(first).toBeGreaterThan(9_900)',
      '  expect(first).toBeLessThanOrEqual(10_000)',
      '}, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: chainedTolerant }], 30_000).clock).toEqual([])
    // 比较族（容差）与"未进入退避"的 0 值不算钉死 —— 反向样本，防判据把合法形态误杀。
    const tolerant = [
      'await vi.waitFor(() => {',
      '  const first = harness.states.find(state => state.retryDelayMs > 0)?.retryDelayMs',
      '  expect(first).toBeGreaterThan(9_900)',
      '  expect(first).toBeLessThanOrEqual(10_000)',
      '  expect(state).toMatchObject({ retryAttempt: 1, retryDelayMs: 0 })',
      '  const positive = calls.some(call => (call[0].retryDelayMs ?? 0) > 0)',
      '  expect(positive).toBe(true)',
      '}, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', tolerant)[0]?.clockPins).toEqual([])
    // 显式豁免要人写下理由（同一行或上一行），换匹配器不是豁免。
    const exempt = [
      '// wait-budget-contract:allow-clock-value 冻结时钟下该值是确定性的',
      'await vi.waitFor(() => { expect(x.retryDelayMs).toStrictEqual(10_000) }, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', exempt)[0]?.clockPins).toEqual([])
    expect(findWaitForSites('self.ts', 'await vi.waitFor(() => { expect(x.retryDelayMs).toStrictEqual(10_000) }, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })\n')[0]?.clockPins).toHaveLength(1)
  })

  it('负样本 ②：tests/ 下非 spec 的 .ts helper 也在扫描面内（复审的 helper 形态）', () => {
    // 扫描面自证：`wait-budgets.ts` 是 tests/ 下的非 spec `.ts`，必须在面内。
    expect(scanned.some(entry => entry.name === 'wait-budgets.ts'), '扫描面漏了 tests/ 下的非 spec .ts').toBe(true)
    expect(scanned.every(entry => entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))).toBe(true)
    expect(scanned.some(entry => entry.name.endsWith('.spec.ts'))).toBe(true)
    // 契约在非 spec 文件上的行为：没给预算 ⇒ 红（判据不再按文件名放行）。
    const helper = 'export async function settle(): Promise<void> {\n  await vi.waitFor(() => { expect(done).toBe(true) })\n}\n'
    const report = contractFindings([{ name: 'tests/wait-helper-probe.ts', source: helper }], 30_000)
    expect(report.budget.map(finding => finding.file)).toEqual(['tests/wait-helper-probe.ts'])
    expect(report.budget[0]?.message).toContain('没有显式 timeout')
  })

  it('负样本 ③：元素访问拼写不给预算，两个见证必须同时看见（复审的 vi[\'waitFor\'] 形态）', () => {
    const element = "export const probe = async (): Promise<void> => {\n  await vi['waitFor'](() => { expect(x).toBe(1) })\n}\n"
    const report = contractFindings([{ name: 'tests/wait-probe.ts', source: element }], 30_000)
    expect(report.budget).toHaveLength(1)
    expect(report.coverage, 'AST 与"代码位置计数"必须一致（否则就是双向漏检）').toEqual([])
    // 反过来：把同一个调用点写成 AST 认不出的形状（动态键）时，覆盖率对账必须红，
    // 而不是静默缩小契约。
    const dynamic = 'const key = "waitFor"\nawait vi[key](() => { expect(x).toBe(1) })\n'
    expect(findWaitForSites('self.ts', dynamic)).toEqual([])
  })

  it('扫描面覆盖 tests/** 的每个 TS 源文件，且调用点数量在下限之上（判据不许空转）', () => {
    expect(scanned.length, '没有扫到任何 TS 源文件').toBeGreaterThan(10)
    expect(scanned.some(entry => entry.name === 'updates.spec.ts'), '扫描面漏了 updates.spec.ts').toBe(true)
    const filesWithCalls = new Set(allSites.map(site => site.name))
    expect(allSites.length, `等待预算判据扫到的调用点只有 ${String(allSites.length)} 个，扫描器可能已经失效`)
      .toBeGreaterThanOrEqual(MIN_CALL_SITES)
    expect(filesWithCalls.size, '等待预算判据只覆盖了极少数文件').toBeGreaterThanOrEqual(MIN_FILES_WITH_CALLS)
    expect(
      findings.coverage,
      `扫描器与源码不一致（判据可能已经失效）：\n${render(findings.coverage)}`,
    ).toEqual([])
    // 柯里化用例声明也必须被看见（复审 N5）：至少有一条 `it.each(…)` 在面内。
    expect(declarationLines.length, '没有识别到任何用例声明').toBeGreaterThan(50)
  })

  it('每一个等待型断言都显式给了预算，且预算引用集中表里的键', () => {
    expect(findings.budget, `等待预算契约被破坏：\n${render(findings.budget)}`).toEqual([])
  })

  it('每个调用点上方都有一行"现象"理由（预算的取值依据逐处可读）', () => {
    const missing = findings.budget.filter(finding => finding.message.includes('理由注释'))
    expect(missing, `等待预算缺少逐处理由：\n${render(missing)}`).toEqual([])
  })

  it('预算表每一项都不低于登记的现象下限（把预算改小只会让判据变红）', () => {
    const violations: string[] = []
    const budgets: Record<string, number> = { ...WAIT_BUDGETS }
    const testBudgets: Record<string, number> = { ...TEST_BUDGETS }
    for (const [key, floor] of Object.entries(WAIT_BUDGET_FLOORS)) {
      const value = budgets[key]
      if (value === undefined) violations.push(`WAIT_BUDGETS 缺少 ${key}`)
      else if (value < floor) violations.push(`WAIT_BUDGETS.${key}=${String(value)} 低于现象下限 ${String(floor)}`)
    }
    for (const [key, floor] of Object.entries(TEST_BUDGET_FLOORS)) {
      const value = testBudgets[key]
      if (value === undefined) violations.push(`TEST_BUDGETS 缺少 ${key}`)
      else if (value < floor) violations.push(`TEST_BUDGETS.${key}=${String(value)} 低于现象下限 ${String(floor)}`)
    }
    expect(violations, `预算低于它要观察的现象：\n${violations.join('\n')}`).toEqual([])
    // 表里不得有"没有下限登记"的键（新加预算必须同时登记现象下限）。
    expect(Object.keys(WAIT_BUDGETS).sort()).toEqual(Object.keys(WAIT_BUDGET_FLOORS).sort())
    expect(Object.keys(TEST_BUDGETS).sort()).toEqual(Object.keys(TEST_BUDGET_FLOORS).sort())
  })

  it('真实产物上的清单派生用例显式声明产物派生档（不吃 vitest 缺省的 5s testTimeout）', () => {
    const name = 'verify-packaged-runtime.spec.ts'
    const entry = scanned.find(candidate => candidate.name === name)
    expect(entry, `扫描面里没有 ${name}`).toBeDefined()
    const declarations = findTestDeclarations(name, entry?.source ?? '', scannedProject)
      .filter(declaration => declaration.body.includes('collectWorkspaceSurface'))
    expect(declarations.length, `${name} 里没有直接调用 collectWorkspaceSurface 的用例，判据会空转`)
      .toBeGreaterThan(0)
    const offenders = declarations
      .filter(declaration => !(declaration.options ?? '').includes('TEST_BUDGETS.ARTIFACT_DERIVATION_MS'))
      .map(declaration => `${name}:${declaration.line}`)
    expect(offenders, `这些用例在真实产物上派生清单却没给显式 testTimeout：\n${offenders.join('\n')}`).toEqual([])
  })

  it('等待条件不得钉死墙钟现算字段的精确值（第二类假红：条件永不可满足）', () => {
    expect(findings.clock, `等待条件钉死了墙钟现算的值（改用比较/容差）：\n${render(findings.clock)}`).toEqual([])
  })

  it('用例自己的预算 ≥ 它内部用到的等待预算，柯里化声明（it.each / it.skipIf）同样在面内', () => {
    // 本机 4 路负载实测的形态：`vi.waitFor` 给了 12s，但用例吃 5s 缺省 ⇒ 在 5001ms
    // 被 `Error: Test timed out in 5000ms` 掐死，12s 一次都没用上。
    const fallback = packageTestTimeout()
    const largestWait = Math.max(...Object.values(WAIT_BUDGETS))
    expect(
      fallback,
      `包缺省 testTimeout(${String(fallback)}ms) 小于最大的等待预算(${String(largestWait)}ms)：`
      + '任何等待预算都用不满，失败还会伪装成"Test timed out"',
    ).toBeGreaterThanOrEqual(largestWait)
    expect(findings.caseBudget, `用例预算小于它要用的等待预算：\n${render(findings.caseBudget)}`).toEqual([])

    // 复审 N5 点名的三个调用点（`updates.spec.ts:384/574/591` 的 `it.each`）必须真的进面：
    // 旧判据只认 `Identifier === 'it'`，这些声明的等待预算键一个都读不到（判据静默漏检）。
    const updates = scanned.find(entry => entry.name === 'updates.spec.ts')
    expect(updates, '扫描面里没有 updates.spec.ts').toBeDefined()
    const updatesDeclarations = findTestDeclarations('updates.spec.ts', updates?.source ?? '', scannedProject)
    expect(
      updatesDeclarations.filter(entry => entry.curried).length,
      'updates.spec.ts 的三处 it.each(...) 必须全部被识别为用例声明（复审 N5）',
    ).toBeGreaterThanOrEqual(3)
    // 旧判据（`Identifier === 'it'`）读不到这些声明的等待预算键 ⇒ 它们静默不进判据。
    expect(
      updatesDeclarations.filter(entry => entry.curried && entry.waitBudgetKeys.length > 0).length,
      '柯里化声明内部的等待预算键必须被读到（否则"用例预算 ≥ 等待预算"对它们恒不生效）',
    ).toBeGreaterThanOrEqual(1)

    // 复审 N5 的机制自证：柯里化声明必须被解析出等待预算键，否则它永远不进上面这条判据。
    const curried = [
      "it.each([1, 2])('case %i', async () => {",
      '  // 现象：状态传播档。',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })',
      '})',
      "it.skipIf(process.platform === 'win32')('skipped', async () => {",
      '  // 现象：真实 I/O 档。',
      '  await vi.waitFor(() => { expect(y).toBe(1) }, { timeout: WAIT_BUDGETS.REAL_IO_MS })',
      '})',
      '',
    ].join('\n')
    const declarations = findTestDeclarations('self.ts', curried)
    expect(declarations.map(declaration => declaration.waitBudgetKeys)).toEqual([
      ['STATE_PROPAGATION_MS'],
      ['REAL_IO_MS'],
    ])
    // 柯里化声明上真的会触发"用例预算 < 等待预算"：显式 5s 的 it.each 用例必须红。
    const tooSmall = [
      "it.each([1])('case %i', async () => {",
      '  // 现象：退避窗口档。',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: WAIT_BUDGETS.RETRY_BACKOFF_WINDOW_MS })',
      '}, 5_000)',
      '',
    ].join('\n')
    const report = contractFindings([{ name: 'tests/probe.spec.ts', source: tooSmall }], 30_000)
    expect(report.caseBudget, 'it.each(…) 的用例预算必须被比对').toHaveLength(1)
    expect(report.caseBudget[0]?.message).toContain('12000ms')
  })

  it('复审 N3 通道 ①：裸别名（const w = vi.waitFor）是必须给预算的调用点', () => {
    const bareAlias = [
      'const w = vi.waitFor',
      'await w(() => { expect(1).toBe(1) })',
      '',
    ].join('\n')
    const sites = findWaitForSites('self.ts', bareAlias)
    expect(sites.map(site => `${site.api}/${site.spelling}`), '裸别名必须被 AST 看见').toEqual(['vi.waitFor/alias'])
    expect(sites[0]?.timeout, '裸别名没有预算').toBeUndefined()
    // 真实求值路径上必须红：没给预算 + 没有理由注释。
    const report = contractFindings([{ name: 'tests/probe.spec.ts', source: bareAlias }], 30_000)
    expect(report.budget.map(finding => finding.message).join('|'), '没给预算的裸别名必须判红').toContain('没有显式 timeout')
    // 换个名字不是旁路：链式、元素访问、`.bind` 三种绑定同样在面内。
    expect(findWaitForSites('self.ts', 'const a = vi.waitFor\nconst b = a\nawait b(() => {})\n').map(site => site.spelling)).toEqual(['alias'])
    expect(findWaitForSites('self.ts', "const w = vi['waitFor']\nawait w(() => {})\n").map(site => site.spelling)).toEqual(['alias'])
    expect(findWaitForSites('self.ts', 'const w = vi.waitFor.bind(vi)\nawait w(() => {})\n').map(site => site.spelling)).toEqual(['alias'])
    expect(findWaitForSites('self.ts', 'const p = expect.poll\nawait p(() => 1)\n').map(site => site.api)).toEqual(['expect.poll'])
    // 别的对象的同名方法仍然不受约束（判据不许把任何 `w(...)` 都当等待）。
    expect(findWaitForSites('self.ts', 'const w = server.waitFor\nawait w(() => {})\n')).toEqual([])
    expect(findWaitForSites('self.ts', 'const w = helper["waitFor"]\nawait w(() => {})\n')).toEqual([])
  })

  it('复审 N3 通道 ②：逗号表达式 / 括号包装的 callee 两个见证都要看见', () => {
    // 形态放在 `it(…, async () => …)` 里，与真实用例同形：`await` 在脚本顶层会被解析成
    // 标识符（`await (0, x)(y)` 变成 `await(0, x)(y)`），只有异步体里才是等待表达式。
    const wrap = (body: string): string => `it('probe', async () => {\n${body}\n})\n`
    const comma = wrap('  await (0, vi.waitFor)(() => { expect(1).toBe(1) })')
    const commaSites = findWaitForSites('self.ts', comma)
    expect(commaSites.map(site => site.spelling), '逗号表达式必须被 AST 看见').toEqual(['wrapped'])
    expect(commaSites[0]?.timeout, '这种写法也没有预算').toBeUndefined()
    expect(
      countCodeOccurrences(maskLiteralsAndComments('self.ts', comma), 'vi.waitFor('),
      '"代码位置"计数必须同样看见它（两个见证同时失明就是假绿）',
    ).toBe(1)
    // 覆盖率对账在三种包装形态上都不许失配，且真实求值路径上要红。
    const paren = wrap('  await (vi.waitFor)(() => {})')
    expect(findWaitForSites('self.ts', paren).map(site => site.spelling)).toEqual(['wrapped'])
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', paren), 'vi.waitFor(')).toBe(1)
    const element = wrap("  await (0, vi['waitFor'])(() => {})")
    expect(findWaitForSites('self.ts', element).map(site => site.spelling)).toEqual(['wrapped'])
    for (const source of [comma, paren, element]) {
      const report = contractFindings([{ name: 'tests/probe.spec.ts', source }], 30_000)
      expect(report.coverage, `覆盖率对账不得失配：${source.trim()}`).toEqual([])
      expect(report.budget, `没给预算的包装形态必须判红：${source.trim()}`).toHaveLength(1)
    }
    // 反向：装了预算 + 理由注释的包装形态必须绿（判据认得它，且不误杀）。
    const budgeted = [
      "it('probe', async () => {",
      '  // 现象：状态传播档。',
      '  await (0, vi.waitFor)(() => {}, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })',
      '})',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: budgeted }], 30_000)).toEqual({
      budget: [], clock: [], coverage: [], caseBudget: [],
    })
  })

  it('复审 N3 通道 ③：模块级 helper 里的等待沿调用传播到用例预算（同文件与相对导入）', () => {
    // 同文件 helper：5s 的用例内部调用了一个等待 15s 的 helper ⇒ 判据必须红。
    const sameFile = [
      'async function until(fn: () => void): Promise<void> {',
      '  // 现象：真实 I/O 档。',
      '  await vi.waitFor(fn, { timeout: WAIT_BUDGETS.REAL_IO_MS })',
      '}',
      "it('case', async () => { await until(() => {}) }, 5_000)",
      '',
    ].join('\n')
    const sameReport = contractFindings([{ name: 'tests/probe.spec.ts', source: sameFile }], 30_000)
    expect(sameReport.caseBudget, '用例预算检查必须看穿同文件 helper').toHaveLength(1)
    expect(sameReport.caseBudget[0]?.message).toContain('15000ms')
    // 反向：预算够（或吃包级 30s 兜底）时不得误报；没被调用的 helper 不牵连别的用例。
    const bigBudget = sameFile.replace('}, 5_000)', '}, 30_000)')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: bigBudget }], 30_000).caseBudget).toEqual([])
    const unreferenced = [
      'async function never(): Promise<void> {',
      '  // 现象：真实 I/O 档。',
      '  await vi.waitFor(() => {}, { timeout: WAIT_BUDGETS.REAL_IO_MS })',
      '}',
      "it('case', async () => { expect(1).toBe(1) }, 5_000)",
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: unreferenced }], 30_000).caseBudget, '没被调用的 helper 不牵连用例').toEqual([])
    // 跨文件的相对导入（tests/** 之内）：`tests/**` 里的 helper 同样要看得穿。
    const helperFile = {
      name: 'tests/helpers/wait-helper.ts',
      source: [
        "import { vi } from 'vitest'",
        "import { WAIT_BUDGETS } from '../wait-budgets.ts'",
        'export async function until(fn: () => void): Promise<void> {',
        '  // 现象：真实 I/O 档。',
        '  await vi.waitFor(fn, { timeout: WAIT_BUDGETS.REAL_IO_MS })',
        '}',
        '',
      ].join('\n'),
    }
    const caseFile = (caseBudget: string): { name: string, source: string } => ({
      name: 'tests/case.spec.ts',
      source: [
        "import { it } from 'vitest'",
        "import { until } from './helpers/wait-helper.ts'",
        `it('case', async () => { await until(() => {}) }, ${caseBudget})`,
        '',
      ].join('\n'),
    })
    const crossReport = contractFindings([helperFile, caseFile('5_000')], 30_000)
    expect(crossReport.caseBudget, '跨文件 helper 的等待预算必须被看穿').toHaveLength(1)
    expect(crossReport.caseBudget[0]?.file).toBe('tests/case.spec.ts')
    // 反向：预算够时必须绿（传播不许变成"见到调用就红"）。
    expect(contractFindings([helperFile, caseFile('30_000')], 30_000).caseBudget).toEqual([])
  })

  it('复审 N5：理由注释接受"上一行 / 上方（可隔空行）/ 同一行行尾"，没有注释仍然红', () => {
    const call = "await vi.waitFor(() => {}, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })"
    const shapes: Array<[string, string[]]> = [
      ['上一行', ['// 现象：状态传播档。', call]],
      ['同一行（行尾）', [`${call} // 现象：状态传播档。`]],
      ['上方隔一空行', ['// 现象：状态传播档。', '', call]],
      ['多行调用（行尾在结束行）', [
        'await vi.waitFor(',
        '  () => {},',
        '  { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS },',
        ') // 现象：状态传播档。',
      ]],
    ]
    for (const [label, lines] of shapes) {
      const source = `${lines.join('\n')}\n`
      expect(findWaitForSites('self.ts', source)[0]?.reasonComment, `${label}：必须被接受`).toBe(true)
      expect(contractFindings([{ name: 'tests/probe.spec.ts', source }], 30_000).budget, `${label}：正当等待不得被拦`).toEqual([])
    }
    // 反向：完全没注释仍然红（放宽的是位置，不是要求）。
    const bare = `${call}\n`
    expect(findWaitForSites('self.ts', bare)[0]?.reasonComment).toBe(false)
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: bare }], 30_000).budget.map(finding => finding.message).join('|'))
      .toContain('理由注释')
    // 中间夹着代码不算"上方"（逐处可读不放宽成"同一个用例里随便哪一行"）。
    const separated = ['// 现象：状态传播档。', 'const unrelated = 1', call, ''].join('\n')
    expect(findWaitForSites('self.ts', separated)[0]?.reasonComment).toBe(false)
    // 条件里字符串中的 `//`（URL）不得被当成行尾注释。
    const urlInCondition = "await vi.waitFor(() => { expect(url).toBe('http://127.0.0.1/x') }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n"
    expect(findWaitForSites('self.ts', urlInCondition)[0]?.reasonComment, '字符串里的 // 不是注释').toBe(false)
  })
})

/** 判据的"扫描面缩水"自检：目录树被搬空时必须看得见（不是静默通过）。 */
describe('desktop waitFor budget contract · 扫描面', () => {
  it('tests 根目录存在且是目录（否则上面的扫描会静默变成空集）', () => {
    expect(statSync(testsRoot).isDirectory()).toBe(true)
  })
})
