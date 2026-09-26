/**
 * R22 V6 F2（P2）判据：`browser_eval` 出口的**认证头 / 凭据头**脱敏。
 *
 * 缺陷形态（V6 复审实测，`eval-policy.ts` 的 `maskCredentialFragments`）：
 * 第一趟 `maskSensitiveKeyValueText` 把 `Authorization:` 当敏感键，而它的 `key: value`
 * 规则在**第一个空格**处收尾 ⇒ 擦掉的是**方案名**（`Bearer`/`Basic`）；第二趟
 * `KEYWORD_SPAN`（模块自己承诺"兜住 `Bearer <opaque>`"的那条，见 `eval-policy.ts` 的
 * `CREDENTIAL_VALUE_SHAPES` 注释）这时已经看不到方案名，于是：
 *
 *   `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123`
 *     → `Authorization: **** eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123`   ← 凭据明文
 *
 * `Basic` 形态更彻底：`basic` 不在 `KEYWORD_SPAN` 的关键词表里，两趟都不命中
 * （`Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==` 原样出窗）。凭据进模型上下文
 * （进而进上游 LLM）是本条的实际后果。
 *
 * 判据分两面，缺一条就有"擦多了"或"擦漏了"的假绿空间：
 *  · **正向**：五种形态（Authorization / Proxy-Authorization / Cookie / x-api-key /
 *    无前缀裸 token）的**凭据段**一律不得以明文出窗；
 *  · **反向**：散文与文档示例不误伤（`the bearer of good news`、`token budgets`、
 *    `Bearer <your-token>` 这类占位符、`Cookie: the browser sends cookies`）。
 */
import { describe, expect, it } from 'vitest'
import { serializeEvalResult } from '../src/eval-policy.ts'

/** 三段式 JWT（真实形态）。 */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123'
/** 不透明 bearer token（真实形态：无点号、长 alnum）。 */
const OPAQUE = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666'
/** base64("user:password")。 */
const BASIC_B64 = 'dXNlcjpwYXNzd29yZA=='
/**
 * base64("aaaaaaaa")：**不含数字**的合法 base64。
 *
 * 这一类是"密钥是 base64、但恰好没有数字"的真实形态：片段级 `isCredentialSpan` 对
 * ≥12 但无数字的串判 false（EV-1 的散文保护），所以认证头规则必须靠**方案名**这个
 * 声明来判定，不能只靠片段形状。
 */
const BASIC_B64_NO_DIGIT = 'YWFhYWFhYWE='
/** `sk-` 前缀的 API key。 */
const API_KEY = 'sk-1234567890abcdefghij'
/** 42 字符的裸句柄（无关键词前缀）。 */
const BARE = 'abc123def456ghi789jkl012'

describe('R22 V6 F2 正向：凭据段不得明文出窗', () => {
  it.each([
    ['Authorization: Bearer <jwt>', `Authorization: Bearer ${JWT}`, JWT],
    ['Authorization: Bearer <不透明 token>', `Authorization: Bearer ${OPAQUE}`, OPAQUE],
    ['Authorization: Basic <b64>', `Authorization: Basic ${BASIC_B64}`, BASIC_B64],
    ['Authorization: Basic <无数字 b64>', `Authorization: Basic ${BASIC_B64_NO_DIGIT}`, BASIC_B64_NO_DIGIT],
    ['Proxy-Authorization: Basic <b64>', `Proxy-Authorization: Basic ${BASIC_B64}`, BASIC_B64],
    ['小写 authorization: bearer <jwt>', `authorization: bearer ${JWT}`, JWT],
  ])('%s：凭据段被擦掉，键名仍可辨认', (_label, text, secret) => {
    const out = serializeEvalResult(text)
    expect(out).not.toContain(secret)
    // 只擦值、不擦整行：键名仍可辨认（否则 op log/模型的上下文只剩 ****）。
    expect(out.toLowerCase()).toContain('authorization')
  })

  it('Cookie: a=b（单条非会话 cookie）的值同样被擦掉', () => {
    const out = serializeEvalResult('Cookie: a=b')
    expect(out).not.toContain('a=b')
    expect(out).toContain('Cookie')
  })

  it('Cookie: <会话 cookie> 整串打码（既有口径不退化）', () => {
    expect(serializeEvalResult('Cookie: sessionid=abc123def456')).toBe('"****"')
  })

  it('x-api-key / api_key 的值被擦掉（既有 key=value 口径不退化）', () => {
    expect(serializeEvalResult(`x-api-key: ${API_KEY}`)).not.toContain(API_KEY)
    expect(serializeEvalResult('api_key=SUPERSECRET')).toBe('"api_key=****"')
  })

  it('无前缀裸 token 仍被擦掉（关键词片段口径不退化）', () => {
    expect(serializeEvalResult(`Bearer ${BARE}`)).not.toContain(BARE)
    expect(serializeEvalResult(`token ${BARE}`)).toBe('"token ****"')
  })

  it('JSON 文本里的认证头（页面回显请求体/头）同样不留明文', () => {
    const out = serializeEvalResult(`{"Authorization":"Bearer ${JWT}"}`)
    expect(out).not.toContain(JWT)
  })

  it('两趟规则不得互相抵消：`<敏感键>: <方案名> <凭据>` 家族（方案名不是凭据）', () => {
    // 关键词表里同时有 `token` 与 `bearer` 时，任何 `<keyword>[:=] <keyword2> <secret>`
    // 都会同病：第一趟擦掉第二个关键词，第二趟就再也认不出这个形态。
    const out = serializeEvalResult(`token: bearer ${BARE}`)
    expect(out).not.toContain(BARE)
  })
})

describe('R22 V6 F2 反向：散文与文档示例不误伤', () => {
  it.each([
    'the bearer of good news',
    'This page explains token budgets',
    'the secret garden',
    'password reset instructions',
    'The token authentication mechanism',
    'Cookie: the browser sends cookies',
  ])('普通正文逐字节保留：%s', (text) => {
    expect(serializeEvalResult(text)).toBe(JSON.stringify(text))
  })

  it('认证头取值不是凭据时，后面的散文不被吞掉（`Bearer` 只是普通单词）', () => {
    // `Bearer of good news` 不构成凭据（方案名 + 两个短英文词）⇒ 新规则不得命中。
    // 键后面那一个词仍按既有 `key: value` 口径处理，但**其余正文逐字保留**。
    const out = serializeEvalResult('Authorization: Bearer of good news')
    expect(out).toContain('of good news')
  })

  it('非认证方案的取值不触发整段掩码（`none required` 这类普通取值）', () => {
    // 只有公认的认证方案（bearer/basic/…）才算"这是凭据"的声明：任意英文词都当方案名
    // 会把这个形态后面的正文一起吃掉。既有 `key: value` 口径仍擦掉紧邻的那个词，
    // 但**句子剩下的部分逐字保留**。
    const out = serializeEvalResult('Authorization: none required')
    expect(out).toContain('required')
  })

  it('文档占位符 `<your-token>` 不被吞掉（它不是凭据）', () => {
    const out = serializeEvalResult('Authorization: Bearer <your-token>')
    expect(out).toContain('<your-token>')
  })
})
