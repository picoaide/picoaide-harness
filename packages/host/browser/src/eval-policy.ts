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

/** Member property names that make a member chain a code-execution path.
 *
 * Checked at EVERY link of a member chain (not just the outermost property):
 * `('').constructor.constructor` must be rejected at the first `constructor`.
 * Name-based (base-agnostic) on purpose: `Reflect.construct`,
 * `Reflect['construct']`, `Reflect?.construct` and any other `.construct`
 * are all covered by one rule, and aliasing the base object cannot evade it.
 *
 * - constructor/prototype/__proto__: constructor-chain code execution (P1-1)
 * - eval/Function: code-execution primitives reachable as member values
 * - call/apply/bind/construct: call trampolines + Reflect construction (P1-2)
 * - getOwnPropertyDescriptor(s)/__lookupGetter__/__lookupSetter__: reflection
 *   APIs whose result carries `.value`/getter straight to `Function`.
 *   NOTE: `Object.getPrototypeOf` is deliberately NOT listed — the resulting
 *   value's `.constructor` is already caught by this same chain rule.
 */
const DANGEROUS_MEMBERS = new Set([
  'constructor', 'prototype', '__proto__',
  'eval', 'Function',
  'call', 'apply', 'bind', 'construct',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors',
  '__lookupGetter__', '__lookupSetter__',
])

interface AnyNode {
  type: string
  [key: string]: unknown
}

/** Keys that carry acorn bookkeeping rather than child AST nodes. */
const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'raw', 'range'])

/** Visit every direct child AST node of `node` (single walk implementation
 * shared by the pre-scan and the main traversal). */
