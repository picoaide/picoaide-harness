/**
 * AI 桥保留路径的**跨包逐字对拍**（L7 §五② / 接缝 J6）。
 *
 * 真源只有一个：`packages/host/wasm-apps-host/src/ai-chat.ts` 的 `AI_CHAT_PATH`。
 * 客户端半边（`packages/client/wasm-apps/src/client/app-ai.ts` 的 `APP_AI_CHAT_PATH`）
 * 是**另一份字面量** —— 两边各自演化时，"应用页 POST 的路径"与"协议 handler 拦截的
 * 路径"会静默错开：应用拿到 404/HTML，而两端的单测（各自用自己的夹具）**全绿**。
 * 本仓已有 5 个 P0 出自同一失效模式（`header-spec-parity.spec.ts` 的头注释）。
 *
 * 判据（与 `header-spec-parity.spec.ts` 同一写法）：**读对方源码**，逐字比较常量值，
 * 而不是各用各的夹具。
 *
 * 变异验证：把 `ai-chat.ts` 的 `AI_CHAT_PATH` 改成单下划线 `/_picoaide/ai/chat`（§22.1
 * 曾写错的那个形态）⇒ 本用例必红；把客户端常量改成别的路径 ⇒ 必红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AI_CHAT_PATH, AI_HIDDEN_SESSION_PREFIX, AI_CHAT_MAX_MESSAGES, AI_CHAT_MAX_CONTENT_BYTES } from './ai-chat.ts'

const CLIENT_SOURCE = fileURLToPath(new URL('../../../../packages/client/wasm-apps/src/client/app-ai.ts', import.meta.url))

/** 读客户端源码（缺失是失败，不是跳过：静默跳过等于把这条判据关掉）。 */
function clientSource(): string {
  return readFileSync(CLIENT_SOURCE, 'utf8')
}

/** 从源码里取一个字符串常量的字面量值（**故意不 import** 客户端包：跨包 import 会引入
 * 构建依赖，而且"两边都 import 同一个常量"本身就不是对拍 —— 那只证明了一处定义）。 */
function literalOf(source: string, name: string): string | undefined {
  const match = new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`, 'u').exec(source)
  return match?.[1]
}

/** 从源码里取一个数字常量（支持 `64` 与 `16 * 1024` 两种写法；其它形态 ⇒ undefined）。 */
function numberLiteralOf(source: string, name: string): number | undefined {
  const match = new RegExp(`export const ${name}\\s*=\\s*([^\\n]+)`, 'u').exec(source)
  if (match?.[1] === undefined) return undefined
  const expression = match[1].replace(/\/\/.*$/u, '').trim()
  const factors = expression.split('*').map(part => part.trim())
  if (factors.length === 0 || factors.some(part => !/^\d+$/u.test(part))) return undefined
  return factors.reduce((product, part) => product * Number(part), 1)
}

describe('AI 桥保留路径：客户端真源逐字对拍（L7 §五② / J6）', () => {
  it('客户端 APP_AI_CHAT_PATH 逐字等于宿主 AI_CHAT_PATH', () => {
    const raw = clientSource()
    expect(literalOf(raw, 'APP_AI_CHAT_PATH'), `APP_AI_CHAT_PATH must be declared in ${CLIENT_SOURCE}`).toBe(AI_CHAT_PATH)
  })

  it('保留路径是双下划线形态（§21.2 冻结；单下划线是文档里已被订正过的错写）', () => {
    expect(AI_CHAT_PATH).toBe('/__picoaide/ai/chat')
    expect(AI_CHAT_PATH.startsWith('/__picoaide/')).toBe(true)
  })

  it('上下限两端一致（条数 64 / 单条 16 KiB）', () => {
    const raw = clientSource()
    expect(numberLiteralOf(raw, 'APP_AI_MESSAGES_MAX')).toBe(AI_CHAT_MAX_MESSAGES)
    expect(numberLiteralOf(raw, 'APP_AI_MESSAGE_MAX_BYTES')).toBe(AI_CHAT_MAX_CONTENT_BYTES)
  })

  it('隐藏会话前缀两端一致（客户端注释/文档都按同一前缀描述）', () => {
    // 客户端半边不构造会话 id（那是宿主的事），但它把前缀写进了契约注释；这里钉住
    // 宿主值本身，防止"文档写 app:、实现写 pico-app:"这类漂移。
    expect(AI_HIDDEN_SESSION_PREFIX).toBe('app:')
    expect(clientSource()).toContain('app:<app_id>')
  })
})
