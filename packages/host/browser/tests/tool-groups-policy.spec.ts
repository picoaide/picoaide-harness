/**
 * R21 F-02：「企业策略」两个开关（`evalEnabled` / `toolGroups`）的**缺省方向**与显式值语义。
 *
 * 缺陷形态（修前）：
 *  - `parseToolGroups` 在结果为空集时回落 `DEFAULT_GROUPS` ⇒ `toolGroups: []`（运维想关掉
 *    全部浏览器工具时最自然的写法）**反而把七组全部打开**（fail-open 的反直觉形态）；
 *  - `evalEnabled` / `toolGroups` **全仓零赋值点**（装配面只注入 `appOriginScheme`），
 *    而两者的缺省都是"开"⇒ 规划文档里"企业策略可整体禁用"那句是**空头承诺**。
 *    本轮定案：撤回承诺、把口径写成"宿主配置 + 缺省全开"（`index.ts` 的字段注释与
 *    `docs/planning/2026-09-07-ai-browser-redesign.md` §7.9 同步），并消掉上面的 `[]` 回落。
 *
 * 三条判据各钉一件事，缺一条就有假绿空间：
 *  1. **解析语义**：键缺席 = 全开；显式数组 = 字面生效（可为空集 = 全关）。
 *  2. **能力面**：空集时 `applyBrowserTools` 注册的工具数必须是 **0**（只断言"解析出空集"
 *     是值断言，注册面才是真正决定模型能看见什么的那一步）。
 *  3. **缺省方向 + schema**：`browser_eval` 的缺省必须能被**调用**（而不是抛 `policy`）；
 *     两个键必须真的在 Schemastery schema 里（未声明的键会被**剥掉** ⇒ 配置静默失效、
 *     回落全开 —— 本仓在 MCP `authProvider` 上踩过同一个坑）。
 */
import { describe, expect, it } from 'vitest'
import { BrowserRuntime } from '../src/runtime.ts'
import { Config } from '../src/index.ts'
import { DEFAULT_GROUPS, applyBrowserTools, parseToolGroups } from '../src/tools.ts'

/** 七个工具组（与 `GROUP_OF` 的取值集合一致）。 */
const ALL_GROUPS = ['navigate', 'interact', 'read', 'write', 'memory', 'artifacts', 'control'] as const

/**
 * 用真的 `applyBrowserTools` 收集"会被注册进模型工具面"的工具名。
 *
 * 这是**能力断言**：组策略的作用点就是"注册多少个工具"，只断言 `parseToolGroups`
 * 的返回值会在"解析对了但接线时没用它"时假绿。
 * @param groups - 启用的组集合。
 * @returns 注册过的工具名（按注册顺序）。
 */
function registeredTools(groups: ReadonlySet<string>): string[] {
  const names: string[] = []
  const ctx = {
    tools: { register: (definition: { name: string }) => { names.push(definition.name); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const dispose = applyBrowserTools(ctx, {} as never, groups)
  dispose()
  return names
}

describe('toolGroups：键缺席才是"全开"，显式数组按字面生效', () => {
  it('键缺席 = 七组全开（唯一保留的 fail-open 缺省，且是文档写明的缺省）', () => {
    expect([...parseToolGroups(undefined)].sort()).toEqual([...ALL_GROUPS].sort())
    expect(registeredTools(parseToolGroups(undefined)).length).toBeGreaterThan(0)
    expect(registeredTools(DEFAULT_GROUPS).length).toBe(registeredTools(parseToolGroups(undefined)).length)
  })

  it('显式空数组 = 全关（此前回落到全开：`[]` 把七组全部打开）', () => {
    expect([...parseToolGroups([])]).toEqual([])
    // 能力面：一个工具都不注册（含 browser_eval）。
    expect(registeredTools(parseToolGroups([]))).toEqual([])
  })

  it('无法识别的名字按"未启用"处理（写错名字 = 全关，不能开门）', () => {
    expect([...parseToolGroups(['naviagte'])]).toEqual([])
    expect(registeredTools(parseToolGroups(['naviagte']))).toEqual([])
  })

  it('显式给出已知组：只注册该组的工具，`browser_eval` 不在 read 组', () => {
    const read = registeredTools(parseToolGroups(['read']))
    expect(read.length).toBeGreaterThan(0)
    expect(read).toContain('browser_get_snapshot')
    // `browser_eval` 在用户已登录的分区里执行 AI 编写的 JS ⇒ 归 write 组。
    expect(read).not.toContain('browser_eval')
    expect(registeredTools(parseToolGroups(['write']))).toContain('browser_eval')
  })

  it('未知名字不会把整组拖回全开（混合形态）', () => {
    const groups = parseToolGroups(['read', 'naviagte'])
    expect([...groups]).toEqual(['read'])
    expect(registeredTools(groups)).toEqual(registeredTools(parseToolGroups(['read'])))
  })
})

describe('evalEnabled：缺省方向是"开"，且开关必须真的能传到插件（schema 不得吞键）', () => {
  it('缺省（不传该键）⇒ browser_eval 可用（抛的不是 policy）', async () => {
    const runtime = new BrowserRuntime({} as never, {})
    // 不存在的 tab 一定失败，但**失败原因**区分了默认方向：被策略关掉时抛 `policy`。
    const cause = await runtime.eval(999, '1 + 1').catch((error: unknown) => error)
    expect((cause as Error & { code?: string }).code).not.toBe('policy')
  })

  it('显式 evalEnabled=false ⇒ browser_eval 抛 policy（对照组，证明上一条真的在测缺省）', async () => {
    const runtime = new BrowserRuntime({} as never, { evalEnabled: false })
    const cause = await runtime.eval(999, '1 + 1').catch((error: unknown) => error)
    expect((cause as Error & { code?: string }).code).toBe('policy')
  })

  it('Schemastery schema 声明了两个键（未声明 ⇒ 配置被静默剥掉、回落全开）', () => {
    const parsed = Config({ evalEnabled: false, toolGroups: [] }) as { evalEnabled?: boolean, toolGroups?: string[] }
    expect(parsed.evalEnabled).toBe(false)
    expect(parsed.toolGroups).toEqual([])
    // 空数组穿过 schema 之后仍然是"全关"（不是被回落成 undefined = 全开）。
    expect(registeredTools(parseToolGroups(parsed.toolGroups))).toEqual([])
  })
})