function forEachChild(node: AnyNode, fn: (child: AnyNode, key: string, index: number | null) => void): void {
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        if (isNode(item)) fn(item, key, i)
      }
    } else if (isNode(value)) {
      fn(value, key, null)
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

/** Walk the AST; returns the first violation reason or null.
 *
 * Scope-aware (FIX-3): `arrowBindings` maps each arrow function to the names
 * its parameter patterns bind, and the recursion carries the chain of
 * enclosing arrows. A bare-identifier call is an unverifiable alias only when
 * the callee name is bound by an ENCLOSING arrow AND the value that reaches
 * that binding is not statically provable to be harmless. The previous version
 * collected every parameter name into one global set, so
 * `[() => 1].map(f => f())` was rejected for an unrelated arrow's `f`.
 *
 * Bindings are unwrapped through EVERY parameter form (FIX-1): Identifier,
 * ObjectPattern (nested / renamed / computed keys), ArrayPattern,
 * AssignmentPattern (defaults) and RestElement.
 */
function findViolation(node: AnyNode, source: string): string | null {
  // Pre-scan: per-arrow parameter bindings + parent links (needed to resolve
  // where an arrow's parameters actually receive their values) + the node
  // kinds that can hand a value back out of a sub-expression.
  const arrowBindings = new Map<AnyNode, Set<string>>()
  const parents = new Map<AnyNode, { parent: AnyNode; key: string; index: number | null }>()
  /** Arrow functions nested inside a value expression (indexed by container). */
  const nestedArrows = new Map<AnyNode, AnyNode[]>()
  /** Identifiers bound under a dangerous pattern key (`{a: [c]}` → c). */
  const taintedBindings = new Set<string>()
  {
    const walk: AnyNode[] = [node]
    while (walk.length > 0) {
      const cur = walk.pop()!
      if (cur.type === 'ArrowFunctionExpression') {
        const names = new Set<string>()
        for (const param of ((cur as { params?: AnyNode[] }).params ?? [])) {
          collectPatternNames(param, names)
          // A non-Identifier binding form yields a piece of an aggregate whose
          // contents are not statically provable → calls through it are denied.
          if (param.type !== 'Identifier') collectTaintedNames(param, taintedBindings)
        }
        arrowBindings.set(cur, names)
      }
      const arrows: AnyNode[] = []
      forEachChild(cur, (child, key, index) => {
        parents.set(child, { parent: cur, key, index })
        if (child.type === 'ArrowFunctionExpression') arrows.push(child)
        walk.push(child)
      })
      if (arrows.length > 0) nestedArrows.set(cur, arrows)
    }
  }
  // Enclosing arrow chain (innermost last) for the node being visited.
  const arrowAncestors: AnyNode[] = []
  const enclosingBinding = (name: string): AnyNode | null => {
    for (let i = arrowAncestors.length - 1; i >= 0; i--) {
      const arrow = arrowAncestors[i]!
      if (arrowBindings.get(arrow)?.has(name) === true) return arrow
    }
    return null
  }
  const boundInEnclosingArrow = (name: string): boolean => enclosingBinding(name) !== null

  /** Values that can flow into an arrow's parameters, when statically known. */
  const incomingValues = (arrow: AnyNode): AnyNode[] | null => {
    const link = parents.get(arrow)
    if (link === undefined) return null
    const { parent, key } = link
    if (parent.type === 'CallExpression' && key === 'callee') {
      return ((parent as { arguments?: AnyNode[] }).arguments ?? [])
    }
    if (parent.type === 'CallExpression' && key === 'arguments') {
      const callee = (parent as { callee?: AnyNode }).callee
      if (callee !== undefined && callee.type === 'MemberExpression') {
        const receiver = unwrapChain((callee as { object?: AnyNode }).object)
        if (receiver !== undefined && receiver.type === 'ArrayExpression') {
          return ((receiver as { elements?: (AnyNode | null)[] }).elements ?? [])
            .filter((element): element is AnyNode => element !== null && element !== undefined)
        }
      }
      return null
    }
    return null
  }
  /** A bare alias call is allowed only when every incoming value is provably
   * inert (literal / inline arrow / literal aggregate): `[() => 1].map(f => f())`
   * passes, while `(f => f('alert(1)'))(setTimeout)` and
   * `Object.values(window).map(v => v('x'))` do not. */
  const aliasBindingProvablySafe = (arrow: AnyNode): boolean => {
    const values = incomingValues(arrow)
    if (values === null) return false
    return values.every((value) => isProvablySafeValue(value))
  }

  /** Reason when a VALUE position carries a banned/dangerous reference.
   * Recurses through composite value expressions so an identifier cannot be
   * smuggled inside an array/object/sequence (`[setTimeout].map(f => f('1'))`,
   * `[1].map((0, alert))`). */
  const dangerousValue = (value: AnyNode | undefined | null): string | null => {
    const node = unwrapChain(value ?? undefined)
    if (node === undefined) return null
    /** Composite expressions whose danger is exactly "some child is
     * dangerous" share ONE child walk (D-1) instead of a hand-written
     * per-node property list. */
    const anyChildDangerous = (current: AnyNode): string | null => {
      let reason: string | null = null
      forEachChild(current, (child) => {
        if (reason !== null) return
        reason = dangerousValue(child)
      })
      return reason
    }
    switch (node.type) {
      case 'Identifier': {
        const name = (node as { name?: string }).name
        if (name === undefined) return null
        if (name === 'eval' || name === 'Function') return 'eval/Function is not allowed'
        if (DANGEROUS_MEMBERS.has(name) || WRITE_APIS.has(name)) {
          return `access to ${name} is not allowed (read-only eval)`
        }
        return null
      }
      case 'MemberExpression': {
        const chain = firstDangerousChainLink(node)
        if (chain !== null) return chain
        const name = memberName(node)
        if (name !== undefined && name !== null && WRITE_APIS.has(name)) {
          return `access to ${name} is not allowed (read-only eval)`
        }
        // R3-P0: a computed key whose name cannot be resolved at validation
        // time is fine for a plain READ (`data[key]`) but must never hand its
        // member VALUE to a consumer (callback/argument/property value/…):
        // `window[String.fromCharCode(101,118,97,108)]` IS `window.eval`.
        const unverifiable = unverifiableComputedKey(node)
        if (unverifiable !== null) return unverifiable
        return null
      }
      case 'CallExpression': {
        // Reflective read that resolves to a banned member value:
        // `Reflect.get(window, 'open')` IS the banned API as a value.
        const calleeName = callTargetName((node as { callee?: AnyNode }).callee)
        if (calleeName === 'get' || calleeName === 'getOwnPropertyDescriptor') {
          for (const argument of ((node as { arguments?: AnyNode[] }).arguments ?? [])) {
            // `Reflect.get(window, ...['eval'])` SPREADS the name argument, so
            // the effective name is the spread source's elements, not the array.
            const nameNodes = reflectiveNameNodes(argument)
            if (nameNodes === null) return UNVERIFIABLE_KEY_REASON
            for (const nameNode of nameNodes) {
              const literal = constantStringValue(nameNode)
              if (literal !== undefined && (WRITE_APIS.has(literal) || DANGEROUS_MEMBERS.has(literal))) {
                return `access to ${literal} is not allowed (read-only eval)`
              }
              // R3-P0: the name argument can also be computed at runtime
              // (`Reflect.get(window, String.fromCharCode(101,118,97,108))`).
              const unverifiable = unverifiableKeyExpression(nameNode)
              if (unverifiable !== null) return unverifiable
            }
          }
        }
        return null
      }
      case 'ObjectExpression':
        for (const property of ((node as { properties?: AnyNode[] }).properties ?? [])) {
          if (property.type !== 'Property') return 'dynamic call target is not allowed (read-only eval)'
          const reason = dangerousValue((property as { value?: AnyNode }).value)
          if (reason !== null) return reason
        }
        return null
      case 'ArrayExpression':
      case 'SequenceExpression':
      case 'ConditionalExpression':
      case 'LogicalExpression':
      case 'BinaryExpression':
      case 'TemplateLiteral':
      case 'UnaryExpression':
        return anyChildDangerous(node)
      case 'SpreadElement':
        return dangerousValue((node as { argument?: AnyNode }).argument)
      case 'AssignmentExpression':
        return dangerousValue((node as { right?: AnyNode }).right)
      default:
        return null
    }
  }

  /** Reason when a member-access call target's VALUE is not provably inert.
   * `({a:1}).a()` and `({g: () => 1}).g()` pass; `({f: setTimeout}).f('1')`
   * and `((o) => o.g('x'))({g: window[k]})` do not. */
  const memberTargetReason = (callee: AnyNode | undefined): string | null => {
    const node = unwrapChain(callee)
    if (node === undefined || node.type !== 'MemberExpression') return null
    const keyName = memberName(node)
    if (keyName === undefined || keyName === null) return null
    let target = unwrapChain((node as { object?: AnyNode }).object)
    if (target !== undefined && target.type === 'Identifier') {
      const name = (target as { name?: string }).name
      if (name === undefined || !boundInEnclosingArrow(name)) return null
      const arrow = enclosingBinding(name)
      const values = arrow === null ? null : incomingValues(arrow)
      if (values === null || values.length !== 1) return null
      target = unwrapChain(values[0])
    }
    if (target === undefined || target.type !== 'ObjectExpression') return null
    for (const property of ((target as { properties?: AnyNode[] }).properties ?? [])) {
      if (property.type !== 'Property') return `dynamic call target is not allowed (read-only eval)`
      if (propertyKeyName((property as { key?: AnyNode }).key) !== keyName) continue
      if (!isProvablySafeValue((property as { value?: AnyNode }).value)) {
        return `call to ${keyName} is not allowed (read-only eval)`
      }
      return null
    }
    return null
  }

  const visit = (current: AnyNode): string | null => {
    const type = current.type
    const isArrow = type === 'ArrowFunctionExpression'
    if (isArrow) arrowAncestors.push(current)
    try {
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
        if (name !== null && DANGEROUS_MEMBERS.has(name)) {
          return `call to ${name} is not allowed (read-only eval)`
        }
        if (name !== null && (WRITE_APIS.has(name) || name === 'eval' || name === 'Function')) {
          return `call to ${name} is not allowed (read-only eval)`
        }
        if (name !== null && boundInEnclosingArrow(name)) {
          const arrow = enclosingBinding(name)
          // Destructured / defaulted / rest bindings hold an unprovable piece
          // of an aggregate; only a plain parameter bound to provably inert
          // values may be called.
          if (taintedBindings.has(name) || arrow === null || !aliasBindingProvablySafe(arrow)) {
            return `call to alias ${name} is not allowed (read-only eval)`
          }
        }
        const targetReason = memberTargetReason(callee)
        if (targetReason !== null) return targetReason
        // FIX-2: a dangerous reference handed over as an ARGUMENT
        // (`[1].map(alert)`, `Promise.resolve(1).then(setTimeout)`) launders
        // the banned API through a harmless callee name.
        for (const argument of ((current as { arguments?: AnyNode[] }).arguments ?? [])) {
          const reason = dangerousValue(argument)
          if (reason !== null) return reason
        }
      }
      if (type === 'MemberExpression') {
        // Walk the WHOLE base chain: `a.b.c` must be checked at every link,
        // not just the outermost property (`('').constructor.constructor`).
        const chainReason = firstDangerousChainLink(current)
        if (chainReason !== null) return chainReason
        const name = memberName(current)
        if (name === undefined) {
          // Non-literal computed READ is allowed (data access like data[key]).
        } else if (name !== null && WRITE_APIS.has(name)) {
          return `access to ${name} is not allowed (read-only eval)`
        }
      }
      if (type === 'Property') {
        // FIX-2: `({f: setTimeout}).f('…')` launders the value via a property.
        // ObjectPattern properties bind names, not values — skip those.
        const parent = parents.get(current)?.parent
        if (parent === undefined || parent.type !== 'ObjectPattern') {
          const reason = dangerousValue((current as { value?: AnyNode }).value)
          if (reason !== null) return reason
        }
      }
      if (type === 'ArrayExpression') {
        // FIX-2: `[setTimeout].map(f => f('x'))` smuggles the API in a value.
        for (const element of ((current as { elements?: (AnyNode | null)[] }).elements ?? [])) {
          if (element === null || element === undefined || element.type === 'SpreadElement') continue
          const reason = dangerousValue(element)
          if (reason !== null) return reason
        }
      }
      if (type === 'ArrowFunctionExpression') {
        // An arrow body that EVALUATES to a banned value hands it to whoever
        // collects the result (`[1].map(x => setTimeout).at(0)('alert(1)')`).
        // Inline arrows are the FIX-3 whitelist, so this stays scoped to
        // banned identifiers/member chains and never fires on `() => 1`.
        const reason = dangerousValue((current as { body?: AnyNode }).body)
        if (reason !== null) return reason
      }
      if (type === 'ObjectPattern' || type === 'ArrayPattern' || type === 'AssignmentPattern' || type === 'RestElement') {
        // FIX-1: a binding pattern whose key names a dangerous member is a
        // rename of that member (`({constructor: c}) => …`).
        const reason = patternKeyViolation(current)
        if (reason !== null) return reason
      }
      if (type === 'Identifier') {
        const name = (current as { name?: string }).name
        if (name === 'eval' || name === 'Function') return 'eval/Function is not allowed'
      }
      let reason: string | null = null
      forEachChild(current, (child) => {
        if (reason !== null) return
        reason = visit(child)
      })
      return reason
    } finally {
      if (isArrow) arrowAncestors.pop()
    }
  }
  void source
  return visit(node)
}

