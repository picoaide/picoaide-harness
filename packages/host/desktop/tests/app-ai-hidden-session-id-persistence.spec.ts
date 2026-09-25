/**
 * R14 C-03（P2）**端到端**判据：隐藏会话必须**真的落盘**（不是"run 返回成功但没有文件"）。
 *
 * 单元判据在 `packages/host/wasm-apps-host/src/ai-chat-session-id-budget.spec.ts`（形状与
 * 预算算术）；本文件补的是它测不到的那一半 —— **真的写盘**：真 Cordis + 真 agent loop +
 * 真 `SessionPersistenceJsonl` + 真 `createAppAiRunner`，然后**以磁盘为 oracle**：
 *
 *  - 修复前（14 个中文字符的账号名）：`run => resolved` 而 `files under root: 0`
 *    （目录名 266B > 255 ⇒ `ENAMETOOLONG`，错误浮不出来）；
 *  - 修复后：id 换成定长摘要段（78B），文件真的出现。
 *
 * 判据：
 *  ①每个形态都必须落盘（短名内联 / 12 字内联 / 13 字摘要三条都对同一件事断言 ——
 *    短名那条是**非空转对照**：文件存在这条断言本身是可满足的）；
 *  ②磁盘上的会话目录名逐字等于上游 `encodeSegment(id)` 的镜像（把"真后端用了哪个名字"
 *    钉在判据里，而不是我们自己的假设）；
 *  ③该目录名的字节数 == `encodedSessionIdBytes(id)` 且 ≤ 244 —— 于是 `ai-chat.ts` 的预算
 *    算术被**真后端的产物**验证（算错就会在这里红）。
 *
 * ## R14 VB-N1（本文件第二个 describe）
 *
 * 上面这三条全是"新 root + 单轮"，正好绕过真正的生产形态：**会话根里已经存在项目目录**
 * 时，上游 `findLog()` 会对每个项目目录先做一次 `exists(encodeSegment(id) + '.jsonl.zstd')`
 * 的 legacy flat 探测（+11 字节，只吞 `ENOENT`）⇒ 245..255 这一段**每一轮**都
 * `ENAMETOOLONG`。第二个 describe 用"播种一个项目目录 + 连续多轮"复现该形态，并带一条
 * **非空转对照**：修复前 `hiddenSessionId` 真的会产出的那个内联 id 在同样的 root 上必然
 * 失败（否则"修复后的判据绿"可能只是因为这条语料本来就没人踩过）。
 *
 * 变异验证（拆掉即红）：把 `hiddenSessionId` 的预算判断去掉（一律内联）⇒ "13 字"那条红在
 * ①（0 文件，正是 C-03 的症状）；把预算常量改回 255 ⇒ VB-N1 段红（13 字那条会退回内联并
 * 在"有项目目录"的 root 上 ENAMETOOLONG）；把 `encodedSessionIdBytes` 的 5 字节口径改成 1 ⇒ ③红。
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppAiRunner } from '../src/app-ai-runner.ts'
// 直接引**源文件**（不是 `@picoaide/dsh-wasm-apps-host/ai-chat` 的构建产物）：本用例判的就是
// 这次改动的源码，走 lib 会拿旧产物测出假绿（本仓登记过的"本地绿、CI 红"形态）。
import {
  AI_HIDDEN_SESSION_ID_MAX_BYTES,
  AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG,
  encodedSessionIdBytes,
  hiddenSessionId,
  hiddenSessionScope,
} from '../../wasm-apps-host/src/ai-chat.ts'
import { WAIT_BUDGETS } from './wait-budgets.ts'

/** 一个已登录账号 + 服务端（本文件所有语料共用，保证 id 只在"账号段长度"这一个维度上变）。 */
const SCOPE_SERVER = 'https://harness.example.com'

/**
 * 上游 `encodeSegment`（`session-persistence-jsonl/src/format.ts:198`）的**镜像**。
 *
 * 只用于对拍：断言"磁盘上那个目录名 == 我们按上游规则算出来的名字"。镜像写错就在②红
 * —— 所以它不是"又抄一份实现"，而是把真后端的产物当 oracle。
 */
function upstreamEncodeSegment(raw: string): string {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    out += char !== '~' && /^[A-Za-z0-9._-]$/u.test(char) ? char : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 树里所有**名字**等于 `name` 的目录（返回目录名，不是路径 —— 判据比的是名字的字节数）。
 */
function directoryNames(root: string, name: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === name) found.push(entry.name)
      walk(join(dir, entry.name))
    }
  }
  walk(root)
  return found
}

/** 树里的文件总数（"真的落盘了"只看这个）。 */
function countFiles(root: string): number {
  let count = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else count += 1
    }
  }
  walk(root)
  return count
}

