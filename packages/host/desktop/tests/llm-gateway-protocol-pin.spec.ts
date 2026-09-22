/**
 * 「企业网关必须走 chat-completions」的组装期判据。
 *
 * 背景（现场事故 2026-09-22，客户机）：上游 0.1.6 给 `llm-deepseek` 加了 `protocol`
 * 且**缺省值是 `messages`**；那条协议路径只发 `x-api-key`、不发 `Authorization`
 * （`protocols/messages/adapter.ts`），而我们的网关 `/v1/*` 挂在 `BearerAuth` 下、
 * 只认 `Authorization: Bearer …` ⇒ 每个模型请求 401 `AUTH_REQUIRED`「缺少认证令牌」。
 * 修法是在**组装期**（enterprise patch 的 `llm-deepseek` 行 config）钉死
 * `chat-completions`：这一层不经过 settings 落盘，因此不受"settings 写不进去"
 * 影响（另一条运行期写入路径 `gateway-model.sync` 恰恰会因此失效 —— 那正是本次
 * 事故里"本该修好链路的那一行写不进去"的原因）。
 *
 * 为什么必须钉在**组合结果**上而不是只查 patch 文本：patch 对不存在的行 id 只 warn
 * 不报错，`config` 又是**整键替换**——任何一次上游行改名、补丁层顺序变化或后续层
 * 覆盖，都会让"文本里有这一行"与"跑起来真的是这个值"分叉。本用例组装真实的桌面
 * profile（真 bundle + 真 patch 链）后直接读那一行的 config。
 *
 * 三条反证/边界（保证判据有牙且边界是**有意**的）：
 *  ① 摘掉这条 patch 后同一行必须没有 config（也就是退回上游缺省 `messages`）；
 *  ② base 行**自己没有 config**——所以这条单键 patch 不会挤掉别人的键；哪天上游
 *     给这行加了 config，本用例会红，提醒把 pin 改成合并而不是替换；
 *  ③ 更晚的层（用户 `$DSH_HOME/cordis.patch.yml`）**仍然可以覆盖**它 —— 这是有意的
 *     逃生门，不是漏洞；`config` 是整键替换，所以覆盖这一行时**必须重述 protocol**
 *     （只写 `models` 会把 pin 一起换掉 ⇒ 回落 `messages`；用例把这条口径写死）。
 *     注意逃生门**只在未登录/离线时持久**：有会话之后 `gateway-model` 的 sync 会把
 *     user 层的 `protocol: chat-completions` 写回去（user 层压 base），要长期改协议得改
 *     渠道/组合层（`packages/host/enterprise/src/gateway-model.ts`）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { prepareDesktopProfile } from '../src/profile.ts'

const require = createRequire(import.meta.url)
const homes: string[] = []

/** `llm-deepseek` 行 config 的类型（= 上游 schema 解析后的部分覆盖，组装层给的就是这种）。 */
type DeepSeekRowConfig = Partial<ReturnType<typeof DeepSeekConfig>>

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-llm-protocol-pin-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * 现场形态的 `settings.yaml`（0.1.5 线写入的那一段）：**没有 `protocol` 键**，
 * 字段是 `baseURL/apiKeyEnv/models/reasoningEffort`（域名用保留占位符）。
 */
const FIELD_SHAPE_SETTINGS_YAML = [
  'llm-deepseek:',
  '  {',
  '    baseURL: https://harness.example.com/v1,',
  '    apiKeyEnv: PICOAI_GATEWAY_TOKEN,',
  '    models:',
  '      [',
  '        {',
  '            id: smoke-model,',
  '            name: smoke-model,',
  '            maxTokens: 4096,',
  '            inputModalities: [ text ]',
  '          }',
  '      ],',
  '    reasoningEffort: max',
  '  }',
  '',
].join('\n')

/** 组装真实桌面 profile，返回 `llm-deepseek` 行 + 组装期被跳过的补丁告警。 */
async function assemble(options: {
  omitRowPin?: boolean
  homePatch?: string
  home?: string
} = {}): Promise<{ row: { id?: string, config?: DeepSeekRowConfig } | undefined, warnings: string[] }> {
  const home = options.home ?? temporaryHome()
  if (options.homePatch !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), options.homePatch)
  const prepared = await prepareDesktopProfile(undefined, home, process.platform)
  const layers = options.omitRowPin
    ? prepared.patches.filter(patch => (patch as { id?: string }).id !== 'llm-deepseek')
    : prepared.patches
  const warnings: string[] = []
  // composeEntries 的告警**默认静默**：patch 打在不存在的行上只 warn 不报错，正是
  // "补丁在、配置不在"的形态。这里把告警收下来一起断言。
  const rows = composeEntries([layers], message => warnings.push(message))
  return { row: rows.find(candidate => candidate.id === 'llm-deepseek'), warnings }
}

