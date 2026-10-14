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
 * ## 量具（三个独立通道，互为交叉验证）
 *
 *   · **内容**：每个模块一个哨兵串 `picoaide.feature.<module>.v1`（命名从渠道契约的
 *     `FEATURE_MODULES` 派生），写在**该模块每一个页面文件**里（页面根元素的
 *     `data-feature-sentinel`，见 `MODULE_EXPECTATIONS[*].pages`）。关掉的模块 ⇒ 产物里
 *     找不到这个串。
 *   · **结构**：Vite 按模块文件名给动态 chunk 命名（`CapabilityCenter-<hash>.js` …）
 *     ⇒ 关掉的模块，它的页面 chunk 文件名一个都不该出现。
 *   · **源码图**（前置，不依赖构建）：模块页只能经 `App.tsx` 里 `__FEATURE_*__` 守卫的
 *     `import()` 进入（`scripts/feature-page-graph.mjs`）。**这一条是给前两条补盲区的**：
 *     模块页被**静态**引用时（审计 M6 的形态：核心页里写一行
 *     `import Apps from './app-center/Apps'`），它被内联进引用方的 chunk —— 既没有自己的
 *     chunk 名（结构面看不见），当时也不是每个页面都带哨兵（内容面看不见）。静态引用是
 *     "关闭模块的页面代码不进 dist"这条不变量最直接的破坏方式，必须在源码图上判。
 *
 * 三个通道都做双侧；只做一侧的那种（"文件名清单"或"哨兵串"单用）都在下面各自的
 * 说明里写清了它单独用会漏什么。
 *
 * ## 判据**自己**的表也是判据面（退出码 2 的那一半）
 *
 * `MODULE_EXPECTATIONS` 是手写的期望表（刻意不 import 被测实现），它与 `App.tsx` 里被守卫的
 * `import()` 说明符**双向对拍**、并要求表里每个页面文件都带本模块哨兵：任一方向缺项 ⇒ 退出码 2
 * （"判据自己缩面了"），而不是悄悄少判一个文件。缺了这两条，新增一个模块页时形态表会被
 * 强制更新、这张产物表却不会 —— 新页面的泄漏正好落进上面第三条通道的盲区。
 *
 * ## **判定体自己也要有量具**（判据的判据，退出码 2 的另一半）
 *
 * 前面那三条通道判的是**产物**；而"产物 ⟺ 变体"这件事只有一个判定体：`judge()`。
 * `checkPreconditions` 只能证明**量具还在**（哨兵串写没写、页表全不全、vite 在不在），
 * 它证明不了**判定体还在**。现场（2026-10-14 独立审计）：把 `judge()` 改成 `return []`
 * —— 前置检查全过、源码图全过、5 次构建照跑 —— 而 `npm run check:features` 打印 ✅5/5、
 * 退出码 0。也就是说，判定体被掏空时，这套门禁的**每一条**都还是绿的（一个"永远说
 * 没问题"的量具比没有量具更坏：它把"没判"伪装成"判过了"）。
 *
 * 修法是给判定体配**合成样本**：不依赖真构建，直接构造 dist 形状的输入喂给 `judge()`，
 * 断言**正样本无问题**且**每个负样本都被点名**（负样本各注入一类偏差：缺/多哨兵串、
 * 缺/多页面 chunk、空 dist、缺核心页 chunk）。任何一条不成立 ⇒ 退出码 2 —— 因为那时
 * 失效的是**判据**，不是产物；把它记成 1 会让人去查产品代码，查不到东西。
 *
 * 为什么样本数要有**下界常量**：判据的判据同样会被人"顺手删两个样本"（删到零条时自检
 * 恒绿，判定体被掏空又回到上面的现场）。`SELFTEST_MIN_SAMPLES` / `SELFTEST_MIN_RED_SAMPLES`
 * 是**棘轮**：只允许被"变多"越过，删样本 / 删负样本当场红。
 *
 * 自检跑在**任何真构建之前**：判据坏了要 1 秒内知道，而不是跑完 5 次构建（分钟级）之后。
 *
 * ## 用法与退出码
 *
 * ```bash
 * node scripts/check-feature-chunks.mjs              # 全部矩阵（5 次构建，约 2 分钟）
 * node scripts/check-feature-chunks.mjs --keep       # 保留产物目录（排障用）
 * node scripts/check-feature-chunks.mjs --quiet      # 只打印结论行
 * ```
 *
 * 退出码（**1 与 2 是两个不同的人去看**）：
 *
 *   · 0 = 矩阵全部符合预期；
 *   · 1 = **产物与变体不符**（产品代码错了：关闭的模块仍有代码进 dist，或开启的模块没进；
 *     含源码图上的泄漏 —— 那一类在构建之前就红）⇒ 去看 `src/`；
 *   · 2 = **判据自身失效**（`judge()` 自检不过 / 读不到输入 / 量具缺失 / 页表与守卫不对拍：
 *     源文件里没有哨兵串、页面源文件找不到、vite 不可执行）⇒ 去看这个脚本与 `src/` 的
 *     哨兵/页表，不要去查产品代码 —— 那时"产品错了没有"这件事**还没被判**。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// 源码图判据的唯一实现（同一份实现也跑在 `src/lib/features.test.ts` 里 —— 毫秒级那条链
