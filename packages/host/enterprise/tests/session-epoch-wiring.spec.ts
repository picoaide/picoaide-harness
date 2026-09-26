/**
 * 「会话代际守卫」的**接线判据**（第二十六轮审计 Z2-01，P1）。
 *
 * ## 为什么必须有这一层
 *
 * 行为判据（`bootstrap.spec.ts` / `error-reporting.spec.ts` / `gateway-model.spec.ts` /
 * `channel-sync.spec.ts` 里各自那两条"迟到响应不得落地"）证明的是**今天**这四个 sync
 * 都守住了。它挡不住本仓最典型的失效形态：**新增一个 sync 入口时忘了加守卫**
 * （Z2-01 本身就是"同一根因只收口了一条路径"的产物：`bootstrap.ts` 的错误分支在
 * R22-V1-N3 已经写对了推理，成功路径却原样留了三个未守卫的写入）。
 *
 * 所以这里按**源码形状**钉四条，全部是"漏了就红"：
 *
 *  A. 每个 sync 里**每个 `await` 之后**都必须紧跟一次代际比对
 *     （`if (!<guard>.isCurrent(<epoch>)) return`）—— 唯一豁免是"该 await 就是所在
 *     block 的最后一条语句"（后面已没有可落地的副作用）；
 *  B. **每一个会话入口**（`subscribeSession(ctx, cb)` / `ctx.on(SESSION_CHANGED_EVENT, cb)`）
 *     都必须抵达一个被守卫的函数；
 *  C. **每个 `await` 都必须住在被守卫的函数里** —— 新增的未守卫 sync 入口因此当场变红；
 *     豁免必须显式登记（`AWAIT_EXEMPTIONS`，且登记项陈旧也红）；
 *  D. 被 await 的 `initSentry` 必须收到**第 5 个实参**（代际谓词）：它在自己的 await
 *     之后改模块级 `sentry`/`status`，只在调用点外面补一句比对拦不住。
 *
 * 判据自身有**自检**（`analyze()` 对合成源码的判定），避免"分析器恒真"这类假绿。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../src')

/** 被本判据覆盖的四个"会话派生投影"实现文件（唯一真源：这四条 sync）。 */
const GUARDED_FILES = ['bootstrap.ts', 'error-reporting.ts', 'gateway-model.ts', 'channel-sync.ts'] as const

/**
 * `await` **允许**住在未守卫函数里的白名单（键 = `文件#函数名`）。
 *
 * 每一条都要写清"它的 await 之后会不会改状态、由谁保证"—— 登记项必须真的存在且真的
 * 含 await（陈旧登记会让白名单慢慢变成免检区，见 `it('豁免表不得陈旧')`）。
 */
const AWAIT_EXEMPTIONS: Readonly<Record<string, string>> = {
  'error-reporting.ts#initSentry':
    '内部 await（close 冲刷/关闭空 client）之后确实会改模块级 sentry/status ⇒ 由调用方传入第 5 个实参（代际谓词）守卫，见判据 D。',
  'error-reporting.ts#reportErrorReportingStatus':
    '状态回传的 POST（尽力而为）。调用点全部在 sync 内、且都在 `if (!epochs.isCurrent(epoch)) return` 之后；它自己的 await 之后只动"已报键"集合（带去重身份，不投影到当前会话）。',
}

/** 一条判据违规。 */
interface Finding {
  readonly kind:
    | 'await-without-check'
    | 'await-outside-guard'
    | 'entry-not-guarded'
    | 'initSentry-without-predicate'
  readonly detail: string
}

/** 取一个节点的单行摘要（用于断言/报告可定位）。 */
function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `L${line + 1}: ${node.getText(source).replace(/\s+/gu, ' ').slice(0, 90)}`
}

/** 收集 `X.begin()` 里的接收者名（一代际守卫 = 一个接收者）。 */
function guardReceivers(fn: ts.FunctionLikeDeclaration): Set<string> {
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    // 不进嵌套函数：守卫必须由本函数自己取（`apply()` 里那个不属于 `sync`）。
    if (node !== fn && ts.isFunctionLike(node)) return
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'begin'
    ) {
      found.add(node.expression.expression.getText())
    }
    ts.forEachChild(node, visit)
  }
  if (fn.body !== undefined) visit(fn.body)
  return found
}

/** `if (!<guard>.isCurrent(...)) return` 形状的判定。 */
function guardCheckOf(statement: ts.Statement, guards: ReadonlySet<string>): string | undefined {
  if (!ts.isIfStatement(statement)) return undefined
  const condition = statement.expression
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return undefined
  const call = condition.operand
  if (!ts.isCallExpression(call)) return undefined
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'isCurrent') return undefined
  const receiver = callee.expression.getText()
  if (!guards.has(receiver)) return undefined
  const then = statement.thenStatement
  const isReturn = ts.isReturnStatement(then)
    || (ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]!))
  return isReturn ? receiver : undefined
}

