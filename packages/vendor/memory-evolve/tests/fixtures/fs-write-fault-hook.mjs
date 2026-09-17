/** Loader hook: resolve `node:fs` to a shim whose `writeFileSync` fails on the
 * N-th **fd** write (`FAULT_ON`, 1-based; errno from `FAULT_CODE`), so a
 * mid-loop write failure inside `syncSkillDirSafe` can be exercised
 * deterministically on any platform.
 *
 * Why "fd write" is the discriminator: the production path writes file bodies
 * through `writeFileSync(fd, data)` (lib/sync/filesets.js, the single atomic-write
 * primitive), while every fixture/setup write passes a *path*. Faulting only the
 * fd form therefore injects the failure exactly into the copy loop and leaves the
 * child's own setup untouched.
 *
 * Every other named export is forwarded from the real fs — the export list is
 * generated from the real module (same reason as tests/fixtures/fs-fault-hook.mjs:
 * a hard-coded list goes stale the moment a module under test imports one more
 * node:fs name). */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realFs = require('node:fs')

export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    return { url: 'node-fs-write-fault:shim', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'node-fs-write-fault:shim') {
    const names = Object.keys(realFs)
      .filter((n) => n !== 'default' && n !== 'writeFileSync' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    const source = [
      'const real = globalThis.__realFs',
      "const code = process.env.FAULT_CODE ?? 'ENOSPC'",
      'const failOn = Number(process.env.FAULT_ON ?? 1)',
      'let fdWrites = 0',
      "const fault = () => { const e = new Error('injected ' + code); e.code = code; throw e }",
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      'export function writeFileSync(file, data, options) {',
      '  if (typeof file === "number") {',
      '    fdWrites += 1',
      '    if (fdWrites === failOn) return fault()',
      '  }',
      '  return real.writeFileSync(file, data, options)',
      '}',
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
