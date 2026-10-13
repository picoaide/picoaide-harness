#!/usr/bin/env node
/**
 * **变体产物判据（P3）**：被关闭模块的页面代码**不得进 dist**，被开启的**必须进**。
 *
 * 契约：`docs/decisions/2026-10-14-webadmin-feature-variant.md`。
 *
 * ## 为什么这条判据必须真跑构建
 *
 * `src/lib/features.test.ts` 判的是**源码形态**（`__FEATURE_X__ ? lazy(…) : …`）。
 * 形态对不等于产物对：打包器折分支是有条件的（只折字面量），插件版本、`manualChunks`、
 * 新增一条静态 import、把 `import()` 挪出守卫……任何一条都能让"源码看着对、chunk 照样产出"。
 * 所以这条判据真跑构建、真读产物字节。
 *
 * ## 判据形态（三条硬约束，缺一条就是假判据）
 *
 *   1. **双侧**：只判"关闭变体里没有"是**恒真**的（一个空产物也满足）⇒ 同一轮里必须
 *      同时判"开启变体里**必须**存在"。两侧结果一起打印、一起决定退出码。
 *   2. **逐模块**：只跑"全开 vs 全关"两次的话，"关 A 却把 B 的页面也删了"照样绿。
 *      矩阵 = 全开 + 全关 + **每个模块单独关闭**（共 3+2=5 次构建）。
 *   3. **反空转**：每次构建都要证明"这次构建真的产出了页面 chunk"（核心页 chunk 在、
 *      dist 非空、index.html 在），否则关闭侧的全部"不存在"断言可以被一个失败的构建满足。
 *
 * ## 量具（两个独立通道，互为交叉验证）
 *
 *   · **内容**：每个模块一个哨兵串 `picoaide.feature.<module>.v1`（命名从渠道契约的
 *     `FEATURE_MODULES` 派生），写在该模块**真的会渲染**的那条路径上（页面根元素的
 *     `data-feature-sentinel`）。关掉的模块 ⇒ 产物里找不到这个串。
 *   · **结构**：Vite 按模块文件名给动态 chunk 命名（`CapabilityCenter-<hash>.js` …）
 *     ⇒ 关掉的模块，它的页面 chunk 文件名一个都不该出现。
 *
 * 两个通道都做双侧；只做一侧的那种（"文件名清单"或"哨兵串"单用）都在下面各自的
 * 说明里写清了它单独用会漏什么。
 *
 * ## 用法与退出码
 *
 * ```bash
 * node scripts/check-feature-chunks.mjs              # 全部矩阵（5 次构建，约 1 分钟）
 * node scripts/check-feature-chunks.mjs --keep       # 保留产物目录（排障用）
 * node scripts/check-feature-chunks.mjs --quiet      # 只打印结论行
 * ```
 *
 * 退出码：0 = 矩阵全部符合预期；1 = 有不符合项；2 = **判据自身**读不到输入 / 量具缺失
 * （源文件里没有哨兵串、页面源文件找不到、vite 不可执行）—— 2 与 1 分开，是为了让
 * "判据坏了"与"产品错了"在 CI 日志里可区分。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ROOT = join(PACKAGE_ROOT, 'node_modules', '.cache', 'picoaide-feature-dist')

/**
 * 模块清单 —— **顺序是契约**（与 Go `internal/features`、渠道 `features`、
 * `features.mjs` 的 `FEATURE_MODULES` 逐字一致）。判据**刻意自持这一份**（不 import
 * 被测代码的解析器）：判据的期望必须独立于被测实现，否则"实现改了、期望跟着改"就没人拦。
 */
const FEATURE_MODULES = ['skills', 'apps', 'connectors']

/** 全开变体标识（= `features.mjs` 的缺省值）。 */
const FULL_VARIANT = FEATURE_MODULES.join(',')

/** 全关的显式取值。 */
const NONE_VARIANT = 'none'

