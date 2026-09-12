/**
 * `browser_eval` guardrail (v4 §7.3-9): `browser_eval` accepts exactly ONE
 * expression, validated as an AST on the host side before execution.
 *
 * IMPORTANT (2026-09-08 product decision): this validator is a **heuristic
 * misuse guardrail, NOT a security boundary**. The AI is allowed to operate
 * every part of the browser (fetch/XHR/WebSocket and arbitrary JS included);
 * the rules below only keep a single call legible and refuse obvious
 * hand-fumble side effects. They are bypassable by design (e.g. `.constructor`)
 * and no isolation guarantee rests on them.
 *
 * Validation rules:
 * - the expression must parse as `Expression` (no statements, declarations,
 *   assignments — program rejected);
 * - forbidden node kinds: Assignment/Update, Variable/Function/Class
 *   declarations, `new`, `await`/`yield`, `Function`/`eval` calls,
 *   `with`, Super, TaggedTemplate, Import/Export;
 * - forbidden writes/side-effect APIs (called or member-accessed):
 *   setItem (storage), document.write, form submit, window.open, alerts,
 *   print, history/replaceState, location assignment, cookie assignment,
 *   DOM mutation, in-place array/object mutation, media/presentation side
 *   effects. Network-outbound APIs (fetch/XMLHttpRequest/WebSocket/
 *   EventSource/sendBeacon) are NOT forbidden (2026-09-08 product decision).
 * - a whitelist of read helper globals is injected into the executed
 *   expression (readText/readAttr/readJson/readVar) and must not be shadowed.
 *
 * Result post-processing (execution side): JSON-serialize with size/depth
 * caps + secret masking. The mask step lives in this module for tests.
 * @module @picoaide/dsh-browser
 */

import acorn from './vendor/acorn.cjs'
import { browserError } from './errors.ts'
import { SECRET_VALUE } from './sensitive.ts'

/** Max expression length (host-side bound, far below page cost). */
export const MAX_EVAL_EXPRESSION = 8192

/** Max serialized result length. */
export const MAX_EVAL_RESULT_BYTES = 8 * 1024

/** Max result JSON depth. */
export const MAX_EVAL_RESULT_DEPTH = 6

/** Read-only helper globals injected into the eval sandbox expression. */
export const EVAL_HELPERS = ['readText', 'readAttr', 'readJson', 'readVar'] as const

/** Member base names treated as side-effect/write entry points.
 *
 * NOTE (2026-09-08 product decision): network-outbound APIs (fetch,
 * XMLHttpRequest, WebSocket, EventSource, sendBeacon) are REMOVED from this
 * set. The AI already has full browser control plus a shell tool; banning
 * fetch in eval only forces it to re-implement the same request through
 * navigate/click/fill_form or a shell script — it does not stop data egress,
 * it just makes it less legible. What remains here are code-execution,
 * DOM/presentation and page-state writes (assignment-style side effects).
 *
 * `innerHTML` / `outerHTML` are deliberately ABSENT. They name readable data
 * properties whose only write form is an assignment, and `AssignmentExpression`
 * is rejected before this set is consulted — so listing them here blocked the
 * read (`document.documentElement.outerHTML`) with a message that called a pure
 * read a "side-effect API" (real-device report 2026-09-12). Do not re-add them:
 * they protect nothing.
 */
const WRITE_APIS = new Set([
  'setItem',
  'write',
  'writeln',
  'submit',
  'open',
  'alert',
  'confirm',
  'prompt',
  'print',
  'pushState',
  'replaceState',
  'assign',
  'replace',
  'reload',
  'back',
  'forward',
  'go',
  'close',
  'reset',
  'requestSubmit',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'queueMicrotask',
  'addEventListener',
  'removeEventListener',
  'insertAdjacentHTML',
  'insertAdjacentText',
  'setAttribute',
  'removeAttribute',
  'appendChild',
  'removeChild',
  'replaceChild',
  'remove',
  'cloneNode',
  'focus',
  'blur',
  'click',
  'scrollIntoView',
  'scrollTo',
  'scrollBy',
  'execCommand',
  // in-place array mutation (page state survives eval)
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  // object/reflection writes
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
  'deleteProperty',
  'set',
  'delete',
  // media / presentation side effects
  'play',
  'pause',
  'lock',
  'requestFullscreen',
  'exitFullscreen',
])

