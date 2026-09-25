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
 *  ①每个形态都必须落盘（短名内联 / 13 字内联 / 14 字摘要三条都对同一件事断言 ——
 *    短名那条是**非空转对照**：文件存在这条断言本身是可满足的）；
 *  ②磁盘上的会话目录名逐字等于上游 `encodeSegment(id)` 的镜像（把"真后端用了哪个名字"
 *    钉在判据里，而不是我们自己的假设）；
 *  ③该目录名的字节数 == `encodedSessionIdBytes(id)` 且 ≤ 255 —— 于是 `ai-chat.ts` 的预算
 *    算术被**真后端的产物**验证（算错就会在这里红）。
 *
 * 变异验证（拆掉即红）：把 `hiddenSessionId` 的预算判断去掉（一律内联）⇒ "14 字"那条红在
 * ①（0 文件，正是 C-03 的症状）；把 `encodedSessionIdBytes` 的 5 字节口径改成 1 ⇒ ③红。
 */
import { readdirSync } from 'node:fs'
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
} from '../../wasm-apps-host/src/ai-chat.ts'
import { WAIT_BUDGETS } from './wait-budgets.ts'

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
 * 跑一轮并返回磁盘证据（真持久化后端 + 真 runner）。
 * @param user - 账号名（本用例的变量就是它的编码后长度）。
 * @param appId - app_id。
 * @returns 会话 id、磁盘上的会话目录名（取到 0 个则 `undefined`）。
 */
async function sessionOnDisk(user: string, appId: string): Promise<{ id: string, dirName: string | undefined, files: number }> {
  const root = mkdtempSync(join(tmpdir(), 'r14c03-session-id-'))
  roots.push(root)
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
  const id = hiddenSessionId({ userId: user, serverURL: 'https://harness.example.com' }, appId)
  await runner.run({
    sessionId: id,
    appId,
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: () => {},
    signal: new AbortController().signal,
  })
  const dirName = upstreamEncodeSegment(id)
  // 现象：会话产物要穿过真实磁盘（header 落盘 + zstd flush），`run` 返回时还不一定可见。
  await expect.poll(() => countFiles(root), { timeout: WAIT_BUDGETS.REAL_IO_MS }).toBeGreaterThan(0)
  return { id, dirName: directoryNames(root, dirName)[0], files: countFiles(root) }
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

  it('②13 个中文字符（内联 252B，真机落得下）：落盘', async () => {
    const { id, dirName } = await sessionOnDisk('张'.repeat(13), 'a'.repeat(20))
    expect(id).not.toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    expect(dirName, '磁盘上没有按上游规则命名的会话目录').toBeDefined()
    expect(encodedSessionIdBytes(id)).toBe(252)
    expect(Buffer.byteLength(dirName as string)).toBe(encodedSessionIdBytes(id))
  })

  it('③14 个中文字符（内联 266B 落不下）：换摘要形态后落盘（修复前是 0 个文件 + run 成功）', async () => {
    const { id, dirName, files } = await sessionOnDisk('张'.repeat(14), 'a'.repeat(20))
    // 形态：换成定长摘要段（否则 266B > 255 必然 ENAMETOOLONG）。
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