/** Unwrap an optional-chain wrapper so callers can look at the real node. */
function unwrapChain(node: AnyNode | undefined): AnyNode | undefined {
  let current = node
  while (current !== undefined && current.type === 'ChainExpression') {
    current = (current as { expression?: AnyNode }).expression
  }
  return current
}

/** True when a value expression is statically provable to be inert: a
 * literal, an inline arrow (its body is itself validated), or an aggregate of
 * such values. Anything whose runtime value cannot be proven is NOT safe. */
function isProvablySafeValue(node: AnyNode | undefined | null): boolean {
  if (node === undefined || node === null) return false
  switch (node.type) {
    case 'Literal':
    case 'ArrowFunctionExpression':
      return true
    case 'TemplateLiteral':
      return ((node as { expressions?: AnyNode[] }).expressions ?? []).every((expression) => isProvablySafeValue(expression))
    case 'ArrayExpression':
      return ((node as { elements?: (AnyNode | null)[] }).elements ?? [])
        .every((element) => element === null || element === undefined || isProvablySafeValue(element))
    case 'ObjectExpression':
      return ((node as { properties?: AnyNode[] }).properties ?? []).every((property) => {
        if (property.type !== 'Property') return false
        const key = propertyKeyName((property as { key?: AnyNode }).key)
        if (key === undefined) return false
        return isProvablySafeValue((property as { value?: AnyNode }).value)
      })
    case 'UnaryExpression':
      return isProvablySafeValue((node as { argument?: AnyNode }).argument)
    case 'BinaryExpression':
      return isProvablySafeValue((node as { left?: AnyNode }).left)
        && isProvablySafeValue((node as { right?: AnyNode }).right)
    case 'ConditionalExpression':
      return isProvablySafeValue((node as { test?: AnyNode }).test)
        && isProvablySafeValue((node as { consequent?: AnyNode }).consequent)
        && isProvablySafeValue((node as { alternate?: AnyNode }).alternate)
    case 'SequenceExpression': {
      // D-1: "every child is inert" via the shared child walk. A sequence's
      // value is its last expression, but all of them are evaluated, so the
      // whole node is inert exactly when every element is.
      let safe = true
      forEachChild(node, (child) => {
        if (!isProvablySafeValue(child)) safe = false
      })
      return safe
    }
    default:
      return false
  }
}

