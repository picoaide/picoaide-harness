/**
 * 「桌面组合的网关模型行」的组装期判据。
 *
 * 演变（两段都得记住）：
 *  · **0.1.6**：`llm-deepseek` 新增 `protocol`，缺省 `messages`；messages 路径只发
 *    `x-api-key`、不发 `Authorization`，而我们的网关 `/v1/*` 挂在 `BearerAuth` 下 ⇒
 *    每个模型请求 401「缺少认证令牌」（2026-09-22 现场事故）。当时的修法是在组装期
 *    钉死 `protocol: chat-completions`。
 *  · **0.1.7-rc.2**：`protocol` **被删除**，不再是可配置项，配了直接抛错
 *    （`llm-deepseek/src/config.ts:207` → `llm-deepseek: protocol is not configurable;
 *    remove it and use a Messages-compatible baseURL`）。适配器只剩 Messages 一条路径，
 *    鉴权改由**注册 provider 的插件**决定（`registerDeepSeekProvider(..., {resolveAuth})`）。
 *    上游的 `x-api-key` 实现 `@deepseek-ai/dsh-llm-deepseek-api-key` 没有换头的接缝 ⇒
 *    组装期禁用那一行，改插自研的 `@picoaide/dsh-enterprise/gateway-llm`（Bearer）。
 *
 * 为什么判据必须落在**组合结果**上：patch 对不存在的行 id 只 warn、`config` 又是整键
 * 替换，任何一层顺手加回 `protocol`（旧文档、旧 settings 段、运维补丁）都会静默复活
 * 这个必抛错的键；同理，"只禁用不插入"（没人注册 provider）和"只插入不禁用"
 * （两个适配器抢同一个路由）都只在真组合里看得出来。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { Config as WebSearchConfig } from '@deepseek-ai/dsh-web-search-deepseek'
import { prepareDesktopProfile } from '../src/profile.ts'

/** 组装期注册网关 provider 的那一行的包名（`cordis.patch.yml` 的 `name`）。 */
const GATEWAY_LLM_ROW_PACKAGE = '@picoaide/dsh-enterprise/gateway-llm'

/** 0.1.7 从 `llm-deepseek` 删掉的键（配了整行激活即抛错）。 */
const REMOVED_PROTOCOL_KEY = 'protocol'

/**
 * 企业插件的组装补丁（本组合的一层）**原文**。
 *
 * 这里刻意**不** import `@picoaide/dsh-enterprise/gateway-llm` 取常量：CI 的 gate job 里
 * desktop 的 check 排在 enterprise 之前、那一刻 enterprise 的 `lib/` 还不存在
 * （`scripts/check-workspaces.mjs:269` 的调度注释），而这条判据要的只是"组合里那一行的 id"。
 * 读这一层补丁的**原文**（真 YAML 解析）反而更硬：它同时钉住"补丁真写了这个 id"与
 * "组合结果里就是这个 id"；enterprise 包自己的用例再把它的常量与这份 YAML 对拍。
 */
const GATEWAY_LLM_PATCH = new URL('../../enterprise/cordis.patch.yml', import.meta.url)

interface PatchEntry { id?: unknown, name?: unknown, disabled?: unknown, config?: unknown, insert?: unknown }

/** 读企业补丁的原文（真 YAML 解析，不是字符串 grep）。 */
function gatewayLlmPatch(): { entries: PatchEntry[], inserted: PatchEntry[] } {
  const entries = parseYaml(readFileSync(GATEWAY_LLM_PATCH, 'utf8')) as PatchEntry[]
  const inserted: PatchEntry[] = []
  for (const entry of entries) {
    if (!Array.isArray(entry.insert)) continue
    for (const candidate of entry.insert) inserted.push(candidate as PatchEntry)
  }
  return { entries, inserted }
}

/** 组装期那一行（企业补丁 insert 的那条 `gateway-llm`）的 id。 */
function declaredGatewayRowId(): string {
  const declared = gatewayLlmPatch().inserted.filter(entry => entry.name === GATEWAY_LLM_ROW_PACKAGE)
  expect(declared, `企业补丁必须恰插入一条 ${GATEWAY_LLM_ROW_PACKAGE}`).toHaveLength(1)
  const id = declared[0]?.id
  expect(typeof id, '插入行必须有 id（0.1.7 起 id 就是设置命名空间）').toBe('string')
  return id as string
}

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-llm-protocol-pin-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface Row { id?: string, name?: string, config?: Record<string, unknown>, disabled?: unknown }

/** 组装真实桌面 profile，返回按 id 索引的行 + 组装期被跳过的补丁告警。 */
async function assemble(options: {
  homePatch?: string
  home?: string
} = {}): Promise<{ rows: Map<string, Row>, warnings: string[] }> {
  const home = options.home ?? temporaryHome()
  if (options.homePatch !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), options.homePatch)
  const prepared = await prepareDesktopProfile(undefined, home, process.platform)
  const warnings: string[] = []
  // composeEntries 的告警**默认静默**：patch 打在不存在的行上只 warn 不报错，正是
  // "补丁在、配置不在"的形态。这里把告警收下来一起断言。
  const composed = composeEntries([prepared.patches], message => warnings.push(message)) as Row[]
  const rows = new Map<string, Row>()
  for (const row of composed) if (typeof row.id === 'string') rows.set(row.id, row)
  return { rows, warnings }
}

/** 上游适配器解析一步：`Config` 校验 → 请求选项（`protocol` 就是在这里被拒）。 */
function adapterOptions(config: object): unknown {
  return resolveAdapterOptions(plainOptions(DeepSeekConfig(config)))
}

