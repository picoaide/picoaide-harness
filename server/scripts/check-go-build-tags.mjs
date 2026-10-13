#!/usr/bin/env node
/**
 * 变体矩阵判据（P1 第一片，2026-10-14）。
 *
 * ## 它判什么
 *
 * 对**每一种可选模块组合**各跑一次全仓编译，让"关掉某个模块"这种构建形态至少存在一条
 * 可执行的判据。组合与包树边界（模块树定义见下面的 `MODULE_TREES`，与决策记录
 * `docs/decisions/2026-10-14-server-build-tags.md` §2 同一份口径）。
 *
 * 组合**不是手抄的一张表，而是从渠道契约的取值域穷尽派生的**（`COMBOS` 由
 * `FEATURE_MODULES` 的全部 2ⁿ 个子集 × `channelFeaturesVariant()` 生成）：三个开关
 * 彼此独立（`docs/decisions/2026-10-13-feature-split-build-time.md` 决策台账
 * 「三个独立开关、任意组合」），所以**每一个子集都是可达的交付变体**，矩阵必须穷尽 ——
 * 2026-10-14 独立审计 P1-2 实测：手抄的 5 行表漏了 `connectors` / `skills,connectors` /
 * `apps,connectors` 三组，而漏掉的三组里恰好有一组（`connectors`）自己的 `go test` 是红的
 * ⇒「矩阵自称穷尽」与「减配变体永不被测」同时成立，且没有任何入口会红。
 *
 * 变体标识**逐字取自渠道契约**（`packages/host/desktop/scripts/channel-constants.ts` 的
 * `channelFeaturesVariant()`：`skills,apps,connectors` / `apps` / `none`）—— 判据用的是
 * 与发布链同一个串，而不是这里另起一套组合名，见
 * docs/decisions/2026-10-13-channel-feature-modules.md §5「三处只能读同一个串」。
 * 这里的 `MODULES` 也因此**不再自持一份字面量**：直接从那份 TS 常量模块读
 * （Node 的类型剥离直读，与 `scripts/verify-ci-scripts.mjs` 第 17 节同一姿势）。
 *
 * 每一步都判两件事：
 *   ① **编译面**：`go build -tags=<组合> ./...`（缺省再加一次 `go vet …`）必须成功 ——
 *      每一种组合都得编得过，否则"支持变体"就是空话；
 *   ② **依赖面**：`go list -deps -tags=<组合> ./cmd/server` 里，**开着的**模块包树必须
 *      在，**关掉的**模块包树必须不在。
 *
 * 认账（**本判据不管什么**）：它只跑 build / vet / `go list -deps`，**不跑 `go test`**
 * —— 变体的**运行期**行为（关闭态路由树上有什么、装配是否 fail-loud）由各包自己的用例
 * 按 build tag 覆盖（如 `cmd/server/routes_source_test.go` 的登记级反向断言 +
 * `internal/router/optional_*_off_registration_test.go` 的位置级断言），而 CI 的
 * `go test` 只跑发布态组合。见决策记录 §11-2。
 *
 * ## ② 的"关掉的那一半"自 2026-10-14 起**生效**（P1 第二片）
 *
 * 第一片只做 tag 接线与判据，不做真正的裁剪 —— 那时关掉模块，包树照样进二进制，
 * 这一段只能按"预期失败（⏳）"报告。第二片把三个模块的路由注册、`cmd/server` 的装配
 * 与 handler 包全部接成**构建期条件注册**之后，"包树消失"成了可断言的事实：
 *
 *   · `make -C server check-tags` 的缺省参数就是 `--expect-cut`（裁剪断言**拦门禁**）；
 *   · 想临时看"只报账"的形态：`make check-tags TAGS_ARGS=`（显式传空）；
 *   · `--expect-cut=<模块,…>` 仍是**探针**形态：对所有组合套一组指定的裁剪集，
 *     必须变红，用来证明这条判据不是空转。
 *
 * 关闭态的三种装配形态（判据测的是结果，这里是"为什么结果成立"）：
 *   ① 路由：`internal/router/optional_*_on.go` / `_off.go` 一对 build-tag 文件，
 *      关闭态给同名**空类型**与空实现 ⇒ 注册代码编不进来（不是"注册了但 handler 为 nil"）；
 *   ② 装配：`cmd/server/optional_*_on.go` / `_off.go` 一对，关闭态不构造 handler；
 *   ③ 包边界：`internal/limits`（上限数值真源）与 `internal/skillseed`（内置技能下发面）
 *      按"谁真的用它"归位 —— 前者是基础面，后者属 skills。见决策记录 §2。
 *
 * ## 用法
 *
 * ```bash
 * node server/scripts/check-go-build-tags.mjs                    # 全部组合，裁剪断言只报告
 * node server/scripts/check-go-build-tags.mjs --no-vet            # 不跑 go vet（快一点）
 * node server/scripts/check-go-build-tags.mjs --only=apps        # 只跑一个组合
 * node server/scripts/check-go-build-tags.mjs --expect-cut        # 裁剪断言转为拦门禁（make check-tags 的缺省）
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(SERVER_DIR, '..')

/**
 * 模块名与变体标识的**唯一真源** = 渠道契约常量模块（`.ts` 直读靠 Node 的类型剥离，
 * 与 `scripts/verify-ci-scripts.mjs` 第 17 节、`scripts/ci-channels.sh` 同一姿势）。
 *
 * 为什么不在这里写一份字面量：判据用的必须是**发布链那一个串**。手抄一份的失效形态已经
 * 实测过一次（2026-10-14 独立审计 P1-2）：矩阵漏了 3/8 个组合而脚本头自称"每一种组合"。
 */
