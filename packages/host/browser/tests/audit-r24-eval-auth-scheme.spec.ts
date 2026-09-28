/**
 * R24 N1（P2）判据：`browser_eval` 出口的认证头取值必须按**结构**判定，不能枚举方案名。
 *
 * 缺陷（X2 审计实跑）：R22 V6 F2 把认证头的整段擦除挂在"取值里出现**白名单**方案名"
 * 这个门限上（`bearer|basic|digest|token|apikey|api[_-]?key|negotiate|ntlm|oauth2?|saml`）。
 * 任何不在表里的方案名都会让规则整体不命中，随后 `KEYWORD_SPAN`（片段 <8 位不命中）
 * 与最后那趟 `key: value`（在第一个空格处收尾）只擦掉**方案名**：
 *
 *   `Authorization: SSWS AQAAANCMND8BFdERjHoAwE` → `Authorization: **** AQAAANCMND8BFdERjHoAwE`
 *
 * 同族：`SNOWFLAKE_JWT`（长 13，被当成"方案名"擦掉）、Zendesk、小写 `authorization:`、
 * `Proxy-Authorization:`。而 RFC 7235 的 auth-scheme 是任意 token ⇒ 加名字不可能收敛
 * （R23 N1 补 `saml` 就是同一修法方向的又一次补丁）。
 *
 * 修复：**头名即声明** —— 头名命中（大小写不敏感）就把取值整段换成 `****`，只有
 * 明确的非凭据形态（占位符 `<token>`、纯散文）才保留。
 *
 * 判据四块：① 任意方案名整段擦（含"白名单已知方案与任意方案输出必须逐字节相同"的
 * 结构控制，这条直接杀死"再加几个名字"的修法）；② 既有 27 例反向语料合并去重后
 * 逐字节保留；③ 占位符/散文的保留形态；④ 认账边界（散文尾被整段吃掉）钉住。
 */
import { describe, expect, it } from 'vitest'
import { serializeEvalResult } from '../src/eval-policy.ts'

/** 假凭据（公开仓纪律：一律用明显的假值）。 */
const CRED = 'AQAAANCMND8BFdERjHoAwE'
/** 三段式 JWT。 */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123'
/** base64("user:password")。 */
const BASIC_B64 = 'dXNlcjpwYXNzd29yZA=='
/** 不含数字的合法 base64（"声明即敏感"的关键形态）。 */
const BASIC_B64_NO_DIGIT = 'YWFhYWFhYWE='

const out = (text: string): string => JSON.parse(serializeEvalResult(text)) as string

// ============================================================ ① 结构判据

/**
 * 任意方案名（RFC 7235 的 auth-scheme 是任意 token）—— **没有一个**能被白名单收编
 * 到"收敛"的程度：这条语料只要有一条命中失败，就说明判据又退回了枚举。
 */
const ARBITRARY_SCHEMES: readonly string[] = [
  'SSWS',
  'SNOWFLAKE_JWT',
  'Zendesk',
  'MyCompanyScheme',
  'X-CUSTOM',
  'Wibble',
  'FOO',
  'abcd1234',
]

/** 旧实现的方案名白名单（用于对照：两族输出必须逐字节相同）。 */
const WHITELISTED_SCHEMES: readonly string[] = ['bearer', 'basic', 'digest', 'token', 'apikey', 'api_key', 'negotiate', 'ntlm', 'oauth', 'oauth2', 'saml']

