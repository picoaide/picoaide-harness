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
// **前置校验件的三张清单**（R12-D-01 的收口件）：它是"任何 yarn 命令之前"的第一道，
// 与上面两份各自枚举同一批禁键 / 钩子名 / 必需标量 —— 三份必须同源（⑥b 逐条对拍）。
// 该模块只依赖 `node:*` 与 `git`，且被 import 时零副作用（入口有 isEntryPoint 守卫）。
import {
  INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS,
  INSTALL_INTEGRITY_LIFECYCLE_HOOKS,
  INSTALL_INTEGRITY_REGISTERED_HOOKS,
  INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS,
} from './check-install-integrity.mjs'

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
 * 在仓库根跑一次 git（同步；用于"摘要锚到 **git 对象**"这一层 —— R12-D-01 的 B 面）。
 * @param args - git 参数。
 * @param encoding - `utf8`（缺省）或 `buffer`。
 * @returns `spawnSync` 的结果。
 */
function gitInRoot(args, encoding = 'utf8') {
  return spawnSync('git', ['-C', ROOT, ...args], { encoding, maxBuffer: 128 * 1024 * 1024 })
}

/** 仓库里读不读得到 git 元数据（读不到 ⇒ 摘要只能退化成"工作树 vs 登记值"，走告警通道）。 */
export function gitMetadataAvailable() {
  return gitInRoot(['rev-parse', '--git-dir']).status === 0
}

/**
 * `git show HEAD:<path>` 的字节（**判据的主输入**）。
 *
 * 为什么主判据必须是它、而不是工作树：install 期（`.yarnrc.yml` 的 `plugins:` 顶层模块代码、
 * 工作区 `postinstall`）能改写工作树里的判据执行体**并顺手改掉登记值** —— 那时"工作树 vs
 * 登记值"是自洽的，只有 HEAD 对象能看出这件事（R12-D-01 的 A3/A4：只改
 * `check-root-guards.mjs` 会被 `--require-clean` 抓住，**同时**改这份锚定判据就 EXIT=0）。
 * @param path - 仓库相对路径。
 * @returns `Buffer`；不在 HEAD 里 / 读不出 ⇒ `null`。
 */
export function readHeadBytes(path) {
  const result = gitInRoot(['show', `HEAD:${path}`], 'buffer')
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null
}

/** HEAD 里全部 `scripts/check-*.mjs`（判据执行体的**全集**；读不出 ⇒ `null`）。 */
export function listHeadJudgeBodies() {
  const result = gitInRoot(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'scripts'])
  if (result.status !== 0) return null
  return String(result.stdout)
    .split('\0')
    .filter(name => /^scripts\/check-[^/]*\.mjs$/u.test(name))
    .sort()
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
  // R12-D-01 的收口件：装在所有 yarn 命令**之前**的"判据本体完整性"前置校验。
  // 它自己也是判据执行体（可被改写 ⇒ 前置校验形同虚设），所以在这里登记**内容摘要**：
  // 改动它必须显式出现在 diff 里（`--print-digests` 打印可粘贴行）。
  'scripts/check-install-integrity.mjs',
]

/**
 * 「install 期判据本体完整性前置校验」这一件的**内容摘要登记**（R12-D-01 ①）。
 *
 * 为什么它不能只靠"工作树 == HEAD"：那条判据在**这个脚本自己**被改写时是空的 ——
 * 改写者会让它打印通过。所以它的内容必须是**被登记、进 diff、可评审**的；
 * 与守卫脚本的 `REGISTERED_GUARD_ENTRIES[*].digest` 同一套纪律（摘要由本判据复算对拍）。
 *
 * `methods` = 该脚本负责的判据面（摘要之外给人看的冗余证据，防止"登记了个空壳"）。
 */