let channelContract
try {
  channelContract = await import(
    pathToFileURL(resolve(REPO_DIR, 'packages/host/desktop/scripts/channel-constants.ts')).href
  )
} catch (error) {
  console.error('✗ 读不到渠道契约常量模块 packages/host/desktop/scripts/channel-constants.ts —— '
    + '本判据的模块清单与变体标识都从它派生\n'
    + '  （`.ts` 直读依赖 Node 的类型剥离；Node ≥22.19 缺省开启）\n'
    + `  ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
const { FEATURE_MODULES, channelFeaturesVariant } = channelContract

/** 模块名的规范顺序（与 `internal/features` 的 AllModules、`FEATURE_MODULES` 三者同序）。 */
const MODULES = [...FEATURE_MODULES]

/** 模块 → 该模块的包树（仓库内 `server/` 相对路径前缀）。与决策记录 §2 同源。 */
const MODULE_TREES = {
  skills: [
    'internal/marketplace',
    'internal/sharedskills',
    'internal/agentshare',
    'internal/capabilities',
    // 内置技能下发面（平台内置技能随镜像发布，`/api/client/v2/skills/builtin*`）。
    // 它**服务的是 skills**：应用中心关闭时它必须还在（技能面照常下发），技能面关闭
    // 时它必须消失。P1 第二片因此把它从 `internal/wasmapp/skillseed` 挪到
    // `internal/skillseed` —— 留在 wasmapp 树下会让上面两条**同时**不可能成立
    // （apps 关 ⇒ 整棵 wasmapp 消失 ⇒ 技能面拿不到内置技能）。
    // 归位依据（P0 规划 §5 第 4 条）：`/opt/picoaide/skills` 的唯一消费方就是它。
    'internal/skillseed',
  ],
  apps: ['internal/wasmapp'],
  connectors: ['internal/connectors'],
}

// 包树登记表必须与模块清单同源：少一个模块 ⇒ 那个模块的"应当被裁掉"永远判不到。
// （新增可选模块时忘登记是最容易发生的形态，所以放在模块加载期 fail-loud 而不是等判据。）
{
  const trees = Object.keys(MODULE_TREES).sort()
  const expected = [...MODULES].sort()
  if (JSON.stringify(trees) !== JSON.stringify(expected)) {
    console.error('✗ MODULE_TREES 与 FEATURE_MODULES 不是同一组模块：'
      + `登记表 [${trees.join(', ')}] vs 契约 [${expected.join(', ')}]`)
    process.exit(2)
  }
}

/**
 * 变体矩阵 —— **从取值域穷尽派生**，不是手抄的一张表。
 *
 * `variant` = 渠道契约里的 `features_variant` 字面量（同时就是 `--only=` 的取值），
 * `tags` = 传给 `-tags=` 的那串（`none` ⇒ 空串），`cut` = 该组合下**应当被裁掉**的模块。
 *
 * 为什么穷尽 2ⁿ 个子集：三个开关彼此独立（决策台账「三个独立开关、任意组合」），
 * `channelFeaturesVariant()` 能产出**任意**子集 ⇒ 每一个子集都是可达的交付变体。
 * 顺序即执行顺序：基线（全开）先跑，后面才有"基线成立"的参照；其余按"关掉的模块数"
 * **升序**（差异小 → 大），同数量按变体名稳定排序 —— 诊断时先看与基线差异最小的那一组。
 */
const COMBOS = (() => {
  const combos = []
  for (let mask = 0; mask < (1 << MODULES.length); mask += 1) {
    const features = Object.fromEntries(MODULES.map((name, index) => [name, (mask & (1 << index)) !== 0]))
    const variant = channelFeaturesVariant(features)
    combos.push({
      variant,
      tags: variant === 'none' ? '' : variant,
      cut: MODULES.filter(name => !features[name]),
      baseline: variant === MODULES.join(','),
    })
  }
  // 基线最先；其余按"关掉的模块数"升序（差异小 → 大），同数量按变体名稳定排序。
  combos.sort((a, b) => {
    if (a.baseline !== b.baseline) return a.baseline ? -1 : 1
    if (a.cut.length !== b.cut.length) return a.cut.length - b.cut.length
    return a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0
  })
  // 自证：变体标识不得重复（重复 ⇒ 某个组合被静默丢掉）且正好 2ⁿ 个。
  const variants = new Set(combos.map(combo => combo.variant))
  if (combos.length !== (1 << MODULES.length) || variants.size !== combos.length) {
    console.error(`✗ COMBOS 派生失败：期望 ${1 << MODULES.length} 个互不相同的变体，`
      + `实得 ${combos.length} 个（去重后 ${variants.size} 个）`)
    process.exit(2)
  }
  return combos
})()

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
    if (!options.expectCut) console.log(`  ⏳ 裁剪断言未成立（${cutFailures.length} 条）—— 本次按"只报告"运行（TAGS_ARGS 显式传空）`)
  }

  console.log()
  if (pending.length > 0) {
    console.log(`⏳ 裁剪断言未成立（${pending.length} 条）—— 本次是"只报告"形态，不影响退出码：`)
    for (const item of pending) console.log(`  · ${item}`)
    console.log('  缺省（`make -C server check-tags`）带 `--expect-cut`，这些条目会直接判失败。')
    console.log('  只有显式 `TAGS_ARGS=`（空）才会走到这里；见 docs/decisions/2026-10-14-server-build-tags.md §4。')
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