interface AnyNode {
  type: string
  [key: string]: unknown
}

/** Marker thrown by the credential-tab egress shim (see {@link wrapEvalExpression}).
 * Recognized by the runtime to turn a page exception into an explicit policy
 * error instead of a generic "page script failed". */
export const EVAL_EGRESS_BLOCKED_MARKER = 'PICOAI_EVAL_EGRESS_BLOCKED'

/** Network-write surfaces that can carry a page value off the machine.
 *
 * 2026-09-13 (R-2): these stay ALLOWED on ordinary tabs (see the 2026-09-08
 * decision above), but they are refused on a tab that received credentials
 * through `browser_fill_credentials`. Value-level scrubbing cannot stop an
 * active request — `fetch('/x?p='+document.querySelector('#pw').value)` handed
 * the injected password to the network verbatim (re-verified on a real
 * Electron renderer, `tests/probes/outlet-egress-probe.mjs`). The list is the
 * *static* half of the gate; {@link wrapEvalExpression} is the enforcing half
 * (it disables the same APIs inside the page for the duration of the call), so
 * a smuggled reference (`this['fe'+'tch']`) hits a throwing shim instead of the
 * real API. */
const EGRESS_APIS = new Set([
  'fetch',
  'xmlhttprequest',
  'sendbeacon',
  'websocket',
  'eventsource',
  'worker',
  'sharedworker',
  'importscripts',
  'serviceworker',
  'rtcpeerconnection',
  'rtcdatachannel',
])

/** Every fixed name this expression mentions (identifiers, member names and
 * string-literal computed access), lower-cased. */
function mentionedNames(node: AnyNode): Set<string> {
  const names = new Set<string>()
  const stack: AnyNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.type === 'Identifier') {
      const name = (current as { name?: string }).name
      if (name !== undefined) names.add(name.toLowerCase())
    }
    if (current.type === 'MemberExpression') {
      const property = (current as { property?: AnyNode }).property
      if ((current as { computed?: boolean }).computed !== true && property?.type === 'Identifier') {
        const name = (property as { name?: string }).name
        if (name !== undefined) names.add(name.toLowerCase())
      }
      if (property?.type === 'Literal' && typeof property.value === 'string') names.add(property.value.toLowerCase())
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'raw' || key === 'range') continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item)
      } else if (isNode(value)) {
        stack.push(value)
      }
    }
  }
  return names
}

/**
 * Credential-tab restriction (R-2, 2026-09-13).
 *
 * `browser_eval` on a tab that holds injected credentials may read the page,
 * but may not use a network-write API: the credential is in that page's DOM and
 * any outbound request can carry it out. Refusing the API by name is the
 * legible half; the shim installed by {@link wrapEvalExpression} is the
 * enforcing half.
 *
 * Known and accepted bypass surface (stated, not hidden): a page that cached a
 * reference to `fetch` in its own module scope can still be driven through it.
 * Closing that would require removing `browser_eval` from credential tabs
 * altogether — the stricter product option A/B documented in
 * docs/…/R-2. The default implemented here is the strict one *for the API
 * surface the model can name*, plus page-side enforcement.
 */
export function assertCredentialTabExpression(expression: string): void {
  const program = parseExpression(expression)
  const names = mentionedNames(program)
  for (const api of EGRESS_APIS) {
    if (names.has(api)) {
      throw browserError(
        'policy',
        `browser_eval: ${api} is blocked on this tab — it received credentials through browser_fill_credentials, and an outbound request can carry them off the page. Read-only expressions and the read* helpers still work; do page-authored requests in a tab without injected credentials.`,
      )
    }
  }
}



