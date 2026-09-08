/**
 * Read-only eval policy (v4 §7.3-9): `browser_eval` accepts exactly ONE
 * expression, validated as an AST on the host side before execution.
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
 * - a whitelist of read-only helper globals is injected into the executed
 *   expression (readText/readAttr/readJson/readVar) and must not be shadowed.
 *
 * Result post-processing (execution side): JSON-serialize with size/depth
 * caps + secret masking. The mask step lives in this module for tests.
 * @module @picoaide/dsh-browser
 */

import acorn from './vendor/acorn.cjs'
import { browserError } from './errors.ts'

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
  'innerHTML',
  'outerHTML',
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
      return 'assignment/update is not allowed (read-only eval)'
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
        return 'dynamic call target is not allowed (read-only eval)'
      }
      if (name !== null && (WRITE_APIS.has(name) || name === 'eval' || name === 'Function')) {
        return `call to ${name} is not allowed (read-only eval)`
      }
    }
    if (type === 'MemberExpression') {
      const name = memberName(current)
      if (name === undefined) {
        // Non-literal computed READ is allowed (data access like data[key]).
      } else if (name !== null && WRITE_APIS.has(name)) {
        return `access to ${name} is not allowed (read-only eval)`
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
 * Wrap a validated expression for page execution: prepend the read-only
 * helper definitions (self-contained, no globals leaked) so `read*` helpers
 * work in the page context without template injection.
 */
export function wrapEvalExpression(expression: string): string {
  return `(() => {
    const __readText = (sel) => { const el = document.querySelector(sel); return el ? (el.innerText ?? el.textContent ?? '').slice(0, 4096) : null; };
    const __readAttr = (sel, name) => { const el = document.querySelector(sel); return el ? el.getAttribute(name) : null; };
    const __readJson = (sel) => { const el = document.querySelector(sel); if (!el) return null; try { return JSON.parse(el.textContent || 'null'); } catch { return null; } };
    const __readVar = (path) => { const parts = String(path).split('.'); let cur = globalThis; for (const p of parts) { cur = cur?.[p]; if (cur === undefined) return undefined; } try { return JSON.parse(JSON.stringify(cur)); } catch { return String(cur); } };
    const readText = __readText, readAttr = __readAttr, readJson = __readJson, readVar = __readVar;
    return (${expression});
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

const SECRET_VALUE = /(?:token|secret|password|passwd|authorization|api[_-]?key|session[_-]?id|access[_-]?key|refresh[_-]?token|bearer|private[_-]?key)/iu
const MASK = '****'

function maskString(value: string): string {
  if (value.length === 0) return value
  if (value.length > 4096) return `${value.slice(0, 4096)}…`
  if (SECRET_VALUE.test(value) && value.length >= 6) return MASK
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
