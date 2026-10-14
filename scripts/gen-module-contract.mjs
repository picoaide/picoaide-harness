#!/usr/bin/env node
/**
 * 模块编译契约的**生成器 + 门禁**（单一真源 + 代码生成）。
 *
 * ## 为什么是"生成"而不是"对拍"
 *
 * 编译期功能模块（skills / apps / connectors）的模块名此前分散在**六个端**各写一遍：
 * Go 权威（`ModuleX` + `allModules`）、Go 构建标签分片、webadmin `FEATURE_MODULES`、
 * 客户端 `FEATURE_MODULES` + `features.<m>` 模板键族、`server/Makefile` 的 `GO_TAGS ?=`、
 * `server/Dockerfile` 的两个 `ARG` 缺省值、`.github/workflows/ci.yml` 的 `-tags=` 字面量。
 * 每一端都有自己的判据，但**没有一条跨端机械对拍**：把 `'connectors'` 在 TS 侧两处
 * 一起改成 `'connector'` 时，JS 判据与 Go 判据**都会绿** ⇒ 跨语言漂移无人抓。
 *
 * 「登记 + 对拍」能发现漂移，但改一个模块名仍要人肉改六处；本片改成**单一真源 + 生成**：
 *   · 真源 = 仓库根 `module-contract.json`（顺序=契约）；
 *   · 各端的模块名清单是**生成物**（用成对标记 `@generated:module-contract` /
 *     `@end:module-contract` 包住生成区），非生成区由本脚本**逐字节保留**；
 *   · `--check` 在内存里重算并与磁盘逐字节比 ⇒ 手改生成区、或真源改了却没跑生成器，
 *     都是**一条红**（而不是"六个端各自自洽地漂移"）。
 *
 * ## 两种模式
 *
 *   · 缺省（写）：读真源 ⇒ 重写各端**标记块内**的内容。幂等：连跑两次第二次零改动。
 *     真源非法（version/形状/重复 id）⇒ **不写任何文件**并 exit 1。
 *   · `--check`：在内存里重算，与磁盘逐字节比；任一不符 ⇒ exit 1，报错点名
 *     「文件 + 生成区 + 该跑 `node scripts/gen-module-contract.mjs`」。
 *     **文件读不到 = 红**（仓库结构事故不是 skip，口径照
 *     `server/internal/serverauth/usage_contract_test.go` 的候选路径 + `t.Fatalf`）。
 *
 * ## 生成面（6 个文件 / 11 个生成区）
 *
 * | 文件 | 生成区 |
 * | --- | --- |
 * | `server/internal/features/features.go` | ① `ModuleX = "…"` 常量条目 ② `allModules` 那一行 |
 * | `server/webadmin/features.mjs` | `FEATURE_MODULES` 那一行 |
 * | `packages/host/desktop/scripts/channel-constants.ts` | ① `FEATURE_MODULES` ② `FEATURE_MODULE_DEFAULTS`（**渠道缺省表**）③ `'features.<m>'` 模板键族 |
 * | `server/Makefile` | `GO_TAGS ?= ` 那一行 |
 * | `server/Dockerfile` | ① webadmin stage 的 `ARG GO_TAGS=` / `ARG FEATURES=` ② Go stage 的 `ARG GO_TAGS=` |
 * | `.github/workflows/ci.yml` | ① `go vet -tags=…` 那一行 ② `go test -tags=…` 那一行 |
 *
 * ## 契约字段与棘轮
 *
 * 每个模块有 `{ id, goConst, title, defaultInChannel }`：`defaultInChannel` 是"渠道**不写**
 * `features.<m>` 时这个模块算不算要"的唯一真源（生成成 `FEATURE_MODULE_DEFAULTS`，
 * 由 `channel-constants.ts` 的 `normalizeChannelFeatures()` **读表**而不是硬编码 true）。
 * **新增模块一律先设 `false`**；缺省 `true` 的模块数被 {@link MAX_MODULES_DEFAULT_ON}
 * 这把棘轮卡住（超限即红，要默认开必须显式改那个常量并进 diff）。
 *
 * **刻意不生成**（它们不是"名字清单"，是逻辑/结构）：`featureSentinel()` /
 * `featureGlobalName()` 这类派生函数、Dockerfile 的 `$FEATURES`↔`$GO_TAGS` 成对
 * fail-loud 断言、Makefile 的 `GO_TAG_FLAG` 与 `--build-arg` 透传、注释里的示意写法。
 *
 * ## 核验但**不**生成的结构面（4 处，见 {@link VERIFIED_FACES}）
 *
 *   ① `packages/host/desktop/src/channel-features.ts` 的 `module: '<名>'` 出现顺序 == 契约顺序；
 *   ② `server/internal/router/optional_<m>_on.go` / `_off.go` 成对存在且首行标签逐字正确，
 *      且 router 包里**没有**契约之外的孤儿模块标签；
 *   ③ `server/webadmin/features.mjs` 的 `featureGlobalName()` **真跑**后 == `__FEATURE_<ID大写>__`；
 *   ④ Go `AllModules()`（解析源码得到的顺序）== 契约顺序。
 *
 * 这四处硬塞进 JSON 只会把逻辑搬进数据文件（比"抄一遍"更糟），所以它们留在各自文件里，
 * 由 `--check` 断言。
 *
 * 用法：`node scripts/gen-module-contract.mjs [--check]`
 * 退出码：0 通过；1 有断言失败。
 *
 * @module scripts/gen-module-contract
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根（本脚本位于 `scripts/` 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 单一真源的文件名（仓库根）。 */
export const MODULE_CONTRACT_FILE = 'module-contract.json'