const REGISTERED_INSTALL_INTEGRITY_BODIES = [
  {
    path: 'scripts/check-install-integrity.mjs',
    // 由 `node scripts/check-guard-parser-integrity.mjs --print-digests` 打印（粘贴回本行）。
    sha256: '473a6895ebb2d5fc8bfc989e9c82a34cc0ed31222dd0900fa786367e407b7936',
    methods: [
      'judge-body-bytes-equal-head',
      'yarnrc-forbidden-keys',
      'yarn-code-directories-empty',
      'lifecycle-hooks-registered',
    ],
  },
  {
    // 凭据检查器（R12-D-03 / C-P0-2②）：它把"通过凭据"从流属性抬成"步骤独占文件 + 一次性
    // nonce"。它自己也是判据执行体 ⇒ 同样按内容摘要登记（改动必须进 diff、可评审）。
    path: 'scripts/check-verdict-credential.mjs',
    sha256: '402ec25d13178f638768bd57325308795e1ac91e7c874f9baa6afef9a01f1650',
    methods: [
      'credential-exactly-once',
      'credential-counter-semantics',
      'step-private-dir-ownership',
      'nonce-echo-binding',
    ],
  },
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
/**
 * **工作区** manifest 的安装期生命周期钩子登记（R12-D-02，P1）。
 *
 * 现场：同族的 install 期代码执行通道在**工作区包**上完全没判据 ——
 * `lifecycleHookProblems()` 只被喂了根 manifest（本文件 `main()` 里
 * `JSON.parse(readFileSync(join(ROOT, 'package.json')))`），而真 yarn 4.18.0 在
 * `enableScripts: false` 下**照样执行工作区自己的 `postinstall`**（R12-D 的 probe-ws 实测：
 * `YN0007: │ sub@workspace:packages/sub must be built…` + 标记文件落地）⇒ 在
 * 任一工作区包的 manifest 里加一行 `postinstall` 就能在 install 期改写判据本体，
 * 而当时的判据打印的是「根 package.json 无未登记的生命周期钩子」并 EXIT=0。
 *
 * 键 = `{ manifest, hook }`（`manifest` 是仓库相对路径），空表 = **禁新增**。
 */
const REGISTERED_WORKSPACE_LIFECYCLE_HOOKS = [
  {
    manifest: 'packages/host/desktop/package.json',
    hook: 'prepack',
    reason: '既有的"打包前必须过 check"约定（`prepack: yarn run check`）：`prepack` 只在 '
      + '`yarn pack` / 发布打包时执行，**install 期不执行**（真 yarn 4.18.0 实测：'
      + '`enableScripts: false` 下 workspace 的 `postinstall` 会跑、`prepack`/`prepare` 不跑）'
      + '⇒ 它不构成 R12-D-02 那条"install 期改写判据本体"的通道',
    approvedBy: '第十二轮红队 R12-D-02 收口（N1 泳道）',
  },
  {
    manifest: 'community/fabric/package.json',
    hook: 'prepack',
    reason: '同 `packages/host/desktop`：`prepack` 只在打包/发布时执行，不在 install 期（真 yarn 实测）',
    approvedBy: '第十二轮红队 R12-D-02 收口（N1 泳道）',
  },
]
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
/** 工作区 manifest 的文件名形态（`scripts/check-install-integrity.mjs` 侧的清单必须与它一致）。 */
const WORKSPACE_MANIFEST_PATTERN = /^(?:packages|community)\/[^/]+(?:\/[^/]+)?\/package\.json$/u

/**
 * 根 `.yarnrc.yml` 的登记判据（纯函数；输入来自调用方读到的字节，便于自检/变异验证）。
 *
 * @param options - `{ text, exists, isSymlink, isFile, expectedSha256, actualSha256 }`。
 * @returns 问题清单（空 = 通过）。
 */
export function yarnConfigurationProblems(options, registry = REGISTERED_YARN_CONFIGURATION) {
  const problems = []
  if (!options.exists) {
    problems.push(`${registry.path} 不存在 —— 本判据的输入缺席（拒绝把"读不到"当成"没有"）`)
    return problems
  }
  if (options.isSymlink) {
    problems.push(`${registry.path} 是一个**符号链接** —— 内容来自仓外`
      + '（同族的投放机制：守卫脚本曾被换成同名符号链接），入口配置必须是常规文件')
    return problems
  }
  if (!options.isFile) {
    problems.push(`${registry.path} 不是一个常规文件`)
    return problems
  }
  if (options.actualSha256 !== options.expectedSha256) {
    problems.push(`${registry.path} 的**内容**与登记值不一致：\n`
      + `      登记 sha256：${options.expectedSha256}\n`
      + `      实际 sha256：${options.actualSha256}`)
  }
  const keys = yarnrcTopLevelKeys(options.text)
  if (keys.length === 0) {
    problems.push(`${registry.path} 读不出任何顶级键（解析面失效 ⇒ 拒绝把"读不出"当成"没有"）`)
    return problems
  }
  const allowed = new Set(registry.allowedKeys.map(entry => entry[0]))
  const allowances = new Set(REGISTERED_YARN_ENTRY_ALLOWANCES.map(entry => entry.key))
  for (const key of [...new Set(keys)]) {
    // **禁键优先**（第十一轮复审 J1 的 N5，P2）：`forbiddenKeys` 是硬约束，`allowedKeys` 是
    // "新键为什么改不了判据结论"的登记。旧实现先 `if (allowed.has(key) || …) continue`，于是
    // **把 `plugins` 加进 `allowedKeys` 就让禁键整条消失**（审计方实测：那条只剩 `.yarn/plugins/`
    // 落地文件这一条**独立**判据还在报），而错误文案写的却是"确实需要时**只能**先登记进
    // `REGISTERED_YARN_ENTRY_ALLOWANCES`" —— 口径与实现不一致，且少一道网。
    // 现在：禁键 ⇒ 只有 `allowances`（唯一放行通道）能放行；非禁键 ⇒ 才看 `allowedKeys`。
    const forbidden = registry.forbiddenKeys.find(entry => entry[0] === key)
    if (forbidden !== undefined) {
      if (allowances.has(key)) continue
      problems.push(`${registry.path} 里有**禁键** \`${key}\`：${forbidden[1]}`
        + '\n      ⇒ 确实需要时**只能**先登记进 `REGISTERED_YARN_ENTRY_ALLOWANCES`（`{ key, reason, approvedBy }`）'
        + '并写清为什么它不会让判据变空；登记值同样进 diff、同样可评审。'
        + '\n      ⇒ 注意：把它加进 `allowedKeys` **不算**登记 —— 禁键优先于 `allowedKeys`（J1 复审 N5）。')
      continue
    }
    if (allowed.has(key)) continue
    problems.push(`${registry.path} 里有**未登记**的顶级键 \`${key}\``
      + '\n      ⇒ 新键必须登记进 `registry.allowedKeys` 并写明它为什么改不了判据结论。')
  }
  for (const [key, expected, why] of registry.requiredScalars) {
    const actual = yarnrcScalarValue(options.text, key)
    if (actual !== expected) {
      problems.push(`${registry.path} 的 \`${key}\` 必须是 \`${expected}\`（实际 ${JSON.stringify(actual)}）`
        + `：${why}`)
    }
  }
  return problems
}

/**
 * 一份 manifest 的生命周期钩子登记判据（纯函数，P1-1 ① / R12-D-02）。
 *
 * @param manifest - manifest 解析结果。
 * @param path - 该 manifest 的仓库相对路径（缺省=根 `package.json`；工作区用它的真实路径）。
 * @returns 问题清单。
 */
export function lifecycleHookProblems(manifest, path = 'package.json') {
  const isRoot = path === 'package.json'
  const registered = new Set((isRoot ? REGISTERED_ROOT_LIFECYCLE_HOOKS : REGISTERED_WORKSPACE_LIFECYCLE_HOOKS)
    .filter(entry => isRoot || entry.manifest === path)
    .map(entry => entry.hook))
  const hooks = ROOT_LIFECYCLE_HOOK_NAMES.filter(name => typeof manifest?.scripts?.[name] === 'string')
  const problems = []
  for (const hook of hooks) {
    if (registered.has(hook)) continue
    problems.push(`${path} 的 \`scripts.${hook}\` 是**安装期生命周期钩子**且没有登记：`
      + `${JSON.stringify(manifest.scripts[hook])}`
      + '\n      ⇒ `enableScripts: false` 只挡依赖的构建脚本，**挡不住 workspace 自己的 postinstall**'
      + '（根 workspace 与工作区包都一样：真 yarn 4.18.0 实测，工作区钩子在 enableScripts=false 下'
      + '照样执行）；而 CI 的 `yarn install --immutable` 排在根守卫之前 —— install 期可以改写守卫脚本'
      + '并顺手改掉内容摘要登记值（第十一轮 P1-1 / 第十二轮 R12-D-02 实测：内容判据 EXIT 1→0）。'
      + `\n      ⇒ 确实需要时登记进 ${isRoot ? '`REGISTERED_ROOT_LIFECYCLE_HOOKS`（`{ hook, reason, approvedBy }`）' : '`REGISTERED_WORKSPACE_LIFECYCLE_HOOKS`（`{ manifest, hook, reason, approvedBy }`）'}，`
      + '并写清"为什么必须发生在 install 期"。')
  }
  const stale = (isRoot ? REGISTERED_ROOT_LIFECYCLE_HOOKS : REGISTERED_WORKSPACE_LIFECYCLE_HOOKS)
    .filter(entry => isRoot || entry.manifest === path)
    .map(entry => entry.hook)
    .filter(hook => !hooks.includes(hook))
  for (const hook of stale) {
    problems.push(`登记表里的生命周期钩子 \`${path}#${hook}\` 在 ${path} 里并不存在 ——`
      + '陈旧登记必须清掉（留下它等于给下一个人一个"已经批过"的钩子名）')
  }
  return problems
}

/**
 * **全部** manifest（根 + 每个 workspace 包）的钩子判据（R12-D-02）。
 *
 * 清单**从 HEAD 的根 manifest 展开**（`workspaces` 的 glob），不读工作树：这份清单是
 * "登记面"的输入，而工作树在 install 期可被改写。展开出 0 个工作区 manifest ⇒ **fail-loud**
 * （"一个都展开不出来"与"没有工作区"不可区分）。
 *
 * @param options - `{ readHeadBlob, root }`。`readHeadBlob(path)` 返回 `Buffer`/`null`。
 * @returns `{ problems, manifests }`；`manifests` = 参与扫描的相对路径（含根）。
 */
export function allLifecycleHookProblems(options) {
  const problems = []
  const rootBytes = options.readHeadBlob('package.json')
  if (rootBytes === null) {
    return { problems: ['读不到 HEAD 里的 package.json —— 钩子登记面的输入缺席'], manifests: [] }
  }
  let rootManifest
  try {
    rootManifest = JSON.parse(rootBytes.toString('utf8'))
  } catch (error) {
    return { problems: [`HEAD 的 package.json 不是合法 JSON：${error.message}`], manifests: [] }
  }
  problems.push(...lifecycleHookProblems(rootManifest, 'package.json'))
  const workspaceManifests = expandWorkspaceManifests(options.root, rootManifest?.workspaces ?? [])
  if (workspaceManifests.length === 0) {
    return {
      problems: [...problems, '从 HEAD 的 `workspaces` 展开出 0 个 manifest —— 工作区钩子的登记面会静默变空，'
        + '按判据输入缺席处理（fail-loud，而不是"没有工作区"）'],
      manifests: ['package.json'],
    }
  }
  for (const path of workspaceManifests) {
    const bytes = options.readHeadBlob(path)
    if (bytes === null) {
      problems.push(`${path} 不在 HEAD 里 —— 工作区 manifest 登记面残缺`)
      continue
    }
    try {
      problems.push(...lifecycleHookProblems(JSON.parse(bytes.toString('utf8')), path))
    } catch (error) {
      problems.push(`${path} 不是合法 JSON（HEAD 那份）：${error.message}`)
    }
  }
  return { problems, manifests: ['package.json', ...workspaceManifests] }
}

/**
 * 展开 `workspaces` 里的目录形态（逐段星号；与本仓 `packages/<scope>/<pkg>` /
 * `community/<name>` 两张 glob 一致，与 `scripts/check-install-integrity.mjs` 的同名实现同源）。
 * @param root - 仓库根。
 * @param patterns - `workspaces` 数组。
 * @returns manifest 相对路径（升序；只保留真的存在 package.json 的目录）。
 */
export function expandWorkspaceManifests(root, patterns) {
  const manifests = new Set()
  const walk = (directory, segments) => {
    if (segments.length === 0) {
      if (existsSync(join(root, directory, 'package.json'))) manifests.add(`${directory}/package.json`)
      return
    }
    const [head, ...rest] = segments
    if (head !== '*') {
      walk(directory === '' ? head : `${directory}/${head}`, rest)
      return
    }
    const absolute = directory === '' ? root : join(root, directory)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      walk(directory === '' ? entry.name : `${directory}/${entry.name}`, rest)
    }
  }
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (typeof pattern !== 'string') continue
    walk('', pattern.split('/').filter(segment => segment !== ''))
  }
  return [...manifests].filter(path => WORKSPACE_MANIFEST_PATTERN.test(path)).sort()
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
/**
 * 探针**包**名（只存在于合成树里）：用来证明"包级 check 的进程环境**原样继承**本进程"
 * —— 与守卫通道的清洗相对照（第十一轮复审 J1 的 N3）。
 */
const SPAWN_WIRING_PROBE_PACKAGE = 'r11-probe-pkg'
/**
 * `selfTestGuardSpawnWiring()` 至少执行的断言条数（12 条：两个 runner + 污染拒绝 + **双钩子拒绝**
 * （J1 复审 N1）+ **正当 `NODE_OPTIONS` 不拒跑、包级继承、守卫仍被清洗**（J1 复审 N3）
 * + **两个 runner 必须打印通过凭据**（N1/N4）+ 回落前置判据 + 探针自证）。
 */
