/** Loader hook: 把 `node:fs` 换成"macOS 形态"的 shim（2026-09-16 客户现场回归）。
 *
 * macOS 与 Linux 的关键差异（实测）：
 *   - `/proc/self/fd` **不存在**；
 *   - `realpathSync('/dev/fd/N')` **不解析**、原样返回 `/dev/fd/N`，且**不抛错**。
 *
 * 于是插件的 `fdRealPath()` 会返回 `/dev/fd/N` 这个"入口自身"的字符串，包含性
 * 检查判成"落在仓库外" ⇒ `openExclusiveSafe` 返回 unsafe ⇒ 取锁抛出误导性的
 * 「仓库内 .memory.lock 是符号链接（或越出仓库边界）」⇒ **macOS 上所有记忆写入
 * 失败**，而清理用的 `unlinkSync('/dev/fd/N')` 什么也删不掉、残留锁越积越多。
 *
 * 这个 fixture 就是让 Linux/CI 也能复现那次现场：`realpathSync` 对 `/dev/fd/`
 * 前缀原样返回（macOS 行为），其余转发真实实现。导出名从真实模块生成（同
 * fs-fault-hook.mjs 的理由：硬编码导出列表会随被测模块 import 新名字而失效）。 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realFs = require('node:fs')

export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    // URL 必须可解析（Node 对非 URL 形态的 url 直接抛 ERR_INVALID_RETURN_PROPERTY_VALUE）
    return { url: 'dsh-shim://fs-macos', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'dsh-shim://fs-macos') {
    const names = Object.keys(realFs)
      .filter((n) => n !== 'default' && n !== 'realpathSync' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    const source = [
      'const real = globalThis.__realFs',
      'export const realpathSync = (p, ...rest) => {',
      "  const s = String(p)",
      // macOS：/dev/fd/N 不解析、原样返回；/proc/self/fd/N 入口不存在（ENOENT）
      "  if (s.startsWith('/proc/self/fd/')) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }",
      "  if (s.startsWith('/dev/fd/')) return s",
      '  return real.realpathSync(p, ...rest)',
      '}',
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
