#!/usr/bin/env node
/**
 * 根守卫「判据自身的**解析器**与守卫脚本**内容**」完整性判据。
 *
 * 对应 2026-09-24 第十轮审计的两条同族发现（"判据自己读到的东西由谁解释 / 执行"）：
 *
 * ## C-17 —— 门禁的**依赖面**就是门禁的判据面
 *
 * `scripts/check-workflows.mjs` / `scripts/verify-ci-scripts.mjs` / `scripts/verify-inventories.mjs`
 * 三条根守卫都 `import { parse } from 'yaml'`。审计实测：把 `node_modules/yaml` 换成一个
 * **只对 ≥20 KB 文档剔除被拒键名**的补丁副本（大小闸门是为了不惊动内联的小 YAML 自检样本），
 * 三条判据同时失明而 `check-root-guards.mjs` 照报 `✓`。投放机制不是"必须手改 node_modules"
 * 的妄想：`package.json` 的 `resolutions` 里已经有 10 条 `patch:` 条目（`patches/*.patch`
 * 入库、`corepack yarn install` 时应用），把 `yaml` 加进去是完全同形的操作 ——
 * 也就是说"改解析器"这件事**可以完全发生在仓库里**。
 *
 * 判据：对解析器包的**实际文件集**（按路径升序：`path\0<文件 sha256>\n` 逐条喂给 sha256）
 * 算一个摘要，与下面 `REGISTERED_GATE_PARSER_PACKAGES` 的登记值对拍。不一致 ⇒ 红，
 * 并打印**可执行指引**（谁来改、怎么改、什么情况下**不该**顺手改登记值）。
 *
 * **为什么不 import 那个包**：本判据自己绝不能依赖它 —— 用了 `yaml` 就等于把判据的
 * 可信根交给同一个可被 `resolutions` 改写的包（C-17 的原话：判据自身被谁执行）。
 * 所以本文件只用 `node:crypto` + `node:fs`，读的是**文件字节**，不是它能解析出什么。
 *
 * ## C-06 —— 守卫脚本的**内容**也是判据面
 *
 * `scripts/check-root-guards.mjs` 的 `REGISTERED_GUARD_ENTRIES` 逐条登记了「守卫名 →
 * argv 尾 → 脚本路径」，但**脚本内容本身无判据**：把 `scripts/check-theme-tokens.mjs`
 * 的内容整段换成 `process.exit(0)`、或把它换成同名**符号链接**指向另一个能通过的守卫之后，
 * 运行器照报 `✓ check-theme-tokens`（审计在副本里实测：从 ✗ 翻成 ✓，两条门禁都看不出区别）。
 * 现在每条登记多一个 `digest`（脚本文件的 sha256），由本判据复算对拍；符号链接一律红。
 * 第二判据在 `scripts/verify-check-workspaces.mjs`（独立复算 + 自己的符号链接断言）。
 *
 * ## 用法与退出码
 *
 * 用法：`node scripts/check-guard-parser-integrity.mjs [--print-digests]`
 * 退出码：0 = 全部一致；1 = 有不一致（并打印指引）；2 = 判据自身读不到输入（配置/环境错误）。
 * `--print-digests` 只打印**可直接粘回仓内文件**的登记行（评审过的 diff 才是唯一的更新通道）。
 *
 * ## 诚实边界
 *
 * 覆盖的是"**安装后的文件字节**"这一层。真正防住"同一个 PR 顺手把登记值也改了"的机制是
 * **评审**（登记值在 diff 里可见），不是密码学 —— 本判据保证的是"任何解析器/守卫脚本的
 * 改动都必须显式出现在 diff 里"，而不是"改动不可能发生"。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// **执行体入口的共享实现**（R11-I1）：`yarnrcTopLevelKeys` / `yarnrcScalarValue` 是 `.yarnrc.yml` 的
// （实现在编排器 `check-workspaces.mjs` —— 那是两个 runner 共同的下游，方向由依赖决定）
// 唯一解析口径（内容登记判据与「经 yarn 可信吗」的前置检查共用一份）；`yarnEntryTrustProblems`
// 是「禁 yarnPath/plugins/生命周期钩子」的唯一判定。**刻意不 import `yaml`**：入口判据不能依赖
// 一个可被 `resolutions` 改写的解析器（本文件的 C-17 段就是这条）。
import { YARN_ENTRY_FORBIDDEN_KEYS, YARN_LIFECYCLE_HOOKS, yarnrcScalarValue, yarnrcTopLevelKeys } from './check-workspaces.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GUARD_RUNNER = join(ROOT, 'scripts', 'check-root-guards.mjs')
/** 守卫登记表的标记（与 `check-root-guards.mjs` 里的常量名逐字一致）。 */
const GUARD_TABLE_MARKER = 'const REGISTERED_GUARD_ENTRIES = new Map(['

/**
 * 门禁自己依赖的解析器包（C-17 的登记表；**唯一真源**）。
 *
 * `sha256` = 该包目录下**全部常规文件**的摘要（算法见 `packageTreeDigest()`）：
 * 路径升序，逐条 `update(相对路径)` + `update(0x00)` + `update(文件 sha256 的 hex)` + `update(0x0a)`，
 * 最后取整体 sha256 的 hex。`files` = 参与计算的文件数（用来抓"多塞了一个文件"这种
 * 摘要之外的形状变化 —— 它本来也会改变摘要，这个计数是给人看的冗余证据）。
 *
 * 更新通道：**只允许**在同一个 PR 里改这里的登记值（diff 可见、可评审）。
 * 生成：`node scripts/check-guard-parser-integrity.mjs --print-digests`。
 */
const REGISTERED_GATE_PARSER_PACKAGES = [
  {
    name: 'yaml',
    version: '2.9.0',
    files: 233,
    sha256: '2e4766b9ef2f933e833837091e03ec322a523651bd08317d0c2ce0d7a973be1d',
    why: 'check-workflows / verify-ci-scripts / verify-inventories 三条根守卫的 YAML 解析器；'
      + '换掉它即可让三条判据同时失明（第十轮审计 C-17 实测：只对 ≥20 KB 文档剔除被拒键名'
      + '的补丁副本让三条判据全部 EXIT=0）',
  },
]

/**
 * 一段字节的 sha256（小写 hex）。
 * @param data - 文件内容。
 * @returns 摘要。
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 一个包目录的**文件集**摘要。
 *
 * 逐文件（而不是"把整个目录 tar 起来"）算，是为了让报错能点名到**哪一个文件**变了 ——
 * 审计现场是"只改了一个 `dist/public-api.js`"，光有一个总摘要看不出病根。
 *
 * @param directory - 包目录绝对路径。
 * @returns `{ sha256, files, entries }`；`entries` = `[{ path, sha256 }]`（路径升序）。
 */
function packageTreeDigest(directory) {
  const files = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        files.push({ path, symlink: true })
        continue
      }
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push({ path, symlink: false })
    }
  }
  walk(directory)
  const entries = files
    .map(entry => ({
      path: relative(directory, entry.path).split(sep).join('/'),
      absolute: entry.path,
      symlink: entry.symlink,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : (left.path > right.path ? 1 : 0)))
  const digest = createHash('sha256')
  for (const entry of entries) {
    if (entry.symlink) {
      digest.update(entry.path)
      digest.update('\u0000')
      digest.update('SYMLINK')
      digest.update('\n')
      continue
    }
    digest.update(entry.path)
    digest.update('\u0000')
    digest.update(sha256(readFileSync(entry.absolute)))
    digest.update('\n')
  }
  return {
    sha256: digest.digest('hex'),
    files: entries.length,
    entries: entries.map(entry => ({ path: entry.path, symlink: entry.symlink })),
  }
}

/**
 * 解析一个包名 → **包根目录**（Node 真正会加载的那一份）。
 *
 * 先用 `import.meta.resolve()`（它不加载模块，只做解析；本判据因此仍然"不依赖 yaml"的
 * 语义 —— 只是问一句"如果加载，会加载谁"），再从入口文件向上找最近的、`package.json`
 * 里 `name` 与包名一致的目录。解析失败时回落到 `<ROOT>/node_modules/<name>`（本仓
 * `nodeLinker: node-modules`，根 devDependency 就装在那里）。
 *
 * @param name - 包名。
 * @returns `{ directory, source }`（`source` = 诊断用来源说明）；找不到时 `directory` 为 null。
 */