/** Recursively collect every identifier a binding pattern introduces. */
function collectPatternNames(pattern: AnyNode | undefined | null, out: Set<string>): void {
  if (pattern === undefined || pattern === null) return
  switch (pattern.type) {
    case 'Identifier': {
      const name = (pattern as { name?: string }).name
      if (name !== undefined) out.add(name)
      return
    }
    case 'ObjectPattern':
      for (const property of ((pattern as { properties?: AnyNode[] }).properties ?? [])) {
        collectPatternNames(property, out)
      }
      return
    case 'ArrayPattern':
      for (const element of ((pattern as { elements?: (AnyNode | null)[] }).elements ?? [])) {
        collectPatternNames(element, out)
      }
      return
    case 'AssignmentPattern':
      collectPatternNames((pattern as { left?: AnyNode }).left, out)
      return
    case 'RestElement':
      collectPatternNames((pattern as { argument?: AnyNode }).argument, out)
      return
    case 'Property':
      collectPatternNames((pattern as { value?: AnyNode }).value, out)
      return
    default:
      return
  }
}

/** Collect identifiers bound by a NON-trivial binding form (destructuring /
 * default / rest). Their runtime value is a piece of an aggregate that cannot
 * be proven inert, so a call through such an alias is rejected:
 * `(({a: [c]}) => c('…'))({a: [(x=>x)]})`. */
