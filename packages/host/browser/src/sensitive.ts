/**
 * Credential vocabulary — the single definition site (2026-09-12, P1-6).
 *
 * Before this module `store.ts` (URL query/fragment masking) and
 * `eval-policy.ts` (eval-result masking) each declared their own regex, and the
 * two had already drifted: `sessionid`/`bearer` counted as secrets in eval
 * results yet were persisted in cleartext in URLs. Every consumer
 * (store.ts, runtime.ts op-log masking, eval-policy.ts) now reads one of the
 * two patterns below instead of declaring its own.
 *
 * Two patterns on purpose — the two contexts are not the same threat model:
 *
 * - {@link SENSITIVE_KEY_PATTERN} matches key/parameter **names** (URL query
 *   parameters, URL fragment pairs, op-log summaries, eval-result field names).
 *   Substring matching is required: `accessToken`, `id_token`, `JSESSIONID`,
 *   `X-Amz-Signature` and `SAMLResponse` must all hit.
 * - {@link SECRET_VALUE} matches free-form **values** (eval results). It stays
 *   narrow on purpose: `code`/`key`/`session`/`sid` are ordinary English words,
 *   so listing them here would mask `president`/`encoded`/`monkey` wholesale.
 *   The invariant "every `SECRET_VALUE` term is also a `SENSITIVE_KEY_PATTERN`
 *   term" is pinned by `tests/sensitive.spec.ts` so the historical drift cannot
 *   come back silently.
 * @module @picoaide/dsh-browser
 */

/** Sensitive key/parameter name fragments (case-insensitive substring match).
 *
 * 2026-09-15 审计 P2：这张表**只服务 URL 面**（查询串、URL 片段、
 * `stripSensitiveUrl` 的二次文本扫描）。它刻意保持子串语义且一个字不动——URL
 * 参数名短、可枚举，且 `code`/`key`/`sid` 在查询串里确实是凭据位。自由文本
 * （页面标题/摘要）改用 {@link PROSE_SENSITIVE_TERMS}，见那里的取舍说明。 */
export const SENSITIVE_TERMS = [
  'assertion',
  'auth',
  'bearer',
  'code',
  'credential',
  'jwt',
  'key',
  'passwd',
  'password',
  'saml',
  'secret',
  'session',
  'sid',
  'signature',
  'ticket',
  'token',
] as const

/** Matches credential-shaped key/parameter NAMES (substring, case-insensitive). */
export const SENSITIVE_KEY_PATTERN = new RegExp(SENSITIVE_TERMS.join('|'), 'iu')

/**
 * 自由文本（页面标题、摘要）**散文段**用的强凭据词表（2026-09-15 审计 P2）。
 *
 * 为什么要第二张表：`SENSITIVE_TERMS` 里的 `key` / `code` / `sid` 是普通英文
 * 词，散文里到处出现。实测（2026-09-15 审计）：书签/历史标题
 * `搜索 “key=value” 的含义` 被写成 `搜索 “key=**** 的含义`——**写入即不可逆**，
 * 用户数据被自己的脱敏器改坏了。这里只留"看到就必须打码"的强凭据键：
 *
 * - 子串语义（与键名表一致）：`access_token`/`refresh_token`/`csrf_token` 由
 *   `token` 覆盖，`client_secret` 由 `secret` 覆盖，`api-key`/`api_key`/`apikey`
 *   由 `api[_-]?key` 覆盖，`set-cookie` 由 `cookie` 覆盖；
 * - 取舍（安全侧）：URL 面仍然是兜底——标题/摘要里**以 URL/查询串形态出现**的段
 *   （见 store.ts 的 `isUrlShapedRun`）继续按 {@link SENSITIVE_TERMS} 全强度处理，
 *   所以 `Login failed: code=T14&state=x` 这类查询串形态照旧打码；被放过的只有
 *   真正的散文形态。
 * - 代价（认账）：散文里裸写的 `code=T14`、`sid=x` 不再打码（`key=value` 更不再
 *   打码）。这是审计明确要求的交换：散文被改坏是确定性损失，而散文里恰好出现
 *   凭据键值对是概率性泄漏，且 URL 面（`url` 字段、标题里的 URL）已覆盖绝大多数
 *   真实凭据。
 * - 残留：`pwd`/`cookie` 只在这张表里，不在 {@link SENSITIVE_TERMS} 里（审计要求
 *   URL 面保持现有强度、逐字节不动），所以 `?pwd=x` 在 **url 字段**里仍不打码；
 *   自由文本里则按 {@link URL_SHAPED_TEXT_TERMS} 的并集处理。
 */