/** Parse `source`; returns the single Expression node or throws eval-policy. */
function parseExpression(source: string): AnyNode {
  try {
    // acorn parseExpressionAt rejects trailing statements? It parses an
    // expression at pos and ignores the rest — we verify full-consumption
    // by re-parsing as a program and requiring exactly one expression
    // statement with no other statements.
    const program = acorn.parse(`(${source}\n)`, { ecmaVersion: 2024, sourceType: 'script' }) as AnyNode
    return program
  } catch {
    throw browserError('eval-policy', 'browser_eval: expression failed to parse (must be a single expression)')
  }
}

/** Walk the AST; returns the first violation reason or null. */
function findViolation(node: AnyNode, source: string): string | null {
  const stack: AnyNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    const type = current.type
    if (type === 'AssignmentExpression' || type === 'UpdateExpression') {
      return 'assignment/update is not allowed (single expression guardrail)'
    }
    if (type === 'VariableDeclaration' || type === 'FunctionDeclaration' || type === 'ClassDeclaration'
      || type === 'ClassExpression' || type === 'FunctionExpression') {
      return 'declarations are not allowed (single expression only)'
    }
    if (type === 'NewExpression') return '`new` is not allowed'
    if (type === 'AwaitExpression' || type === 'YieldExpression') return 'await/yield is not allowed'
    if (type === 'WithStatement' || type === 'ForStatement' || type === 'ForInStatement' || type === 'ForOfStatement'
      || type === 'WhileStatement' || type === 'DoWhileStatement' || type === 'SwitchStatement' || type === 'IfStatement'
      || type === 'TryStatement' || type === 'ThrowStatement' || type === 'ReturnStatement' || type === 'LabeledStatement') {
      return 'statements are not allowed (single expression only)'
    }
    if (type === 'TaggedTemplateExpression') return 'tagged templates are not allowed'
    if (type === 'ImportExpression' || type === 'MetaProperty' || type === 'Super') {
      return 'import/meta/super are not allowed'
    }
    if (type === 'CallExpression') {
      const callee = current.callee as AnyNode | undefined
      const name = callTargetName(callee)
      if (name === undefined) {
        return 'dynamic call target is not allowed (guardrail: single expression, literal callee)'
      }
      if (name !== null && (WRITE_APIS.has(name) || name === 'eval' || name === 'Function')) {
        return `call to ${name} is not allowed (guardrail: code-execution/side-effect API)`
      }
    }
    if (type === 'MemberExpression') {
      const name = memberName(current)
      if (name === undefined) {
        // Non-literal computed READ is allowed (data access like data[key]).
      } else if (name !== null && WRITE_APIS.has(name)) {
        return `access to ${name} is not allowed (guardrail: side-effect API)`
      }
    }
    if (type === 'Identifier') {
      if ((current as { name?: string }).name === 'eval' || (current as { name?: string }).name === 'Function') {
        return 'eval/Function is not allowed'
      }
    }
    if (type === 'TemplateLiteral') {
      // Template literals are fine (string building only).
    }
    // Append children.
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'raw' || key === 'range') continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) stack.push(item)
        }
      } else if (isNode(value)) {
        stack.push(value)
      }
    }
    void source
  }
  return null
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/** Resolve the fixed call-target name of a callee, or `undefined` when the
 * callee cannot be statically proven to be a fixed name (dynamic computed
 * access, sequence/conditional callees, optional chains, …) — such calls are
 * rejected rather than risk executing an un-vetted side-effect API. */
function callTargetName(callee: AnyNode | undefined): string | null | undefined {
  if (callee === undefined) return null
  let node = callee
  if (node.type === 'ChainExpression') {
    node = (node as unknown as { expression?: AnyNode }).expression as AnyNode
  }
  if (node === undefined) return undefined
  if (node.type === 'Identifier') return (node as { name?: string }).name ?? null
  if (node.type === 'MemberExpression') return memberName(node)
  // A pure arrow IIFE is self-contained: its body is walked by the AST
  // validator (side-effect APIs inside are rejected), so the call itself
  // needs no target-name check.
  if (node.type === 'ArrowFunctionExpression') return null
  return undefined
}

/** Resolve the dotted member name of a callee/member (a.b.c → 'c').
 * String-literal computed access (`window['fetch']`) resolves to its value;
 * non-literal computed access yields `undefined` (unverifiable); non-member
 * callees yield `null`. */
