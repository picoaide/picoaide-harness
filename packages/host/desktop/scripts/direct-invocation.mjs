/**
 * 「本模块是被当作 CLI 直接执行，还是被 import」的**唯一判据**。
 *
 * ## 为什么需要它（2026-09-23 独立复审 N-2 实测）
 *
 * `process.argv[1]` 是**调用方写下的路径**，Node 不做 realpath；而主模块的
 * `import.meta.url` **已经过 realpath**。于是那句"经典"守卫
 *
 *     resolve(process.argv[1]) === fileURLToPath(import.meta.url)
 *
 * 在**经符号链接目录调用**时判为假：
 *
 *     node <symlink-to-repo>/packages/host/desktop/scripts/package-linux.mjs
 *     # argv[1]          = <symlink-to-repo>/…/scripts/package-linux.mjs
 *     # import.meta.url  = file:///<real-repo>/…/scripts/package-linux.mjs
 *
 * 后果不是报错而是**静默 exit 0**：脚本像成功一样结束、什么都没做
 * （`yarn dist:linux` 会"成功但没有产物"）。本项目把这种失败模式登记为不可接受，
 * 所以这里做两件事：
 *
 *   1. **两边都取 realpath** 再比较 —— 符号链接目录（含 macOS 的
 *      `/tmp` → `/private/tmp`、Windows 的 junction/短名）都能认出自己是主模块；
 *   2. **判据与证据矛盾时 fail-loud** —— 若独立证据说"argv[1] 就是本文件"
 *      （Node 的 `import.meta.main`，或 dev+ino 文件身份）而路径判据说"不是直接
 *      执行"，那只能是判据被改坏了（历史形态就是只比 `resolve()`）。此时抛错，
 *      而不是让"被当作 CLI 调用却什么都没做"静默通过。
 *
 * 调用方一律写成 `isDirectInvocation(import.meta)`：把调用方自己的 `import.meta`
 * 传进来，才能同时拿到"本模块的 URL"与"本模块是不是主模块"这两个证据。
 *
 * @module dsh-plugin-desktop/scripts/direct-invocation
 */

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 取 realpath；路径不存在或读不到时回落到 `resolve()`。
 *
 * 回落不是宽容：路径写错（文件不存在）时仍要给出**确定性**的比较结果，
 * 否则同一个守卫会随文件系统状态给出不同答案。
 * @param path - 任意路径（可相对）。
 * @returns 绝对路径（尽可能 realpath 化）。
 */
export function canonicalFilePath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
}

/**
 * 两个路径是否指向同一个文件（dev + ino）。
 *
 * 只在**兜底证据**里用，绝不作为"直接执行"的通过条件 —— 否则"两边都取 realpath"
 * 这条主判据被拆掉时符号链接场景会被它悄悄救回，回归就测不出来了。
 * @param a - 路径 A。
 * @param b - 路径 B。
 * @returns 同一文件为 true；拿不到稳定身份（ino=0）或读不到时为 false。
 */
function sameFileIdentity(a, b) {
  try {
    const left = statSync(a, { bigint: true })
    const right = statSync(b, { bigint: true })
    // ino=0 表示该平台/文件系统给不出稳定身份（部分网络盘、某些 Windows 情形），
    // 此时**不得**据此断言"同一个文件"——那会把无关文件误判成矛盾。
    if (left.ino === 0n || right.ino === 0n) return false
    return left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

/**
 * 本模块是否被当作 CLI 直接执行。
 * @param meta - 调用方的 `import.meta`（要 `url` 与 `main` 两个字段）。
 * @param argv1 - 入口路径；缺省取 `process.argv[1]`。
 * @returns true = 直接执行；false = 被 import（含 REPL/`-e`/stdin：那时没有 argv[1]）。
 * @throws 路径判据说"否"、而独立证据说"argv[1] 就是本文件"时（见文件头第 2 点）。
 */
export function isDirectInvocation(meta, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false
  const url = meta !== null && typeof meta === 'object' && typeof meta.url === 'string'
    ? meta.url
    : import.meta.url
  const mainFlag = meta !== null && typeof meta === 'object' && typeof meta.main === 'boolean'
    ? meta.main
    : undefined
  const self = fileURLToPath(url)
  // 主判据：两边都取 realpath（argv[1] 未被 Node realpath 化，主模块已被 realpath 化）。
  if (canonicalFilePath(argv1) === canonicalFilePath(self)) return true
  // 到这里判据说"不是直接执行"。再用**独立证据**复核：任一证据说"argv[1] 就是本文件"
  // 就说明判据坏了 —— 报错，绝不静默继续（文件头第 2 点）。
  if (mainFlag === true || sameFileIdentity(argv1, self)) {
    throw new Error(
      `direct-invocation: argv[1]=${argv1} 按文件身份就是本模块（${self}），`
      + '却被直接执行判据判为"否"。这会让 CLI 调用静默什么都不做，故在此 fail-loud；'
      + '请检查 direct-invocation.mjs 的判据（两边都必须取 realpath）。',
    )
  }
  return false
}
