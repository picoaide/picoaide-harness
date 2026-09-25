/**
 * R14 C-03（P2）判据：**隐藏会话 id 必须落得下盘，不许静默丢失**。
 *
 * 缺陷形态（真 `hiddenSessionId` + 真 jsonl 持久化，修复前实测）：
 *
 *	CJK=13 … run => resolved files under root: 2
 *	CJK=14 … run => resolved files under root: 0     ← 静默：没有文件、没有报错
 *
 * 机制：会话落盘的目录名是上游 `encodeSegment(sessionId)`（`format.ts:198`），而它会
 * 把内联账号段 `~XXXX~` 里的 `~` **再转义一次**（`~` → `~007E`）⇒ 账号名里每个非
 * `[A-Za-z0-9._-]` 字符占 **14 字节**文件名；`50 + |app_id| + 14n > 255` 即
 * `ENAMETOOLONG`，而该错误在 `run` 里**浮不出来**（照常 resolve、磁盘上零文件）。
 *
 * 判据：
 *  - ①短账号名/契约语料形状**逐字不变**（内联形态）：换形态会让已有用户的隐藏会话
 *    上下文全部读不到，所以只在"落不下盘"时才换；
 *  - ②13 个中文字符仍内联（真机 252B，落得下）—— 边界不许提前跳形态；
 *  - ③14 个中文字符换成定长摘要段（`#:u32:<32 hex>`），编码后 ≤ 255；
 *  - ④矩阵不变量：各种 app_id 长度 × 账号名长度下，**构造出来的 id 一律 ≤ 255 字节**
 *    （要么短到落得下、要么抛错，没有第三种）；
 *  - ⑤摘要形态仍按 (账号 × 服务端) 分域、且**不会与任何内联形态撞成同一个 id**；
 *  - ⑥归因不受影响：所有形态都保持 `app:<app_id>#…`（服务端只读 `#` 之前那段）。
 *
 * 变异验证（拆掉即红）：把 `hiddenSessionId` 里的预算判断去掉（一律内联）⇒ ③④红；
 * 把摘要段改成常量（丢弃账号/服务端维度）⇒ ⑤红；把摘要段换成"直接抛错"⇒ ③红
 * （错误形态可接受但本用例按"要么落得下"的口径要求换形态 —— 见报告里的诚实边界）。
 */
import { describe, expect, it } from 'vitest'
import {
  AI_HIDDEN_SESSION_ID_MAX_BYTES,
  AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG,
  encodedSessionIdBytes,
  hiddenSessionId,
  hiddenSessionScope,
} from './ai-chat.ts'

const SERVER = 'https://harness.example.com'
const OTHER_SERVER = 'https://second.example.com'