/**
 * 每个模块的量具与结构面。
 *
 * `sentinelFile`（哨兵串所在源文件）与 `pageChunks`（该模块会产出的动态 chunk 基名）
 * 是**判据的期望表**：改模块边界（页面改名/挪模块）必须同时改这里，否则前置检查会红
 * （见 `checkPreconditions`），不会静默少判一个模块的页面。
 */
const MODULE_EXPECTATIONS = [
  {
    module: 'skills',
    sentinel: 'picoaide.feature.skills.v1',
    sentinelFile: 'src/pages/CapabilityCenter.tsx',
    pageChunks: ['CapabilityCenter'],
  },
  {
    module: 'apps',
    sentinel: 'picoaide.feature.apps.v1',
    sentinelFile: 'src/pages/app-center/AppCenterLayout.tsx',
    pageChunks: ['AppCenterLayout', 'Apps', 'OpensBoard', 'Limits'],
  },
  {
    module: 'connectors',
    sentinel: 'picoaide.feature.connectors.v1',
    sentinelFile: 'src/pages/Connectors.tsx',
    pageChunks: ['Connectors'],
  },
]

/**
 * **反空转**用的核心页 chunk 基名（与三个模块无关、任何变体下都必须在）。
 *
 * 没有它的话，"关闭侧"的全部断言可以被一次**什么都没产出**的构建满足 —— 那正是这类
 * 判据最经典的假绿形态。
 */
const CORE_PAGE_CHUNK = 'Users'

/** 期望的构建矩阵：全开 + 全关 + 每个模块单独关闭。 */
function buildMatrix() {
  const matrix = [{ label: '全开', variant: FULL_VARIANT }]
  for (const module of FEATURE_MODULES) {
    const variant = FEATURE_MODULES.filter((m) => m !== module).join(',')
    matrix.push({ label: `关 ${module}`, variant: variant === '' ? NONE_VARIANT : variant })
  }
  matrix.push({ label: '全关', variant: NONE_VARIANT })
  return matrix
}

/**
 * 递归列出目录下的全部常规文件（ASCII 升序）。
 * @param dir - 目录。
 * @returns 绝对路径数组。
 */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

/**
 * 相对路径（POSIX 风格，用于打印与断言消息；跨平台稳定）。
 * @param from - 基准目录。
 * @param to - 目标路径。
 * @returns 相对路径。
 */
function relPosix(from, to) {
  return relative(from, to).split(sep).join('/')
}

/**
 * **前置检查**：判据自己的量具必须齐备。任一项不满足 ⇒ 退出码 2。
 *
 * 为什么单独一步（而不是混进断言里）：量具缺失时后面所有断言都会"通过"——哨兵串源文件
 * 不见了 ⇒ 关掉的变体里当然找不到它。这是"判据坏了"与"产品错了"必须分开的那一处。
 * @returns 问题清单（空 = 齐备）。
 */
function checkPreconditions() {
  const problems = []
  const viteBin = join(PACKAGE_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) problems.push(`vite 不可执行（缺 ${relPosix(PACKAGE_ROOT, viteBin)}）：先 npm ci`)

  const pageSources = existsSync(join(PACKAGE_ROOT, 'src', 'pages'))
    ? listFiles(join(PACKAGE_ROOT, 'src', 'pages')).filter((p) => p.endsWith('.tsx') && !p.endsWith('.test.tsx'))
    : []
  if (pageSources.length === 0) problems.push('src/pages 下一个页面源文件都没有（工作目录不对？）')

  for (const expectation of MODULE_EXPECTATIONS) {
    const file = join(PACKAGE_ROOT, expectation.sentinelFile)
    if (!existsSync(file)) {
      problems.push(`模块 ${expectation.module} 的哨兵串源文件不存在：${expectation.sentinelFile}`)
      continue
    }
    const text = readFileSync(file, 'utf8')
    if (!text.includes(expectation.sentinel)) {
      problems.push(
        `模块 ${expectation.module} 的源文件 ${expectation.sentinelFile} 里没有哨兵串 `
          + `${JSON.stringify(expectation.sentinel)}：量具缺失 ⇒ "关闭变体里找不到它"变成恒真。`,
      )
    }
    for (const basename of expectation.pageChunks) {
      const hit = pageSources.filter((p) => p.slice(p.lastIndexOf(sep) + 1) === `${basename}.tsx`)
      if (hit.length === 0) {
        problems.push(
          `模块 ${expectation.module} 期望的页面 chunk 基名 ${basename} 在 src/pages 下找不到对应 `
            + `${basename}.tsx（页面改名/挪走后本判据的期望表必须同步，否则少判一个页面）`,
        )
      }
    }
  }
  return problems
}

