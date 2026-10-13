#!/usr/bin/env node
/**
 * 变体矩阵判据（P1 第一片，2026-10-14）。
 *
 * ## 它判什么
 *
 * 对**每一种可选模块组合**各跑一次全仓编译，让"关掉某个模块"这种构建形态至少存在一条
 * 可执行的判据。组合与包树边界（模块树定义见下面的 `MODULE_TREES`，与决策记录
 * `docs/decisions/2026-10-14-server-build-tags.md` §2 同一份口径）：
 *
 *   | 变体标识（= `features_variant`） | `-tags=`                 | 期望被裁掉的模块树 |
 *   |----------------------------------|--------------------------|--------------------|
 *   | `skills,apps,connectors`         | `skills,apps,connectors` | （基线：三个树都必须**在**） |
 *   | `none`                           | ``（空 = 一个都不开）    | skills / apps / connectors |
 *   | `skills`                         | `skills`                 | apps / connectors |
 *   | `apps`                           | `apps`                   | skills / connectors |
 *   | `skills,apps`                    | `skills,apps`            | connectors |
 *
 * 变体标识**逐字取自渠道契约**（`packages/host/desktop/scripts/channel-constants.ts` 的
 * `channelFeaturesVariant()`：`skills,apps,connectors` / `apps` / `none`）—— 判据用的是
 * 与发布链同一个串，而不是这里另起一套组合名，见
 * docs/decisions/2026-10-13-channel-feature-modules.md §5「三处只能读同一个串」。
 *
 * 每一步都判两件事：
 *   ① **编译面**：`go build -tags=<组合> ./...`（缺省再加一次 `go vet …`）必须成功 ——
 *      每一种组合都得编得过，否则"支持变体"就是空话；
 *   ② **依赖面**：`go list -deps -tags=<组合> ./cmd/server` 里，**开着的**模块包树必须
 *      在，**关掉的**模块包树必须不在。
 *
 * ## ⚠️ 第二片接线前，② 里"关掉的那一半"必然不成立
 *
 * 本片（P1 第一片）只做 tag 接线与判据，**不做**真正的裁剪：`internal/features` 已经
 * 如实报告开关状态，但没有任何包按 `features.Has*()` 做条件编译，所以关掉模块时
 * `internal/wasmapp/**` / `internal/{marketplace,sharedskills,agentshare,capabilities}` /
 * `internal/connectors` 照样进二进制。"包树消失"因此**现在必然失败**。
 *
 * 这条判据刻意写成**显式的预期失败标记**，而不是现在就红的门禁：
 *   · 缺省（不带 `--expect-cut`）= 裁剪断言只**报告**，不影响退出码；
 *   · `--expect-cut` = 裁剪断言变成拦门禁 —— **P1 第二片把条件化编译接上线之后**，
 *     第二片应当把本开关写进它自己的调用点（`make check-tags TAGS_ARGS=--expect-cut`，
 *     或升格进 `yarn check` / CI）。在此之前它必然红，红了才是判据还活着。
 *
 * 判据"明知现在不成立"也要留在这里的理由：它是第二片的**验收面**。没有它，第二片的
 * 验收只剩"我改了代码"，而"包树真的消失了"这件事没人量。
 *
 * ## 用法
 *
 * ```bash
 * node server/scripts/check-go-build-tags.mjs                    # 全部组合，裁剪断言只报告
 * node server/scripts/check-go-build-tags.mjs --no-vet            # 不跑 go vet（快一点）
 * node server/scripts/check-go-build-tags.mjs --only=apps        # 只跑一个组合
 * node server/scripts/check-go-build-tags.mjs --expect-cut        # 裁剪断言转为拦门禁
 * node server/scripts/check-go-build-tags.mjs --expect-cut=apps   # 探针：对所有组合都套
 *                                                                # "apps 应被裁掉"，必红
 * node server/scripts/check-go-build-tags.mjs --self-test         # 只自证判据引擎（不碰 go）
 * make -C server check-tags                                      # 等价入口
 * ```
 *
 * 退出码：0 = 通过；1 = 有断言失败；2 = 用法/参数/基线前提错误（**不是**"通过"）。
 *
 * ## 判据自身的诚实边界（认账）
 *
 *   · 它只证明"这个组合编得过 + 包树在不在"，**不证明**运行时行为对不对（裁剪后的
 *     路由/接口面由各自的包级用例与 `server/internal/serverstore` 的表面判据负责）。
 *   · 包树边界是**人工登记**的（下面的 `MODULE_TREES`）：包改名/新增包而这里没跟上
 *     ⇒ 判据会红在"基线前提"那一条（`all` 组合里树必须在），不会静默变空。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(SCRIPT_DIR, '..')

/** 模块 → 该模块的包树（仓库内 `server/` 相对路径前缀）。与决策记录 §2 同源。 */
const MODULE_TREES = {
  skills: [
    'internal/marketplace',
    'internal/sharedskills',
    'internal/agentshare',
    'internal/capabilities',
  ],
  apps: ['internal/wasmapp'],
  connectors: ['internal/connectors'],
}

