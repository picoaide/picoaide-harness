/**
 * 变体页面图判据（P3 第三片）：**模块页只能经 `__FEATURE_<MODULE>__` 守卫的 `import()`
 * 进入产物** —— 判的是 `src/**` 的 **import 图**，不是只看 `App.tsx`。
 *
 * 契约：`docs/decisions/2026-10-14-webadmin-feature-variant.md`（本片）与
 * `docs/decisions/2026-10-13-channel-feature-modules.md` §6（哨兵串）。
 *
 * ## 为什么必须有这一条（现场）
 *
 * 产物判据 `check-feature-chunks.mjs` 的两条量具里，**结构面**只认 Vite 的动态 chunk 名
 * （`<模块文件名>-<hash>.js`）。模块页一旦被**静态**引用，它就被内联进引用方的 chunk：
 * 既没有自己的 chunk 名，也没有"关闭变体里不该出现"的可判形态。实测的变异体（审计 M6）：
 * 在核心页 `src/pages/Users.tsx` 顶部写一行 `import AppsProbe from './app-center/Apps'`
 * （外加防 tree-shaking 的 `globalThis` 副作用）⇒ `FEATURES=skills,connectors` 的产物里
 * `assets/Users-<hash>.js` 带着应用中心的页面代码，而当时的判据全绿。
 *
 * 内容面（哨兵串）能不能抓住它，取决于**哨兵落在哪个文件**：apps 的哨兵当时只在
 * `pages/app-center/AppCenterLayout.tsx`（分区布局），被静态拉进来的是 `Apps.tsx`
 * —— 没有哨兵的那个文件泄漏时，内容面也看不见。所以本片的修法是两条一起：
 *
 *   ① **每个模块页各自带哨兵**（`findSentinelProblems`：登记在页表里的每个文件都必须声明
 *      本模块的哨兵字面量、并在 JSX 里**真的渲染**它）—— 内容面的覆盖面 = 页表，不再是
 *      "每个模块碰巧有一个文件带哨兵"；
 *   ② **模块页的入口只能有一个**（`findCutProblems`：从 `src/main.tsx` 出发的 import 图里，
 *      指向模块页/模块私有代码的每一条边都必须是 `App.tsx` 里那条被守卫的 `import()`）——
 *      这条不依赖打包器的 tree-shaking 行为，**边的存在**本身就是红灯。
 *
 * 第三条（`findRegistryProblems`）是"判据自己的表不许缩面"：`App.tsx` 里被守卫的每个
 * `import()` 说明符与本模块页表**双向**对拍，新增模块页不登记 ⇒ 红，页表列了但守卫没了
 * ⇒ 同样红。
 *
 * ## 判据形态（三条规则，逐一对应的失效形态）
 *
 *   · **R1 声明页**：页表里的文件，除"`App.tsx` 里本模块那条守卫 `import()`"之外，
 *     **任何**入边（静态 / 未被守卫的动态 / 来自别的模块）都是违规 —— 覆盖 M6（核心页静态
 *     引用）与 M5（入口静态引用）。
 *   · **R2 模块私有文件**：不是声明页、但只在模块守卫之下才可达的文件（例如能力中心的
 *     子页 `pages/Marketplace.tsx`）。从模块外部引用它同样违规 —— 否则"漏一个文件"就退回
 *     到 R1 之前的形态。与核心共用的文件（`components/ui/*`）两边都可达 ⇒ 不算模块私有。
 *   · **R3 页表双向**：见 {@link findRegistryProblems}。
 *
 * 扫描面是**源码文本**（正则抽 import 语句），不是 TypeScript 编译器：`tsc` 在这里要
 * 秒级 ~ 十秒级并需要一份 `tsconfig` 语义，而本判据要跑在每次 `npm test` 里。代价是
 * "型别导入"必须显式排除（`import type` / `export type` 在编译期被抹掉，不算运行时边），
 * 以及非相对说明符（裸包名 / `@/` 别名之外的形式）不解析 —— 后者只可能是外部依赖，
 * 不可能是本仓页面。**认账**：注释里写着的 `import('…')` 会被当成边（本仓不允许用注释
 * 藏 import；真出现时红灯指向那行，改注释即可）。
 *
 * @module picoaide-webadmin/feature-page-graph
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

/** 参与图扫描的扩展名（页面与它们的依赖；`.css` / `.json` 不是模块页，不参与可达性）。 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.jsx']

/** 前端源码根（相对 webadmin 包根）。 */
export const SOURCE_ROOT = 'src'

