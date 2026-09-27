#!/usr/bin/env node
/**
 * scripts/check-ci-parity.mjs — **本地收尾清单**（第三十三轮 FIX-48⑤）。
 *
 * ## 为什么需要它
 *
 * 本地三件套（`yarn check` / `yarn install --immutable` / Go 的 gofmt+vet+test）覆盖不到
 * CI 判据面的一大块。第三十二轮 AE1 把 `.github/workflows/ci.yml` 的 **9 job / 104 step**
 * 逐条对账（扣除纯基础设施后 60 条语义步）：**A 本地三件套已覆盖 7 条（≈12%）**、
 * B 可补齐且已实跑 13 条（≈22%）、C 可补齐但未实跑 7 条、**D 结构性只能 CI ≈33 条（≈55%）**。
 * 也就是说"三件套全绿"最多只说明 12% 的判据面。本脚本把 B 组里**能真跑**的那几条
 * 收成一条串行命令，让本地收尾有一个可复算的、看得见耗时的判据。
 *
 * ## 口径（三条，刻意写死在这里）
 *
 * 1. **串行**。本仓已有并发构建竞态与 wasm 门禁并发不安全的记录
 *    （第三十二轮 AE1-07：`verify-wasm-client-only.sh` 的证据目录原先按固定路径共享，
 *    两个实例并发会双红 —— 已在 FIX-48③ 里 run-id 化）。收尾清单**自己**不再制造并发。
 * 2. **命令从真源抽，不手抄**。`tar -czf` 的路径集合从 `ci.yml` 的 `Package workspace build
 *    products` 步骤逐字抽；docs-only 分类器从 `changes` job 的 `run:` 块逐字抽
 *    （GitHub 表达式换成 env 变量），再对合成历史真跑 12 格矩阵。手抄一份 = 下一次
 *    CI 改了它就分叉，而分叉的本地判据比没有判据更坏。
 * 3. **不粉饰**：结构性只能 CI 的 ≈55%（Windows/macOS runner、Apple 签名+公证、R2/AWS/gh
 *    凭据、私有渠道仓、tag-only 事件、PR 上下文、job 间 `needs`、制品上传下载面）**不进**
 *    本清单 —— 把它们塞进来只会得到一堆"本地跳过"，那是自欺。差集结论见
 *    `temp/r21/fix-48/REPORT.md` 与 `docs/AUDIT-2026-09-23-FULL.md` §7.72.2。
 *
 * ## 用法
 *
 * ```
 * corepack yarn check:ci-parity          # 全量（约 3 分钟）
 * node scripts/check-ci-parity.mjs --list    # 只列步骤（不跑）
 * ```
 * 退出码：0 = 全部步骤通过；1 = 有步骤失败（日志逐条落在 `temp/ci-parity/<run>/`）。
 *
 * 前置：`yarn check`（或 `yarn prebuild`）跑过一次 —— `tar` 那一步的 15 条路径是
 * **工作区构建产物**；缺产物时它会像 CI 一样直接失败（不静默跳过）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CI_YML = join(ROOT, '.github', 'workflows', 'ci.yml')

// ---------------------------------------------------------------------------
// 真源抽取：ci.yml
// ---------------------------------------------------------------------------

/**
 * 取某个 job 里某一步骤的 `run: |` 块体（逐字，不展开任何 GitHub 表达式）。
 * @param text - `ci.yml` 全文。
 * @param options - `{ job, contains }`：`job` 是 job 名（如 `changes`），
 *   `contains` 用来在 job 内定位那一步（默认取该 job 的第一个 `run: |`）。
 * @returns `{ block, steps }`：块体文本与它前面的 step 名（诊断用）。
 */
