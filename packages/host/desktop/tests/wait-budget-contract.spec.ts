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
 *    `wait-budgets.ts` 的文件头）—— 判据按**取值形态**判，不按匹配器名单判；
 * 10. **跨包同宽**（R11-B-02）：`browser` / `connectors` / `cron` / `enterprise` 的
 *    `tests/**` 走同一份判据（预算口径 = 显式数值 ≥ {@link CROSS_PACKAGE_MIN_WAIT_MS}），
 *    且每包的 `vitest.config.ts` 缺省 `testTimeout` 必须 ≥ 该包用到的最大等待预算。
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
 * ## 第十一轮（R11-B-02 / R11-B-03）：把面补宽，把误红纠正
 *
 * 审计实测（HEAD `3264137997`）**4 种绕法绿 / 3 种正当写法红**，两个方向都收口：
 *
 *  - **绕法（已堵）**：`const v = vi; v.waitFor(…)`（对象改名）、
 *    `import { vitest } from 'vitest'; vitest.waitFor(…)`（命名空间拼写 —— 实测
 *    `vitest === vi`）、`tests/x.spec.mts`（扫描面原只有 `.ts`/`.tsx`）、
 *    `tests/helper.ts` 的 `export const w = vi.waitFor` + 别处 `w(…)`（别名表按文件建）。
 *    另加 fail-closed 的 taint：取值链提到 vitest / 等待 API 却解析不出形状的名字，
 *    其 `.waitFor(` / `.poll(`（以及"提到等待 API"的名字被直接调用）一律按等待调用判。
 *  - **误红（已纠正）**：`{ timeout: WAIT_BUDGETS.X } satisfies …`（options 不是对象
 *    字面量）、`const timeout = WAIT_BUDGETS.X` + `{ timeout }`（简写属性）、
 *    理由注释与调用之间隔一行预算构造（`const budget = …`）。
 *  - **跨包面（R11-B-02）**：契约原先只罩桌面包，`browser` / `connectors` / `cron` /
 *    `enterprise` 还有 40 处等待吃 1s 缺省（`browser` 连 `testTimeout` 都没有、
 *    `enterprise` 连 `vitest.config.ts` 都没有）。现在四个包都在面内，判据与桌面包
 *    **共用同一份实现**；预算口径见 {@link CROSS_PACKAGE_MIN_WAIT_MS}（显式数值 +
 *    现象下限，桌面包仍是"必须引用集中表"）。
 *
 * 认账的边界：动态调用、函数值传递、以及 `tests/**` 之外的模块看不见（契约的扫描面
 * 本来就是各包的 `tests/**`）；这些由预算表的现象下限与包级 30s 兜底罩着。
 *
 * 现在的收口：扫描面 = 桌面包 + 四个宿主包的 `tests/**` 下**所有**
 * `*.ts` / `*.tsx` / `*.mts` / `*.cts`（含非 spec）；拼写面 = 点访问 + 元素访问 +
 * 包装形态 + 解构别名 + 常量别名 + 命名空间改名/导入 + 跨文件导出的等待 API；
 * 预算面 = 显式 `timeout`（集中表引用或 ≥ 现象下限的数值）+ 逐处理由注释 +
 * 用例预算 ≥ 内部等待预算（沿调用图传播）；
 * 钉死判据 = **取值形态**（墙钟字段/它的标量别名只要进了非比较族断言、或与字面量做等值
 * 比较、或在对象字面量里钉非零值，即红），并保留 `wait-budget-contract:allow-clock-value`
 * 的**显式豁免**（要人写下理由，不能靠换匹配器绕过）。
 *
 * @module dsh-plugin-desktop/tests/wait-budget-contract
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { configDefaults, defaultExclude, defaultInclude } from 'vitest/config'
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

/** 本契约认作"测试源"的扩展名（第十一轮 R11-B-03：`.mts` 曾整片在面外）。 */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const

/** `foo.mts` / `foo.ts` / `foo/index.ts` … 的所有扫描面候选路径。 */
function scannedCandidates(base: string): string[] {
  return [
    ...SCANNED_EXTENSIONS.map(extension => `${base}${extension}`),
    ...SCANNED_EXTENSIONS.map(extension => `${base}/index${extension}`),
  ]
}

/**
 * 一个名字解析到的"等待来源"。
 *
 * - 等待 API 本身（`const w = vi.waitFor`）；
 * - 命名空间对象（`const v = vi`、`import { vitest } from 'vitest'`）；
 * - `vitest` 模块命名空间（`import * as ns from 'vitest'` ⇒ `ns.vi.waitFor`）。
 *
 * 第十二轮（R11-B-03）加的：判据的形态面从"两个标识符文本"扩成"任何最终求值到
 * `vi.waitFor` / `expect.poll` 的名字"——对象改名（`const v = vi`）、命名空间导入
 * （`import { vitest }`）、跨文件 `export const w = vi.waitFor` 都在这张表里。
 */
type NamespaceValue = 'vi' | 'expect' | 'module'

/** 一个等待 API 的形态（对象名 + 方法名）。 */
interface WaitApiShape {
  readonly object: string
  readonly method: string
}

/** 一个文件（或一个项目）解析出的等待别名表。 */
interface WaitAliases {
  /** 本地名 → 等待 API。 */
  readonly apis: Map<string, WaitApiShape>
  /** 本地名 → 命名空间对象。 */
  readonly namespaces: Map<string, NamespaceValue>
  /**
   * "取值可能是等待 API、但解析不出确切形态"的名字（R11-B-03 的 fail-closed 面）。
   *
   * `const w = pick(vi.waitFor)` 这类绑定：取值链上确实提到等待 API，只是形状看不见。
   * 这类名字**被直接调用**（`w(fn)`）时按等待调用判 —— 换个写法绕不过契约。
   */
  readonly taintedApis: Set<string>
  /**
   * "取值可能是 vitest 命名空间、但解析不出确切形态"的名字。
   *
   * `const v = pick(vi)` 这类绑定：这类名字上的 `.waitFor(` / `.poll(` 按等待调用判。
   * 它**不**覆盖直接调用（`const emit = vi.fn(); emit(x)` 里的 `emit(x)` 不是等待）——
   * 两类 taint 必须分开，否则 `vi.fn()` 的常见用法会被误杀。
   */
  readonly taintedNamespaces: Set<string>
}

/** 空表（自检用例的单文件路径会就地建表）。 */
function emptyAliases(): WaitAliases {
  return { apis: new Map(), namespaces: new Map(), taintedApis: new Set(), taintedNamespaces: new Set() }
}

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
 * 一个表达式解析到的**命名空间对象**（`vi` / `expect` / `vitest` 模块命名空间）。
 *
 * R11-B-03 的四条绕法里有两条藏在这一层：`const v = vi; v.waitFor(…)`（对象改名）
 * 与 `import { vitest } from 'vitest'; vitest.waitFor(…)`（命名空间拼写 —— vitest 的
 * 模块导出里 `vitest` 就是 `vi` 本身，实测 `vitest === vi`，是合法且可用的拼写）。
 * 裸标识符 `vitest` 无条件按 `vi` 认：未导入时那段代码本来就跑不起来，认它只会让
 * 已经坏掉的文件变红（fail-closed 的方向）。
 * @param expression - the candidate receiver.
 * @param aliases - the file's alias table.
 * @returns the namespace value, or undefined.
 */
function namespaceOf(expression: ts.Expression, aliases: WaitAliases): NamespaceValue | undefined {
  const inner = unwrapWaitCallee(expression).inner
  if (ts.isIdentifier(inner)) {
    if (inner.text === 'vi' || inner.text === 'vitest') return 'vi'
    if (inner.text === 'expect') return 'expect'
    return aliases.namespaces.get(inner.text)
  }
  // `import * as ns from 'vitest'` ⇒ `ns.vi.waitFor(…)` / `ns.vitest.waitFor(…)`.
  if (ts.isPropertyAccessExpression(inner) && namespaceOf(inner.expression, aliases) === 'module') {
    if (inner.name.text === 'vi' || inner.name.text === 'vitest') return 'vi'
    if (inner.name.text === 'expect') return 'expect'
  }
  return undefined
}

/**
 * 一个表达式是不是"对 `vi` / `expect` 的等待 API 的引用"（不调用，只取值）。
 *
 * 覆盖点访问与元素访问两种拼写；`vi.waitFor.bind(vi)` 也算 —— 绑定后的函数就是同一个
 * 等待 API，把它当别的函数放过去，等价于给契约开一条"换个名字"的旁路。
 *
 * 接收者先过 {@link namespaceOf}：`const v = vi` 之后 `v.waitFor` 与 `vi.waitFor`
 * 是同一个 API，只认标识符文本正是 R11-B-03 的头号绕法。
 * @param expression - the candidate.
 * @param aliases - the file's alias table (namespaces + renamed APIs).
 * @returns the resolved API shape, or undefined.
 */
function waitReferenceOf(
  expression: ts.Expression,
  aliases: WaitAliases = emptyAliases(),
): { api: typeof WAIT_APIS[number], spelling: 'dot' | 'element' } | undefined {
  const inner = unwrapWaitCallee(expression).inner
  const match = (receiver: NamespaceValue | undefined, method: string, spelling: 'dot' | 'element'): { api: typeof WAIT_APIS[number], spelling: 'dot' | 'element' } | undefined => {
    if (receiver === undefined || receiver === 'module') return undefined
    const found = WAIT_APIS.find(candidate => candidate.object === receiver && candidate.method === method)
    return found === undefined ? undefined : { api: found, spelling }
  }
  // `vi.waitFor.bind(vi)`: the bound function IS the same wait API. Resolving it is
  // what keeps `const w = vi.waitFor.bind(vi)` from being a rename-shaped bypass.
  if (ts.isCallExpression(inner)) {
    const callee = unwrapWaitCallee(inner.expression).inner
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return waitReferenceOf(callee.expression, aliases)
    return undefined
  }
  if (ts.isPropertyAccessExpression(inner)) {
    return match(namespaceOf(inner.expression, aliases), inner.name.text, 'dot')
  }
  if (ts.isElementAccessExpression(inner)) {
    const argument = inner.argumentExpression
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      return match(namespaceOf(inner.expression, aliases), argument.text, 'element')
    }
  }
  // A renamed API (`const w = vi.waitFor`) used through another name.
  if (ts.isIdentifier(inner)) {
    const bound = aliases.apis.get(inner.text)
    if (bound === undefined) return undefined
    const found = WAIT_APIS.find(candidate => candidate.object === bound.object && candidate.method === bound.method)
    return found === undefined ? undefined : { api: found, spelling: 'dot' }
  }
  return undefined
}

