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
 *   DOM mutation, page-state mutation, media/presentation side effects.
 *   Network-outbound APIs (fetch/XMLHttpRequest/WebSocket/EventSource/
 *   sendBeacon) are NOT forbidden (2026-09-08 product decision).
 * - the matched NAME alone is not the verdict for a handful of names whose
 *   meaning depends on the RECEIVER (2026-09-15 audit, both directions):
 *   `String.prototype.replace` is a pure function while `location.replace` is a
 *   navigation, and `Array.prototype.sort/fill/push/…` only mutate page state
 *   when the receiver is page state rather than a value this expression built.
 *   Pure receivers are allowed; everything unprovable stays refused.
 * - reflection is checked as well (2026-09-15 audit): `Reflect.construct` is the
 *   `new` operator under another name (always refused) and `Reflect.apply` is
 *   judged against the function object it is handed, so a write API reached
 *   through it is refused exactly like a direct call. Computed member names made
 *   of concatenated string literals (`localStorage['set'+'Item']`) are folded
 *   before that judgement instead of reading as "dynamic, therefore data".
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
// EV-1：片段级 `key=value` 打码复用 store 的唯一实现（词表与 URL/摘要面同源）。
import { maskCredentialUrlsInText, maskSensitiveKeyValueText } from './store.ts'

/** Max expression length (host-side bound, far below page cost). */
export const MAX_EVAL_EXPRESSION = 8192

/** Max serialized result length. */
export const MAX_EVAL_RESULT_BYTES = 8 * 1024

/** Max result JSON depth. */
const MAX_EVAL_RESULT_DEPTH = 6

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

/**
 * Names whose verdict depends on the RECEIVER (2026-09-15 审计 P2「双向失真」）。
 *
 * 审计实测两个方向同时错：
 * - 误杀：`document.body.innerText.replace(/\s+/g,' ')` 被按名字拒绝，可它是
 *   `String.prototype.replace`——**纯函数**，不碰页面状态；
 * - 漏放：`Reflect.apply(localStorage['set'+'Item'], localStorage, [...])` 真的
 *   写进了 storage（名字匹配既没看见 `setItem`，也没看见调用关系）。
 *
 * 豁免只给**真正是纯函数的同名方法**：`replace` 在字符串接收者上不改动任何
 * 东西。`sort`/`fill`/`push`/`splice` 这些**同名物都是原地改动**（`Array.prototype`
 * 的 `sort`/`fill` 直接改接收者本身），谈不上"纯函数"，因此照旧一律拒绝——
 * `[1,2,3].push(4)` / `[1].sort()` 的既有回归断言（tests/audit-fixes.spec.ts）
 * 也要求它们保持被拒。`map` 本来就允许（返回新数组，不在写 API 表里）。
 */
const RECEIVER_AWARE_WRITE_APIS = new Set([
  // String.prototype.replace ↔ Location.replace（导航）
  'replace',
])

/** 返回字符串的内建成员方法（接收者还不是写宿主时，其返回值可证明是字符串）。
 * `replace`/`replaceAll` 也在内：链式 `a.replace(x,y).replace(z,w)` 的接收者
 * 是前一次替换的结果，按"返回值是字符串"才能继续豁免（`location.replace` 在
 * 外层已被名字规则拒掉）。 */
const STRING_RESULT_METHODS = new Set([
  'toString', 'toLocaleString', 'join', 'split', 'slice', 'substring', 'substr',
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase',
  'toLocaleLowerCase', 'toLocaleUpperCase', 'concat', 'charAt', 'charCodeAt',
  'codePointAt', 'padStart', 'padEnd', 'repeat', 'match', 'matchAll', 'search',
  'normalize', 'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf',
  'localeCompare', 'at', 'replace', 'replaceAll',
])

/** 返回字符串的元素属性（读页面的文字，不会写页面）。 */
const STRING_YIELDING_PROPERTIES = new Set([
  'innerText', 'textContent', 'outerText', 'innerHTML', 'outerHTML', 'value',
  'title', 'href', 'src', 'placeholder', 'name', 'id', 'className', 'alt',
  'label', 'content', 'text',
])

/** 直接返回字符串的全局调用。 */
const STRING_GLOBAL_CALLS = new Set([
  'String', 'readText', 'readAttr', 'encodeURIComponent', 'decodeURIComponent',
])