/** 模块名的规范顺序（与 `internal/features` 的 AllModules 一致）。 */
const MODULES = ['skills', 'apps', 'connectors']

/**
 * 变体矩阵。`variant` = 渠道契约里的 `features_variant` 字面量（同时就是 `--only=` 的取值），
 * `tags` = 传给 `-tags=` 的那串（`none` ⇒ 空串），`cut` = 该组合下**应当被裁掉**的模块。
 * 顺序即执行顺序：基线先跑，后面才有"基线成立"的参照。
 */
const COMBOS = [
  { variant: 'skills,apps,connectors', tags: 'skills,apps,connectors', cut: [], baseline: true },
  { variant: 'none', tags: '', cut: ['skills', 'apps', 'connectors'] },
  { variant: 'skills', tags: 'skills', cut: ['apps', 'connectors'] },
  { variant: 'apps', tags: 'apps', cut: ['skills', 'connectors'] },
  { variant: 'skills,apps', tags: 'skills,apps', cut: ['connectors'] },
]

/** 模块前缀（`go.mod` 的 module 行）——`go list` 输出的是完整 import path。 */
const MODULE_PATH = 'github.com/picoaide/picoaide'

class UsageError extends Error {}

/** 解析参数。未知参数一律 fail-loud（exit 2），绝不"看不懂就当没传"。 */
function parseArgs(argv) {
  const options = { only: null, vet: true, expectCut: false, cutOverride: null, selfTest: false, list: false }
  for (const arg of argv) {
    if (arg === '--no-vet') { options.vet = false; continue }
    if (arg === '--self-test') { options.selfTest = true; continue }
    if (arg === '--list') { options.list = true; continue }
    if (arg === '--expect-cut') { options.expectCut = true; continue }
    if (arg.startsWith('--expect-cut=')) {
      options.expectCut = true
      options.cutOverride = splitModules(arg.slice('--expect-cut='.length), '--expect-cut')
      continue
    }
    if (arg.startsWith('--only=')) {
      const variant = arg.slice('--only='.length)
      if (!COMBOS.some(combo => combo.variant === variant)) {
        throw new UsageError(`--only=${variant}：没有这个变体（可选：${COMBOS.map(combo => combo.variant).join(' / ')}）`)
      }
      options.only = variant
      continue
    }
    throw new UsageError(`不认识的参数：${arg}`)
  }
  return options
}

/** 拆 `a,b` 形式的模块名列表；空串 = 空集；未知名字 fail-loud。 */
function splitModules(text, flag) {
  const names = text.split(',').map(name => name.trim()).filter(name => name !== '')
  for (const name of names) {
    if (!MODULES.includes(name)) {
      throw new UsageError(`${flag} 里的 ${name} 不是模块名（可选：${MODULES.join(' / ')}）`)
    }
  }
  return names
}