function extractRunBlock(text, options) {
  const lines = text.split('\n')
  const jobStart = lines.findIndex(line => new RegExp(`^  ${options.job}:\\s*$`, 'u').test(line))
  if (jobStart < 0) throw new Error(`ci.yml 里找不到 job \`${options.job}\``)
  const blocks = []
  for (let i = jobStart + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^  [A-Za-z_][\w-]*:\s*$/u.test(line)) break // 下一个 job
    const runMatch = /^(\s*)run: \|\s*$/u.exec(line)
    if (runMatch === null) continue
    const indent = runMatch[1].length
    const body = []
    for (let k = i + 1; k < lines.length; k += 1) {
      const inner = lines[k]
      if (inner.trim() !== '' && inner.length - inner.trimStart().length <= indent) break
      body.push(inner.slice(Math.min(indent + 2, inner.length)))
    }
    // 该 step 的名字（向上找最近的 `- name:`；没有就退回 `- id:`；都没有用 `<未命名>`）。
    let name = '<未命名>'
    for (let k = i; k >= jobStart; k -= 1) {
      const named = /^\s*- name: (.+)$/u.exec(lines[k])
      if (named !== null) { name = named[1].trim(); break }
      const identified = /^\s*- id: (.+)$/u.exec(lines[k])
      if (identified !== null && name === '<未命名>') name = `id=${identified[1].trim()}`
    }
    blocks.push({ name, block: body.join('\n') })
  }
  if (blocks.length === 0) throw new Error(`job \`${options.job}\` 里没有 \`run: |\` 块`)
  const wanted = options.contains === undefined
    ? blocks[0]
    : blocks.find(entry => entry.block.includes(options.contains))
  if (wanted === undefined) {
    throw new Error(`job \`${options.job}\` 里找不到含 ${JSON.stringify(options.contains)} 的 \`run: |\` 块`)
  }
  return wanted
}

/**
 * 抽 `Package workspace build products` 的 `tar -czf` 目标路径（逐字）。
 * @param text - `ci.yml` 全文。
 * @returns `{ paths, block }`。
 */
function extractTarPaths(text) {
  const { block } = extractRunBlock(text, { job: 'gate', contains: 'tar -czf workspace-build.tgz' })
  const at = block.indexOf('tar -czf workspace-build.tgz')
  const rest = block.slice(at + 'tar -czf workspace-build.tgz'.length)
  // 反斜杠续行 → 单行；到行尾（不再续行）为止。
  const joined = rest.replace(/\\\n\s*/gu, ' ')
  // 末行的续行反斜杠（块尾没有换行时）会留下一个孤立的 `\` token —— 它不是路径。
  const paths = joined.split(/\s+/u).map(token => token.trim())
    .filter(token => token !== '' && token !== '\\' && !token.startsWith('#'))
  return { paths, block }
}

// ---------------------------------------------------------------------------
// 步骤定义
// ---------------------------------------------------------------------------

