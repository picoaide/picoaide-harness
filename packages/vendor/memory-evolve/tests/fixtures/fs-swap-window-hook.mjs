/** Loader hook: run an injected "fourth writer" **inside the real swap window**
 * of `syncSkillDirSafe` (lib/coi/skills-sync.js).
 *
 * The window is the gap between
 *
 *   1) `renameSync(destDir, asideDir)`  — basename `.old-<name>-<pid>-<ts>`
 *   2) `renameSync(stagingDir, destDir)` — basename `.staging-<name>-<pid>-<ts>`
 *
 * so the hook wraps `renameSync` and, **before** the aside rename reaches the
 * real fs, calls `globalThis.__swapWindowWriter()` once. That callback is
 * installed by the child fixture and must be the **real** writer under test
 * (e.g. `svc.writeSkill` from `lib/coi/index.js`), never a stub.
 *
 * Only once (`__swapWindowFired`) and only on the aside rename: the single
 * atomic-write primitive renames `<file>.tmp.<pid>` → file, and the staging
 * rename must keep working — otherwise the run would test the injected fault
 * instead of the writer.
 *
 * Why a loader hook and not a monkey patch: `skills-sync.js` imports
 * `renameSync` as an ESM named import from a builtin, which is a snapshot of
 * the original binding — assigning `fs.renameSync` afterwards has no effect.
 *
 * Every other named export is forwarded from the real `node:fs` (the export
 * list is generated from the real module, so it cannot go stale).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realFs = require('node:fs')

export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    return { url: 'node-fs-swap-window:shim', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'node-fs-swap-window:shim') {
    const names = Object.keys(realFs)
      .filter((n) => n !== 'default' && n !== 'renameSync' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    const source = [
      "import { basename as base } from 'node:path'",
      'const real = globalThis.__realFs',
      // 旁置 rename：`renameSync(destDir, asideDir)` —— `.old-<name>-<pid>-<ts>`
      // 是**目标**那一侧的 basename（`destDir` 就是普通技能目录名）。
      'const isAside = (oldPath, newPath) => /^\\.old-.*\\d+-\\d+$/.test(base(String(newPath)))',
      'export function renameSync(oldPath, newPath) {',
      '  if (!isAside(oldPath, newPath)) return real.renameSync(oldPath, newPath)',
      // 先让"旧目录旁置"真正落地（此刻 dest 不存在、staging 还没就位 = 审计探针
      // 手工复演的那个窗口），再调用写者。
      '  const done = real.renameSync(oldPath, newPath)',
      '  if (globalThis.__swapWindowFired !== true) {',
      '    globalThis.__swapWindowFired = true',
      '    const w = globalThis.__swapWindowWriter',
      '    if (typeof w === "function") {',
      '      try { globalThis.__swapWindowWriterResult = w() }',
      '      catch (e) { globalThis.__swapWindowWriterResult = { threw: String((e && e.message) || e) } }',
      '    }',
      '  }',
      '  return done',
      '}',
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
