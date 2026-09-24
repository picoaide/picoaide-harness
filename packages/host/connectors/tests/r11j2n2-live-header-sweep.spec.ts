/**
 * R11 J2-N2（P3）：注册期「两个记录源短暂共存」时，带外刷新必须把**新**记录也刷上。
 *
 * ## 窗口是怎么来的（产品路径，不是推演）
 *
 * 重新授权路径（`index.ts` 的 `startConnect` → OAuth 流程成功之后）直接调用
 * `registerMcp(def, { signal })`，**不先退役旧登记**（注释写明了理由：失败的重新授权
 * 不该把一条好用的连接器的工具摘掉，退役交给 `registerMcp` 内部做）。于是：
 *
 * ```
 *   :2302  attachMcpLiveHeaders(provider, renderedHeaders.headers)
 *   :2309  publishPendingLiveHeaders()          ← 新记录进 pendingLiveHeaders
 *   :2355  await waitForRebuildClearance(...)   ← 唯一的 await：在途调用没排空就停在这
 *   :2372  retire()                             ← 旧登记此刻才从 mcpRegistrations 摘掉
 * ```
 *
 * 在 `[publish, retire]` 里，同一个 `serverName` 同时有**两条本连接器的记录**：即将被
 * 退役的旧登记，和这条注册马上要读的新 pending 记录。旧实现 `refreshLiveHeaders` 命中
 * 「已登记优先」就 `continue`，于是带外刷新把新令牌写进了**注定作废的那条**，新记录
 * 仍是替换前的令牌 ⇒ 新传输带着死令牌上线，注册以 `Server returned 401 after
 * re-authentication` 收场（第九轮 R9-D-1 修的就是这个症状，只是那次修在另一条路径上）。
 * 跨 owner 的串写被 `def.id` 判据挡着（那一半成立），所以复审把它记成 P3、标"未证成"。
 *
 * ## 修法与这条判据的边界（如实写清；R12-B-04 把"可达前提"写全）
 *
 * 修法：sweep **两个来源**（都按 `def.id` 判归属），谁存在就刷谁 —— 幂等、严格更宽、
 * 不引入任何跨 owner 写入；`refreshed` 计数只用于日志（两处调用点都丢弃返回值）。
 *
 * **这条判据是结构判据，不是端到端判据。** 第十二轮复审把"为什么现有装置里做不到端到端"
 * 逐条钉了下来（R12-B-04）。下面三段就是那段认账的正文 —— 它由文件末的"可达前提"用例
 * 守着：前提一旦变化（例如探针装置改用真 fence、票数不再恒 0）就会红着要人来更新。
 *
 * 1. **窗口要撑开需要什么**：`await waitForRebuildClearance(def, server)` 是
 *    `publishPendingLiveHeaders()` 与 `retire()` 之间**唯一**的 await，而它**默认立刻
 *    返回**：`src/index.ts` 里那道函数的闸是 ①`server.transport === 'streamable-http'`、
 *    ②`mcpRegistrations.get(serverName)` 存在且 `live.id === def.id`、
 *    ③**`isMcpOutboundBusy(url)` 为真**。前两条在重新授权路径上成立，第三条才是关键 ——
 *    它要求该端点上有一条**被 fence 计过票**的在途 MCP 调用（票由
 *    `mcp-transport-fence.ts` 的 `createMcpOutboundFetch` 在每次出站请求上记，
 *    `hardenTransport` 把它装进传输实例）。没有任何在途调用时，两个记录源的共存期
 *    塌成**微任务级**窗口 —— 确定性构造不出来（只能靠运气）。
 * 2. **现有装置为什么结构不可达**：本族探针（`helpers/connector-harness.ts` +
 *    `r11b01-midreg-window.spec.ts` + `r12b-already-in-use-retry.spec.ts`）
 *    **自己 `new StreamableHTTPClientTransport(...)`**，并把上游桥
 *    `@deepseek-ai/dsh-mcp-client` `vi.mock` 成 `apply: () => {}` —— 真正装载传输、
 *    给传输装 fence 票的那条路（`hardenTransport` / `ensureMcpTransportRedirectFence`）
 *    整条不参与 ⇒ **票数恒为 0** ⇒ `waitForRebuildClearance` 恒立刻返回 ⇒ 上面那个窗口
 *    在这些用例里**结构性不可达**（不是"难写"，是装置里没有产生票的路径）。
 * 3. **所以今天只有形状判据**：端到端能证明"记录 = 传输所读对象"这条接缝的，是
 *    `audit-r9-connector-headers.spec.ts` 的两条用例（`productionTransport()` 手搭
 *    传输 + 真 fence 装符号 + 真 HTTP），但它们**不在** J2-N2 的两源窗口里。要让这条
 *    判据变成端到端，必须让探针装置经过 `ensureMcpTransportRedirectFence()` + 真传输
 *    （或把 `mcp-transport-fence` 的票务注入点暴露成测试可见的替身），再在窗口内跑一次
 *    面板刷新 —— 代价与 P3 不匹配，本轮**没有**做。
 *
 * 因此这里钉的是**代码形态**与**同族行为**：
 *
 * 1. `refreshLiveHeaders` 的 sweep 循环体内必须**同时**取两个来源，且都带 `def.id` 归属判据；
 * 2. 循环体内**不许**有 `continue`（那正是"命中第一个来源就跳过第二个"的变异形态）；
 * 3. 判据自身会咬：把同一段扫描器喂给"旧形态"的合成源码（带 `continue`）必须报红 ——
 *    所以本文件不需要改仓库代码就能证明它会红，端到端窗口一旦补上，这条仍然有效；
 * 4. "可达前提"用例：上面 1./2. 两段里引用的锚点（三道闸、票的唯一发放处、探针装置
 *    自建传输 + 桥被 mock）必须在源码/装置里真的存在 —— 认账不许停在文字上。
 *
 * 同族的端到端路径（单个来源、注册窗口内刷新）由 `r11b01-midreg-window.spec.ts`
 * 的真实 HTTP + 真 pinned SDK 探针守着；**重试路径**那条（`already in use` 重试里
 * 重新发布记录）由 `r12b-already-in-use-retry.spec.ts` 端到端守着。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const testsRoot = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(testsRoot, '..', 'src', 'index.ts')
const source = readFileSync(sourcePath, 'utf8')

interface SweepShape {
  /** sweep 循环里出现的记录来源（按 `xxx.get(server.serverName)` 归一）。 */
  readonly sources: readonly string[]
  /** 循环体内出现的 `def.id` 归属判据次数。 */
  readonly ownershipChecks: number
  /** 循环体内有没有 `continue`（旧形态：命中第一个来源就跳过第二个）。 */
  readonly continues: number
  /** 循环体内有没有 `return`（同上，另一种跳过形态）。 */
  readonly returns: number
}