function collectTaintedNames(pattern: AnyNode | undefined | null, out: Set<string>): void {
  if (pattern === undefined || pattern === null) return
  switch (pattern.type) {
    case 'Identifier': {
      const name = (pattern as { name?: string }).name
      if (name !== undefined) out.add(name)
      return
    }
    case 'ObjectPattern':
      for (const property of ((pattern as { properties?: AnyNode[] }).properties ?? [])) {
        collectTaintedNames(property, out)
      }
      return
    case 'ArrayPattern':
      for (const element of ((pattern as { elements?: (AnyNode | null)[] }).elements ?? [])) {
        collectTaintedNames(element, out)
      }
      return
    case 'AssignmentPattern':
      collectTaintedNames((pattern as { left?: AnyNode }).left, out)
      return
    case 'RestElement':
      collectTaintedNames((pattern as { argument?: AnyNode }).argument, out)
      return
    case 'Property':
      collectTaintedNames((pattern as { value?: AnyNode }).value, out)
      return
    default:
      return
  }
}

/** Reason when a binding pattern's DEFAULT VALUE is a banned/dangerous
 * reference (`((f = setTimeout) => f('1'))()`), or null. */
function dangerousPatternValue(value: AnyNode | undefined): string | null {
  const node = unwrapChain(value)
  if (node === undefined) return null
  if (node.type === 'Identifier') {
    const name = (node as { name?: string }).name
    if (name === undefined) return null
    if (name === 'eval' || name === 'Function') return 'eval/Function is not allowed'
    if (DANGEROUS_MEMBERS.has(name) || WRITE_APIS.has(name)) {
      return `access to ${name} is not allowed (read-only eval)`
    }
    return null
  }
  if (node.type === 'MemberExpression') {
    const chain = firstDangerousChainLink(node)
    if (chain !== null) return chain
    const name = memberName(node)
    if (name !== undefined && name !== null && WRITE_APIS.has(name)) {
      return `access to ${name} is not allowed (read-only eval)`
    }
    // R3-P0: `((f = window[String.fromCharCode(101,118,97,108)]) => f('…'))()`.
    const unverifiable = unverifiableComputedKey(node)
    if (unverifiable !== null) return unverifiable
  }
  return null
}