/** 结构：`{ id, label, cwd?, cmd, env?, tag }`；`cmd` 一律经 `/bin/bash -c` 跑。 */
function buildSteps() {
  const ciText = readFileSync(CI_YML, 'utf8')
  const tar = extractTarPaths(ciText)
  const classifier = extractRunBlock(ciText, { job: 'changes', contains: 'DOCS_ONLY' })
  const steps = []

  steps.push({
    id: 'docs-only-classifier',
    label: `CI docs-only 分类器（逐字抽出「${classifier.name}」+ 12 格矩阵）`,
    tag: 'CI gate',
    local: () => `node ${JSON.stringify(join(ROOT, 'scripts', 'ci-parity-classifier.mjs'))}`,
  })

  steps.push({
    id: 'workspace-tar',
    label: `CI 的 tar -czf 自检（${tar.paths.length} 条工作区产物路径，逐字抽自 ci.yml）`,
    tag: 'CI gate',
    local: () => `tar -czf "temp/ci-parity-workspace-build.tgz" ${tar.paths.map(p => JSON.stringify(p)).join(' ')}`
      + ' && tar -tzf "temp/ci-parity-workspace-build.tgz" > /dev/null',
  })

  steps.push({
    id: 'deploy-assets',
    label: '部署资产语法（bash -n docker/entrypoint.sh + PG_PASSWORD=ci docker compose config -q）',
    tag: 'CI server',
    cwd: join(ROOT, 'server'),
    local: () => 'bash -n docker/entrypoint.sh && PG_PASSWORD=ci docker compose -f docker-compose.yml config -q',
  })

  steps.push({
    id: 'version-manifests',
    label: 'node scripts/version.mjs manifests',
    tag: 'CI gate/release',
    local: () => 'node scripts/version.mjs manifests',
  })

  // CI 的第一步就是它（`gate` job 的 `Classify the release tag`）。CI 里 GITHUB_REF /
  // GITHUB_REF_NAME 由 runner 注入；本地**没有**它们时它退化成 `release_kind=none`
  // （安全缺省，等于"分支形态"）—— 那样跑等于没跑，所以这里额外把**形态矩阵**跑一遍：
  // 两条 fail-loud（未知后缀 `-hotfix` / 漏 `v` 前缀）正是 K-04 与 R5-C-1 的现场形态，
  // 它们判反的后果是"构建照跑、交付为零、CI 全绿"。
  steps.push({
    id: 'release-policy',
    label: 'bash scripts/ci-release-policy.sh（CI 形态 + 6 格 ref 形态矩阵，含两条 fail-loud）',
    tag: 'CI gate',
    local: () => [
      'set -euo pipefail',
      'bash scripts/ci-release-policy.sh',
      'expect() {',
      '  local out code',
      '  set +e; out="$(GITHUB_REF="$1" GITHUB_REF_NAME="$2" bash scripts/ci-release-policy.sh 2>&1)"; code=$?; set -e',
      '  [ "$code" = "$3" ] || { printf "REF=%s 期望退出码 %s 实得 %s\\n%s\\n" "$2" "$3" "$code" "$out"; return 1; }',
      '  [ "$3" != 0 ] && return 0',
      '  for kv in "release_kind=$4" "channel_set=$5" "publish_release=$6"; do',
      '    printf "%s\\n" "$out" | grep -qx "$kv" || { printf "REF=%s 缺 %s（实得 %s）\\n" "$2" "$kv" "$(printf "%s" "$out" | tr "\\n" " ")"; return 1; }',
      '  done',
      '}',
      'expect refs/heads/main main 0 none official false',
      'expect refs/tags/v9.9.9 v9.9.9 0 stable all true',
      'expect refs/tags/v9.9.9-beta.1 v9.9.9-beta.1 0 prerelease beta true',
      'expect refs/tags/docs-snapshot docs-snapshot 0 none official false',
      'expect refs/tags/v9.9.9-hotfix v9.9.9-hotfix 1',
      'expect refs/tags/9.9.9 9.9.9 1',
      'echo "release-policy 形态矩阵：6/6 ✓（含两条 fail-loud：未知后缀 / 漏 v 前缀）"',
    ].join('\n'),
  })

  // 判据域 = **"工作树逐字节等于 HEAD"**（它防的是 install 期插件/生命周期钩子改写判据本体）。
  // ⇒ 在**未提交**的共享工作树里它必然红（那不是缺陷，是这条判据的定义域）。所以本步骤先把
  // 当前工作树做成一个**自洽仓库副本**（`git archive HEAD` + 工作树的改动/新增文件 +
  // `git init && git add -A && git commit`），在副本里跑同一条命令 —— 判据①②③④ 于是真的
  // 被求值（yarnrc 禁键 / `.yarn/plugins` 与 `.yarn/releases` 两侧为空 / 未登记的生命周期钩子 /
  // 执行体全集逐字节），而不是"本地跳过"。主树一字不动（副本在 `temp/` 下）。
  steps.push({
    id: 'install-integrity',
    label: 'node scripts/check-install-integrity.mjs（在「工作树的自洽副本」里跑；判据域=工作树==HEAD）',
    tag: 'CI gate-guards',
    prepare: () => prepareSelfConsistentCopy(),
    local: () => 'node scripts/check-install-integrity.mjs',
  })

  steps.push({
    id: 'guard-parser-integrity',
    label: 'node scripts/check-guard-parser-integrity.mjs（不带 --require-clean，同 CI）',
    tag: 'CI gate-guards',
    local: () => 'node scripts/check-guard-parser-integrity.mjs',
  })

  steps.push({
    id: 'frozen-launchers',
    label: 'node scripts/check-frozen-launchers.mjs',
    tag: 'CI gate',
    local: () => 'node scripts/check-frozen-launchers.mjs',
  })

  // FIX-47② 的守卫住在 webadmin 里（`server/webadmin` 的 vitest 套件），本地三件套**不跑它**
  // ⇒ 不放进本清单的话，"webadmin 的判据在本地根本没有门禁"。
  steps.push({
    id: 'webadmin-npm-test',
    label: 'cd server/webadmin && npm test（FIX-47② 的守卫在这里）',
    tag: 'CI server',
    cwd: join(ROOT, 'server', 'webadmin'),
    local: () => 'npm test',
  })

  // `make build-server`：CI server job 的最后一步。
  // **必须显式给 GOCACHE/GOMODCACHE** —— 本沙箱 `/root/.cache/go-build` 是只读的，
  // 缺省值会以 `mkdir /root/.cache/go-build: read-only file system` 直接失败
  // （与代码无关的假红）。缺省指到仓内缓存（与 wasm 门禁的 repo 模式同一对目录）。
  steps.push({
    id: 'make-build-server',
    label: 'make build-server（显式 GOCACHE/GOMODCACHE = 仓内缓存）',
    tag: 'CI server',
    cwd: join(ROOT, 'server'),
    env: {
      GOCACHE: process.env.CI_PARITY_GOCACHE ?? join(ROOT, 'temp', 'go-build'),
      GOMODCACHE: process.env.CI_PARITY_GOMODCACHE ?? join(ROOT, 'temp', 'gomodcache'),
      GOFLAGS: process.env.CI_PARITY_GOFLAGS ?? '-mod=mod',
    },
    local: () => 'make build-server',
  })

  return { steps, tar, classifier }
}