/** 在 `server/` 里跑一条 go 命令；返回 `{ ok, stdout, stderr }`。 */
function runGo(args, { capture = true } = {}) {
  const result = spawnSync('go', args, {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 不吞输出：编译失败时把 stderr 原样带出来（正是要给人看诊断）。
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, stdout: '', stderr: `执行 go 失败：${result.error.message}` }
  }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * 判据引擎（**纯函数**，`--self-test` 直接喂合成输入复核它）：
 * 给定"当前依赖里出现的包树"与"应当被裁掉的模块"，返回失败项列表。
 *
 * 两个方向都判：
 *   · 应当被裁掉的模块，它的整棵包树一个包都不许在；
 *   · **没有**被裁掉的模块（= 开着的），它的包树必须至少有一个包在 ——
 *     这一半今天就成立，也是"基线前提没坏"的证据。
 */
export function evaluateCut(presentPrefixes, cutModules, modules = MODULES, trees = MODULE_TREES) {
  const failures = []
  for (const name of modules) {
    const prefixes = trees[name]
    const found = prefixes.filter(prefix => presentPrefixes.has(prefix))
    const isCut = cutModules.includes(name)
    if (isCut && found.length > 0) {
      failures.push({
        module: name,
        kind: 'still-present',
        detail: `模块 ${name} 应当被裁掉，但它的包树还在依赖里：${found.join('、')}`,
      })
    }
    if (!isCut && found.length === 0) {
      failures.push({
        module: name,
        kind: 'missing-while-enabled',
        detail: `模块 ${name} 是开着的，但它的包树一个包都不在依赖里：${prefixes.join('、')}`,
      })
    }
  }
  return failures
}

/** `go list -deps` 的原始输出 → 出现在依赖里的"包树前缀"集合。 */
export function presentTreePrefixes(depLines, modules = MODULES, trees = MODULE_TREES) {
  const present = new Set()
  const deps = depLines
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => (line.startsWith(`${MODULE_PATH}/`) ? line.slice(MODULE_PATH.length + 1) : null))
    .filter(line => line !== null)
  for (const name of modules) {
    for (const prefix of trees[name]) {
      if (deps.some(dep => dep === prefix || dep.startsWith(`${prefix}/`))) present.add(prefix)
    }
  }
  return present
}