/** await 所在的、直接挂在 Block 下的那条语句。 */
function enclosingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (ts.isStatement(current) && current.parent !== undefined && ts.isBlock(current.parent)) return current
    current = current.parent
  }
  return undefined
}

/** 最近的外层函数（含箭头函数）。 */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

/** 收集 `subscribeSession(ctx, cb)` / `ctx.on(SESSION_CHANGED_EVENT, cb)` 的回调。 */
function sessionEntries(source: ts.SourceFile): ts.Expression[] {
  const entries: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === 'subscribeSession' && node.arguments.length >= 2) {
        entries.push(node.arguments[1]!)
      }
      if (
        ts.isPropertyAccessExpression(callee)
        && callee.name.text === 'on'
        && node.arguments[0] !== undefined
        && node.arguments[0].getText().includes('SESSION_CHANGED_EVENT')
        && node.arguments.length >= 2
      ) {
        entries.push(node.arguments[1]!)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return entries
}

/** 文件里所有"函数名 → 节点"（`function f()` 与 `const f = … =>` 两种写法）。 */
function namedFunctions(source: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration> {
  const map = new Map<string, ts.FunctionLikeDeclaration>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) map.set(node.name.text, node)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isFunctionLike(node.initializer)) {
      map.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return map
}

/**
 * 对一个源文件跑完 A–D 四条判据。
 * @param text - 源码正文。
 * @param fileName - 文件名（用于豁免表键与定位）。
 * @param exemptions - AWAIT 白名单。
 * @returns 违规清单（空 = 全部通过）。
 */
function analyze(
  text: string,
  fileName: string,
  exemptions: Readonly<Record<string, string>> = AWAIT_EXEMPTIONS,
): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const findings: Finding[] = []
  const guardsByFunction = new Map<ts.FunctionLikeDeclaration, Set<string>>()
  const functionName = new Map<ts.FunctionLikeDeclaration, string>()
  for (const [name, fn] of namedFunctions(source)) {
    guardsByFunction.set(fn, guardReceivers(fn))
    functionName.set(fn, name)
  }
  // A/C/D：逐个 await 判。
  const visitAwait = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const fn = enclosingFunction(node)
      const guards = fn === undefined ? new Set<string>() : guardsByFunction.get(fn) ?? guardReceivers(fn)
      const label = `${fileName}#${fn === undefined ? '<top>' : functionName.get(fn) ?? '<anonymous>'}`

      // C：await 必须住在被守卫的函数里（除非显式豁免）。
      if (guards.size === 0) {
        if (exemptions[label] === undefined) {
          findings.push({
            kind: 'await-outside-guard',
            detail: `${label} 里的 await 没有代际守卫：${where(source, node)}`,
          })
        }
        ts.forEachChild(node, visitAwait)
        return
      }

      // A：await 之后必须紧跟一次比对（豁免"其后只剩终止语句"：后面已没有可落地的副作用）。
      const statement = enclosingStatement(node)
      if (statement === undefined || !ts.isBlock(statement.parent)) {
        findings.push({ kind: 'await-without-check', detail: `${label} 的 await 不在 block 里，无法判定后继比对：${where(source, node)}` })
      } else {
        const block = statement.parent
        const index = block.statements.indexOf(statement)
        const rest = block.statements.slice(index + 1)
        // 终止语句（裸 return / break / continue）之后没有任何会落地的副作用 ⇒ 无需比对。
        const terminalOnly = rest.every((s) =>
          (ts.isReturnStatement(s) && s.expression === undefined)
          || ts.isBreakStatement(s)
          || ts.isContinueStatement(s))
        const next = rest[0]
        if (!terminalOnly && next !== undefined && guardCheckOf(next, guards) === undefined) {
          findings.push({
            kind: 'await-without-check',
            detail: `${label} 的 await 之后没有代际比对：${where(source, node)} → 下一条是 ${where(source, next)}`,
          })
        }
      }
    }
    ts.forEachChild(node, visitAwait)
  }
  visitAwait(source)

  // B：每个会话入口都要抵达一个被守卫的函数。
  const named = namedFunctions(source)
  for (const entry of sessionEntries(source)) {
    const referenced: string[] = []
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== entry) return
      if (ts.isIdentifier(node)) referenced.push(node.text)
      ts.forEachChild(node, collect)
    }
    collect(entry)
    const reachable = referenced
      .map((name) => named.get(name))
      .filter((fn): fn is ts.FunctionLikeDeclaration => fn !== undefined)
    const entryHasAwait = ((): boolean => {
      let found = false
      const scan = (node: ts.Node): void => {
        if (ts.isAwaitExpression(node)) found = true
        ts.forEachChild(node, scan)
      }
      scan(entry)
      return found
    })()
    if (entryHasAwait && (ts.isFunctionLike(entry) ? guardReceivers(entry as ts.FunctionLikeDeclaration).size : 0) === 0) {
      // 入口自己就是 async 且没取代际 ⇒ 红（新写法必须自己守卫）。
      findings.push({ kind: 'entry-not-guarded', detail: `${fileName} 的会话入口自己含 await 却没有代际守卫：${where(source, entry)}` })
    }
    if (reachable.length === 0 || !reachable.some((fn) => (guardsByFunction.get(fn) ?? guardReceivers(fn)).size > 0)) {
      findings.push({
        kind: 'entry-not-guarded',
        detail: `${fileName} 的会话入口没有抵达任何被守卫的函数：${where(source, entry)}`,
      })
    }
  }

  // D：initSentry 必须收到代际谓词（第 5 个实参）。
  const visitInit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'initSentry') {
      const fn = enclosingFunction(node)
      const guards = fn === undefined ? new Set<string>() : guardsByFunction.get(fn) ?? guardReceivers(fn)
      if (guards.size > 0) {
        const fifth = node.arguments[4]
        if (fifth === undefined || !fifth.getText().includes('.isCurrent(')) {
          findings.push({
            kind: 'initSentry-without-predicate',
            detail: `${fileName} 的 initSentry 缺第 5 个实参（代际谓词）：${where(source, node)}`,
          })
        }
      }
    }
    ts.forEachChild(node, visitInit)
  }
  visitInit(source)

  return findings
}