/** 一段文本回答的流。 */
class AnsweringAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const roots: string[] = []
const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * 等到磁盘上出现文件（**不抛**：判据由调用方给，免得"等待"本身变成一条空转断言）。
 * @param root - 会话根。
 * @returns 观察到的文件数（超时后仍为 0 就返回 0）。
 */
async function waitForFiles(root: string): Promise<number> {
  const deadline = Date.now() + WAIT_BUDGETS.REAL_IO_MS
  let files = countFiles(root)
  while (files === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    files = countFiles(root)
  }
  return files
}

/**
 * 播种**生产形态**：会话根里已经存在一个别人的项目目录。
 *
 * 为什么这一条是 VB-N1 的关键：上游 `findLog()` 对 root 下**每一个**项目目录都先做一次
 * legacy flat 探测 `exists(join(project, encodeSegment(id) + '.jsonl.zstd'))`（比目录名多
 * 11 字节、只吞 `ENOENT`）。空 root（本文件第一个 describe 的形态）**没有**项目目录，
 * 于是探测不跑、245..255 的 id 看起来"第一轮成功"——第二轮才失败。真实用户有工作区就
 * 会有项目目录，所以这才是常态。
 */
function seedProjectDirectory(root: string): void {
  mkdirSync(join(root, 'some-workspace'), { recursive: true })
}

/** 一次落盘观察的磁盘证据。 */
interface SessionEvidence {
  /** 平台给出的隐藏会话 id。 */
  readonly id: string
  /** 每一轮的结果（`resolved` 或 `threw:<原因>`）。 */
  readonly outcomes: readonly string[]
  /** 磁盘上的会话目录名（取到 0 个则 `undefined`）。 */
  readonly dirName: string | undefined
  /** 树里的文件总数。 */
  readonly files: number
}

/**
 * 在**同一个 root** 上跑 N 轮并返回磁盘证据（真持久化后端 + 真 runner）。
 * @param user - 账号名（本用例的变量就是它的编码后长度）。
 * @param appId - app_id。
 * @param options - `id`（覆盖平台算出的 id，用于"修复前形态"对照）/ `projectDir`（播种项目目录）/ `turns`（轮数）。
 * @returns 会话 id、逐轮结果、磁盘上的会话目录名、文件数。
 */
async function sessionOnDisk(
  user: string,
  appId: string,
  options: { id?: string, projectDir?: boolean, turns?: number } = {},
): Promise<SessionEvidence> {
  const root = mkdtempSync(join(tmpdir(), 'r14c03-session-id-'))
  roots.push(root)
  if (options.projectDir === true) seedProjectDirectory(root)
  const ctx = new Context()
  live.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  await ctx.plugin(SessionPersistenceJsonl, { root })
  ctx.llm.registerAdapter(['mock'], new AnsweringAdapter())
  const runner = createAppAiRunner(ctx, { cwd: root })
  const id = options.id ?? hiddenSessionId({ userId: user, serverURL: SCOPE_SERVER }, appId)
  const outcomes: string[] = []
  for (let turn = 0; turn < (options.turns ?? 1); turn += 1) {
    try {
      await runner.run({
        sessionId: id,
        appId,
        messages: [{ role: 'user', content: `turn-${String(turn)}` }],
        onDelta: () => {},
        signal: new AbortController().signal,
      })
      outcomes.push('resolved')
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code
      outcomes.push(`threw:${typeof code === 'string' && code !== '' ? code : cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  // 现象：会话产物要穿过真实磁盘（header 落盘 + zstd flush），`run` 返回时还不一定可见。
  // 只在"至少有一轮成功"时才等 —— 全失败（如"修复前形态"的对照）没有待落盘的写入，
  // 干等满预算只会把一条本该毫秒级判红的用例拖成 15 s。
  const files = outcomes.includes('resolved') ? await waitForFiles(root) : countFiles(root)
  return { id, outcomes, dirName: directoryNames(root, upstreamEncodeSegment(id))[0], files }
}

describe('R14 C-03：隐藏会话必须真的落盘（磁盘为 oracle）', () => {
  it('①短账号名（内联形态）：落盘，且目录名 = 上游 encodeSegment(id)', async () => {
    const { id, dirName, files } = await sessionOnDisk('alice', 'demo')
    expect(files).toBeGreaterThan(0)
    // 非空转对照：短名这条走的是内联形态（不换形态 ⇒ 已有会话不断档）。
    expect(id).not.toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    expect(dirName, '磁盘上没有按上游规则命名的会话目录').toBeDefined()
    expect(Buffer.byteLength(dirName as string)).toBe(encodedSessionIdBytes(id))
    expect(Buffer.byteLength(dirName as string)).toBeLessThanOrEqual(AI_HIDDEN_SESSION_ID_MAX_BYTES)
  })

  it('②12 个中文字符（内联 238B ≤ 244）：内联形态落盘', async () => {
    const { id, dirName, files } = await sessionOnDisk('张'.repeat(12), 'a'.repeat(20))
    expect(id).not.toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    expect(dirName, '磁盘上没有按上游规则命名的会话目录').toBeDefined()
    expect(encodedSessionIdBytes(id)).toBe(238)
    expect(Buffer.byteLength(dirName as string)).toBe(encodedSessionIdBytes(id))
    expect(files).toBeGreaterThan(0)
  })

  it('③13 个中文字符（内联 252B > 244）：换摘要形态后落盘（修复前是 0 个文件 + run 成功）', async () => {
    const { id, dirName, files } = await sessionOnDisk('张'.repeat(13), 'a'.repeat(20))
    // 形态：换成定长摘要段（内联 252B 在 NAME_MAX(255) 之下、却过不了 +11 字节的 legacy 探测）。
    expect(id).toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    // 判据本体：文件真的在（修复前这里 0 个）。
    expect(files, 'run 返回成功但磁盘上没有任何会话文件（C-03 的静默丢失）').toBeGreaterThan(0)
    expect(dirName, '磁盘上没有按上游规则命名的会话目录').toBeDefined()
    // 算术被真产物验证：目录名字节数 == 我们算的字节数，且落得下。
    expect(Buffer.byteLength(dirName as string)).toBe(encodedSessionIdBytes(id))
    expect(Buffer.byteLength(dirName as string)).toBeLessThanOrEqual(AI_HIDDEN_SESSION_ID_MAX_BYTES)
    // 归因面不受影响（服务端只读 `#` 之前那段）。
    expect(id.startsWith(`app:${'a'.repeat(20)}#`)).toBe(true)
  })
})

