/**
 * B-02（2026-09-23 独立审计 P1）：致命启动失败必须有**用户可见出口**。
 *
 * 缺陷形态：`main.ts` 的致命 `catch` 只 `errorCause` + `exit 1`，而
 * `startup-rows.ts` 的模块注释**自称**会弹恢复对话框 —— 注释与实现不一致。
 * 打包 GUI 上（Windows 双击 / macOS 启动台）没有 stderr 接收方、也没有窗口，
 * "必要行没激活 / 数据根不可写 / YAML 解析失败"全都表现为双击之后什么都没有。
 *
 * 判据分两层：
 *  1. **行为**：对话框选项（三个出口的返回值语义）、打开日志后重新询问、
 *     原生面不可用时的兜底与"绝不抛穿"；
 *  2. **接线**：`main.ts` 的 catch 真的调用它（并且顺序在退出之前），
 *     `startup-rows.ts` 的注释点向真实实现（注释与实现必须一致）。
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  fatalBootDialogOptions,
  fatalBootIdentity,
  reportFatalBootFailure,
  type FatalBootDialogCopy,
  type FatalBootSurface,
} from '../src/fatal-boot.ts'

const COPY: FatalBootDialogCopy = {
  title: 'Example Harness 无法启动',
  message: 'Example Harness 启动失败，已关闭。',
  detail: 'boom\n\n日志目录：/tmp/example/logs',
  openLogs: '打开日志',
  retry: '重试',
  quit: '退出',
}

interface Surface {
  showMessageBoxSync: ReturnType<typeof vi.fn>
  showErrorBox: ReturnType<typeof vi.fn>
  openPath: ReturnType<typeof vi.fn>
}

function surface(responses: readonly number[]): Surface {
  const queue = [...responses]
  return {
    showMessageBoxSync: vi.fn(() => queue.shift() ?? 2),
    showErrorBox: vi.fn(),
    openPath: vi.fn(async () => ''),
  }
}

describe('致命启动错误面（B-02）', () => {
  it('按钮顺序即返回值语义：打开日志 / 重试 / 退出', () => {
    const options = fatalBootDialogOptions(COPY)
    expect(options.type).toBe('error')
    expect(options.buttons).toEqual(['打开日志', '重试', '退出'])
    // 默认 = 打开日志（致命失败的第一动作是取证）；Esc/关窗 = 退出（不是"重试"：
    // 用户没改任何东西之前重试只会再失败一次）。
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(2)
    expect(options.detail).toContain('/tmp/example/logs')
  })

  it('选「重试」返回 retry，且不再打开日志', async () => {
    const ui = surface([1])
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs' })).resolves.toBe('retry')
    expect(ui.showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(ui.openPath).not.toHaveBeenCalled()
  })

  it('选「退出」（或关窗）返回 quit', async () => {
    const ui = surface([2])
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs' })).resolves.toBe('quit')
    expect(ui.openPath).not.toHaveBeenCalled()
  })

  it('选「打开日志」→ 打开目录后重新询问；日志打不开也要继续问', async () => {
    const ui = surface([0, 1])
    ui.openPath.mockResolvedValueOnce('ENOENT')
    const log = vi.fn()
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs', log }))
      .resolves.toBe('retry')
    expect(ui.openPath).toHaveBeenCalledWith('/tmp/example/logs')
    expect(ui.showMessageBoxSync).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not open the log directory'))
  })

  it('原生对话框不可用时退回 showErrorBox，仍然让用户看到（绝不静默）', async () => {
    const ui = surface([1])
    ui.showMessageBoxSync.mockImplementation(() => { throw new Error('no display') })
    const log = vi.fn()
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs', log })).resolves.toBe('quit')
    expect(ui.showErrorBox).toHaveBeenCalledWith(COPY.title, expect.stringContaining('boom'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fatal startup dialog unavailable'))
  })

  it('两个原生面都不可用时也不抛穿（只记录），由调用方以非零码退出', async () => {
    const ui = surface([1])
    ui.showMessageBoxSync.mockImplementation(() => { throw new Error('no display') })
    ui.showErrorBox.mockImplementation(() => { throw new Error('no window server') })
    const log = vi.fn()
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs', log })).resolves.toBe('quit')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fatal startup error box unavailable'))
  })
})

describe('main.ts / startup-rows.ts 的接线与注释一致性（B-02）', () => {
  const mainSource = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')
  const rowsSource = readFileSync(fileURLToPath(new URL('../src/startup-rows.ts', import.meta.url)), 'utf8')

  /** 致命 catch 块（`errorCause` 那一个）的源码片段。 */
  function fatalCatch(): string {
    const at = mainSource.indexOf('electronLogger.errorCause(cause)')
    expect(at, 'main.ts 必须保留致命路径的 errorCause').toBeGreaterThan(-1)
    return mainSource.slice(at, at + 1_500)
  }

  it('致命 catch 真的调用原生错误面，且顺序在退出之前', () => {
    const block = fatalCatch()
    // 锚在真实调用语句上（注释里也提到了 `shutdown.request(1)`，不能用裸子串）。
    const dialogAt = block.indexOf('\n    const action = await reportFatalStartupFailure(')
    const exitAt = block.indexOf('\n    await shutdown.request(')
    expect(dialogAt, '致命路径必须调用 reportFatalStartupFailure（否则用户什么都看不到）').toBeGreaterThan(-1)
    expect(exitAt, '致命路径必须仍然以显式退出收尾').toBeGreaterThan(-1)
    expect(exitAt, '弹窗必须在退出之前').toBeGreaterThan(dialogAt)
  })

  it('接的是真的 Electron 原生面（不是空实现）', () => {
    // 三个出口依赖的原生能力：富对话框、兜底错误框、打开日志目录。
    for (const needle of ['dialog.showMessageBoxSync(', 'dialog.showErrorBox(', 'shell.openPath(']) {
      expect(mainSource, `main.ts 必须接线 ${needle}`).toContain(needle)
    }
    expect(mainSource).toContain("from './fatal-boot.ts'")
    // 重试必须走既有的 relaunch 通道（code 0 才真重启，见 shutdown.ts）。
    expect(fatalCatch()).toContain('requestRelaunch()')
  })

  it('详情里的日志目录与日志系统同源（<userData>/logs）', () => {
    expect(mainSource).toContain("join(app.getPath('userData'), 'logs')")
    // 详情先过掩码：原生弹窗是渠道客户可见面，不能比日志更"诚实"。
    expect(mainSource).toContain('maskSecrets(')
  })

  it('startup-rows 的注释与实现一致（指名真实实现文件）', () => {
    expect(rowsSource).toContain('fatal-boot.ts')
    expect(rowsSource).toContain('reportFatalStartupFailure')
  })
})