describe('接线判据：四个 sync 的代际守卫（AST）', () => {
  for (const file of GUARDED_FILES) {
    it(`${file}：每个 await 之后都有比对、入口都被守卫、initSentry 收到谓词`, () => {
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      expect(analyze(text, file), `${file} 的代际守卫接线不完整`).toEqual([])
    })
  }

  it('豁免表不得陈旧（登记的函数必须真的存在、真的含 await，并写明理由）', () => {
    for (const [key, reason] of Object.entries(AWAIT_EXEMPTIONS)) {
      const [file, fnName] = key.split('#') as [string, string]
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const fn = namedFunctions(source).get(fnName)
      expect(fn, `豁免表里的 ${key} 已经不存在了（陈旧登记 = 免检区）`).toBeDefined()
      let hasAwait = false
      const scan = (node: ts.Node): void => {
        if (node !== fn && ts.isFunctionLike(node)) return
        if (ts.isAwaitExpression(node)) hasAwait = true
        ts.forEachChild(node, scan)
      }
      scan(fn!)
      expect(hasAwait, `豁免表里的 ${key} 已经没有 await 了`).toBe(true)
      expect(reason.length, `${key} 必须写明豁免理由`).toBeGreaterThan(20)
    }
  })

  it('判据自检：未守卫的 await / 未守卫的新入口 / 漏传谓词都能被抓到', () => {
    const base = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const x = await load(s)
        doWrite(x)
      }
      subscribeSession(ctx, (s) => { void sync(s) })
    `
    // ① await 之后没有比对 ⇒ await-without-check。
    expect(analyze(base, 'synthetic.ts').map((f) => f.kind)).toContain('await-without-check')

    // ② 未守卫的新 sync 入口 ⇒ await-outside-guard（C 条）。
    const unguardedEntry = `
      const sync2 = async (s) => { const x = await load(s); doWrite(x) }
      subscribeSession(ctx, (s) => { void sync2(s) })
    `
    const findings2 = analyze(unguardedEntry, 'synthetic.ts').map((f) => f.kind)
    expect(findings2).toContain('await-outside-guard')
    expect(findings2).toContain('entry-not-guarded')

    // ③ initSentry 漏传谓词 ⇒ initSentry-without-predicate。
    const missingPredicate = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const cfg = await load(s)
        if (!epochs.isCurrent(epoch)) return
        await initSentry(cfg.dsn, 'r1')
      }
      subscribeSession(ctx, (s) => { void sync(s) })
    `
    expect(analyze(missingPredicate, 'synthetic.ts').map((f) => f.kind)).toContain('initSentry-without-predicate')

    // ④ 完整形状（含谓词、含比对）⇒ 零违规（正面自检：分析器不是恒红）。
    const sound = `
      const epochs = createSessionEpoch()
      const sync = async (s) => {
        const epoch = epochs.begin()
        const cfg = await load(s)
        if (!epochs.isCurrent(epoch)) return
        await initSentry(cfg.dsn, 'r1', 'error', false, () => epochs.isCurrent(epoch))
      }
      subscribeSession(ctx, (s) => { void sync(s) })
    `
    expect(analyze(sound, 'synthetic.ts')).toEqual([])
  })
})