/** 写宿主：接收者是这些（或其点号路径）时不做任何"纯函数"豁免。 */
const WRITE_HOST_ROOTS = new Set([
  'location', 'history', 'localStorage', 'sessionStorage', 'document', 'window',
  'globalThis', 'navigator', 'top', 'parent', 'self', 'frames', 'this',
])

/** `Reflect` 的调用型方法：`construct` ≡ `new`（一律拒绝），`apply` 按目标函数判定。 */
const REFLECT_APPLY = 'apply'
const REFLECT_CONSTRUCT = 'construct'

/** 写 API 名字集合（含 receiver-aware 的那批），供反射路径复用同一判定。 */
function isWriteApiName(name: string): boolean {
  return WRITE_APIS.has(name)
}

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
      if (name !== null && (name === 'eval' || name === 'Function')) {
        return `call to ${name} is not allowed (guardrail: code-execution API)`
      }
      if (name !== null) {
        const blocked = blockedWriteCall(name, callee)
        if (blocked !== null) return blocked
      }
      const reflection = reflectViolation(current)
      if (reflection !== null) return reflection
    }
    if (type === 'MemberExpression') {
      const name = memberName(current)
      // `undefined` = 非字面量计算属性（数据访问如 data[key]，允许读取）。
      if (name !== undefined && name !== null) {
        const blocked = blockedWriteAccess(name, current)
        if (blocked !== null) return blocked
        const reflection = reflectMemberViolation(current, name)
        if (reflection !== null) return reflection
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
 * callees yield `null`.
 *
 * 2026-09-15 审计 P2：拼接出来的常量属性名（`localStorage['set'+'Item']`）也
 * 要折叠出来 —— 它此前被当成"非字面量计算属性 = 数据访问"放过，于是
 * `Reflect.apply(localStorage['set'+'Item'], …)` 真的写进了 storage。 */
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
    const folded = foldStringConcat(property)
    return folded === undefined ? undefined : folded
  }
  return null
}

/** Fold an expression made only of string literals / literal template strings
 * joined by `+` into its value; `undefined` when anything is dynamic. */
function foldStringConcat(node: AnyNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Literal') {
    return typeof (node as { value?: unknown }).value === 'string' ? (node as unknown as { value: string }).value : undefined
  }
  if (node.type === 'TemplateLiteral') {
    const expressions = (node as { expressions?: AnyNode[] }).expressions ?? []
    if (expressions.length !== 0) return undefined
    const quasis = (node as { quasis?: Array<{ value?: { cooked?: string } }> }).quasis ?? []
    return quasis.map((quasi) => quasi.value?.cooked ?? '').join('')
  }
  if (node.type === 'ParenthesizedExpression') return foldStringConcat((node as { expression?: AnyNode }).expression)
  if (node.type === 'BinaryExpression' && (node as { operator?: string }).operator === '+') {
    const left = foldStringConcat((node as { left?: AnyNode }).left)
    const right = foldStringConcat((node as { right?: AnyNode }).right)
    if (left === undefined || right === undefined) return undefined
    return left + right
  }
  return undefined
}

/** Static dotted path of an expression (`document.body.innerText`), or
 * `undefined` when any hop is dynamic. */
function staticPath(node: AnyNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Identifier') return (node as { name?: string }).name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'ChainExpression') return staticPath((node as { expression?: AnyNode }).expression)
  if (node.type === 'MemberExpression') {
    const base = staticPath((node as { object?: AnyNode }).object)
    const property = memberName(node)
    if (base === undefined || property === undefined || property === null) return undefined
    return `${base}.${property}`
  }
  return undefined
}

/** Is this receiver a page/write host (`location`, `history`, `localStorage`,
 * `document.location`, …)? Such a receiver never gets the pure-function
 * exemption. */
function isWriteHostReceiver(node: AnyNode | undefined): boolean {
  if (node === undefined) return false
  if (node.type === 'ThisExpression') return true
  const path = staticPath(node)
  if (path === undefined) return false
  if (WRITE_HOST_ROOTS.has(path)) return true
  return WRITE_HOST_ROOTS.has(path.slice(path.lastIndexOf('.') + 1))
}

/** Can this expression be proven to evaluate to a STRING (so a `replace` on it
 * is `String.prototype.replace` rather than `Location.replace`)? Fail-closed:
 * anything unprovable returns false and keeps the old by-name refusal. */
