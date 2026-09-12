/**
 * `@electron/asar` 的**路径分隔符**适配（2026-09-12，Windows 打包实测）。
 *
 * `@electron/asar` v3 的 `Filesystem#getNode()` 用 `path.dirname()` / `path.basename()`
 * 拆输入路径，再用 `searchNodeFromDirectory()` 里的 `p.split(path.sep)` 逐级下钻。
 * `path.sep` 在 Windows 上是 `\`，于是**用 `/` 分隔的归档内路径在 Windows 上永远查不到**
 * （整串被当成一个目录名 → `"…" was not found in this archive`），而 Linux/macOS 上
 * `path.sep === '/'`，同样的代码恰好正确 —— 典型的"本地绿、Windows 红"。
 *
 * 反过来 `listPackage()` 的回报是 `path.join()` 拼的，**平台原生**（Windows 上是 `\`，
 * 且带前导分隔符），所以"列举得到、却读不出来"会同时出现。
 *
 * 结论：**列举结果比较前统一归一化，交给 `extractFile` 前转成平台分隔符**。
 * 两条都是纯函数，便于在任意平台上用显式分隔符做回归测试。
 *
 * @module dsh-plugin-desktop/scripts/asar-entry-path
 */

import { sep } from 'node:path'

/**
 * 把归档内路径转成 `extractFile` 能识别的形状：去掉前导分隔符，并把 `/`
 * 换成目标平台分隔符。
 * @param entry - 以 `/` 分隔的归档内路径（可带前导分隔符）。
 * @param separator - 目标分隔符，缺省 `path.sep`；测试可显式传入。
 * @returns 可交给 `@electron/asar` 读取的路径。
 */
export function toAsarEntryPath(entry: string, separator: string = sep): string {
  const trimmed = entry.replace(/^[/\\]+/u, '')
  return separator === '/' ? trimmed : trimmed.split('/').join(separator)
}

/**
 * 把 `listPackage()` 的回报归一化成"以 `/` 分隔、无前导斜杠"的键，用于跨平台比较。
 * @param entry - `listPackage()` 报出的一条路径。
 * @returns 归一化后的键。
 */
export function normalizeAsarEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '')
}