/** Reason when a binding pattern renames a dangerous member or defaults to a
 * dangerous value, or null. */
function patternKeyViolation(pattern: AnyNode): string | null {
  if (pattern.type === 'AssignmentPattern') {
    // `((f = setTimeout) => f('1'))()` — the default value IS the banned API.
    const defaultValue = dangerousPatternValue((pattern as { right?: AnyNode }).right)
    if (defaultValue !== null) return defaultValue
    return patternKeyViolation((pattern as { left?: AnyNode }).left as AnyNode)
  }
  if (pattern.type === 'RestElement') return patternKeyViolation((pattern as { argument?: AnyNode }).argument as AnyNode)
  if (pattern.type === 'ArrayPattern') {
    for (const element of ((pattern as { elements?: (AnyNode | null)[] }).elements ?? [])) {
      if (element !== null && element !== undefined) {
        const reason = patternKeyViolation(element)
        if (reason !== null) return reason
      }
    }
    return null
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of ((pattern as { properties?: AnyNode[] }).properties ?? [])) {
      if (property.type === 'Property') {
        const keyName = propertyKeyName((property as { key?: AnyNode }).key)
        if (keyName !== undefined && keyName !== null && (DANGEROUS_MEMBERS.has(keyName) || WRITE_APIS.has(keyName))) {
          return `binding pattern key ${keyName} is not allowed (read-only eval)`
        }
        // R3-P0: a COMPUTED pattern key can also be a member read whose name is
        // only known at runtime (`({[window[String.fromCharCode(101,118,97,108)]]: x}) => …`).
        const unverifiable = unverifiableKeyExpression((property as { key?: AnyNode }).key)
        if (unverifiable !== null) return unverifiable
        const reason = patternKeyViolation((property as { value?: AnyNode }).value as AnyNode)
        if (reason !== null) return reason
      } else {
        const reason = patternKeyViolation(property)
        if (reason !== null) return reason
      }
    }
    return null
  }
  return null
}

/** Resolve a property key node to a constant name when statically provable. */
function propertyKeyName(key: AnyNode | undefined): string | null | undefined {
  if (key === undefined) return null
  if (key.type === 'Identifier') return (key as { name?: string }).name ?? null
  if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : null
  return constantStringValue(key)
}

/** Constant-fold a pure string expression (literal / template / concatenation).
 * Returns `undefined` when the value cannot be proven statically. */