/** 构建入口（`index.html` 的 `<script type="module" src="/src/main.tsx">`）。 */
export const ENTRY_FILE = 'src/main.tsx'

/** 变体入口（守卫写在这里）。 */
export const APP_FILE = 'src/App.tsx'

/**
 * `__FEATURE_<MODULE>__ ? lazy(() => import('<spec>'))` 的匹配（含区间；守卫形态的
 * 唯一判据在 `src/lib/features.test.ts`，这里只负责**把这条边认出来**）。
 */
const GUARD_RE = /__FEATURE_([A-Z0-9_]+)__\s*\?\s*lazy\(\s*\(\s*\)\s*=>\s*import\(\s*'([^']+)'\s*\)\s*\)/gu

/** `import … from '<spec>'` / `export … from '<spec>'`（整条语句，含跨行）。 */
const STATEMENT_RE = /(?:^|\n)[ \t]*(import|export)\b([\s\S]*?)\bfrom[ \t]*['"]([^'"]+)['"]/gu

/** 副作用导入：`import '<spec>'`（无 `from`，单独抽，避免吞掉下一条语句）。 */
const BARE_IMPORT_RE = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/gu

/** 动态导入：`import('<spec>')`。 */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu

/**
 * 一个 import 边。
 * @typedef {object} ImportEdge
 * @property {string} to - 目标文件的绝对路径。
 * @property {string} spec - 源码里写的说明符。
 * @property {boolean} dynamic - 是否 `import()`（false = 静态 import/export）。
 * @property {string | null} guardedModule - 该边是否就是 `App.tsx` 里某个 `__FEATURE_*__` 守卫的 `import()`；是则给出模块名。
 */

/**
 * `__FEATURE_<MODULE>__ ? lazy(() => import('<spec>'))` 的全部出现。
 * @param appSource - `App.tsx` 源码。
 * @returns {{ module: string, spec: string, start: number, end: number }[]} 守卫清单（`module` 已小写）。
 */
export function parseGuardedImports(appSource) {
  const out = []
  for (const match of appSource.matchAll(GUARD_RE)) {
    out.push({
      module: match[1].toLowerCase(),
      spec: match[2],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return out
}

/**
 * 说明符 → 目标文件（不存在 ⇒ `null`）。
 *
 * 只认相对说明符与 `@/` 别名（`vite.config.ts` 的 alias 指向 `src/`）：裸说明符是外部依赖，
 * 不可能是本仓页面。
 * @param fromFile - 发起 import 的文件（绝对路径）。
 * @param spec - 说明符。
 * @param packageRoot - webadmin 包根（绝对路径）。
 * @returns 目标文件绝对路径或 `null`。
 */
export function resolveSpecifier(fromFile, spec, packageRoot) {
  let base
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else if (spec.startsWith('@/')) base = resolve(packageRoot, SOURCE_ROOT, spec.slice(2))
  else return null
  const candidates = [base]
  for (const extension of SOURCE_EXTENSIONS) candidates.push(base + extension)
  for (const extension of SOURCE_EXTENSIONS) candidates.push(join(base, `index${extension}`))
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * 一个源文件里的全部 import 边。
 * @param file - 文件绝对路径。
 * @param source - 源码。
 * @param packageRoot - webadmin 包根（绝对路径）。
 * @param appFile - `App.tsx` 的绝对路径（只有它上面的动态 `import()` 可能被守卫认领）。
 * @returns {ImportEdge[]} 边清单（解析不到目标的说明符直接丢弃）。
 */
function parseImportEdges(file, source, packageRoot, appFile) {
  const guards = file === appFile ? parseGuardedImports(source) : []
  const edges = []
  /** @param spec - 说明符。 @param dynamic - 是否动态。 @param index - 匹配位置。 */
  const push = (spec, dynamic, index) => {
    const to = resolveSpecifier(file, spec, packageRoot)
    if (to === null) return
    const guard = dynamic
      ? guards.find((entry) => index >= entry.start && index < entry.end && entry.spec === spec)
      : undefined
    edges.push({ to, spec, dynamic, guardedModule: guard?.module ?? null })
  }
  for (const match of source.matchAll(STATEMENT_RE)) {
    // `import type … from '…'` / `export type … from '…'`：编译期被抹掉，不是运行时边。
    if (/^[ \t]*type\b/u.test(match[2] ?? '')) continue
    push(match[3], false, match.index)
  }
  for (const match of source.matchAll(BARE_IMPORT_RE)) push(match[1], false, match.index)
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) push(match[1], true, match.index)
  return edges
}

/**
 * 递归列出参与图扫描的源文件（**排除测试文件**：`*.test.*` / `*.spec.*` 不在构建图里，
 * 它们 import 页面是正常形态）。
 * @param dir - 目录绝对路径。
 * @param out - 累积数组。
 * @returns {string[]} 文件绝对路径（升序）。
 */
function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(full, out)
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name))
      && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) out.push(full)
  }
  return out.sort()
}