function provablyString(node: AnyNode | undefined): boolean {
  if (node === undefined) return false
  switch (node.type) {
    case 'Literal':
      return typeof (node as { value?: unknown }).value === 'string'
    case 'TemplateLiteral':
      return true
    case 'BinaryExpression':
      if ((node as { operator?: string }).operator !== '+') return false
      return provablyString((node as { left?: AnyNode }).left) || provablyString((node as { right?: AnyNode }).right)
    case 'ChainExpression':
      return provablyString((node as { expression?: AnyNode }).expression)
    case 'MemberExpression': {
      const property = memberName(node)
      return property !== undefined && property !== null && STRING_YIELDING_PROPERTIES.has(property)
    }
    case 'CallExpression': {
      const callee = (node as { callee?: AnyNode }).callee
      if (callee === undefined) return false
      if (callee.type === 'Identifier') {
        const name = (callee as { name?: string }).name
        return name !== undefined && STRING_GLOBAL_CALLS.has(name)
      }
      if (callee.type === 'MemberExpression') {
        const property = memberName(callee)
        if (property === undefined || property === null) return false
        if (property === 'stringify' && staticPath((callee as { object?: AnyNode }).object) === 'JSON') return true
        if (!STRING_RESULT_METHODS.has(property)) return false
        return !isWriteHostReceiver((callee as { object?: AnyNode }).object)
      }
      return false
    }
    default:
      return false
  }
}

/** The receiver of a member expression / of a member callee. */
function receiverOf(node: AnyNode | undefined): AnyNode | undefined {
  if (node === undefined) return undefined
  if (node.type === 'ChainExpression') return receiverOf((node as { expression?: AnyNode }).expression)
  if (node.type === 'MemberExpression') return (node as { object?: AnyNode }).object
  return undefined
}

/** The 2026-09-15 audit's receiver-aware exemption: a receiver-dependent name is
 * allowed only when the receiver is provably a string (`replace`) or provably a
 * fresh value (`sort`/`fill`/`push`/…). */
function receiverExempt(name: string, receiver: AnyNode | undefined): boolean {
  if (!RECEIVER_AWARE_WRITE_APIS.has(name)) return false
  if (isWriteHostReceiver(receiver)) return false
  // 只有"接收者可证明是字符串"时才豁免：此时 `replace` 必然是
  // String.prototype.replace（纯函数）。证明不了就维持旧的名字拒绝（fail-closed）。
  return provablyString(receiver)
}

function blockedWriteCall(name: string, callee: AnyNode | undefined): string | null {
  if (!isWriteApiName(name)) return null
  if (receiverExempt(name, receiverOf(callee))) return null
  return `call to ${name} is not allowed (guardrail: code-execution/side-effect API)`
}

function blockedWriteAccess(name: string, member: AnyNode): string | null {
  if (!isWriteApiName(name)) return null
  if (receiverExempt(name, receiverOf(member))) return null
  return `access to ${name} is not allowed (guardrail: side-effect API)`
}

/** The statically-known `Reflect.<method>` name of a callee, `undefined` when
 * the callee is not a `Reflect` member (`''` = dynamic property name). */
function reflectMethodOf(callee: AnyNode | undefined): string | undefined {
  let node = callee
  if (node !== undefined && node.type === 'ChainExpression') node = (node as { expression?: AnyNode }).expression
  if (node === undefined || node.type !== 'MemberExpression') return undefined
  if (staticPath((node as { object?: AnyNode }).object) !== 'Reflect') return undefined
  const name = memberName(node)
  if (name === undefined) return ''
  return name === null ? undefined : name
}

/** 2026-09-15 审计 P2：反射调用不得成为写 API 的替代入口。
 * - `Reflect.construct` ≡ `new`（本来就是被拒的代码执行）；
 * - `Reflect.apply(fn, …)`：fn 必须是**静态可解析的点号函数对象**，且不能是
 *   写 API、也不能挂在写宿主上（`localStorage['set'+'Item']` 折叠后即命中）；
 * - `Reflect.get(target, key)`：key 折叠出写 API 名 ⇒ 拒；key 动态且目标不明 ⇒
 *   拒（证明不了它不是写 API）。 */