function constantStringValue(node: AnyNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined
  if (node.type === 'TemplateLiteral') {
    const expressions = ((node as { expressions?: AnyNode[] }).expressions ?? [])
    const quasis = ((node as { quasis?: AnyNode[] }).quasis ?? [])
    let out = ''
    for (let i = 0; i < quasis.length; i++) {
      const cooked = (quasis[i] as { value?: { cooked?: string } }).value?.cooked
      if (typeof cooked !== 'string') return undefined
      out += cooked
      const expression = expressions[i]
      if (expression !== undefined) {
        const inner = constantStringValue(expression)
        if (inner === undefined) return undefined
        out += inner
      }
    }
    return out
  }
  if (node.type === 'BinaryExpression' && (node as { operator?: string }).operator === '+') {
    const left = constantStringValue((node as { left?: AnyNode }).left)
    if (left === undefined) return undefined
    const right = constantStringValue((node as { right?: AnyNode }).right)
    if (right === undefined) return undefined
    return left + right
  }
  return undefined
}

/** Walk the whole member base chain; returns the first dangerous link reason.
 *
 * FIX-4: a dynamic computed link (`x[expr]`) no longer aborts the walk — the
 * link name is unverifiable, but the links BELOW it must still be checked, so
 * `('')['con'+'structor']` is caught by constant folding and `x[k].constructor`
 * still trips on the outer `constructor`. */
