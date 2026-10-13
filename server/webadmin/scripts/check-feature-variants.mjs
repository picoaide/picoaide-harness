#!/usr/bin/env node
/**
 * webadmin **变体测试矩阵（非缺省变体）** —— P3 第三片。
 *
 * 契约：`docs/decisions/2026-10-14-webadmin-feature-variant.md` §4/§7.2。
 *
 * ## 为什么需要这个调度点
 *
 * `src/lib/nav.test.ts` / `src/lib/routes.test.ts` 是**按变体给期望**的：关掉的模块其侧栏条目
 * 与路由不得留在产物里。但它们只在有人**手动**设 `FEATURES` 时才会执行 —— CI 的 `npm test`
 * 与 `make check` 的缺省都是全开变体。2026-10-14 独立审计的变异 M3（删掉 `nav.ts` 里
 * `FEATURE_NAV_ENTRIES.filter((entry) => isFeatureEnabled(entry.module))` 那一行）实测：
 * `FEATURES=skills,apps npx vitest run src/lib/nav.test.ts` 红（"模块 connectors 关闭，但侧栏
 * 条目 /connectors 仍在产物里"），而同一次变异下产物判据 `check:features` 与全开门禁**全绿**
 * ⇒ 关闭变体会发布一个指向不存在路由的侧栏条目（点进去 404），没有任何自动门禁拦得住。
 * 判据有效 ≠ 判据有人跑，所以矩阵本身要有调度点：`make -C server check`（发布门禁）与 CI 的
 * `server` job 都跑 `make -C server webadmin-variant-tests`，后者就是本脚本。
 *
 * ## 为什么矩阵里**不含**缺省变体
 *
 * 缺省（全开）变体由上层已经跑过一次的 `npm test` 覆盖；矩阵只跑"关掉一部分"的组合
 * （逐个关闭 + 全关），那才是变体特有的失效面。重复跑全开只是把同一件事做两遍。
 *
 * ## 为什么是一个仓内脚本而不是 Makefile 里的 `for` 循环
 *
 * `scripts/check-integration-tests.mjs` 的"CI 执行面闭包"会跟着 `make [-C <dir>] <目标>` 读配方
 * 体，遇到读不懂的命令位一律 fail-closed。Makefile 里的 `@for …; do …; done` 正是它读不懂的
 * 形态（实测：`命令位上的可执行名 \`@for\` 没有登记`）。写成仓内脚本 + `npm run`（与
 * `check:features` 同一条被闭包认识的形态）既让闭包读得下去，也让本地与 CI 跑的是同一份实现。
 *
 * ## 用法与退出码
 *
 * ```bash
 * npm run check:variant-tests          # 默认矩阵：4 个非缺省变体
 * node scripts/check-feature-variants.mjs apps,connectors   # 只跑指定变体（排障用）
 * ```
 *
 * 退出码：0 = 矩阵全部通过；1 = 有变体失败（**第一个失败的变体就停**：后续变体的失败信息会被
 * 前一个的噪音盖住，而修复者要的是"哪个变体、哪条断言"）。
 *
 * @module picoaide-webadmin/check-feature-variants
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 非缺省变体矩阵（**唯一真源**；`scripts/verify-ci-scripts.mjs` 第 19 节直接 import 本模块读它）。
 *
 * 四个组合 = 逐个关闭三个模块 + 全关（与产物判据 `check-feature-chunks.mjs` 的 5 次构建矩阵
 * 同一套口径，只是这里不重复跑"全开"）。取值形态与 `features.mjs` 的解析一致：
 * 逗号分隔、顺序无关、全关写显式 `none`。
 */
export const VARIANT_MATRIX = ['apps,connectors', 'skills,connectors', 'skills,apps', 'none']

/**
 * 跑一个变体的完整单测。
 * @param variant - `FEATURES` 取值。
 * @returns 子进程退出码（`null` = 被信号杀掉）。
 */
function runVariant(variant) {
  process.stdout.write(`\n== webadmin 变体单测：FEATURES=${variant}\n`)
  const result = spawnSync('npm', ['test'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, FEATURES: variant },
    stdio: 'inherit',
  })
  return result.status
}

/**
 * 入口（被 import 时零副作用：判据要读 {@link VARIANT_MATRIX}）。
 * @returns 退出码。
 */
function main() {
  const fromArgv = process.argv.slice(2).flatMap((arg) => arg.split(/\s+/u)).filter(Boolean)
  const matrix = fromArgv.length > 0 ? fromArgv : VARIANT_MATRIX
  for (const variant of matrix) {
    const status = runVariant(variant)
    if (status !== 0) {
      process.stderr.write(
        `\ncheck-feature-variants: 变体 ${variant} 的单测失败（退出码 ${status ?? 'null'}）。`
          + '这类失败几乎总是"某个登记表没有按变体过滤"（nav.ts / routes.ts 的 FEATURE_* 表），'
          + `先用 \`FEATURES=${variant} npm test\` 单独复现。\n`,
      )
      return 1
    }
  }
  process.stdout.write(`\ncheck-feature-variants: ✅ ${matrix.length} 个非缺省变体全部通过（${matrix.join(' / ')}）\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === join(PACKAGE_ROOT, 'scripts', 'check-feature-variants.mjs')) {
  process.exit(main())
}
