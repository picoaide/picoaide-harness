#!/usr/bin/env node
/**
 * 构建产物守卫：`lib/electron.js` 必须把 `electron` 留作运行期外部依赖。
 *
 * 背景（2026-10-20 真机回归）：`electron` 在本包是 **devDependency**，而 tsdown
 * 只自动外置 dependencies。漏掉 tsdown 配置里的 `external: ['electron']` 时，
 * rolldown 会把 npm 的 `electron/index.js` 内联进产物——它导出的是可执行文件
 * 路径（打包产物里连 `node_modules/electron` 都没有，直接抛 "Electron failed to
 * install correctly"）。于是 main 进程的 `loadElectronModule()` 拿不到
 * `safeStorage`：已存会话解不出来（每次启动都要求重新登录），并且读取失败后
 * 还会以 0600 明文重写令牌。
 *
 * 为什么放在 `build` 而不是测试里：tag 发布流水线按已跑过全量 CI 的提交打包，
 * **只编译 + 打包、不跑测试**；只有构建期守卫能挡住这一类"产物静默降级"。
 *
 * 允许传入一个文件路径（默认 `lib/electron.js`），便于用历史坏产物做反向验证：
 *   node scripts/check-built-electron.mjs temp/electron.broken.js   # 必须红
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_ARTIFACT = fileURLToPath(new URL('../lib/electron.js', import.meta.url))
const artifact = process.argv[2] ?? DEFAULT_ARTIFACT

/** npm `electron` 包（非 Electron 运行时 API）的独有标记。 */
const BUNDLED_NPM_ELECTRON_MARKERS = [
  'Electron failed to install correctly',
  'getElectronPath',
  'node_modules/electron/index.js',
]

/** 外置后产物里保留的两种形态（ESM 动态 import / createRequire）。 */
const EXTERNAL_REFERENCE = /(?:import\(["']electron["']\)|require\(["']electron["']\))/u

function fail(message) {
  console.error(`[check-built-electron] ${message}`)
  console.error(`[check-built-electron] artifact: ${artifact}`)
  process.exit(1)
}

if (!existsSync(artifact)) {
  fail('missing built artifact (run the tsdown build first)')
}

const source = readFileSync(artifact, 'utf8')
const marker = BUNDLED_NPM_ELECTRON_MARKERS.find((needle) => source.includes(needle))
if (marker !== undefined) {
  fail(
    `electron was bundled into the artifact (found ${JSON.stringify(marker)}); ` +
      "add 'electron' to the tsdown config's external list",
  )
}

if (!EXTERNAL_REFERENCE.test(source)) {
  fail('the artifact no longer references electron as an external module at runtime')
}

console.log(`[check-built-electron] OK: ${artifact} keeps electron external`)