/**
 * **棘轮上限**：允许 `defaultInChannel: true`（= 不声明就给）的模块数上限。
 *
 * 现场：`defaultInChannel` 决定"渠道**不写** `features.<m>` 时这个模块算不算要"——
 * 缺省 `true` 意味着一个刚做出来的模块会**自动**发给所有既有渠道（含已经交付的客户包），
 * 而这件事在 diff 里只是一个布尔。上限常量把它变成一个**必须显式改的可见动作**：
 * `--check` 在 `开启数 > MAX_MODULES_DEFAULT_ON` 时判红（新增模块想默认开就要改这个数字，
 * 评审时一眼看得见），而"新增模块默认 `false`"永远不需要动它。
 *
 * 注意：它**只是上限**（不是等式）—— 把某个模块的缺省改成 `false` 不需要下调它
 * （下调是可选的收紧，不强制，避免"临时关一个模块"被它拦住）。
 */
export const MAX_MODULES_DEFAULT_ON = 3

/**
 * 真源的候选路径（照 `server/internal/serverauth/usage_contract_test.go` 的口径：
 * 调用方的工作目录可能是仓库根、也可能在 `scripts/` 下）。
 */
const CONTRACT_CANDIDATES = [MODULE_CONTRACT_FILE, join('..', MODULE_CONTRACT_FILE)]