/**
 * 解析一个调用点的**拼写**：点访问、元素访问（`vi['waitFor']`）、被包装的直接调用
 * （`(0, vi.waitFor)(fn)`）、别名（`const w = vi.waitFor` / `const { waitFor } = vi`）、
 * **命名空间改名**（`const v = vi; v.waitFor(…)`）与**跨文件导出的等待 API**
 * （`import { w } from './helper.ts'`，R11-B-03 的 E 例）。
 * @param node - the call expression.
 * @param aliases - the file's alias table (renamed APIs + namespaces + tainted names).
 * @param _file - the source file (kept for future diagnostics).
 * @returns the resolved call shape, or undefined for a call this contract ignores.
 */
function resolveWaitCall(
  node: ts.CallExpression,
  aliases: WaitAliases,
  _file: ts.SourceFile,
): { api: typeof WAIT_APIS[number], spelling: WaitForSite['spelling'] } | undefined {
  const { inner, wrapped } = unwrapWaitCallee(node.expression)
  // Direct spellings first, on the unwrapped callee: the wrapping must not decide
  // whether the contract sees the call (复审 N3 通道 ②).
  const direct = waitReferenceOf(inner, aliases)
  if (direct !== undefined) {
    // A call that resolves through the ALIAS TABLE has no `vi.waitFor(` at this code
    // position, so it is the shape the needle witness cannot count: `const w =
    // vi.waitFor; w(…)`, `import { vitest } from 'vitest'; vitest.waitFor(…)` and
    // `const v = vi; v.waitFor(…)` all keep the `alias` spelling (both witnesses
    // exclude them from the reconciliation). Everything the needle CAN see stays
    // `dot`/`element`/`wrapped` — i.e. calls whose receiver is the literal
    // `vi` / `expect` identifier.
    if (resolvesThroughAliasTable(inner, aliases)) return { api: direct.api, spelling: 'alias' }
    return { api: direct.api, spelling: wrapped ? 'wrapped' : direct.spelling }
  }
  if (ts.isIdentifier(inner)) {
    // Fail-closed: the value chain mentions a wait API but the shape is opaque
    // (`const w = pick(vi.waitFor); w(fn)`) — that is a wait call for this contract.
    if (aliases.taintedApis.has(inner.text)) return { api: WAIT_APIS[0], spelling: 'alias' }
    return undefined
  }
  // `x.waitFor(…)` / `x.poll(…)` on a name that could be a namespace but could not
  // be resolved (`const v = pick(vi)`): fail-closed. Names that never mention
  // vitest (`server.waitFor`, `helper['waitFor']`) stay out — the contract is about
  // the vitest wait APIs, not about the method's spelling.
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    const method = ts.isPropertyAccessExpression(inner)
      ? inner.name.text
      : (inner.argumentExpression !== undefined && ts.isStringLiteralLike(inner.argumentExpression)
          ? inner.argumentExpression.text
          : undefined)
    const receiver = unwrapWaitCallee(inner.expression).inner
    const taintedNames: readonly Set<string>[] = [aliases.taintedNamespaces, aliases.taintedApis]
    const receiverIsTainted = ts.isIdentifier(receiver) && taintedNames.some(set => set.has(receiver.text))
    const found = WAIT_APIS.find(candidate => candidate.method === method)
    if (receiverIsTainted && found !== undefined) return { api: found, spelling: 'alias' }
  }
  return undefined
}

/**
 * 这个 callee 是不是**通过别名表**解析出来的（而不是字面量 `vi` / `expect`）。
 *
 * 两个见证必须一致：needle 只数代码位置上的 `vi.waitFor(` / `expect.poll(`，所以
 * 任何"名字与字面量不同"的写法都必须归到 `alias` 拼写，否则覆盖率对账会把一处
 * 真实调用算成"AST 多看见一处"（或反过来静默缩小契约）。R11-B-03 的 B/C 两例
 * 正是这一类。
 * @param callee - the (unwrapped) callee expression.
 * @param aliases - the file's alias table.
 * @returns true when the call goes through a renamed API or a namespace alias.
 */
function resolvesThroughAliasTable(callee: ts.Expression, aliases: WaitAliases): boolean {
  if (ts.isIdentifier(callee)) return aliases.apis.has(callee.text) || aliases.namespaces.has(callee.text)
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const receiver = unwrapWaitCallee(callee.expression).inner
    // `vitest` 是模块导出里与 `vi` 同一个对象的那个名字（实测 `vitest === vi`），
    // 但 needle 只数 `vi.waitFor(` —— 所以它同样属于"needle 看不见"的一类。
    if (ts.isIdentifier(receiver)) {
      return receiver.text === 'vitest'
        || aliases.namespaces.has(receiver.text)
        || aliases.apis.has(receiver.text)
    }
    // `ns.vi.waitFor(…)` (a module namespace import).
    if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression)) {
      return aliases.namespaces.has(receiver.expression.text)
    }
  }
  return false
}

/** 一个文件里解析出的别名**与导出**（跨文件别名要读后者的导出表）。 */
interface FileAliases {
  readonly aliases: WaitAliases
  /** 导出名 → 该名字绑定的等待别名（`export const w = vi.waitFor`）。 */
  readonly exports: Map<string, { kind: 'api', api: WaitApiShape } | { kind: 'namespace', value: NamespaceValue }>
}

/** 一个导出名在目标文件里的绑定（跨文件别名解析的返回值）。 */
type ExportedAlias = FileAliases['exports'] extends Map<string, infer T> ? T : never

/**
 * Collect every local name bound to one of the wait APIs, to a vitest namespace, or
 * to a "mentions vitest but unresolvable" value.
 *
 * Shapes (each one an audit finding when missing — R11-B-03):
 *
 *  - destructuring (`const { waitFor } = vi`, `const { poll: eventually } = expect`);
 *  - a plain constant bound to the API itself (`const w = vi.waitFor`,
 *    `const w = vi['waitFor']`, `const b = vi.waitFor.bind(vi)`, chains such as
 *    `const w2 = w`) — 复审 N3 通道 ①;
 *  - a constant bound to a NAMESPACE (`const v = vi`), so `v.waitFor(…)` resolves
 *    exactly like `vi.waitFor(…)` — R11-B-03 bypass B;
 *  - imports (`import { vitest } from 'vitest'`, `import * as ns from 'vitest'`,
 *    `import { vi as v } from 'vitest'`) — R11-B-03 bypass C;
 *  - a named import of a wait API or namespace EXPORTED BY ANOTHER SCANNED FILE
 *    (`export const w = vi.waitFor` in `tests/helper.ts`, `import { w } from
 *    './helper.ts'`) — R11-B-03 bypass E. `export * from` is deliberately not
 *    followed: the name stays unresolved, and an unresolved name whose value chain
 *    mentions a wait API lands in `taintedApis` (fail-closed).
 *
 * Anything more exotic (a function returning the API, an object property) stays out
 * of the alias map — but a wrapper FUNCTION (`const w = (...a) => vi.waitFor(...a)`)
 * is covered by the local-call propagation instead: the wait inside its body is a
 * call site of its own and the case that invokes it inherits the budget.
 * @param file - the source file.
 * @param resolveExport - resolves `import { name } from './x.ts'` to that name's
 *   binding in the target file (undefined when the target is outside the scan set).
 * @returns the alias table plus this file's own exports.
 */
