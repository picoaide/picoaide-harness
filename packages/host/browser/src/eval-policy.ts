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
 *   fetch, XMLHttpRequest, sendBeacon, WebSocket constructor, setItem
 *   (storage), document.write, form submit, window.open, alerts, print,
 *   crypto.subtle? no — subtle is read-only; history/replaceState,
 *   location assignment, cookie assignment, focus? allowed.
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

/** Member base names treated as side-effect/write entry points. */
const WRITE_APIS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'setItem',
  'write',
  'submit',
  'open',
  'alert',
  'confirm',
  'prompt',
  'print',
  'pushState',
  'replaceState',
  'assign',
  'reload',
  'postMessage',
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
      const name = memberName(callee)
      if (name !== null && WRITE_APIS.has(name)) {
        return `call to ${name} is not allowed (read-only eval)`
      }
    }
    if (type === 'MemberExpression') {
      const name = memberName(current)
      if (name !== null && WRITE_APIS.has(name)) {
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

/** Resolve the dotted member name of a callee/member (a.b.c → 'c'), null if computed. */
function memberName(node: AnyNode | undefined): string | null {
  if (node === undefined) return null
  if (node.type === 'Identifier') return (node as { name?: string }).name ?? null
  if (node.type === 'MemberExpression' && (node as { computed?: boolean }).computed !== true) {
    const property = (node as { property?: AnyNode }).property
    if (property !== undefined && property.type === 'Identifier') return (property as { name?: string }).name ?? null
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

/** Redact secret-shaped string values inside an arbitrary JSON value (deep). */
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
      out[key] = maskEvalResult((value as Record<string, unknown>)[key], depth + 1)
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
