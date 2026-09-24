/**
 * **等待预算契约**的静态判据：`tests/**` 里每一个 `vi.waitFor(` / `expect.poll(` 都必须显式给预算，
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
 * 所以本文件在 TypeScript AST 上找 `vi.waitFor` 调用点。
 *
 * ## 判了什么（每一条都能被打坏）
 *
 * 1. `vi.waitFor` 必须有第二个参数（options 对象）与其中的 `timeout`；
 * 2. `timeout` 必须引用 `WAIT_BUDGETS.<键>` —— 数值字面量、别的对象一律不算；
 * 3. 引用到的键必须在 `WAIT_BUDGETS` 里真实存在；
 * 4. 表里每一项都必须 ≥ `WAIT_BUDGET_FLOORS` 登记的现象下限（改小预算 ⇒ 判据红）；
 * 5. 每个调用点上方必须有一行 `//` 理由注释（预算的来源要逐处可读）；
 * 6. 真实产物上逐条派生清单的用例必须显式声明 `TEST_BUDGETS.ARTIFACT_DERIVATION_MS`；
 * 7. 判据自身不空转：扫描面下限 + 扫描器自检（注释/字符串里的同名文本不得被当成调用）。
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

/** One `vi.waitFor(...)` / `expect.poll(...)` call site found in a syntax tree. */
interface WaitForSite {
  /** 1-based line of the call, for the failure message. */
  readonly line: number
  /** 调用形态（`vi.waitFor` / `expect.poll`）。 */
  readonly api: string
  /** 显式 `timeout` 的表达式文本（未给时为 undefined）。 */
  readonly timeout: string | undefined
  /** 调用点上一行（用于判"逐处留一行理由"）。 */
  readonly previousLine: string
  /** 等待条件里钉死的"墙钟现算字段"（第二类假红，见下）。 */
  readonly clockPins: readonly string[]
}

/**
 * 由**墙钟现算**的字段：它们的值 = `截止时刻 - Date.now()`，置位与发布之间只隔几条
 * 语句，负载下墙钟越过 1ms 就会差一个单位，而取值此后单调变差 ⇒ 等待条件**永不可
 * 满足**（与等待预算无关）。这类字段只能用**比较**（`toBeGreaterThan`）断言，
 * 不能用 `toBe`/`toEqual`/对象字面量钉精确值。
 *
 * 实证（2026-09-24，四路并发跑 `updates.spec.ts`）：`keeps the download state and the
 * countdown visible during the backoff wait` 收到的快照序列是 `retryDelayMs` =
 * `0 0 0 0 0 9999 9000 7997 6997 …` —— 首帧是 9_999 而不是 10_000，断言红。
 */
const CLOCK_DERIVED_FIELDS = new Set(['retryDelayMs'])

/**
 * 在语法树上找 `vi.waitFor(...)` / `expect.poll(...)`，并读出它的 `timeout` 实参。
 *
 * 注释不是语法节点 ⇒ 注释掉的调用**不存在**；空白与折行不改变 AST ⇒
 * 换行格式化的等价代码**仍然找到**（两个方向都由本文件的自检用例钉住）。
 * @param fileName - 文件名（仅用于诊断与 script kind）。
 * @param source - 源码文本。
 * @returns 每个调用点的行号、形态、`timeout` 表达式、上一行与钉死的墙钟字段。
 */
