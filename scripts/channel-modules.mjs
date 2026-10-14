#!/usr/bin/env node
/**
 * **渠道 × 模块清单工具**（面向人 + 面向私有渠道仓的 CI/运维）。
 *
 * 编译期功能模块的清单是**单一真源 + 代码生成**的：真源在仓库根
 * `module-contract.json`（每个模块带 `id` / `goConst` / `title` / `defaultInChannel`），
 * 各端清单与**渠道缺省表**（`FEATURE_MODULE_DEFAULTS`）都是
 * `scripts/gen-module-contract.mjs` 的生成物。本工具是**只读的视图层**：
 *
 *   · `--list`               打印系统可用的模块清单（id / 渠道声明键 / 渠道缺省 / 一句话说明）；
 *   · `--template`           打印**可直接粘贴**的 `"features"` 片段（列出全部模块 + 各自缺省值
 *                            + 纪律说明）。**不含任何渠道/客户身份**（公开仓铁律 0）；
 *   · `--explain <channel.json>`  对一份真实渠道配置**真跑** `normalizeChannelFeatures()`
 *                            （从 `channel-constants.ts` import，**不重写语义**），打印
 *                            显式声明 / 按缺省推断 / 实际交付 / 被裁掉 / 变体串；
 *   · `--check  <channel.json>`   同上但**严格**（机器门禁）：未知键 / 非布尔取值 / 文件读不到
 *                           一律非零退出并点名，供私有渠道仓 CI 与运维用。
 *
 * **缺文件 = 红，不是 skip**（本仓纪律：真源/输入读不到是结构事故，不是环境差异）。
 * `--explain` 与 `--check` 的区别只在**输出形态**：前者给人看完整推断过程（并打印问题），
 * 后者是判据（问题 + 退出码），两者的退出码都是 fail-loud。
 *
 * 零外部依赖（只 import node 内建 + 仓内零依赖模块）⇒ 在**没有 node_modules 的检出**里也能跑
 * （与 `scripts/ci-channels.sh` 的三个探针同一条约束）。
 *
 * 用法：`node scripts/channel-modules.mjs [--list|--template|--explain <path>|--check <path>]`
 * 退出码：0 通过；1 有问题（缺文件/非法声明/契约与生成物漂移）。
 *
 * @module scripts/channel-modules
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MAX_MODULES_DEFAULT_ON,
  MODULE_CONTRACT_FILE,
  loadModuleContract,
} from './gen-module-contract.mjs'

/** 仓库根（本脚本位于 `scripts/` 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 渠道常量模块（`FEATURE_MODULES` / `FEATURE_MODULE_DEFAULTS` / `normalizeChannelFeatures`）。 */
const CONSTANTS_RELATIVE = 'packages/host/desktop/scripts/channel-constants.ts'

/** 是不是"普通对象"（数组 / null / 标量都不算）。 */
const isPlainRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 装载"契约 + 生成物"两侧的模块视图，并**互相核对**（漂移 = 红）。
 *
 * 契约给 `title` 与 `defaultInChannel`（真源），生成物给客户端实际读的
 * `FEATURE_MODULES` / `FEATURE_MODULE_DEFAULTS` —— 两边都得有，且必须逐字逐序一致，
 * 否则本工具打印的清单就不是客户端真正会用的那一套。
 * @returns {Promise<{modules: Array<{id: string, title: string, defaultInChannel: boolean}>|null, problems: string[]}>} 视图或问题。
 */