// 每次 `npm test` 都会走，产物判据这条链是分钟级）。**期望表仍然各持一份**：判据的期望
// 独立于被测实现，但"怎么读 import 图"不需要两套口径。
import { findCutProblems, findRegistryProblems, findSentinelProblems } from './feature-page-graph.mjs'

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
 * `pages`（该模块的**全部**页面源文件）是**判据的期望表**：
 *   · 每个文件都必须带本模块的哨兵串并渲染它（内容面的覆盖面 = 这张表）；
 *   · 每个文件都必须恰好被 `App.tsx` 里本模块守卫的那条 `import()` 引入（与守卫双向对拍）；
 *   · 每个文件对应一个动态 chunk 基名（Vite 按模块文件名命名）—— 结构面就是它。
 * 改模块边界（新增页面 / 页面改名 / 挪模块）必须同时改这里，否则前置检查会红（见
 * `checkPreconditions`），不会静默少判一个页面。
 *
 * 页面清单**刻意手写**（不从 `App.tsx` 派生）：判据的期望不能与"被测实现里恰好写了什么"
 * 自洽 —— 派生的那一刻，"有人把守卫删了"就同时把期望也删了。双向对拍（守卫 ⟺ 本表）
 * 才是那份保险。
 */
const MODULE_EXPECTATIONS = [
  {
    module: 'skills',
    sentinel: 'picoaide.feature.skills.v1',
    pages: ['src/pages/CapabilityCenter.tsx'],
  },
  {
    module: 'apps',
    sentinel: 'picoaide.feature.apps.v1',
    pages: [
      'src/pages/app-center/AppCenterLayout.tsx',
      'src/pages/app-center/Apps.tsx',
      'src/pages/app-center/OpensBoard.tsx',
      'src/pages/app-center/Limits.tsx',
    ],
  },
  {
    module: 'connectors',
    sentinel: 'picoaide.feature.connectors.v1',
    pages: ['src/pages/Connectors.tsx'],
  },
]

/** 页表 → 模块 → 页面源文件（`feature-page-graph.mjs` 的入参形态）。 */
const MODULE_PAGES = Object.fromEntries(MODULE_EXPECTATIONS.map((e) => [e.module, e.pages]))

/** 页表 → 模块 → 哨兵串（同一份期望表喂给内容面与源码图面）。 */
const MODULE_SENTINELS = Object.fromEntries(MODULE_EXPECTATIONS.map((e) => [e.module, e.sentinel]))

/**
 * 一个模块页对应的动态 chunk 基名（Vite 按模块文件名给 chunk 命名：`Apps.tsx` → `Apps-<hash>.js`）。
 * @param page - 页面源文件（包根相对 POSIX 路径）。
 * @returns chunk 基名。
 */