/**
 * 用真实的 `FileSettingsProvider` 读一份 `settings.yaml`，并按桌面组合的 base 解析
 * `llm-deepseek` —— 与运行期 `ctx.settings` 走的是同一条 "schema 缺省 → base → user"
 * 路径（provider 在自己的 `Service.init` 里 load + publish）。
 * @param home - 已写入 `settings.yaml` 的数据根。
 * @param base - 组装期的行 config。
 * @returns 解析后的 `llm-deepseek` 值。
 */
async function resolveWithUserLayer(
  home: string,
  base: DeepSeekRowConfig | undefined,
): Promise<ReturnType<typeof DeepSeekConfig>> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, { dshHome: home, watch: false })
  try {
    await fiber
    // `exactOptionalPropertyTypes` 下不能传 `{ base: undefined }`：缺省 base 时就别传这个键。
    const scope = base === undefined
      ? ctx.settings.register('llm-deepseek', DeepSeekConfig)
      : ctx.settings.register('llm-deepseek', DeepSeekConfig, { base })
    return scope.get()
  } finally {
    await fiber.dispose()
  }
}

/** 企业覆盖层的行 config（与运行时 profile.ts 读的是同一个文件）。 */
function enterpriseRowConfig(id: string): unknown {
  const patchPath = join(
    dirname(require.resolve('@picoaide/dsh-enterprise/package.json')),
    'cordis.patch.yml',
  )
  const entries = parseYaml(readFileSync(patchPath, 'utf8')) as Array<{ id?: string, config?: unknown }>
  return entries.find(entry => entry.id === id)?.config
}

