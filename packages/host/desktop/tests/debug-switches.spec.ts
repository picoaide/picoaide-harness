/**
 * 调试开关闸门（2026-09-26 第二十五轮审计 Y4-01，P1）的判据。
 *
 * 三层，互补：
 *  1. **行为**（纯函数）：6 类开关 × 打包/开发 × 逃生门开/关 —— 打包态逐个拒绝、
 *     开发态一个都不拦、逃生门只影响"放行"这一支。
 *  2. **副作用**（可注入 IO）：拒绝时必须 write + showErrorBox + exit(1)；原生错误面
 *     或 stderr 抛异常时**仍然**退出（fail-closed 不是"尽力而为"）；放行时零副作用。
 *  3. **接线**（`main.ts` 源码，AST 级）：闸门必须**在模块作用域**、必须早于
 *     `async function run()`（也就是早于 `await app.whenReady()`）、必须不被条件包住、
 *     必须调用 `./debug-switches.*` 的**原导出**（不是同名别名）、实参个数恰好 2，
 *     且检测入参四项齐全（`packaged: app.isPackaged` 被改成 `false` 即红）。
 *
 * 为什么必须钉接线的**形状**（而不是只跑纯函数）：闸门被删掉/被掏空时纯函数判据
 * 全部照旧通过，而生产行为是"打包版照旧接受 `--inspect`" —— 本仓已登记过两次同形
 * 事故（`network-policy.spec.ts` 头部记录的 B1-03 与 X3-04）。AST 判据的**自检**
 * （`findGateCalls` 对合成样本的判定）也在本文件内，避免"判据自己恒真"。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  ALLOW_DEBUG_SWITCHES_ENV,
  applyDebugSwitchGate,
  collectDebugSwitches,
  DEBUG_SWITCH_REFUSAL_TITLE,
  DEBUG_SWITCHES,
  debugSwitchEscapeLogLine,
  debugSwitchRefusalMessage,
  detectDebugSwitches,
  matchDebugSwitch,
  type DebugSwitchGate,
  type DebugSwitchGateIO,
} from '../src/debug-switches.ts'

const REPO = join(__dirname, '../../../..')

/** 打包态 + 无逃生门的基准输入。 */
const PACKAGED = { argv: [] as string[], execArgv: [] as string[], packaged: true, env: {} as Record<string, string | undefined> }

/** 组装一次判定（只写关心的字段）。 */
function detect(overrides: Partial<typeof PACKAGED>): DebugSwitchGate {
  return detectDebugSwitches({ ...PACKAGED, ...overrides })
}

/** 记录副作用的假 IO。 */
function fakeIO(options: { throwOnErrorBox?: boolean; throwOnWrite?: boolean } = {}): {
  io: DebugSwitchGateIO
  writes: string[]
  boxes: { title: string; content: string }[]
  exits: number[]
} {
  const writes: string[] = []
  const boxes: { title: string; content: string }[] = []
  const exits: number[] = []
  return {
    writes,
    boxes,
    exits,
    io: {
      write: chunk => {
        if (options.throwOnWrite === true) throw new Error('stderr is gone')
        writes.push(chunk)
      },
      showErrorBox: (title, content) => {
        if (options.throwOnErrorBox === true) throw new Error('no display')
        boxes.push({ title, content })
      },
      exit: code => { exits.push(code) },
    },
  }
}

describe('开关识别：只认 `--<name>` 与 `--<name>=<value>`', () => {
  it('6 类受管开关的两种写法都命中，且回报的名字取自受管清单', () => {
    expect(DEBUG_SWITCHES).toEqual([
      'inspect', 'inspect-brk', 'inspect-port', 'remote-debugging-port', 'remote-debugging-pipe', 'js-flags',
    ])
    for (const name of DEBUG_SWITCHES) {
      expect(matchDebugSwitch(`--${name}`), `--${name} 必须命中`).toBe(name)
      expect(matchDebugSwitch(`--${name}=value`), `--${name}=value 必须命中`).toBe(name)
    }
  })

  it('同一前缀的兄弟开关不会互相吃掉（`--inspect-brk` 不能被 `inspect` 命中）', () => {
    expect(matchDebugSwitch('--inspect-brk=9229')).toBe('inspect-brk')
    expect(matchDebugSwitch('--inspect-port=9300')).toBe('inspect-port')
  })

  it('近似名字一律不命中（误判的代价是"打包版起不来"）', () => {
    for (const argument of [
      '--no-inspect', '--inspection', '--inspecto', '--remote-debugging-portx', '--js-flags-extra',
      'inspect=9337', '--', '-inspect', '--lang=zh-CN', '--no-sandbox', '--proxy-server=http://x',
    ]) {
      expect(matchDebugSwitch(argument), `${argument} 不得命中`).toBeUndefined()
    }
  })

  it('argv 与 execArgv 两个通道都收集，且如实标出来源', () => {
    expect(collectDebugSwitches(['--no-sandbox', '--inspect=9337'], ['--js-flags=--x'])).toEqual([
      { name: 'inspect', raw: '--inspect=9337', source: 'argv' },
      { name: 'js-flags', raw: '--js-flags=--x', source: 'execArgv' },
    ])
  })
})