function resolvePackageDirectory(name) {
  const notes = []
  let entryUrl = null
  try {
    entryUrl = import.meta.resolve(name)
  } catch (error) {
    notes.push(`import.meta.resolve(${JSON.stringify(name)}) 失败：${error?.message ?? String(error)}`)
  }
  if (typeof entryUrl === 'string' && entryUrl.startsWith('file:')) {
    let directory = dirname(fileURLToPath(entryUrl))
    for (;;) {
      const manifestPath = join(directory, 'package.json')
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          if (manifest?.name === name) {
            return { directory, source: `import.meta.resolve → ${relative(ROOT, directory) || '.'}`, notes }
          }
        } catch { /* 继续向上找 */ }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    notes.push(`从 ${entryUrl} 向上没有找到 package.json 里 name === ${JSON.stringify(name)} 的目录`)
  }
  const fallback = join(ROOT, 'node_modules', name)
  if (existsSync(fallback)) {
    return { directory: fallback, source: `回落 ${relative(ROOT, fallback)}`, notes }
  }
  return { directory: null, source: '未找到', notes }
}

/**
 * 从 `check-root-guards.mjs` 的源码里解析守卫登记表（名字 / 脚本命令 / argv 尾 / digest）。
 *
 * 与 `check-root-guards.mjs` 解析编排器 `GUARDS` 表同一手法：**解析有判据** —— 表找不到、
 * 切出来的条目数与"以 `['` 开头的行数"对不上、某行解析不出四元组，全部 fail-loud。
 * 静默少读一条 = 那条守卫的内容判据消失，正是本文件要消灭的形态。
 *
 * @param source - `check-root-guards.mjs` 的源码文本。
 * @returns `{ entries }` 或 `{ error }`。
 */
export function parseGuardEntries(source) {
  const start = source.indexOf(GUARD_TABLE_MARKER)
  if (start < 0) return { error: `在 scripts/check-root-guards.mjs 里找不到 \`${GUARD_TABLE_MARKER}\`` }
  const end = source.indexOf('\n])', start)
  if (end < 0) return { error: '在 scripts/check-root-guards.mjs 里找不到守卫登记表的结尾' }
  const body = source.slice(start + GUARD_TABLE_MARKER.length, end)
  const entryLine = /^\s*\['([^']+)',\s*\{\s*script:\s*'([^']+)',\s*argvTail:\s*\[[^\]]*\],\s*digest:\s*'([^']*)'\s*\},?\s*\]\s*,?\s*$/u
  const entries = []
  const problems = []
  for (const line of body.split('\n')) {
    if (!/^\s*\['/u.test(line)) continue
    const match = entryLine.exec(line)
    if (match === null) {
      problems.push(`守卫登记表的这一行解析不出「名字 / script / argvTail / digest」四元组：${line.trim()}`)
      continue
    }
    entries.push({ name: match[1], script: match[2], digest: match[3] })
  }
  if (problems.length > 0) return { error: problems.join('\n  ') }
  if (entries.length === 0) return { error: '守卫登记表解析出 0 条（表结构变了？）' }
  return { entries }
}

/**
 * 把 `script`（形如 `node scripts/x.mjs` / `bash scripts/x.sh`）解析成仓内文件路径。
 * @param script - 登记值。
 * @returns `{ path, problem }`（二者其一为 null）。
 */
function guardScriptPath(script) {
  const match = /^(?:node|bash)\s+(scripts\/\S+)$/u.exec(typeof script === 'string' ? script.trim() : '')
  if (match === null) {
    return {
      path: null,
      problem: `登记的脚本命令 ${JSON.stringify(script)} 不是 \`node scripts/…\` / \`bash scripts/…\` 形态`,
    }
  }
  return { path: join(ROOT, match[1]), problem: null }
}

/**
 * 登记行的**可粘贴**形态（给 `--print-digests` 与不一致时的修法提示用）。
 * @param entry - `{ name, script, argvTail, digest }`。
 * @returns 一行 JS。
 */
function pasteLine(entry) {
  return `  ['${entry.name}', { script: '${entry.script}', argvTail: ${entry.argvTail}, digest: '${entry.digest}' }],`
}

/** 从源码里取某条登记的 argvTail 字面量（只用于打印可粘贴行）。 */
function argvTailLiteral(source, name) {
  const pattern = new RegExp(`\\['${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}',\\s*\\{[^}]*argvTail:\\s*(\\[[^\\]]*\\])`, 'u')
  return pattern.exec(source)?.[1] ?? '[]'
}

/* ===========================================================================
 * R11-I1（2026-09-24 第十一轮审计 · I1 泳道）：**执行体入口**的三条收口
 *
 * 这一段的主题与本文件原有两条（C-17 解析器包 / C-06 守卫脚本内容）同源：
 * 「判据自己读到、执行的东西由谁提供」。第十轮把判据面推到"守卫脚本的内容"之后就停了，
 * 而**谁把守卫跑起来**这一层还是敞开的 —— 本轮审计实测三条通道：
 *
 *   ① **P0-1**：`.yarnrc.yml` 的 `plugins:`（+ 可提交的 `.yarn/plugins/*.cjs`）在
 *      **yarn 进程内部**往每个被 spawn 的脚本环境注入 `NODE_OPTIONS=--import=<退出钩子>`
 *      ⇒ `corepack yarn check` EXIT 1→0（「32 通过、0 失败」）、
 *      `node scripts/check-root-guards.mjs` `3 通过、14 失败` → `17 通过、0 失败`，
 *      workflow 一个字节都没改；同族的 `yarnPath: ./noop.cjs` 更彻底 —— 整个 yarn 被换掉。
 *   ② **P1-1**：根 `package.json` 的 `postinstall` 在 `enableScripts: false` 下**仍然执行**
 *      （实测：它只挡依赖的构建脚本），而 CI 的 `yarn install --immutable` 排在根守卫之前
 *      ⇒ install 期可以改写守卫脚本**并顺手改掉内容摘要登记值**，内容判据 EXIT 1→0。
 *   ③ **P1-2**：同一条注入在 `check-workspaces.mjs`（`yarn check` 路径）上仍然有效 ——
 *      第十轮只给两个 runner 中的一个加了子进程环境清洗。
 *
 * 收口方式（与仓库既有纪律一致：**登记制 + 可评审的 diff + 判据必须能被打坏**）：
 *   · `.yarnrc.yml` 进登记制：键集合白名单 + `enableScripts` 取值判据 + **内容摘要**；
 *   · `.yarn/plugins/**` `.yarn/releases/**` 必须为空（配合 `.gitignore` 的反向规则登记）；
 *   · 根 `package.json` 的生命周期钩子进登记制（当前空表 = 禁新增）；
 *   · 摘要判据**锚到 git 对象**：工作树与 HEAD 不一致 ⇒ CI 上硬红（见 gitAnchorProblems 的理由与代价）；
 *   · 「两处都清洗 + 守卫不经 yarn」用**真子进程**证明（合成树 + corepack 桩：yarn 被打断时
 *     两个 runner 仍必须 EXIT=0，且守卫子进程看不到危险族键）。
 * ======================================================================== */

/**
 * 门禁**执行体入口**的路径（工作树必须与 HEAD 一致的那批文件）—— 见 {@link gitAnchorProblems}。
 * 只列"能改变判据结论"的入口：守卫登记表宿主、解析器包登记宿主、以及解释器/脚本入口文件。
 */
const EXECUTION_ENTRY_PATHS = [
  '.yarnrc.yml',
  '.gitignore',
  'package.json',
  'scripts/check-root-guards.mjs',
  'scripts/check-workspaces.mjs',
  'scripts/check-guard-parser-integrity.mjs',
]

/**
 * 根 `.yarnrc.yml` 的登记（**唯一真源**）。
 *
 * 为什么要它：`.yarnrc.yml` 是"谁能解释 `yarn`、谁能往脚本环境里写东西"的入口配置，
 * 而它此前**没有任何判据读它**（`grep -rn yarnrc scripts/*.mjs` 只命中"改它会跑全量"的前缀表）。
 * 三条判据各有分工：
 *   1. **内容摘要** —— 任何改动都必须显式出现在 diff 里（`--print-digests` 给可粘贴行）；
 *   2. **键集合白名单** —— 新键（尤其 `yarnPath`/`plugins`）必须登记并写明理由；
 *   3. **关键键取值** —— `enableScripts` 必须是 `false`、`nodeLinker` 必须是 `node-modules`
 *      （"存在即通过"是假绿：`enableScripts: true` 会放开依赖的构建脚本）。
 */
const REGISTERED_YARN_CONFIGURATION = {
  path: '.yarnrc.yml',
  sha256: 'f417a262d92a7e584ce9efa48702ad63b617162f4847c02de486d565b1d3a5f9',
  /** 允许出现的**顶级键**（登记制：每条带理由）。出现未登记的键 ⇒ 红。 */
  allowedKeys: [
    ['enableScripts', '依赖的构建脚本开关 —— 必须保持 false（本仓"依赖不在 install 期跑代码"的唯一开关）'],
    ['nmHoistingLimits', 'node-modules 链接器的提升边界（构建拓扑要求）'],
    ['nodeLinker', '必须是 node-modules（Electron 打包与原生模块要求）'],
    ['supportedArchitectures', 'macOS 通用包要求 node_modules 里同时有 x64/arm64 切片'],
    ['cacheFolder', 'yarn 缓存放在仓内（本机/容器里全局缓存只读）'],
    ['enableGlobalCache', '关掉全局缓存（同上）'],
  ],
  /** 关键键的**取值**判据（不只是"存在"）。 */
  requiredScalars: [
    ['enableScripts', 'false', '一旦放开，install 期可执行的东西就从"根 workspace 的 postinstall"扩到全部依赖的构建脚本'],
    ['nodeLinker', 'node-modules', 'Electron 打包与原生模块要求 node-modules 链接器'],
  ],
  /** 禁键（出现即红；确实需要时必须先登记进 `REGISTERED_YARN_ENTRY_ALLOWANCES` 并写明理由）。 */
  forbiddenKeys: [
    ['yarnPath', '换掉整个 yarn 解释器：一行 diff（`yarnPath: ./noop.cjs`）就能让 `yarn install` 与'
      + '全部门禁空转（第十一轮 D 路实测：守卫运行器报 `✓` 而判据一次没跑）'],
    ['plugins', '插件钩子 `wrapScriptExecution` 在 **yarn 进程内部**改写被 spawn 脚本的环境'
      + '（第十一轮 C 路实测：`corepack yarn check` EXIT 1→0、根守卫 3 通过/14 失败 → 17 通过/0 失败）'],
  ],
}

/** 禁键的**豁免登记**（空表 = fail-closed）。每条 `{ key, reason, approvedBy }`：加一条是显式的决定。 */
const REGISTERED_YARN_ENTRY_ALLOWANCES = []

/**
 * `.gitignore` 里把 `.yarn/**` 放回**可提交面**的反向规则（登记制：每条带理由）。
 *
 * 为什么这也算执行体入口：`.gitignore:2` 是 `.yarn/*`（忽略），而 `:4`/`:5` 的
 * `!.yarn/plugins` / `!.yarn/releases` 让插件与发行版**可以入库** —— P0-1 的载荷
 * （`.yarn/plugins/probe.cjs`）正是靠这条进的仓（审计实测 `git check-ignore` 判定它不被忽略）。
 * 这两条当前是 yarn 官方推荐写法（本仓暂时用不到），所以保留 = 登记它们**并**断言
 * 对应目录当前没有落地文件（`YARN_CODE_DIRECTORIES`）。
 */
const REGISTERED_YARN_GITIGNORE_NEGATIONS = [
  ['!.yarn/patches', 'yarn 官方推荐写法：把 Yarn 自带的 patch 协议产物入库（本仓的补丁走仓根 `patches/`，'
    + '`.yarn/patches/` 当前为空；该目录**单独**不能生效 —— 必须同时有 `resolutions` 的 patch 条目，'
    + '那条通道由 `verify-patch-resolutions.mjs` 与本文件的解析器包判据看着）'],
  ['!.yarn/plugins', 'yarn 官方推荐写法：用 `yarn plugin import` 时把插件文件入库（本仓当前无插件；'
    + '**这是 P0-1 的载荷通道**：`.yarnrc.yml` 的 `plugins:` 一旦指到这里，插件钩子就在 yarn 进程内部'
    + '改写每个脚本子进程的环境 ⇒ 本文件同时断言 `.yarn/plugins/` 没有落地文件）'],
  ['!.yarn/releases', 'yarn 官方推荐写法：用 `yarnPath` 时把 yarn 发行版入库（本仓当前无 releases；'
    + '同属"换掉整个 yarn"的载荷通道 ⇒ 同时断言该目录为空）'],
  ['!.yarn/sdks', 'yarn 官方推荐写法：把编辑器 SDK 产物入库（纯编辑器提示，不参与门禁执行；本仓当前为空）'],
  ['!.yarn/versions', 'yarn 官方推荐写法：把 `yarn version` 插件的状态文件入库（纯版本状态；本仓当前为空）'],
]

/**
 * 已登记"可提交"的**代码目录**：**当前必须是空的**（有文件即红）。
 *
 * 只列这两个：yarn 会**只凭 `.yarnrc.yml` 里的引用**就去读它们（`plugins:` → `.yarn/plugins/*.cjs`
 * 被 `require`；`yarnPath:` → `.yarn/releases/<ver>/yarn.js` 被当成 yarn 本体），
 * 不需要任何第二个文件参与 —— 也就是说"放一个文件进去"本身就是完整的载荷。
 * 另外三个（patches/sdks/versions）是**数据 + 需要别处引用才生效**，登记在
 * `REGISTERED_YARN_GITIGNORE_NEGATIONS` 里，不在这里做"必须为空"的硬断言。
 */
const YARN_CODE_DIRECTORIES = ['.yarn/plugins', '.yarn/releases']

/**
 * 根 `package.json` **安装期生命周期钩子**的登记（P1-1 ①）。
 *
 * 空表 = **禁新增**（当前根 `package.json` 没有任何生命周期钩子）。为什么单列一条：
 * `enableScripts: false` 只挡**依赖**的构建脚本 —— 根 workspace 自己的 `postinstall`
 * 照样执行（审计在全新项目里实测：`enableScripts` 两个取值都产出 POSTINSTALL 标记），
 * 而 CI 的 `yarn install --immutable` 排在根守卫**之前** ⇒ install 期是"改写守卫脚本 +
 * 改写内容摘要登记值"的理想窗口（实测内容判据 EXIT 1→0）。
 * 确实需要一条钩子时：在 `REGISTERED_ROOT_LIFECYCLE_HOOKS` 里登记 `{ hook, reason, approvedBy }`
 * 并说明"为什么必须发生在 install 期"（可评审的 diff 是唯一更新通道）。
 */
const REGISTERED_ROOT_LIFECYCLE_HOOKS = []
/** 受登记约束的生命周期钩子名。 */
const ROOT_LIFECYCLE_HOOK_NAMES = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
]

