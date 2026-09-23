/** Loader hook: resolve `node:fs` to a shim whose `renameSync` fails when the
 * **source basename** is one of the atomic-swap names produced by
 * `syncSkillDirSafe` (lib/coi/skills-sync.js):
 *
 *   - `.staging-<name>-<pid>-<ts>` → the staging→dest swap (step 2 of the swap);
 *   - `.old-<name>-<pid>-<ts>`     → the aside→dest restore (the rollback path),
 *     failed only when `SWAP_FAIL_RESTORE=1`.
 *
 * Why basename + the `-<pid>-<ts>` suffix: the single atomic-write primitive also
 * renames (`<file>.tmp.<pid>` → file, lib/sync/filesets.js), and that temp name
 * must keep working — otherwise the fault would land in the copy loop instead of
 * the swap. The infix is matched **without** anchoring the skill name, so both the
 * current leading-dot form (A16, 2026-09-23) and the legacy `<name>.staging-…`
 * form keep taking the injected fault. Every other named export is forwarded from
 * the real fs (the export list is generated from the real module so it cannot go
 * stale).
 *
 * Env:
 *   SWAP_FAULT_CODE   - errno to throw (default EPERM).
 *   SWAP_FAIL_RESTORE - '1' also fails the aside→dest rollback (double failure).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realFs = require('node:fs')

export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    return { url: 'node-fs-swap-fault:shim', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'node-fs-swap-fault:shim') {
    const names = Object.keys(realFs)
      .filter((n) => n !== 'default' && n !== 'renameSync' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    const source = [
      "import { basename as base } from 'node:path'",
      'const real = globalThis.__realFs',
      "const code = process.env.SWAP_FAULT_CODE ?? 'EPERM'",
      "const failRestore = process.env.SWAP_FAIL_RESTORE === '1'",
      "const fault = () => { const e = new Error('injected ' + code + ' on swap rename'); e.code = code; throw e }",
      // 技能名不锚定：新命名（.staging-<name>-<pid>-<ts>）与旧命名（<name>.staging-<pid>-<ts>）
      // 都命中；原子写的 <file>.tmp.<pid> 不命中（它的结尾是 .tmp.<pid>）。
      "const isSwap = (p) => /\\.staging-.*\\d+-\\d+$/.test(base(String(p)))",
      "const isRestore = (p) => /\\.old-.*\\d+-\\d+$/.test(base(String(p)))",
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      'export function renameSync(oldPath, newPath) {',
      '  if (isSwap(oldPath)) return fault()',
      '  if (failRestore && isRestore(oldPath)) return fault()',
      '  return real.renameSync(oldPath, newPath)',
      '}',
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