describe('R14 C-03：隐藏会话 id 的文件名预算', () => {
  it('①短账号名保持内联形态（逐字等于契约语料形状，不断已有会话的上下文）', () => {
    const id = hiddenSessionId({ userId: 'alice', serverURL: SERVER }, 'demo')
    expect(id).toMatch(/^app:demo#alice@[0-9a-f]{32}$/u)
    // 内联段仍然是 `hiddenSessionScope` 的输出（没有偷偷换形态）。
    expect(id).toBe(`app:demo#${hiddenSessionScope({ userId: 'alice', serverURL: SERVER })}`)
    expect(encodedSessionIdBytes(id)).toBeLessThanOrEqual(AI_HIDDEN_SESSION_ID_MAX_BYTES)
  })

  it('②13 个中文字符仍内联（252B ≤ 255：边界不许提前跳形态）', () => {
    const scope = { userId: '张'.repeat(13), serverURL: SERVER }
    const id = hiddenSessionId(scope, 'a'.repeat(20))
    expect(id).toBe(`app:${'a'.repeat(20)}#${hiddenSessionScope(scope)}`)
    expect(id).not.toContain(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG)
    // 真机实测的字节数（目录名长度）：13 × 14 + 50 + 20 = 252。
    expect(encodedSessionIdBytes(id)).toBe(252)
  })

  it('③14 个中文字符换成定长摘要段（真机 266B 落不下 ⇒ 必须换形态或报错）', () => {
    const scope = { userId: '张'.repeat(14), serverURL: SERVER }
    const inlineBytes = encodedSessionIdBytes(`app:${'a'.repeat(20)}#${hiddenSessionScope(scope)}`)
    expect(inlineBytes, '前提：内联形态确实超预算').toBeGreaterThan(AI_HIDDEN_SESSION_ID_MAX_BYTES)

    const id = hiddenSessionId(scope, 'a'.repeat(20))
    expect(id).toMatch(/^app:a{20}#:u32:[0-9a-f]{32}$/u)
    expect(encodedSessionIdBytes(id)).toBeLessThanOrEqual(AI_HIDDEN_SESSION_ID_MAX_BYTES)
  })

  it('④矩阵不变量：任何 (app_id, 账号名) 组合构造出的 id 都 ≤ 255 字节', () => {
    const users = ['a', 'alice@example.com', '张伟', '张'.repeat(13), '张'.repeat(14), '张'.repeat(40), '🙂'.repeat(30), 'x'.repeat(200)]
    const appIds = ['a', 'a'.repeat(20), 'a'.repeat(63), 'my-notes-app']
    for (const userId of users) {
      for (const appId of appIds) {
        for (const serverURL of [SERVER, OTHER_SERVER, null]) {
          const id = hiddenSessionId({ userId, serverURL }, appId)
          expect(
            encodedSessionIdBytes(id),
            `超预算的 id 会静默不落盘：user=${JSON.stringify(userId)} app_id=${appId}`,
          ).toBeLessThanOrEqual(AI_HIDDEN_SESSION_ID_MAX_BYTES)
        }
      }
    }
  })

  it('⑤摘要形态：稳定、按 (账号 × 服务端) 分域、且不与内联形态相撞', () => {
    const long = { userId: '张'.repeat(14), serverURL: SERVER }
    const first = hiddenSessionId(long, 'demo-app')
    expect(hiddenSessionId(long, 'demo-app')).toBe(first)
    expect(hiddenSessionId({ userId: '张'.repeat(15), serverURL: SERVER }, 'demo-app')).not.toBe(first)
    expect(hiddenSessionId({ userId: '张'.repeat(14), serverURL: OTHER_SERVER }, 'demo-app')).not.toBe(first)
    // 摘要段是 `:u32:` + 32 hex，而内联段的字符集是 `[A-Za-z0-9._-~@]`（`:` 只可能来自
    // 前缀与分隔符）⇒ 一个"名字恰好是那 32 位 hex"的账号不会被算成同一个会话。
    const twin = hiddenSessionId({ userId: first.slice(first.indexOf('#') + 1), serverURL: SERVER }, 'demo-app')
    expect(twin).not.toBe(first)
  })

  it('⑥归因形状不变：所有形态都是 `app:<app_id>#…`（服务端只读 `#` 之前那段）', () => {
    for (const userId of ['alice', '张'.repeat(14)]) {
      const id = hiddenSessionId({ userId, serverURL: SERVER }, 'my-notes')
      expect(id.startsWith('app:my-notes#')).toBe(true)
    }
    // 空 app_id / 空账号仍然 fail-loud（与 C-03 无关的既有闸门不许被这次改动放松）。
    expect(() => hiddenSessionId({ userId: 'alice', serverURL: SERVER }, '')).toThrow(/app_id/u)
    expect(() => hiddenSessionId({ userId: '   ', serverURL: SERVER }, 'demo')).toThrow(/account scope/u)
  })

  it('⑦服务端地址的归一化在两种形态下一致（尾斜杠不许把上下文劈成两半）', () => {
    // 契约语料第 4 条（`https://harness.example.com/` == 无斜杠）钉的是内联形态；摘要形态
    // 必须**同一份归一化**，否则长账号名一换形态就多出一条"地址带斜杠"的历史。
    //
    // app_id 取 20 字符：`demo` 那种短 id 下 14 个中文字符仍落得下（250B），走的是内联形态
    // —— 那样这条用例就**测不到**摘要形态的归一化（第一版正是这么写空转的）。
    const appId = 'a'.repeat(20)
    const cases: Array<{ user: string, digest: boolean }> = [
      { user: 'alice', digest: false },
      { user: '张'.repeat(14), digest: true },
    ]
    for (const { user, digest } of cases) {
      const plain = hiddenSessionId({ userId: user, serverURL: SERVER }, appId)
      // 前提断言：两种形态都要真的被覆盖到（否则本用例只测了内联那一半）。
      expect(plain.includes(AI_HIDDEN_SESSION_SCOPE_DIGEST_TAG), `形态预期不符（user=${user}）`).toBe(digest)
      // 尾斜杠 / 账号名两侧空白都必须归一化掉（与内联段同一口径）。
      expect(hiddenSessionId({ userId: user, serverURL: `${SERVER}/` }, appId), '尾斜杠改变了 id').toBe(plain)
      expect(hiddenSessionId({ userId: `  ${user}  `, serverURL: SERVER }, appId)).toBe(plain)
    }
  })
})