/**
 * 根 `.yarnrc.yml` 的登记判据（纯函数；输入来自调用方读到的字节，便于自检/变异验证）。
 *
 * @param options - `{ text, exists, isSymlink, isFile, expectedSha256, actualSha256 }`。
 * @returns 问题清单（空 = 通过）。
 */
export function yarnConfigurationProblems(options) {
  const problems = []
  if (!options.exists) {
    problems.push(`${REGISTERED_YARN_CONFIGURATION.path} 不存在 —— 本判据的输入缺席（拒绝把"读不到"当成"没有"）`)
    return problems
  }
  if (options.isSymlink) {
    problems.push(`${REGISTERED_YARN_CONFIGURATION.path} 是一个**符号链接** —— 内容来自仓外`
      + '（同族的投放机制：守卫脚本曾被换成同名符号链接），入口配置必须是常规文件')
    return problems
  }
  if (!options.isFile) {
    problems.push(`${REGISTERED_YARN_CONFIGURATION.path} 不是一个常规文件`)
    return problems
  }
  if (options.actualSha256 !== options.expectedSha256) {
    problems.push(`${REGISTERED_YARN_CONFIGURATION.path} 的**内容**与登记值不一致：\n`
      + `      登记 sha256：${options.expectedSha256}\n`
      + `      实际 sha256：${options.actualSha256}`)
  }
  const keys = yarnrcTopLevelKeys(options.text)
  if (keys.length === 0) {
    problems.push(`${REGISTERED_YARN_CONFIGURATION.path} 读不出任何顶级键（解析面失效 ⇒ 拒绝把"读不出"当成"没有"）`)
    return problems
  }
  const allowed = new Set(REGISTERED_YARN_CONFIGURATION.allowedKeys.map(entry => entry[0]))
  const allowances = new Set(REGISTERED_YARN_ENTRY_ALLOWANCES.map(entry => entry.key))
  for (const key of [...new Set(keys)]) {
    if (allowed.has(key) || allowances.has(key)) continue
    const forbidden = REGISTERED_YARN_CONFIGURATION.forbiddenKeys.find(entry => entry[0] === key)
    problems.push(forbidden === undefined
      ? `${REGISTERED_YARN_CONFIGURATION.path} 里有**未登记**的顶级键 \`${key}\``
        + '\n      ⇒ 新键必须登记进 `REGISTERED_YARN_CONFIGURATION.allowedKeys` 并写明它为什么改不了判据结论。'
      : `${REGISTERED_YARN_CONFIGURATION.path} 里有**禁键** \`${key}\`：${forbidden[1]}`
        + '\n      ⇒ 确实需要时**只能**先登记进 `REGISTERED_YARN_ENTRY_ALLOWANCES`（`{ key, reason, approvedBy }`）'
        + '并写清为什么它不会让判据变空；登记值同样进 diff、同样可评审。')
  }
  for (const [key, expected, why] of REGISTERED_YARN_CONFIGURATION.requiredScalars) {
    const actual = yarnrcScalarValue(options.text, key)
    if (actual !== expected) {
      problems.push(`${REGISTERED_YARN_CONFIGURATION.path} 的 \`${key}\` 必须是 \`${expected}\`（实际 ${JSON.stringify(actual)}）`
        + `：${why}`)
    }
  }
  return problems
}

