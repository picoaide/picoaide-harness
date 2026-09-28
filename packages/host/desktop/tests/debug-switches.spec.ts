/**
 * 调试开关闸门（2026-09-26 第二十五轮审计 Y4-01，P1；单横线覆盖 = 第二十六轮 Z2-02；
 * Node 隐藏别名 = 第二十七轮 FIX-37）的判据。
 *
 * 四层，互补：
 *  1. **行为**（纯函数）：受管清单每一名 × {单横线, 双横线} × {裸, `=`, `:`} × 打包/开发
 *     × 逃生门开/关 —— 打包态逐个拒绝、开发态一个都不拦、逃生门只影响"放行"这一支。
 *     Z2-02 的教训：判据与实现**共享同一个误解**（"只认 `--`"）时，两层都锚在错的假设上，
 *     所以这一层现在按 **argv 解析面**（真机对照矩阵
 *     `temp/r21/fix-30/probe/chromium-argv/matrix.out`）而不是按"我们以为的写法"来钉。
 *  2. **副作用**（可注入 IO）：拒绝时必须 write + showErrorBox + exit(1)；原生错误面
 *     或 stderr 抛异常时**仍然**退出（fail-closed 不是"尽力而为"）；放行时零副作用。
 *  3. **接线**（`main.ts` 源码，AST 级）：闸门必须**在模块作用域**、必须早于
 *     `async function run()`（也就是早于 `await app.whenReady()`）、必须不被条件包住、
 *     必须调用 `./debug-switches.*` 的**原导出**（不是同名别名）、实参个数恰好 2，
 *     且检测入参四项齐全（`packaged: app.isPackaged` 被改成 `false` 即红）。
 *  4. **上游锚**（pinned Electron 运行时里的字面量，FIX-37）：清单里的名字必须是
 *     **上游真有的名字**，而不是本仓自己写顺手的写法 —— 隐藏别名（`--inspect-brk-node`）
 *     不在 `--help` 里，唯一可复核的仓内出处就是运行时那份二进制/快照，所以判据直接
 *     去那里找 `addReadOnlyProcessAlias('_breakNodeFirstLine', '--inspect-brk-node', false)`。
 *     第 1 层对第 4 层的关系是"清单 ⊇ 上游锚"：删掉别名 ⇒ 第 1 层的字面量判据与第 4 层
 *     的枚举判据同时红。（`DEBUG_SWITCHES` 是一份**显式清单**，不是"所有调试开关"；
 *     清单外的别名仍不在闸门面内，`--inspect*` 家族整体由打包期 fuse 兜底。
 *     详见 `src/debug-switches.ts` 的模块头与 `packaged-inspect-fuse.spec.ts`。）
 *
 * 为什么必须钉接线的**形状**（而不是只跑纯函数）：闸门被删掉/被掏空时纯函数判据
 * 全部照旧通过，而生产行为是"打包版照旧接受 `--inspect`" —— 本仓已登记过两次同形
 * 事故（`network-policy.spec.ts` 头部记录的 B1-03 与 X3-04）。AST 判据的**自检**
 * （`findGateCalls` 对合成样本的判定）也在本文件内，避免"判据自己恒真"。
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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

describe('开关识别：受管清单每一名 × 单横线/双横线的全矩阵', () => {
  it('受管清单逐字固定（闸门面 = 这份清单 × 两种横线前缀；**不是**"所有调试开关"）', () => {
    // 逐字写死（不从被测模块取常量）：删掉其中任一名字都必须在这里红。
    // 位置顺序也是有意的：主进程/V8 控制面在前、渲染进程 CDP 在后（见 `DEBUG_SWITCHES` 注释）。
    expect(DEBUG_SWITCHES).toEqual([
      'inspect', 'inspect-brk', 'inspect-brk-node', 'inspect-wait', 'inspect-port',
      'debug-port', 'inspect-publish-uid', 'js-flags',
      'remote-debugging-port', 'remote-debugging-pipe',
    ])
  })

  it('清单每一名 × {单横线, 双横线} × {裸, =值, :值} 全矩阵逐条命中', () => {
    // Z2-02：Chromium 接受单横线（真机对照 `-remote-debugging-port=9451` 真的开了
    // `DevTools listening on ws://127.0.0.1:9451/...`），所以"只认 `--`"等于闸门不存在。
    // 这里逐个形态断言，不做抽样。
    for (const name of DEBUG_SWITCHES) {
      for (const dashes of ['-', '--']) {
        expect(matchDebugSwitch(`${dashes}${name}`), `${dashes}${name} 必须命中`).toBe(name)
        expect(matchDebugSwitch(`${dashes}${name}=9337`), `${dashes}${name}=9337 必须命中`).toBe(name)
        expect(matchDebugSwitch(`${dashes}${name}:9337`), `${dashes}${name}:9337 必须命中`).toBe(name)
      }
    }
  })

  it('inspect-brk 的四种形态单独钉死（Z1 真机在试的主进程 RCE 路径）', () => {
    expect(matchDebugSwitch('--inspect-brk')).toBe('inspect-brk')
    expect(matchDebugSwitch('-inspect-brk')).toBe('inspect-brk')
    expect(matchDebugSwitch('--inspect-brk=9337')).toBe('inspect-brk')
    expect(matchDebugSwitch('-inspect-brk=9337')).toBe('inspect-brk')
    // 兄弟开关不得互相吃掉（`inspect-brk` 不能被 `inspect` 命中）。
    expect(matchDebugSwitch('--inspect-brk=9229')).toBe('inspect-brk')
    expect(matchDebugSwitch('--inspect-port=9300')).toBe('inspect-port')
    // 隐藏别名同理：`--inspect-brk-node=9824` 既不能被 `inspect` 也不能被
    // `inspect-brk` 吃掉（名字不同、且 `matchDebugSwitch` 是精确相等而非前缀）。
    expect(matchDebugSwitch('--inspect-brk-node=9824')).toBe('inspect-brk-node')
    expect(matchDebugSwitch('--inspect-brk-node')).toBe('inspect-brk-node')
    expect(matchDebugSwitch('-inspect-brk-node=9824')).toBe('inspect-brk-node')
  })

  it('大小写变体也命中 —— 有意的过拦（真机对照里大写形态不生效，但过拦只花一次拒绝）', () => {
    expect(matchDebugSwitch('-REMOTE-DEBUGGING-PORT=9456')).toBe('remote-debugging-port')
    expect(matchDebugSwitch('--Remote-Debugging-Port=9333')).toBe('remote-debugging-port')
    expect(matchDebugSwitch('-INSPECT')).toBe('inspect')
  })

  it('近似名字与三根横线一律不命中（误判的代价是"打包版起不来"）', () => {
    for (const argument of [
      '--no-inspect', '--inspection', '--inspecto', '--remote-debugging-portx', '--js-flags-extra',
      // `--allow-inspector`（Node 24 权限模型下"允许使用 inspector"）**有意不在清单里**：
      // 它自己不开监听（`node --help`：allow use of inspector when any permissions are set），
      // 也不在 Node 自己的 `kInspectArgRegex = /--inspect(?:-brk|-port)?|--debug-port/` 里
      // ⇒ 列它只会多出误拒。它是"清单一角"，不是"清单完备"的证据。
      '--allow-inspector',
      'inspect=9337', '--', '-',
      // 三根横线不是"更宽的同一种形态"：真机对照 `---remote-debugging-port=9453`
      // **没有**开监听（Chromium 只吃一或两根），Node 侧同样不认。
      '---inspect=9337', '---remote-debugging-port=9453', '----inspect',
      '--lang=zh-CN', '--no-sandbox', '--proxy-server=http://x', 'picoaide://x',
    ]) {
      expect(matchDebugSwitch(argument), `${argument} 不得命中`).toBeUndefined()
    }
  })

  it('argv 与 execArgv 两个通道都收集，且如实标出来源', () => {
    expect(collectDebugSwitches(['--no-sandbox', '--inspect=9337'], ['--js-flags=--x'])).toEqual([
      { name: 'inspect', raw: '--inspect=9337', source: 'argv' },
      { name: 'js-flags', raw: '--js-flags=--x', source: 'execArgv' },
    ])
    expect(collectDebugSwitches(['-remote-debugging-port=9339'], [])).toEqual([
      { name: 'remote-debugging-port', raw: '-remote-debugging-port=9339', source: 'argv' },
    ])
  })
})

describe('Node inspect 族：隐藏别名 + 上游锚（FIX-37）', () => {
  /**
   * inspect 族的逐个枚举（名字 → **出处**）。
   *
   * 这一列**故意在判据里再写一遍**、不从 `DEBUG_SWITCHES` 派生：判据要能咬住"清单里少了谁"，
   * 而从被测对象派生期望值就是自指等式（本仓登记的假绿模式 3）。
   * 出处栏是给下一次上游升级用的：名字变了/消失了，先回来核这一栏。
   */
  const INSPECT_FAMILY: readonly { readonly name: string; readonly basis: string }[] = [
    { name: 'inspect', basis: 'ELECTRON_RUN_AS_NODE=1 <bin> --help（activate inspector on host:port）' },
    { name: 'inspect-brk', basis: '--help（break at start of user script）+ node_options.cc Implies --inspect' },
    {
      name: 'inspect-brk-node',
      basis: "隐藏别名（--help 不列）：pre_execution.js:313 addReadOnlyProcessAlias('_breakNodeFirstLine', '--inspect-brk-node', false)"
        + ' + node_options.cc:477-479（AddOption + Implies --inspect + AddAlias --inspect-brk-node=）',
    },
    {
      name: 'inspect-wait',
      basis: '--help + node_options.cc:482-487（Implies --inspect）；真机对照在本宿主上 NO-LISTENER ⇒ 当前是过拦',
    },
    { name: 'inspect-port', basis: '--help（--debug-port, --inspect-port=[host:]port）' },
    { name: 'debug-port', basis: 'node_options.cc:457 AddAlias("--debug-port", "--inspect-port") + 上游 kInspectArgRegex 一族' },
    { name: 'inspect-publish-uid', basis: '--help（uid 目的地；单独不激活，与 inspect-port 同为过拦）' },
  ]

  it('枚举：inspect 族的每个名字都在受管清单里（含 --help 不列的隐藏别名）', () => {
    for (const entry of INSPECT_FAMILY) {
      expect(DEBUG_SWITCHES, `${entry.name} 必须受管 —— 出处：${entry.basis}`).toContain(entry.name)
    }
  })

  it('隐藏别名 --inspect-brk-node 的四种形态：命中 + 打包态拒绝（真机上它真的开监听）', () => {
    for (const raw of ['--inspect-brk-node', '--inspect-brk-node=9824', '-inspect-brk-node', '-inspect-brk-node=9824']) {
      expect(matchDebugSwitch(raw), `${raw} 必须命中`).toBe('inspect-brk-node')
      const gate = detect({ argv: ['--no-sandbox', raw] })
      expect(gate.refused, `${raw} 在打包态必须 refused`).toBe(true)
      expect(gate.matches.map(match => match.raw)).toEqual([raw])
    }
  })

  it('上游锚：pinned Electron 运行时里真的有这条别名注册（不是我们编的名字）', () => {
    const runtime = scanElectronRuntimeForInspectAlias()
    // 先要强的那个形态（注册行）；只有它不在时才退回"名字在运行时里"这一较弱的证据，
    // 并在断言消息里写明退化到哪一层 —— 判据不得因为"退化了"而变成假绿（消息即证据）。
    expect(
      runtime.registration ?? runtime.name,
      `pinned Electron 运行时（${runtime.scanned}）里找不到 ${ALIAS_REGISTRATION}；`
        + '若上游确实改了这行，先回来核 INSPECT_FAMILY 的出处栏，再决定清单怎么改',
    ).toBeDefined()
  })
})

