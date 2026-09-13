/** Loader hook: resolve `node:fs` to a shim whose renameSync throws a
 * configurable errno (FAULT_CODE), so the copy fallback in
 * approvePendingSkill can be exercised deterministically on any platform.
 *
 * Every other named export is forwarded from the real fs — the export list is
 * **generated from the real module**, not hard-coded: a hard-coded list goes
 * stale the moment a module under test imports one more node:fs name, and the
 * shim then fails to instantiate with
 * `SyntaxError: The requested module 'node:fs' does not provide an export
 * named …` — which reads like a product bug but is a fixture limitation.
 * 2026-09-13（FIX-27 收口）: lib/skills.js → lib/sync/filesets.js pulled in
 * openSync/lstatSync/… and the hard-coded list broke exactly this way.
 *
 * The generation happens here (hook side) via createRequire — `require` does
 * not go through the ESM loader hooks, so it cannot recurse into this shim. */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realFs = require('node:fs')

export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    return { url: 'node-fs-fault:shim', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'node-fs-fault:shim') {
    const names = Object.keys(realFs)
      .filter((n) => n !== 'default' && n !== 'renameSync' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    const source = [
      'const real = globalThis.__realFs',
      "const code = process.env.FAULT_CODE ?? 'EBUSY'",
      "const fault = () => { const e = new Error('injected ' + code); e.code = code; throw e }",
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      'export const renameSync = fault',
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