/**
 * 根 `package.json` 生命周期钩子的登记判据（纯函数，P1-1 ①）。
 * @param manifest - 根 `package.json` 解析结果。
 * @returns 问题清单。
 */
export function lifecycleHookProblems(manifest) {
  const registered = new Set(REGISTERED_ROOT_LIFECYCLE_HOOKS.map(entry => entry.hook))
  const hooks = ROOT_LIFECYCLE_HOOK_NAMES.filter(name => typeof manifest?.scripts?.[name] === 'string')
  const problems = []
  for (const hook of hooks) {
    if (registered.has(hook)) continue
    problems.push(`根 package.json 的 \`scripts.${hook}\` 是**安装期生命周期钩子**且没有登记：`
      + `${JSON.stringify(manifest.scripts[hook])}`
      + '\n      ⇒ `enableScripts: false` 只挡依赖的构建脚本，**挡不住根 workspace 自己的 postinstall**；'
      + '而 CI 的 `yarn install --immutable` 排在根守卫之前 —— install 期可以改写守卫脚本'
      + '并顺手改掉内容摘要登记值（第十一轮 P1-1 实测：内容判据 EXIT 1→0）。'
      + '\n      ⇒ 确实需要时登记进 `REGISTERED_ROOT_LIFECYCLE_HOOKS`（`{ hook, reason, approvedBy }`），'
      + '并写清"为什么必须发生在 install 期"。')
  }
  const stale = REGISTERED_ROOT_LIFECYCLE_HOOKS
    .map(entry => entry.hook)
    .filter(hook => !hooks.includes(hook))
  for (const hook of stale) {
    problems.push(`登记表里的生命周期钩子 \`${hook}\` 在根 package.json 里并不存在 ——`
      + '陈旧登记必须清掉（留下它等于给下一个人一个"已经批过"的钩子名）')
  }
  return problems
}

/**
 * `.gitignore` 的 `.yarn` 反向规则登记判据（纯函数）。
 * @param text - `.gitignore` 正文。
 * @returns 问题清单。
 */
