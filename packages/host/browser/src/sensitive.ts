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

/** Sensitive key/parameter name fragments (case-insensitive substring match). */
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
  const normalized = key.toLowerCase()
  return SENSITIVE_TERMS.some((term) => {
    const at = normalized.indexOf(term)
    if (at < 0) return false
    if (at === 0) return true
    return !/[a-z0-9]/.test(normalized[at - 1]!)
  })
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
