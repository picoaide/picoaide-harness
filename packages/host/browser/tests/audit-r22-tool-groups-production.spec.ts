/**
 * R22 V6 F1/F5（P0 发布阻断）判据：`toolGroups` 在**生产装配形态**下的注册面。
 *
 * 缺陷形态（`280b3fc249` 起，V6 复审实测；2026-09-26 在本树复现）：
 * `index.ts` 的 `Config` schema 里 `toolGroups: z.array(z.string())` **没有 `.default()`**，
 * 而 Schemastery 会把**缺键的数组**物化成 `[]`（同一 schema 的标量字段缺键仍是
 * `undefined`，只有数组/字典中招）。生产装配注入的正是"缺键"形态 ——
 * `packages/host/desktop/src/profile.ts` 给 `pico-browser` 行只注入 `{ appOriginScheme }`，
 * `cordis.patch.yml` 的 insert 没有 config，而 patch 的 `config` 是**整键替换** ——
 * ⇒ `parseToolGroups(config.toolGroups)` 拿到 `[]` ⇒ 空集 ⇒ `applyBrowserTools` 注册
 * **0** 个工具，而 system prompt 的 `tool:browser` 指引照旧宣称 31 个工具存在：
 * 模型被明确告知有浏览器工具，逐个调用都会 "unknown tool"（静默功能全失）。
 *
 * **为什么旧判据不承重**：`tests/tool-groups-policy.spec.ts` 只调
 * `parseToolGroups(undefined)` 与 `Config({ toolGroups: [] })`（显式键），**从不经过
 * `Config({})` / `Config({ appOriginScheme })`**，所以取不到"schema 把缺键变成 `[]`"
 * 这一步；全量 browser 套件 727/727 绿也看不见这个回归（V6 实测）。本文件因此只钉
 * **生产形态**（缺键经真 schema / 真 cordis 之后的注册面），函数层语义仍由
 * `tool-groups-policy.spec.ts` 覆盖。
 *
 * 三条判据各钉一件事：
 *  1. `Config({})` 与 `Config({ appOriginScheme })` ⇒ 注册 **31** 个工具（全开）；
 *  2. 显式 `[]` ⇒ 注册 **0** 个工具（R21 F-02 的语义不许回退成"回落全开"）；
 *  3. **接线面**：`src/index.ts` 的唯一调用点确实把经 schema 归一化的
 *     `config.toolGroups` 交给 `parseToolGroups`（V6 F5：判据钉在函数层，函数与真实
 *     调用点之间那一步无人守）。
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { DEFAULT_GROUPS, applyBrowserTools, parseToolGroups } from '../src/tools.ts'

/**
 * 生产装配注入的 config 形态（`packages/host/desktop/src/profile.ts` 的
 * `BROWSER_ROW_ID` 分支：只有 `appOriginScheme` 一个键）。
 */
const PRODUCTION_CONFIG = { appOriginScheme: 'picoaide-app' } as const

/** 工具面大小（V6 2026-09-26 实测 31 = `tools.ts` 的 `GROUP_OF` 键数）。 */
const TOOL_COUNT = 31

/** 用真的 `applyBrowserTools` 收集"会被注册进模型工具面"的工具名（能力断言）。 */
function registeredTools(groups: ReadonlySet<string>): string[] {
  const names: string[] = []
  const ctx = {
    tools: { register: (definition: { name: string }) => { names.push(definition.name); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  applyBrowserTools(ctx, {} as never, groups)
  return names
}

/** 取 `Config` 归一化之后的 `toolGroups`（= cordis 传给 `apply` 的那一份）。 */
function normalizedToolGroups(input: Record<string, unknown>): string[] | undefined {
  return (Config(input as never) as { toolGroups?: string[] }).toolGroups
}

describe('R22 V6 F1：生产装配形态（缺键经 schema）必须注册全部浏览器工具', () => {
  it('Config({}) ⇒ 缺键不得被物化成 []，注册面 = 全开 31 个', () => {
    const groups = normalizedToolGroups({})
    // 第一层：schema 层。缺键被物化成 `[]` 就是本 P0 的成因。
    expect(groups).not.toEqual([])
    expect([...(groups ?? [])].sort()).toEqual([...DEFAULT_GROUPS].sort())
    // 第二层：**能力面**（真正决定模型能看见什么的那一步，不是只断言解析结果）。
    const registered = registeredTools(parseToolGroups(groups))
    expect(registered).toHaveLength(TOOL_COUNT)
    expect(registered).toContain('browser_open')
    expect(registered).toContain('browser_eval')
  })

  it('Config({ appOriginScheme })（生产 profile 的真实形态）⇒ 注册 31 个工具', () => {
    const groups = normalizedToolGroups({ ...PRODUCTION_CONFIG })
    expect(registeredTools(parseToolGroups(groups))).toHaveLength(TOOL_COUNT)
  })

  it('真 cordis：ctx.plugin 把 schema 归一化后的 config 交给 apply ⇒ 注册 31 个（端到端装配面）', async () => {
    const registered: string[] = []
    const seen: Array<string[] | undefined> = []
    const plugin = {
      name: 'r22-tool-groups-production',
      Config,
      apply: (_ctx: Context, config: { toolGroups?: string[] }) => {
        seen.push(config.toolGroups)
        registered.push(...registeredTools(parseToolGroups(config.toolGroups)))
      },
    }
    const ctx = new Context()
    ctx.plugin(plugin as never, { ...PRODUCTION_CONFIG } as never)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seen).toHaveLength(1)
    expect(registered).toHaveLength(TOOL_COUNT)
  })

  it('反向：显式 [] 仍然全关（R21 F-02 的语义不得回退）', () => {
    const groups = normalizedToolGroups({ toolGroups: [] })
    expect(groups).toEqual([])
    expect(registeredTools(parseToolGroups(groups))).toEqual([])
  })

  it('反向：显式合法列表按字面生效（缺省补齐不得变成"总是全开"）', () => {
    const groups = normalizedToolGroups({ toolGroups: ['read'] })
    expect(groups).toEqual(['read'])
    const registered = registeredTools(parseToolGroups(groups))
    expect(registered.length).toBeGreaterThan(0)
    expect(registered).toContain('browser_get_snapshot')
    expect(registered).not.toContain('browser_eval')
    expect(registered.length).toBeLessThan(TOOL_COUNT)
  })
})

describe('R22 V6 F5：装配层接线（schema → 调用点）', () => {
  it('index.ts 的唯一调用点消费经 schema 归一化的 config.toolGroups，且 schema 自带缺省', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    // 1) schema 自己带缺省 —— 缺省不许靠调用点的 `?? DEFAULT_GROUPS` 兜
    //    （那样"显式 []"与"缺键"又会被混成一件事）。
    expect(source).toMatch(/toolGroups:\s*z\.array\(z\.string\(\)\)\.default\(/)
    // 2) 唯一调用点逐字把 `config.toolGroups` 交给 `parseToolGroups`（不是绕过它用
    //    模块常量、也不是取别的键）。
    expect(source).toContain('applyBrowserTools(ctx, runtime, parseToolGroups(config.toolGroups))')
    // 3) 反向：`config.toolGroups` 在 index.ts 里只允许出现这一处 —— 第二处就是
    //    "绕过 schema 的第二条取值路径"（V6 F5 的那道缝）。
    expect([...source.matchAll(/config\.toolGroups/gu)]).toHaveLength(1)
  })
})