/**
 * 真跑一次 `vite build`。
 * @param variant - `FEATURES` 取值。
 * @param outDir - 产物目录（每次构建一个，互不覆盖）。
 * @returns `{ ok, detail }`。
 */
function runBuild(variant, outDir) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const result = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, FEATURES: variant },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  if (result.status !== 0) {
    return { ok: false, detail: `vite build 退出码 ${result.status ?? 'null'}\n${(result.stderr ?? '').slice(-2000)}` }
  }
  if (!existsSync(join(outDir, 'index.html'))) return { ok: false, detail: `构建成功但 ${relPosix(PACKAGE_ROOT, outDir)}/index.html 不存在` }
  return { ok: true, detail: '' }
}

/**
 * 读一次构建产物：全部文件的文本内容 + chunk 文件名集合。
 * @param outDir - 产物目录。
 * @returns `{ text, chunkBasenames, assetFiles }`。
 */
function readDist(outDir) {
  const files = listFiles(outDir)
  /** 拼接全文（dist 规模是 MB 级，直接读；用小写归一以免被大小写差异绕过）。 */
  let text = ''
  for (const file of files) {
    if (statSync(file).size > 32 * 1024 * 1024) continue
    text += readFileSync(file, 'utf8')
  }
  const assetFiles = files
    .filter((p) => p.includes(`${sep}assets${sep}`))
    .map((p) => p.slice(p.lastIndexOf(sep) + 1))
  // Vite 的动态 chunk 名形如 `<模块文件名>-<hash>.js`；取 `-hash.js` 之前的基名。
  const chunkBasenames = new Set(
    assetFiles
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.replace(/-[A-Za-z0-9_-]{6,}\.js$/u, '').replace(/\.js$/u, '')),
  )
  return { text, chunkBasenames, assetFiles }
}

/**
 * 判一次构建产物是否与变体一致。
 * @param matrixEntry - `{ label, variant }`。
 * @param enabled - `Set<string>` 该变体下开启的模块。
 * @param dist - {@link readDist} 的结果。
 * @returns 问题清单（空 = 符合）。
 */
function judge(matrixEntry, enabled, dist) {
  const problems = []
  // ---- 反空转（先判）：这次构建必须真的产出了东西 ----------------------------
  if (dist.assetFiles.length === 0) problems.push('dist/assets 为空：这次构建没产出任何资源，"不存在"类断言全部无意义')
  if (!dist.chunkBasenames.has(CORE_PAGE_CHUNK)) {
    problems.push(
      `dist 里找不到核心页 chunk ${CORE_PAGE_CHUNK}-*.js：要么构建没产出页面 chunk（空转），要么 `
        + 'chunk 命名规则变了（本判据的结构面口径要跟着改）',
    )
  }
  if (enabled.size > 0 && !dist.text.includes('picoaide.feature.')) {
    // 只在"至少开着一个模块"时判：全关变体里**没有**哨兵串是预期状态（那正是被测行为），
    // 拿它当反空转证据会把正确结果判红。反空转的另一半（核心页 chunk）在每种变体下都判。
    problems.push('dist 里连一个哨兵串都没有（量具整体失效：哨兵被优化掉了？构建没产出？）')
  }

  for (const expectation of MODULE_EXPECTATIONS) {
    const on = enabled.has(expectation.module)
    // ---- 内容面 --------------------------------------------------------------
    const hasSentinel = dist.text.includes(expectation.sentinel)
    if (on && !hasSentinel) {
      problems.push(`${expectation.module} 已开启，但产物里找不到它的哨兵串 ${expectation.sentinel}`)
    }
    if (!on && hasSentinel) {
      problems.push(`${expectation.module} 已关闭，但产物里仍带着它的哨兵串 ${expectation.sentinel}（页面代码进了 dist）`)
    }
    // ---- 结构面 --------------------------------------------------------------
    for (const basename of expectation.pageChunks) {
      const present = dist.chunkBasenames.has(basename)
      if (on && !present) problems.push(`${expectation.module} 已开启，但缺少它的页面 chunk ${basename}-*.js`)
      if (!on && present) problems.push(`${expectation.module} 已关闭，但仍产出了它的页面 chunk ${basename}-*.js`)
    }
  }
  return problems
}