/**
 * 读出 `refreshLiveHeaders` 里 sweep 循环的形状。
 * @param text - `src/index.ts` 的全文（或合成源码，供判据自检）。
 * @returns 形状；找不到函数/循环时抛错（判据不许在"扫不到"时变绿）。
 */
function sweepShapeOf(text: string): SweepShape {
  const file = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found: SweepShape | undefined
  const visit = (node: ts.Node): void => {
    const isTargetFunction = (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && node.parent !== undefined
      && ts.isVariableDeclaration(node.parent)
      && node.parent.name.getText(file) === 'refreshLiveHeaders'
    if (isTargetFunction && ts.isBlock(node.body)) {
      const loop = node.body.statements.find(statement =>
        ts.isForOfStatement(statement) && statement.expression.getText(file).replace(/\s+/gu, '') === 'def.mcp')
      if (loop === undefined || !ts.isForOfStatement(loop) || !ts.isBlock(loop.statement)) {
        throw new Error('refreshLiveHeaders 里找不到 `for (const server of def.mcp)` 循环（判据要跟着改）')
      }
      const body = loop.statement
      const inner = body.getText(file)
      const sources = [...inner.matchAll(/(\w+)\.get\(server\.serverName\)/gu)].map(match => match[1] as string)
      let continues = 0
      let returns = 0
      const count = (current: ts.Node): void => {
        if (ts.isContinueStatement(current)) continues += 1
        if (ts.isReturnStatement(current)) returns += 1
        ts.forEachChild(current, count)
      }
      count(body)
      found = {
        sources: [...new Set(sources)].sort(),
        ownershipChecks: (inner.match(/def\.id/gu) ?? []).length,
        continues,
        returns,
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (found === undefined) throw new Error('src/index.ts 里找不到 refreshLiveHeaders（判据的锚点没了）')
  return found
}

describe('R11 J2-N2: 带外刷新必须扫过两个记录来源（注册期共存窗口）', () => {
  it('refreshLiveHeaders 的 sweep 同时取 mcpRegistrations 与 pendingLiveHeaders，各自按 def.id 判归属', () => {
    const shape = sweepShapeOf(source)
    expect(
      shape.sources,
      'sweep 必须同时读两个来源：只读一个（或命中第一个就 continue）会让另一条记录留在替换前的令牌上（J2-N2）',
    ).toEqual(['mcpRegistrations', 'pendingLiveHeaders'])
    expect(
      shape.ownershipChecks,
      '两个来源都必须带 def.id 归属判据 —— 否则会把别的连接器的记录写脏（CN-4 那一半）',
    ).toBeGreaterThanOrEqual(2)
    expect(shape.continues, 'sweep 循环里不许有 continue：那正是"命中已登记就跳过 pending"的旧形态').toBe(0)
    expect(shape.returns, 'sweep 循环里不许有提前 return：那会让 loop 只处理第一个 server').toBe(0)
  })

  it('判据自身会咬：把旧形态（continue 短路）喂给同一段扫描器必须报红', () => {
    // 与真源码同形，只把 sweep 换回旧形态：命中已登记就 continue，够不到 pending。
    const oldShape = source.replace(
      /      const pending = pendingLiveHeaders\.get\(server\.serverName\)/u,
      '      continue\n      const pending = pendingLiveHeaders.get(server.serverName)',
    )
    expect(oldShape, '替换锚点没命中（判据自检失效）').not.toBe(source)
    const shape = sweepShapeOf(oldShape)
    expect(shape.continues, '旧形态必须被数出 continue').toBeGreaterThan(0)
    expect(
      shape.continues === 0 && shape.sources.length === 2,
      '复合判据（两个来源 + 无 continue）在旧形态上必须为假 —— 这就是它会红的证明',
    ).toBe(false)
  })

  it('判据不是恒真：源码里确实存在这两个 map（锚点没被改名架空）', () => {
    expect(source).toContain('const pendingLiveHeaders = new Map<')
    expect(source).toContain('const mcpRegistrations = new Map<')
    expect(() => sweepShapeOf('const unrelated = 1\n'), '扫不到函数必须抛错，不许静默变绿').toThrow(/refreshLiveHeaders/u)
  })

  it('可达前提（R12-B-04）：窗口只在"fence 计过票的在途调用"存在时撑得开，而本族装置里票数恒 0', () => {
    // 这一段是文件头第 1./2. 条的**机器判据**：认账里引用的锚点必须真的存在，
    // 否则那段文字就是过期的（例如有人把探针改成走真 fence、票数不再恒 0）。
    // 三条闸：transport 形态 / 已登记且同 owner / 端点在途忙。
    const clearance = /\n {2}const waitForRebuildClearance = async[\s\S]*?\n {2}\}\n/u.exec(source)
    expect(clearance, 'index.ts 里找不到 waitForRebuildClearance（认账段的锚点没了）').not.toBeNull()
    const body = clearance![0]
    expect(body, '闸①：只有 streamable-http 才等').toContain(`server.transport !== 'streamable-http'`)
    expect(body, '闸②：必须已登记且同 owner').toContain('mcpRegistrations.get(server.serverName)')
    expect(body, '闸③：只有端点在途忙才真的等 —— 这就是"票数为 0 时窗口塌成微任务"的判据').toContain('isMcpOutboundBusy(url)')

    // 票的唯一发放处：fence 把 `createMcpOutboundFetch` 装进传输实例。
    const fence = readFileSync(join(testsRoot, '..', 'src', 'mcp-transport-fence.ts'), 'utf8')
    expect(fence, '票（在途记账）必须由 fence 的 createMcpOutboundFetch 记').toContain('export function createMcpOutboundFetch')
    expect(fence, '它必须被装进传输实例（否则票永远是 0）').toMatch(/FETCH_WITH_INIT_FIELD\] = createMcpOutboundFetch\(/u)

    // 装置的形态：本族探针自建传输 + mock 掉上游桥 ⇒ 从不经过 fence ⇒ 票恒 0。
    const sibling = readFileSync(join(testsRoot, 'r11b01-midreg-window.spec.ts'), 'utf8')
    expect(
      sibling.includes("vi.mock('@deepseek-ai/dsh-mcp-client'") && sibling.includes('new StreamableHTTPClientTransport('),
      '同族探针装置变了（不再自建传输 / 不再 mock 上游桥）—— 文件头"结构不可达"那两段需要重新核对：'
      + '若装置已走真 fence，就该把这条认账升级成端到端判据（那是好事，别把它当误报删掉）',
    ).toBe(true)
    expect(
      readFileSync(join(testsRoot, 'r12b-already-in-use-retry.spec.ts'), 'utf8'),
      '重试路径那条端到端用例不见了（它是 J2-N2 之外的另一条同族路径）',
    ).toContain('new StreamableHTTPClientTransport(')
  })
})