export function yarnGitignoreNegationProblems(text) {
  const registered = new Set(REGISTERED_YARN_GITIGNORE_NEGATIONS.map(entry => entry[0]))
  const problems = []
  const lines = String(text).split('\n').map(line => line.trim())
  for (const line of lines) {
    if (!/^![^\s]/u.test(line)) continue
    if (!/^!\.yarn\//u.test(line)) continue
    if (registered.has(line)) continue
    problems.push(`.gitignore 里有**未登记**的 .yarn 反向规则 \`${line}\` ——`
      + '它把 `.yarn/**` 的某一部分放回**可提交面**（P0-1 的载荷 `.yarn/plugins/probe.cjs`'
      + '正是靠 `!.yarn/plugins` 进的仓）⇒ 需要时登记进 `REGISTERED_YARN_GITIGNORE_NEGATIONS` 并写明理由')
  }
  return problems
}

/**
 * `.yarn/**` 里"可提交 + 会被 yarn 当代码读"的目录**必须是空的**（纯函数）。
 * @param entries - `[{ directory, files: [相对路径] }]`。
 * @returns 问题清单。
 */
export function yarnCodeDirectoryProblems(entries) {
  const problems = []
  for (const entry of entries) {
    if (entry.files.length === 0) continue
    problems.push(`${entry.directory}/ 下有 ${entry.files.length} 个文件：${entry.files.slice(0, 3).join('、')}`
      + `${entry.files.length > 3 ? ' …' : ''}`
      + '\n      ⇒ 这是"可提交 + 会被 yarn 当代码读"的目录（`.gitignore` 的 `!.yarn/plugins` 放行了它）：'
      + 'P0-1 的插件载荷就放在这里。当前登记为"空"（需要放文件时先登记并写明理由）。')
  }
  return problems
}

/**
 * 摘要判据的 **git 锚**（P1-1 ②）：工作树必须与 `HEAD` 逐字节一致。
 *
 * ## 为什么必须有（现场）
 *
 * 内容摘要判据（本文件上面那一段）读的是**工作树**：`scripts/check-root-guards.mjs` 的
 * `REGISTERED_GUARD_ENTRIES[*].digest` ↔ 磁盘上守卫脚本的 sha256。P1-1 的现场是
 * `postinstall` 在 install 期把守卫脚本掏空（`process.exit(0)`）**并顺手把登记值改成新摘要** ——
 * 于是"工作树 vs 登记值"自洽，判据从 EXIT=1 翻回 EXIT=0，而 diff 里只有 `package.json` 一行
 * 加一个新脚本。工作树可以在 install 期被改写，**HEAD 对象不能**（改写 `.git` 是另一个量级的动作）：
 *   · 攻击态：登记值 = 掏空后的内容，`HEAD:scripts/x.mjs` = 原始内容 ⇒ 不一致 ⇒ 红；
 *   · 正当改动（同一 PR 里改守卫 + 更新登记值 + 提交）：工作树 == HEAD ⇒ 绿。
 *
 * ## 取向与代价（二选一里选了第二条的**严格版**，理由与代价都写在这里）
 *
 * 取向 (i)"登记值 = `git show HEAD:<path>` 的摘要"：判据一旦通过，就与工作树无关 ——
 *   代价是本地**未提交**的守卫改动会让"内容判据"整段失效（登记值按 HEAD 算，跑的是工作树）。
 * 取向 (ii)"**同时**校验工作树与 HEAD 一致"（本实现）：两侧都对才绿。
 *   ⇒ **本仓的共享工作树长期有并发未提交改动**（第十一轮就有多条泳道同时在改 `scripts/**`），
 *   若本地也硬判，等于要求"改守卫必须先提交"，整条门禁会变成假红机器（代价更大）。
 *   ⇒ 所以严格面放在 **CI**（`GITHUB_ACTIONS`/`CI`）：那正是 P1-1 攻击发生的场景
 *   （`yarn install --immutable` → 根守卫），而 CI 的检出树在门禁启动时**本就**应等于 HEAD。
 *   本地降级为**显式告警**（打印"未验证"，并进 `yarn check` 的 `[DEGRADED]` 汇总 —— 不静默）。
 * **认账的代价**：本地脏树上这条判据只告警不拦 —— 它与攻击态在本判据的输入面上不可区分
 *   （两者都是"工作树 ≠ HEAD 且登记值与工作树一致"），区分只能靠人（评审时的 diff）。
 *
 * @param options - `{ paths, readWorktree, readHead, strict, gitAvailable }`。
 *   `readHead(path)` 返回 `Buffer`；文件不在 HEAD 里（新文件）返回 `null`。
 * @returns `{ failures, advisories }`。
 */
export function gitAnchorProblems(options) {
  const diverged = []
  const unanchored = []
  for (const path of options.paths) {
    if (!options.gitAvailable) {
      unanchored.push(path)
      continue
    }
    const head = options.readHead(path)
    if (head === null) {
      unanchored.push(path)
      continue
    }
    const worktree = options.readWorktree(path)
    if (worktree === null) {
      diverged.push(`${path}（工作树里不存在，但 HEAD 里有）`)
      continue
    }
    if (!head.equals(worktree)) diverged.push(path)
  }
  const failures = []
  const advisories = []
  if (!options.gitAvailable) {
    const message = '读不到 git 元数据（不在仓库里 / 没有 .git）⇒ "install 期改写"这条判据**未验证**'
    if (options.strict) failures.push(`${message}（CI 上必须能锚定 HEAD：把 .git 检出来，或显式登记一条例外）`)
    else advisories.push(message)
    return { failures, advisories }
  }
  if (unanchored.length > 0) {
    const message = `这些"执行体入口"不在 HEAD 里（未提交的新文件）⇒ git 锚定**未验证**：${unanchored.join('、')}`
    if (options.strict) {
      failures.push(`${message}\n      ⇒ CI 上出现这个形态只有两种可能：文件在检出后才被创建（install 期写入！），`
        + '或者登记表指向了一个没进版本库的路径。两种都不许静默通过。')
    } else advisories.push(message)
  }
  if (diverged.length > 0) {
    const detail = `工作树与 HEAD 不一致（${diverged.length} 条）：${diverged.join('、')}`
      + '\n      ⇒ 这正是 P1-1 的形态：`yarn install` 期（或前序步骤）改写了**判据执行体**，'
      + '而"工作树 vs 登记值"自洽 ⇒ 只有 HEAD 能看出这件事。'
    if (options.strict) failures.push(detail)
    else advisories.push(`${detail}\n      ⇒ 本地脏树（正在编辑）与攻击态在本判据的输入面上不可区分，`
      + '所以本地只告警；**CI 上是硬判据**（检出树应当等于 HEAD）。')
  }
  return { failures, advisories }
}

/* ---------------------------------------------------------------------------
 * 「两处都清洗 + 守卫不经 yarn」的**运行级**判据（R11-I1 P1-2 / P0-1 ①）。
 *
 * 为什么必须是运行级：第十轮给两个 runner 中的一个（`check-root-guards.mjs`）加了清洗，
 * 另一个（`check-workspaces.mjs` = `yarn check` 路径）没有 —— 同一条
 * `NODE_OPTIONS=--import=<退出钩子>` 在 `yarn check` 上仍然 EXIT 1→0（审计实测）。
 * 这种"同族路径只收口了一条"的缺陷，用源码级字符串断言抓不稳（把接线删掉、
 * 注释留着，字符串判据照样绿）。这里造一棵**合成守卫树**（真实 runner 实现 +
 * 合成登记表 + 一个会自证的探针守卫 + 一个"被调用就失败"的 corepack 桩），
 * 用**真子进程**证明四件事：
 *   ① 守卫子进程看不到危险族键（`BASH_ENV`）——清洗真的咬到了；
 *   ② 探针看得到普通键（marker）——证明不是"整份环境被清空"这种反向破坏；
 *   ③ 两个 runner 都 **EXIT=0**，而 yarn 在探针树里被 stub 成**必失败**
 *      ⇒ 守卫确实没经 yarn 起（回退到 `corepack yarn run` 的实现在这里必红）；
 *   ④ runner 自己的环境被污染时必须**拒绝运行**（退出码不可被 `--import` 钩子改写）。
 * ------------------------------------------------------------------------- */

/** 探针守卫名（只存在于合成树里）。 */
const SPAWN_WIRING_PROBE_GUARD = 'check:r11-env-probe'
/** 探针守卫用来证明"环境确实传下来了"的普通键（不在任何危险族里 ⇒ 必须被保留）。 */
const SPAWN_WIRING_MARKER_KEY = 'R11_GUARD_ENV_PROBE_MARKER'
/** `selfTestGuardSpawnWiring()` 至少执行的断言条数（5 条：两个 runner + 污染拒绝 + 回落前置判据 + 探针自证）。 */
const SELFTEST_SPAWN_WIRING_ASSERTIONS = 5

/**
 * 探针守卫的源码（写进合成树）。它自证三件事并**用不可改写的退出码**报错：
 * 危险族键缺席（`BASH_ENV`/`NODE_OPTIONS`）、marker 在场（环境确实传下来了）。
 */
const SPAWN_WIRING_PROBE_SOURCE = [
  "import { writeFileSync, writeSync } from 'node:fs'",
  'const facts = {',
  `  marker: process.env.${SPAWN_WIRING_MARKER_KEY} ?? null,`,
  '  bashEnv: process.env.BASH_ENV ?? null,',
  '  nodeOptions: process.env.NODE_OPTIONS ?? null,',
  '  outPath: process.env.R11_GUARD_ENV_PROBE_OUT ?? null,',
  '}',
  // 留痕：守卫**通过**时 runner 不打印子进程输出 ⇒ 事实必须落到文件里，
  // 否则"两个 runner 都跑到了守卫、且环境是干净的"这件事无法被证明（判据会退化成尾窗字符串）。
  "if (facts.outPath !== null) writeFileSync(facts.outPath, JSON.stringify(facts) + '\\n')",
  `const clean = facts.marker === 'yes' && facts.bashEnv === null && facts.nodeOptions === null`,
  "writeSync(1, 'R11-GUARD-ENV-PROBE ' + JSON.stringify(facts) + (clean ? ' CLEAN' : ' DIRTY') + '\\n')",
  'if (!clean) {',
  '  process.removeAllListeners("exit")',
  '  process.removeAllListeners("beforeExit")',
  '  process.reallyExit(1)',
  '}',
  '',
].join('\n')

/** 从运行器源码里解析 `MINIMUM_REQUIRED_GUARDS`（合成树必须把它们都放进登记表，否则运行器 exit 2）。 */
function parseMinimumRequiredGuards(source) {
  const block = /const MINIMUM_REQUIRED_GUARDS = \[([\s\S]*?)\]/u.exec(source)?.[1]
  if (block === undefined) return null
  return [...block.matchAll(/'([^']+)'/gu)].map(match => match[1])
}

/** 把运行器副本的 `REGISTERED_GUARD_ENTRIES` 换成合成登记（名字 / 脚本体 / 占位摘要）。 */
function patchProbeRunnerRegistry(source, names) {
  const block = /const REGISTERED_GUARD_ENTRIES = new Map\(\[[\s\S]*?\n\]\)/u.exec(source)
  if (block === null) throw new Error('找不到 REGISTERED_GUARD_ENTRIES 表')
  const entries = names.map(name =>
    `  ['${name}', { script: 'node scripts/${name.replace(/[:]/gu, '-')}.mjs', argvTail: [], digest: '${'a'.repeat(64)}' }],`)
  return source.replace(block[0], ['const REGISTERED_GUARD_ENTRIES = new Map([', ...entries, '])'].join('\n'))
}

/** 把编排器副本的 `GUARDS` / `ADVISORY_REGISTRY` 两张表换成合成表（其余字节一律不动）。 */
function patchProbeOrchestratorTables(source, names) {
  const guardsBlock = /const GUARDS = \[[\s\S]*?\n\]/u.exec(source)
  if (guardsBlock === null) throw new Error('找不到 GUARDS 表')
  const synthetic = ['const GUARDS = [', ...names.map(name => `  { name: '${name}', args: ['run', '${name}'] },`), ']'].join('\n')
  let out = source.replace(guardsBlock[0], synthetic)
  // 空表形态必须先认（`const ADVISORY_REGISTRY = []` 同行收尾）：直接拿 /\[[\s\S]*?\n\]/ 去匹配它，
  // 会一路吃到**下一个**以 `]` 开头的行（实测把 `validateAdvisoryRegistry` 整个函数吞掉，
  // 合成树里的编排器于是 ReferenceError —— 探针树的"接线判据"必须对真实源码形态稳健）。
  if (/const ADVISORY_REGISTRY = \[\]\s*$/mu.test(out)) return out
  const advisoryBlock = /const ADVISORY_REGISTRY = \[[\s\S]*?\n\]/u.exec(out)
  if (advisoryBlock === null) throw new Error('找不到 ADVISORY_REGISTRY 表')
  out = out.replace(advisoryBlock[0], 'const ADVISORY_REGISTRY = []')
  return out
}

/** 在合成树里跑 git（固定身份/签名，避免受调用者配置影响）。 */
function probeGit(cwd, ...args) {
  return spawnSync('git', [
    '-c', 'user.email=probe@example.com',
    '-c', 'user.name=probe',
    '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main',
    ...args,
  ], { cwd, encoding: 'utf8' })
}

/**
 * 造一棵**合成守卫树**：真 `check-root-guards.mjs` / 真 `check-workspaces.mjs`（只换两张表）
 * + 合成守卫脚本 + corepack 桩（**被调用就退出 1**）+ 一个初始提交的 git 仓库。
 * @returns `{ tree, names }`。
 */
export function buildGuardSpawnWiringProbe() {
  const tree = mkdtempSync(join(tmpdir(), 'r11-guard-wiring-'))
  mkdirSync(join(tree, 'scripts'))
  mkdirSync(join(tree, 'bin'))
  const runnerSource = readFileSync(GUARD_RUNNER, 'utf8')
  const orchestratorSource = readFileSync(join(ROOT, 'scripts', 'check-workspaces.mjs'), 'utf8')
  const minimum = parseMinimumRequiredGuards(runnerSource)
  if (!Array.isArray(minimum) || minimum.length === 0) {
    throw new Error('从 check-root-guards.mjs 里读不出 MINIMUM_REQUIRED_GUARDS —— 本判据的锚点失效')
  }
  const names = [...minimum, SPAWN_WIRING_PROBE_GUARD]
  const scriptOf = name => `scripts/${name.replace(/[:]/gu, '-')}.mjs`
  for (const name of names) {
    writeFileSync(join(tree, scriptOf(name)),
      name === SPAWN_WIRING_PROBE_GUARD ? SPAWN_WIRING_PROBE_SOURCE : 'process.exit(0)\n')
  }
  writeFileSync(join(tree, 'scripts', 'check-root-guards.mjs'), patchProbeRunnerRegistry(runnerSource, names))
  writeFileSync(join(tree, 'scripts', 'check-workspaces.mjs'), patchProbeOrchestratorTables(orchestratorSource, names))
  writeFileSync(join(tree, 'package.json'), `${JSON.stringify({
    name: 'r11-guard-wiring-probe',
    private: true,
    scripts: Object.fromEntries(names.map(name => [name, `node ${scriptOf(name)}`])),
  }, null, 2)}\n`)
  // corepack 桩：被调用就失败（探针树里 yarn **不该**被用到 —— 这正是不经 yarn 的判据）。
  const stub = join(tree, 'bin', 'corepack')
  writeFileSync(stub, '#!/bin/sh\nprintf "R11-WIRING-PROBE-COREPACK-CALLED %s\\n" "$*" >&2\nexit 1\n')
  chmodSync(stub, 0o755)
  const init = probeGit(tree, 'init', '-q')
  if (init.status !== 0) throw new Error(`合成树 git init 失败：${init.stderr}`)
  const add = probeGit(tree, 'add', '-A')
  if (add.status !== 0) throw new Error(`合成树 git add 失败：${add.stderr}`)
  const commit = probeGit(tree, 'commit', '-q', '-m', 'init')
  if (commit.status !== 0) throw new Error(`合成树 git commit 失败：${commit.stderr}`)
  return { tree, names }
}

/**
 * 运行级判据：两个 runner 的守卫 spawn 通道都必须"清洗 + 不经 yarn"。
 *
 * @returns `{ failures, assertions }`。
 */
export function selfTestGuardSpawnWiring() {
  const failures = []
  let assertions = 0
  let tree = null
  try {
    const probe = buildGuardSpawnWiringProbe()
    tree = probe.tree
    const env = {
      ...process.env,
      FORCE_COLOR: '0',
      PATH: `${join(tree, 'bin')}:${process.env.PATH ?? ''}`,
      [SPAWN_WIRING_MARKER_KEY]: 'yes',
      // 危险族键：清洗必须把它丢掉（探针自己会断言这一点并**不可改写地**退 1）。
      BASH_ENV: '/nonexistent-r11-wiring-hook.sh',
    }
    const runnerTrace = join(tree, 'probe-runner.json')
    const orchestratorTrace = join(tree, 'probe-orchestrator.json')
    // ① 运行器（docs-only PR 的唯一防线）
    const runner = spawnSync(process.execPath, [join(tree, 'scripts', 'check-root-guards.mjs'), '--concurrency', '1'], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...env, R11_GUARD_ENV_PROBE_OUT: runnerTrace },
    })
    assertions += 1
    if (runner.status !== 0) {
      failures.push(`[spawn-wiring] \`check-root-guards.mjs\` 在合成树上必须 EXIT=0（守卫直接 spawn + 环境清洗），`
        + `实际 ${runner.status}：${JSON.stringify(`${runner.stdout ?? ''}${runner.stderr ?? ''}`.slice(-500))}`)
    }
    // ② 编排器（`yarn check` 路径）——用 `--changed HEAD` 只跑根守卫（合成树里没有包）
    const orchestrator = spawnSync(process.execPath, [join(tree, 'scripts', 'check-workspaces.mjs'), '--changed', 'HEAD'], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...env, R11_GUARD_ENV_PROBE_OUT: orchestratorTrace },
    })
    assertions += 1
    if (orchestrator.status !== 0) {
      failures.push(`[spawn-wiring] \`check-workspaces.mjs\`（\`yarn check\` 路径）在合成树上必须 EXIT=0，`
        + `实际 ${orchestrator.status}：${JSON.stringify(`${orchestrator.stdout ?? ''}${orchestrator.stderr ?? ''}`.slice(-500))}`)
    }
    // ③ 反向：runner 自己的环境被污染（`--import` 退出钩子）时**必须拒绝运行**。
    //    钩子写成一个真文件（data: URL 里的引号在 URL 解析后会被吃掉 —— 实测踩过）。
    const exitHook = join(tree, 'r11-exit-hook.mjs')
    writeFileSync(exitHook, 'process.on("exit", () => { process.exitCode = 0 })\n')
    //    判据：退出码非 0（钩子能把 `process.exit(1)` 改写成 0 ⇒ 实现必须走 reallyExit/信号）。
    const contaminated = spawnSync(process.execPath, [join(tree, 'scripts', 'check-root-guards.mjs'), '--list'], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...env, NODE_OPTIONS: `--import=${exitHook}` },
    })
    assertions += 1
    const contaminatedOutput = `${contaminated.stdout ?? ''}${contaminated.stderr ?? ''}`
    if (contaminated.status === 0 || !contaminatedOutput.includes('拒绝运行')) {
      failures.push('[spawn-wiring] runner 自己的环境里有 `NODE_OPTIONS=--import=<退出钩子>` 时必须'
        + `**拒绝运行**并给出理由，实际 EXIT=${contaminated.status}：${JSON.stringify(contaminatedOutput.slice(-300))}`)
    }
    // ⑤ 回落的**前置判据**（P0-1 的窄回落）：登记脚本文件不存在 + `.yarnrc.yml` 有 `plugins:`
    //    ⇒ 必须**拒绝**回落到 `corepack yarn run` —— 否则"删掉守卫脚本 + 装插件"就能把守卫
    //    换成恒绿的空壳（注入的退出钩子会把 `MODULE_NOT_FOUND` 的退出码改写成 0）。
    rmSync(join(tree, 'scripts', `${SPAWN_WIRING_PROBE_GUARD.replace(/[:]/gu, '-')}.mjs`), { force: true })
    writeFileSync(join(tree, '.yarnrc.yml'), 'plugins:\n  - path: .yarn/plugins/probe.cjs\n    spec: probe-plugin\n')
    const fallback = spawnSync(process.execPath, [join(tree, 'scripts', 'check-root-guards.mjs'), '--concurrency', '1'], {
      cwd: tree,
      encoding: 'utf8',
      env,
    })
    assertions += 1
    const fallbackOutput = `${fallback.stdout ?? ''}${fallback.stderr ?? ''}`
    if (fallback.status === 0 || !/拒绝回落/u.test(fallbackOutput)) {
      failures.push('[spawn-wiring] 登记脚本文件不存在 **且** `.yarnrc.yml` 里有 `plugins:` 时，'
        + '守卫必须**拒绝回落到 `corepack yarn run`** 并判失败（EXIT≠0），'
        + `实际 EXIT=${fallback.status}：${JSON.stringify(fallbackOutput.slice(-400))}`)
    }
    // ④ 探针留痕：两个 runner 都真的把守卫跑起来了，**且**守卫看到的环境是干净的。
    //    （守卫通过时 runner 不打印子进程输出 ⇒ 只断言"输出里有 marker"会退化成字符串判据。）
    assertions += 1
    for (const [label, trace] of [['check-root-guards.mjs', runnerTrace], ['check-workspaces.mjs', orchestratorTrace]]) {
      let facts = null
      try {
        facts = JSON.parse(readFileSync(trace, 'utf8'))
      } catch {
        facts = null
      }
      if (facts === null) {
        failures.push(`[spawn-wiring] ${label} 这一路没有留下探针留痕（${trace}）⇒ "守卫真的跑了"没有被证明`)
        continue
      }
      if (facts.marker !== 'yes' || facts.bashEnv !== null || facts.nodeOptions !== null) {
        failures.push(`[spawn-wiring] ${label} 这一路的守卫子进程环境不对：${JSON.stringify(facts)}`
          + '（marker 必须在场 —— 证明环境确实传下来了；`BASH_ENV`/`NODE_OPTIONS` 必须缺席 —— 证明清洗咬到了）')
      }
    }
  } catch (error) {
    failures.push(`[spawn-wiring] 无法开展（合成树构建/运行失败：${error?.message ?? String(error)}）`)
  } finally {
    if (tree !== null) {
      try {
        rmSync(tree, { recursive: true, force: true })
      } catch {
        // 清理失败不影响结论
      }
    }
  }
  return { failures, assertions }
}

