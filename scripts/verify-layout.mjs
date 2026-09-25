import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const fail = message => { throw new Error(`verify-layout: ${message}`) }

const workspace = readJson('package.json')
const upstream = readJson('upstream.json')
const plugin = readJson('packages/host/desktop/package.json')
const enterprise = readJson('packages/host/enterprise/package.json')
const connectors = readJson('packages/host/connectors/package.json')
const browser = readJson('packages/host/browser/package.json')
const fabric = readJson('community/fabric/package.json')
const upstreamPackage = readJson('deepseek-harness/package.json')
const noteDirectory = '.agents/notes/implemented/process'
const noteName = '2026-08-15-pinned-upstream-and-isolated-yarn-workspace'
const notePaths = [`${noteDirectory}/${noteName}.md`, `${noteDirectory}/${noteName}.zh.md`]
const noteRecordPath = `${noteDirectory}/${noteName}.i18n.yaml`

if (workspace.packageManager !== 'yarn@4.18.0') {
  fail('the product workspace must pin yarn@4.18.0')
}

// Workspace topology is self-describing: the root workspaces list is the
// single source of truth. Every member must exist, be a valid package, and
// carry a name whose final segment matches its directory basename (this
// admits both flat members like `dsh-community-fabric` and scoped members
// like `plugins/dsh-enterprise` -> `@picoaide/dsh-enterprise`). The member
// directory set is **derived by expanding the root `workspaces` globs** —
// not by a hardcoded directory scan.
//
// ## 为什么必须按 glob 派生（R18A-G-02，2026-09-25）
//
// 修前这里是 `collectWorkspaceMembers('packages', 1)` / `('community', 1)`
// 的**硬编码目录扫描**，而同一段注释却自称"glob 是唯一真源"。后果：判据的
// **文件集**与 Yarn 实际认的成员集可以分叉 —— 往根 `workspaces` 里加一条
// 新 glob（`tools/*`、`apps/*`…）之后，那个新成员的 manifest 无论多不
// 规范（会被 `yarn install` 重新序列化 ⇒ 门禁在 install 之后误判"执行体
// 被改写"）都判不到，守卫照旧 EXIT=0。现在文件集直接来自 glob：**新增一个
// workspace 成员即被纳入**，与 `scripts/check-workspaces.mjs` 和 Yarn 自己
// 的口径同一份真源。
if (!Array.isArray(workspace.workspaces) || workspace.workspaces.length === 0) {
  fail('the root Yarn workspace must declare a non-empty workspaces list')
}
const packageGlob = 'packages/*/*'
const communityGlob = 'community/*'
if (!workspace.workspaces.includes(packageGlob) || !workspace.workspaces.includes(communityGlob)) {
  fail('the root Yarn workspace must declare both packages/*/* and community/*')
}
// Package naming keeps the published npm name stable while the workspace
// directory is organized by role. This directory-to-name table is the single
// authoritative mapping: every workspace member directory must appear here
// with exactly the package name it owns. Member directories are allowed to
// drop the `dsh-` prefix or rename the role segment (e.g. `desktop` owns
// `dsh-plugin-desktop`), so the old "name tail equals directory basename"
// check is replaced by table membership.
const packageNameTable = new Map([
  ['packages/host/desktop', 'dsh-plugin-desktop'],
  ['packages/host/enterprise', '@picoaide/dsh-enterprise'],
  ['packages/host/connectors', '@picoaide/dsh-connectors'],
  ['packages/host/browser', '@picoaide/dsh-browser'],
  // 2026-09-20（构建环修复，路线 A / A 扩展）：宿主侧共享工具的**两个零依赖
  // 叶子包**。目录名与包名都跟角色走（host-locale / host-home ↔
  // @picoaide/dsh-host-*），严格按本表比对。
  ['packages/host/host-locale', '@picoaide/dsh-host-locale'],
  ['packages/host/host-home', '@picoaide/dsh-host-home'],
  ['packages/host/wasm-apps-host', '@picoaide/dsh-wasm-apps-host'],
  ['packages/host/cron', '@picoaide/dsh-cron'],
  ['packages/client/account-card', '@picoaide/dsh-account-card'],
  ['packages/client/branding', '@picoaide/dsh-branding'],
  ['packages/client/wasm-apps', '@picoaide/dsh-wasm-apps'],
  // 2026-09-20：四个客户端面板（定时任务 / 能力中心 / 连接器 / 应用中心）共用的
  // **中列整页装载器 + 视觉语言**叶子包（零 `@picoaide/*` 依赖，被消费方的 client
  // bundle 内联）—— 它替掉了"cron 自持 DOM 装载 + 其余三个各写一套模态"的分叉。
  ['packages/client/panel-surface', '@picoaide/dsh-panel-surface'],
  // 2026-09-21：侧边栏底部**并道行** —— 一个「更多」行 + 向上浮层，条目经客户端
  // Cordis 服务 `picoFootMenu` 从五个面板插件收集（它们不再各自注册一整行）。
  ['packages/client/foot-menu', '@picoaide/dsh-foot-menu'],
  ['packages/vendor/memory-evolve', 'dsh-memory-evolve'],
  ['community/fabric', 'dsh-community-fabric'],
])
const nameForPath = dir => packageNameTable.get(dir)
/**
 * 展开一条根 `workspaces` glob → 匹配到的**目录**（POSIX 相对路径，已排序）。
 *
 * 只支持 glob 在本仓真正用到的形态：`*` 段（单层通配）与字面量段。`**` 也实现
 * （递归），这样将来加一条 `packages/**` 之类的写法不会静默退化成"匹配不到任何成员"
 * —— 匹配不到是 fail-loud 的（见下面的 `memberCount` 对账）。
 *
 * 不引入 glob 依赖：本判据的输入面是**仓内目录树本身**，用 `readdirSync` 逐段展开
 * 既是最小实现，也避免"解析器可被 resolutions 改写"这一类问题（见
 * `scripts/check-guard-parser-integrity.mjs` 的 C-17）。
 * @param pattern - 根 `workspaces` 里的一条模式。
 * @returns 匹配目录的仓库相对路径（升序、去重）。
 */