/**
 * R14 **VB-N1**：真正的有效预算是 244 —— 判据必须落在"会话根里已经有项目目录 + 多轮"上。
 *
 * 为什么单独立一节：上面三条全是"新 root + 单轮"，而缺陷恰恰只在有项目目录时显形
 * （空 root 是"第一轮成功、第二轮失败"）。本节的每一条都播种项目目录、都跑多轮。
 */
describe('R14 VB-N1：会话根里有项目目录时的多轮落盘（有效预算是 244）', () => {
  it('①12 个中文字符（内联 238B）：项目目录已存在 + 连续三轮都落盘', async () => {
    const { id, outcomes, dirName, files } = await sessionOnDisk('张'.repeat(12), 'a'.repeat(20), { projectDir: true, turns: 3 })
    expect(id, '238B 在有效预算内，不许提前换形态（换了就是升级断档）').not.toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    expect(outcomes, '内联形态在"有项目目录"的 root 上必须三轮全绿').toEqual(['resolved', 'resolved', 'resolved'])
    expect(files).toBeGreaterThan(0)
    expect(dirName).toBeDefined()
    expect(Buffer.byteLength(dirName as string)).toBe(238)
  })

  it('②13 个中文字符（内联 252B）：换成摘要形态后，项目目录已存在时三轮都落盘', async () => {
    const { id, outcomes, files } = await sessionOnDisk('张'.repeat(13), 'a'.repeat(20), { projectDir: true, turns: 3 })
    expect(id).toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    expect(outcomes).toEqual(['resolved', 'resolved', 'resolved'])
    expect(files).toBeGreaterThan(0)
  })

  it('③非空转对照：修复前会产出的那个内联 id（252B）在同样的 root 上必然失败', async () => {
    const appId = 'a'.repeat(20)
    const scope = { userId: '张'.repeat(13), serverURL: SCOPE_SERVER }
    // 逐字重建**修复前** `hiddenSessionId` 的输出形态（旧预算 255 ⇒ 252B 保持内联）。
    const preFixInlineId = `app:${appId}#${hiddenSessionScope(scope)}`
    expect(encodedSessionIdBytes(preFixInlineId), '前提：这正是 VB-N1 的 245..255 带').toBe(252)

    const control = await sessionOnDisk(scope.userId, appId, { id: preFixInlineId, projectDir: true, turns: 1 })
    // 判据：它**不可能**落盘 —— 探测名 263B > NAME_MAX(255) ⇒ ENAMETOOLONG 从 stat 抛到 run。
    // （这条同时证明 ①②不是恒真：如果连"修复前的 id"都能落盘，那 244 的收窄就无从谈起。）
    expect(control.outcomes[0], '修复前的内联 id 居然落盘了 ⇒ 本节的判据是空转的').toMatch(/ENAMETOOLONG/u)
    expect(control.files, '失败形态下不该有会话文件').toBe(0)
    expect(control.dirName, '失败形态下不该有会话目录').toBeUndefined()

    // 而平台现在为**同一个账号**给出的 id 是摘要形态，它落得下盘（第二节 ② 的同一结论）。
    expect(hiddenSessionId(scope, appId)).not.toBe(preFixInlineId)
  })
})
