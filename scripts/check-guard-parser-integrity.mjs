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

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    return 0
  }

  if (failures.length > 0 || packageFailures.length > 0) {
    for (const detail of failures) {
      process.stderr.write(`\ncheck-guard-parser-integrity: ${detail}\n`)
    }
    for (const detail of packageFailures) {
      process.stderr.write(`\ncheck-guard-parser-integrity: ${detail}\n`)
    }
    process.stderr.write('\ncheck-guard-parser-integrity: 修法（两条，按"这次改动是不是你有意的"选）\n')
    process.stderr.write('  ① **有意的**改动（修守卫 / 加判据 / 升级依赖）：在同一个 PR 里更新登记值 ——\n')
    process.stderr.write('     `node scripts/check-guard-parser-integrity.mjs --print-digests` 会打印可直接粘回\n')
    process.stderr.write('     `scripts/check-root-guards.mjs`（守卫）与本文件（解析器包）的登记行。\n')
    process.stderr.write('  ② **不是你改的**：这就是"守卫被掏空 / 被换掉 / 解析器被替换"的信号 ——\n')
    process.stderr.write('     先查清是谁在同一个 PR 里动了它，**不要**顺手更新登记值（登记值可评审正是本判据的全部意义）。\n')
    process.stderr.write(`\ncheck-guard-parser-integrity: ${failures.length + packageFailures.length} 项未通过`
      + `（守卫 ${parsed.entries.length} 条 · 解析器包 ${REGISTERED_GATE_PARSER_PACKAGES.length} 个）\n`)
    return 1
  }

  process.stdout.write(`check-guard-parser-integrity: OK — ${parsed.entries.length} 条守卫脚本的**内容**摘要与登记值一致`
    + `（含符号链接检查）；${REGISTERED_GATE_PARSER_PACKAGES.length} 个门禁解析器包的文件集摘要一致：`
    + REGISTERED_GATE_PARSER_PACKAGES
      .map(entry => `${entry.name}@${entry.version}(${entry.files} 个文件, sha256 ${entry.sha256.slice(0, 12)}…)`)
      .join('、')
    + '；根 package.json 的 `resolutions` 里没有这些解析器的 patch 条目\n')
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