const expandWorkspaceGlob = pattern => {
  const walk = (base, segments) => {
    if (segments.length === 0) return [base]
    const [segment, ...rest] = segments
    if (segment === '') return walk(base, rest)
    if (segment === '**') {
      const out = walk(base, rest)
      for (const name of readDirectoryNames(base)) {
        out.push(...walk(base === '' ? name : `${base}/${name}`, segments))
      }
      return out
    }
    if (segment === '*') {
      return readDirectoryNames(base).flatMap(name => walk(base === '' ? name : `${base}/${name}`, rest))
    }
    const next = base === '' ? segment : `${base}/${segment}`
    if (!existsSync(resolve(root, next))) fail(`workspace glob ${pattern} 的路径段 ${next} 不存在`)
    return walk(next, rest)
  }
  return [...new Set(walk('', pattern.split('/').filter(Boolean)))].sort()
}
/**
 * 读一个目录下的**子目录名**（跳过 `node_modules` 与隐藏目录）。
 * @param base - 仓库相对目录（`''` = 仓根）；不存在时返回空表（由调用方的对账兜底）。
 * @returns 子目录名列表。
 */
function readDirectoryNames(base) {
  const target = base === '' ? root : resolve(root, base)
  let names
  try {
    names = readdirSync(target)
  } catch {
    return []
  }
  return names.filter(name => name !== 'node_modules' && !name.startsWith('.')).filter((name) => {
    try {
      return lstatSync(resolve(target, name)).isDirectory()
    } catch {
      return false
    }
  })
}
const workspaceDirs = []
const workspaceManifests = new Map()
for (const pattern of workspace.workspaces) {
  if (typeof pattern !== 'string' || pattern === '') {
    fail(`根 workspaces 里出现了非字符串/空模式：${JSON.stringify(pattern)} —— 判据的文件集由它派生，读不懂即红`)
  }
  for (const dir of expandWorkspaceGlob(pattern)) {
    if (!existsSync(resolve(root, dir, 'package.json'))) continue
    const manifest = readJson(`${dir}/package.json`)
    const expected = nameForPath(dir)
    if (expected !== manifest.name) {
      fail(`workspace member ${dir} must own ${expected ?? '<declared in packageNameTable>'} (got ${manifest.name ?? 'missing'})`
        + ` —— 它是根 workspaces 的 \`${pattern}\` 匹配到的成员，所以**必须**同时登记进 packageNameTable`
        + '（判据的文件集按 glob 派生：新成员不进表就既不校验名字也不校验 manifest 形态）')
    }
    workspaceManifests.set(manifest.name, manifest)
    workspaceDirs.push(dir)
  }
}
if (workspaceDirs.length === 0) {
  fail('the workspace tree must contain at least one package')
}
// 反向（死条目）：名字表里的每一条都必须仍然是 glob 匹配到的成员 —— 成员被删/被搬走
// 之后，这条映射就成了"说自己还在看着一个不存在的包"。
for (const dir of packageNameTable.keys()) {
  if (!workspaceDirs.includes(dir)) {
    fail(`packageNameTable 里的 ${dir} 不再是根 workspaces 匹配到的成员 ——`
      + ' 死条目会让这张表看起来比实际宽，请在改掉目录/glob 时同步删掉它')
  }
}
for (const [name, manifest] of workspaceManifests) {
  if (manifest.packageManager !== undefined) fail(`${name} must inherit the root Yarn release`)
}
const claudePath = resolve(root, 'CLAUDE.md')
const claudeStat = lstatSync(claudePath)
// Windows checkouts materialize the symlink as a regular file holding the
// target name; accept both forms so the pointer stays verified on every host.
const claudeTarget = claudeStat.isSymbolicLink()
  ? readlinkSync(claudePath)
  : readFileSync(claudePath, 'utf8').trim()
