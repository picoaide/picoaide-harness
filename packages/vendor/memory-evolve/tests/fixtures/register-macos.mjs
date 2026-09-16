/** Bootstrap：先装好真实 fs 与 loader 钩子，再让被测子进程跑（顺序关键）。
 *
 * `globalThis.__realFs` 必须在 shim 模块被加载**之前**存在——shim 的模块体里就
 * 用它转发真实导出。静态 import 的提升规则让这件事没法在被测文件里做，所以放这。 */
import { createRequire } from 'node:module'
import { register } from 'node:module'

globalThis.__realFs = createRequire(import.meta.url)('node:fs')
register('./fs-macos-hook.mjs', import.meta.url)