/**
 * Node 里那行**隐藏别名注册**（逐字取自上游 `lib/internal/process/pre_execution.js`）。
 * 它在 pinned Electron 二进制里也能 `strings` 到 —— 这就是"清单里的名字是上游真有的名字"
 * 的仓内可复核锚。
 */
const ALIAS_REGISTRATION = "addReadOnlyProcessAlias('_breakNodeFirstLine', '--inspect-brk-node', false)"

/** 本仓安装的 Electron 可执行文件（`require('electron')` 在普通 Node 进程里返回二进制路径）。 */
function resolveElectronBinary(): string {
  const require = createRequire(import.meta.url)
  const binary = require('electron') as unknown
  if (typeof binary !== 'string' || !existsSync(binary)) {
    // 与 `packaged-inspect-fuse.spec.ts` 同口径：缺二进制是**环境问题**（先 yarn install），
    // 不是"跳过这一层"——跳过就等于把上游锚变成空转。
    throw new Error(`electron binary not resolved (got ${JSON.stringify(binary)}); run yarn install first`)
  }
  return binary
}

/** 分块扫文件里有没有这段字节（运行时 250MB+，不能整份读进内存）。 */
function fileContains(file: string, needle: string): boolean {
  const target = Buffer.from(needle, 'utf8')
  const size = statSync(file).size
  if (size === 0) return false
  const chunk = 4 << 20
  const buffer = Buffer.allocUnsafe(chunk + target.length)
  const fd = openSync(file, 'r')
  try {
    let carry = 0
    let position = 0
    while (position < size) {
      const read = readSync(fd, buffer, carry, chunk, position)
      if (read <= 0) break
      position += read
      const view = buffer.subarray(0, carry + read)
      if (view.includes(target)) return true
      // 跨块边界的命中：把尾部不到 needle 长度的字节挪到下一块头部，否则会漏（假绿）。
      carry = Math.min(target.length - 1, view.length)
      view.copy(buffer, 0, view.length - carry)
    }
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * 在 pinned Electron 运行时里找隐藏别名：可执行文件 + 同目录的 `*.bin` 快照
 * （不同平台把内嵌 JS 放在哪一份里不保证，两份都扫）。
 * @returns 命中文件（强证据 = 注册行，弱证据 = 仅名字）与扫描根。
 */
function scanElectronRuntimeForInspectAlias(): {
  readonly registration: string | undefined
  readonly name: string | undefined
  readonly scanned: string
} {
  const binary = resolveElectronBinary()
  const distDir = dirname(binary)
  const files = [binary, ...readdirSync(distDir).filter(entry => entry.endsWith('.bin')).map(entry => join(distDir, entry))]
  let name: string | undefined
  for (const file of files) {
    if (fileContains(file, ALIAS_REGISTRATION)) return { registration: file, name: name ?? file, scanned: distDir }
    if (name === undefined && fileContains(file, '--inspect-brk-node')) name = file
  }
  return { registration: undefined, name, scanned: distDir }
}

describe('判定：打包态逐个拒绝（单/双横线同等），开发态一个都不拦', () => {
  it('全矩阵在打包态都必须被拒绝（逐个断言，不是抽样）', () => {
    for (const name of DEBUG_SWITCHES) {
      for (const raw of [`--${name}`, `--${name}=1`, `-${name}`, `-${name}=1`, `-${name}:1`]) {
        const gate = detect({ argv: ['--no-sandbox', raw] })
        expect(gate.refused, `${raw} 在打包态必须 refused`).toBe(true)
        expect(gate.matches.map(match => match.raw)).toEqual([raw])
      }
    }
  })

  it('execArgv 里的开关同样拒绝（V8 是 Node/Electron 的另一条入口）', () => {
    expect(detect({ execArgv: ['--inspect-brk'] }).refused).toBe(true)
    expect(detect({ execArgv: ['-inspect-brk'] }).refused).toBe(true)
  })

  it('开发态（!app.isPackaged）不得被误伤 —— 调试开关是正常手段', () => {
    const gate = detect({ packaged: false, argv: ['--inspect=9337', '--remote-debugging-port=9334', '-inspect-brk=9337', '-remote-debugging-port=9339'] })
    expect(gate.refused).toBe(false)
    expect(gate.escaped).toBe(false)
    // 仍然如实收集（供日志/排障），只是不拦。
    expect(gate.matches).toHaveLength(4)
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