if (claudeTarget !== 'AGENTS.md') {
  fail('CLAUDE.md must link to the outer repository AGENTS.md')
}
for (const legacyFile of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/host/desktop/pnpm-lock.yaml',
  'packages/host/desktop/pnpm-workspace.yaml',
  'community/fabric/pnpm-lock.yaml',
  'community/fabric/pnpm-workspace.yaml',
]) {
  if (existsSync(resolve(root, legacyFile))) fail(`${legacyFile} must not exist`)
}
if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.deepseek-harness.path']) !== 'deepseek-harness') {
  fail('the upstream submodule path must be deepseek-harness')
}
if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.deepseek-harness.url']) !== upstream.repository) {
  fail('the upstream submodule URL differs from upstream.json')
}
if (typeof upstreamPackage.packageManager !== 'string' || !upstreamPackage.packageManager.startsWith('pnpm@')) {
  fail('the upstream checkout must retain its pnpm package manager')
}

for (const [owner, manifest] of [
  ['root', workspace],
  ['desktop', plugin],
  ['enterprise', enterprise],
  ['connectors', connectors],
  ['browser', browser],
  ['fabric', fabric],
]) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range !== 'string') continue
      if (/^(?:portal|link):/u.test(range)
        || (range.startsWith('file:') && range.includes('deepseek-harness'))) {
        fail(`${owner} ${field}.${name} bypasses the published DSH package boundary`)
      }
    }
  }
}

const [mode, object] = run('git', ['ls-files', '--stage', '--', 'deepseek-harness']).split(/\s+/u)
if (mode !== '160000') fail('deepseek-harness must be tracked as a Git submodule')
if (object !== upstream.commit) fail(`submodule index is ${object}, expected ${upstream.commit}`)

const upstreamDir = resolve(root, 'deepseek-harness')
if (run('git', ['rev-parse', 'HEAD'], upstreamDir) !== upstream.commit) {
  fail('checked-out upstream commit differs from upstream.json')
}
if (run('git', ['status', '--porcelain'], upstreamDir) !== '') {
  fail('deepseek-harness contains local changes')
}
if (run('git', ['remote', 'get-url', 'origin'], upstreamDir) !== upstream.repository) {
  fail('deepseek-harness origin differs from upstream.json')
}
if (upstreamPackage.version !== upstream.sourceVersion) {
  fail('deepseek-harness package version differs from upstream.json')
}
for (const [owner, manifest] of [['plugin', plugin], ['enterprise', enterprise], ['connectors', connectors], ['browser', browser]]) {
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) }
  for (const name of Object.keys(deps).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) {
    if (deps[name] !== upstream.runtimePackageVersion) {
      fail(`${owner} ${name} must use the recorded DSH runtime package family`)
    }
  }
}