/** 生成区的成对标记（注释前缀由文件本身决定：`//` 或 `#`）。 */
const MARKER_OPEN_RE = /^([ \t]*)(\/\/|#)[ \t]*@generated:module-contract\b/u
const MARKER_CLOSE_RE = /^([ \t]*)(\/\/|#)[ \t]*@end:module-contract\b/u

/** 生成区开始标记的**规范形态**（`--check` 逐字节比的就是它）。 */
const markerOpen = (comment, indent) =>
  `${indent}${comment} @generated:module-contract (scripts/gen-module-contract.mjs) — 手改会被 --check 判红`

/** 生成区结束标记的**规范形态**。 */
const markerClose = (comment, indent) => `${indent}${comment} @end:module-contract`

/** `'skills', 'apps'` 形态的模块 id 字面量。 */
const quotedIds = (ids) => ids.map(id => `'${id}'`).join(', ')

/**
 * **生成面登记表**：6 个文件、10 个生成区。
 *
 * ⚠️ **`regions` 的顺序 = 该文件里标记出现的顺序**（渲染时按序号配对 `@generated` 与
 * `@end`）—— 同一个文件里有多个生成区时，数组顺序与源码顺序不一致会让 `--check` 报
 * "标记交叉嵌套"（fail-loud，改顺序要同时改这里）。
 *
 * `regions[i].body(ctx)` 返回**不含缩进前缀**的正文行（缩进取自该区的开始标记）；
 * 空串行原样输出（不写尾随空白）。渲染必须是**契约的纯函数** —— 这是 `--check`
 * 能做逐字节比较的前提。
 */
export const GENERATED_SITES = [
  {
    path: 'server/internal/features/features.go',
    label: 'Go 权威（ModuleX 常量 + allModules）',
    regions: [
      {
        id: 'features.consts',
        label: 'ModuleX 常量条目',
        body: ({ modules }) => modules.flatMap(module => [
          `// ${module.goConst} ${module.title}。`,
          `${module.goConst} = "${module.id}"`,
        ]),
      },
      {
        id: 'features.all-modules',
        label: 'allModules 那一行（顺序 = 契约）',
        body: ({ modules }) => [
          `var allModules = []string{${modules.map(module => module.goConst).join(', ')}}`,
          // 末尾这个空串不是装饰：`gofmt` 要求 `var …` 声明与紧跟其后的独立注释行
          // （即生成区的 `// @end`）之间留一个空行 —— 少了它 `gofmt -l` 会点名本文件，
          // CI 的 `gofmt check` 步当场红（2026-10-14 实测：首版就是这么红的）。
          '',
        ],
      },
    ],
  },
  {
    path: 'server/webadmin/features.mjs',
    label: 'webadmin FEATURE_MODULES',
    regions: [
      {
        id: 'webadmin.modules',
        label: 'FEATURE_MODULES 那一行',
        body: ({ ids }) => [`export const FEATURE_MODULES = [${quotedIds(ids)}]`],
      },
    ],
  },
  {
    path: 'packages/host/desktop/scripts/channel-constants.ts',
    label: '客户端 FEATURE_MODULES + 渠道缺省表 + features.<m> 模板键族',
    regions: [
      {
        id: 'client.template-keys',
        label: "CHANNEL_TEMPLATE_KEYS 里的 'features.<m>' 键族",
        body: ({ ids }) => ids.map(id => `'features.${id}',`),
      },
      {
        id: 'client.modules',
        label: 'FEATURE_MODULES 那一行',
        body: ({ ids }) => [`export const FEATURE_MODULES = [${quotedIds(ids)}] as const`],
      },
      {
        id: 'client.module-defaults',
        label: 'FEATURE_MODULE_DEFAULTS 渠道缺省表',
        body: ({ modules }) => [
          'export const FEATURE_MODULE_DEFAULTS: Readonly<Record<FeatureModule, boolean>> = {',
          ...modules.map(module => `  ${module.id}: ${module.defaultInChannel},`),
          '}',
        ],
      },
    ],
  },
  {
    path: 'server/Makefile',
    label: 'Makefile 的 GO_TAGS 缺省值',
    regions: [
      {
        id: 'makefile.go-tags',
        label: 'GO_TAGS ?= 那一行',
        body: ({ idsText }) => [`GO_TAGS ?= ${idsText}`],
      },
    ],
  },
  {
    path: 'server/Dockerfile',
    label: 'Dockerfile 两个 build-arg 的缺省值',
    regions: [
      {
        id: 'dockerfile.webadmin-stage',
        label: 'webadmin stage 的 ARG GO_TAGS= / ARG FEATURES=',
        body: ({ idsText }) => [`ARG GO_TAGS=${idsText}`, `ARG FEATURES=${idsText}`],
      },
      {
        id: 'dockerfile.go-stage',
        label: 'Go stage 的 ARG GO_TAGS=',
        body: ({ idsText }) => [`ARG GO_TAGS=${idsText}`],
      },
    ],
  },
  {
    path: '.github/workflows/ci.yml',
    label: 'ci.yml 的 -tags= 字面量（只生成"带值的字面量"两处）',
    regions: [
      {
        id: 'ci.vet-tags',
        label: 'go vet 步的 -tags=',
        body: ({ idsText }) => [`- run: go vet -tags=${idsText} ./...`],
      },
      {
        id: 'ci.test-tags',
        label: 'go test 步的 -tags=',
        body: ({ idsText }) => [
          `go test -tags=${idsText} ./... -count=1 -p 1 -timeout 15m -json > go-test.json || GO_TEST_STATUS=$?`,
        ],
      },
    ],
  },
]

/**
 * **核验但不生成**的结构面（4 处）。
 *
 * 它们是"结构/逻辑"而不是"名字清单"：塞进 JSON 等于把逻辑搬进数据文件。
 */
export const VERIFIED_FACES = [
  {
    id: 'client.surface-order',
    label: 'packages/host/desktop/src/channel-features.ts 的 `module:` 出现顺序 == 契约顺序',
  },
  {
    id: 'router.shard-tags',
    label: 'server/internal/router 的标签分片成对且逐字正确、无孤儿模块标签',
  },
  {
    id: 'webadmin.global-name',
    label: 'server/webadmin/features.mjs 的 featureGlobalName() 真跑 == __FEATURE_<ID大写>__',
  },
  {
    id: 'go.all-modules',
    label: 'server/internal/features/features.go 的 AllModules()（源码顺序）== 契约顺序',
  },
]

/**
 * 面数（供根守卫的汇总串引用；唯一真源在这里，别在调用点重算）。
 *
 * `faces` = 6 个生成文件 + 4 处结构核验 = 10 面；`regions` = 8 个生成区。
 */
export const MODULE_CONTRACT_FACE_COUNTS = {
  generatedFiles: GENERATED_SITES.length,
  generatedRegions: GENERATED_SITES.reduce((total, site) => total + site.regions.length, 0),
  verifiedFaces: VERIFIED_FACES.length,
  faces: GENERATED_SITES.length + VERIFIED_FACES.length,
  regions: GENERATED_SITES.reduce((total, site) => total + site.regions.length, 0)
    + VERIFIED_FACES.length,
}

/**
 * 把一个仓库相对路径解析成**真实文件路径**（候选路径口径）。
 *
 * 顺序：仓库根相对 → 当前工作目录相对 → 从当前工作目录逐级向上（≤6 级）。
 * @param {string} relativePath - 仓库相对路径（POSIX 分隔）。
 * @param {{root?: string, cwd?: string}} [options] - 覆盖项（自检用）。
 * @returns {{path: string|null, tried: string[]}} 命中路径与尝试过的全部路径。
 */
function resolveRepoPath(relativePath, options = {}) {
  const root = options.root ?? ROOT
  const cwd = options.cwd ?? process.cwd()
  const tried = []
  const bases = [root, cwd]
  let up = cwd
  for (let level = 0; level < 6; level += 1) {
    const parent = dirname(up)
    if (parent === up) break
    up = parent
    bases.push(up)
  }
  for (const base of bases) {
    const candidate = resolve(base, relativePath)
    if (tried.includes(candidate)) continue
    tried.push(candidate)
    if (existsSync(candidate)) return { path: candidate, tried }
  }
  return { path: null, tried }
}

/**
 * 读一个真源文件；**读不到 = 红**（仓库结构事故，不是 skip）。
 * @param {string} relativePath - 仓库相对路径。
 * @param {{root?: string, cwd?: string}} [options] - 覆盖项。
 * @returns {{text: string|null, path: string|null, problem: string|null}} 读取结果。
 */
function readRepoFile(relativePath, options = {}) {
  const { path, tried } = resolveRepoPath(relativePath, options)
  if (path === null) {
    return {
      text: null,
      path: null,
      problem: `${relativePath} **不可达** —— 这是仓库结构事故（真源被改名/搬走），不是环境差异。`
        + `候选路径全部尝试过：${tried.join(' | ')}。请把它放回原位，或在本脚本的 `
        + 'GENERATED_SITES / 核验面里登记新位置。',
    }
  }
  try {
    return { text: readFileSync(path, 'utf8'), path, problem: null }
  } catch (error) {
    return { text: null, path, problem: `${relativePath} 读失败：${error?.message ?? String(error)}` }
  }
}

/**
 * 校验并解析真源 JSON。
 * @param {string} text - 真源正文。
 * @returns {{contract: {version: number, modules: Array<{id: string, goConst: string, title: string, defaultInChannel: boolean}>}|null, problems: string[]}} 契约或问题。
 */
export function parseModuleContract(text) {
  const problems = []
  let raw = null
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { contract: null, problems: [`${MODULE_CONTRACT_FILE} 不是合法 JSON：${error?.message ?? String(error)}`] }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { contract: null, problems: [`${MODULE_CONTRACT_FILE} 的顶层必须是对象`] }
  }
  if (raw.version !== 1) {
    problems.push(`${MODULE_CONTRACT_FILE} 的 version 必须逐字是 1（实际 ${JSON.stringify(raw.version ?? null)}）`)
  }
  if (!Array.isArray(raw.modules) || raw.modules.length === 0) {
    problems.push(`${MODULE_CONTRACT_FILE} 的 modules 必须是非空数组`
      + '（空数组 = 一个模块都没有，各端会被生成成空清单）')
    return { contract: null, problems }
  }
  const modules = []
  const seenIds = new Map()
  const seenConsts = new Map()
  for (const [index, entry] of raw.modules.entries()) {
    const at = `modules[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${at} 必须是对象 { id, goConst, title, defaultInChannel }`)
      continue
    }
    const id = entry.id
    const goConst = entry.goConst
    // `title` 可选（缺省用 id）：它只影响 Go 常量上方那行注释，缺省不该让生成器拒绝工作。
    const title = entry.title === undefined ? id : entry.title
    // `defaultInChannel` **必填布尔**（缺省语义的唯一真源）：它决定"渠道不声明这个模块时
    // 算不算要"。写成 `"true"` 字符串这类形态必须当场红 —— 静默回落等于换了一套缺省语义。
    const defaultInChannel = entry.defaultInChannel
    if (typeof defaultInChannel !== 'boolean') {
      problems.push(`${at}.defaultInChannel 必须是布尔（**新增模块一律先设 false**：缺省不进任何`
        + `渠道），实际 ${JSON.stringify(defaultInChannel ?? null)}`)
      continue
    }
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(id)) {
      problems.push(`${at}.id 必须是小写字母开头的模块名（[a-z][a-z0-9_]*），实际 ${JSON.stringify(id ?? null)}`)
      continue
    }
    if (typeof goConst !== 'string' || !/^Module[A-Z][A-Za-z0-9_]*$/u.test(goConst)) {
      problems.push(`${at}.goConst 必须是 Go 常量名（Module + 大写开头），实际 ${JSON.stringify(goConst ?? null)}`)
      continue
    }
    if (typeof title !== 'string' || title.trim() === '') {
      problems.push(`${at}.title 必须是非空字符串（缺省 = id）`)
      continue
    }
    if (seenIds.has(id)) problems.push(`${at}.id 与 modules[${seenIds.get(id)}] 重复：${id}`)
    else seenIds.set(id, index)
    if (seenConsts.has(goConst)) problems.push(`${at}.goConst 与 modules[${seenConsts.get(goConst)}] 重复：${goConst}`)
    else seenConsts.set(goConst, index)
    modules.push({ id, goConst, title, defaultInChannel, line: index })
  }
  if (problems.length > 0) return { contract: null, problems }
  return { contract: { version: 1, modules }, problems }
}

