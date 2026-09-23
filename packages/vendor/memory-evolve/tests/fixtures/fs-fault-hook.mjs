/** Loader hook: resolve `node:fs` to a shim whose renameSync throws a
 * configurable errno (FAULT_CODE), so the copy fallback in
 * approvePendingSkill can be exercised deterministically on any platform.
 *
 * **只打目录 rename**（缺省）：被测条件是"采纳那一次目录搬移失败"
 * （跨设备 = EXDEV / 被占用 = EBUSY / 权限 = EPERM·EACCES）。原子写原语自己的
 * `<file>.tmp.<pid> → <file>` 落在文件上，必须照常工作——否则注入的就成了
 * "rename 整体不可用"（用 `FAULT_ALL_RENAMES=1` 显式覆盖那一种形态）。
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
      "const failAllRenames = process.env.FAULT_ALL_RENAMES === '1'",
      "const fault = () => { const e = new Error('injected ' + code); e.code = code; throw e }",
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      // 只打**目录** rename（= approvePendingSkill 的 `<pending>/<name>` → `<skills>/<name>`
      // 那一次）。2026-09-23（A5/A10 修复）后采纳回落的逐文件拷贝走
      // `writeFileAtomicSafeAt`，它自己的 `renameSync(<file>.tmp.<pid> → <file>)` 落在
      // **文件**上：那是原子写的落盘动作，不是被测的那次目录搬移。失败全部 rename
      // 等于"这个文件系统的 rename 整体坏了"（另一条真实形态，用 FAULT_ALL_RENAMES=1
      // 覆盖：此时如实抛错、由 HTTP 层报"采纳失败"，绝不半写或 abort）。
      'export function renameSync(oldPath, newPath) {',
      '  if (!failAllRenames) {',
      '    let isDirectory = false',
      '    try { isDirectory = real.lstatSync(oldPath).isDirectory() } catch { isDirectory = false }',
      '    if (!isDirectory) return real.renameSync(oldPath, newPath)',
      '  }',
      '  return fault()',
      '}',
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