describe('判定：打包态逐个拒绝，开发态一个都不拦', () => {
  it('每个受管开关在打包态都必须被拒绝（逐个断言，不是抽样）', () => {
    for (const name of DEBUG_SWITCHES) {
      for (const raw of [`--${name}`, `--${name}=1`]) {
        const gate = detect({ argv: ['--no-sandbox', raw] })
        expect(gate.refused, `${raw} 在打包态必须 refused`).toBe(true)
        expect(gate.matches.map(match => match.raw)).toEqual([raw])
      }
    }
  })

  it('execArgv 里的开关同样拒绝（V8 是 Node/Electron 的另一条入口）', () => {
    expect(detect({ execArgv: ['--inspect-brk'] }).refused).toBe(true)
  })

  it('开发态（!app.isPackaged）不得被误伤 —— 调试开关是正常手段', () => {
    const gate = detect({ packaged: false, argv: ['--inspect=9337', '--remote-debugging-port=9334'] })
    expect(gate.refused).toBe(false)
    expect(gate.escaped).toBe(false)
    // 仍然如实收集（供日志/排障），只是不拦。
    expect(gate.matches).toHaveLength(2)
  })

  it('正常启动（无调试开关）在打包态照旧放行', () => {
    const gate = detect({ argv: ['--no-sandbox', '--lang=zh-CN', 'picoaide://x'] })
    expect(gate).toMatchObject({ refused: false, escaped: false, hatch: false })
    expect(gate.matches).toEqual([])
  })

  it('逃生门放行一次，并且只在"确有命中"时算 escaped（要留痕）', () => {
    const escaped = detect({ argv: ['--remote-debugging-port=9334'], env: { [ALLOW_DEBUG_SWITCHES_ENV]: '1' } })
    expect(escaped).toMatchObject({ refused: false, hatch: true, escaped: true })
    // 开了逃生门但没有命中：不算 escaped（无需在日志里喊"保护已关闭"）。
    expect(detect({ env: { [ALLOW_DEBUG_SWITCHES_ENV]: '1' } })).toMatchObject({ escaped: false, refused: false })
  })

  it('逃生门的真值口径与出口策略同源：关闭值不算开', () => {
    for (const off of ['', ' ', '0', 'false', 'no', 'off']) {
      expect(detect({ argv: ['--inspect'], env: { [ALLOW_DEBUG_SWITCHES_ENV]: off } }).refused,
        `PICOAI_ALLOW_DEBUG_SWITCHES=${JSON.stringify(off)} 必须仍然拒绝`).toBe(true)
    }
    expect(detect({ argv: ['--inspect'], env: { [ALLOW_DEBUG_SWITCHES_ENV.toLowerCase()]: 'yes' } }).escaped).toBe(true)
  })

  it('逃生门变量名逐字固定（E2E/探针/文档/HANDOFF 都按这个名字写）', () => {
    expect(ALLOW_DEBUG_SWITCHES_ENV).toBe('PICOAI_ALLOW_DEBUG_SWITCHES')
  })
})