/**
 * 契约 → 渲染上下文。
 * @param {{modules: Array<{id: string, goConst: string, title: string, defaultInChannel: boolean}>}} contract - 契约。
 * @returns {{ids: string[], idsText: string, modules: object[]}} 渲染上下文。
 */
const contractContext = (contract) => ({
  ids: contract.modules.map(module => module.id),
  idsText: contract.modules.map(module => module.id).join(','),
  modules: contract.modules,
})

/**
 * **读真源**（候选路径 + fail-loud）：所有模式共用这一条，避免三处各写一遍解析。
 * @param {{root?: string, cwd?: string}} [options] - 覆盖项。
 * @returns {{contract: object|null, problems: string[], path: string|null}} 契约 / 问题 / 命中路径。
 */
export function loadModuleContract(options = {}) {
  for (const candidate of CONTRACT_CANDIDATES) {
    const read = readRepoFile(candidate, options)
    if (read.text === null) continue
    const parsed = parseModuleContract(read.text)
    return { contract: parsed.contract, problems: parsed.problems, path: read.path }
  }
  const tried = CONTRACT_CANDIDATES.flatMap(candidate => resolveRepoPath(candidate, options).tried)
  return {
    contract: null,
    problems: [`${MODULE_CONTRACT_FILE} **不可达** —— 这是仓库结构事故（单一真源被改名/搬走），`
      + `不是环境差异。候选路径全部尝试过：${tried.join(' | ')}`],
    path: null,
  }
}

/**
 * 契约自洽断言（**与生成物无关**，只判真源本身）。
 *
 *   (a) 每个模块的 `defaultInChannel` 必须是布尔 —— 已在 {@link parseModuleContract} 里判
 *       （缺/非布尔 ⇒ 解析阶段即红，不产契约）；
 *   (b) **棘轮**：`defaultInChannel: true` 的模块数不得超过 {@link MAX_MODULES_DEFAULT_ON}。
 *       新增模块想默认开就必须显式改那个常量（进 diff、可评审），否则"悄悄默认全开"。
 * @param {{modules: Array<{id: string, defaultInChannel: boolean}>}} contract - 契约。
 * @returns {string[]} 问题清单（空 = 自洽）。
 */