/**
 * 相对 webadmin 包根的 POSIX 路径（打印用；注释里写的路径要能直接粘进编辑器）。
 * @param packageRoot - 包根。
 * @param file - 绝对路径。
 * @returns 相对路径。
 */
function rel(packageRoot, file) {
  return relative(packageRoot, file).split(sep).join('/')
}

/**
 * 整个 `src/**` 的 import 图。
 * @param packageRoot - webadmin 包根（绝对路径）。
 * @returns {{ graph: Map<string, ImportEdge[]>, entry: string, appFile: string }} 图与两个入口。
 */
function buildGraph(packageRoot) {
  const srcDir = join(packageRoot, SOURCE_ROOT)
  const appFile = join(packageRoot, APP_FILE)
  const entry = join(packageRoot, ENTRY_FILE)
  const graph = new Map()
  for (const file of listSourceFiles(srcDir)) {
    graph.set(file, parseImportEdges(file, readFileSync(file, 'utf8'), packageRoot, appFile))
  }
  return { graph, entry, appFile }
}

/**
 * 广度优先：从 `roots` 出发，**跳过全部被守卫的 `import()`**（守卫是模块的唯一合法入口，
 * 由 R1 单独判），并且不进入 `stopAt` 里的文件。
 * @param roots - 起点文件。
 * @param graph - import 图。
 * @param stopAt - 不再继续展开的文件集合。
 * @returns {Set<string>} 可达文件（含起点）。
 */