function reflectViolation(call: AnyNode): string | null {
  const method = reflectMethodOf((call as { callee?: AnyNode }).callee)
  if (method === undefined) return null
  if (method === '') return 'Reflect with a computed method name is not allowed (guardrail: reflection)'
  const args = (call as { arguments?: AnyNode[] }).arguments ?? []
  if (method === REFLECT_CONSTRUCT) {
    return 'Reflect.construct is not allowed (guardrail: construction is code execution, like `new`)'
  }
  if (method === REFLECT_APPLY) {
    const target = args[0]
    if (target === undefined || target.type !== 'MemberExpression' || staticPath(target) === undefined) {
      return 'Reflect.apply needs a statically known function object (guardrail: a dynamic target can hide a write API)'
    }
    const path = staticPath(target)!
    const name = path.slice(path.lastIndexOf('.') + 1)
    if (isWriteApiName(name)) {
      return `Reflect.apply to ${name} is not allowed (guardrail: reflection must not smuggle a side-effect API)`
    }
    const root = path.slice(0, path.indexOf('.') < 0 ? path.length : path.indexOf('.'))
    if (WRITE_HOST_ROOTS.has(root)) {
      return `Reflect.apply on ${root} is not allowed (guardrail: reflection must not smuggle a side-effect API)`
    }
    return null
  }
  if (method === 'get') {
    const target = args[0]
    const key = foldStringConcat(args[1])
    if (key !== undefined && isWriteApiName(key)) {
      return `Reflect.get(...['${key}']) is not allowed (guardrail: reflection must not smuggle a side-effect API)`
    }
    const path = staticPath(target)
    if (path !== undefined && (WRITE_HOST_ROOTS.has(path) || WRITE_HOST_ROOTS.has(path.slice(0, path.indexOf('.') < 0 ? path.length : path.indexOf('.'))))) {
      return `Reflect.get on ${path} is not allowed (guardrail: reflection must not smuggle a side-effect API)`
    }
    if (key === undefined) {
      return 'Reflect.get with a computed key is not allowed (guardrail: the key can name a write API)'
    }
    return null
  }
  return null
}

/** `Reflect.construct` read as a value (`Reflect.construct.call(...)` is the
 * obvious smuggling shape) is refused for the same reason a call is. */