/**
 * 把**当前工作树**做成一个自洽的 git 仓库副本（`temp/ci-parity/self-consistent/`）并返回它。
 *
 * 为什么需要：`check-install-integrity.mjs` 的判据域是"工作树逐字节等于 HEAD"——
 * 本地未提交的工作树里它必然红，而"必然红"的步骤留在清单里就是噪声（本仓反复吃过
 * "假红导致判据被关掉"的教训）。副本里 HEAD 就是当前内容 ⇒ 判据真的被求值。
 * @returns {string} 副本目录（供该步骤当 cwd）。
 */
function prepareSelfConsistentCopy() {
  const dest = join(ROOT, 'temp', 'ci-parity', 'self-consistent')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const sh = (cmd, cwd) => {
    const result = spawnSync('/bin/bash', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`自洽副本准备失败：${cmd}\n${result.stderr ?? ''}`)
    return result.stdout ?? ''
  }
  // 1) HEAD 的跟踪文件；2) 工作树的改动与新增（保持逐字，含未跟踪的新脚本）。
  sh(`git archive HEAD | tar -x -C ${JSON.stringify(dest)}`, ROOT)
  // 跟踪文件的改动（含删除）+ 未跟踪的新文件：**逐字**搬过去，副本才等于工作树。
  const status = sh('git diff --name-status HEAD', ROOT).split('\n').map(line => line.trim()).filter(Boolean)
  const others = sh('git ls-files --others --exclude-standard', ROOT).split('\n').map(line => line.trim()).filter(Boolean)
  for (const line of status) {
    const [kind, ...rest] = line.split(/\t/u)
    const rel = rest.at(-1) ?? ''
    if (rel === '') continue
    const from = join(ROOT, rel)
    const to = join(dest, rel)
    if (kind.startsWith('D')) { rmSync(to, { recursive: true, force: true }); continue }
    if (!existsSync(from)) continue
    spawnSync('/bin/bash', ['-c', `mkdir -p ${JSON.stringify(dirname(to))} && cp -a ${JSON.stringify(from)} ${JSON.stringify(to)}`], { cwd: ROOT })
  }
  for (const rel of others) {
    const from = join(ROOT, rel)
    if (!existsSync(from)) continue
    const to = join(dest, rel)
    spawnSync('/bin/bash', ['-c', `mkdir -p ${JSON.stringify(dirname(to))} && cp -a ${JSON.stringify(from)} ${JSON.stringify(to)}`], { cwd: ROOT })
  }
  // 3) 让副本自洽：HEAD == 工作树（这就是那条判据的输入面）。
  sh('git init -q -b main . && git config user.email ci-parity@example.invalid'
    + ' && git config user.name "ci parity" && git add -A && git commit -qm "ci-parity snapshot"', dest)
  return dest
}

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const { steps, tar, classifier } = buildSteps()

if (argv.includes('--list')) {
  console.log(`check-ci-parity: ${steps.length} 步（串行）`)
  for (const [index, step] of steps.entries()) {
    console.log(`  ${String(index + 1).padStart(2)}. [${step.tag}] ${step.label}`)
  }
  console.log(`\ntar 路径（逐字抽自 ci.yml，${tar.paths.length} 条）：`)
  for (const path of tar.paths) console.log(`  · ${path}`)
  console.log(`\ndocs-only 分类器（逐字抽自 ci.yml 的「${classifier.name}」，${classifier.block.split('\n').length} 行）：`)
  console.log(classifier.block.split('\n').map(line => `  | ${line}`).join('\n'))
  process.exit(0)
}

const runStamp = new Date().toISOString().replace(/[:.]/gu, '-')
const LOG_DIR = join(ROOT, 'temp', 'ci-parity', runStamp)
mkdirSync(LOG_DIR, { recursive: true })