export function contractSelfProblems(contract) {
  const problems = []
  if (!Number.isSafeInteger(MAX_MODULES_DEFAULT_ON) || MAX_MODULES_DEFAULT_ON <= 0) {
    problems.push(`MAX_MODULES_DEFAULT_ON 必须是正整数（实际 ${JSON.stringify(MAX_MODULES_DEFAULT_ON)}）`
      + ' —— 它被掏空/改成 0 时棘轮就失效了')
  }
  const onByDefault = contract.modules.filter(module => module.defaultInChannel === true)
  if (onByDefault.length > MAX_MODULES_DEFAULT_ON) {
    problems.push(`契约里有 ${onByDefault.length} 个模块 \`defaultInChannel: true\`，超过棘轮上限 `
      + `MAX_MODULES_DEFAULT_ON = ${MAX_MODULES_DEFAULT_ON}`
      + `（${onByDefault.map(module => module.id).join(', ')}）—— 缺省 true 意味着这个模块会`
      + '**自动发给所有既有渠道**（含已交付的客户包）。要么把它改成 `false` 让渠道显式打开，'
      + '要么显式上调 `scripts/gen-module-contract.mjs` 里的 `MAX_MODULES_DEFAULT_ON`'
      + '（让它出现在 diff 里被评审看见）')
  }
  return problems
}

/**
 * 定位一个文件里的全部生成区标记。
 * @param {string[]} lines - 文件行。
 * @returns {{opens: object[], closes: object[]}} 开始/结束标记（按出现顺序）。
 */
function locateMarkers(lines) {
  const opens = []
  const closes = []
  lines.forEach((line, index) => {
    const open = MARKER_OPEN_RE.exec(line)
    if (open !== null) opens.push({ index, indent: open[1], comment: open[2] })
    const close = MARKER_CLOSE_RE.exec(line)
    if (close !== null) closes.push({ index, indent: close[1], comment: close[2] })
  })
  return { opens, closes }
}

/**
 * **纯函数重算**：给定磁盘正文 ⇒ 期望正文（生成区内容被重写，其余逐字节保留）。
 * @param {string} text - 磁盘正文。
 * @param {object} site - {@link GENERATED_SITES} 的一项。
 * @param {object} ctx - {@link contractContext} 的产物。
 * @returns {{text: string, problems: string[]}} 期望正文与问题清单（问题非空 = 标记块坏了）。
 */
export function renderSite(text, site, ctx) {
  const lines = text.split('\n')
  const { opens, closes } = locateMarkers(lines)
  const problems = []
  if (opens.length !== site.regions.length || closes.length !== site.regions.length) {
    problems.push(`${site.path} 的生成区标记数量不符：期望 ${site.regions.length} 组 `
      + `\`@generated:module-contract\` / \`@end:module-contract\`，实际 `
      + `${opens.length} / ${closes.length}`
      + `（标记被删/被改名/多了一组 —— ${site.regions.map(region => region.id).join(' / ')}）`)
    return { text, problems }
  }
  for (const [index, region] of site.regions.entries()) {
    if (opens[index].index >= closes[index].index) {
      problems.push(`${site.path} 的生成区 ${region.id} 标记顺序颠倒（\`@end\` 在 \`@generated\` 之前）`)
    }
    const next = opens[index + 1]
    if (next !== undefined && closes[index].index >= next.index) {
      problems.push(`${site.path} 的生成区 ${region.id} 与 ${site.regions[index + 1].id} 的标记交叉嵌套`)
    }
  }
  if (problems.length > 0) return { text, problems }
  const out = []
  let cursor = 0
  for (const [index, region] of site.regions.entries()) {
    const open = opens[index]
    // 缩进取自**开始标记自己**：生成区落在哪个缩进层级由文件结构决定，不在这里再抄一遍。
    out.push(...lines.slice(cursor, open.index))
    out.push(markerOpen(open.comment, open.indent))
    for (const bodyLine of region.body(ctx)) {
      out.push(bodyLine === '' ? '' : open.indent + bodyLine)
    }
    out.push(markerClose(open.comment, open.indent))
    cursor = closes[index].index + 1
  }
  out.push(...lines.slice(cursor))
  return { text: out.join('\n'), problems }
}

/**
 * ci.yml 的"带值但不是契约串"普查。
 *
 * 判定口径（对应"只生成带值的字面量、注释里的示意写法一律不动"）：
 *   · 跳过注释行（`#` 开头）；
 *   · 只把**看起来就是模块 id 列表**的取值（`id(,id)*`）当成字面量；
 *   · `-tags=…`（省略号示意）、`-tags=$GO_TAGS`（变量形态，注释里明令不要改成它）、
 *     空值一律**跳过**；
 *   · 剩下的字面量若不等于契约串 ⇒ **红并点名**（说明有人手写了非契约 tag 串），
 *     而不是静默替换。
 * @param {string} text - ci.yml 正文。
 * @param {string} idsText - 契约串。
 * @returns {string[]} 问题清单。
 */