describe('文案与留痕', () => {
  it('拒绝文案点名开关、说清危害与两条出路（含逃生门变量名）', () => {
    const gate = detect({ argv: ['--inspect=9337'] })
    const message = debugSwitchRefusalMessage(gate)
    expect(message).toContain('--inspect=9337')
    // 期望值写死在这里（不从被测模块取常量）：自指等式杀不掉"把取值改错"的变异。
    expect(message).toContain('PICOAI_ALLOW_DEBUG_SWITCHES=1')
    expect(message).toContain('yarn dev')
    expect(message).toContain('--remote-debugging-port')
    // 中英双写：模块作用域拿不到 locale（app.getLocale() ready 前返回空串，实测见模块注释）。
    expect(message).toContain('拒绝启动')
    expect(message).toContain('Refusing to start')
    expect(DEBUG_SWITCH_REFUSAL_TITLE).toContain('调试开关被拒绝')
  })

  it('逃生门留痕：只有 escaped 时才给日志行，且点名变量与开关', () => {
    expect(debugSwitchEscapeLogLine(detect({ argv: ['--inspect'] }))).toBeUndefined()
    const line = debugSwitchEscapeLogLine(detect({ argv: ['--inspect'], env: { [ALLOW_DEBUG_SWITCHES_ENV]: '1' } }))
    expect(line).toContain('PICOAI_ALLOW_DEBUG_SWITCHES')
    expect(line).toContain('--inspect')
  })
})

describe('副作用：拒绝必须"喊出来"且"退出去"', () => {
  it('拒绝 ⇒ 写 stderr + 弹错误面 + exit(1)', () => {
    const { io, writes, boxes, exits } = fakeIO()
    expect(applyDebugSwitchGate(detect({ argv: ['--inspect=9337'] }), io)).toBe('refused')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('--inspect=9337')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.content).toContain('--inspect=9337')
    expect(exits).toEqual([1])
  })

  it('原生错误面抛异常（无显示器/受限沙箱）也必须退出（fail-closed）', () => {
    const { io, exits } = fakeIO({ throwOnErrorBox: true })
    expect(applyDebugSwitchGate(detect({ argv: ['--remote-debugging-port=9334'] }), io)).toBe('refused')
    expect(exits).toEqual([1])
  })

  it('连 stderr 都写不出去时仍然退出，且命令式地先试错误面', () => {
    const { io, boxes, exits } = fakeIO({ throwOnWrite: true })
    expect(applyDebugSwitchGate(detect({ argv: ['--js-flags=--x'] }), io)).toBe('refused')
    expect(boxes).toHaveLength(1)
    expect(exits).toEqual([1])
  })

  it('放行时一个副作用都没有（开发态 / 打包态正常启动 / 逃生门）', () => {
    for (const gate of [
      detect({ packaged: false, argv: ['--inspect'] }),
      detect({ argv: ['--no-sandbox'] }),
      detect({ argv: ['--inspect'], env: { [ALLOW_DEBUG_SWITCHES_ENV]: '1' } }),
    ]) {
      const { io, writes, boxes, exits } = fakeIO()
      const verdict = applyDebugSwitchGate(gate, io)
      expect(verdict).not.toBe('refused')
      expect([writes.length, boxes.length, exits.length]).toEqual([0, 0, 0])
    }
  })
})

/** 一个 `applyDebugSwitchGate(...)` 调用点的语法树投影。 */
interface GateCall {
  /** 实参个数（生产接线必须恰好 2：gate + io）。 */
  readonly argCount: number
  /** 第一个实参的标识符（传别的表达式时为 undefined）。 */
  readonly gate: string | undefined
  /** 第二个实参是不是对象字面量，以及它给了哪些属性名。 */
  readonly ioKeys: readonly string[]
  /** 是否被 `if` / 三元 / 短路逻辑包住（包住 = 可能根本不执行）。 */
  readonly conditional: boolean
  /** 是否落在某个函数体里（闸门必须在**模块作用域**：`start()` 里已经晚于开关生效）。 */
  readonly insideFunction: boolean
  /** 被调用的标识符是否解析到 `./debug-switches.*` 的**原导出**。 */
  readonly resolved: boolean
  /** 调用点在文件里的字符偏移（用于和 `await app.whenReady()` 比先后）。 */
  readonly at: number
}

/** `applyDebugSwitchGate` 的原导出名与真实现模块（R24 X3-04 口径：别名 import 不是真实现）。 */
const GATE_EXPORT = 'applyDebugSwitchGate'

/** 模块说明符是否指向 `debug-switches`（源码 `.ts` 与构建产物 `.js` 两种写法都认）。 */
function isGateModule(specifier: string): boolean {
  const base = specifier.split('/').pop() ?? ''
  return /^debug-switches\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(base)
}

