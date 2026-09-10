import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { loadInstalledPackage, verifyRuntimeClosure } from './runtime-closure.mjs'

const packageRoot = resolve(import.meta.dirname, '..')
const manifestPath = resolve(packageRoot, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

// ---- 1. package.json exports 的每个子路径都必须指向**真实存在的**产物 ----
//
// 2026-09-10 实测踩到:新增 src/desktop-channel.ts 后往 exports 里加了
// `./desktop-channel -> ./lib/desktop-channel.js`,却忘了往 tsdown.config.ts 的
// entry 表里加一行 —— 类型声明有(tsc --emitDeclarationOnly 按 tsconfig 产)、
// JS 没有,而 typecheck / 单测 / 门禁全绿(它们都直接 import src/)。
// 相对 import 会被 tsdown 内联进 chunk,所以"少加一个 entry"在应用内运行时
// 未必报错;但**声明过的对外子路径**是 package.json 的承诺,必须存在 ——
// 这类缺陷只在真正的消费者 import 那个子路径时才炸,属于最晚发现的一类。
const missing = []
for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
  const candidates = typeof target === 'string'
    ? [target]
    : [target.default, target.types].filter(value => typeof value === 'string')
  for (const candidate of candidates) {
    if (!existsSync(resolve(packageRoot, candidate))) missing.push(`${subpath} -> ${candidate}`)
  }
}
if (missing.length > 0) {
  console.error('verify-runtime-closure: package.json exports 指向不存在的产物:')
  for (const entry of missing) console.error(`  ${entry}`)
  console.error('  提示:新增 src 模块并写进 exports 时,别忘了在 tsdown.config.ts 的 entry 里加一行。')
  process.exit(1)
}

// ---- 2. 一方依赖图闭合(原有检查) ----
const result = await verifyRuntimeClosure(manifest, loadInstalledPackage, manifestPath)

if (result.failures.length > 0) {
  console.error('verify-runtime-closure: required first-party peers are missing from dsh-plugin-desktop dependencies:')
  for (const failure of result.failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(
  `verify-runtime-closure: ${result.packageCount} first-party nodes form a closed reachable runtime graph;`
  + ` ${Object.keys(manifest.exports ?? {}).length} export subpaths all resolve.`,
)