export function scanWorkflowTagLiterals(text, idsText) {
  const problems = []
  text.split('\n').forEach((line, index) => {
    if (/^[ \t]*#/u.test(line)) return
    for (const match of line.matchAll(/-tags=([^\s"'\\]*)/gu)) {
      const value = match[1]
      if (!/^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/u.test(value)) continue
      if (value === idsText) continue
      problems.push(`.github/workflows/ci.yml:${index + 1} 的 \`-tags=${value}\` 是**带值但不是契约串**的`
        + `写法（契约串 = ${idsText}）—— 请把它改成契约串，或（若它是新的一处出现点）`
        + '在 scripts/gen-module-contract.mjs 的 GENERATED_SITES 里加一个生成区')
    }
  })
  return problems
}

/**
 * 核验面 ①：`channel-features.ts` 的 `module: '<名>'` 出现顺序 == 契约顺序。
 * @param {object} ctx - 渲染上下文。
 * @param {{root?: string, cwd?: string}} options - 覆盖项。
 * @returns {string[]} 问题清单。
 */
function verifyClientSurfaceOrder(ctx, options) {
  const relativePath = 'packages/host/desktop/src/channel-features.ts'
  const read = readRepoFile(relativePath, options)
  if (read.text === null) return [read.problem]
  const found = [...read.text.matchAll(/module:[ \t]*'([a-z0-9_]+)'/gu)].map(match => match[1])
  if (found.length !== ctx.ids.length || found.some((id, index) => id !== ctx.ids[index])) {
    return [`${relativePath} 的 \`module: '<名>'\` 出现顺序是 ${JSON.stringify(found)}，`
      + `契约要求 ${JSON.stringify(ctx.ids)}（顺序=契约：装配面与 channelFeaturesVariant() 同源）`]
  }
  return []
}

/**
 * 核验面 ②：router 标签分片成对且首行标签逐字正确 + 无孤儿模块标签。
 * @param {object} ctx - 渲染上下文。
 * @param {{root?: string, cwd?: string}} options - 覆盖项。
 * @returns {string[]} 问题清单。
 */
function verifyRouterShards(ctx, options) {
  const relativeDir = 'server/internal/router'
  const { path: dir, tried } = resolveRepoPath(relativeDir, options)
  if (dir === null || !statSync(dir).isDirectory()) {
    return [`${relativeDir} 目录不可达 —— 仓库结构事故（不是环境差异）。候选：${tried.join(' | ')}`]
  }
  const problems = []
  const entries = readdirSync(dir).filter(name => name.endsWith('.go')).sort()
  for (const id of ctx.ids) {
    for (const [suffix, want] of [['on', `//go:build ${id}`], ['off', `//go:build !${id}`]]) {
      const name = `optional_${id}_${suffix}.go`
      const relative = `${relativeDir}/${name}`
      if (!entries.includes(name)) {
        problems.push(`${relative} 不存在 —— 模块 ${id} 的 ${suffix} 分片缺失（Go 的编译期开关少一半）`)
        continue
      }
      const firstLine = readFileSync(join(dir, name), 'utf8').split('\n')[0].trim()
      if (firstLine !== want) {
        problems.push(`${relative}:1 的首行是 ${JSON.stringify(firstLine)}，期望逐字 ${JSON.stringify(want)}`)
      }
    }
  }
  const known = new Set(ctx.ids)
  for (const name of entries) {
    const text = readFileSync(join(dir, name), 'utf8')
    const buildLine = text.split('\n').find(line => line.trimStart().startsWith('//go:build'))
    if (buildLine !== undefined) {
      const body = buildLine.replace(/^[ \t]*\/\/go:build[ \t]*/u, '').trim()
      for (const token of body.split(/[^A-Za-z0-9_]+/u)) {
        if (token === '' || known.has(token)) continue
        problems.push(`${relativeDir}/${name} 带了模块标签 \`${token}\`，但它不是契约里的模块`
          + `（孤儿标签：Go 侧多一个编译期开关，没有任何消费方；契约 = ${ctx.ids.join(', ')}）`)
      }
    }
    const shard = /^optional_(.+)_(on|off)\.go$/u.exec(name)
    if (shard !== null && !known.has(shard[1])) {
      problems.push(`${relativeDir}/${name} 的文件名里模块名是 ${JSON.stringify(shard[1])}，`
        + `契约里没有它（契约 = ${ctx.ids.join(', ')}）`)
    }
  }
  return problems
}

/**
 * 核验面 ③：`featureGlobalName()` 真跑后 == `__FEATURE_<ID大写>__`。
 * @param {object} ctx - 渲染上下文。
 * @param {{root?: string, cwd?: string}} options - 覆盖项。
 * @returns {Promise<string[]>} 问题清单。
 */
async function verifyWebadminGlobalName(ctx, options) {
  const relativePath = 'server/webadmin/features.mjs'
  const read = readRepoFile(relativePath, options)
  if (read.text === null) return [read.problem]
  let module = null
  try {
    module = await import(pathToFileURL(read.path).href)
  } catch (error) {
    return [`${relativePath} import 失败：${error?.message ?? String(error)}`]
  }
  const problems = []
  for (const id of ctx.ids) {
    const want = `__FEATURE_${id.toUpperCase()}__`
    let got = null
    try {
      got = typeof module.featureGlobalName === 'function' ? module.featureGlobalName(id) : null
    } catch (error) {
      got = `(抛错: ${error?.message ?? String(error)})`
    }
    if (got !== want) {
      problems.push(`${relativePath} 的 featureGlobalName(${JSON.stringify(id)}) 真跑得到 `
        + `${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
    }
  }
  return problems
}

/**
 * 核验面 ④：Go `AllModules()` 的源码顺序 == 契约顺序。
 * @param {object} ctx - 渲染上下文。
 * @param {{root?: string, cwd?: string}} options - 覆盖项。
 * @returns {string[]} 问题清单。
 */
function verifyGoAllModules(ctx, options) {
  const relativePath = 'server/internal/features/features.go'
  const read = readRepoFile(relativePath, options)
  if (read.text === null) return [read.problem]
  const problems = []
  const constants = new Map()
  for (const match of read.text.matchAll(/^[ \t]*Module([A-Za-z0-9_]+)[ \t]*=[ \t]*"([^"]*)"[ \t]*$/gmu)) {
    constants.set(`Module${match[1]}`, match[2])
  }
  const allMatch = /^[ \t]*var[ \t]+allModules[ \t]*=[ \t]*\[\]string[ \t]*\{([^}]*)\}/mu.exec(read.text)
  if (allMatch === null) {
    problems.push(`${relativePath} 里找不到 \`var allModules = []string{...}\``)
    return problems
  }
  const refs = allMatch[1].split(',').map(token => token.trim()).filter(token => token !== '')
  const resolved = refs.map((ref) => {
    if (!constants.has(ref)) {
      problems.push(`${relativePath} 的 allModules 引用了未声明的常量 \`${ref}\``)
      return null
    }
    return constants.get(ref)
  })
  const orderMismatch = problems.length === 0
    && (resolved.length !== ctx.ids.length || resolved.some((value, index) => value !== ctx.ids[index]))
  if (orderMismatch) {
    problems.push(`${relativePath} 的 AllModules()（源码顺序）解析为 ${JSON.stringify(resolved)}，`
      + `契约要求 ${JSON.stringify(ctx.ids)}（顺序=契约：Enabled() 的返回序由它派生）`)
  }
  const apiMatch = /func[ \t]+AllModules[ \t]*\([ \t]*\)[ \t]*\[\]string[ \t]*\{([^}]*)\}/u.exec(read.text)
  if (apiMatch === null || !/\ballModules\b/u.test(apiMatch[1])) {
    problems.push(`${relativePath} 的 AllModules() 必须从 allModules 取值（否则模块表又多了一个真源）`)
  }
  return problems
}

/**
 * **`--check`**：在内存里重算各端生成物并与磁盘逐字节比，再跑契约自洽 + 4 处结构核验。
 *
 * 问题分**三桶**返回（CLI 按桶给不同的修法，见 {@link main}）：
 *   · `contractProblems`  —— 真源本身不可达/非法/违反棘轮 ⇒ 修 `module-contract.json`
 *     （或显式上调 `MAX_MODULES_DEFAULT_ON`）；
 *   · `generatedProblems` —— 标记块内的**生成物**与真源不一致 ⇒ 跑生成器（一次修好）；
 *   · `structuralProblems`—— **不是生成物**的结构面/接线面（客户端 `module:` 顺序、
 *     router 分片、`featureGlobalName()`、`AllModules()`、ci.yml 里手写的非契约 `-tags=`）
 *     ⇒ 跑生成器**不会**修好，必须按每条点名的位置人工补齐。
 * @param {{root?: string, cwd?: string}} [options] - 覆盖项（自检/测试用）。
 * @returns {Promise<{ok: boolean, problems: string[], contractProblems: string[], generatedProblems: string[], structuralProblems: string[], counts: object, contract: object|null}>} 判定结果。
 */
export async function checkModuleContract(options = {}) {
  const contractProblems = []
  const generatedProblems = []
  const structuralProblems = []
  const loaded = loadModuleContract(options)
  contractProblems.push(...loaded.problems)
  const contract = loaded.contract
  if (contract !== null) contractProblems.push(...contractSelfProblems(contract))
  if (contract === null) {
    return {
      ok: false,
      problems: [...contractProblems],
      contractProblems,
      generatedProblems,
      structuralProblems,
      counts: MODULE_CONTRACT_FACE_COUNTS,
      contract: null,
    }
  }
  const ctx = contractContext(contract)

  // ---- 生成面：逐文件逐字节比 ------------------------------------------------
  for (const site of GENERATED_SITES) {
    const read = readRepoFile(site.path, options)
    if (read.text === null) {
      generatedProblems.push(read.problem)
      continue
    }
    const rendered = renderSite(read.text, site, ctx)
    if (rendered.problems.length > 0) {
      generatedProblems.push(...rendered.problems)
      continue
    }
    if (rendered.text === read.text) continue
    const before = read.text.split('\n')
    const after = rendered.text.split('\n')
    const changed = []
    const limit = Math.max(before.length, after.length)
    for (let index = 0; index < limit; index += 1) {
      if (before[index] === after[index]) continue
      changed.push(`第 ${index + 1} 行：实际 ${JSON.stringify(before[index] ?? null)}`
        + ` ≠ 期望 ${JSON.stringify(after[index] ?? null)}`)
    }
    generatedProblems.push(`${site.path}（${site.label} / 生成区 ${site.regions
      .map(region => region.id).join('+')}）的生成物与真源 \`${MODULE_CONTRACT_FILE}\` 不一致：`
      + `${changed.slice(0, 6).join('；')}${changed.length > 6 ? `；…共 ${changed.length} 行不同` : ''}`)
  }

  // ---- 接线面：ci.yml 的"带值但不是契约串"普查（不是生成区）-------------------
  {
    const read = readRepoFile('.github/workflows/ci.yml', options)
    if (read.text !== null) structuralProblems.push(...scanWorkflowTagLiterals(read.text, ctx.idsText))
  }

  // ---- 核验面（生成之外的结构面）--------------------------------------------
  structuralProblems.push(...verifyClientSurfaceOrder(ctx, options))
  structuralProblems.push(...verifyRouterShards(ctx, options))
  structuralProblems.push(...await verifyWebadminGlobalName(ctx, options))
  structuralProblems.push(...verifyGoAllModules(ctx, options))

  const problems = [...contractProblems, ...generatedProblems, ...structuralProblems]
  return {
    ok: problems.length === 0,
    problems,
    contractProblems,
    generatedProblems,
    structuralProblems,
    counts: MODULE_CONTRACT_FACE_COUNTS,
    contract,
  }
}

/**
 * **缺省（写）模式**：按真源重写各端标记块内的内容。幂等。
 *
 * 真源非法 ⇒ **一个文件都不写**并返回问题（半写状态比不写更糟）。
 * @param {{root?: string, cwd?: string}} [options] - 覆盖项。
 * @returns {Promise<{ok: boolean, problems: string[], changed: string[], unchanged: string[]}>} 结果。
 */
export async function generateModuleContract(options = {}) {
  const problems = []
  const loaded = loadModuleContract(options)
  problems.push(...loaded.problems)
  const contract = loaded.contract
  if (contract === null) {
    return { ok: false, problems, changed: [], unchanged: [] }
  }
  const ctx = contractContext(contract)
  /** 先全部渲染成功再落盘：避免"前两个文件写了、第三个标记坏了"的半写状态。 */
  const pending = []
  for (const site of GENERATED_SITES) {
    const read = readRepoFile(site.path, options)
    if (read.text === null) {
      problems.push(read.problem)
      continue
    }
    const rendered = renderSite(read.text, site, ctx)
    if (rendered.problems.length > 0) {
      problems.push(...rendered.problems)
      continue
    }
    pending.push({ site, path: read.path, before: read.text, after: rendered.text })
  }
  if (problems.length > 0) return { ok: false, problems, changed: [], unchanged: [] }
  const changed = []
  const unchanged = []
  for (const item of pending) {
    if (item.before === item.after) {
      unchanged.push(item.site.path)
      continue
    }
    writeFileSync(item.path, item.after)
    changed.push(item.site.path)
  }
  return { ok: true, problems, changed, unchanged }
}

/** CLI 主流程。 */
async function main(argv) {
  const unknown = argv.filter(argument => argument.startsWith('-') && argument !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`gen-module-contract: 未知参数 ${unknown.join(' ')}\n`
      + '用法：node scripts/gen-module-contract.mjs [--check]\n')
    return 1
  }
  if (argv.includes('--check')) {
    const result = await checkModuleContract()
    if (!result.ok) {
      /**
       * 按桶给**不同的修法**：生成区不一致跑一次生成器就修好；结构面缺失跑生成器**不会**
       * 修好（它们不是生成物）—— 把两者混在一句"跑生成器"里会让人白跑一趟。
       */
      const buckets = [
        {
          label: '真源问题',
          problems: result.contractProblems,
          fix: `修 \`${MODULE_CONTRACT_FILE}\`（新增模块一律先设 \`defaultInChannel: false\`；`
            + '要让它默认开就必须显式上调 `scripts/gen-module-contract.mjs` 的 '
            + '`MAX_MODULES_DEFAULT_ON`）',
        },
        {
          label: '生成区不一致',
          problems: result.generatedProblems,
          fix: '跑 `node scripts/gen-module-contract.mjs` 重新生成（生成区是**生成物**，手改会被判红）',
        },
        {
          label: '结构面/接线面缺失（**不是生成物**）',
          problems: result.structuralProblems,
          fix: '跑生成器**不会**修好这一桶 —— 按上面逐条点名的文件:行**人工补齐**'
            + '（客户端 `module:` 顺序 / router 的 `optional_<m>_{on,off}.go` / '
            + '`featureGlobalName()` / `AllModules()` / ci.yml 里手写的非契约 `-tags=`）',
        },
      ]
      for (const bucket of buckets) {
        if (bucket.problems.length === 0) continue
        process.stderr.write(`gen-module-contract --check: 【${bucket.label}】${bucket.problems.length} 项\n`)
        for (const problem of bucket.problems) {
          process.stderr.write(`gen-module-contract --check:   · ${problem}\n`)
        }
        process.stderr.write(`gen-module-contract --check:   ⇒ 修法：${bucket.fix}\n`)
      }
      process.stderr.write(`gen-module-contract --check: 合计 ${result.problems.length} 项不一致`
        + `（真源 ${result.contractProblems.length} · 生成区 ${result.generatedProblems.length}`
        + ` · 结构面 ${result.structuralProblems.length}）\n`)
      return 1
    }
    process.stdout.write(`gen-module-contract --check: OK — 生成物与 ${MODULE_CONTRACT_FILE} 逐字节一致`
      + `（生成 ${result.counts.generatedFiles} 端 / ${result.counts.generatedRegions} 处，`
      + `另核验 ${result.counts.verifiedFaces} 处结构面）\n`)
    return 0
  }
  const result = await generateModuleContract()
  if (!result.ok) {
    for (const problem of result.problems) process.stderr.write(`gen-module-contract: ${problem}\n`)
    process.stderr.write(`gen-module-contract: ${result.problems.length} 项问题 —— 未写入任何文件\n`)
    return 1
  }
  for (const path of result.changed) process.stdout.write(`gen-module-contract: 更新 ${path}\n`)
  process.stdout.write(`gen-module-contract: OK — ${result.changed.length} 个文件更新、`
    + `${result.unchanged.length} 个文件已是最新\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