export const PROSE_SENSITIVE_TERMS = [
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'api[_-]?key',
  'cookie',
  'session',
  'credential',
] as const

/** Matches credential-shaped key names in PROSE (substring, case-insensitive). */
export const PROSE_SENSITIVE_KEY_PATTERN = new RegExp(PROSE_SENSITIVE_TERMS.join('|'), 'iu')

/**
 * 自由文本里 **URL/查询串形态**的段使用的词表 = 键名表 ∪ 散文表（2026-09-15 审计 P2）。
 *
 * 并集而不是交集：这一段本来就走 URL 面的尺子，取并集保证自由文本的覆盖度
 * **只增不减**——`pwd`/`cookie` 在散文表里，`code`/`key`/`sid`/`signature` 在键名
 * 表里，两边都认。逐字节的 URL 面行为不受影响：`stripSensitiveUrl` /
 * `maskSensitiveKeyValueText` 仍只用 {@link SENSITIVE_KEY_PATTERN}。
 */
const URL_SHAPED_TEXT_TERMS = [...SENSITIVE_TERMS, 'pwd', 'cookie'] as const

/** Matches credential-shaped key names in URL/query-shaped free text. */
export const URL_SHAPED_TEXT_KEY_PATTERN = new RegExp(URL_SHAPED_TEXT_TERMS.join('|'), 'iu')

/** 预编译"全词判定"用的匹配器（词表是常量，避免每次扫描重新编译正则）。 */
function matchersFor(terms: readonly string[]): readonly RegExp[] {
  return terms.map((term) => new RegExp(term, 'u'))
}
const SENSITIVE_MATCHERS = matchersFor(SENSITIVE_TERMS)
const PROSE_MATCHERS = matchersFor(PROSE_SENSITIVE_TERMS)
const URL_SHAPED_TEXT_MATCHERS = matchersFor(URL_SHAPED_TEXT_TERMS)

/** 词表无关的"全词"判定：命中的第一个位置在词首，或前一个字符不是字母数字。 */
function isExactTerm(key: string, matchers: readonly RegExp[]): boolean {
  const normalized = key.toLowerCase()
  for (const matcher of matchers) {
    const at = normalized.search(matcher)
    if (at < 0) continue
    if (at === 0) return true
    if (!/[a-z0-9]/.test(normalized[at - 1]!)) return true
  }
  return false
}

/**
 * True when the key's own vocabulary is a credential term, rather than a term
 * merely buried inside a longer word (R-5, 2026-09-13).
 *
 * The substring semantics above are right for a delimiter that only ever
 * separates a key from a value (`=`, `&#61;`, `＝`): `accessToken=…` must hit.
 * They are NOT right for `:`, which is also ordinary prose punctuation:
 * `encoded: 0` contains `code`, `decoder: x` contains `code`, `keyboard: y`
 * starts with `key`, `consider: z` contains `sid`. A colon therefore counts
 * only when the key IS a term (`password:`, `token:`, `code:`) or when the term
 * opens a word part (`Authorization:`, `X-Amz-Signature:`). Quoted JSON keys
 * (`"accessToken": …`) are unambiguous by shape and do not need this gate.
 */
export function isExactSensitiveKey(key: string): boolean {
  return isExactTerm(key, SENSITIVE_MATCHERS)
}

/** {@link isExactSensitiveKey} 的散文版：按散文强凭据词表判定（2026-09-15 审计 P2）。 */
export function isExactProseSensitiveKey(key: string): boolean {
  return isExactTerm(key, PROSE_MATCHERS)
}

/** {@link isExactSensitiveKey} 的 URL 形态文本版：按两表并集判定（2026-09-15 审计 P2）。 */
export function isExactUrlShapedTextKey(key: string): boolean {
  return isExactTerm(key, URL_SHAPED_TEXT_MATCHERS)
}

/** Credential shapes that are unambiguous enough for free-form text/values. */
export const SECRET_VALUE_TERMS = [
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'api[_-]?key',
  'session[_-]?id',
  'access[_-]?key',
  'refresh[_-]?token',
  'bearer',
  'private[_-]?key',
] as const

/** Matches credential-shaped free-form VALUES (substring, case-insensitive). */
export const SECRET_VALUE = new RegExp(SECRET_VALUE_TERMS.join('|'), 'iu')