function memberName(node: AnyNode | undefined): string | null | undefined {
  if (node === undefined) return null
  if (node.type === 'Identifier') return (node as { name?: string }).name ?? null
  if (node.type === 'MemberExpression') {
    const property = (node as { property?: AnyNode }).property
    if ((node as { computed?: boolean }).computed !== true) {
      if (property !== undefined && property.type === 'Identifier') return (property as { name?: string }).name ?? null
      return null
    }
    if (property !== undefined && property.type === 'Literal' && typeof property.value === 'string') {
      return property.value
    }
    return undefined
  }
  return null
}

/** Validate an eval expression (throws BrowserError 'eval-policy'). */
export function validateEvalExpression(expression: string): void {
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > MAX_EVAL_EXPRESSION) {
    throw browserError('eval-policy', `browser_eval: expression must be a non-empty string ≤ ${MAX_EVAL_EXPRESSION} chars`)
  }
  const wrapped = parseExpression(expression)
  if ((wrapped as AnyNode).type !== 'Program') {
    throw browserError('eval-policy', 'browser_eval: expression must be a single expression')
  }
  const body = (wrapped as { body?: AnyNode[] }).body ?? []
  if (body.length !== 1 || body[0]?.type !== 'ExpressionStatement') {
    throw browserError('eval-policy', 'browser_eval: expression must be a single expression (no statements)')
  }
  const violation = findViolation(body[0], expression)
  if (violation !== null) {
    throw browserError('eval-policy', `browser_eval: ${violation}`)
  }
}

/**
 * Wrap a validated expression for page execution: prepend the read
 * helper definitions (self-contained, no globals leaked) so `read*` helpers
 * work in the page context without template injection.
 *
 * `denyEgress` (R-2, 2026-09-13) additionally disables the network-write APIs
 * inside the page for the duration of this one evaluation and restores them in
 * a `finally` — the enforcing half of the credential-tab gate. It is a shim,
 * not a sandbox: it exists so a smuggled reference (`this['fe'+'tch']`) hits a
 * thrower instead of the real API, and so the failure is a clear, marked error
 * instead of a silent leak.
 */
export function wrapEvalExpression(expression: string, options: { denyEgress?: boolean } = {}): string {
  const helpers = `
    const __readText = (sel) => { const el = document.querySelector(sel); return el ? (el.innerText ?? el.textContent ?? '').slice(0, 4096) : null; };
    const __readAttr = (sel, name) => { const el = document.querySelector(sel); return el ? el.getAttribute(name) : null; };
    const __readJson = (sel) => { const el = document.querySelector(sel); if (!el) return null; try { return JSON.parse(el.textContent || 'null'); } catch { return null; } };
    const __readVar = (path) => { const parts = String(path).split('.'); let cur = globalThis; for (const p of parts) { cur = cur?.[p]; if (cur === undefined) return undefined; } try { return JSON.parse(JSON.stringify(cur)); } catch { return String(cur); } };
    const readText = __readText, readAttr = __readAttr, readJson = __readJson, readVar = __readVar;`
  if (options.denyEgress !== true) {
    return `(() => {${helpers}
    return (${expression});
  })()`
  }
  return `(() => {${helpers}
    const __marker = ${JSON.stringify(EVAL_EGRESS_BLOCKED_MARKER)};
    const __throwBlocked = (name) => { const err = new Error(__marker + ': ' + name + ' is disabled on this tab while injected credentials are present'); err.name = 'BrowserEvalEgressBlocked'; throw err; };
    const __restores = [];
    const __denyValue = (target, key, name, replacement) => {
      if (target === undefined || target === null) return;
      let previous;
      let existed = false;
      try { existed = Object.prototype.hasOwnProperty.call(target, key); previous = target[key]; } catch { return; }
      try {
        Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: false, value: replacement ?? function () { return __throwBlocked(name); } });
        __restores.push(() => { try { if (existed) Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: true, value: previous }); else delete target[key]; } catch { /* frozen target */ } });
      } catch { /* non-configurable */ }
    };
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'Request']) {
      __denyValue(globalThis, name, name);
    }
    __denyValue(globalThis.navigator, 'sendBeacon', 'sendBeacon');
    __denyValue(globalThis.navigator, 'serviceWorker', 'serviceWorker');
    __denyValue(globalThis, 'importScripts', 'importScripts');
    for (const key of ['open', 'send']) {
      __denyValue(globalThis.XMLHttpRequest && globalThis.XMLHttpRequest.prototype, key, 'XMLHttpRequest.' + key);
    }
    __denyValue(globalThis.HTMLFormElement && globalThis.HTMLFormElement.prototype, 'submit', 'form.submit');
    __denyValue(globalThis.HTMLFormElement && globalThis.HTMLFormElement.prototype, 'requestSubmit', 'form.requestSubmit');
    try {
      return (${expression});
    } finally {
      for (let i = __restores.length - 1; i >= 0; i--) { try { __restores[i](); } catch { /* restore is best effort */ } }
    }
  })()`
}