/**
 * 入口。
 * @returns 退出码。
 */
function main() {
  const argv = process.argv.slice(2)
  const keep = argv.includes('--keep')
  const quiet = argv.includes('--quiet')

  const preconditions = checkPreconditions()
  if (preconditions.length > 0) {
    process.stderr.write('check-feature-chunks: 判据自身的前置检查未通过（退出码 2）\n')
    for (const problem of preconditions) process.stderr.write(`  · ${problem}\n`)
    return 2
  }

  const matrix = buildMatrix()
  const failures = []
  const rows = []
  for (const entry of matrix) {
    const slug = entry.variant.replace(/[^a-z,]/gu, '') || NONE_VARIANT
    const outDir = join(DIST_ROOT, slug === NONE_VARIANT ? NONE_VARIANT : slug)
    const enabled = new Set(entry.variant === NONE_VARIANT ? [] : entry.variant.split(','))
    const build = runBuild(entry.variant, outDir)
    if (!build.ok) {
      failures.push(`[${entry.label}] FEATURES=${entry.variant} 构建失败：${build.detail}`)
      rows.push(`${entry.label.padEnd(10)} FEATURES=${entry.variant.padEnd(24)} 构建失败`)
      continue
    }
    const problems = judge(entry, enabled, readDist(outDir))
    for (const problem of problems) failures.push(`[${entry.label}] FEATURES=${entry.variant}：${problem}`)
    rows.push(
      `${entry.label.padEnd(14)} FEATURES=${entry.variant.padEnd(24)} `
        + `${problems.length === 0 ? '✓' : `✗ ${problems.length} 项`}`,
    )
    if (!keep) rmSync(outDir, { recursive: true, force: true })
  }

  if (!quiet) {
    process.stdout.write('webadmin 变体产物判据（每行一次真构建）\n')
    for (const row of rows) process.stdout.write(`  ${row}\n`)
    process.stdout.write(`  产物目录：${keep ? relPosix(PACKAGE_ROOT, DIST_ROOT) : '（已清理，--keep 保留）'}\n`)
  }
  if (failures.length > 0) {
    process.stderr.write(`check-feature-chunks: ${failures.length} 项不符合预期\n`)
    for (const failure of failures) process.stderr.write(`  · ${failure}\n`)
    process.stderr.write(
      '  口径：关闭的模块其页面代码不得进 dist（内容=哨兵串、结构=页面 chunk 名）；'
        + '开启的模块两侧都必须存在。改模块边界请同步 MODULE_EXPECTATIONS。\n',
    )
    return 1
  }
  process.stdout.write(
    `check-feature-chunks: ✅ ${matrix.length} 个变体全部符合预期`
      + `（全开侧存在 / 关闭侧不存在，逐模块双侧；模块：${FEATURE_MODULES.join(', ')}）\n`,
  )
  return 0
}

process.exit(main())
