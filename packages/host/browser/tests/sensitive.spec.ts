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
import {
  PROSE_SENSITIVE_KEY_PATTERN,
  SECRET_VALUE,
  SECRET_VALUE_TERMS,
  SENSITIVE_KEY_PATTERN,
  SENSITIVE_TERMS,
  URL_SHAPED_TEXT_KEY_PATTERN,
} from '../src/sensitive.ts'
import { maskSensitiveKeyValueText, stripSensitiveText, stripSensitiveUrl } from '../src/store.ts'
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

/**
 * 2026-09-15 审计 P2：**自由文本的散文段**只对强凭据键打码。
 *
 * 第三张表（`PROSE_SENSITIVE_TERMS`）存在的原因：`key`/`code`/`sid` 是普通英文
 * 词，散文标题里的 `key=value` 被整段打码是**不可逆的数据损坏**（实测
 * `搜索 “key=value” 的含义` → `搜索 “key=**** 的含义`）。URL 面（`SENSITIVE_TERMS`）
 * 一个字不动；自由文本里 URL/查询串形态的段用两张表的**并集**，覆盖度只增不减。
 */
describe('sensitive.ts: 自由文本词表分档（2026-09-15 审计 P2）', () => {
  it('散文词表去掉了 key/code/sid，保留强凭据键（子串语义）', () => {
    for (const ordinary of ['key', 'code', 'sid', 'barcode', 'encoded', 'monkey']) {
      expect(PROSE_SENSITIVE_KEY_PATTERN.test(ordinary), ordinary).toBe(false)
    }
    for (const credential of [
      'token', 'access_token', 'refresh_token', 'client_secret', 'password', 'passwd', 'pwd',
      'authorization', 'api_key', 'api-key', 'apikey', 'cookie', 'sessionId', 'credential',
    ]) {
      expect(PROSE_SENSITIVE_KEY_PATTERN.test(credential), credential).toBe(true)
    }
  })

  it('URL 形态文本词表是并集：键名表全命中，且补上散文表独有的 pwd/cookie', () => {
    for (const term of SENSITIVE_TERMS) {
      expect(URL_SHAPED_TEXT_KEY_PATTERN.test(term), term).toBe(true)
    }
    for (const sample of ['pwd', 'cookie', 'api_key', 'access_token', 'code', 'sid', 'key']) {
      expect(URL_SHAPED_TEXT_KEY_PATTERN.test(sample), sample).toBe(true)
    }
    // URL 面（键名表）按审计要求保持原样：pwd/cookie 本来就不在其列
    expect(SENSITIVE_KEY_PATTERN.test('pwd')).toBe(false)
    expect(SENSITIVE_KEY_PATTERN.test('cookie')).toBe(false)
  })

  it('stripSensitiveText：散文逐字节保留，强凭据键仍打码', () => {
    expect(stripSensitiveText('搜索 “key=value” 的含义')).toBe('搜索 “key=value” 的含义')
    expect(stripSensitiveText('see code=404 and sid=7')).toBe('see code=404 and sid=7')
    expect(stripSensitiveText('notes about passwords')).toBe('notes about passwords')
    expect(stripSensitiveText('password=hunter2')).toBe('password=****')
    expect(stripSensitiveText('token=T12')).toBe('token=****')
  })

  it('stripSensitiveText：URL/查询串形态仍按键名级强度（URL 面兜底）', () => {
    expect(stripSensitiveText('Login failed: code=T14&state=x')).toBe('Login failed: code=****&state=x')
    expect(stripSensitiveText('Sign in /cb?%73id=T11')).toBe('Sign in /cb?%73id=****')
    expect(stripSensitiveText('https://h/cb?X-Amz-Signature=SIG&token=TOK')).toBe(
      'https://h/cb?X-Amz-Signature=****&token=****',
    )
    expect(stripSensitiveText('{"code":"T14"}')).toBe('{"code":"****"}')
  })

  it('url 字段与 URL 面扫描器行为完全不变', () => {
    expect(stripSensitiveUrl('https://h/cb?code=SECRET&key=v&sid=1')).toBe('https://h/cb?code=****&key=****&sid=****')
    expect(stripSensitiveUrl('https://h/cb?%2573id=T3')).toBe('https://h/cb?%2573id=****')
    // maskSensitiveKeyValueText 仍是 URL 面的全强度扫描器（R-5 的 JSON 覆盖不变）
    expect(maskSensitiveKeyValueText('{"code":"T14"}')).toBe('{"code":"****"}')
    expect(maskSensitiveKeyValueText('Login failed: code=T14&state=x')).toBe('Login failed: code=****&state=x')
  })

  it('残留（认账）：token_type / sessionIdle 这类含强凭据子串的键在散文里仍会被打码', () => {
    // 保留 `token`/`session` 子串语义是刻意的：`id_token`/`csrf_token`/`set-cookie`
    // 必须命中，代价就是 `token_type=bearer` 这类非机密键也会被打码——过度脱敏是
    // 安全方向，且审计只要求去掉 key/code/sid 这类**普通英文词**。
    expect(stripSensitiveText('token_type=bearer')).toBe('token_type=****')
    expect(stripSensitiveText('sessionIdle=30')).toBe('sessionIdle=****')
  })
})