const noteRecord = readFileSync(resolve(root, noteRecordPath), 'utf8')
for (const notePath of notePaths) {
  // Hash the committed blob, not the working tree: checkout line endings
  // differ per host, while HEAD:<path> is identical everywhere.
  const expected = run('git', ['rev-parse', `HEAD:${notePath}`])
  const recordLine = `${basename(notePath)}: ${expected}`
  if (!noteRecord.split(/\r?\n/u).includes(recordLine)) {
    fail(`${noteRecordPath} is stale for ${notePath}`)
  }
}

const readmeRecord = readFileSync(resolve(root, 'README.i18n.yaml'), 'utf8')
for (const readmeName of ['README.md', 'README.en.md']) {
  const expected = run('git', ['rev-parse', `HEAD:${readmeName}`])
  const recordLine = `${readmeName}: ${expected}`
  if (!readmeRecord.split(/\r?\n/u).includes(recordLine)) {
    fail(`README.i18n.yaml is stale for ${readmeName}`)
  }
}

// workspace manifest 必须是 **Yarn 会原样保留的形态**。
//
// 为什么需要这条（2026-09-25 第十六轮的真实 CI 红）：`yarn install --immutable` 会把
// Yarn **会重新序列化**的 manifest 写回磁盘（实测：一处 `exports` 子块缩进少了两格 ⇒
// install 后整个文件被改写）。于是同一次 CI 里 —— ①"判据执行体有没有被 install 期改写"的
// 前置校验在 install **之后**跑，会看到 `工作树 ≠ HEAD` 并把这次**规范化**当成"载荷改写了
// 执行体"判红；②失败信息指向"install 期有人动了判据"，而不是"你的 manifest 不是 Yarn 会
// 保留的形态"，排查成本极高。这条判据把同一类问题**提前到 install 之前**并给出可操作原因。
//
// ## 判据 = Yarn 4.18.0 自己的判据（R18A-G-01 的收口）
//
// 修前这里是 `raw !== JSON.stringify(JSON.parse(raw), null, 2) + '\n'`，把**4 空格缩进 /
// Tab 缩进 / CRLF** 这三种**合法且 Yarn 不会改写**的形态判红，并在消息里给出"跑一次
// `yarn install` 提交被改写的文件"这种**空操作**修法（照做永远绿不了）。
//
// 现在按 Yarn 的真实实现建模（`.yarn/releases` 那份 4.18.0 bundle 的
// `Manifest.loadFromText` / `persistManifest` / `xfs.changeFileTextPromise`）：
//   · **缩进单位取自文件本身**：`text.match(/^[ \t]+/m)` 的首个匹配（缺省 `'  '`）；
//   · **换行风格取自文件本身**：`automaticNewlines` 把新内容的每个 `\r?\n` 换成
//     原文第一个换行（`convertNewlines`）；
//   · 其余必须等于 `JSON.stringify(parsed, null, <该缩进>)`：`": "` 分隔符、无空行、
//     无尾随空白、末尾恰好一个换行。
// 于是"4 空格 / Tab / CRLF 不改写、紧凑冒号 / 缺末尾换行 / 尾随空行 / 子块缩进错位要改写"
// 这四条实测结论与判据逐条对上（见下面的自证表 `YARN_MANIFEST_FORM_CASES`）。
/**
 * Yarn 4 的缩进探测（`Manifest.loadFromText` 逐字同形）。
 * @param raw - manifest 原文。
 * @returns 缩进单位（缺省两个空格）。
 */
const yarnManifestIndent = raw => /^[ \t]+/mu.exec(raw)?.[0] ?? '  '
/**
 * Yarn 4 的换行探测（`convertNewlines` 取原文第一个换行）。
 * @param raw - manifest 原文。
 * @returns `'\r\n'` 或 `'\n'`。
 */
const yarnManifestNewline = raw => /\r?\n/u.exec(raw)?.[0] ?? '\n'
/**
 * Yarn 4 写完之后的**期望字节**。
 * @param raw - manifest 原文（只用来探测缩进与换行）。
 * @returns Yarn 会写出的文本。
 */
const yarnManifestCanonical = raw => {
  const indent = yarnManifestIndent(raw)
  const newline = yarnManifestNewline(raw)
  return `${JSON.stringify(JSON.parse(raw), null, indent)}\n`.replace(/\r?\n/gu, newline)
}
/**
 * 判据自身的**形态自证**：三种"合法且 Yarn 不改写"的形态必须放行，四种"Yarn 会改写"的
 * 形态必须判红。表里的期望值是 2026-09-25 审计用合成工程实测 corepack yarn 4.18.0
 * `install --immutable` 的 `rewritten` 结果（留痕 `temp/r18/A/artifacts/out-yarn-rewrite*.txt`），
 * 并与上面从 4.18.0 bundle 读出的实现逐条一致。
 */