describe('R24 N1 ① 任意方案名都整段擦（判据与方案名无关）', () => {
  it.each(ARBITRARY_SCHEMES)('Authorization: %s <凭据> ⇒ 取值整段掩码', (scheme) => {
    const text = `Authorization: ${scheme} ${CRED}`
    const masked = out(text)
    expect(masked, `凭据明文出窗：${masked}`).not.toContain(CRED)
    expect(masked, `方案名也必须在掩码里（整段擦）：${masked}`).not.toContain(scheme)
    expect(masked).toBe('Authorization: ****')
  })

  it.each(ARBITRARY_SCHEMES)('Proxy-Authorization: %s <凭据> ⇒ 取值整段掩码', (scheme) => {
    const masked = out(`Proxy-Authorization: ${scheme} ${CRED}`)
    expect(masked).not.toContain(CRED)
    expect(masked).toBe('Proxy-Authorization: ****')
  })

  it('方案名的大小写不敏感（小写头名 + 小写方案名同样整段擦）', () => {
    expect(out(`authorization: ssws ${CRED}`)).toBe('authorization: ****')
    expect(out(`AUTHORIZATION: SSWS ${CRED}`)).toBe('AUTHORIZATION: ****')
    expect(out(`proxy-authorization: ssws ${CRED}`)).toBe('proxy-authorization: ****')
  })

  /**
   * **杀死"再加几个名字"的修法**：同一形态下，旧白名单里的方案名与任意方案名必须
   * 产出**逐字节相同**的结果。按白名单实现时两族必然分叉（已知方案 ⇒ 整段擦；
   * 未知方案 ⇒ `**** <凭据>`），本用例即红。
   */
  it('白名单已知方案与任意方案的输出必须逐字节相同（结构判据的控制组）', () => {
    const reference = out(`Authorization: wibble ${CRED}`)
    expect(reference).toBe('Authorization: ****')
    for (const scheme of WHITELISTED_SCHEMES) {
      expect(out(`Authorization: ${scheme} ${CRED}`), `方案名 ${scheme} 的读数与任意方案不同`).toBe(reference)
    }
  })

  it('无方案名 / 多空格 / JSON 引号键同样整段擦', () => {
    expect(out(`Authorization: ${CRED}`)).toBe('Authorization: ****')
    expect(out(`Authorization:   SSWS   ${CRED}`)).toBe('Authorization:   ****')
    expect(out(`{"Authorization":"SSWS ${CRED}"}`)).toBe('{"Authorization":"****"}')
    expect(out(`{"authorization":"Bearer ${JWT}"}`)).toBe('{"authorization":"****"}')
  })

  it('等号形态：整串就是 `authorization=<凭据>` 的 cookie 对形状 ⇒ 按 P1-18 整串打码', () => {
    // 既有行为（`looksLikeCookieString` 的 SESSION_COOKIE_NAME 含 `authorization`），
    // 与本次改动无关；这里钉住"凭据不出窗"这一条。
    const masked = out(`authorization=${CRED}`)
    expect(masked).not.toContain(CRED)
    expect(masked).toBe('****')
  })

  it('真实凭据形态逐条不出窗（JWT / base64 / 不透明串 / 纯字母句柄）', () => {
    for (const [text, secret] of [
      [`Authorization: Bearer ${JWT}`, JWT],
      [`Authorization: Basic ${BASIC_B64}`, BASIC_B64],
      [`Authorization: Basic ${BASIC_B64_NO_DIGIT}`, BASIC_B64_NO_DIGIT],
      [`Proxy-Authorization: Basic ${BASIC_B64}`, BASIC_B64],
      [`Authorization: SSWS ${CRED}`, CRED],
      [`authorization: ssws ${CRED}`, CRED],
      [`Authorization: SNOWFLAKE_JWT ${CRED}`, CRED],
    ] as const) {
      const masked = out(text)
      expect(masked, `明文出窗：${masked}`).not.toContain(secret)
    }
  })
})

// ==================================================== ② 反向语料（合并去重）

/** R22 V6 F2 反向语料（`tests/audit-r22-eval-header-mask.spec.ts`，含 `toContain` 三条）。 */
const R22_REVERSE: readonly string[] = [
  'the bearer of good news',
  'This page explains token budgets',
  'the secret garden',
  'password reset instructions',
  'The token authentication mechanism',
  'Cookie: the browser sends cookies',
  'Authorization: Bearer of good news',
  'Authorization: none required',
  'Authorization: Bearer <your-token>',
]

/** R23 N1 反向语料（`tests/audit-r23-eval-mask-family.spec.ts`，含占位符组与 `toContain` 三条）。 */
const R23_REVERSE: readonly string[] = [
  'the bearer of good news',
  'This page explains token budgets',
  'the secret garden',
  'password reset instructions',
  'The token authentication mechanism',
  'the token expired before the request was sent',
  'token rotation policy for the gateway',
  'password management guidelines are published internally',
  'secret management is documented separately',
  'credential rotation happens every ninety days',
  'api_key configuration is described below',
  'session_id is assigned by the server on login',
  'refresh_token lifetime is configured by the administrator',
  'access_key terminology appears throughout this page',
  'Cookie: the browser sends cookies',
  'Cookie policy: we use cookies to improve your experience',
  'Set-Cookie is a response header',
  'Authorization is required for this endpoint',
  'send the Authorization header',
  'a bearer token must be refreshed',
  '<your-token>',
  'YOUR_TOKEN_HERE',
  'xxxx',
  'token <your-token>',
  'token xxxx',
  'api_key <API_KEY>',
  'Authorization: Bearer <your-token>',
  'Authorization: none required',
  'Authorization: Bearer of good news',
]