async function loadModuleView() {
  const problems = []
  const loaded = loadModuleContract()
  if (loaded.contract === null) return { modules: null, problems: loaded.problems }

  const constantsPath = resolve(ROOT, CONSTANTS_RELATIVE)
  if (!existsSync(constantsPath)) {
    return {
      modules: null,
      problems: [`${CONSTANTS_RELATIVE} **不可达** —— 仓库结构事故（渠道常量模块被改名/搬走），`
        + `不是环境差异。请把它放回 ${CONSTANTS_RELATIVE}`],
    }
  }
  let constants = null
  try {
    constants = await import(pathToFileURL(constantsPath).href)
  } catch (error) {
    return { modules: null, problems: [`${CONSTANTS_RELATIVE} import 失败：${error?.message ?? String(error)}`] }
  }

  const contractIds = loaded.contract.modules.map(module => module.id)
  const generatedIds = [...(constants.FEATURE_MODULES ?? [])]
  if (JSON.stringify(contractIds) !== JSON.stringify(generatedIds)) {
    problems.push(`${MODULE_CONTRACT_FILE} 的模块顺序 ${JSON.stringify(contractIds)} 与 `
      + `${CONSTANTS_RELATIVE} 的 FEATURE_MODULES ${JSON.stringify(generatedIds)} 不一致`
      + ' —— 跑 `node scripts/gen-module-contract.mjs` 重新生成（生成物与真源必须逐字逐序一致）')
  }
  const defaults = constants.FEATURE_MODULE_DEFAULTS ?? {}
  for (const module of loaded.contract.modules) {
    if (defaults[module.id] !== module.defaultInChannel) {
      problems.push(`${CONSTANTS_RELATIVE} 的 FEATURE_MODULE_DEFAULTS.${module.id} 是 `
        + `${JSON.stringify(defaults[module.id] ?? null)}，契约 ${MODULE_CONTRACT_FILE} 的 `
        + `defaultInChannel 是 ${JSON.stringify(module.defaultInChannel)}`
        + ' —— 跑 `node scripts/gen-module-contract.mjs` 重新生成')
    }
  }
  if (!Number.isSafeInteger(MAX_MODULES_DEFAULT_ON) || MAX_MODULES_DEFAULT_ON <= 0) {
    problems.push(`gen-module-contract.mjs 的 MAX_MODULES_DEFAULT_ON 必须是正整数`
      + `（实际 ${JSON.stringify(MAX_MODULES_DEFAULT_ON)}）—— 它被掏空时"新增模块悄悄默认全开"就没人拦`)
  }
  if (problems.length > 0) return { modules: null, problems }
  return {
    modules: loaded.contract.modules.map(module => ({
      id: module.id,
      title: module.title,
      defaultInChannel: module.defaultInChannel,
    })),
    problems,
  }
}

/** 把路径解析成真实文件（cwd 优先，再退到仓库根；两条都试 ⇒ 报错能列出尝试过什么）。 */
function resolveInputPath(given) {
  const tried = []
  const bases = isAbsolute(given) ? [''] : [process.cwd(), ROOT]
  for (const base of bases) {
    const path = base === '' ? given : resolve(base, given)
    tried.push(path)
    if (existsSync(path)) return { path, tried }
  }
  return { path: null, tried }
}

/**
 * 读一份 `channel.json` 并**真跑**语义解析。
 * @param {string} given - 用户给的路径。
 * @param {object} constants - `channel-constants.ts` 的模块。
 * @returns {{path: string|null, doc: object|null, features: unknown, declared: string[],
 *   normalized: object|null, problems: string[]}} 解析结果（`problems` 非空 = 红）。
 */
function readChannelFeatures(given, constants) {
  const problems = []
  const { path, tried } = resolveInputPath(given)
  if (path === null) {
    return {
      path: null,
      doc: null,
      features: undefined,
      declared: [],
      normalized: null,
      problems: [`${given} **读不到** —— 候选路径全部尝试过：${tried.join(' | ')}`
        + '（缺文件是结构/输入事故，不是 skip：请确认路径，别把"读不到"当"没问题"）'],
    }
  }
  let text = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      path, doc: null, features: undefined, declared: [], normalized: null,
      problems: [`${path} 读失败：${error?.message ?? String(error)}`],
    }
  }
  let doc = null
  try {
    doc = JSON.parse(text)
  } catch (error) {
    return {
      path, doc: null, features: undefined, declared: [], normalized: null,
      problems: [`${path} 不是合法 JSON：${error?.message ?? String(error)}`],
    }
  }
  if (!isPlainRecord(doc)) {
    return {
      path, doc: null, features: undefined, declared: [], normalized: null,
      problems: [`${path} 的顶层必须是对象（channel.json 形态）`],
    }
  }
  const features = doc.features
  const declared = isPlainRecord(features) ? Object.keys(features) : []
  try {
    const normalized = constants.normalizeChannelFeatures(features)
    return { path, doc, features, declared, normalized, problems }
  } catch (error) {
    const detail = Array.isArray(error?.problems) && error.problems.length > 0
      ? error.problems
      : [error?.message ?? String(error)]
    return {
      path, doc, features, declared, normalized: null,
      problems: detail.map(item => `${path}：${item}`),
    }
  }
}