function reflectMemberViolation(member: AnyNode, name: string): string | null {
  if (name !== REFLECT_CONSTRUCT) return null
  if (staticPath((member as { object?: AnyNode }).object) !== 'Reflect') return null
  return 'Reflect.construct is not allowed (guardrail: construction is code execution, like `new`)'
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

/**
 * Value-level projection of one string on its way into the serialized result
 * (F-5, 2026-09-13 round 2).
 *
 * The runtime passes its injected-credential redactor here so that the
 * value-exact masking of {@link maskString} and the size caps below happen in
 * the order that cannot leave a fragment: **project, then cut**. Before this,
 * `maskString` sliced a >4 KB value at 4096 and `serializeEvalResult` sliced
 * the serialized text at 8 KB, and the runtime's redactor only saw the result
 * — a password straddling either cut came back as a plaintext head fragment.
 */
export type EvalValueProjection = (text: string) => string

/** Redact secret-shaped string values inside an arbitrary JSON value (deep).
 * Values under secret-shaped KEYS are masked regardless of the value's own
 * text (a session id value need not contain the word "token").
 *
 * `project` (F-5) runs on every string that survives the depth/width caps —
 * values AND object keys, because a page-chosen key is page-controlled text
 * too — BEFORE the 4 KB per-value cap (see {@link maskString}). */
export function maskEvalResult(value: unknown, depth = 0, project?: EvalValueProjection): unknown {
  if (depth > MAX_EVAL_RESULT_DEPTH) return '[depth-limit]'
  if (typeof value === 'string') return maskString(value, project)
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => maskEvalResult(item, depth + 1, project))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    let count = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (count >= 128) { out['…'] = '[truncated]'; break }
      count++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = (value as Record<string, unknown>)[key]
      // The KEY is projected before it is cut away with the rest of the text
      // (F-5): a page-chosen key longer than the serialized cap used to be
      // truncated by `serializeEvalResult` with the credential still in it.
      const safeKey = project === undefined ? key : project(key)
      // R23 N3：`cookie` / `Set-Cookie` 是**取值容器**键（`{cookie: 'a=1; b=2'}`），
      // 与 `SECRET_VALUE`（值形态词表）同一口径：键名本身就是"值整体是凭据材料"
      // 的声明。`code`/`session` 这类普通词不在此列，所以 `{code: 'token'}` 不动。
      out[safeKey] = SECRET_VALUE.test(key) || COOKIE_JAR_KEY.test(key) ? MASK : maskEvalResult(inner, depth + 1, project)
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
/** Cookie **flag** attributes（`HttpOnly`/`Secure`/`Partitioned`，都是无值形态；带 `=`
 *  的 `secure=` 是普通配置键，不算信号）与取值属性（`SameSite=`/`Expires=`/`Max-Age=`）。
 *  `Path=`/`Domain=` 刻意**不**在这里：它们是 CSS/配置里常见的普通键（`path=/api`）。 */
const COOKIE_ATTRIBUTE = /(?:^|[;\s])(?:httponly|secure|partitioned)\b(?!\s*=)|(?:^|[;\s])(?:expires|max-age|samesite)\s*=/iu
/** A KEY whose value is a whole cookie jar (`{cookie: 'a=1; b=2'}`, `Set-Cookie`). */
const COOKIE_JAR_KEY = /^(?:set-)?cookie$/iu

/**
 * Detect a cookie/`Set-Cookie` **jar** shape: a session/CSRF cookie name is
 * present (`sid=…`, `jsessionid=…`) or a cookie flag/attribute is present
 * (`…; HttpOnly`, `…; SameSite=Lax`). Cookie values are opaque credentials and
 * cookie names are not secret-shaped, so keyword matching alone never fired
 * (P1-18) — such a string is masked whole rather than one fragment.
 *
 * `Cookie:`/`Set-Cookie:` **头**形态不在这里判：那条路由
 * {@link COOKIE_HEADER_VALUE} 按头名擦掉取值（`Cookie: a=b` → `Cookie: ****`，
 * 键名保留），整串打码只留给"裸的 jar"（P1-18 的回归面）。
 *
 * R23 N3（2026-09-26）：判据以前是"**≥2 个 `k=v` 且串里有 `;`**"，于是任何分号
 * 分隔的普通正文（CSS 内联样式 `width=100; height=200`、配置片段、日志行）都被
 * 整串抹成 `****`，连键名一起消失 —— 那正是 EV-1 要修的形态，而同一段文本经
 * `browser_get_text` 逐字可读。现在只有**真的 cookie jar**才整串打码（两条信号，
 * 与 {@link COOKIE_HEADER_VALUE} 的"按头名判定"同一精神）；普通 `k=v; k2=v2`
 * 交给片段级规则 —— 敏感键的值照样被擦（`password=hunter2xyz` → `password=****`），
 * 普通键值对逐字保留。
 */
function looksLikeCookieString(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3) return false
  const pairs = trimmed.match(COOKIE_PAIR)
  if (pairs === null || pairs.length === 0) return false
  if (pairs.some((pair) => SESSION_COOKIE_NAME.test(pair.slice(0, pair.indexOf('='))))) return true
  return pairs.length >= 2 && trimmed.includes(';') && COOKIE_ATTRIBUTE.test(trimmed)
}

/**
 * 整串**就是**一个凭据的形态（EV-1：只有整串符合这些形状才整串打码）。
 *
 * 每条都要求整个字符串就是那个凭据，而不是"提到了某个词"：
 *  - HTTP 认证头取值（`Bearer <token>` / `Basic <base64>`）：方案的尾巴必须是
 *    一个不带空格的凭据串 —— `Bearer of good news` 这类散文因此不命中；
 *  - JWT（三段 base64url）；
 *  - 带**公认前缀**的 API key（`sk-`/`ghp_`/`glpat-`/`xoxb-`/`AKIA…`）：前缀本身就
 *    是"这是凭据"的声明，前缀之后还要求 ≥12 位，slug/CSS 类名不会命中。
 *
 * 认账边界（EV-1 的取舍）：**裸的、不带前缀也不含数字的不透明串**不再整串打码
 * （`dXNlcjpwYXNz` 这类 base64 凭据）。旧实现也不打码（`SECRET_VALUE` 只认关键词），
 * 所以这不是覆盖度回退；而放宽整串规则换来的是"普通正文不再被抹成 ****"。真正
 * 需要兜住的三条仍在：①注入凭据走 `project`（值级精确脱敏）；②`Authorization: Basic …`
 * 这类形态由 {@link AUTH_HEADER_VALUE} **整段**擦掉取值（2026-09-26 R22 V6 F2 之前这里
 * 写的是"由 `key=value`/`key: value` 片段规则擦掉值"—— 实测那句话是**假的**：那条规则
 * 在第一个空格处收尾，擦掉的是方案名、凭据留明文）；③**有声明**的裸串（`token <纯字母
 * 不透明串>`）由 {@link KEYWORD_SPAN} + {@link isDeclaredCredentialSpan} 擦掉 ——
 * 声明在场时不再要求"含数字"，所以这条边界只覆盖"既无前缀也无关键词"的形态。
 */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /^bearer\s+[A-Za-z0-9._~+/=-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u,
  /^(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_-]{12,}$/u,
]

