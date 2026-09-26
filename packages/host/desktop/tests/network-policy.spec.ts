/**
 * 客户端"禁止使用任何代理"策略（2026-09-22 定案）。
 *
 * 真机判据在 `temp/proxy-probe/REPORT.md`：默认跟随宿主机代理、`no-proxy-server`
 * 覆盖全部 session 且压过显式 `--proxy-server`、逐 session `setProxy` 会漏分区、
 * Node 栈只有换 dispatcher 才撤得掉 `NODE_USE_ENV_PROXY`。
 *
 * 本文件守住三件事：
 *  1. 纯策略逻辑（判定顺序、真值、环境清理、dispatcher 替换）；
 *  2. **强制执行块**（`enforceDirectTransport`）真的产生副作用 —— 以注入 deps 的行为判据
 *     钉住"换 dispatcher + 清环境"两件事（2026-09-25 审计 B1-03：内联在 `start()` 里时
 *     只有文本位置判据，掏成 `if (false && …)` 后 18/18 全绿）；
 *  3. **接线**（`main.ts` 必须在 `app.whenReady()` 之前 append 开关、必须**无条件**调用强制块）
 *     —— 接线断了不会有任何运行时症状，只会静默回到"跟随宿主机代理"。接线判据走
 *     **TypeScript AST**（注释掉 = 调用不存在、换行改写不误伤），见 B1-03 / B1-05。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  ALLOW_SYSTEM_PROXY_ENV,
  applySystemProxyPolicy,
  enforceDirectNodeTransport,
  enforceDirectTransport,
  isEnabledFlag,
  lateAllowSystemProxyWarning,
  NODE_ENV_PROXY_FLAG,
  NO_PROXY_SWITCH,
  PROXY_ENV_NAMES,
  resolveSystemProxyPolicy,
  stripProxyEnvironment,
  type NodeDispatcherModule,
  type NodeTransportOutcome,
} from '../src/network-policy.ts'
import { parseDesktopChannelProfile } from '../src/desktop-channel.ts'

const REPO = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

describe('出口策略判定：默认禁止，环境变量 > 渠道包 > 缺省', () => {
  it('没有任何配置时禁止代理', () => {
    expect(resolveSystemProxyPolicy({}, undefined)).toEqual({ allow: false, source: 'default' })
    expect(resolveSystemProxyPolicy({}, {})).toEqual({ allow: false, source: 'default' })
    expect(resolveSystemProxyPolicy({}, { allowSystemProxy: false })).toEqual({ allow: false, source: 'default' })
  })

  it('渠道包 desktop.allow_system_proxy: true 才允许，且来源记为 channel', () => {
    expect(resolveSystemProxyPolicy({}, { allowSystemProxy: true })).toEqual({ allow: true, source: 'channel' })
  })

  it('环境变量是**双向**开关，且压过渠道包', () => {
    expect(resolveSystemProxyPolicy({ [ALLOW_SYSTEM_PROXY_ENV]: '1' }, { allowSystemProxy: false }))
      .toEqual({ allow: true, source: 'environment' })
    // 显式关：渠道包开了也仍然禁止（"默认禁止"不能被渠道配置单方面推翻成无法回退）。
    expect(resolveSystemProxyPolicy({ [ALLOW_SYSTEM_PROXY_ENV]: '0' }, { allowSystemProxy: true }))
      .toEqual({ allow: false, source: 'environment' })
  })

  it('环境变量名大小写都认（Windows 环境名大小写不敏感）', () => {
    expect(resolveSystemProxyPolicy({ [ALLOW_SYSTEM_PROXY_ENV.toLowerCase()]: 'true' }, undefined))
      .toEqual({ allow: true, source: 'environment' })
  })

  it('真值表：只有明确的关闭值算关闭', () => {
    for (const off of ['', ' ', '0', 'false', 'FALSE', 'no', 'off']) expect(isEnabledFlag(off)).toBe(false)
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE', ' 1 ']) expect(isEnabledFlag(on)).toBe(true)
    expect(isEnabledFlag(undefined)).toBe(false)
  })

  it('渠道包只认严格布尔 true（字符串 "true" 按缺省=禁止处理，误读只会更严）', () => {
    const profile = parseDesktopChannelProfile({
      channel_id: 'acme',
      desktop: { app_origin_scheme: 'acme-app', allow_system_proxy: 'true' },
    })
    expect(profile?.allowSystemProxy).toBe(false)
    const strict = parseDesktopChannelProfile({
      channel_id: 'acme',
      desktop: { app_origin_scheme: 'acme-app', allow_system_proxy: true },
    })
    expect(strict?.allowSystemProxy).toBe(true)
    // 缺省路径（官方构建/未配该字段）与渠道化改造前一致。
    const bare = parseDesktopChannelProfile({ channel_id: 'acme', desktop: { app_origin_scheme: 'acme-app' } })
    expect(bare?.allowSystemProxy).toBe(false)
  })
})

describe('Chromium 开关', () => {
  it('禁止时 append no-proxy-server，允许时一个开关都不动', () => {
    const appended: string[] = []
    const commandLine = { appendSwitch: (name: string) => { appended.push(name) } }
    expect(applySystemProxyPolicy(commandLine, { allow: false, source: 'default' })).toBe(true)
    // 期望值**写死**在这里（不从被测模块取值）：自指等式 `toEqual([NO_PROXY_SWITCH])`
    // 杀不掉"把取值改成 Chromium 不认的名字"这一变异（B1-05）。
    expect(appended).toEqual(['no-proxy-server'])
    appended.length = 0
    expect(applySystemProxyPolicy(commandLine, { allow: true, source: 'channel' })).toBe(false)
    expect(appended).toEqual([])
  })

  it('开关取值必须逐字是 Chromium 认识的那个名字（改名词即红）', () => {
    // Chromium/Electron 只认 `--no-proxy-server`（switch 名就是 `no-proxy-server`，没有
    // 复数/连字符变体；同族的 `--proxy-server` 是**另一个**开关）。真源=Electron 文档
    // （`app.commandLine.appendSwitch` / 命令行开关表）与 Chromium 的
    // `switches::kNoProxyServer`；端到端的能力判据是真机探针 `yarn probe:proxy`
    // （`scripts/proxy-policy-probe-app.mjs` 断言 `resolveProxy` 为 DIRECT，**不在
    // `yarn check` 内**）—— 所以这里必须有一条能在单测里变红的取值判据。
    // 变异：改成 `no-proxy-servers` ⇒ 本用例红（旧版 18/18 全绿，整个"默认禁止代理"静默失效）。
    expect(NO_PROXY_SWITCH).toBe('no-proxy-server')
  })
})

describe('代理环境清理', () => {
  it('删掉大小写两套代理名与 NODE_USE_ENV_PROXY，并如实回报删除项', () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://proxy.example.com:8080',
      https_proxy: 'http://proxy.example.com:8080',
      NO_PROXY: 'localhost',
      [NODE_ENV_PROXY_FLAG]: '1',
      PATH: '/usr/bin',
      DSH_HOME: '/home/u/.picoaide-harness',
    }
    const removed = stripProxyEnvironment(env)
    expect(removed).toEqual(['HTTP_PROXY', 'https_proxy', 'NO_PROXY', NODE_ENV_PROXY_FLAG])
    for (const name of [...PROXY_ENV_NAMES, NODE_ENV_PROXY_FLAG]) expect(env[name]).toBeUndefined()
    // 非代理名一字不动（尤其 DSH_ 与 PATH）。
    expect(env.PATH).toBe('/usr/bin')
    expect(env.DSH_HOME).toBe('/home/u/.picoaide-harness')
  })

  it('本来就没有代理配置时什么都不报', () => {
    expect(stripProxyEnvironment({ PATH: '/usr/bin' })).toEqual([])
  })
})

describe('Node 栈（undici dispatcher）', () => {  function fakeUndici(): { module: NodeDispatcherModule; installed: unknown[]; agent: object } {
    const agent = { kind: 'direct-agent' }
    const installed: unknown[] = []
    return {
      agent,
      installed,
      module: {
        Agent: class { constructor() { return agent as never } } as unknown as NodeDispatcherModule['Agent'],
        getGlobalDispatcher: () => ({ kind: 'env-proxy-agent' }),
        setGlobalDispatcher: (dispatcher: unknown) => { installed.push(dispatcher) },
      },
    }
  }

  it('宿主机没设 NODE_USE_ENV_PROXY 时完全不加载 undici', async () => {
    const load = vi.fn()
    expect(await enforceDirectNodeTransport({ HTTP_PROXY: 'http://proxy.example.com:8080' }, load)).toBe('not-requested')
    expect(load).not.toHaveBeenCalled()
    expect(await enforceDirectNodeTransport({ [NODE_ENV_PROXY_FLAG]: '0' }, load)).toBe('not-requested')
    expect(load).not.toHaveBeenCalled()
  })

  it('设了就换成直连 Agent（删环境变量撤不掉它，唯一可用手段）', async () => {
    const fake = fakeUndici()
    expect(await enforceDirectNodeTransport({ [NODE_ENV_PROXY_FLAG]: '1' }, async () => fake.module)).toBe('swapped')
    expect(fake.installed).toEqual([fake.agent])
  })

  it('undici 不可用时如实回报，不抛（打包缺件也要能启动）', async () => {
    expect(await enforceDirectNodeTransport({ [NODE_ENV_PROXY_FLAG]: '1' }, async () => {
      throw new Error('Cannot find module undici')
    })).toBe('unavailable')
  })
})

describe('强制执行块（可注入 deps，B1-03）', () => {
  /** 假 deps：记录调用顺序与"换 dispatcher 时看到的环境"。 */
  function fakeDeps(outcome: NodeTransportOutcome = 'swapped'): {
    readonly order: string[]
    readonly envSeen: Array<string | undefined>
    readonly deps: {
      readonly enforceNodeTransport: (env: Record<string, string | undefined>) => Promise<NodeTransportOutcome>
      readonly stripEnvironment: (env: Record<string, string | undefined>) => readonly string[]
    }
  } {
    const order: string[] = []
    const envSeen: Array<string | undefined> = []
    return {
      order,
      envSeen,
      deps: {
        enforceNodeTransport: async (env) => {
          order.push('transport')
          envSeen.push(env[NODE_ENV_PROXY_FLAG])
          return outcome
        },
        stripEnvironment: (env) => {
          order.push('strip')
          return stripProxyEnvironment(env)
        },
      },
    }
  }

  it('禁止代理时：真的换 dispatcher + 真的删环境变量（掏空成 if (false) 即红）', async () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://proxy.example.com:8080',
      [NODE_ENV_PROXY_FLAG]: '1',
      PATH: '/usr/bin',
    }
    const fake = fakeDeps()
    const result = await enforceDirectTransport(env, { allow: false, source: 'default' }, fake.deps)

    expect(result).toEqual({
      enforced: true,
      transport: 'swapped',
      cleared: ['HTTP_PROXY', NODE_ENV_PROXY_FLAG],
      lateWarning: undefined,
    })
    // 副作用**真的发生**（不是"算了个结论"）：这才是否定"掏空成不可达"的那一半。
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env[NODE_ENV_PROXY_FLAG]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    // 顺序有语义：换 dispatcher 的判定必须看到**删除前**的环境（Node 启动时就按它装了 agent）。
    expect(fake.order).toEqual(['transport', 'strip'])
    expect(fake.envSeen).toEqual(['1'])
  })

  it('允许代理时：一个副作用都不产生，注入的 deps 一次都不调用', async () => {
    const env: Record<string, string | undefined> = { HTTP_PROXY: 'http://proxy.example.com:8080' }
    const fake = fakeDeps()
    const result = await enforceDirectTransport(env, { allow: true, source: 'channel' }, fake.deps)

    expect(result).toEqual({ enforced: false, transport: undefined, cleared: [], lateWarning: undefined })
    expect(env.HTTP_PROXY).toBe('http://proxy.example.com:8080')
    expect(fake.order).toEqual([])
  })

  it('`.env` 分层里的排障开关在清理**之前**读（否则永远报不出来）', async () => {
    const env: Record<string, string | undefined> = { [ALLOW_SYSTEM_PROXY_ENV]: '1' }
    const result = await enforceDirectTransport(env, { allow: false, source: 'default' }, {
      enforceNodeTransport: async () => 'not-requested',
      // 假 strip 故意把这个变量也删掉：判定必须在它之前完成。
      stripEnvironment: (target) => {
        Reflect.deleteProperty(target, ALLOW_SYSTEM_PROXY_ENV)
        return []
      },
    })
    expect(result.lateWarning).toContain(ALLOW_SYSTEM_PROXY_ENV)
  })

  it('undici 不可用时如实回报，不抛（打包缺件也要能启动）', async () => {
    const env: Record<string, string | undefined> = { [NODE_ENV_PROXY_FLAG]: '1', HTTP_PROXY: 'http://proxy.example.com:8080' }
    const result = await enforceDirectTransport(env, { allow: false, source: 'default' }, {
      enforceNodeTransport: async () => 'unavailable',
      stripEnvironment: stripProxyEnvironment,
    })
    expect(result.transport).toBe('unavailable')
    // 删除顺序 = PROXY_ENV_NAMES 的顺序（HTTP_PROXY 在前），随后才是 NODE_USE_ENV_PROXY。
    expect(result.cleared).toEqual(['HTTP_PROXY', NODE_ENV_PROXY_FLAG])
  })
})