function collectAliases(
  file: ts.SourceFile,
  resolveExport: (specifier: string, name: string) => ExportedAlias | undefined = () => undefined,
): FileAliases {
  const apis: WaitAliases['apis'] = new Map()
  const namespaces: WaitAliases['namespaces'] = new Map()
  const taintedApis: WaitAliases['taintedApis'] = new Set()
  const taintedNamespaces: WaitAliases['taintedNamespaces'] = new Set()
  const exports: FileAliases['exports'] = new Map()
  /** 常量绑定，等解析趟处理（顺序无关）。 */
  const bindings: Array<{ name: string, initializer: ts.Expression, exported: boolean }> = []
  const table = (): WaitAliases => ({ apis, namespaces, taintedApis, taintedNamespaces })
  /** 子树里是否出现等待 API 的**取值**（`vi.waitFor` / 已解析的别名）。 */
  const mentionsWaitApi = (node: ts.Node): boolean => {
    let found = false
    const walk = (child: ts.Node): void => {
      if (found) return
      if (isWaitApiValue(child)) { found = true; return }
      if (ts.isIdentifier(child) && (apis.has(child.text) || taintedApis.has(child.text))) { found = true; return }
      ts.forEachChild(child, walk)
    }
    walk(node)
    return found
  }
  /** 子树里是否出现 vitest 命名空间（或它的别名/taint）。 */
  const mentionsNamespace = (node: ts.Node): boolean => {
    let found = false
    const walk = (child: ts.Node): void => {
      if (found) return
      if (ts.isIdentifier(child)) {
        if (child.text === 'vi' || child.text === 'vitest' || child.text === 'expect') { found = true; return }
        if (namespaces.has(child.text) || taintedNamespaces.has(child.text)) { found = true; return }
      }
      ts.forEachChild(child, walk)
    }
    walk(node)
    return found
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const clause = node.importClause?.namedBindings
      if (clause !== undefined) {
        if (ts.isNamespaceImport(clause)) {
          // `import * as ns from 'vitest'` ⇒ `ns.vi.waitFor(…)`.
          if (specifier === 'vitest') namespaces.set(clause.name.text, 'module')
        } else if (ts.isNamedImports(clause)) {
          for (const element of clause.elements) {
            const imported = (element.propertyName ?? element.name).text
            const local = element.name.text
            if (specifier === 'vitest') {
              // 字面量 `vi` / `vitest` / `expect` 已经由 {@link namespaceOf} 直接
              // 解析；把它们本身塞进别名表会让"字面量拼写"被误判成"通过别名表"，
              // 两个见证随即失配（覆盖率对账会红）。只登记**改名**的绑定。
              const literalNames = local === 'vi' || local === 'vitest' || local === 'expect'
              if (!literalNames) {
                if (imported === 'vi' || imported === 'vitest') namespaces.set(local, 'vi')
                else if (imported === 'expect') namespaces.set(local, 'expect')
              }
              continue
            }
            const target = resolveExport(specifier, imported)
            if (target === undefined) continue
            if (target.kind === 'api') apis.set(local, target.api)
            else namespaces.set(local, target.value)
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const source = namespaceOf(node.initializer, table())
      if (source !== undefined && source !== 'module') {
        for (const element of node.name.elements) {
          const property = element.propertyName
          const key = property === undefined
            ? (ts.isIdentifier(element.name) ? element.name.text : undefined)
            : (ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined)
          if (key === undefined || !ts.isIdentifier(element.name)) continue
          apis.set(element.name.text, { object: source, method: key })
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const statement = node.parent.parent
      const exported = ts.isVariableStatement(statement)
        && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      bindings.push({ name: node.name.text, initializer: node.initializer, exported })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  // Three passes so a chain (`const a = vi.waitFor; const b = a`) and a namespace
  // rename (`const v = vi; const w = v.waitFor`) resolve in any declaration order.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const binding of bindings) {
      if (binding.name === 'vi' || binding.name === 'vitest' || binding.name === 'expect') continue
      if (apis.has(binding.name) || namespaces.has(binding.name)) continue
      const inner = unwrapWaitCallee(binding.initializer).inner
      const namespace = namespaceOf(binding.initializer, table())
      // `const v = vi` — a namespace rename. `const w = vi.waitFor` is an API
      // rename (a VALUE, not a namespace binding) and is handled by `apiValueOf`.
      if (namespace !== undefined && namespace !== 'module' && ts.isIdentifier(inner)) {
        namespaces.set(binding.name, namespace)
        if (binding.exported) exports.set(binding.name, { kind: 'namespace', value: namespace })
        continue
      }
      const reference = apiValueOf(binding.initializer, table())
      if (reference !== undefined) {
        apis.set(binding.name, reference)
        if (binding.exported) exports.set(binding.name, { kind: 'api', api: reference })
        continue
      }
      // Fail-closed taint, in two classes so that `const emit = vi.fn(); emit(x)` is
      // not mistaken for a wait call.
      if (mentionsWaitApi(binding.initializer)) taintedApis.add(binding.name)
      else if (mentionsNamespace(binding.initializer)) taintedNamespaces.add(binding.name)
    }
  }
  return { aliases: table(), exports }
}

/** 一个表达式**就是**等待 API 的取值（`vi.waitFor` / `v['waitFor']` / `.bind`）。 */
function isWaitApiValue(node: ts.Node): boolean {
  if (!ts.isExpression(node)) return false
  return waitReferenceOf(node, emptyAliases()) !== undefined
}

/**
 * 一个"取值表达式"绑定到哪个等待 API，含别名链（`const w = vi.waitFor`、
 * `const p = v.poll`、`const b = a`）。裸标识符要看表（那是别名链，不是取值本身）。
 * @param expression - the initializer.
 * @param aliases - the table as it stands during this pass.
 * @returns the API shape, or undefined.
 */
function apiValueOf(expression: ts.Expression, aliases: WaitAliases): WaitApiShape | undefined {
  const inner = unwrapWaitCallee(expression).inner
  if (!ts.isIdentifier(inner)) {
    const direct = waitReferenceOf(inner, aliases)
    if (direct !== undefined) return { object: direct.api.object, method: direct.api.method }
    return undefined
  }
  return aliases.apis.get(inner.text)
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
 * 在 `at` 的词法位置向外找最近的 `const/let <name> = <init>`。
 *
 * 判据要读懂两种正当写法（R11-B-03 的 G/H 两例）：
 *
 * ```ts
 * const timeout = WAIT_BUDGETS.STATE_PROPAGATION_MS
 * await vi.waitFor(fn, { timeout })
 * const budget = { timeout: WAIT_BUDGETS.REAL_IO_MS }
 * await vi.waitFor(fn, budget)
 * ```
 *
 * 解析规则是**词法近似**：从 `at` 向外逐层看作用域，同层取位置在 `at` 之前的声明；
 * 某个函数作用域把该名字当参数绑定（遮蔽）时就**解析失败**（返回 undefined）——
 * 宁可判红也不要把外层同名常量借给内层。解析不出 ⇒ 判据按"timeout 不是集中表引用"
 * 处理（fail-closed 的方向）。
 * @param name - the identifier to resolve.
 * @param at - the position the identifier is used at.
 * @param file - the source file.
 * @returns the initializer expression, or undefined.
 */
function resolveLocalConstant(name: string, at: ts.Node, file: ts.SourceFile): ts.Expression | undefined {
  const position = at.getStart(file)
  /** 参数绑定把外层的同名常量遮住 —— 解析失败，而不是借用外层。 */
  const bindsParameter = (node: ts.Node): boolean => {
    const parameters = (node as ts.FunctionLikeDeclaration).parameters
    if (parameters === undefined) return false
    for (const parameter of parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return true
      if (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) {
        const bound = parameter.name.elements.some((element) =>
          ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === name)
        if (bound) return true
      }
    }
    return false
  }
  const declares = (node: ts.Node): ts.Expression | undefined => {
    let found: ts.Expression | undefined
    const walk = (child: ts.Node): void => {
      if (found !== undefined) return
      if (
        ts.isVariableDeclaration(child)
        && ts.isIdentifier(child.name)
        && child.name.text === name
        && child.initializer !== undefined
        && child.getStart(file) < position
      ) {
        found = child.initializer
        return
      }
      ts.forEachChild(child, walk)
    }
    walk(node)
    return found
  }
  for (let current: ts.Node | undefined = at; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current) && bindsParameter(current)) return undefined
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseClause(current)) {
      const found = declares(current)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * 读出一个等待调用点的 `timeout` 表达式文本（判定与传播只此一份实现）。
 *
 * 形态面（R11-B-03 的三条正当写法都在这里）：
 *
 *  - `{ timeout: WAIT_BUDGETS.X }`（点访问）；
 *  - `{ timeout: WAIT_BUDGETS.X } satisfies Record<string, number>` —— 包装不影响
 *    判定（`satisfies` / `as` / 括号 / 非空断言一律剥掉）；
 *  - 简写 `{ timeout }` —— 沿本地常量解析出 `WAIT_BUDGETS.X`；
 *  - 整个 options 是本地常量（`vi.waitFor(fn, budget)` 且 `budget` 的对象字面量在
 *    同一作用域可见）。
 *
 * 其它形态（数值字面量、别的对象、解析不出的标识符）一律返回能显示出来的文本，
 * 由判据判红 —— 不是"看不懂就放行"。
 * @param node - the wait call.
 * @param file - the source file.
 * @param aliases - the file's alias table (only for diagnostics).
 * @returns the timeout expression text, or undefined when no second argument exists.
 */
function resolveTimeoutText(node: ts.CallExpression, file: ts.SourceFile): string | undefined {
  const options = node.arguments[1]
  if (options === undefined) return undefined
  const resolved = stripWrappers(options)
  const literal = ts.isIdentifier(resolved)
    ? resolveLocalConstant(resolved.text, resolved, file)
    : resolved
  if (literal === undefined) return `无法解析的预算对象：${options.getText(file)}`
  const target = stripWrappers(literal)
  if (!ts.isObjectLiteralExpression(target)) {
    // `vi.waitFor(fn, 5_000)` 这种数值形态：登记成"给了预算但不是对象"，一律判红。
    return `非对象形态：${options.getText(file)}`
  }
  for (const property of target.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'timeout') {
      return property.initializer.getText(file)
    }
    // `{ timeout }` —— 简写属性是 ShorthandPropertyAssignment，旧实现只认
    // PropertyAssignment，于是同一份正当写法被判红（R11-B-03 的 G 例）。
    if (
      ts.isShorthandPropertyAssignment(property)
      && property.name.getText(file) === 'timeout'
    ) {
      const initializer = resolveLocalConstant(property.name.text, property, file)
      return initializer === undefined
        ? `无法解析的简写 timeout：${property.name.text}`
        : initializer.getText(file)
    }
  }
  return `对象里没有 timeout：${target.getText(file)}`
}

/**
 * 一个调用点是否带**理由注释**（含"预算构造链"上的注释，R11-B-03 的 H 例）。
 *
 * 接受范围与契约文字逐字一致：注释写在调用点**上一行或上方（中间只允许空行）**，
 * 或写在调用**所在行的行尾**；两条之外再加一条**同链**：调用点消费的预算由上面
 * 紧邻的 `const` 声明构造（`// 现象…` / `const budget = { timeout: … }` /
 * `await vi.waitFor(fn, budget)`）时，注释挂在那条声明上同样算"逐处可读"——
 * 它描述的就是这次等待的预算。链只沿"调用点真正引用到的名字"往回走，
 * 中间夹一条无关语句不算（那是"同一个用例里随便哪一行"，不放宽）。
 * @param node - the wait call.
 * @param file - the source file.
 * @param lines - the source lines.
 * @returns true when a `//` reason comment is attached.
 */
function hasReasonCommentForCall(node: ts.CallExpression, file: ts.SourceFile, lines: readonly string[]): boolean {
  const start = file.getLineAndCharacterOfPosition(node.getStart(file))
  const end = file.getLineAndCharacterOfPosition(node.getEnd())
  if (hasReasonComment(lines, start, end)) return true
  // The names this wait consumes as its budget (`vi.waitFor(fn, budget)` /
  // `{ timeout }`), transitively through local constants.
  const wanted = new Set<string>()
  const addNames = (expression: ts.Expression | undefined, depth: number): void => {
    if (expression === undefined || depth > 4) return
    const inner = stripWrappers(expression)
    if (ts.isIdentifier(inner)) {
      if (wanted.has(inner.text)) return
      wanted.add(inner.text)
      addNames(resolveLocalConstant(inner.text, inner, file), depth + 1)
      return
    }
    if (ts.isObjectLiteralExpression(inner)) {
      for (const property of inner.properties) {
        if (ts.isPropertyAssignment(property)) addNames(property.initializer, depth + 1)
        else if (ts.isShorthandPropertyAssignment(property)) addNames(property.name, depth + 1)
      }
    }
  }
  addNames(node.arguments[1], 0)
  if (wanted.size === 0) return false
  /** 调用点所在语句列表里，紧邻在前的语句（含链上声明）逐条回溯。 */
  let statement: ts.Node = node
  while (statement.parent !== undefined && !ts.isStatement(statement)) statement = statement.parent
  const list = statement.parent
  if (list === undefined || !ts.isSourceFile(list) && !ts.isBlock(list) && !ts.isModuleBlock(list) && !ts.isCaseClause(list)) return false
  const statements: readonly ts.Node[] = list.statements
  const index = statements.indexOf(statement)
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = statements[cursor]
    if (previous === undefined) return false
    const declared: string[] = []
    if (ts.isVariableStatement(previous)) {
      for (const declaration of previous.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declared.push(declaration.name.text)
      }
    }
    if (!declared.some(name => wanted.has(name))) return false
    const commentStart = file.getLineAndCharacterOfPosition(previous.getStart(file))
    const commentEnd = file.getLineAndCharacterOfPosition(previous.getEnd())
    if (hasReasonComment(lines, commentStart, commentEnd)) return true
    for (const declaration of (previous as ts.VariableStatement).declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) addNames(declaration.initializer, 0)
    }
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
function findWaitForSites(fileName: string, source: string, projectAliases?: WaitAliases): WaitForSite[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const lines = source.split('\n')
  // 项目级别名表（跨文件导出、命名空间改名）由调用方给出；自检用例走单文件路径，
  // 就地建一张表 —— 两条路的**判定实现**是同一个 {@link resolveWaitCall}。
  const aliases = projectAliases ?? collectAliases(file).aliases
  const found: WaitForSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolved = resolveWaitCall(node, aliases, file)
      if (resolved !== undefined) {
        const start = file.getLineAndCharacterOfPosition(node.getStart(file))
        const line = start.line + 1
        const callback = node.arguments[0]
        found.push({
          line,
          api: resolved.api.label,
          spelling: resolved.spelling,
          timeout: resolveTimeoutText(node, file),
          previousLine: lines[line - 2] ?? '',
          reasonComment: hasReasonCommentForCall(node, file, lines),
          clockPins: callback === undefined ? [] : collectClockPins(callback, file, lines),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 剥掉括号 / `as` / `satisfies` / `!` / `<T>` 断言，只看真正的取值表达式。 */
function stripWrappers(node: ts.Expression): ts.Expression {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (
      ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) current = current.expression
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
function maskLiteralsAndComments(fileName: string, source: string, aliases: WaitAliases = emptyAliases()): string {
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
  /**
   * callee 归一化后的文本（`vi.waitFor`），不是**直接**等待调用时为 undefined。
   *
   * 通过别名表解析出来的调用（`w(…)` / `v.waitFor(…)` / `vitest.waitFor(…)`）刻意
   * **不**归一化：它们的代码位置本来就没有 `vi.waitFor(`，AST 面把这一类记成 `alias`
   * 并在覆盖率对账里排除 —— 归一化会让 needle 平白多出一处，两个见证随即失配。
   */
  const normalizedCallee = (callee: ts.Expression): string | undefined => {
    const reference = waitReferenceOf(callee, aliases)
    if (reference === undefined || resolvesThroughAliasTable(callee, aliases)) return undefined
    return `${reference.api.object}.${reference.api.method}`
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
 *
 * 第十一轮 R11-B-03 又把面补宽一次：扩展名原先只有 `.ts` / `.tsx`，一个
 * `tests/x.spec.mts` 里的裸 `vi.waitFor` 整片不在面内（实测绿）。现在与
 * `SCANNED_EXTENSIONS` 同源（`.ts` / `.tsx` / `.mts` / `.cts`）。
 * @param root - the tests root directory.
 * @returns relative POSIX paths of every scanned TypeScript file below it.
 */
function collectTestSources(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && SCANNED_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
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
  /** 同一批等待的**毫秒数**（跨包面按数值口径比对用例预算）。 */
  readonly waitBudgetMs: number[]
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
function findTestDeclarations(
  fileName: string,
  source: string,
  project?: TestProject,
  rule: BudgetRule = 'central-table',
): TestDeclaration[] {
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
          // 预算**沿调用传播**：用例体里直接的等待，加上它调用的本地/导入函数体里的
          // 等待（复审 N3 通道 ③）。
          ...(() => {
            const reachable = waitKeysReachableFrom(callback, owner, files, rule)
            return { waitBudgetKeys: reachable.keys, waitBudgetMs: reachable.ms }
          })(),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * 一棵子树里所有等待型断言用到的预算。
 *
 * 两条口径共用这一份实现（第十一轮 R11-B-02 的跨包面就靠它）：
 *  - `central-table`（桌面包）：`WAIT_BUDGETS.<键>` —— 键要真实存在；
 *  - `explicit-number`（其余宿主包）：数值字面量 —— 判据用 {@link CROSS_PACKAGE_MIN_WAIT_MS}
 *    这个**现象下限**兜住"随便写个小数字"，改小只会让判据变红。
 *
 * `timeout` 的读取走 {@link resolveTimeoutText}：`satisfies` 包装、简写属性、整个
 * options 是本地常量三种正当写法与逐处判据**同一份解析**，不会一处认一处不认。
 * @param root - the subtree being walked.
 * @param file - the source file.
 * @param aliases - the file's alias table.
 * @param rule - the budget rule in force.
 * @returns referenced keys (central-table) and every budget in milliseconds.
 */
function collectWaitBudgets(
  root: ts.Node,
  file: ts.SourceFile,
  aliases: WaitAliases,
  rule: BudgetRule,
): { keys: string[], ms: number[] } {
  const keys: string[] = []
  const ms: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && resolveWaitCall(node, aliases, file) !== undefined) {
      const text = resolveTimeoutText(node, file)
      if (text !== undefined) {
        const referenced = /^WAIT_BUDGETS\.([A-Z0-9_]+)$/u.exec(text.trim())
        if (rule === 'central-table') {
          const budgets: Record<string, number> = { ...WAIT_BUDGETS }
          if (referenced?.[1] !== undefined) {
            keys.push(referenced[1])
            ms.push(budgets[referenced[1]] ?? 0)
          }
        } else {
          const numeric = resolveNumericBudget(text)
          if (numeric !== undefined) ms.push(numeric)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return { keys, ms }
}

/** 非桌面包的等待预算现象下限（与桌面 `STATE_PROPAGATION_MS` 同档）。 */
const CROSS_PACKAGE_MIN_WAIT_MS = 10_000

/** `timeout` 文本 → 毫秒数（数值字面量 / `WAIT_BUDGETS.<键>`）。 */
function resolveNumericBudget(text: string): number | undefined {
  const trimmed = text.trim()
  if (/^\d[\d_]*$/u.test(trimmed)) return Number(trimmed.replaceAll('_', ''))
  const referenced = /^WAIT_BUDGETS\.([A-Z0-9_]+)$/u.exec(trimmed)
  if (referenced?.[1] !== undefined) {
    const budgets: Record<string, number> = { ...WAIT_BUDGETS }
    return budgets[referenced[1]]
  }
  return undefined
}

/** 预算口径：桌面包必须引用集中表；其余宿主包接受显式数值（≥ 现象下限）。 */
type BudgetRule = 'central-table' | 'explicit-number'

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
  /** 本文件的等待别名表（含跨文件导出解析后的结果）。 */
  readonly aliases: WaitAliases
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
  for (const candidate of [base, ...scannedCandidates(base)]) {
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
function indexFileCalls(
  name: string,
  source: string,
  scanned: ReadonlySet<string>,
  aliases: WaitAliases = collectAliases(ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, scriptKindOf(name))).aliases,
): FileCalls {
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
  return { name, sourceFile, functions, imports, namespaces, aliases }
}

/**
 * 建整个扫描面的调用图索引 + **跨文件别名表**（R11-B-03 的 E 例）。
 *
 * 两趟：第一趟按文件解析出"本文件能给出的导出"（`export const w = vi.waitFor`），
 * 第二趟带着导出解析器重跑一次，让 `import { w } from './helper.ts'` 也解析成等待 API。
 * 旧实现的别名表**按文件**建，跨文件别名因此整片在判据面外 —— 换个写法即绕过。
 * @param files - `{ name, source }` pairs (relative name, source text).
 * @returns the project index (call graph + alias table per file).
 */
function buildTestProject(files: ReadonlyArray<{ name: string, source: string }>): TestProject {
  const scannedNames = new Set(files.map(entry => entry.name))
  const parsed = files.map((entry) => {
    const sourceFile = ts.createSourceFile(entry.name, entry.source, ts.ScriptTarget.Latest, true, scriptKindOf(entry.name))
    return { entry, sourceFile, local: collectAliases(sourceFile) }
  })
  const exportsByFile = new Map(parsed.map(item => [item.entry.name, item.local.exports]))
  const project: TestProject = new Map()
  for (const item of parsed) {
    const resolve = (specifier: string, name: string): ExportedAlias | undefined => {
      const target = resolveScannedFile(item.entry.name, specifier, scannedNames)
      return target === undefined ? undefined : exportsByFile.get(target)?.get(name)
    }
    const full = collectAliases(item.sourceFile, resolve)
    project.set(item.entry.name, indexFileCalls(item.entry.name, item.entry.source, scannedNames, full.aliases))
  }
  return project
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
function waitKeysReachableFrom(
  root: ts.Node,
  owner: FileCalls,
  project: TestProject,
  rule: BudgetRule = 'central-table',
): { keys: string[], ms: number[] } {
  const keys: string[] = []
  const ms: number[] = []
  const visited = new Set<string>()
  const add = (key: string): void => { if (!keys.includes(key)) keys.push(key) }
  const addMs = (value: number): void => { if (!ms.includes(value)) ms.push(value) }
  const walk = (node: ts.Node, file: FileCalls): void => {
    const collected = collectWaitBudgets(node, file.sourceFile, file.aliases, rule)
    for (const key of collected.keys) add(key)
    for (const value of collected.ms) addMs(value)
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
  return { keys, ms }
}

/**
 * 一个包缺省的 `testTimeout`（它的 `vitest.config.ts`）。缺失时按 vitest 的 5_000 计
 * —— "没写"与"写了 5s"在可达性上是同一件事（R11-B-02 的跨包面就靠这条：没有
 * `vitest.config.ts` 的包会被按 5s 判）。
 * @param configPath - absolute path of the package's `vitest.config.ts`.
 * @returns the declared `testTimeout`, or vitest's 5_000 default.
 */
function testTimeoutOf(configPath: string): number {
  let source: string
  try {
    source = readFileSync(configPath, 'utf8')
  } catch {
    return 5_000
  }
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

/** 桌面包自己的缺省 `testTimeout`。 */
function packageTestTimeout(): number {
  return testTimeoutOf(join(testsRoot, '..', 'vitest.config.ts'))
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
  rule: BudgetRule = 'central-table',
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
  // 调用图索引与别名表按**整个传入集合**建一次：跨文件的 helper 与跨文件的别名
  // 都要能被判据穿透（复审 N3 通道 ③ / R11-B-03 的 E 例）。
  const project = buildTestProject(files)
  const aliasesOf = (name: string): WaitAliases => project.get(name)?.aliases ?? emptyAliases()
  for (const entry of files) {
    const found = findWaitForSites(entry.name, entry.source, aliasesOf(entry.name))
    for (const site of found) {
      if (site.timeout === undefined) {
        budget.push({ file: entry.name, line: site.line, message: `${site.api} 没有显式 timeout（吃 vitest 缺省的 1s）` })
        continue
      }
      if (rule === 'central-table') {
        const referenced = /^WAIT_BUDGETS\.([A-Z0-9_]+)$/u.exec(site.timeout.trim())
        if (referenced === null) {
          budget.push({ file: entry.name, line: site.line, message: `${site.api} 的 timeout 不是集中表的引用：${site.timeout}` })
        } else {
          const key = referenced[1] as string
          if (!Object.hasOwn(WAIT_BUDGETS, key)) {
            budget.push({ file: entry.name, line: site.line, message: `引用了不存在的预算键 WAIT_BUDGETS.${key}` })
          }
        }
      } else {
        // 非桌面包：显式数值预算也认，但必须 ≥ 现象下限 —— 把预算改小只会让判据变红。
        const numeric = resolveNumericBudget(site.timeout)
        if (numeric === undefined) {
          budget.push({ file: entry.name, line: site.line, message: `${site.api} 的 timeout 不是显式预算：${site.timeout}` })
        } else if (numeric < CROSS_PACKAGE_MIN_WAIT_MS) {
          budget.push({
            file: entry.name,
            line: site.line,
            message: `${site.api} 的预算 ${String(numeric)}ms 低于现象下限 ${String(CROSS_PACKAGE_MIN_WAIT_MS)}ms`,
          })
        }
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
    const masked = maskLiteralsAndComments(entry.name, entry.source, aliasesOf(entry.name))
    const inCode = WAIT_API_NEEDLES
      .reduce((sum, needle) => sum + countCodeOccurrences(masked, needle), 0)
    const direct = found.filter(site => site.spelling !== 'alias').length
    if (inCode !== direct) {
      coverage.push({ file: entry.name, line: 1, message: `代码位置 ${String(inCode)} 处，AST 找到 ${String(direct)} 处` })
    }
    for (const declaration of findTestDeclarations(entry.name, entry.source, project, rule)) {
      if (declaration.waitBudgetMs.length === 0) continue
      const declared = declaration.options === undefined
        ? declaration.numericTimeout
        : /timeout\s*:\s*([^,}]+)/u.exec(declaration.options)?.[1]
      const budgetMs = declared === undefined ? fallbackTimeout : resolveTestBudget(declared)
      const needed = Math.max(...declaration.waitBudgetMs)
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
/** 扫描面的调用图索引 + 别名表（跨文件 helper 与跨文件别名都用它）。 */
const scannedProject: TestProject = buildTestProject(scanned)
const findings = contractFindings(scanned, packageTestTimeout())
/** 等待型调用点，按 (文件, 行) 定位（用于"每一个调用点都进了判据"的自检）。 */
const allSites = scanned.flatMap(entry =>
  findWaitForSites(entry.name, entry.source, scannedProject.get(entry.name)?.aliases).map(site => ({ name: entry.name, ...site })))
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
    // 扫描面与 `SCANNED_EXTENSIONS` 同源（R11-B-03 的 D 例：`.mts` 曾整片在面外）。
    expect(scanned.every(entry => SCANNED_EXTENSIONS.some(extension => entry.name.endsWith(extension)))).toBe(true)
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

/* ------------------------------------------------------------------------- *
 * R11-B-02：契约的**跨包面**
 *
 * 审计发现（第十一轮）：等待预算契约的扫描面只有桌面包的 `tests/**`，而
 * `browser` / `enterprise` / `cron` / `connectors` 还有 **40 处**等待型断言吃
 * `vi.waitFor` 的 1s 缺省（`browser` 连 `testTimeout` 都没有、`enterprise` 连
 * `vitest.config.ts` 都没有）。同一个 commit 一次红一次绿的那种假红，在这四个包
 * 里一模一样地成立 —— 而契约的价值恰恰是"不看运气"。
 *
 * 处置取向（与审计建议一致）：**先补预算，再把面扩到位**，不为了让判据变绿而放宽。
 *  - 四个包逐处显式预算（本文件的判据强制：显式数值、带理由注释、且 ≥ 现象下限）；
 *  - `browser` / `enterprise` 补 `vitest.config.ts`（`testTimeout: 30_000`），
 *    `cron` / `connectors` 早有 30s；
 *  - 判据与桌面包**共用同一份实现**（{@link contractFindings}），只有预算口径不同：
 *    桌面包必须引用集中表 `WAIT_BUDGETS`，其余包接受显式数值（≥ 现象下限）——
 *    它们的集中表尚未建立，而"数值 + 下限"同样让"把预算改小"变成红灯。
 * ------------------------------------------------------------------------- */

/** 一个被跨包面覆盖的宿主包。 */
interface HostPackageScan {
  readonly name: string
  /** `tests/**` 根目录（绝对路径）。 */
  readonly root: string
  /** 该包的 `vitest.config.ts`（缺失按 5s 判 —— 那正是 R11-B-02 的一半）。 */
  readonly configPath: string
}

const hostRoot = join(testsRoot, '..', '..')

/** 跨包面：四个宿主包，路径从桌面包推出（它们永远同仓并存）。 */
const HOST_PACKAGE_SCANS: readonly HostPackageScan[] = [
  { name: 'browser', root: join(hostRoot, 'browser', 'tests'), configPath: join(hostRoot, 'browser', 'vitest.config.ts') },
  { name: 'connectors', root: join(hostRoot, 'connectors', 'tests'), configPath: join(hostRoot, 'connectors', 'vitest.config.ts') },
  { name: 'cron', root: join(hostRoot, 'cron', 'tests'), configPath: join(hostRoot, 'cron', 'vitest.config.ts') },
  { name: 'enterprise', root: join(hostRoot, 'enterprise', 'tests'), configPath: join(hostRoot, 'enterprise', 'vitest.config.ts') },
]

/** 跨包面的调用点总数下限（判据不许在"什么都没扫到"时变绿）。 */
const MIN_CROSS_PACKAGE_CALL_SITES = 30

interface CrossPackageResult {
  readonly scan: HostPackageScan
  readonly files: ReadonlyArray<{ name: string, source: string }>
  readonly fallback: number
  readonly findings: ReturnType<typeof contractFindings>
  readonly sites: ReadonlyArray<{ name: string, line: number, api: string, timeout: string | undefined }>
}

const crossPackages: readonly CrossPackageResult[] = HOST_PACKAGE_SCANS.map((scan) => {
  const files = collectTestSources(scan.root).map(name => ({ name, source: readFileSync(join(scan.root, name), 'utf8') }))
  const fallback = testTimeoutOf(scan.configPath)
  const project = buildTestProject(files)
  return {
    scan,
    files,
    fallback,
    findings: contractFindings(files, fallback, 'explicit-number'),
    sites: files.flatMap(entry => findWaitForSites(entry.name, entry.source, project.get(entry.name)?.aliases)
      .map(site => ({ name: `${scan.name}/${entry.name}`, line: site.line, api: site.api, timeout: site.timeout }))),
  }
})

describe('wait budget contract · 跨包面（R11-B-02）', () => {
  it('四个宿主包都在面内，且每个包都真的扫到了调用点（判据不许空转）', () => {
    expect(crossPackages.map(entry => entry.scan.name)).toEqual(['browser', 'connectors', 'cron', 'enterprise'])
    for (const entry of crossPackages) {
      expect(entry.files.length, `${entry.scan.name}: 扫描面是空的（目录搬走或扩展名漏了）`).toBeGreaterThan(3)
      expect(
        entry.sites.length,
        `${entry.scan.name}: 一个等待型调用点都没扫到 —— 该包从判据面里掉出去了`,
      ).toBeGreaterThanOrEqual(2)
      expect(
        entry.findings.coverage,
        `${entry.scan.name}: AST 与"代码位置计数"不一致（判据可能已经失效）：\n${render(entry.findings.coverage)}`,
      ).toEqual([])
    }
    const total = crossPackages.reduce((sum, entry) => sum + entry.sites.length, 0)
    expect(total, `跨包面只扫到 ${String(total)} 个调用点（下限 ${String(MIN_CROSS_PACKAGE_CALL_SITES)}）`)
      .toBeGreaterThanOrEqual(MIN_CROSS_PACKAGE_CALL_SITES)
  })

  it('跨包面的每个等待都显式给了预算、都不低于现象下限、都带理由注释', () => {
    for (const entry of crossPackages) {
      expect(
        entry.findings.budget,
        `${entry.scan.name}: 等待预算契约被破坏：\n${render(entry.findings.budget)}`,
      ).toEqual([])
      expect(
        entry.findings.clock,
        `${entry.scan.name}: 等待条件钉死了墙钟现算的值：\n${render(entry.findings.clock)}`,
      ).toEqual([])
    }
  })

  it('每个包的缺省 testTimeout ≥ 该包最大的等待预算（否则预算用不满）', () => {
    for (const entry of crossPackages) {
      const largest = Math.max(
        CROSS_PACKAGE_MIN_WAIT_MS,
        ...entry.sites.map(site => resolveNumericBudget(site.timeout ?? '') ?? 0),
      )
      expect(
        entry.fallback,
        `${entry.scan.name}: 包缺省 testTimeout(${String(entry.fallback)}ms) 小于该包最大的等待预算(${String(largest)}ms)`,
      ).toBeGreaterThanOrEqual(largest)
    }
  })

  it('判据在跨包口径上真的会咬：没有预算 / 预算低于下限 / 没有理由注释，三态全红', () => {
    const bare = 'it("probe", async () => {\n  await vi.waitFor(() => { expect(x).toBe(1) })\n})\n'
    const bareReport = contractFindings([{ name: 'tests/probe.spec.ts', source: bare }], 30_000, 'explicit-number')
    expect(bareReport.budget.map(finding => finding.message).join('|'), '没有预算必须红').toContain('没有显式 timeout')
    const small = [
      'it("probe", async () => {',
      '  // 现象：状态传播档。',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: 1_000 })',
      '})',
      '',
    ].join('\n')
    const smallReport = contractFindings([{ name: 'tests/probe.spec.ts', source: small }], 30_000, 'explicit-number')
    expect(smallReport.budget.map(finding => finding.message).join('|'), '低于现象下限必须红').toContain('低于现象下限')
    const noReason = [
      'it("probe", async () => {',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: 10_000 })',
      '})',
      '',
    ].join('\n')
    const noReasonReport = contractFindings([{ name: 'tests/probe.spec.ts', source: noReason }], 30_000, 'explicit-number')
    expect(noReasonReport.budget.map(finding => finding.message).join('|'), '没有理由注释必须红').toContain('理由注释')
    // 反向：正当写法（显式预算 + 理由注释）必须绿 —— 判据不是"见到等待就红"。
    const ok = [
      'it("probe", async () => {',
      '  // 现象：进程内状态传播。',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: 10_000 })',
      '})',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: ok }], 30_000, 'explicit-number')).toEqual({
      budget: [], clock: [], coverage: [], caseBudget: [],
    })
  })
})


/* ------------------------------------------------------------------------- *
 * 测试发现面契约（R11-J2-N1）
 *
 * ## 为什么需要它
 *
 * R11-B-02 给 enterprise 新加 `vitest.config.ts` 时顺手写了
 * `include: ['tests/**\/*.spec.ts']`。vitest 的缺省发现面是
 * `**\/*.{test,spec}.?(c|m)[jt]s?(x)`（`vitest/config` 的 `defaultInclude`），而该包
 * 有一个测试文件在 `tests/` **之外**（`src/server-connector/connector.test.ts`）⇒
 * 四条断言（`validateBootstrap` / `sha256Fingerprint` / `checkFingerprint` /
 * `saveFingerprint`）**从门禁里静默消失**：整包 62 → 61 个文件，而当时没有任何判据
 * 会咬到它（跨包等待预算判据的扫描面是各包的 `tests/`，与被收窄的 `include`
 * **共享同一个盲区**）。
 *
 * ## 判据的五条设计要点
 *
 * 1. **两个见证，来源不同**：① 文件系统上按缺省 include/exclude 语义走出来的集合
 *    （{@link defaultSurfaceFiles}，**不读任何配置**）；② `vitest list --filesOnly`
 *    报出的实际发现集合（走真正的 vitest 配置解析与 glob，**不重写一遍 glob 语义**）。
 *    两者必须逐字相等 —— "加 config 前后发现的文件集合相同"就是这一条。
 * 2. **缺省常量先对表**：`defaultInclude` / `defaultExclude` /
 *    `configDefaults.environment` 必须仍是本文件认识的那几个值，否则 fail-loud
 *    （vitest 换了默认值，"文件名后缀 + 跳过目录"这个复刻就不再等价）。
 * 3. **静态面同判**：配置里的 `include` / `exclude` / `environment` 必须"不声明，或与
 *    缺省逐字一致"，否则必须有 {@link DISCOVERY_NARROWING} 登记（丢失文件清单 + 理由）。
 * 4. **豁免不许滥用**：登记进 {@link DISCOVERY_NARROWING} 的文件必须是**可证明的非
 *    vitest 文件**（正文里没有 vitest import）—— 真用例永远不许被"登记成豁免"。
 * 5. **判据自身会咬**：{@link discoveryFindings} 是纯函数，合成集合上"收窄未登记 /
 *    比缺省更宽 / 登记与事实对不上"三种都红、"登记一致"绿。
 * ------------------------------------------------------------------------- */

interface DiscoveryScan {
  readonly name: string
  /** 包根（绝对路径）——缺省发现面就在这棵树下。 */
  readonly pkgRoot: string
  /** 该包的 `vitest.config.ts`（静态面读它）。 */
  readonly configPath: string
}

/** 五个宿主包（桌面包也在面内：它的配置是既有文件，同样不许偷偷收窄）。 */
const DISCOVERY_SCANS: readonly DiscoveryScan[] = [
  { name: 'browser', pkgRoot: join(hostRoot, 'browser'), configPath: join(hostRoot, 'browser', 'vitest.config.ts') },
  { name: 'connectors', pkgRoot: join(hostRoot, 'connectors'), configPath: join(hostRoot, 'connectors', 'vitest.config.ts') },
  { name: 'cron', pkgRoot: join(hostRoot, 'cron'), configPath: join(hostRoot, 'cron', 'vitest.config.ts') },
  { name: 'desktop', pkgRoot: join(hostRoot, 'desktop'), configPath: join(hostRoot, 'desktop', 'vitest.config.ts') },
  { name: 'enterprise', pkgRoot: join(hostRoot, 'enterprise'), configPath: join(hostRoot, 'enterprise', 'vitest.config.ts') },
]

/**
 * 本判据认识的那一份缺省发现面。
 *
 * `defaultInclude` 是"任意深度 + 文件名形态"，所以它的等价复刻就是**文件名后缀判定**
 * （见 {@link DEFAULT_TEST_FILE}）；`defaultExclude` 只有两条"整套跳过某目录"的形态，
 * 等价复刻就是走目录时跳过那两个目录名（见 {@link DEFAULT_EXCLUDED_DIRS}）。
 * 两条常量一变，复刻就不再等价 ⇒ 第 1 条用例 fail-loud。
 */
const RECOGNIZED_DEFAULT_INCLUDE: readonly string[] = ['**/*.{test,spec}.?(c|m)[jt]s?(x)']
const RECOGNIZED_DEFAULT_EXCLUDE: readonly string[] = ['**/node_modules/**', '**/.git/**']
const DEFAULT_TEST_FILE = /\.(?:test|spec)\.(?:[cm])?[jt]sx?$/
const DEFAULT_EXCLUDED_DIRS = new Set(['node_modules', '.git'])

/**
 * 允许"配置发现面比缺省窄"的登记表：逐文件 + 理由。
 *
 * **只有可证明的非 vitest 文件才进得来**（见"豁免不许滥用"那条用例）。任何一处
 * 未登记的收窄都会让第 2 条用例变红 —— 判据默认"配置不许改变发现面"。
 */
const DISCOVERY_NARROWING: Readonly<Record<string, { readonly files: readonly string[], readonly reason: string }>> = {
  desktop: {
    files: ['scripts/runtime-closure.spec.mjs'],
    reason: [
      '`node:test` 脚本，由 package.json 的 `verify:closure` 用 `node --test` 跑',
      '（`node --test scripts/runtime-closure.spec.mjs && node scripts/verify-runtime-closure.mjs`），',
      '正文 import 的是 `node:test`/`node:assert`，没有 vitest —— 它不是 vitest 用例，',
      '收进来只会得到 "No test suite found in file"。本包 `include: [\'tests/**/*.spec.ts\']`',
      '正是为此而写，第十轮（`3264137997`）就存在，不是本轮引入。',
    ].join(''),
  },
}

/** 配置里除发现面之外允许出现的字段（它们不影响"哪些文件会被收集"）。 */
const NON_DISCOVERY_CONFIG_KEYS = new Set(['testTimeout', 'maxWorkers', 'pool', 'poolOptions', 'sequence', 'retry', 'reporters', 'globals', 'restoreMocks', 'clearMocks', 'mockReset', 'silent', 'bail', 'testNamePattern', 'hookTimeout', 'teardownTimeout'])

/** 去掉 ANSI 颜色序列（`vitest list` 在 TTY 下会上色）。 */
const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, '')

/**
 * 按**缺省发现面**在文件系统上走一遍 —— 不读任何配置。
 * @param pkgRoot - 包根目录。
 * @returns 相对包根的 POSIX 路径，已排序。
 */
function defaultSurfaceFiles(pkgRoot: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile() && DEFAULT_TEST_FILE.test(entry.name)) {
        found.push(relative(pkgRoot, full).split('\\').join('/'))
      }
    }
  }
  walk(pkgRoot)
  return found.sort()
}

/**
 * 用 vitest 自己的发现机制报出该包**实际**会跑的文件集合。
 *
 * 判据刻意不重写 glob 语义：`vitest list --filesOnly` 走的就是 `vitest run` 的配置
 * 解析与文件收集，所以"配置有没有把某个文件排除掉"这件事只有一个权威答案。
 * @param scan - 目标包。
 * @returns 相对包根的 POSIX 路径（已排序）与原始输出（失败消息里要给人看）。
 */
function effectiveSurfaceFiles(scan: DiscoveryScan): { files: string[], raw: string } {
  const entry = join(scan.pkgRoot, 'node_modules', 'vitest', 'vitest.mjs')
  // 别把外层的 vitest 运行期变量带进去：本判据在 worker 里跑，`VITEST*` 是给外层的。
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^VITEST/u.test(key)) env[key] = value
  let stdout: string
  try {
    stdout = execFileSync(process.execPath, [entry, 'list', '--filesOnly'], {
      cwd: scan.pkgRoot,
      encoding: 'utf8',
      env,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (cause: unknown) {
    const detail = cause as { stdout?: string, stderr?: string }
    throw new Error(
      `vitest list 跑不起来（${scan.name}）：${String(cause)}\nstdout:\n${detail.stdout ?? ''}\nstderr:\n${detail.stderr ?? ''}`,
    )
  }
  const files = stdout
    .split('\n')
    .map(line => stripAnsi(line).trim())
    .filter(line => line !== '')
    .map(line => line.replace(/^\.\//u, '').split('\\').join('/'))
    .sort()
  return { files, raw: stdout }
}

/**
 * 两侧集合的**纯**判别器（判据自检直接喂合成集合）。
 * @param scanName - 包名（查 {@link DISCOVERY_NARROWING}）。
 * @param defaultFiles - 缺省发现面。
 * @param effectiveFiles - 配置下的实际发现面。
 * @returns 人类可读的失败行，空数组 = 绿。
 */
function discoveryFindings(
  scanName: string,
  defaultFiles: readonly string[],
  effectiveFiles: readonly string[],
): readonly string[] {
  const findings: string[] = []
  const extra = effectiveFiles.filter(file => !defaultFiles.includes(file))
  if (extra.length > 0) {
    findings.push(`配置比缺省发现面更宽：多出来 ${extra.join('、')}（不在缺省发现面里的文件会被当用例跑）`)
  }
  const lost = [...defaultFiles.filter(file => !effectiveFiles.includes(file))].sort()
  const registered = DISCOVERY_NARROWING[scanName]
  const expected = registered === undefined ? [] : [...registered.files].sort()
  if (expected.join('\n') !== lost.join('\n')) {
    findings.push(registered === undefined
      ? `配置收窄了发现面且没有登记：${lost.join('、')}（这些文件不会进任何门禁）`
      : `登记与实际丢失对不上：登记 [${expected.join('、') || '空'}]，实际丢失 [${lost.join('、') || '空'}]`)
  }
  return findings
}

/** 读配置里 `test: { … }` 的直接属性：名字 → 初始化文本。 */
function configTestProperties(configPath: string): Map<string, string> {
  const source = readFileSync(configPath, 'utf8')
  const file = ts.createSourceFile('vitest.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const properties = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'test' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const member of node.initializer.properties) {
        if (ts.isPropertyAssignment(member)) properties.set(member.name.getText(file), member.initializer.getText(file))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return properties
}

/** 把 `['a', 'b']` 形态的初始化文本解析成字符串数组（解析不出来返回 null）。 */
function stringArrayLiteral(text: string): string[] | null {
  const file = ts.createSourceFile('probe.ts', `const x = ${text}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let value: string[] | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node) && node.elements.every(element => ts.isStringLiteral(element))) {
      value = node.elements.map(element => (element as ts.StringLiteral).text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return value
}

/** 该文件正文里有没有 vitest 的 import（豁免资格的判据）。 */
function importsVitest(source: string): boolean {
  return /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"]vitest(?:\/[^'"]*)?['"]/u.test(source)
}

describe('wait budget contract · 测试发现面（R11-J2-N1）', () => {
  it('缺省发现面的三个常量仍是判据认识的那几个（vitest 改了默认值就必须回来对表）', () => {
    expect(
      [...defaultInclude],
      'vitest 的 defaultInclude 变了：本判据用"文件名后缀"复刻它（见 DEFAULT_TEST_FILE），必须重新对表',
    ).toEqual([...RECOGNIZED_DEFAULT_INCLUDE])
    expect(
      [...defaultExclude],
      'vitest 的 defaultExclude 变了：本判据用"跳过 node_modules/.git 两个目录"复刻它（见 DEFAULT_EXCLUDED_DIRS），必须重新对表',
    ).toEqual([...RECOGNIZED_DEFAULT_EXCLUDE])
    expect(configDefaults.environment, 'vitest 的缺省 environment 不再是 node，配置里显式声明它也不再"与缺省一致"').toBe('node')
  })

  it('五个宿主包的配置都不得收窄发现面（vitest list 的实际集合 == 缺省语义走出的集合）', () => {
    expect(DISCOVERY_SCANS.map(scan => scan.name)).toEqual(['browser', 'connectors', 'cron', 'desktop', 'enterprise'])
    let total = 0
    for (const scan of DISCOVERY_SCANS) {
      const defaultFiles = defaultSurfaceFiles(scan.pkgRoot)
      expect(
        defaultFiles.length,
        `${scan.name}: 缺省发现面只走出 ${String(defaultFiles.length)} 个文件 —— 判据正在空转（目录搬走或后缀判据失效）`,
      ).toBeGreaterThan(4)
      total += defaultFiles.length
      const { files: effectiveFiles, raw } = effectiveSurfaceFiles(scan)
      const findings = discoveryFindings(scan.name, defaultFiles, effectiveFiles)
      expect(
        findings,
        `${scan.name}: 测试发现面对拍失败（配置收窄/放宽了发现面）\n${findings.join('\n')}\n`
        + `缺省发现面 ${String(defaultFiles.length)} 个文件、实际 ${String(effectiveFiles.length)} 个\n`
        + `\nvitest list 原始输出：\n${raw}`,
      ).toEqual([])
    }
    expect(total, `五个包的缺省发现面合计只有 ${String(total)} 个文件 —— 判据的扫描面塌了`).toBeGreaterThanOrEqual(200)
  })

  it('静态面同判：include / exclude / environment 必须"不声明或与缺省逐字一致"，否则必须有登记', () => {
    for (const scan of DISCOVERY_SCANS) {
      const properties = configTestProperties(scan.configPath)
      expect(properties.size, `${scan.name}: 读不到 vitest.config.ts 的 test 段（配置可能换了写法，判据要跟着改）`).toBeGreaterThan(0)
      const include = properties.get('include')
      if (include !== undefined) {
        const parsed = stringArrayLiteral(include)
        const sameAsDefault = parsed !== null && parsed.join('\n') === [...defaultInclude].join('\n')
        expect(
          sameAsDefault || DISCOVERY_NARROWING[scan.name] !== undefined,
          `${scan.name}: 配置声明了 include = ${include}，它既不等同于缺省 ${JSON.stringify([...defaultInclude])}，也没有登记 —— `
          + '声明 include 会把 tests/ 之外的测试文件静默排除（J2-N1 就是这么丢掉 connector.test.ts 的）。'
          + '要么删掉 include（只留预算），要么在 DISCOVERY_NARROWING 里登记丢失清单与理由。',
        ).toBe(true)
      }
      const exclude = properties.get('exclude')
      if (exclude !== undefined) {
        const parsed = stringArrayLiteral(exclude)
        expect(
          parsed !== null && parsed.join('\n') === [...defaultExclude].join('\n'),
          `${scan.name}: 配置声明了 exclude = ${exclude}，与缺省 ${JSON.stringify([...defaultExclude])} 不一致 —— 排除项同样要登记`,
        ).toBe(true)
      }
      const environment = properties.get('environment')
      if (environment !== undefined) {
        expect(environment, `${scan.name}: environment 只有等于缺省（'node'）才算"与缺省一致"`).toBe(`'${configDefaults.environment}'`)
      }
      const unexpected = [...properties.keys()].filter(key =>
        !NON_DISCOVERY_CONFIG_KEYS.has(key) && key !== 'include' && key !== 'exclude' && key !== 'environment')
      expect(
        unexpected,
        `${scan.name}: test 段出现未登记字段 ${unexpected.join('、')} —— 先判断它是否影响发现面，再决定登记还是放行`,
      ).toEqual([])
    }
  })

  it('豁免不许滥用：登记进 DISCOVERY_NARROWING 的文件必须是可证明的非 vitest 文件', () => {
    for (const [name, entry] of Object.entries(DISCOVERY_NARROWING)) {
      const scan = DISCOVERY_SCANS.find(candidate => candidate.name === name)
      expect(scan, `${name}: 登记了一个不在面内的包`).toBeDefined()
      expect(entry.reason.length, `${name}: 豁免必须写下理由（人话，不是"已知"两个字）`).toBeGreaterThan(20)
      for (const file of entry.files) {
        const full = join(scan!.pkgRoot, file)
        expect(statSync(full, { throwIfNoEntry: false })?.isFile() === true, `${name}: 登记豁免的 ${file} 不存在（陈旧的豁免）`).toBe(true)
        const source = readFileSync(full, 'utf8')
        expect(
          importsVitest(source),
          `${name}: ${file} 是**真的 vitest 用例**（正文 import 了 vitest）—— 不许把它登记成"配置收窄的豁免"，`
          + '那是把静默漏跑合法化。要么把配置改回缺省发现面，要么把文件放进 tests/。',
        ).toBe(false)
        expect(
          DEFAULT_TEST_FILE.test(file),
          `${name}: ${file} 根本不在缺省发现面里（登记它没有意义）`,
        ).toBe(true)
      }
    }
  })

  it('判据自身会咬：合成集合上"收窄未登记 / 更宽 / 登记对不上"三种都红，登记一致时绿', () => {
    const a = ['tests/a.spec.ts', 'src/b.test.ts']
    expect(discoveryFindings('browser', a, a), '两侧相同必须绿（判据不是"见到配置就红"）').toEqual([])
    const narrowed = discoveryFindings('browser', a, ['tests/a.spec.ts'])
    expect(narrowed.join('|'), '收窄且未登记必须红').toContain('没有登记')
    expect(narrowed.join('|'), '失败消息要点名丢掉的文件').toContain('src/b.test.ts')
    const widened = discoveryFindings('browser', ['tests/a.spec.ts'], a)
    expect(widened.join('|'), '比缺省更宽必须红').toContain('更宽')
    const mismatched = discoveryFindings('desktop', ['tests/a.spec.ts', 'scripts/x.spec.mjs'], ['tests/a.spec.ts'])
    expect(mismatched.join('|'), '登记与实际丢失对不上必须红').toContain('对不上')
    expect(discoveryFindings('desktop', ['tests/a.spec.ts', 'scripts/x.spec.mjs'], ['tests/a.spec.ts']).length).toBe(1)
  })
})


/* ------------------------------------------------------------------------- *
 * R11-B-03：形态面与误红面
 *
 * 审计实测（第十一轮，HEAD `3264137997`）：这条判据是"拼写枚举 + 双见证对账"，
 * **4 种绕法绿 / 3 种正当写法红**：
 *
 * | 例 | 写法 | 修复前 |
 * |---|---|---|
 * | B | `const v = vi; v.waitFor(…)` | 绿（只认 `vi` / `expect` 两个标识符文本） |
 * | C | `import { vitest } from 'vitest'; vitest.waitFor(…)` | 绿（命名空间拼写） |
 * | D | `tests/x.spec.mts` 里的裸 `vi.waitFor` | 绿（扫描面只有 `.ts` / `.tsx`） |
 * | E | `tests/helper.ts` 的 `export const w = vi.waitFor` + 别的文件 `w(…)` | 绿（别名表按文件建） |
 * | F | `{ timeout: WAIT_BUDGETS.X } satisfies Record<string, number>` | 红（options 不是对象字面量） |
 * | G | `const timeout = WAIT_BUDGETS.X; vi.waitFor(fn, { timeout })` | 红（简写属性不是 PropertyAssignment） |
 * | H | 理由注释与调用之间隔一行预算构造（`const budget = …`） | 红（注释位置 + 非字面引用） |
 *
 * 处置：B/C/D/E 四条**堵上**（含 fail-closed 的 taint：取值链提到 vitest 却解析不出
 * 形状的名字，其 `.waitFor(` / `.poll(` 一律按等待调用判），F/G/H 三条**纠正**（注释
 * 位置再放宽一档：挂在该次等待**消费的预算构造链**上同样算逐处可读）。判据不许因此
 * 变松：①"新加一个正当等待（引用集中表 + 紧邻理由注释）必须绿"；②每条修复都配
 * "改坏 ⇒ 判据必红"的变异（`temp/r11/fix-I3/`）。
 * ------------------------------------------------------------------------- */

describe('wait budget contract · 形态面（R11-B-03 的四条绕法）', () => {
  it('B：`const v = vi` 之后的 `v.waitFor(…)` 与 `vi.waitFor(…)` 同罪', () => {
    const renamed = [
      'const v = vi',
      'await v.waitFor(() => { expect(x).toBe(1) })',
      '',
    ].join('\n')
    const sites = findWaitForSites('self.ts', renamed)
    expect(sites.map(site => `${site.api}/${site.spelling}`), '对象改名必须被 AST 看见').toEqual(['vi.waitFor/alias'])
    expect(sites[0]?.timeout, '这种写法没有预算').toBeUndefined()
    const report = contractFindings([{ name: 'tests/probe.spec.ts', source: renamed }], 30_000)
    expect(report.budget.map(finding => finding.message).join('|'), '没给预算的对象改名必须判红').toContain('没有显式 timeout')
    // 链式（`const w = v.waitFor`）与 `expect` 命名空间同理。
    expect(findWaitForSites('self.ts', 'const v = vi\nconst w = v.waitFor\nawait w(() => {})\n').map(site => site.spelling)).toEqual(['alias'])
    expect(findWaitForSites('self.ts', 'const e = expect\nawait e.poll(() => 1)\n').map(site => site.api)).toEqual(['expect.poll'])
    // 反向：别的对象的同名方法仍然不受约束（判据不许把任何 `x.waitFor` 都当等待）。
    expect(findWaitForSites('self.ts', 'const s = server\nawait s.waitFor(() => {})\n')).toEqual([])
  })

  it('C：命名空间拼写（`import { vitest }` / `import * as ns`）也在面内', () => {
    const named = [
      "import { vitest } from 'vitest'",
      'await vitest.waitFor(() => { expect(x).toBe(1) })',
      '',
    ].join('\n')
    const sites = findWaitForSites('self.ts', named)
    expect(sites.map(site => `${site.api}/${site.spelling}`), '`vitest` 就是 `vi`（实测 vitest === vi），必须被看见')
      .toEqual(['vi.waitFor/alias'])
    const report = contractFindings([{ name: 'tests/probe.spec.ts', source: named }], 30_000)
    expect(report.budget.map(finding => finding.message).join('|')).toContain('没有显式 timeout')
    // 两个见证仍然一致：命名空间拼写在 needle 面外，因此必须归 alias（否则覆盖率对账会红）。
    expect(report.coverage, '命名空间拼写不得让覆盖率对账失配').toEqual([])
    // 模块命名空间：`ns.vi.waitFor` / `ns.vitest.waitFor` / `ns.expect.poll`。
    expect(findWaitForSites('self.ts', "import * as ns from 'vitest'\nawait ns.vi.waitFor(() => {})\n").map(site => site.api)).toEqual(['vi.waitFor'])
    expect(findWaitForSites('self.ts', "import * as ns from 'vitest'\nawait ns.expect.poll(() => 1)\n").map(site => site.api)).toEqual(['expect.poll'])
    // 别名导入（`vi as v`）与它的元素访问拼写：名字来自别名表，因此两个见证都按
    // `alias` 记（needle 只认字面量 `vi.waitFor(`）。
    expect(findWaitForSites('self.ts', "import { vi as v } from 'vitest'\nawait v['waitFor'](() => {})\n").map(site => site.spelling)).toEqual(['alias'])
  })

  it('D：`.mts` / `.cts` 里的等待同样在扫描面内（扩展名不再漏）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wait-scan-'))
    try {
      writeFileSync(join(dir, 'probe.spec.mts'), 'await vi.waitFor(() => { expect(x).toBe(1) })\n')
      writeFileSync(join(dir, 'other.spec.cts'), 'await vi.waitFor(() => { expect(y).toBe(1) })\n')
      const found = collectTestSources(dir).sort()
      expect(found, '.mts / .cts 必须在扫描面内（审计的 D 例就是 .spec.mts）').toEqual(['other.spec.cts', 'probe.spec.mts'])
      for (const name of found) {
        const source = readFileSync(join(dir, name), 'utf8')
        const report = contractFindings([{ name, source }], 30_000)
        expect(report.budget.map(finding => finding.message).join('|'), `${name} 里的裸等待必须判红`).toContain('没有显式 timeout')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('E：跨文件导出的等待 API（`export const w = vi.waitFor`）也解析得到', () => {
    const helper = {
      name: 'tests/helpers/wait-alias.ts',
      source: [
        "import { vi } from 'vitest'",
        'export const w = vi.waitFor',
        '',
      ].join('\n'),
    }
    const spec = {
      name: 'tests/case.spec.ts',
      source: [
        'import { w } from "./helpers/wait-alias.ts"',
        'await w(() => { expect(x).toBe(1) })',
        '',
      ].join('\n'),
    }
    const report = contractFindings([helper, spec], 30_000)
    expect(report.budget.map(finding => `$'${finding.file}':${finding.message}`).join('|'), '跨文件别名必须被穿透')
      .toContain('没有显式 timeout')
    expect(report.budget.some(finding => finding.file === 'tests/case.spec.ts')).toBe(true)
    // 反向：跨文件别名给了集中表预算 + 理由注释时必须绿（不许"见到导入就红"）。
    const budgeted = {
      name: 'tests/case.spec.ts',
      source: [
        'import { w } from "./helpers/wait-alias.ts"',
        "import { WAIT_BUDGETS } from '../wait-budgets.ts'",
        '// 现象：状态传播档。',
        'await w(() => { expect(x).toBe(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })',
        '',
      ].join('\n'),
    }
    expect(contractFindings([helper, budgeted], 30_000).budget).toEqual([])
  })

  it('fail-closed：取值链提到 vitest 却解析不出形状的名字，其等待调用仍必须给预算', () => {
    const opaque = [
      'const w = pick(vi.waitFor)',
      'await w(() => { expect(x).toBe(1) })',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: opaque }], 30_000).budget.length,
      '解析不出的等待取值必须 fail-closed（否则换个工厂函数就绕过契约）').toBeGreaterThan(0)
    const opaqueNamespace = [
      'const v = pick(vi)',
      'await v.waitFor(() => { expect(x).toBe(1) })',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: opaqueNamespace }], 30_000).budget.length,
      '解析不出的命名空间上的 waitFor 同样 fail-closed').toBeGreaterThan(0)
    // 反向：`vi.fn()` 这类常见用法不得被误判成等待（taint 分两类正是为此）。
    const mock = [
      'const emit = vi.fn()',
      'emit(1)',
      '// 现象：状态传播档。',
      'await vi.waitFor(() => {}, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: mock }], 30_000).budget, 'mock 的直接调用不是等待').toEqual([])
  })
})

describe('wait budget contract · 误红面（R11-B-03 的三条正当写法）', () => {
  it('F：`satisfies` 包装的 options 对象仍然是"给了预算"', () => {
    const source = [
      'it("probe", async () => {',
      '  // 现象：状态传播档。',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS } satisfies Record<string, number>)',
      '})',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', source)[0]?.timeout).toBe('WAIT_BUDGETS.STATE_PROPAGATION_MS')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source }], 30_000).budget, '正当写法不得被判红').toEqual([])
    // `as` 与括号包装同理。
    const asCast = source.replace('satisfies Record<string, number>', 'as Record<string, number>')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: asCast }], 30_000).budget).toEqual([])
    const parenthesized = source.replace('{ timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }', '({ timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: parenthesized }], 30_000).budget).toEqual([])
  })

  it('G：简写属性 `{ timeout }` 沿本地常量解析到集中表', () => {
    const source = [
      'it("probe", async () => {',
      '  const timeout = WAIT_BUDGETS.STATE_PROPAGATION_MS',
      '  // 现象：状态传播档。',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, { timeout })',
      '})',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', source)[0]?.timeout).toBe('WAIT_BUDGETS.STATE_PROPAGATION_MS')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source }], 30_000).budget, '简写属性是正当写法').toEqual([])
    // 反向：简写指向别的常量（不是集中表）仍然判红 —— 放宽的是形态，不是要求。
    const otherConstant = source.replace('const timeout = WAIT_BUDGETS.STATE_PROPAGATION_MS', 'const timeout = 5_000')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: otherConstant }], 30_000).budget.length).toBeGreaterThan(0)
  })

  it('H：整个 options 是本地常量、理由注释挂在预算构造链上，仍然算逐处可读', () => {
    const source = [
      'it("probe", async () => {',
      '  // 现象：真实 I/O 档（真实磁盘读写）。',
      '  const budget = { timeout: WAIT_BUDGETS.REAL_IO_MS }',
      '  await vi.waitFor(() => { expect(x).toBe(1) }, budget)',
      '})',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', source)[0]?.timeout, 'options 是本地常量时必须解析到它的对象字面量').toBe('WAIT_BUDGETS.REAL_IO_MS')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source }], 30_000).budget, '预算构造链上的注释必须被接受').toEqual([])
    // 反向：链上完全没注释时两条都红（注释位置放宽，不是取消要求）。
    const undocumented = source.replace('  // 现象：真实 I/O 档（真实磁盘读写）。\n', '')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source: undocumented }], 30_000).budget.length).toBeGreaterThan(0)
    // 反向：链上夹一条无关语句不算"上方"（否则"逐处可读"就没了）。
    const unrelated = [
      'it("probe", async () => {',
      '  // 现象：真实 I/O 档。',
      '  const unrelated = 1',
      '  await vi.waitFor(() => { expect(x).toBe(1) })',
      '})',
      '',
    ].join('\n')
    expect(findWaitForSites('self.ts', unrelated)[0]?.reasonComment).toBe(false)
  })

  it('新加一个正当等待（引用集中表 + 紧邻理由注释）必须绿', () => {
    const source = [
      'it("a brand new case", async () => {',
      '  // 现象：真实 I/O 档（清单落盘后状态机发布快照）。',
      '  await vi.waitFor(() => { expect(harness.published).toHaveLength(1) }, { timeout: WAIT_BUDGETS.REAL_IO_MS })',
      '  // 现象：状态传播档（轮询读取计数）。',
      '  await expect.poll(() => harness.count(), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe(1)',
      '})',
      '',
    ].join('\n')
    expect(contractFindings([{ name: 'tests/probe.spec.ts', source }], 30_000)).toEqual({
      budget: [], clock: [], coverage: [], caseBudget: [],
    })
  })
})

describe('desktop waitFor budget contract · 扫描面', () => {
  it('tests 根目录存在且是目录（否则上面的扫描会静默变成空集）', () => {
    expect(statSync(testsRoot).isDirectory()).toBe(true)
  })
})