function firstDangerousChainLink(current: AnyNode): string | null {
  let link: AnyNode | undefined = current
  while (link !== undefined && link.type === 'MemberExpression') {
    const linkName = memberName(link)
    if (linkName !== undefined && linkName !== null && DANGEROUS_MEMBERS.has(linkName)) {
      return `access to ${linkName} is not allowed (read-only eval)`
    }
    link = (link as { object?: AnyNode }).object
    if (link !== undefined && link.type === 'ChainExpression') {
      link = (link as unknown as { expression?: AnyNode }).expression
    }
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
 *
 * This is the SINGLE name-resolution entry for `WRITE_APIS` /
 * `DANGEROUS_MEMBERS` / member-chain decisions, so the computed branch must
 * constant-fold exactly like `propertyKeyName()` does (NEW-P0): when folding
 * lived only in the pattern-key and `Reflect.get` paths, `window['ev'+'al']`
 * resolved to `undefined` (unverifiable) while `window['eval']` resolved to
 * `'eval'`, so the same chain passed or failed purely on how the key was
 * spelled — and a folded `eval` could be handed over as a callback.
 *
 * String-literal / folded-string computed access (`window['fetch']`,
 * `window['ev'+'al']`, ``window[`ev${'a'}l`]``) resolves to its value;
 * genuinely dynamic computed access (`data[key]`, `window[0]`) yields
 * `undefined` (unverifiable); non-member callees yield `null`. */
function memberName(node: AnyNode | undefined): string | null | undefined {
  if (node === undefined) return null
  if (node.type === 'Identifier') return (node as { name?: string }).name ?? null
  if (node.type === 'MemberExpression') {
    const property = (node as { property?: AnyNode }).property
    if ((node as { computed?: boolean }).computed !== true) {
      if (property !== undefined && property.type === 'Identifier') return (property as { name?: string }).name ?? null
      return null
    }
    return constantStringValue(property)
  }
  return null
}

/** True when a property-key expression is computed at RUNTIME through a member
 * read, so the resolved property name cannot be proven at validation time.
 *
 * This is the R3-P0 discriminator. `memberName()` returns `undefined` both for
 * a plain dynamic key (`data[key]`, `window[0]`) and for a key whose VALUE is
 * only known at run time (`window[String.fromCharCode(101,118,97,108)]`), and
 * the value-position branches historically treated both as "allow". The first
 * kind is the documented legit read (AC3); the second kind can spell ANY
 * blacklisted name without a constant, so it is denied wherever the member
 * VALUE is consumed.
 *
 * Every runtime key builder is the same class — `String.fromCharCode`,
 * `String.fromCodePoint`, `atob`, `decodeURIComponent`, `Array.join`,
 * `String.concat`, `slice`/`substring`/`replace`/`split`, `toLowerCase`,
 * `String.raw`, a bare property read (`obj.prop`), a spread, … — because each
 * one is a MEMBER READ or CALL whose result is computed by the page. No
 * allow-list of "safe builders" is possible: an attacker composes two of them,
 * and the validator cannot evaluate them. The check is therefore structural and
 * base-agnostic (DECIDED D6): a computed key expression that contains a member
 * access, a call or a spread is unverifiable, whatever the base object is.
 * Plain expressions (identifiers, literals, arithmetic) stay allowed. */
function keyIsRuntimeComputed(keyNode: AnyNode | undefined, depth = 0): boolean {
  if (keyNode === undefined || depth > 6) return false
  const key = unwrapChain(keyNode)
  if (key === undefined) return false
  switch (key.type) {
    case 'MemberExpression':
      // `obj.prop`, `String.fromCharCode`, `['e','v'].join`
      return true
    case 'CallExpression':
      // `atob('…')`, `decodeURIComponent('…')`, `String(x)`, an inline IIFE —
      // a call result is computed by the page and cannot be proven here.
      return true
    case 'SpreadElement':
      // `window[[...['eval']]]` / `Reflect.get(o, ...['eval'])`: a spread key
      // is assembled at runtime from an unknown number of elements.
      return true
    case 'SequenceExpression':
    case 'ConditionalExpression':
    case 'LogicalExpression':
    case 'BinaryExpression':
    case 'TemplateLiteral':
    case 'UnaryExpression':
    case 'ArrayExpression': {
      let computed = false
      forEachChild(key, (child) => {
        if (!computed && keyIsRuntimeComputed(child, depth + 1)) computed = true
      })
      return computed
    }
    default:
      return false
  }
}

/** True when ANY link of a member chain is keyed by a runtime-computed
 * expression. `window[String.fromCharCode(101,118,97,108)].valueOf` reaches the
 * banned function through a harmless-looking outer name, so the check must
 * cover the whole chain, not only the outermost link. */
function chainHasRuntimeComputedKey(member: AnyNode | undefined): boolean {
  let link = member
  while (link !== undefined && link.type === 'MemberExpression') {
    if ((link as { computed?: boolean }).computed === true
      && keyIsRuntimeComputed((link as { property?: AnyNode }).property)) return true
    link = unwrapChain((link as { object?: AnyNode }).object)
  }
  return false
}

/** Reason when a computed member access (or a reflective read) is keyed by a
 * runtime-computed expression, or null. Because the rule fires only on the KEY
 * of a computed access, `data[key]`, `obj[key].items[0]`, `({[key]: 1})`,
 * `Reflect.get(o, key)` and `fetch('u', { body: data[key] })` stay allowed. */
const UNVERIFIABLE_KEY_REASON = 'computed key whose name cannot be statically resolved is not allowed (read-only eval)'

/** Member-expression entry: a chain whose every computed key folds to a
 * constant (or is a plain expression) is always resolvable. */
function unverifiableComputedKey(member: AnyNode | undefined): string | null {
  return chainHasRuntimeComputedKey(member) ? UNVERIFIABLE_KEY_REASON : null
}

/** Bare key-expression entry (binding-pattern keys, `Reflect.get` name args). */
function unverifiableKeyExpression(keyNode: AnyNode | undefined): string | null {
  return keyIsRuntimeComputed(keyNode) ? UNVERIFIABLE_KEY_REASON : null
}

/** Name expressions a `Reflect.get` / `getOwnPropertyDescriptor` argument
 * contributes: the argument itself, or the elements of a spread source
 * (`Reflect.get(o, ...['eval'])` spreads one name). Returns null when the
 * spread source is not an inline array (unknown number of names). */
function reflectiveNameNodes(argument: AnyNode): AnyNode[] | null {
  if (argument.type !== 'SpreadElement') return [argument]
  const source = unwrapChain((argument as { argument?: AnyNode }).argument)
  if (source === undefined) return null
  if (source.type === 'ArrayExpression') {
    const elements = ((source as { elements?: (AnyNode | null)[] }).elements ?? [])
      .filter((element): element is AnyNode => element !== null && element !== undefined)
    return elements.length === (source as { elements?: (AnyNode | null)[] }).elements?.length ? elements : null
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