describe('环境分层里的排障开关（.env 太晚，必须留痕而不是静默无效）', () => {
  it('真实进程环境设的开关：不报"太晚"（它本来就生效了）', () => {
    const env = { [ALLOW_SYSTEM_PROXY_ENV]: '1' }
    expect(lateAllowSystemProxyWarning(env, resolveSystemProxyPolicy(env, undefined))).toBeUndefined()
  })

  it('.env 分层注入的开关：报一行说明为什么没生效', () => {
    const policy = resolveSystemProxyPolicy({}, undefined)
    const warning = lateAllowSystemProxyWarning({ [ALLOW_SYSTEM_PROXY_ENV]: '1' }, policy)
    expect(warning).toContain(ALLOW_SYSTEM_PROXY_ENV)
    expect(warning).toContain('real process environment')
    // 关闭值或没设：不产生日志噪音。
    expect(lateAllowSystemProxyWarning({ [ALLOW_SYSTEM_PROXY_ENV]: '0' }, policy)).toBeUndefined()
    expect(lateAllowSystemProxyWarning({}, policy)).toBeUndefined()
  })
})

describe('接线（源码级）：开关必须早于 app.whenReady()，清理必须发生在出站之前', () => {
  const main = read('packages/host/desktop/src/main.ts')
  const policy = read('packages/host/desktop/src/network-policy.ts')

  it('唯一字面量在 network-policy.ts，main.ts 只调用策略函数', () => {
    // 期望值写死（不是 `'${NO_PROXY_SWITCH}'` 的自指模板）：自指等式在实现改名后仍恒真。
    expect(policy).toContain("export const NO_PROXY_SWITCH = 'no-proxy-server'")
    expect(main).toContain('applySystemProxyPolicy(app.commandLine, SYSTEM_PROXY_POLICY)')
  })

  it('append 发生在 app.whenReady() 之前（晚一行 Chromium 就不再读它）', () => {
    const call = main.indexOf('applySystemProxyPolicy(app.commandLine, SYSTEM_PROXY_POLICY)')
    const ready = main.indexOf('await app.whenReady()')
    expect(call).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(-1)
    expect(call).toBeLessThan(ready)
  })

  it('策略在模块作用域取值（不能是插件 apply 期的 Config：那时已经晚于 ready）', () => {
    const declaration = main.indexOf('const SYSTEM_PROXY_POLICY = resolveSystemProxyPolicy(process.env, CHANNEL_PROFILE)')
    expect(declaration).toBeGreaterThan(-1)
    expect(declaration).toBeLessThan(main.indexOf('async function start()'))
  })

  it('loadLayeredEnv 之后、boot 之前**无条件**执行强制块（AST 级，掏空即红）', () => {
    // 为什么升级成 AST（2026-09-25 审计 B1-03）：旧版是三条子串位置断言，
    // 把强制块掏成 `if (false && !SYSTEM_PROXY_POLICY.allow)` 后 needle 全在、18/18 全绿，
    // 而真机探针 `yarn probe:proxy` 直接 import `lib/network-policy.js`，**不经过这段控制流**。
    // 现在这段逻辑在 `enforceDirectTransport()` 里（行为判据见上一个 describe），
    // 这里钉"它真的会被调用、且没有被任何条件包住"。
    const calls = findEnforcementCalls(main)
    expect(calls, 'main.ts 必须恰好一处 await enforceDirectTransport(process.env, SYSTEM_PROXY_POLICY)').toHaveLength(1)
    expect(calls[0]?.conditional, '强制块不得被 if/三元包住 —— 关掉时与"不强制执行"完全等价').toBe(false)
    expect(calls[0]?.env, '第一个实参必须是 process.env（否则清的不是真环境）').toBe('process.env')
    expect(calls[0]?.policy, '第二个实参必须是模块作用域算出的 SYSTEM_PROXY_POLICY').toBe('SYSTEM_PROXY_POLICY')

    const lines = callLines(main, ['loadLayeredEnv', 'enforceDirectTransport', 'boot'])
    const envLoad = lines.get('loadLayeredEnv')?.[0]
    const enforce = lines.get('enforceDirectTransport')?.[0]
    const bootAt = lines.get('boot')?.[0]
    expect(envLoad, 'main.ts 必须调用 loadLayeredEnv()').toBeGreaterThan(0)
    expect(bootAt, 'main.ts 必须调用 boot()').toBeGreaterThan(0)
    expect(enforce, '强制块必须在 loadLayeredEnv 之后（连 home .env 注入的代理名一起清）')
      .toBeGreaterThan(envLoad!)
    expect(enforce, '强制块必须在任何插件出站之前（boot() 在同一段代码里更靠后）').toBeLessThan(bootAt!)

    // 自检：判据本身要能抓住两种"掏空"形态，且不误伤换行改写。
    const canonical = "const enforcement = await enforceDirectTransport(process.env, SYSTEM_PROXY_POLICY)\n"
    expect(findEnforcementCalls(canonical)).toEqual([
      { conditional: false, env: 'process.env', policy: 'SYSTEM_PROXY_POLICY' },
    ])
    expect(findEnforcementCalls(`if (false && !SYSTEM_PROXY_POLICY.allow) {\n  ${canonical}}\n`)[0]?.conditional)
      .toBe(true)
    expect(findEnforcementCalls(`if (false) {\n  ${canonical}}\n`)[0]?.conditional).toBe(true)
    expect(findEnforcementCalls("const enforcement = false && await enforceDirectTransport(process.env, SYSTEM_PROXY_POLICY)\n")[0]?.conditional)
      .toBe(true)
    expect(findEnforcementCalls("const enforcement = await enforceDirectTransport(\n  process.env,\n  SYSTEM_PROXY_POLICY,\n)\n"))
      .toHaveLength(1)
    // 注释掉 = 调用不存在（文本包含会假绿）。
    expect(findEnforcementCalls(`// ${canonical}`)).toEqual([])
    // 换个"更好的"策略字面量也必须被抓（那正是把强制块绕开的另一种写法）。
    expect(findEnforcementCalls("await enforceDirectTransport(process.env, { allow: true, source: 'default' })\n")[0]?.policy)
      .toBeUndefined()
  })
})