describe('desktop composition vs the removed llm-deepseek protocol selector', () => {
  it('upstream rejects a protocol key outright (the reason the old pin had to go)', () => {
    // 判据驱动的是**上游真实代码路径**（schema → resolveAdapterOptions），不是字符串。
    expect(() => adapterOptions({ [REMOVED_PROTOCOL_KEY]: 'chat-completions' }))
      .toThrow('protocol is not configurable')
    // 反向对照：同一份选项去掉 `protocol` 就能解析 —— 证明上一条的抛错只由这个键引起。
    expect(() => adapterOptions({ baseURL: 'https://harness.example.com/v1' })).not.toThrow()
  })

  it('组合把网关 provider 行插进来、把上游 x-api-key 行禁掉，且都不带 protocol', async () => {
    const { rows, warnings } = await assemble()
    const gatewayRowId = declaredGatewayRowId()
    const gateway = rows.get(gatewayRowId)
    expect(gateway, 'the assembled profile must contain the gateway provider row').toBeDefined()
    // 组合结果里的行 id = 企业补丁 insert 的 id（0.1.7 起 id 就是设置命名空间，
    // `gateway-model.ts`/`bootstrap.ts` 按同一个常量写入 baseURL/models）。
    expect(gateway?.name).toBe(GATEWAY_LLM_ROW_PACKAGE)
    expect(gateway?.disabled).toBeFalsy()
    // 组装期没有任何"补丁打空"的告警：钉错行 id 时这里先红，比只断言 config 更好定位。
    expect(warnings.filter(message => message.includes(gatewayRowId) || message.includes('llm-deepseek'))).toEqual([])
    // 上游那一行必须被禁用：留着它 = 两个适配器抢 `deepseek-official` 路由
    // （`LlmRuntime.registerAdapter` 会以 DUPLICATE_ADAPTER 拒绝第二个）。
    expect(rows.get('llm-deepseek')?.disabled).toBe(true)
    // 两行都不能带 0.1.7 已删除的 `protocol` 键。
    expect(Object.hasOwn(gateway?.config ?? {}, REMOVED_PROTOCOL_KEY)).toBe(false)
    expect(Object.hasOwn(rows.get('llm-deepseek')?.config ?? {}, REMOVED_PROTOCOL_KEY)).toBe(false)
    // 上游 schema 也不再为这个键补缺省值 —— 0.1.6 的"缺省即 messages"已不存在。
    expect(Object.hasOwn(DeepSeekConfig({}), REMOVED_PROTOCOL_KEY)).toBe(false)
    // 网关行插进来了就得能被解析（baseURL 由运行期写入，这里只证 schema 接受这份 config）。
    expect(() => adapterOptions(gateway?.config ?? {})).not.toThrow()
    // 企业补丁**原文**也不得在任何一行 config 里写 `protocol`（写在企业包里、组合时抛错，
      // 与本判据是两个观测点：一个在源、一个在组合结果）。
    const declared = gatewayLlmPatch()
    for (const entry of [...declared.entries, ...declared.inserted]) {
      expect(Object.hasOwn((entry.config ?? {}) as object, REMOVED_PROTOCOL_KEY)).toBe(false)
    }
  })

  it('反向对照：任何一层加回 protocol 都会到达组合并被上游拒绝', async () => {
    // 变异/反向对照：证明上一条不是因为"这一行根本没有 config"才通过 ——
    // 真加回 `protocol` 时它必须原样出现在组合结果里（于是激活即抛错，本判据有牙）。
    const { rows } = await assemble({
      homePatch: ['- id: llm-deepseek', '  config:', '    protocol: chat-completions', ''].join('\n'),
    })
    expect(rows.get('llm-deepseek')?.config).toMatchObject({ [REMOVED_PROTOCOL_KEY]: 'chat-completions' })
    expect(() => adapterOptions(rows.get('llm-deepseek')?.config ?? {}))
      .toThrow('protocol is not configurable')
  })

  it('同一链路第二处（web-search-deepseek）：0.1.7 里没有 protocol，apiKeyEnv 仍是网关令牌', async () => {
    // 历史上这条链路有两处：chat（`llm-deepseek`）与 web_search（`web-search-deepseek`，
    // 同样打网关 `/v1/messages`）。0.1.7 的删除面**只涉及 `llm-deepseek`**；web-search 从来
    // 没有过 `protocol`，它的 `apiKeyEnv`/`baseURL`/`model` 三个键仍然存在且都是 volatile，
    // 请求头本来就同时发 `x-api-key` 与 `authorization: Bearer`
    // （`web-search-deepseek/src/provider.ts:228-231`）⇒ 只换 chat 那一条就够，这里是它的判据。
    const { rows, warnings } = await assemble()
    const row = rows.get('web-search-deepseek')
    expect(row, 'the assembled profile must contain the web-search row').toBeDefined()
    expect(warnings.filter(message => message.includes('web-search-deepseek'))).toEqual([])
    expect(row?.config).toMatchObject({ apiKeyEnv: 'PICOAI_GATEWAY_TOKEN' })
    // 真 schema：这份 config 必须被 web-search 行自己的 Config 接受，且它不认识 `protocol`。
    const resolved = WebSearchConfig(row?.config ?? {}) as unknown as {
      apiKeyEnv: { get: () => string }
      protocol?: unknown
    }
    expect(resolved.apiKeyEnv.get()).toBe('PICOAI_GATEWAY_TOKEN')
    expect(Object.hasOwn(resolved, REMOVED_PROTOCOL_KEY)).toBe(false)
  })
})

/*
 * 未做项（DEFERRED）：
 *  · 真机（打包版 Electron + 真 Go 服务端）的 `/v1/messages` 端到端 401/200 对照属于
 *    网关泳道的探针，见 `temp/r4/`；本文件只钉组装期事实。
 */