/** 收集调用点（注释不是节点 ⇒ 注释掉 = 不存在；折行不改变语义 ⇒ 不误伤）。 */
function findGateCalls(source: string, fileName = 'main.ts'): GateCall[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: GateCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GATE_EXPORT) {
      const io = node.arguments[1]
      found.push({
        argCount: node.arguments.length,
        gate: node.arguments[0] !== undefined && ts.isIdentifier(node.arguments[0]) ? node.arguments[0].text : undefined,
        ioKeys: io !== undefined && ts.isObjectLiteralExpression(io)
          ? io.properties.flatMap(property => (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) ? [property.name.text] : []))
          : [],
        conditional: hasConditionalAncestor(node),
        insideFunction: hasFunctionAncestor(node),
        resolved: resolvesToGateImport(node),
        at: node.getStart(file),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 调用是否落在任何函数/方法体内（`arrow` 也算 —— `const f = () => applyDebugSwitchGate(...)`）。 */
function hasFunctionAncestor(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) return true
  }
  return false
}

/** 调用是否可能被跳过（`if` / 三元 / `&&` `||` `??` 的右操作数）。 */
function hasConditionalAncestor(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) return true
    if (
      ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      && current.right.getStart() <= node.getStart()
      && node.getEnd() <= current.right.getEnd()
    ) {
      return true
    }
  }
  return false
}

/**
 * 这个名字解析到哪里：模块顶层的"**从 `./debug-switches.*` 未改名导入
 * `applyDebugSwitchGate`**"才算真实现。
 *
 * 覆盖 X3-04 那三种绕过（别名 import / 从别的模块 import / namespace import）与
 * 局部同名遮蔽（本闸门在模块作用域，遮蔽只能发生在模块层：`const applyDebugSwitchGate = …`
 * 与 import 重声明在 TS 里本就报错，判据只是把它变成**显式红灯**而不是靠类型检查兜）。
 */
function resolvesToGateImport(node: ts.Node): boolean {
  const bindsName = (binding: ts.BindingName | undefined): boolean => {
    if (binding === undefined) return false
    if (ts.isIdentifier(binding)) return binding.text === GATE_EXPORT
    return binding.elements.some(element => !ts.isOmittedExpression(element) && bindsName(element.name))
  }
  const classify = (statement: ts.Statement): 'import' | 'other' | undefined => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause === undefined) return undefined
      const fromSource = ts.isStringLiteral(statement.moduleSpecifier) && isGateModule(statement.moduleSpecifier.text)
      if (clause.name !== undefined && clause.name.text === GATE_EXPORT) return 'other'
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === GATE_EXPORT) return 'other'
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        const matched = bindings.elements.find(element => (element.name ?? element.propertyName)?.text === GATE_EXPORT)
        if (matched === undefined) return undefined
        const original = matched.propertyName?.text ?? matched.name.text
        return original === GATE_EXPORT && fromSource ? 'import' : 'other'
      }
      return undefined
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(declaration => bindsName(declaration.name)) ? 'other' : undefined
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name !== undefined && statement.name.text === GATE_EXPORT) return 'other'
    return undefined
  }
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current)) {
      let sawImport = false
      const statements: readonly ts.Statement[] = ts.isCaseBlock(current)
        ? current.clauses.flatMap(clause => [...clause.statements])
        : current.statements
      for (const statement of statements) {
        const kind = classify(statement)
        if (kind === 'other') return false
        if (kind === 'import') sawImport = true
      }
      if (sawImport) return true
      if (ts.isSourceFile(current)) return false
      continue
    }
    if (ts.isFunctionLike(current)) {
      const parameters = 'parameters' in current ? current.parameters : undefined
      if (parameters?.some(parameter => bindsName(parameter.name)) === true) return false
    }
  }
  return false
}