/**
 * 判据主流程。
 * @param argv - 命令行参数（去掉 `node` 与脚本名）。
 * @returns 退出码。
 */
function main(argv) {
  const printDigests = argv.includes('--print-digests')
  const unknown = argv.filter(argument => argument !== '--print-digests')
  if (unknown.length > 0) {
    console.error(`check-guard-parser-integrity: 未知参数 ${unknown.join(' ')}`)
    return 2
  }

  let runnerSource
  try {
    runnerSource = readFileSync(GUARD_RUNNER, 'utf8')
  } catch (error) {
    console.error(`check-guard-parser-integrity: 读不到 ${GUARD_RUNNER}：${error.message}`)
    return 2
  }
  const parsed = parseGuardEntries(runnerSource)
  if (parsed.error !== undefined) {
    console.error(`check-guard-parser-integrity: ${parsed.error}`)
    console.error('  ⇒ 拒绝在"读不出登记表"的情况下继续：那会让守卫脚本的内容判据静默消失'
      + '（第十轮审计 C-06：内容被掏空/被换成符号链接时运行器照报 `✓`）。')
    return 2
  }

  const failures = []
  const actual = []
  for (const entry of parsed.entries) {
    const { path, problem } = guardScriptPath(entry.script)
    if (problem !== null) {
      failures.push(`登记的脚本命令不合法（${entry.name}）：${problem}`)
      continue
    }
    if (!existsSync(path)) {
      failures.push(`守卫 ${entry.name} 的脚本不存在：${relative(ROOT, path)}`)
      continue
    }
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      let linkTarget
      try {
        linkTarget = readlinkSync(path)
      } catch {
        linkTarget = '（读不到链接目标）'
      }
      failures.push(`守卫 ${entry.name} 的脚本是一个**符号链接**：${relative(ROOT, path)} → ${linkTarget}`
        + '\n      ⇒ 审计实测：把守卫脚本换成同名符号链接指向另一个"能通过"的守卫，运行器照报 `✓`'
        + '（名字/argv/形态三者全对）。守卫脚本必须是常规文件。')
      continue
    }
    if (!stats.isFile()) {
      failures.push(`守卫 ${entry.name} 的脚本不是一个常规文件：${relative(ROOT, path)}`)
      continue
    }
    const digest = sha256(readFileSync(path))
    actual.push({ name: entry.name, script: entry.script, argvTail: entry.argvTail ?? argvTailLiteral(runnerSource, entry.name), digest })
    if (entry.digest !== digest) {
      failures.push(`守卫 ${entry.name} 的脚本**内容**与登记值不一致：\n`
        + `      脚本：${relative(ROOT, path)}\n`
        + `      登记 sha256：${entry.digest}\n`
        + `      实际 sha256：${digest}`)
    }
  }

  const packageFailures = []
  for (const registration of REGISTERED_GATE_PARSER_PACKAGES) {
    const resolved = resolvePackageDirectory(registration.name)
    if (resolved.directory === null) {
      packageFailures.push(`解析器包 ${registration.name} 找不到（${resolved.notes.join('；')}）`
        + ' ⇒ 判据的输入缺席：门禁依赖它的那几条守卫要么起不来，要么加载的是别处的副本。')
      continue
    }
    const manifestPath = join(resolved.directory, 'package.json')
    if (!existsSync(manifestPath)) {
      packageFailures.push(`解析器包 ${registration.name} 的目录里没有 package.json：${relative(ROOT, resolved.directory)}`)
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest?.name !== registration.name) {
      packageFailures.push(`解析到 ${relative(ROOT, resolved.directory)}，但它的 package.json 里 name = `
        + `${JSON.stringify(manifest?.name ?? null)}（登记的是 ${JSON.stringify(registration.name)}）`)
      continue
    }
    const tree = packageTreeDigest(resolved.directory)
    if (manifest.version !== registration.version) {
      packageFailures.push(`解析器包 ${registration.name} 的版本从 ${registration.version} 变成了 `
        + `${JSON.stringify(manifest.version ?? null)}（yarn.lock 升级？）`)
    }
    if (tree.sha256 !== registration.sha256 || tree.files !== registration.files) {
      packageFailures.push(`解析器包 ${registration.name}（${relative(ROOT, resolved.directory)}，${resolved.source}）的**文件集**与登记值不一致：\n`
        + `      登记：sha256=${registration.sha256} files=${registration.files}\n`
        + `      实际：sha256=${tree.sha256} files=${tree.files}\n`
        + '      为什么这是 P0 级：`check-workflows` / `verify-ci-scripts` / `verify-inventories` 三条根守卫'
        + '都用它解析输入 —— 换掉它就能让三条判据同时失明，而门禁照报 `✓`'
        + '（第十轮审计 C-17 实测：只改 `dist/public-api.js` 一处，三条判据全部 EXIT=0）。')
    }
  }
  // 同族的**投放机制**判据：`resolutions` 里的 `patch:` 是"在仓内改依赖内容"的正式通道。
  // 门禁自己的解析器绝不能出现在那里 —— 否则"文件集摘要"会在**每次 install 时**被合法地改掉。
  try {
    const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const patchedParsers = Object.keys(rootManifest?.resolutions ?? {})
      .filter(key => REGISTERED_GATE_PARSER_PACKAGES.some(entry => key === entry.name || key.startsWith(`${entry.name}@`)))
    if (patchedParsers.length > 0) {
      packageFailures.push(`根 package.json 的 \`resolutions\` 里有门禁解析器的 patch 条目：${patchedParsers.join('、')}`
        + '\n      ⇒ 这是"在仓内改依赖内容"的正式通道（本仓已有 10 条 `patch:` 条目）。'
        + '\n      ⇒ 门禁自己的解析器必须保持 pristine：要么去掉该 patch，要么把这条判据的登记面'
        + '改成"patch 后的期望内容"并写清理由（但那时判据的可信根就变成了同一个可被改的文件）。')
    }
  } catch (error) {
    packageFailures.push(`读根 package.json 失败：${error?.message ?? String(error)}`)
  }

  // ===========================================================================
  // R11-I1 ①（P0-1 ② / P1-1 ①）：**执行体入口**的登记制 + 摘要判据的 git 锚。
  //
  // 这一层是本文件原有两条（C-17 解析器包 / C-06 守卫脚本内容）的**下一层**：
  // 谁把判据自己读到、执行的东西跑起来。详见上面「执行体入口的三条收口」段。
  // ===========================================================================
  const executionFailures = []
  {
    // ① `.yarnrc.yml`（解释器入口）：内容摘要 + 键集合白名单 + 关键键取值。
    const rcPath = join(ROOT, REGISTERED_YARN_CONFIGURATION.path)
    const rcExists = existsSync(rcPath)
    let rcText = ''
    let rcIsSymlink = false
    let rcIsFile = false
    let rcSha256 = null
    if (rcExists) {
      const stats = lstatSync(rcPath)
      rcIsSymlink = stats.isSymbolicLink()
      rcIsFile = stats.isFile()
      if (rcIsFile) {
        const bytes = readFileSync(rcPath)
        rcText = bytes.toString('utf8')
        rcSha256 = sha256(bytes)
      }
    }
    executionFailures.push(...yarnConfigurationProblems({
      exists: rcExists,
      text: rcText,
      isSymlink: rcIsSymlink,
      isFile: rcIsFile,
      expectedSha256: REGISTERED_YARN_CONFIGURATION.sha256,
      actualSha256: rcSha256,
    }))
    // ② `.yarn/plugins/**` / `.yarn/releases/**` 必须是空的（`.gitignore` 已把它们登记为"可提交"）。
    const codeDirectories = YARN_CODE_DIRECTORIES.map(relativeDirectory => {
      const directory = join(ROOT, relativeDirectory)
      const files = []
      if (existsSync(directory)) {
        const walk = current => {
          for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name)
            if (entry.isDirectory()) walk(path)
            else files.push(relative(ROOT, path))
          }
        }
        walk(directory)
      }
      return { directory: relativeDirectory, files }
    })
    executionFailures.push(...yarnCodeDirectoryProblems(codeDirectories))
    // ③ `.gitignore` 的 `.yarn` 反向规则（P0-1 的载荷正是靠 `!.yarn/plugins` 进的仓）。
    executionFailures.push(...yarnGitignoreNegationProblems(readFileSync(join(ROOT, '.gitignore'), 'utf8')))
    // ④ 根 `package.json` 的生命周期钩子（`enableScripts: false` 挡不住根 workspace 自己的 postinstall）。
    executionFailures.push(...lifecycleHookProblems(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))))
    // ⑤ 摘要判据的 **git 锚**（P1-1 ②）：工作树必须与 HEAD 逐字节一致。
    //    严格面在 CI（`GITHUB_ACTIONS`/`CI`）；本地脏树只告警（理由与代价见 gitAnchorProblems 的注释）。
    const strictAnchor = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true'
    const readHead = path => {
      const result = spawnSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      return result.status === 0 ? result.stdout : null
    }
    const gitAvailable = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).status === 0
    const readWorktree = path => {
      const absolute = join(ROOT, path)
      return existsSync(absolute) && lstatSync(absolute).isFile() ? readFileSync(absolute) : null
    }
    const anchorPaths = [
      ...new Set([
        ...EXECUTION_ENTRY_PATHS,
        ...parsed.entries.map(entry => /^(?:node|bash)\s+(scripts\/\S+)$/u.exec(entry.script)?.[1]).filter(Boolean),
      ]),
    ]
    const anchor = gitAnchorProblems({ paths: anchorPaths, readHead, readWorktree, strict: strictAnchor, gitAvailable })
    executionFailures.push(...anchor.failures)
    for (const advisory of anchor.advisories) {
      console.log(`check-guard-parser-integrity: WARNING — ${advisory}`)
    }
    // ⑥ 同一批禁键 / 钩子名的**两份实现必须一致**（运行器侧的"经 yarn 可信吗"前置检查 ↔
    //    本判据的登记制）。两侧各自枚举时一旦漂移，就会出现"回落被拦、登记制放行"的裂缝。
    const forbiddenInRunner = [...YARN_ENTRY_FORBIDDEN_KEYS].sort().join(',')
    const forbiddenHere = REGISTERED_YARN_CONFIGURATION.forbiddenKeys.map(entry => entry[0]).sort().join(',')
    if (forbiddenInRunner !== forbiddenHere) {
      executionFailures.push(`禁键清单在两侧漂移：check-root-guards.mjs 的 \`YARN_ENTRY_FORBIDDEN_KEYS\` = `
        + `${JSON.stringify(forbiddenInRunner)} / 本文件 \`REGISTERED_YARN_CONFIGURATION.forbiddenKeys\` = `
        + `${JSON.stringify(forbiddenHere)} ⇒ 两份判定必须同源（一侧拦住回落、另一侧却登记放行 = 裂缝）`)
    }
    const hooksInRunner = [...YARN_LIFECYCLE_HOOKS].sort().join(',')
    const hooksHere = [...ROOT_LIFECYCLE_HOOK_NAMES].sort().join(',')
    if (hooksInRunner !== hooksHere) {
      executionFailures.push(`生命周期钩子清单在两侧漂移：check-root-guards.mjs 的 \`YARN_LIFECYCLE_HOOKS\` = `
        + `${JSON.stringify(hooksInRunner)} / 本文件的 \`ROOT_LIFECYCLE_HOOK_NAMES\` = ${JSON.stringify(hooksHere)}`)
    }
  }

  // ===========================================================================
  // R11-I1 ②（P0-1 ① / P1-2）：**运行级**判据 —— 两个 runner 的守卫 spawn 通道都必须是
  // 「直接 spawn（不经 yarn）+ 环境清洗」。用真子进程 + 合成树 + 必失败的 corepack 桩证明；
  // `--print-digests` 是维护通道，跳过（它不该跑任何判据）。
  // ===========================================================================
  if (!printDigests) {
    const wiring = selfTestGuardSpawnWiring()
    if (!Array.isArray(wiring?.failures) || typeof wiring?.assertions !== 'number') {
      executionFailures.push('[spawn-wiring] selfTestGuardSpawnWiring() 的返回形状不对（需要 {failures, assertions}）')
    } else {
      if (wiring.assertions < SELFTEST_SPAWN_WIRING_ASSERTIONS) {
        executionFailures.push(`[spawn-wiring] 运行级判据只执行了 ${wiring.assertions} 条断言`
          + `（期望 ≥ ${SELFTEST_SPAWN_WIRING_ASSERTIONS}）⇒ 判据被掏空`)
      }
      executionFailures.push(...wiring.failures)
    }
  }

  if (printDigests) {
    process.stdout.write('# 守卫脚本内容摘要（粘回 scripts/check-root-guards.mjs 的 REGISTERED_GUARD_ENTRIES）\n')
    for (const entry of actual) process.stdout.write(`${pasteLine(entry)}\n`)
    process.stdout.write('\n# 解析器包文件集摘要（粘回本文件的 REGISTERED_GATE_PARSER_PACKAGES）\n')
    for (const registration of REGISTERED_GATE_PARSER_PACKAGES) {
      const resolved = resolvePackageDirectory(registration.name)
      if (resolved.directory === null) continue
      const tree = packageTreeDigest(resolved.directory)
      const manifest = JSON.parse(readFileSync(join(resolved.directory, 'package.json'), 'utf8'))
      process.stdout.write(`  { name: '${registration.name}', version: '${manifest.version}', files: ${tree.files}, sha256: '${tree.sha256}' },\n`)
    }
    process.stdout.write('\n# 执行体入口摘要（粘回本文件的 REGISTERED_YARN_CONFIGURATION）\n')
    process.stdout.write(`  path: '${REGISTERED_YARN_CONFIGURATION.path}', sha256: '${sha256(readFileSync(join(ROOT, REGISTERED_YARN_CONFIGURATION.path)))}',\n`)
    return 0
  }

  if (failures.length > 0 || packageFailures.length > 0 || executionFailures.length > 0) {
    for (const detail of failures) {
      process.stderr.write(`\ncheck-guard-parser-integrity: ${detail}\n`)
    }
    for (const detail of packageFailures) {
      process.stderr.write(`\ncheck-guard-parser-integrity: ${detail}\n`)
    }
    for (const detail of executionFailures) {
      process.stderr.write(`\ncheck-guard-parser-integrity: ${detail}\n`)
    }
    process.stderr.write('\ncheck-guard-parser-integrity: 修法（两条，按"这次改动是不是你有意的"选）\n')
    process.stderr.write('  ① **有意的**改动（修守卫 / 加判据 / 升级依赖）：在同一个 PR 里更新登记值 ——\n')
    process.stderr.write('     `node scripts/check-guard-parser-integrity.mjs --print-digests` 会打印可直接粘回\n')
    process.stderr.write('     `scripts/check-root-guards.mjs`（守卫）与本文件（解析器包）的登记行。\n')
    process.stderr.write('  ② **不是你改的**：这就是"守卫被掏空 / 被换掉 / 解析器被替换"的信号 ——\n')
    process.stderr.write('     先查清是谁在同一个 PR 里动了它，**不要**顺手更新登记值（登记值可评审正是本判据的全部意义）。\n')
    process.stderr.write(`\ncheck-guard-parser-integrity: ${failures.length + packageFailures.length + executionFailures.length} 项未通过`
      + `（守卫 ${parsed.entries.length} 条 · 解析器包 ${REGISTERED_GATE_PARSER_PACKAGES.length} 个`
      + ` · 执行体入口 ${EXECUTION_ENTRY_PATHS.length} 条）\n`)
    return 1
  }

  process.stdout.write(`check-guard-parser-integrity: OK — ${parsed.entries.length} 条守卫脚本的**内容**摘要与登记值一致`
    + `（含符号链接检查）；${REGISTERED_GATE_PARSER_PACKAGES.length} 个门禁解析器包的文件集摘要一致：`
    + REGISTERED_GATE_PARSER_PACKAGES
      .map(entry => `${entry.name}@${entry.version}(${entry.files} 个文件, sha256 ${entry.sha256.slice(0, 12)}…)`)
      .join('、')
    + '；根 package.json 的 `resolutions` 里没有这些解析器的 patch 条目；'
    + `执行体入口：${REGISTERED_YARN_CONFIGURATION.path} 的内容摘要与登记值一致（禁键 `
    + `${REGISTERED_YARN_CONFIGURATION.forbiddenKeys.map(entry => entry[0]).join('/')} 缺席、`
    + `${REGISTERED_YARN_CONFIGURATION.requiredScalars.map(entry => `${entry[0]}=${entry[1]}`).join('、')}）；`
    + `${YARN_CODE_DIRECTORIES.join('/')} 为空；根 package.json 无未登记的生命周期钩子；`
    + '两个 runner 的守卫通道：直接 spawn（不经 yarn）+ 环境清洗（真子进程证明）；'
    + `工作树↔HEAD 锚定 ${process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true' ? '严格' : '本地告警（CI 上为硬判据）'}\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2))
  // 与 `check-root-guards.mjs` 同一套加固：显式退出（只设 `process.exitCode` 会被
  // `--import` 注入的退出钩子改写；`process.on('exit')` 钩子同样会把 exitCode 改回去）。
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(code)
}