// 分类器那一格需要「当前 ci.yml 的分类器正文」与一个合成 git 仓库；把两者都落盘，
// 让判据可复算（而不是把 12 格结论直接写进脚本）。
const EXTRACT_DIR = join(ROOT, 'temp', 'ci-parity', 'extracted')
mkdirSync(EXTRACT_DIR, { recursive: true })
const classifierPath = join(EXTRACT_DIR, 'ci-changes-scope.sh')
writeFileSync(
  classifierPath,
  `#!/usr/bin/env bash\n# 由 scripts/check-ci-parity.mjs 从 .github/workflows/ci.yml 的`
  + `「${classifier.name}」步骤逐字抽出（GitHub 表达式已换成 env 变量）。\n`
  + classifier.block.replace(/\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/gu, '${BASE_SHA}')
    .replace(/\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/gu, '${HEAD_SHA}')
    .replace(/\$\{\{\s*github\.event\.before\s*\}\}/gu, '${BEFORE_SHA}')
  + '\n',
  { mode: 0o755 },
)
if (/\$\{\{/u.test(readFileSync(classifierPath, 'utf8'))) {
  throw new Error('docs-only 分类器里还有没替换掉的 GitHub 表达式 —— 抽取口径要同步')
}

console.log(`check-ci-parity: 本地收尾清单（${steps.length} 步，**串行**）`)
console.log(`日志目录：${LOG_DIR.replace(`${ROOT}/`, '')}`)
console.log(`tar 路径 ${tar.paths.length} 条 / 分类器 ${classifier.block.split('\n').length} 行（两者都逐字抽自 ci.yml）`)
console.log('')

const results = []
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.label}`
  const logFile = join(LOG_DIR, `${step.id}.log`)
  const started = Date.now()
  process.stdout.write(`${label} … `)
  const prepared = step.prepare === undefined ? undefined : step.prepare()
  const result = spawnSync('/bin/bash', ['-c', step.local()], {
    cwd: prepared ?? step.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    env: { ...process.env, ...(step.env ?? {}) },
  })
  const seconds = (Date.now() - started) / 1000
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(logFile, `$ ${step.local()}\n（cwd=${prepared ?? step.cwd ?? ROOT}）\n（env 追加=${JSON.stringify(step.env ?? {})}）\n`
    + `（exit=${String(result.status)}，${seconds.toFixed(1)}s）\n\n${output}`)
  const ok = result.status === 0
  results.push({ ...step, ok, seconds, logFile, output, status: result.status })
  console.log(ok ? `PASS（${seconds.toFixed(1)}s）` : `FAIL（exit=${String(result.status)}，${seconds.toFixed(1)}s）`)
  if (!ok) {
    const tail = output.trim().split('\n').slice(-25)
    console.log(tail.map(line => `      ${line}`).join('\n'))
    console.log(`      （完整日志：${logFile.replace(`${ROOT}/`, '')}）`)
  }
}

const total = results.reduce((sum, entry) => sum + entry.seconds, 0)
console.log('')
console.log('| # | 步骤 | 归属 CI job | 退出码 | 耗时(s) |')
console.log('|---|---|---|---|---|')
for (const [index, entry] of results.entries()) {
  console.log(`| ${index + 1} | ${entry.label} | ${entry.tag} | ${entry.ok ? '0' : String(entry.status)} | ${entry.seconds.toFixed(1)} |`)
}
console.log('')
const failed = results.filter(entry => !entry.ok)
console.log(`check-ci-parity: ${results.length - failed.length}/${results.length} 通过，合计 ${total.toFixed(1)}s`
  + `（串行；日志 ${LOG_DIR.replace(`${ROOT}/`, '')}）`)
if (failed.length > 0) {
  console.log(`失败步骤：${failed.map(entry => entry.id).join(', ')}`)
  process.exit(1)
}
// 结构上只能 CI 的部分**刻意不在这里**（塞进来只会得到一堆"本地跳过"）：
// Windows/macOS runner、Apple 签名 + 公证、R2/AWS/gh 凭据、私有渠道仓、tag-only 事件、
// PR 上下文、job 间 needs、制品上传下载面。差集结论见 docs/AUDIT-2026-09-23-FULL.md §7.72.2。
console.log('check-ci-parity: VERDICT PASS —— 本地可补齐的判据面全部通过'
  + '（结构上只能 CI 的 ≈55% 见 docs/AUDIT-2026-09-23-FULL.md §7.72.2，本清单不假装覆盖）')