/**
 * C1-02（2026-10-04）：致命路径必须在 **runtime 还没就位**的窗口里也能工作。
 *
 * ## 真值核对（本条修复前）
 *
 * 审计原文给的可达链路是"构造器抛错 ⇒ 落到致命 catch 时 `runtime === undefined`
 * ⇒ `runtime.locale` 抛 TypeError"。逐行核对源码后**更严重**：`start()` 里那个
 * `try`（当时从 `loadLayeredEnv` 才开始）**根本没罩住**构造器、`registerAppScheme`、
 * `app.whenReady()`、`applyInstallDshHome` —— 这些语句在 try **之外**，失败会直接逸出
 * `start()`，被 `void run()` 吞成 unhandled rejection：既没有原生错误面，也没有受控
 * 退出码，用户看到的仍然是"双击之后什么都没有"（B-02 要消灭的形态；`applyInstallDshHome`
 * 上方那句"the surrounding try/catch logs it and exits 1"的注释当时也是不成立的）。
 *
 * 所以修复有两半，判据也有两半：
 *  1. **行为**：`fatalBootIdentity(undefined, …)` 不得抛错并回落产品常量（下面第一组）。
 *     这是"窗口内不 TypeError"这条性质本身，可被变异打坏。
 *  2. **接线**（AST，注释不是语法节点）：构造器必须落在"其 catch 走致命路径"的那个
 *     `try` 里；致命调用传的必须是**类型上含 undefined 的那个视图**；退出协调器的
 *     `prepareToQuit` 必须走可选访问；`nativeExit`/`shutdown` 必须在 try **之前**就位
 *     （否则 catch 里的 `await shutdown.request(...)` 又会在窗口内炸）。这三条是
 *     "行为层抓不到"的部分（main.ts 依赖 electron，单测挂不起来），如实标注为
 *     源码级接线判据 —— 但每一条都有实测变异（见 fixes/C1-P2-batch.md）。
 *
 * ## 2026-10-04 验证方加固（两个实测可打穿的边界，见 verify/C1-P2-batch.md §3.2）
 *
 * 第一版接线判据是**点名式**的，验证方实跑证明它有两个边界，两处都补成结构性判据：
 *  1. **判据只钉了三个名字**（构造器 / `registerAppScheme` / `applyInstallDshHome`）
 *     ⇒ 把一个**未点名**的引导成员移出致命 try（变异 #4：`installDesktopChildProcessLogging`）
 *     可以让 `fatal-boot.spec.ts` 15/15 全绿，而缺陷类（该成员抛错时逸出 `start()`）
 *     原样回归。现在改判**结构**：`start()` 里**任何深度**的语句都必须落在致命 try 的
 *     源码区间内，或者在 `FATAL_WINDOW_WHITELIST` 里**逐条登记**（每条带理由）；
 *     另有 `FATAL_WINDOW_MEMBERS` 按成员粒度断言调用点，连"把成员塞进另一段自带
 *     try/catch 的降级块"也算逃逸。
 *  2. **"类型含 undefined"是"同名声明有没有"，不是"实参解析到哪个绑定"**
 *     ⇒ 传回定值视图 + 死代码里加一句同名 decoy 声明即可满足（变异 #5：15/15 全绿）。
 *     现在改用 `ts.createProgram` 的**绑定解析**（`getSymbolAtLocation`），并要求那个
 *     绑定在声明处就是 `undefined`（"还没就位"的行为证据）、且与退出前的
 *     `?.prepareToQuit()` 是同一个绑定。
 */