/** R24 N1 新增：认证头**取值**层面的形态（占位符/散文保留，方案名按既有口径擦）。 */
const R24_AUTH_VALUE_CASES: ReadonlyArray<readonly [text: string, expected: string]> = [
  // 占位符 / 纯散文 ⇒ 取值逐字保留（只有紧邻头名的第一个词按既有 `key: value` 口径擦）
  ['Authorization: Bearer <your-token>', 'Authorization: **** <your-token>'],
  ['Authorization: Bearer <your-api-key>', 'Authorization: **** <your-api-key>'],
  ['Authorization: <token>', 'Authorization: <token>'],
  ['Proxy-Authorization: Bearer <token>', 'Proxy-Authorization: **** <token>'],
  ['Authorization: Bearer of good news', 'Authorization: **** of good news'],
  ['Authorization: none required', 'Authorization: **** required'],
  ['Authorization: Bearer of the realm', 'Authorization: **** of the realm'],
  ['the Authorization header is required', 'the Authorization header is required'],
]

/** 合并去重后的反向语料（既有 29 条 + 本次新增）。 */
const REVERSE_CORPUS: readonly string[] = [...new Set([
  ...R22_REVERSE,
  ...R23_REVERSE,
  ...R24_AUTH_VALUE_CASES.map(([text]) => text),
])]

/** 逐字节保留的子集（合并后的语料去掉"允许擦掉紧邻头名的方案名"那几条）。 */
const BYTE_IDENTICAL = REVERSE_CORPUS.filter((text) => !R24_AUTH_VALUE_CASES.some(([input]) => input === text))

describe('R24 N1 ② 反向语料合并去重后逐字节保留', () => {
  it('语料规模与去重（既有反向语料 + 本次新增，重复项已合并）', () => {
    const legacy = new Set([...R22_REVERSE, ...R23_REVERSE])
    expect(legacy.size).toBeGreaterThanOrEqual(27)
    // 合并去重：每条既有语料都在合并表里，且合并表无重复。
    for (const text of legacy) expect(REVERSE_CORPUS).toContain(text)
    expect(REVERSE_CORPUS.length).toBe(new Set(REVERSE_CORPUS).size)
    expect(REVERSE_CORPUS.length).toBeGreaterThanOrEqual(legacy.size)
    expect(R24_AUTH_VALUE_CASES.length).toBe(8)
  })

  it.each(BYTE_IDENTICAL)('逐字节保留：%s', (text) => {
    expect(out(text), '被改坏').toBe(text)
  })

  it.each(R24_AUTH_VALUE_CASES)('取值形态读数固定：%s', (text, expected) => {
    expect(out(text)).toBe(expected)
  })

  it('占位符与后续散文不被整段吃掉（`toContain` 口径与 R22/R23 同形）', () => {
    expect(out('Authorization: Bearer <your-token>')).toContain('<your-token>')
    expect(out('Authorization: none required')).toContain('required')
    expect(out('Authorization: Bearer of good news')).toContain('of good news')
  })
})

// ==================================================== ④ 认账边界（钉住）

describe('R24 N1 ④ 认账边界：头名命中即声明，取值的散文尾一并进掩码', () => {
  it('取值里出现非散文词时整段擦，同一行的尾部散文也一起吃掉', () => {
    // 「整段擦」的直接代价：`Authorization: <凭据> …` 之后的同段文字不可分辨。
    // fail-closed 方向（多擦可恢复、漏擦不可恢复），这里把行为钉住以免被当成回归。
    const withTail = out(`Authorization: SSWS ${CRED} (see docs)`)
    expect(withTail).not.toContain(CRED)
    expect(withTail).toContain('Authorization: ****')
    const withSentence = out(`Authorization: Bearer ${CRED} is required for the API`)
    expect(withSentence).not.toContain(CRED)
    expect(withSentence).toContain('Authorization: ****')
  })

  it('取值是纯散文时不整段擦（只有紧邻头名的第一个词按既有口径处理）', () => {
    expect(out('Authorization: Bearer of the realm')).toBe('Authorization: **** of the realm')
  })
})
