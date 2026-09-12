/**
 * 2026-09-12（P1-6）：凭证词表**单一来源**。
 *
 * 背景：URL 脱敏白名单（原 store.ts:81）与 eval 结果脱敏的 SECRET_VALUE
 * （原 eval-policy.ts:322）是两份各自维护的正则，已经漂移——`sessionid` /
 * `bearer` 在 eval 结果里算凭证，在 URL 里却明文落盘。现在两份词表都由
 * `src/sensitive.ts` 声明，本 spec 用不变式锁住"不能再漂回去"：
 *
 * 1. eval 值启发式认得的每个词，URL/键名白名单也必须认得（子集不变式）；
 * 2. URL/键名匹配保持**子串**语义（camelCase / 复合键必须命中）；
 * 3. eval 值启发式不在普通英文词上误炸（`president`/`encoded`/`monkey`）。
 */
import { describe, expect, it } from 'vitest'
import { SECRET_VALUE, SECRET_VALUE_TERMS, SENSITIVE_KEY_PATTERN, SENSITIVE_TERMS } from '../src/sensitive.ts'
import { stripSensitiveUrl } from '../src/store.ts'
import { serializeEvalResult } from '../src/eval-policy.ts'

describe('sensitive.ts: 凭证词表单一来源（P1-6）', () => {
  it('不变式：eval 值启发式的词全部落在键名白名单内', () => {
    for (const term of SECRET_VALUE_TERMS) {
      expect(SENSITIVE_KEY_PATTERN.test(term), `term ${term} 不在键名白名单里`).toBe(true)
    }
    // 反向不做要求：code/key/session 是 URL 参数里的凭证，但作为 JSON 字段名
    // 太常见（`{"code":0}`），刻意不进入自由文本/字段值启发式。
    expect(SENSITIVE_TERMS).toContain('session')
    expect(SENSITIVE_TERMS).toContain('sid')
    expect(SENSITIVE_TERMS).toContain('bearer')
  })

  it('键名匹配是子串语义：camelCase / 复合键 / 大小写全部命中', () => {
    const keys = [
      'accessToken', 'id_token', 'refreshToken', 'sessionId', 'JSESSIONID', 'PHPSESSID',
      'connect.sid', 'SAMLResponse', 'X-Amz-Signature', 'apiKey', 'privateKey', 'csrf_token',
      'authorization', 'jwt', 'ticket', 'assertion', 'passwd', 'auth_code', 'credential',
    ]
    for (const key of keys) expect(SENSITIVE_KEY_PATTERN.test(key), key).toBe(true)
  })

  it('自由文本启发式不误炸普通英文词', () => {
    for (const text of ['president', 'consider', 'outside', 'encoded', 'decoder', 'monkey', 'keyboard', 'barcode']) {
      expect(SECRET_VALUE.test(text), text).toBe(false)
    }
  })

  it('两侧的语义差异是刻意的：URL 参数 code 掩码，eval 结果字段 code 保留', () => {
    expect(stripSensitiveUrl('https://h/cb?code=SECRET')).toBe('https://h/cb?code=****')
    // 模型读 API 响应 `{"code":0,"msg":"ok"}` 时不能退化成一片 ****
    expect(serializeEvalResult({ code: 0, msg: 'ok' })).toBe('{"code":0,"msg":"ok"}')
    // 但真正凭证形状的字段名照旧掩码
    expect(serializeEvalResult({ sessionId: 'abc123', bearer: 'xyz' })).toBe('{"sessionId":"****","bearer":"****"}')
  })
})