const YARN_MANIFEST_FORM_CASES = [
  ['规范形态（两空格 + LF + 末尾一个换行）', 'pass', '{\n  "name": "x",\n  "version": "0.0.0-use.local",\n  "private": true\n}\n'],
  // R18A-G-01 的三种**放行**用例：合法 JSON，且 yarn 4.18.0 实测 `rewritten=false`。
  ['4 空格缩进（合法 JSON，Yarn 保缩进 ⇒ 不改写）', 'pass', '{\n    "name": "x",\n    "version": "0.0.0-use.local",\n    "private": true\n}\n'],
  ['Tab 缩进（合法 JSON，Yarn 保缩进 ⇒ 不改写）', 'pass', '{\n\t"name": "x",\n\t"version": "0.0.0-use.local",\n\t"private": true\n}\n'],
  ['CRLF（合法 JSON，Yarn 保换行风格 ⇒ 不改写）', 'pass', '{\r\n  "name": "x",\r\n  "version": "0.0.0-use.local",\r\n  "private": true\r\n}\r\n'],
  ['紧凑冒号（Yarn 用 `": "` 重排 ⇒ 改写）', 'rewrite', '{\n  "name":"x",\n  "version":"0.0.0-use.local",\n  "private":true\n}\n'],
  ['缺末尾换行（Yarn 补一个 ⇒ 改写）', 'rewrite', '{\n  "name": "x",\n  "version": "0.0.0-use.local",\n  "private": true\n}'],
  ['尾随空行（Yarn 去掉 ⇒ 改写）', 'rewrite', '{\n  "name": "x",\n  "version": "0.0.0-use.local",\n  "private": true\n}\n\n'],
  ['子块缩进少两格（Yarn 按探测到的缩进重排 ⇒ 改写）', 'rewrite', '{\n  "name": "x",\n  "exports": {\n    ".": "./lib/index.js"\n}\n}\n'],
]
for (const [label, expected, sample] of YARN_MANIFEST_FORM_CASES) {
  const canonical = yarnManifestCanonical(sample) === sample
  if (canonical !== (expected === 'pass')) {
    fail(`判据自身自证失败：形态「${label}」被判成 ${canonical ? 'pass' : 'rewrite'}，`
      + `而 yarn 4.18.0 的实测结论是 ${expected} —— 规范形态判据与 Yarn 的实现分叉了`
      + '（放行面/判红面都必须与 Yarn 逐条一致，否则要么误报、要么放过真会被改写的 manifest）')
  }
}
const nonCanonicalManifests = []
for (const manifestPath of ['package.json', ...workspaceDirs.map(dir => `${dir}/package.json`)]) {
  const raw = readFileSync(resolve(root, manifestPath), 'utf8')
  if (yarnManifestCanonical(raw) !== raw) nonCanonicalManifests.push(manifestPath)
}
if (nonCanonicalManifests.length > 0) {
  fail(`这些 manifest 不是 Yarn 会**原样保留**的形态：${nonCanonicalManifests.join('、')} ——`
    + '`yarn install` 会重新序列化它们（缩进单位取文件首个缩进行的前导空白、换行风格取文件首个换行，'
    + '其余必须等于 `JSON.stringify(parsed, null, <该缩进>)`：`": "` 分隔符、无空行/无尾随空白、'
    + '末尾恰好一个换行），使工作树与 HEAD 不一致，进而让 install 之后的判据锚把这次**规范化**'
    + '误判成"判据执行体被改写"（CI 必红且信息误导）。'
    + '修法：按当前缩进与换行风格把该文件重排成 `JSON.stringify(parsed, null, <缩进>)` 的形态'
    + '（等价于跑一次 `yarn install` 并提交**被改写**的文件）。注意：4 空格缩进 / Tab / CRLF '
    + '本身是 Yarn 保留的形态，不需要、也不会因为跑 install 而变化。')
}

process.stdout.write(`verify-layout: Yarn workspace and upstream ${upstream.commit.slice(0, 10)} are consistent\n`)