/** 取 `detectDebugSwitches({...})` 的实参对象里的属性名 → 初始化表达式文本。 */
function detectionArguments(source: string, fileName = 'main.ts'): ReadonlyMap<string, string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const result = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'detectDebugSwitches') {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            result.set(property.name.text, property.initializer.getText(file).replace(/\s+/gu, ' ').trim())
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

describe('接线（main.ts 源码级 AST）：模块作用域、早于 ready、不可掏空', () => {
  const main = readFileSync(join(REPO, 'packages/host/desktop/src/main.ts'), 'utf8')

  it('恰好一处 applyDebugSwitchGate(gate, io) 调用，且在模块作用域', () => {
    const calls = findGateCalls(main)
    expect(calls, 'main.ts 必须恰好一处 applyDebugSwitchGate(...)').toHaveLength(1)
    const [call] = calls
    expect(call?.conditional, '不得被 if/三元/短路包住 —— 包住就等价于"可能不设防"').toBe(false)
    expect(call?.insideFunction, '必须在模块作用域：`--inspect` 在 JS 跑之前就已监听，start()/run() 里都太晚').toBe(false)
    expect(call?.argCount, '实参个数必须是 2（gate + io；多喂参数会让接线的判据看不见 io 的真实形状）').toBe(2)
    expect(call?.gate, '第一个实参必须是模块作用域算出的 DEBUG_SWITCH_GATE').toBe('DEBUG_SWITCH_GATE')
    expect(call?.ioKeys, '第二个实参必须显式给出三个副作用（write/showErrorBox/exit）').toEqual(
      expect.arrayContaining(['write', 'showErrorBox', 'exit']),
    )
    expect(call?.resolved, '被调用的必须是 ./debug-switches.* 的原导出（别名/别的模块同名符号不算）').toBe(true)
  })

  it('检测入参四项齐全，且打包判据取自 app.isPackaged（改成 false 即红）', () => {
    const args = detectionArguments(main)
    expect(args.get('argv')).toBe('process.argv')
    expect(args.get('execArgv')).toBe('process.execArgv')
    // 写死字面量：`packaged: false`（开发态恒放行 = 闸门失效）必须当场变红。
    expect(args.get('packaged')).toBe('app.isPackaged')
    expect(args.get('env')).toBe('process.env')
  })

  it('闸门的位置早于 `async function run()`（因而早于 await app.whenReady()）', () => {
    const call = findGateCalls(main)[0]
    const gateAt = call?.at ?? -1
    expect(gateAt).toBeGreaterThan(-1)
    const runAt = main.indexOf('async function run(')
    const readyAt = main.indexOf('await app.whenReady()')
    expect(runAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(-1)
    expect(gateAt, '闸门必须在 run() 之前（模块作用域）').toBeLessThan(runAt)
    expect(gateAt, '闸门必须在 await app.whenReady() 之前').toBeLessThan(readyAt)
  })

  it('逃生门必须在启动日志里留痕（header 状态 + 一行明细）', () => {
    expect(main).toContain('debugSwitches ${DEBUG_SWITCH_GATE.escaped ? \'allowed-by-env\' : \'guarded\'}')
    const escapeLine = main.indexOf('const debugSwitchEscape = debugSwitchEscapeLogLine(DEBUG_SWITCH_GATE)')
    expect(escapeLine, 'start() 必须按闸门结果写逃生门日志行').toBeGreaterThan(-1)
    expect(main.indexOf('electronLogger.error(`${BIN_NAME}: ${debugSwitchEscape}`)')).toBeGreaterThan(escapeLine)
  })

  it('判据自检：掏空/遮蔽/别名/条件化/移进函数 五种形态都必须被识别', () => {
    const canonical = "applyDebugSwitchGate(DEBUG_SWITCH_GATE, { write: writeStderrSync, showErrorBox: (t, c) => { dialog.showErrorBox(t, c) }, exit: code => { app.exit(code) } })\n"
    const withImport = `import { applyDebugSwitchGate } from './debug-switches.ts'\n${canonical}`
    expect(findGateCalls(withImport)).toEqual([{
      argCount: 2, gate: 'DEBUG_SWITCH_GATE', ioKeys: ['write', 'showErrorBox', 'exit'],
      conditional: false, insideFunction: false, resolved: true, at: withImport.indexOf('applyDebugSwitchGate', 10),
    }])
    // ① 注释掉 = 不存在（文本包含会假绿）。
    expect(findGateCalls(`// ${canonical}`)).toEqual([])
    // ② 条件化（掏成 `if (false && …)`）。
    expect(findGateCalls(`if (false) {\n  ${canonical}}\n`)[0]?.conditional).toBe(true)
    expect(findGateCalls(`false && ${canonical}`)[0]?.conditional).toBe(true)
    // ③ 移进函数（start()/run() 里 = 晚于开关生效）。
    expect(findGateCalls(`async function start() {\n  ${canonical}}\n`)[0]?.insideFunction).toBe(true)
    // ④ 别名 import（`detectDebugSwitches as applyDebugSwitchGate`：语法上是 import 绑定，
    //    运行期却是另一个函数 —— X3-04 的最小反例）。
    expect(findGateCalls(`import { detectDebugSwitches as applyDebugSwitchGate } from './debug-switches.ts'\n${canonical}`)[0]?.resolved).toBe(false)
    expect(findGateCalls(`import { applyDebugSwitchGate } from './somewhere-else.ts'\n${canonical}`)[0]?.resolved).toBe(false)
    expect(findGateCalls(`import * as applyDebugSwitchGate from './debug-switches.ts'\n${canonical}`)[0]?.resolved).toBe(false)
    // ⑤ 模块作用域重声明（同名 const 遮蔽真实现）。
    expect(findGateCalls(`import { applyDebugSwitchGate } from './debug-switches.ts'\nconst applyDebugSwitchGate = () => {}\n${canonical}`)[0]?.resolved).toBe(false)
    // 反向：构建产物写法（`./debug-switches.js`）不得误红。
    expect(findGateCalls(`import { applyDebugSwitchGate } from './debug-switches.js'\n${canonical}`)[0]?.resolved).toBe(true)
    // 反向：多喂一个实参必须是 3（io 是接缝，不许被换成 no-op 之外的东西还说"形状没变"）。
    expect(findGateCalls(`applyDebugSwitchGate(DEBUG_SWITCH_GATE, {}, undefined)\n`)[0]?.argCount).toBe(3)
    expect(findGateCalls(`applyDebugSwitchGate(DEBUG_SWITCH_GATE, {})\n`)[0]?.ioKeys).toEqual([])
  })

  it('检测入参判据自检：packaged 一旦被写死成 false 就抓得到', () => {
    const sample = 'const G = detectDebugSwitches({ argv: process.argv, execArgv: process.execArgv, packaged: false, env: process.env })\n'
    expect(detectionArguments(sample).get('packaged')).toBe('false')
    expect(detectionArguments(sample).get('packaged')).not.toBe('app.isPackaged')
    expect(detectionArguments('const G = detectDebugSwitches({ packaged: app.isPackaged })\n').has('argv')).toBe(false)
  })

  it('闸门模块不得反向 import electron（纯 Node 单测 + 纯函数判据的前提）', () => {
    const module = readFileSync(join(REPO, 'packages/host/desktop/src/debug-switches.ts'), 'utf8')
    expect(module).not.toMatch(/from 'electron'/u)
    // 唯一实现复用：真值口径必须来自 network-policy（不许在这里另抄一份）。
    expect(module).toContain("import { isEnabledFlag } from './network-policy.ts'")
  })
})

describe('纯函数不得依赖运行期环境', () => {
  it('detectDebugSwitches 不改写入参（启动期对象被篡改会很难查）', () => {
    const argv = ['--inspect=9337']
    const env: Record<string, string | undefined> = { [ALLOW_DEBUG_SWITCHES_ENV]: '1' }
    const before = JSON.stringify({ argv, env })
    detectDebugSwitches({ argv, execArgv: [], packaged: true, env })
    expect(JSON.stringify({ argv, env })).toBe(before)
  })

  it('判定是纯的：同一输入两次得到同样结果（无模块级缓存）', () => {
    const input = { argv: ['--remote-debugging-pipe'], execArgv: [], packaged: true, env: {} as Record<string, string | undefined> }
    expect(detectDebugSwitches(input)).toEqual(detectDebugSwitches(input))
  })

  it('逃生门只读真实进程环境：模块自己不许读环境/配置文件（判定全部由入参决定）', () => {
    // 模块作用域早于 `.env` 分层加载，所以这里结构上不能有"读分层"的路径；
    // 判据形态 = 模块正文里不得出现 `process.env` / 读文件调用。
    const module = readFileSync(join(REPO, 'packages/host/desktop/src/debug-switches.ts'), 'utf8')
    expect(module).not.toMatch(/process\.env|readFileSync|loadLayeredEnv/u)
  })
})