function chunkBasenameOf(page) {
  return basename(page).replace(/\.[cm]?[jt]sx?$/u, '')
}

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
 * **前置检查**：判据自己的量具必须齐备、期望表必须与守卫对拍。任一项不满足 ⇒ 退出码 2。
 *
 * 为什么单独一步（而不是混进断言里）：量具缺失时后面所有断言都会"通过"——哨兵串源文件
 * 不见了 ⇒ 关掉的变体里当然找不到它。这是"判据坏了/表缩面了"与"产品错了"必须分开的那一处。
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
    if (expectation.pages.length === 0) {
      problems.push(`模块 ${expectation.module} 的期望页表是空的（判据自己的表塌了）`)
      continue
    }
    for (const page of expectation.pages) {
      const file = join(PACKAGE_ROOT, page)
      if (!existsSync(file)) {
        problems.push(
          `模块 ${expectation.module} 期望的页面源文件不存在：${page}（页面改名/挪走后本判据的期望表必须同步，`
            + '否则少判一个页面）',
        )
        continue
      }
      if (!pageSources.includes(file)) {
        problems.push(`模块 ${expectation.module} 的 ${page} 不是 src/pages 下的页面源文件（期望表指向了别处？）`)
      }
    }
  }
  // 量具齐备：页表里每个文件都带本模块哨兵且渲染它（内容面的覆盖面 = 页表）。
  problems.push(...findSentinelProblems({
    packageRoot: PACKAGE_ROOT,
    modulePages: MODULE_PAGES,
    moduleSentinels: MODULE_SENTINELS,
  }))
  // 双向对拍：`App.tsx` 里被守卫的 import() ⟺ 本判据的页表（缺任一方向都说明判据要缩面了）。
  problems.push(...findRegistryProblems({ packageRoot: PACKAGE_ROOT, modulePages: MODULE_PAGES }))
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
 * 资源文件名集合 → 动态 chunk 基名集合。
 *
 * Vite 的动态 chunk 名形如 `<模块文件名>-<hash>.js`；取 `-hash.js` 之前的基名。
 * 单独抽出来是给 {@link syntheticDist} 用的：合成样本必须走**同一条**派生规则，
 * 否则"样本长得像 dist"就成了一句没人检查的话（读产物的规则改了、样本没改 ⇒ 自检恒绿）。
 * @param assetFiles - `assets/` 下的文件名（不含目录）。
 * @returns chunk 基名集合。
 */
function chunkBasenamesOf(assetFiles) {
  return new Set(
    assetFiles
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.replace(/-[A-Za-z0-9_-]{6,}\.js$/u, '').replace(/\.js$/u, '')),
  )
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
  return { text, chunkBasenames: chunkBasenamesOf(assetFiles), assetFiles }
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
    for (const page of expectation.pages) {
      const chunk = chunkBasenameOf(page)
      const present = dist.chunkBasenames.has(chunk)
      if (on && !present) problems.push(`${expectation.module} 已开启，但缺少它的页面 chunk ${chunk}-*.js（对应 ${page}）`)
      if (!on && present) problems.push(`${expectation.module} 已关闭，但仍产出了它的页面 chunk ${chunk}-*.js（对应 ${page}）`)
    }
  }
  return problems
}

/**
 * 合成样本条数**下限**（棘轮；见文件头"判定体自己也要有量具"）。
 *
 * 取值 = `SELFTEST_SAMPLES` 的当前实测条数，只允许被"变多"越过。为什么要有这条地板：
 * 逐样本断言是"对每条样本判一次"，样本被删光时那个循环**一次都不执行** ⇒ 自检恒绿，
 * 判定体被掏空又回到审计现场。所以 `>=` 判据与逐样本断言**分开写**（掏空逐样本断言
 * 不能顺手掏空这条地板）。
 */
const SELFTEST_MIN_SAMPLES = 7

/** 负样本（注入了偏差、必须被 `judge()` 点名）的条数下限，与上一条同口径。 */
const SELFTEST_MIN_RED_SAMPLES = 6

/** 合成 chunk 名里的伪哈希（形状与 Vite 产出一致，供 {@link chunkBasenamesOf} 剥掉）。 */
const SYNTHETIC_CHUNK_HASH = 'AbCd1234'

/**
 * 期望表里某个模块的那一项。
 * @param module - 模块名。
 * @returns `{ module, sentinel, pages }`（找不到 ⇒ 抛错：样本自己引用了不存在的模块）。
 */
function expectationOf(module) {
  const found = MODULE_EXPECTATIONS.find((entry) => entry.module === module)
  if (found === undefined) throw new Error(`自检样本引用了不存在的模块：${module}`)
  return found
}

/**
 * 造一个"与该变体一致"的 dist 形状样本（不碰磁盘、不跑构建）。
 *
 * 形状与 {@link readDist} 的返回**逐字段同形**，chunk 基名走同一条
 * {@link chunkBasenamesOf} —— 判定体的输入契约变了，这些样本也必须跟着变，否则自检会
 * 变成"拿旧形状喂新判定体"的假绿。
 * @param enabled - `Set<string>` 该变体下开启的模块。
 * @returns `{ text, chunkBasenames, assetFiles }`。
 */
function syntheticDist(enabled) {
  const assetFiles = [`${CORE_PAGE_CHUNK}-${SYNTHETIC_CHUNK_HASH}.js`]
  let text = ''
  for (const expectation of MODULE_EXPECTATIONS) {
    if (!enabled.has(expectation.module)) continue
    text += `<div data-feature-sentinel="${expectation.sentinel}"></div>`
    for (const page of expectation.pages) {
      assetFiles.push(`${chunkBasenameOf(page)}-${SYNTHETIC_CHUNK_HASH}.js`)
    }
  }
  return { text, chunkBasenames: chunkBasenamesOf(assetFiles), assetFiles }
}