function findWaitForSites(fileName: string, source: string): WaitForSite[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lines = source.split('\n')
  const found: WaitForSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // 收窄必须落在 const 上：在闭包里读 `node.expression` 会丢掉 narrowing（TS2339）。
      const callee = node.expression
      const receiver = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.expression.text
        : undefined
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
      const api = receiver === undefined || method === undefined
        ? undefined
        : WAIT_APIS.find(candidate => candidate.object === receiver && candidate.method === method)
      if (api !== undefined) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
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
          api: api.label,
          timeout,
          previousLine: lines[line - 2] ?? '',
          clockPins: callback === undefined ? [] : collectClockPins(callback, file),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 一个等待条件里对"墙钟现算字段"钉精确值的写法（对象字面量与 `toBe`/`toEqual`）。 */
function collectClockPins(root: ts.Node, file: ts.SourceFile): string[] {
  const pins: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && CLOCK_DERIVED_FIELDS.has(node.name.text)
      && ts.isNumericLiteral(node.initializer)
    ) {
      pins.push(`${node.name.text}: ${node.initializer.getText(file)}`)
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'toBe' || node.expression.name.text === 'toEqual')
      && node.arguments.length === 1
      && node.arguments[0] !== undefined
      && ts.isNumericLiteral(node.arguments[0])
    ) {
      const receiver = node.expression.expression.getText(file)
      for (const field of CLOCK_DERIVED_FIELDS) {
        if (new RegExp(`\\.${field}\\b`, 'u').test(receiver)) {
          pins.push(`${receiver} → ${node.expression.name.text}(${node.arguments[0].getText(file)})`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return pins
}

/**
 * 把源码里的**字符串/模板字面量/正则字面量/注释**内容抹成空格，只留代码位置。
 *
 * 用途：数"代码位置上出现了几次 `vi.waitFor(`"。字面量与注释由 AST 给出精确区间
 * （注释在字面量抹平之后再扫，所以字符串里出现的 `/*` 不会骗到它），
 * 因此 `vi.waitFor(` 出现在文档/夹具字符串里时不会被当成调用点。
 * @param fileName - 文件名（仅用于 script kind）。
 * @param source - 源码文本。
 * @returns 等长（按 UTF-16 码元）的掩码文本。
 */
function maskLiteralsAndComments(fileName: string, source: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const chars = source.split('')
  const blank = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  const visit = (node: ts.Node): void => {
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

/** 代码位置上出现 `needle` 的次数。 */
function countCodeOccurrences(masked: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = masked.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/** 递归收集 `tests/**` 下的 spec 文件（相对 tests 根的 POSIX 路径）。 */
function collectSpecFiles(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.spec.ts')) found.push(relative(root, full).split('\\').join('/'))
    }
  }
  walk(root)
  return found
}

/** 一个文件里所有 `it(...)` 调用点（`it.each(...)(…)` 的柯里化形态不在此列）。 */
function findTestDeclarations(
  fileName: string,
  source: string,
): Array<{ line: number, body: string, options: string | undefined, waitBudgetKeys: string[] }> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Array<{ line: number, body: string, options: string | undefined, waitBudgetKeys: string[] }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'it') {
      const callback = node.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      const options = node.arguments.find(argument => ts.isObjectLiteralExpression(argument))
      if (callback !== undefined) {
        found.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          body: callback.getText(file),
          options: options?.getText(file),
          waitBudgetKeys: collectWaitBudgetKeys(callback, file),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 一棵子树里所有 `vi.waitFor(…, { timeout: WAIT_BUDGETS.<键> })` 引用到的键。 */
function collectWaitBudgetKeys(root: ts.Node, file: ts.SourceFile): string[] {
  const keys: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'vi'
      && node.expression.name.text === 'waitFor'
    ) {
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
    ts.forEachChild(node, visit)
  }
  visit(root)
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

const specFiles = collectSpecFiles(testsRoot)
const scanned = specFiles.map(name => ({ name, source: readFileSync(join(testsRoot, name), 'utf8') }))
const sitesByFile = new Map(scanned.map(entry => [entry.name, findWaitForSites(entry.name, entry.source)]))
const allSites = [...sitesByFile.entries()].flatMap(([name, sites]) => sites.map(site => ({ name, ...site })))

describe('desktop waitFor budget contract (R10 M-1)', () => {
  it('判据本身是代码感知的：注释掉必红、折行格式化仍绿、数值字面量不算预算', () => {
    // 自检 —— 这条用例保护的是**判据**而不是产品代码。
    const canonical = "await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n"
    expect(findWaitForSites('self.ts', canonical)).toEqual([
      { line: 1, api: 'vi.waitFor', timeout: 'WAIT_BUDGETS.STATE_PROPAGATION_MS', previousLine: '', clockPins: [] },
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
      { line: 1, api: 'vi.waitFor', timeout: undefined, previousLine: '', clockPins: [] },
    ])
    // 第二类假红：等待条件钉死"墙钟现算字段"的精确值（条件可能永不可满足）。
    expect(
      findWaitForSites('self.ts', 'await vi.waitFor(() => { expect(x).toHaveBeenCalledWith(expect.objectContaining({ retryDelayMs: 10_000 })) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n')[0]?.clockPins,
    ).toEqual(['retryDelayMs: 10_000'])
    expect(
      findWaitForSites('self.ts', 'await vi.waitFor(() => { expect(state.retryDelayMs).toBe(10_000) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n')[0]?.clockPins,
    ).toEqual(['expect(state.retryDelayMs) → toBe(10_000)'])
    // 比较形态（容差断言）与别的字段都不算钉死。
    expect(
      findWaitForSites('self.ts', 'await vi.waitFor(() => { expect(state.retryDelayMs).toBeGreaterThan(9_900) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n')[0]?.clockPins,
    ).toEqual([])
    expect(
      findWaitForSites('self.ts', 'await vi.waitFor(() => { expect(x).toHaveBeenCalledWith(expect.objectContaining({ retryAttempt: 1 })) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })\n')[0]?.clockPins,
    ).toEqual([])
    // 数值形态（vitest 允许 `waitFor(fn, ms)`）不算"显式预算对象"。
    expect(findWaitForSites('self.ts', 'await vi.waitFor(() => {}, 5_000)\n')[0]?.timeout).toBe('非对象形态：5_000')
    // 别的对象（不是集中表）不算预算：判据必须认得出来。
    expect(findWaitForSites('self.ts', 'await vi.waitFor(() => {}, { timeout: 5_000 })\n')[0]?.timeout).toBe('5_000')

    // 掩码器（"代码位置"计数用）：字面量/注释里出现的同名文本不算代码位置。
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', 'const sample = "vi.waitFor(() => {})"\n'), 'vi.waitFor(')).toBe(0)
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', '// vi.waitFor(() => {})\n'), 'vi.waitFor(')).toBe(0)
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', '/* vi.waitFor(() => {}) */\n'), 'vi.waitFor(')).toBe(0)
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', 'const re = /[\'"]vi\\.waitFor\\(/\n'), 'vi.waitFor(')).toBe(0)
    expect(countCodeOccurrences(maskLiteralsAndComments('self.ts', canonical), 'vi.waitFor(')).toBe(1)
  })

  it('扫描面覆盖 tests/**，且调用点数量在下限之上（判据不许空转）', () => {
    expect(specFiles.length, '没有扫到任何 spec 文件').toBeGreaterThan(10)
    expect(scanned.some(entry => entry.name === 'updates.spec.ts'), '扫描面漏了 updates.spec.ts').toBe(true)
    const filesWithCalls = [...sitesByFile.entries()].filter(([, sites]) => sites.length > 0)
    expect(allSites.length, `等待预算判据扫到的调用点只有 ${String(allSites.length)} 个，扫描器可能已经失效`)
      .toBeGreaterThanOrEqual(MIN_CALL_SITES)
    expect(filesWithCalls.length, '等待预算判据只覆盖了极少数文件').toBeGreaterThanOrEqual(MIN_FILES_WITH_CALLS)
    // 每个**代码位置**出现 `vi.waitFor(` 的文件都必须被 AST 如数找到 ——
    // 这条同时防"某个文件被静默跳过"和"解析器失效后判据空转"（字符串/注释里的
    // 同名文本会被掩码掉，不算代码位置）。
    const mismatch: string[] = []
    for (const entry of scanned) {
      const masked = maskLiteralsAndComments(entry.name, entry.source)
      const inCode = WAIT_API_NEEDLES
        .reduce((sum, needle) => sum + countCodeOccurrences(masked, needle), 0)
      const inAst = (sitesByFile.get(entry.name) ?? []).length
      if (inCode !== inAst) {
        mismatch.push(`${entry.name}: 代码位置 ${String(inCode)} 处，AST 找到 ${String(inAst)} 处`)
      }
    }
    expect(mismatch, `扫描器与源码不一致（判据可能已经失效）：\n${mismatch.join('\n')}`).toEqual([])
  })

  it('每一个等待型断言（vi.waitFor / expect.poll）都显式给了预算，且预算引用集中表里的键', () => {
    const offenders: string[] = []
    for (const site of allSites) {
      if (site.timeout === undefined) {
        offenders.push(`${site.name}:${site.line} 没有显式 timeout（吃 vitest 缺省的 1s）`)
        continue
      }
      const referenced = /^WAIT_BUDGETS\.([A-Z0-9_]+)$/u.exec(site.timeout.trim())
      if (referenced === null) {
        offenders.push(`${site.name}:${site.line} 的 timeout 不是集中表的引用：${site.timeout}`)
        continue
      }
      const key = referenced[1] as string
      if (!Object.hasOwn(WAIT_BUDGETS, key)) {
        offenders.push(`${site.name}:${site.line} 引用了不存在的预算键 WAIT_BUDGETS.${key}`)
      }
    }
    expect(offenders, `等待预算契约被破坏：\n${offenders.join('\n')}`).toEqual([])
  })

  it('每个调用点上方都有一行"现象"理由（预算的取值依据逐处可读）', () => {
    const missing = allSites
      .filter(site => !/^\s*\/\/\s*\S/u.test(site.previousLine))
      .map(site => `${site.name}:${site.line} 上方没有理由注释：${JSON.stringify(site.previousLine)}`)
    expect(missing, `等待预算缺少逐处理由：\n${missing.join('\n')}`).toEqual([])
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
    const declarations = findTestDeclarations(name, entry?.source ?? '')
      .filter(declaration => declaration.body.includes('collectWorkspaceSurface'))
    expect(declarations.length, `${name} 里没有直接调用 collectWorkspaceSurface 的用例，判据会空转`)
      .toBeGreaterThan(0)
    const offenders = declarations
      .filter(declaration => !(declaration.options ?? '').includes('TEST_BUDGETS.ARTIFACT_DERIVATION_MS'))
      .map(declaration => `${name}:${declaration.line}`)
    expect(offenders, `这些用例在真实产物上派生清单却没给显式 testTimeout：\n${offenders.join('\n')}`).toEqual([])
  })

  it('等待条件不得钉死墙钟现算字段的精确毫秒值（第二类假红：条件永不可满足）', () => {
    // 与预算无关的另一半：`retryDelayMs` 这类字段是 `截止时刻 - Date.now()` 现算的，
    // 首帧在负载下会是 9_999 而不是 10_000，此后单调变差 ⇒ `toBe`/`toEqual`/对象字面量
    // 钉精确值的等待条件**永远不会成立**，给多少预算都红。
    const offenders = allSites
      .filter(site => site.clockPins.length > 0)
      .map(site => `${site.name}:${site.line} 钉死了 ${site.clockPins.join('、')}`)
    expect(offenders, `等待条件钉死了墙钟现算的值（改用比较/容差）：\n${offenders.join('\n')}`).toEqual([])
  })

  it('用例自己的预算 ≥ 它内部用到的等待预算（否则等待预算永远用不满）', () => {
    // 本机 4 路负载实测的形态：`vi.waitFor` 给了 12s，但用例吃 5s 缺省 ⇒ 在 5001ms
    // 被 `Error: Test timed out in 5000ms` 掐死，12s 一次都没用上。
    const fallback = packageTestTimeout()
    const largestWait = Math.max(...Object.values(WAIT_BUDGETS))
    expect(
      fallback,
      `包缺省 testTimeout(${String(fallback)}ms) 小于最大的等待预算(${String(largestWait)}ms)：`
      + '任何等待预算都用不满，失败还会伪装成"Test timed out"',
    ).toBeGreaterThanOrEqual(largestWait)

    const offenders: string[] = []
    for (const entry of scanned) {
      for (const declaration of findTestDeclarations(entry.name, entry.source)) {
        if (declaration.waitBudgetKeys.length === 0) continue
        const declared = declaration.options === undefined
          ? undefined
          : /timeout\s*:\s*([^,}]+)/u.exec(declaration.options)?.[1]
        const budget = declared === undefined ? fallback : resolveTestBudget(declared)
        const needed = Math.max(...declaration.waitBudgetKeys.map((key) => {
          const budgets: Record<string, number> = { ...WAIT_BUDGETS }
          return budgets[key] ?? 0
        }))
        if (budget === undefined || budget < needed) {
          offenders.push(
            `${entry.name}:${declaration.line} 内部等待预算 ${String(needed)}ms，用例预算 ${budget === undefined ? '不可解析' : `${String(budget)}ms`}`,
          )
        }
      }
    }
    expect(offenders, `用例预算小于它要用的等待预算：\n${offenders.join('\n')}`).toEqual([])
  })
})

/** 判据的"扫描面缩水"自检：目录树被搬空时必须看得见（不是静默通过）。 */
describe('desktop waitFor budget contract · 扫描面', () => {
  it('tests 根目录存在且是目录（否则上面的扫描会静默变成空集）', () => {
    expect(statSync(testsRoot).isDirectory()).toBe(true)
  })
})