describe('致命窗口：runtime 未就位时的身份取值（C1-02，行为）', () => {
  const fallback = { locale: 'zh' as const, productName: 'Example Harness' }

  it('runtime 缺席时回落到产品常量，绝不抛 TypeError', () => {
    // 窗口内（构造器抛错、协议注册失败、whenReady 失败…）runtime 还不存在；
    // 变异：把 fatal-boot.ts 的 `runtime?.locale ?? fallback.locale` 改回
    // `runtime.locale` ⇒ 本用例抛 TypeError ⇒ 红。
    expect(fatalBootIdentity(undefined, fallback)).toEqual(fallback)
  })

  it('runtime 就位时用运行期值（不是恒回落）', () => {
    expect(fatalBootIdentity({ locale: 'en' as const, productName: 'Acme Harness' }, fallback))
      .toEqual({ locale: 'en', productName: 'Acme Harness' })
  })
})

describe('致命窗口：main.ts 的接线（C1-02，AST）', () => {
  const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  const text = readFileSync(mainPath, 'utf8')
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.ESNext, true)

  /** 致命 catch 里那次 `reportFatalStartupFailure(...)` 调用。 */
  function fatalCall(): ts.CallExpression {
    let found: ts.CallExpression | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'reportFatalStartupFailure') {
        found = node
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(found, 'main.ts 必须调用 reportFatalStartupFailure').toBeDefined()
    return found as ts.CallExpression
  }

  /** 包住该调用的最近一个 `try` 语句。 */
  function enclosingTry(call: ts.CallExpression): ts.TryStatement {
    let node: ts.Node | undefined = call
    while (node !== undefined) {
      if (ts.isTryStatement(node) && node.catchClause !== undefined
        && call.getStart(source) >= node.catchClause.getStart(source)) {
        return node
      }
      node = node.parent
    }
    throw new Error('fatal call is not inside a try/catch')
  }

  /** `async function start()` 的函数体（窗口语句都在这一个函数里）。 */
  function startFunction(): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'start') { found = node; return }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(found, 'main.ts 必须保留 start()').toBeDefined()
    return found as ts.FunctionDeclaration
  }

  /**
   * 单文件 Program + 类型检查器（2026-10-04 验证方加固）。
   *
   * 判据要回答的是"实参**解析到哪个绑定**"，而不是"文件里有没有同名声明"：旧判据在 AST 上
   * 找同名的 `VariableDeclaration` 再断言类型串里有 `undefined`，被验证方用**死代码里的
   * 同名 decoy 声明**满足了（变异 #5）。这里让 tsc 自己做绑定解析 —— decoy 在别的行、
   * 别的块都不会改变 `getSymbolAtLocation` 的答案。
   *
   * 只把 main.ts 一个文件喂进 Program（`noResolve`）：局部变量绑定不需要依赖与 lib，
   * 所以这条判据也不依赖能否解析 `electron` 等外部模块（纯 Node 下解析不了，见模块头）。
   */
  const checker: ts.TypeChecker = (() => {
    const host: ts.CompilerHost = {
      getSourceFile: name => (name === mainPath ? source : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => dirname(mainPath),
      getCanonicalFileName: file => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: file => file === mainPath,
      readFile: file => (file === mainPath ? text : undefined),
    }
    return ts.createProgram([mainPath], { noResolve: true, target: ts.ScriptTarget.ESNext }, host).getTypeChecker()
  })()

  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  /** 语句的首行（失败信息里点到具体形态，而不是只报行号）。 */
  const oneLine = (node: ts.Node): string => node.getText().split('\n')[0]?.trim() ?? ''

  /** 该节点（含嵌套）里是否调用了/构造了 `callee`（按被调用者的源码文本比对）。 */
  const callsNamed = (node: ts.Node, callee: string): boolean => {
    let hit = false
    const visit = (child: ts.Node): void => {
      if (hit) return
      if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
        if (child.expression.getText() === callee) {
          hit = true
          return
        }
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    return hit
  }

  /** 该语句里 `const x = …` / `let x` 的声明节点。 */
  const declarationNamed = (statement: ts.Statement, name: string): ts.VariableDeclaration | undefined =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.find(
        declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      )
      : undefined

  /** 表达式里是否出现该标识符（排除属性名与声明名位置，避免把 `x.error()`/`const x` 算进来）。 */
  const referencesNamed = (node: ts.Node, name: string): boolean => {
    let hit = false
    const visit = (child: ts.Node): void => {
      if (hit) return
      if (ts.isIdentifier(child) && child.text === name
        && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)
        && !(ts.isVariableDeclaration(child.parent) && child.parent.name === child)) {
        hit = true
        return
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    return hit
  }

  interface GuardedSegment {
    /** 稳定 id（失败信息里点名，便于评审这份白名单本身）。 */
    readonly id: string
    /** 为什么它可以不在致命窗口里（必须能被 reviewer 独立复核，不是"历史如此"）。 */
    readonly reason: string
    readonly matches: (statement: ts.Statement) => boolean
  }

  /**
   * 允许留在致命窗口**之外**的形态。每条都必须给出理由 —— 这是 C1-02 那半修复的判据面：
   * 引导段里"任何一条可能抛错的语句"都不许在窗口外，除非它在下面逐条登记过。
   *
   * 白名单不能变成橡皮图章：`致命窗口：main.ts 的接线` 那一组里有三条自检 —— 未登记语句
   * 一律判红、条目必须是"真的兜住了窗口外的语句"（死条目判红）、以及一条负控（白名单
   * 不许匹配"把引导成员移出 try"的形态）。
   */
  const FATAL_WINDOW_WHITELIST: readonly GuardedSegment[] = [
    {
      id: 'single-instance-guard',
      reason: '单实例锁是"要不要启动"的第一判断，必须早于任何装配（拿到锁之前不能有副作用）；'
        + '命中即 app.quit() + return，没有任何半装配状态需要收尾。',
      matches: statement => ts.isIfStatement(statement)
        && callsNamed(statement.expression, 'app.requestSingleInstanceLock'),
    },
    {
      id: 'fatal-window-bindings',
      reason: '无初始化器的纯绑定声明（current/shutdown/runtime/mountedRuntime/logSink/desktopRun/remove*）：'
        + '声明语句本身不执行任何代码、抛不出来；且致命 catch 里的语句必须能看见它们。',
      matches: statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.every(declaration => declaration.initializer === undefined),
    },
    {
      id: 'file-logging-segment',
      reason: '自带 try/catch 的降级段：日志不可写时只把原因写到 stderr 并把 logSink 置回 undefined'
        + '（不阻断启动、也不逸出 start()）。',
      matches: statement => ts.isTryStatement(statement) && statement.catchClause !== undefined
        && callsNamed(statement, 'LogFileSink'),
    },
    {
      id: 'crash-reporting-segment',
      reason: '自带 try/catch 的降级段：本地崩溃上报不可用时只记一行 stderr（同类降级）。',
      matches: statement => ts.isTryStatement(statement) && statement.catchClause !== undefined
        && callsNamed(statement, 'startDesktopCrashReporting'),
    },
    {
      id: 'active-run-tracking-segment',
      reason: '自带 try/catch 的降级段：active-run 标记不可用时只记一行 stderr（同类降级）。',
      matches: statement => ts.isTryStatement(statement) && statement.catchClause !== undefined
        && callsNamed(statement, 'beginDesktopRun'),
    },
    {
      id: 'electron-logger-construction',
      reason: '构造器只保存 sink 引用（desktop-logger.ts:76，无 I/O、无 Electron 调用）；'
        + '且必须在致命 try 之前 —— catch 里的 errorCause 要用它。',
      matches: statement => declarationNamed(statement, 'electronLogger') !== undefined
        && callsNamed(statement, 'ElectronStderrLogger'),
    },
    {
      id: 'debug-switch-escape-value',
      reason: '纯函数：入参是模块作用域常量 DEBUG_SWITCH_GATE，无 I/O、无 Electron 调用。',
      matches: statement => declarationNamed(statement, 'debugSwitchEscape') !== undefined
        && callsNamed(statement, 'debugSwitchEscapeLogLine'),
    },
    {
      id: 'debug-switch-escape-warning',
      reason: '靠逃生门启动时必须在日志里留痕：一次 stderr 写'
        + '（ElectronStderrLogger.error 自己 try 住 sink 写，stderr 是启动期唯一诊断出口）。',
      matches: statement => ts.isIfStatement(statement)
        && referencesNamed(statement.expression, 'debugSwitchEscape')
        && callsNamed(statement, 'electronLogger.error'),
    },
    {
      id: 'exit-coordinator',
      reason: '纯对象构造（shutdown.ts:36-52：没有 I/O、不碰 runtime），且必须在致命 try **之前** ——'
        + 'catch 里的 nativeExit.requestRelaunch() 要靠它。',
      matches: statement => declarationNamed(statement, 'nativeExit') !== undefined
        && callsNamed(statement, 'createDesktopExitCoordinator'),
    },
    {
      id: 'exit-code-closure',
      reason: '箭头函数表达式：定义时不执行任何代码（真正的调用点在关停协调器的回调里），'
        + '因此构造它这一步不可能抛错。',
      matches: statement => {
        const declaration = declarationNamed(statement, 'finalExit')
        if (declaration?.initializer === undefined) return false
        return ts.isArrowFunction(declaration.initializer)
      },
    },
    {
      id: 'shutdown-coordinator',
      reason: '纯对象构造（shutdown.ts:61-92，同 exit-coordinator），且必须在致命 try **之前** ——'
        + 'catch 里的 await shutdown.request(...) 要靠它。',
      matches: statement => {
        if (!ts.isExpressionStatement(statement)) return false
        const expression = statement.expression
        return ts.isBinaryExpression(expression)
          && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(expression.left) && expression.left.text === 'shutdown'
          && callsNamed(expression.right, 'createDesktopShutdown')
      },
    },
  ]

  /**
   * 必须在致命窗口**内**的引导成员（按被调用者的源码文本登记）。
   *
   * 为什么在"语句区间"判据之外还要一条成员粒度的：语句判据看的是"这条语句在不在窗口里"，
   * 而把成员塞进**另一段自带 try/catch 的降级块**（它的整棵子树由那条白名单条目兜住）时，
   * 语句判据看不见 —— 但那个成员抛错时仍然走不到致命出口。名单里每个调用点都必须在窗口内，
   * 且名单不许有死条目（成员改名/搬走 ⇒ 判红，逼作者同步这份契约）。
   *
   * 注意两个**相反**的成员：`createDesktopExitCoordinator` / `createDesktopShutdown` 必须留在
   * 窗口之外（catch 要用它们），由白名单条目与"在 try 之前就位"那条判据守着。
   */
  const FATAL_WINDOW_MEMBERS: readonly string[] = [
    // 审计 C1-02 逐条点名过的引导段成员。
    'installDesktopChildProcessLogging',
    'registerAppScheme',
    'ElectronDesktopRuntime',
    'installDesktopUncaughtExceptionLogging',
    'installShutdownRequests',
    'app.whenReady',
    'resolveDesktopShellEnvironment',
    'applyInstallDshHome',
    // 同族的装配步骤：任一失败都会留下半装配的桌面壳，必须在同一个致命出口里。
    'loadLayeredEnv',
    'enforceDirectTransport',
    'prepareDesktopProfile',
    'installProfilePackageResolver',
    'installAsarSpawnRewrite',
    'boot',
    'assertRequiredRowsActive',
    'assertRequiredClientEntries',
    'installFailLoud',
    'runtime.mountScheduled',
  ]

  it('构造 runtime 的语句落在这个 try 里（窗口外的失败会逸出 start()）', () => {
    const guarded = enclosingTry(fatalCall())
    const range: [number, number] = [guarded.tryBlock.getStart(source), guarded.tryBlock.getEnd()]
    // 只在 `start()` 里取值：`run()` 的 `--export-diagnostics` 早退分支也有一次
    // `applyInstallDshHome`，它不在这条致命路径上（那是另一条出口，自带 try/catch）。
    const inStart = (predicate: (node: ts.Node) => boolean): number[] => {
      const positions: number[] = []
      const visit = (node: ts.Node): void => {
        if (predicate(node)) positions.push(node.getStart(source))
        ts.forEachChild(node, visit)
      }
      visit(startFunction())
      return positions
    }
    const constructors = inStart(node => ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'ElectronDesktopRuntime')
    expect(constructors.length, 'start() 必须构造一次 ElectronDesktopRuntime').toBe(1)
    const at = constructors[0] ?? -1
    expect(
      at >= range[0] && at <= range[1],
      'ElectronDesktopRuntime 的构造器（非 darwin/win32/linux 会抛错）必须在致命 try 内',
    ).toBe(true)
    // 同族的其余窗口语句：协议注册与数据根推导（`applyInstallDshHome` 对不安全
    // DSH_HOME 抛错）也必须在同一个 try 里。
    for (const name of ['registerAppScheme', 'applyInstallDshHome']) {
      const calls = inStart(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === name)
      expect(calls.length, `start() 必须调用 ${name}`).toBe(1)
      expect(calls.every(position => position >= range[0] && position <= range[1]),
        `${name} 必须在致命 try 内`).toBe(true)
    }
  })

  it('致命调用传的是"可能还没就位"的那个视图 —— 解析真实绑定，不是同名声明', () => {
    const call = fatalCall()
    const argument = call.arguments[1]
    expect(argument, '致命调用必须传身份来源').toBeDefined()
    expect(ts.isIdentifier(argument as ts.Node), '第二个实参必须是标识符（可选视图）').toBe(true)
    const view = argument as ts.Identifier

    // **绑定解析**（不是"同名声明里有没有 undefined"）：验证方变异 #5 用死代码里的同名
    // decoy 声明满足了旧判据；`getSymbolAtLocation` 问的是"这个标识符指向哪个声明"，
    // decoy 在别的行、别的块都改不了答案。
    const symbol = checker.getSymbolAtLocation(view)
    expect(symbol, `无法解析 ${view.text} 的绑定`).toBeDefined()
    const declarations = (symbol?.declarations ?? []).filter(ts.isVariableDeclaration)
    expect(declarations.length, `${view.text} 必须解析到唯一一个变量声明（实得 ${declarations.length}）`).toBe(1)
    const declaration = declarations[0]
    expect(declaration, '致命调用传的标识符必须解析到一个变量声明').toBeDefined()
    if (declaration === undefined) return

    const type = declaration.type?.getText(source) ?? '<无类型注解>'
    expect(type, `${view.text} 的类型必须显式含 undefined（窗口内可能未就位），实得 ${type}`)
      .toContain('undefined')
    // "还没就位"的行为证据：声明处没有初始化器（那一刻它的值就是 undefined），
    // 赋值（`mountedRuntime = runtime`）发生在构造器成功之后的致命 try 里。
    const initializer = declaration.initializer?.getText(source)
    expect(
      initializer === undefined || initializer === 'undefined',
      `${view.text} 必须在声明处就是 undefined（不能拿一个已赋值的视图冒充）：实得初始化器 ${String(initializer)}`,
    ).toBe(true)

    // 窗口里的另一个读点（退出前的 `?.prepareToQuit()`）必须用**同一个**绑定：
    // 两者指向不同的视图时，"弹窗读的是可选视图、退出读的是定值视图"会各修一半。
    const receivers: ts.Expression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'prepareToQuit'
        && node.questionDotToken !== undefined) {
        receivers.push(node.expression)
      }
      ts.forEachChild(node, visit)
    }
    visit(startFunction())
    expect(receivers.length, '退出前的 prepareToQuit 必须走可选访问').toBeGreaterThan(0)
    expect(
      receivers.some(receiver => checker.getSymbolAtLocation(receiver) === symbol),
      '`?.prepareToQuit()` 与致命调用必须用同一个可选视图',
    ).toBe(true)
  })

  it('退出协调器与关停协调器在 try 之前就位，且 prepareToQuit 走可选访问', () => {
    const guarded = enclosingTry(fatalCall())
    const tryStart = guarded.getStart(source)
    for (const name of ['createDesktopExitCoordinator', 'createDesktopShutdown']) {
      const calls: number[] = []
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
          calls.push(node.getStart(source))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(calls.length, `main.ts 必须调用 ${name}`).toBeGreaterThan(0)
      expect(calls.every(position => position < tryStart),
        `${name} 必须在致命 try 之前就位（否则 catch 的退出语句自己会在窗口内炸）`).toBe(true)
    }
    // `prepareToQuit: () => { <view>?.prepareToQuit() }`：问号是"窗口内 runtime 还没
    // 构造出来"的唯一正确形态；去掉它，退出路径就又解引用 undefined。
    let optionalPrepare = 0
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'prepareToQuit'
        && node.questionDotToken !== undefined) {
        optionalPrepare += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(optionalPrepare, '退出前的 prepareToQuit 必须走可选访问（窗口内可能未就位）').toBeGreaterThan(0)
  })

  it('引导段的每条语句都在致命 try 内，或在显式登记的白名单里（防"逐成员静默退化"）', () => {
    const fatal = enclosingTry(fatalCall())
    const start = startFunction()
    const windowStart = fatal.tryBlock.getStart(source)
    const windowEnd = fatal.tryBlock.getEnd()
    const inWindow = (node: ts.Node): boolean => {
      const at = node.getStart(source)
      return at >= windowStart && at < windowEnd
    }

    // `start()` 里**任何深度**的语句（不是只看顶层）：被塞进别的块、别的 try 一样算逃逸。
    const statements: ts.Statement[] = []
    const collect = (node: ts.Node): void => {
      if (ts.isStatement(node)) statements.push(node)
      ts.forEachChild(node, collect)
    }
    for (const statement of start.body?.statements ?? []) collect(statement)
    expect(statements.length, 'start() 的语句枚举缩水了？').toBeGreaterThan(10)

    const uncovered: string[] = []
    for (const statement of statements) {
      let node: ts.Node | undefined = statement
      let covered = false
      while (node !== undefined && node !== start) {
        // 局部常量：`node` 是可变的 `let`，闭包里 narrowing 会被丢弃（TS 不给可变捕获做窄化）。
        const current: ts.Node = node
        // 致命 try 语句本身是窗口的边界（catch 体就是最后的出口，不可能再套一层）。
        if (current === fatal || inWindow(current)
          || (ts.isStatement(current) && FATAL_WINDOW_WHITELIST.some(entry => entry.matches(current)))) {
          covered = true
          break
        }
        node = current.parent
      }
      if (!covered) uncovered.push(`L${lineOf(statement)} ${oneLine(statement)}`)
    }
    expect(uncovered, [
      'start() 里这些语句落在致命 try 之外：抛错会逸出 start()（被 `void run()` 吞成 unhandled rejection，'
      + '既没有原生错误面、也没有受控退出码）。',
      '处置：移进致命 try；确有必要留在外面的，在 FATAL_WINDOW_WHITELIST 里逐条登记（id + 理由 + 只匹配该形态）。',
    ].join('\n')).toEqual([])

    // 白名单不许有死条目：每条都必须真的在窗口外兜住至少一条语句（代码改回去了就删条目，
    // 别留着当免死金牌 —— 一条"匹配一切"的条目会让上面那条判据整体失效）。
    const used = new Set<string>()
    for (const statement of statements) {
      if (inWindow(statement)) continue
      for (const entry of FATAL_WINDOW_WHITELIST) {
        if (entry.matches(statement)) used.add(entry.id)
      }
    }
    expect(
      FATAL_WINDOW_WHITELIST.filter(entry => !used.has(entry.id)).map(entry => entry.id),
      '这些白名单条目已不再兜住任何留在致命窗口之外的语句（要么删掉，要么改回它守护的形态）',
    ).toEqual([])

    // 登记制的另一半：`reason` 不是装饰字段 —— 一句话的理由（或空串）等于没登记，
    // 评审时要能从理由本身判断"这条语句真的抛不出来 / 真的自带降级"。
    expect(
      FATAL_WINDOW_WHITELIST.filter(entry => entry.reason.trim().length < 40).map(entry => entry.id),
      '白名单条目的 reason 太短：登记制要求"为什么它可以不在致命窗口里"能被独立复核',
    ).toEqual([])
  })

  it('登记在册的引导成员一律落在致命 try 内（塞进别的块/别的 try 也算逃逸）', () => {
    const fatal = enclosingTry(fatalCall())
    const windowStart = fatal.tryBlock.getStart(source)
    const windowEnd = fatal.tryBlock.getEnd()

    const sites = new Map<string, number[]>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression.getText(source)
        if (FATAL_WINDOW_MEMBERS.includes(callee)) {
          sites.set(callee, [...(sites.get(callee) ?? []), node.getStart(source)])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(startFunction())

    const missing = FATAL_WINDOW_MEMBERS.filter(member => (sites.get(member) ?? []).length === 0)
    expect(missing, '名单里的引导成员在 start() 里找不到调用点（改名/搬走之后请同步 FATAL_WINDOW_MEMBERS）')
      .toEqual([])

    const escaped: string[] = []
    for (const [member, positions] of sites) {
      for (const position of positions) {
        if (position < windowStart || position >= windowEnd) {
          escaped.push(`${member} @L${source.getLineAndCharacterOfPosition(position).line + 1}`)
        }
      }
    }
    expect(escaped, [
      '这些引导成员在致命 try 之外：它抛错时既没有原生错误面、也没有受控退出码（B-02 的原始缺陷形态）。',
      '注：createDesktopExitCoordinator / createDesktopShutdown 相反 —— 必须留在 try 之外（catch 要用它们），'
      + '由白名单与"在 try 之前就位"那条判据守着。',
    ].join('\n')).toEqual([])
  })

  /**
   * 白名单的**负控**：下面这些形态一旦出现在 `start()` 里就必须判红。把它们逐个喂给每条
   * 白名单条目并断言"一条都不匹配" —— 这既是变异 #4（把 `installDesktopChildProcessLogging`
   * 移出 try）的常驻复现，也堵住"为了让某条语句过关而把条目写宽"的路子。
   */
  it('白名单不会匹配"把引导成员移出 try"的形态（负控）', () => {
    const sample = ts.createSourceFile(
      'moved-out.ts',
      [
        'async function start() {',
        '  removeChildProcessLogging = installDesktopChildProcessLogging(app, electronLogger)',
        '  registerAppScheme(APP_ORIGIN_SCHEME)',
        '  runtime = new ElectronDesktopRuntime(handler, () => {}, electronLogger, DEEP_LINK_SCHEME)',
        '  await app.whenReady()',
        '  const homeDir = applyInstallDshHome({ productDir: CHANNEL_PROFILE?.homeDir })',
        '  if (someFlag) { await resolveDesktopShellEnvironment({}) }',
        '  const prepared = await prepareDesktopProfile(process.env.DSH_TELEMETRY_DISABLED)',
        '}',
      ].join('\n'),
      ts.ScriptTarget.ESNext,
      true,
    )
    const statements: ts.Statement[] = []
    const collect = (node: ts.Node): void => {
      if (ts.isStatement(node)) statements.push(node)
      ts.forEachChild(node, collect)
    }
    collect(sample)
    expect(statements.length, '负控样本必须解析出语句').toBeGreaterThan(5)

    for (const statement of statements) {
      for (const entry of FATAL_WINDOW_WHITELIST) {
        expect(
          entry.matches(statement),
          `白名单条目 ${entry.id} 不该匹配"移出 try"的形态：${oneLine(statement)}`,
        ).toBe(false)
      }
    }
  })
})