describe('enterprise gateway protocol pin', () => {
  it('pins protocol=chat-completions on the assembled llm-deepseek row', async () => {
    const { row, warnings } = await assemble()
    expect(row, 'the assembled profile must contain the llm-deepseek row').toBeDefined()
    // 组装期没有任何"补丁打空"的告警：钉错行 id 时这里先红，比只断言 config 更好定位。
    expect(warnings.filter(message => message.includes('llm-deepseek'))).toEqual([])
    // 深等（不是只查 protocol）：多了/少了键都会红 —— `config` 是整键替换，多出来的键
    // 只能是有人往这条 patch 里加了东西。
    expect(row?.config).toEqual({ protocol: 'chat-completions' })
  })

  it('carries the pin in the enterprise patch layer', () => {
    // 组合结果对、但补丁文本没写（例如被别的层顺手注入）时，这条会指出是哪一层丢了。
    expect(enterpriseRowConfig('llm-deepseek')).toMatchObject({ protocol: 'chat-completions' })
  })

  it('documents why the pin exists: the upstream default is the Messages protocol', () => {
    // 缺省值就是"每个模型请求 401"：缺省 protocol=messages，而 messages 适配器只发
    // x-api-key、不发 Authorization。上游改这个缺省值时本用例变红 —— 那是重看这层
    // pin（是否还需要）的信号，不是可以顺手改掉的噪音。
    expect(DeepSeekConfig({}).protocol).toBe('messages')
  })

  it('a stored user section without protocol does not shadow the pin (the field shape)', async () => {
    // 现场形态：settings.yaml 里的 `llm-deepseek` 段由 0.1.5 线写入，**没有 protocol**。
    // 组装层是 base，user 层缺键不该盖掉它 —— 这是"升级即好"的关键一层。这里用真实的
    // FileSettingsProvider 读磁盘上的 settings.yaml（不是手搓 section 对象），走的就是
    // 运行期 `ctx.settings` 的同一条解析路径。
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), FIELD_SHAPE_SETTINGS_YAML)
    const { row } = await assemble({ home })
    const resolved = await resolveWithUserLayer(home, row?.config)
    expect(resolved.protocol).toBe('chat-completions')
    // 用户的字段一个都不能丢（拼错层会让 baseURL/apiKeyEnv 变回 schema 缺省）。
    expect(resolved.baseURL).toBe('https://harness.example.com/v1')
    expect(resolved.apiKeyEnv).toBe('PICOAI_GATEWAY_TOKEN')
    expect(resolved.models?.map(model => model.id)).toEqual(['smoke-model'])
    expect(resolved.reasoningEffort).toBe('max')
  })

  it('a user section with an explicit protocol still wins (the documented escape hatch)', async () => {
    // 同一条真实路径的另一半：用户层**显式**写 protocol 时它就是最终值 —— 逃生门必须
    // 双向可证，否则上一条用例无法区分"base 赢"与"user 层根本没被读到"。
    const home = temporaryHome()
    writeFileSync(
      join(home, 'settings.yaml'),
      ['llm-deepseek:', '  { protocol: messages, baseURL: https://harness.example.com/v1 }', ''].join('\n'),
    )
    const { row } = await assemble({ home })
    expect((await resolveWithUserLayer(home, row?.config)).protocol).toBe('messages')
  })

  it('reverse control: without the pin the same stored section resolves to messages', async () => {
    // 变异验证：摘掉组装期的 pin 后，**同一份**现场 settings.yaml 解析成 messages
    // （= 现场事故里适配器实际发出的请求）。证明上一条的 chat-completions 真由 pin 决定。
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), FIELD_SHAPE_SETTINGS_YAML)
    const { row } = await assemble({ home, omitRowPin: true })
    expect((await resolveWithUserLayer(home, row?.config)).protocol).toBe('messages')
  })

  it('reverse control: without the pin the row falls back to the upstream default', async () => {
    // 变异验证：删掉 enterprise 的这条 patch 后，同一行必须**没有** config ——
    // 证明上面那条断言真的由这条 pin 决定，而不是别的层恰好也写了。
    const { row } = await assemble({ omitRowPin: true })
    expect(row?.config).toBeUndefined()
    // 上游 schema 把它补成 messages —— 与生产事故里适配器实际发出的请求一致。
    const upstreamResolved = DeepSeekConfig(row?.config ?? {})
    expect(upstreamResolved.protocol).toBe('messages')
  })

  it('reverse control: the base row owns no config of its own (so the single-key patch cannot drop keys)', async () => {
    // `config` 是整键替换：只有 base 行**自己没有** config 时，这条单键 patch 才是安全的。
    // 上游哪天给这行加了 config（例如 apiKeyEnv/defaultContextWindow），本用例会红，
    // 提醒把 pin 改成合并而不是替换。
    const { row } = await assemble({ omitRowPin: true })
    expect(row).toBeDefined()
    expect(row?.config).toBeUndefined()
  })

  it('a later layer (home patch) still overrides the pin on purpose', async () => {
    // 逃生门：`$DSH_HOME/cordis.patch.yml` 是最后应用的层，运维想显式改协议可以覆盖。
    // 注意它**只在未登录/离线时持久**：有会话之后 `gateway-model` 的 sync 会把 user 层的
    // `protocol: chat-completions` 写回去（user 层压 base）—— 见下面那条整键替换用例与文件头。
    const { row } = await assemble({
      homePatch: ['- id: llm-deepseek', '  config:', '    protocol: messages', ''].join('\n'),
    })
    expect(row?.config).toEqual({ protocol: 'messages' })
    expect(DeepSeekConfig(row?.config ?? {}).protocol).toBe('messages')
  })

  it('home patch replacement is whole-key: touching another key drops the pin (documented hazard)', async () => {
    // `config` 是**整键替换**，而 home patch 是最后应用的层：只想换 models 的运维补丁
    // 会把 pin 一起换掉 ⇒ 解析回 `messages` ⇒ 网关 401（本次事故的形态）。这不是可以
    // 静默过去的边界，所以在这里把口径写死：
    //  · 组装层会保留 pin（上面几条）；
    //  · 覆盖这一行 config 的补丁**必须重述** `protocol: chat-completions`；
    //  · 兜底是运行期的 `gateway-model.sync`（每次会话变更把 protocol 写回 **user 层**，
    //    而 user 层优先于 base）；真正复现 401 需要"覆盖了该行 config"且"settings
    //    落盘同时失败"—— 正是本次事故的组合（写锁被孤儿锁挡死）。
    const { row } = await assemble({
      homePatch: [
        '- id: llm-deepseek',
        '  config:',
        '    models:',
        '      - id: user-model',
        '        name: user-model',
        '',
      ].join('\n'),
    })
    expect(row?.config).toEqual({ models: [{ id: 'user-model', name: 'user-model' }] })
    expect(DeepSeekConfig(row?.config ?? {}).protocol).toBe('messages')

    // 正例：按口径重述 protocol 的补丁既换掉 models、又保住网关协议。
    const kept = await assemble({
      homePatch: [
        '- id: llm-deepseek',
        '  config:',
        '    protocol: chat-completions',
        '    models:',
        '      - id: user-model',
        '        name: user-model',
        '',
      ].join('\n'),
    })
    expect(DeepSeekConfig(kept.row?.config ?? {}).protocol).toBe('chat-completions')
  })
})