const SELFTEST_SPAWN_WIRING_ASSERTIONS = 12

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
  // **包表也换成合成的一条**（J1 复审 N3 的运行级证据）：编排器的包级通道只在"真的有包被选中"
  // 时才会 spawn `corepack`，所以"正当 `NODE_OPTIONS` 是否进到包级环境"必须先有一张包表。
  // `PATH_OWNERS`/`DEPENDENTS` 同步清空 —— 它们指向真实包名，留着会让 `scheduleTableProblems()`
  // 报"指向不存在的包"（EXIT=2），那样测的就不是这一条了。
  const packagesBlock = /const PACKAGES = \[[\s\S]*?\n\]/u.exec(out)
  if (packagesBlock === null) throw new Error('找不到 PACKAGES 表')
  out = out.replace(packagesBlock[0], ['const PACKAGES = [',
    `  { name: '${SPAWN_WIRING_PROBE_PACKAGE}', dir: 'packages/probe/${SPAWN_WIRING_PROBE_PACKAGE}', needs: [], script: 'check' },`,
    ']'].join('\n'))
  const pathOwnersBlock = /const PATH_OWNERS = \[[\s\S]*?\n\]/u.exec(out)
  if (pathOwnersBlock === null) throw new Error('找不到 PATH_OWNERS 表')
  // `scheduleTableProblems()` 要求每个包的**根目录前缀**恰有一条归属（`--changed` 靠它把改动
  // 映射到包）⇒ 合成包表必须配一条合成归属，否则编排器直接 EXIT=2（实测踩过）。
  out = out.replace(pathOwnersBlock[0],
    `const PATH_OWNERS = [['packages/probe/${SPAWN_WIRING_PROBE_PACKAGE}/', '${SPAWN_WIRING_PROBE_PACKAGE}']]`)
  const dependentsBlock = /const DEPENDENTS = \{[\s\S]*?\n\}/u.exec(out)
  if (dependentsBlock === null) throw new Error('找不到 DEPENDENTS 表')
  out = out.replace(dependentsBlock[0], 'const DEPENDENTS = {}')
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
  // 合成包目录（包级 check 的 spawn 目标；`--only <探针包>` 时编排器会经 corepack 起它）。
  mkdirSync(join(tree, 'packages', 'probe', SPAWN_WIRING_PROBE_PACKAGE), { recursive: true })
  writeFileSync(join(tree, 'packages', 'probe', SPAWN_WIRING_PROBE_PACKAGE, 'package.json'),
    `${JSON.stringify({ name: SPAWN_WIRING_PROBE_PACKAGE, private: true, scripts: { check: 'node check.mjs' } }, null, 2)}\n`)
  // corepack 桩：被调用就失败（探针树里 yarn **不该**被守卫通道用到 —— 这正是不经 yarn 的判据），
  // 但**把交给它的进程环境落一份留痕**（`R11_COREPACK_ENV_TRACE`）：包级 check 走的就是这条通道，
  // 于是"清洗只作用于守卫"这件事有运行级证据（J1 复审 N3）。
  const stub = join(tree, 'bin', 'corepack')
  writeFileSync(stub, [
    '#!/bin/sh',
    'printf "R11-WIRING-PROBE-COREPACK-CALLED %s\\n" "$*" >&2',
    'if [ -n "${R11_COREPACK_ENV_TRACE:-}" ]; then',
    '  {',
    '    printf "NODE_OPTIONS=%s\\n" "${NODE_OPTIONS:-}"',
    '    printf "R11_MARKER=%s\\n" "${R11_GUARD_ENV_PROBE_MARKER:-}"',
    '    printf "BASH_ENV=%s\\n" "${BASH_ENV:-}"',
    '  } > "$R11_COREPACK_ENV_TRACE"',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
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
    // ③b **两条钩子都覆写**（第十一轮复审 J1 的 N1，P0）：`process.exit` **与** `process.reallyExit`
    //     同时被换成"正常退出 0"的函数（载荷只多两行）。旧实现把 `reallyExit` 放在 `try` 里、只靠
    //     它**抛不抛**决定要不要 `SIGKILL` 补刀 ⇒ 被换掉的 `reallyExit` 不抛 ⇒ 兜底永不执行 ⇒
    //     判决不可信的进程说出"通过"（审计方实测 `corepack yarn check` EXIT=**0**、
    //     `check-root-guards` EXIT=**0**，日志里连摘要行都没有）。三条判据一起钉：
    //     退出码非 0 ∧ 有拒绝文案 ∧ **没有**任何"跑过了"的凭据（摘要行 / `VERDICT PASS`）。
    const twoHook = join(tree, 'r11-two-hook.mjs')
    writeFileSync(twoHook, [
      'const realExit = process.exit.bind(process)',
      'const realReallyExit = process.reallyExit ? process.reallyExit.bind(process) : realExit',
      'try { Object.defineProperty(process, "exitCode", { configurable: true, get: () => 0, set: () => {} }) } catch {}',
      'process.exit = () => realExit(0)',
      'process.reallyExit = () => realReallyExit(0)',
      'process.on("uncaughtException", () => realExit(0))',
      'process.on("unhandledRejection", () => realExit(0))',
      'process.on("exit", () => { process.exitCode = 0 })',
      '',
    ].join('\n'))
    const twoHooked = spawnSync(process.execPath, [join(tree, 'scripts', 'check-root-guards.mjs'), '--list'], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...env, NODE_OPTIONS: `--import=${twoHook}` },
    })
    const twoHookedOutput = `${twoHooked.stdout ?? ''}${twoHooked.stderr ?? ''}`
    assertions += 1
    if (twoHooked.status === 0) {
      failures.push('[spawn-wiring] 钩子**同时**覆写 `process.exit` 与 `process.reallyExit` 时，runner 仍然'
        + `说出了"通过"（EXIT=0）—— 结束路径又被"抛不抛"决定了（J1 复审 N1 的 P0 形态）：`
        + `${JSON.stringify(twoHookedOutput.slice(-300))}`)
    }
    assertions += 1
    if (!twoHookedOutput.includes('拒绝运行')) {
      failures.push('[spawn-wiring] 双钩子形态必须仍然打印拒绝文案（否则 CI 日志里只剩"被信号杀死"，指不到病根）：'
        + `${JSON.stringify(twoHookedOutput.slice(-300))}`)
    }
    assertions += 1
    //    判据取**行首锚定**的凭据形态（拒绝文案里会引用 `VERDICT PASS` 这个词，行内出现不算打印）。
    if (twoHookedOutput.includes('────')
      || /(?:^|\n)\s*(?:check-root-guards|check-workspaces): VERDICT PASS/u.test(twoHookedOutput)) {
      failures.push('[spawn-wiring] 双钩子形态下 runner 打印了"跑过了"的凭据（摘要行 / `VERDICT PASS`）—— '
        + '那正是"零任务 + 绿"的现场（J1 复审 N1）：'
        + `${JSON.stringify(twoHookedOutput.slice(-300))}`)
    }
    // ⑦ **通过凭据本身必须存在且自洽**（第十一轮复审 J1 的 N1/N4）：两个 runner 在"真的跑过"
    //    的那次运行里必须打印**行首锚定**的通过行，且"实跑 == 计划 > 0"。
    //    为什么这条是必须的：这道闸门的全部价值就是"父进程/CI 认那一行，而不是认退出码"——
    //    那一行被删掉、被改名、或 N 变成 0 时，父进程侧唯一的凭据就消失了（而退出码照样是 0）。
    //    判据是**行首前缀**（凭据行后面跟一句人读的括注，所以不锚行尾）。
    const runnerPass = /^check-root-guards: VERDICT PASS guards=(\d+)\b/mu.exec(runner.stdout ?? '')
    assertions += 1
    if (runnerPass === null || Number(runnerPass[1]) <= 0) {
      failures.push('[spawn-wiring] 根守卫运行器"真的跑过"的那次运行必须打印'
        + ` \`check-root-guards: VERDICT PASS guards=<N>\`（N>0），实际：`
        + `${JSON.stringify((runner.stdout ?? '').split('\n').filter(line => line.includes('VERDICT')).join(' | ').slice(0, 300))}`
        + '\n  ⇒ 没有这一行时，父进程/CI 只能相信退出码 —— 而退出码正是 P0-1 载荷能改写的东西（J1 复审 N1/N4）。')
    }
    const orchestratorPass = /^check-workspaces: VERDICT PASS planned=(\d+) executed=(\d+)\b/mu.exec(orchestrator.stdout ?? '')
    assertions += 1
    if (orchestratorPass === null
      || Number(orchestratorPass[1]) <= 0
      || orchestratorPass[1] !== orchestratorPass[2]) {
      failures.push('[spawn-wiring] 编排器"真的跑过"的那次运行必须打印'
        + ` \`check-workspaces: VERDICT PASS planned=N executed=N\`（N>0 且两数相等），实际：`
        + `${JSON.stringify((orchestrator.stdout ?? '').split('\n').filter(line => line.includes('VERDICT')).join(' | ').slice(0, 300))}`
        + '\n  ⇒ "实跑 == 计划"正是"零任务 + 绿"那条失效形态的反面（J1 复审 N4）。')
    }
    // ⑥ **N3 的两半**（第十一轮复审 J1）：正当的 `NODE_OPTIONS=--max-old-space-size=…`
    //    必须（a）**不再被拒跑**（旧实现按键名一律拒绝 ⇒ 连 `--list` 都 EXIT=2），
    //    且（b）**仍然进到包级 check 的环境里**（清洗只该作用于守卫通道）—— 同时（c）守卫子进程
    //    的环境**仍然被清洗**。三个事实在**同一次运行**里各留一份留痕：
    //      · `R11_GUARD_ENV_PROBE_OUT` = 探针守卫写的 JSON（守卫通道）；
    //      · `R11_COREPACK_ENV_TRACE` = corepack 桩写的 package 通道环境（见 buildGuardSpawnWiringProbe）。
    //    为什么必须是运行级：这三件事都是"接线"，源码里换个变量名/换一份 env 对象就能反转，
    //    而字符串断言在反转后照样绿（第十轮 D-03 / 本轮 N3 是同一类缺陷）。
    const benignTrace = join(tree, 'r11-benign-node-options.json')
    const pkgEnvTrace = join(tree, 'r11-package-env.txt')
    const benign = spawnSync(process.execPath, [
      join(tree, 'scripts', 'check-workspaces.mjs'), '--only', SPAWN_WIRING_PROBE_PACKAGE,
    ], {
      cwd: tree,
      encoding: 'utf8',
      env: {
        ...env,
        NODE_OPTIONS: '--max-old-space-size=64',
        R11_GUARD_ENV_PROBE_OUT: benignTrace,
        R11_COREPACK_ENV_TRACE: pkgEnvTrace,
      },
    })
    assertions += 1
    // 退出码 1 = 包级 check 真的被调度了、corepack 桩按设计失败（2 = 在入口就被拒 ⇒ N3 的现场）。
    if (benign.status !== 1) {
      failures.push('[spawn-wiring] `NODE_OPTIONS=--max-old-space-size=64`（正当用法：堆上限）下编排器必须照常'
        + `调度（含包级 check；corepack 桩失败 ⇒ EXIT=1），实际 ${benign.status}：`
        + `${JSON.stringify(`${benign.stdout ?? ''}${benign.stderr ?? ''}`.slice(-300))}`
        + '\n  ⇒ 旧实现按**键名**拒绝（`NODE_OPTIONS` 一律危险），代价是"给门禁加堆内存"从生效变成直接红（N3）。')
    }
    assertions += 1
    let pkgEnv = null
    try {
      pkgEnv = readFileSync(pkgEnvTrace, 'utf8')
    } catch {
      pkgEnv = null
    }
    if (pkgEnv === null) {
      failures.push(`[spawn-wiring] 包级 check 那一路没有留下环境留痕（${pkgEnvTrace}）⇒ `
        + '"正当 `NODE_OPTIONS` 真的传到了包级构建环境"没有被证明（N3 的后半条）')
    } else {
      if (!/^NODE_OPTIONS=--max-old-space-size=64$/mu.test(pkgEnv)) {
        failures.push('[spawn-wiring] 包级 check 的进程环境里**没有**正当的 `NODE_OPTIONS`：'
          + `${JSON.stringify(pkgEnv)}`
          + '\n  ⇒ 清洗必须**只**作用于守卫通道（N3）：把同一份清洗套在包级 check 上会顺手丢掉'
          + ' `NODE_OPTIONS=--max-old-space-size=…` / `YARN_*` / `npm_config_*`，那是把"注入面收口"错做成"构建环境阉割"。')
      }
      if (!/^R11_MARKER=yes$/mu.test(pkgEnv)) {
        failures.push('[spawn-wiring] 包级 check 的进程环境里没有探针 marker（环境没有被原样继承）：'
          + `${JSON.stringify(pkgEnv)}`)
      }
    }
    assertions += 1
    let benignFacts = null
    try {
      benignFacts = JSON.parse(readFileSync(benignTrace, 'utf8'))
    } catch {
      benignFacts = null
    }
    if (benignFacts === null) {
      failures.push(`[spawn-wiring] 正当 \`NODE_OPTIONS\` 的那一路没有留下探针留痕（${benignTrace}）⇒ `
        + '"拒绝按键名放宽之后守卫仍被清洗"没有被证明')
    } else if (benignFacts.marker !== 'yes' || benignFacts.nodeOptions !== null || benignFacts.bashEnv !== null) {
      failures.push('[spawn-wiring] 正当 `NODE_OPTIONS` 的那一路守卫子进程环境不对：'
        + `${JSON.stringify(benignFacts)}（marker 必须在场；\`NODE_OPTIONS\`/\`BASH_ENV\` 必须缺席 —— `
        + '判据按**旗标内容**放宽 runner 自身，守卫通道的清洗**不许**跟着放宽）')
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
 * 「git 锚定」严格面的**判据信号**（第十一轮复审 J1 的 N2，P1）。
 *
 * 旧实现只看 `GITHUB_ACTIONS === 'true' || CI === 'true'` —— 而这两个都是**普通环境变量**，
 * 被钉步骤体里一行 `unset CI GITHUB_ACTIONS`（或 `env -u CI -u GITHUB_ACTIONS …`）就能把
 * 这条唯一的承重网从"CI 硬判据"降级成"本地告警"（审计方实测：`CI=true node …` = 1，
 * 同一棵树加一行 `unset` = **0**）。
 *
 * 现在取的是**runner 注入、且形如"路径/摘要"的多个独立信号**，任一在场即严格：
 *   · `GITHUB_EVENT_PATH`（事件 JSON 的**文件路径**：runner 一定写，步骤体没有理由清它）；
 *   · `GITHUB_SHA`（40 位十六进制）；
 *   · `GITHUB_RUN_ID`（十进制，Actions 里必有）；
 *   · `GITHUB_WORKFLOW` / `RUNNER_OS` / `RUNNER_TEMP`（runner 级环境）。
 * 要静默严格面就得把这些**全部**清掉 —— 那需要多条 `unset`，而静态面已经认 `unset`/`env -u`
 * （`check-workflows.mjs` 的 [SK-17]，本轮 N2 ①），所以"隐藏的降级"变成"显式可判的 diff"。
 *
 * **为什么新判据不能只靠 env**（问题的正解不在 env 里）：任何环境变量都能被步骤体清掉，
 * 所以这条只是把"一行 unset"变成"六行 unset（且被静态判据拦）"。真正的硬通道是
 * **参数**：`--require-clean`（本文件支持，CI 侧可显式传）—— 它写在 `run:` 的 argv 里，
 * 不在环境面上；步骤体要改 argv 就得改命令本身（[SK-14] 的判据面），而命令改了就是评审可见的 diff。
 * 结论：**env 信号负责"默认就严格"，参数负责"不可被环境面关闭"**；两者都要在才叫分界钉死。
 * @param env - 源环境（缺省 `process.env`）。
 * @returns 命中的信号（按检查顺序）；空数组 = 本地姿态（只告警）。
 */
export function strictAnchorSignals(env = process.env) {
  const hits = []
  if (env.GITHUB_ACTIONS === 'true') hits.push('GITHUB_ACTIONS')
  if (env.CI === 'true') hits.push('CI')
  if (typeof env.GITHUB_EVENT_PATH === 'string' && env.GITHUB_EVENT_PATH.trim() !== '') hits.push('GITHUB_EVENT_PATH')
  if (/^[0-9a-f]{40}$/iu.test(env.GITHUB_SHA ?? '')) hits.push('GITHUB_SHA')
  if (/^\d+$/u.test(env.GITHUB_RUN_ID ?? '')) hits.push('GITHUB_RUN_ID')
  if (typeof env.GITHUB_WORKFLOW === 'string' && env.GITHUB_WORKFLOW.trim() !== '') hits.push('GITHUB_WORKFLOW')
  if (typeof env.RUNNER_OS === 'string' && env.RUNNER_OS.trim() !== '') hits.push('RUNNER_OS')
  if (typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.trim() !== '') hits.push('RUNNER_TEMP')
  return hits
}

/* ---------------------------------------------------------------------------
 * R13-D-01（第十三轮红队 P0）的两条**平台锚**：判据执行体的字节从哪里来才算数。
 *
 * 现场：载荷改写判据执行体**并 `git commit`** ⇒ `git show HEAD:` 与工作树自洽，
 * `--restore` / `--require-clean` / 摘要登记全部失效，Full gate **EXIT=0** 且打印**真凭据**。
 * 根因是"锚"取在**本地 git 对象库**上（与被审对象同域可写）。两条收口：
 *
 *   ① **`assertHeadEqualsEnv`**：`git rev-parse HEAD` 必须等于 `$GITHUB_SHA`（平台注入值，
 *      仓内执行点改不了 —— 要改它得先写本进程的环境，而"第一道执行体"这个**位置**判据
 *      （`check-install-integrity.mjs` + `check-workflows.mjs` 的 [SK-14⑨]）挡在那里）。
 *      不相等 ⇒ **退出码 2**（`--require-clean` 或 CI 信号在场时；本地无信号时只告警）。
 *   ② **远端对象库锚**：把登记的执行体按 `$GITHUB_SHA` 从 `origin` **取回**到
 *      `$RUNNER_TEMP` 下的干净目录（`git init` + `fetch --depth 1 --filter=blob:none`
 *      + 按需 `cat-file blob`），用**那份字节**复算摘要并与登记值对拍。
 *
 * **② 的真实效力（V13-A §2.3 / §10 R4 的诚实降级；不要再照旧口径高估它）**：
 * 它是**另一个域上的独立确认**，**不是**"结构性收口"、**不是**"载荷改不了的字节比对"、
 * 更不是"第二道防线"。理由是纯内容寻址的：调用点先要求 `HEAD == $GITHUB_SHA`（① 成立），
 * 而 `expected[path]` 由 `sha256(git show HEAD:<path>)` 派生（本文件 `readHeadBytes`），
 * 远端 `cat-file` 取的是**同一个 commit** 的同名 blob —— 同一个 SHA 在 git 内容寻址下
 * 必然同字节。⇒ **`mismatches`（字节不符）分支在生产调用路径上不可达**，只有**伪造/合成
 * `expected`**（或 SHA-1 碰撞）才能命中它；`missing` 分支同理（键就是从那个 commit 读出来的）。
 * 生产路径上它实际退化为一条**可用性探测**：「能不能从 `origin` 按裸 `$GITHUB_SHA` 取回」。
 * 覆盖面也只有 `REGISTERED_INSTALL_INTEGRITY_BODIES` 的 **2 条**前置校验件，
 * **不是** 96 条执行体那一面（那一面由本文件其余判据 + `check-install-integrity.mjs` 负责）。
 * 合成 `expected` 触发该分支的变异证据 = `temp/r13/GA/mutate.sh` 的 M3（`temp/` 不入库；
 * 该条目自身标注为变异，不代表产线行为）。
 *
 * 成本与取舍（如实写在这里，也写进报告）：多一次浅取回 —— **新增一次网络依赖**。用
 * `--filter=blob:none` 只取 commit + tree，**blob 按需惰性取回**（每个登记件一次往返），
 * 因此代价与"要验几个文件"成正比、与"仓有多大"无关。**离线/无 origin 的场景**：非严格面
 * （本地、无 runner 信号）只告警、不动退出码（V13-A §2.1 实测 T2b2 = EXIT 0）；环境里
 * **没有 `$GITHUB_SHA`** 时 ② 连探测都不做（`sha === null` ⇒ `status: 'skipped'`，
 * 由 ① 去报"判据输入缺席"）；
 * **严格面（CI / `--require-clean`）下取不回 ⇒ 红** —— 这是 **fail-closed 的设计意图**
 * （"锚不可达"不能当成"锚成立"），不是新的假红来源：CI 上 `$GITHUB_SHA` 恒在平台对象库里，
 * 取不回只可能是网络/凭据/权限异常，那正是应该红的情况。
 * ------------------------------------------------------------------------- */

/** 远端锚在 `$RUNNER_TEMP` 下的工作目录名（每次运行唯一）。 */
const REMOTE_ANCHOR_DIR_PREFIX = 'gate-remote-anchor-'

/**
 * `assertHeadEqualsEnv`：`HEAD` 与平台值的一致性（R13-D-01）。
 *
 * 这是两条平台锚里**唯一在生产调用路径上真正生效**的一条：`HEAD` 取自本地 git 对象库
 * （与被审对象同域可写），`$GITHUB_SHA` 由平台注入（仓内执行点改不了）—— 两者跨域，
 * 不相等就是"判据在自己的可写域里自洽"这一失效态的**结构性**识别。
 *
 * @param options - `{ head, env, strict }`。
 * @returns `{ failures, advisories, sha, note }`。
 */
export function assertHeadEqualsEnv(options = {}) {
  const env = options.env ?? {}
  const head = String(options.head ?? '')
  const raw = typeof env.GITHUB_SHA === 'string' ? env.GITHUB_SHA.trim() : ''
  const failures = []
  const advisories = []
  if (raw === '') {
    const message = '平台锚（`HEAD == $GITHUB_SHA`）**未验证**：环境里没有 `GITHUB_SHA`'
    if (options.strict) {
      failures.push(`${message} —— 严格面（\`--require-clean\` 或 CI 信号在场）下这是判据输入缺席：`
        + '`HEAD` 取自**本地 git 对象库**，而它与被审对象同域可写（R13-D-01：改写判据并 `git commit` 后，'
        + '`git show HEAD:` 与工作树自洽 ⇒ 全部比对"自洽地通过"）。CI 上 `GITHUB_SHA` 必在场。')
    } else advisories.push(message)
    return { failures, advisories, sha: null, note: null }
  }
  if (!/^[0-9a-f]{40}$/u.test(raw)) {
    failures.push(`\`GITHUB_SHA\` 形态非法：${JSON.stringify(raw)}（必须是 40 位小写 hex）`)
    return { failures, advisories, sha: null, note: null }
  }
  if (raw !== head) {
    failures.push(`**平台锚不一致**：\`git rev-parse HEAD\` = ${head} · \`$GITHUB_SHA\` = ${raw}\n`
      + '      ⇒ 判据比对的是"本地 git 对象库里的 HEAD"，而它**与被审对象同域可写**：'
      + '载荷改写判据执行体并 `git commit` 之后，`git show HEAD:` 与工作树自洽 ⇒ 摘要登记、'
      + '`--restore`、`--require-clean` **全部失效**而门禁 EXIT=0（第十三轮 R13-D-01 实测）。')
    return { failures, advisories, sha: raw, note: null }
  }
  return { failures, advisories, sha: raw, note: `平台锚一致：HEAD == $GITHUB_SHA == ${raw.slice(0, 12)}…` }
}

/**
 * **远端对象库锚**（R13-D-01 的 ②）：把登记的执行体按 `$GITHUB_SHA` 从 `origin`
 * 取回到一个干净目录，用那份字节复算摘要。
 *
 * 效力边界见上方头注释（V13-A §2.3 / §10 R4）：调用点已先要求 `HEAD == $GITHUB_SHA`，
 * 而 `expected` 是从**同一个 commit** 的 `git show HEAD:` 派生的 ⇒ 这里的字节对拍在
 * **生产调用路径上不可达**（内容寻址必然同字节），只有合成 `expected` 才命中
 * `mismatches`。它实际兑现的是"能否从 `origin` 按裸 `$GITHUB_SHA` 取回"的**可用性探测**
 * 与"取不回 ⇒ 严格面红"的 fail-closed 语义，且只覆盖 2 条前置校验件。
 * **不要把它读成"载荷改不了的第二道防线 / 结构性收口"。**
 *
 * @param options - `{ sha, paths, env, strict }`；`paths` = 要验的仓库相对路径。
 * @returns `{ failures, advisories, note, status }`；`status` ∈ `ok|skipped|unavailable`。
 */
export function remoteAnchorProblems(options = {}) {
  const failures = []
  const advisories = []
  const sha = options.sha
  const paths = options.paths ?? []
  if (sha === null || paths.length === 0) return { failures, advisories, note: null, status: 'skipped' }
  const env = options.env ?? process.env
  const runnerTemp = typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.trim() !== ''
    ? env.RUNNER_TEMP.trim()
    : (env.TMPDIR ?? tmpdir())
  const remote = gitInRoot(['remote', 'get-url', 'origin'])
  if (remote.status !== 0 || String(remote.stdout).trim() === '') {
    const message = '取不回远端对象库：本仓没有 `origin` remote（无法把判据执行体按 `$GITHUB_SHA` 从**载荷改不了的**那份取回）'
    if (options.strict) failures.push(message + ' ⇒ 严格面下"锚不可达"不能当成"锚成立"。')
    else advisories.push(message)
    return { failures, advisories, note: null, status: 'unavailable' }
  }
  const directory = mkdtempSync(join(runnerTemp, REMOTE_ANCHOR_DIR_PREFIX))
  const run = (args, encoding = 'utf8') => spawnSync('git', ['-C', directory, ...args],
    { encoding, maxBuffer: 128 * 1024 * 1024 })
  try {
    if (run(['init', '--quiet']).status !== 0) throw new Error('git init 失败')
    // origin 可能是**相对路径**（本机把远端指向相邻目录的常见形态）；工作目录是临时目录，
    // 相对 URL 在那里解析不到 ⇒ 先按本仓根绝对化（`scheme://` 与 `user@host:path` 原样保留）。
    const rawRemote = String(remote.stdout).trim()
    const remoteUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(rawRemote) || /^[^/]+@[^/]+:/u.test(rawRemote)
      ? rawRemote
      : resolve(ROOT, rawRemote)
    if (run(['remote', 'add', 'origin', remoteUrl]).status !== 0) throw new Error('git remote add 失败')
    // `--filter=blob:none`：只取 commit + tree，blob 在 `cat-file` 时**按需**取回
    // （每个登记件一次往返）—— 代价与"要验几个文件"成正比，与仓的大小无关。
    let fetch = run(['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', sha])
    if (fetch.status !== 0) {
      // 服务端不支持 partial clone ⇒ 回落整份浅取（更强但更贵）。
      fetch = run(['fetch', '--quiet', '--depth', '1', 'origin', sha])
    }
    if (fetch.status !== 0) throw new Error(`git fetch 失败：${String(fetch.stderr).trim().split('\n').slice(-1)[0] ?? ''}`)
    const head = run(['rev-parse', 'FETCH_HEAD'])
    if (head.status !== 0 || String(head.stdout).trim() !== sha) {
      throw new Error(`取回的提交不是 $GITHUB_SHA（实际 ${String(head.stdout).trim().slice(0, 12)}）`)
    }
    const mismatches = []
    const missing = []
    for (const path of paths) {
      const blob = run(['cat-file', 'blob', `FETCH_HEAD:${path}`], 'buffer')
      if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
        missing.push(path)
        continue
      }
      const remoteDigest = sha256(blob.stdout)
      const registered = (options.expected ?? {})[path]
      if (typeof registered === 'string' && registered !== remoteDigest) {
        mismatches.push(`${path}\n        登记值 sha256：${registered}\n        远端 sha256：${remoteDigest}`)
      }
    }
    if (missing.length > 0) {
      failures.push(`远端提交 ${sha.slice(0, 12)} 里读不到这些判据执行体：${missing.join('、')}\n`
        + '      ⇒ 要么登记表指向了一条不在平台提交里的路径，要么取回被截断（"读不到"不等于"没问题"）。')
    }
    if (mismatches.length > 0) {
      failures.push(`**远端对象库锚不一致**（${mismatches.length} 条）：\n      ${mismatches.join('\n      ')}\n`
        + '      ⇒ 登记值对应的字节**不在平台提交里** —— 本地的"工作树 == HEAD == 登记值"三份自洽'
        + '在这里失效（载荷可以 `git commit`，但改不了 `origin`）。这就是 R13-D-01 的结构性收口。')
    }
    if (failures.length === 0) {
      return {
        failures,
        advisories,
        note: `远端对象库锚一致：${paths.length} 条判据执行体的字节在 origin@${sha.slice(0, 12)} 上复算与登记值相同`,
        status: 'ok',
      }
    }
    return { failures, advisories, note: null, status: 'ok' }
  } catch (error) {
    const message = `远端对象库锚**取不回**：${error.message}`
    if (options.strict) {
      failures.push(`${message}\n      ⇒ 严格面（CI / \`--require-clean\`）下"锚不可达"不能当成"锚成立"：`
        + '请检查网络/凭据；要临时跳过必须改代码（进 diff），不要用一个环境变量把这条降级。')
    } else advisories.push(message)
    return { failures, advisories, note: null, status: 'unavailable' }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 判据主流程。
 * @param argv - 命令行参数（去掉 `node` 与脚本名）。
 * @returns 退出码。
 */
function main(argv) {
  const printDigests = argv.includes('--print-digests')
  // `--require-clean`（第十一轮复审 J1 的 N2 ②）：把"git 锚定"锁成硬判据的**参数通道** ——
  // 它不在环境面上，步骤体里 `unset`/`env -u` 改不了它（要改就得改命令本身 ⇒ 评审可见）。
  const requireClean = argv.includes('--require-clean')
  // 严格面的**信号**在函数作用域里算一次：判据段（git 锚）与末尾的通过行共用同一份取值
  // （放进块作用域会让末尾那行引用不到 —— Node 直接 ReferenceError，实测踩过）。
  const anchorSignals = strictAnchorSignals()
  const strictAnchor = requireClean || anchorSignals.length > 0
  /** R13-D-01 的平台锚：失败进 `executionFailures`，本地姿态进这里（不静默）。 */
  const anchorAdvisories = []
  let anchorNote = null

  const unknown = argv.filter(argument => argument !== '--print-digests' && argument !== '--require-clean')
  if (unknown.length > 0) {
    console.error(`check-guard-parser-integrity: 未知参数 ${unknown.join(' ')}`)
    return 2
  }

  let runnerSource
  // **守卫登记表的宿主也从 git 对象读**（R12-D-01 的 B 面）：工作树里的
  // `check-root-guards.mjs` 在 install 期可被改写（改写者会顺手改掉登记值），
  // 只有 HEAD 对象是"install 期不可改写"的那份。读不到 HEAD 时退化成工作树 + 后面报告警。
  // 严格面（CI）读 HEAD 对象；本地读工作树 —— 与下面摘要对拍的两面口径**必须同源**
  // （否则"本地改守卫 + 跑 refresh-digests"会拿工作树脚本去撞 HEAD 里的旧登记值 = 假红）。
  const headRunnerBytes = strictAnchor && gitMetadataAvailable()
    ? readHeadBytes('scripts/check-root-guards.mjs')
    : null
  try {
    runnerSource = headRunnerBytes === null ? readFileSync(GUARD_RUNNER, 'utf8') : headRunnerBytes.toString('utf8')
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
    // **摘要的主判据 = HEAD 对象的字节**（工作树那份可能已被 install 期改写）：
    //   ① HEAD 摘要 ≠ 登记值 ⇒ 红（"脚本与登记表一起被改"在这里现形）；
    //   ② 工作树 ≠ HEAD ⇒ 红（严格面）/ 告警（本地脏树）—— 见下面 anchor 段；
    //   ③ 读不到 HEAD（不在检出里 / 新文件）⇒ 退化到工作树摘要（判据不消失，但不假装锚住了）。
    const relativePath = relative(ROOT, path)
    const headBytes = readHeadBytes(relativePath)
    const worktreeBytes = readFileSync(path)
    // **严格面（CI）= HEAD 对象的字节**（install 期不可改写的那份）；本地 = 工作树字节 ——
    // 与本文件 `gitAnchorProblems` 的"本地告警 / CI 硬判据"同一取向：否则"改守卫 →
    // `refresh-digests` → 本地判据"这条既有开发流程会一直红到提交那一刻（假红机器）。
    const anchored = strictAnchor && headBytes !== null
    const digest = sha256(anchored ? headBytes : worktreeBytes)
    actual.push({ name: entry.name, script: entry.script, argvTail: entry.argvTail ?? argvTailLiteral(runnerSource, entry.name), digest })
    if (entry.digest !== digest) {
      failures.push(`守卫 ${entry.name} 的脚本**内容**与登记值不一致：\n`
        + `      脚本：${relativePath}\n`
        + `      ${anchored ? 'HEAD  ' : '工作树'} sha256：${digest}${anchored ? '（严格面：锚到 git 对象）' : ''}\n`
        + `      登记 sha256：${entry.digest}`
        + (headBytes === null ? '' : `\n      工作树 sha256：${sha256(worktreeBytes)}（与 HEAD 不一致时另有一条锚定判据）`)
        + '\n      ⇒ 摘要对拍锚的是 **git 对象**（HEAD），不是工作树：install 期把"脚本 + 登记值"'
        + '一起改掉的形态在这里现形（第十二轮红队 R12-D-01 的 A4：只改守卫会被抓住，'
        + '同时改这份锚定判据才 EXIT=0）。')
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
  /** 参与钩子判据的 manifest 条数（根 + 工作区；给收尾的通过行用）—— 在块外声明，末尾要引用。 */
  let manifestCount = 0
  {
    // ① `.yarnrc.yml`（解释器入口）：内容摘要 + 键集合白名单 + 关键键取值。
    //    **两份都判**（R12-D-01 的 B 面）：工作树那份可能被 install 期改写（改了就连禁键
    //    一起消失，而"工作树 vs 登记值"会自洽）⇒ 禁键 / 必需标量按 **HEAD 那份**再判一次。
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
    const rcHeadBytes = readHeadBytes(REGISTERED_YARN_CONFIGURATION.path)
    executionFailures.push(...yarnConfigurationProblems({
      exists: rcExists,
      text: rcText,
      isSymlink: rcIsSymlink,
      isFile: rcIsFile,
      // 摘要取 HEAD（严格面）/ 工作树（本地），理由同守卫脚本那一段。
      expectedSha256: REGISTERED_YARN_CONFIGURATION.sha256,
      actualSha256: strictAnchor && rcHeadBytes !== null ? sha256(rcHeadBytes) : rcSha256,
    }))
    if (rcHeadBytes !== null) {
      executionFailures.push(...yarnConfigurationProblems({
        exists: true,
        text: rcHeadBytes.toString('utf8'),
        isSymlink: false,
        isFile: true,
        expectedSha256: REGISTERED_YARN_CONFIGURATION.sha256,
        actualSha256: sha256(rcHeadBytes),
      }).filter(problem => !problem.includes('的内容**与登记值不一致')))
    }
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
    // ④ 根与**每一个工作区** manifest 的生命周期钩子（R12-D-02）：`enableScripts: false`
    //    挡不住 root workspace 自己的 postinstall，**也挡不住工作区包的**（真 yarn 实测）。
    //    登记面的输入取自 HEAD（工作树在 install 期可被改写）。
    const readManifestForHooks = path => {
      if (strictAnchor) return readHeadBytes(path)
      const absolute = join(ROOT, path)
      if (existsSync(absolute) && lstatSync(absolute).isFile()) return readFileSync(absolute)
      return readHeadBytes(path)
    }
    const hookScan = allLifecycleHookProblems({ readHeadBlob: readManifestForHooks, root: ROOT })
    executionFailures.push(...hookScan.problems)
    manifestCount = hookScan.manifests.length
    // ⑤ 摘要判据的 **git 锚**（P1-1 ②）：工作树必须与 HEAD 逐字节一致。
    //    严格面 = **runner 注入信号**（多个独立变量，任一在场即严格）+ 显式 `--require-clean`
    //    参数；本地脏树只告警（理由与代价见 gitAnchorProblems 的注释、信号清单见
    //    `strictAnchorSignals()` 的注释 —— N2 的订正：旧实现只看 `CI`/`GITHUB_ACTIONS`，
    //    两个都能被一行 `unset` 清掉）。
    //    `anchorSignals` / `strictAnchor` 的取值在 main() 的**函数作用域**里算（末尾的通过行
    //    也要用同一份 —— 放进块作用域时末尾那行会 ReferenceError，本仓实测踩过）。
    const readHead = path => readHeadBytes(path)
    const gitAvailable = gitMetadataAvailable()
    const readWorktree = path => {
      const absolute = join(ROOT, path)
      return existsSync(absolute) && lstatSync(absolute).isFile() ? readFileSync(absolute) : null
    }
    // 锚定面 = 入口文件 + 全部登记的守卫脚本 + **HEAD 里的全部 `scripts/check-*.mjs`**
    //（R12-D-01 的 A 面：那一组"判据执行体"里任何一条被 install 期改写，都必须在严格面上红）
    // + 全部工作区 manifest（R12-D-02）。
    const anchorPaths = [
      ...new Set([
        ...EXECUTION_ENTRY_PATHS,
        ...(listHeadJudgeBodies() ?? []),
        ...hookScan.manifests,
        ...parsed.entries.map(entry => /^(?:node|bash)\s+(scripts\/\S+)$/u.exec(entry.script)?.[1]).filter(Boolean),
      ]),
    ].sort()
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
    // ⑥b **第三份**实现（R12-D-01 的收口件 `scripts/check-install-integrity.mjs`）的清单也必须一致：
    //     它是"任何 yarn 命令之前"的第一道，与上面两份各自枚举同一批禁键 / 钩子名 ——
    //     任一侧漂移都会留下"前置校验放行、登记制拦住"（或反向）的裂缝。
    const installer = {
      INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS,
      INSTALL_INTEGRITY_LIFECYCLE_HOOKS,
      INSTALL_INTEGRITY_REGISTERED_HOOKS,
      INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS,
    }
    const forbiddenInInstaller = [...installer.INSTALL_INTEGRITY_FORBIDDEN_YARN_KEYS].sort().join(',')
    if (forbiddenInInstaller !== forbiddenHere) {
      executionFailures.push('禁键清单在**前置校验**与登记制之间漂移：'
        + `check-install-integrity.mjs = ${JSON.stringify(forbiddenInInstaller)} / `
        + `本文件 = ${JSON.stringify(forbiddenHere)} ⇒ 三份判定必须同源`)
    }
    const scalarsInInstaller = installer.INSTALL_INTEGRITY_REQUIRED_YARN_SCALARS
      .map(entry => `${entry[0]}=${entry[1]}`).sort().join(',')
    const scalarsHere = REGISTERED_YARN_CONFIGURATION.requiredScalars
      .map(entry => `${entry[0]}=${entry[1]}`).sort().join(',')
    if (scalarsInInstaller !== scalarsHere) {
      executionFailures.push('`.yarnrc.yml` 必需标量在前置校验与登记制之间漂移：'
        + `check-install-integrity.mjs = ${JSON.stringify(scalarsInInstaller)} / 本文件 = ${JSON.stringify(scalarsHere)}`)
    }
    const hooksInInstaller = [...installer.INSTALL_INTEGRITY_LIFECYCLE_HOOKS].sort().join(',')
    if (hooksInInstaller !== hooksHere) {
      executionFailures.push('生命周期钩子清单在前置校验与登记制之间漂移：'
        + `check-install-integrity.mjs = ${JSON.stringify(hooksInInstaller)} / 本文件 = ${JSON.stringify(hooksHere)}`)
    }
    // ⑥d 两份**工作区钩子登记表**必须一致（本文件 ↔ `check-install-integrity.mjs`）：
    //     前置校验在 install **之前**跑、本判据在之后跑，任何一侧多/少一条登记都会留下
    //     "前置校验放行、登记制拦住"（或反向）的裂缝 —— 与 ⑥/⑥b 同一套纪律。
    {
      const here = REGISTERED_WORKSPACE_LIFECYCLE_HOOKS
        .map(entry => `${entry.manifest}#${entry.hook}`).sort().join(',')
      const there = [...installer.INSTALL_INTEGRITY_REGISTERED_HOOKS].sort().join(',')
      if (here !== there) {
        executionFailures.push('工作区生命周期钩子的登记表在**前置校验**与登记制之间漂移：'
          + `\n      check-install-integrity.mjs（install 之前）：${JSON.stringify(there) || '（空）'}`
          + `\n      本文件（登记制）：${JSON.stringify(here) || '（空）'}`
          + '\n      ⇒ 两份必须逐条相同（键 = `<manifest>#<hook>`）。')
      }
    }
    // ⓪ **平台锚**（R13-D-01）：① `HEAD` 必须等于 `$GITHUB_SHA`（跨域，生产路径上真正生效的
    //    那一条）；② 再把登记的执行体从 `origin@$GITHUB_SHA` 取回复算摘要 —— 因为 ① 成立时
    //    `expected` 与远端 blob 出自同一个 commit，② 的字节对拍**必然相等**（内容寻址），
    //    它兑现的是"能否按裸 SHA 取回"的可用性探测与"取不回 ⇒ 严格面红"；
    //    效力边界见 `remoteAnchorProblems` 上方头注释（V13-A §2.3 / §10 R4）。
    {
      const headShaResult = gitInRoot(['rev-parse', 'HEAD'])
      const headSha = headShaResult.status === 0 ? String(headShaResult.stdout).trim() : ''
      const anchor = assertHeadEqualsEnv({ head: headSha, env: process.env, strict: strictAnchor })
      executionFailures.push(...anchor.failures)
      anchorAdvisories.push(...anchor.advisories)
      if (anchor.note !== null) anchorNote = anchor.note
      const expected = {}
      for (const registration of REGISTERED_INSTALL_INTEGRITY_BODIES) {
        const bytes = readHeadBytes(registration.path)
        if (bytes !== null) expected[registration.path] = sha256(bytes)
      }
      const remote = remoteAnchorProblems({
        sha: anchor.sha,
        paths: Object.keys(expected),
        expected,
        env: process.env,
        strict: strictAnchor,
      })
      executionFailures.push(...remote.failures)
      anchorAdvisories.push(...remote.advisories)
      if (remote.note !== null) anchorNote = `${anchorNote === null ? '' : `${anchorNote}；`}${remote.note}`
    }
    // ⑥c **前置校验件自身的内容摘要**（R12-D-01 ①）：它能被改写 ⇒ 它的字节必须登记、进 diff。
    for (const registration of REGISTERED_INSTALL_INTEGRITY_BODIES) {
      const headBytes = readHeadBytes(registration.path)
      const absolute = join(ROOT, registration.path)
      if (headBytes === null) {
        // 严格面（CI）是硬判据；本地允许"这个 PR 刚把它加进来、还没提交"（否则开发者在
        // 提交之前永远看到红 —— 与本文件其它几条"本地告警 / CI 硬判据"同一取向）。
        const message = `登记的前置校验件不在 HEAD 里：${registration.path}`
          + ' ⇒ install 期"检出后才创建"的形态，或登记路径写错 —— 两种都不许静默通过'
        if (strictAnchor) executionFailures.push(message)
        else console.log(`check-guard-parser-integrity: WARNING — ${message}（本地：未提交的新文件，CI 上是硬判据）`)
        continue
      }
      if (!existsSync(absolute)) {
        executionFailures.push(`登记的前置校验件在工作树里不存在：${registration.path}`)
        continue
      }
      const worktreeBytes = readFileSync(absolute)
      const anchored = strictAnchor
      const digest = sha256(anchored ? headBytes : worktreeBytes)
      if (registration.sha256 !== digest) {
        executionFailures.push(`前置校验件的**内容**与登记值不一致：${registration.path}\n`
          + `      登记 sha256：${registration.sha256}\n`
          + `      ${anchored ? 'HEAD  ' : '工作树'} sha256：${digest}\n`
          + '      ⇒ 它是"判据本体有没有被 install 期改写"的第一道判据，自己必须是被登记、'
          + '可评审的那份；有意的改动请用 `--print-digests` 更新本文件的登记行。')
      }
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

  // ===========================================================================
  // R11-J1 的两条**纯函数**自检（N5 / N2）：判据的"优先级"与"信号面"这两件事，
  // 用合成输入直接钉住 —— 它们都不是"文件里有没有那行字"能证明的。
  // ===========================================================================
  if (!printDigests) {
    // N5：**禁键优先于 allowedKeys**。合成登记表：`plugins` 既在 `allowedKeys`（错的登记通道）
    // 又在 `forbiddenKeys` ⇒ 必须仍然报"禁键"。旧实现先 `continue` 掉 allowed ⇒ 这条静默消失，
    // 而错误文案说的却是"只能登记进 REGISTERED_YARN_ENTRY_ALLOWANCES"（口径与实现不一致，J1 的 N5）。
    {
      const probeRegistry = {
        ...REGISTERED_YARN_CONFIGURATION,
        allowedKeys: [...REGISTERED_YARN_CONFIGURATION.allowedKeys, ['plugins', 'J1 复审 N5 的合成登记：走错通道']],
        forbiddenKeys: [['plugins', 'J1 复审 N5 的合成禁键（钩子在 yarn 进程内部改写脚本环境）']],
      }
      const probeText = [
        // 键集合 = 真实登记的两条 requiredScalars（避免合成文本撞上"取值不对"那条无关判据）
        'enableScripts: false',
        'nodeLinker: node-modules',
        'plugins:',
        '  - path: .yarn/plugins/probe.cjs',
        '',
      ].join('\n')
      const probeProblems = yarnConfigurationProblems({
        exists: true,
        text: probeText,
        isSymlink: false,
        isFile: true,
        expectedSha256: 'x',
        actualSha256: 'x',
      }, probeRegistry)
      executionFailures.push(...(probeProblems.some(problem => problem.includes('禁键'))
        ? []
        : ['[yarnrc-precedence] `plugins` 同时出现在 `allowedKeys` 与 `forbiddenKeys` 里时必须报**禁键**'
          + '（禁键优先）—— 旧实现先放行 allowedKeys ⇒ 把它加进 allowedKeys 就能让禁键整条消失，'
          + '而错误文案给出的唯一通道是 `REGISTERED_YARN_ENTRY_ALLOWANCES`（J1 复审 N5）。']))
    }
    // N2：**严格面的信号面**。`CI`/`GITHUB_ACTIONS` 被清掉、但 runner 注入的信号在场时必须仍然严格
    // —— 否则被钉步骤体里一行 `unset CI GITHUB_ACTIONS` 就能把 git 锚定降级成本地告警（J1 的 N2）。
    {
      const runnerOnly = strictAnchorSignals({ GITHUB_EVENT_PATH: '/tmp/event.json' })
      const shaOnly = strictAnchorSignals({ GITHUB_SHA: 'a'.repeat(40) })
      const none = strictAnchorSignals({})
      if (!runnerOnly.includes('GITHUB_EVENT_PATH')) {
        executionFailures.push('[strict-anchor] `GITHUB_EVENT_PATH` 必须是一个严格信号（runner 注入的**路径**变量；'
          + '`unset CI GITHUB_ACTIONS` 清不掉它）—— 旧实现只看 `CI`/`GITHUB_ACTIONS`，一行 `unset` 就能把'
          + '唯一的承重网降级（J1 复审 N2）。')
      }
      if (!shaOnly.includes('GITHUB_SHA')) {
        executionFailures.push('[strict-anchor] `GITHUB_SHA`（40 位十六进制）必须是一个严格信号（J1 复审 N2）。')
      }
      if (none.length !== 0) {
        executionFailures.push(`[strict-anchor] 空环境必须是"本地告警"姿态（本地脏树不许硬判），实际信号 ${JSON.stringify(none)}。`)
      }
      // **接线**（这半条只能是源码级：判据脚本不能在自身判据里递归地跑自己，那会把一次运行变成两次、
      // 且被 spawn 的那次同样受步骤体影响）。它钉的是"严格面由 strictAnchorSignals() 驱动"，
      // 行为级证据在 CI 侧（`--require-clean`）与审计报告里。
      const selfSource = readFileSync(join(ROOT, 'scripts', 'check-guard-parser-integrity.mjs'), 'utf8')
      //     判据钉的是**调用点**（不只是"某一行长得对"）：`strictAnchorSignals()` 必须真的喂给 `strictAnchor`。
      //     只钉赋值那一行是不够的 —— 把上一行换成 `process.env.CI === 'true' ? ['CI'] : []` 就绕过了
      //     （本泳道实测：那样变异之后 EXIT=0，而两行里只有第二行"看起来对"）。
      if (!/const anchorSignals = strictAnchorSignals\(\)\n\s*const strictAnchor = requireClean \|\| anchorSignals\.length > 0/u.test(selfSource)) {
        executionFailures.push('[strict-anchor] 接线断了：严格面必须写成 `const anchorSignals = strictAnchorSignals()`'
          + ' + `const strictAnchor = requireClean || anchorSignals.length > 0`（**同一个** `strictAnchorSignals()` 的取值喂给判定）。'
          + '回到"只看 CI/GITHUB_ACTIONS"就等于让一行 `unset` 关掉整条判据（J1 复审 N2）。')
      }
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
    process.stdout.write('\n# 前置校验件摘要（粘回本文件的 REGISTERED_INSTALL_INTEGRITY_BODIES）\n')
    for (const registration of REGISTERED_INSTALL_INTEGRITY_BODIES) {
      const bytes = readHeadBytes(registration.path) ?? readFileSync(join(ROOT, registration.path))
      process.stdout.write(`  { path: '${registration.path}', sha256: '${sha256(bytes)}',\n`)
      process.stdout.write(`    methods: ${JSON.stringify(registration.methods)} },\n`)
    }
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
    for (const detail of anchorAdvisories) {
      process.stderr.write(`\ncheck-guard-parser-integrity: [平台锚·告警] ${detail}\n`)
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
    + `（**锚到 git 对象**：HEAD 那份的 sha256 对拍 + 符号链接检查）；`
    + `${REGISTERED_GATE_PARSER_PACKAGES.length} 个门禁解析器包的文件集摘要一致：`
    + REGISTERED_GATE_PARSER_PACKAGES
      .map(entry => `${entry.name}@${entry.version}(${entry.files} 个文件, sha256 ${entry.sha256.slice(0, 12)}…)`)
      .join('、')
    + '；根 package.json 的 `resolutions` 里没有这些解析器的 patch 条目；'
    + `执行体入口：${REGISTERED_YARN_CONFIGURATION.path} 的内容摘要与登记值一致（禁键 `
    + `${REGISTERED_YARN_CONFIGURATION.forbiddenKeys.map(entry => entry[0]).join('/')} 缺席、`
    + `${REGISTERED_YARN_CONFIGURATION.requiredScalars.map(entry => `${entry[0]}=${entry[1]}`).join('、')}，`
    + '**HEAD 与工作树两份都判**）；'
    + `${YARN_CODE_DIRECTORIES.join('/')} 为空；`
    + `根 + ${manifestCount - 1} 个工作区 manifest 无未登记的生命周期钩子（R12-D-02）；`
    + `前置校验件 ${REGISTERED_INSTALL_INTEGRITY_BODIES.map(entry => entry.path).join('、')} 的字节登记一致（R12-D-01）；`
    + '两个 runner 的守卫通道：直接 spawn（不经 yarn）+ 环境清洗（真子进程证明）；'
    + `${anchorNote === null ? '' : `${anchorNote}；`}`
    + `${anchorAdvisories.length === 0 ? '' : `平台锚告警：${anchorAdvisories.join('；')}；`}`
    + `工作树↔HEAD 锚定 ${strictAnchor
      ? `严格（信号：${requireClean ? '`--require-clean`' : ''}${requireClean && anchorSignals.length > 0 ? '+' : ''}${anchorSignals.join('+') || '—'}）`
      : '本地告警（CI 上为硬判据；`--require-clean` 可显式要求严格）'}\n`)
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