/** Redact secret-shaped string values inside an arbitrary JSON value (deep).
 * Values under secret-shaped KEYS are masked regardless of the value's own
 * text (a session id value need not contain the word "token"). */
export function maskEvalResult(value: unknown, depth = 0): unknown {
  if (depth > MAX_EVAL_RESULT_DEPTH) return '[depth-limit]'
  if (typeof value === 'string') return maskString(value)
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => maskEvalResult(item, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    let count = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (count >= 128) { out['…'] = '[truncated]'; break }
      count++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = (value as Record<string, unknown>)[key]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out[key] = SECRET_VALUE.test(key) ? MASK : maskEvalResult(inner, depth + 1)
    }
    return out
  }
  return value
}

// SECRET_VALUE (credential-shaped key names / free-form values) lives in
// `sensitive.ts` — single definition site shared with the URL/op-log masking
// (P1-6: the two lists had drifted).
const MASK = '****'

/** One `name=value` cookie pair (value may be quoted; empty values allowed). */
const COOKIE_PAIR = /([A-Za-z0-9_.#$%&*+\-^|~]{1,64})=(?:"[^"]*"|[^;\s]*)/gu
/** Cookie names that carry a session/CSRF credential on their own. */
const SESSION_COOKIE_NAME = /^(?:sid|s|session|sessionid|jsessionid|phpsessid|connect\.sid|csrftoken|xsrf-token|xsrf|_csrf|_session_id|auth|authorization)$/iu

/**
 * Detect a cookie/`Set-Cookie` header shape: `k=v; k2=v2` (two or more
 * `;`-separated pairs), or a single session/CSRF cookie pair (`sid=…`).
 * Cookie values are opaque credentials and cookie names are not secret-shaped,
 * so keyword matching alone never fired (P1-18) — the whole string is masked
 * rather than one fragment.
 */
function looksLikeCookieString(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3) return false
  const pairs = trimmed.match(COOKIE_PAIR)
  if (pairs === null || pairs.length === 0) return false
  if (pairs.length >= 2 && trimmed.includes(';')) return true
  const first = pairs[0]!
  return SESSION_COOKIE_NAME.test(first.slice(0, first.indexOf('=')))
}

function maskString(value: string): string {
  if (value.length === 0) return value
  // Detect BEFORE truncating: a >4 KB value (a routine cookie jar, a long
  // response body) used to be sliced and returned with its credential in the
  // clear — the P1-18 cookie-shape detector never ran (2026-09-11 audit).
  if (SECRET_VALUE.test(value) && value.length >= 6) return MASK
  if (looksLikeCookieString(value)) return MASK
  if (value.length > 4096) return `${value.slice(0, 4096)}…`
  return value
}

/** Serialize an eval result: size + depth caps applied, secrets masked.
 * Never throws. */
export function serializeEvalResult(value: unknown): string {
  const masked = maskEvalResult(value)
  let text: string
  try {
    text = JSON.stringify(masked, null, 0) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
  if (text.length > MAX_EVAL_RESULT_BYTES) {
    text = `${text.slice(0, MAX_EVAL_RESULT_BYTES)}…`
  }
  return text
}