/** `--list`：打印系统可用模块清单。 */
async function cmdList() {
  const { modules, problems } = await loadModuleView()
  if (modules === null) {
    for (const problem of problems) process.stderr.write(`channel-modules --list: ${problem}\n`)
    return 1
  }
  const rows = modules.map(module => [
    module.id,
    `features.${module.id}`,
    String(module.defaultInChannel),
    module.title,
  ])
  const headers = ['id', '渠道声明键', '渠道缺省', '说明']
  const table = [headers, ...rows]
  const widths = headers.map((_, column) => Math.max(...table.map(row => [...String(row[column])].length)))
  process.stdout.write(`渠道模块清单（唯一真源 = ${MODULE_CONTRACT_FILE}；生成物 = ${CONSTANTS_RELATIVE}）\n`)
  for (const row of table) {
    process.stdout.write(`  ${row.map((value, column) => String(value).padEnd(widths[column])).join('  ')}\n`)
  }
  const onByDefault = modules.filter(module => module.defaultInChannel).length
  process.stdout.write(`  渠道缺省开启 ${onByDefault} 个 / 棘轮上限 MAX_MODULES_DEFAULT_ON = `
    + `${MAX_MODULES_DEFAULT_ON}（新增模块一律先设 false：缺省不进任何渠道）\n`)
  return 0
}

/** `--template`：打印可直接粘贴的 `"features"` 片段（**不含任何渠道/客户身份**）。 */
async function cmdTemplate() {
  const { modules, problems } = await loadModuleView()
  if (modules === null) {
    for (const problem of problems) process.stderr.write(`channel-modules --template: ${problem}\n`)
    return 1
  }
  const lines = []
  lines.push('# 渠道模块清单片段（把下面那段 JSON 放进 channels/<id>/channel.json 的顶层）')
  lines.push('# 纪律：')
  lines.push('#   · 这里列出**全部**模块 + 各自缺省值 —— 显式声明 = 该渠道的完整裁剪面，不漏不猜；')
  lines.push('#   · 要**关掉**某模块：把它的 true 改 false（关掉的那个模块的包/行/目录都不进产物）；')
  lines.push('#   · **新增模块默认 false**（缺省不进任何渠道）：要发给本渠道必须显式写 true；')
  lines.push('#   · 未知键 / 非布尔取值（含字符串 "false"）会让构建当场失败，别手写猜测；')
  lines.push('#   · 改完跑 `node scripts/channel-modules.mjs --check <这份 channel.json>`。')
  lines.push('"features": {')
  modules.forEach((module, index) => {
    const tail = index === modules.length - 1 ? '' : ','
    lines.push(`  "${module.id}": ${module.defaultInChannel}${tail}`)
  })
  lines.push('}')
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/**
 * `--explain` / `--check` 的公共求值：显式声明 / 按缺省推断 / 交付 / 裁掉 / 变体串。
 * @param {string} path - channel.json 路径。
 * @returns {Promise<{problems: string[], view: object|null}>} 结果。
 */
async function evaluateChannel(path) {
  const loaded = await loadModuleView()
  if (loaded.modules === null) return { problems: loaded.problems, view: null }
  const constantsPath = resolve(ROOT, CONSTANTS_RELATIVE)
  const constants = await import(pathToFileURL(constantsPath).href)
  const ids = loaded.modules.map(module => module.id)
  const parsed = readChannelFeatures(path, constants)
  const defaults = Object.fromEntries(loaded.modules.map(module => [module.id, module.defaultInChannel]))
  const inferred = ids.filter(id => !parsed.declared.includes(id))
  const view = {
    // 读不到时 `parsed.path` 是 null —— 报头里仍要有**用户给的那个串**才可行动。
    path: parsed.path ?? path,
    ids,
    defaults,
    features: parsed.features,
    declared: parsed.declared,
    inferred,
    normalized: parsed.normalized,
    problems: parsed.problems,
  }
  return { problems: parsed.problems, view }
}

/** 交付视图：实际交付 / 被裁掉 / 变体串（`normalized` 为 null ⇒ 三者都是 null）。 */
function deliveryOf(view) {
  if (view.normalized === null) return { delivered: null, cut: null, variant: null }
  const delivered = view.ids.filter(id => view.normalized[id] === true)
  const cut = view.ids.filter(id => view.normalized[id] === false)
  return { delivered, cut, variant: delivered.length === 0 ? 'none' : delivered.join(',') }
}

/** 显式声明的模块（带取值，用于人读的那一行）。 */
const declaredText = (view) => (view.declared.length === 0
  ? '(无，全部按契约缺省)'
  : view.declared.map(id => `${id}=${JSON.stringify(isPlainRecord(view.features) ? view.features[id] : null)}`)
    .join(' '))

/** `--explain`：给人看的完整推断过程（有问题也照打，但退出码 fail-loud）。 */
async function cmdExplain(path) {
  const { problems, view } = await evaluateChannel(path)
  if (view === null) {
    for (const problem of problems) process.stderr.write(`channel-modules --explain: ${problem}\n`)
    return 1
  }
  const lines = []
  lines.push(`channel-modules --explain: ${view.path}`)
  lines.push(`  契约（${MODULE_CONTRACT_FILE} 的 defaultInChannel）：`
    + `${view.ids.map(id => `${id}=${view.defaults[id]}`).join(' ')}`)
  lines.push(`  显式声明（${view.declared.length}）：${declaredText(view)}`)
  lines.push(`  按契约缺省推断（${view.inferred.length}）：${view.inferred.length === 0 ? '(无)'
    : view.inferred.map(id => `${id}=${view.defaults[id]}`).join(' ')}`)
  const delivery = deliveryOf(view)
  if (delivery.delivered === null) {
    lines.push('  实际交付：**判不出来**（上面的声明非法，构建期会 fail-loud 拒绝）')
    lines.push('  变体串（FEATURES=）：**判不出来** —— 先修声明')
  } else {
    lines.push(`  实际交付（${delivery.delivered.length}）：${delivery.delivered.length === 0
      ? '(无 —— 三个全关)'
      : delivery.delivered.map(id => `features.${id}`).join(' / ')}`)
    lines.push(`  被裁掉（${delivery.cut.length}）：${delivery.cut.length === 0
      ? '(无)'
      : delivery.cut.map(id => `features.${id}`).join(' / ')}`)
    lines.push(`  变体串（FEATURES=）：${delivery.variant}`)
  }
  for (const line of lines) process.stdout.write(`${line}\n`)
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`channel-modules --explain: ${problem}\n`)
    process.stderr.write(`channel-modules --explain: ${problems.length} 项问题 —— 这份声明现在就会让`
      + '构建 fail-loud（上面的"按契约缺省推断"只是让人看清会被裁成什么）\n')
    return 1
  }
  return 0
}