/** `--self-test`：不碰 go，只证明判据引擎真的会红。 */
function selfTest() {
  const problems = []
  const allPresent = new Set([...MODULES.flatMap(name => MODULE_TREES[name])])
  const noApps = new Set([...allPresent].filter(prefix => !prefix.startsWith('internal/wasmapp')))

  const pass = evaluateCut(allPresent, [])
  if (pass.length !== 0) problems.push(`三个模块都开着时应无失败项，实际 ${JSON.stringify(pass)}`)

  const cutDetected = evaluateCut(allPresent, ['apps'])
  if (cutDetected.length !== 1 || cutDetected[0]?.kind !== 'still-present') {
    problems.push(`"apps 应被裁掉而它还在"必须**正好**报一条 still-present，实际 ${JSON.stringify(cutDetected)}`)
  }

  const cutSatisfied = evaluateCut(noApps, ['apps'])
  if (cutSatisfied.length !== 0) problems.push(`apps 的包树确实不在时不应有失败项，实际 ${JSON.stringify(cutSatisfied)}`)

  const enabledMissing = evaluateCut(noApps, [])
  if (enabledMissing.length !== 1 || enabledMissing[0]?.kind !== 'missing-while-enabled') {
    problems.push(`开着的模块包树不在时必须报 missing-while-enabled，实际 ${JSON.stringify(enabledMissing)}`)
  }

  const prefixes = presentTreePrefixes([
    `${MODULE_PATH}/cmd/server`,
    `${MODULE_PATH}/internal/wasmapp/api`,
    `${MODULE_PATH}/internal/connectors`,
    'fmt',
    'github.com/other/dep/internal/wasmapp',
  ].join('\n'))
  if (!(prefixes.has('internal/wasmapp') && prefixes.has('internal/connectors'))) {
    problems.push(`presentTreePrefixes 没有认出包树：${[...prefixes].join('、')}`)
  }
  if (prefixes.has('internal/marketplace')) {
    problems.push('presentTreePrefixes 把不存在的包树也算进来了')
  }
  if ([...prefixes].some(prefix => prefix.startsWith('github.com/other'))) {
    problems.push('presentTreePrefixes 把别的 module 的同名路径也算进来了（必须只认本 module）')
  }

  if (problems.length > 0) {
    console.error('✗ 判据引擎自证失败：')
    for (const problem of problems) console.error(`  · ${problem}`)
    return 1
  }
  console.log('✓ 判据引擎自证通过（4 条引擎断言 + 3 条依赖前缀归一断言；含"必须能红"的两条）')
  return 0
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`check-go-build-tags: ${error.message}`)
      console.error('用法：node server/scripts/check-go-build-tags.mjs [--no-vet] [--only=<组合>] [--expect-cut[=模块,…]] [--self-test] [--list]')
      return 2
    }
    throw error
  }

  if (options.list) {
    for (const combo of COMBOS) {
      console.log(`${combo.variant.padEnd(24)} -tags=${combo.tags === '' ? '(空)' : combo.tags}`
        + `  期望裁掉：[${combo.cut.join(', ') || '无（基线）'}]`)
    }
    return 0
  }

  if (options.selfTest) return selfTest()

  const combos = options.only === null ? COMBOS : COMBOS.filter(combo => combo.variant === options.only)
  const failures = []
  const pending = []

  console.log(`变体矩阵：${combos.length} 个组合（build${options.vet ? ' + vet' : ''}`
    + `${options.expectCut ? ' + 裁剪断言【拦门禁】' : ' + 裁剪断言【只报告】'}）`)
  console.log()

  for (const combo of combos) {
    const tagArgs = [`-tags=${combo.tags}`]
    const label = `-tags=${combo.tags === '' ? '(空)' : combo.tags}`
    console.log(`→ [${combo.variant}] ${label}`)

    const build = runGo(['build', ...tagArgs, './...'])
    if (!build.ok) {
      failures.push(`[${combo.variant}] go build ${label} 失败`)
      console.error(indent(build.stderr || build.stdout))
      continue
    }
    console.log('  ✓ go build ./...')

    if (options.vet) {
      const vet = runGo(['vet', ...tagArgs, './...'])
      if (!vet.ok) {
        failures.push(`[${combo.variant}] go vet ${label} 失败`)
        console.error(indent(vet.stderr || vet.stdout))
        continue
      }
      console.log('  ✓ go vet ./...')
    }

    const listed = runGo(['list', '-deps', ...tagArgs, './cmd/server'])
    if (!listed.ok) {
      failures.push(`[${combo.variant}] go list -deps ${label} 失败`)
      console.error(indent(listed.stderr || listed.stdout))
      continue
    }
    const present = presentTreePrefixes(listed.stdout)
    const cut = options.cutOverride ?? combo.cut
    const cutFailures = evaluateCut(present, cut)

    if (combo.baseline === true && options.cutOverride === null) {
      // 基线前提：全开时三个模块树**都必须**在。不在 = 包树边界登记陈旧（改名/挪包），
      // 这条红了说明判据自己的前提坏了，而不是"裁剪成功"。
      const baseline = evaluateCut(present, []).filter(item => item.kind === 'missing-while-enabled')
      if (baseline.length > 0) {
        for (const item of baseline) failures.push(`[基线] ${item.detail}（MODULE_TREES 登记陈旧？）`)
      } else {
        console.log('  ✓ 基线：三个模块的包树都在依赖里')
      }
    }

    const shown = []
    for (const name of MODULES) {
      const inCut = cut.includes(name)
      const anyPresent = MODULE_TREES[name].some(prefix => present.has(prefix))
      shown.push(`${name}=${anyPresent ? '在' : '不在'}${inCut ? '(应裁)' : ''}`)
    }
    console.log(`  · 依赖面：${shown.join('  ')}`)

    if (cutFailures.length === 0) {
      console.log('  ✓ 裁剪断言成立')
      continue
    }
    for (const item of cutFailures) {
      if (options.expectCut) failures.push(`[${combo.variant}] ${item.detail}`)
      else pending.push(`[${combo.variant}] ${item.detail}`)
    }
    if (!options.expectCut) console.log(`  ⏳ 裁剪断言未成立（${cutFailures.length} 条）—— 本片预期如此`)
  }

  console.log()
  if (pending.length > 0) {
    console.log(`⏳ 裁剪断言待生效（第二片接线后才成立，本片按"预期失败"报告，不影响退出码）：`)
    for (const item of pending) console.log(`  · ${item}`)
    console.log('  依据：P1 第一片只做 tag 接线与判据，不做条件化编译 ——')
    console.log('  见 docs/decisions/2026-10-14-server-build-tags.md §4。')
    console.log(`  第二片把本开关打开：${'`make -C server check-tags TAGS_ARGS=--expect-cut`'}`)
    console.log()
  }

  if (failures.length > 0) {
    console.error(`✗ 变体矩阵判据失败（${failures.length} 条）：`)
    for (const item of failures) console.error(`  · ${item}`)
    return 1
  }
  console.log(`✓ 变体矩阵判据通过：${combos.length} 个组合全部编得过，依赖面断言符合预期`)
  return 0
}

/** 给子进程输出加缩进（诊断挂在对应组合下面，不糊成一片）。 */
function indent(text) {
  return String(text).trimEnd().split('\n').map(line => `    ${line}`).join('\n')
}

process.exitCode = main()