function reachable(roots, graph, stopAt = new Set()) {
  const seen = new Set()
  const queue = []
  for (const root of roots) {
    if (!seen.has(root)) {
      seen.add(root)
      queue.push(root)
    }
  }
  while (queue.length > 0) {
    const file = queue.shift()
    for (const edge of graph.get(file) ?? []) {
      if (edge.guardedModule !== null) continue
      if (seen.has(edge.to) || stopAt.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return seen
}

/**
 * **R3 页表双向对拍**：`App.tsx` 里被守卫的 `import()` ⟺ 模块页表。
 *
 * 为什么必须双向：单向（"表里的文件存在"）不会发现**新增的模块页**——新页面写进
 * `App.tsx` 的守卫里、忘了登记，产物判据就少判一个文件（这正是审计的 P1-3：
 * 两张表互相独立时，"新增模块页"只会更新其中一张）。
 * @param options - `{ packageRoot, modulePages }`。
 * @param options.packageRoot - webadmin 包根（绝对路径）。
 * @param options.modulePages - 模块 → 页面源文件（相对包根的 POSIX 路径）。
 * @returns {string[]} 问题清单（空 = 双向一致）。
 */
export function findRegistryProblems({ packageRoot, modulePages }) {
  const appFile = join(packageRoot, APP_FILE)
  if (!existsSync(appFile)) return [`变体入口不存在：${APP_FILE}（守卫与页表都无从对拍）`]
  const appSource = readFileSync(appFile, 'utf8')
  const problems = []
  const resolved = []
  for (const guard of parseGuardedImports(appSource)) {
    const to = resolveSpecifier(appFile, guard.spec, packageRoot)
    if (to === null) {
      problems.push(
        `${APP_FILE} 里 __FEATURE_${guard.module.toUpperCase()}__ 守卫的 import('${guard.spec}') `
          + '解析不到源文件（路径写错？页表/守卫两侧都要能定位到同一个文件）',
      )
      continue
    }
    resolved.push({ module: guard.module, to, spec: guard.spec })
  }
  if (resolved.length === 0) {
    problems.push(`${APP_FILE} 里一个被守卫的模块页 import() 都扫不到（扫描器退化？页表无从对拍）`)
  }
  const allListed = new Map()
  for (const [module, pages] of Object.entries(modulePages)) {
    for (const page of pages) allListed.set(join(packageRoot, page), module)
  }
  // 方向 ①：守卫 → 页表
  for (const entry of resolved) {
    const owner = allListed.get(entry.to)
    if (owner === undefined) {
      problems.push(
        `${APP_FILE} 里守卫着 ${rel(packageRoot, entry.to)}（模块 ${entry.module}），但它不在任何模块的页表里 `
          + '—— 新增模块页必须同时登记（否则产物判据少判一个文件）',
      )
    } else if (owner !== entry.module) {
      problems.push(
        `${rel(packageRoot, entry.to)} 在 __FEATURE_${entry.module.toUpperCase()}__ 守卫下，页表却把它登记在模块 ${owner}`
          + '（守卫的模块与页表的模块必须一致）',
      )
    }
  }
  // 方向 ②：页表 → 守卫
  for (const [module, pages] of Object.entries(modulePages)) {
    for (const page of pages) {
      const target = join(packageRoot, page)
      const hits = resolved.filter((entry) => entry.to === target && entry.module === module)
      if (hits.length === 0) {
        problems.push(
          `模块 ${module} 的页表列了 ${page}，但 ${APP_FILE} 里没有对应的 `
            + `__FEATURE_${module.toUpperCase()}__ ? lazy(() => import('…')) 守卫 `
            + '（守卫被删/被改名/换了模块，或页表已经过期）',
        )
      } else if (hits.length > 1) {
        problems.push(`模块 ${module} 的 ${page} 在 ${APP_FILE} 里被守卫了 ${hits.length} 次（期望恰好一次）`)
      }
    }
  }
  return problems
}

/**
 * **R1 + R2 切面判据**：模块代码的每一条入边都必须是守卫那条 `import()`。
 *
 * 判据形态见文件头"三条规则"。返回的是**违规清单**（空 = 切干净了）。
 * @param options - `{ packageRoot, modulePages }`。
 * @param options.packageRoot - webadmin 包根（绝对路径）。
 * @param options.modulePages - 模块 → 页面源文件（相对包根的 POSIX 路径）。
 * @returns {string[]} 问题清单（空 = 每个模块页都只能经守卫进入）。
 */
export function findCutProblems({ packageRoot, modulePages }) {
  const { graph, entry, appFile } = buildGraph(packageRoot)
  if (!graph.has(entry)) return [`构建入口 ${ENTRY_FILE} 不在源码图里（工作目录不对？）`]
  const problems = []
  const declared = new Map()
  for (const [module, pages] of Object.entries(modulePages)) {
    for (const page of pages) declared.set(join(packageRoot, page), module)
  }
  // 守卫边：目标 → 模块（`App.tsx` 上的那些 import()）。
  const guardTargets = new Map()
  for (const edge of graph.get(appFile) ?? []) {
    if (edge.guardedModule !== null) guardTargets.set(edge.to, edge.guardedModule)
  }
  const seenPairs = new Set()
  const report = (from, to, detail) => {
    const key = `${from}\u0000${to}`
    if (seenPairs.has(key)) return
    seenPairs.add(key)
    problems.push(detail)
  }

  // ---- R1：声明页只允许"本模块守卫"这一条入边 --------------------------------
  const guardedModules = new Set(guardTargets.values())
  for (const [from, edges] of graph) {
    for (const edge of edges) {
      const owner = declared.get(edge.to)
      if (owner === undefined) continue
      if (edge.guardedModule !== null) {
        if (from === appFile && edge.guardedModule === owner) continue
        report(from, edge.to,
          `${rel(packageRoot, edge.to)}（模块 ${owner}）被 ${rel(packageRoot, from)} 上一条 `
            + `__FEATURE_${edge.guardedModule.toUpperCase()}__ 守卫的 import() 引入 —— 守卫只能写在 `
            + `${APP_FILE}（换个文件写等于让产物判据看不见这条边）`)
        continue
      }
      report(from, edge.to,
        `模块页 ${rel(packageRoot, edge.to)}（模块 ${owner}）被 ${rel(packageRoot, from)} 以`
          + `${edge.dynamic ? '**未被守卫的动态** import()' : '**静态** import'} 引入 —— `
          + `模块页只能经 ${APP_FILE} 里 __FEATURE_${owner.toUpperCase()}__ 守卫的 import() 进入；`
          + '否则关闭该模块时它的页面代码仍会进产物（Vite 会把它内联进引用方的 chunk，'
          + '结构面看不到、内容面只在它自己带哨兵时才看得到）')
    }
  }

  // ---- R2：模块私有文件（非声明页，只在守卫下可达）同样不许被外部引用 --------
  const coreReachable = reachable([entry], graph)
  const stopAt = new Set([...guardTargets.keys()])
  const owners = new Map()
  for (const [target, module] of guardTargets) {
    if (!graph.has(target)) continue
    for (const file of reachable([target], graph, stopAt)) {
      if (coreReachable.has(file)) continue
      const set = owners.get(file) ?? new Set()
      set.add(module)
      owners.set(file, set)
    }
  }
  for (const [from, edges] of graph) {
    for (const edge of edges) {
      if (edge.guardedModule !== null) continue
      const owner = owners.get(edge.to)
      if (owner === undefined || owner.size === 0) continue
      // 同一个模块内部的边是正常形态（子页随守卫一起进产物）；跨模块/从模块外进来的才是泄漏。
      const fromOwner = owners.get(from) ?? new Set()
      if ([...owner].some((module) => fromOwner.has(module))) continue
      // 声明页由 R1 报（措辞更具体），这里不重复。
      if (declared.has(edge.to)) continue
      report(from, edge.to,
        `${rel(packageRoot, edge.to)}（模块 ${[...owner].join('/')} 的私有代码）被 `
          + `${rel(packageRoot, from)}（${fromOwner.size === 0 ? '模块外' : `模块 ${[...fromOwner].join('/')}`}）`
          + `以${edge.dynamic ? '动态' : '静态'} import 引入 —— 关闭该模块时它仍会进产物`)
    }
  }
  // 反向自证：守卫一个都没扫到（或图是空的）时，上面两条规则都会"零命中"。
  if (guardedModules.size === 0 && graph.size > 0) {
    problems.push(`${APP_FILE} 上扫不到任何被守卫的模块页 import()（图判据的起点没了，先跑页表对拍）`)
  }
  return problems
}

/**
 * 每个**声明页**都必须自带本模块的哨兵串，并且在 JSX 里真的渲染它
 * （内容面 `check-feature-chunks.mjs` 的覆盖面 = 页表，而不是"每模块碰巧有一个文件带哨兵"）。
 *
 * 形态约束（刻意的）：`export const FEATURE_SENTINEL = '<哨兵>'` + 作为值出现在
 * `data-feature-sentinel={FEATURE_SENTINEL}`。两条都是"可执行引用"的判据 —— 只写在注释里、
 * 或只声明不渲染（未被引用的字符串会被打包器丢掉），都不算。
 * @param options - `{ packageRoot, modulePages, moduleSentinels }`。
 * @param options.packageRoot - webadmin 包根（绝对路径）。
 * @param options.modulePages - 模块 → 页面源文件（相对包根的 POSIX 路径）。
 * @param options.moduleSentinels - 模块 → 哨兵串。
 * @returns {string[]} 问题清单（空 = 每个声明页都带哨兵且渲染了它）。
 */
export function findSentinelProblems({ packageRoot, modulePages, moduleSentinels }) {
  const problems = []
  for (const [module, pages] of Object.entries(modulePages)) {
    const sentinel = moduleSentinels[module]
    if (typeof sentinel !== 'string' || sentinel === '') {
      problems.push(`模块 ${module} 没有给出哨兵串（量具缺失 ⇒ "关闭变体里没有它"变成恒真）`)
      continue
    }
    for (const page of pages) {
      const file = join(packageRoot, page)
      if (!existsSync(file)) {
        problems.push(`模块 ${module} 的页面源文件不存在：${page}`)
        continue
      }
      const source = readFileSync(file, 'utf8')
      const declaration = new RegExp(
        `export const FEATURE_SENTINEL\\s*=\\s*['"]${sentinel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`,
        'u',
      )
      if (!declaration.test(source)) {
        problems.push(
          `${page} 里没有本模块的哨兵字面量声明（期望 \`export const FEATURE_SENTINEL = '${sentinel}'\`）`
            + ' —— 模块页各自带哨兵，内容面才覆盖得住"这个文件被静态拉进产物"',
        )
      }
      if (!/data-feature-sentinel=\{FEATURE_SENTINEL\}/u.test(source)) {
        problems.push(
          `${page} 声明了哨兵却没有在 JSX 里渲染（期望 \`data-feature-sentinel={FEATURE_SENTINEL}\`）`
            + ' —— 未被引用的字符串会被打包器丢掉，"产物里没有这个串"就失去意义',
        )
      }
    }
  }
  return problems
}