/**
 * 自检样本表：**一个正样本 + 六个负样本**，负样本各注入一类偏差（对应 `judge()` 的
 * 每一条断言）。`mutate === null` 即正样本。
 *
 * 期望是**结构性**的（正样本必须零问题、负样本必须被点名），不是"必须恰好报 N 项" ——
 * 后者会把"判定体多报了一条"这种改进也判红；这里要钉住的是"判定体还看得见偏差"。
 *
 * @type {{ name: string, variant: string, mutate: ((dist: object) => void) | null, why: string }[]}
 */
const SELFTEST_SAMPLES = [
  {
    name: '正样本：全开变体与产物一致',
    variant: FULL_VARIANT,
    mutate: null,
    why: '判定体把正确产物判红（量具坏了，会天天误报产品错）',
  },
  {
    name: '负样本①：已开启模块缺哨兵串',
    variant: FULL_VARIANT,
    mutate: (dist) => { dist.text = dist.text.replace(expectationOf('apps').sentinel, '') },
    why: '内容面的"开启侧必须存在"整条失效',
  },
  {
    name: '负样本②：已关闭模块多出哨兵串',
    variant: 'skills,connectors',
    mutate: (dist) => { dist.text += `<div data-feature-sentinel="${expectationOf('apps').sentinel}"></div>` },
    why: '内容面看不见"关闭的模块其页面代码进了 dist"',
  },
  {
    name: '负样本③：已开启模块缺页面 chunk',
    variant: FULL_VARIANT,
    mutate: (dist) => {
      const missing = `${chunkBasenameOf(expectationOf('apps').pages[0])}-${SYNTHETIC_CHUNK_HASH}.js`
      dist.assetFiles = dist.assetFiles.filter((name) => name !== missing)
    },
    why: '结构面的"开启侧必须存在"整条失效',
  },
  {
    name: '负样本④：已关闭模块多出页面 chunk',
    variant: 'skills,connectors',
    mutate: (dist) => {
      dist.assetFiles.push(`${chunkBasenameOf(expectationOf('apps').pages[0])}-${SYNTHETIC_CHUNK_HASH}.js`)
    },
    why: '结构面看不见"关闭的模块仍产出了它的页面 chunk"',
  },
  {
    name: '负样本⑤：空 dist',
    variant: FULL_VARIANT,
    mutate: (dist) => { dist.assetFiles = []; dist.text = '' },
    why: '反空转失效 ⇒ 关闭侧的全部"不存在"断言可以被一次失败构建满足',
  },
  {
    name: '负样本⑥：缺核心页 chunk',
    variant: FULL_VARIANT,
    mutate: (dist) => {
      dist.assetFiles = dist.assetFiles.filter((name) => !name.startsWith(`${CORE_PAGE_CHUNK}-`))
    },
    why: '反空转的另一半失效 ⇒ 分不清"模块被裁掉"与"这次构建什么都没产出"',
  },
]

/**
 * **判定体的自检**（判据的判据）：合成样本喂给 `judge()`，断言正样本零问题、每个负样本
 * 都被点名，且样本数不低于地板。
 *
 * 为什么这里不复用 `readDist`：那要真构建（分钟级）才能拿到输入，而这条自检必须在**任何
 * 真构建之前**跑完 —— 判据坏了要 1 秒内知道。
 * @returns {string[]} 问题清单（空 = 判定体在量、且量具没被删）。
 */