/**
 * 一个 `enforceDirectTransport(...)` 调用点在语法树里的投影。
 *
 * 在语法树上找：注释不是节点 ⇒ 注释掉的调用"不存在"；空白/折行不改变 AST ⇒
 * 语义等价的改写仍能找到（本仓 tests/profile-context-wiring.spec.ts 的模块头记录过
 * 纯 `toContain` 在两个方向上同时失效的事故）。
 */
interface EnforcementCall {
  /** 是否被 `if` / 三元包住（被包住 = 可能根本不执行）。 */
  readonly conditional: boolean
  /** 第一个实参的文本形态（`process.env` 这类点号表达式会被拼回来）。 */
  readonly env: string | undefined
  /** 第二个实参的标识符（传字面量/别的对象时为 undefined）。 */
  readonly policy: string | undefined
}

/**
 * 找 `enforceDirectTransport(<env>, <policy>)` 调用点。
 * @param source - TypeScript 源码。
 * @param fileName - 诊断与 ScriptKind 判定用。
 * @returns 每个调用点。
 */
function findEnforcementCalls(source: string, fileName = 'main.ts'): EnforcementCall[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: EnforcementCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'enforceDirectTransport') {
      const [env, policy] = node.arguments
      found.push({
        conditional: hasConditionalAncestor(node),
        env: env === undefined
          ? undefined
          : ts.isPropertyAccessExpression(env) && ts.isIdentifier(env.expression)
            ? `${env.expression.text}.${env.name.text}`
            : env.getText(file),
        policy: policy !== undefined && ts.isIdentifier(policy) ? policy.text : undefined,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 调用是否可能被跳过（祖先里有 `if`、三元，或短路逻辑的右操作数）。 */
function hasConditionalAncestor(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) return true
    // `false && await enforceDirectTransport(…)` / `cond || await …`：右操作数可能根本不求值。
    if (
      ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      // 调用可能在右操作数的**子树**里（`false && await call(…)` 的右操作数是 AwaitExpression）。
      && current.right.getStart() <= node.getStart()
      && node.getEnd() <= current.right.getEnd()
    ) {
      return true
    }
  }
  return false
}

/** 按被调方标识符收集调用点行号（1-based，按出现顺序）。 */
function callLines(source: string, names: readonly string[], fileName = 'main.ts'): Map<string, number[]> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lines = new Map<string, number[]>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
      lines.set(node.expression.text, [...(lines.get(node.expression.text) ?? []), line])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}