/** `--check`：机器门禁（退出码是产物，问题逐条点名）。 */
async function cmdCheck(path) {
  const { problems, view } = await evaluateChannel(path)
  if (view === null) {
    for (const problem of problems) process.stderr.write(`channel-modules --check: ${problem}\n`)
    return 1
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`channel-modules --check: ${problem}\n`)
    process.stderr.write(`channel-modules --check: 非法声明 —— 未知键/非布尔取值/读不到都会在这里红`
      + '（不要靠"忽略坏键"绕过：那方向永远是**多交付一个模块**）\n')
    return 1
  }
  const delivery = deliveryOf(view)
  process.stdout.write(`channel-modules --check: OK — ${view.path}：显式声明 ${view.declared.length}`
    + ` / 按契约缺省 ${view.inferred.length}；实际交付 ${delivery.variant}`
    + `（裁掉 ${delivery.cut.length === 0 ? '无' : delivery.cut.join(',')}）\n`)
  return 0
}

/** CLI 主流程。 */
async function main(argv) {
  const mode = argv[0]
  const usage = '用法：node scripts/channel-modules.mjs [--list|--template|--explain <channel.json>|'
    + '--check <channel.json>]\n'
  if (mode === undefined || mode === '--help' || mode === '-h') {
    process.stdout.write(usage)
    return mode === undefined ? 1 : 0
  }
  if (mode === '--list' && argv.length === 1) return cmdList()
  if (mode === '--template' && argv.length === 1) return cmdTemplate()
  if ((mode === '--explain' || mode === '--check') && argv.length === 2 && argv[1] !== '') {
    return mode === '--explain' ? cmdExplain(argv[1]) : cmdCheck(argv[1])
  }
  process.stderr.write(`channel-modules: 参数不对（收到 ${JSON.stringify(argv)}）\n${usage}`)
  return 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