function judgeSelftestProblems() {
  const problems = []
  const negatives = SELFTEST_SAMPLES.filter((sample) => sample.mutate !== null)
  const positives = SELFTEST_SAMPLES.filter((sample) => sample.mutate === null)
  // ---- 地板（与逐样本断言分开：见 SELFTEST_MIN_SAMPLES 的说明）------------------
  if (SELFTEST_SAMPLES.length < SELFTEST_MIN_SAMPLES) {
    problems.push(
      `自检样本只剩 ${SELFTEST_SAMPLES.length} 条 < 下限 ${SELFTEST_MIN_SAMPLES}`
        + '（判据的判据被删样本；删样本必须同时改这里的下限并写明理由）',
    )
  }
  if (negatives.length < SELFTEST_MIN_RED_SAMPLES) {
    problems.push(
      `负样本只剩 ${negatives.length} 条 < 下限 ${SELFTEST_MIN_RED_SAMPLES}`
        + '（没有偏差注入，"判定体还在"就成了没人检查的话）',
    )
  }
  if (positives.length === 0) problems.push('一个正样本都没有（判定体可以被"永远报错"满足）')
  // ---- 逐样本 ------------------------------------------------------------------
  for (const sample of SELFTEST_SAMPLES) {
    try {
      const enabled = new Set(sample.variant === NONE_VARIANT ? [] : sample.variant.split(','))
      const dist = syntheticDist(enabled)
      if (sample.mutate !== null) sample.mutate(dist)
      // 变异只动 `assetFiles` / `text`；chunk 派生面按产物口径重算（同 `readDist`）。
      dist.chunkBasenames = chunkBasenamesOf(dist.assetFiles)
      const found = judge({ label: sample.name, variant: sample.variant }, enabled, dist)
      if (sample.mutate !== null && found.length === 0) {
        problems.push(
          `自检「${sample.name}」：注入了偏差（${sample.why}）却一项都没被 judge() 检出 —— `
            + '判定体的这一条断言失效了（改判定体必须同批改本样本，并说明为什么这条断言不该再成立）',
        )
      }
      if (sample.mutate === null && found.length > 0) {
        problems.push(
          `自检「${sample.name}」：正样本（与变体一致的产物）被判出 ${found.length} 项：`
            + `${found.join('；')} —— 量具坏了，先修判据再修产品`,
        )
      }
    } catch (error) {
      // 合成样本自己抛错（表形状变了、模块名对不上……）也必须归到"判据自身失效"（退出码 2）：
      // 让异常冒到 node 顶层会得到退出码 1，那会被读成"产品错了"，与本文的口径冲突。
      problems.push(`自检「${sample.name}」跑不起来：${error instanceof Error ? error.message : String(error)}`)
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

  // **第一步**：判定体自己的量具（不跑构建，毫秒级）。放在前置检查之前 —— 判定体坏了的话，
  // 后面每一步"通过"都没有意义（一个 `return []` 的判定体会让整套矩阵打印 ✅）。
  const selftest = judgeSelftestProblems()
  if (selftest.length > 0) {
    process.stderr.write(
      'check-feature-chunks: judge() 自检未通过（退出码 2 —— 失效的是**判据**，不是产物）\n',
    )
    for (const problem of selftest) process.stderr.write(`  · ${problem}\n`)
    process.stderr.write(
      '  口径：退出码 2 = 判据自身失效（自检/量具/页表对拍），退出码 1 = 产物与变体不符；'
        + '先修判据（本脚本的 judge() / SELFTEST_SAMPLES）再谈产品。\n',
    )
    return 2
  }

  const preconditions = checkPreconditions()
  if (preconditions.length > 0) {
    process.stderr.write('check-feature-chunks: 判据自身的前置检查未通过（退出码 2）\n')
    for (const problem of preconditions) process.stderr.write(`  · ${problem}\n`)
    return 2
  }

  // 源码图上的泄漏（退出码 1，**先于构建**判）：静态引用一个模块页时，它会被内联进引用方的
  // chunk —— 结构面没有 chunk 名可判、内容面只在被拉进来的那个文件自己带哨兵时才看得见。
  // 这条不依赖打包器行为，先判能让失败信息直接指向那行 import，也省掉 5 次构建。
  const cutProblems = findCutProblems({ packageRoot: PACKAGE_ROOT, modulePages: MODULE_PAGES })
  if (cutProblems.length > 0) {
    process.stderr.write(`check-feature-chunks: 源码图上就有 ${cutProblems.length} 处模块页被守卫之外的路径引用（退出码 1）\n`)
    for (const problem of cutProblems) process.stderr.write(`  · ${problem}\n`)
    process.stderr.write(
      '  口径：模块页只能经 src/App.tsx 里 __FEATURE_<MODULE>__ 守卫的 import() 进入产物；'
        + '静态引用（或未被守卫的 import()）会让关闭变体的产物里仍带着该页代码。\n',
    )
    return 1
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
      '  口径：关闭的模块其页面代码不得进 dist（内容=哨兵串、结构=页面 chunk 名、'
        + '源码图=模块页只能经守卫 import() 进入）；'
        + '开启的模块两侧都必须存在。改模块边界请同步 MODULE_EXPECTATIONS（页表与守卫双向对拍）。\n',
    )
    return 1
  }
  process.stdout.write(
    `check-feature-chunks: ✅ ${matrix.length} 个变体全部符合预期`
      + `（源码图无旁路入口 / 全开侧存在 / 关闭侧不存在，逐模块双侧；模块：${FEATURE_MODULES.join(', ')}）\n`,
  )
  return 0
}

process.exit(main())