/**
 * 敏感关键词后紧跟的 opaque 片段（`token abc123def456` / `Bearer eyJ…`）：
 * 只擦**这个片段**，不是整串（EV-1）。
 *
 * R23 N1（2026-09-26）：关键词命中本身就是"这是凭据声明"，片段是否打码由
 * {@link isDeclaredCredentialSpan} 判定 —— 不再要求片段"同时含数字与字母"
 * （`token ABCDEFGHIJKLMNOPQRSTUVWX` 这类**纯字母**不透明串曾原样出窗）。
 *
 * 片段**不得以分隔符开头**（`(?![=:])`）：`=`/`:` 也在片段的字符集里（base64
 * padding 用到 `=`），没有这条时 `api_key=example`（值只有 7 位）会让分隔符被
 * 回溯进片段、连 `=` 一起被掩码成 `api_key****`；这种形态本该交给 `key=value`
 * 规则，输出 `api_key=****`（键与分隔符保留）。
 */
const KEYWORD_SPAN = /(\b(?:token|secret|password|passwd|pwd|authorization|api[_-]?key|apikey|session[_-]?id|access[_-]?key|refresh[_-]?token|private[_-]?key|bearer|credential)\b\s*(?:[:=]\s*)?["']?)((?![=:])[A-Za-z0-9_+/.=-]{8,})/giu

/**
 * 单个英文单词的形态（首字母任意大小写、其余小写）：`authentication`、
 * `Rotation`、`expiration`。这是声明门限下**唯一**被排除的形状。
 */
const PROSE_WORD_SHAPE = /^[A-Za-z][a-z]+$/u

/**
 * 纯字母"单词"超过这个长度就不像英文词了：英文词极少有 ≥16 个字母的，而
 * 无数字的纯字母句柄（`deadbeefcafebabe`）正好落在这条线之上。
 */
const PROSE_WORD_MAX_LENGTH = 16

/** 片段是否只是散文里的一个英文词（`token authentication` 不许被当成凭据）。 */
function isProseLikeSpan(span: string): boolean {
  return span.length < PROSE_WORD_MAX_LENGTH && PROSE_WORD_SHAPE.test(span)
}

/**
 * **声明之后**的片段是否按凭据打码 —— `KEYWORD_SPAN` 与 `AUTH_HEADER_VALUE`
 * 共用的同一份判据（R23 N1，与 R22 V6 F2 的"方案名即声明"同源）。
 *
 * 判据的**声明**部分由调用方给出（关键词命中 / 认证方案名在场），这里只判片段：
 *
 *  - 命中 {@link CREDENTIAL_VALUE_SHAPES} 的形状（`Bearer x` / JWT / 带公认前缀的
 *    key）⇒ 是凭据；
 *  - 否则只要**不像散文里的一个英文词**（见 {@link isProseLikeSpan}）就算凭据：
 *    `ABCDEFGHIJKLMNOPQRSTUVWX`（纯大写）、`aBcDeFgHiJkL`（混合大小写）、
 *    `deadbeefcafebabe`（16 个纯小写字母）都命中，`authentication`（14 个纯小写
 *    字母）、`Rotation` 不命中。
 *
 * 为什么不再要求"同时含数字与字母"：那是**按长度/字符集**判定，等于把
 * `token <纯字母不透明串>` 这一族（base64 长度 ≥12 时无数字的概率约 8.5%）留在
 * 明文里 —— 同一份实现里 `Authorization: Basic <无数字 b64>` 早就靠"方案名"擦掉了，
 * 关键词分支没有理由用更弱的判据。
 *
 * 认账边界：**纯小写或首字母大写的 8–15 位纯字母串**（`token abcdefghij`）与英文词
 * 在形状上不可分，仍按散文保留（随机 base64 命中该形状的概率 ≈ (26/64)^12 ≈ 0.024%）。
 *
 * 代价（认账，方向与 {@link maskSensitiveKeyValueText} 的"fail-closed"一致）：
 * **全大写**的英文短语（`PASSWORD EXPIRATION`）会被当成不透明串打码 —— 全大写散文与
 * 全大写句柄在形状上不可分，而掩码可恢复、明文泄漏不可恢复。
 */
function isDeclaredCredentialSpan(span: string): boolean {
  if (CREDENTIAL_VALUE_SHAPES.some((shape) => shape.test(span))) return true
  return !isProseLikeSpan(span)
}

/**
 * `Authorization` / `Proxy-Authorization` 头的**取值**（`<scheme> <credential>`）。
 *
 * 这类键的值有两段（方案名 + 凭据），而 `maskSensitiveKeyValueText` 的 `key: value`
 * 规则在**第一个空格**处收尾 ⇒ 它擦掉的是**方案名**、真正的凭据反而落单；第二趟
 * `KEYWORD_SPAN` 这时又看不到方案名（而且 `basic` 本来就不在它的关键词表里），于是
 * `Authorization: Bearer <jwt>` 出窗时是 `Authorization: **** <jwt>` —— 凭据明文进
 * 模型上下文（2026-09-26 R22 V6 F2）。这条规则跑在片段级两趟**之前**，把整个取值
 * （含方案名）换成掩码。
 *
 * 两道门限，避免把散文改坏：
 *  - 只有**公认的认证方案**才算"这是凭据"的声明（`Authorization: none required` 这类
 *    普通取值不命中；`saml` 于 R23 N1 补入，与 `oauth2?` 同族）；
 *  - 没有方案名时仍可整体掩码，但片段要过 {@link isDeclaredCredentialSpan}（形状/长度）。
 *    方案名在场时是**无条件**声明（不再过形状门限）：`Authorization: Bearer abcdefghij`
 *    这类无数字、纯小写的句柄必须仍被擦掉 —— 关键词分支的"反散文"豁免在这里不适用，
 *    因为头名 + 认证方案已经把它标记成凭据位。
 */
const AUTH_HEADER_VALUE = /(\b(?:proxy-)?authorization\b\s*[:=]\s*["']?)(?:(?:bearer|basic|digest|token|apikey|api[_-]?key|negotiate|ntlm|oauth2?|saml)\s+)?([A-Za-z0-9_+/.=~-]{8,})/giu

/**
 * `Cookie` / `Set-Cookie` 头的取值（cookie 对 `k=v`，可 `; ` 分隔多条）。
 *
 * 会话 cookie 名在 {@link SESSION_COOKIE_NAME} 里，所以"整个字符串就是 cookie 串"的
 * 形态早就在 `maskString` 的整串分支被打码（P1-18 的回归面）。落单的是**单条、且
 * cookie 名不在名单里**的形态（`Cookie: a=b`）：`cookie` 有意不在
 * `SENSITIVE_KEY_PATTERN` 的词表里（URL 面的 `?cookie=` 逐字节不动），于是它既不命中
 * 整串形状、也不命中 `key: value` ⇒ 值原样出窗（2026-09-26 R22 V6 F2 的判据形态）。
 * cookie 头的取值整体是凭据材料，这里按"值必须真的是 cookie 对"的形状门限擦掉它 ——
 * 散文（`Cookie: the browser sends cookies`）没有 `k=v` 形态，不命中。
 */
const COOKIE_HEADER_VALUE = /(\b(?:set-)?cookie\b\s*[:=]\s*)([A-Za-z0-9_.#$%&*+\-^|~]{1,64}=[^\s;,]+(?:\s*;\s*[A-Za-z0-9_.#$%&*+\-^|~]{1,64}=[^\s;,]+)*)/giu

/**
 * 片段级凭据打码（2026-09-23 审计 EV-1）。
 *
 * 旧实现：`SECRET_VALUE.test(value) && value.length >= 6` ⇒ **整串** `****`。
 * `SECRET_VALUE` 是无词边界的子串正则，于是任何"提到"这些词的普通正文都变成零信息
 * ——`browser_eval` 读 `document.body.innerText`/`document.title` 时，页面里出现
 * "password reset"、"token budgets"、"the secret garden" 这类措辞，模型拿到的是
 * `****`；而**同一段文本**经 `browser_get_text` 是正常可读的 ⇒ 两个工具对同一数据
 * 自相矛盾。
 *
 * 现在的口径（与 `browser_get_text`/op log 同族：先形态、再片段）：
 *  1. 整串**就是** cookie 头/会话 cookie/带 cookie 属性（{@link looksLikeCookieString}）
 *     或是凭据形态 ⇒ 整串打码（cookie 值本身无键可依，键名匹配永远指不到它，
 *     这条是 P1-18 的回归面）—— R23 N3 起"≥2 个 `k=v` 且含 `;`"不再算 cookie 串，
 *     普通键值列表交给片段级规则；
 *  2. 否则只擦片段，**四趟顺序固定为：内嵌 URL（{@link maskCredentialUrlsInText}）
 *     → 认证/cookie 头取值 → 关键词 + opaque 片段 → `key=value`/`key: value`
 *     的敏感值**（最后一趟复用 store 的唯一实现
 *     {@link maskSensitiveKeyValueText}，与 URL/摘要面同一张词表）；
 *  3. 其余正文原样保留。
 *
 * **为什么是这个顺序**（2026-09-26 R22 V6 F2 / R23 N2）：`key: value` 规则在第一个
 * 空格处收尾，所以它跑在前面时会把"方案名 / 第二个关键词"先擦成 `****`，后面的关键词
 * 片段规则就再也认不出 `<keyword> <credential>` 形态 ⇒ 真正的凭据留明文
 * （`Authorization: Bearer <jwt>` → `Authorization: **** <jwt>`）。URL 那一趟跑在
 * 最前面则是因为 userinfo **没有键**，只有 URL 结构能看见它。四趟都只**增加**掩码、
 * 从不还原，所以顺序只会比旧顺序更严，不会漏；认证头与 cookie 头还要在片段级之前
 * **整段**擦掉取值（见 {@link AUTH_HEADER_VALUE} / {@link COOKIE_HEADER_VALUE}）。
 *
 * 顺序不变（F-5）：**先掩码后截断**，`project` 仍然在 4 KB 上限之前跑 —— 跨截断点
 * 的凭据只会以 `****` 的形式出现。
 */
function maskCredentialFragments(value: string): string {
  // R23 N2: 内嵌 URL 的 userinfo/查询串先擦（与标题/摘要面同一份实现
  // `store.maskCredentialUrlsInText`）。userinfo 没有键、也不含关键词，只有 URL
  // 结构能看见它；跑在最前面是因为 URL 是最具体的结构，之后的片段级规则只会
  // 在此基础上继续**增加**掩码。
  const urls = maskCredentialUrlsInText(value)
  const headers = urls
    .replace(AUTH_HEADER_VALUE, (match, key: string, scheme: string | undefined, span: string) =>
      (scheme !== undefined || isDeclaredCredentialSpan(span)) ? `${key}${MASK}` : match)
    .replace(COOKIE_HEADER_VALUE, (_match: string, key: string) => `${key}${MASK}`)
  const spans = headers.replace(KEYWORD_SPAN, (match, prefix: string, span: string) =>
    isDeclaredCredentialSpan(span) ? `${prefix}${MASK}` : match)
  return maskSensitiveKeyValueText(spans)
}

function maskString(value: string, project?: EvalValueProjection): string {
  if (value.length === 0) return value
  // Detect BEFORE truncating: a >4 KB value (a routine cookie jar, a long
  // response body) used to be sliced and returned with its credential in the
  // clear — the P1-18 cookie-shape detector never ran (2026-09-11 audit).
  if (looksLikeCookieString(value) || CREDENTIAL_VALUE_SHAPES.some((shape) => shape.test(value))) return MASK
  const masked = maskCredentialFragments(value)
  // F-5 (2026-09-13 round 2): the caller's value-level projection runs BEFORE
  // the cap. The other order (slice, then let `runtime.eval` redact the
  // serialized text) left the head of a credential that straddled the cut in
  // the clear, followed by `…` so the R7 tail backstop could not see it either.
  const projected = project === undefined ? masked : project(masked)
  if (projected.length > 4096) return `${projected.slice(0, 4096)}…`
  return projected
}

/** Serialize an eval result: size + depth caps applied, secrets masked.
 * Never throws.
 *
 * `project` (F-5, 2026-09-13 round 2) is the caller's value-level projection,
 * applied to every string value/key BEFORE the per-value and total caps, so a
 * credential straddling a cut is masked instead of clipped into a fragment. */
export function serializeEvalResult(value: unknown, project?: EvalValueProjection): string {
  const masked = maskEvalResult(value, 0, project)
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
